use serde_json::{Map, Value, json};

use super::{
    error::{BackendError, BackendResult},
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

fn is_seedance_25_video_model(model_id: &str) -> bool {
    let identity = model_id.to_ascii_lowercase();
    identity.contains("seedance-2-5") || identity.contains("seedance-2.5")
}

fn is_dreamina_seedance_video_model(model_id: &str) -> bool {
    model_id.to_ascii_lowercase().contains("dreamina-seedance")
}

/// 已知视频生成家族与常见生成方向缩写。这里不使用宽泛的厂商品牌名，避免把
/// 同一厂商的文本模型误判为视频；供应商显式声明的 operations 永远拥有更高优先级。
fn is_video_model_identity(identity: &str) -> bool {
    const VIDEO_FRAGMENTS: [&str; 19] = [
        "seedance",
        "wan3.0-video",
        "wan3-0-video",
        "minimax-video",
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
    refresh_seedance_25_video_defaults(&mut schema, model_id);
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
    let schema = schema_for_enabled_operations(discovered, model_id, operations);
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
        "text_to_image" | "text-to-image" | "image_generation" | "image-generation" => {
            Some(GenerationOperation::TextToImage)
        }
        "image_to_image" | "image-to-image" | "image_edit" | "image-edit" => {
            Some(GenerationOperation::ImageToImage)
        }
        "video_generation" | "video-generation" | "text_to_video" | "text-to-video" => {
            Some(GenerationOperation::VideoGeneration)
        }
        "text_generation" | "text-generation" | "chat" | "chat_completion" | "chat-completion"
        | "llm" | "text" => Some(GenerationOperation::TextGeneration),
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
    refresh_seedance_25_video_defaults(&mut complete, model_id);
    complete
}

fn default_operation_schema(model_id: &str, operation: GenerationOperation) -> Value {
    match operation {
        GenerationOperation::TextGeneration => {
            let profile = text_request_profile(model_id);
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
            json!({
                "resultType": "image",
                "requestProfileId": "openai_images_v1",
                "profileVersion": 1,
                "request": {
                    "path": "/v1/images/generations",
                    "encoding": "json",
                    "parameterContainer": "root"
                },
                "parameters": {
                    "size": {
                        "type": "string",
                        "label": "尺寸",
                        "default": size_default,
                        "enum": size_enum
                    },
                    "quality": {
                        "type": "string",
                        "label": "质量",
                        "default": quality_default,
                        "enum": quality_enum
                    }
                }
            })
        }
        GenerationOperation::ImageToImage => json!({
            "resultType": "image",
            "requestProfileId": "openai_image_edits_v1",
            "profileVersion": 1,
            "request": {
                "path": "/v1/images/edits",
                "encoding": "multipart",
                "parameterContainer": "multipart"
            },
            "parameters": {}
        }),
        GenerationOperation::VideoGeneration => {
            let identity = model_id.to_ascii_lowercase();
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
                Value::Array((4..=15).map(Value::from).collect())
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
/// `model_definitions`。若 gpt-image 模型的参数仍是旧默认值（说明并非服务商
/// 下发的自定义参数），则原位替换为当前默认值；其余情况一律不动。
/// 返回是否发生了替换。
pub fn refresh_legacy_image_parameter_defaults(schema: &mut Value, model_id: &str) -> bool {
    if !model_id.to_ascii_lowercase().contains("gpt-image") {
        return false;
    }
    let Some(definition) = schema
        .get_mut("text_to_image")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let legacy = legacy_text_to_image_parameters();
    if definition.get("parameters") != Some(&legacy) {
        return false;
    }
    let Some(parameters) = default_operation_schema(model_id, GenerationOperation::TextToImage)
        .get("parameters")
        .cloned()
    else {
        return false;
    };
    definition.insert("parameters".into(), parameters);
    true
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
            assert_eq!(parameters["duration"]["enum"].as_array().unwrap().len(), 12);
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
        );
        let parameters = &repaired["video_generation"]["parameters"];
        assert_eq!(parameters["priority"]["default"], 0);
        assert_eq!(parameters["output_format"]["default"], "mp4");
        assert_eq!(parameters["generate_audio"]["default"], true);
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

        // 非 gpt-image 模型沿用通用文生图契约。
        let generic = default_model_schema("photon-1", &[GenerationOperation::TextToImage]);
        let generic_parameters = &generic["text_to_image"]["parameters"];
        assert_eq!(generic_parameters["quality"]["default"], "standard");
        assert_eq!(
            generic_parameters["quality"]["enum"],
            json!(["hd", "standard"])
        );
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

        // 非 gpt-image 模型的旧默认值保持原样（其供应商仍接受 standard/hd）。
        let mut generic = json!({
            "text_to_image": { "parameters": legacy_text_to_image_parameters() }
        });
        assert!(!refresh_legacy_image_parameter_defaults(
            &mut generic,
            "photon-1"
        ));
    }
}
