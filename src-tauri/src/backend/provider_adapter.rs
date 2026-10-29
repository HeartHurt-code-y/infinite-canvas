//! 供应商适配器抽象：连接身份、目录端点、请求头与百炼 URL 规则集中在这里。
//!
//! 模型实现（万相请求体、Seedance metadata）与适配器隔离：适配器只决定
//! 「打哪、带什么头、信封长什么样」，不决定提示词/素材如何编码。
//! 切换供应商是 `ProviderAdapterKind` 上的静态分发，不引入 trait object。

use reqwest::Method;
use serde_json::{Map, Value, json};
use url::Url;

use super::error::{BackendError, BackendResult};

pub const MOYU_ADAPTER_ID: &str = "moyu_v1";
/// 火山引擎方舟（Ark）素材资产库适配器：OpenAPI Action 风格 + V4 签名（AK/SK）。
pub const ARK_ADAPTER_ID: &str = "volcengine_ark_v1";
/// 阿里云百炼（华北2 北京 Model Studio / MaaS）。
pub const BAILIAN_ADAPTER_ID: &str = "aliyun_bailian_v1";
/// 豆包语音 OpenSpeech 服务，密钥与火山方舟完全独立。
pub const DOUBAO_VOICE_ADAPTER_ID: &str = "doubao_voice_v1";
/// Grsai 图片生成 API（gpt-image-2 系列）：`POST /v1/api/generate` 提交、
/// `GET /v1/api/result?id=` 轮询，与 OpenAI 兼容网关的 `/v1/images/*` 完全不同。
pub const GRSAI_ADAPTER_ID: &str = "grsai_v1";
/// 饭众烟图片与视频：按连接使用统一异步任务协议。
pub const FZY_ADAPTER_ID: &str = "fzy_ai_v1";
/// Atlas Cloud 模型生成 API：出图 `POST /api/v1/model/generateImage`、出视频
/// `POST /api/v1/model/generateVideo`，轮询统一 `GET /api/v1/model/prediction/{id}`；
/// 平台所有回答套一层 `data` 信封，与 OpenAI 兼容网关的 `/v1/images/*` 完全不同。
pub const ATLASCLOUD_ADAPTER_ID: &str = "atlascloud_v1";
pub const DOUBAO_VOICE_BASE_URL: &str = "https://openspeech.bytedance.com";

pub const SUPPORTED_ADAPTER_IDS: [&str; 7] = [
    MOYU_ADAPTER_ID,
    ARK_ADAPTER_ID,
    BAILIAN_ADAPTER_ID,
    DOUBAO_VOICE_ADAPTER_ID,
    GRSAI_ADAPTER_ID,
    FZY_ADAPTER_ID,
    ATLASCLOUD_ADAPTER_ID,
];

/// 华北2（北京）百炼 MaaS 主机后缀。业务空间 ID 作为子域拼进完整 Base URL。
pub const BAILIAN_BEIJING_HOST_SUFFIX: &str = "cn-beijing.maas.aliyuncs.com";

const ARK_MODELS_PATH: &str = "/models";
const GATEWAY_MODELS_PATH: &str = "/v1/models";
const BAILIAN_MODELS_PATH: &str = "/api/v1/models";

pub const BAILIAN_VIDEO_PATH: &str = "/api/v1/services/aigc/video-generation/video-synthesis";
pub const BAILIAN_VIDEO_OBSERVE_PATH: &str = "/api/v1/tasks/{task_id}";
pub const DASHSCOPE_VIDEO_ENVELOPE: &str = "dashscope_input_parameters";

const DASHSCOPE_ASYNC_HEADER: (&str, &str) = ("X-DashScope-Async", "enable");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAdapterKind {
    Moyu,
    VolcengineArk,
    AliyunBailian,
    DoubaoVoice,
    Grsai,
    FzyAi,
    AtlasCloud,
}

impl ProviderAdapterKind {
    pub fn parse(adapter_id: &str) -> Option<Self> {
        match adapter_id {
            MOYU_ADAPTER_ID => Some(Self::Moyu),
            ARK_ADAPTER_ID => Some(Self::VolcengineArk),
            BAILIAN_ADAPTER_ID => Some(Self::AliyunBailian),
            DOUBAO_VOICE_ADAPTER_ID => Some(Self::DoubaoVoice),
            GRSAI_ADAPTER_ID => Some(Self::Grsai),
            FZY_ADAPTER_ID => Some(Self::FzyAi),
            ATLASCLOUD_ADAPTER_ID => Some(Self::AtlasCloud),
            _ => None,
        }
    }

    pub fn require(adapter_id: &str) -> BackendResult<Self> {
        Self::parse(adapter_id).ok_or_else(|| {
            BackendError::validation(
                "provider adapter is not supported",
                json!({
                    "adapterId": adapter_id,
                    "supported": SUPPORTED_ADAPTER_IDS,
                }),
            )
        })
    }

    /// `parse` 的逆映射：只有往返用例需要它（生产代码始终沿用连接记录里的 adapter id 字符串）。

    /// 模型目录相对路径。连通性测试与「拉取模型」必须共用，避免两处各写一份后漂移。
    pub fn catalog_path(self) -> &'static str {
        match self {
            Self::VolcengineArk => ARK_MODELS_PATH,
            Self::AliyunBailian => BAILIAN_MODELS_PATH,
            // Grsai、Atlas Cloud 与豆包语音一样没有目录接口：`list_models` 直接返回
            // 文档列明的固定模型清单，不走这个路径。
            Self::Grsai | Self::DoubaoVoice | Self::AtlasCloud => "",
            Self::Moyu | Self::FzyAi => GATEWAY_MODELS_PATH,
        }
    }

    pub fn catalog_probe_query(self) -> Vec<(&'static str, String)> {
        match self {
            Self::AliyunBailian => vec![
                ("page_no", "1".into()),
                ("page_size", "1".into()),
                ("language", "zh-CN".into()),
            ],
            Self::Moyu
            | Self::VolcengineArk
            | Self::DoubaoVoice
            | Self::Grsai
            | Self::FzyAi
            | Self::AtlasCloud => Vec::new(),
        }
    }

    pub fn catalog_page_query(self, page_no: u32, page_size: u32) -> Vec<(&'static str, String)> {
        match self {
            Self::AliyunBailian => vec![
                ("page_no", page_no.to_string()),
                ("page_size", page_size.to_string()),
                ("language", "zh-CN".into()),
            ],
            Self::Moyu
            | Self::VolcengineArk
            | Self::DoubaoVoice
            | Self::Grsai
            | Self::FzyAi
            | Self::AtlasCloud => Vec::new(),
        }
    }

    pub fn paginates_catalog(self) -> bool {
        matches!(self, Self::AliyunBailian)
    }

    /// 百炼视频创建必须带异步头，否则上游报「不支持同步调用」。
    pub fn extra_headers(self, method: &Method) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::AliyunBailian if !method.is_safe() => &[DASHSCOPE_ASYNC_HEADER],
            _ => &[],
        }
    }

    pub fn allows_empty_credential(self) -> bool {
        matches!(self, Self::VolcengineArk)
    }

    pub fn supports_asset_library(self) -> bool {
        // Grsai 只有 generate / result 两个接口，没有素材库浏览或上传；
        // Atlas Cloud 只开放出图与轮询（外加一次性素材上传），没有素材库浏览接口。
        !matches!(
            self,
            Self::AliyunBailian
                | Self::DoubaoVoice
                | Self::Grsai
                | Self::FzyAi
                | Self::AtlasCloud
        )
    }

    pub fn uses_dashscope_wan_envelope(self) -> bool {
        matches!(self, Self::AliyunBailian)
    }

    /// 规范化连接 Base URL：方舟素材资产域名改写为推理 API；百炼校验华北2 主机。
    pub fn normalize_base_url(self, base_url: String) -> BackendResult<String> {
        match self {
            Self::VolcengineArk => {
                let parsed = Url::parse(&base_url)?;
                if parsed
                    .host_str()
                    .map(|host| host.ends_with("volcengineapi.com"))
                    .unwrap_or(false)
                {
                    Ok("https://ark.cn-beijing.volces.com/api/v3".to_string())
                } else {
                    Ok(base_url)
                }
            }
            Self::AliyunBailian => {
                let workspace_id = parse_bailian_workspace_id(&base_url).ok_or_else(|| {
                    BackendError::validation(
                        "阿里云百炼 Base URL 必须是华北2（北京）业务空间地址 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
                        json!({ "baseUrl": base_url }),
                    )
                })?;
                assemble_bailian_base_url(&workspace_id)
            }
            Self::DoubaoVoice => {
                let parsed = Url::parse(&base_url)?;
                if parsed.scheme() != "https"
                    || parsed.host_str() != Some("openspeech.bytedance.com")
                    || !parsed.path().trim_end_matches('/').is_empty()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(BackendError::validation(
                        "豆包语音连接必须使用官方地址 https://openspeech.bytedance.com",
                        json!({ "baseUrl": base_url }),
                    ));
                }
                Ok(DOUBAO_VOICE_BASE_URL.into())
            }
            // Grsai 有全球 / 国内两个官方节点，也常见自建中转：像 OpenAI 兼容网关一样
            // 保留用户填写的 Base URL，不做主机白名单。Atlas Cloud 同理（文档只给
            // `https://api.atlascloud.ai`，但也允许自建网关）。
            Self::Grsai | Self::Moyu | Self::FzyAi | Self::AtlasCloud => Ok(base_url),
        }
    }
}

pub fn is_supported_adapter_id(adapter_id: &str) -> bool {
    ProviderAdapterKind::parse(adapter_id).is_some()
}

pub fn catalog_path_for_adapter(adapter_id: &str) -> &'static str {
    ProviderAdapterKind::parse(adapter_id)
        .map(ProviderAdapterKind::catalog_path)
        .unwrap_or(GATEWAY_MODELS_PATH)
}

pub fn extra_headers_for_adapter(
    adapter_id: &str,
    method: &Method,
) -> &'static [(&'static str, &'static str)] {
    ProviderAdapterKind::parse(adapter_id)
        .map(|kind| kind.extra_headers(method))
        .unwrap_or(&[])
}

pub fn validate_workspace_id(workspace_id: &str) -> BackendResult<&str> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty()
        || workspace_id.len() > 64
        || !workspace_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        || !workspace_id
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
    {
        return Err(BackendError::validation(
            "业务空间 ID 只能包含字母、数字、连字符或下划线，且不能为空",
            json!({ "workspaceId": workspace_id }),
        ));
    }
    Ok(workspace_id)
}

pub fn assemble_bailian_base_url(workspace_id: &str) -> BackendResult<String> {
    let workspace_id = validate_workspace_id(workspace_id)?;
    Ok(format!(
        "https://{workspace_id}.{BAILIAN_BEIJING_HOST_SUFFIX}"
    ))
}

pub fn parse_bailian_workspace_id(base_url: &str) -> Option<String> {
    let parsed = Url::parse(base_url.trim()).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let suffix = format!(".{BAILIAN_BEIJING_HOST_SUFFIX}");
    let workspace = host.strip_suffix(&suffix)?;
    if workspace.is_empty() || workspace.contains('.') {
        return None;
    }
    Some(workspace.to_string())
}

/// 百炼目录页：`output.models` + `output.total`。
pub fn bailian_catalog_page(value: &Value) -> Option<(&Vec<Value>, u64)> {
    let models = value.pointer("/output/models").and_then(Value::as_array)?;
    let total = value
        .pointer("/output/total")
        .and_then(Value::as_u64)
        .unwrap_or(models.len() as u64);
    Some((models, total))
}

/// 把网关风格的万相扁平请求体改写成官方 DashScope 信封：
/// `{ model, input: { prompt, media }, parameters: { ... } }`。
pub fn wrap_dashscope_wan_video_body(body: Value) -> Value {
    let Value::Object(mut root) = body else {
        return body;
    };
    if root.get("input").is_some() {
        return Value::Object(root);
    }

    let model = root.remove("model");
    let prompt = root.remove("prompt");
    let media = root.remove("media");
    let parameters = std::mem::take(&mut root);

    let mut input = Map::new();
    if let Some(prompt) = prompt {
        input.insert("prompt".into(), prompt);
    }
    if let Some(media) = media {
        input.insert("media".into(), media);
    }
    ensure_prompt_extend_for_documents(&mut input, &mut root, &parameters);

    let mut wrapped = Map::new();
    if let Some(model) = model {
        wrapped.insert("model".into(), model);
    }
    if !input.is_empty() {
        wrapped.insert("input".into(), Value::Object(input));
    }
    let mut parameters = parameters;
    if let Some(forced) = root.remove("prompt_extend") {
        parameters.insert("prompt_extend".into(), forced);
    }
    if !parameters.is_empty() {
        wrapped.insert("parameters".into(), Value::Object(parameters));
    }
    Value::Object(wrapped)
}

fn ensure_prompt_extend_for_documents(
    input: &mut Map<String, Value>,
    leftover: &mut Map<String, Value>,
    parameters: &Map<String, Value>,
) {
    let needs_extend = input
        .get("media")
        .and_then(Value::as_array)
        .is_some_and(|media| {
            media.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("file" | "link")
                )
            })
        });
    if needs_extend && parameters.get("prompt_extend") != Some(&Value::Bool(true)) {
        leftover.insert("prompt_extend".into(), json!(true));
    }
}

pub fn finalize_video_body(adapter_id: &str, schema: &Value, body: Value) -> Value {
    let envelope = schema.pointer("/request/envelope").and_then(Value::as_str)
        == Some(DASHSCOPE_VIDEO_ENVELOPE);
    let adapter_wrap = ProviderAdapterKind::parse(adapter_id)
        .is_some_and(ProviderAdapterKind::uses_dashscope_wan_envelope);
    if envelope || adapter_wrap {
        wrap_dashscope_wan_video_body(body)
    } else {
        body
    }
}
