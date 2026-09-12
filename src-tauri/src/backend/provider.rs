use std::{collections::HashSet, sync::Arc};

use base64::Engine as _;
use chrono::Utc;
use futures_util::StreamExt as _;
use reqwest::{Method, multipart};
use serde_json::{Map, Value, json};
use tauri_plugin_log::log::{error, info, warn};
use url::Url;
use uuid::Uuid;

use super::{
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    model_schema::{
        infer_catalog_schema, is_seedance_25_video_model, operations_from_schema,
        provider_scoped_model_definition_id,
    },
    prompt_optimize::{TextModelFallbackRequest, TextModelStream},
    storage::{
        GenerationLifecycleFact, GenerationTaskLifecycle, Storage, TaskExecutionRecord, now_ms,
    },
    types::{
        ConnectivityTestResult, GenerationOperation, MediaType, RawProviderResponse,
        RemoteModelOption, TokenUsage, VideoTaskType,
    },
    volcengine_ark::{self, ArkCredentials},
};

pub const MOYU_ADAPTER_ID: &str = "moyu_v1";
/// 火山引擎方舟（Ark）素材资产库适配器：OpenAPI Action 风格 + V4 签名（AK/SK）。
/// 仅用于素材库连接；生成请求仍走 `moyu_v1` 的 OpenAI 兼容路径。
pub const ARK_ADAPTER_ID: &str = "volcengine_ark_v1";
/// 历史全局素材库令牌引用；仅用于兼容旧版本凭据。
///
/// 新版本优先使用 `asset-library-token:{provider_connection_id}`，避免不同
/// Base URL 共用凭据。未配置供应商专用令牌时才回退到本引用。
pub const ASSET_LIBRARY_CREDENTIAL_REF: &str = "asset-library-token";

/// 没有云端素材库的上游主机（小写、不含端口）。
///
/// 盘趣聚合网关（One API / new-api 内核）只开放 `/v1/models` 与
/// `/v1/video/generations*`，`/v1/assets/*` 全部 404：该连接只参与模型生成。
/// 素材库请求在解析阶段就按主机挡掉，避免把上游 404 原样当成「素材库故障」展示；
/// 判定口径与前端 `src/lib/assetLibrarySupport.ts` 保持一致。
/// 实测记录见 `docs/integrations/panqu-video-api.md`。
const HOSTS_WITHOUT_ASSET_LIBRARY: [&str; 2] = ["115.191.2.88", "panqu.com"];

/// 返回命中的「没有素材库」主机；地址无法解析时退回原始字符串比对（用户可能只填主机）。
fn host_without_asset_library(base_url: &str) -> Option<&'static str> {
    let host = Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_else(|| base_url.trim().to_ascii_lowercase());
    HOSTS_WITHOUT_ASSET_LIBRARY
        .into_iter()
        .find(|unsupported| host == *unsupported || host.ends_with(&format!(".{unsupported}")))
}

pub fn asset_library_credential_ref(provider_connection_id: &str) -> String {
    format!("{ASSET_LIBRARY_CREDENTIAL_REF}:{provider_connection_id}")
}

#[derive(Clone)]
pub struct ProviderRuntime {
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    credentials: CredentialStore,
    client: reqwest::Client,
}

#[derive(Clone)]
pub struct ResolvedProviderContext {
    pub provider_connection_id: String,
    pub adapter_id: String,
    pub base_url: String,
    pub api_key_ref: String,
    api_key: String,
}

/// 生成结果「直链二次下载」的鉴权与来源上下文。
///
/// 图片/视频接口返回的是结果文件的 `url`，下载由客户端自己发起。既有实现是一个
/// 完全裸的 GET（没有 `Authorization`、没有 `Referer`），上游只要做防盗链或要求
/// 同令牌访问就必然失败，而错误信息只会显示「HTTP 403」，看不出是缺请求头。
/// 这里把生成请求已经持有的身份整理成可复用的请求头。
///
/// **决策：`Authorization` 无条件发送**，即「与生成请求带同一把凭据」，不按目标主机
/// 设信任边界。产品侧明确接受它的代价：供应商返回的直链可能指向第三方存储域名，
/// 那把 API Key 也会发给该域名（供应商本身就是把这些直链交给我们的，凭据作用域的
/// 扩大由供应商的返回内容决定）。
///
/// 残余风险与既有缓解：
/// - 若直链主机 3xx 到另一个主机，reqwest 会剥离敏感头（含 `Authorization`），
///   不会把密钥转发出去；
/// - 若要收回这条策略，改回「仅同源发送」只需在 `apply` 里恢复 `trusts_host` 守卫
///   （`trusts_host` 仍被 `Referer` 使用，未删除）。
#[derive(Debug, Clone, Default)]
pub struct ResultDownloadAuth {
    provider_host: Option<String>,
    provider_origin: Option<String>,
    bearer_token: Option<String>,
}

impl ResultDownloadAuth {
    /// 从连接 base URL 与密钥构造。
    ///
    /// `from_context` 是生成链路的入口；单独暴露这一层，是为了让结果保存这类只有
    /// `taskId` 之外信息的调用方（以及测试）不必先拼出一个完整的
    /// `ResolvedProviderContext`。
    pub fn from_parts(base_url: &str, api_key: &str) -> Self {
        let parsed = match Url::parse(base_url) {
            Ok(parsed) => parsed,
            Err(_) => return Self::default(),
        };
        let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
            return Self::default();
        };
        Self {
            provider_host: Some(host),
            provider_origin: Some(parsed.origin().ascii_serialization()),
            bearer_token: Some(api_key.to_string()).filter(|key| !key.is_empty()),
        }
    }

    /// 从生成任务的冻结连接上下文构造：`api_key` 已按模型的令牌分组解析，
    /// 与本次生成实际使用的身份一致。
    pub fn from_context(context: &ResolvedProviderContext) -> Self {
        Self::from_parts(&context.base_url, &context.api_key)
    }

    /// 目标直链的主机是否是「同一个供应商」：同主机或其子域。
    ///
    /// 只用于决定 `Referer` 取哪一个 origin，不再约束 `Authorization`。
    fn trusts_host(&self, target: &Url) -> bool {
        let Some(provider_host) = self.provider_host.as_deref() else {
            return false;
        };
        let Some(target_host) = target.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        target_host == provider_host || target_host.ends_with(&format!(".{provider_host}"))
    }

    /// 把结果下载需要的请求头应用到请求上。
    ///
    /// - `Accept` 与 `Authorization`：恒定发送（凭据存在时），与生成请求使用同一把
    ///   `api_key`，不随目标主机变化；`Authorization` 不依赖 URL 能否解析。
    /// - `Referer`：同源时用供应商 origin；跨域时退化为直链自身的 origin——后者是
    ///   真正会校验防盗链的那个主机，用它的 origin 才能过检查，同时不把供应商地址
    ///   泄露给第三方。URL 无法解析时不构造该头。
    pub fn apply(&self, request: reqwest::RequestBuilder, url: &str) -> reqwest::RequestBuilder {
        let mut request = request.header(reqwest::header::ACCEPT, "image/*,video/*,*/*");
        if let Some(token) = self.bearer_token.as_deref() {
            request = request.bearer_auth(token);
        }
        let Ok(parsed) = Url::parse(url) else {
            return request;
        };
        let referer = if self.trusts_host(&parsed) {
            self.provider_origin.clone()
        } else {
            Some(parsed.origin().ascii_serialization())
        };
        if let Some(referer) = referer {
            request = request.header(reqwest::header::REFERER, referer);
        }
        request
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub media_type: MediaType,
    pub type_position: u32,
    pub role: String,
    pub display_name: String,
    pub stable_identity: Value,
    pub mime_type: String,
    pub byte_size: u64,
    /// 后端 ffprobe 从真实视频读取，不能由调用方元数据代填。
    pub duration_seconds: Option<f64>,
    pub sha256: String,
    pub file_name: String,
    pub bytes: Option<Vec<u8>>,
    pub remote_reference: Option<String>,
    pub prompt_segment_index: Option<usize>,
    /// 前端按输入（连线）顺序分配的全局序号，用于确定 content 数组顺序。
    pub content_index: Option<u32>,
}

impl ResolvedMedia {
    pub fn archive(&self) -> Value {
        json!({
            "mediaType": self.media_type,
            "typePosition": self.type_position,
            "role": self.role,
            "displayName": self.display_name,
            "stableIdentity": self.stable_identity,
            "mimeType": self.mime_type,
            "byteSize": self.byte_size,
            "durationSeconds": self.duration_seconds,
            "sha256": self.sha256,
            "fileName": self.file_name,
            "promptSegmentIndex": self.prompt_segment_index,
            "contentIndex": self.content_index,
            "remoteReference": self.remote_reference.as_ref().map(|value| redact_url_string(value)),
        })
    }
}

#[derive(Debug, Clone)]
pub enum CompiledContentItem {
    Text(String),
    Media {
        media_type: MediaType,
        type_position: u32,
    },
}

#[derive(Debug, Clone)]
pub struct ResolvedGeneration {
    pub rendered_prompt: String,
    pub content: Vec<CompiledContentItem>,
    pub images: Vec<ResolvedMedia>,
    pub videos: Vec<ResolvedMedia>,
    pub audios: Vec<ResolvedMedia>,
    pub parameters: Value,
    pub video_task_type: Option<VideoTaskType>,
    pub operation_schema: Value,
}

impl ResolvedGeneration {
    pub fn media(&self, media_type: MediaType, position: u32) -> Option<&ResolvedMedia> {
        let values = match media_type {
            MediaType::Image => &self.images,
            MediaType::Video => &self.videos,
            MediaType::Audio => &self.audios,
            MediaType::Text => &self.audios,
        };
        values.iter().find(|item| item.type_position == position)
    }

    pub fn archive(&self) -> Value {
        json!({
            "renderedPrompt": self.rendered_prompt,
            "content": self.content.iter().map(|item| match item {
                CompiledContentItem::Text(text) => json!({ "kind": "text", "text": text }),
                CompiledContentItem::Media { media_type, type_position } => json!({
                    "kind": "media",
                    "mediaType": media_type,
                    "typePosition": type_position
                }),
            }).collect::<Vec<_>>(),
            "images": self.images.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "videos": self.videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "audios": self.audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "parameters": self.parameters,
            "videoTaskType": self.video_task_type,
            "operationSchema": self.operation_schema,
        })
    }
}

/// 图片生成结果的图层元数据（Seedream 5.0 pro `layer_decomposition` 场景）。
/// 开启图层拆分后，响应 `data` 数组中每个项代表一个图层（含底图），携带
/// `z_index`（层级，0 为底图）、`name`（图层名）、`description`（图层描述）、
/// `bounding_box`（图层在画布中的包围盒）。用于把每个图层单独落为可编辑对象。
#[derive(Debug, Clone, Default)]
pub struct ImageLayerMetadata {
    pub z_index: u32,
    pub name: Option<String>,
    pub description: Option<String>,
    pub bounding_box: Option<Value>,
}

#[derive(Debug, Clone)]
pub enum ImageSource {
    Url {
        url: String,
        layer: Option<ImageLayerMetadata>,
    },
    Base64 {
        data: String,
        layer: Option<ImageLayerMetadata>,
    },
}

/// 媒体类型的稳定排序权重：image < video < audio，用于 content 数组稳定排序。
fn media_kind_rank(media_type: MediaType) -> u8 {
    match media_type {
        MediaType::Image => 0,
        MediaType::Video => 1,
        MediaType::Audio => 2,
        MediaType::Text => 3,
    }
}

#[derive(Debug, Clone)]
pub enum GenerationSubmission {
    Images(Vec<ImageSource>),
    RemoteVideoTask { task_id: String },
}

#[derive(Debug, Clone)]
pub struct GenerationObservation {
    pub remote_status: String,
    pub progress: Option<f64>,
    pub video_url: Option<String>,
    /// Context-IR（h3_context_ir）任务产出的是扩写文本，位于查询响应的
    /// `data.data.task.content.prompt`；视频任务此字段为 None。
    pub text_content: Option<String>,
    pub failure: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct CapturedHttpResponse {
    pub call_id: String,
    pub status: u16,
    pub headers: Value,
    pub body: String,
}

struct CapturedJsonRequest<'a> {
    phase: &'a str,
    method: Method,
    path: &'a str,
    body: &'a Value,
}

/// 单次文本模型调用的元数据：流式方言，以及本次是否为退避重试。
struct TextCallRequest<'a> {
    phase: &'a str,
    dialect: Option<TextModelStream>,
    fallback_reason: Option<&'a str>,
}

/// 等待响应头的上限。超过它说明上游在生成完成前完全不回传数据，这正是非流式请求
/// 触发反向代理零字节超时（如 Cloudflare 100 秒后的 524）的原因，因此提前给出
/// 指向明确的本机错误，而不是让代理层返回一个无法归因的状态码。
const FIRST_BYTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 流式响应的块间空闲上限：正常增量通常毫秒级到达，停发这么久即视为上游中断。
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// 单个 SSE 帧的缓冲上限。一帧承载一条增量，正常远小于此值；超过它说明上游没有
/// 按 SSE 分帧回传，继续缓存没有意义。
const SSE_FRAME_BUFFER_LIMIT: usize = 8 * 1024 * 1024;
/// 正文增量的转发间隔。模型每秒可能产出几十条增量，逐条转发会把 Tauri 事件通道和
/// 前端重渲染都打满；按时间合批后视觉上仍然是逐字推进。
const STREAM_DELTA_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

/// 三类文本接口共用的 SSE 增量累积器。
///
/// 逐块接收字节流，按空行切分事件帧，交给方言累积，最后重新组装成一份与该接口
/// **非流式响应等价**的完整响应对象。这样调用方的用量统计、截断判定与文本提取逻辑
/// 都不需要区分流式与非流式，也不需要区分接口方言。
///
/// 缓冲原始字节而不是先转成字符串：网络块边界与 UTF-8 字符边界无关，中文内容
/// 经常被拆在两个块里，只有在完整帧上解码才不会把字符撕成替换符（U+FFFD）。
#[derive(Default)]
struct SseFrameParser {
    buffer: Vec<u8>,
    frames: usize,
    parse_failures: usize,
    dropped_bytes: usize,
    provider_error: Option<Value>,
}

impl SseFrameParser {
    /// 累积一个网络块并就地派发其中已完整的事件帧；每个帧处理完都把新增正文推给
    /// `sink`，由它按时间节流后交给上层。
    fn push(&mut self, chunk: &[u8], dialect: &mut dyn DialectSink, sink: &mut StreamSink<'_>) {
        self.buffer.extend_from_slice(chunk);
        loop {
            // SSE 事件以空行结束，`\r\n\r\n` 与 `\n\n` 兼容。
            let Some((boundary, width)) = find_sse_boundary(&self.buffer) else {
                if self.buffer.len() > SSE_FRAME_BUFFER_LIMIT {
                    self.dropped_bytes += self.buffer.len();
                    warn!(
                        "[provider] SSE 帧超过缓冲上限，丢弃 {} 字节",
                        self.buffer.len()
                    );
                    self.buffer.clear();
                }
                return;
            };
            // 只对完整帧解码：帧内字节必然构成合法 UTF-8（上游按字符切分 JSON），
            // 因此这里不会产生替换符。
            let frame = String::from_utf8_lossy(&self.buffer[..boundary]).into_owned();
            self.buffer.drain(..boundary + width);
            self.accept_frame(&frame, dialect, sink);
        }
    }

    /// 解析一个事件帧。`data:` 承载 JSON 载荷，其余字段（event / id / 注释）忽略：
    /// 三类方言都把有效载荷放在 `data` 里，`event:` 只是事件种类的冗余标注，
    /// 种类可从载荷的字段形状判断，因此不需要单独跟踪。
    fn accept_frame(
        &mut self,
        frame: &str,
        dialect: &mut dyn DialectSink,
        sink: &mut StreamSink<'_>,
    ) {
        let mut data = String::new();
        for line in frame.lines() {
            let line = line.trim_end_matches('\r');
            if line.starts_with(':') {
                continue;
            }
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(payload.trim_start());
        }
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            self.parse_failures += 1;
            return;
        };
        self.frames += 1;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            self.provider_error.get_or_insert_with(|| error.clone());
        }
        dialect.accept_event(&value);
        // 一帧处理完就把新增正文推出去：正文在方言里是纯追加的，按「已发出长度」
        // 切片即可拿到增量，对三种方言都成立。
        sink.emit(dialect.text());
    }

    /// 组装完整响应对象：方言负责正文、终态与用量，这里统一附加流式诊断字段与
    /// 流内错误。顶层字段形状与非流式响应保持一致，`parse_token_usage` 因此无需改动。
    fn assemble(self, dialect: &dyn SseDialect) -> Value {
        let diagnostics = json!({
            "frames": self.frames,
            "parseFailures": self.parse_failures,
            "droppedBytes": self.dropped_bytes,
        });
        let mut payload = dialect.finish();
        if let Some(object) = payload.as_object_mut() {
            if let Some(error) = self.provider_error {
                object.insert("error".to_string(), error);
            }
            object.insert("x_stream".to_string(), diagnostics);
        }
        payload
    }
}

/// 方言事件入口：由 `SseFrameParser` 逐帧调用。
///
/// `text` 返回已累积的交付正文。正文在三种方言里都是纯追加的，因此「已发出长度 →
/// 当前长度」就是新增部分，流式转发不需要每种方言各写一套增量逻辑。
trait DialectSink {
    fn accept_event(&mut self, event: &Value);
    fn text(&self) -> &str;
}

/// 方言出口：把累积到的增量还原成该接口的非流式响应形状。
///
/// 要求 `Send`：方言实例在文本调用的异步任务里创建并跨 await 持有，不满足时
/// 整个 `run_prompt_node` future 会失去 `Send`，Tauri 命令将无法编译。
trait SseDialect: DialectSink + Send {
    fn finish(&self) -> Value;
}

/// 流式正文的下游出口。上层用它把增量推给前端（Tauri 事件），测试里可以直接收进
/// `String` 做断言。
pub type TextDeltaSink<'a> = dyn FnMut(&str) + Send + 'a;

/// 增量节流器：模型可能每秒产出几十条增量，逐条转发会把事件通道打满。
/// 按时间合批（默认 120ms），并保证流结束时把剩余部分补发一次。
struct StreamSink<'a> {
    sink: Option<&'a mut TextDeltaSink<'a>>,
    emitted_chars: usize,
    last_emit: Option<std::time::Instant>,
}

impl<'a> StreamSink<'a> {
    fn new(sink: Option<&'a mut TextDeltaSink<'a>>) -> Self {
        Self {
            sink,
            emitted_chars: 0,
            last_emit: None,
        }
    }

    /// 转发截至 `text` 的新增部分。切点会把「已发出长度」回退到最近的字符边界，
    /// 避免在多字节字符中间切片而 panic。
    fn emit(&mut self, text: &str) {
        if self.sink.is_none() {
            return;
        }
        if text.len() <= self.emitted_chars {
            return;
        }
        if let Some(last) = self.last_emit
            && last.elapsed() < STREAM_DELTA_INTERVAL
        {
            return;
        }
        let start = floor_char_boundary(text, self.emitted_chars);
        if start >= text.len() {
            return;
        }
        let delta = &text[start..];
        if let Some(sink) = self.sink.as_deref_mut() {
            sink(delta);
        }
        self.emitted_chars = text.len();
        self.last_emit = Some(std::time::Instant::now());
    }

    /// 补发剩余增量：流结束时调用，保证最后一段不会因为节流窗口而丢失。
    fn finish(&mut self, text: &str) {
        if self.sink.is_none() || text.len() <= self.emitted_chars {
            return;
        }
        let start = floor_char_boundary(text, self.emitted_chars);
        if start < text.len() {
            let delta = &text[start..];
            if let Some(sink) = self.sink.as_deref_mut() {
                sink(delta);
            }
        }
        self.emitted_chars = text.len();
    }
}

/// 返回不大于 `index` 的最大字符边界，`index` 越界时返回 `text.len()`。
fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut boundary = index;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    boundary
}

/// OpenAI 兼容 `/v1/chat/completions`：`choices[].delta.content` 增量，
/// `finish_reason` 在最后一个 choice 上，`usage` 在 `stream_options.include_usage`
/// 打开的末尾分片里。
#[derive(Default)]
struct OpenAiChatDialect {
    id: Option<String>,
    model: Option<String>,
    created: Option<i64>,
    finish_reason: Option<String>,
    content: String,
    reasoning_content: String,
    usage: Option<Value>,
}

impl DialectSink for OpenAiChatDialect {
    fn accept_event(&mut self, value: &Value) {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            self.id.get_or_insert_with(|| id.to_string());
        }
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            self.model.get_or_insert_with(|| model.to_string());
        }
        if let Some(created) = value.get("created").and_then(Value::as_i64) {
            self.created.get_or_insert(created);
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(usage.clone());
        }
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            return;
        };
        for choice in choices {
            let delta = choice.get("delta").unwrap_or(choice);
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.content.push_str(text);
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                self.reasoning_content.push_str(reasoning);
            }
            if let Some(reason) = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
            {
                self.finish_reason = Some(reason.to_string());
            }
        }
    }

    fn text(&self) -> &str {
        &self.content
    }
}

impl SseDialect for OpenAiChatDialect {
    fn finish(&self) -> Value {
        let mut choice = serde_json::Map::new();
        choice.insert("index".to_string(), json!(0));
        choice.insert(
            "message".to_string(),
            json!({
                "role": "assistant",
                "content": self.content,
                "reasoning_content": self.reasoning_content,
            }),
        );
        choice.insert(
            "finish_reason".to_string(),
            self.finish_reason
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        let mut payload = serde_json::Map::new();
        payload.insert("object".to_string(), json!("chat.completion"));
        if let Some(id) = &self.id {
            payload.insert("id".to_string(), Value::String(id.clone()));
        }
        if let Some(model) = &self.model {
            payload.insert("model".to_string(), Value::String(model.clone()));
        }
        if let Some(created) = self.created {
            payload.insert("created".to_string(), json!(created));
        }
        payload.insert(
            "choices".to_string(),
            Value::Array(vec![Value::Object(choice)]),
        );
        if let Some(usage) = &self.usage {
            payload.insert("usage".to_string(), usage.clone());
        }
        Value::Object(payload)
    }
}

/// Anthropic Messages `/v1/messages`：`message_start` 给出 id / model / 输入用量，
/// `content_block_delta` 的 `delta.text` 是正文增量，`message_delta` 给出
/// `stop_reason` 与输出用量。终态还原为 `content[]` 文本块 + `stop_reason` + `usage`，
/// 与非流式响应形状一致。
#[derive(Default)]
struct AnthropicMessagesDialect {
    id: Option<String>,
    model: Option<String>,
    stop_reason: Option<String>,
    text: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl DialectSink for AnthropicMessagesDialect {
    fn accept_event(&mut self, value: &Value) {
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "message_start" => {
                if let Some(message) = value.get("message") {
                    if let Some(id) = message.get("id").and_then(Value::as_str) {
                        self.id.get_or_insert_with(|| id.to_string());
                    }
                    if let Some(model) = message.get("model").and_then(Value::as_str) {
                        self.model.get_or_insert_with(|| model.to_string());
                    }
                    if let Some(tokens) = read_token(message, &["input_tokens"]) {
                        self.input_tokens = Some(tokens);
                    }
                    if let Some(tokens) = read_token(message, &["output_tokens"]) {
                        self.output_tokens = Some(tokens.max(self.output_tokens.unwrap_or(0)));
                    }
                }
            }
            "content_block_delta" => {
                // 只累积文本块：thinking / signature 增量不属于交付正文。
                if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
                    self.text.push_str(text);
                }
            }
            "message_delta" => {
                if let Some(reason) = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(tokens) = read_token(value, &["output_tokens"]) {
                    self.output_tokens = Some(tokens.max(self.output_tokens.unwrap_or(0)));
                }
            }
            _ => {}
        }
    }

    fn text(&self) -> &str {
        &self.text
    }
}

impl SseDialect for AnthropicMessagesDialect {
    fn finish(&self) -> Value {
        let mut payload = serde_json::Map::new();
        payload.insert("type".to_string(), json!("message"));
        payload.insert("role".to_string(), json!("assistant"));
        if let Some(id) = &self.id {
            payload.insert("id".to_string(), Value::String(id.clone()));
        }
        if let Some(model) = &self.model {
            payload.insert("model".to_string(), Value::String(model.clone()));
        }
        let mut blocks = Vec::new();
        if !self.text.is_empty() {
            blocks.push(json!({ "type": "text", "text": self.text }));
        }
        payload.insert("content".to_string(), Value::Array(blocks));
        payload.insert(
            "stop_reason".to_string(),
            self.stop_reason
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        if self.input_tokens.is_some() || self.output_tokens.is_some() {
            payload.insert(
                "usage".to_string(),
                json!({
                    "input_tokens": self.input_tokens,
                    "output_tokens": self.output_tokens,
                }),
            );
        }
        Value::Object(payload)
    }
}

/// Gemini `:streamGenerateContent?alt=sse`：每个分片就是一份
/// `GenerateContentResponse`，`candidates[0].content.parts[].text` 是正文增量，
/// `usageMetadata` 随分片逐步补齐。终态还原为 `candidates[0]` + `usageMetadata`，
/// 与非流式响应形状一致。
#[derive(Default)]
struct GeminiContentDialect {
    model_version: Option<String>,
    text: String,
    finish_reason: Option<String>,
    usage: Option<Value>,
    prompt_feedback: Option<Value>,
}

impl DialectSink for GeminiContentDialect {
    fn accept_event(&mut self, value: &Value) {
        if let Some(version) = value.get("modelVersion").and_then(Value::as_str) {
            self.model_version
                .get_or_insert_with(|| version.to_string());
        }
        if self.prompt_feedback.is_none()
            && let Some(feedback) = value.get("promptFeedback").filter(|item| !item.is_null())
        {
            self.prompt_feedback = Some(feedback.clone());
        }
        // 用量随分片单调递增，取最后一个分片即最终值。
        if let Some(usage) = value.get("usageMetadata").filter(|usage| !usage.is_null()) {
            self.usage = Some(usage.clone());
        }
        let Some(candidates) = value.get("candidates").and_then(Value::as_array) else {
            return;
        };
        for candidate in candidates {
            if let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    // 带 thought=true 的分片是思维链，不算交付正文。
                    if part.get("thought").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        self.text.push_str(text);
                    }
                }
            }
            if let Some(reason) = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
            {
                self.finish_reason = Some(reason.to_string());
            }
        }
    }

    fn text(&self) -> &str {
        &self.text
    }
}

impl SseDialect for GeminiContentDialect {
    fn finish(&self) -> Value {
        let mut candidate = serde_json::Map::new();
        candidate.insert(
            "content".to_string(),
            json!({ "role": "model", "parts": [{ "text": self.text }] }),
        );
        candidate.insert(
            "finishReason".to_string(),
            self.finish_reason
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        let mut payload = serde_json::Map::new();
        payload.insert(
            "candidates".to_string(),
            Value::Array(vec![Value::Object(candidate)]),
        );
        if let Some(usage) = &self.usage {
            payload.insert("usageMetadata".to_string(), usage.clone());
        }
        if let Some(version) = &self.model_version {
            payload.insert("modelVersion".to_string(), Value::String(version.clone()));
        }
        if let Some(feedback) = &self.prompt_feedback {
            payload.insert("promptFeedback".to_string(), feedback.clone());
        }
        Value::Object(payload)
    }
}

/// 按方言构造解析器。
fn sse_dialect(dialect: TextModelStream) -> Box<dyn SseDialect> {
    match dialect {
        TextModelStream::OpenAiChat => Box::<OpenAiChatDialect>::default(),
        TextModelStream::AnthropicMessages => Box::<AnthropicMessagesDialect>::default(),
        TextModelStream::GeminiContent => Box::<GeminiContentDialect>::default(),
    }
}

/// 从任意层级的 usage 对象里读一个 token 字段（Anthropic 与 Gemini 的字段名不同）。
fn read_token(container: &Value, keys: &[&str]) -> Option<u64> {
    let usage = container.get("usage").unwrap_or(container);
    keys.iter().find_map(|key| {
        usage.get(*key).and_then(|field| {
            field
                .as_u64()
                .or_else(|| field.as_i64().map(|value| value.max(0) as u64))
        })
    })
}

/// 冻结一次出站请求的归档记录（provider_calls 的 `request` 字段）。
///
/// `url` 是已解析、已脱敏的完整地址；`body` 与 `archive_body` 分开：前者用于实际
/// 请求，后者用于落盘，调用方可在其中移除大体积内联媒体或不应重复落盘的本地文档正文。
fn build_archive(
    context: &ResolvedProviderContext,
    url: &str,
    extra_headers: &[(&str, &str)],
    body: &Value,
    archive_body: Option<&Value>,
) -> Value {
    let mut headers = serde_json::Map::from_iter([
        (
            "authorization".to_string(),
            Value::String("已排除敏感凭据".to_string()),
        ),
        (
            "content-type".to_string(),
            Value::String("application/json".to_string()),
        ),
    ]);
    for (name, value) in extra_headers {
        headers.insert((*name).to_string(), Value::String((*value).to_string()));
    }
    json!({
        "providerConnectionId": context.provider_connection_id,
        "adapterId": context.adapter_id,
        "credentialReference": context.api_key_ref,
        "method": "POST",
        "url": url,
        "headers": headers,
        "bodyType": "json",
        "body": redact_request_value(archive_body.unwrap_or(body)),
    })
}

/// 文本调用在什么情况下应改走非流式端点重发一次。
///
/// 三种情况都表示「上游没有真正接受这个流式请求」：
/// - 5xx：上游侧故障（含反向代理以 524 代答）。
/// - 4xx：端点或参数不被接受。moyu 的 Gemini 文档只公开 `:generateContent`，
///   完全没有 `:streamGenerateContent` 与 `alt=sse`，被拒时只能退回非流式。
/// - 2xx 但一个 SSE 帧都没有：网关把整轮生成缓冲后一次性回完整 JSON。
///
/// 但只有退避确实会改变请求时才值得重发——否则就是原样重发一次。改变可能来自
/// 端点不同（Gemini 换成 `:generateContent`），也可能来自请求体不同（去掉
/// `stream` / `stream_options`）。
///
/// 判定用帧数而不是正文长度：上游确实流式回了一个空正文时不应被误判成退化响应。
fn should_retry_without_streaming(
    status: u16,
    payload: &Value,
    endpoint_changes: bool,
    retry_body: &Value,
    body: &Value,
) -> bool {
    let request_changes = endpoint_changes || retry_body != body;
    if (500..600).contains(&status) {
        return request_changes;
    }
    if (400..500).contains(&status) {
        return request_changes;
    }
    // 2xx 但没有帧：网关忽略了流式，改走非流式重发一次就能拿到完整响应。
    (200..300).contains(&status)
        && payload.pointer("/x_stream/frames").and_then(Value::as_u64) == Some(0)
}

/// 把「上游没按 SSE 回传、直接给了完整 JSON」的响应体解析成响应对象。
///
/// 两种退化形状都要吃下：
/// - 单对象：某个网关忽略 `stream` 直接回一份 `chat/completion` 或 `message`。
/// - 数组：Gemini 在 `alt=sse` 缺失或未生效时返回 `[{...}, {...}]` 形式的
///   `GenerateContentResponse` 列表，需要合并 `parts[].text` 与 `usageMetadata`。
fn parse_complete_json_payload(transcript: &str) -> Option<Value> {
    let trimmed = transcript.trim();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(trimmed).ok()?;
    match parsed {
        Value::Object(_) => Some(parsed),
        Value::Array(chunks) => {
            // Gemini 分片列表：正文按顺序拼接，用量取最后一个非空 usageMetadata，
            // 终态原因沿用最后一个非空 finishReason。
            let mut text = String::new();
            let mut usage = None;
            let mut finish_reason = None;
            let mut last: Option<Value> = None;
            for chunk in &chunks {
                if chunk
                    .get("usageMetadata")
                    .is_some_and(|value| !value.is_null())
                {
                    usage = chunk.get("usageMetadata").cloned();
                }
                if let Some(reason) = chunk
                    .pointer("/candidates/0/finishReason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                {
                    finish_reason = Some(Value::String(reason.to_string()));
                }
                if let Some(parts) = chunk
                    .pointer("/candidates/0/content/parts")
                    .and_then(Value::as_array)
                {
                    for part in parts {
                        if part.get("thought").and_then(Value::as_bool) == Some(true) {
                            continue;
                        }
                        if let Some(piece) = part.get("text").and_then(Value::as_str) {
                            text.push_str(piece);
                        }
                    }
                }
                last = Some(chunk.clone());
            }
            let mut payload = last.unwrap_or_else(|| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "candidates".to_string(),
                    json!([{
                        "content": { "role": "model", "parts": [{ "text": text }] },
                        "finishReason": finish_reason.unwrap_or(Value::Null),
                    }]),
                );
                if let Some(usage) = usage {
                    object.insert("usageMetadata".to_string(), usage);
                }
            }
            Some(payload)
        }
        _ => None,
    }
}

/// 返回（帧结束位置, 分隔符宽度）；没有完整帧时返回 None。
/// 在原始字节上查找，空行分隔符本身是 ASCII，不会出现在多字节字符内部。
fn find_sse_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let newline = buffer.windows(2).position(|pair| pair == b"\n\n");
    let carriage = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (newline, carriage) {
        (Some(newline), Some(carriage)) if carriage < newline => Some((carriage, 4)),
        (Some(newline), _) => Some((newline, 2)),
        (None, Some(carriage)) => Some((carriage, 4)),
        (None, None) => None,
    }
}

impl CapturedHttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn is_retryable(&self) -> bool {
        (500..600).contains(&self.status)
    }
}

impl ProviderRuntime {
    pub fn new(
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        credentials: CredentialStore,
    ) -> BackendResult<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("InfiniteCanvas/0.1")
            .build()?;
        Ok(Self {
            storage,
            lifecycle,
            credentials,
            client,
        })
    }

    /// 按模型定义 ID 回读其远程模型 ID（仅读本机定义表，不发网络请求）。
    /// 提示词优化的模型定义可能不是规范作用域格式，需要在定义表中兜底查找。
    pub fn model_definition_remote_id(&self, model_definition_id: &str) -> Option<String> {
        self.storage
            .list_model_definitions()
            .ok()?
            .into_iter()
            .find(|definition| definition.id == model_definition_id)
            .and_then(|definition| definition.remote_model_id)
    }

    pub fn resolve_current(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<ResolvedProviderContext> {
        let provider = self
            .storage
            .get_provider_connection(provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider_connection_id }),
            ));
        }
        self.resolve(
            provider.id,
            provider.adapter_id,
            provider.base_url,
            provider.api_key_ref,
        )
    }

    pub fn resolve_frozen(
        &self,
        task: &TaskExecutionRecord,
    ) -> BackendResult<ResolvedProviderContext> {
        self.resolve(
            task.provider_connection_id.clone(),
            task.adapter_id_snapshot.clone(),
            task.base_url_snapshot.clone(),
            task.api_key_ref_snapshot.clone(),
        )
    }

    /// 按模型的令牌分组解析凭据上下文：`token_group = None` 使用供应商主 API Key
    /// （等价 `resolve_current`），`Some(name)` 使用该分组自己的密钥。
    pub fn resolve_token_group(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<ResolvedProviderContext> {
        let provider = self
            .storage
            .get_provider_connection(provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider_connection_id }),
            ));
        }
        let api_key_ref = self
            .storage
            .resolve_binding_credential_ref(provider_connection_id, token_group)?;
        self.resolve(
            provider.id,
            provider.adapter_id,
            provider.base_url,
            api_key_ref,
        )
    }

    fn resolve(
        &self,
        provider_connection_id: String,
        adapter_id: String,
        base_url: String,
        api_key_ref: String,
    ) -> BackendResult<ResolvedProviderContext> {
        if adapter_id != MOYU_ADAPTER_ID && adapter_id != ARK_ADAPTER_ID {
            return Err(BackendError::validation(
                "unsupported provider adapter",
                json!({
                    "adapterId": adapter_id,
                    "supported": [MOYU_ADAPTER_ID, ARK_ADAPTER_ID],
                }),
            ));
        }
        validate_base_url(&base_url)?;
        // 火山引擎方舟推理 API 与素材资产 API 使用不同域名：
        // - 推理 API：https://ark.cn-beijing.volces.com/api/v3（OpenAI 兼容，Bearer 鉴权）
        // - 素材资产 API：https://ark.cn-beijing.volcengineapi.com（OpenAPI Action，AK/SK 签名）
        // 若用户把连接的 Base URL 误填为素材资产 API 域名，自动规范化为推理 API 端点，
        // 避免模型拉取/生成请求发到 OpenAPI 网关后返回 MissingParameter。
        let base_url = if adapter_id == ARK_ADAPTER_ID {
            let parsed = Url::parse(&base_url)?;
            if parsed
                .host_str()
                .map(|host| host.ends_with("volcengineapi.com"))
                .unwrap_or(false)
            {
                "https://ark.cn-beijing.volces.com/api/v3".to_string()
            } else {
                base_url
            }
        } else {
            base_url
        };
        // ark 连接的主 API Key 允许缺失：素材请求全部走 asset-library 作用域的
        // AK/SK 凭据（`resolve_asset_library` 会覆盖 api_key）；ark 连接不参与
        // Bearer 鉴权的生成路径，空主密钥不会泄漏到任何请求头。
        let api_key = if adapter_id == ARK_ADAPTER_ID {
            self.credentials.get(&api_key_ref).unwrap_or_default()
        } else {
            self.credentials.get(&api_key_ref)?
        };
        Ok(ResolvedProviderContext {
            provider_connection_id,
            adapter_id,
            base_url,
            api_key_ref,
            api_key,
        })
    }

    pub(super) fn resolve_asset_library(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<ResolvedProviderContext> {
        let mut context = self.resolve_current(provider_connection_id)?;
        if let Some(host) = host_without_asset_library(&context.base_url) {
            return Err(BackendError::Conflict(format!(
                "供应商连接 {}（{host}）没有云端素材库：该网关只有模型生成接口，\
                 /v1/assets/* 全部 404；素材请使用本地素材库或本地生成结果。",
                context.provider_connection_id
            )));
        }
        let scoped_credential_ref = asset_library_credential_ref(provider_connection_id);
        for credential_ref in [scoped_credential_ref.as_str(), ASSET_LIBRARY_CREDENTIAL_REF] {
            if self.credentials.status(credential_ref)?.configured {
                context.api_key_ref = credential_ref.to_string();
                context.api_key = self.credentials.get(credential_ref)?;
                break;
            }
        }
        Ok(context)
    }

    pub async fn submit(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<(GenerationSubmission, CapturedHttpResponse)> {
        let context = self.resolve_frozen(task)?;
        match task.operation {
            GenerationOperation::TextToImage => {
                let body = build_text_to_image_body(task, resolved)?;
                let path = request_path(&resolved.operation_schema, "/v1/images/generations")?;
                let response = self
                    .captured_json(
                        task,
                        attempt_id,
                        &context,
                        CapturedJsonRequest {
                            phase: "submit",
                            method: Method::POST,
                            path: &path,
                            body: &body,
                        },
                    )
                    .await?;
                let submission = parse_image_submission(&response, false)?;
                Ok((submission, response))
            }
            GenerationOperation::ImageToImage => {
                let path = request_path(&resolved.operation_schema, "/v1/images/edits")?;
                // Seedream 图生图走 JSON（`POST /v1/images/generations`，参考图以
                // 顶层 `image` 字段传 URL）；Gemini 图生图同样走 JSON，但 `image`
                // 传 data URI（`data:<mime>;base64,<DATA>`，见 https://doc.moyu.info/
                // 9280683m0.md）；其余模型沿用 multipart edits 契约。
                let encoding = resolved
                    .operation_schema
                    .pointer("/request/encoding")
                    .and_then(Value::as_str)
                    .unwrap_or("multipart");
                let response = if encoding == "json" {
                    let media_encoding = resolved
                        .operation_schema
                        .pointer("/request/mediaEncoding")
                        .and_then(Value::as_str)
                        .unwrap_or("seedream_image_urls");
                    let body = match media_encoding {
                        "gemini_image_data_uri" => {
                            build_gemini_image_to_image_body(task, resolved)?
                        }
                        _ => build_seedream_image_to_image_body(task, resolved)?,
                    };
                    self.captured_json(
                        task,
                        attempt_id,
                        &context,
                        CapturedJsonRequest {
                            phase: "submit",
                            method: Method::POST,
                            path: &path,
                            body: &body,
                        },
                    )
                    .await?
                } else {
                    self.captured_image_edit(task, attempt_id, &context, resolved, &path)
                        .await?
                };
                let submission = if encoding == "json" {
                    parse_image_submission(&response, false)?
                } else {
                    parse_image_submission(&response, true)?
                };
                Ok((submission, response))
            }
            GenerationOperation::VideoGeneration => {
                let body = build_video_body(task, resolved)?;
                let path = request_path(&resolved.operation_schema, "/v1/video/generations")?;
                let response = self
                    .captured_json(
                        task,
                        attempt_id,
                        &context,
                        CapturedJsonRequest {
                            phase: "submit",
                            method: Method::POST,
                            path: &path,
                            body: &body,
                        },
                    )
                    .await?;
                let task_id = parse_video_task_id(&response)?;
                Ok((GenerationSubmission::RemoteVideoTask { task_id }, response))
            }
            // 文本模型不通过生成任务管线提交：提示词优化等功能按各自流程直接调用
            // 文本接口适配层，不会构造 TextGeneration 的生成任务。此分支防御性拦截
            // 意外流入的任务，避免走到图片/视频的请求构造导致格式不匹配。
            GenerationOperation::TextGeneration => Err(BackendError::validation(
                "text generation is not a canvas generation task; it is invoked directly by text-model features",
                json!({ "operation": task.operation.as_str(), "taskId": task.id }),
            )),
        }
    }

    pub async fn observe(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<(GenerationObservation, CapturedHttpResponse)> {
        let _ = task.remote_task_id.as_deref().ok_or_else(|| {
            BackendError::validation(
                "video task has no remote task id",
                json!({ "taskId": task.id }),
            )
        })?;
        let context = self.resolve_frozen(task)?;
        let path = video_observe_path(&self.storage, task)?;
        let empty_body = Value::Null;
        let response = self
            .captured_json(
                task,
                attempt_id,
                &context,
                CapturedJsonRequest {
                    phase: "observe",
                    method: Method::GET,
                    path: &path,
                    body: &empty_body,
                },
            )
            .await?;
        let observation = parse_video_observation(&response)?;
        Ok((observation, response))
    }

    /// 通过 `GET {base_url}/v1/videos/{remote_task_id}/content` 获取海外平台视频
    /// 生成成功产物的原始字节流（`video/mp4`）。
    ///
    /// 文档契约：当成功观察响应中顶层 `data.result_url` 为空（旧任务）时，
    /// 应回退到本接口获取视频内容，这是最可靠的获取方式。
    pub async fn fetch_video_content(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<Vec<u8>> {
        let remote_task_id = task.remote_task_id.as_deref().ok_or_else(|| {
            BackendError::validation(
                "video task has no remote task id",
                json!({ "taskId": task.id }),
            )
        })?;
        let context = self.resolve_frozen(task)?;
        let path = format!("/v1/videos/{remote_task_id}/content");
        let url = endpoint(&context.base_url, &path)?;
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: "video-content".to_string(),
                request: json!({
                    "providerConnectionId": context.provider_connection_id,
                    "adapterId": context.adapter_id,
                    "credentialReference": context.api_key_ref,
                    "method": "GET",
                    "url": sanitize_url(&url),
                    "headers": { "authorization": "已排除敏感凭据" },
                    "bodyType": "none",
                    "body": Value::Null,
                }),
            },
        )?;
        let sent_at = now_ms();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallSent {
                call_id: call_id.clone(),
                sent_at,
            },
        )?;
        let response = match self
            .client
            .get(url)
            .bearer_auth(&context.api_key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let backend_error = BackendError::Transport(error);
                self.lifecycle.commit(
                    &task.id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.clone(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        if !(200..300).contains(&status) {
            let raw_response = String::from_utf8_lossy(&response.bytes().await?).into_owned();
            self.lifecycle.commit(
                &task.id,
                GenerationLifecycleFact::ProviderCallResponded {
                    call_id: call_id.clone(),
                    sent_at,
                    status,
                    headers: headers.clone(),
                    raw_response: raw_response.clone(),
                },
            )?;
            return Err(BackendError::protocol(
                format!("video content download returned HTTP {status}"),
                json!({ "httpStatus": status, "headers": headers, "rawResponse": raw_response }),
            ));
        }
        let bytes = response.bytes().await?.to_vec();
        info!(
            "[provider] 收到视频 content 直连响应: taskId={}, callId={}, HTTP {status}, 字节 {}",
            task.id,
            call_id,
            bytes.len()
        );
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallResponded {
                call_id: call_id.clone(),
                sent_at,
                status,
                headers,
                raw_response: format!("<binary video content: {} bytes>", bytes.len()),
            },
        )?;
        Ok(bytes)
    }

    async fn captured_json(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        request: CapturedJsonRequest<'_>,
    ) -> BackendResult<CapturedHttpResponse> {
        let CapturedJsonRequest {
            phase,
            method,
            path,
            body,
        } = request;
        let url = endpoint(&context.base_url, path)?;
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": method.as_str(),
            "url": sanitize_url(&url),
            "headers": {
                "authorization": "已排除敏感凭据",
                "content-type": "application/json"
            },
            "bodyType": "json",
            "body": redact_request_value(body),
        });
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: phase.to_string(),
                request: archive,
            },
        )?;

        let sanitized_url = sanitize_url(&url);
        let mut request = self
            .client
            .request(method.clone(), url)
            .bearer_auth(&context.api_key);
        if method != Method::GET && !body.is_null() {
            request = request.json(body);
        }
        info!(
            "[provider] 发起供应商请求: taskId={}, phase={phase}, callId={}, {} {}",
            task.id,
            call_id,
            method.as_str(),
            sanitized_url
        );
        let started_at = std::time::Instant::now();
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("{} / phase={} / taskId={}", method.as_str(), phase, task.id),
                request,
            )
            .await?;
        info!(
            "[provider] 收到供应商响应: taskId={}, phase={phase}, callId={}, HTTP {}, 耗时 {}ms, 响应体 {} 字符",
            task.id,
            call_id,
            response.status,
            started_at.elapsed().as_millis(),
            response.body.len()
        );
        Ok(response)
    }

    /// 文本模型专用的可追溯 JSON 调用。与媒体生成共用 provider_calls，
    /// 因而会冻结实际 URL、协议头、脱敏后的请求体、完整原始响应和网络层错误。
    /// `body` 仅用于实际 HTTP 请求；`archive_body` 用于持久化，调用方可在其中
    /// 移除大体积内联媒体或不应重复落盘的本地文档正文。
    ///
    /// `stream` 为 `Some(方言)` 时按 SSE 增量读取：非流式响应在生成完成前不回传任何
    /// 字节，长上下文与长输出的首字时长会撞上反向代理的零字节读取超时（例如
    /// Cloudflare 在 100 秒无数据时以 524 终止连接）；流式返回持续回传增量，
    /// 该判定条件不再成立。增量会按方言重新组装成与非流式等价的完整响应对象返回。
    ///
    /// `delta_sink` 非空时，正文增量边收边按时间节流转发出去，供上层实时展示。
    /// 两条退避路径都不转发增量：重试会让正文从头再来一遍，转发出去只会覆盖或
    /// 重复已展示的内容。
    ///
    /// 两条退避路径，各自只重发一次：
    /// 1. `fallback`：上游拒绝某个可选字段（OpenAI 档案的用量选项）时去掉它重发。
    /// 2. `fallback_path`：上游不真正支持流式（路径不存在、参数被拒、或把整轮生成
    ///    缓冲后一次性回完整 JSON）时改走非流式端点重发。Gemini 尤其需要：moyu 文档
    ///    只公开 `:generateContent`，没有 `:streamGenerateContent` 与 `alt=sse`。
    #[allow(clippy::too_many_arguments)]
    pub async fn captured_text_json(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        path: &str,
        query: &[(&str, String)],
        body: &Value,
        archive_body: &Value,
        extra_headers: &[(&str, &str)],
        stream: Option<TextModelStream>,
        fallback: Option<TextModelFallbackRequest>,
        fallback_path: Option<&str>,
        delta_sink: Option<&mut TextDeltaSink<'_>>,
    ) -> BackendResult<(CapturedHttpResponse, Value)> {
        let context = self.resolve_frozen(task)?;
        let mut url = endpoint(&context.base_url, path)?;
        // Gemini 的流式端点靠查询参数选择 SSE 返回；`endpoint()` 会清空 query，
        // 因此查询参数由调用方单独给出，在这里统一附加。
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(name, value)| (*name, value.as_str())));
        }
        // 非流式退避端点：不带任何查询参数（Gemini 的 alt=sse 只对流式端点有意义）。
        let sanitized_url = sanitize_url(&url);
        let retry_plan = match (stream, fallback_path) {
            (Some(_), Some(fallback_path)) => {
                let retry_url = endpoint(&context.base_url, fallback_path)?;
                let retry_archive = build_archive(
                    &context,
                    &sanitize_url(&retry_url),
                    extra_headers,
                    body,
                    fallback.as_ref().map(|fallback| &fallback.body),
                );
                Some((retry_url, retry_archive))
            }
            _ => None,
        };
        let archive = build_archive(&context, &sanitized_url, extra_headers, archive_body, None);
        let request = TextCallRequest {
            phase: "text_generation",
            dialect: stream,
            fallback_reason: None,
        };

        let (response, payload) = match self
            .send_text_call(
                task,
                attempt_id,
                &context,
                &url,
                &archive,
                body,
                extra_headers,
                &request,
                delta_sink,
            )
            .await
        {
            Ok(value) => value,
            Err(error) => return Err(error),
        };
        // 退避 1：上游拒绝某个可选字段。4xx 通常表示请求体不被接受，而唯一的可选
        // 字段就是 OpenAI 档案的用量选项；可见的 4xx 大概率仍会失败，故只重试一次。
        if let Some(fallback) = &fallback
            && (400..500).contains(&response.status)
        {
            let fallback_reason = fallback.reason;
            info!(
                "[provider] 文本模型请求被拒，按退避请求体重试一次: taskId={}, HTTP {}, 原因={fallback_reason}",
                task.id, response.status
            );
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let retry_archive = build_archive(
                &context,
                &sanitized_url,
                extra_headers,
                &fallback.body,
                None,
            );
            let retry_request = TextCallRequest {
                phase: "text_generation",
                dialect: stream,
                fallback_reason: Some(fallback_reason),
            };
            return self
                .send_text_call(
                    task,
                    attempt_id,
                    &context,
                    &url,
                    &retry_archive,
                    &fallback.body,
                    extra_headers,
                    &retry_request,
                    // 重试不转发增量：正文会从头再来一遍，转发只会重复已展示的内容。
                    None,
                )
                .await;
        }
        // 退避 2：上游没有真正接受流式请求 → 改走非流式端点，并按非流式解析。
        if let Some((retry_url, retry_archive)) = retry_plan {
            let retry_body = fallback
                .as_ref()
                .map(|fallback| &fallback.body)
                .unwrap_or(body);
            let endpoint_changes = sanitize_url(&retry_url) != sanitized_url;
            if !should_retry_without_streaming(
                response.status,
                &payload,
                endpoint_changes,
                retry_body,
                body,
            ) {
                return Ok((response, payload));
            }
            info!(
                "[provider] 上游未接受流式请求，改走非流式端点重试一次: taskId={}, HTTP {}, 目标={}",
                task.id,
                response.status,
                sanitize_url(&retry_url)
            );
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let retry_request = TextCallRequest {
                phase: "text_generation",
                dialect: None,
                fallback_reason: Some("provider does not honour streaming for this endpoint"),
            };
            return self
                .send_text_call(
                    task,
                    attempt_id,
                    &context,
                    &retry_url,
                    &retry_archive,
                    retry_body,
                    extra_headers,
                    &retry_request,
                    // 非流式退避没有增量可转发。
                    None,
                )
                .await;
        }
        Ok((response, payload))
    }

    /// 单次文本模型调用：冻结 provider_calls 记录、发送请求、读取响应。
    ///
    /// 非流式响应用 `send_captured` 一次读完（保持原有调试字段与行为）；流式响应
    /// 逐块读取 SSE 增量并重组为完整响应对象，返回的 `Value` 与非流式响应形状一致。
    #[allow(clippy::too_many_arguments)]
    async fn send_text_call(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        url: &Url,
        archive: &Value,
        body: &Value,
        extra_headers: &[(&str, &str)],
        call: &TextCallRequest<'_>,
        delta_sink: Option<&mut TextDeltaSink<'_>>,
    ) -> BackendResult<(CapturedHttpResponse, Value)> {
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: call.phase.to_string(),
                request: archive.clone(),
            },
        )?;

        let sanitized_url = sanitize_url(url);
        let mut request = self
            .client
            .post(url.clone())
            .bearer_auth(&context.api_key)
            .json(body);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        info!(
            "[provider] 发起文本模型请求: taskId={}, callId={}, POST {}, 流式方言={:?}",
            task.id, call_id, sanitized_url, call.dialect
        );
        let started_at = std::time::Instant::now();
        let sent_at = now_ms();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallSent {
                call_id: call_id.clone(),
                sent_at,
            },
        )?;

        let label = format!("POST / phase=text_generation / taskId={}", task.id);
        let (status, headers, body_text, payload) = match call.dialect {
            Some(dialect) => {
                match self
                    .read_streamed_text_response(
                        &task.id, &call_id, sent_at, &label, request, dialect, delta_sink,
                    )
                    .await
                {
                    Ok(value) => value,
                    Err(error) => return Err(error),
                }
            }
            None => {
                let response = match self
                    .send_captured(&task.id, &call_id, &label, request)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => return Err(error),
                };
                let payload = serde_json::from_str::<Value>(&response.body).unwrap_or(Value::Null);
                (response.status, response.headers, response.body, payload)
            }
        };
        info!(
            "[provider] 收到文本模型响应: taskId={}, callId={}, HTTP {}, 耗时 {}ms, 流式方言={:?}, 响应体 {} 字符{}",
            task.id,
            call_id,
            status,
            started_at.elapsed().as_millis(),
            call.dialect,
            body_text.len(),
            call.fallback_reason
                .map(|reason| format!(", 退避原因: {reason}"))
                .unwrap_or_default()
        );
        Ok((
            CapturedHttpResponse {
                call_id,
                status,
                headers,
                body: body_text,
            },
            payload,
        ))
    }

    /// 读取文本接口的 SSE 流，按方言把增量重新组装成与非流式等价的完整响应对象。
    ///
    /// 返回（状态码、响应头、原始 SSE 文本、重组后的响应对象）。非 2xx 与上游在
    /// 流内返回的错误对象都保留原始文本，让调用方的错误诊断与非流式保持一致。
    ///
    /// 三个接口的流式协议不同（OpenAI 的 `delta.content`、Anthropic 的
    /// `content_block_delta`、Gemini 的分数片 `candidates[].content.parts[]`），
    /// 但共用同一套帧切分与空闲超时，差异全部收敛在方言实现里。
    ///
    /// `delta_sink` 非空时，正文增量边收边转出去（按时间节流），供上层实时展示。
    #[allow(clippy::too_many_arguments)]
    async fn read_streamed_text_response(
        &self,
        task_id: &str,
        call_id: &str,
        sent_at: i64,
        label: &str,
        request: reqwest::RequestBuilder,
        dialect: TextModelStream,
        mut delta_sink: Option<&mut TextDeltaSink<'_>>,
    ) -> BackendResult<(u16, Value, String, Value)> {
        let response = match tokio::time::timeout(FIRST_BYTE_TIMEOUT, request.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let backend_error = BackendError::Transport(error);
                error!(
                    "[provider] 请求发送失败（网络层）: label={label}, 错误: {}",
                    backend_error.payload().message
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
            Err(_) => {
                let backend_error = BackendError::protocol(
                    format!(
                        "provider did not send response headers within {}s",
                        FIRST_BYTE_TIMEOUT.as_secs()
                    ),
                    json!({ "callId": call_id, "timeoutSeconds": FIRST_BYTE_TIMEOUT.as_secs() }),
                );
                error!("[provider] 等待响应头超时: label={label}");
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let mut stream = response.bytes_stream();
        let mut parser = SseFrameParser::default();
        let mut dialect = sse_dialect(dialect);
        let mut delta_sink = match delta_sink.take() {
            Some(sink) => StreamSink::new(Some(sink)),
            None => StreamSink::new(None),
        };
        let mut transcript = String::new();
        let mut chunks = 0usize;
        let mut bytes = 0usize;
        loop {
            // 首块与块间用同一空闲超时：只要上游持续回传就不判定失败，停发即中止。
            let next = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await;
            let item = match next {
                Ok(Some(item)) => item,
                Ok(None) => break,
                Err(_) => {
                    let backend_error = BackendError::protocol(
                        format!(
                            "provider stream stalled for {}s",
                            STREAM_IDLE_TIMEOUT.as_secs()
                        ),
                        json!({
                            "callId": call_id,
                            "timeoutSeconds": STREAM_IDLE_TIMEOUT.as_secs(),
                            "receivedChunks": chunks,
                            "receivedBytes": bytes,
                        }),
                    );
                    error!("[provider] 流式响应中断: label={label}, 已接收 {chunks} 块");
                    self.lifecycle.commit(
                        task_id,
                        GenerationLifecycleFact::ProviderCallFailed {
                            call_id: call_id.to_string(),
                            sent_at,
                            error: backend_error.runtime_record(),
                        },
                    )?;
                    return Err(backend_error);
                }
            };
            let chunk = match item {
                Ok(chunk) => chunk,
                Err(error) => {
                    let backend_error = BackendError::Transport(error);
                    error!(
                        "[provider] 读取流式响应失败（网络层）: label={label}, HTTP {status}, 错误: {}",
                        backend_error.payload().message
                    );
                    self.lifecycle.commit(
                        task_id,
                        GenerationLifecycleFact::ProviderCallFailed {
                            call_id: call_id.to_string(),
                            sent_at,
                            error: backend_error.runtime_record(),
                        },
                    )?;
                    return Err(backend_error);
                }
            };
            chunks += 1;
            bytes += chunk.len();
            transcript.push_str(&String::from_utf8_lossy(&chunk));
            // 解析器按原始字节累积，只在完整帧上解码，避免块边界撕裂多字节字符。
            parser.push(&chunk, dialect.as_mut(), &mut delta_sink);
        }
        let mut payload = parser.assemble(dialect.as_ref());
        // 网关可能忽略流式请求直接回一份完整 JSON（聚合平台的常见退化行为，Gemini 的
        // 非 SSE 返回还会是一个 JSON 数组）。这种情况下一个 SSE 帧都没有，但响应体
        // 本身就是完整响应，直接采用，避免把一次成功的调用判成「空响应」。
        // 判定条件用帧数而不是正文长度：上游确实流式回了一个空正文时不应被覆盖。
        if (200..300).contains(&status)
            && payload.pointer("/x_stream/frames").and_then(Value::as_u64) == Some(0)
            && let Some(complete) = parse_complete_json_payload(&transcript)
        {
            info!(
                "[provider] 上游未按 SSE 回传，改用完整 JSON 响应: taskId={task_id}, callId={call_id}"
            );
            payload = complete;
        }
        // 补发被节流窗口挡住的最后一段：上游可能正好在窗口内结束。
        if (200..300).contains(&status) {
            delta_sink.finish(dialect.text());
        }
        // 成功时存档重组后的完整响应（与非流式同形状、含 usage）；失败时存档原始
        // SSE 文本，错误诊断因此不会丢失上游实际回传的内容。
        let body_text = if (200..300).contains(&status) {
            serde_json::to_string(&payload).unwrap_or_default()
        } else {
            transcript
        };
        self.lifecycle.commit(
            task_id,
            GenerationLifecycleFact::ProviderCallResponded {
                call_id: call_id.to_string(),
                sent_at,
                status,
                headers: headers.clone(),
                raw_response: body_text.clone(),
            },
        )?;
        Ok((status, headers, body_text, payload))
    }

    async fn captured_image_edit(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
        path: &str,
    ) -> BackendResult<CapturedHttpResponse> {
        if resolved.images.is_empty() {
            return Err(BackendError::validation(
                "image-to-image requires at least one resolved image",
                json!({ "taskId": task.id }),
            ));
        }
        let remote_model_id = task
            .remote_model_id_snapshot
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::validation(
                    "image-to-image requires a remote model id",
                    json!({ "taskId": task.id, "modelDefinitionId": task.model_definition_id }),
                )
            })?;
        ensure_request_encoding(&resolved.operation_schema, "multipart")?;
        let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
        let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
        let image_field = request_field(&resolved.operation_schema, "imageField", "image[]")?;
        let mapped_parameters = mapped_parameters(resolved, "multipart")?;
        if mapped_parameters
            .iter()
            .any(|parameter| parameter.container != "multipart")
        {
            return Err(BackendError::validation(
                "multipart image parameters must use the multipart request container",
                json!({ "operationSchema": resolved.operation_schema }),
            ));
        }
        let mut archived_fields = vec![
            json!({ "name": model_field, "value": remote_model_id }),
            json!({ "name": prompt_field, "value": resolved.rendered_prompt }),
        ];
        archived_fields.extend(
            mapped_parameters
                .iter()
                .map(|parameter| json!({ "name": parameter.field, "value": parameter.value })),
        );
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": "POST",
            "url": sanitize_url(&url),
            "headers": {
                "authorization": "已排除敏感凭据",
                "content-type": "multipart/form-data; boundary=运行时生成，未持久化"
            },
            "bodyType": "multipart",
            "fields": archived_fields,
            "files": resolved.images.iter().map(|image| json!({
                "name": image_field,
                "mediaType": image.media_type,
                "typePosition": image.type_position,
                "fileName": image.file_name,
                "mimeType": image.mime_type,
                "byteSize": image.byte_size,
                "sha256": image.sha256,
                "stableIdentity": image.stable_identity,
            })).collect::<Vec<_>>()
        });
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: "submit".to_string(),
                request: archive,
            },
        )?;

        let mut form = multipart::Form::new()
            .text(model_field.clone(), remote_model_id.to_string())
            .text(prompt_field, resolved.rendered_prompt.clone());
        for parameter in mapped_parameters {
            form = form.text(parameter.field, multipart_value(&parameter.value));
        }
        for image in &resolved.images {
            let bytes = image.bytes.clone().ok_or_else(|| {
                BackendError::validation(
                    "resolved image has no bytes for multipart upload",
                    image.archive(),
                )
            })?;
            let part = multipart::Part::bytes(bytes)
                .file_name(image.file_name.clone())
                .mime_str(&image.mime_type)
                .map_err(BackendError::Transport)?;
            form = form.part(image_field.clone(), part);
        }
        let request = self
            .client
            .post(url)
            .bearer_auth(&context.api_key)
            .multipart(form);
        info!(
            "[provider] 发起供应商请求: taskId={}, phase=submit, callId={}, POST {} (multipart, 图片 {} 个)",
            task.id,
            call_id,
            sanitized_url,
            resolved.images.len()
        );
        let started_at = std::time::Instant::now();
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("POST / phase=submit / taskId={}", task.id),
                request,
            )
            .await?;
        info!(
            "[provider] 收到供应商响应: taskId={}, phase=submit, callId={}, HTTP {}, 耗时 {}ms, 响应体 {} 字符",
            task.id,
            call_id,
            response.status,
            started_at.elapsed().as_millis(),
            response.body.len()
        );
        Ok(response)
    }

    async fn send_captured(
        &self,
        task_id: &str,
        call_id: &str,
        label: &str,
        request: reqwest::RequestBuilder,
    ) -> BackendResult<CapturedHttpResponse> {
        let sent_at = now_ms();
        self.lifecycle.commit(
            task_id,
            GenerationLifecycleFact::ProviderCallSent {
                call_id: call_id.to_string(),
                sent_at,
            },
        )?;
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let backend_error = BackendError::Transport(error);
                error!(
                    "[provider] 请求发送失败（网络层）: label={label}, 错误: {}",
                    backend_error.payload().message
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                let backend_error = BackendError::Transport(error);
                error!(
                    "[provider] 读取响应体失败（网络层）: label={label}, HTTP {status}, 错误: {}",
                    backend_error.payload().message
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let body = String::from_utf8_lossy(&bytes).into_owned();
        self.lifecycle.commit(
            task_id,
            GenerationLifecycleFact::ProviderCallResponded {
                call_id: call_id.to_string(),
                sent_at,
                status,
                headers: headers.clone(),
                raw_response: body.clone(),
            },
        )?;
        Ok(CapturedHttpResponse {
            call_id: call_id.to_string(),
            status,
            headers,
            body,
        })
    }

    /// 可指定模型令牌分组：`token_group = Some(name)` 时使用该分组的密钥发起
    /// 请求（不同分组能访问的模型目录不同，拉取模型与连通性测试需要按分组令牌进行）。
    pub async fn raw_json_request_with_token_group(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_token_group(provider_connection_id, token_group)?;
        self.send_raw_json_request(&context, method, path, query, body, &[])
            .await
    }

    /// 素材库专用直连请求。基础地址取自当前素材库供应商连接，Bearer 凭据
    /// 优先使用该连接专用的素材库令牌，再兼容旧版全局令牌。
    pub(super) async fn raw_asset_json_request(
        &self,
        provider_connection_id: &str,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        self.send_raw_json_request(&context, method, path, query, body, &[])
            .await
    }

    /// 素材库专用 multipart 直传请求（海外平台素材上传：`POST /v1/assets/upload`）。
    ///
    /// 海外平台（如 konjac.ai）的素材导入不使用 JSON `url` 方式（旧端点 `/v1/assets/async`
    /// 返回 404 Invalid URL），而是直接 multipart 上传文件字节。本方法复用素材库直连
    /// 通道（供应商连接 + Bearer 素材库令牌），构造 `file` 文件 part 与文本字段 part。
    /// 文件 part 从磁盘路径流式读取（ReaderStream + 已知长度），文件不整段驻留内存。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn raw_asset_multipart_request(
        &self,
        provider_connection_id: &str,
        path: &str,
        fields: &[(String, String)],
        file_field: &str,
        file_name: &str,
        mime_type: &str,
        file_path: &std::path::Path,
        file_size: u64,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let mut form = multipart::Form::new();
        for (name, value) in fields {
            form = form.text(name.clone(), value.clone());
        }
        let file = tokio::fs::File::open(file_path).await?;
        let stream = tokio_util::io::ReaderStream::new(file);
        let part =
            multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), file_size)
                .file_name(file_name.to_string())
                .mime_str(mime_type)
                .map_err(BackendError::Transport)?;
        form = form.part(file_field.to_string(), part);
        let request = self
            .client
            .post(url)
            .bearer_auth(&context.api_key)
            .multipart(form);
        info!(
            "[provider] 发起直连请求: providerConnectionId={}, credentialReference={}, POST {} (multipart)",
            context.provider_connection_id, context.api_key_ref, sanitized_url
        );
        let started_at = std::time::Instant::now();
        let response = request.send().await?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (multipart), HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn send_raw_json_request(
        &self,
        context: &ResolvedProviderContext,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        extra_headers: &[(&str, &str)],
    ) -> BackendResult<RawProviderResponse> {
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let method_str = method.as_str().to_string();
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&context.api_key);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        info!(
            "[provider] 发起直连请求: providerConnectionId={}, credentialReference={}, {method_str} {sanitized_url}",
            context.provider_connection_id, context.api_key_ref
        );
        let started_at = std::time::Instant::now();
        let response = request.send().await?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, {method_str} {sanitized_url}, HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    /// 火山引擎方舟素材 OpenAPI 请求：`POST {base_url}/?Action={action}&Version=2024-01-01`，
    /// 请求体为 JSON，鉴权使用 AK/SK 派生的 V4 签名头（X-Date / X-Content-Sha256 / Authorization）。
    ///
    /// 签名与发送共用同一份 `payload` 字符串（serde_json 序列化一次），保证
    /// `HexEncode(SHA256(payload))` 与实际发送字节完全一致，否则上游报
    /// SignatureDoesNotMatch。
    pub(super) async fn raw_ark_action_request(
        &self,
        provider_connection_id: &str,
        action: &str,
        body: &Value,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        if context.adapter_id != ARK_ADAPTER_ID {
            return Err(BackendError::validation(
                "ark asset request requires a volcengine_ark_v1 provider connection",
                json!({
                    "providerConnectionId": provider_connection_id,
                    "adapterId": context.adapter_id,
                }),
            ));
        }
        let credentials = ArkCredentials::parse(&context.api_key)?;
        // 火山引擎方舟有两套独立 API：
        // - 推理 API（模型拉取/生成）：供应商连接的 base_url，如 https://ark.cn-beijing.volces.com/api/v3
        // - 素材资产 API（浏览/分组/上传/删除）：固定 OpenAPI 端点 https://ark.cn-beijing.volcengineapi.com
        // 两者域名、鉴权方式、协议格式均不同，素材请求必须走素材资产 API 端点。
        const ARK_ASSET_API_BASE_URL: &str = "https://ark.cn-beijing.volcengineapi.com";
        let mut url = endpoint(ARK_ASSET_API_BASE_URL, "/")?;
        let canonical_uri = url.path().to_string();
        let host = url
            .host_str()
            .ok_or_else(|| {
                BackendError::validation(
                    "ark asset API base URL must be an absolute HTTP(S) URL",
                    json!({ "baseUrl": ARK_ASSET_API_BASE_URL }),
                )
            })?
            .to_string();
        let (service, region) = volcengine_ark::service_region_from_host(&host);
        let query_pairs = [
            ("Action".to_string(), action.to_string()),
            (
                "Version".to_string(),
                volcengine_ark::ARK_API_VERSION.to_string(),
            ),
        ];
        for (key, value) in &query_pairs {
            url.query_pairs_mut().append_pair(key, value);
        }
        // reqwest 会按自己的规则序列化 query；签名侧使用火山引擎 UriEncode 规则。
        // Action/Version 均为字母数字，两种编码结果一致（无保留字符），签名不会错位。
        let payload = serde_json::to_string(body)?;
        let signature = volcengine_ark::sign_request(
            &credentials,
            &service,
            &region,
            "POST",
            &canonical_uri,
            &query_pairs,
            &host,
            "application/json",
            &payload,
            &Utc::now(),
        );
        let sanitized_url = sanitize_url(&url);
        let request = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .header("x-date", signature.x_date)
            .header("x-content-sha256", signature.x_content_sha256)
            .header("authorization", signature.authorization)
            .body(payload);
        info!(
            "[provider] 发起 Ark 直连请求: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (Action={action})",
            context.provider_connection_id, context.api_key_ref
        );
        let started_at = std::time::Instant::now();
        let response = request.send().await?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到 Ark 直连响应: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (Action={action}), HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    /// 连通性测试：向供应商 `/v1/models` 发起一次真实的鉴权请求。
    ///
    /// 失败（网络不可达、凭据错误、非 2xx）转换为 `ok=false` 的结果而不是错误，
    /// 保存动作本身已经成功，前端需要把两种结果分开提示。
    ///
    /// `token_group` 非空时用该分组的令牌测试（客户曾反馈 as 分组令牌拉取失败，
    /// 单独测试分组连通性可直接定位密钥/权限问题）。
    pub async fn test_connection(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<ConnectivityTestResult> {
        let started_at = std::time::Instant::now();
        let elapsed_ms = || started_at.elapsed().as_millis() as u64;
        // 火山引擎 Ark 连接没有 `/v1/models` Bearer 语义，改用素材 OpenAPI 的
        // ListAssetGroups（最小分页）做探测：能同时验证 AK/SK 签名与网关可达性。
        let ark_connection = token_group.is_none()
            && self
                .storage
                .get_provider_connection(provider_connection_id)
                .map(|provider| provider.adapter_id == ARK_ADAPTER_ID)
                .unwrap_or(false);
        let probe = if ark_connection {
            self.raw_ark_action_request(
                provider_connection_id,
                "ListAssetGroups",
                &json!({
                    "Filter": { "GroupType": "AIGC" },
                    "PageNumber": 1,
                    "PageSize": 1,
                }),
            )
            .await
        } else {
            self.raw_json_request_with_token_group(
                provider_connection_id,
                token_group,
                Method::GET,
                "/v1/models",
                &[],
                None,
            )
            .await
        };
        match probe {
            Ok(response) => {
                let ok = (200..300).contains(&response.status);
                Ok(ConnectivityTestResult {
                    ok,
                    http_status: Some(response.status),
                    elapsed_ms: elapsed_ms(),
                    reason: (!ok).then(|| "http-error".to_string()),
                    detail: (!ok).then(|| truncate_connectivity_detail(&response.body)),
                })
            }
            Err(error) => Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: elapsed_ms(),
                reason: Some(connectivity_error_reason(&error).to_string()),
                detail: Some(truncate_connectivity_detail(&error.to_string())),
            }),
        }
    }

    pub async fn list_models(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<Vec<RemoteModelOption>> {
        // 火山引擎方舟推理 API 的 Base URL 已含 /api/v3 前缀，模型列表端点为 /models；
        // 其他 OpenAI 兼容供应商沿用 /v1/models。
        let models_path = self
            .storage
            .get_provider_connection(provider_connection_id)
            .map(|provider| {
                if provider.adapter_id == ARK_ADAPTER_ID {
                    "/models"
                } else {
                    "/v1/models"
                }
            })
            .unwrap_or("/v1/models");
        let response = self
            .raw_json_request_with_token_group(
                provider_connection_id,
                token_group,
                Method::GET,
                models_path,
                &[],
                None,
            )
            .await?;
        let mut models = parse_model_catalog(&response)?;
        let definitions = self.storage.list_model_definitions()?;
        let bindings = self.storage.list_bindings(Some(provider_connection_id))?;

        for model in &mut models {
            let scoped_definition_id =
                provider_scoped_model_definition_id(provider_connection_id, &model.id);
            let binding = bindings
                .iter()
                .find(|binding| binding.model_definition_id == scoped_definition_id)
                .or_else(|| {
                    bindings.iter().find(|binding| {
                        binding.enabled
                            && binding.remote_model_id.as_deref() == Some(model.id.as_str())
                    })
                })
                .or_else(|| {
                    bindings.iter().find(|binding| {
                        binding.remote_model_id.as_deref() == Some(model.id.as_str())
                    })
                });
            let definition = binding
                .and_then(|binding| {
                    definitions
                        .iter()
                        .find(|definition| definition.id == binding.model_definition_id)
                })
                .or_else(|| {
                    definitions.iter().find(|definition| {
                        !definition.id.starts_with("remote::")
                            && (definition.remote_model_id.as_deref() == Some(model.id.as_str())
                                || definition.id == model.id)
                    })
                });
            model.model_definition_id = scoped_definition_id;
            if let Some(definition) = definition {
                model.operation_schema = definition.operations.clone();
                model.suggested_operations = operations_from_schema(&definition.operations);
            }
            model.has_configured_binding = binding.is_some();
            model.configured_operations = binding
                .filter(|binding| binding.enabled)
                .map(|binding| binding.enabled_operations.clone())
                .unwrap_or_default();
            // 令牌分组：优先取已保存绑定上的分组（回显用户配置），
            // 否则标记本次拉取所用的分组，方便前端预选同一个分组令牌。
            model.token_group = binding
                .and_then(|binding| binding.token_group.clone())
                .or_else(|| token_group.map(ToOwned::to_owned));
        }

        Ok(models)
    }

    pub(super) async fn captured_asset_get(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        provider_connection_id: &str,
        asset_id: &str,
    ) -> BackendResult<(CapturedHttpResponse, Value)> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        let body = json!({ "id": asset_id });
        let response = self
            .captured_json(
                task,
                attempt_id,
                &context,
                CapturedJsonRequest {
                    phase: "resolve_asset",
                    method: Method::POST,
                    path: "/v1/assets/get",
                    body: &body,
                },
            )
            .await?;
        require_success(&response)?;
        let value = serde_json::from_str(&response.body)?;
        Ok((response, value))
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

#[derive(Debug, Clone)]
struct MappedParameter {
    container: String,
    field: String,
    value: Value,
}

fn request_path(operation_schema: &Value, fallback: &str) -> BackendResult<String> {
    let path = operation_schema
        .pointer("/request/path")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('?')
        || path.contains('#')
        || path.len() > 512
    {
        return Err(BackendError::validation(
            "model request path must be a relative absolute-path without query or fragment",
            json!({ "path": path }),
        ));
    }
    Ok(path.to_string())
}

fn ensure_request_encoding(operation_schema: &Value, expected: &str) -> BackendResult<()> {
    let encoding = operation_schema
        .pointer("/request/encoding")
        .and_then(Value::as_str)
        .unwrap_or(expected);
    if encoding != expected {
        return Err(BackendError::validation(
            "model request encoding is not supported by this operation profile",
            json!({ "encoding": encoding, "expected": expected }),
        ));
    }
    Ok(())
}

fn request_field(operation_schema: &Value, setting: &str, fallback: &str) -> BackendResult<String> {
    let pointer = format!("/request/{setting}");
    let field = operation_schema
        .pointer(&pointer)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !valid_request_field_name(field) {
        return Err(BackendError::validation(
            "model request field name is invalid",
            json!({ "setting": setting, "field": field }),
        ));
    }
    Ok(field.to_string())
}

fn valid_request_field_name(field: &str) -> bool {
    !field.is_empty()
        && field.len() <= 128
        && field.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '[' | ']')
        })
}

fn mapped_parameters(
    resolved: &ResolvedGeneration,
    fallback_container: &str,
) -> BackendResult<Vec<MappedParameter>> {
    let values = resolved.parameters.as_object().ok_or_else(|| {
        BackendError::validation(
            "normalized generation parameters must be a JSON object",
            json!({ "parameters": resolved.parameters }),
        )
    })?;
    let definitions = resolved
        .operation_schema
        .get("parameters")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let operation_container = resolved
        .operation_schema
        .pointer("/request/parameterContainer")
        .and_then(Value::as_str)
        .unwrap_or(fallback_container);
    let has_media =
        !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty();

    let mut mapped = Vec::new();
    for (key, value) in values {
        let definition = definitions
            .get(key)
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BackendError::validation(
                    "normalized parameter is absent from the frozen model schema",
                    json!({ "parameter": key }),
                )
            })?;
        if has_media
            && value.as_bool() == Some(true)
            && definition
                .get("requiresNoMedia")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(BackendError::validation(
                "model parameter requires a generation request without media inputs",
                json!({ "parameter": key }),
            ));
        }
        let field = definition
            .get("requestField")
            .and_then(Value::as_str)
            .unwrap_or(key)
            .trim();
        if !valid_request_field_name(field) {
            return Err(BackendError::validation(
                "model parameter request field name is invalid",
                json!({ "parameter": key, "requestField": field }),
            ));
        }
        let container = definition
            .get("requestLocation")
            .and_then(Value::as_str)
            .unwrap_or(operation_container)
            .to_string();
        let value = match definition.get("transform").and_then(Value::as_str) {
            Some("web_search_tool") if value.as_bool() == Some(true) => {
                json!([{ "type": "web_search" }])
            }
            Some("web_search_tool") => continue,
            // Seedream 组图数量：仅在组图模式为 auto 时发送
            // `sequential_image_generation_options: { "max_images": N }`。
            Some("max_images_object") => {
                if values
                    .get("sequential_image_generation")
                    .and_then(Value::as_str)
                    != Some("auto")
                {
                    continue;
                }
                json!({ "max_images": value })
            }
            // Seedream 提示词优化：转换为 `optimize_prompt_options: { "mode": … }`。
            Some("optimize_prompt_mode_object") => json!({ "mode": value }),
            Some(transform) => {
                return Err(BackendError::validation(
                    "model parameter uses an unsupported request transform",
                    json!({ "parameter": key, "transform": transform }),
                ));
            }
            None => value.clone(),
        };
        mapped.push(MappedParameter {
            container,
            field: field.to_string(),
            value,
        });
    }
    Ok(mapped)
}

fn insert_mapped_parameters(
    body: &mut Map<String, Value>,
    metadata_field: &str,
    parameters: Vec<MappedParameter>,
) -> BackendResult<()> {
    for parameter in parameters {
        let target = match parameter.container.as_str() {
            "root" => &mut *body,
            "metadata" => {
                let metadata = body
                    .entry(metadata_field.to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                metadata.as_object_mut().ok_or_else(|| {
                    BackendError::validation(
                        "request metadata field collides with a non-object value",
                        json!({ "metadataField": metadata_field }),
                    )
                })?
            }
            other => {
                return Err(BackendError::validation(
                    "model parameter request container is unsupported",
                    json!({ "container": other, "parameter": parameter.field }),
                ));
            }
        };
        if target.contains_key(&parameter.field) {
            return Err(BackendError::validation(
                "model parameter request field collides with another request field",
                json!({ "field": parameter.field, "container": parameter.container }),
            ));
        }
        target.insert(parameter.field, parameter.value);
    }
    Ok(())
}

fn multipart_value(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn build_text_to_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "text-to-image cannot encode media references",
            resolved.archive(),
        ));
    }
    if resolved.rendered_prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "text-to-image prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;
    let mut body = Map::new();
    if let Some(model) = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
    {
        body.insert(model_field, Value::String(model.to_string()));
    }
    body.insert(
        prompt_field,
        Value::String(resolved.rendered_prompt.clone()),
    );
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

/// Seedream 图生图 JSON 请求体（moyu 聚合平台）：`POST /v1/images/generations`，
/// `model`/`prompt` 与参数放顶层，参考图通过顶层 `image` 字段传 URL
/// （文档示例 `"image":"https://…"`：单张为字符串，多张为保持输入顺序的 URL 数组），
/// 不走 multipart edits 接口。
fn build_seedream_image_to_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "seedream image-to-image requires at least one image reference",
            json!({ "taskId": task.id }),
        ));
    }
    // 文档规定 `image` 数组最多传入 6 张参考图（https://doc.moyu.info/9280685m0.md）。
    if resolved.images.len() > 6 {
        return Err(BackendError::validation(
            "seedream image-to-image accepts at most 6 image references",
            json!({ "images": resolved.images.len() }),
        ));
    }
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "seedream image-to-image only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    if resolved.rendered_prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "image-to-image prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let image_field = request_field(&resolved.operation_schema, "mediaField", "image")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let references = resolved
        .images
        .iter()
        .map(|image| {
            image.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "seedream image input has no remote-readable reference",
                    image.archive(),
                )
            })
        })
        .collect::<BackendResult<Vec<_>>>()?;
    // 文档示例使用单字符串；多张参考图时保持输入顺序为 URL 数组。
    let image_value = match references.as_slice() {
        [single] => Value::String((*single).clone()),
        _ => Value::Array(
            references
                .into_iter()
                .map(|reference| Value::String(reference.clone()))
                .collect(),
        ),
    };

    let mut body = Map::new();
    if let Some(model) = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
    {
        body.insert(model_field, Value::String(model.to_string()));
    }
    body.insert(
        prompt_field,
        Value::String(resolved.rendered_prompt.clone()),
    );
    body.insert(image_field, image_value);
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

/// Gemini 图生图 JSON 请求体（moyu 聚合平台，https://doc.moyu.info/9280683m0.md）：
/// `POST /v1/images/generations`，`model`/`prompt`/`size` 放顶层，参考图通过顶层
/// `image` 字段传 data URI（`data:<mime>;base64,<DATA>`，带前缀），不走 multipart
/// edits 接口。文档示例单张为字符串；多张时保持输入顺序为数组。响应
/// `data[].b64_json`（`url`/`revised_prompt` 未使用时会以空字符串返回，属正常）。
fn build_gemini_image_to_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "gemini image-to-image requires at least one image reference",
            json!({ "taskId": task.id }),
        ));
    }
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "gemini image-to-image only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    if resolved.rendered_prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "image-to-image prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let image_field = request_field(&resolved.operation_schema, "mediaField", "image")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let data_uris = resolved
        .images
        .iter()
        .map(|image| {
            let bytes = image.bytes.clone().ok_or_else(|| {
                BackendError::validation(
                    "gemini image input has no bytes for base64 data uri encoding",
                    image.archive(),
                )
            })?;
            Ok(format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    // 文档示例使用单字符串；多张参考图时保持输入顺序为数组。
    let image_value = match data_uris.as_slice() {
        [single] => Value::String(single.clone()),
        _ => Value::Array(data_uris.into_iter().map(Value::String).collect::<Vec<_>>()),
    };

    let mut body = Map::new();
    if let Some(model) = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
    {
        body.insert(model_field, Value::String(model.to_string()));
    }
    body.insert(
        prompt_field,
        Value::String(resolved.rendered_prompt.clone()),
    );
    body.insert(image_field, image_value);
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

/// 计算视频任务的状态轮询路径。
///
/// 默认使用 `GET /v1/video/generations/{task_id}`；模型定义可在操作 schema 的
/// `request.observePath` 声明替代路径（支持 `{task_id}` 占位符），例如 Vidu 系列
/// 使用 `GET /v1/videos/{task_id}`。路径会经过与提交路径相同的合法性校验。
fn video_observe_path(storage: &Storage, task: &TaskExecutionRecord) -> BackendResult<String> {
    let remote_task_id = task.remote_task_id.as_deref().unwrap_or_default();
    let operation_schema = storage
        .list_model_definitions()?
        .into_iter()
        .find(|definition| definition.id == task.model_definition_id)
        .map(|definition| definition.operations);
    video_observe_path_from_schema(operation_schema.as_ref(), remote_task_id)
}

/// 解析模型声明的视频轮询路径模板（默认 `/v1/video/generations/{task_id}`），
/// 替换 `{task_id}` 占位符并做合法性校验。
fn video_observe_path_from_schema(
    operation_schema: Option<&Value>,
    remote_task_id: &str,
) -> BackendResult<String> {
    let observe_path = operation_schema
        .and_then(|schema| schema.pointer("/request/observePath"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let path = match observe_path {
        Some(template) => template.replace("{task_id}", remote_task_id),
        None => format!("/v1/video/generations/{remote_task_id}"),
    };
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('?')
        || path.contains('#')
        || path.len() > 512
    {
        return Err(BackendError::validation(
            "model observe path must be a relative absolute-path without query or fragment",
            json!({ "path": path }),
        ));
    }
    Ok(path)
}

fn build_video_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation(
                "video generation requires a remote model id",
                json!({ "taskId": task.id, "modelDefinitionId": task.model_definition_id }),
            )
        })?;
    let has_media =
        !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty();
    let accepts_media_only_prompt = has_media
        && resolved
            .operation_schema
            .pointer("/request/promptMode")
            .and_then(Value::as_str)
            == Some("prompt_or_media");
    if resolved.rendered_prompt.trim().is_empty() && !accepts_media_only_prompt {
        return Err(BackendError::validation(
            "video prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    validate_seedance_25_video_task(model, resolved)?;
    match resolved
        .operation_schema
        .pointer("/request/mediaEncoding")
        .and_then(Value::as_str)
    {
        Some("wan_media_array") => return build_wan_video_body(model, resolved),
        Some("veo_image_urls") => return build_veo_video_body(model, resolved),
        Some("vidu_image_urls") => return build_vidu_video_body(model, resolved),
        Some("minimax_h3_media") => return build_minimax_h3_video_body(model, resolved),
        Some(unsupported) => {
            return Err(BackendError::validation(
                "video request uses an unsupported media encoding",
                json!({ "mediaEncoding": unsupported }),
            ));
        }
        None => {}
    }
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let content_field = request_field(&resolved.operation_schema, "contentField", "content")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;
    let content_container =
        request_field(&resolved.operation_schema, "contentContainer", "metadata")?;

    let mut content = Vec::new();
    // 收集所有进入 content 的媒体项（提示词引用 + 未提及的显式媒体），
    // 并按前端传入的 content_index（输入/连线顺序）升序排列。
    // 这样 content 数组顺序与提示词中的「图片N」标签严格一致：
    // 前端 UI 显示的图片1/图片2 与请求体 content[0]/content[1] 一一对应，
    // 不再受提示词书写顺序影响，避免「删除/重加素材导致引用错位」。
    let mut content_media = Vec::new();
    for item in &resolved.content {
        match item {
            // 文本片段统一并入下方渲染后的提示词；content 中不保留原始 text 条目，
            // 而是在组装 body 时把渲染后的完整提示词作为首个 text 条目写回 content。
            CompiledContentItem::Text(_) => {}
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => {
                let media = resolved.media(*media_type, *type_position).ok_or_else(|| {
                    BackendError::protocol(
                        "compiled media position is missing",
                        json!({ "mediaType": media_type, "typePosition": type_position }),
                    )
                })?;
                content_media.push(media);
            }
        }
    }
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
        .filter(|media| media.prompt_segment_index.is_none())
    {
        content_media.push(media);
    }
    // 去重：同一 target（type_position）可能被多次引用，content 里只保留一次。
    content_media.sort_by(|a, b| {
        media_kind_rank(a.media_type)
            .cmp(&media_kind_rank(b.media_type))
            .then(a.type_position.cmp(&b.type_position))
            .then(
                a.content_index
                    .unwrap_or(u32::MAX)
                    .cmp(&b.content_index.unwrap_or(u32::MAX)),
            )
    });
    content_media
        .dedup_by(|a, b| a.media_type == b.media_type && a.type_position == b.type_position);
    // 按前端输入顺序（content_index）排列；缺失时保持在已解析顺序中的相对位置。
    content_media.sort_by(|a, b| match (a.content_index, b.content_index) {
        (Some(ai), Some(bi)) => ai.cmp(&bi),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    for media in content_media {
        let reference = media.remote_reference.as_ref().ok_or_else(|| {
            BackendError::validation(
                "video media input has no remote-readable reference",
                media.archive(),
            )
        })?;
        content.push(video_media_content(media, reference));
    }

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    // Seedance 文档：顶层 prompt 仅要求非空（平台校验用），真正发送给上游模型的
    // 提示词来自 metadata.content 中的 text 条目；只有未传 content 时才回退到顶层
    // prompt。因此带媒体（参考图/视频/音频、编辑、延长等）的请求必须在 content
    // 中显式携带文本，否则平台会以「prompt is required」拒绝任务创建。
    // 这里把渲染后的提示词作为 content 首个 text 条目写入（媒体项随后），并保持
    // 顶层 prompt 非空以满足平台校验；纯文生视频（无媒体）维持 content 为空，
    // 由平台按既有行为回退到顶层 prompt。
    let prompt = seedance_task_prompt(model, resolved, video_prompt(resolved));
    if !prompt.trim().is_empty() {
        body.insert(prompt_field, Value::String(prompt.clone()));
        if has_media {
            content.insert(0, json!({ "type": "text", "text": prompt }));
        }
    }
    match content_container.as_str() {
        "root" => {
            body.insert(content_field, Value::Array(content));
        }
        "metadata" => {
            let mut metadata = Map::new();
            metadata.insert(content_field, Value::Array(content));
            body.insert(metadata_field.clone(), Value::Object(metadata));
        }
        other => {
            return Err(BackendError::validation(
                "video content container is unsupported",
                json!({ "contentContainer": other }),
            ));
        }
    }
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "metadata")?,
    )?;
    Ok(Value::Object(body))
}

pub(crate) fn seedance_video_task_type(
    local_type: Option<VideoTaskType>,
    parameters: &Value,
) -> VideoTaskType {
    local_type.unwrap_or_else(|| match parameters["omni_reference_task_type"].as_str() {
        Some("reference") => VideoTaskType::Reference,
        Some("edit") => VideoTaskType::Edit,
        Some("extend") => VideoTaskType::Extend,
        _ => VideoTaskType::Auto,
    })
}

fn seedance_task_prompt(model: &str, resolved: &ResolvedGeneration, prompt: String) -> String {
    if !is_seedance_25_video_model(model) {
        return prompt;
    }
    match seedance_video_task_type(resolved.video_task_type, &resolved.parameters) {
        VideoTaskType::Edit
            if ![
                "编辑视频",
                "增加",
                "加上",
                "删除",
                "去掉",
                "修改",
                "替换",
                "改成",
            ]
            .iter()
            .any(|keyword| prompt.contains(keyword)) =>
        {
            format!("编辑视频：\n{prompt}")
        }
        VideoTaskType::Extend
            if !["向前延长", "向后延长", "延续", "续写"]
                .iter()
                .any(|keyword| prompt.contains(keyword)) =>
        {
            format!("续写视频：\n{prompt}")
        }
        _ => prompt,
    }
}

/// 官方 2.5 特殊任务约束在付费提交前再次校验。海外模型的本地意图只参与
/// 校验，远端字段依旧由冻结 schema 白名单决定。
fn validate_seedance_25_video_task(
    model: &str,
    resolved: &ResolvedGeneration,
) -> BackendResult<()> {
    if !is_seedance_25_video_model(model) {
        if resolved.video_task_type.is_some() {
            return Err(BackendError::validation(
                "所选模型不支持 Seedance 2.5 任务类型，请重新选择模型或任务类型",
                json!({ "model": model }),
            ));
        }
        return Ok(());
    }
    let task_type = seedance_video_task_type(resolved.video_task_type, &resolved.parameters);
    if let Some(local_type) = resolved.video_task_type
        && let Some(remote_type) = resolved.parameters["omni_reference_task_type"].as_str()
        && remote_type != local_type.omni_reference_task_type()
    {
        return Err(BackendError::validation(
            "视频任务类型与模型参数不一致，请重新选择任务类型",
            json!({ "videoTaskType": local_type, "omniReferenceTaskType": remote_type }),
        ));
    }
    let mut first_frames = 0;
    let mut last_frames = 0;
    let mut references = 0;
    let mut reference_videos = 0;
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        match (media.media_type, media.role.as_str()) {
            (MediaType::Image, "first_frame") => first_frames += 1,
            (MediaType::Image, "last_frame") => last_frames += 1,
            (MediaType::Image, "reference_image") | (MediaType::Audio, "reference_audio") => {
                references += 1
            }
            (MediaType::Video, "reference_video") => {
                references += 1;
                reference_videos += 1;
            }
            _ => {
                return Err(BackendError::validation(
                    "Seedance 2.5 素材类型与用途不匹配",
                    media.archive(),
                ));
            }
        }
    }
    let has_frames = first_frames > 0 || last_frames > 0;
    let selected_frames = matches!(
        task_type,
        VideoTaskType::FirstFrame | VideoTaskType::FirstLastFrame
    );
    if first_frames > 1 || last_frames > 1 || (has_frames && first_frames != 1) {
        return Err(BackendError::validation(
            "首帧/首尾帧任务必须有且仅有一张首帧，尾帧最多一张",
            json!({ "firstFrames": first_frames, "lastFrames": last_frames }),
        ));
    }
    if (has_frames && references > 0)
        || (has_frames
            && matches!(
                task_type,
                VideoTaskType::Reference | VideoTaskType::Edit | VideoTaskType::Extend
            ))
    {
        return Err(BackendError::validation(
            "首帧/首尾帧与全参考、视频编辑、视频延长不能混用，请调整素材用途或任务类型",
            json!({ "videoTaskType": task_type, "firstFrames": first_frames, "lastFrames": last_frames, "references": references }),
        ));
    }
    if (selected_frames && first_frames != 1)
        || (task_type == VideoTaskType::FirstLastFrame && last_frames != 1)
        || (task_type == VideoTaskType::FirstFrame && last_frames != 0)
    {
        return Err(BackendError::validation(
            "首帧任务需要一张首帧；首尾帧任务需要各一张首帧和尾帧",
            json!({ "videoTaskType": task_type, "firstFrames": first_frames, "lastFrames": last_frames }),
        ));
    }
    if matches!(task_type, VideoTaskType::Edit | VideoTaskType::Extend) && reference_videos == 0 {
        return Err(BackendError::validation(
            "视频编辑和视频延长至少需要一个参考视频",
            json!({ "videoTaskType": task_type }),
        ));
    }
    if task_type == VideoTaskType::Reference && references == 0 {
        return Err(BackendError::validation(
            "全参考任务至少需要一个参考素材",
            json!({ "videoTaskType": task_type }),
        ));
    }
    if (has_frames
        || selected_frames
        || matches!(task_type, VideoTaskType::Edit | VideoTaskType::Extend))
        && resolved.parameters["ratio"].as_str() != Some("adaptive")
    {
        return Err(BackendError::validation(
            "Seedance 2.5 首帧/首尾帧、视频编辑和视频延长的画幅必须为自适应（adaptive）",
            json!({ "ratio": resolved.parameters["ratio"] }),
        ));
    }
    if has_frames
        || selected_frames
        || matches!(task_type, VideoTaskType::Edit | VideoTaskType::Extend)
    {
        let duration = resolved.parameters["duration"].as_i64();
        if !duration.is_some_and(|value| value == -1 || (4..=30).contains(&value)) {
            return Err(BackendError::validation(
                "Seedance 2.5 输出时长必须为智能（-1）或 4–30 秒",
                json!({ "duration": resolved.parameters["duration"] }),
            ));
        }
    }
    if task_type == VideoTaskType::Edit && resolved.parameters["duration"].as_i64() != Some(-1) {
        return Err(BackendError::validation(
            "视频编辑的输出时长必须为智能（-1），自动跟随待编辑视频",
            json!({ "duration": resolved.parameters["duration"] }),
        ));
    }
    if matches!(task_type, VideoTaskType::Edit | VideoTaskType::Extend) {
        if reference_videos > 10 {
            return Err(BackendError::validation(
                "视频编辑和视频延长最多支持 10 个参考视频",
                json!({ "referenceVideos": reference_videos }),
            ));
        }
        let minimum_seconds = if task_type == VideoTaskType::Edit {
            4.0
        } else {
            2.0
        };
        for video in &resolved.videos {
            if !video.duration_seconds.is_some_and(|duration| {
                duration.is_finite() && (minimum_seconds..=30.0).contains(&duration)
            }) {
                return Err(BackendError::validation(
                    format!(
                        "当前视频任务要求每个参考视频的实际时长为 {minimum_seconds}–30 秒：{}",
                        video.display_name
                    ),
                    video.archive(),
                ));
            }
        }
        let total_seconds: f64 = resolved
            .videos
            .iter()
            .filter_map(|video| video.duration_seconds)
            .sum();
        if total_seconds > 30.0 {
            return Err(BackendError::validation(
                "视频编辑和视频延长的参考视频实际总时长不能超过 30 秒",
                json!({ "totalDurationSeconds": total_seconds }),
            ));
        }
    }
    Ok(())
}

/// 通用视频 body 的 prompt 渲染：由结构化 `content` 重建，媒体引用渲染为
/// `图片N` / `视频N` / `音频N` 简洁标签，而不是 `[图片N：文件名]` 占位形式。
/// 结果既作为顶层 `prompt`（平台仅要求非空），也作为 `metadata.content` 的
/// text 条目发送给模型（Seedance 文档：实际提示词来自 content 文本）。
fn video_prompt(resolved: &ResolvedGeneration) -> String {
    let mut prompt = String::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) => prompt.push_str(text),
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => {
                let label = match media_type {
                    MediaType::Image => "图片",
                    MediaType::Video => "视频",
                    MediaType::Audio => "音频",
                    MediaType::Text => "文本",
                };
                prompt.push_str(&format!("{label}{type_position}"));
            }
        }
    }
    prompt
}

fn build_wan_video_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    validate_wan_media(resolved)?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let media_field = request_field(&resolved.operation_schema, "mediaField", "media")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    let prompt = wan_prompt(resolved);
    if !prompt.trim().is_empty() {
        body.insert(prompt_field, Value::String(prompt));
    }

    let media = resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
        .map(|item| {
            let reference = item.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "video media input has no remote-readable reference",
                    item.archive(),
                )
            })?;
            Ok(json!({ "type": item.role, "url": reference }))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    if !media.is_empty() {
        body.insert(media_field, Value::Array(media));
    }

    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

/// Veo（Google Veo，魔芋AI 代理）视频请求体：`model`/`prompt`/`resolution`/
/// `aspect_ratio`/`duration` 为顶层字段，`images` 为图生视频参考图 URL 数组
/// （只支持公网 http/https URL，文档约定平台只取第一个），
/// `negativePrompt`/`sampleCount`/`enhancePrompt`/`seed` 放入 `metadata` 对象。
fn build_veo_video_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    validate_veo_media(resolved)?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let media_field = request_field(&resolved.operation_schema, "mediaField", "images")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    let prompt = video_prompt(resolved);
    if prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "Veo video prompt must not be empty",
            resolved.archive(),
        ));
    }
    body.insert(prompt_field, Value::String(prompt));

    // 图生视频参考图：只支持公网 http(s) URL（暂存对象或远端素材的读取地址），
    // 不支持 base64 / data URL 直传。
    let images = resolved
        .images
        .iter()
        .map(|item| {
            let reference = item.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "Veo image input has no remote-readable reference",
                    item.archive(),
                )
            })?;
            if !(reference.starts_with("http://") || reference.starts_with("https://")) {
                return Err(BackendError::validation(
                    "Veo image input must reference a public http(s) URL",
                    json!({
                        "displayName": item.display_name,
                        "remoteReference": redact_url_string(reference)
                    }),
                ));
            }
            Ok(Value::String(reference.clone()))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    if !images.is_empty() {
        body.insert(media_field, Value::Array(images));
    }

    // resolution/aspect_ratio/duration 落在顶层；metadata 可选参数按
    // requestLocation: "metadata" 归入 metadata 对象。
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;

    // 1080p 分辨率仅支持 8 秒时长（接口约束，提前给出可读错误）。
    let resolution = body
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("720p");
    let duration = body.get("duration").and_then(Value::as_i64).unwrap_or(8);
    if resolution == "1080p" && duration != 8 {
        return Err(BackendError::validation(
            "Veo 1080p resolution requires a duration of 8 seconds",
            json!({ "resolution": resolution, "duration": duration }),
        ));
    }

    Ok(Value::Object(body))
}

/// Veo 仅接受图片参考输入（顶层 `images` URL 数组）；视频/音频素材不支持。
fn validate_veo_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "Veo video generation only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    Ok(())
}

/// Vidu 系列（魔芋AI 聚合平台）视频请求体：`model`/`prompt`/`resolution`/
/// `aspect_ratio`/`duration`/`seed`/`watermark` 为顶层字段，`images` 为图生/
/// 首尾帧/参考图输入 URL 或 Base64 Data URI 数组（数量决定生成模式：
/// 1 张=图生、2 张=首尾帧、≥3 张=参考图，保持输入顺序），
/// `movement_amplitude`/`style`/`audio`/`audio_type`/`off_peak`/`bgm` 等高级参数
/// 放入 `metadata` 对象透传。
fn build_vidu_video_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    validate_vidu_media(resolved)?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let media_field = request_field(&resolved.operation_schema, "mediaField", "images")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    let prompt = video_prompt(resolved);
    if prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "Vidu video prompt must not be empty",
            resolved.archive(),
        ));
    }
    body.insert(prompt_field, Value::String(prompt));

    // 图生/首尾帧/参考图输入：支持公网 http(s) URL 与带前缀的 Base64 Data URI。
    // 数量决定生成模式（1 张=图生、2 张=首尾帧、≥3 张=参考图），保持输入顺序。
    let images = resolved
        .images
        .iter()
        .map(|item| {
            let reference = item.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "Vidu image input has no remote-readable reference",
                    item.archive(),
                )
            })?;
            Ok(Value::String(reference.clone()))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    if !images.is_empty() {
        body.insert(media_field, Value::Array(images));
    }

    // resolution/aspect_ratio/duration/seed/watermark 落在顶层；metadata 高级参数
    // 按 requestLocation: "metadata" 归入 metadata 对象。
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;

    Ok(Value::Object(body))
}

/// Vidu 仅接受图片参考输入（顶层 `images` URL/Base64 数组）；视频/音频素材不支持。
fn validate_vidu_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "Vidu video generation only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    Ok(())
}

/// MiniMax-H3（魔芋平台新一代视频生成模型）视频请求体：
/// - `model`/`prompt`/`duration`/`resolution`/`ratio`/`aigc_watermark` 为顶层字段；
/// - 媒体通过 `metadata` 传入：`first_frame_image`（首帧）、`last_frame_image`（尾帧）、
///   `reference_images`（参考图数组）、`reference_videos`（参考视频数组）、
///   `reference_audios`（参考音频数组）；
/// - `metadata.task_type` 区分任务类型：generation（文生/图生/参考生成，默认）与
///   regeneration（768P→2K 再生成，连接的源视频作为 `base_video_url`，输出时长由
///   源视频决定，不发送 `duration`）。
fn build_minimax_h3_video_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    validate_minimax_h3_media(resolved)?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    let prompt = video_prompt(resolved);
    if prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "MiniMax-H3 video prompt must not be empty",
            resolved.archive(),
        ));
    }
    body.insert(prompt_field, Value::String(prompt));

    // resolution/ratio/duration/aigc_watermark 落在顶层；task_type 声明了
    // requestLocation: "metadata"，由 insert_mapped_parameters 归入 metadata 对象。
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;

    let task_type = body
        .get(&metadata_field)
        .and_then(|value| value.get("task_type"))
        .and_then(Value::as_str)
        .unwrap_or("generation")
        .to_string();

    if task_type == "regeneration" {
        // regeneration：源视频作为 base_video_url（source_task_id 与 base_video_url
        // 二选一，本地未提供任务 ID 输入，使用连接的源视频地址）；可额外携带
        // 参考音频；输出时长由源视频决定，不发送 duration。
        if resolved.videos.len() != 1 {
            return Err(BackendError::validation(
                "MiniMax-H3 regeneration requires exactly one source video input",
                json!({ "videos": resolved.videos.len() }),
            ));
        }
        if !resolved.images.is_empty() {
            return Err(BackendError::validation(
                "MiniMax-H3 regeneration does not accept image inputs",
                json!({ "images": resolved.images.len() }),
            ));
        }
        body.remove("duration");
    } else if task_type == "h3_context_ir" {
        // Context-IR（智能扩写）：产出文本而非视频，不接受 resolution（文档说明传了
        // 也会被忽略）；输入仅限参考视频/音频（各 ≤3），不接受图片。
        if !resolved.images.is_empty() {
            return Err(BackendError::validation(
                "MiniMax-H3 Context-IR does not accept image inputs",
                json!({ "images": resolved.images.len() }),
            ));
        }
        body.remove("resolution");
    }

    let metadata = body
        .entry(metadata_field.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    let metadata_object = metadata.as_object_mut().ok_or_else(|| {
        BackendError::validation(
            "MiniMax-H3 metadata field collides with a non-object value",
            json!({ "metadataField": metadata_field }),
        )
    })?;
    metadata_object.insert("task_type".into(), Value::String(task_type.clone()));

    if task_type == "regeneration" {
        let base = resolved.videos.first().expect("videos length checked");
        let reference = base.remote_reference.as_ref().ok_or_else(|| {
            BackendError::validation(
                "MiniMax-H3 regeneration video has no remote-readable reference",
                base.archive(),
            )
        })?;
        metadata_object.insert("base_video_url".into(), Value::String(reference.clone()));
        for media in &resolved.audios {
            let reference = media.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "MiniMax-H3 regeneration audio has no remote-readable reference",
                    media.archive(),
                )
            })?;
            metadata_object
                .entry("reference_audios")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("reference_audios array")
                .push(Value::String(reference.clone()));
        }
    } else {
        for media in &resolved.images {
            let reference = media.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "MiniMax-H3 image input has no remote-readable reference",
                    media.archive(),
                )
            })?;
            match media.role.as_str() {
                "first_frame" => {
                    metadata_object
                        .insert("first_frame_image".into(), Value::String(reference.clone()));
                }
                "last_frame" => {
                    metadata_object
                        .insert("last_frame_image".into(), Value::String(reference.clone()));
                }
                "reference_image" => {
                    metadata_object
                        .entry("reference_images")
                        .or_insert_with(|| Value::Array(Vec::new()))
                        .as_array_mut()
                        .expect("reference_images array")
                        .push(Value::String(reference.clone()));
                }
                _ => {
                    return Err(BackendError::validation(
                        "MiniMax-H3 image role is incompatible with the resolved media type",
                        json!({
                            "role": media.role,
                            "mediaType": media.media_type,
                            "displayName": media.display_name
                        }),
                    ));
                }
            }
        }
        for media in &resolved.videos {
            let reference = media.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "MiniMax-H3 video input has no remote-readable reference",
                    media.archive(),
                )
            })?;
            metadata_object
                .entry("reference_videos")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("reference_videos array")
                .push(Value::String(reference.clone()));
        }
        for media in &resolved.audios {
            let reference = media.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "MiniMax-H3 audio input has no remote-readable reference",
                    media.archive(),
                )
            })?;
            metadata_object
                .entry("reference_audios")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("reference_audios array")
                .push(Value::String(reference.clone()));
        }
    }

    Ok(Value::Object(body))
}

/// MiniMax-H3 媒体前置校验：
/// - 首帧/尾帧图片各最多 1 张，参考图最多 9 张，参考视频/音频各最多 3 段；
/// - 首帧/尾帧模式与参考图/视频/音频模式不可混用（平台会以 build_request_failed 拒绝）；
/// - 角色必须与素材类型匹配（role: first_frame/last_frame/reference_image → 图片，
///   reference_video → 视频，reference_audio → 音频）。
fn validate_minimax_h3_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    let mut first_frames = 0_usize;
    let mut last_frames = 0_usize;
    let mut reference_images = 0_usize;
    let mut reference_videos = 0_usize;
    let mut reference_audios = 0_usize;
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        match media.role.as_str() {
            "first_frame" if media.media_type == MediaType::Image => first_frames += 1,
            "last_frame" if media.media_type == MediaType::Image => last_frames += 1,
            "reference_image" if media.media_type == MediaType::Image => reference_images += 1,
            "reference_video" if media.media_type == MediaType::Video => reference_videos += 1,
            "reference_audio" if media.media_type == MediaType::Audio => reference_audios += 1,
            _ => {
                return Err(BackendError::validation(
                    "MiniMax-H3 media role is incompatible with the resolved media type",
                    json!({
                        "role": media.role,
                        "mediaType": media.media_type,
                        "displayName": media.display_name
                    }),
                ));
            }
        }
    }
    if first_frames > 1
        || last_frames > 1
        || reference_images > 9
        || reference_videos > 3
        || reference_audios > 3
    {
        return Err(BackendError::validation(
            "MiniMax-H3 media input exceeds a documented count limit",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    let has_frame_inputs = first_frames > 0 || last_frames > 0;
    let has_reference_inputs = reference_images > 0 || reference_videos > 0 || reference_audios > 0;
    if has_frame_inputs && has_reference_inputs {
        return Err(BackendError::validation(
            "MiniMax-H3 frame inputs and reference inputs cannot be mixed",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    Ok(())
}

fn wan_prompt(resolved: &ResolvedGeneration) -> String {
    let mut prompt = String::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) => prompt.push_str(text),
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => {
                let label = match media_type {
                    MediaType::Image => "图",
                    MediaType::Video => "视频",
                    MediaType::Audio => "音频",
                    MediaType::Text => "文本",
                };
                prompt.push_str(&format!("{label}{type_position}"));
            }
        }
    }
    prompt
}

fn validate_wan_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    const ALLOWED_IMAGE_MIME_TYPES: [&str; 5] = [
        "image/jpeg",
        "image/png",
        "image/bmp",
        "image/x-ms-bmp",
        "image/webp",
    ];

    let mut first_frames = 0_usize;
    let mut last_frames = 0_usize;
    let mut reference_images = 0_usize;
    let mut reference_videos = 0_usize;
    let mut reference_audios = 0_usize;
    let mut document_files = 0_usize;
    let mut document_links = 0_usize;
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        match media.role.as_str() {
            "first_frame" if media.media_type == MediaType::Image => first_frames += 1,
            "last_frame" if media.media_type == MediaType::Image => last_frames += 1,
            "reference_image" if media.media_type == MediaType::Image => reference_images += 1,
            "reference_video" if media.media_type == MediaType::Video => reference_videos += 1,
            "reference_audio" if media.media_type == MediaType::Audio => reference_audios += 1,
            // 文档/网页生视频：`file`/`link` 素材本身就是公网 URL，不绑定图片/视频/音频类型。
            "file" => document_files += 1,
            "link" => document_links += 1,
            _ => {
                return Err(BackendError::validation(
                    "Wan 3.0 media role is incompatible with the resolved media type",
                    json!({
                        "role": media.role,
                        "mediaType": media.media_type,
                        "displayName": media.display_name
                    }),
                ));
            }
        }
        // 图片格式约束只适用于真正的图片素材；`file`/`link` 是公网文档/网页 URL。
        if media.media_type == MediaType::Image
            && !matches!(media.role.as_str(), "file" | "link")
            && !ALLOWED_IMAGE_MIME_TYPES.contains(&media.mime_type.as_str())
        {
            return Err(BackendError::validation(
                "Wan 3.0 image input uses an unsupported format",
                json!({ "mimeType": media.mime_type, "displayName": media.display_name }),
            ));
        }
        // 文档/网页仅支持无需登录的公开页面：请求层至少校验引用是公网 http(s) URL。
        if matches!(media.role.as_str(), "file" | "link")
            && !media.remote_reference.as_deref().is_some_and(|reference| {
                reference.starts_with("http://") || reference.starts_with("https://")
            })
        {
            return Err(BackendError::validation(
                "Wan 3.0 document/link input must reference a public http(s) URL",
                json!({
                    "role": media.role,
                    "displayName": media.display_name
                }),
            ));
        }
    }

    if first_frames > 1
        || last_frames > 1
        || reference_images > 10
        || reference_videos > 5
        || reference_audios > 5
        || document_files > 1
        || document_links > 1
    {
        return Err(BackendError::validation(
            "Wan 3.0 media input exceeds a documented count limit",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios,
                "documentFiles": document_files,
                "documentLinks": document_links
            }),
        ));
    }
    let has_frame_inputs = first_frames > 0 || last_frames > 0;
    let has_reference_inputs = reference_images > 0 || reference_videos > 0 || reference_audios > 0;
    if has_frame_inputs && has_reference_inputs {
        return Err(BackendError::validation(
            "Wan 3.0 frame inputs and reference inputs cannot be mixed",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    let has_document_inputs = document_files > 0 || document_links > 0;
    if has_document_inputs && (has_frame_inputs || has_reference_inputs) {
        return Err(BackendError::validation(
            "Wan 3.0 document/link inputs cannot be mixed with other media inputs",
            json!({
                "documentFiles": document_files,
                "documentLinks": document_links,
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    if document_files > 0 && document_links > 0 {
        return Err(BackendError::validation(
            "Wan 3.0 file and link inputs are mutually exclusive",
            json!({
                "documentFiles": document_files,
                "documentLinks": document_links
            }),
        ));
    }
    Ok(())
}

fn video_media_content(media: &ResolvedMedia, reference: &str) -> Value {
    match media.media_type {
        MediaType::Image => json!({
            "type": "image_url",
            "image_url": { "url": reference },
            "role": media.role,
        }),
        MediaType::Video => json!({
            "type": "video_url",
            "video_url": { "url": reference },
            "role": media.role,
        }),
        MediaType::Audio => json!({
            "type": "audio_url",
            "audio_url": { "url": reference },
            "role": media.role,
        }),
        MediaType::Text => json!({
            "type": "text",
            "text": reference,
            "role": media.role,
        }),
    }
}

fn parse_image_submission(
    response: &CapturedHttpResponse,
    require_base64: bool,
) -> BackendResult<GenerationSubmission> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let mut sources = Vec::new();
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        for item in items {
            let url = item.get("url").and_then(Value::as_str);
            let base64 = item.get("b64_json").and_then(Value::as_str);
            // Seedream 5.0 pro 图层拆分：data 项携带 z_index/name/description/bounding_box，
            // 用于把每个图层单独落为可编辑对象。
            let layer = if item.get("z_index").is_some() {
                Some(ImageLayerMetadata {
                    z_index: item.get("z_index").and_then(Value::as_u64).unwrap_or(0) as u32,
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned),
                    bounding_box: item.get("bounding_box").cloned(),
                })
            } else {
                None
            };
            if require_base64 {
                if let Some(base64) = base64.filter(|value| !value.is_empty()) {
                    sources.push(ImageSource::Base64 {
                        data: base64.to_string(),
                        layer,
                    });
                }
            } else if let Some(url) = url.filter(|value| !value.is_empty()) {
                sources.push(ImageSource::Url {
                    url: url.to_string(),
                    layer,
                });
            } else if let Some(base64) = base64.filter(|value| !value.is_empty()) {
                sources.push(ImageSource::Base64 {
                    data: base64.to_string(),
                    layer,
                });
            }
        }
    }
    if !require_base64 {
        if let Some(urls) = value.pointer("/data/image_urls").and_then(Value::as_array) {
            sources.extend(
                urls.iter()
                    .filter_map(Value::as_str)
                    .filter(|url| !url.is_empty())
                    .map(|url| ImageSource::Url {
                        url: url.to_string(),
                        layer: None,
                    }),
            );
        }
    }
    if sources.is_empty() {
        return Err(BackendError::protocol(
            "image response did not contain a valid result",
            json!({ "httpStatus": response.status, "rawResponse": response.body }),
        ));
    }
    Ok(GenerationSubmission::Images(sources))
}

fn parse_video_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    value
        .get("task_id")
        .or_else(|| value.get("id"))
        .or_else(|| value.pointer("/data/task_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            BackendError::protocol(
                "video submission did not return task_id",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })
}

fn parse_video_observation(
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let remote_status = value
        .pointer("/data/status")
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            BackendError::protocol(
                "video observation did not return status",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })?
        .to_string();
    let progress = value
        .pointer("/data/progress")
        .or_else(|| value.get("progress"))
        .and_then(parse_progress);
    let video_url = extract_video_url(&value);
    // Context-IR（h3_context_ir）任务：扩写文本在透传层 `data.data.task.content.prompt`，
    // 外层没有 result_url，`modality` 为 "text"。
    let text_content = value
        .pointer("/data/data/task/content/prompt")
        .and_then(Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .map(ToOwned::to_owned);
    let fail_reason = value.pointer("/data/fail_reason").cloned();
    let upstream_error = value
        .pointer("/data/data/data/data/error")
        .or_else(|| value.pointer("/data/data/data/error"))
        .or_else(|| value.pointer("/data/data/error"))
        .cloned();
    let remote_failed = matches!(
        remote_status.to_ascii_uppercase().as_str(),
        "FAILURE" | "FAILED"
    );
    let failure = if remote_failed
        && (fail_reason.as_ref().is_some_and(|value| !value.is_null())
            || upstream_error
                .as_ref()
                .is_some_and(|value| !value.is_null()))
    {
        Some(json!({
            "failReason": fail_reason,
            "upstreamError": upstream_error
        }))
    } else {
        None
    };
    Ok(GenerationObservation {
        remote_status,
        progress,
        video_url,
        text_content,
        failure,
    })
}

/// 从供应商视频观察响应中提取产物 URL。
///
/// 不同供应商/平台的嵌套层级差异很大，按序探测常见位置：
/// - 海外平台：顶层 `data.result_url`
/// - Seedance/MAGateway 轮询：`data.data.data.result_url`，或
///   `data.data.data.data.content.video_url`（content 有时会被序列化为
///   JSON 字符串，需二次解析）。
/// - 其他历史结构：`data.data.result_url`、`data.data...content.video_url`、
///   `metadata.url` 等。
fn extract_video_url(value: &Value) -> Option<String> {
    const PROBED_PATHS: &[&str] = &[
        "/data/result_url",
        "/data/data/result_url",
        "/data/data/data/result_url",
        "/data/data/data/data/content/video_url",
        "/data/data/data/content/video_url",
        "/data/data/content/video_url",
        "/data/content/video_url",
        "/content/video_url",
        "/data/data/data/data/content/url",
        "/data/metadata/url",
        "/metadata/url",
    ];
    for path in PROBED_PATHS {
        if let Some(url) = value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
        {
            return Some(url.to_owned());
        }
    }
    // content 可能以 JSON 字符串返回（内嵌 video_url / url），按同序深度的
    // content 位置二次解析，避免因序列化方式不同而漏掉产物。
    const CONTENT_PATHS: &[&str] = &[
        "/data/data/data/data/content",
        "/data/data/data/content",
        "/data/data/content",
        "/data/content",
        "/content",
    ];
    for path in CONTENT_PATHS {
        let Some(inner) = value
            .pointer(path)
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        else {
            continue;
        };
        for key in ["video_url", "url"] {
            if let Some(url) = inner
                .pointer(&format!("/{key}"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
            {
                return Some(url.to_owned());
            }
        }
    }
    None
}

fn parse_progress(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .map(str::trim)
            .and_then(|value| value.strip_suffix('%').unwrap_or(value).trim().parse().ok())
    })
}

/// 从供应商响应中提取 token 用量（usage 对象）。
///
/// 不同供应商/平台的嵌套层级差异很大：
/// - OpenAI 兼容：顶层 `usage`
/// - Gemini：`usageMetadata`
/// - 图片同步响应：`data.usage`
/// - Seedance/MAGateway 视频轮询：`data.data.data.data.usage`（其次
///   `data.data.data.usage`、`data.data.usage`）。
///
/// usage 内至少要有一个已知的 token 字段才视为有效，避免把空对象当作用量。
pub fn parse_token_usage(response: &CapturedHttpResponse) -> Option<TokenUsage> {
    if !response.is_success() {
        return None;
    }
    let value: Value = serde_json::from_str(&response.body).ok()?;
    let usage = value
        .pointer("/data/data/data/data/usage")
        .or_else(|| value.pointer("/data/data/data/usage"))
        .or_else(|| value.pointer("/data/data/usage"))
        .or_else(|| value.pointer("/data/usage"))
        .or_else(|| value.get("usage"))
        .or_else(|| value.get("usageMetadata"))?;
    let usage = usage.as_object()?;
    let read_tokens = |keys: &[&str]| -> Option<u64> {
        keys.iter().find_map(|key| {
            usage.get(*key).and_then(|field| {
                field
                    .as_u64()
                    .or_else(|| field.as_i64().map(|v| v.max(0) as u64))
            })
        })
    };
    let prompt_tokens = read_tokens(&["prompt_tokens", "input_tokens", "promptTokenCount"]);
    let completion_tokens =
        read_tokens(&["completion_tokens", "output_tokens", "candidatesTokenCount"]);
    let total_tokens = read_tokens(&["total_tokens", "totalTokenCount"]).or_else(|| {
        prompt_tokens
            .zip(completion_tokens)
            .map(|(prompt, output)| prompt + output)
    });
    let tokens = TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    };
    (tokens.prompt_tokens.is_some()
        || tokens.completion_tokens.is_some()
        || tokens.total_tokens.is_some())
    .then_some(tokens)
}

fn require_success(response: &CapturedHttpResponse) -> BackendResult<()> {
    if response.is_success() {
        Ok(())
    } else {
        Err(BackendError::protocol(
            format!("provider returned HTTP {}", response.status),
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
                "retryable": response.is_retryable(),
            }),
        ))
    }
}

fn parse_model_catalog(response: &RawProviderResponse) -> BackendResult<Vec<RemoteModelOption>> {
    if !(200..300).contains(&response.status) {
        return Err(BackendError::protocol(
            format!(
                "provider returned HTTP {} while listing models",
                response.status
            ),
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
            }),
        ));
    }

    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        BackendError::protocol(
            "model list response is not valid JSON",
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
                "jsonError": error.to_string(),
            }),
        )
    })?;
    let items = match &value {
        Value::Array(items) => Some(items),
        Value::Object(_) => value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.get("models").and_then(Value::as_array))
            .or_else(|| value.pointer("/data/models").and_then(Value::as_array)),
        _ => None,
    }
    .ok_or_else(|| {
        BackendError::protocol(
            "model list response did not contain an array",
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
            }),
        )
    })?;

    let mut seen = HashSet::new();
    let models = items
        .iter()
        .filter_map(|item| {
            let (id, display_name, owned_by) = match item {
                Value::String(id) => (id.as_str(), id.as_str(), None),
                Value::Object(_) => {
                    let id = item
                        .get("id")
                        .or_else(|| item.get("model_id"))
                        .or_else(|| item.get("model"))
                        .and_then(Value::as_str)?;
                    let display_name = item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or(id);
                    let owned_by = item
                        .get("owned_by")
                        .or_else(|| item.get("provider"))
                        .and_then(Value::as_str);
                    (id, display_name, owned_by)
                }
                _ => return None,
            };
            let id = id.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let operation_schema = infer_catalog_schema(item, id, display_name);
            let suggested_operations = operations_from_schema(&operation_schema);
            Some(RemoteModelOption {
                id: id.to_string(),
                model_definition_id: String::new(),
                display_name: display_name.to_string(),
                owned_by: owned_by.map(ToOwned::to_owned),
                has_configured_binding: false,
                configured_operations: Vec::new(),
                suggested_operations,
                operation_schema,
                token_group: None,
            })
        })
        .collect();
    Ok(models)
}

pub fn endpoint(base_url: &str, path: &str) -> BackendResult<Url> {
    let mut url = Url::parse(base_url)?;
    let mut base_segments = url
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let requested_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    // A provider connection can share OpenAI-compatible and Gemini endpoints.
    // Their version roots are alternatives, while any gateway prefix stays intact.
    if matches!(
        (
            base_segments.last().copied(),
            requested_segments.first().copied()
        ),
        (Some("v1"), Some("v1beta")) | (Some("v1beta"), Some("v1"))
    ) {
        base_segments.pop();
    }
    let overlap = (1..=base_segments.len().min(requested_segments.len()))
        .rev()
        .find(|count| base_segments[base_segments.len() - count..] == requested_segments[..*count])
        .unwrap_or(0);
    let joined_segments = base_segments
        .iter()
        .copied()
        .chain(requested_segments[overlap..].iter().copied())
        .collect::<Vec<_>>();
    url.set_path(&format!("/{}", joined_segments.join("/")));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn validate_base_url(base_url: &str) -> BackendResult<()> {
    let url = Url::parse(base_url)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(BackendError::validation(
            "base URL must be an absolute HTTP or HTTPS URL",
            json!({ "baseUrl": base_url }),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BackendError::validation(
            "base URL must not contain credentials, query parameters, or a fragment",
            json!({ "baseUrl": base_url }),
        ));
    }
    Ok(())
}

pub fn sanitize_url(url: &Url) -> String {
    let mut sanitized = url.clone();
    let _ = sanitized.set_username("");
    let _ = sanitized.set_password(None);
    if sanitized
        .query_pairs()
        .any(|(key, _)| sensitive_query_key(&key))
    {
        sanitized.set_query(None);
    }
    sanitized.to_string()
}

pub(crate) fn redact_url_string(value: &str) -> String {
    Url::parse(value)
        .map(|url| sanitize_url(&url))
        .unwrap_or_else(|_| value.to_string())
}

fn sensitive_query_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("signature")
        || key.contains("credential")
        || key.contains("security-token")
        || key.contains("accesskey")
        || key.contains("api_key")
        || key == "token"
        || key.starts_with("x-tos-")
        || key.starts_with("x-amz-")
}

pub(crate) fn redact_request_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(redact_request_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if lower.contains("api_key") || lower == "authorization" || lower == "cookie" {
                        (key.clone(), Value::String("已排除敏感凭据".into()))
                    } else {
                        (key.clone(), redact_request_value(value))
                    }
                })
                .collect(),
        ),
        Value::String(value) => Value::String(redact_url_string(value)),
        other => other.clone(),
    }
}

/// 连通性测试失败详情的截断长度：保留足够定位问题的前缀，避免错误横幅被长响应体撑爆。
const CONNECTIVITY_DETAIL_MAX_CHARS: usize = 400;

pub(crate) fn truncate_connectivity_detail(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= CONNECTIVITY_DETAIL_MAX_CHARS {
        return trimmed.to_string();
    }
    let truncated: String = trimmed
        .chars()
        .take(CONNECTIVITY_DETAIL_MAX_CHARS)
        .collect();
    format!("{truncated}…")
}

/// 把底层错误映射为机器可读的连通性失败类别，供前端生成本地化提示。
fn connectivity_error_reason(error: &BackendError) -> &'static str {
    match error {
        BackendError::Transport(_) => "network-error",
        BackendError::NotFound(_) | BackendError::Validation { .. } => "not-configured",
        BackendError::Credential(_) => "credential-error",
        _ => "error",
    }
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> Value {
    let mut values = Map::new();
    for (name, value) in headers {
        let rendered = value
            .to_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|_| format!("{:?}", value.as_bytes()));
        values
            .entry(name.as_str().to_string())
            .and_modify(|current| {
                if let Value::Array(items) = current {
                    items.push(Value::String(rendered.clone()));
                } else {
                    let previous = current.take();
                    *current = Value::Array(vec![previous, Value::String(rendered.clone())]);
                }
            })
            .or_insert(Value::String(rendered));
    }
    Value::Object(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按原始 SSE 文本投喂解析器，块边界由 `chunk_size` 决定（模拟真实网络分块）。
    /// 泛型化为具体方言是为了拿到具体类型，从而不必为测试引入 `Box<dyn>`。
    fn assemble_raw<D: SseDialect + Default>(sse: &str, chunk_size: usize) -> Value {
        let mut dialect = D::default();
        let mut parser = SseFrameParser::default();
        let mut sink = StreamSink::new(None);
        for chunk in sse.as_bytes().chunks(chunk_size) {
            parser.push(chunk, &mut dialect, &mut sink);
        }
        parser.assemble(&dialect)
    }

    /// 投喂并收集转发出去的正文增量，返回（整段原文, 逐次转发的内容）。
    fn collect_deltas<D: SseDialect + Default>(
        sse: &str,
        chunk_size: usize,
    ) -> (String, Vec<String>) {
        let mut dialect = D::default();
        let mut parser = SseFrameParser::default();
        let emitted: Vec<String> = Vec::new();
        // 用 Mutex 让收集闭包在 `&mut` 借用下也能写入（`TextDeltaSink` 要求 Send）。
        let collected = std::sync::Mutex::new(emitted);
        {
            let mut collector = |delta: &str| {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(delta.to_string());
                }
            };
            let mut sink = StreamSink::new(Some(&mut collector));
            for chunk in sse.as_bytes().chunks(chunk_size) {
                parser.push(chunk, &mut dialect, &mut sink);
            }
            // 与真实读取路径一致：流结束时补发被节流窗口挡住的最后一段。
            sink.finish(dialect.text());
        }
        let full = dialect.text().to_string();
        let deltas = collected.into_inner().unwrap_or_default();
        (full, deltas)
    }

    #[test]
    fn openai_sse_frames_assemble_into_a_complete_non_streaming_response() {
        let payload = assemble_raw::<OpenAiChatDialect>(
            concat!(
                "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1730000000,",
                "\"model\":\"deepseek-v4-flash\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",",
                "\"content\":\"\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"# 分镜\\n\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"【分镜3】\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],",
                "\"usage\":{\"prompt_tokens\":58000,\"completion_tokens\":1200,\"total_tokens\":59200}}\n\n",
                "data: [DONE]\n\n",
            ),
            // 按 7 字节切块投喂：块边界必然落在多字节中文字符内部，解码只能在
            // 完整帧上进行，否则正文会被撕成替换符。
            7,
        );
        assert_eq!(payload["id"], "chat-1");
        assert_eq!(payload["model"], "deepseek-v4-flash");
        assert_eq!(payload["created"], 1730000000);
        assert_eq!(payload["object"], "chat.completion");
        assert_eq!(payload["choices"][0]["message"]["role"], "assistant");
        assert_eq!(
            payload["choices"][0]["message"]["content"],
            "# 分镜\n【分镜3】"
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "stop");
        // 4 条 JSON 事件各计一帧；`data: [DONE]` 是结束标记，不算帧。
        assert_eq!(payload["x_stream"]["frames"], 4);
        assert_eq!(payload["x_stream"]["parseFailures"], 0);
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&payload).as_deref(),
            Some("# 分镜\n【分镜3】")
        );
        let usage = parse_token_usage(&CapturedHttpResponse {
            call_id: "call-1".into(),
            status: 200,
            headers: json!({}),
            body: serde_json::to_string(&payload).unwrap(),
        })
        .expect("usage");
        assert_eq!(usage.prompt_tokens, Some(58000));
        assert_eq!(usage.completion_tokens, Some(1200));
        assert_eq!(usage.total_tokens, Some(59200));
    }

    #[test]
    fn sse_parser_tolerates_crlf_unknown_fields_and_split_frames() {
        // `\r\n\r\n` 分隔、`event:`/注释行与跨块的半帧；最后一段没有空行结尾，
        // 只处理完整帧，残余部分不参与重组。
        let payload = assemble_raw::<OpenAiChatDialect>(
            concat!(
                ": keep-alive\r\n\r\nevent: message\r\ndata: {\"choices\":[{\"delta\":",
                "{\"content\":\"前\"}}]}\r\n\r\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"后\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"丢弃\"}}]}",
            ),
            3,
        );
        assert_eq!(payload["choices"][0]["message"]["content"], "前后");
        assert_eq!(payload["choices"][0]["finish_reason"], Value::Null);
        assert_eq!(payload["x_stream"]["frames"], 2);
        assert_eq!(payload["x_stream"]["parseFailures"], 0);
        assert!(payload.get("usage").is_none());
    }

    #[test]
    fn sse_parser_surfaces_in_stream_errors_and_keeps_reasoning_out_of_the_deliverable() {
        let mut dialect = OpenAiChatDialect::default();
        let mut parser = SseFrameParser::default();
        let mut sink = StreamSink::new(None);
        // 思维链增量单独累积，不混进交付正文。
        parser.push(
            b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"\xe5\x85\x88\xe6\x83\xb3\"}}]}\n\n",
            &mut dialect,
            &mut sink,
        );
        parser.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"\xe6\xad\xa3\xe6\x96\x87\"}}]}\n\n",
            &mut dialect,
            &mut sink,
        );
        // 上游在流内返回错误对象时保留原始错误，便于诊断。
        parser.push(
            b"data: {\"error\":{\"message\":\"upstream overloaded\"}}\n\n",
            &mut dialect,
            &mut sink,
        );
        // 非 JSON 载荷计入解析失败，但不影响已累积的正文。
        parser.push(b"data: not-json\n\n", &mut dialect, &mut sink);
        parser.push(b"data: [DONE]\n\n", &mut dialect, &mut sink);
        let payload = parser.assemble(&dialect);
        assert_eq!(payload["choices"][0]["message"]["content"], "正文");
        assert_eq!(
            payload["choices"][0]["message"]["reasoning_content"],
            "先想"
        );
        assert_eq!(payload["error"]["message"], "upstream overloaded");
        assert_eq!(payload["x_stream"]["parseFailures"], 1);
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&payload).as_deref(),
            Some("正文")
        );
    }

    /// Anthropic Messages：`message_start` / `content_block_delta` / `message_delta`
    /// 三类事件必须还原成 `content[]` + `stop_reason` + `usage` 的非流式形状。
    #[test]
    fn anthropic_sse_events_reassemble_into_a_message_response() {
        let payload = assemble_raw::<AnthropicMessagesDialect>(
            concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-sonnet-4-5\",",
                "\"usage\":{\"input_tokens\":58000,\"output_tokens\":1}}}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"# 分镜\"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"【分镜3】\"}}\n\n",
                // 思维链增量不属于交付正文。
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"先想\"}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1200}}\n\n",
                "event: message_stop\n",
                "data: {\"type\":\"message_stop\"}\n\n",
            ),
            11,
        );
        assert_eq!(payload["type"], "message");
        assert_eq!(payload["id"], "msg_1");
        assert_eq!(payload["model"], "claude-sonnet-4-5");
        assert_eq!(payload["content"][0]["type"], "text");
        assert_eq!(payload["content"][0]["text"], "# 分镜【分镜3】");
        assert_eq!(payload["stop_reason"], "end_turn");
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&payload).as_deref(),
            Some("# 分镜【分镜3】")
        );
        // 截断判定依赖该路径的 stop_reason，这里的形状必须与截断检查的预期一致。
        assert_eq!(
            payload.pointer("/stop_reason").and_then(Value::as_str),
            Some("end_turn")
        );
        let usage = parse_token_usage(&CapturedHttpResponse {
            call_id: "call-2".into(),
            status: 200,
            headers: json!({}),
            body: serde_json::to_string(&payload).unwrap(),
        })
        .expect("usage");
        assert_eq!(usage.prompt_tokens, Some(58000));
        assert_eq!(usage.completion_tokens, Some(1200));
    }

    /// Gemini 的 `alt=sse` 分片：正文逐步拼接，用量取最后一个分片，终态原因沿用
    /// `finishReason`；带 `thought=true` 的分片是思维链，不进正文。
    #[test]
    fn gemini_sse_chunks_reassemble_into_a_generate_content_response() {
        let payload = assemble_raw::<GeminiContentDialect>(
            concat!(
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"# 分镜\"}]}}],",
                "\"modelVersion\":\"gemini-2.5-flash\",\"usageMetadata\":{\"promptTokenCount\":58000,\"totalTokenCount\":58001}}\n\n",
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"thought\":true,\"text\":\"先想\"}]}}]}\n\n",
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"【分镜3】\"}]}}],",
                "\"usageMetadata\":{\"promptTokenCount\":58000,\"candidatesTokenCount\":1200,\"totalTokenCount\":59200}}\n\n",
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"\"}]},\"finishReason\":\"STOP\"}],",
                "\"usageMetadata\":{\"promptTokenCount\":58000,\"candidatesTokenCount\":1200,\"totalTokenCount\":59200}}\n\n",
            ),
            13,
        );
        assert_eq!(payload["modelVersion"], "gemini-2.5-flash");
        assert_eq!(
            payload["candidates"][0]["content"]["parts"][0]["text"],
            "# 分镜【分镜3】"
        );
        assert_eq!(payload["candidates"][0]["finishReason"], "STOP");
        assert_eq!(payload["x_stream"]["frames"], 4);
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&payload).as_deref(),
            Some("# 分镜【分镜3】")
        );
        let usage = parse_token_usage(&CapturedHttpResponse {
            call_id: "call-3".into(),
            status: 200,
            headers: json!({}),
            body: serde_json::to_string(&payload).unwrap(),
        })
        .expect("usage");
        assert_eq!(usage.prompt_tokens, Some(58000));
        assert_eq!(usage.completion_tokens, Some(1200));
        assert_eq!(usage.total_tokens, Some(59200));
    }

    /// Gemini 未生效 `alt=sse` 时返回的是分片数组而不是 SSE；没有帧就必须改用整份
    /// 响应体，并把数组里的正文与用量合并成一份响应对象。
    #[test]
    fn json_array_payload_is_merged_when_the_gateway_ignores_streaming() {
        let transcript = concat!(
            "[{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"第一段\"}]}}]},",
            "{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"thought\":true,\"text\":\"先想\"}]}}]},",
            "{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"第二段\"}]},",
            "\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":4}}]",
        );
        let mut parser = SseFrameParser::default();
        let mut dialect = GeminiContentDialect::default();
        let mut sink = StreamSink::new(None);
        parser.push(transcript.as_bytes(), &mut dialect, &mut sink);
        let mut payload = parser.assemble(&dialect);
        assert_eq!(payload.pointer("/x_stream/frames"), Some(&json!(0)));
        payload = parse_complete_json_payload(transcript).expect("merged array payload");
        assert_eq!(
            payload["candidates"][0]["content"]["parts"][0]["text"],
            "第一段第二段"
        );
        assert_eq!(payload["candidates"][0]["finishReason"], "STOP");
        assert_eq!(payload["usageMetadata"]["candidatesTokenCount"], 4);
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&payload).as_deref(),
            Some("第一段第二段")
        );
        // 单对象退化响应同样直接采用。
        let single =
            "{\"content\":[{\"type\":\"text\",\"text\":\"正文\"}],\"stop_reason\":\"end_turn\"}";
        let merged = parse_complete_json_payload(single).expect("single object payload");
        assert_eq!(
            super::super::prompt_optimize::extract_text_model_output(&merged).as_deref(),
            Some("正文")
        );
        // 非 JSON 响应体不参与合并，避免把 HTML 错误页当成结果。
        assert!(parse_complete_json_payload("<html>524</html>").is_none());
    }

    /// 上游忽略 stream 字段、直接回完整 JSON 时，解析器不产生任何 SSE 帧，
    /// 调用方据此改用整个响应体（判定条件是帧数为零）。
    #[test]
    fn sse_parser_reports_no_frames_for_a_plain_json_response() {
        let payload = assemble_raw::<OpenAiChatDialect>(
            "{\"id\":\"chat-2\",\"choices\":[{\"message\":{\"content\":\"body\"}}]}",
            64,
        );
        assert_eq!(payload.pointer("/x_stream/frames"), Some(&json!(0)));
        // 没有帧就没有增量：重组结果里只有空占位，正文必须为空，才不会被误当结果。
        assert_eq!(payload["choices"][0]["message"]["content"], "");
        assert_eq!(payload["choices"][0]["finish_reason"], Value::Null);
    }

    /// 非流式退避的判定：端点差异或请求体差异，至少要有一个，否则重发没有意义。
    #[test]
    fn streaming_retry_requires_an_actually_different_request() {
        let streamed = json!({ "model": "m", "messages": [], "stream": true });
        let plain = json!({ "model": "m", "messages": [] });
        let gemini_streamed = json!({ "contents": [] });
        let ended = json!({ "x_stream": { "frames": 4 } });
        let buffered = json!({ "x_stream": { "frames": 0 } });
        // Gemini：请求体一致，但路径不同（:streamGenerateContent → :generateContent）。
        assert!(should_retry_without_streaming(
            404,
            &json!({}),
            true,
            &gemini_streamed,
            &gemini_streamed
        ));
        // OpenAI / Anthropic：路径相同时必须真的去掉了 stream 才算改变。
        assert!(should_retry_without_streaming(
            400,
            &json!({}),
            false,
            &plain,
            &streamed
        ));
        assert!(!should_retry_without_streaming(
            400,
            &json!({}),
            false,
            &streamed,
            &streamed
        ));
        // 网关把整轮生成缓冲后一次性回完整 JSON：一个帧都没有，值得改走非流式。
        assert!(should_retry_without_streaming(
            200, &buffered, false, &plain, &streamed
        ));
        // 确实流过（有帧）就不该推翻已得到的结果。
        assert!(!should_retry_without_streaming(
            200, &ended, false, &plain, &streamed
        ));
    }

    /// 增量转发必须做到「逐次转发拼接后正好等于最终正文」，否则前端会看到重复或缺失。
    /// 三种方言都要满足，因为转发逻辑是共用的、只有累积来源不同。
    #[test]
    fn streamed_text_deltas_concatenate_to_the_final_text() {
        // OpenAI：分片增量。
        let (full, deltas) = collect_deltas::<OpenAiChatDialect>(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"# 分镜\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"\\n【分镜3】\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            ),
            5,
        );
        assert_eq!(full, "# 分镜\n【分镜3】");
        assert_eq!(deltas.concat(), full);
        // 思维链不计入正文，也不应被转发出去。
        let (reasoning_full, reasoning_deltas) = collect_deltas::<OpenAiChatDialect>(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先想很久\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}\n\n",
            ),
            7,
        );
        assert_eq!(reasoning_full, "答案");
        assert_eq!(reasoning_deltas.concat(), "答案");

        // Anthropic：只有 content_block_delta 进正文。
        let (claude_full, claude_deltas) = collect_deltas::<AnthropicMessagesDialect>(
            concat!(
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"第一段\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"略\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"第二段\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            ),
            9,
        );
        assert_eq!(claude_full, "第一段第二段");
        assert_eq!(claude_deltas.concat(), claude_full);

        // Gemini：分片 parts[].text；thought 分片不进正文。
        let (gemini_full, gemini_deltas) = collect_deltas::<GeminiContentDialect>(
            concat!(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"甲\"}]}}]}\n\n",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"thought\":true,\"text\":\"略\"}]}}]}\n\n",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"乙\"}]}}]}\n\n",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\"}]},\"finishReason\":\"STOP\"}]}\n\n",
            ),
            6,
        );
        assert_eq!(gemini_full, "甲乙");
        assert_eq!(gemini_deltas.concat(), gemini_full);
    }

    /// 节流：同一时间窗口内的多条增量会被合并，最终补发保证不丢内容。
    #[test]
    fn stream_sink_throttles_and_then_flushes_the_tail() {
        let collected = std::sync::Mutex::new(Vec::<String>::new());
        {
            let mut collector = |delta: &str| {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(delta.to_string());
                }
            };
            let mut sink = StreamSink::new(Some(&mut collector));
            // 三次调用落在同一窗口内：只有第一次真正转发。
            sink.emit("一");
            sink.emit("一二");
            sink.emit("一二三");
            // 结束时补发剩余部分。
            sink.finish("一二三");
            // 已全部发出后再调用什么都不发。
            sink.finish("一二三");
        }
        let deltas = collected.into_inner().unwrap_or_default();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas.concat(), "一二三");
    }

    #[test]
    fn floor_char_boundary_never_splits_a_multibyte_char() {
        let text = "中文abc";
        // 「中」占 3 字节：切在 1/2 上都要回退到 0。
        assert_eq!(floor_char_boundary(text, 1), 0);
        assert_eq!(floor_char_boundary(text, 2), 0);
        assert_eq!(floor_char_boundary(text, 3), 3);
        assert_eq!(floor_char_boundary(text, 4), 3);
        assert_eq!(floor_char_boundary(text, text.len()), text.len());
        assert_eq!(floor_char_boundary(text, text.len() + 9), text.len());
    }

    #[test]
    fn sse_boundary_detection_prefers_the_earliest_separator() {
        assert_eq!(find_sse_boundary(b"data: a\n\nrest"), Some((7, 2)));
        assert_eq!(find_sse_boundary(b"data: a\r\n\r\nrest"), Some((7, 4)));
        assert_eq!(find_sse_boundary(b"data: a\r\nrest"), None);
        assert_eq!(find_sse_boundary(b""), None);
        // 分隔符查找在字节上进行：不会误命中文多字节字符内部。
        assert_eq!(find_sse_boundary("data: 中文内容".as_bytes()), None);
    }

    fn download_auth(base_url: &str, api_key: &str) -> ResultDownloadAuth {
        ResultDownloadAuth::from_parts(base_url, api_key)
    }

    /// 构造一个下载请求并取出最终的请求头。
    ///
    /// `request_url` 是 reqwest 必须能解析的请求地址（真实下载里就是供应商给的直链）；
    /// `applied_url` 是传给 `apply` 做信任判定的地址，二者在「目标不可解析」的用例里
    /// 故意不同——`apply` 必须自己容忍解析失败，而不是依赖调用方保证。
    fn download_headers(
        auth: &ResultDownloadAuth,
        request_url: &str,
        applied_url: &str,
    ) -> reqwest::header::HeaderMap {
        auth.apply(reqwest::Client::new().get(request_url), applied_url)
            .build()
            .expect("build download request")
            .headers()
            .clone()
    }

    fn headers_for(auth: &ResultDownloadAuth, url: &str) -> reqwest::header::HeaderMap {
        download_headers(auth, url, url)
    }

    /// 结果下载的 `Authorization` 与生成请求完全一致：**不按目标主机设信任边界**，
    /// 只要凭据存在就发送；`Referer` 才按同源/跨域分别取值。
    ///
    /// 这是产品侧明确接受的取舍：直链可能指向第三方存储域名，那把 API Key 也会发过去。
    /// 用例把「无条件发送」与「Referer 仍按同源区分」两条都钉死，避免以后被无声改回。
    #[test]
    fn result_download_auth_matches_generation_identity_for_every_host() {
        let auth = download_auth("https://api.moyu.info/v1", "sk-secret");

        // 同源：带 Bearer，Referer 用供应商 origin。
        let same_host = headers_for(&auth, "https://api.moyu.info/images/a.png");
        assert_eq!(
            same_host
                .get(reqwest::header::AUTHORIZATION)
                .expect("same-host download keeps the bearer token"),
            "Bearer sk-secret"
        );
        assert_eq!(
            same_host.get(reqwest::header::REFERER).expect("referer"),
            "https://api.moyu.info"
        );

        // 子域：同样带 Bearer，Referer 仍是供应商 origin。
        let subdomain = headers_for(&auth, "https://img.api.moyu.info/b.png");
        assert_eq!(
            subdomain
                .get(reqwest::header::AUTHORIZATION)
                .expect("subdomain keeps the bearer token"),
            "Bearer sk-secret"
        );
        assert_eq!(
            subdomain.get(reqwest::header::REFERER).expect("referer"),
            "https://api.moyu.info"
        );

        // 跨域（上游自有存储域名）：Bearer 照发；Referer 退化为直链自身 origin。
        let cross_host = headers_for(&auth, "https://chatgpt2api.example.com/c.png");
        assert_eq!(
            cross_host
                .get(reqwest::header::AUTHORIZATION)
                .expect("cross-host download carries the same credential as generation"),
            "Bearer sk-secret"
        );
        assert_eq!(
            cross_host.get(reqwest::header::REFERER).expect("referer"),
            "https://chatgpt2api.example.com"
        );

        // 形近域名：Bearer 一样发送（不再有信任边界），但 Referer 不会被当成同源。
        for lookalike in [
            "https://notapi.moyu.info/d.png",
            "https://api.moyu.info.attacker.test/e.png",
        ] {
            let headers = headers_for(&auth, lookalike);
            assert_eq!(
                headers.get(reqwest::header::AUTHORIZATION).expect("bearer"),
                "Bearer sk-secret"
            );
            assert_ne!(
                headers.get(reqwest::header::REFERER).expect("referer"),
                "https://api.moyu.info"
            );
        }

        // 未配置密钥（或已撤销）时不发送 Authorization，行为与原裸 GET 一致。
        let keyless = download_auth("https://api.moyu.info/v1", "");
        assert!(
            headers_for(&keyless, "https://api.moyu.info/images/a.png")
                .get(reqwest::header::AUTHORIZATION)
                .is_none()
        );

        // base_url 无法解析 → 没有可用凭据，不带 Authorization；
        // Referer 退化为直链自身 origin（不把没解析出来的地址当身份）。
        let unparsable = download_auth("not a url", "sk-x");
        let unparsable_headers = headers_for(&unparsable, "https://api.moyu.info/images/a.png");
        assert!(
            unparsable_headers
                .get(reqwest::header::AUTHORIZATION)
                .is_none()
        );
        assert_eq!(
            unparsable_headers
                .get(reqwest::header::REFERER)
                .expect("referer"),
            "https://api.moyu.info"
        );
    }

    /// `Authorization` 与 URL 能否解析无关：凭据存在就发；只有 `Referer` 需要解析结果，
    /// 解析失败时跳过它。`apply` 必须自己容忍解析失败——真实调用方不会先替它校验。
    #[test]
    fn result_download_auth_applies_identity_without_parsing_target() {
        let auth = download_auth("https://api.moyu.info/v1", "sk-secret");
        let headers = download_headers(&auth, "https://api.moyu.info/images/a.png", "不是 URL");
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).expect("bearer"),
            "Bearer sk-secret"
        );
        assert!(headers.get(reqwest::header::REFERER).is_none());
        assert_eq!(
            headers.get(reqwest::header::ACCEPT).expect("accept"),
            "image/*,video/*,*/*"
        );
    }

    fn task(operation: GenerationOperation) -> TaskExecutionRecord {
        TaskExecutionRecord {
            id: "task-1".into(),
            operation,
            status: super::super::types::GenerationTaskStatus::Created,
            provider_connection_id: "company".into(),
            provider_display_name_snapshot: "Company".into(),
            adapter_id_snapshot: MOYU_ADAPTER_ID.into(),
            base_url_snapshot: "https://example.com/v1".into(),
            api_key_ref_snapshot: "provider:company:api-key".into(),
            model_definition_id: "company-model".into(),
            remote_model_id_snapshot: Some("company-model-v2".into()),
            remote_task_id: None,
            logical_request: json!({}),
            resolved_request: None,
        }
    }

    fn resolved(operation_schema: Value, parameters: Value) -> ResolvedGeneration {
        ResolvedGeneration {
            rendered_prompt: "A train arrives".into(),
            content: vec![CompiledContentItem::Text("A train arrives".into())],
            images: Vec::new(),
            videos: Vec::new(),
            audios: Vec::new(),
            parameters,
            video_task_type: None,
            operation_schema,
        }
    }

    fn resolved_media(
        media_type: MediaType,
        type_position: u32,
        role: &str,
        url: &str,
        prompt_segment_index: Option<usize>,
    ) -> ResolvedMedia {
        ResolvedMedia {
            media_type,
            type_position,
            role: role.into(),
            display_name: format!("asset-{type_position}"),
            stable_identity: json!({ "id": type_position }),
            mime_type: match media_type {
                MediaType::Image => "image/png",
                MediaType::Video => "video/mp4",
                MediaType::Audio => "audio/mpeg",
                MediaType::Text => "text/plain",
            }
            .into(),
            byte_size: 1024,
            duration_seconds: None,
            sha256: "abc".into(),
            file_name: format!("asset-{type_position}"),
            bytes: None,
            remote_reference: Some(url.into()),
            prompt_segment_index,
            content_index: Some(type_position),
        }
    }

    #[test]
    fn endpoint_handles_trailing_slashes() {
        assert_eq!(
            endpoint("https://example.com/", "/v1/images/generations")
                .expect("url")
                .as_str(),
            "https://example.com/v1/images/generations"
        );
    }

    #[test]
    fn asset_library_credentials_are_scoped_to_the_provider_connection() {
        assert_eq!(
            asset_library_credential_ref("provider-overseas"),
            "asset-library-token:provider-overseas"
        );
    }

    #[test]
    fn gateways_without_asset_endpoints_are_kept_out_of_the_asset_library() {
        // 盘趣网关没有 `/v1/assets/*`：直连 IP、带端口的地址与文档域名同样要挡住。
        assert_eq!(
            host_without_asset_library("https://115.191.2.88/"),
            Some("115.191.2.88")
        );
        assert_eq!(
            host_without_asset_library("http://115.191.2.88:3000/v1"),
            Some("115.191.2.88")
        );
        assert_eq!(
            host_without_asset_library("https://aiapis.panqu.com/"),
            Some("panqu.com")
        );
        // 其他上游继续使用既有素材库链路（魔芋聚合与火山引擎方舟）。
        assert_eq!(host_without_asset_library("https://www.moyu.info/"), None);
        assert_eq!(
            host_without_asset_library("https://ark.cn-beijing.volces.com/api/v3"),
            None
        );
        assert_eq!(host_without_asset_library(""), None);
    }

    #[test]
    fn endpoint_does_not_duplicate_a_version_prefix() {
        assert_eq!(
            endpoint("https://example.com/openai/v1", "/v1/models")
                .expect("url")
                .as_str(),
            "https://example.com/openai/v1/models"
        );
        assert_eq!(
            endpoint("https://example.com/company", "/v1/models")
                .expect("url")
                .as_str(),
            "https://example.com/company/v1/models"
        );
    }

    #[test]
    fn endpoint_switches_gemini_and_openai_versions_without_losing_gateway_prefixes() {
        for (base, path, expected) in [
            (
                "https://example.com/v1/",
                "/v1beta/models/gemini-3.6-flash:generateContent",
                "https://example.com/v1beta/models/gemini-3.6-flash:generateContent",
            ),
            (
                "https://example.com/gateway/v1",
                "/v1beta/models/gemini-3.6-flash:generateContent",
                "https://example.com/gateway/v1beta/models/gemini-3.6-flash:generateContent",
            ),
            (
                "https://example.com/v1beta/",
                "/v1beta/models/gemini-3.6-flash:generateContent",
                "https://example.com/v1beta/models/gemini-3.6-flash:generateContent",
            ),
            (
                "https://example.com/gateway/v1beta",
                "/v1/images/generations",
                "https://example.com/gateway/v1/images/generations",
            ),
            (
                "https://example.com/v1",
                "/v1/chat/completions",
                "https://example.com/v1/chat/completions",
            ),
            (
                "https://example.com/company",
                "/v1beta/models/gemini-3.6-flash:generateContent",
                "https://example.com/company/v1beta/models/gemini-3.6-flash:generateContent",
            ),
            (
                "https://example.com/gateway/v1",
                "/files",
                "https://example.com/gateway/v1/files",
            ),
        ] {
            assert_eq!(endpoint(base, path).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn model_parser_accepts_openai_and_company_shapes() {
        let openai = RawProviderResponse {
            status: 200,
            headers: json!({}),
            body: json!({
                "data": [
                    { "id": "image-1", "owned_by": "company" },
                    { "id": "video-1", "name": "视频模型一" }
                ]
            })
            .to_string(),
        };
        let models = parse_model_catalog(&openai).expect("OpenAI model list");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "image-1");
        assert_eq!(models[0].owned_by.as_deref(), Some("company"));
        assert_eq!(models[1].display_name, "视频模型一");

        let company = RawProviderResponse {
            status: 200,
            headers: json!({}),
            body: json!({ "data": { "models": ["model-a", { "model_id": "model-b" }] } })
                .to_string(),
        };
        let models = parse_model_catalog(&company).expect("company model list");
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["model-a", "model-b"]
        );
    }

    #[test]
    fn model_parser_preserves_the_raw_non_success_response() {
        let response = RawProviderResponse {
            status: 502,
            headers: json!({ "x-request-id": "req-1" }),
            body: r#"{"error":{"message":"upstream failed"}}"#.into(),
        };
        let error = parse_model_catalog(&response).expect_err("protocol error");
        let payload = error.payload();
        assert_eq!(payload.details["httpStatus"], 502);
        assert_eq!(payload.details["rawResponse"], response.body);
        assert_eq!(payload.details["headers"]["x-request-id"], "req-1");
    }

    #[test]
    fn text_image_builder_uses_frozen_request_field_aliases() {
        let generation = resolved(
            json!({
                "request": {
                    "encoding": "json",
                    "modelField": "model_id",
                    "promptField": "input"
                },
                "parameters": {
                    "aspect": {
                        "type": "string",
                        "requestField": "size"
                    }
                }
            }),
            json!({ "aspect": "1024x1536" }),
        );
        let body = build_text_to_image_body(&task(GenerationOperation::TextToImage), &generation)
            .expect("text image body");
        assert_eq!(body["model_id"], "company-model-v2");
        assert_eq!(body["input"], "A train arrives");
        assert_eq!(body["size"], "1024x1536");
        assert!(body.get("aspect").is_none());
    }

    #[test]
    fn seedream_image_to_image_builder_uses_json_body_with_url_references() {
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-pro-260628",
            &[
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
        );
        let mut generation = resolved(
            schema["image_to_image"].clone(),
            json!({
                "size": "2048x2048",
                "quality": "hd",
                "watermark": true,
                "response_format": "b64_json",
                "background": "transparent",
                "layer_decomposition": true
            }),
        );
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "image",
            "https://cdn.example.com/a.png",
            Some(0),
        ));
        let body = build_seedream_image_to_image_body(
            &task(GenerationOperation::ImageToImage),
            &generation,
        )
        .expect("seedream image-to-image body");
        assert_eq!(body["model"], "company-model-v2");
        assert_eq!(body["prompt"], "A train arrives");
        // 单张参考图按文档示例以字符串发送。
        assert_eq!(body["image"], "https://cdn.example.com/a.png");
        assert_eq!(body["size"], "2048x2048");
        assert_eq!(body["quality"], "hd");
        assert_eq!(body["watermark"], true);
        // 文档参数表：response_format 原样透传（b64_json 时响应走 Base64）。
        assert_eq!(body["response_format"], "b64_json");
        assert_eq!(body["background"], "transparent");
        assert_eq!(body["layer_decomposition"], true);
    }

    #[test]
    fn seedream_50_document_model_builds_json_body_with_documented_parameters() {
        // moyu 文档推荐的 doubao-seedream-5-0-260128：组图模式 + 输出格式 +
        // 返回格式 + 水印全部按文档参数表透传。
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-260128",
            &[GenerationOperation::ImageToImage],
        );
        let mut generation = resolved(
            schema["image_to_image"].clone(),
            json!({
                "size": "2K",
                "watermark": false,
                "response_format": "b64_json",
                "output_format": "webp",
                "sequential_image_generation": "auto"
            }),
        );
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "image",
            "https://cdn.example.com/a.png",
            Some(0),
        ));
        let body = build_seedream_image_to_image_body(
            &task(GenerationOperation::ImageToImage),
            &generation,
        )
        .expect("seedream 5.0 image-to-image body");
        assert_eq!(body["image"], "https://cdn.example.com/a.png");
        assert_eq!(body["size"], "2K");
        assert_eq!(body["watermark"], false);
        assert_eq!(body["response_format"], "b64_json");
        assert_eq!(body["output_format"], "webp");
        assert_eq!(body["sequential_image_generation"], "auto");
    }

    #[test]
    fn seedream_image_to_image_rejects_more_than_six_reference_images() {
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-260128",
            &[GenerationOperation::ImageToImage],
        );
        let mut generation = resolved(schema["image_to_image"].clone(), json!({}));
        for index in 1..=7 {
            generation.images.push(resolved_media(
                MediaType::Image,
                index as u32,
                "image",
                &format!("https://cdn.example.com/{index}.png"),
                Some((index - 1) as usize),
            ));
        }
        let error = build_seedream_image_to_image_body(
            &task(GenerationOperation::ImageToImage),
            &generation,
        )
        .expect_err("seedream image-to-image must reject 7 reference images");
        assert!(
            error.to_string().contains("at most 6 image references"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn seedream_image_to_image_builder_uses_url_array_for_multiple_references() {
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-pro-260628",
            &[GenerationOperation::ImageToImage],
        );
        let mut generation = resolved(schema["image_to_image"].clone(), json!({}));
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "image",
            "https://cdn.example.com/a.png",
            Some(0),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "image",
            "https://cdn.example.com/b.png",
            Some(1),
        ));
        let body = build_seedream_image_to_image_body(
            &task(GenerationOperation::ImageToImage),
            &generation,
        )
        .expect("seedream image-to-image body");
        assert_eq!(
            body["image"],
            json!([
                "https://cdn.example.com/a.png",
                "https://cdn.example.com/b.png"
            ])
        );
    }

    #[test]
    fn gemini_image_to_image_builder_uses_json_body_with_data_uri() {
        // https://doc.moyu.info/9280683m0.md OpenAI 兼容格式：顶层 model/prompt/
        // size + `image` data URI（带 `data:<mime>;base64,` 前缀），响应走 b64_json。
        let schema = super::super::model_schema::default_model_schema(
            "gemini-3-pro-image-preview",
            &[GenerationOperation::ImageToImage],
        );
        assert_eq!(
            schema["image_to_image"]["request"]["mediaEncoding"],
            "gemini_image_data_uri"
        );
        let mut generation = resolved(schema["image_to_image"].clone(), json!({ "size": "16:9" }));
        let mut media = resolved_media(
            MediaType::Image,
            1,
            "image",
            "https://cdn.example.com/a.png",
            Some(0),
        );
        media.bytes = Some(b"\x89PNG fake png bytes".to_vec());
        generation.images.push(media);
        let body =
            build_gemini_image_to_image_body(&task(GenerationOperation::ImageToImage), &generation)
                .expect("gemini image-to-image body");
        assert_eq!(body["model"], "company-model-v2");
        assert_eq!(body["prompt"], "A train arrives");
        // 单张参考图按文档示例以 data URI 字符串发送。
        let image = body["image"].as_str().expect("image must be a string");
        assert_eq!(image, "data:image/png;base64,iVBORyBmYWtlIHBuZyBieXRlcw==");
        assert_eq!(body["size"], "16:9");
    }

    #[test]
    fn gemini_image_to_image_builder_uses_data_uri_array_for_multiple_references() {
        let schema = super::super::model_schema::default_model_schema(
            "gemini-3-pro-image-preview",
            &[GenerationOperation::ImageToImage],
        );
        let mut generation = resolved(schema["image_to_image"].clone(), json!({}));
        for (index, bytes) in [b"first-png-bytes".to_vec(), b"second-png-bytes".to_vec()]
            .into_iter()
            .enumerate()
        {
            let mut media = resolved_media(
                MediaType::Image,
                index as u32 + 1,
                "image",
                &format!("https://cdn.example.com/{}.png", index + 1),
                Some(index),
            );
            media.bytes = Some(bytes);
            generation.images.push(media);
        }
        let body =
            build_gemini_image_to_image_body(&task(GenerationOperation::ImageToImage), &generation)
                .expect("gemini image-to-image body");
        // 多张参考图保持输入顺序为 data URI 数组。
        let images = body["image"].as_array().expect("image must be an array");
        assert_eq!(images.len(), 2);
        assert_eq!(
            images[0].as_str().unwrap(),
            "data:image/png;base64,Zmlyc3QtcG5nLWJ5dGVz"
        );
        assert_eq!(
            images[1].as_str().unwrap(),
            "data:image/png;base64,c2Vjb25kLXBuZy1ieXRlcw=="
        );
    }

    #[test]
    fn gemini_image_to_image_rejects_media_without_bytes() {
        let schema = super::super::model_schema::default_model_schema(
            "gemini-3-pro-image-preview",
            &[GenerationOperation::ImageToImage],
        );
        let mut generation = resolved(schema["image_to_image"].clone(), json!({}));
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "image",
            "https://cdn.example.com/a.png",
            Some(0),
        ));
        let error =
            build_gemini_image_to_image_body(&task(GenerationOperation::ImageToImage), &generation)
                .expect_err("gemini image-to-image must require base64-capable bytes");
        assert!(
            error.to_string().contains("no bytes for base64"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn seedream_group_optimize_and_web_search_parameters_transform_into_request_objects() {
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-lite",
            &[GenerationOperation::TextToImage],
        );
        let generation = resolved(
            schema["text_to_image"].clone(),
            json!({
                "sequential_image_generation": "auto",
                "max_images": 8,
                "optimize_prompt_mode": "fast",
                "web_search": true
            }),
        );
        let body = build_text_to_image_body(&task(GenerationOperation::TextToImage), &generation)
            .expect("seedream text image body");
        assert_eq!(body["sequential_image_generation"], "auto");
        assert_eq!(
            body["sequential_image_generation_options"],
            json!({ "max_images": 8 })
        );
        assert_eq!(body["optimize_prompt_options"], json!({ "mode": "fast" }));
        assert_eq!(body["tools"], json!([{ "type": "web_search" }]));

        // 组图模式为 disabled 时不发送组图数量（max_images 被忽略）。
        let generation = resolved(
            schema["text_to_image"].clone(),
            json!({ "sequential_image_generation": "disabled", "web_search": false }),
        );
        let body = build_text_to_image_body(&task(GenerationOperation::TextToImage), &generation)
            .expect("seedream text image body");
        assert_eq!(body["sequential_image_generation"], "disabled");
        assert!(body.get("sequential_image_generation_options").is_none());
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn video_builder_maps_declared_parameters_and_transforms_web_search() {
        let generation = resolved(
            json!({
                "request": {
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {
                    "frames": {
                        "type": "integer",
                        "requestField": "frame_count"
                    },
                    "web_search": {
                        "type": "boolean",
                        "requestField": "tools",
                        "transform": "web_search_tool",
                        "requiresNoMedia": true
                    }
                }
            }),
            json!({ "frames": 48, "web_search": true }),
        );
        let body = build_video_body(&task(GenerationOperation::VideoGeneration), &generation)
            .expect("video body");
        assert_eq!(body["metadata"]["frame_count"], 48);
        assert_eq!(body["metadata"]["tools"], json!([{ "type": "web_search" }]));
        assert_eq!(
            body["metadata"]["content"].as_array().map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn dreamina_seedance_builder_uses_top_level_prompt_and_metadata_fields() {
        let schema = super::super::model_schema::default_model_schema(
            "dreamina-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "9:16",
                "resolution": "720p",
                "duration": 12,
                "generate_audio": true,
                "web_search": true,
                "output_format": "mov",
                "priority": 7
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("dreamina-seedance-2.5".into());

        let body = build_video_body(&video_task, &generation).expect("Dreamina video body");
        assert_eq!(body["model"], "dreamina-seedance-2.5");
        // Seedance 文档：prompt 是实际发送给模型的提示词；content 中 text 条目被忽略。
        assert_eq!(body["prompt"], "A train arrives");
        assert_eq!(
            body["metadata"]["content"].as_array().map(Vec::len),
            Some(0)
        );
        assert_eq!(body["metadata"]["ratio"], "9:16");
        assert_eq!(body["metadata"]["resolution"], "720p");
        assert_eq!(body["metadata"]["duration"], 12);
        assert_eq!(body["metadata"]["generate_audio"], true);
        assert_eq!(body["metadata"]["output_format"], "mov");
        assert_eq!(body["metadata"]["priority"], 7);
        assert_eq!(body["metadata"]["tools"], json!([{ "type": "web_search" }]));
        assert!(body.get("omni_reference_task_type").is_none());
    }

    #[test]
    fn dreamina_seedance_builder_renders_reference_media_as_short_labels_in_prompt() {
        let schema = super::super::model_schema::default_model_schema(
            "dreamina-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "adaptive",
                "resolution": "720p",
                "duration": 30,
                "generate_audio": true,
                "output_format": "mp4",
                "priority": 0
            }),
        );
        // 模拟画布拼接：两张参考图 + 文本「疯狂做爱」。
        generation.rendered_prompt =
            "[图片1：微信图片_xxx.jpg]和[图片2：微信图片_yyy.jpg]疯狂做爱".into();
        generation.content = vec![
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text("和".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 2,
            },
            CompiledContentItem::Text("疯狂做爱".into()),
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "asset://asset-20260902214334-t5rnj",
            Some(1),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "asset://asset-20260902214333-l5lpp",
            Some(2),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("dreamina-seedance-2.5".into());

        let body = build_video_body(&video_task, &generation).expect("Dreamina media body");

        // Seedance 文档：顶层 prompt 仅要求非空，实际提示词来自 content 中的 text
        // 条目；带媒体请求必须显式携带文本，因此 content 首项是渲染后的提示词，
        // 随后才是媒体项（图片N 标签与媒体顺序一一对应）。
        assert_eq!(body["prompt"], "图片1和图片2疯狂做爱");
        assert_eq!(
            body["metadata"]["content"].as_array().map(Vec::len),
            Some(3)
        );
        assert_eq!(body["metadata"]["content"][0]["type"], "text");
        assert_eq!(
            body["metadata"]["content"][0]["text"],
            "图片1和图片2疯狂做爱"
        );
        assert_eq!(body["metadata"]["content"][1]["type"], "image_url");
        assert_eq!(body["metadata"]["content"][2]["type"], "image_url");
        assert_eq!(
            body["metadata"]["content"][1]["image_url"]["url"],
            "asset://asset-20260902214334-t5rnj"
        );
        assert_eq!(
            body["metadata"]["content"][2]["image_url"]["url"],
            "asset://asset-20260902214333-l5lpp"
        );
    }

    fn seedance_task_fixture(
        model: &str,
        mode: VideoTaskType,
    ) -> (TaskExecutionRecord, ResolvedGeneration) {
        let schema = super::super::model_schema::default_model_schema(
            model,
            &[GenerationOperation::VideoGeneration],
        );
        let mut parameters = json!({ "ratio": "adaptive", "duration": -1 });
        if schema["video_generation"]["parameters"]
            .get("omni_reference_task_type")
            .is_some()
        {
            parameters["omni_reference_task_type"] = json!(mode.omni_reference_task_type());
        }
        let mut generation = resolved(schema["video_generation"].clone(), parameters);
        generation.video_task_type = Some(mode);
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some(model.into());
        (video_task, generation)
    }

    #[test]
    fn seedance_edit_requires_real_video_duration_and_keeps_local_mode_out_of_remote_body() {
        for model in ["doubao-seedance-2-5-260628", "dreamina-seedance-2.5"] {
            let (task, mut generation) = seedance_task_fixture(model, VideoTaskType::Edit);
            assert!(
                build_video_body(&task, &generation).is_err(),
                "edit needs video"
            );
            generation.videos.push(resolved_media(
                MediaType::Video,
                1,
                "reference_video",
                "https://cdn.example.com/edit.mp4",
                None,
            ));
            for duration in [
                None,
                Some(3.99),
                Some(30.01),
                Some(f64::NAN),
                Some(f64::INFINITY),
            ] {
                generation.videos[0].duration_seconds = duration;
                assert!(
                    build_video_body(&task, &generation).is_err(),
                    "invalid actual duration: {duration:?}"
                );
            }
            for duration in [4.0, 16.5, 30.0] {
                generation.videos[0].duration_seconds = Some(duration);
                let body = build_video_body(&task, &generation).expect("valid edit");
                // 本地任务类型只参与校验，不写进请求体：远端字段由冻结 schema 决定
                // （国内 Seedance 2.5 的任务类型是根级 `omni_reference_task_type` 字符串）。
                assert!(body.get("videoTaskType").is_none());
                assert!(body["metadata"].get("videoTaskType").is_none());
                // 参数容器按方言分流：国内 doubao-seedance-* 走方舟
                // `/contents/generations/tasks`，参数平铺在根级；海外 Dreamina 走魔芋
                // `/v1/video/generations`，参数归入 metadata。
                if model.starts_with("dreamina") {
                    assert_eq!(body["metadata"]["ratio"], "adaptive");
                    assert_eq!(body["metadata"]["duration"], -1);
                    // 海外模型没有任务类型参数，任何容器里都不该出现。
                    assert!(body.get("omni_reference_task_type").is_none());
                    assert!(body["metadata"].get("omni_reference_task_type").is_none());
                } else {
                    assert_eq!(body["ratio"], "adaptive");
                    assert_eq!(body["duration"], -1);
                    assert_eq!(body["omni_reference_task_type"], "edit");
                    assert!(body["metadata"].get("ratio").is_none());
                    assert!(body["metadata"].get("omni_reference_task_type").is_none());
                }
            }
            generation.parameters["duration"] = json!(10);
            assert!(build_video_body(&task, &generation).is_err());
            generation.parameters["duration"] = json!(-1);
            generation.parameters["ratio"] = json!("16:9");
            assert!(build_video_body(&task, &generation).is_err());
        }
    }

    #[test]
    fn seedance_frames_require_first_frame_and_cannot_mix_reference_media() {
        let (task, mut generation) =
            seedance_task_fixture("doubao-seedance-2-5-260628", VideoTaskType::FirstFrame);
        assert!(build_video_body(&task, &generation).is_err());
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/first.png",
            None,
        ));
        assert!(build_video_body(&task, &generation).is_ok());
        generation.parameters["ratio"] = json!("1:1");
        assert!(build_video_body(&task, &generation).is_err());
        generation.parameters["ratio"] = json!("adaptive");
        generation.video_task_type = Some(VideoTaskType::FirstLastFrame);
        assert!(
            build_video_body(&task, &generation).is_err(),
            "missing last frame"
        );
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "last_frame",
            "https://cdn.example.com/last.png",
            None,
        ));
        assert!(build_video_body(&task, &generation).is_ok());
        generation.images.push(resolved_media(
            MediaType::Image,
            3,
            "reference_image",
            "https://cdn.example.com/reference.png",
            None,
        ));
        assert!(
            build_video_body(&task, &generation).is_err(),
            "mixed reference image"
        );
        generation.images.pop();
        generation.images.remove(0);
        generation.video_task_type = None;
        assert!(
            build_video_body(&task, &generation).is_err(),
            "legacy last frame alone"
        );
    }

    #[test]
    fn seedance_extend_requires_video_and_adaptive_ratio_with_legal_output_duration() {
        let (task, mut generation) =
            seedance_task_fixture("dreamina-seedance-2.5", VideoTaskType::Extend);
        assert!(build_video_body(&task, &generation).is_err());
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/extend.mp4",
            None,
        ));
        for duration in [None, Some(1.99), Some(30.01)] {
            generation.videos[0].duration_seconds = duration;
            assert!(build_video_body(&task, &generation).is_err());
        }
        generation.videos[0].duration_seconds = Some(2.0);
        for duration in [-1, 4, 15, 30] {
            generation.parameters["duration"] = json!(duration);
            assert!(build_video_body(&task, &generation).is_ok());
        }
        for duration in [json!(0), json!(3), json!(31), json!(4.5), json!("10")] {
            generation.parameters["duration"] = duration;
            assert!(build_video_body(&task, &generation).is_err());
        }
        generation.parameters["duration"] = json!(-1);
        generation.parameters["ratio"] = json!("16:9");
        assert!(build_video_body(&task, &generation).is_err());
    }

    #[test]
    fn seedance_legacy_edit_parameter_is_validated_and_conflicting_local_intent_is_rejected() {
        let (task, mut generation) =
            seedance_task_fixture("doubao-seedance-2-5-260628", VideoTaskType::Edit);
        generation.video_task_type = None;
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/edit.mp4",
            None,
        ));
        assert!(build_video_body(&task, &generation).is_err());
        generation.videos[0].duration_seconds = Some(10.0);
        assert!(build_video_body(&task, &generation).is_ok());
        generation.video_task_type = Some(VideoTaskType::Extend);
        assert!(build_video_body(&task, &generation).is_err());
    }

    #[test]
    fn seedance_edit_and_extend_limit_actual_total_duration_and_video_count() {
        for model in ["doubao-seedance-2-5-260628", "dreamina-seedance-2.5"] {
            for mode in [VideoTaskType::Edit, VideoTaskType::Extend] {
                let (task, mut generation) = seedance_task_fixture(model, mode);
                for position in 1..=2 {
                    let mut video = resolved_media(
                        MediaType::Video,
                        position,
                        "reference_video",
                        "https://cdn.example.com/source.mp4",
                        None,
                    );
                    video.duration_seconds = Some(15.0);
                    generation.videos.push(video);
                }
                assert!(
                    build_video_body(&task, &generation).is_ok(),
                    "30 seconds total"
                );
                generation.videos[1].duration_seconds = Some(15.01);
                assert!(
                    build_video_body(&task, &generation).is_err(),
                    "more than 30 seconds total"
                );
                generation.videos.clear();
                for position in 1..=11 {
                    let mut video = resolved_media(
                        MediaType::Video,
                        position,
                        "reference_video",
                        "https://cdn.example.com/source.mp4",
                        None,
                    );
                    video.duration_seconds = Some(if mode == VideoTaskType::Edit {
                        4.0
                    } else {
                        2.0
                    });
                    generation.videos.push(video);
                }
                assert!(
                    build_video_body(&task, &generation)
                        .unwrap_err()
                        .to_string()
                        .contains("10 个")
                );
            }
        }
    }

    #[test]
    fn seedance_reference_needs_at_least_one_reference() {
        let (task, mut generation) =
            seedance_task_fixture("doubao-seedance-2-5-260628", VideoTaskType::Reference);
        assert!(build_video_body(&task, &generation).is_err());
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/reference.png",
            None,
        ));
        assert!(build_video_body(&task, &generation).is_ok());
    }

    #[test]
    fn seedance_task_intent_roundtrips_without_breaking_legacy_generation_commands() {
        let legacy = json!({ "canvasId": "canvas", "sourceNodeId": "node", "operation": "video_generation", "providerConnectionId": "provider", "modelDefinitionId": "model", "prompt": [], "parameters": {} });
        let mut command: super::super::types::StartGenerationCommand =
            serde_json::from_value(legacy.clone()).unwrap();
        assert!(command.video_task_type.is_none());
        assert!(
            serde_json::to_value(&command)
                .unwrap()
                .get("videoTaskType")
                .is_none()
        );
        command.video_task_type = Some(VideoTaskType::FirstLastFrame);
        let frozen = serde_json::to_value(&command).unwrap();
        assert_eq!(frozen["videoTaskType"], "first_last_frame");
        let restored: super::super::types::StartGenerationCommand =
            serde_json::from_value(frozen).unwrap();
        assert_eq!(
            restored.video_task_type,
            Some(VideoTaskType::FirstLastFrame)
        );
    }

    #[test]
    fn seedance_task_prompt_adds_required_intent_without_changing_user_media_order() {
        for mode in [VideoTaskType::Edit, VideoTaskType::Extend] {
            let (task, mut generation) = seedance_task_fixture("dreamina-seedance-2.5", mode);
            generation.videos.push(resolved_media(
                MediaType::Video,
                1,
                "reference_video",
                "https://cdn.example.com/source.mp4",
                Some(1),
            ));
            generation.videos[0].duration_seconds = Some(10.0);
            generation.content = vec![
                CompiledContentItem::Text("请按原来的风格处理".into()),
                CompiledContentItem::Media {
                    media_type: MediaType::Video,
                    type_position: 1,
                },
            ];
            let body = build_video_body(&task, &generation).unwrap();
            let prefix = if mode == VideoTaskType::Edit {
                "编辑视频："
            } else {
                "续写视频："
            };
            assert_eq!(body["prompt"], format!("{prefix}\n请按原来的风格处理视频1"));
            assert_eq!(body["metadata"]["content"][0]["text"], body["prompt"]);
            assert_eq!(body["metadata"]["content"][1]["role"], "reference_video");
        }
    }

    #[test]
    fn seedance_extend_with_reference_video_includes_text_item_in_content() {
        // 回归：带媒体（参考视频延长）的 Seedance 请求必须把渲染提示词写入
        // metadata.content 的首个 text 条目；缺失时平台以「prompt is required」
        // 拒绝任务创建（真实的 HTTP 400 fail_to_fetch_task 场景）。
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedance-2-5-260628",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "adaptive",
                "resolution": "480p",
                "duration": -1,
                "generate_audio": true,
                "output_format": "mp4",
                "omni_reference_task_type": "extend"
            }),
        );
        generation.rendered_prompt = "【生成目标】\n向后延长视频1，生成一段对峙戏".into();
        generation.content = vec![
            CompiledContentItem::Text("【生成目标】\n向后延长".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Video,
                type_position: 1,
            },
            CompiledContentItem::Text("，生成一段对峙戏".into()),
        ];
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/ref.mp4",
            Some(1),
        ));
        generation.videos[0].duration_seconds = Some(10.0);
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("doubao-seedance-2.5".into());

        let body = build_video_body(&video_task, &generation).expect("Seedance extend body");
        assert_eq!(body["model"], "doubao-seedance-2.5");
        // 国内 Seedance 2.5 的参数平铺在根级：任务类型是根级 `omni_reference_task_type` 字符串，
        // 不在 metadata 里（metadata 只承载 content 与媒体项）。
        assert_eq!(body["omni_reference_task_type"], "extend");
        assert!(body["metadata"].get("omni_reference_task_type").is_none());
        assert_eq!(
            body["metadata"]["content"][0],
            json!({ "type": "text", "text": "【生成目标】\n向后延长视频1，生成一段对峙戏" })
        );
        assert_eq!(body["metadata"]["content"][1]["type"], "video_url");
        assert_eq!(body["metadata"]["content"][1]["role"], "reference_video");
        assert_eq!(
            body["metadata"]["content"][1]["video_url"]["url"],
            "https://cdn.example.com/ref.mp4"
        );
        assert!(
            body["prompt"]
                .as_str()
                .is_some_and(|prompt| !prompt.trim().is_empty())
        );
    }

    #[test]
    fn domestic_seedance_25_flattens_parameters_at_root_and_keeps_metadata_for_content() {
        // 契约：国内火山引擎原生 Seedance（doubao-seedance-*）走方舟
        // `/contents/generations/tasks`，画幅/时长/分辨率/任务类型等参数平铺在请求体根级；
        // metadata 只承载 content 与媒体项。海外 Dreamina 才把参数归入 metadata。
        // 这条用例把根级形状单独钉住：此前它只被"参数应在 metadata"的错误预期覆盖，
        // 结果两个用例长期失败而真实请求体其实是对的。
        let schema = super::super::model_schema::default_model_schema(
            "doubao-seedance-2-5-260628",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "adaptive",
                "resolution": "1080p",
                "duration": -1,
                "generate_audio": true,
                "output_format": "mp4",
                "omni_reference_task_type": "edit"
            }),
        );
        generation.rendered_prompt = "把天空换成黄昏".into();
        generation.content = vec![
            CompiledContentItem::Text("把天空换成黄昏".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Video,
                type_position: 1,
            },
        ];
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/source.mp4",
            Some(1),
        ));
        generation.videos[0].duration_seconds = Some(8.0);
        generation.video_task_type = Some(VideoTaskType::Edit);
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("doubao-seedance-2-5-260628".into());

        let body = build_video_body(&video_task, &generation).expect("domestic Seedance edit body");
        assert_eq!(body["model"], "doubao-seedance-2-5-260628");
        // 解码类参数平铺在根级。
        assert_eq!(body["ratio"], "adaptive");
        assert_eq!(body["resolution"], "1080p");
        assert_eq!(body["duration"], -1);
        assert_eq!(body["generate_audio"], true);
        assert_eq!(body["output_format"], "mp4");
        assert_eq!(body["omni_reference_task_type"], "edit");
        // metadata 只放 content：参数不能同时泄进 metadata，否则平台会读到两份口径。
        let metadata = body["metadata"].as_object().expect("metadata object");
        assert_eq!(
            metadata.keys().collect::<Vec<_>>(),
            vec!["content"],
            "metadata 只承载 content，参数必须留在根级"
        );
        assert_eq!(metadata["content"][0]["type"], "text");
        // content 首个 text 条目是渲染后的完整提示词：媒体引用渲染为「视频N」短标签，
        // 编辑任务再补「编辑视频：」前缀；与根级 prompt 保持一致。
        assert_eq!(metadata["content"][0]["text"], body["prompt"]);
        assert_eq!(
            metadata["content"][0]["text"],
            "编辑视频：\n把天空换成黄昏视频1"
        );
        assert_eq!(metadata["content"][1]["role"], "reference_video");
        // 请求体里没有本地 videoTaskType 字段：远端任务类型用 omni_reference_task_type 表达。
        assert!(body.get("videoTaskType").is_none());
    }

    #[test]
    fn wan_video_builder_uses_root_parameters_and_role_url_media_items() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video-prime",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "1080P",
                "ratio": "adaptive",
                "duration": 5,
                "seed": 42,
                "watermark": false
            }),
        );
        generation.rendered_prompt = "舞者[图片1：模特]跟随[音频1：音乐]".into();
        generation.content = vec![
            CompiledContentItem::Text("舞者".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text("跟随".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Audio,
                type_position: 1,
            },
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/model.png",
            Some(1),
        ));
        generation.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/music.mp3",
            Some(3),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video-prime".into());

        let body = build_video_body(&video_task, &generation).expect("Wan video body");
        assert_eq!(body["model"], "wan3.0-video-prime");
        assert_eq!(body["prompt"], "舞者图1跟随音频1");
        assert_eq!(body["resolution"], "1080P");
        assert_eq!(body["duration"], 5);
        assert_eq!(body["seed"], 42);
        assert_eq!(
            body["media"],
            json!([
                {
                    "type": "reference_image",
                    "url": "https://cdn.example.com/model.png"
                },
                {
                    "type": "reference_audio",
                    "url": "https://cdn.example.com/music.mp3"
                }
            ])
        );
        assert!(body.get("metadata").is_none());
    }

    #[test]
    fn wan_video_builder_accepts_media_without_a_prompt() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "720P",
                "ratio": "9:16",
                "duration": -1,
                "watermark": false
            }),
        );
        generation.rendered_prompt.clear();
        generation.content.clear();
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/first.webp",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video".into());

        let body = build_video_body(&video_task, &generation).expect("media-only Wan body");
        assert!(body.get("prompt").is_none());
        assert_eq!(
            body["media"],
            json!([{
                "type": "first_frame",
                "url": "https://cdn.example.com/first.webp"
            }])
        );
    }

    #[test]
    fn wan_video_builder_accepts_image_larger_than_former_byte_limit() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({"resolution": "720P", "ratio": "9:16", "duration": 5}),
        );
        let mut image = resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/large.png",
            None,
        );
        image.byte_size = 20 * 1024 * 1024 + 1;
        generation.images.push(image);
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video".into());

        let body = build_video_body(&video_task, &generation).expect("large image Wan body");
        assert_eq!(
            body["media"],
            json!([{"type": "first_frame", "url": "https://cdn.example.com/large.png"}])
        );
        generation.images[0].mime_type = "image/gif".into();
        assert!(build_video_body(&video_task, &generation).is_err());
    }

    #[test]
    fn wan_video_builder_accepts_document_file_and_link_media() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );

        // 文档文件（file）：解析公网文档内容生成视频。
        let mut file_generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "1080P", "ratio": "adaptive", "duration": 5 }),
        );
        file_generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "file",
            "https://example.com/public-doc.pdf",
            None,
        ));
        let mut file_task = task(GenerationOperation::VideoGeneration);
        file_task.remote_model_id_snapshot = Some("wan3.0-video".into());
        let file_body = build_video_body(&file_task, &file_generation).expect("Wan file body");
        assert_eq!(
            file_body["media"],
            json!([{ "type": "file", "url": "https://example.com/public-doc.pdf" }])
        );

        // 网页链接（link）：解析公网网页内容生成视频。
        let mut link_generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720P", "ratio": "16:9", "duration": -1 }),
        );
        link_generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "link",
            "https://example.com/public-article",
            None,
        ));
        let mut link_task = task(GenerationOperation::VideoGeneration);
        link_task.remote_model_id_snapshot = Some("wan3.0-video".into());
        let link_body = build_video_body(&link_task, &link_generation).expect("Wan link body");
        assert_eq!(
            link_body["media"],
            json!([{ "type": "link", "url": "https://example.com/public-article" }])
        );
    }

    #[test]
    fn wan_video_builder_rejects_document_media_mixed_with_other_inputs() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );

        // file 与 link 互斥。
        let mut mixed_generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "1080P", "ratio": "adaptive", "duration": 5 }),
        );
        mixed_generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "file",
            "https://example.com/public-doc.pdf",
            None,
        ));
        mixed_generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "link",
            "https://example.com/public-article",
            None,
        ));
        let mut mixed_task = task(GenerationOperation::VideoGeneration);
        mixed_task.remote_model_id_snapshot = Some("wan3.0-video".into());
        let error = build_video_body(&mixed_task, &mixed_generation)
            .expect_err("Wan file/link mixing must fail");
        assert!(error.to_string().contains("mutually exclusive"));

        // file/link 不与参考素材混用。
        let mut reference_generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "1080P", "ratio": "adaptive", "duration": 5 }),
        );
        reference_generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "link",
            "https://example.com/public-article",
            None,
        ));
        reference_generation.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/music.mp3",
            None,
        ));
        let mut reference_task = task(GenerationOperation::VideoGeneration);
        reference_task.remote_model_id_snapshot = Some("wan3.0-video".into());
        let error = build_video_body(&reference_task, &reference_generation)
            .expect_err("Wan document/link with references must fail");
        assert!(error.to_string().contains("cannot be mixed"));
    }

    #[test]
    fn veo_video_builder_uses_top_level_parameters_and_metadata_fields() {
        let schema = super::super::model_schema::default_model_schema(
            "veo-3.1-fast",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "1080p",
                "aspect_ratio": "16:9",
                "duration": 8,
                "sampleCount": 2,
                "enhancePrompt": true,
                "negativePrompt": "blurry, low quality"
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("veo-3.1-fast".into());

        let body = build_video_body(&video_task, &generation).expect("Veo video body");
        assert_eq!(body["model"], "veo-3.1-fast");
        assert_eq!(body["prompt"], "A train arrives");
        assert_eq!(body["resolution"], "1080p");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(body["duration"], 8);
        assert_eq!(body["metadata"]["negativePrompt"], "blurry, low quality");
        assert_eq!(body["metadata"]["sampleCount"], 2);
        assert_eq!(body["metadata"]["enhancePrompt"], true);
        assert!(body.get("images").is_none());
        // Veo 不携带 Seedance 的 metadata.content 协议。
        assert!(body["metadata"].get("content").is_none());
    }

    #[test]
    fn veo_video_builder_puts_reference_images_into_top_level_images_array() {
        let schema = super::super::model_schema::default_model_schema(
            "veo-3.1-fast",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "720p",
                "aspect_ratio": "9:16",
                "duration": 4,
                "sampleCount": 1,
                "enhancePrompt": true
            }),
        );
        generation.content = vec![
            CompiledContentItem::Text("The cat ".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text(" slowly turns its head".into()),
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/cat.jpg",
            Some(1),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("veo-3.1-fast".into());

        let body = build_video_body(&video_task, &generation).expect("Veo image body");
        assert_eq!(body["prompt"], "The cat 图片1 slowly turns its head");
        assert_eq!(body["images"], json!(["https://cdn.example.com/cat.jpg"]));
        assert_eq!(body["resolution"], "720p");
        assert_eq!(body["aspect_ratio"], "9:16");
        assert_eq!(body["duration"], 4);
        assert!(body["metadata"].get("content").is_none());
    }

    #[test]
    fn veo_video_builder_rejects_video_audio_and_non_public_image_references() {
        let schema = super::super::model_schema::default_model_schema(
            "veo-3.1-fast",
            &[GenerationOperation::VideoGeneration],
        );

        // 视频/音频素材不支持。
        let mut with_video = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720p", "aspect_ratio": "16:9", "duration": 8 }),
        );
        with_video.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/ref.mp4",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("veo-3.1-fast".into());
        let error = build_video_body(&video_task, &with_video).expect_err("Veo video must fail");
        assert!(
            error
                .to_string()
                .contains("only accepts image reference inputs")
        );

        // 图片引用必须是公网 http(s) URL（不支持 asset:// 或 base64 直传）。
        let mut with_asset = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720p", "aspect_ratio": "16:9", "duration": 8 }),
        );
        with_asset.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "asset://asset-20260902214334-t5rnj",
            Some(1),
        ));
        let mut asset_task = task(GenerationOperation::VideoGeneration);
        asset_task.remote_model_id_snapshot = Some("veo-3.1-fast".into());
        let error =
            build_video_body(&asset_task, &with_asset).expect_err("non-public image must fail");
        assert!(
            error
                .to_string()
                .contains("must reference a public http(s) URL")
        );
    }

    #[test]
    fn vidu_video_builder_uses_top_level_parameters_and_metadata_fields() {
        let schema = super::super::model_schema::default_model_schema(
            "viduq3-turbo",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "1080p",
                "aspect_ratio": "9:16",
                "duration": 8,
                "seed": 12345,
                "watermark": false,
                "movement_amplitude": "large",
                "style": "anime",
                "audio": false,
                "off_peak": true,
                "bgm": true
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("viduq3-turbo".into());

        let body = build_video_body(&video_task, &generation).expect("Vidu video body");
        assert_eq!(body["model"], "viduq3-turbo");
        assert_eq!(body["prompt"], "A train arrives");
        assert_eq!(body["resolution"], "1080p");
        assert_eq!(body["aspect_ratio"], "9:16");
        assert_eq!(body["duration"], 8);
        assert_eq!(body["seed"], 12345);
        assert_eq!(body["watermark"], false);
        // metadata 高级参数按 requestLocation 归入 metadata 对象。
        assert_eq!(body["metadata"]["movement_amplitude"], "large");
        assert_eq!(body["metadata"]["style"], "anime");
        assert_eq!(body["metadata"]["audio"], false);
        assert_eq!(body["metadata"]["off_peak"], true);
        assert_eq!(body["metadata"]["bgm"], true);
        // Vidu 不携带 Seedance 的 metadata.content 协议。
        assert!(body["metadata"].get("content").is_none());
        assert!(body.get("images").is_none());
    }

    #[test]
    fn vidu_video_builder_puts_reference_images_into_top_level_images_array() {
        let schema = super::super::model_schema::default_model_schema(
            "viduq3-turbo",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720p", "aspect_ratio": "16:9", "duration": 5 }),
        );
        generation.content = vec![
            CompiledContentItem::Text("The cat ".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text(" slowly turns its head".into()),
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/cat.jpg",
            Some(1),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA...",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("viduq3-turbo".into());

        let body = build_video_body(&video_task, &generation).expect("Vidu image body");
        assert_eq!(body["prompt"], "The cat 图片1 slowly turns its head");
        assert_eq!(
            body["images"],
            json!([
                "https://cdn.example.com/cat.jpg",
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA..."
            ])
        );
        assert_eq!(body["resolution"], "720p");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(body["duration"], 5);
        assert!(body["metadata"].get("content").is_none());
    }

    #[test]
    fn vidu_video_builder_rejects_video_and_audio_inputs() {
        let schema = super::super::model_schema::default_model_schema(
            "viduq3-turbo",
            &[GenerationOperation::VideoGeneration],
        );

        // 视频/音频素材不支持。
        let mut with_video = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720p", "aspect_ratio": "16:9", "duration": 5 }),
        );
        with_video.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/ref.mp4",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("viduq3-turbo".into());
        let error = build_video_body(&video_task, &with_video).expect_err("Vidu video must fail");
        assert!(
            error
                .to_string()
                .contains("only accepts image reference inputs")
        );

        let mut with_audio = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "720p", "aspect_ratio": "16:9", "duration": 5 }),
        );
        with_audio.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/ref.mp3",
            None,
        ));
        let mut audio_task = task(GenerationOperation::VideoGeneration);
        audio_task.remote_model_id_snapshot = Some("viduq3-turbo".into());
        let error = build_video_body(&audio_task, &with_audio).expect_err("Vidu audio must fail");
        assert!(
            error
                .to_string()
                .contains("only accepts image reference inputs")
        );
    }

    #[test]
    fn minimax_h3_builder_uses_top_level_parameters_and_metadata_fields() {
        let schema = super::super::model_schema::default_model_schema(
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "generation",
                "resolution": "2K",
                "ratio": "16:9",
                "duration": 8,
                "aigc_watermark": true
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("MiniMax-H3".into());

        let body = build_video_body(&video_task, &generation).expect("MiniMax-H3 video body");
        assert_eq!(body["model"], "MiniMax-H3");
        assert_eq!(body["prompt"], "A train arrives");
        // MiniMax-H3 文档：duration/resolution/ratio/aigc_watermark 均为顶层字段。
        assert_eq!(body["resolution"], "2K");
        assert_eq!(body["ratio"], "16:9");
        assert_eq!(body["duration"], 8);
        assert_eq!(body["aigc_watermark"], true);
        // metadata 只包含任务类型（无媒体时不生成媒体字段）。
        assert_eq!(body["metadata"]["task_type"], "generation");
        assert!(body["metadata"].get("first_frame_image").is_none());
        assert!(body["metadata"].get("reference_images").is_none());
        // 顶层参数不得重复出现在 metadata。
        assert!(body["metadata"].get("resolution").is_none());
        assert!(body["metadata"].get("duration").is_none());
        // task_type 只进 metadata，不留在顶层。
        assert!(body.get("task_type").is_none());
    }

    #[test]
    fn minimax_h3_builder_encodes_frame_and_reference_media() {
        let schema = super::super::model_schema::default_model_schema(
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "generation",
                "resolution": "2K",
                "ratio": "adaptive",
                "duration": 5,
                "aigc_watermark": false
            }),
        );
        // 首帧 + 尾帧 + 参考图 + 参考视频 + 参考音频（参考模式）。
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/ref1.png",
            Some(1),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "https://cdn.example.com/ref2.png",
            Some(2),
        ));
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/ref.mp4",
            Some(1),
        ));
        generation.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/ref.mp3",
            Some(1),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("MiniMax-H3".into());

        let body = build_video_body(&video_task, &generation).expect("MiniMax-H3 media body");
        assert_eq!(body["metadata"]["task_type"], "generation");
        assert_eq!(
            body["metadata"]["reference_images"],
            json!([
                "https://cdn.example.com/ref1.png",
                "https://cdn.example.com/ref2.png"
            ])
        );
        assert_eq!(
            body["metadata"]["reference_videos"],
            json!(["https://cdn.example.com/ref.mp4"])
        );
        assert_eq!(
            body["metadata"]["reference_audios"],
            json!(["https://cdn.example.com/ref.mp3"])
        );
        assert!(body["metadata"].get("first_frame_image").is_none());
        assert!(body["metadata"].get("last_frame_image").is_none());

        // 首帧/尾帧模式（独立使用，互不依赖）。
        let mut frame_generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "generation",
                "resolution": "768P",
                "ratio": "9:16",
                "duration": 5,
                "aigc_watermark": false
            }),
        );
        frame_generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/first.png",
            Some(1),
        ));
        frame_generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "last_frame",
            "https://cdn.example.com/last.png",
            Some(2),
        ));
        let mut frame_task = task(GenerationOperation::VideoGeneration);
        frame_task.remote_model_id_snapshot = Some("MiniMax-H3".into());

        let frame_body =
            build_video_body(&frame_task, &frame_generation).expect("MiniMax-H3 frame body");
        assert_eq!(
            frame_body["metadata"]["first_frame_image"],
            "https://cdn.example.com/first.png"
        );
        assert_eq!(
            frame_body["metadata"]["last_frame_image"],
            "https://cdn.example.com/last.png"
        );
        assert!(frame_body["metadata"].get("reference_images").is_none());
    }

    #[test]
    fn minimax_h3_builder_rejects_mixed_frame_and_reference_inputs() {
        let schema = super::super::model_schema::default_model_schema(
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "generation",
                "resolution": "2K",
                "ratio": "adaptive",
                "duration": 5,
                "aigc_watermark": false
            }),
        );
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/first.png",
            Some(1),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "https://cdn.example.com/ref.png",
            Some(2),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("MiniMax-H3".into());
        let error = build_video_body(&video_task, &generation)
            .expect_err("Mixed frame and reference must fail");
        assert!(
            error
                .to_string()
                .contains("frame inputs and reference inputs cannot be mixed")
        );

        // 角色与素材类型不匹配。
        let mut wrong_role = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "generation",
                "resolution": "2K",
                "ratio": "adaptive",
                "duration": 5,
                "aigc_watermark": false
            }),
        );
        wrong_role.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_image",
            "https://cdn.example.com/ref.mp3",
            None,
        ));
        let mut audio_task = task(GenerationOperation::VideoGeneration);
        audio_task.remote_model_id_snapshot = Some("MiniMax-H3".into());
        let error =
            build_video_body(&audio_task, &wrong_role).expect_err("Role/type mismatch must fail");
        assert!(
            error
                .to_string()
                .contains("incompatible with the resolved media type")
        );
    }

    #[test]
    fn minimax_h3_builder_regeneration_uses_base_video_url_and_omits_duration() {
        let schema = super::super::model_schema::default_model_schema(
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "regeneration",
                "resolution": "2K",
                "ratio": "adaptive",
                "duration": 8,
                "aigc_watermark": false
            }),
        );
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/source.mp4",
            Some(1),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("MiniMax-H3".into());

        let body = build_video_body(&video_task, &generation).expect("MiniMax-H3 regen body");
        assert_eq!(body["metadata"]["task_type"], "regeneration");
        assert_eq!(
            body["metadata"]["base_video_url"],
            "https://cdn.example.com/source.mp4"
        );
        // regeneration 输出时长由源视频决定，不发送 duration。
        assert!(body.get("duration").is_none());
        assert!(body["metadata"].get("reference_videos").is_none());

        // 缺少源视频时拒绝。
        let empty = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "regeneration",
                "resolution": "2K",
                "ratio": "adaptive",
                "duration": 8,
                "aigc_watermark": false
            }),
        );
        let mut empty_task = task(GenerationOperation::VideoGeneration);
        empty_task.remote_model_id_snapshot = Some("MiniMax-H3".into());
        let error = build_video_body(&empty_task, &empty).expect_err("Regeneration must fail");
        assert!(
            error
                .to_string()
                .contains("requires exactly one source video input")
        );
    }

    #[test]
    fn minimax_h3_builder_context_ir_omits_resolution_and_maps_reference_media() {
        let schema = super::super::model_schema::default_model_schema(
            "MiniMax-H3",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "task_type": "h3_context_ir",
                "resolution": "2K",
                "ratio": "21:9",
                "duration": 12,
                "aigc_watermark": true
            }),
        );
        generation.videos.push(resolved_media(
            MediaType::Video,
            1,
            "reference_video",
            "https://cdn.example.com/clip.mp4",
            Some(1),
        ));
        generation.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/music.mp3",
            Some(2),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("MiniMax-H3".into());

        let body = build_video_body(&video_task, &generation).expect("MiniMax-H3 Context-IR body");
        assert_eq!(body["metadata"]["task_type"], "h3_context_ir");
        // Context-IR 不接受 resolution（文档说明传了也会被忽略），请求体不应携带。
        assert!(body.get("resolution").is_none());
        // 可传 duration/ratio 影响扩写。
        assert_eq!(body["duration"], 12);
        assert_eq!(body["ratio"], "21:9");
        assert_eq!(body["aigc_watermark"], true);
        assert_eq!(
            body["metadata"]["reference_videos"],
            json!(["https://cdn.example.com/clip.mp4"])
        );
        assert_eq!(
            body["metadata"]["reference_audios"],
            json!(["https://cdn.example.com/music.mp3"])
        );

        // Context-IR 不接受图片输入。
        let mut with_image = resolved(
            schema["video_generation"].clone(),
            json!({ "task_type": "h3_context_ir" }),
        );
        with_image.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/shot.png",
            Some(1),
        ));
        let mut image_task = task(GenerationOperation::VideoGeneration);
        image_task.remote_model_id_snapshot = Some("MiniMax-H3".into());
        let error =
            build_video_body(&image_task, &with_image).expect_err("Context-IR must reject images");
        assert!(
            error.to_string().contains("does not accept image inputs"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn video_observation_extracts_context_ir_text_from_task_content_prompt() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "message": "",
                "data": {
                    "task_id": "435194938720659",
                    "action": "generate",
                    "status": "SUCCESS",
                    "fail_reason": "",
                    "progress": "100%",
                    "data": {
                        "task": {
                            "id": "435194938720659",
                            "model": "MiniMax-H3",
                            "status": "succeeded",
                            "modality": "text",
                            "task_type": "h3_context_ir",
                            "content": {
                                "prompt": "清晨的城市天际线，金色朝阳……（智能扩写后的完整提示词）"
                            }
                        }
                    }
                }
            })
            .to_string(),
        };
        let observation = parse_video_observation(&response).expect("Context-IR observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        // Context-IR 无 result_url，扩写文本在透传层 content.prompt。
        assert_eq!(observation.video_url, None);
        assert_eq!(
            observation.text_content.as_deref(),
            Some("清晨的城市天际线，金色朝阳……（智能扩写后的完整提示词）")
        );
    }

    #[test]
    fn video_observe_path_supports_model_declared_paths() {
        // 默认路径：/v1/video/generations/{task_id}。
        assert_eq!(
            video_observe_path_from_schema(None, "task_abc").expect("default path"),
            "/v1/video/generations/task_abc"
        );
        // 模型声明 observePath（Vidu 系列）。
        let schema = super::super::model_schema::default_model_schema(
            "viduq3-pro",
            &[GenerationOperation::VideoGeneration],
        );
        assert_eq!(
            video_observe_path_from_schema(Some(&schema["video_generation"]), "task_vidu")
                .expect("vidu path"),
            "/v1/videos/task_vidu"
        );
        // 无该字段时回退默认路径。
        let generic = json!({
            "video_generation": {
                "request": { "path": "/v1/video/generations" }
            }
        });
        assert_eq!(
            video_observe_path_from_schema(Some(&generic["video_generation"]), "task_gen")
                .expect("generic path"),
            "/v1/video/generations/task_gen"
        );
    }

    #[test]
    fn veo_video_builder_rejects_1080p_with_non_8_duration() {
        let schema = super::super::model_schema::default_model_schema(
            "veo-3.1-fast",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "1080p",
                "aspect_ratio": "16:9",
                "duration": 4,
                "sampleCount": 1,
                "enhancePrompt": true
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("veo-3.1-fast".into());
        let error = build_video_body(&video_task, &generation)
            .expect_err("Veo 1080p with non-8 duration must fail");
        assert!(
            error
                .to_string()
                .contains("requires a duration of 8 seconds")
        );
    }

    #[test]
    fn wan_video_builder_rejects_non_public_document_references() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({ "resolution": "1080P", "ratio": "adaptive", "duration": 5 }),
        );
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "link",
            "asset://asset-20260902214334-t5rnj",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video".into());
        let error = build_video_body(&video_task, &generation)
            .expect_err("Wan non-public document reference must fail");
        assert!(error.to_string().contains("public http(s) URL"));
    }

    #[test]
    fn request_path_rejects_cross_origin_and_query_like_values() {
        assert!(
            request_path(
                &json!({ "request": { "path": "https://evil.test/x" } }),
                "/v1/x"
            )
            .is_err()
        );
        assert!(
            request_path(&json!({ "request": { "path": "/v1/x?secret=1" } }), "/v1/x").is_err()
        );
        assert_eq!(
            request_path(
                &json!({ "request": { "path": "/custom/generate" } }),
                "/v1/x"
            )
            .unwrap(),
            "/custom/generate"
        );
    }

    #[test]
    fn signed_query_is_removed_from_archived_requests() {
        let value = json!({
            "url": "https://user:password@tos.example/file.png?X-Tos-Signature=secret&x=1",
            "prompt": "keep me"
        });
        let redacted = redact_request_value(&value);
        assert_eq!(redacted["url"], "https://tos.example/file.png");
        assert_eq!(redacted["prompt"], "keep me");
    }

    #[test]
    fn token_usage_accepts_openai_anthropic_and_gemini_shapes() {
        let usage_for = |body: Value| {
            parse_token_usage(&CapturedHttpResponse {
                call_id: "test-call".into(),
                status: 200,
                headers: json!({}),
                body: body.to_string(),
            })
            .expect("token usage")
        };

        let openai = usage_for(json!({
            "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 }
        }));
        assert_eq!(openai.prompt_tokens, Some(11));
        assert_eq!(openai.completion_tokens, Some(7));
        assert_eq!(openai.total_tokens, Some(18));

        let anthropic = usage_for(json!({
            "usage": { "input_tokens": 13, "output_tokens": 5 }
        }));
        assert_eq!(anthropic.prompt_tokens, Some(13));
        assert_eq!(anthropic.completion_tokens, Some(5));
        assert_eq!(anthropic.total_tokens, Some(18));

        let gemini = usage_for(json!({
            "usageMetadata": {
                "promptTokenCount": 17,
                "candidatesTokenCount": 3,
                "totalTokenCount": 20
            }
        }));
        assert_eq!(gemini.prompt_tokens, Some(17));
        assert_eq!(gemini.completion_tokens, Some(3));
        assert_eq!(gemini.total_tokens, Some(20));
    }

    #[test]
    fn token_usage_extracts_from_deeply_nested_magateway_video_poll() {
        // 回归：MAGateway/Seedance 视频轮询响应的 usage 位于
        // `data.data.data.data.usage`，此前只探测更浅层级导致用量从未被记录。
        let tokens = parse_token_usage(&CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "data": {
                    "task_id": "task_tdKuphY1aWjLG3jVtZMkCoNFLMfFL6xN",
                    "status": "SUCCESS",
                    "progress": "100%",
                    "data": {
                        "code": "success",
                        "data": {
                            "action": "generate",
                            "data": {
                                "content": { "video_url": "https://cdn.example.com/video.mp4" },
                                "status": "succeeded",
                                "usage": {
                                    "completion_tokens": 87300,
                                    "total_tokens": 87300
                                }
                            },
                            "result_url": "https://cdn.example.com/video.mp4",
                            "status": "SUCCESS"
                        },
                        "message": ""
                    }
                }
            })
            .to_string(),
        })
        .expect("token usage");

        assert_eq!(tokens.completion_tokens, Some(87300));
        assert_eq!(tokens.total_tokens, Some(87300));
    }

    #[test]
    fn image_parser_accepts_url_or_base64_and_prefers_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": [
                    { "url": "https://example.com/a.png", "b64_json": "ignored" },
                    { "b64_json": "kept" }
                ]
            })
            .to_string(),
        };
        let GenerationSubmission::Images(images) =
            parse_image_submission(&response, false).expect("images")
        else {
            panic!("expected images");
        };
        assert!(matches!(images[0], ImageSource::Url { .. }));
        assert!(matches!(images[1], ImageSource::Base64 { .. }));
    }

    #[test]
    fn image_parser_extracts_seedream_layer_metadata() {
        // Seedream 5.0 pro 图层拆分：data 数组每项携带 z_index/name/description/bounding_box，
        // 解析后应保留在 ImageSource.layer 中，供前端把每个图层单独落为可编辑对象。
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": [
                    {
                        "url": "https://example.com/base.png",
                        "z_index": 0,
                        "name": "底图",
                        "description": "完整合成画面",
                        "bounding_box": { "x": 0, "y": 0, "width": 2048, "height": 2048 }
                    },
                    {
                        "url": "https://example.com/layer1.png",
                        "z_index": 1,
                        "name": "人物",
                        "description": "前景人物主体"
                    },
                    {
                        "url": "https://example.com/plain.png"
                    }
                ]
            })
            .to_string(),
        };
        let GenerationSubmission::Images(images) =
            parse_image_submission(&response, false).expect("images")
        else {
            panic!("expected images");
        };
        assert_eq!(images.len(), 3);
        // 底图：z_index=0，name/description/bounding_box 齐全。
        match &images[0] {
            ImageSource::Url { url, layer } => {
                assert_eq!(url, "https://example.com/base.png");
                let layer = layer.as_ref().expect("base layer metadata");
                assert_eq!(layer.z_index, 0);
                assert_eq!(layer.name.as_deref(), Some("底图"));
                assert_eq!(layer.description.as_deref(), Some("完整合成画面"));
                assert!(layer.bounding_box.is_some());
            }
            _ => panic!("expected url source"),
        }
        // 图层 1：z_index=1，无 bounding_box。
        match &images[1] {
            ImageSource::Url { layer, .. } => {
                let layer = layer.as_ref().expect("layer 1 metadata");
                assert_eq!(layer.z_index, 1);
                assert_eq!(layer.name.as_deref(), Some("人物"));
                assert!(layer.bounding_box.is_none());
            }
            _ => panic!("expected url source"),
        }
        // 普通结果：无 z_index，layer 为 None。
        match &images[2] {
            ImageSource::Url { layer, .. } => {
                assert!(layer.is_none());
            }
            _ => panic!("expected url source"),
        }
    }

    #[test]
    fn video_submission_accepts_wan_top_level_id() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({ "id": "wan-task-1", "status": "queued" }).to_string(),
        };
        assert_eq!(parse_video_task_id(&response).unwrap(), "wan-task-1");
    }

    #[test]
    fn video_observation_accepts_percent_progress_and_metadata_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "completed",
                    "progress": "30%",
                    "metadata": { "url": "https://cdn.example.com/video.mp4" }
                }
            })
            .to_string(),
        };
        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "completed");
        assert_eq!(observation.progress, Some(30.0));
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
    }

    #[test]
    fn video_observation_accepts_wan_result_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "data": {
                    "status": "SUCCESS",
                    "progress": "100%",
                    "result_url": "https://cdn.example.com/wan.mp4",
                    "fail_reason": ""
                }
            })
            .to_string(),
        };
        let observation = parse_video_observation(&response).expect("Wan observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(observation.progress, Some(100.0));
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/wan.mp4")
        );
        assert_eq!(observation.failure, None);
    }

    #[test]
    fn successful_video_observation_ignores_misplaced_url_in_fail_reason() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "SUCCESS",
                    "fail_reason": "https://cdn.example.com/video.mp4",
                    "data": {
                        "data": {
                            "content": {
                                "video_url": "https://cdn.example.com/video.mp4"
                            }
                        }
                    }
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
        assert_eq!(observation.failure, None);
    }

    #[test]
    fn successful_video_observation_without_result_url_yields_no_video_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "data": {
                    "status": "SUCCESS",
                    "progress": "100%",
                    "result_url": "",
                    "data": {
                        "content": { "video_url": "" }
                    }
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(observation.video_url, None);
    }

    #[test]
    fn video_observation_extracts_url_from_deeply_nested_magateway_response() {
        // 回归：MAGateway/Seedance 轮询成功响应将产物 URL 嵌套在
        // `data.data.data.result_url` 与 `data.data.data.data.content.video_url`，
        // 此前解析器只探测更浅的层级导致 video_url 丢失、视频无法落盘
        // （交付包报「successful video task has no video_url」）。
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "message": "",
                "data": {
                    "task_id": "task_tdKuphY1aWjLG3jVtZMkCoNFLMfFL6xN",
                    "action": "generate",
                    "status": "SUCCESS",
                    "fail_reason": "https://cdn.example.com/red-herring.mp4",
                    "submit_time": 1788489112,
                    "start_time": 1788489118,
                    "finish_time": 1788489292,
                    "progress": "100%",
                    "data": {
                        "code": "success",
                        "data": {
                            "action": "generate",
                            "data": {
                                "cgtId": "cgt-20260904103155-x9bkq",
                                "content": {
                                    "video_url": "https://cdn.example.com/video.mp4"
                                },
                                "created_at": 1788489115,
                                "draft": false,
                                "duration": 4,
                                "execution_expires_after": 172800,
                                "framespersecond": 24,
                                "generate_audio": true,
                                "id": "task_tdKuphY1aWjLG3jVtZMkCoNFLMfFL6xN",
                                "model": "Seedance2.0",
                                "ratio": "16:9",
                                "resolution": "720p",
                                "seed": 19695,
                                "service_tier": "default",
                                "status": "succeeded",
                                "updated_at": 1788489264,
                                "usage": {
                                    "completion_tokens": 87300,
                                    "total_tokens": 87300
                                }
                            },
                            "fail_reason": "",
                            "finish_time": 1788489289,
                            "progress": "100%",
                            "result_url": "https://cdn.example.com/video.mp4",
                            "start_time": 1788489116,
                            "status": "SUCCESS",
                            "submit_time": 1788489112,
                            "task_id": "task_tdKuphY1aWjLG3jVtZMkCoNFLMfFL6xN"
                        },
                        "message": ""
                    }
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("MAGateway observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(observation.progress, Some(100.0));
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
        assert_eq!(observation.failure, None);
    }

    #[test]
    fn video_observation_extracts_url_from_json_string_content() {
        // 回归：content 以 JSON 字符串（而非对象）返回时也能提取 video_url。
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "data": {
                    "status": "SUCCESS",
                    "progress": "100%",
                    "data": {
                        "data": {
                            "data": {
                                "content": "{\"video_url\":\"https://cdn.example.com/video.mp4\"}"
                            }
                        }
                    }
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
    }

    #[test]
    fn failed_video_observation_preserves_fail_reason() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "FAILED",
                    "fail_reason": "content policy rejection"
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(
            observation.failure,
            Some(json!({
                "failReason": "content policy rejection",
                "upstreamError": null
            }))
        );
    }
}
