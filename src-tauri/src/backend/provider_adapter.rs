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

pub const SUPPORTED_ADAPTER_IDS: [&str; 3] = [MOYU_ADAPTER_ID, ARK_ADAPTER_ID, BAILIAN_ADAPTER_ID];

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
}

impl ProviderAdapterKind {
    pub fn parse(adapter_id: &str) -> Option<Self> {
        match adapter_id {
            MOYU_ADAPTER_ID => Some(Self::Moyu),
            ARK_ADAPTER_ID => Some(Self::VolcengineArk),
            BAILIAN_ADAPTER_ID => Some(Self::AliyunBailian),
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

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Moyu => MOYU_ADAPTER_ID,
            Self::VolcengineArk => ARK_ADAPTER_ID,
            Self::AliyunBailian => BAILIAN_ADAPTER_ID,
        }
    }

    /// 模型目录相对路径。连通性测试与「拉取模型」必须共用，避免两处各写一份后漂移。
    pub fn catalog_path(self) -> &'static str {
        match self {
            Self::VolcengineArk => ARK_MODELS_PATH,
            Self::AliyunBailian => BAILIAN_MODELS_PATH,
            Self::Moyu => GATEWAY_MODELS_PATH,
        }
    }

    pub fn catalog_probe_query(self) -> Vec<(&'static str, String)> {
        match self {
            Self::AliyunBailian => vec![
                ("page_no", "1".into()),
                ("page_size", "1".into()),
                ("language", "zh-CN".into()),
            ],
            Self::Moyu | Self::VolcengineArk => Vec::new(),
        }
    }

    pub fn catalog_page_query(self, page_no: u32, page_size: u32) -> Vec<(&'static str, String)> {
        match self {
            Self::AliyunBailian => vec![
                ("page_no", page_no.to_string()),
                ("page_size", page_size.to_string()),
                ("language", "zh-CN".into()),
            ],
            Self::Moyu | Self::VolcengineArk => Vec::new(),
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
        !matches!(self, Self::AliyunBailian)
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
            Self::Moyu => Ok(base_url),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_kind_maps_known_ids_and_rejects_unknown() {
        assert_eq!(
            ProviderAdapterKind::parse(MOYU_ADAPTER_ID),
            Some(ProviderAdapterKind::Moyu)
        );
        assert_eq!(
            ProviderAdapterKind::parse(ARK_ADAPTER_ID),
            Some(ProviderAdapterKind::VolcengineArk)
        );
        assert_eq!(
            ProviderAdapterKind::parse(BAILIAN_ADAPTER_ID),
            Some(ProviderAdapterKind::AliyunBailian)
        );
        assert_eq!(
            ProviderAdapterKind::AliyunBailian.as_str(),
            BAILIAN_ADAPTER_ID
        );
        assert!(ProviderAdapterKind::parse("unknown").is_none());
        assert!(ProviderAdapterKind::require("luma_v1").is_err());
    }

    #[test]
    fn catalog_paths_are_isolated_per_adapter() {
        assert_eq!(ProviderAdapterKind::VolcengineArk.catalog_path(), "/models");
        assert_eq!(ProviderAdapterKind::Moyu.catalog_path(), "/v1/models");
        assert_eq!(
            ProviderAdapterKind::AliyunBailian.catalog_path(),
            "/api/v1/models"
        );
        assert_eq!(catalog_path_for_adapter(""), "/v1/models");
    }

    #[test]
    fn bailian_posts_require_async_header() {
        assert_eq!(
            ProviderAdapterKind::AliyunBailian.extra_headers(&Method::POST),
            &[("X-DashScope-Async", "enable")]
        );
        assert!(
            ProviderAdapterKind::AliyunBailian
                .extra_headers(&Method::GET)
                .is_empty()
        );
        assert!(
            ProviderAdapterKind::Moyu
                .extra_headers(&Method::POST)
                .is_empty()
        );
    }

    #[test]
    fn beijing_workspace_id_assembles_and_parses_the_maas_host() {
        let url = assemble_bailian_base_url("llm-workspace-1").expect("url");
        assert_eq!(url, "https://llm-workspace-1.cn-beijing.maas.aliyuncs.com");
        assert_eq!(
            parse_bailian_workspace_id(&url).as_deref(),
            Some("llm-workspace-1")
        );
        assert!(parse_bailian_workspace_id("https://dashscope.aliyuncs.com/api/v1").is_none());
        assert!(assemble_bailian_base_url("bad.id").is_err());
        assert!(assemble_bailian_base_url("").is_err());
    }

    #[test]
    fn bailian_normalize_rejects_non_beijing_hosts() {
        let error = ProviderAdapterKind::AliyunBailian
            .normalize_base_url("https://dashscope.aliyuncs.com".into())
            .expect_err("must be beijing maas host");
        assert!(error.to_string().contains("华北2"));
        assert_eq!(
            ProviderAdapterKind::AliyunBailian
                .normalize_base_url("https://ws-1.cn-beijing.maas.aliyuncs.com/".into())
                .expect("ok"),
            "https://ws-1.cn-beijing.maas.aliyuncs.com"
        );
    }

    #[test]
    fn wan_gateway_body_wraps_into_dashscope_input_parameters() {
        let wrapped = wrap_dashscope_wan_video_body(json!({
            "model": "wan3.0-video",
            "prompt": "一只猫在草地上奔跑",
            "media": [{ "type": "first_frame", "url": "https://cdn.example.com/first.png" }],
            "resolution": "480P",
            "ratio": "adaptive",
            "duration": 5,
            "prompt_extend": true
        }));
        assert_eq!(wrapped["model"], "wan3.0-video");
        assert_eq!(wrapped["input"]["prompt"], "一只猫在草地上奔跑");
        assert_eq!(
            wrapped["input"]["media"],
            json!([{ "type": "first_frame", "url": "https://cdn.example.com/first.png" }])
        );
        assert_eq!(wrapped["parameters"]["resolution"], "480P");
        assert_eq!(wrapped["parameters"]["duration"], 5);
        assert!(wrapped.get("prompt").is_none());
        assert!(wrapped.get("media").is_none());
        // 已是信封则不再二次包裹。
        assert_eq!(wrap_dashscope_wan_video_body(wrapped.clone()), wrapped);
    }

    #[test]
    fn file_or_link_media_forces_prompt_extend() {
        let wrapped = wrap_dashscope_wan_video_body(json!({
            "model": "wan3.0-video",
            "prompt": "根据文档生成广告",
            "media": [{ "type": "file", "url": "https://cdn.example.com/brief.pptx" }],
            "duration": 10,
            "prompt_extend": false
        }));
        assert_eq!(wrapped["parameters"]["prompt_extend"], true);
    }
}
