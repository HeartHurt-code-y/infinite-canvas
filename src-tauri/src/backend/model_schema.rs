use serde_json::{Map, Value, json};

use super::{
    error::{BackendError, BackendResult},
    provider_adapter::{
        ARK_ADAPTER_ID, BAILIAN_ADAPTER_ID, BAILIAN_VIDEO_OBSERVE_PATH, BAILIAN_VIDEO_PATH,
        DASHSCOPE_VIDEO_ENVELOPE, GRSAI_ADAPTER_ID,
    },
    types::GenerationOperation,
};

const OPERATION_KEYS: [(&str, GenerationOperation); 5] = [
    ("text_to_image", GenerationOperation::TextToImage),
    ("image_to_image", GenerationOperation::ImageToImage),
    ("video_generation", GenerationOperation::VideoGeneration),
    ("text_generation", GenerationOperation::TextGeneration),
    ("speech_generation", GenerationOperation::SpeechGeneration),
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
    /// Grsai 图片生成 API（gpt-image-2 系列）：提交 `POST /v1/api/generate`，
    /// 轮询 `GET /v1/api/result?id={task_id}`；同名模型在聚合网关上走
    /// `/v1/images/generations`，契约必须按连接方言区分。
    Grsai,
}

impl RequestDialect {
    /// 适配器 → 方言。方舟推理 API 的 Base URL 自带 `/api/v3`，端点因此不带
    /// `/v1` 前缀；百炼走官方 MaaS 路径；Grsai 是自有协议；其余适配器都是
    /// OpenAI 兼容网关。
    pub fn for_adapter(adapter_id: &str) -> Self {
        if adapter_id == ARK_ADAPTER_ID {
            Self::VolcengineArk
        } else if adapter_id == BAILIAN_ADAPTER_ID {
            Self::AliyunBailian
        } else if adapter_id == GRSAI_ADAPTER_ID {
            Self::Grsai
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
/// OpenAI 兼容网关的语音合成接口（魔芋 `seed-audio` 系文档）：JSON 提交，
/// 成功响应体直接是音频二进制，字幕走 `X-Subtitle` 响应头。
pub const GATEWAY_TTS_PATH: &str = "/v1/tts/create";
/// 豆包语音 OpenSpeech 的合成接口，只在独立语音连接上存在。
pub const DOUBAO_TTS_PATH: &str = "/api/v3/tts/unidirectional/sse";
pub const GATEWAY_TTS_REQUEST_PROFILE: &str = "gateway_tts_create_v1";
pub const DOUBAO_TTS_REQUEST_PROFILE: &str = "doubao_voice_tts_v3_sse";

/// 按连接方言改写操作 Schema 里的请求端点。
///
/// `default_operation_schema` 只看得到模型名，只能给出 OpenAI 兼容网关的规范值；
/// 本函数是方舟连接的唯一改写入口，也在保存模型与打开数据库时把历史按模型名写下的
/// 方舟原生端点改回网关端点。只在这三对互为替代的端点之间互换，其他家族
/// （Veo / Vidu / Wan / MiniMax、Gemini、Anthropic）自己的路径原样保留；
/// Grsai 图片连接，以及精确 Seedance 草稿样片模型在兼容网关上的契约，会按
/// 对应文档同时改写端点、轮询和参数（见 `apply_grsai_image_dialect` 与
/// `apply_seedance_draft_video_dialect`）。
///
/// 返回是否发生改写，调用方据此决定是否需要把定义写回数据库。
pub fn apply_request_dialect(schema: &mut Value, model_id: &str, dialect: RequestDialect) -> bool {
    let identity = model_id.to_ascii_lowercase();
    let video = apply_video_dialect(schema, &identity, dialect);
    let image = apply_image_dialect(schema, &identity, dialect);
    let text = apply_text_dialect(schema, &identity, dialect);
    let speech = apply_speech_dialect(schema, &identity);
    video || image || text || speech
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
    // PixVerse 的已知合同属于兼容网关；同名模型出现在其他连接时，不能把
    // 供应商自定义的原生路径替换成魔芋路径。
    let pixverse_profile_changed = dialect == RequestDialect::OpenAiCompatible
        && refresh_pixverse_video_defaults(schema, identity);
    let draft_profile_changed = apply_seedance_draft_video_dialect(schema, identity, dialect);
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
        // Grsai 只承载 gpt-image 系图片契约；图片家族改写在 `apply_image_dialect`
        // 已提前返回，视频契约在这里保持原样（不被误改写成网关端点）。
        RequestDialect::Grsai => false,
        // 方舟只承载自家 Seedance（含 1.x）。Vidu / Wan / Veo / MiniMax 在方舟上
        // 没有端点，它们自己的契约保持原样。
        RequestDialect::VolcengineArk => {
            let native_seedance =
                identity.contains("seedance") && !is_dreamina_seedance_video_model(identity);
            if !native_seedance {
                return draft_profile_changed || pixverse_profile_changed;
            }
            let mut changed = draft_profile_changed;
            changed |= set_request_field(request, "path", json!(ARK_VIDEO_PATH));
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
                return draft_profile_changed || pixverse_profile_changed;
            }
            let mut changed = set_request_field(request, "path", json!(GATEWAY_VIDEO_PATH));
            // 参数容器随方言走：原生契约把画幅/时长/分辨率平铺在顶层、content 也在顶层，
            // 网关契约把它们归入 `metadata`。只认通用视频档案，供应商自定义档案的
            // 顶层参数容器保持原样。
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

/// 文生图与图生图共用同一对图片端点：
/// 网关 `/v1/images/generations` ↔ 方舟原生 `/images/generations`。
/// Grsai 连接例外：端点、轮询与参数整条换成 Grsai 自有协议。
fn apply_image_dialect(schema: &mut Value, identity: &str, dialect: RequestDialect) -> bool {
    if dialect == RequestDialect::Grsai {
        return apply_grsai_image_dialect(schema, identity);
    }
    let mut changed = false;
    for operation in [
        GenerationOperation::TextToImage,
        GenerationOperation::ImageToImage,
    ] {
        changed |= apply_image_operation_dialect(schema, identity, dialect, operation);
    }
    changed
}

fn apply_image_operation_dialect(
    schema: &mut Value,
    identity: &str,
    dialect: RequestDialect,
    operation: GenerationOperation,
) -> bool {
    let Some(request) = request_object_mut(schema, operation) else {
        return false;
    };
    let path = current_request_path(request).to_string();
    match dialect {
        RequestDialect::AliyunBailian => false,
        // Grsai 连接的图片契约在 `apply_image_dialect` 入口整条改写，不会走到这里。
        RequestDialect::Grsai => false,
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
        // Grsai 连接不承载文本对话模型，文本契约保持原样。
        RequestDialect::Grsai => false,
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

/// 语音：`seed-tts-*` ↔ 豆包 OpenSpeech SSE，`seed-audio-*` ↔ 网关 `/v1/tts/create`。
///
/// 端点由模型家族唯一决定（豆包语音模型只在独立语音连接上提供，网关 TTS 模型只在
/// OpenAI 兼容网关上提供），所以这里不参与连接方言判断，只把历史上按另一家族写下的
/// 定义归一回来，保证 `synthesize_speech` 读到的请求档案与路径始终成对。
fn apply_speech_dialect(schema: &mut Value, identity: &str) -> bool {
    if !is_doubao_voice_tts_model(identity) && !is_gateway_tts_model(identity) {
        return false;
    }
    let Some(operation) = operation_object_mut(schema, GenerationOperation::SpeechGeneration)
    else {
        return false;
    };
    let profile = speech_request_profile(identity);
    let path = if profile == DOUBAO_TTS_REQUEST_PROFILE {
        DOUBAO_TTS_PATH
    } else {
        GATEWAY_TTS_PATH
    };
    let mut changed = set_request_field(operation, "requestProfileId", json!(profile));
    if let Some(request) = operation.get_mut("request").and_then(Value::as_object_mut) {
        changed |= set_request_field(request, "path", json!(path));
        changed |= set_request_field(request, "encoding", json!("json"));
        changed |= set_request_field(request, "parameterContainer", json!("root"));
    }
    changed
}

pub fn infer_catalog_schema(item: &Value, model_id: &str, display_name: &str) -> Value {
    // 两个完整 PixVerse 型号有明确的视频合同，不能被目录通用 chat 标签覆盖。
    // 若目录提供视频扩展 Schema，仍保留其中的自定义参数与标记。
    if is_pixverse_video_model(model_id) {
        if let Some(schema) = advertised_schema(item)
            && schema.get("video_generation").is_some_and(Value::is_object)
        {
            let mut schema = complete_advertised_schema(schema, model_id);
            if let Some(object) = schema.as_object_mut() {
                object.retain(|key, _| key == "video_generation");
            }
            return schema;
        }
        return default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
    }
    // 草稿样片契约以完整模型 ID 为准，不能被聚合目录里的 text/chat 标签覆盖。
    if is_seedance_draft_video_model(model_id) {
        return default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
    }
    // 这八个远端 ID 有明确的按次视频合同。聚合网关的通用目录能力字段可能把
    // 它们误报成 chat/文本，不能让泛化标签覆盖已知的视频请求协议。
    if is_sp25_per_use_video_model(model_id) {
        return default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
    }
    // RD 网关的三个模型同理：目录能力字段可能把它们误报成 chat/文本。
    if is_rd_video_model(model_id) {
        return default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
    }
    if is_doubao_voice_tts_model(model_id) || is_gateway_tts_model(model_id) {
        // 语音家族有确定的合成合同（SSE 或二进制音频端点）。聚合目录把这类型号
        // 泛化上报成 chat/text 时，不能让通用能力标签覆盖已知端点，同上面的按次
        // 视频模型规则。
        return default_model_schema(model_id, &[GenerationOperation::SpeechGeneration]);
    }
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
    if identity.contains("qwen-audio-") && identity.contains("-tts")
        || identity.contains("cosyvoice-v")
    {
        return default_model_schema(model_id, &[GenerationOperation::SpeechGeneration]);
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

pub(crate) const MOYU_PIXVERSE_VIDEO_PROFILE: &str = "moyu_pixverse_video_v1";

/// 只接受文档的完整型号，避免把 PixVerse-V5 或未来后缀型号误套 V6/C1 能力。
pub(crate) fn is_pixverse_video_model(model_id: &str) -> bool {
    model_id.eq_ignore_ascii_case("PixVerse-V6") || model_id.eq_ignore_ascii_case("PixVerse-C1")
}

fn pixverse_video_operation_schema(model_id: &str) -> Option<Value> {
    if !is_pixverse_video_model(model_id) {
        return None;
    }
    let mut parameters = json!({
        "aspect_ratio": {
            "type": "string", "label": "画幅", "default": "16:9",
            "enum": ["16:9", "9:16", "4:3", "3:4", "1:1", "2:3", "3:2", "21:9"],
            "order": 0
        },
        "duration": {
            "type": "integer", "label": "时长", "default": 5,
            "enum": (1..=15).map(Value::from).collect::<Vec<_>>(), "order": 1
        },
        "quality": {
            "type": "string", "label": "清晰度", "default": "540p",
            "enum": ["360p", "540p", "720p", "1080p"],
            "requestLocation": "metadata", "order": 2
        },
        "generate_audio_switch": {
            "type": "boolean", "label": "生成音频", "default": false,
            "requestLocation": "metadata", "order": 3
        },
        "seed": {
            "type": "integer", "label": "随机种子", "optional": true, "order": 5
        },
        "template_id": {
            "type": "integer", "label": "特效模板 ID", "optional": true,
            "requestLocation": "metadata", "order": 6
        },
        "action": {
            "type": "string", "label": "能力模式", "optional": true,
            "enum": ["text", "img", "fusion"], "requestLocation": "metadata", "order": 7
        }
    });
    if model_id.eq_ignore_ascii_case("PixVerse-V6") {
        parameters["generate_multi_clip_switch"] = json!({
            "type": "boolean", "label": "多镜头", "default": false,
            "requestLocation": "metadata", "order": 4
        });
    }
    Some(json!({
        "resultType": "video",
        "requestProfileId": MOYU_PIXVERSE_VIDEO_PROFILE,
        "profileVersion": 1,
        "request": {
            "path": GATEWAY_VIDEO_PATH,
            "observePath": "/v1/video/generations/{task_id}",
            "encoding": "json", "parameterContainer": "root",
            "mediaEncoding": "pixverse_image_inputs", "mediaField": "images",
            "metadataField": "metadata", "promptMode": "prompt_or_media"
        },
        "parameters": parameters
    }))
}

fn is_seedance_20_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("seedance-2-0") || identity.contains("seedance-2.0")
}

pub(crate) fn is_seedance_25_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("seedance-2-5") || identity.contains("seedance-2.5")
}

pub(crate) const MOYU_SEEDANCE_DRAFT_PROFILE: &str = "moyu_seedance_25_draft_v1";

pub(crate) fn is_seedance_draft_video_model(model_id: &str) -> bool {
    model_id == "doubao-seedance-2-5-260628"
}

/// 同名模型在方舟上保留原生能力，只有 OpenAI 兼容网关采用本次草稿样片合同。
/// 旧的通用国内档案同时声明 1080p、联网搜索等字段；该网关的生成阶段仅开放
/// 480p/720p，1080p 正片由 draft_task 晋升请求让平台自动设置。
fn apply_seedance_draft_video_dialect(
    schema: &mut Value,
    model_id: &str,
    dialect: RequestDialect,
) -> bool {
    if !is_seedance_draft_video_model(model_id) {
        return false;
    }
    let Some(operation) = operation_object_mut(schema, GenerationOperation::VideoGeneration) else {
        return false;
    };
    let replacement = match dialect {
        RequestDialect::OpenAiCompatible => {
            let mut durations = vec![json!(-1)];
            durations.extend((4..=30).map(Value::from));
            json!({
                "resultType": "video",
                "requestProfileId": MOYU_SEEDANCE_DRAFT_PROFILE,
                "profileVersion": 1,
                "request": {
                    "path": GATEWAY_VIDEO_PATH,
                    "observePath": "/v1/video/generations/{task_id}",
                    "encoding": "json",
                    "parameterContainer": "metadata",
                    "contentContainer": "metadata"
                },
                "parameters": {
                    "ratio": {
                        "type": "string", "label": "画幅", "default": "adaptive",
                        "enum": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]
                    },
                    "resolution": {
                        "type": "string", "label": "分辨率", "default": "720p",
                        "enum": ["720p", "480p"]
                    },
                    "duration": {
                        "type": "integer", "label": "时长", "default": 5, "enum": durations
                    },
                    "generate_audio": {
                        "type": "boolean", "label": "生成音频", "default": true
                    },
                    "draft": {
                        "type": "boolean", "label": "生成草稿样片", "default": false
                    }
                }
            })
        }
        RequestDialect::VolcengineArk
            if operation.get("requestProfileId").and_then(Value::as_str)
                == Some(MOYU_SEEDANCE_DRAFT_PROFILE) =>
        {
            // default_operation_schema 按名称提供通用国内 Seedance 档案；端点随后
            // 仍由本连接的方言统一改写，恢复方舟档案不改变其他模型或适配器。
            default_operation_schema(model_id, GenerationOperation::VideoGeneration)
        }
        _ => return false,
    };
    let mut replacement = replacement.as_object().cloned().unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    if *operation == replacement {
        return false;
    }
    *operation = replacement;
    true
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

/// 按次系列只接受文档列出的八个完整 ID；相近名称或后缀版本不能套用此契约。
pub(crate) fn sp25_per_use_limits(model_id: &str) -> Option<(u32, u32, u32, u32)> {
    match model_id {
        "sp2.5-720p-4-15s" => Some((4, 15, 10, 0)),
        "sp2.5-720p-16-30s" => Some((16, 30, 10, 0)),
        "sp2.5-720p-30s-ch1" => Some((30, 30, 30, 0)),
        "sp2.5-720p-30s-ch2" => Some((30, 30, 9, 0)),
        "sp2.5-720p-30s-ch3" => Some((30, 30, 30, 0)),
        "sp2.5-720p-30s-ch4" => Some((30, 30, 9, 0)),
        "sp2.5-720p-30s-ch5" => Some((30, 30, 10, 10)),
        "sp2.5-720p-30s-ch6" => Some((30, 30, 30, 10)),
        _ => None,
    }
}

pub(crate) fn is_sp25_per_use_video_model(model_id: &str) -> bool {
    sp25_per_use_limits(model_id).is_some()
}

fn sp25_per_use_video_operation_schema(model_id: &str) -> Option<Value> {
    let (minimum_duration, maximum_duration, max_images, max_audios) =
        sp25_per_use_limits(model_id)?;
    let durations = (minimum_duration..=maximum_duration)
        .map(Value::from)
        .collect::<Vec<_>>();
    let mut parameters = json!({
        "ratio": {
            "type": "string",
            "label": "画幅",
            "default": "16:9",
            "enum": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
            "requestField": "ratio",
            "order": 0
        }
    });
    // 固定 30 秒型号由模型 ID 锁定时长，默认省略；文档也接受显式传 30。
    if minimum_duration != maximum_duration {
        parameters["duration"] = json!({
            "type": "integer",
            "label": "时长",
            "default": minimum_duration,
            "enum": durations,
            "requestField": "duration",
            "order": 1
        });
    } else {
        parameters["duration"] = json!({
            "type": "integer",
            "label": "时长",
            "optional": true,
            "enum": [30],
            "requestField": "duration",
            "order": 1
        });
    }
    // 分辨率同样由模型 ID 锁定；默认省略，但允许文档声明的显式 720P。
    parameters["resolution"] = json!({
        "type": "string",
        "label": "分辨率",
        "optional": true,
        "enum": ["720P"],
        "requestField": "resolution",
        "order": 2
    });
    Some(json!({
        "resultType": "video",
        "requestProfileId": "sp25_per_use_video_v1",
        "profileVersion": 1,
        "request": {
            "path": "/v1/video/generations",
            "encoding": "json",
            "parameterContainer": "root",
            "mediaEncoding": "sp25_per_use_urls",
            "mediaField": "images",
            "audioField": "reference_audios",
            "maxImages": max_images,
            "maxAudios": max_audios,
            "maxVideos": 0
        },
        "parameters": parameters
    }))
}

/// Seedance 2.5 RD 网关的按档位能力表。文档声明“本系列所有模型共用这套契约，
/// 只有价格、时长范围和参考素材上限不同”，因此这里按完整模型 ID 建表（与按次
/// 系列同一原则：相近名称或后缀版本不能套用此契约），未来新增档位只需扩表。
///
/// - `rd-seedance-2.5-480p/720p/1080p`：4–30 秒，30 图 + 10 视频 + 10 音频，
///   分辨率由模型 ID 锁定（`resolution` 可省略，传了必须与档位一致）。
#[derive(Clone, Copy)]
pub(crate) struct RdVideoLimits {
    /// 模型档位对应的显式分辨率值（文档示例为大写 `720P`）。
    pub resolution: &'static str,
    pub minimum_duration: u32,
    pub maximum_duration: u32,
    pub max_images: u32,
    pub max_videos: u32,
    pub max_audios: u32,
}

pub(crate) fn rd_video_limits(model_id: &str) -> Option<RdVideoLimits> {
    let resolution = match model_id {
        "rd-seedance-2.5-480p" => "480P",
        "rd-seedance-2.5-720p" => "720P",
        "rd-seedance-2.5-1080p" => "1080P",
        _ => return None,
    };
    Some(RdVideoLimits {
        resolution,
        minimum_duration: 4,
        maximum_duration: 30,
        max_images: 30,
        max_videos: 10,
        max_audios: 10,
    })
}

pub(crate) fn is_rd_video_model(model_id: &str) -> bool {
    rd_video_limits(model_id).is_some()
}

/// Seedance 2.5 RD 网关的视频操作 Schema。
///
/// 该网关（new-api 内核）与魔芋 Seedance 契约（`metadata.content` + `metadata.*`）
/// 不同：`model`/`prompt`/`duration`/`ratio`/`resolution`/`generate_audio` 以及媒体
/// 数组 `images`/`reference_videos`/`reference_audios`/`start_frame`/`end_frame` 全部
/// 是顶层字段。模型 ID 含 `seedance-2.5` 子串，必须排在通用 Seedance 分支之前，
/// 否则会被误判为魔芋契约。
///
/// 媒体上传沿用按次系列的 `POST /v1/assets/uploads`（免费），本地素材先上传取回
/// 公网 URL 再提交；该网关没有素材库浏览接口，素材库侧按主机排除。
fn rd_video_operation_schema(model_id: &str) -> Option<Value> {
    let limits = rd_video_limits(model_id)?;
    let durations = (limits.minimum_duration..=limits.maximum_duration)
        .map(Value::from)
        .collect::<Vec<_>>();
    let parameters = json!({
        "duration": {
            "type": "integer",
            "label": "时长",
            "default": 5,
            "enum": durations,
            "requestField": "duration",
            "order": 0
        },
        "ratio": {
            "type": "string",
            "label": "画幅",
            "default": "16:9",
            "enum": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
            "requestField": "ratio",
            "order": 1
        },
        "resolution": {
            "type": "string",
            "label": "分辨率",
            "optional": true,
            "enum": [limits.resolution],
            "requestField": "resolution",
            "order": 2
        },
        "generate_audio": {
            "type": "boolean",
            "label": "生成音频",
            "default": true,
            "requestField": "generate_audio",
            "order": 3
        }
    });
    Some(json!({
        "resultType": "video",
        "requestProfileId": "rd_video_v1",
        "profileVersion": 1,
        "request": {
            "path": "/v1/video/generations",
            "encoding": "json",
            "parameterContainer": "root",
            "mediaEncoding": "rd_video_urls",
            "mediaField": "images",
            "videoField": "reference_videos",
            "audioField": "reference_audios",
            "maxImages": limits.max_images,
            "maxVideos": limits.max_videos,
            "maxAudios": limits.max_audios
        },
        "parameters": parameters
    }))
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
pub(crate) fn is_seedream_image_model(model_id: &str) -> bool {
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

/// 语音合成的请求档案同样按模型家族落定：`seed-tts-*` 只在豆包语音 OpenSpeech
/// 上有 SSE 接口，`seed-audio-*` 只在 OpenAI 兼容网关上有 `/v1/tts/create`。
/// 两个家族互斥，因此这里不需要连接方言参与。
pub fn is_doubao_voice_tts_model(model_id: &str) -> bool {
    model_id.trim().to_ascii_lowercase().starts_with("seed-tts")
}

pub fn is_gateway_tts_model(model_id: &str) -> bool {
    model_id
        .trim()
        .to_ascii_lowercase()
        .starts_with("seed-audio")
}

fn speech_request_profile(model_id: &str) -> &'static str {
    if is_doubao_voice_tts_model(model_id) {
        DOUBAO_TTS_REQUEST_PROFILE
    } else {
        GATEWAY_TTS_REQUEST_PROFILE
    }
}

/// 语音操作 Schema。配音不走通用生成任务通道，而由 `synthesize_speech` 命令
/// 独立执行，所以参数不声明成节点表单字段，避免生成一排没有消费者的控件。
fn speech_operation_schema(model_id: &str) -> Value {
    let (profile, path) = match speech_request_profile(model_id) {
        DOUBAO_TTS_REQUEST_PROFILE => (DOUBAO_TTS_REQUEST_PROFILE, DOUBAO_TTS_PATH),
        _ => (GATEWAY_TTS_REQUEST_PROFILE, GATEWAY_TTS_PATH),
    };
    json!({
        "resultType": "audio",
        "requestProfileId": profile,
        "profileVersion": 1,
        "request": {
            "path": path,
            "encoding": "json",
            "parameterContainer": "root"
        },
        "parameters": {}
    })
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
    refresh_sp25_per_use_video_defaults(&mut schema, model_id);
    refresh_rd_video_defaults(&mut schema, model_id);
    refresh_seedream_image_parameter_defaults(&mut schema, model_id);
    refresh_async_image_task_defaults(&mut schema, model_id);
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

    // 本地 Schema 用于显示参数和补充缺省值，不是服务端能力白名单。
    // 已保存的档案可能滞后于渠道，显式字段和值完整保留，由真实服务端判定。
    let mut normalized = supplied.clone();
    for (key, definition) in &definitions {
        let definition = definition.as_object().ok_or_else(|| {
            BackendError::validation(
                "model parameter definition must be an object",
                json!({ "parameter": key, "definition": definition }),
            )
        })?;
        if !normalized.contains_key(key)
            && let Some(value) = definition.get("default")
        {
            normalized.insert(key.clone(), value.clone());
        }
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
            GenerationOperation::SpeechGeneration => "audio",
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
        "speech_generation" | "speech-generation" | "text_to_speech" | "text-to-speech" | "tts" => {
            Some(GenerationOperation::SpeechGeneration)
        }
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
    refresh_sp25_per_use_video_defaults(&mut complete, model_id);
    refresh_pixverse_video_defaults(&mut complete, model_id);
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

/// `gpt-image-2.5`（sunburst / flare）走异步任务接口：
/// `POST /v1/images/generations` 只换回任务号，结果再查
/// `GET /v1/images/tasks/{id}`。请求体是 `aspect_ratio` + `resolution`，
/// 不是上一代 gpt-image 的 `size` / `quality`。
fn is_async_image_task_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("gpt-image-2.5") || identity.contains("gpt-image-2-5")
}

fn async_image_task_parameters() -> Value {
    json!({
        "aspect_ratio": {
            "type": "string",
            "label": "画幅",
            "default": "1:1",
            "enum": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
            "order": 1
        },
        "resolution": {
            "type": "string",
            "label": "分辨率",
            "default": "2k",
            "enum": ["1k", "2k", "4k"],
            "order": 2
        }
    })
}

/// Grsai 图片生成 API（gpt-image-2 系列）契约（文档
/// https://qmy27nhsd9.apifox.cn/452409160e0.md 与
/// https://qmy27nhsd9.apifox.cn/452409577e0.md）：
/// `POST /v1/api/generate` 提交（`replyType: async` 换任务号），
/// `GET /v1/api/result?id={task_id}` 轮询。同一批模型名在聚合网关上走
/// `/v1/images/generations`，契约必须按连接方言区分，不能按模型名全局推断。
pub const GRSAI_IMAGE_PROFILE: &str = "grsai_image_v1";
const GRSAI_GENERATE_PATH: &str = "/v1/api/generate";
/// 轮询模板带查询串：观察路径校验允许恰好一个 `?`，`endpoint` 会把它落成 URL 查询。
const GRSAI_RESULT_OBSERVE_PATH: &str = "/v1/api/result?id={task_id}";

/// Grsai 的 vip 系（`-vip` / `-flare` / `-sunburst`）：`aspectRatio` 只接受像素值，
/// 传比例字符串会被上游拒绝；`gpt-image-2` / `gpt-image-2.5` 则直接接受比例。
pub fn is_grsai_pixel_image_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    if !identity.contains("gpt-image") {
        return false;
    }
    identity.contains("-vip") || identity.contains("-flare") || identity.contains("-sunburst")
}

/// vip 系「比例 × 分辨率档位 → 文档像素值」参考表。1:3 与 3:1 没有第三档
/// （4K 档会超出文档声明的 3840px 最大边长约束）；`auto` 不查表、直接透传。
pub fn grsai_pixel_dimensions(aspect_ratio: &str, resolution: &str) -> Option<&'static str> {
    let (one_k, two_k, four_k) = match aspect_ratio {
        "1:1" => ("1024x1024", "2048x2048", "2880x2880"),
        "16:9" => ("1280x720", "2048x1152", "3840x2160"),
        "9:16" => ("720x1280", "1152x2048", "2160x3840"),
        "4:3" => ("1152x864", "2304x1728", "3264x2448"),
        "3:4" => ("864x1152", "1728x2304", "2448x3264"),
        "3:2" => ("1536x1024", "2048x1360", "3504x2336"),
        "2:3" => ("1024x1536", "1360x2048", "2336x3504"),
        "5:4" => ("1120x896", "2240x1792", "3200x2560"),
        "4:5" => ("896x1120", "1792x2240", "2560x3200"),
        "21:9" => ("1456x624", "2912x1248", "3840x1648"),
        "9:21" => ("624x1456", "1248x2912", "1648x3840"),
        "1:3" => ("688x2048", "1280x3840", ""),
        "3:1" => ("2048x688", "3840x1280", ""),
        "2:1" => ("1536x768", "3072x1536", "3840x1920"),
        "1:2" => ("768x1536", "1536x3072", "1920x3840"),
        _ => return None,
    };
    let pixel = match resolution {
        "1k" => one_k,
        "2k" => two_k,
        "4k" => four_k,
        _ => return None,
    };
    (!pixel.is_empty()).then_some(pixel)
}

/// Grsai 契约参数：非 vip 系只声明画幅（`aspectRatio` 收比例字符串；文档的
/// gpt-image-2 比例参考没有 1:3 与 3:1）。vip 系声明画幅 + 分辨率 + 质量 +
/// 透明背景：质量在 vip 上只接受 medium（唯一取值不再声明）、flare 上
/// low/medium/high、sunburst 上另有 xhigh/max；`background` 仅这三款支持
/// `transparent`，客户端按布尔勾选、只在勾选时发送。
fn grsai_image_parameters(model_id: &str) -> Value {
    if !is_grsai_pixel_image_model(model_id) {
        return json!({
            "aspect_ratio": {
                "type": "string",
                "label": "画幅",
                "default": "1:1",
                "enum": [
                    "auto", "1:1", "16:9", "9:16", "4:3", "3:4",
                    "3:2", "2:3", "5:4", "4:5", "21:9", "9:21", "1:2", "2:1"
                ],
                "requestField": "aspectRatio",
                "order": 1
            }
        });
    }
    let identity = model_id.to_ascii_lowercase();
    let mut parameters = Map::new();
    parameters.insert(
        "aspect_ratio".into(),
        json!({
            "type": "string",
            "label": "画幅",
            "default": "1:1",
            "enum": [
                "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
                "5:4", "4:5", "21:9", "9:21", "1:3", "3:1", "2:1", "1:2"
            ],
            "requestField": "aspectRatio",
            "order": 1
        }),
    );
    parameters.insert(
        "resolution".into(),
        json!({
            "type": "string",
            "label": "分辨率",
            "default": "2k",
            "enum": ["1k", "2k", "4k"],
            "order": 2
        }),
    );
    if identity.contains("-flare") {
        parameters.insert(
            "quality".into(),
            json!({
                "type": "string",
                "label": "质量",
                "default": "medium",
                "enum": ["low", "medium", "high"],
                "order": 3
            }),
        );
    } else if identity.contains("-sunburst") {
        parameters.insert(
            "quality".into(),
            json!({
                "type": "string",
                "label": "质量",
                "default": "medium",
                "enum": ["low", "medium", "high", "xhigh", "max"],
                "order": 3
            }),
        );
    }
    parameters.insert(
        "background".into(),
        json!({
            "type": "boolean",
            "label": "透明背景",
            "default": false,
            "order": 4
        }),
    );
    Value::Object(parameters)
}

fn grsai_image_operation_schema(model_id: &str, operation: GenerationOperation) -> Value {
    let mut request = Map::new();
    request.insert("path".into(), json!(GRSAI_GENERATE_PATH));
    request.insert("encoding".into(), json!("json"));
    request.insert("parameterContainer".into(), json!("root"));
    request.insert("observePath".into(), json!(GRSAI_RESULT_OBSERVE_PATH));
    if operation == GenerationOperation::ImageToImage {
        // 参考图走顶层 `images` 数组：公网 URL 原样透传，本地图片编码为
        // data URI（文档声明 base64 与 URL 均可）。
        request.insert("mediaEncoding".into(), json!("grsai_image_inputs"));
        request.insert("mediaField".into(), json!("images"));
    }
    json!({
        "resultType": "image",
        "requestProfileId": GRSAI_IMAGE_PROFILE,
        "profileVersion": 1,
        "request": request,
        "parameters": grsai_image_parameters(model_id)
    })
}

/// Grsai 连接上的 gpt-image 系模型整条改写成 Grsai 契约（端点、轮询、参数）。
/// 生成结果与当前条目一致时不写入，保证重复应用是幂等的。
fn apply_grsai_image_dialect(schema: &mut Value, identity: &str) -> bool {
    if !identity.contains("gpt-image") {
        return false;
    }
    let mut changed = false;
    for operation in [
        GenerationOperation::TextToImage,
        GenerationOperation::ImageToImage,
    ] {
        let Some(slot) = schema.get_mut(operation.as_str()) else {
            continue;
        };
        let replacement = grsai_image_operation_schema(identity, operation);
        if *slot != replacement {
            *slot = replacement;
            changed = true;
        }
    }
    changed
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
        GenerationOperation::SpeechGeneration => speech_operation_schema(model_id),
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
            if is_async_image_task_model(model_id) {
                return json!({
                    "resultType": "image",
                    "requestProfileId": "openai_image_tasks_v1",
                    "profileVersion": 1,
                    "request": {
                        "path": "/v1/images/generations",
                        "encoding": "json",
                        "parameterContainer": "root",
                        "observePath": "/v1/images/tasks/{task_id}"
                    },
                    "parameters": async_image_task_parameters()
                });
            }
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
            if let Some(schema) = pixverse_video_operation_schema(model_id) {
                return schema;
            }
            if let Some(schema) = sp25_per_use_video_operation_schema(model_id) {
                return schema;
            }
            // Seedance 2.5 RD 网关：顶层 `duration`/`ratio`/`resolution` 与顶层媒体数组。
            // 模型 ID 含 `seedance-2.5` 子串，必须排在通用 Seedance 2.5 分支之前，
            // 否则会被当成魔芋 metadata 契约。
            if let Some(schema) = rd_video_operation_schema(model_id) {
                return schema;
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

/// 把早期 PixVerse 通用 metadata/content 视频合同刷新为明确的顶层参数与
/// 图片 URL/img_id 数组合同。保留扩展参数定义与供应商标记；已经具备当前档案
/// 时保持原样，避免覆盖保存后的自定义参数与端点。
pub fn refresh_pixverse_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    let Some(mut replacement) = pixverse_video_operation_schema(model_id) else {
        return false;
    };
    let Some(operation) = operation_object_mut(schema, GenerationOperation::VideoGeneration) else {
        return false;
    };
    let has_current_profile = operation.get("requestProfileId").and_then(Value::as_str)
        == Some(MOYU_PIXVERSE_VIDEO_PROFILE)
        && operation
            .get("request")
            .and_then(|request| request.get("mediaEncoding"))
            .and_then(Value::as_str)
            == Some("pixverse_image_inputs");
    if has_current_profile {
        // 当前档案允许供应商调整已有参数；补齐目录只声明扩展参数时缺失的
        // 基础能力即可，不覆盖当前档案的参数定义和自定义请求路径。
        let Some(canonical_parameters) = replacement.get("parameters").and_then(Value::as_object)
        else {
            return false;
        };
        let Some(parameters) = operation
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
        else {
            operation.insert("parameters".into(), json!(canonical_parameters));
            return true;
        };
        let mut changed = false;
        for (key, value) in canonical_parameters {
            if !parameters.contains_key(key) {
                parameters.insert(key.clone(), value.clone());
                changed = true;
            }
        }
        return changed;
    }
    if let Some(provided_parameters) = operation.get("parameters").and_then(Value::as_object)
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
    let mut replacement = replacement.as_object().cloned().unwrap_or_default();
    for (key, value) in operation.iter() {
        if !matches!(
            key.as_str(),
            "parameters" | "request" | "requestProfileId" | "profileVersion" | "resultType"
        ) {
            replacement.insert(key.clone(), value.clone());
        }
    }
    if *operation == replacement {
        return false;
    }
    *operation = replacement;
    true
}

/// 按次系列只允许其文档列出的请求字段。旧的通用 Seedance 档案即使带有非空
/// 参数也必须替换，否则会把 `metadata`、首尾帧或生成音频等无效字段带入请求。
fn refresh_sp25_per_use_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    let Some(replacement) = sp25_per_use_video_operation_schema(model_id) else {
        return false;
    };
    let Some(operation) = schema.get_mut(GenerationOperation::VideoGeneration.as_str()) else {
        return false;
    };
    if *operation == replacement {
        return false;
    }
    *operation = replacement;
    true
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
    if is_seedance_draft_video_model(model_id)
        && schema
            .pointer("/video_generation/requestProfileId")
            .and_then(Value::as_str)
            == Some(MOYU_SEEDANCE_DRAFT_PROFILE)
    {
        // 已按网关草稿合同迁移的档案不再走旧国内能力补齐，避免每次打开都先
        // 加回 1080p/联网搜索、再由连接方言删除，造成无意义的重复写入。
        return false;
    }
    // RD 网关模型 ID 含 `seedance-2.5` 子串，但契约完全不同；
    // 其档案由 `refresh_rd_video_defaults` 负责刷新，这里不能把 1080p/联网搜索
    // 等魔芋能力塞进 RD 顶层契约。
    if is_rd_video_model(model_id) {
        return false;
    }
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

/// 把 RD 网关模型保存的旧视频档案刷新为当前顶层契约。
///
/// RD 模型 ID 含 `seedance-2.5` 子串：在本档案分支存在之前保存的绑定会被
/// 推断成魔芋 metadata 契约，提交时会因字段容器错位被网关拒绝。只要视频
/// 档案不是当前 `rd_video_v1` 档案，就整体替换为按当前档位表生成的规范
/// Schema（与按次系列的档案升级同一原则）。
pub fn refresh_rd_video_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_rd_video_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut(GenerationOperation::VideoGeneration.as_str())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if operation.get("requestProfileId").and_then(Value::as_str) == Some("rd_video_v1") {
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
/// 已保存的 gpt-image-2.5 若仍是上一代 `size` / `quality` 契约，改写成异步任务契约。
/// 供应商另外声明的参数保留；`size` / `quality` / `n` / `response_format` 不再发送。
fn refresh_async_image_task_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !is_async_image_task_model(model_id) {
        return false;
    }
    let Some(operation) = schema
        .get_mut("text_to_image")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let profile = operation.get("requestProfileId").and_then(Value::as_str);
    let observe = operation
        .get("request")
        .and_then(|request| request.get("observePath"))
        .and_then(Value::as_str);
    let parameters = operation.get("parameters");
    let ready = profile == Some("openai_image_tasks_v1")
        && observe == Some("/v1/images/tasks/{task_id}")
        && parameters
            .and_then(|parameters| parameters.get("aspect_ratio"))
            .is_some()
        && parameters
            .and_then(|parameters| parameters.get("resolution"))
            .is_some();
    if ready {
        return false;
    }
    if !matches!(
        profile,
        None | Some("openai_images_v1") | Some("openai_image_tasks_v1")
    ) {
        return false;
    }

    let mut replacement = default_operation_schema(model_id, GenerationOperation::TextToImage)
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(provided_parameters) = operation.get("parameters").and_then(Value::as_object)
        && let Some(target_parameters) = replacement
            .get_mut("parameters")
            .and_then(Value::as_object_mut)
    {
        for (key, value) in provided_parameters {
            if matches!(key.as_str(), "size" | "quality" | "n" | "response_format") {
                continue;
            }
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
    fn pixverse_profiles_match_only_the_documented_complete_model_ids() {
        for model_id in ["PixVerse-V6", "PixVerse-C1", "pixverse-v6", "PIXVERSE-C1"] {
            assert!(is_pixverse_video_model(model_id));
            let operation =
                default_operation_schema(model_id, GenerationOperation::VideoGeneration);
            assert_eq!(operation["requestProfileId"], MOYU_PIXVERSE_VIDEO_PROFILE);
            assert_eq!(operation["request"]["parameterContainer"], "root");
            assert_eq!(
                operation["request"]["mediaEncoding"],
                "pixverse_image_inputs"
            );
            assert_eq!(
                operation["request"]["observePath"],
                "/v1/video/generations/{task_id}"
            );
            assert_eq!(operation["request"]["promptMode"], "prompt_or_media");
            assert_eq!(operation["parameters"]["duration"]["default"], 5);
            assert_eq!(
                operation["parameters"]["duration"]["enum"],
                json!((1..=15).collect::<Vec<_>>())
            );
            assert_eq!(
                operation["parameters"]["quality"]["enum"],
                json!(["360p", "540p", "720p", "1080p"])
            );
            assert_eq!(
                operation["parameters"]["quality"]["requestLocation"],
                "metadata"
            );
            assert!(operation["parameters"]["action"].get("default").is_none());
            assert_eq!(
                operation["parameters"]["action"]["enum"],
                json!(["text", "img", "fusion"])
            );
            assert_eq!(
                operation["parameters"]
                    .get("generate_multi_clip_switch")
                    .is_some(),
                model_id.eq_ignore_ascii_case("PixVerse-V6")
            );
        }
        for model_id in [
            "PixVerse-V5",
            "PixVerse-V6-pro",
            "PixVerse-C1-preview",
            "vendor/PixVerse-V6",
        ] {
            assert!(!is_pixverse_video_model(model_id));
            assert!(pixverse_video_operation_schema(model_id).is_none());
        }
    }

    #[test]
    fn pixverse_catalog_fixes_chat_labels_and_preserves_video_extensions() {
        for item in [
            json!({ "id": "PixVerse-C1", "operations": ["chat"] }),
            json!({ "id": "PixVerse-C1", "capabilities": { "operations": {
                "text_generation": { "resultType": "text", "parameters": {} }
            } } }),
        ] {
            let schema = infer_catalog_schema(&item, "PixVerse-C1", "PixVerse C1");
            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration]
            );
            assert_eq!(
                schema["video_generation"]["requestProfileId"],
                MOYU_PIXVERSE_VIDEO_PROFILE
            );
        }
        let advertised = json!({ "operations": {
            "text_generation": { "resultType": "text", "parameters": {} },
            "video_generation": {
                "resultType": "video", "vendorTag": "custom",
                "parameters": { "vendor_option": { "type": "string", "optional": true } }
            }
        } });
        let schema = infer_catalog_schema(&advertised, "PixVerse-V6", "PixVerse V6");
        assert_eq!(
            operations_from_schema(&schema),
            [GenerationOperation::VideoGeneration]
        );
        assert_eq!(schema["video_generation"]["vendorTag"], "custom");
        assert_eq!(
            schema["video_generation"]["parameters"]["duration"]["default"],
            5
        );
        assert_eq!(
            schema["video_generation"]["parameters"]["vendor_option"]["optional"],
            true
        );
    }

    #[test]
    fn pixverse_old_saved_schema_is_repaired_only_for_the_gateway_dialect() {
        let stale = json!({ "video_generation": {
            "resultType": "video", "requestProfileId": "moyu_video_metadata_v1",
            "request": { "path": "/vendor/video", "parameterContainer": "metadata", "contentContainer": "metadata" },
            "parameters": { "vendor_option": { "type": "string", "optional": true } },
            "vendorTag": "keep"
        } });
        for dialect in [
            RequestDialect::VolcengineArk,
            RequestDialect::AliyunBailian,
            RequestDialect::Grsai,
        ] {
            let mut preserved = stale.clone();
            assert!(!apply_request_dialect(
                &mut preserved,
                "PixVerse-V6",
                dialect
            ));
            assert_eq!(preserved, stale);
        }
        let mut repaired = stale;
        assert!(apply_request_dialect(
            &mut repaired,
            "PixVerse-V6",
            RequestDialect::OpenAiCompatible
        ));
        let video = &repaired["video_generation"];
        assert_eq!(video["requestProfileId"], MOYU_PIXVERSE_VIDEO_PROFILE);
        assert_eq!(video["request"]["path"], "/v1/video/generations");
        assert_eq!(video["request"]["parameterContainer"], "root");
        assert!(video["request"].get("contentContainer").is_none());
        assert_eq!(video["vendorTag"], "keep");
        assert!(video["parameters"].get("vendor_option").is_some());
        assert!(!apply_request_dialect(
            &mut repaired,
            "PixVerse-V6",
            RequestDialect::OpenAiCompatible
        ));
    }

    #[test]
    fn pixverse_normalization_keeps_explicit_parameters_and_metadata() {
        let operation =
            default_operation_schema("PixVerse-C1", GenerationOperation::VideoGeneration);
        let supplied = json!({
            "duration": 16, "quality": "future_quality", "seed": -1,
            "generate_multi_clip_switch": true,
            "metadata": { "duration": 8, "quality": "1080p", "action": "modify", "media_id": "123" }
        });
        let normalized = normalize_parameters(&operation, &supplied).unwrap();
        for (key, value) in supplied.as_object().unwrap() {
            assert_eq!(normalized.get(key), Some(value), "{key}");
        }
        assert_eq!(normalized["aspect_ratio"], "16:9");
        assert_eq!(normalized["generate_audio_switch"], false);
        assert!(
            normalize_parameters(&operation, &json!({}))
                .unwrap()
                .get("action")
                .is_none()
        );
    }

    #[test]
    fn speech_profile_and_endpoint_follow_the_model_family() {
        // 魔芋 seed-audio 系：JSON 提交 + 音频二进制响应，端点是网关的 /v1/tts/create。
        let gateway =
            default_operation_schema("seed-audio-1.0", GenerationOperation::SpeechGeneration);
        assert_eq!(
            gateway["requestProfileId"].as_str(),
            Some(GATEWAY_TTS_REQUEST_PROFILE)
        );
        assert_eq!(gateway["request"]["path"].as_str(), Some(GATEWAY_TTS_PATH));
        assert_eq!(gateway["resultType"].as_str(), Some("audio"));
        // 豆包 seed-tts 系仍留在独立语音连接的 SSE 接口上。
        let doubao =
            default_operation_schema("seed-tts-2.0", GenerationOperation::SpeechGeneration);
        assert_eq!(
            doubao["requestProfileId"].as_str(),
            Some(DOUBAO_TTS_REQUEST_PROFILE)
        );
        assert_eq!(doubao["request"]["path"].as_str(), Some(DOUBAO_TTS_PATH));
        assert_eq!(
            schema_for_enabled_operations(
                &Value::Object(Map::new()),
                "seed-audio-1.0",
                &[GenerationOperation::SpeechGeneration],
                RequestDialect::VolcengineArk
            )["speech_generation"]["request"]["path"]
                .as_str(),
            Some(GATEWAY_TTS_PATH)
        );
    }

    #[test]
    fn catalog_models_recognised_as_speech_keep_their_family_endpoint() {
        let item = json!({ "id": "seed-audio-1.0", "display_name": "Seed Audio 1.0" });
        let schema = infer_catalog_schema(&item, "seed-audio-1.0", "Seed Audio 1.0");
        assert_eq!(
            operations_from_schema(&schema),
            vec![GenerationOperation::SpeechGeneration]
        );
        assert_eq!(
            schema["speech_generation"]["request"]["path"].as_str(),
            Some(GATEWAY_TTS_PATH)
        );
        // 聚合目录把语音模型泛化成 chat 能力时，已知家族不能被泛化标签覆盖。
        let mislabelled = json!({ "id": "seed-audio-1.0", "operations": ["chat"] });
        assert_eq!(
            infer_catalog_schema(&mislabelled, "seed-audio-1.0", "Seed Audio 1.0")["speech_generation"]
                ["requestProfileId"]
                .as_str(),
            Some(GATEWAY_TTS_REQUEST_PROFILE)
        );
    }

    #[test]
    fn speech_dialect_repairs_a_definition_saved_for_the_other_family() {
        let mut schema =
            default_model_schema("seed-audio-1.0", &[GenerationOperation::SpeechGeneration]);
        schema["speech_generation"]["request"]["path"] = json!(DOUBAO_TTS_PATH);
        schema["speech_generation"]["requestProfileId"] = json!(DOUBAO_TTS_REQUEST_PROFILE);
        assert!(apply_request_dialect(
            &mut schema,
            "seed-audio-1.0",
            RequestDialect::OpenAiCompatible
        ));
        assert_eq!(
            schema["speech_generation"]["request"]["path"].as_str(),
            Some(GATEWAY_TTS_PATH)
        );
        assert_eq!(
            schema["speech_generation"]["requestProfileId"].as_str(),
            Some(GATEWAY_TTS_REQUEST_PROFILE)
        );
        // 已归一则不再改写，避免每次打开数据库都把定义标成「有变化」。
        assert!(!apply_request_dialect(
            &mut schema,
            "seed-audio-1.0",
            RequestDialect::OpenAiCompatible
        ));
        // 未接入的语音型号原样保留，不被强行套上任何一家端点。
        let mut unknown =
            default_model_schema("some-voice-model", &[GenerationOperation::SpeechGeneration]);
        unknown["speech_generation"]["request"]["path"] = json!("/custom/tts");
        assert!(!apply_request_dialect(
            &mut unknown,
            "some-voice-model",
            RequestDialect::OpenAiCompatible
        ));
        assert_eq!(
            unknown["speech_generation"]["request"]["path"].as_str(),
            Some("/custom/tts")
        );
    }

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
    fn sp25_per_use_models_use_exact_ids_and_documented_limits() {
        let models = [
            ("sp2.5-720p-4-15s", 4, 15, 10, 0),
            ("sp2.5-720p-16-30s", 16, 30, 10, 0),
            ("sp2.5-720p-30s-ch1", 30, 30, 30, 0),
            ("sp2.5-720p-30s-ch2", 30, 30, 9, 0),
            ("sp2.5-720p-30s-ch3", 30, 30, 30, 0),
            ("sp2.5-720p-30s-ch4", 30, 30, 9, 0),
            ("sp2.5-720p-30s-ch5", 30, 30, 10, 10),
            ("sp2.5-720p-30s-ch6", 30, 30, 30, 10),
        ];
        for (model_id, min_duration, max_duration, max_images, max_audios) in models {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration]
            );
            let video = &schema["video_generation"];
            assert_eq!(
                video["requestProfileId"], "sp25_per_use_video_v1",
                "{model_id}"
            );
            assert_eq!(
                video["request"]["path"], "/v1/video/generations",
                "{model_id}"
            );
            assert_eq!(video["request"]["parameterContainer"], "root", "{model_id}");
            assert_eq!(
                video["request"]["mediaEncoding"], "sp25_per_use_urls",
                "{model_id}"
            );
            assert_eq!(video["request"]["maxImages"], max_images, "{model_id}");
            assert_eq!(video["request"]["maxAudios"], max_audios, "{model_id}");
            assert_eq!(video["request"]["maxVideos"], 0, "{model_id}");
            assert_eq!(
                video["parameters"]["ratio"]["enum"],
                json!(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
                "{model_id}"
            );
            assert_eq!(video["parameters"]["resolution"]["enum"], json!(["720P"]));
            assert!(video["parameters"]["resolution"].get("default").is_none());
            if min_duration == max_duration {
                assert_eq!(video["parameters"]["duration"]["enum"], json!([30]));
                assert!(video["parameters"]["duration"].get("default").is_none());
            } else {
                let durations = video["parameters"]["duration"]["enum"].as_array().unwrap();
                assert_eq!(durations.first(), Some(&json!(min_duration)), "{model_id}");
                assert_eq!(durations.last(), Some(&json!(max_duration)), "{model_id}");
                assert_eq!(durations.len(), (max_duration - min_duration + 1) as usize);
            }
        }
        assert!(sp25_per_use_limits("sp2.5-720p-30s-ch7").is_none());
        assert!(sp25_per_use_limits("sp2.5-720p-30s-ch3-v2").is_none());
        assert!(sp25_per_use_limits("SP2.5-720P-30S-CH3").is_none());
    }

    #[test]
    fn sp25_catalog_ids_override_generic_advertised_capabilities() {
        for item in [
            json!({
                "id": "sp2.5-720p-4-15s",
                "operations": ["chat"]
            }),
            json!({
                "id": "sp2.5-720p-4-15s",
                "capabilities": {
                    "operations": {
                        "text_generation": { "resultType": "text", "parameters": {} }
                    }
                }
            }),
        ] {
            let schema = infer_catalog_schema(&item, "sp2.5-720p-4-15s", "SP 2.5");
            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration]
            );
            assert_eq!(
                schema["video_generation"]["requestProfileId"],
                "sp25_per_use_video_v1"
            );
        }
    }

    #[test]
    fn sp25_per_use_replaces_stale_seedance_contract_and_parameters() {
        let model_id = "sp2.5-720p-30s-ch5";
        let stale = json!({
            "video_generation": {
                "resultType": "video",
                "requestProfileId": "moyu_video_metadata_v1",
                "request": {
                    "path": "/v1/video/generations",
                    "encoding": "json",
                    "parameterContainer": "metadata",
                    "contentContainer": "metadata"
                },
                "parameters": {
                    "generate_audio": { "type": "boolean", "default": true },
                    "duration": { "type": "integer", "default": 5 }
                }
            }
        });
        let repaired = schema_for_enabled_operations(
            &stale,
            model_id,
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        let video = &repaired["video_generation"];
        assert_eq!(video["requestProfileId"], "sp25_per_use_video_v1");
        assert_eq!(video["request"]["parameterContainer"], "root");
        assert!(video["request"].get("contentContainer").is_none());
        assert!(video["parameters"].get("generate_audio").is_none());
        assert_eq!(
            normalize_parameters(video, &json!({})).unwrap(),
            json!({ "ratio": "16:9" })
        );
        assert_eq!(
            normalize_parameters(video, &json!({ "duration": 30, "resolution": "720P" })).unwrap(),
            json!({ "ratio": "16:9", "duration": 30, "resolution": "720P" })
        );
        assert_eq!(
            normalize_parameters(
                video,
                &json!({ "duration": 29, "resolution": "1080P", "generate_audio": true })
            )
            .unwrap(),
            json!({ "ratio": "16:9", "duration": 29, "resolution": "1080P", "generate_audio": true })
        );

        let mut unchanged = stale.clone();
        assert!(!refresh_sp25_per_use_video_defaults(
            &mut unchanged,
            "sp2.5-720p-30s-ch7"
        ));
        assert_eq!(unchanged, stale);
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

        // 其他家族自己的端点不受影响：Vidu 的 `/v1/videos` 轮询
        // 在两种方言下都保持原样（方舟上没有它们的位置）。
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
    fn image_dialect_rewrites_seedream_text_to_image_and_image_to_image() {
        let mut schema = default_model_schema(
            "doubao-seedream-4-5-251128",
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
        );
        assert!(apply_request_dialect(
            &mut schema,
            "doubao-seedream-4-5-251128",
            RequestDialect::VolcengineArk
        ));
        assert_eq!(
            schema["text_to_image"]["request"]["path"],
            "/images/generations"
        );
        assert_eq!(
            schema["image_to_image"]["request"]["path"],
            "/images/generations"
        );
        assert_eq!(schema["image_to_image"]["request"]["mediaField"], "image");

        assert!(apply_request_dialect(
            &mut schema,
            "doubao-seedream-4-5-251128",
            RequestDialect::OpenAiCompatible
        ));
        assert_eq!(
            schema["text_to_image"]["request"]["path"],
            "/v1/images/generations"
        );
        assert_eq!(
            schema["image_to_image"]["request"]["path"],
            "/v1/images/generations"
        );
        assert_eq!(
            schema["image_to_image"]["request"]["mediaEncoding"],
            "seedream_image_urls"
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
    fn seedance_draft_gateway_schema_overrides_catalog_labels_and_keeps_ark_contract() {
        let model = "doubao-seedance-2-5-260628";
        let mut schema = infer_catalog_schema(
            &json!({ "id": model, "capabilities": ["text_generation"] }),
            model,
            "文本模型",
        );
        assert_eq!(
            operations_from_schema(&schema),
            [GenerationOperation::VideoGeneration]
        );
        assert!(apply_request_dialect(
            &mut schema,
            model,
            RequestDialect::OpenAiCompatible
        ));
        let gateway = &schema["video_generation"];
        assert_eq!(gateway["requestProfileId"], MOYU_SEEDANCE_DRAFT_PROFILE);
        assert_eq!(gateway["request"]["path"], "/v1/video/generations");
        assert_eq!(gateway["parameters"]["duration"]["default"], 5);
        assert_eq!(
            gateway["parameters"]["resolution"]["enum"],
            json!(["720p", "480p"])
        );
        assert_eq!(gateway["parameters"]["draft"]["default"], false);
        assert!(gateway["parameters"].get("web_search").is_none());
        assert!(gateway["parameters"].get("output_format").is_none());
        assert!(!apply_request_dialect(
            &mut schema,
            model,
            RequestDialect::OpenAiCompatible
        ));
        assert!(!refresh_seedance_25_video_defaults(&mut schema, model));

        assert!(apply_request_dialect(
            &mut schema,
            model,
            RequestDialect::VolcengineArk
        ));
        let ark = &schema["video_generation"];
        assert_eq!(ark["request"]["path"], "/contents/generations/tasks");
        assert_eq!(ark["request"]["parameterContainer"], "root");
        assert_eq!(ark["parameters"]["duration"]["default"], -1);
        assert!(
            ark["parameters"]["resolution"]["enum"]
                .as_array()
                .unwrap()
                .contains(&json!("1080p"))
        );
        assert!(ark["parameters"].get("web_search").is_some());
        assert!(ark["parameters"].get("draft").is_none());
        assert!(!apply_request_dialect(
            &mut schema,
            model,
            RequestDialect::VolcengineArk
        ));

        for other in [
            "doubao-seedance-2.5",
            "doubao-seedance-2-5-260629",
            "dreamina-seedance-2.5",
            "rd-seedance-2.5-720p",
        ] {
            let mut legacy = default_model_schema(other, &[GenerationOperation::VideoGeneration]);
            let before = legacy.clone();
            apply_request_dialect(&mut legacy, other, RequestDialect::OpenAiCompatible);
            assert_eq!(legacy, before, "unrelated model {other} keeps its contract");
        }
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
    fn rd_video_models_use_the_top_level_gateway_contract() {
        for (model_id, tier) in [
            ("rd-seedance-2.5-480p", "480P"),
            ("rd-seedance-2.5-720p", "720P"),
            ("rd-seedance-2.5-1080p", "1080P"),
        ] {
            let schema = infer_catalog_schema(&json!({ "id": model_id }), model_id, model_id);
            let definition = &schema["video_generation"];
            let parameters = &definition["parameters"];

            assert_eq!(
                operations_from_schema(&schema),
                [GenerationOperation::VideoGeneration],
                "model {model_id}"
            );
            assert_eq!(definition["resultType"], "video");
            // 模型 ID 含 `seedance-2.5` 子串，但必须命中 RD 顶层契约而不是魔芋契约。
            assert_eq!(definition["requestProfileId"], "rd_video_v1");
            assert_eq!(definition["request"]["path"], "/v1/video/generations");
            assert_eq!(definition["request"]["parameterContainer"], "root");
            assert_eq!(definition["request"]["mediaEncoding"], "rd_video_urls");
            assert_eq!(definition["request"]["mediaField"], "images");
            assert_eq!(definition["request"]["videoField"], "reference_videos");
            assert_eq!(definition["request"]["audioField"], "reference_audios");
            assert_eq!(definition["request"]["maxImages"], 30);
            assert_eq!(definition["request"]["maxVideos"], 10);
            assert_eq!(definition["request"]["maxAudios"], 10);
            assert!(definition["request"].get("observePath").is_none());

            // 分辨率由模型 ID 锁定；可省略，显式传值必须与档位一致。
            assert_eq!(parameters["resolution"]["enum"], json!([tier]));
            assert_eq!(parameters["resolution"]["optional"], true);
            assert_eq!(parameters["duration"]["default"], 5);
            assert_eq!(
                parameters["duration"]["enum"]
                    .as_array()
                    .unwrap()
                    .as_slice(),
                &(4..=30).map(Value::from).collect::<Vec<_>>()
            );
            assert_eq!(parameters["ratio"]["default"], "16:9");
            assert_eq!(
                parameters["ratio"]["enum"],
                json!(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"])
            );
            assert_eq!(parameters["generate_audio"]["default"], true);
            // RD 契约没有魔芋 Seedance 2.5 的任务类型、联网搜索与输出格式字段。
            assert!(parameters.get("omni_reference_task_type").is_none());
            assert!(parameters.get("web_search").is_none());
            assert!(parameters.get("output_format").is_none());
        }
    }

    #[test]
    fn domestic_seedance_25_keeps_the_moyu_contract_next_to_rd_models() {
        let schema = infer_catalog_schema(
            &json!({ "id": "doubao-seedance-2-5-260628" }),
            "doubao-seedance-2-5-260628",
            "doubao-seedance-2-5-260628",
        );
        assert_eq!(
            schema["video_generation"]["requestProfileId"],
            "moyu_video_metadata_v1"
        );
    }

    #[test]
    fn seedance_25_refresher_does_not_touch_rd_archives() {
        let rd_schema =
            default_operation_schema("rd-seedance-2.5-720p", GenerationOperation::VideoGeneration);
        let mut schema = json!({ "video_generation": rd_schema });
        // 魔芋刷新器会把 1080p/联网搜索塞进国内 Seedance 2.5 档案；RD 档案必须原样保留。
        assert!(!refresh_seedance_25_video_defaults(
            &mut schema,
            "rd-seedance-2.5-720p"
        ));
        assert_eq!(
            schema["video_generation"]["requestProfileId"],
            "rd_video_v1"
        );
        assert!(
            schema["video_generation"]["parameters"]
                .get("web_search")
                .is_none()
        );
        assert_eq!(
            schema["video_generation"]["parameters"]["resolution"]["enum"],
            json!(["720P"])
        );
    }

    #[test]
    fn stale_moyu_archive_for_rd_model_is_upgraded_to_the_rd_contract() {
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
            "rd-seedance-2.5-1080p",
            &[GenerationOperation::VideoGeneration],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            repaired["video_generation"]["requestProfileId"],
            "rd_video_v1"
        );
        assert_eq!(
            repaired["video_generation"]["request"]["parameterContainer"],
            "root"
        );
        assert_eq!(
            repaired["video_generation"]["parameters"]["resolution"]["enum"],
            json!(["1080P"])
        );
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
    fn normalizer_applies_defaults_and_defers_remote_parameter_policy() {
        let schema = json!({
            "parameters": {
                "duration": { "type": "integer", "default": 5, "enum": [5, 8], "minimum": 5, "maximum": 8 },
                "required_by_old_schema": { "type": "string", "required": true }
            }
        });
        assert_eq!(
            normalize_parameters(&schema, &json!({})).unwrap(),
            json!({ "duration": 5 })
        );
        for duration in [json!(7), json!(30), json!(1), json!("adaptive")] {
            let supplied = json!({ "duration": duration, "channel_extension": true });
            assert_eq!(normalize_parameters(&schema, &supplied).unwrap(), supplied);
        }
        assert_eq!(
            normalize_parameters(&schema, &json!({ "channel_extension": true })).unwrap(),
            json!({ "duration": 5, "channel_extension": true })
        );
        assert!(normalize_parameters(&schema, &json!([])).is_err());
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
    fn async_image_task_models_use_aspect_ratio_resolution_and_task_polling() {
        let fresh = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2.5-sunburst",
            &[GenerationOperation::TextToImage],
            RequestDialect::OpenAiCompatible,
        );
        let definition = &fresh["text_to_image"];
        assert_eq!(definition["requestProfileId"], "openai_image_tasks_v1");
        assert_eq!(definition["request"]["path"], "/v1/images/generations");
        assert_eq!(
            definition["request"]["observePath"],
            "/v1/images/tasks/{task_id}"
        );
        assert_eq!(definition["parameters"]["aspect_ratio"]["default"], "1:1");
        assert_eq!(definition["parameters"]["resolution"]["default"], "2k");
        assert!(definition["parameters"].get("size").is_none());
        assert!(definition["parameters"].get("quality").is_none());

        let classic = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2",
            &[GenerationOperation::TextToImage],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            classic["text_to_image"]["requestProfileId"],
            "openai_images_v1"
        );
        assert!(
            classic["text_to_image"]["request"]
                .get("observePath")
                .is_none()
        );

        let saved = schema_for_enabled_operations(
            &classic,
            "gpt-image-2.5-flare",
            &[GenerationOperation::TextToImage],
            RequestDialect::OpenAiCompatible,
        );
        assert_eq!(
            saved["text_to_image"]["request"]["observePath"],
            "/v1/images/tasks/{task_id}"
        );
        assert!(
            saved["text_to_image"]["parameters"]
                .get("aspect_ratio")
                .is_some()
        );
        assert!(saved["text_to_image"]["parameters"].get("size").is_none());
    }

    #[test]
    fn grsai_dialect_rewrites_gpt_image_families_to_the_generate_api() {
        // 同一批模型名：聚合网关方言得到 openai_image_tasks_v1 / openai_images_v1，
        // Grsai 方言整条换成 grsai_image_v1（端点 + 轮询 + 参数）。
        let sunburst = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2.5-sunburst",
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
            RequestDialect::Grsai,
        );
        let definition = &sunburst["text_to_image"];
        assert_eq!(definition["requestProfileId"], "grsai_image_v1");
        assert_eq!(definition["request"]["path"], "/v1/api/generate");
        assert_eq!(
            definition["request"]["observePath"],
            "/v1/api/result?id={task_id}"
        );
        // vip 系参数：画幅 + 分辨率 + 质量（sunburst 独有 xhigh/max）+ 透明背景。
        assert_eq!(
            definition["parameters"]["aspect_ratio"]["requestField"],
            "aspectRatio"
        );
        assert_eq!(definition["parameters"]["resolution"]["default"], "2k");
        assert_eq!(
            definition["parameters"]["quality"]["enum"],
            json!(["low", "medium", "high", "xhigh", "max"])
        );
        assert_eq!(definition["parameters"]["background"]["type"], "boolean");
        // 图生图：参考图走顶层 images 数组。
        assert_eq!(
            sunburst["image_to_image"]["request"]["mediaEncoding"],
            "grsai_image_inputs"
        );
        assert_eq!(
            sunburst["image_to_image"]["request"]["mediaField"],
            "images"
        );

        // 非 vip：只声明画幅（aspectRatio 直接收比例字符串），没有分辨率与透明背景。
        let plain = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        let plain_definition = &plain["text_to_image"];
        assert_eq!(plain_definition["requestProfileId"], "grsai_image_v1");
        assert!(plain_definition["parameters"].get("resolution").is_none());
        assert!(plain_definition["parameters"].get("quality").is_none());
        assert!(plain_definition["parameters"].get("background").is_none());
        // 文档的 gpt-image-2 比例参考没有 1:3 / 3:1。
        let ratios = plain_definition["parameters"]["aspect_ratio"]["enum"]
            .as_array()
            .expect("enum");
        assert!(!ratios.contains(&json!("1:3")));
        assert!(!ratios.contains(&json!("3:1")));

        // flare 的质量枚举与 sunburst 不同；vip 只接受 medium（不再声明质量参数）。
        let flare = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2.5-flare",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        assert_eq!(
            flare["text_to_image"]["parameters"]["quality"]["enum"],
            json!(["low", "medium", "high"])
        );
        let vip = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2-vip",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        assert!(vip["text_to_image"]["parameters"].get("quality").is_none());
        assert!(
            vip["text_to_image"]["parameters"]
                .get("background")
                .is_some()
        );
    }

    #[test]
    fn grsai_dialect_rewrite_is_idempotent_and_scoped() {
        // 重复应用（保存回读再保存）不产生第二次改写。
        let mut schema = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2.5",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        assert!(!apply_request_dialect(
            &mut schema,
            "gpt-image-2.5",
            RequestDialect::Grsai
        ));
        // Grsai 连接上的非 gpt-image 模型契约保持原样（不误改写成 Grsai 协议）。
        let seedream = schema_for_enabled_operations(
            &json!({}),
            "doubao-seedream-4-0",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        assert_eq!(
            seedream["text_to_image"]["requestProfileId"],
            "moyu_seedream_image_v1"
        );
        assert_eq!(
            seedream["text_to_image"]["request"]["path"],
            "/v1/images/generations"
        );
    }

    #[test]
    fn grsai_profile_is_immune_to_async_task_refresher() {
        // 已保存的 Grsai 定义重新经过 schema_for_enabled_operations（绑定刷新路径）：
        // 异步任务刷新器只认 openai 系档案，不得把 grsai_image_v1 改写回去。
        let saved = schema_for_enabled_operations(
            &json!({}),
            "gpt-image-2.5-sunburst",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        let rebound = schema_for_enabled_operations(
            &saved,
            "gpt-image-2.5-sunburst",
            &[GenerationOperation::TextToImage],
            RequestDialect::Grsai,
        );
        assert_eq!(rebound, saved);
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
