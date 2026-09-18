use serde_json::{Map, Value, json};

use super::{
    error::{BackendError, BackendResult},
    provider_adapter::{
        ARK_ADAPTER_ID, BAILIAN_ADAPTER_ID, BAILIAN_VIDEO_OBSERVE_PATH, BAILIAN_VIDEO_PATH,
        DASHSCOPE_VIDEO_ENVELOPE,
    },
    types::GenerationOperation,
};

const OPERATION_KEYS: [(&str, GenerationOperation); 4] = [
    ("text_to_image", GenerationOperation::TextToImage),
    ("image_to_image", GenerationOperation::ImageToImage),
    ("video_generation", GenerationOperation::VideoGeneration),
    ("text_generation", GenerationOperation::TextGeneration),
];

pub fn provider_scoped_model_definition_id(
    provider_connection_id: &str,
    remote_model_id: &str,
) -> String {
    format!("remote::{provider_connection_id}::{remote_model_id}")
}

pub fn operations_from_schema(schema: &Value) -> Vec<GenerationOperation> {
    OPERATION_KEYS
        .iter()
        .filter_map(|(key, operation)| schema.get(*key).map(|_| *operation))
        .collect()
}

/// 供应商连接的请求方言。
///
/// 端点是**供应商连接**的属性，不是模型名的属性：同一个 `doubao-seedance-*`，
/// 在火山方舟原生接口上是 `/contents/generations/tasks`，在 OpenAI 兼容网关上
/// （魔芋聚合平台，以及 new-api / One API 内核的聚合站）是 `/v1/video/generations`。
/// 历史实现只看模型名，把网关发布的 `doubao-*` 也发到了方舟原生路径，上游于是返回
/// `HTTP 404 {"error":{"message":"Invalid URL (POST /v1/contents/generations/tasks)"}}`。
/// 模型名只用来判断能力与参数，端点一律由连接适配器决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestDialect {
    /// OpenAI 兼容网关：`/v1/video/generations`、`/v1/images/generations`、
    /// `/v1/chat/completions`。
    OpenAiCompatible,
    /// 火山方舟原生接口：`/contents/generations/tasks`、`/images/generations`、
    /// `/chat/completions`。
    VolcengineArk,
    /// 阿里云百炼（华北2）官方 DashScope：万相走
    /// `/api/v1/services/aigc/video-generation/video-synthesis`。
    AliyunBailian,
}

impl RequestDialect {
    /// 适配器 → 方言。方舟推理 API 的 Base URL 自带 `/api/v3`，端点因此不带
    /// `/v1` 前缀；百炼走官方 MaaS 路径；其余适配器都是 OpenAI 兼容网关。
    pub fn for_adapter(adapter_id: &str) -> Self {
        if adapter_id == ARK_ADAPTER_ID {
            Self::VolcengineArk
        } else if adapter_id == BAILIAN_ADAPTER_ID {
            Self::AliyunBailian
        } else {
            Self::OpenAiCompatible
        }
    }
}

/// 方舟原生 Seedance 视频任务接口：提交与轮询同路径，参数平铺在顶层。
const ARK_VIDEO_PATH: &str = "/contents/generations/tasks";
const ARK_VIDEO_OBSERVE_PATH: &str = "/contents/generations/tasks/{task_id}";
/// OpenAI 兼容网关的视频任务接口（魔芋 API 文档与 new-api 内核一致）。
const GATEWAY_VIDEO_PATH: &str = "/v1/video/generations";
/// 方舟原生 Seedream 文生图接口（网关对应 `/v1/images/generations`）。
const ARK_IMAGE_PATH: &str = "/images/generations";
const GATEWAY_IMAGE_PATH: &str = "/v1/images/generations";
/// doubao 文本模型的原生对话接口（网关对应 `/v1/chat/completions`）。
const ARK_CHAT_PATH: &str = "/chat/completions";
const GATEWAY_CHAT_PATH: &str = "/v1/chat/completions";

/// 按连接方言改写操作 Schema 里的请求端点。
///
/// `default_operation_schema` 只看得到模型名，只能给出 OpenAI 兼容网关的规范值；
/// 本函数是方舟连接的唯一改写入口，也在保存模型与打开数据库时把历史按模型名写下的
/// 方舟原生端点改回网关端点。只在这三对互为替代的端点之间互换，其他家族
/// （Veo / Vidu / Wan / MiniMax、Gemini、Anthropic、盘趣）自己的路径原样保留。
///
/// 返回是否发生改写，调用方据此决定是否需要把定义写回数据库。
pub fn apply_request_dialect(schema: &mut Value, model_id: &str, dialect: RequestDialect) -> bool {
    let identity = model_id.to_ascii_lowercase();
    let video = apply_video_dialect(schema, &identity, dialect);
    let image = apply_image_dialect(schema, &identity, dialect);
    let text = apply_text_dialect(schema, &identity, dialect);
    video || image || text
}

fn operation_object_mut(
    schema: &mut Value,
    operation: GenerationOperation,
) -> Option<&mut Map<String, Value>> {
    schema
        .get_mut(operation.as_str())
        .and_then(Value::as_object_mut)
}

fn request_object_mut(
    schema: &mut Value,
    operation: GenerationOperation,
) -> Option<&mut Map<String, Value>> {
    operation_object_mut(schema, operation)?
        .get_mut("request")
        .and_then(Value::as_object_mut)
}

fn current_request_path(request: &Map<String, Value>) -> &str {
    request
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// 只在值确实变化时写入，避免仅因键序不同就把定义标记成「已改写」。
fn set_request_field(request: &mut Map<String, Value>, field: &str, value: Value) -> bool {
    if request.get(field) == Some(&value) {
        return false;
    }
    request.insert(field.to_string(), value);
    true
}

/// 视频：网关 `/v1/video/generations` ↔ 方舟原生 `/contents/generations/tasks`
/// ↔ 百炼官方万相 `/api/v1/services/aigc/video-generation/video-synthesis`。
fn apply_video_dialect(schema: &mut Value, identity: &str, dialect: RequestDialect) -> bool {
    if dialect == RequestDialect::AliyunBailian {
        return apply_bailian_wan_video_dialect(schema, identity);
    }
    let Some(operation) = operation_object_mut(schema, GenerationOperation::VideoGeneration) else {
        return false;
    };
    let profile = operation
        .get("requestProfileId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let Some(request) = operation.get_mut("request").and_then(Value::as_object_mut) else {
        return false;
    };
    let path = current_request_path(request).to_string();
    match dialect {
        RequestDialect::AliyunBailian => false,
        // 方舟只承载自家 Seedance（含 1.x）。Vidu / Wan / Veo / MiniMax / 盘趣在方舟上
        // 没有端点，它们自己的契约保持原样。
        RequestDialect::VolcengineArk => {
            let native_seedance = identity.contains("seedance")
                && !is_dreamina_seedance_video_model(identity)
                && !is_panqu_video_model(identity);
            if !native_seedance {
                return false;
            }
            let mut changed = set_request_field(request, "path", json!(ARK_VIDEO_PATH));
            changed |= set_request_field(request, "parameterContainer", json!("root"));
            // 原生请求体的 content 数组也在顶层（网关契约才把它放进 metadata）。
            changed |= set_request_field(request, "contentContainer", json!("root"));
            // 原生任务接口的轮询是 `GET /contents/generations/tasks/{id}`；默认的
            // `/v1/video/generations/{id}` 在方舟上不存在。
            changed |= set_request_field(request, "observePath", json!(ARK_VIDEO_OBSERVE_PATH));
            changed
        }
        RequestDialect::OpenAiCompatible => {
            // 方舟/百炼原生路径只可能由「按模型名推导」或连接方言写下；
            // 网关从来不用它们，因此改回 `/v1/video/generations`。
            if path == BAILIAN_VIDEO_PATH {
                let mut changed = set_request_field(request, "path", json!(GATEWAY_VIDEO_PATH));
                if request.get("observePath").and_then(Value::as_str)
                    == Some(BAILIAN_VIDEO_OBSERVE_PATH)
                {
                    request.remove("observePath");
                    changed = true;
                }
                if request.get("envelope").and_then(Value::as_str) == Some(DASHSCOPE_VIDEO_ENVELOPE)
                {
                    request.remove("envelope");
                    changed = true;
                }
                return changed;
            }
            if path != ARK_VIDEO_PATH {
                return false;
            }
            let mut changed = set_request_field(request, "path", json!(GATEWAY_VIDEO_PATH));
            // 参数容器随方言走：原生契约把画幅/时长/分辨率平铺在顶层、content 也在顶层，
            // 网关契约把它们归入 `metadata`。只认通用视频档案，供应商自定义档案的容器
            // 保持原样（盘趣网关的顶层契约即属此类）。
            if profile == "moyu_video_metadata_v1"
                && request.get("parameterContainer").and_then(Value::as_str) == Some("root")
            {
                changed |= set_request_field(request, "parameterContainer", json!("metadata"));
            }
            if request.get("contentContainer").and_then(Value::as_str) == Some("root") {
                request.remove("contentContainer");
                changed = true;
            }
            if request.get("observePath").and_then(Value::as_str) == Some(ARK_VIDEO_OBSERVE_PATH) {
                request.remove("observePath");
                changed = true;
            }
            changed
        }
    }
}

/// 百炼只改写万相 3.0：官方异步视频合成端点 + DashScope input/parameters 信封。
fn apply_bailian_wan_video_dialect(schema: &mut Value, identity: &str) -> bool {
    if !is_wan_30_video_model(identity) {
        return false;
    }
    let Some(operation) = operation_object_mut(schema, GenerationOperation::VideoGeneration) else {
        return false;
    };
    let mut changed = {
        let Some(request) = operation.get_mut("request").and_then(Value::as_object_mut) else {
            return false;
        };
        let mut changed = set_request_field(request, "path", json!(BAILIAN_VIDEO_PATH));
        changed |= set_request_field(request, "observePath", json!(BAILIAN_VIDEO_OBSERVE_PATH));
        changed |= set_request_field(request, "parameterContainer", json!("root"));
        changed |= set_request_field(request, "envelope", json!(DASHSCOPE_VIDEO_ENVELOPE));
        changed |= set_request_field(request, "mediaEncoding", json!("wan_media_array"));
        changed |= set_request_field(request, "promptMode", json!("prompt_or_media"));
        changed
    };
    let Some(parameters) = operation
        .get_mut("parameters")
        .and_then(Value::as_object_mut)
    else {
        return changed;
    };
    if let Some(ratio) = parameters.get_mut("ratio")
        && let Some(values) = ratio.get_mut("enum").and_then(Value::as_array_mut)
        && !values.iter().any(|value| value.as_str() == Some("21:9"))
    {
        values.insert(1, json!("21:9"));
        changed = true;
    }
    if !parameters.contains_key("audio") {
        parameters.insert(
            "audio".into(),
            json!({
                "type": "boolean",
                "label": "输出音频",
                "default": true,
                "order": 5
            }),
        );
        changed = true;
    }
    if !parameters.contains_key("prompt_extend") {
        parameters.insert(
            "prompt_extend".into(),
            json!({
                "type": "boolean",
                "label": "智能改写",
                "default": true,
                "order": 6
            }),
        );
        changed = true;
    }
    changed
}

/// 文生图：网关 `/v1/images/generations` ↔ 方舟原生 `/images/generations`。
fn apply_image_dialect(schema: &mut Value, identity: &str, dialect: RequestDialect) -> bool {
    let Some(request) = request_object_mut(schema, GenerationOperation::TextToImage) else {
        return false;
    };
    let path = current_request_path(request).to_string();
    match dialect {
        RequestDialect::AliyunBailian => false,
        // 方舟原生图片接口只承载自家 Seedream；其他家族的图片契约保持原样。
        RequestDialect::VolcengineArk => {
            if !is_seedream_image_model(identity) || path != GATEWAY_IMAGE_PATH {
                return false;
            }
            set_request_field(request, "path", json!(ARK_IMAGE_PATH))
        }
        RequestDialect::OpenAiCompatible => {
            if path != ARK_IMAGE_PATH {
                return false;
            }
            set_request_field(request, "path", json!(GATEWAY_IMAGE_PATH))
        }
    }
}

/// 文本对话：网关 `/v1/chat/completions` ↔ 方舟原生 `/chat/completions`。
fn apply_text_dialect(schema: &mut Value, identity: &str, dialect: RequestDialect) -> bool {
    let Some(request) = request_object_mut(schema, GenerationOperation::TextGeneration) else {
        return false;
    };
    let path = current_request_path(request).to_string();
    let domestic_doubao = identity.starts_with("doubao-") || identity == "doubao";
    match dialect {
        RequestDialect::AliyunBailian => false,
        RequestDialect::VolcengineArk => {
            if !domestic_doubao || path != GATEWAY_CHAT_PATH {
                return false;
            }
            set_request_field(request, "path", json!(ARK_CHAT_PATH))
        }
        // 只处理 OpenAI 兼容对话端点；Anthropic `/v1/messages` 与 Gemini
        // `…:generateContent` 不受影响。
        RequestDialect::OpenAiCompatible => {
            if path != ARK_CHAT_PATH {
                return false;
            }
            set_request_field(request, "path", json!(GATEWAY_CHAT_PATH))
        }
    }
}

pub fn infer_catalog_schema(item: &Value, model_id: &str, display_name: &str) -> Value {
    if let Some(schema) = advertised_schema(item) {
        return complete_advertised_schema(schema, model_id);
    }

    let advertised = advertised_operation_names(item);
    if !advertised.is_empty() {
        return default_model_schema(model_id, &advertised);
    }

    let identity = format!("{model_id} {display_name}").to_ascii_lowercase();
    // 媒体生成型号必须先于厂商品牌级文本规则判断。例如 seedream 仍以
    // `doubao-` 开头、Gemini Image 仍以 `gemini-` 开头；若先匹配品牌，
    // 它们会被错误预选为文本模型。
    if is_video_model_identity(&identity) {
        return default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
    }
    if identity.contains("gpt-image") || identity.contains("dall-e") {
        return default_model_schema(
            model_id,
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
        );
    }
    if is_image_model_identity(&identity) {
        // 仅凭名称能可靠判断输出类型，不能可靠判断是否支持参考图；默认只开启
        // 文生图，供应商明确声明 image_to_image 时仍由上面的能力字段完整采用。
        return default_model_schema(model_id, &[GenerationOperation::TextToImage]);
    }
    if is_text_model_identity(&identity) {
        return default_model_schema(model_id, &[GenerationOperation::TextGeneration]);
    }
    Value::Object(Map::new())
}

/// 判断身份串中是否包含一个由非字母数字分隔的完整 ASCII 标记。
fn contains_identity_token(identity: &str, expected: &str) -> bool {
    identity
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|token| token == expected)
}

fn is_wan_30_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("wan3.0-video") || identity.contains("wan3-0-video")
}

fn is_seedance_20_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("seedance-2-0") || identity.contains("seedance-2.0")
}

pub(crate) fn is_seedance_25_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("seedance-2-5") || identity.contains("seedance-2.5")
}

fn is_dreamina_seedance_video_model(model_id: &str) -> bool {
    model_id.to_ascii_lowercase().contains("dreamina-seedance")
}

/// Veo 系列（Google Veo）：`veo-3`、`veo-3-fast`、`veo-3.1`、`veo-3.1-fast`。
/// 按「非字母数字分隔的完整 ASCII 标记」匹配，避免把 `video` 等相近词误判。
fn is_veo_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    contains_identity_token(&identity, "veo")
}

/// Vidu 系列（魔芋 AI 聚合平台）：`vidu2.0` / `viduq1` / `viduq3-pro` /
/// `viduq3-turbo`。四个模型走同一套 Vidu 端点与请求契约，差异仅在分辨率白名单
/// 与能力（`viduq3-pro` 不支持 ≥3 张参考图生视频）。
/// 按「非字母数字分隔的完整 ASCII 标记」匹配，避免把 `video` 等相近词误判。
fn is_vidu_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    contains_identity_token(&identity, "vidu")
        || identity.contains("vidu2.0")
        || identity.contains("viduq1")
        || identity.contains("viduq3")
}

/// MiniMax-H3（魔芋平台新一代视频生成模型）：`MiniMax-H3`。
/// 走独立的 MiniMax-H3 请求契约：`resolution` 取 `768P`/`2K`，媒体通过
/// `metadata.first_frame_image` / `last_frame_image` / `reference_images` /
/// `reference_videos` / `reference_audios` 传入，`metadata.task_type` 区分
/// 文生/图生/参考生成（generation）与 768P→2K 再生成（regeneration）。
fn is_minimax_h3_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("minimax-h3")
        || identity.contains("minimax_h3")
        || identity.contains("minimax h3")
}

/// 盘趣聚合网关（One API / new-api 内核）的视频模型，当前为 `pan-seedance-2.0`。
///
/// 这个网关虽然也接受 `metadata.*` 透传，但**分辨率与画幅是按顶层字段做渠道匹配的**：
/// 把 `resolution` 放进 `metadata` 时渠道不看该字段，任务会被路由到默认渠道；
/// 而顶层传一个渠道未覆盖的档位（实测该站 480p / 1080p）会直接以
/// `No available channel for model … matching resolution=…` 拒绝提交。
/// 因此这里按 API 文档声明顶层字段，并只开放实测可用的分辨率。
///
/// 与 Seedance 2.0 的魔芋契约（`metadata.content` + `metadata.*`）不同，二者不能共用
/// 一份操作 Schema；识别依据是网关公开的 `pan-` 模型前缀（本机没有该前缀的其他模型）。
fn is_panqu_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.starts_with("pan-") && identity.contains("seedance")
}

/// 盘趣网关的视频操作 Schema：`model`/`prompt`/`resolution`/`aspect_ratio`/`duration`
/// 全部为顶层字段，轮询使用默认 `GET /v1/video/generations/{task_id}`。
///
/// 只声明实测可用的分辨率（该站 `pan-seedance-2.0` 的渠道仅覆盖 720p）；把 480p/1080p
/// 也列进枚举会让用户选到必然 503 的档位。时长按 API 文档的 `4–15` 秒。
fn panqu_video_operation_schema() -> Value {
    json!({
        "resultType": "video",
        "requestProfileId": "panqu_video_v1",
        "profileVersion": 1,
        "request": {
            "path": "/v1/video/generations",
            "encoding": "json",
            "parameterContainer": "root",
            "mediaEncoding": "vidu_image_urls",
            "mediaField": "images",
            "metadataField": "metadata"
        },
        "parameters": {
            "resolution": {
                "type": "string",
                "label": "分辨率",
                "default": "720p",
                "enum": ["720p"],
                "requestField": "resolution",
                "order": 0
            },
            "aspect_ratio": {
                "type": "string",
                "label": "画幅",
                "default": "16:9",
                "enum": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
                "requestField": "aspect_ratio",
                "order": 1
            },
            "duration": {
                "type": "integer",
                "label": "时长",
                "default": 5,
                "enum": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
                "requestField": "duration",
                "order": 2
            },
            "seed": {
                "type": "integer",
                "label": "随机种子",
                "optional": true,
                "minimum": -1,
                "maximum": 4294967295i64,
                "requestField": "seed",
                "order": 3
            },
            "generate_audio": {
                "type": "boolean",
                "label": "生成音频",
                "default": true,
                "requestField": "generate_audio",
                "order": 4
            },
            "watermark": {
                "type": "boolean",
                "label": "添加水印",
                "default": false,
                "requestField": "watermark",
                "order": 5
            },
            // 该网关只支持 `[{"type":"web_search"}]` 形式的联网搜索，且仅纯文生视频可用；
            // `web_search_tool` 变换把它映射为顶层 `tools` 数组（与既有 Seedance 契约同名）。
            "web_search": {
                "type": "boolean",
                "label": "联网搜索",
                "default": false,
                "requestField": "tools",
                "transform": "web_search_tool",
                "requiresNoMedia": true,
                "order": 6
            }
        }
    })
}

/// 已知视频生成家族与常见生成方向缩写。这里不使用宽泛的厂商品牌名，避免把
/// 同一厂商的文本模型误判为视频；供应商显式声明的 operations 永远拥有更高优先级。
fn is_video_model_identity(identity: &str) -> bool {
    const VIDEO_FRAGMENTS: [&str; 22] = [
        "seedance",
        "wan3.0-video",
        "wan3-0-video",
        "minimax-video",
        "minimax-h3",
        "minimax_h3",
        "hunyuan-video",
        "cogvideo",
        "ltx-video",
        "text-to-video",
        "image-to-video",
        "video-generation",
        "video-gen",
        "pixverse",
        "hailuo",
        "runway-gen",
        "luma-ray",
        "ray-2",
        "ray2",
        "vidu",
        "视频生成",
        "视频模型",
    ];
    const VIDEO_TOKENS: [&str; 7] = ["sora", "veo", "kling", "vidu", "pika", "t2v", "i2v"];

    VIDEO_FRAGMENTS
        .iter()
        .any(|fragment| identity.contains(fragment))
        || VIDEO_TOKENS
            .iter()
            .any(|token| contains_identity_token(identity, token))
}

/// 已知图片生成家族。`image` 本身不作为通用标记，以免把图片理解、Embedding
/// 等非生成模型误选为图片模型；品牌与 image 的组合则足够明确。
fn is_image_model_identity(identity: &str) -> bool {
    const IMAGE_FRAGMENTS: [&str; 17] = [
        "seedream",
        "stable-diffusion",
        "stable diffusion",
        "stable-image",
        "qwen-image",
        "image-generation",
        "image-gen",
        "text-to-image",
        "image-to-image",
        "midjourney",
        "ideogram",
        "recraft",
        "cogview",
        "kolors",
        "nano-banana",
        "图片生成",
        "图片模型",
    ];
    const IMAGE_TOKENS: [&str; 4] = ["flux", "sdxl", "imagen", "photon"];

    IMAGE_FRAGMENTS
        .iter()
        .any(|fragment| identity.contains(fragment))
        || IMAGE_TOKENS
            .iter()
            .any(|token| contains_identity_token(identity, token))
        || ((identity.contains("gemini") || identity.contains("qwen"))
            && contains_identity_token(identity, "image"))
}

/// Gemini 图片生成模型（如 `gemini-2.5-flash-image`、`gemini-3-pro-image-preview`）。
/// 走 OpenAI Images API（`POST /v1/images/generations`），但 `size` 使用画幅比例
/// （`1:1`/`16:9`/…）而非像素尺寸，不声明 `quality`；上游忽略 `n`（一次只返回
/// 一张，多张需业务侧并发调用）。
fn is_gemini_image_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("gemini") && contains_identity_token(&identity, "image")
}

/// Doubao Seedream 图片生成模型（如 `doubao-seedream-5-0-260128`（moyu 文档
/// 推荐）、`doubao-seedream-4-5-251128`、`doubao-seedream-5-0-pro-260628`）。
/// moyu 聚合平台走 OpenAI Images API（`POST /v1/images/generations`），但契约与
/// dall-e/gpt-image 不同：`size` 只接受 `2K` 及 ≥2K 的像素尺寸（`2048x2048`/
/// `2848x1600`，低于 3686400 像素会被上游拒绝），`quality` 仅 `standard`/`hd`，
/// 并支持 `watermark`、`response_format`（url/b64_json）、组图模式
/// （`sequential_image_generation`）与输出格式（`output_format`：jpg/png/webp）
/// 等 Seedream 专属参数。与视频模型 seedance 名称不同（`seedream` 不含
/// `seedance` 子串），互不干扰。
fn is_seedream_image_model(model_id: &str) -> bool {
    model_id.to_ascii_lowercase().contains("seedream")
}

/// Seedream 图片模型的能力版本：按模型 ID 中的版本标记识别高级参数支持范围。
/// - `5.0`：moyu 文档推荐的标准 Seedream 5.0（如 `doubao-seedream-5-0-260128`），
///   支持组图、输出格式
/// - `5.0-pro`：图层拆分、提示词优化、输出格式、透明背景（仅图生图）
/// - `5.0-lite`：组图、提示词优化、联网搜索、输出格式
/// - `4.5` / `4.0`：组图
/// - `generic`：其他 Seedream 变体按 4.x 通用契约处理（只含基础参数）
fn seedream_image_version(model_id: &str) -> Option<&'static str> {
    let identity = model_id.to_ascii_lowercase();
    if !identity.contains("seedream") {
        return None;
    }
    if identity.contains("seedream-5-0-pro") || identity.contains("seedream-5.0-pro") {
        Some("5.0-pro")
    } else if identity.contains("seedream-5-0-lite") || identity.contains("seedream-5.0-lite") {
        Some("5.0-lite")
    } else if identity.contains("seedream-5-0") || identity.contains("seedream-5.0") {
        Some("5.0")
    } else if identity.contains("seedream-4-5") || identity.contains("seedream-4.5") {
        Some("4.5")
    } else if identity.contains("seedream-4-0") || identity.contains("seedream-4.0") {
        Some("4.0")
    } else {
        Some("generic")
    }
}

/// 按模型 ID / 显示名特征识别文本（对话）模型。
/// 供应商（moyu 聚合平台）的 `/v1/models` 不返回模型能力分类，只能按命名约定推断；
/// 视频模型（seedance）与图片模型（gpt-image / dall-e）已在调用方先行排除。
fn is_text_model_identity(identity: &str) -> bool {
    const TEXT_MODEL_PREFIXES: [&str; 15] = [
        "gpt-", "gpt", "chatgpt", "o1", "o3", "o4", "claude", "gemini", "deepseek", "qwen", "glm",
        "kimi", "doubao", "ernie", "hunyuan",
    ];
    const TEXT_MODEL_CONTAINS: [&str; 8] = [
        "moonshot", "llama", "mistral", "mixtral", "minimax", "step-", "-chat", "chat-",
    ];
    // 精确前缀（如 gpt-4o、o3-mini、glm-4）。
    if TEXT_MODEL_PREFIXES
        .iter()
        .any(|prefix| identity.starts_with(prefix))
    {
        return true;
    }
    TEXT_MODEL_CONTAINS
        .iter()
        .any(|fragment| identity.contains(fragment))
}

/// 按模型 ID 推断文本接口的请求档案（request profile）。
/// moyu 聚合平台同时代理 OpenAI 兼容、Anthropic Messages、Gemini generateContent
/// 三种文本接口，运行时按该档案自动适配请求与响应格式。
pub fn text_request_profile(model_id: &str) -> &'static str {
    let identity = model_id.to_ascii_lowercase();
    if identity.starts_with("claude") {
        "anthropic_messages_v1"
    } else if identity.starts_with("gemini") {
        "gemini_generate_content_v1"
    } else {
        "openai_chat_v1"
    }
}

pub fn schema_for_enabled_operations(
    discovered: &Value,
    model_id: &str,
    operations: &[GenerationOperation],
    dialect: RequestDialect,
) -> Value {
    let discovered = discovered.as_object();
    let mut schema = Map::new();
    for operation in operations {
        let key = operation.as_str();
        // 以规范 Schema 为基底，保证每个操作条目都带有校验依赖的字段
        // （`parameters`、`resultType`、请求档案）。历史遗留的畸形条目
        // （例如只含 `{ resultType: "video" }`、缺失 `parameters`）会被这里补齐；
        // 服务商下发的字段再叠加到基底之上，自定义参数不会丢失。
        let mut definition = default_operation_schema(model_id, *operation)
            .as_object()
            .cloned()
            .unwrap_or_default();
        if let Some(provided) = discovered
            .and_then(|schema| schema.get(key))
            .and_then(Value::as_object)
        {
            for (field, value) in provided {
                definition.insert(field.clone(), value.clone());
            }
        }
        // 保证每个操作条目都带合法的 `parameters` 对象，这是
        // `validate_schema_for_operations` 的硬性要求。历史畸形条目（只含 `resultType`）
        // 缺该字段，补一个空对象即可通过校验；若服务商下发过参数，base 中已包含。
        // `resultType` 由操作键（video_generation / text_to_image …）本身决定，沿用
        // `default_operation_schema` 的规范值；一旦不匹配，仍由校验层报错，不在此静默覆盖。
        if !definition.get("parameters").is_some_and(Value::is_object) {
            definition.insert("parameters".into(), Value::Object(Map::new()));
        }
        schema.insert(key.to_string(), Value::Object(definition));
    }
    let mut schema = Value::Object(schema);
    refresh_wan_30_video_defaults(&mut schema, model_id);
    refresh_dreamina_seedance_video_defaults(&mut schema, model_id);
    refresh_seedance_20_video_defaults(&mut schema, model_id);
    refresh_seedance_25_video_defaults(&mut schema, model_id);
    refresh_veo_video_defaults(&mut schema, model_id);
    refresh_vidu_video_defaults(&mut schema, model_id);
    refresh_minimax_h3_video_defaults(&mut schema, model_id);
    refresh_seedream_image_parameter_defaults(&mut schema, model_id);
    // 端点属于供应商连接：上面按模型名推导出的契约（以及供应商下发的自定义契约）
    // 统一改写到本连接的方言上。方舟连接因此保留原生路径，网关连接一定拿到
    // `/v1/...` 端点。
    apply_request_dialect(&mut schema, model_id, dialect);
    schema
}

pub fn default_model_schema(model_id: &str, operations: &[GenerationOperation]) -> Value {
    let mut schema = Map::new();
    for operation in operations {
        schema.insert(
            operation.as_str().to_string(),
            default_operation_schema(model_id, *operation),
        );
    }
    Value::Object(schema)
}

pub fn normalize_parameters(operation_schema: &Value, supplied: &Value) -> BackendResult<Value> {
    let supplied = supplied.as_object().ok_or_else(|| {
        BackendError::validation(
            "generation parameters must be a JSON object",
            json!({ "parameters": supplied }),
        )
    })?;
    let definitions = operation_schema
        .get("parameters")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let unknown = supplied
        .keys()
        .filter(|key| !definitions.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(BackendError::validation(
            "generation parameters contain fields unsupported by the selected model",
            json!({ "unsupported": unknown, "supported": definitions.keys().collect::<Vec<_>>() }),
        ));
    }

    let mut normalized = Map::new();
    for (key, definition) in &definitions {
        let definition = definition.as_object().ok_or_else(|| {
            BackendError::validation(
                "model parameter definition must be an object",
                json!({ "parameter": key, "definition": definition }),
            )
        })?;
        let value = supplied
            .get(key)
            .or_else(|| definition.get("default"))
            .cloned();
        let Some(value) = value else {
            if definition
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err(BackendError::validation(
                    "a required model parameter is missing",
                    json!({ "parameter": key }),
                ));
            }
            continue;
        };
        validate_parameter_value(key, definition, &value)?;
        normalized.insert(key.clone(), value);
    }
    Ok(Value::Object(normalized))
}

pub fn validate_schema_for_operations(
    discovered: &Value,
    model_id: &str,
    operations: &[GenerationOperation],
) -> BackendResult<Value> {
    // 校验只看契约形状（`resultType` / `parameters` / 参数类型），端点由保存时按
    // 连接方言确定，因此这里用规范方言即可。
    let schema = schema_for_enabled_operations(
        discovered,
        model_id,
        operations,
        RequestDialect::OpenAiCompatible,
    );
    for operation in operations {
        let definition = schema
            .get(operation.as_str())
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BackendError::validation(
                    "enabled model operation requires an operation schema object",
                    json!({ "operation": operation, "schema": schema }),
                )
            })?;
        let parameters = definition
            .get("parameters")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BackendError::validation(
                    "model operation parameters must be a JSON object",
                    json!({ "operation": operation, "definition": definition }),
                )
            })?;
        let expected_result_type = match operation {
            GenerationOperation::TextToImage | GenerationOperation::ImageToImage => "image",
            GenerationOperation::VideoGeneration => "video",
            GenerationOperation::TextGeneration => "text",
        };
        if definition.get("resultType").and_then(Value::as_str) != Some(expected_result_type) {
            return Err(BackendError::validation(
                "model operation result type does not match its generation category",
                json!({
                    "operation": operation,
                    "expectedResultType": expected_result_type,
                    "actualResultType": definition.get("resultType")
                }),
            ));
        }
        for (key, parameter) in parameters {
            let parameter = parameter.as_object().ok_or_else(|| {
                BackendError::validation(
                    "model parameter definition must be a JSON object",
                    json!({ "operation": operation, "parameter": key }),
                )
            })?;
            match parameter.get("type").and_then(Value::as_str) {
                Some("string" | "integer" | "number" | "boolean") => {}
                other => {
                    return Err(BackendError::validation(
                        "model parameter definition has an unsupported type",
                        json!({ "operation": operation, "parameter": key, "type": other }),
                    ));
                }
            }
            if let Some(default) = parameter.get("default") {
                validate_parameter_value(key, parameter, default)?;
            }
        }
    }
    Ok(schema)
}

fn advertised_schema(item: &Value) -> Option<&Value> {
    [
        "/operations",
        "/operation_schema",
        "/operationSchema",
        "/capabilities",
        "/capabilities/operations",
        "/metadata/capabilities",
        "/metadata/operations",
    ]
    .iter()
    .filter_map(|pointer| item.pointer(pointer))
    .find(|value| {
        value.as_object().is_some_and(|object| {
            OPERATION_KEYS
                .iter()
                .any(|(key, _)| object.get(*key).is_some_and(Value::is_object))
        })
    })
}

fn advertised_operation_names(item: &Value) -> Vec<GenerationOperation> {
    [
        "/operations",
        "/supported_operations",
        "/supportedOperations",
        "/capabilities/operations",
        "/capabilities/supported_operations",
        "/capabilities/supportedOperations",
        "/capabilities",
        "/inference_metadata/response_modality",
    ]
    .iter()
    .filter_map(|pointer| item.pointer(pointer).and_then(Value::as_array))
    .flatten()
    .filter_map(Value::as_str)
    .filter_map(parse_operation_alias)
    .fold(Vec::new(), |mut operations, operation| {
        if !operations.contains(&operation) {
            operations.push(operation);
        }
        operations
    })
}

fn parse_operation_alias(value: &str) -> Option<GenerationOperation> {
    match value.trim().to_ascii_lowercase().as_str() {
        "text_to_image" | "text-to-image" | "image_generation" | "image-generation" | "ig"
        | "image" => Some(GenerationOperation::TextToImage),
        "image_to_image" | "image-to-image" | "image_edit" | "image-edit" => {
            Some(GenerationOperation::ImageToImage)
        }
        "video_generation" | "video-generation" | "text_to_video" | "text-to-video" | "vg"
        | "video" => Some(GenerationOperation::VideoGeneration),
        "text_generation" | "text-generation" | "chat" | "chat_completion" | "chat-completion"
        | "llm" | "text" | "tg" => Some(GenerationOperation::TextGeneration),
        _ => None,
    }
}

fn complete_advertised_schema(schema: &Value, model_id: &str) -> Value {
    let Some(advertised) = schema.as_object() else {
        return Value::Object(Map::new());
    };
    let mut complete = Map::new();
    for (key, operation) in OPERATION_KEYS {
        let Some(definition) = advertised.get(key).and_then(Value::as_object) else {
            continue;
        };
        let mut merged = default_operation_schema(model_id, operation)
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (field, value) in definition {
            merged.insert(field.clone(), value.clone());
        }
        if !definition.contains_key("parameters") {
            let parameters = definition
                .get("parameter_schema")
                .or_else(|| definition.get("parameterSchema"))
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            merged.insert("parameters".into(), parameters);
        }
        complete.insert(key.to_string(), Value::Object(merged));
    }
    let mut complete = Value::Object(complete);
    refresh_wan_30_video_defaults(&mut complete, model_id);
    refresh_dreamina_seedance_video_defaults(&mut complete, model_id);
    refresh_seedance_20_video_defaults(&mut complete, model_id);
    refresh_seedance_25_video_defaults(&mut complete, model_id);
    refresh_veo_video_defaults(&mut complete, model_id);
    refresh_vidu_video_defaults(&mut complete, model_id);
    refresh_minimax_h3_video_defaults(&mut complete, model_id);
    complete
}

/// Seedream 文生图基础参数：`size` 走 2K 契约（`2K`/`2048x2048`/`2848x1600`，
/// 低于 3686400 像素会被上游拒绝）、`quality` 仅 `standard`/`hd`、`watermark`
/// 控制水印（应用侧默认无水印；文档 API 默认值为 true）、`response_format`
/// 控制返回链接或 Base64。
/// 版本附加参数由 `seedream_append_version_parameters` 按能力追加。
///
/// `response_format` 默认 `b64_json`：返回链接时客户端必须再直连供应商的存储域名
/// 下载一次，而该域名常与可连通的 API 域名不同（上游存储/CDN、境外或被代理软件
/// fake-ip 劫持），会把「生成成功」变成「保存失败」。内联 Base64 只需生成这一条
/// 通道即可拿到结果，是唯一不依赖第二次连接的返回方式。
fn seedream_text_to_image_parameters() -> Value {
    json!({
        "size": {
            "type": "string",
            "label": "尺寸",
            "default": "2K",
            "enum": ["2K", "2048x2048", "2848x1600"],
            "order": 0
        },
        "quality": {
            "type": "string",
            "label": "质量",
            "default": "standard",
            "enum": ["standard", "hd"],
            "order": 1
        },
        "watermark": {
            "type": "boolean",
            "label": "添加水印",
            "default": false,
            "order": 2
        },
        "response_format": {
            "type": "string",
            "label": "返回格式",
            "default": "b64_json",
            "enum": ["url", "b64_json"],
            "order": 9
        }
    })
}

/// 按 Seedream 能力版本向参数表追加高级参数（moyu 文档参数表）：
/// - 组图模式 `sequential_image_generation`（auto/disabled）与组图数量
///   `max_images`（1~15，仅 auto 时发送）：Seedream 5.0 / 5.0 lite / 4.5 / 4.0
/// - 提示词优化 `optimize_prompt_mode`（fast/standard）：Seedream 5.0 pro / lite
/// - 输出格式 `output_format`（jpg/png/webp，文档默认 jpg）：Seedream 5.0 /
///   5.0 pro / 5.0 lite
/// - 联网搜索 `web_search`（tools 转换，仅文生图、无媒体输入）：Seedream 5.0 lite
/// - 背景通道 `background`（opaque/transparent）与图层拆分
///   `layer_decomposition`（仅图生图）：Seedream 5.0 pro
fn seedream_append_version_parameters(
    parameters: &mut Map<String, Value>,
    version: Option<&str>,
    image_to_image: bool,
) {
    if matches!(version, Some("5.0" | "5.0-lite" | "4.5" | "4.0")) {
        parameters.insert(
            "sequential_image_generation".into(),
            json!({
                "type": "string",
                "label": "组图模式",
                "default": "disabled",
                "enum": ["disabled", "auto"],
                "order": 3
            }),
        );
        parameters.insert(
            "max_images".into(),
            json!({
                "type": "integer",
                "label": "组图数量",
                "optional": true,
                "default": 4,
                "minimum": 1,
                "maximum": 15,
                "requestField": "sequential_image_generation_options",
                "transform": "max_images_object",
                "order": 4
            }),
        );
    }
    if matches!(version, Some("5.0-pro" | "5.0-lite")) {
        parameters.insert(
            "optimize_prompt_mode".into(),
            json!({
                "type": "string",
                "label": "提示词优化",
                "default": "fast",
                "enum": ["fast", "standard"],
                "requestField": "optimize_prompt_options",
                "transform": "optimize_prompt_mode_object",
                "order": 5
            }),
        );
    }
    if matches!(version, Some("5.0" | "5.0-pro" | "5.0-lite")) {
        parameters.insert(
            "output_format".into(),
            json!({
                "type": "string",
                "label": "输出格式",
                "default": "jpg",
                "enum": ["jpg", "png", "webp"],
                "order": 6
            }),
        );
    }
    if matches!(version, Some("5.0-lite")) && !image_to_image {
        parameters.insert(
            "web_search".into(),
            json!({
                "type": "boolean",
                "label": "联网搜索",
                "default": false,
                "requiresNoMedia": true,
                "requestField": "tools",
                "transform": "web_search_tool",
                "order": 7
            }),
        );
    }
    if matches!(version, Some("5.0-pro")) && image_to_image {
        parameters.insert(
            "background".into(),
            json!({
                "type": "string",
                "label": "背景通道",
                "default": "opaque",
                "enum": ["opaque", "transparent"],
                "order": 7
            }),
        );
        parameters.insert(
            "layer_decomposition".into(),
            json!({
                "type": "boolean",
                "label": "图层拆分",
                "default": false,
                "order": 8
            }),
        );
    }
}

/// GPT-Image 契约的尺寸参数：接口文档规定只接受 `auto` 与三种标准尺寸。
fn gpt_image_size_parameter() -> Value {
    json!({
        "type": "string",
        "label": "尺寸",
        "default": "auto",
        "enum": ["auto", "1024x1024", "1536x1024", "1024x1536"]
    })
}

/// GPT-Image 契约的质量参数：接口文档规定只接受 `auto/high/medium/low`。
fn gpt_image_quality_parameter() -> Value {
    json!({
        "type": "string",
        "label": "质量",
        "default": "auto",
        "enum": ["auto", "high", "medium", "low"]
    })
}

/// GPT-Image 契约的生成数量参数：图片生成与图片编辑接口均声明 `n`，取值范围 1~10，默认 1。
fn gpt_image_count_parameter() -> Value {
    json!({
        "type": "integer",
        "label": "生成数量",
        "default": 1,
        "minimum": 1,
        "maximum": 10
    })
}

/// dall-e 系 OpenAI Images 契约（`/v1/images/generations`）的返回格式参数：`url` 返回
/// 可下载的链接，`b64_json` 把图片内联在响应里。
///
/// 默认 `b64_json`：`url` 需要客户端再对供应商返回的存储地址发第二次请求，而该地址
/// 与生成接口的域名往往不同（上游自有存储/CDN）。当这台机器连得上生成接口却连不上
/// 那个存储域名时，生成成功但结果永远保存不下来；内联 Base64 不引入第二次连接。
/// 兼容性由「下载失败回退 Base64」与用户可改的「返回格式」参数共同兜底：供应商若
/// 忽略该字段仍返回链接，保存阶段会照旧下载。
///
/// **只属于 dall-e 契约**：gpt-image 系列不接受该键（见文生图默认契约里的注释），
/// Seedream 有自己从文档抄来的同名字段（`seedream_text_to_image_parameters`）。
fn openai_image_response_format_parameter() -> Value {
    json!({
        "type": "string",
        "label": "返回格式",
        "default": "b64_json",
        "enum": ["url", "b64_json"],
        "order": 3
    })
}

/// Gemini 图片生成契约的尺寸参数：接口只接受画幅比例（非像素尺寸），默认 `1:1`。
fn gemini_image_size_parameter() -> Value {
    json!({
        "type": "string",
        "label": "尺寸",
        "default": "1:1",
        "enum": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]
    })
}

/// 尚未加入 `n` 参数的早期 GPT Image 文生图默认参数（加入 `n` 前的形状），
/// 用于识别需要迁移到当前契约的已保存定义。
fn gpt_image_text_to_image_parameters_before_n() -> Value {
    json!({
        "size": gpt_image_size_parameter(),
        "quality": gpt_image_quality_parameter()
    })
}

/// 曾把「返回格式」声明为默认 `b64_json` 的 GPT Image 文生图默认参数（本次修正前的
/// 形状），用于识别需要剔除 `response_format` 键的已保存定义。
///
/// 2026-09-15 真机实测：moyu 网关对 `gpt-image-2` 回
/// HTTP 400 `Unknown parameter: 'response_format'`（`code=unknown_parameter`）。
/// `response_format` 只属于 dall-e 系列契约，gpt-image 系列不接受该键，且其结果恒为
/// 内联 Base64，因此当前契约不再声明它。
fn gpt_image_text_to_image_parameters_with_response_format() -> Value {
    json!({
        "size": gpt_image_size_parameter(),
        "quality": gpt_image_quality_parameter(),
        "n": gpt_image_count_parameter(),
        "response_format": openai_image_response_format_parameter()
    })
}

fn default_operation_schema(model_id: &str, operation: GenerationOperation) -> Value {
    match operation {
        GenerationOperation::TextGeneration => {
            let profile = text_request_profile(model_id);
            // 对话端点按 OpenAI 兼容网关声明；方舟连接由 `apply_request_dialect`
            // 改写成原生 `/chat/completions`（两条路径在方舟的 `/api/v3` Base URL 上
            // 也归一到同一地址）。
            let (path, parameter_container) = match profile {
                "anthropic_messages_v1" => ("/v1/messages", "root"),
                "gemini_generate_content_v1" => ("/v1beta/models/{model}:generateContent", "root"),
                _ => ("/v1/chat/completions", "root"),
            };
            json!({
                "resultType": "text",
                "requestProfileId": profile,
                "profileVersion": 1,
                "request": {
                    "path": path,
                    "encoding": "json",
                    "parameterContainer": parameter_container
                },
                "parameters": {}
            })
        }
        GenerationOperation::TextToImage => {
            // Doubao Seedream 契约（moyu 聚合平台）：`size` 只接受 `2K` 及 ≥2K 的
            // 像素尺寸（低于 3686400 像素会被上游拒绝），`quality` 仅 standard/hd，
            // 并支持 watermark 与按版本区分的组图/提示词优化/联网搜索/输出格式参数。
            if is_seedream_image_model(model_id) {
                let version = seedream_image_version(model_id);
                let mut parameters = seedream_text_to_image_parameters();
                if let Some(parameters_object) = parameters.as_object_mut() {
                    seedream_append_version_parameters(parameters_object, version, false);
                }
                // 文生图端点按 OpenAI 兼容网关声明；方舟连接由
                // `apply_request_dialect` 改写成原生 `/images/generations`。
                return json!({
                    "resultType": "image",
                    "requestProfileId": "moyu_seedream_image_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/images/generations",
                        "encoding": "json",
                        "parameterContainer": "root"
                    },
                    "parameters": parameters
                });
            }
            // Gemini 图片生成契约：`size` 只接受画幅比例（1:1/16:9/…），不声明
            // `quality`；上游忽略 `n`（一次只返回一张），因此不声明生成数量参数。
            if is_gemini_image_model(model_id) {
                let mut parameters = Map::new();
                parameters.insert("size".into(), gemini_image_size_parameter());
                return json!({
                    "resultType": "image",
                    "requestProfileId": "openai_images_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/images/generations",
                        "encoding": "json",
                        "parameterContainer": "root"
                    },
                    "parameters": parameters
                });
            }
            // gpt-image 系列（gpt-image-1/1.5/2 …）遵循 GPT Image 契约：
            // quality 只接受 auto/high/medium/low，size 只接受 auto 与三种标准尺寸；
            // 其余模型沿用 dall-e 时代的通用契约（standard/hd）。
            let gpt_image = model_id.to_ascii_lowercase().contains("gpt-image");
            let (size_default, size_enum) = if gpt_image {
                (
                    "auto",
                    json!(["auto", "1024x1024", "1536x1024", "1024x1536"]),
                )
            } else {
                (
                    "1024x1024",
                    json!([
                        "256x256",
                        "512x512",
                        "1024x1024",
                        "1536x1024",
                        "1024x1536",
                        "1792x1024",
                        "1024x1792"
                    ]),
                )
            };
            let (quality_default, quality_enum) = if gpt_image {
                ("auto", json!(["auto", "high", "medium", "low"]))
            } else {
                ("standard", json!(["hd", "standard"]))
            };
            let mut parameters = Map::new();
            parameters.insert(
                "size".into(),
                json!({
                    "type": "string",
                    "label": "尺寸",
                    "default": size_default,
                    "enum": size_enum
                }),
            );
            parameters.insert(
                "quality".into(),
                json!({
                    "type": "string",
                    "label": "质量",
                    "default": quality_default,
                    "enum": quality_enum
                }),
            );
            // GPT Image 契约的图片生成接口还声明生成数量 `n`（1~10，默认 1）。
            if gpt_image {
                parameters.insert("n".into(), gpt_image_count_parameter());
            } else {
                // 返回格式只属于 dall-e 系列：gpt-image 系列既不接受该键（供应商以
                // HTTP 400 unknown_parameter 拒绝），结果也恒为内联 Base64，声明它
                // 只会让整次生成失败，因此不给 gpt-image 声明。
                parameters.insert(
                    "response_format".into(),
                    openai_image_response_format_parameter(),
                );
            }
            json!({
                "resultType": "image",
                "requestProfileId": "openai_images_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/generations",
                    "encoding": "json",
                    "parameterContainer": "root"
                },
                "parameters": parameters
            })
        }
        GenerationOperation::ImageToImage => {
            // Seedream 图生图契约（moyu 聚合平台）：不走 multipart edits 接口，
            // 而是 JSON `POST /v1/images/generations`，参考图通过顶层 `image`
            // 字段传 URL（文档示例 `"image":"https://…"`）；参数容器为 root。
            // 基础参数与文生图一致，5.0 pro 额外支持透明背景与图层拆分。
            if is_seedream_image_model(model_id) {
                let version = seedream_image_version(model_id);
                let mut parameters = seedream_text_to_image_parameters();
                if let Some(parameters_object) = parameters.as_object_mut() {
                    seedream_append_version_parameters(parameters_object, version, true);
                }
                return json!({
                    "resultType": "image",
                    "requestProfileId": "moyu_seedream_image_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/images/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "seedream_image_urls",
                        "mediaField": "image"
                    },
                    "parameters": parameters
                });
            }
            // Gemini 图生图契约（https://doc.moyu.info/9280683m0.md）：与文生图
            // 一致走 OpenAI Images API JSON `POST /v1/images/generations`，参考图
            // 通过顶层 `image` 字段传 data URI（`data:<mime>;base64,<DATA>`，带前缀；
            // 文档示例单张为字符串，多张保持输入顺序为数组），不走 multipart edits
            // 接口。参数容器为 root；`size` 使用画幅比例（与 Gemini 原生格式的
            // `imageConfig.aspectRatio` 同义），不声明 `quality`，且接口忽略 `n`
            // （一次只返回一张，多张由业务侧拆分任务）。
            if is_gemini_image_model(model_id) {
                let mut parameters = Map::new();
                parameters.insert("size".into(), gemini_image_size_parameter());
                return json!({
                    "resultType": "image",
                    "requestProfileId": "openai_images_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/images/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "gemini_image_data_uri",
                        "mediaField": "image"
                    },
                    "parameters": parameters
                });
            }
            // GPT-Image 契约的图片编辑接口（multipart）同样声明 `n`/`size`/`quality`；
            // 其余模型沿用旧契约（只有 model/image[]/prompt）。
            let gpt_image = model_id.to_ascii_lowercase().contains("gpt-image");
            let mut parameters = Map::new();
            if gpt_image {
                parameters.insert("size".into(), gpt_image_size_parameter());
                parameters.insert("quality".into(), gpt_image_quality_parameter());
                parameters.insert("n".into(), gpt_image_count_parameter());
            }
            json!({
                "resultType": "image",
                "requestProfileId": "openai_image_edits_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/edits",
                    "encoding": "multipart",
                    "parameterContainer": "multipart"
                },
                "parameters": parameters
            })
        }
        GenerationOperation::VideoGeneration => {
            let identity = model_id.to_ascii_lowercase();
            // 盘趣聚合网关：顶层 `resolution`/`aspect_ratio`/`duration`，media 为顶层
            // `images` URL 数组。必须排在 Seedance 2.0 分支之前，否则会被当成魔芋契约。
            if is_panqu_video_model(&identity) {
                return panqu_video_operation_schema();
            }
            let vidu = is_vidu_video_model(&identity);
            if vidu {
                // Vidu 系列（魔芋AI 聚合平台）：请求体为顶层字段，`model`/`prompt`/
                // `resolution`/`aspect_ratio`/`duration`/`seed`/`watermark` 均放顶层，
                // `images` 为图生/首尾帧/参考图输入 URL/Base64 数组（1 张=图生、
                // 2 张=首尾帧、≥3 张=参考图，数量自动判定生成模式），
                // `movement_amplitude`/`style`/`audio`/`audio_type`/`off_peak`/`bgm`
                // 等高级参数放入 `metadata` 对象透传。
                // 分辨率受模型白名单前置校验：vidu2.0=360p/720p/1080p、
                // viduq1=仅 1080p、viduq3-pro/viduq3-turbo=540p/720p/1080p。
                // 轮询结果使用 `/v1/videos/{task_id}`（observePath）。
                let default_resolution = if identity.contains("viduq1") {
                    "1080p"
                } else {
                    "720p"
                };
                let resolutions = if identity.contains("vidu2.0") {
                    json!(["360p", "720p", "1080p"])
                } else if identity.contains("viduq1") {
                    json!(["1080p"])
                } else {
                    // viduq3-pro / viduq3-turbo
                    json!(["540p", "720p", "1080p"])
                };
                let durations = (1..=16).map(Value::from).collect::<Vec<_>>();
                return json!({
                    "resultType": "video",
                    "requestProfileId": "moyu_vidu_video_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/video/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "vidu_image_urls",
                        "mediaField": "images",
                        "metadataField": "metadata",
                        "observePath": "/v1/videos/{task_id}"
                    },
                    "parameters": {
                        "resolution": {
                            "type": "string",
                            "label": "分辨率",
                            "default": default_resolution,
                            "enum": resolutions,
                            "order": 0
                        },
                        "aspect_ratio": {
                            "type": "string",
                            "label": "画幅",
                            "default": "16:9",
                            "enum": ["16:9", "9:16", "1:1", "3:4", "4:3"],
                            "order": 1
                        },
                        "duration": {
                            "type": "integer",
                            "label": "时长",
                            "default": 5,
                            "enum": durations,
                            "order": 2
                        },
                        "seed": {
                            "type": "integer",
                            "label": "随机种子",
                            "optional": true,
                            "minimum": -1,
                            "maximum": 4294967295i64,
                            "order": 3
                        },
                        "watermark": {
                            "type": "boolean",
                            "label": "添加水印",
                            "default": false,
                            "order": 4
                        },
                        "movement_amplitude": {
                            "type": "string",
                            "label": "运动幅度",
                            "default": "auto",
                            "enum": ["auto", "small", "medium", "large"],
                            "requestLocation": "metadata",
                            "order": 5
                        },
                        "style": {
                            "type": "string",
                            "label": "风格",
                            "default": "general",
                            "enum": ["general", "anime"],
                            "requestLocation": "metadata",
                            "order": 6
                        },
                        "audio": {
                            "type": "boolean",
                            "label": "生成音频",
                            "default": true,
                            "requestLocation": "metadata",
                            "order": 7
                        },
                        "audio_type": {
                            "type": "string",
                            "label": "音频类型",
                            "optional": true,
                            "requestLocation": "metadata",
                            "order": 8
                        },
                        "off_peak": {
                            "type": "boolean",
                            "label": "闲时模式",
                            "default": false,
                            "requestLocation": "metadata",
                            "order": 9
                        },
                        "bgm": {
                            "type": "boolean",
                            "label": "背景音乐",
                            "default": false,
                            "requestLocation": "metadata",
                            "order": 10
                        }
                    }
                });
            }
            if is_minimax_h3_video_model(&identity) {
                // MiniMax-H3（魔芋平台新一代视频生成模型）：请求体为顶层字段，
                // `model`/`prompt`/`duration`/`resolution`/`ratio`/`aigc_watermark`
                // 均放顶层；媒体通过 `metadata` 传入：`first_frame_image`（首帧，
                // ≤1）、`last_frame_image`（尾帧，≤1）、`reference_images`（参考图
                // 数组，≤9）、`reference_videos`（参考视频数组，≤3）、
                // `reference_audios`（参考音频数组，≤3）。
                // `metadata.task_type` 区分任务类型：generation（文生/图生/参考
                // 生成，默认）、regeneration（768P→2K 再生成，连接的源视频作为
                // `base_video_url`，输出时长由源视频决定，不发送 duration）。
                // 轮询使用默认 `GET /v1/video/generations/{task_id}`。
                return json!({
                    "resultType": "video",
                    "requestProfileId": "moyu_minimax_h3_video_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/video/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "minimax_h3_media",
                        "metadataField": "metadata"
                    },
                    "parameters": {
                        "task_type": {
                            "type": "string",
                            "label": "任务类型",
                            "default": "generation",
                            "enum": ["generation", "regeneration", "h3_context_ir"],
                            "requestLocation": "metadata",
                            "order": 0
                        },
                        "resolution": {
                            "type": "string",
                            "label": "分辨率",
                            "default": "2K",
                            "enum": ["768P", "2K"],
                            "order": 1
                        },
                        "ratio": {
                            "type": "string",
                            "label": "画幅",
                            "default": "adaptive",
                            "enum": ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
                            "order": 2
                        },
                        "duration": {
                            "type": "integer",
                            "label": "时长",
                            "default": 5,
                            "enum": (4..=15).map(Value::from).collect::<Vec<_>>(),
                            "order": 3
                        },
                        "aigc_watermark": {
                            "type": "boolean",
                            "label": "AIGC水印",
                            "default": false,
                            "order": 4
                        }
                    }
                });
            }
            let veo = is_veo_video_model(&identity);
            if veo {
                // Veo（Google Veo，魔芋AI 代理）：请求体为顶层字段，`resolution`
                // 必填（720p/1080p），1080p 要求 duration 必须为 8；`images` 为图生
                // 视频参考图 URL 数组（只支持公网 http/https URL，不支持 base64）；
                // 其余可选项（negativePrompt/sampleCount/enhancePrompt/seed）放入
                // `metadata` 对象。
                return json!({
                    "resultType": "video",
                    "requestProfileId": "moyu_veo_video_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/video/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "veo_image_urls",
                        "mediaField": "images",
                        "metadataField": "metadata"
                    },
                    "parameters": {
                        "resolution": {
                            "type": "string",
                            "label": "分辨率",
                            "default": "720p",
                            "enum": ["720p", "1080p"],
                            "order": 0
                        },
                        "aspect_ratio": {
                            "type": "string",
                            "label": "画幅",
                            "default": "16:9",
                            "enum": ["16:9", "9:16"],
                            "order": 1
                        },
                        "duration": {
                            "type": "integer",
                            "label": "时长",
                            "default": 8,
                            "enum": [4, 6, 8],
                            "order": 2
                        },
                        "negativePrompt": {
                            "type": "string",
                            "label": "反向提示词",
                            "optional": true,
                            "requestLocation": "metadata",
                            "order": 3
                        },
                        "sampleCount": {
                            "type": "integer",
                            "label": "单次生成数",
                            "default": 1,
                            "minimum": 1,
                            "maximum": 4,
                            "requestLocation": "metadata",
                            "order": 4
                        },
                        "enhancePrompt": {
                            "type": "boolean",
                            "label": "提示词优化",
                            "default": true,
                            "requestLocation": "metadata",
                            "order": 5
                        },
                        "seed": {
                            "type": "integer",
                            "label": "随机种子",
                            "optional": true,
                            "minimum": 0,
                            "maximum": 4294967295i64,
                            "requestLocation": "metadata",
                            "order": 6
                        }
                    }
                });
            }
            let wan_30 = is_wan_30_video_model(&identity);
            if wan_30 {
                let mut durations = vec![json!(-1)];
                durations.extend((2..=30).map(Value::from));
                return json!({
                    "resultType": "video",
                    "requestProfileId": "moyu_wan3_video_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/video/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "mediaEncoding": "wan_media_array",
                        "mediaField": "media",
                        "promptMode": "prompt_or_media"
                    },
                    "parameters": {
                        "resolution": {
                            "type": "string",
                            "label": "分辨率",
                            "default": "1080P",
                            "enum": ["480P", "720P", "1080P"],
                            "order": 0
                        },
                        "ratio": {
                            "type": "string",
                            "label": "画幅",
                            "default": "adaptive",
                            "enum": ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
                            "order": 1
                        },
                        "duration": {
                            "type": "integer",
                            "label": "时长",
                            "default": 5,
                            "enum": durations,
                            "order": 2
                        },
                        "seed": {
                            "type": "integer",
                            "label": "随机种子",
                            "optional": true,
                            "minimum": 0,
                            "maximum": 2147483647,
                            "order": 3
                        },
                        "watermark": {
                            "type": "boolean",
                            "label": "添加水印",
                            "default": false,
                            "order": 4
                        }
                    }
                });
            }
            let seedance_25 = is_seedance_25_video_model(&identity);
            let seedance_20 = is_seedance_20_video_model(&identity);
            let dreamina = is_dreamina_seedance_video_model(&identity);
            let fast_or_mini = identity.contains("fast") || identity.contains("mini");
            let durations = if seedance_25 {
                let mut values = vec![json!(-1)];
                values.extend((4..=30).map(Value::from));
                Value::Array(values)
            } else if seedance_20 {
                let mut values = vec![json!(-1)];
                values.extend((4..=15).map(Value::from));
                Value::Array(values)
            } else {
                Value::Array(Vec::new())
            };
            // 海外 Dreamina Seedance 仅开放 720p/480p；国内 Seedance 2.5 官方全平台
            // 支持 1080p（文档曾前后矛盾，现已确认），2.5 的 fast/mini 变体保持 720p/480p。
            let resolutions = if dreamina || (seedance_25 && fast_or_mini) {
                json!(["720p", "480p"])
            } else if seedance_25 {
                json!(["720p", "480p", "1080p"])
            } else if seedance_20 {
                json!(["720p", "480p", "1080p", "4k"])
            } else {
                Value::Array(Vec::new())
            };
            let mut parameters = Map::new();
            if seedance_20 || seedance_25 {
                parameters.insert(
                    "ratio".into(),
                    json!({
                        "type": "string",
                        "label": "画幅",
                        "default": "adaptive",
                        "enum": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]
                    }),
                );
                parameters.insert(
                    "resolution".into(),
                    json!({ "type": "string", "label": "分辨率", "default": "720p", "enum": resolutions }),
                );
                parameters.insert(
                    "duration".into(),
                    json!({ "type": "integer", "label": "时长", "default": if seedance_25 { -1 } else { 5 }, "enum": durations }),
                );
                parameters.insert(
                    "generate_audio".into(),
                    json!({ "type": "boolean", "label": "生成音频", "default": true }),
                );
            }
            // 联网搜索：Seedance 2.0 标准版，以及全部 Seedance 2.5（国内与海外）均支持，
            // 仅在无媒体输入的文生视频场景启用。
            if (seedance_20 && !identity.contains("mini")) || seedance_25 {
                parameters.insert(
                    "web_search".into(),
                    json!({
                        "type": "boolean",
                        "label": "联网搜索",
                        "default": false,
                        "requiresNoMedia": true,
                        "requestField": "tools",
                        "transform": "web_search_tool"
                    }),
                );
            }
            if seedance_25 {
                parameters.insert(
                    "output_format".into(),
                    json!({ "type": "string", "label": "输出格式", "default": "mp4", "enum": ["mp4", "mov"] }),
                );
                if dreamina {
                    parameters.insert(
                        "priority".into(),
                        json!({
                            "type": "integer",
                            "label": "执行优先级",
                            "default": 0,
                            "minimum": 0,
                            "maximum": 9
                        }),
                    );
                } else {
                    parameters.insert(
                        "omni_reference_task_type".into(),
                        json!({
                            "type": "string",
                            "label": "任务类型",
                            "default": "auto",
                            "enum": ["auto", "reference", "edit", "extend"]
                        }),
                    );
                }
            }
            // 视频提交端点按 OpenAI 兼容网关声明（`/v1/video/generations` +
            // `metadata` 容器）；方舟连接由 `apply_request_dialect` 改写成原生
            // `/contents/generations/tasks`（参数平铺在根级）。端点属于供应商连接，
            // 不随模型名变化。
            json!({
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": parameters
            })
        }
    }
}

/// 把早期版本已经保存的 Wan 3.0 通用视频档案升级为 Wan 专用协议。
///
/// 旧档案把 `parameters: {}` 当成供应商的权威声明，因而覆盖了后来新增的
/// Wan 默认参数；同时仍使用 Seedance 的 `metadata.content` 请求协议。这里只对
/// 明确的 Wan 3.0 模型身份执行升级，其他模型显式声明的空参数仍保持权威。
pub fn refresh_wan_30_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_wan_30_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let parameters_are_empty = operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty);
    let request = operation.get("request").and_then(Value::as_object);
    let has_wan_profile = operation.get("requestProfileId").and_then(Value::as_str)
        == Some("moyu_wan3_video_v1")
        && request
            .and_then(|request| request.get("mediaEncoding"))
            .and_then(Value::as_str)
            == Some("wan_media_array")
        && request
            .and_then(|request| request.get("parameterContainer"))
            .and_then(Value::as_str)
            == Some("root");
    if !parameters_are_empty && has_wan_profile {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    // 若供应商曾声明非空的扩展参数，保留它们；Wan 的五个规范参数和请求协议
    // 仍由当前版本档案提供。
    if let Some(provided_parameters) = operation.get("parameters").and_then(Value::as_object)
        && !provided_parameters.is_empty()
        && let Some(target_parameters) = replacement
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
    {
        for (key, value) in provided_parameters {
            target_parameters
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把旧版本为海外 Dreamina Seedance 模型保存的空视频参数档案升级为当前协议。
///
/// 海外模型 ID 使用 `seedance-2.0` / `seedance-2.5` 点号版本；旧版本只识别
/// 国内模型的 `seedance-2-0` / `seedance-2-5` 连字符版本，因此虽然能判断为
/// 视频模型，却会把 `parameters: {}` 持久化。只修复明确的 Dreamina 模型和空参数，
/// 避免覆盖供应商下发的非空自定义字段。
pub fn refresh_dreamina_seedance_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_dreamina_seedance_video_model(model_id)
        || (!is_seedance_20_video_model(model_id) && !is_seedance_25_video_model(model_id))
    {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if !operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty)
    {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把历史版本为 Seedance 2.0 系列保存的视频参数档案补上 `duration=-1`（智能时长）。
///
/// Seedance 系列文档将 `duration=-1` 作为通用取值，由模型在有效范围内自主选择
/// 时长；早期版本只对 2.5 暴露了该选项，2.0 已保存的档案需要原位补齐 `-1`，
/// 避免覆盖服务商下发的非空自定义参数。
pub fn refresh_seedance_20_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_seedance_20_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if !operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty)
    {
        let Some(parameters) = operation
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
        else {
            return false;
        };
        let Some(duration) = parameters
            .get_mut("duration")
            .and_then(Value::as_object_mut)
        else {
            return false;
        };
        let Some(values) = duration.get_mut("enum").and_then(Value::as_array_mut) else {
            return false;
        };
        if !values.iter().any(|value| value.as_i64() == Some(-1)) {
            values.insert(0, json!(-1));
            return true;
        }
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把历史版本为国内 Seedance 2.5 模型保存的视频参数档案刷新到当前能力。
///
/// 早期版本因官方文档对 `1080p` 与联网搜索支持前后矛盾，把国内
/// `doubao-seedance-2-5-...` 的分辨率限制为 `480p/720p` 且不提供
/// `web_search`。用户确认该模型在所有官方平台均支持联网搜索与 1080p：
/// - 空参数档案：整体替换为当前默认（与 Wan / Dreamina 的升级一致）；
/// - 非空档案：原位补齐缺失的 `1080p` 分辨率与 `web_search` 定义，
///   不覆盖服务商下发的自定义参数。
pub fn refresh_seedance_25_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_seedance_25_video_model(model_id) || is_dreamina_seedance_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if !operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty)
    {
        let Some(parameters) = operation
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
        else {
            return false;
        };
        let mut changed = false;
        if let Some(resolution) = parameters
            .get_mut("resolution")
            .and_then(Value::as_object_mut)
            && let Some(values) = resolution.get_mut("enum").and_then(Value::as_array_mut)
            && !values.iter().any(|value| value == "1080p")
        {
            values.push(json!("1080p"));
            changed = true;
        }
        if !parameters.contains_key("web_search") {
            parameters.insert(
                "web_search".into(),
                json!({
                    "type": "boolean",
                    "label": "联网搜索",
                    "default": false,
                    "requiresNoMedia": true,
                    "requestField": "tools",
                    "transform": "web_search_tool"
                }),
            );
            changed = true;
        }
        return changed;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把旧版本为 Veo 模型保存的空视频参数档案刷新为当前协议。
///
/// Veo 是新增模型家族；若供应商下发或历史档案里出现空 `parameters: {}`，会覆盖
/// 当前版本的顶层参数（resolution/aspect_ratio/duration）与 metadata 可选参数，
/// 导致请求缺少必填的 `resolution` 而被平台拒绝。只修复明确的 Veo 模型与空参数，
/// 避免覆盖供应商下发的非空自定义字段。
pub fn refresh_veo_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_veo_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if !operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty)
    {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把旧版本为 Vidu 模型保存的空视频参数档案刷新为当前协议。
///
/// Vidu 是新增模型家族；若供应商下发或历史档案里出现空 `parameters: {}`，会覆盖
/// 当前版本的顶层参数（resolution/aspect_ratio/duration/seed/watermark）与
/// metadata 高级参数，导致请求缺少模型能力白名单而可能被平台拒绝。只修复明确的
/// Vidu 模型与空参数，避免覆盖供应商下发的非空自定义字段。
pub fn refresh_vidu_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_vidu_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if !operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty)
    {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}

/// 把旧版本为 MiniMax-H3 保存的视频参数档案刷新为当前 MiniMax-H3 契约。
///
/// MiniMax-H3 是新增模型家族；若供应商下发或历史档案里出现空 `parameters: {}`
/// （旧版本只按通用视频模型处理），会覆盖当前版本的分辨率/画幅/时长等顶层参数与
/// `minimax_h3_media` 请求档案，导致请求缺少能力白名单而可能被平台拒绝。只修复
/// 明确的 MiniMax-H3 模型与空参数，避免覆盖供应商下发的非空自定义字段。
pub fn refresh_minimax_h3_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_minimax_h3_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let parameters_are_empty = operation
        .get("parameters")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty);
    let request = operation.get("request").and_then(Value::as_object);
    let has_minimax_profile = operation.get("requestProfileId").and_then(Value::as_str)
        == Some("moyu_minimax_h3_video_v1")
        && request
            .and_then(|request| request.get("mediaEncoding"))
            .and_then(Value::as_str)
            == Some("minimax_h3_media");
    if !parameters_are_empty && has_minimax_profile {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        .as_object()
        .cloned()
        .unwrap_or_default();
    // 若供应商曾声明非空的扩展参数，保留它们；MiniMax-H3 的规范参数和请求协议
    // 仍由当前版本档案提供。
    if let Some(provided_parameters) = operation.get("parameters").and_then(Value::as_object)
        && !provided_parameters.is_empty()
        && let Some(target_parameters) = replacement
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
    {
        for (key, value) in provided_parameters {
            target_parameters
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    *operation = replacement;
    true
}
/// 历史版本写入的文生图默认参数（dall-e 契约）。gpt-image 系列的供应商会以
/// HTTP 400 拒绝其中的 `standard`/`hd` 质量与 dall-e 尺寸，需要迁移。
fn legacy_text_to_image_parameters() -> Value {
    json!({
        "size": {
            "type": "string",
            "label": "尺寸",
            "default": "1024x1024",
            "enum": ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"]
        },
        "quality": {
            "type": "string",
            "label": "质量",
            "default": "standard",
            "enum": ["hd", "standard"]
        }
    })
}

/// 历史版本把 dall-e 契约当作所有文生图模型的默认参数持久化进了
/// `model_definitions`。若参数仍是历史默认值（说明并非服务商下发的自定义参数），
/// 则原位替换为当前默认值；其余情况一律不动。
///
/// 迁移的三类历史形状：
/// - dall-e 旧契约（`1024x1024` + `standard`）——gpt-image 供应商会以 HTTP 400 拒绝；
/// - 尚未加入 `n` 的早期 GPT Image 契约；
/// - 曾声明返回格式 `response_format` 的 GPT Image 契约（上游以 HTTP 400
///   `unknown_parameter` 拒绝该键，因此当前契约剔除它）。
///
/// Gemini 与 Seedream 各有自己的契约刷新（`refresh_gemini_image_parameter_defaults`、
/// `refresh_seedream_image_parameter_defaults`），这里显式让出，避免互相覆盖。
/// 也把 gpt-image 图生图的历史空参数（旧契约不支持 size/quality/n）刷新为当前契约。
/// 返回是否发生了替换。
pub fn refresh_legacy_image_parameter_defaults(schema: &mut Value, model_id: &str) -> bool {
    if is_gemini_image_model(model_id) || is_seedream_image_model(model_id) {
        return false;
    }
    let gpt_image = model_id.to_ascii_lowercase().contains("gpt-image");
    let mut changed = false;
    // 文生图：dall-e 旧契约、早期 GPT Image 契约或带返回格式的旧契约 → 刷新为当前契约。
    if let Some(definition) = schema
        .get_mut("text_to_image")
        .and_then(Value::as_object_mut)
    {
        let legacy = legacy_text_to_image_parameters();
        let before_n = gpt_image_text_to_image_parameters_before_n();
        let with_response_format = gpt_image_text_to_image_parameters_with_response_format();
        if definition.get("parameters") == Some(&legacy)
            || definition.get("parameters") == Some(&before_n)
            || definition.get("parameters") == Some(&with_response_format)
        {
            if let Some(parameters) =
                default_operation_schema(model_id, GenerationOperation::TextToImage)
                    .get("parameters")
                    .cloned()
            {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    // 图生图：历史契约（旧接口不支持 size/quality/n）持久化为空参数 → 刷新为当前契约。
    // 仅对 gpt-image 生效：其他模型（如通用 dall-e 契约）的图生图当前默认本就是空参数。
    if gpt_image
        && let Some(definition) = schema
            .get_mut("image_to_image")
            .and_then(Value::as_object_mut)
    {
        let parameters_empty = definition
            .get("parameters")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty);
        if parameters_empty {
            if let Some(parameters) =
                default_operation_schema(model_id, GenerationOperation::ImageToImage)
                    .get("parameters")
                    .cloned()
            {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    changed
}

/// Gemini 图片模型的文生图契约变更：历史版本按 dall-e 通用契约把像素尺寸
/// （`1024x1024` 等）与 `quality`（`standard`/`hd`）持久化进了 `model_definitions`，
/// 而 Gemini 图片生成接口只接受画幅比例 `size`（`1:1`/`16:9`/…）且忽略 `n`。
/// 若参数仍是旧默认形状（说明并非服务商下发的自定义参数），则原位替换为当前契约。
///
/// 图生图契约变更：历史版本按通用 multipart edits 契约（`POST /v1/images/edits`、
/// `image[]` 文件 part、无参数）保存，而 Gemini 图生图走 JSON
/// `POST /v1/images/generations`（顶层 `image` data URI + `size` 参数）。若参数
/// 为空或请求编码仍是 multipart（说明并非服务商下发的自定义 JSON 契约），则把
/// request 与 parameters 一并刷新为当前契约。
/// 返回是否发生了替换。
pub fn refresh_gemini_image_parameter_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_gemini_image_model(model_id) {
        return false;
    }
    let mut changed = false;
    let legacy = legacy_text_to_image_parameters();
    if let Some(definition) = schema
        .get_mut("text_to_image")
        .and_then(Value::as_object_mut)
    {
        if definition.get("parameters") == Some(&legacy) {
            if let Some(parameters) =
                default_operation_schema(model_id, GenerationOperation::TextToImage)
                    .get("parameters")
                    .cloned()
            {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    // 图生图：历史 multipart edits 契约（空参数 / 非 JSON 编码）→ 刷新为 JSON 图生图契约。
    if let Some(definition) = schema
        .get_mut("image_to_image")
        .and_then(Value::as_object_mut)
    {
        let parameters_empty = definition
            .get("parameters")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty);
        let encoding = definition
            .get("request")
            .and_then(Value::as_object)
            .and_then(|request| request.get("encoding"))
            .and_then(Value::as_str)
            .unwrap_or("multipart");
        if parameters_empty || encoding != "json" {
            let current = default_operation_schema(model_id, GenerationOperation::ImageToImage);
            if let Some(request) = current.get("request").cloned() {
                definition.insert("request".into(), request);
                changed = true;
            }
            if let Some(parameters) = current.get("parameters").cloned() {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    changed
}

/// 上一版 Seedream 默认参数形状（本次文档契约变更前的生成器输出：`watermark`
/// 默认 `false`、无 `response_format`、`output_format` 为 `jpeg`/`png`）。用于把
/// 历史保存的默认参数原位刷新为当前文档契约；服务商下发的自定义参数形状
/// （含额外键或不同默认值）不会被匹配，避免覆盖第三方配置。
fn previous_seedream_image_parameters(version: Option<&str>, image_to_image: bool) -> Value {
    let mut parameters = Map::new();
    parameters.insert(
        "size".into(),
        json!({
            "type": "string",
            "label": "尺寸",
            "default": "2K",
            "enum": ["2K", "2048x2048", "2848x1600"],
            "order": 0
        }),
    );
    parameters.insert(
        "quality".into(),
        json!({
            "type": "string",
            "label": "质量",
            "default": "standard",
            "enum": ["standard", "hd"],
            "order": 1
        }),
    );
    parameters.insert(
        "watermark".into(),
        json!({
            "type": "boolean",
            "label": "添加水印",
            "default": false,
            "order": 2
        }),
    );
    if matches!(version, Some("5.0-lite" | "4.5" | "4.0")) {
        parameters.insert(
            "sequential_image_generation".into(),
            json!({
                "type": "string",
                "label": "组图模式",
                "default": "disabled",
                "enum": ["disabled", "auto"],
                "order": 3
            }),
        );
        parameters.insert(
            "max_images".into(),
            json!({
                "type": "integer",
                "label": "组图数量",
                "optional": true,
                "default": 4,
                "minimum": 1,
                "maximum": 15,
                "requestField": "sequential_image_generation_options",
                "transform": "max_images_object",
                "order": 4
            }),
        );
    }
    if matches!(version, Some("5.0-pro" | "5.0-lite")) {
        parameters.insert(
            "optimize_prompt_mode".into(),
            json!({
                "type": "string",
                "label": "提示词优化",
                "default": "fast",
                "enum": ["fast", "standard"],
                "requestField": "optimize_prompt_options",
                "transform": "optimize_prompt_mode_object",
                "order": 5
            }),
        );
        parameters.insert(
            "output_format".into(),
            json!({
                "type": "string",
                "label": "输出格式",
                "default": "jpeg",
                "enum": ["jpeg", "png"],
                "order": 6
            }),
        );
    }
    if matches!(version, Some("5.0-lite")) && !image_to_image {
        parameters.insert(
            "web_search".into(),
            json!({
                "type": "boolean",
                "label": "联网搜索",
                "default": false,
                "requiresNoMedia": true,
                "requestField": "tools",
                "transform": "web_search_tool",
                "order": 7
            }),
        );
    }
    if matches!(version, Some("5.0-pro")) && image_to_image {
        parameters.insert(
            "background".into(),
            json!({
                "type": "string",
                "label": "背景通道",
                "default": "opaque",
                "enum": ["opaque", "transparent"],
                "order": 7
            }),
        );
        parameters.insert(
            "layer_decomposition".into(),
            json!({
                "type": "boolean",
                "label": "图层拆分",
                "default": false,
                "order": 8
            }),
        );
    }
    Value::Object(parameters)
}

/// Seedream 图片模型的契约变更：历史版本按 dall-e 通用契约把像素尺寸
/// （`1024x1024` 等）与 `quality`（`standard`/`hd`）持久化进了 `model_definitions`，
/// 而 moyu 的 Seedream 图片接口只接受 2K 及以上的尺寸（`2K`/`2048x2048`/
/// `2848x1600`），并支持 watermark、返回格式与组图等专属参数。
/// 若参数仍是旧默认形状（dall-e 旧契约、上一版 Seedream 默认形状，说明并非
/// 服务商下发的自定义参数），则原位替换为当前契约；图生图的历史空参数
/// （旧契约不支持 size/quality 等）同样刷新。
/// 返回是否发生了替换。
pub fn refresh_seedream_image_parameter_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_seedream_image_model(model_id) {
        return false;
    }
    let mut changed = false;
    let version = seedream_image_version(model_id);
    let current_parameters = |operation: GenerationOperation| -> Option<Value> {
        default_operation_schema(model_id, operation)
            .get("parameters")
            .cloned()
    };
    // 文生图：dall-e 旧契约 / 上一版 Seedream 默认 → 刷新为当前文档契约。
    if let Some(definition) = schema
        .get_mut("text_to_image")
        .and_then(Value::as_object_mut)
    {
        let legacy = legacy_text_to_image_parameters();
        let previous = previous_seedream_image_parameters(version, false);
        let parameters_empty = definition
            .get("parameters")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty);
        if definition.get("parameters") == Some(&legacy)
            || definition.get("parameters") == Some(&previous)
            || parameters_empty
        {
            if let Some(parameters) = current_parameters(GenerationOperation::TextToImage) {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    // 图生图：历史契约（旧接口按 multipart 空参数保存）→ 刷新为 Seedream JSON 契约。
    if let Some(definition) = schema
        .get_mut("image_to_image")
        .and_then(Value::as_object_mut)
    {
        let previous = previous_seedream_image_parameters(version, true);
        let parameters_empty = definition
            .get("parameters")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty);
        if definition.get("parameters") == Some(&previous) || parameters_empty {
            if let Some(parameters) = current_parameters(GenerationOperation::ImageToImage) {
                definition.insert("parameters".into(), parameters);
                changed = true;
            }
        }
    }
    changed
}

fn validate_parameter_value(
    key: &str,
    definition: &Map<String, Value>,
    value: &Value,
) -> BackendResult<()> {
    let valid_type = match definition.get("type").and_then(Value::as_str) {
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("number") => value.is_number(),
        Some("string") | None => value.is_string(),
        Some(unsupported) => {
            return Err(BackendError::validation(
                "model parameter schema uses an unsupported type",
                json!({ "parameter": key, "type": unsupported }),
            ));
        }
    };
    if !valid_type {
        return Err(BackendError::validation(
            "model parameter has the wrong JSON type",
            json!({ "parameter": key, "value": value, "expected": definition.get("type") }),
        ));
    }
    if let Some(values) = definition.get("enum").and_then(Value::as_array)
        && !values.contains(value)
    {
        return Err(BackendError::validation(
            "model parameter is outside its allowed values",
            json!({ "parameter": key, "value": value, "allowed": values }),
        ));
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = definition.get("minimum").and_then(Value::as_f64)
            && number < minimum
        {
            return Err(BackendError::validation(
                "model parameter is below its minimum",
                json!({ "parameter": key, "value": number, "minimum": minimum }),
            ));
        }
        if let Some(maximum) = definition.get("maximum").and_then(Value::as_f64)
            && number > maximum
        {
            return Err(BackendError::validation(
                "model parameter is above its maximum",
                json!({ "parameter": key, "value": number, "maximum": maximum }),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_schema_prefers_advertised_fields_and_aliases() {
        let item = json!({
            "id": "company-video",
            "capabilities": {
                "operations": {
                    "video_generation": {
                        "parameters": {
                            "frames": {
                                "type": "integer",
                                "default": 48,
                                "enum": [24, 48],
                                "requestField": "frame_count"
                            }
                        }
                    }
                }
            }
        });
        let schema = infer_catalog_schema(&item, "company-video", "Company Video");
        assert_eq!(
            schema["video_generation"]["parameters"]["frames"]["requestField"],
            "frame_count"
        );
        assert_eq!(
            operations_from_schema(&schema),
            [GenerationOperation::VideoGeneration]
        );
    }

    #[test]
    fn unknown_catalog_models_are_not_guessed() {
        let schema = infer_catalog_schema(
            &json!({ "id": "company-model" }),
            "company-model",
            "Company",
        );
        assert_eq!(schema, json!({}));
    }

    #[test]
    fn text_models_are_inferred_with_matching_request_profile() {
        for (model_id, expected_profile) in [
            ("gpt-4o", "openai_chat_v1"),
            ("doubao-seed-1-8-251228", "openai_chat_v1"),
            ("claude-sonnet-4-5-20250929", "anthropic_messages_v1"),
            ("gemini-2.5-flash", "gemini_generate_content_v1"),
            ("deepseek-v3", "openai_chat_v1"),
        ] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["text_generation"];
            assert_eq!(definition["resultType"], "text", "model {model_id}");
            assert_eq!(
                definition["requestProfileId"], expected_profile,
                "model {model_id}"
            );
            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::TextGeneration],
                "model {model_id}"
            );
        }
    }

    #[test]
    fn seedance_models_are_video_not_text() {
        let schema = infer_catalog_schema(
            &json!({ "id": "doubao-seedance-2-5-260628" }),
            "doubao-seedance-2-5-260628",
            "Seedance 2.5",
        );
        assert!(schema.get("text_generation").is_none());
        assert!(schema.get("video_generation").is_some());
    }

    #[test]
    fn dreamina_seedance_models_use_the_overseas_parameter_contract() {
        for model_id in ["dreamina-seedance-2.0", "dreamina-seedance-2.0-fast"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let parameters = &schema["video_generation"]["parameters"];
            assert_eq!(
                parameters["resolution"]["enum"],
                json!(["720p", "480p"]),
                "model {model_id}"
            );
            assert_eq!(parameters["duration"]["enum"].as_array().unwrap().len(), 13);
            assert_eq!(parameters["generate_audio"]["default"], true);
            assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
        }

        let schema = infer_catalog_schema(
            &json!({ "id": "dreamina-seedance-2.5" }),
            "dreamina-seedance-2.5",
            "Dreamina Seedance 2.5",
        );
        let parameters = &schema["video_generation"]["parameters"];
        assert_eq!(parameters["resolution"]["enum"], json!(["720p", "480p"]));
        assert_eq!(parameters["duration"]["enum"].as_array().unwrap().len(), 28);
        assert_eq!(parameters["output_format"]["enum"], json!(["mp4", "mov"]));
        assert_eq!(parameters["priority"]["minimum"], 0);
        assert_eq!(parameters["priority"]["maximum"], 9);
        assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
        assert!(parameters.get("omni_reference_task_type").is_none());

        let domestic = default_model_schema(
            "doubao-seedance-2-5-260628",
            &[GenerationOperation::VideoGeneration],
        );
        let domestic_parameters = &domestic["video_generation"]["parameters"];
        assert!(
            domestic_parameters
                .get("omni_reference_task_type")
                .is_some()
        );
        assert!(domestic_parameters.get("priority").is_none());
    }

    #[test]
    fn video_endpoints_follow_the_connection_dialect_instead_of_the_model_name() {
        // 线上事故回归：`doubao-seedance-*` 曾被按模型名硬编码成方舟原生端点，网关连接
        // 因此请求 `/v1/contents/generations/tasks` 并拿到 HTTP 404 `Invalid URL`。
        // 契约由连接适配器决定：方舟原生端点只在方舟连接上出现。
        assert_eq!(
            RequestDialect::for_adapter(super::super::provider_adapter::ARK_ADAPTER_ID),
            RequestDialect::VolcengineArk
        );
        assert_eq!(
            RequestDialect::for_adapter(super::super::provider_adapter::MOYU_ADAPTER_ID),
            RequestDialect::OpenAiCompatible
        );

        // 暴露给前端的目录契约（拉取模型）也按连接方言落定。
        let advertised = json!({
            "id": "doubao-seedance-2.5",
            "operations": ["video_generation"],
        });
        let gateway =
            infer_catalog_schema(&advertised, "doubao-seedance-2.5", "doubao-seedance-2.5");
        // `infer_catalog_schema` 只认识模型名，因此规范值是网关契约；
        // `apply_request_dialect` 是方舟连接唯一的改写入口。
        let mut ark = gateway.clone();
        assert!(apply_request_dialect(
            &mut ark,
            "doubao-seedance-2.5",
            RequestDialect::VolcengineArk
        ));
        assert_eq!(
            ark["video_generation"]["request"]["path"],
            "/contents/generations/tasks"
        );
        assert_eq!(
            ark["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            ark["video_generation"]["request"]["contentContainer"],
            "root"
        );
        assert_eq!(
            ark["video_generation"]["request"]["observePath"],
            "/contents/generations/tasks/{task_id}"
        );

        // 已保存/前端回传的方舟原生契约，在网关连接上会被改回 `/v1/video/generations`
        // （参数与 content 回到 metadata，原生轮询路径移除）。这正是用户库里被写坏的
        // 定义在下次打开应用时被修好的路径。
        let mut stale = default_model_schema(
            "doubao-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
        );
        stale["video_generation"]["request"] = json!({
            "path": "/contents/generations/tasks",
            "encoding": "json",
            "parameterContainer": "root",
            "contentContainer": "root",
            "observePath": "/contents/generations/tasks/{task_id}"
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "doubao-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["request"]["path"],
            "/v1/video/generations"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "metadata"
        );
        assert!(
            repaired["video_generation"]["request"]
                .get("observePath")
                .is_none()
        );

        // 其他家族自己的端点不受影响：盘趣网关顶层字段契约、Vidu 的 `/v1/videos` 轮询
        // 在两种方言下都保持原样（方舟上没有它们的位置）。
        let mut panqu =
            default_model_schema("pan-seedance-2.0", &[GenerationOperation::VideoGeneration]);
        assert!(!apply_request_dialect(
            &mut panqu,
            "pan-seedance-2.0",
            RequestDialect::VolcengineArk
        ));
        assert_eq!(
            panqu["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        let mut vidu = default_model_schema("viduq3-pro", &[GenerationOperation::VideoGeneration]);
        assert!(!apply_request_dialect(
            &mut vidu,
            "viduq3-pro",
            RequestDialect::VolcengineArk
        ));
        assert_eq!(
            vidu["video_generation"]["request"]["observePath"],
            "/v1/videos/{task_id}"
        );
        assert_eq!(
            vidu["video_generation"]["request"]["path"],
            "/v1/video/generations"
        );
    }

    #[test]
    fn bailian_dialect_rewrites_wan_30_to_official_dashscope_endpoints() {
        assert_eq!(
            RequestDialect::for_adapter(super::super::provider_adapter::BAILIAN_ADAPTER_ID),
            RequestDialect::AliyunBailian
        );
        let mut schema =
            default_model_schema("wan3.0-video", &[GenerationOperation::VideoGeneration]);
        assert!(apply_request_dialect(
            &mut schema,
            "wan3.0-video",
            RequestDialect::AliyunBailian
        ));
        let request = &schema["video_generation"]["request"];
        assert_eq!(
            request["path"],
            "/api/v1/services/aigc/video-generation/video-synthesis"
        );
        assert_eq!(request["observePath"], "/api/v1/tasks/{task_id}");
        assert_eq!(request["envelope"], "dashscope_input_parameters");
        assert_eq!(request["mediaEncoding"], "wan_media_array");
        assert_eq!(
            schema["video_generation"]["parameters"]["audio"]["default"],
            true
        );
        assert_eq!(
            schema["video_generation"]["parameters"]["prompt_extend"]["default"],
            true
        );
        let ratio_enum = schema["video_generation"]["parameters"]["ratio"]["enum"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(ratio_enum.iter().any(|value| value == "21:9"));

        // 网关连接会把百炼原生路径改回 `/v1/video/generations`。
        assert!(apply_request_dialect(
            &mut schema,
            "wan3.0-video",
            RequestDialect::OpenAiCompatible
        ));
        assert_eq!(
            schema["video_generation"]["request"]["path"],
            "/v1/video/generations"
        );
        assert!(
            schema["video_generation"]["request"]
                .get("envelope")
                .is_none()
        );

        let catalog = infer_catalog_schema(
            &json!({
                "model": "wan3.0-video-prime",
                "name": "万相3.0-高速版",
                "capabilities": ["VG"],
            }),
            "wan3.0-video-prime",
            "万相3.0-高速版",
        );
        assert_eq!(
            operations_from_schema(&catalog),
            [GenerationOperation::VideoGeneration]
        );
    }

    #[test]
    fn domestic_seedance_25_models_support_1080p_and_web_search() {
        let schema = default_model_schema(
            "doubao-seedance-2-5-260628",
            &[GenerationOperation::VideoGeneration],
        );
        let parameters = &schema["video_generation"]["parameters"];
        assert_eq!(
            parameters["resolution"]["enum"],
            json!(["720p", "480p", "1080p"])
        );
        assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
        assert_eq!(parameters["web_search"]["requiresNoMedia"], true);
        assert!(parameters.get("omni_reference_task_type").is_some());

        // 旧档案：非空但缺 1080p 与 web_search，应原位补齐且不覆盖其他自定义字段。
        let mut stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {
                    "ratio": { "type": "string", "label": "画幅", "default": "adaptive", "enum": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] },
                    "resolution": { "type": "string", "label": "分辨率", "default": "720p", "enum": ["720p", "480p"] },
                    "duration": { "type": "integer", "label": "时长", "default": -1, "enum": [-1] },
                    "generate_audio": { "type": "boolean", "label": "生成音频", "default": true },
                    "output_format": { "type": "string", "label": "输出格式", "default": "mp4", "enum": ["mp4", "mov"] },
                    "omni_reference_task_type": { "type": "string", "label": "任务类型", "default": "auto", "enum": ["auto", "reference", "edit", "extend"] }
                }
            }
        });
        assert!(refresh_seedance_25_video_defaults(
            &mut stale,
            "doubao-seedance-2-5-260628"
        ));
        let parameters = &stale["video_generation"]["parameters"];
        assert_eq!(
            parameters["resolution"]["enum"],
            json!(["720p", "480p", "1080p"])
        );
        assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
        assert_eq!(parameters["output_format"]["default"], "mp4");

        // 空参数档案：整体替换为当前默认。
        let mut empty = json!({
            "video_generation": { "resultType": "video", "parameters": {} }
        });
        assert!(refresh_seedance_25_video_defaults(
            &mut empty,
            "doubao-seedance-2-5-260628"
        ));
        let parameters = &empty["video_generation"]["parameters"];
        assert_eq!(
            parameters["resolution"]["enum"],
            json!(["720p", "480p", "1080p"])
        );
        assert!(parameters.get("web_search").is_some());

        // 海外 Dreamina 2.5 不受该刷新影响。
        let mut dreamina = json!({
            "video_generation": {
                "resultType": "video",
                "parameters": { "resolution": { "type": "string", "enum": ["720p", "480p"] } }
            }
        });
        assert!(!refresh_seedance_25_video_defaults(
            &mut dreamina,
            "dreamina-seedance-2.5"
        ));
    }

    #[test]
    fn stale_empty_dreamina_seedance_schema_is_upgraded() {
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {}
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "dreamina-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        let parameters = &repaired["video_generation"]["parameters"];
        assert_eq!(parameters["priority"]["default"], 0);
        assert_eq!(parameters["output_format"]["default"], "mp4");
        assert_eq!(parameters["generate_audio"]["default"], true);
    }

    #[test]
    fn seedance_20_video_schemas_gain_smart_duration() {
        // 非空档案：原位把 `-1` 补到 duration 枚举首位。
        let mut stale = json!({
            "video_generation": {
                "resultType": "video",
                "parameters": {
                    "duration": {
                        "type": "integer",
                        "label": "时长",
                        "default": 5,
                        "enum": [4, 5, 6]
                    }
                }
            }
        });
        assert!(refresh_seedance_20_video_defaults(
            &mut stale,
            "doubao-seedance-2-0-260128"
        ));
        assert_eq!(
            stale["video_generation"]["parameters"]["duration"]["enum"],
            json!([-1, 4, 5, 6])
        );

        // 空参数档案：整体替换为当前默认，时长枚举同样包含 -1。
        let mut empty = json!({
            "video_generation": { "resultType": "video", "parameters": {} }
        });
        assert!(refresh_seedance_20_video_defaults(
            &mut empty,
            "doubao-seedance-2-0-fast-260128"
        ));
        let enum_values = empty["video_generation"]["parameters"]["duration"]["enum"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(enum_values.len(), 13);
        assert_eq!(enum_values[0], json!(-1));

        // Seedance 2.5 不受该刷新影响。
        let mut untouched = json!({
            "video_generation": {
                "resultType": "video",
                "parameters": { "duration": { "type": "integer", "enum": [4, 5] } }
            }
        });
        assert!(!refresh_seedance_20_video_defaults(
            &mut untouched,
            "doubao-seedance-2-5-260628"
        ));
        assert_eq!(
            untouched["video_generation"]["parameters"]["duration"]["enum"],
            json!([4, 5])
        );
    }

    #[test]
    fn wan_30_models_use_the_root_media_request_contract() {
        for model_id in ["wan3.0-video", "wan3.0-video-prime"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration]
            );
            assert_eq!(definition["requestProfileId"], "moyu_wan3_video_v1");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "wan_media_array");
            assert_eq!(definition["request"]["promptMode"], "prompt_or_media");
            assert_eq!(parameters["resolution"]["default"], "1080P");
            assert_eq!(
                parameters["resolution"]["enum"],
                json!(["480P", "720P", "1080P"])
            );
            assert_eq!(parameters["duration"]["enum"].as_array().unwrap().len(), 30);
            assert_eq!(parameters["seed"]["minimum"], 0);
            assert_eq!(parameters["seed"]["maximum"], 2_147_483_647_i64);
            assert!(parameters["seed"].get("default").is_none());
            assert_eq!(parameters["watermark"]["default"], false);
        }
    }

    #[test]
    fn veo_models_use_the_root_top_level_request_contract() {
        for model_id in ["veo-3", "veo-3-fast", "veo-3.1", "veo-3.1-fast"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration]
            );
            assert_eq!(definition["requestProfileId"], "moyu_veo_video_v1");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "veo_image_urls");
            assert_eq!(definition["request"]["mediaField"], "images");
            assert_eq!(parameters["resolution"]["default"], "720p");
            assert_eq!(parameters["resolution"]["enum"], json!(["720p", "1080p"]));
            assert_eq!(parameters["aspect_ratio"]["default"], "16:9");
            assert_eq!(parameters["aspect_ratio"]["enum"], json!(["16:9", "9:16"]));
            assert_eq!(parameters["duration"]["default"], 8);
            assert_eq!(parameters["duration"]["enum"], json!([4, 6, 8]));
            assert_eq!(parameters["negativePrompt"]["requestLocation"], "metadata");
            assert_eq!(parameters["sampleCount"]["requestLocation"], "metadata");
            assert_eq!(parameters["sampleCount"]["maximum"], 4);
            assert_eq!(parameters["enhancePrompt"]["default"], true);
            assert_eq!(parameters["enhancePrompt"]["requestLocation"], "metadata");
            assert_eq!(parameters["seed"]["maximum"], 4_294_967_295_i64);
            assert_eq!(parameters["seed"]["requestLocation"], "metadata");
            assert!(parameters["seed"].get("default").is_none());
        }
    }

    #[test]
    fn stale_empty_veo_schema_is_upgraded_to_the_top_level_contract() {
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {}
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "veo-3.1-fast",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["requestProfileId"],
            "moyu_veo_video_v1"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["resolution"]["default"],
            "720p"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["aspect_ratio"]["enum"],
            json!(["16:9", "9:16"])
        );

        // 非 Veo 的通用视频模型空参数档案保持原样，不受 Veo 刷新影响。
        let generic = schema_for_enabled_operations(
            &stale,
            "company-video",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(generic["video_generation"]["parameters"], json!({}));
        assert_eq!(
            generic["video_generation"]["requestProfileId"],
            "moyu_video_metadata_v1"
        );
    }

    #[test]
    fn vidu_models_use_the_root_top_level_request_contract() {
        for (model_id, expected_resolutions, expected_default_resolution) in [
            ("vidu2.0", json!(["360p", "720p", "1080p"]), "720p"),
            ("viduq1", json!(["1080p"]), "1080p"),
            ("viduq3-pro", json!(["540p", "720p", "1080p"]), "720p"),
            ("viduq3-turbo", json!(["540p", "720p", "1080p"]), "720p"),
        ] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration],
                "model {model_id}"
            );
            assert_eq!(definition["requestProfileId"], "moyu_vidu_video_v1");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "vidu_image_urls");
            assert_eq!(definition["request"]["mediaField"], "images");
            assert_eq!(definition["request"]["metadataField"], "metadata");
            assert_eq!(definition["request"]["observePath"], "/v1/videos/{task_id}");
            assert_eq!(
                parameters["resolution"]["default"], expected_default_resolution,
                "model {model_id}"
            );
            assert_eq!(
                parameters["resolution"]["enum"], expected_resolutions,
                "model {model_id}"
            );
            assert_eq!(parameters["aspect_ratio"]["default"], "16:9");
            assert_eq!(
                parameters["aspect_ratio"]["enum"],
                json!(["16:9", "9:16", "1:1", "3:4", "4:3"])
            );
            assert_eq!(parameters["duration"]["default"], 5);
            assert_eq!(parameters["duration"]["enum"].as_array().unwrap().len(), 16);
            assert_eq!(parameters["seed"]["minimum"], -1);
            assert_eq!(parameters["seed"]["maximum"], 4_294_967_295_i64);
            assert!(parameters["seed"].get("default").is_none());
            assert_eq!(parameters["watermark"]["default"], false);
            assert_eq!(
                parameters["movement_amplitude"]["requestLocation"],
                "metadata"
            );
            assert_eq!(parameters["movement_amplitude"]["default"], "auto");
            assert_eq!(
                parameters["movement_amplitude"]["enum"],
                json!(["auto", "small", "medium", "large"])
            );
            assert_eq!(parameters["style"]["requestLocation"], "metadata");
            assert_eq!(parameters["style"]["enum"], json!(["general", "anime"]));
            assert_eq!(parameters["audio"]["requestLocation"], "metadata");
            assert_eq!(parameters["audio"]["default"], true);
            assert_eq!(parameters["audio_type"]["requestLocation"], "metadata");
            assert_eq!(parameters["off_peak"]["requestLocation"], "metadata");
            assert_eq!(parameters["bgm"]["requestLocation"], "metadata");
            assert_eq!(parameters["bgm"]["default"], false);
        }
    }

    #[test]
    fn stale_empty_vidu_schema_is_upgraded_to_the_top_level_contract() {
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {}
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "viduq3-turbo",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["requestProfileId"],
            "moyu_vidu_video_v1"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["observePath"],
            "/v1/videos/{task_id}"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["resolution"]["default"],
            "720p"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["aspect_ratio"]["enum"],
            json!(["16:9", "9:16", "1:1", "3:4", "4:3"])
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["audio"]["default"],
            true
        );

        // 非 Vidu 的通用视频模型空参数档案保持原样，不受 Vidu 刷新影响。
        let generic = schema_for_enabled_operations(
            &stale,
            "company-video",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(generic["video_generation"]["parameters"], json!({}));
        assert_eq!(
            generic["video_generation"]["requestProfileId"],
            "moyu_video_metadata_v1"
        );
    }

    #[test]
    fn panqu_video_model_uses_top_level_fields_and_720p_only() {
        for model_id in ["pan-seedance-2.0", "pan-seedance-2-0-260128"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration],
                "model {model_id}"
            );
            assert_eq!(definition["resultType"], "video");
            assert_eq!(definition["requestProfileId"], "panqu_video_v1");
            assert_eq!(definition["request"]["path"], "/v1/video/generations");
            // 顶层字段：分辨率参与网关的渠道匹配，放进 metadata 会被忽略。
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "vidu_image_urls");
            assert_eq!(definition["request"]["mediaField"], "images");
            // 轮询沿用默认 `GET /v1/video/generations/{task_id}`。
            assert!(definition["request"].get("observePath").is_none());

            // 该站 pan-seedance-2.0 的渠道只覆盖 720p：不把 480p/1080p 列进枚举。
            assert_eq!(parameters["resolution"]["default"], "720p");
            assert_eq!(parameters["resolution"]["enum"], json!(["720p"]));
            assert_eq!(parameters["aspect_ratio"]["default"], "16:9");
            assert_eq!(parameters["duration"]["default"], 5);
            assert_eq!(
                parameters["duration"]["enum"]
                    .as_array()
                    .unwrap()
                    .as_slice(),
                &(4..=15).map(Value::from).collect::<Vec<_>>()
            );
            assert_eq!(parameters["generate_audio"]["default"], true);
            assert_eq!(parameters["watermark"]["default"], false);
            // 联网搜索映射为顶层 `tools` 数组，并且只在没有媒体输入时提交。
            assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
            assert_eq!(parameters["web_search"]["requestField"], "tools");
            assert_eq!(parameters["web_search"]["requiresNoMedia"], true);
            // 顶层参数不声明 requestLocation（默认落在参数容器 root）。
            assert!(parameters["resolution"].get("requestLocation").is_none());
            assert!(parameters["duration"].get("requestLocation").is_none());
        }
    }

    #[test]
    fn panqu_prefix_without_seedance_keeps_the_gateway_contract() {
        // 其他 `pan-` 前缀模型不属于盘趣网关的视频契约：仍按既有规则推断，
        // 不能因为前缀相似就把它们当成盘趣视频模型。
        let schema = infer_catalog_schema(
            &json!({ "id": "pan-image-1" }),
            "pan-image-1",
            "pan-image-1",
        );
        assert!(schema.get("video_generation").is_none());
    }

    #[test]
    fn minimax_h3_model_uses_the_root_top_level_request_contract() {
        for model_id in ["MiniMax-H3", "minimax-h3", "minimax_h3_260901"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration],
                "model {model_id}"
            );
            assert_eq!(definition["requestProfileId"], "moyu_minimax_h3_video_v1");
            assert_eq!(definition["request"]["path"], "/v1/video/generations");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "minimax_h3_media");
            assert_eq!(definition["request"]["metadataField"], "metadata");
            // 轮询沿用默认 `GET /v1/video/generations/{task_id}`，不声明 observePath。
            assert!(definition["request"].get("observePath").is_none());

            // metadata.task_type：generation（默认）/ regeneration / h3_context_ir。
            assert_eq!(parameters["task_type"]["default"], "generation");
            assert_eq!(
                parameters["task_type"]["enum"],
                json!(["generation", "regeneration", "h3_context_ir"])
            );
            assert_eq!(parameters["task_type"]["requestLocation"], "metadata");

            // 顶层参数：resolution（768P/2K）、ratio、duration（4..=15）、aigc_watermark。
            assert_eq!(parameters["resolution"]["default"], "2K");
            assert_eq!(parameters["resolution"]["enum"], json!(["768P", "2K"]));
            assert_eq!(parameters["ratio"]["default"], "adaptive");
            assert_eq!(
                parameters["ratio"]["enum"],
                json!(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
            );
            assert_eq!(parameters["duration"]["default"], 5);
            assert_eq!(
                parameters["duration"]["enum"]
                    .as_array()
                    .unwrap()
                    .as_slice(),
                &(4..=15).map(Value::from).collect::<Vec<_>>()
            );
            assert_eq!(parameters["aigc_watermark"]["default"], false);
            assert_eq!(parameters["aigc_watermark"]["type"], "boolean");
            // 顶层参数不声明 requestLocation（默认落在参数容器 root）。
            assert!(parameters["resolution"].get("requestLocation").is_none());
            assert!(parameters["duration"].get("requestLocation").is_none());
        }
    }

    #[test]
    fn stale_empty_minimax_h3_schema_is_upgraded_to_the_h3_contract() {
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {}
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["requestProfileId"],
            "moyu_minimax_h3_video_v1"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["mediaEncoding"],
            "minimax_h3_media"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["resolution"]["default"],
            "2K"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["task_type"]["default"],
            "generation"
        );

        // 非 MiniMax-H3 的通用视频模型空参数档案保持原样，不受 H3 刷新影响。
        let generic = schema_for_enabled_operations(
            &stale,
            "company-video",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(generic["video_generation"]["parameters"], json!({}));
        assert_eq!(
            generic["video_generation"]["requestProfileId"],
            "moyu_video_metadata_v1"
        );
    }

    #[test]
    fn stale_empty_wan_schema_is_upgraded_without_changing_generic_empty_schemas() {
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {}
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["requestProfileId"],
            "moyu_wan3_video_v1"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["resolution"]["default"],
            "1080P"
        );

        let generic = schema_for_enabled_operations(
            &stale,
            "company-video",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(generic["video_generation"]["parameters"], json!({}));
        assert_eq!(
            generic["video_generation"]["requestProfileId"],
            "moyu_video_metadata_v1"
        );
    }

    #[test]
    fn media_model_name_hints_take_precedence_over_text_vendor_prefixes() {
        for (model_id, expected_operations) in [
            (
                "doubao-seedream-4-0-250828",
                vec![GenerationOperation::TextToImage],
            ),
            (
                "gemini-2.5-flash-image-preview",
                vec![GenerationOperation::TextToImage],
            ),
            ("qwen-image-plus", vec![GenerationOperation::TextToImage]),
            ("flux-1.1-pro", vec![GenerationOperation::TextToImage]),
            (
                "doubao-seedance-1-5-pro-250528",
                vec![GenerationOperation::VideoGeneration],
            ),
            (
                "minimax-video-01",
                vec![GenerationOperation::VideoGeneration],
            ),
            ("hunyuan-video", vec![GenerationOperation::VideoGeneration]),
            (
                "veo-3.1-generate-preview",
                vec![GenerationOperation::VideoGeneration],
            ),
        ] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            assert_eq!(
                operations_from_schema(&schema),
                expected_operations,
                "model {model_id}"
            );
            assert!(
                schema.get("text_generation").is_none(),
                "media model {model_id} must not be classified as text"
            );
        }
    }

    #[test]
    fn enabled_schema_keeps_only_one_generation_category() {
        let discovered = default_model_schema(
            "mixed-model",
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::VideoGeneration,
            ],
        );
        let image_only = schema_for_enabled_operations(
            &discovered,
            "mixed-model",
            &[GenerationOperation::TextToImage],
            RequestDialect::OpenAiCompatible,
        );
        assert!(image_only.get("text_to_image").is_some());
        assert!(image_only.get("video_generation").is_none());

        let invalid = json!({
            "video_generation": {
                "resultType": "image",
                "parameters": {}
            }
        });
        assert!(
            validate_schema_for_operations(
                &invalid,
                "wrong-result-model",
                &[GenerationOperation::VideoGeneration]
            )
            .is_err()
        );
    }

    #[test]
    fn malformed_operation_schema_is_repaired_with_parameters() {
        // 历史行只存了 `resultType`、缺失 `parameters`/`request`。前端回读损坏定义后
        // 会把同样的形状原样回传，validate_schema_for_operations 此前会因此失败。
        let malformed = json!({
            "video_generation": { "resultType": "video" }
        });
        let repaired = schema_for_enabled_operations(
            &malformed,
            "doubao-seedance-2-0-260128",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert!(
            repaired["video_generation"]["parameters"].is_object(),
            "repaired schema must carry a parameters object"
        );
        assert_eq!(repaired["video_generation"]["resultType"], "video");
        // 修复后校验必须能通过。
        assert!(
            validate_schema_for_operations(
                &malformed,
                "doubao-seedance-2-0-260128",
                &[GenerationOperation::VideoGeneration]
            )
            .is_ok()
        );
    }

    #[test]
    fn normalizer_applies_defaults_and_rejects_unknown_or_invalid_values() {
        let schema = json!({
            "parameters": {
                "duration": { "type": "integer", "default": 5, "enum": [5, 8] }
            }
        });
        assert_eq!(
            normalize_parameters(&schema, &json!({})).unwrap(),
            json!({ "duration": 5 })
        );
        assert!(normalize_parameters(&schema, &json!({ "duration": 7 })).is_err());
        assert!(normalize_parameters(&schema, &json!({ "unknown": true })).is_err());
    }

    #[test]
    fn gpt_image_models_use_their_own_quality_and_size_contract() {
        let schema = infer_catalog_schema(
            &json!({ "id": "gpt-image-2" }),
            "gpt-image-2",
            "GPT Image 2",
        );
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(parameters["quality"]["default"], "auto");
        assert_eq!(
            parameters["quality"]["enum"],
            json!(["auto", "high", "medium", "low"])
        );
        assert_eq!(parameters["size"]["default"], "auto");
        assert_eq!(
            parameters["size"]["enum"],
            json!(["auto", "1024x1024", "1536x1024", "1024x1536"])
        );
        // GPT Image 契约：图片生成声明生成数量 n（1~10，默认 1）。
        assert_eq!(parameters["n"]["type"], "integer");
        assert_eq!(parameters["n"]["default"], 1);
        assert_eq!(parameters["n"]["minimum"], 1);
        assert_eq!(parameters["n"]["maximum"], 10);
        // gpt-image 系列不接受 `response_format`（moyu 真机实测 HTTP 400
        // unknown_parameter），结果恒为内联 Base64，因此当前契约不声明该键。
        assert!(parameters.get("response_format").is_none());

        // 图生图（图片编辑 multipart 接口）同样声明 n/size/quality。
        let edit_parameters = &schema["image_to_image"]["parameters"];
        assert_eq!(edit_parameters["n"]["default"], 1);
        assert_eq!(edit_parameters["size"]["default"], "auto");
        assert_eq!(edit_parameters["quality"]["default"], "auto");

        // 非 gpt-image 模型沿用通用文生图契约，并保留 dall-e 契约的返回格式参数。
        let generic = default_model_schema("photon-1", &[GenerationOperation::TextToImage]);
        let generic_parameters = &generic["text_to_image"]["parameters"];
        assert_eq!(generic_parameters["quality"]["default"], "standard");
        assert_eq!(
            generic_parameters["quality"]["enum"],
            json!(["hd", "standard"])
        );
        assert!(generic_parameters.get("n").is_none());
        assert_eq!(generic_parameters["response_format"]["default"], "b64_json");
    }

    #[test]
    fn seedream_image_models_use_the_moyu_2k_contract() {
        // Seedream 4.5：2K 尺寸、standard/hd 质量、水印（默认开启）+ 组图模式。
        let schema = infer_catalog_schema(
            &json!({ "id": "doubao-seedream-4-5-251128" }),
            "doubao-seedream-4-5-251128",
            "Seedream 4.5",
        );
        assert_eq!(
            operations_from_schema(&schema),
            [GenerationOperation::TextToImage]
        );
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(parameters["size"]["default"], "2K");
        assert_eq!(
            parameters["size"]["enum"],
            json!(["2K", "2048x2048", "2848x1600"])
        );
        assert_eq!(parameters["quality"]["default"], "standard");
        assert_eq!(parameters["quality"]["enum"], json!(["standard", "hd"]));
        assert_eq!(parameters["watermark"]["type"], "boolean");
        assert_eq!(parameters["watermark"]["default"], false);
        // 返回格式：默认内联 b64_json，避免保存阶段再直连供应商存储域名（文档参数表）。
        assert_eq!(parameters["response_format"]["default"], "b64_json");
        assert_eq!(
            parameters["response_format"]["enum"],
            json!(["url", "b64_json"])
        );
        // 4.5 支持组图模式（auto/disabled）与组图数量（1~15）。
        assert_eq!(
            parameters["sequential_image_generation"]["enum"],
            json!(["disabled", "auto"])
        );
        assert_eq!(parameters["max_images"]["default"], 4);
        assert_eq!(parameters["max_images"]["minimum"], 1);
        assert_eq!(parameters["max_images"]["maximum"], 15);
        assert_eq!(
            parameters["max_images"]["requestField"],
            "sequential_image_generation_options"
        );
        assert_eq!(parameters["max_images"]["transform"], "max_images_object");
        // 4.5 不支持提示词优化/联网搜索/输出格式。
        assert!(parameters.get("optimize_prompt_mode").is_none());
        assert!(parameters.get("web_search").is_none());
        assert!(parameters.get("output_format").is_none());
    }

    #[test]
    fn seedream_50_pro_adds_optimization_output_format_and_image_edit_only_parameters() {
        let schema = default_model_schema(
            "doubao-seedream-5-0-pro-260628",
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
        );
        let text_parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(text_parameters["optimize_prompt_mode"]["default"], "fast");
        assert_eq!(
            text_parameters["optimize_prompt_mode"]["enum"],
            json!(["fast", "standard"])
        );
        assert_eq!(
            text_parameters["optimize_prompt_mode"]["requestField"],
            "optimize_prompt_options"
        );
        assert_eq!(
            text_parameters["optimize_prompt_mode"]["transform"],
            "optimize_prompt_mode_object"
        );
        assert_eq!(text_parameters["output_format"]["default"], "jpg");
        assert_eq!(
            text_parameters["output_format"]["enum"],
            json!(["jpg", "png", "webp"])
        );
        assert_eq!(text_parameters["watermark"]["default"], false);
        assert_eq!(text_parameters["response_format"]["default"], "b64_json");
        // 5.0 pro 不支持组图模式与联网搜索。
        assert!(text_parameters.get("sequential_image_generation").is_none());
        assert!(text_parameters.get("web_search").is_none());

        // 图生图走 JSON /v1/images/generations，声明透明背景与图层拆分。
        let edit = &schema["image_to_image"];
        assert_eq!(edit["request"]["path"], "/v1/images/generations");
        assert_eq!(edit["request"]["encoding"], "json");
        assert_eq!(edit["request"]["parameterContainer"], "root");
        assert_eq!(edit["request"]["mediaEncoding"], "seedream_image_urls");
        assert_eq!(edit["request"]["mediaField"], "image");
        let edit_parameters = &edit["parameters"];
        assert_eq!(edit_parameters["size"]["default"], "2K");
        assert_eq!(edit_parameters["background"]["default"], "opaque");
        assert_eq!(
            edit_parameters["background"]["enum"],
            json!(["opaque", "transparent"])
        );
        assert_eq!(edit_parameters["layer_decomposition"]["type"], "boolean");
        assert_eq!(edit_parameters["layer_decomposition"]["default"], false);
        assert_eq!(edit_parameters["response_format"]["default"], "b64_json");
    }

    #[test]
    fn seedream_50_lite_supports_sequential_optimization_web_search_and_output_format() {
        let schema = default_model_schema(
            "doubao-seedream-5-0-lite",
            &[GenerationOperation::TextToImage],
        );
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(
            parameters["sequential_image_generation"]["enum"],
            json!(["disabled", "auto"])
        );
        assert_eq!(parameters["optimize_prompt_mode"]["default"], "fast");
        assert_eq!(parameters["output_format"]["default"], "jpg");
        assert_eq!(
            parameters["output_format"]["enum"],
            json!(["jpg", "png", "webp"])
        );
        // 联网搜索仅文生图（requiresNoMedia），且只出现在 5.0 lite。
        assert_eq!(parameters["web_search"]["requiresNoMedia"], true);
        assert_eq!(parameters["web_search"]["requestField"], "tools");
        assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
    }

    #[test]
    fn seedream_50_document_model_matches_the_documented_5_0_contract() {
        // moyu 文档（https://doc.moyu.info/9280685m0.md）推荐的 Seedream 5.0：
        // 基础参数 + 组图模式 + 输出格式（jpg/png/webp）；不声明提示词优化/
        // 联网搜索/背景通道/图层拆分。
        for operation in [
            GenerationOperation::TextToImage,
            GenerationOperation::ImageToImage,
        ] {
            let schema = default_model_schema("doubao-seedream-5-0-260128", &[operation]);
            let parameters = &schema[operation.as_str()]["parameters"];
            assert_eq!(parameters["size"]["default"], "2K");
            assert_eq!(parameters["watermark"]["default"], false);
            assert_eq!(parameters["response_format"]["default"], "b64_json");
            assert_eq!(
                parameters["sequential_image_generation"]["enum"],
                json!(["disabled", "auto"])
            );
            assert_eq!(parameters["max_images"]["default"], 4);
            assert_eq!(parameters["output_format"]["default"], "jpg");
            assert_eq!(
                parameters["output_format"]["enum"],
                json!(["jpg", "png", "webp"])
            );
            assert!(parameters.get("optimize_prompt_mode").is_none());
            assert!(parameters.get("web_search").is_none());
            assert!(parameters.get("background").is_none());
            assert!(parameters.get("layer_decomposition").is_none());
        }
    }

    #[test]
    fn seedream_legacy_dall_e_parameter_defaults_are_refreshed() {
        // 历史版本按 dall-e 契约保存 → 刷新为 Seedream 2K 契约。
        let mut schema = json!({
            "text_to_image": {
                "resultType": "image",
                "requestProfileId": "openai_images_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/generations",
                    "encoding": "json",
                    "parameterContainer": "root"
                },
                "parameters": legacy_text_to_image_parameters()
            }
        });
        assert!(refresh_seedream_image_parameter_defaults(
            &mut schema,
            "doubao-seedream-4-5-251128"
        ));
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(parameters["size"]["default"], "2K");
        assert_eq!(
            parameters["size"]["enum"],
            json!(["2K", "2048x2048", "2848x1600"])
        );
        assert!(parameters.get("sequential_image_generation").is_some());

        // 图生图的历史空参数刷新为 Seedream JSON 契约（含 background 等）。
        let mut edit = json!({
            "image_to_image": { "resultType": "image", "parameters": {} }
        });
        assert!(refresh_seedream_image_parameter_defaults(
            &mut edit,
            "doubao-seedream-5-0-pro-260628"
        ));
        let edit_parameters = &edit["image_to_image"]["parameters"];
        assert_eq!(edit_parameters["size"]["default"], "2K");
        assert_eq!(edit_parameters["background"]["default"], "opaque");
        assert_eq!(edit_parameters["layer_decomposition"]["default"], false);

        // 上一版 Seedream 默认形状（watermark 默认 false、无 response_format、
        // output_format 为 jpeg/png）→ 原位刷新为当前文档契约（含默认 b64_json）。
        let mut stale = json!({
            "text_to_image": {
                "resultType": "image",
                "parameters": previous_seedream_image_parameters(
                    Some("4.5"),
                    false
                )
            }
        });
        assert!(refresh_seedream_image_parameter_defaults(
            &mut stale,
            "doubao-seedream-4-5-251128"
        ));
        let refreshed = &stale["text_to_image"]["parameters"];
        assert_eq!(refreshed["watermark"]["default"], false);
        assert_eq!(refreshed["response_format"]["default"], "b64_json");
        assert_eq!(
            refreshed["response_format"]["enum"],
            json!(["url", "b64_json"])
        );
        assert!(refreshed.get("output_format").is_none());

        // 5.0 模型上一版按 generic 保存（只有基础参数）→ 刷新为 5.0 文档契约。
        let mut stale50 = json!({
            "text_to_image": {
                "resultType": "image",
                "parameters": previous_seedream_image_parameters(
                    Some("5.0"),
                    false
                )
            }
        });
        assert!(refresh_seedream_image_parameter_defaults(
            &mut stale50,
            "doubao-seedream-5-0-260128"
        ));
        let refreshed50 = &stale50["text_to_image"]["parameters"];
        assert_eq!(refreshed50["watermark"]["default"], false);
        assert_eq!(refreshed50["response_format"]["default"], "b64_json");
        assert_eq!(
            refreshed50["sequential_image_generation"]["default"],
            "disabled"
        );
        assert_eq!(refreshed50["output_format"]["default"], "jpg");
        assert_eq!(
            refreshed50["output_format"]["enum"],
            json!(["jpg", "png", "webp"])
        );

        // 非 Seedream 模型不受刷新影响。
        let mut generic = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        assert!(!refresh_seedream_image_parameter_defaults(
            &mut generic,
            "photon-1"
        ));
    }

    #[test]
    fn legacy_dall_e_parameter_defaults_are_refreshed_for_gpt_image_models() {
        let mut schema = json!({
            "text_to_image": {
                "resultType": "image",
                "requestProfileId": "openai_images_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/generations",
                    "encoding": "json",
                    "parameterContainer": "root"
                },
                "parameters": legacy_text_to_image_parameters()
            }
        });
        assert!(refresh_legacy_image_parameter_defaults(
            &mut schema,
            "gpt-image-2"
        ));
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(parameters["quality"]["default"], "auto");
        assert_eq!(
            parameters["quality"]["enum"],
            json!(["auto", "high", "medium", "low"])
        );
        assert_eq!(parameters["n"]["default"], 1);

        // 尚未包含 n 的早期 GPT Image 契约也会被刷新（补上 n）。
        let mut before_n = json!({
            "text_to_image": { "parameters": gpt_image_text_to_image_parameters_before_n() }
        });
        assert!(refresh_legacy_image_parameter_defaults(
            &mut before_n,
            "gpt-image-2"
        ));
        assert_eq!(before_n["text_to_image"]["parameters"]["n"]["default"], 1);

        // 曾声明返回格式的 GPT Image 契约会被刷新为当前契约（剔除 response_format）。
        let mut with_response_format = json!({
            "text_to_image": {
                "parameters": gpt_image_text_to_image_parameters_with_response_format()
            }
        });
        assert!(refresh_legacy_image_parameter_defaults(
            &mut with_response_format,
            "gpt-image-2"
        ));
        let refreshed_parameters = &with_response_format["text_to_image"]["parameters"];
        assert!(refreshed_parameters.get("response_format").is_none());
        assert_eq!(refreshed_parameters["n"]["default"], 1);
        assert_eq!(refreshed_parameters["size"]["default"], "auto");
        assert_eq!(refreshed_parameters["quality"]["default"], "auto");

        // 图生图的历史空参数会被刷新为当前契约（含 n/size/quality）。
        let mut edit = json!({
            "image_to_image": { "resultType": "image", "parameters": {} }
        });
        assert!(refresh_legacy_image_parameter_defaults(
            &mut edit,
            "gpt-image-2"
        ));
        let edit_parameters = &edit["image_to_image"]["parameters"];
        assert_eq!(edit_parameters["n"]["default"], 1);
        assert_eq!(edit_parameters["size"]["default"], "auto");
        assert_eq!(edit_parameters["quality"]["default"], "auto");

        // 与旧默认值不一致的自定义参数不被覆盖。
        let mut customized = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        customized["text_to_image"]["parameters"]["quality"]["enum"] = json!(["hd"]);
        assert!(!refresh_legacy_image_parameter_defaults(
            &mut customized,
            "gpt-image-2"
        ));
        assert_eq!(
            customized["text_to_image"]["parameters"]["quality"]["enum"],
            json!(["hd"])
        );

        // 非 gpt-image 的通用 OpenAI Images 模型同样补上返回格式键：
        // 尺寸与质量默认值保持通用契约不变（其供应商仍接受 standard/hd）。
        let mut generic = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        assert!(refresh_legacy_image_parameter_defaults(
            &mut generic,
            "photon-1"
        ));
        let generic_parameters = &generic["text_to_image"]["parameters"];
        assert_eq!(generic_parameters["size"]["default"], "1024x1024");
        assert_eq!(generic_parameters["quality"]["default"], "standard");
        assert_eq!(generic_parameters["response_format"]["default"], "b64_json");

        // Gemini 与 Seedream 各有自己的契约刷新，这里不越界（否则会把画幅比例 /
        // 2K 尺寸的默认值改写成通用 dall-e 尺寸）。
        for model_id in ["gemini-2.5-flash-image", "doubao-seedream-4-5-251128"] {
            let mut other = json!({
                "text_to_image": { "parameters": legacy_text_to_image_parameters() }
            });
            assert!(
                !refresh_legacy_image_parameter_defaults(&mut other, model_id),
                "model {model_id}"
            );
        }
    }

    #[test]
    fn gemini_image_models_use_aspect_ratio_size_without_quality_or_count() {
        for model_id in ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            assert_eq!(
                operations_from_schema(&schema),
                vec![GenerationOperation::TextToImage],
                "model {model_id}"
            );
            let definition = &schema["text_to_image"];
            assert_eq!(definition["requestProfileId"], "openai_images_v1");
            assert_eq!(definition["request"]["path"], "/v1/images/generations");
            let parameters = &definition["parameters"];
            assert_eq!(parameters["size"]["default"], "1:1");
            assert_eq!(
                parameters["size"]["enum"],
                json!(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
            );
            // 不声明质量参数，也不声明生成数量（上游忽略 n，一次只返回一张）。
            assert!(
                parameters.get("quality").is_none(),
                "model {model_id} must not declare quality"
            );
            assert!(
                parameters.get("n").is_none(),
                "model {model_id} must not declare n"
            );
            // 仍被识别为图片模型，而非文本模型。
            assert!(
                schema.get("text_generation").is_none(),
                "model {model_id} must not be classified as text"
            );
        }
    }

    #[test]
    fn gemini_image_legacy_dall_e_parameters_are_refreshed() {
        let mut schema = json!({
            "text_to_image": {
                "resultType": "image",
                "requestProfileId": "openai_images_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/generations",
                    "encoding": "json",
                    "parameterContainer": "root"
                },
                "parameters": legacy_text_to_image_parameters()
            }
        });
        assert!(refresh_gemini_image_parameter_defaults(
            &mut schema,
            "gemini-2.5-flash-image"
        ));
        let parameters = &schema["text_to_image"]["parameters"];
        assert_eq!(parameters["size"]["default"], "1:1");
        assert_eq!(
            parameters["size"]["enum"],
            json!(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
        );
        assert!(parameters.get("quality").is_none());
        assert!(parameters.get("n").is_none());

        // 与旧默认值不一致的自定义参数不被覆盖。
        let mut customized = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        customized["text_to_image"]["parameters"]["size"]["enum"] = json!(["1:1", "16:9"]);
        assert!(!refresh_gemini_image_parameter_defaults(
            &mut customized,
            "gemini-2.5-flash-image"
        ));

        // 非 gemini 图片模型不动。
        let mut generic = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        assert!(!refresh_gemini_image_parameter_defaults(
            &mut generic,
            "gpt-image-2"
        ));
    }

    #[test]
    fn gemini_image_models_use_json_image_to_image_contract_with_data_uri_media() {
        // https://doc.moyu.info/9280683m0.md：Gemini 图生图与文生图一致走
        // OpenAI Images API JSON，参考图以顶层 `image` data URI 传入，参数为画幅比例。
        for model_id in ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"] {
            let schema = default_model_schema(
                model_id,
                &[
                    GenerationOperation::TextToImage,
                    GenerationOperation::ImageToImage,
                ],
            );
            let definition = &schema["image_to_image"];
            assert_eq!(definition["resultType"], "image");
            assert_eq!(definition["requestProfileId"], "openai_images_v1");
            assert_eq!(definition["request"]["path"], "/v1/images/generations");
            assert_eq!(definition["request"]["encoding"], "json");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(
                definition["request"]["mediaEncoding"],
                "gemini_image_data_uri"
            );
            assert_eq!(definition["request"]["mediaField"], "image");
            let parameters = &definition["parameters"];
            assert_eq!(parameters["size"]["default"], "1:1");
            assert_eq!(
                parameters["size"]["enum"],
                json!(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
            );
            assert!(
                parameters.get("quality").is_none(),
                "model {model_id} must not declare quality"
            );
            assert!(
                parameters.get("n").is_none(),
                "model {model_id} must not declare n"
            );
        }
    }

    #[test]
    fn gemini_image_legacy_multipart_image_to_image_contract_is_refreshed() {
        // 历史保存的通用 multipart edits 契约（空参数、multipart 编码）→ 刷新为
        // Gemini JSON 图生图契约（/v1/images/generations + data URI + size 参数）。
        let mut schema = json!({
            "image_to_image": {
                "resultType": "image",
                "requestProfileId": "openai_image_edits_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/edits",
                    "encoding": "multipart",
                    "parameterContainer": "multipart"
                },
                "parameters": {}
            }
        });
        assert!(refresh_gemini_image_parameter_defaults(
            &mut schema,
            "gemini-3-pro-image-preview"
        ));
        let definition = &schema["image_to_image"];
        assert_eq!(definition["request"]["path"], "/v1/images/generations");
        assert_eq!(definition["request"]["encoding"], "json");
        assert_eq!(
            definition["request"]["mediaEncoding"],
            "gemini_image_data_uri"
        );
        assert_eq!(definition["request"]["mediaField"], "image");
        assert_eq!(definition["parameters"]["size"]["default"], "1:1");

        // 已是 JSON 契约（当前形状）不被重复刷新。
        let mut current = json!({
            "image_to_image": default_operation_schema(
                "gemini-3-pro-image-preview",
                GenerationOperation::ImageToImage
            )
        });
        assert!(!refresh_gemini_image_parameter_defaults(
            &mut current,
            "gemini-3-pro-image-preview"
        ));

        // 非 gemini 图片模型不动。
        let mut other = json!({
            "image_to_image": {
                "request": { "path": "/v1/images/edits", "encoding": "multipart" },
                "parameters": {}
            }
        });
        assert!(!refresh_gemini_image_parameter_defaults(
            &mut other,
            "gpt-image-2"
        ));
    }
}
