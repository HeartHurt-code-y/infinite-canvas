use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::{Arc, Mutex},
};

use base64::Engine as _;
use chrono::Utc;
use futures_util::{Stream, StreamExt as _};
use reqwest::{Method, multipart};
use serde_json::{Map, Value, json};
use tauri_plugin_log::log::{error, info, warn};
use url::Url;
use uuid::Uuid;

mod fzy;
mod pixverse;

use self::pixverse::{build_pixverse_video_body, parse_pixverse_video_task_id};

use super::{
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    gateway_profile::GatewayProfile,
    model_schema::{
        ATLASCLOUD_FLUX3_IMAGE_MODEL, ATLASCLOUD_GROK_IMAGE_EDIT_MODEL, ATLASCLOUD_IMAGE_PROFILE,
        ATLASCLOUD_KLING_VIDEO_MAX_IMAGES, ATLASCLOUD_KLING_VIDEO_MAX_PROMPT_CHARS,
        ATLASCLOUD_KLING_VIDEO_MAX_PROMPT_CHARS_NON_ASCII, ATLASCLOUD_KLING_VIDEO_MAX_VIDEOS,
        ATLASCLOUD_KLING_VIDEO_MODEL, ATLASCLOUD_MIDJOURNEY_IMAGE_MODEL,
        ATLASCLOUD_QWEN_IMAGE_MODEL, ATLASCLOUD_VIDU_VIDEO_MODEL, FZY_IMAGE_OBSERVE_TEMPLATE,
        FZY_IMAGE_PROFILE, GATEWAY_TTS_PATH, GATEWAY_TTS_REQUEST_PROFILE, GRSAI_IMAGE_PROFILE,
        RequestDialect, apply_request_dialect, default_model_schema, grsai_pixel_dimensions,
        infer_catalog_schema, is_atlascloud_flux3_image_model, is_atlascloud_kling_video_model,
        is_atlascloud_midjourney_image_model, is_atlascloud_qwen_image_model,
        is_atlascloud_registered_image_model, is_atlascloud_vidu_video_model,
        is_gateway_tts_model, is_grsai_pixel_image_model, is_pixverse_video_model,
        is_seedance_25_video_model, is_seedance_draft_video_model, operations_from_schema,
        provider_scoped_model_definition_id, schema_for_enabled_operations,
    },
    prompt_optimize::{TextModelFallbackRequest, TextModelStream},
    provider_adapter::{
        self, ARK_ADAPTER_ID, ATLASCLOUD_ADAPTER_ID, FZY_ADAPTER_ID, ProviderAdapterKind,
        catalog_path_for_adapter, extra_headers_for_adapter, finalize_video_body,
    },
    speech::{
        GatewayTtsReply, MAX_GATEWAY_ERROR_BYTES, MAX_SPEECH_RESPONSE_BYTES, SpeechAudioConfig,
        SpeechWire, collect_capped, encode_gateway_reference_audio, gateway_audio_plan,
        gateway_request_body, parse_gateway_tts_reply, resolve_speech_binding,
        response_holds_audio, validate_gateway_speaker,
    },
    storage::{
        GenerationLifecycleFact, GenerationTaskLifecycle, Storage, TaskExecutionRecord, now_ms,
    },
    types::{
        ConnectivityTestResult, GenerationOperation, MediaType, RawProviderResponse,
        RemoteModelOption, TokenUsage, VideoTaskType,
    },
    volcengine_ark::{self, ArkCredentials},
};

/// 历史全局素材库令牌引用；仅用于兼容旧版本凭据。
///
/// 新版本优先使用 `asset-library-token:{provider_connection_id}`，避免不同
/// Base URL 共用凭据。未配置供应商专用令牌时才回退到本引用。
pub const ASSET_LIBRARY_CREDENTIAL_REF: &str = "asset-library-token";

/// 模型目录路径：由适配器决定。连通性测试与「拉取模型」共用本函数，避免两处各写一份后漂移。
fn model_catalog_path(adapter_id: &str) -> &'static str {
    catalog_path_for_adapter(adapter_id)
}

/// 没有云端素材库的上游主机（小写、不含端口）。
///
/// Seedance 2.5 RD 网关只有免费的 `POST /v1/assets/uploads` 素材上传（生成输入
/// 中转用），没有素材库浏览/导入接口，不作为素材库来源。
/// 素材库请求在解析阶段就按主机挡掉，避免把上游 404 原样当成「素材库故障」展示；
/// 判定口径与前端 `src/lib/assetLibrarySupport.ts` 保持一致。
/// 实测记录见 `docs/integrations/rd-video-api.md`。
const HOSTS_WITHOUT_ASSET_LIBRARY: [&str; 2] = ["101.34.211.152", "maas.aliyuncs.com"];

/// 提交请求「剥离不认识字段后重发」的最大轮数。gpt-image-2.5 系在只讲 OpenAI
/// images 契约的网关上会被先后拒绝 `aspect_ratio`、`resolution` 两轮，留出余量
/// 覆盖更多自定义参数；被点名的字段每轮都会真正从请求体删除，循环必然收敛。
const MAX_STRIP_RESEND_ROUNDS: usize = 4;

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

fn provider_connection_id_from_api_key_ref(credential_ref: &str) -> Option<&str> {
    let rest = credential_ref.strip_prefix("provider:")?;
    let id = rest.strip_suffix(":api-key")?;
    (!id.is_empty()).then_some(id)
}

/// 用户在配置页更换供应商主 API Key 时，若尚未单独配置素材库令牌，把旧 Key 快照到
/// 供应商专用素材库凭据。素材库按令牌命名空间隔离：直接覆盖主 Key 会让云端库看起来被清空。
pub(super) fn preserve_asset_library_token_when_replacing_provider_key(
    credentials: &CredentialStore,
    credential_ref: &str,
    new_secret: &str,
) -> BackendResult<()> {
    let Some(provider_id) = provider_connection_id_from_api_key_ref(credential_ref) else {
        return Ok(());
    };
    let dedicated = asset_library_credential_ref(provider_id);
    if credentials.status(&dedicated)?.configured
        || credentials.status(ASSET_LIBRARY_CREDENTIAL_REF)?.configured
    {
        return Ok(());
    }
    match credentials.get(credential_ref) {
        Ok(previous) if previous != new_secret => credentials.set(&dedicated, &previous),
        Ok(_) => Ok(()),
        Err(BackendError::NotFound(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

#[derive(Clone)]
pub struct ProviderRuntime {
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    credentials: CredentialStore,
    client: reqwest::Client,
    /// 流式文本调用专用客户端：不带总时限，存活性由首字节与块间空闲两个看门狗
    /// 守护（见 `ProviderRuntime::new`）。
    stream_client: reqwest::Client,
    /// 进程内记忆：上游以 4xx 明确点名「不认识这个字段」的请求字段，按
    /// 「模型定义 + 操作」分桶。命中后请求体不再携带该字段，避免同一模型每次生成都
    /// 先用一个注定失败的请求试一次。
    ///
    /// 持久层的对应修复是模型契约本身（例如 gpt-image 系列不再声明
    /// `response_format`，见 `model_schema::refresh_legacy_image_parameter_defaults`）；
    /// 这一层只兜住「供应商下发的自定义契约」与「以后新增字段」两类，因此不落库：
    /// 契约改了才是权威，进程内记忆只负责当次运行不再重复踩同一个坑。
    rejected_request_fields: Arc<Mutex<BTreeMap<String, BTreeSet<String>>>>,
}

#[derive(Clone)]
pub struct ResolvedProviderContext {
    pub provider_connection_id: String,
    pub adapter_id: String,
    pub base_url: String,
    pub api_key_ref: String,
    pub(crate) api_key: String,
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
    /// `POST /v1/images/generations` 返回 202 和任务号，图片还要再查。
    RemoteImageTask {
        task_id: String,
    },
    RemoteVideoTask {
        task_id: String,
    },
    /// 语音合成是同步返回：响应体直接是音频二进制，没有远程任务号，也没有
    /// 可轮询的第二跳。字节在提交阶段就拿到了，保存阶段只负责落盘。
    Audio {
        bytes: Vec<u8>,
        mime_type: String,
        extension: String,
    },
}

#[derive(Debug, Clone)]
pub struct GenerationObservation {
    pub remote_status: String,
    pub progress: Option<f64>,
    pub video_url: Option<String>,
    /// Context-IR（h3_context_ir）任务产出的是扩写文本，位于查询响应的
    /// `data.data.task.content.prompt`；视频任务此字段为 None。
    pub text_content: Option<String>,
    /// 异步图片任务完成时的产物。视频观察此字段为空。
    pub images: Vec<ImageSource>,
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
/// 流式响应的块间空闲上限。正常增量通常毫秒级到达；部分网关在正文（甚至
/// `finish_reason`）已经发完后仍不关闭连接、也不再推 `[DONE]` / usage，这时
/// 已组装出可交付结果就回收，而不是把整轮生成判失败。
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// 非流式文本调用的总时限（响应头 + 完整响应体）。非流式响应没有块间空闲可观测，
/// 只能用总时限兜底「收了响应头却迟迟不给正文」的网关；但不支持流式的网关要等
/// 上游全部生成完才回传，长文本生成合法地超过 5 分钟，因此比 JSON 接口的
/// 客户端默认值（300 秒）宽松。流式调用不走这条时限，见 `stream_client`。
const NON_STREAM_TEXT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
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
    fn push<D: DialectSink + ?Sized>(
        &mut self,
        chunk: &[u8],
        dialect: &mut D,
        sink: &mut StreamSink<'_>,
    ) {
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
    fn accept_frame<D: DialectSink + ?Sized>(
        &mut self,
        frame: &str,
        dialect: &mut D,
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

    /// 连接结束或空闲超时时，把没有空行结尾的最后一帧也送进方言。
    ///
    /// 不少聚合网关会在最后一个 `data:` 事件后既不补 `\n\n` 也不关连接；若不冲掉
    /// 残余缓冲，已经到达的终态帧（`finish_reason` / 最后一段正文）会被直接丢掉。
    fn flush_pending<D: DialectSink + ?Sized>(
        &mut self,
        dialect: &mut D,
        sink: &mut StreamSink<'_>,
    ) {
        if self.buffer.is_empty() {
            return;
        }
        let frame = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        self.accept_frame(&frame, dialect, sink);
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

/// SSE 字节流的读取统计。`stalled` 表示块间空闲超时，不等于「没有可用结果」。
struct SseReadStats {
    transcript: String,
    chunks: usize,
    bytes: usize,
    stalled: bool,
}

/// 按空闲超时逐块读取 SSE 正文。连接正常关闭时 `stalled = false`；超过空闲上限仍
/// 没有下一字节时 `stalled = true`，由调用方决定是回收已组装内容还是报协议错误。
async fn consume_sse_stream<S, B, E, D>(
    mut stream: S,
    idle_timeout: std::time::Duration,
    parser: &mut SseFrameParser,
    dialect: &mut D,
    sink: &mut StreamSink<'_>,
) -> Result<SseReadStats, E>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    D: DialectSink + ?Sized,
{
    let mut transcript = String::new();
    let mut chunks = 0usize;
    let mut bytes = 0usize;
    loop {
        let next = tokio::time::timeout(idle_timeout, stream.next()).await;
        let item = match next {
            Ok(Some(item)) => item,
            Ok(None) => {
                return Ok(SseReadStats {
                    transcript,
                    chunks,
                    bytes,
                    stalled: false,
                });
            }
            Err(_) => {
                return Ok(SseReadStats {
                    transcript,
                    chunks,
                    bytes,
                    stalled: true,
                });
            }
        };
        let chunk = item?;
        let chunk = chunk.as_ref();
        chunks += 1;
        bytes += chunk.len();
        transcript.push_str(&String::from_utf8_lossy(chunk));
        parser.push(chunk, dialect, sink);
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

/// 判定一次 `request.send()` 的失败是否属于「请求根本没送达上游」。
///
/// 只认**连接层**失败：DNS 解析失败、连接被拒、TLS 握手失败（reqwest 的
/// `is_connect`，它会沿 source 链找到 hyper 的 `ErrorKind::Connect`），以及请求
/// 压根没构造出来（`is_builder`）。这些失败发生在任何请求字节离开本机之前，
/// 供应商不可能收到、更不可能计费。
///
/// 刻意**不**包含：响应体读取失败、4xx / 5xx、首个响应头超时、请求总时限超时。
/// 这些都发生在连接建立之后 —— 请求可能已经到达供应商并开始计费，守卫必须继续
/// 把它们算作「已发出」。宁可把「可能已送达」多算成一次已送达（挡住重复提交，
/// 用户去查原任务即可），也不能少算（放过重复提交 = 双倍扣费）。
fn is_dispatch_failure(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_builder()
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

/// 空闲超时后是否已经拿到可交付结果：有正文，或上游已经给出终态原因。
/// 只有思维链、或只有 keep-alive 注释时不能回收，那仍然是真正的中断。
fn streamed_response_is_usable(payload: &Value, deliverable_text: &str) -> bool {
    if !deliverable_text.trim().is_empty() {
        return true;
    }
    if payload_has_deliverable_text(payload) {
        return true;
    }
    payload_has_terminal_reason(payload)
}

fn payload_has_deliverable_text(payload: &Value) -> bool {
    if payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return true;
    }
    if payload
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return true;
    }
    payload
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                part.get("thought").and_then(Value::as_bool) != Some(true)
                    && part
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
            })
        })
}

fn payload_has_terminal_reason(payload: &Value) -> bool {
    [
        "/choices/0/finish_reason",
        "/stop_reason",
        "/candidates/0/finishReason",
    ]
    .into_iter()
    .any(|path| {
        payload
            .pointer(path)
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.is_empty())
    })
}

fn mark_stream_stalled(payload: &mut Value, chunks: usize, bytes: usize) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let diagnostics = object.entry("x_stream").or_insert_with(|| json!({}));
    if let Some(stream) = diagnostics.as_object_mut() {
        stream.insert("stalled".to_string(), json!(true));
        stream.insert("receivedChunks".to_string(), json!(chunks));
        stream.insert("receivedBytes".to_string(), json!(bytes));
    }
}

/// 流结束（正常关闭或空闲超时）后的收尾：冲掉没有空行结尾的最后一帧，必要时把
/// 完整 JSON 退化响应接进来。空闲超时且没有任何可交付结果时返回 `Err(())`。
fn finalize_streamed_text_payload(
    mut parser: SseFrameParser,
    dialect: &mut dyn SseDialect,
    sink: &mut StreamSink<'_>,
    status: u16,
    stats: &SseReadStats,
    task_id: &str,
    call_id: &str,
) -> Result<Value, ()> {
    let transcript = &stats.transcript;
    parser.flush_pending(dialect, sink);
    let deliverable = dialect.text().to_string();
    let mut payload = parser.assemble(dialect);
    if (200..300).contains(&status)
        && payload.pointer("/x_stream/frames").and_then(Value::as_u64) == Some(0)
        && let Some(complete) = parse_complete_json_payload(transcript)
    {
        info!(
            "[provider] 上游未按 SSE 回传，改用完整 JSON 响应: taskId={task_id}, callId={call_id}"
        );
        payload = complete;
    }
    if stats.stalled {
        if !(200..300).contains(&status) || !streamed_response_is_usable(&payload, &deliverable) {
            return Err(());
        }
        mark_stream_stalled(&mut payload, stats.chunks, stats.bytes);
    }
    Ok(payload)
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
            // 禁止自动跟随重定向：307/308 会**保留方法与请求体**重发，而请求体里
            // 带着提示词与内联 base64 素材。reqwest 只剥离跨域的 Authorization，
            // 不剥离请求体——被劫持或恶意的上游就能把用户内容整份投递到第三方主机。
            // 本仓库的其它客户端（speech / staging / video_edit_source /
            // resource_update / mac_delta_update）都已显式禁用，这里保持一致。
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        // 流式响应不能套总时限：reqwest 的 `.timeout()` 覆盖「发请求到响应体读完」
        // 全程，健康的生成（长上下文规划、长正文输出）合法地超过任何固定上限，会被
        // 硬杀成 `Decode(Body(TimedOut))`。流式的存活性由调用方的两个看门狗守护：
        // FIRST_BYTE_TIMEOUT 限响应头，STREAM_IDLE_TIMEOUT 限块间空闲，正常增量
        // 之间不该有秒级以上的间隙，不需要总时限兜底。
        let stream_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .user_agent("InfiniteCanvas/0.1")
            // 与主客户端同样禁用自动跟随重定向：流式请求的请求体里带着完整提示词
            // 与内联 base64 素材，307/308 会保留方法与请求体重发到跳转目标。
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            storage,
            lifecycle,
            credentials,
            client,
            stream_client,
            rejected_request_fields: Arc::new(Mutex::new(BTreeMap::new())),
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
        let kind = ProviderAdapterKind::require(&adapter_id)?;
        validate_base_url(&base_url)?;
        let base_url = kind.normalize_base_url(base_url)?;
        // ark 连接的主 API Key 允许缺失：素材请求全部走 asset-library 作用域的
        // AK/SK 凭据（`resolve_asset_library` 会覆盖 api_key）；ark 连接不参与
        // Bearer 鉴权的生成路径，空主密钥不会泄漏到任何请求头。
        let api_key = if kind.allows_empty_credential() {
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
        if ProviderAdapterKind::parse(&context.adapter_id)
            .is_some_and(|kind| !kind.supports_asset_library())
        {
            return Err(BackendError::Conflict(format!(
                "供应商连接 {} 未接入云端素材库；素材请使用本地素材库或本地生成结果。",
                context.provider_connection_id
            )));
        }
        if let Some(host) = host_without_asset_library(&context.base_url) {
            return Err(BackendError::Conflict(format!(
                "供应商连接 {}（{host}）没有云端素材库：该网关未开放素材库浏览接口\
                 （RD 网关仅有生成输入用的素材上传）；素材请使用本地素材库或本地生成结果。",
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
                let body = if resolved.operation_schema["requestProfileId"] == FZY_IMAGE_PROFILE {
                    build_fzy_image_body(task, resolved)?
                } else if resolved.operation_schema["requestProfileId"] == GRSAI_IMAGE_PROFILE {
                    build_grsai_image_body(task, resolved)?
                } else if resolved.operation_schema["requestProfileId"] == ATLASCLOUD_IMAGE_PROFILE
                {
                    build_atlascloud_image_body(task, resolved)?
                } else {
                    build_text_to_image_body(task, resolved)?
                };
                let path = request_path(&resolved.operation_schema, "/v1/images/generations")?;
                // 通用网关的付费提交：按提交阶段统一判定「回执是否不明确」。
                // 失败不再被任务层自动重发，避免同一份付费请求被重复扣费。
                let response = self
                    .send_submission_json(task, attempt_id, &context, "submit", &path, body)
                    .await
                    .map_err(|error| ambiguous_paid_submission(&task.id, error))?;
                let submission = parse_task_image_submission(task, &response)
                    .map_err(|error| ambiguous_paid_submission(&task.id, error))?;
                Ok((submission, response))
            }
            GenerationOperation::ImageToImage => {
                let path = request_path(&resolved.operation_schema, "/v1/images/edits")?;
                // Seedream 图生图走 JSON（`POST /v1/images/generations`，参考图以
                // 顶层 `image` 字段传 URL）；Gemini 图生图同样走 JSON，但 `image`
                // 传 data URI（`data:<mime>;base64,<DATA>`，见 https://doc.moyu.info/
                // 9280683m0.md）；Grsai 图生图与文生图共用 `POST /v1/api/generate`，
                // 参考图以顶层 `images` 数组传 URL 或 data URI；Atlas Cloud 走
                // `POST /api/v1/model/generateImage`，参考图以顶层 `image_urls`
                // 数组传 URL 或 data URI；
                // 其余模型沿用 multipart edits 契约。
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
                        "grsai_image_inputs" => build_grsai_image_body(task, resolved)?,
                        "fzy_image_inputs" => build_fzy_image_body(task, resolved)?,
                        "atlascloud_image_inputs" => build_atlascloud_image_body(task, resolved)?,
                        "atlascloud_midjourney_image_inputs" => {
                            build_atlascloud_midjourney_image_body(task, resolved)?
                        }
                        "atlascloud_flux3_image_inputs" => {
                            build_atlascloud_flux3_image_body(task, resolved)?
                        }
                        "atlascloud_qwen_image_inputs" => {
                            build_atlascloud_qwen_image_body(task, resolved)?
                        }
                        _ => build_seedream_image_to_image_body(task, resolved)?,
                    };
                    self.send_submission_json(task, attempt_id, &context, "submit", &path, body)
                        .await
                        .map_err(|error| ambiguous_paid_submission(&task.id, error))?
                } else {
                    self.captured_image_edit(task, attempt_id, &context, resolved, &path)
                        .await
                        .map_err(|error| ambiguous_paid_submission(&task.id, error))?
                };
                let submission = parse_task_image_submission(task, &response)
                    .map_err(|error| ambiguous_paid_submission(&task.id, error))?;
                Ok((submission, response))
            }
            GenerationOperation::VideoGeneration => {
                // 提交分派以冻结档案为权威；草稿样片由任务快照识别（转正片
                // 请求沿用草稿任务身份，冻结档案同样是草稿合同）。
                let seedance_draft_task =
                    GatewayProfile::from_task(task) == Some(GatewayProfile::SeedanceDraft);
                let family = match GatewayProfile::from_operation_schema(&resolved.operation_schema)
                {
                    _ if GatewayProfile::from_task(task) == Some(GatewayProfile::FzyVideo) => {
                        Some(GatewayProfile::FzyVideo)
                    }
                    Some(
                        family @ (GatewayProfile::Sp25PerUse
                        | GatewayProfile::RdVideo
                        | GatewayProfile::PixVerse
                        | GatewayProfile::AtlasCloudVideo),
                    ) => Some(family),
                    _ if seedance_draft_task => Some(GatewayProfile::SeedanceDraft),
                    _ => {
                        // 兜底：Atlas 视频家族的冻结档案可能仍是旧版本按模型名推导出的
                        // 魔芋 Vidu 契约（`/v1/video/generations` + 顶层 `images`），
                        // 而那个端点在 Atlas 上并不存在。按任务快照（远端模型 id +
                        // 连接适配器）裁决家族，避免把付费请求发到不存在的路径。
                        (GatewayProfile::from_task(task)
                            == Some(GatewayProfile::AtlasCloudVideo))
                        .then_some(GatewayProfile::AtlasCloudVideo)
                    }
                };
                let body = match family {
                    Some(GatewayProfile::FzyVideo) => {
                        self.prepare_fzy_video_body(task, attempt_id, &context, resolved)
                            .await?
                    }
                    Some(GatewayProfile::Sp25PerUse) => {
                        self.prepare_sp25_video_body(task, attempt_id, &context, resolved)
                            .await?
                    }
                    Some(GatewayProfile::RdVideo) => {
                        self.prepare_rd_video_body(task, attempt_id, &context, resolved)
                            .await?
                    }
                    Some(GatewayProfile::PixVerse) => {
                        self.prepare_pixverse_video_body(task, attempt_id, &context, resolved)
                            .await?
                    }
                    Some(GatewayProfile::AtlasCloudVideo) => {
                        // Atlas 的视频家族各自一份契约（参数表与媒体字段不同），
                        // 按模型成员分发到对应的组包路径。
                        if is_atlascloud_kling_video_model(
                            task.remote_model_id_snapshot.as_deref().unwrap_or_default(),
                        ) {
                            build_atlascloud_kling_video_body(task, resolved)?
                        } else {
                            build_atlascloud_vidu_video_body(task, resolved)?
                        }
                    }
                    Some(GatewayProfile::SeedanceDraft) | None => finalize_video_body(
                        &context.adapter_id,
                        &resolved.operation_schema,
                        build_video_body(task, resolved)?,
                    ),
                };
                let path = request_path(&resolved.operation_schema, "/v1/video/generations")?;
                let response = if family.is_some() {
                    // 按次、RD 与 Seedance 草稿样片都是独立计费的提交；通用网关的
                    // 「不认识字段就剥离重发」不得改变一次付费提交的请求体，尤其
                    // 不能因剥离 draft 而意外创建正片。
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
                    .await
                    .map_err(|error| match family {
                        Some(GatewayProfile::FzyVideo) => fzy::ambiguous_submission_error(error),
                        Some(GatewayProfile::PixVerse) => {
                            pixverse::ambiguous_submission_error(error)
                        }
                        Some(GatewayProfile::SeedanceDraft) => {
                            seedance_ambiguous_submission_error(error)
                        }
                        Some(GatewayProfile::AtlasCloudVideo) => {
                            atlascloud_ambiguous_submission_error(error)
                        }
                        _ => sp25_ambiguous_submission_error(error),
                    })?
                } else {
                    // 通用网关的付费提交：按提交阶段统一判定「回执是否不明确」。
                    // 失败不再被任务层自动重发，避免同一份付费请求被重复扣费。
                    self.send_submission_json(task, attempt_id, &context, "submit", &path, body)
                        .await
                        .map_err(|error| ambiguous_paid_submission(&task.id, error))?
                };
                let task_id = match family {
                    Some(GatewayProfile::FzyVideo) => fzy::parse_task_id(&response)?,
                    Some(GatewayProfile::Sp25PerUse) => parse_sp25_video_task_id(&response)?,
                    Some(GatewayProfile::PixVerse) => parse_pixverse_video_task_id(&response)?,
                    Some(GatewayProfile::SeedanceDraft) => parse_seedance_draft_task_id(&response)?,
                    /*
                     * Atlas Cloud 视频的回执是平台自有信封（`data.id` 即 prediction
                     * id），没有通用网关那种「任务号 + 进行中状态」的组合，通用解析
                     * 要求 HTTP 202 或明确的进行中状态，因此单独解析。
                     */
                    Some(GatewayProfile::AtlasCloudVideo) => {
                        parse_atlascloud_video_task_id(&response)?
                    }
                    /*
                     * RD 视频与通用网关共用同一个回执解析，而两者的付费提交都可能
                     * 在上游 5xx 时已经建过任务并计费——回执解析阶段必须同样按提交
                     * 阶段判定，否则 5xx 会被任务层判成可重试，再 POST 一遍付费请求。
                     * （发送阶段本来就由 family.is_some() 分支的 ambiguous 包装护住，
                     *  这里补的是解析阶段——5xx 恰恰是在解析阶段才变成 Protocol 的。）
                     */
                    Some(GatewayProfile::RdVideo) | None => parse_video_task_id(&response)
                        .map_err(|error| ambiguous_paid_submission(&task.id, error))?,
                };
                if family == Some(GatewayProfile::SeedanceDraft)
                    && resolved.parameters["draft_task_id"].as_str() == Some(task_id.as_str())
                {
                    return Err(seedance_ambiguous_submission_error(BackendError::protocol(
                        "草稿转正片响应沿用了草稿任务 ID，无法确认正片任务身份",
                        json!({ "draftTaskId": task_id }),
                    )));
                }
                Ok((GenerationSubmission::RemoteVideoTask { task_id }, response))
            }
            // 文本模型不通过生成任务管线提交：提示词优化等功能按各自流程直接调用
            // 文本接口适配层，不会构造 TextGeneration 的生成任务。此分支防御性拦截
            // 意外流入的任务，避免走到图片/视频的请求构造导致格式不匹配。
            GenerationOperation::TextGeneration => {
                Err(BackendError::validation(
                    "text generation is not a canvas generation task; it is invoked directly by text-model features",
                    json!({ "operation": task.operation.as_str(), "taskId": task.id }),
                ))
            }
            GenerationOperation::SpeechGeneration => {
                // 网关 TTS 是一次同步 POST，成功响应体就是音频二进制：同样要按
                // 「提交阶段」判定回执是否不明确，否则 5xx 会被任务层当成可重试，
                // 再 POST 一遍同一份付费请求体。
                let (submission, response) = self
                    .submit_speech(task, attempt_id, &context, resolved)
                    .await
                    .map_err(|error| ambiguous_paid_submission(&task.id, error))?;
                Ok((submission, response))
            }
        }
    }

    /// 网关语音合成（`POST /v1/tts/create`）：一次同步 POST，成功响应体是音频二进制。
    ///
    /// 线上协议（请求体字段、参数区间、错误信封、字幕响应头）全部复用
    /// `speech.rs` 里配音命令用的那一份实现，这里只负责「画布任务」特有的部分：
    /// 冻结任务的凭据与档案、从任务参数映射 `audio_config`、以及把二进制响应
    /// 交给保存层。
    async fn submit_speech(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<(GenerationSubmission, CapturedHttpResponse)> {
        // 绑定与协议归属：模型绑定必须启用语音生成，连接类型决定走哪条合成协议。
        let binding = resolve_speech_binding(
            self.storage.as_ref(),
            self,
            &task.provider_connection_id,
            &task.model_definition_id,
        )?;
        if binding.wire != SpeechWire::Gateway {
            return Err(BackendError::validation(
                "豆包语音模型不支持画布音频节点，请改用网关 TTS 模型（seed-audio 系）。",
                json!({
                    "taskId": task.id,
                    "adapterId": context.adapter_id,
                    "modelDefinitionId": task.model_definition_id,
                }),
            ));
        }
        // 冻结档案是本任务的请求权威：端点与请求档案都取冻结值，不用绑定回读的
        // 活档案（活档案可能在任务创建之后被改过）。
        let profile = resolved
            .operation_schema
            .get("requestProfileId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if profile != GATEWAY_TTS_REQUEST_PROFILE {
            return Err(BackendError::validation(
                "该语音模型的请求档案不是网关 /v1/tts/create 契约，无法在画布音频节点上提交。",
                json!({ "taskId": task.id, "requestProfileId": profile }),
            ));
        }
        let path = request_path(&resolved.operation_schema, GATEWAY_TTS_PATH)?;
        // 远端模型 ID 以任务冻结的快照为准：任务创建之后改绑定不应改变这次提交。
        let remote_model_id = task
            .remote_model_id_snapshot
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(binding.remote_model_id.as_str());
        if !is_gateway_tts_model(remote_model_id) {
            return Err(BackendError::validation(
                "网关语音合成当前只接入 seed-audio 系模型，请选用供应商目录发布的 seed-audio 型号。",
                json!({ "taskId": task.id, "remoteModelId": remote_model_id }),
            ));
        }
        // 要合成的文本只取提示词里的文字片段。`rendered_prompt` 里 @ 引用的参考
        // 音频是一段占位说明（`[音频1：xxx]`），把它原样送去合成，模型会把占位
        // 符当台词念出来。
        let text = resolved
            .content
            .iter()
            .filter_map(|item| match item {
                CompiledContentItem::Text(text) => Some(text.as_str()),
                CompiledContentItem::Media { .. } => None,
            })
            .collect::<String>();
        let text = text.trim();
        if text.is_empty() {
            return Err(BackendError::validation(
                "音频生成需要一段要合成的文本，请填写提示词。",
                json!({ "taskId": task.id }),
            ));
        }
        // 音色复刻：画布音频节点最多带一段参考音频，作为 `audio_data` 内联进请求体。
        let audio_data = match resolved.audios.first() {
            Some(reference) => {
                let bytes = reference.bytes.as_ref().ok_or_else(|| {
                    BackendError::validation(
                        "音色复刻的参考音频必须以本地字节形式提供，请重新选择素材。",
                        json!({
                            "taskId": task.id,
                            "displayName": reference.display_name,
                            "mediaType": reference.media_type,
                        }),
                    )
                })?;
                Some(encode_gateway_reference_audio(
                    bytes,
                    Some(reference.file_name.as_str()),
                )?)
            }
            None => None,
        };
        let (audio_config, speaker) = speech_audio_config(&resolved.parameters)?;
        let plan = gateway_audio_plan(Some(&audio_config))?;
        let body = gateway_request_body(
            remote_model_id,
            text,
            speaker.as_deref(),
            audio_data.as_deref(),
            &plan,
        );
        let (response, bytes) = self
            .send_submission_bytes(task, attempt_id, context, "submit", &path, &body)
            .await?;
        let content_type = content_type_header(&response.headers);
        let reply = parse_gateway_tts_reply(
            response.status,
            &content_type,
            header_value(&response.headers, "x-subtitle").as_deref(),
            &bytes,
        )
        .map_err(|error| {
            // 2xx 但响应体不是音频：上游已受理（成功状态），可能已经计费，只是
            // 回执不可用。按「失败」呈现会让用户再点一次生成——那是第二次付费
            // 请求，因此按图片路径的同一口径落成「已受理但拿不到结果」。
            if (200..300).contains(&response.status) {
                return accepted_without_remote_id_error(
                    "语音网关已返回成功状态，但响应不是音频数据。平台可能已受理并计费，本机也没有可查询的任务号；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
                    json!({
                        "httpStatus": response.status,
                        "contentType": content_type,
                        "source": error.runtime_record(),
                    }),
                );
            }
            error
        })?;
        let (mime_type, extension) = audio_content_type(&reply, plan.container_extension);
        info!(
            "[provider] 语音合成完成: taskId={}, MIME={}, 扩展名={}, 字节 {}",
            task.id,
            mime_type,
            extension,
            reply.audio.len()
        );
        Ok((
            GenerationSubmission::Audio {
                bytes: reply.audio,
                mime_type,
                extension,
            },
            response,
        ))
    }

    /// 按次系列的本地参考素材直接上传到生成平台。上传沿用任务冻结的连接和令牌；
    /// URL 素材则原样透传。客户端仅检查编码完整性，渠道规则由服务端返回。
    async fn prepare_sp25_video_body(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        let model = task.remote_model_id_snapshot.as_deref().ok_or_else(|| {
            BackendError::validation("按次视频任务缺少模型 ID", json!({ "taskId": task.id }))
        })?;
        validate_sp25_video_request(model, resolved)?;
        let mut images = Vec::with_capacity(resolved.images.len());
        let mut audios = Vec::with_capacity(resolved.audios.len());
        for media in &resolved.images {
            images.push(
                self.gateway_reference_url(task, attempt_id, context, media, "按次视频")
                    .await?,
            );
        }
        for media in &resolved.audios {
            audios.push(
                self.gateway_reference_url(task, attempt_id, context, media, "按次视频")
                    .await?,
            );
        }
        build_sp25_video_body(model, resolved, &images, &audios)
    }

    /// Seedance 2.5 RD 网关：本地参考图/视频/音频先经免费的 `POST /v1/assets/uploads`
    /// 换取公网 URL，再提交付费任务；公网 URL 素材原样透传。
    /// 本地任务标记只表达用户意图，不用于判断渠道能力。
    async fn prepare_rd_video_body(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        let model = task.remote_model_id_snapshot.as_deref().ok_or_else(|| {
            BackendError::validation("RD 视频任务缺少模型 ID", json!({ "taskId": task.id }))
        })?;
        validate_rd_video_request(model, resolved)?;
        let mut images = Vec::with_capacity(resolved.images.len());
        let mut videos = Vec::with_capacity(resolved.videos.len());
        let mut audios = Vec::with_capacity(resolved.audios.len());
        let mut start_frame_url: Option<String> = None;
        let mut end_frame_url: Option<String> = None;
        for media in resolved.images.iter().chain(&resolved.videos) {
            let url = self
                .gateway_reference_url(task, attempt_id, context, media, "RD 视频")
                .await?;
            match media.role.as_str() {
                "first_frame" if media.media_type == MediaType::Image => {
                    start_frame_url = Some(url)
                }
                "last_frame" if media.media_type == MediaType::Image => end_frame_url = Some(url),
                _ if media.media_type == MediaType::Video => videos.push(url),
                _ => images.push(url),
            }
        }
        for media in &resolved.audios {
            audios.push(
                self.gateway_reference_url(task, attempt_id, context, media, "RD 视频")
                    .await?,
            );
        }
        build_rd_video_body(
            model,
            resolved,
            images,
            videos,
            audios,
            start_frame_url,
            end_frame_url,
        )
    }

    /// 按次系列与 RD 网关共用：本地参考素材上传 `POST /v1/assets/uploads`
    /// 换取公网 URL（免费且不计入生成计费）；URL 素材原样透传。
    async fn gateway_reference_url(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        media: &ResolvedMedia,
        label: &str,
    ) -> BackendResult<String> {
        if let Some(bytes) = media.bytes.as_ref() {
            let path = "/v1/assets/uploads";
            let url = endpoint(&context.base_url, path)?;
            let call_id = Uuid::new_v4().to_string();
            self.lifecycle.commit(
                &task.id,
                GenerationLifecycleFact::ProviderCallPrepared {
                    call_id: call_id.clone(),
                    attempt_id: attempt_id.to_string(),
                    phase: "upload".to_string(),
                    request: json!({
                        "providerConnectionId": context.provider_connection_id,
                        "adapterId": context.adapter_id,
                        "credentialReference": context.api_key_ref,
                        "method": "POST",
                        "url": sanitize_url(&url),
                        "bodyType": "multipart",
                        "file": {
                            "field": "file",
                            "fileName": media.file_name,
                            "mimeType": media.mime_type,
                            "byteSize": media.byte_size,
                            "sha256": media.sha256,
                            "stableIdentity": media.stable_identity,
                        }
                    }),
                },
            )?;
            let part = multipart::Part::bytes(bytes.clone())
                .file_name(media.file_name.clone())
                .mime_str(&media.mime_type)
                .map_err(BackendError::Transport)?;
            let request = self
                .client
                .post(url)
                .bearer_auth(&context.api_key)
                .multipart(multipart::Form::new().part("file", part));
            let response = self
                .send_captured(
                    &task.id,
                    &call_id,
                    &format!("POST / phase=upload / taskId={}", task.id),
                    request,
                )
                .await?;
            return parse_gateway_upload_url(&response, label);
        }
        let reference = media.remote_reference.as_deref().ok_or_else(|| {
            BackendError::validation(
                format!("{label}参考素材缺少可上传字节或公网 URL"),
                media.archive(),
            )
        })?;
        require_public_url_with(reference, label, media)?;
        Ok(reference.to_string())
    }

    /// 已成功任务的签名下载 URL 可过期；只重查冻结任务，不重新提交收费请求。
    /// 按次系列、RD、PixVerse 与 Seedance 草稿样片共用同一续签路径；后两者的
    /// 任务身份、SUCCESS 状态与签名结果地址有各自的信封形状。
    pub(crate) async fn refresh_sp25_video_url(
        &self,
        task: &TaskExecutionRecord,
    ) -> BackendResult<String> {
        let family = GatewayProfile::from_task(task).ok_or_else(|| {
            BackendError::validation(
                "当前视频请求档案不支持重新查询下载链接",
                json!({ "taskId": task.id }),
            )
        })?;
        let remote_task_id = task.remote_task_id.as_deref().ok_or_else(|| {
            BackendError::validation("远程任务 ID 缺失", json!({ "taskId": task.id }))
        })?;
        if family != GatewayProfile::FzyVideo && !valid_sp25_task_id(remote_task_id) {
            return Err(BackendError::validation(
                "远程任务 ID 格式无效",
                json!({ "taskId": task.id }),
            ));
        }
        let context = self.resolve_frozen(task)?;
        let path = if family == GatewayProfile::FzyVideo {
            fzy::observe_path(remote_task_id)?
        } else {
            checked_observe_path(format!("/v1/video/generations/{remote_task_id}"))?
        };
        let response = self
            .send_raw_json_request(&context, Method::GET, &path, &[], None, &[])
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(sp25_response_error(
                response.status,
                &response.body,
                "查询视频生成任务失败",
            ));
        }
        let payload: Value = serde_json::from_str(&response.body)?;
        let observed_id = match family {
            GatewayProfile::FzyVideo => payload.get("id"),
            // 草稿样片的任务身份与状态在网关的 data 信封里。
            GatewayProfile::SeedanceDraft => payload
                .pointer("/data/task_id")
                .or_else(|| payload.get("task_id")),
            _ => payload.get("task_id"),
        }
        .and_then(Value::as_str);
        let succeeded = match family {
            GatewayProfile::FzyVideo => {
                payload.get("status").and_then(Value::as_str) == Some("success")
            }
            GatewayProfile::SeedanceDraft => payload
                .pointer("/data/status")
                .or_else(|| payload.get("status"))
                .and_then(Value::as_str)
                .is_some_and(|status| matches!(status, "SUCCESS" | "succeeded")),
            GatewayProfile::PixVerse => payload
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status.eq_ignore_ascii_case("success")),
            _ => payload.get("status").and_then(Value::as_str) == Some("succeeded"),
        };
        if observed_id != Some(remote_task_id) || !succeeded {
            return Err(BackendError::protocol(
                "视频任务尚未成功或返回了不匹配的任务身份",
                json!({ "taskId": task.id, "remoteTaskId": remote_task_id, "response": redact_request_value(&payload) }),
            ));
        }
        let fresh_url = if family == GatewayProfile::FzyVideo {
            let captured = CapturedHttpResponse {
                call_id: String::new(),
                status: response.status,
                headers: response.headers,
                body: response.body,
            };
            fzy::parse_observation(&captured, remote_task_id)?.video_url
        } else {
            extract_video_url(&payload)
        }
        .ok_or_else(|| {
            BackendError::protocol(
                "视频任务成功响应缺少下载链接",
                json!({ "taskId": task.id, "remoteTaskId": remote_task_id }),
            )
        })?;
        require_sp25_public_url_value(&fresh_url)?;
        Ok(fresh_url)
    }

    pub async fn observe(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<(GenerationObservation, CapturedHttpResponse)> {
        let _ = task.remote_task_id.as_deref().ok_or_else(|| {
            BackendError::validation(
                "remote generation task has no remote task id",
                json!({ "taskId": task.id }),
            )
        })?;
        let context = self.resolve_frozen(task)?;
        let image_task = matches!(
            task.operation,
            GenerationOperation::TextToImage | GenerationOperation::ImageToImage
        );
        let path = if image_task {
            image_observe_path(&self.storage, task)?
        } else {
            video_observe_path(&self.storage, task)?
        };
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
        let observation = if image_task {
            parse_image_observation(&response)?
        } else if GatewayProfile::from_task(task) == Some(GatewayProfile::FzyVideo) {
            fzy::parse_observation(
                &response,
                task.remote_task_id.as_deref().unwrap_or_default(),
            )?
        } else if GatewayProfile::from_task(task) == Some(GatewayProfile::PixVerse) {
            pixverse::parse_observation(
                &response,
                task.remote_task_id.as_deref().unwrap_or_default(),
            )?
        } else {
            parse_video_observation(&response)?
        };
        Ok((observation, response))
    }

    /// 记忆读写共用的入口：锁中毒时沿用已有数据，不把一次上游退化升级成 panic。
    fn with_rejected_fields<R>(
        &self,
        visit: impl FnOnce(&mut BTreeMap<String, BTreeSet<String>>) -> R,
    ) -> R {
        match self.rejected_request_fields.lock() {
            Ok(mut fields) => visit(&mut fields),
            Err(poisoned) => visit(&mut poisoned.into_inner()),
        }
    }

    /// 发送前剔除本次运行已记忆的「上游拒绝过」字段。
    fn drop_rejected_fields(&self, task: &TaskExecutionRecord, body: &mut Value) {
        if body.as_object().is_none() {
            return;
        }
        let key = rejected_field_key(task);
        let removed = self.with_rejected_fields(|fields| {
            fields
                .get(&key)
                .map(|known| {
                    known
                        .iter()
                        .filter(|field| remove_request_field(body, field))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        });
        if !removed.is_empty() {
            info!(
                "[provider] 请求体按上游拒绝记忆剔除字段: taskId={}, 模型={}, 字段={}",
                task.id,
                task.remote_model_id_snapshot.as_deref().unwrap_or(""),
                removed.join("、")
            );
        }
    }

    /// 提交类 JSON 请求的发送：先剔除已记忆的字段；若上游以 4xx 点名拒绝请求体里的
    /// 某个字段，剥离该字段后重发，并把该字段记进进程内记忆。
    ///
    /// 只有「供应商点名了它不认识的字段」这一种证据才会重发。上游可能连续点名多个
    /// 字段——实测 gpt-image-2.5 系在只讲 OpenAI images 契约的网关上会先拒
    /// `aspect_ratio` 再拒 `resolution`，剥一次到不了底——所以这里循环剥离，上限
    /// `MAX_STRIP_RESEND_ROUNDS` 轮；每一轮都必须真的从请求体里删掉字段，删不动或
    /// 错误没点名字段时立即停止，响应原样返回，由既有失败路径报错。每轮请求都完整
    /// 落在 `provider_calls`（带字段与不带字段的请求逐次可查），日志给出字段名与
    /// 模型，因此不是静默改写。
    ///
    /// 图片编辑的 multipart 契约不在此列：它的参数是表单字段、剥离方式不同，且
    /// gpt-image 编辑接口声明的是 `n`/`size`/`quality` 这类受支持字段。
    async fn send_submission_json(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        phase: &str,
        path: &str,
        body: Value,
    ) -> BackendResult<CapturedHttpResponse> {
        if is_fzy_image_task(task) {
            // 出图 POST 不剥离字段后重发；响应丢失也可能已经创建并冻结费用。
            return self
                .captured_json(
                    task,
                    attempt_id,
                    context,
                    CapturedJsonRequest {
                        phase,
                        method: Method::POST,
                        path,
                        body: &body,
                    },
                )
                .await
                .map_err(fzy_ambiguous_submission_error);
        }
        if is_atlascloud_image_task(task) {
            // Atlas Cloud 出图按张计费，同样不做「剥离字段后重发」：
            // ① 重发可能变成第二次计费（响应丢失时上游可能已建好 prediction）；
            // ② 静默丢掉用户选中的画幅/分辨率/质量，比直接报错更糟——
            //    用户以为拿到了 2K 的图，实际拿到的是上游默认值。
            // 上游点名拒绝字段时，响应原样返回，由既有失败路径把原因带给用户。
            return self
                .captured_json(
                    task,
                    attempt_id,
                    context,
                    CapturedJsonRequest {
                        phase,
                        method: Method::POST,
                        path,
                        body: &body,
                    },
                )
                .await;
        }
        let mut body = body;
        self.drop_rejected_fields(task, &mut body);
        for _round in 0..MAX_STRIP_RESEND_ROUNDS {
            let request = CapturedJsonRequest {
                phase,
                method: Method::POST,
                path,
                body: &body,
            };
            let response = self
                .captured_json(task, attempt_id, context, request)
                .await?;
            if response.is_success() {
                return Ok(response);
            }
            let Some(field) = unsupported_request_field(&response) else {
                return Ok(response);
            };
            if !remove_request_field(&mut body, &field) {
                return Ok(response);
            }
            warn!(
                "[provider] 上游拒绝请求字段，剥离后重发: taskId={}, attemptId={}, phase={phase}, HTTP {}, 字段={field}, 模型={}, 该字段已记入本次运行的不支持清单",
                task.id,
                attempt_id,
                response.status,
                task.remote_model_id_snapshot.as_deref().unwrap_or("")
            );
            self.with_rejected_fields(|fields| {
                fields
                    .entry(rejected_field_key(task))
                    .or_default()
                    .insert(field.clone());
            });
        }
        // 轮次用尽仍被点名：把最后一次请求发完，用它的响应走既有失败路径。
        let request = CapturedJsonRequest {
            phase,
            method: Method::POST,
            path,
            body: &body,
        };
        self.captured_json(task, attempt_id, context, request).await
    }

    /// 提交类请求的字节级发送：响应体是二进制（语音合成的音频），不能走
    /// `captured_json` / `send_captured`——那条路径把响应体按 UTF-8 解成字符串，
    /// 音频字节会被替换符毁掉。
    ///
    /// 诊断归档沿用同一套 `provider_calls` 三态（prepared / sent / responded），
    /// 但响应正文只留一句占位说明：几十兆的音频塞进 SQLite 没有意义，也会把
    /// 「复制报错」变成一堆乱码。
    ///
    /// 读取上限与语音模块共用一套（音频 96 MiB、错误信封 1 MiB），避免两条入口
    /// 对同一个响应体给出不同的分类。
    async fn send_submission_bytes(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        phase: &str,
        path: &str,
        body: &Value,
    ) -> BackendResult<(CapturedHttpResponse, Vec<u8>)> {
        let url = endpoint(&context.base_url, path)?;
        let extra_headers = extra_headers_for_adapter(&context.adapter_id, &Method::POST);
        let mut archived_headers = json!({
            "authorization": "已排除敏感凭据",
            "content-type": "application/json"
        });
        if let Some(headers) = archived_headers.as_object_mut() {
            for (name, value) in extra_headers {
                headers.insert((*name).to_ascii_lowercase(), json!(*value));
            }
        }
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": Method::POST.as_str(),
            "url": sanitize_url(&url),
            "headers": archived_headers,
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
            .request(Method::POST, url)
            .bearer_auth(&context.api_key)
            // 网关 TTS 是同步长请求：文档 p50 约 12 秒，长文本更久。客户端默认的
            // 300 秒总时限对长台词偏紧，这里按语音模块的口径放宽到 10 分钟。
            .timeout(std::time::Duration::from_secs(600));
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        request = request.json(body);
        info!(
            "[provider] 发起供应商请求（二进制响应）: taskId={}, phase={phase}, callId={}, POST {}",
            task.id,
            call_id,
            sanitized_url
        );
        // sent_at 在发送之前写库：请求构造失败也要留下「有没有发出去」的痕迹。
        let sent_at = now_ms();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallSent {
                call_id: call_id.clone(),
                sent_at,
            },
        )?;
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let dispatch_failed = is_dispatch_failure(&error);
                let backend_error = BackendError::Transport(error);
                self.lifecycle.commit(
                    &task.id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.clone(),
                        sent_at,
                        error: backend_error.runtime_record(),
                        dispatch_failed,
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let content_type = content_type_header(&headers);
        let expects_audio = response_holds_audio(status, &content_type);
        let bytes = match collect_capped(
            response,
            if expects_audio {
                MAX_SPEECH_RESPONSE_BYTES
            } else {
                MAX_GATEWAY_ERROR_BYTES
            },
            "语音响应超过单句大小限制。",
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                // 响应体读不下来：上游已经回包并可能计费，不算「未发出」。
                self.lifecycle.commit(
                    &task.id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.clone(),
                        sent_at,
                        error: error.runtime_record(),
                        dispatch_failed: false,
                    },
                )?;
                return Err(error);
            }
        };
        let placeholder = format!("<binary audio: {} bytes>", bytes.len());
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallResponded {
                call_id: call_id.clone(),
                sent_at,
                status,
                headers: headers.clone(),
                raw_response: placeholder.clone(),
            },
        )?;
        Ok((
            CapturedHttpResponse {
                call_id,
                status,
                headers,
                body: placeholder,
            },
            bytes,
        ))
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
        let sanitized_url = sanitize_url(&url);
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
            .timeout(std::time::Duration::from_secs(30 * 60))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // 连接层失败：请求根本没送达上游，标记 dispatch_failed，
                // 「已发出」的守卫据此放行（草稿可以重新提升为正片）。
                let dispatch_failed = is_dispatch_failure(&error);
                let backend_error = BackendError::Transport(error);
                self.lifecycle.commit(
                    &task.id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.clone(),
                        sent_at,
                        error: backend_error.runtime_record(),
                        dispatch_failed,
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
        if looks_like_html_document(&bytes) {
            return Err(html_document_rejection(
                status,
                &sanitized_url,
                &content_type_header(&headers),
                &bytes,
                format!(
                    "视频内容接口返回的是网页而不是视频文件（HTTP {status}）。该网关可能不支持内容接口：请核对供应商连接的 API 地址后重试。"
                ),
            ));
        }
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
        let extra_headers = extra_headers_for_adapter(&context.adapter_id, &method);
        let mut archived_headers = json!({
            "authorization": "已排除敏感凭据",
            "content-type": "application/json"
        });
        if let Some(headers) = archived_headers.as_object_mut() {
            for (name, value) in extra_headers {
                headers.insert((*name).to_ascii_lowercase(), json!(*value));
            }
        }
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": method.as_str(),
            "url": sanitize_url(&url),
            "headers": archived_headers,
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
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
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
        // 流式必须走无总时限的 stream_client；非流式看不到块间粒度，用显式总时限
        // 兜底挂死的网关。
        let client = if call.dialect.is_some() {
            &self.stream_client
        } else {
            &self.client
        };
        let mut request = client
            .post(url.clone())
            .bearer_auth(&context.api_key)
            .json(body);
        if call.dialect.is_none() {
            request = request.timeout(NON_STREAM_TEXT_TIMEOUT);
        }
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        info!(
            "[provider] 发起文本模型请求: taskId={}, callId={}, POST {}, 流式方言={:?}",
            task.id, call_id, sanitized_url, call.dialect
        );
        let started_at = std::time::Instant::now();
        let label = format!("POST / phase=text_generation / taskId={}", task.id);
        let (status, headers, body_text, payload) = match call.dialect {
            Some(dialect) => {
                // Non-stream calls record this inside send_captured; record it only once.
                let sent_at = now_ms();
                self.lifecycle.commit(
                    &task.id,
                    GenerationLifecycleFact::ProviderCallSent {
                        call_id: call_id.clone(),
                        sent_at,
                    },
                )?;
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
                // 连接层失败：请求根本没送达上游，标记 dispatch_failed。
                let dispatch_failed = is_dispatch_failure(&error);
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
                        dispatch_failed,
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
                        // 等响应头超时是「回执不明确」：请求很可能已经送达上游，
                        // 不能当成未发出（否则可能重复提交、双倍扣费）。
                        dispatch_failed: false,
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let response_url = sanitize_url(response.url());
        /*
         * 3xx 早退：本客户端禁用了自动跟随重定向，供应商返回跳转地址时，
         * 响应体多半是 HTML 或空。若继续走 SSE 解析，方言累积器会把它拼成
         * 一个空 payload，最后报出「模型没有返回内容」这种与真实原因无关的错。
         * 这里直接给出中文人话，与非流式路径（require_success 的 3xx 分支）口径一致。
         */
        if (300..400).contains(&status) {
            let backend_error = BackendError::protocol(
                format!(
                    "供应商返回了跳转地址（HTTP {status}），请求未送达。请核对该供应商的 API 地址是否正确，或联系供应商确认其接口变更。"
                ),
                json!({ "callId": call_id, "httpStatus": status, "redirect": true }),
            );
            self.lifecycle.commit(
                task_id,
                GenerationLifecycleFact::ProviderCallFailed {
                    call_id: call_id.to_string(),
                    sent_at,
                    error: backend_error.runtime_record(),
                    // 3xx：上游已经回包了，请求确实送达过，不算未发出。
                    dispatch_failed: false,
                },
            )?;
            return Err(backend_error);
        }
        let mut stream = response.bytes_stream();
        let mut parser = SseFrameParser::default();
        let mut dialect = sse_dialect(dialect);
        let mut delta_sink = match delta_sink.take() {
            Some(sink) => StreamSink::new(Some(sink)),
            None => StreamSink::new(None),
        };
        let stats = match consume_sse_stream(
            &mut stream,
            STREAM_IDLE_TIMEOUT,
            &mut parser,
            dialect.as_mut(),
            &mut delta_sink,
        )
        .await
        {
            Ok(stats) => stats,
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
                        // 响应体读取失败：上游已经回包并可能计费，不算未发出。
                        dispatch_failed: false,
                    },
                )?;
                return Err(backend_error);
            }
        };
        if let Err(error) =
            reject_html_api_response(status, &headers, &stats.transcript, &response_url)
        {
            self.lifecycle.commit(
                task_id,
                GenerationLifecycleFact::ProviderCallResponded {
                    call_id: call_id.to_string(),
                    sent_at,
                    status,
                    headers,
                    raw_response: stats.transcript,
                },
            )?;
            return Err(error);
        }
        let payload = match finalize_streamed_text_payload(
            parser,
            dialect.as_mut(),
            &mut delta_sink,
            status,
            &stats,
            task_id,
            call_id,
        ) {
            Ok(payload) => payload,
            Err(()) => {
                let backend_error = BackendError::protocol(
                    format!(
                        "provider stream stalled for {}s",
                        STREAM_IDLE_TIMEOUT.as_secs()
                    ),
                    json!({
                        "callId": call_id,
                        "timeoutSeconds": STREAM_IDLE_TIMEOUT.as_secs(),
                        "receivedChunks": stats.chunks,
                        "receivedBytes": stats.bytes,
                    }),
                );
                error!(
                    "[provider] 流式响应中断: label={label}, 已接收 {} 块",
                    stats.chunks
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                        // 流中途断：请求早已送达上游，不算未发出。
                        dispatch_failed: false,
                    },
                )?;
                return Err(backend_error);
            }
        };
        if stats.stalled {
            warn!(
                "[provider] 流式空闲超时，改用已接收内容: label={label}, 已接收 {} 块 / {} 字节",
                stats.chunks, stats.bytes
            );
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
            stats.transcript
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
                .map_err(|error| {
                    // 构造 multipart 部件发生在发送之前：请求没发出去，不能按
                    // 「回执不明确」处理（否则会白白丢掉本来可以重试的机会）。
                    BackendError::validation(
                        format!("图片素材的 MIME 类型无法用于上传：{}", image.mime_type),
                        json!({
                            "mimeType": image.mime_type,
                            "fileName": image.file_name,
                            "reason": error.to_string(),
                        }),
                    )
                })?;
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

    /// 发一次请求并把「请求 / 响应 / 失败」三态归档进 `provider_calls`。
    ///
    /// `sent_at` 在 `request.send()` **之前**就写库：请求构造失败也要留下痕迹，
    /// 便于事后查「这次调用到底有没有发出去」。代价是 `sent_at` 非空**不等于**
    /// 「供应商已收到」——所以连接层失败（DNS / 连接被拒 / TLS 握手失败）时还要把
    /// `dispatch_failed` 置 1（由 [`is_dispatch_failure`] 判定），「已发出」的守卫
    /// （storage.rs 的草稿阻断与正片查找）据此把「从未送达」的调用排除掉。
    ///
    /// 「已送达上游但响应体读取失败 / 4xx / 5xx」不算未发出：那些请求可能已经计费，
    /// 必须继续算作已发出，否则会放过重复提交。
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
                // 连接层失败：请求根本没送达上游（DNS 失败 / 连接被拒 / TLS 握手失败），
                // 标记 dispatch_failed。没有这个标记，sent_at 会让守卫把它误判成
                // 「供应商侧还在跑并计费」，把用户永久挡在「该草稿已有正片任务」上。
                let dispatch_failed = is_dispatch_failure(&error);
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
                        dispatch_failed,
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let response_url = sanitize_url(response.url());
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
                        // 响应体读取失败：上游已经回包并可能计费，不算未发出。
                        dispatch_failed: false,
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
        reject_html_api_response(status, &headers, &body, &response_url)?;
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
        let response_url = sanitize_url(response.url());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (multipart), HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        reject_html_api_response(status, &headers, &body, &response_url)?;
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
            .request(method.clone(), url)
            .bearer_auth(&context.api_key);
        for (name, value) in extra_headers_for_adapter(&context.adapter_id, &method)
            .iter()
            .chain(extra_headers.iter())
        {
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
        let response_url = sanitize_url(response.url());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, {method_str} {sanitized_url}, HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        reject_html_api_response(status, &headers, &body, &response_url)?;
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
        if context.api_key.trim().is_empty() {
            // 未配置素材库凭据时，`resolve_asset_library` 会保留主 API Key（模型密钥），
            // 空值继续往下走只会得到「凭据必须为 JSON 形态」这种指向错误的报错。
            return Err(BackendError::validation(
                "该火山引擎连接尚未配置素材库 AK/SK：请在「素材库令牌」处填写 Access Key 与 Secret Key；\
                 只使用模型（拉取模型目录 / 生成）不需要素材库凭据。",
                json!({
                    "providerConnectionId": provider_connection_id,
                    "credentialReference": context.api_key_ref,
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
        let response_url = sanitize_url(response.url());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到 Ark 直连响应: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (Action={action}), HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        reject_html_api_response(status, &headers, &body, &response_url)?;
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    /// 连通性测试：向供应商的模型目录端点发起一次真实的鉴权请求
    /// （`GET {base_url}/v1/models`，火山引擎方舟推理 API 为 `GET {base_url}/models`）。
    ///
    /// 只做这一件事、只发这一个最小请求：它验证的正是「拉取模型」与「模型生成」要用的
    /// 那条链路与那把密钥，不额外触发素材库 OpenAPI（那需要另一套 AK/SK，未配置是允许的
    /// 组合，拿它做探测会把「没配素材库」误报成模型连接失败）。
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
        let adapter_id = self
            .storage
            .get_provider_connection(provider_connection_id)
            .map(|provider| provider.adapter_id)
            .unwrap_or_default();
        let kind = ProviderAdapterKind::parse(&adapter_id);
        if kind == Some(ProviderAdapterKind::DoubaoVoice) {
            // OpenSpeech has no read-only model catalog/probe. A paid TTS request must not
            // be sent just to test credentials; the first real synthesis validates them.
            let credential = self.resolve_token_group(provider_connection_id, token_group);
            return Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: elapsed_ms(),
                reason: Some("generation-only-api".into()),
                detail: Some(match credential {
                    Ok(_) => {
                        "豆包语音凭据已配置；官方语音接口没有免计费的连接探测，首次真实配音时验证。"
                            .into()
                    }
                    Err(error) => error.to_string(),
                }),
            });
        }
        if kind == Some(ProviderAdapterKind::Grsai) {
            // Grsai 只开放付费的 generate / result 两个接口，没有目录或探测端点；
            // 不能为了测连接发一次计费请求，凭据留待首次真实生成验证。
            let credential = self.resolve_token_group(provider_connection_id, token_group);
            return Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: elapsed_ms(),
                reason: Some("generation-only-api".into()),
                detail: Some(match credential {
                    Ok(_) => {
                        "Grsai 凭据已配置；官方只有付费的生成与结果接口，连接测试留待首次真实生成时验证。"
                            .into()
                    }
                    Err(error) => error.to_string(),
                }),
            });
        }
        if kind == Some(ProviderAdapterKind::AtlasCloud) {
            // Atlas Cloud 只开放出图与轮询（外加一次性素材上传），没有目录或探测
            // 端点；不能为了测连接发一次计费请求，凭据留待首次真实生成验证。
            let credential = self.resolve_token_group(provider_connection_id, token_group);
            return Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: elapsed_ms(),
                reason: Some("generation-only-api".into()),
                detail: Some(match credential {
                    Ok(_) => {
                        "Atlas Cloud 凭据已配置；官方只有计费的出图与查询接口，连接测试留待首次真实生成时验证。"
                            .into()
                    }
                    Err(error) => error.to_string(),
                }),
            });
        }
        let probe_query = kind
            .map(ProviderAdapterKind::catalog_probe_query)
            .unwrap_or_default();
        // 只做一次最小探测：GET 模型目录，不落任何生成请求。
        let probe = self
            .raw_json_request_with_token_group(
                provider_connection_id,
                token_group,
                Method::GET,
                model_catalog_path(&adapter_id),
                &probe_query,
                None,
            )
            .await;
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
        let adapter_id = self
            .storage
            .get_provider_connection(provider_connection_id)
            .map(|provider| provider.adapter_id)
            .unwrap_or_default();
        let dialect = RequestDialect::for_adapter(&adapter_id);
        let kind = ProviderAdapterKind::parse(&adapter_id);
        let mut models = if kind == Some(ProviderAdapterKind::DoubaoVoice) {
            // Resource ID is the official service identity, not an invented /models reply.
            self.resolve_token_group(provider_connection_id, token_group)?;
            vec![RemoteModelOption {
                id: "seed-tts-2.0".into(),
                model_definition_id: provider_scoped_model_definition_id(
                    provider_connection_id,
                    "seed-tts-2.0",
                ),
                display_name: "豆包语音 Seed-TTS 2.0".into(),
                owned_by: Some("火山引擎豆包语音".into()),
                has_configured_binding: false,
                configured_operations: vec![],
                suggested_operations: vec![GenerationOperation::SpeechGeneration],
                operation_schema: default_model_schema(
                    "seed-tts-2.0",
                    &[GenerationOperation::SpeechGeneration],
                ),
                token_group: token_group.map(ToOwned::to_owned),
            }]
        } else if kind == Some(ProviderAdapterKind::Grsai) {
            // Grsai 没有模型目录接口：文档在 `model` 参数里逐个列出模型 ID，
            // 这里按文档返回固定清单，契约由 Grsai 方言改写生成。
            self.resolve_token_group(provider_connection_id, token_group)?;
            const GRSAI_IMAGE_MODELS: [(&str, &str); 5] = [
                ("gpt-image-2", "GPT Image 2"),
                ("gpt-image-2-vip", "GPT Image 2 VIP"),
                ("gpt-image-2.5", "GPT Image 2.5"),
                ("gpt-image-2.5-flare", "GPT Image 2.5 Flare"),
                ("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"),
            ];
            GRSAI_IMAGE_MODELS
                .into_iter()
                .map(|(model, display_name)| {
                    let operations = [
                        GenerationOperation::TextToImage,
                        GenerationOperation::ImageToImage,
                    ];
                    RemoteModelOption {
                        id: model.into(),
                        model_definition_id: provider_scoped_model_definition_id(
                            provider_connection_id,
                            model,
                        ),
                        display_name: format!("Grsai {display_name}"),
                        owned_by: Some("Grsai".into()),
                        has_configured_binding: false,
                        configured_operations: vec![],
                        suggested_operations: operations.to_vec(),
                        operation_schema: schema_for_enabled_operations(
                            &Value::Null,
                            model,
                            &operations,
                            RequestDialect::Grsai,
                        ),
                        token_group: token_group.map(ToOwned::to_owned),
                    }
                })
                .collect()
        } else if kind == Some(ProviderAdapterKind::AtlasCloud) {
            // Atlas Cloud 没有公开的模型目录接口（平台只开放生成与查询），这里按
            // 平台目录里已登记的成员返回固定清单；契约由 Atlas 方言改写生成
            // （端点、轮询、参数、成员能力各不相同）。
            self.resolve_token_group(provider_connection_id, token_group)?;
            const ATLASCLOUD_MODELS: [(&str, &str, &str, &[GenerationOperation]); 7] = [
                (
                    "xai/grok-imagine-image-2.0/text-to-image",
                    "Grok Imagine Image 2.0（文生图）",
                    "xAI",
                    &[GenerationOperation::TextToImage],
                ),
                (
                    "xai/grok-imagine-image-2.0-developer/edit",
                    "Grok Imagine Image 2.0 编辑（参考图）",
                    "xAI",
                    &[GenerationOperation::ImageToImage],
                ),
                (
                    "midjourney/v8.2/image-to-image",
                    "Midjourney V8.2（参考图）",
                    "Midjourney",
                    &[GenerationOperation::ImageToImage],
                ),
                (
                    "black-forest-labs/flux-3/edit",
                    "FLUX 3 编辑（参考图）",
                    "Black Forest Labs",
                    &[GenerationOperation::ImageToImage],
                ),
                (
                    "qwen-image-3.0-pro/edit",
                    "Qwen Image 3.0 Pro 编辑（参考图）",
                    "Alibaba",
                    &[GenerationOperation::ImageToImage],
                ),
                (
                    "vidu/q4-preview/reference-to-video",
                    "Vidu Q4（参考图生视频）",
                    "Vidu",
                    &[GenerationOperation::VideoGeneration],
                ),
                (
                    "kwaivgi/kling-v4.0/reference-to-video",
                    "Kling 4.0（参考生视频）",
                    "Kuaishou",
                    &[GenerationOperation::VideoGeneration],
                ),
            ];
            ATLASCLOUD_MODELS
                .into_iter()
                .map(|(model, display_name, owner, operations)| {
                    RemoteModelOption {
                        id: model.into(),
                        model_definition_id: provider_scoped_model_definition_id(
                            provider_connection_id,
                            model,
                        ),
                        display_name: display_name.into(),
                        owned_by: Some(owner.into()),
                        has_configured_binding: false,
                        configured_operations: vec![],
                        suggested_operations: operations.to_vec(),
                        operation_schema: schema_for_enabled_operations(
                            &Value::Null,
                            model,
                            operations,
                            RequestDialect::AtlasCloud,
                        ),
                        token_group: token_group.map(ToOwned::to_owned),
                    }
                })
                .collect()
        } else if let Some(kind) = kind.filter(|kind| kind.paginates_catalog()) {
            self.list_paginated_models(provider_connection_id, token_group, kind, dialect)
                .await?
        } else {
            let response = self
                .raw_json_request_with_token_group(
                    provider_connection_id,
                    token_group,
                    Method::GET,
                    model_catalog_path(&adapter_id),
                    &[],
                    None,
                )
                .await?;
            parse_model_catalog(&response, dialect)?
        };
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
                if (is_seedance_draft_video_model(&model.id) || is_pixverse_video_model(&model.id))
                    && model.operation_schema.get("video_generation").is_none()
                {
                    model.operation_schema =
                        default_model_schema(&model.id, &[GenerationOperation::VideoGeneration]);
                }
                // 已保存或预置的定义可能带着另一套方言的端点（例如按模型名推导出的
                // 方舟原生路径），展示与保存前统一改写成本连接的方言。
                apply_request_dialect(&mut model.operation_schema, &model.id, dialect);
                model.suggested_operations = operations_from_schema(&model.operation_schema);
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

    async fn list_paginated_models(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
        kind: ProviderAdapterKind,
        dialect: RequestDialect,
    ) -> BackendResult<Vec<RemoteModelOption>> {
        const PAGE_SIZE: u32 = 100;
        const MAX_PAGES: u32 = 50;
        let mut page_no = 1_u32;
        let mut models = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let query = kind.catalog_page_query(page_no, PAGE_SIZE);
            let response = self
                .raw_json_request_with_token_group(
                    provider_connection_id,
                    token_group,
                    Method::GET,
                    kind.catalog_path(),
                    &query,
                    None,
                )
                .await?;
            let page = parse_model_catalog(&response, dialect)?;
            let total = serde_json::from_str::<Value>(&response.body)
                .ok()
                .and_then(|value| {
                    provider_adapter::bailian_catalog_page(&value).map(|(_, total)| total)
                })
                .unwrap_or(page.len() as u64);
            let page_len = page.len();
            for model in page {
                if seen.insert(model.id.clone()) {
                    models.push(model);
                }
            }
            if page_len == 0 || models.len() as u64 >= total || page_no >= MAX_PAGES {
                break;
            }
            page_no += 1;
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

pub(crate) fn request_path(operation_schema: &Value, fallback: &str) -> BackendResult<String> {
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
    let mut mapped = Vec::new();
    for (key, value) in values {
        let empty_definition = Map::new();
        let definition = definitions
            .get(key)
            .and_then(Value::as_object)
            .unwrap_or(&empty_definition);
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
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "seedream image-to-image only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
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
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "gemini image-to-image only accepts image reference inputs",
            json!({
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
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

/// Grsai 图片生成请求体（`POST /v1/api/generate`，文生图与图生图共用一个端点）：
/// `model` / `prompt` / `replyType: "async"`（换取任务号后轮询
/// `GET /v1/api/result?id=`）/ `aspectRatio` / `quality` / `background` 放顶层，
/// 参考图通过顶层 `images` 数组传入——公网 URL 原样透传，本地图片编码为
/// data URI（文档声明 base64 与 URL 均可）。
///
/// `aspectRatio` 按模型家族组装：gpt-image-2 / gpt-image-2.5 直接收比例字符串；
/// vip 系（-vip / -flare / -sunburst）只收像素值，由「画幅 × 分辨率档位」查文档
/// 参考表得到（`auto` 直接透传）。`background` 是布尔参数，仅在勾选时发送
/// `transparent`（文档只接受该取值）。
/// 饭众烟图片接口：文生图与参考图生成使用同一路径，参考图始终为数组。
fn build_fzy_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty()
        || !resolved.audios.is_empty()
        || (task.operation == GenerationOperation::TextToImage && !resolved.images.is_empty())
    {
        return Err(BackendError::validation(
            "饭众烟出图只能编码图片参考；请使用图生图并连接图片素材。",
            resolved.archive(),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存图片模型。", json!({"taskId": task.id}))
        })?;
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(resolved.rendered_prompt));
    if task.operation == GenerationOperation::ImageToImage {
        let inputs = resolved
            .images
            .iter()
            .map(|image| {
                if let Some(reference) = image
                    .remote_reference
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    return Ok(json!(reference));
                }
                let bytes = image.bytes.as_ref().ok_or_else(|| {
                    BackendError::validation(
                        "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
                        image.archive(),
                    )
                })?;
                Ok(json!(format!(
                    "data:{};base64,{}",
                    image.mime_type,
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )))
            })
            .collect::<BackendResult<Vec<_>>>()?;
        body.insert("images".into(), Value::Array(inputs));
    }
    insert_mapped_parameters(&mut body, "metadata", mapped_parameters(resolved, "root")?)?;
    Ok(Value::Object(body))
}

fn build_grsai_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.images.is_empty() && task.operation != GenerationOperation::ImageToImage {
        return Err(BackendError::validation(
            "grsai text-to-image cannot encode image references",
            resolved.archive(),
        ));
    }
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "grsai image generation only accepts image reference inputs",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation(
                "grsai image task is missing its model id",
                json!({ "taskId": task.id }),
            )
        })?;
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert("model".into(), Value::String(model.to_string()));
    body.insert(
        prompt_field,
        Value::String(resolved.rendered_prompt.clone()),
    );
    // 应用侧是异步任务架构：提交换任务号、轮询取结果。同步 json 模式会占住
    // 提交请求直到生成完成，长任务容易撞上客户端超时；stream 模式则是 SSE。
    body.insert("replyType".into(), Value::String("async".into()));

    if task.operation == GenerationOperation::ImageToImage {
        let image_field = request_field(&resolved.operation_schema, "mediaField", "images")?;
        let inputs = resolved
            .images
            .iter()
            .map(|image| {
                if let Some(reference) = image
                    .remote_reference
                    .as_deref()
                    .filter(|reference| !reference.is_empty())
                {
                    return Ok(Value::String(reference.to_string()));
                }
                let bytes = image.bytes.clone().ok_or_else(|| {
                    BackendError::validation(
                        "grsai image input has no bytes for base64 data uri encoding",
                        image.archive(),
                    )
                })?;
                Ok(Value::String(format!(
                    "data:{};base64,{}",
                    image.mime_type,
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )))
            })
            .collect::<BackendResult<Vec<_>>>()?;
        body.insert(image_field, Value::Array(inputs));
    }

    // aspectRatio / quality / background 由这里组装，mapped_parameters 只负责
    // 校验与透传其余参数（过滤掉同名映射字段避免插入冲突）。
    let parameters = mapped_parameters(resolved, "root")?
        .into_iter()
        .filter(|parameter| {
            !matches!(
                parameter.field.as_str(),
                "aspectRatio" | "resolution" | "background"
            )
        })
        .collect::<Vec<_>>();
    insert_mapped_parameters(&mut body, &metadata_field, parameters)?;

    let values = resolved.parameters.as_object();
    let aspect_ratio = values
        .and_then(|values| values.get("aspect_ratio"))
        .cloned()
        .unwrap_or(json!("1:1"));
    let aspect_ratio_value = match aspect_ratio.as_str() {
        Some(ratio) if ratio != "auto" && is_grsai_pixel_image_model(model) => {
            let resolution = values
                .and_then(|values| values.get("resolution"))
                .cloned()
                .unwrap_or_else(|| json!("2k"));
            if let Some(pixel) = resolution
                .as_str()
                .and_then(|tier| grsai_pixel_dimensions(ratio, tier))
            {
                Value::String(pixel.into())
            } else {
                // 新档位/自定义像素不在旧查表中时，完整交给渠道判定。
                body.insert("resolution".into(), resolution);
                aspect_ratio.clone()
            }
        }
        _ => {
            /*
             * 画幅 = auto（或不是像素系）时，上面的「把分辨率编码进像素值」那条路
             * 用不上，而 `resolution` 又已经被上面的过滤器从映射结果里剔掉了 ——
             * 于是它**静默消失**：界面显示选中的分辨率不生效，上游按自己的默认
             * 出图，且没有任何报错。这违反「文档新增字段时必须补齐上传和映射，
             * 不能静默丢弃输入」。
             *
             * 所以这里补回：像素系模型把 `resolution` 原样带给渠道。
             */
            if is_grsai_pixel_image_model(model) {
                if let Some(resolution) = values.and_then(|values| values.get("resolution")) {
                    body.insert("resolution".into(), resolution.clone());
                }
            }
            aspect_ratio.clone()
        }
    };
    body.insert("aspectRatio".into(), aspect_ratio_value);
    if let Some(background) = values.and_then(|values| values.get("background")) {
        match background.as_bool() {
            Some(true) => {
                body.insert("background".into(), Value::String("transparent".into()));
            }
            Some(false) => {}
            None => {
                body.insert("background".into(), background.clone());
            }
        }
    }
    Ok(Value::Object(body))
}

/// Atlas Cloud 图片生成请求体（`POST /api/v1/model/generateImage`）：
/// `model` / `prompt` / `num_images` / `enable_base64_output` 放顶层，参考图走
/// 顶层 `image_urls` 数组——公网 URL 原样透传，本地图片编码为 data URI（文档
/// 声明 base64 与 URL 均可）。`aspect_ratio` / `resolution` / `quality` 由参数
/// 表原样透传。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "Atlas Cloud 出图只能编码图片参考；请只连接图片素材。",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存图片模型。", json!({ "taskId": task.id }))
        })?;
    // Midjourney V8.2 家族的契约与 Grok 家族**不同**（单值 `image` 字段、提示词
    // 上限 1024、没有 `num_images`、参数表也换了），走自己那条组包路径。
    if is_atlascloud_midjourney_image_model(model) {
        return build_atlascloud_midjourney_image_body(task, resolved);
    }
    // FLUX 3 家族同理（`reference_images` 数组、1–10 张、参数表又不一样），而且它
    // **没有文生图形态**——必须在落到 Grok 的通用组包之前拦下来，否则文生图请求
    // 会被套上 Grok 的请求体发出去。
    if is_atlascloud_flux3_image_model(model) {
        return build_atlascloud_flux3_image_body(task, resolved);
    }
    // Qwen Image 3.0 Pro 编辑同理（`reference_image_urls` 数组、1–3 张、参数表
    // 又不一样），而且它**没有文生图形态**——必须在落到 Grok 的通用组包之前拦
    // 下来，否则文生图请求会被套上 Grok 的请求体发出去。
    if is_atlascloud_qwen_image_model(model) {
        return build_atlascloud_qwen_image_body(task, resolved);
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !is_atlascloud_registered_image_model(model) {
        // 家族前缀命中但本站没有登记请求体的成员：派发前明确拒绝，
        // 不套用别的成员的请求体，也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的请求体，请改用已登记的 Grok Imagine Image 2.0 模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    let edit_model = model.eq_ignore_ascii_case(ATLASCLOUD_GROK_IMAGE_EDIT_MODEL);
    if task.operation == GenerationOperation::TextToImage {
        if edit_model {
            // 该成员只有「参考图编辑」形态，没有文生图；文生图请求必然被上游拒绝，
            // 与其发一次付费请求再失败，不如在本地说明。
            return Err(BackendError::validation(
                "Grok Imagine Image 2.0 编辑模型必须带 1–3 张参考图：请连接参考图片，或改选文生图模型。",
                json!({ "taskId": task.id, "model": model }),
            ));
        }
        if !resolved.images.is_empty() {
            return Err(BackendError::validation(
                "Atlas Cloud 文生图不接受参考图；请使用参考图编辑模型，或解绑参考图片。",
                resolved.archive(),
            ));
        }
    } else {
        if !edit_model {
            // 文生图成员没有参考图形态；发过去必然被上游拒绝。
            return Err(BackendError::validation(
                "该模型不支持参考图编辑；请改用 Grok Imagine Image 2.0 编辑模型。",
                json!({ "taskId": task.id, "model": model }),
            ));
        }
        // 文档：编辑成员必须带 1–3 张参考图。
        if resolved.images.is_empty() {
            return Err(BackendError::validation(
                "Grok Imagine Image 2.0 编辑模型必须带 1–3 张参考图：请先连接参考图片。",
                json!({ "taskId": task.id, "model": model }),
            ));
        }
        if resolved.images.len() > 3 {
            return Err(BackendError::validation(
                "Grok Imagine Image 2.0 编辑模型最多接受 3 张参考图，请先解绑多余的素材。",
                json!({
                    "taskId": task.id,
                    "model": model,
                    "images": resolved.images.len()
                }),
            ));
        }
    }
    // 文档：提示词上限 8000 字符。
    let prompt = resolved.rendered_prompt.clone();
    if prompt.chars().count() > 8000 {
        return Err(BackendError::validation(
            "提示词超过 8000 字符上限，请精简后再生成。",
            json!({ "taskId": task.id, "length": prompt.chars().count() }),
        ));
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    // 平台按张计费：一次提交一张，多张由应用侧拆成多个任务。
    body.insert("num_images".into(), json!(1));
    // 只要托管链接：结果落盘阶段再下载，不让平台回传 Base64 字节。
    body.insert("enable_base64_output".into(), json!(false));

    if task.operation == GenerationOperation::ImageToImage {
        let image_field = request_field(&resolved.operation_schema, "mediaField", "image_urls")?;
        let inputs = resolved
            .images
            .iter()
            .map(|image| {
                if let Some(reference) = image
                    .remote_reference
                    .as_deref()
                    .filter(|reference| !reference.is_empty())
                {
                    return Ok(Value::String(reference.to_string()));
                }
                let bytes = image.bytes.clone().ok_or_else(|| {
                    BackendError::validation(
                        "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
                        image.archive(),
                    )
                })?;
                Ok(Value::String(format!(
                    "data:{};base64,{}",
                    image.mime_type,
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )))
            })
            .collect::<BackendResult<Vec<_>>>()?;
        body.insert(image_field, Value::Array(inputs));
    }

    // aspect_ratio / resolution / quality 由参数表声明在顶层（root）。
    //
    // 只发送**本契约声明**的参数：画布节点上可能残留着上一个模型的参数（例如
    // dall-e 的 `size`/`n`），把它们塞进 Atlas 请求体会被上游以「未知字段」
    // 拒绝，或更糟——被上游静默忽略，用户却以为自己设了。这里按契约白名单
    // 过滤：本模型声明的参数一个不丢，别的模型的残留参数不带过去（那些参数
    // 本来就不属于这个模型，不是丢弃用户对当前模型的选择）。
    insert_atlascloud_declared_parameters(&mut body, resolved, false)?;
    Ok(Value::Object(body))
}

/// Atlas Cloud **Midjourney V8.2 图生图**请求体（`POST /api/v1/model/generateImage`）。
///
/// 与同平台的 Grok Imagine 家族有四处**契约级**差异（都来自平台文档，不是推测）：
///
/// 1. 参考图走顶层**单值** `image` 字段（不是 `image_urls` 数组），且**只能 1 张**；
/// 2. 提示词上限 **1024** 字符（Grok 是 8000）；
/// 3. **不发** `num_images`：平台每次任务固定返回 4 张图，文档里没有这个参数；
/// 4. 参数表换成 `aspect_ratio` / `hd` / `quality` / `stylize` / `chaos` /
///    `weird` / `seed` / `sref`，**没有** `resolution`（原生 2K 由 `hd` 控制）。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_midjourney_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "Midjourney V8.2 图生图只能编码图片参考；请只连接图片素材。",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存图片模型。", json!({ "taskId": task.id }))
        })?;
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !model.eq_ignore_ascii_case(ATLASCLOUD_MIDJOURNEY_IMAGE_MODEL) {
        // 家族前缀命中但本站没有登记请求体的成员：派发前明确拒绝，
        // 不套用别的成员的请求体，也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的请求体，请改用已登记的 Midjourney V8.2 图生图模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if task.operation != GenerationOperation::ImageToImage {
        // 该成员只有「参考图」形态，没有文生图；文生图请求必然被上游拒绝，
        // 与其发一次付费请求再失败，不如在本地说明。
        return Err(BackendError::validation(
            "Midjourney V8.2 图生图模型必须带 1 张参考图：请连接 1 张参考图片，或改选文生图模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    // 文档：输入图是**单张**（`image` 是字符串字段，不是数组）。
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "Midjourney V8.2 图生图模型必须带 1 张参考图：请先连接参考图片。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if resolved.images.len() > 1 {
        return Err(BackendError::validation(
            "Midjourney V8.2 图生图模型只接受 1 张参考图，请先解绑多余的素材。",
            json!({
                "taskId": task.id,
                "model": model,
                "images": resolved.images.len()
            }),
        ));
    }
    // 文档：提示词上限 1024 字符。
    //
    // 实测（2026-10-28，真实 Key）：平台**入口不校验**这个上限——1030 字符照样
    // 受理并成功出图，而 1166 字符会被受理、在下游跑满约 105 秒后以一句
    // 不可读的 `Origin service encountered an error` 失败（3/3 失败；882 与 1030
    // 共 4 次全部成功）。所以真实边界落在 1030–1166 之间，文档的 1024 偏保守。
    //
    // 这里仍守 1024：只放行已验证可用的区间，且平台随时可能把 schema 里的
    // `maxLength` 变成真正的入口校验——那时放行更长的提示词等于发一次必然失败
    // 的付费请求。报错带上实际字数，用户才知道要砍多少。
    let prompt = resolved.rendered_prompt.clone();
    let prompt_length = prompt.chars().count();
    if prompt_length > 1024 {
        return Err(BackendError::validation(
            format!("提示词 {prompt_length} 字符，超过 1024 字符上限，请精简后再生成。"),
            json!({ "taskId": task.id, "length": prompt_length, "limit": 1024 }),
        ));
    }
    validate_atlascloud_parameters(task, resolved, &["sref"])?;

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    // 只要托管链接：结果落盘阶段再下载，不让平台回传 Base64 字节。
    body.insert("enable_base64_output".into(), json!(false));

    // 参考图：顶层单值 `image` 字段。公网 URL 原样透传，本地图片编码为
    // data URI（文档声明 base64 与 URL 均可）。
    let image_field = request_field(&resolved.operation_schema, "mediaField", "image")?;
    let image = &resolved.images[0];
    let image_value = if let Some(reference) = image
        .remote_reference
        .as_deref()
        .filter(|reference| !reference.is_empty())
    {
        Value::String(reference.to_string())
    } else {
        let bytes = image.bytes.clone().ok_or_else(|| {
            BackendError::validation(
                "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
                image.archive(),
            )
        })?;
        Value::String(format!(
            "data:{};base64,{}",
            image.mime_type,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    };
    body.insert(image_field, image_value);

    // aspect_ratio / hd / quality / stylize / chaos / weird / seed / sref 由参数
    // 表声明在顶层（root）。
    //
    // 只发送**本契约声明**的参数：画布节点上可能残留着上一个模型的参数（例如
    // Grok 的 `resolution`/`num_images`），把它们塞进请求体会被上游以「未知字段」
    // 拒绝，或更糟——被上游静默忽略，用户却以为自己设了。
    insert_atlascloud_declared_parameters(&mut body, resolved, true)?;
    Ok(Value::Object(body))
}

/// Atlas Cloud **FLUX 3 编辑**请求体（`POST /api/v1/model/generateImage`）。
///
/// 与同平台的 Grok Imagine、Midjourney V8.2 两个家族有**契约级**差异（都来自
/// 平台文档，不是推测）：
///
/// 1. 参考图走顶层 **`reference_images` 数组**（不是 Grok 的 `image_urls`，也不是
///    Midjourney 的单值 `image`），且接受 **1–10 张**——顺序即提示词里说的
///    「图 1 … 图 10」；
/// 2. **不发** `num_images`：平台文档没有这个参数（与 Midjourney 同一先例）；
/// 3. 参数表是 `aspect_ratio` / `resolution` / `enable_prompt_expansion` /
///    `output_format` / `safety_tolerance`，**没有** `quality`；`resolution` 多一档
///    `768sq`（方图专用）并支持 `4k`。
///
/// 提示词长度：平台文档**没有**给 `prompt` 声明上限（对比 Grok 的 8000、Midjourney
/// 的 1024），因此这里**不设**本地长度闸门——凭空造一个上限会拦掉上游实际接受的
/// 提示词。文档只提示「短而直接的指令效果最好」。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_flux3_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "FLUX 3 编辑只能编码图片参考；请只连接图片素材。",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存图片模型。", json!({ "taskId": task.id }))
        })?;
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !model.eq_ignore_ascii_case(ATLASCLOUD_FLUX3_IMAGE_MODEL) {
        // 家族前缀命中但本站没有登记请求体的成员：派发前明确拒绝，
        // 不套用别的成员的请求体，也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的请求体，请改用已登记的 FLUX 3 编辑模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if task.operation != GenerationOperation::ImageToImage {
        // 该成员只有「参考图编辑」形态，没有文生图；文生图请求必然被上游拒绝，
        // 与其发一次付费请求再失败，不如在本地说明。
        return Err(BackendError::validation(
            "FLUX 3 编辑模型必须带 1–10 张参考图：请连接参考图片，或改选文生图模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    // 文档：参考图 1–10 张。
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "FLUX 3 编辑模型必须带 1–10 张参考图：请先连接参考图片。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if resolved.images.len() > 10 {
        return Err(BackendError::validation(
            "FLUX 3 编辑模型最多接受 10 张参考图，请先解绑多余的素材。",
            json!({
                "taskId": task.id,
                "model": model,
                "images": resolved.images.len()
            }),
        ));
    }
    validate_atlascloud_parameters(task, resolved, &[])?;

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(resolved.rendered_prompt.clone()));
    // 只要托管链接：结果落盘阶段再下载，不让平台回传 Base64 字节。
    body.insert("enable_base64_output".into(), json!(false));

    // 参考图：顶层 `reference_images` 数组。公网 URL 原样透传，本地图片编码为
    // data URI（文档声明 base64 与 URL 均可）。
    let image_field = request_field(&resolved.operation_schema, "mediaField", "reference_images")?;
    let inputs = resolved
        .images
        .iter()
        .map(|image| {
            if let Some(reference) = image
                .remote_reference
                .as_deref()
                .filter(|reference| !reference.is_empty())
            {
                return Ok(Value::String(reference.to_string()));
            }
            let bytes = image.bytes.clone().ok_or_else(|| {
                BackendError::validation(
                    "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
                    image.archive(),
                )
            })?;
            Ok(Value::String(format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    body.insert(image_field, Value::Array(inputs));

    // aspect_ratio / resolution / enable_prompt_expansion / output_format /
    // safety_tolerance 由参数表声明在顶层（root），原样透传。
    insert_atlascloud_declared_parameters(&mut body, resolved, true)?;
    Ok(Value::Object(body))
}

/// Atlas Cloud **Qwen Image 3.0 Pro 编辑**请求体
/// （`POST /api/v1/model/generateImage`）。
///
/// 与同平台另三个家族有**契约级**差异（都来自平台文档，不是推测）：
///
/// 1. 参考图走顶层 **`reference_image_urls` 数组**（1–3 张）——既不是 Grok 的
///    `image_urls`、也不是 Midjourney 的单值 `image`，也不是 FLUX 3 的
///    `reference_images`（字段名不同、张数上限也不同：3 vs 10）；
/// 2. **不发** `num_images`（文档没有这个参数）：一次请求出几张由 **`n`**
///    表达（1–4）；
/// 3. **不发** `enable_base64_output`（文档的入参表里没有这个字段）：只发契约
///    声明的参数，否则上游可能以「未知字段」拒绝；
/// 4. 参数表是 `size` / `n` / `negative_prompt` / `seed` / `prompt_extend` /
///    `prompt_extend_mode`，**没有** `aspect_ratio` / `resolution` / `quality`；
/// 5. 提示词长度：平台文档**没有**给 `prompt` 声明上限（对比 Grok 的 8000、
///    Midjourney 的 1024），因此这里**不设**本地长度闸门——凭空造一个上限会拦掉
///    上游实际接受的提示词。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_qwen_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "Qwen Image 3.0 Pro 编辑只能编码图片参考；请只连接图片素材。",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
                "audios": resolved.audios.len()
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存图片模型。", json!({ "taskId": task.id }))
        })?;
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !model.eq_ignore_ascii_case(ATLASCLOUD_QWEN_IMAGE_MODEL) {
        // 家族前缀命中但本站没有登记请求体的成员（例如文档默认值
        // `qwen-image-3.0/edit`）：派发前明确拒绝，不套用 Pro 成员的请求体，
        // 也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的请求体，请改用已登记的 Qwen Image 3.0 Pro 编辑模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if task.operation != GenerationOperation::ImageToImage {
        // 该成员只有「参考图编辑」形态，没有文生图；文生图请求必然被上游拒绝，
        // 与其发一次付费请求再失败，不如在本地说明。
        return Err(BackendError::validation(
            "Qwen Image 3.0 Pro 编辑模型必须带 1–3 张参考图：请连接参考图片，或改选文生图模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    // 文档：参考图 1–3 张（单图编辑给 1 张，多图参考 / 主体驱动给到 3 张）。
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "Qwen Image 3.0 Pro 编辑模型必须带 1–3 张参考图：请先连接参考图片。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if resolved.images.len() > 3 {
        return Err(BackendError::validation(
            "Qwen Image 3.0 Pro 编辑模型最多接受 3 张参考图，请先解绑多余的素材。",
            json!({
                "taskId": task.id,
                "model": model,
                "images": resolved.images.len()
            }),
        ));
    }
    // `prompt_extend_mode` 的取值单独说：上游对**参考图编辑**只接受 `direct`。
    // `agent`（APE）虽然写在文档的参数描述里，但实测被上游拒绝
    // （`prompt_extend_mode=agent is not supported for i2i requests`），所以本地
    // 先拦下来并说明原因，而不是发一次必然失败的付费请求。
    //
    // 这条检查**排在通用枚举校验之前**：通用校验只会说「取值不在模型契约允许的范
    // 围内」，不会告诉用户「为什么 agent 不行」。
    validate_atlascloud_qwen_prompt_extend_mode(task, resolved)?;
    validate_atlascloud_parameters(task, resolved, &[])?;
    // `size` 是契约里唯一的自由格式参数（`宽*高`），通用校验只管类型/枚举/数值，
    // 格式与取值范围在这里单独校。
    validate_atlascloud_qwen_size(task, resolved)?;

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(resolved.rendered_prompt.clone()));

    // 参考图：顶层 `reference_image_urls` 数组。公网 URL 原样透传，本地图片编码为
    // data URI（文档声明 base64 与 URL 均可）。
    let image_field = request_field(&resolved.operation_schema, "mediaField", "reference_image_urls")?;
    let inputs = resolved
        .images
        .iter()
        .map(|image| {
            if let Some(reference) = image
                .remote_reference
                .as_deref()
                .filter(|reference| !reference.is_empty())
            {
                return Ok(Value::String(reference.to_string()));
            }
            let bytes = image.bytes.clone().ok_or_else(|| {
                BackendError::validation(
                    "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
                    image.archive(),
                )
            })?;
            Ok(Value::String(format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    body.insert(image_field, Value::Array(inputs));

    // size / n / negative_prompt / seed / prompt_extend / prompt_extend_mode 由
    // 参数表声明在顶层（root）。
    //
    // 只发送**本契约声明**的参数：画布节点上可能残留着上一个模型的参数（例如
    // Grok 的 `resolution`/`quality`、Midjourney 的 `stylize`），把它们塞进请求体
    // 会被上游以「未知字段」拒绝，或更糟——被上游静默忽略，用户却以为自己设了。
    insert_atlascloud_declared_parameters(&mut body, resolved, true)?;
    Ok(Value::Object(body))
}

/// Atlas Cloud **Vidu Q4 参考图生视频**请求体（`POST /api/v1/model/generateVideo`）。
///
/// 与同平台四个图片家族的契约差异（都来自平台文档，不是推测）：
///
/// 1. 端点是 `generateVideo`（图片家族是 `generateImage`）；
/// 2. 参考图走顶层 `reference_images` **数组**（1–15 张，顺序即提示词里的「图 1 …
///    图 15」），不是 Grok 的 `image_urls`、也不是 Midjourney 的单值 `image`；
/// 3. 多出 `reference_audios` 数组（0–3 段参考音频）；
/// 4. 参数表是 `duration` / `aspect_ratio` / `resolution` / `generate_audio` /
///    `seed`，没有 `num_images`、没有 `quality`、没有 `enable_base64_output`。
///
/// 参考图与参考音频：公网 URL 原样透传，本地文件编码为 data URI（文档声明
/// base64 与 URL 均可）。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_vidu_video_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.videos.is_empty() {
        // 文档的输入参数表里没有视频素材位（只有参考图与参考音频）。发过去必然被
        // 上游拒绝，不如在本地说明。
        return Err(BackendError::validation(
            "Vidu Q4 参考图生视频只接受参考图与参考音频，不能连接视频素材。",
            json!({
                "taskId": task.id,
                "videos": resolved.videos.len(),
            }),
        ));
    }
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存视频模型。", json!({ "taskId": task.id }))
        })?;
    if !is_atlascloud_vidu_video_model(model) {
        // 家族前缀命中但本站没有登记请求体的成员：派发前明确拒绝，不套用别的
        // 成员的请求体，也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的视频请求体，请改用已登记的 Vidu Q4 参考图生视频模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if !model.eq_ignore_ascii_case(ATLASCLOUD_VIDU_VIDEO_MODEL) {
        // 同前缀但未登记的成员：与图片家族同一口径，宁可显式拒绝。
        return Err(BackendError::validation(
            "该 Vidu Q4 模型尚未登记 Atlas Cloud 的视频请求体，请改用 Vidu Q4 参考图生视频模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    // 文档：必须 1–15 张参考图（reference_images 是必填项，最少 1 张、最多 15 张）。
    if resolved.images.is_empty() {
        return Err(BackendError::validation(
            "Vidu Q4 参考图生视频必须带 1–15 张参考图：请先连接参考图片。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if resolved.images.len() > 15 {
        return Err(BackendError::validation(
            "Vidu Q4 参考图生视频最多接受 15 张参考图，请先解绑多余的素材。",
            json!({
                "taskId": task.id,
                "model": model,
                "images": resolved.images.len(),
                "limit": 15,
            }),
        ));
    }
    // 文档：参考音频 0–3 段。
    if resolved.audios.len() > 3 {
        return Err(BackendError::validation(
            "Vidu Q4 参考图生视频最多接受 3 段参考音频，请先解绑多余的素材。",
            json!({
                "taskId": task.id,
                "model": model,
                "audios": resolved.audios.len(),
                "limit": 3,
            }),
        ));
    }
    // 文档：提示词必填，上限 20000 字符。
    let prompt = video_prompt(resolved);
    if prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "Vidu Q4 参考图生视频需要提示词：请先填写画面描述。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if prompt.chars().count() > 20000 {
        return Err(BackendError::validation(
            "提示词超过 20000 字符上限，请精简后再生成。",
            json!({ "taskId": task.id, "length": prompt.chars().count(), "limit": 20000 }),
        ));
    }
    // 参数取值（类型 / 枚举 / 最小最大）在派发前本地校验：上游对越界取值会直接
    // 拒绝，而那已经是一次付费请求。
    validate_atlascloud_parameters(task, resolved, &[])?;

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));

    // 参考图：顶层 `reference_images` 数组。公网 URL 原样透传，本地图片编码为
    // data URI（文档声明 base64 与 URL 均可）。
    let image_field = request_field(&resolved.operation_schema, "mediaField", "reference_images")?;
    let images = resolved
        .images
        .iter()
        .map(|image| atlascloud_video_reference(image, "参考图片无法读取，请重新选择本地图片或有效的图片链接。"))
        .collect::<BackendResult<Vec<_>>>()?;
    body.insert(image_field, Value::Array(images));

    // 参考音频：顶层 `reference_audios` 数组（文档标注为可选，0–3 段）。
    let audio_field = request_field(&resolved.operation_schema, "audioField", "reference_audios")?;
    if !resolved.audios.is_empty() {
        let audios = resolved
            .audios
            .iter()
            .map(|audio| {
                atlascloud_video_reference(
                    audio,
                    "参考音频无法读取，请重新选择本地音频或有效的音频链接。",
                )
            })
            .collect::<BackendResult<Vec<_>>>()?;
        body.insert(audio_field, Value::Array(audios));
    }

    // duration / aspect_ratio / resolution / generate_audio / seed 由参数表声明在
    // 顶层（root）。
    //
    // 只发送**本契约声明的参数**：画布节点上可能残留着上一个模型的参数（例如
    // 魔芋 Vidu 的 `watermark`、MiniMax 的 `aigc_watermark`），把它们塞进请求体会
    // 被上游以「未知字段」拒绝，或更糟——被上游静默忽略，用户却以为自己设了。
    insert_atlascloud_declared_parameters(&mut body, resolved, true)?;
    Ok(Value::Object(body))
}

/// Atlas Cloud **Kling 4.0 参考生视频**请求体（`POST /api/v1/model/generateVideo`）。
///
/// 与同平台 Vidu Q4 家族的**契约级**差异（都来自平台文档，不是推测）：
///
/// 1. 媒体槽位不同：参考图走顶层 `reference_images`（≤10 张，含首尾关键帧）、
///    参考视频走顶层 `reference_videos`（≤5 条）、首帧走单值 `image`、尾帧走单值
///    `last_image`；**没有** `reference_audios`；
/// 2. 参数表是 `duration` / `aspect_ratio` / `resolution` 三项，没有
///    `generate_audio`、没有 `seed`；
/// 3. 提示词里的素材指代是 `@image_N` / `@video_N`（Vidu 用「图 N」这类自然
///    语言指代）。
///
/// 参考图与参考视频：公网 URL 原样透传，本地文件编码为 data URI（文档声明
/// base64 与 URL 均可）。
///
/// 提交换 prediction id，再轮询 `GET /api/v1/model/prediction/{id}` 取结果。
fn build_atlascloud_kling_video_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation("请先选择并保存视频模型。", json!({ "taskId": task.id }))
        })?;
    if !is_atlascloud_kling_video_model(model) {
        // 家族前缀命中但本站没有登记请求体的成员：派发前明确拒绝，不套用别的
        // 成员的请求体，也不退回通用形态盲发。
        return Err(BackendError::validation(
            "该模型尚未登记 Atlas Cloud 的视频请求体，请改用已登记的 Kling 4.0 参考生视频模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if !model.eq_ignore_ascii_case(ATLASCLOUD_KLING_VIDEO_MODEL) {
        // 同前缀但未登记的成员：与图片家族同一口径，宁可显式拒绝。
        return Err(BackendError::validation(
            "该 Kling 4.0 模型尚未登记 Atlas Cloud 的视频请求体，请改用 Kling 4.0 参考生视频模型。",
            json!({ "taskId": task.id, "model": model }),
        ));
    }
    if !resolved.audios.is_empty() {
        // 文档的输入参数表里没有音频素材位：它的语音位是 `voice_ids`（Kling 音色
        // ID），不是音频文件。静默丢掉等于让用户以为音色被采纳了。
        return Err(BackendError::validation(
            "Kling 4.0 参考生视频不接受音频素材：它的语音位是 Kling 音色 ID，不是音频文件。请先解绑音频素材。",
            json!({
                "taskId": task.id,
                "audios": resolved.audios.len(),
            }),
        ));
    }
    let slots = kling_media_slots(resolved)?;
    // 文档：图片素材合计（首帧 + 尾帧 + 参考图）最多 10 张。
    if slots.image_count > ATLASCLOUD_KLING_VIDEO_MAX_IMAGES {
        return Err(BackendError::validation(
            format!(
                "Kling 4.0 参考生视频最多接受 {ATLASCLOUD_KLING_VIDEO_MAX_IMAGES} 张图片素材（首帧、尾帧与参考图合计），请先解绑多余的素材。"
            ),
            json!({
                "taskId": task.id,
                "model": model,
                "images": slots.image_count,
                "limit": ATLASCLOUD_KLING_VIDEO_MAX_IMAGES,
            }),
        ));
    }
    // 文档：参考视频最多 5 条。
    if slots.videos.len() > ATLASCLOUD_KLING_VIDEO_MAX_VIDEOS {
        return Err(BackendError::validation(
            format!(
                "Kling 4.0 参考生视频最多接受 {ATLASCLOUD_KLING_VIDEO_MAX_VIDEOS} 条参考视频，请先解绑多余的素材。"
            ),
            json!({
                "taskId": task.id,
                "model": model,
                "videos": slots.videos.len(),
                "limit": ATLASCLOUD_KLING_VIDEO_MAX_VIDEOS,
            }),
        ));
    }
    // 文档：提示词必填，长度上限按语言分档（英文 26000、非英文 11000）。
    let prompt = kling_prompt(resolved, &slots)?;
    let prompt_limit = kling_prompt_limit(&prompt);
    if prompt.chars().count() > prompt_limit {
        return Err(BackendError::validation(
            "提示词超过 Kling 4.0 的长度上限，请精简后再生成。",
            json!({
                "taskId": task.id,
                "length": prompt.chars().count(),
                "limit": prompt_limit,
            }),
        ));
    }
    // 参数取值（类型 / 枚举 / 最小最大）在派发前本地校验：上游对越界取值会直接
    // 拒绝，而那已经是一次付费请求。
    validate_atlascloud_parameters(task, resolved, &[])?;

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    // 首帧 / 尾帧：顶层单值字段（文档的 `image` / `last_image`）。
    if let Some(first_frame) = slots.first_frame {
        body.insert("image".into(), first_frame);
    }
    if let Some(last_frame) = slots.last_frame {
        body.insert("last_image".into(), last_frame);
    }
    // 参考图：顶层 `reference_images` 数组（文档标注为可选，没有就不发这个键）。
    let image_field = request_field(&resolved.operation_schema, "mediaField", "reference_images")?;
    if !slots.reference_images.is_empty() {
        body.insert(image_field, Value::Array(slots.reference_images));
    }
    // 参考视频：顶层 `reference_videos` 数组（文档标注为可选）。
    let video_field = request_field(&resolved.operation_schema, "videoField", "reference_videos")?;
    if !slots.videos.is_empty() {
        body.insert(video_field, Value::Array(slots.videos));
    }
    // duration / aspect_ratio / resolution 由参数表声明在顶层（root）。
    //
    // 只发送**本契约声明的参数**：画布节点上可能残留着上一个模型的参数（例如
    // Vidu 的 `generate_audio` / `seed`、魔芋 Vidu 的 `watermark`），把它们塞进
    // 请求体会被上游以「未知字段」拒绝，或更糟——被上游静默忽略，用户却以为
    // 自己设了。
    insert_atlascloud_declared_parameters(&mut body, resolved, true)?;
    Ok(Value::Object(body))
}

/// Kling 4.0 请求体里的素材分槽，以及提示词里素材的指代记号。
///
/// 文档的编号规则：关键帧先编号（首帧 → 中间帧 → 尾帧），参考图接着编号；
/// 参考视频单独按 `@video_N` 编号。本画布没有「中间帧」槽位，因此实际顺序是
/// 首帧、尾帧、参考图。
struct KlingMediaSlots {
    /// 首帧（顶层 `image` 字段）。
    first_frame: Option<Value>,
    /// 尾帧（顶层 `last_image` 字段）。
    last_frame: Option<Value>,
    /// 参考图（顶层 `reference_images` 数组）。
    reference_images: Vec<Value>,
    /// 参考视频（顶层 `reference_videos` 数组）。
    videos: Vec<Value>,
    /// 素材身份 → 提示词里的指代记号（`@image_N` / `@video_N`）。
    tokens: HashMap<(MediaType, u32), String>,
    /// 图片素材总张数（首帧 + 尾帧 + 参考图），用于对照文档的上限。
    image_count: usize,
}

/// 把画布素材分到 Kling 4.0 的四个槽位，并算出提示词里的 `@image_N` /
/// `@video_N` 记号。
///
/// 槽位按素材**用途**（`role`）判定：画布上标成「首帧 / 尾帧」的图片进关键帧
/// 槽位，其余图片都是参考图；视频一律进参考视频槽位。用途相同的第二张图片
/// （例如用户连了两张首帧）退化成参考图，不静默丢弃。
fn kling_media_slots(resolved: &ResolvedGeneration) -> BackendResult<KlingMediaSlots> {
    let mut first_frame: Option<&ResolvedMedia> = None;
    let mut last_frame: Option<&ResolvedMedia> = None;
    let mut references: Vec<&ResolvedMedia> = Vec::new();
    for image in &resolved.images {
        match image.role.as_str() {
            "first_frame" if first_frame.is_none() => first_frame = Some(image),
            "last_frame" if last_frame.is_none() => last_frame = Some(image),
            _ => references.push(image),
        }
    }
    let mut tokens: HashMap<(MediaType, u32), String> = HashMap::new();
    let mut image_index = 0usize;
    let mut first_frame_value = None;
    if let Some(media) = first_frame {
        image_index += 1;
        tokens.insert(
            (MediaType::Image, media.type_position),
            format!("@image_{image_index}"),
        );
        first_frame_value = Some(atlascloud_video_reference(
            media,
            "首帧图片无法读取，请重新选择本地图片或有效的图片链接。",
        )?);
    }
    let mut last_frame_value = None;
    if let Some(media) = last_frame {
        image_index += 1;
        tokens.insert(
            (MediaType::Image, media.type_position),
            format!("@image_{image_index}"),
        );
        last_frame_value = Some(atlascloud_video_reference(
            media,
            "尾帧图片无法读取，请重新选择本地图片或有效的图片链接。",
        )?);
    }
    let mut reference_images = Vec::with_capacity(references.len());
    for media in references {
        image_index += 1;
        tokens.insert(
            (MediaType::Image, media.type_position),
            format!("@image_{image_index}"),
        );
        reference_images.push(atlascloud_video_reference(
            media,
            "参考图片无法读取，请重新选择本地图片或有效的图片链接。",
        )?);
    }
    let mut videos = Vec::with_capacity(resolved.videos.len());
    for (index, media) in resolved.videos.iter().enumerate() {
        tokens.insert(
            (MediaType::Video, media.type_position),
            format!("@video_{}", index + 1),
        );
        videos.push(atlascloud_video_reference(
            media,
            "参考视频无法读取，请重新选择本地视频或有效的视频链接。",
        )?);
    }
    Ok(KlingMediaSlots {
        first_frame: first_frame_value,
        last_frame: last_frame_value,
        reference_images,
        videos,
        tokens,
        image_count: image_index,
    })
}

/// Kling 4.0 的提示词：把画布提示词里的素材占位换成平台认识的 `@image_N` /
/// `@video_N` 指代。
///
/// 平台的输入参数表明确要求用 `@image_N` / `@video_N` 指代参考素材。画布侧渲染
/// 出来的是「图片1」「[图片1：文件名]」这类自然语言占位，直接发过去模型无法把
/// 参考图和文字描述对上。这里按结构化 `content` 重建：文字原样保留，素材位置
/// 换成对应记号。
fn kling_prompt(resolved: &ResolvedGeneration, slots: &KlingMediaSlots) -> BackendResult<String> {
    let mut prompt = String::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) => prompt.push_str(text),
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => match slots.tokens.get(&(*media_type, *type_position)) {
                Some(token) => prompt.push_str(token),
                None => {
                    // 素材没进请求体（例如被用途判定挡下），提示词里不留悬空占位，
                    // 退回通用标签，至少不会让模型去引用一个不存在的图。
                    let label = match media_type {
                        MediaType::Image => "图片",
                        MediaType::Video => "视频",
                        MediaType::Audio => "音频",
                        MediaType::Text => "文本",
                    };
                    prompt.push_str(&format!("{label}{type_position}"));
                }
            },
        }
    }
    if prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "Kling 4.0 参考生视频需要提示词：请先填写画面描述。",
            json!({}),
        ));
    }
    Ok(prompt)
}

/// Kling 4.0 的提示词长度上限：英文 26000 字符，非英文 11000 字符（文档口径）。
///
/// 文档把两个上限并列为「26,000 English characters (11,000 non-English)」，
/// 这里按「提示词里只要出现非英文字符就按较严的那一档判定」执行——混合文本按
/// 上限的严格者处理，不会因为混了几个英文单词就放行到 26000。
fn kling_prompt_limit(prompt: &str) -> usize {
    if prompt.chars().any(|character| !character.is_ascii()) {
        ATLASCLOUD_KLING_VIDEO_MAX_PROMPT_CHARS_NON_ASCII
    } else {
        ATLASCLOUD_KLING_VIDEO_MAX_PROMPT_CHARS
    }
}

/// 把一个已解析的素材变成 Atlas Cloud 视频接口的参考素材取值：公网 URL 原样透传，
/// 本地文件编码为 data URI（`data:<mime>;base64,…`）。
///
/// 平台文档声明参考图可以给 URL 或 Base64；参考音频一栏写的是「音频片段 URL」，
/// 但同一份文档的 Notes 说明文件形式支持 URL、base64 data URI 与上传接口三种，
/// 因此本地音频同样按 data URI 内联（否则本地音频根本没有可投递的形态）。
fn atlascloud_video_reference(media: &ResolvedMedia, message: &str) -> BackendResult<Value> {
    if let Some(reference) = media
        .remote_reference
        .as_deref()
        .filter(|reference| !reference.is_empty())
    {
        return Ok(Value::String(reference.to_string()));
    }
    let bytes = media.bytes.clone().ok_or_else(|| {
        BackendError::validation(message.to_string(), media.archive())
    })?;
    Ok(Value::String(format!(
        "data:{};base64,{}",
        media.mime_type,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

/// 校验 Qwen 的 `prompt_extend_mode`：参考图编辑只接受 `direct`（单遍改写 DPE）。
///
/// 平台文档的参数描述里提到了 `agent`（APE，agentic 改写管线），但 `Options` 只列
/// 了 `direct`。实测（2026-10-29，真实 Key，协议层直打）：`agent` 会被受理
/// （提交回执 `data.status = processing`），随后在轮询阶段失败，`data.error` 为
/// `prompt_extend_mode=agent is not supported for i2i requests`（信封 `code = 400`，
/// 失败响应里没有 `price` 字段）。也就是说：**参考图编辑这条路只有 `direct` 能用**，
/// `agent` 是文生图侧的能力。
///
/// 因此本地在派发前拦下 `agent`，并把原因说清楚——而不是发一次必然失败的付费
/// 请求，再让用户去读一句英文上游错误。
fn validate_atlascloud_qwen_prompt_extend_mode(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<()> {
    let Some(value) = resolved
        .parameters
        .get("prompt_extend_mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if value.eq_ignore_ascii_case("direct") {
        return Ok(());
    }
    Err(BackendError::validation(
        format!(
            "「改写方式」当前只支持 direct（单遍改写）。上游不支持参考图编辑用 {value} 改写，请改选 direct。"
        ),
        json!({ "taskId": task.id, "parameter": "prompt_extend_mode", "value": value }),
    ))
}

/// 校验 Qwen 的 `size` 参数：形如 `宽*高`（例如 `1280*720`），宽高各 512–1440。
///
/// 文档把取值范围写成「512*512–1440*1440」，因此本地按**每一维**落在
/// [512, 1440] 判定（`512*512` 是最小的一档，`1440*1440` 是最大的一档）。
/// 留空 = 用户没填 = 让模型自选分辨率，这个键不进请求体，因此不校验。
fn validate_atlascloud_qwen_size(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<()> {
    let Some(raw) = resolved
        .parameters
        .get("size")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let invalid = |detail: &str| {
        BackendError::validation(
            format!("「输出尺寸」需要写成 宽*高（例如 1280*720），宽与高各 512–1440。{detail}"),
            json!({ "taskId": task.id, "parameter": "size", "value": raw }),
        )
    };
    let Some((width, height)) = raw.split_once('*') else {
        return Err(invalid("当前写法缺少「*」。"));
    };
    let parse_dimension = |text: &str| -> Option<u32> {
        let trimmed = text.trim();
        if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        trimmed.parse::<u32>().ok()
    };
    let (Some(width), Some(height)) = (parse_dimension(width), parse_dimension(height)) else {
        return Err(invalid("宽与高都要是整数。"));
    };
    if !(512..=1440).contains(&width) || !(512..=1440).contains(&height) {
        return Err(invalid("超出 512–1440 的范围。"));
    }
    Ok(())
}

/// 把契约声明的参数按白名单写进 Atlas 请求体的顶层（root）。
///
/// 只发送**本契约声明**的参数：画布节点上可能残留着上一个模型的参数（例如
/// dall-e 的 `size`/`n`，或 Grok 的 `resolution`），把它们塞进 Atlas 请求体会被
/// 上游以「未知字段」拒绝，或更糟——被上游静默忽略，用户却以为自己设了。这里按
/// 契约白名单过滤：本模型声明的参数一个不丢，别的模型的残留参数不带过去（那些
/// 参数本来就不属于这个模型，不是丢弃用户对当前模型的选择）。
///
/// `skip_blank`：可选参数留空 = 用户没填时，这个键**不进**请求体（上游收到空串
/// 会直接拒绝「期望整数」这类取值）。
fn insert_atlascloud_declared_parameters(
    body: &mut Map<String, Value>,
    resolved: &ResolvedGeneration,
    skip_blank: bool,
) -> BackendResult<()> {
    let declared_fields = resolved
        .operation_schema
        .get("parameters")
        .and_then(Value::as_object)
        .map(|parameters| {
            parameters
                .iter()
                .map(|(key, definition)| {
                    definition
                        .get("requestField")
                        .and_then(Value::as_str)
                        .unwrap_or(key.as_str())
                        .to_string()
                })
                .collect::<BTreeSet<String>>()
        })
        .unwrap_or_default();
    let parameters = mapped_parameters(resolved, "root")?
        .into_iter()
        .filter(|parameter| declared_fields.contains(&parameter.field))
        .filter(|parameter| {
            !skip_blank
                || !parameter
                    .value
                    .as_str()
                    .is_some_and(|value| value.trim().is_empty())
        })
        .collect::<Vec<_>>();
    insert_mapped_parameters(body, "root", parameters)
}

/// 按契约声明校验 Atlas 家族成员的参数取值（类型 / 枚举 / 最小 / 最大）。
///
/// 上游对越界或类型不符的取值会直接拒绝，而那已经是一次付费请求；因此在派发前
/// 本地拦住。判据取自模型档案 `parameters` 的声明（不另写一份数值表——档案改了
/// 这里跟着改），空字符串视为「用户没填」，不算取值错误。
///
/// `https_only_fields` 列出「必须是公网可达 https 地址」的参数名（Midjourney 的
/// `sref`）；其余家族没有这类参数，传空切片。
fn validate_atlascloud_parameters(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
    https_only_fields: &[&str],
) -> BackendResult<()> {
    let Some(definitions) = resolved
        .operation_schema
        .get("parameters")
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    let Some(values) = resolved.parameters.as_object() else {
        return Ok(());
    };
    for (key, definition) in definitions {
        let Some(definition) = definition.as_object() else {
            continue;
        };
        let Some(value) = values.get(key) else {
            continue;
        };
        if value.as_str().is_some_and(|text| text.trim().is_empty()) {
            continue;
        }
        let label = definition
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(key.as_str());
        // 期望整数但拿到小数：单独说，别混进「类型不符」。
        if definition.get("type").and_then(Value::as_str) == Some("integer")
            && value.is_number()
            && value.as_i64().is_none()
            && value.as_u64().is_none()
        {
            return Err(BackendError::validation(
                format!("「{label}」需要整数。"),
                json!({ "taskId": task.id, "parameter": key, "value": value }),
            ));
        }
        let wrong_type = match definition.get("type").and_then(Value::as_str) {
            Some("boolean") => !value.is_boolean(),
            Some("integer") => value.as_i64().is_none() && value.as_u64().is_none(),
            Some("number") => !value.is_number(),
            Some("string") | None => !value.is_string(),
            Some(_) => false,
        };
        if wrong_type {
            return Err(BackendError::validation(
                format!("「{label}」的取值与当前模型契约不符，请在参数区重新选择。"),
                json!({
                    "taskId": task.id,
                    "parameter": key,
                    "value": value,
                    "expected": definition.get("type")
                }),
            ));
        }
        if let Some(allowed) = definition.get("enum").and_then(Value::as_array)
            && !allowed.contains(value)
        {
            return Err(BackendError::validation(
                format!("「{label}」的取值不在模型契约允许的范围内，请重新选择。"),
                json!({
                    "taskId": task.id,
                    "parameter": key,
                    "value": value,
                    "allowed": allowed
                }),
            ));
        }
        if let Some(number) = value.as_f64() {
            if let Some(minimum) = definition.get("minimum").and_then(Value::as_f64)
                && number < minimum
            {
                return Err(BackendError::validation(
                    format!("「{label}」不能小于 {minimum}。"),
                    json!({
                        "taskId": task.id,
                        "parameter": key,
                        "value": number,
                        "minimum": minimum
                    }),
                ));
            }
            if let Some(maximum) = definition.get("maximum").and_then(Value::as_f64)
                && number > maximum
            {
                return Err(BackendError::validation(
                    format!("「{label}」不能大于 {maximum}。"),
                    json!({
                        "taskId": task.id,
                        "parameter": key,
                        "value": number,
                        "maximum": maximum
                    }),
                ));
            }
        }
        // 风格参考图：文档明确要求**公网可达的 https 图片地址**。本地图片或
        // http 地址会被上游拒绝，在派发前拦下来（同样是为了不浪费一次付费请求）。
        if https_only_fields.contains(&key.as_str()) {
            let reference = value.as_str().unwrap_or_default().trim();
            if !reference.starts_with("https://") {
                return Err(BackendError::validation(
                    "「风格参考图 URL」必须是公网可达的 https 图片地址。",
                    json!({ "taskId": task.id, "parameter": key, "value": reference }),
                ));
            }
        }
    }
    Ok(())
}

/// 计算视频任务的状态轮询路径。
///
/// 默认使用 `GET /v1/video/generations/{task_id}`；模型定义可在操作 schema 的
/// `request.observePath` 声明替代路径（支持 `{task_id}` 占位符），例如 Vidu 系列
/// 使用 `GET /v1/videos/{task_id}`。路径会经过与提交路径相同的合法性校验。
fn video_observe_path(storage: &Storage, task: &TaskExecutionRecord) -> BackendResult<String> {
    let remote_task_id = task.remote_task_id.as_deref().unwrap_or_default();
    if GatewayProfile::from_task(task) == Some(GatewayProfile::FzyVideo) {
        return fzy::observe_path(remote_task_id);
    }
    // 草稿及其正片的查询端点属于已提交任务的冻结网关合同。之后修改或
    // 替换模型绑定不能让原任务转向另一个接口；签名结果续查使用同一路径。
    if GatewayProfile::from_task(task) == Some(GatewayProfile::SeedanceDraft) {
        return checked_observe_path(format!("/v1/video/generations/{remote_task_id}"));
    }
    let operation_schema = storage
        .list_model_definitions()?
        .into_iter()
        .find(|definition| definition.id == task.model_definition_id)
        .map(|definition| definition.operations);
    video_observe_path_from_schema(operation_schema.as_ref(), remote_task_id)
}

/// 解析模型声明的视频轮询路径模板（默认 `/v1/video/generations/{task_id}`），
/// 替换 `{task_id}` 占位符并做合法性校验。
///
/// 存档里的操作契约有**两种形状**：按操作分组的
/// `{"video_generation": {"request": {...}}}`（模型定义的常规形状），以及扁平的单
/// 操作对象 `{"request": {...}}`。两种都要认——只认扁平形状时，按操作分组的存档
/// 读不到 `observePath`，会静默退回通用网关的 `/v1/video/generations/{task_id}`，
/// 而那个端点在 Atlas Cloud 上根本不存在（轮询 404，任务永远拿不到产物）。
/// 图片侧的 `image_observe_path` 早已同时探测这两种形状，视频侧此前没有。
fn video_observe_path_from_schema(
    operation_schema: Option<&Value>,
    remote_task_id: &str,
) -> BackendResult<String> {
    let observe_path = operation_schema
        .and_then(|schema| {
            schema
                .pointer("/video_generation/request/observePath")
                .or_else(|| schema.pointer("/request/observePath"))
        })
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let path = match observe_path {
        Some(template) => render_observe_template(&template, remote_task_id),
        None => format!("/v1/video/generations/{remote_task_id}"),
    };
    checked_observe_path(path)
}

/// 渲染观察路径模板：路径段的 `{task_id}` 原样替换（历史行为），查询段（首个
/// `?` 之后）的 `{task_id}` 按 URL 查询值做百分号编码，避免任务号里的特殊
/// 字符破坏查询串。
fn render_observe_template(template: &str, remote_task_id: &str) -> String {
    match template.split_once('?') {
        Some((path, query)) => format!(
            "{}?{}",
            path.replace("{task_id}", remote_task_id),
            query.replace("{task_id}", &encode_query_value(remote_task_id))
        ),
        None => template.replace("{task_id}", remote_task_id),
    }
}

/// URL 查询值的百分号编码：保留非保留字符，其余按字节编码为大写十六进制。
fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

const IMAGE_TASK_OBSERVE_TEMPLATE: &str = "/v1/images/tasks/{task_id}";

/// 异步图片任务的默认轮询路径是 `GET /v1/images/tasks/{id}`。
/// 模型可以在对应操作的 `request.observePath` 里改掉它；Grsai 这类查询串风格
/// 的接口声明 `/v1/api/result?id={task_id}`。
fn image_observe_path(storage: &Storage, task: &TaskExecutionRecord) -> BackendResult<String> {
    let remote_task_id = task.remote_task_id.as_deref().unwrap_or_default();
    if is_fzy_image_task(task) {
        // 只使用提交时冻结的连接与原任务 ID；修改/删除当前模型配置不改变查询协议。
        return checked_observe_path(render_observe_template(
            FZY_IMAGE_OBSERVE_TEMPLATE,
            remote_task_id,
        ));
    }
    let operations = storage
        .list_model_definitions()?
        .into_iter()
        .find(|definition| definition.id == task.model_definition_id)
        .map(|definition| definition.operations);
    let pointer = format!("/{}/request/observePath", task.operation.as_str());
    let template = operations.as_ref().and_then(|schema| {
        schema
            .pointer(&pointer)
            .or_else(|| schema.pointer("/request/observePath"))
            .and_then(Value::as_str)
    });
    let path = match template {
        Some(template) => render_observe_template(template, remote_task_id),
        None => IMAGE_TASK_OBSERVE_TEMPLATE.replace("{task_id}", remote_task_id),
    };
    checked_observe_path(path)
}

fn checked_observe_path(path: String) -> BackendResult<String> {
    // 允许恰好一个 `?` 把路径与查询串分开（Grsai `GET /v1/api/result?id=…`）；
    // `?` 之前仍必须是相对绝对路径，查询串内不允许再出现 `?` 或 `#`。
    let (path_part, query) = match path.split_once('?') {
        Some((path_part, query)) => (path_part.to_string(), Some(query.to_string())),
        None => (path, None),
    };
    let invalid_path = !path_part.starts_with('/')
        || path_part.starts_with("//")
        || path_part.contains('#')
        || path_part.len() > 512;
    let invalid_query = query.as_deref().is_some_and(|query| {
        query.is_empty() || query.contains('?') || query.contains('#') || query.len() > 512
    });
    if invalid_path || invalid_query {
        return Err(BackendError::validation(
            "model observe path must be a relative absolute-path with at most one well-formed query",
            json!({ "path": path_part, "query": query }),
        ));
    }
    Ok(match query {
        Some(query) => format!("{path_part}?{query}"),
        None => path_part,
    })
}

/// 公网 URL 校验核心：按素材来源家族（按次视频 / RD 视频…）生成用户可读的错误文案。
fn require_public_url_value_with(reference: &str, label: &str) -> BackendResult<()> {
    let valid = Url::parse(reference)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());
    if valid {
        Ok(())
    } else {
        Err(BackendError::validation(
            format!("{label}参考素材必须是公网 http(s) URL"),
            json!({ "url": redact_url_string(reference) }),
        ))
    }
}

fn require_public_reference_url_value_with(reference: &str, label: &str) -> BackendResult<()> {
    require_public_url_value_with(reference, label)?;
    let url = Url::parse(reference)?;
    let private_host = match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
        }
        Some(url::Host::Ipv4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
        }
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
        }
        None => true,
    };
    if private_host || !url.username().is_empty() || url.password().is_some() {
        return Err(BackendError::validation(
            format!("{label}参考素材须为无需账号密码的公网 http(s) URL"),
            json!({ "url": redact_url_string(reference) }),
        ));
    }
    Ok(())
}

fn require_public_url_with(
    reference: &str,
    label: &str,
    media: &ResolvedMedia,
) -> BackendResult<()> {
    require_public_reference_url_value_with(reference, label).map_err(|_| {
        BackendError::validation(
            format!("{label}参考素材必须是公网 http(s) URL"),
            media.archive(),
        )
    })
}

fn existing_reference_url_with(label: &str, media: &ResolvedMedia) -> BackendResult<String> {
    let reference = media.remote_reference.as_deref().ok_or_else(|| {
        BackendError::validation(
            format!("{label}参考素材缺少远端 URL；本地文件须先上传"),
            media.archive(),
        )
    })?;
    require_public_url_with(reference, label, media)?;
    Ok(reference.to_string())
}

fn require_sp25_public_url_value(reference: &str) -> BackendResult<()> {
    require_public_url_value_with(reference, "按次视频")
}

fn require_sp25_public_reference_url_value(reference: &str) -> BackendResult<()> {
    require_public_reference_url_value_with(reference, "按次视频")
}

fn sp25_existing_reference_url(media: &ResolvedMedia) -> BackendResult<String> {
    existing_reference_url_with("按次视频", media)
}

fn require_rd_public_reference_url_value(reference: &str) -> BackendResult<()> {
    require_public_reference_url_value_with(reference, "RD 视频")
}

fn rd_existing_reference_url(media: &ResolvedMedia) -> BackendResult<String> {
    existing_reference_url_with("RD 视频", media)
}

fn validate_sp25_video_request(model: &str, resolved: &ResolvedGeneration) -> BackendResult<()> {
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !resolved.parameters.is_object() {
        return Err(BackendError::validation(
            "按次视频参数必须是对象",
            json!({ "model": model }),
        ));
    }
    // 该请求档案只有图片和音频字段，拒绝无法编码的输入，避免静默漏传。
    if !resolved.videos.is_empty()
        || resolved
            .images
            .iter()
            .any(|media| media.role != "reference_image")
    {
        return Err(BackendError::validation(
            "当前按次请求档案无法编码参考视频或首尾帧用途",
            json!({ "model": model, "videos": resolved.videos.len() }),
        ));
    }
    for media in resolved.images.iter().chain(&resolved.audios) {
        if let Some(bytes) = &media.bytes {
            if bytes.is_empty() {
                return Err(BackendError::validation(
                    "参考素材文件为空",
                    media.archive(),
                ));
            }
        } else {
            sp25_existing_reference_url(media)?;
        }
    }
    Ok(())
}

fn build_sp25_video_body(
    model: &str,
    resolved: &ResolvedGeneration,
    images: &[String],
    audios: &[String],
) -> BackendResult<Value> {
    validate_sp25_video_request(model, resolved)?;
    if images.len() != resolved.images.len() || audios.len() != resolved.audios.len() {
        return Err(BackendError::protocol(
            "按次视频素材上传结果与输入数量不一致",
            json!({ "images": images.len(), "referenceAudios": audios.len() }),
        ));
    }
    for reference in images.iter().chain(audios) {
        require_sp25_public_reference_url_value(reference)?;
    }
    let prompt = video_prompt(resolved);
    let prompt = if prompt.trim().is_empty() {
        resolved.rendered_prompt.clone()
    } else {
        prompt
    };
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    if !images.is_empty() {
        body.insert("images".into(), json!(images));
    }
    if !audios.is_empty() {
        body.insert("reference_audios".into(), json!(audios));
    }
    insert_mapped_parameters(&mut body, "metadata", mapped_parameters(resolved, "root")?)?;
    body.entry("ratio").or_insert_with(|| json!("16:9"));
    Ok(Value::Object(body))
}

/// 只检查 RD 请求能否无损编码；远端能力规则由渠道校验。
fn validate_rd_video_request(model: &str, resolved: &ResolvedGeneration) -> BackendResult<()> {
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if !resolved.parameters.is_object() {
        return Err(BackendError::validation(
            "RD 视频参数必须是对象",
            json!({ "model": model }),
        ));
    }
    // 当前上传编译器为首帧、尾帧各保留一个 URL；多个同用途输入无法无损编码。
    for role in ["first_frame", "last_frame"] {
        if resolved
            .images
            .iter()
            .filter(|media| media.role == role)
            .count()
            > 1
        {
            return Err(BackendError::validation(
                "当前 RD 请求编译器每种首尾帧用途只能编码一张图片",
                json!({ "role": role }),
            ));
        }
    }
    // 客户端仅保证素材可上传/可寻址。渠道决定任务能力、数量、格式、大小与时长。
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        if let Some(bytes) = &media.bytes {
            if bytes.is_empty() {
                return Err(BackendError::validation(
                    "参考素材文件为空",
                    media.archive(),
                ));
            }
        } else {
            rd_existing_reference_url(media)?;
        }
    }
    Ok(())
}

/// Seedance 2.5 RD 网关请求体：全部字段为顶层（与魔芋 metadata 契约不同）。
/// `images` / `reference_videos` / `reference_audios` / `start_frame` / `end_frame`
/// 均为公网 URL 数组；当前连接的首尾帧与参考素材完整保留。
fn build_rd_video_body(
    model: &str,
    resolved: &ResolvedGeneration,
    images: Vec<String>,
    videos: Vec<String>,
    audios: Vec<String>,
    start_frame: Option<String>,
    end_frame: Option<String>,
) -> BackendResult<Value> {
    validate_rd_video_request(model, resolved)?;
    let reference_images = resolved
        .images
        .iter()
        .filter(|media| !matches!(media.role.as_str(), "first_frame" | "last_frame"))
        .count();
    let first_frames = resolved
        .images
        .iter()
        .filter(|media| media.role == "first_frame")
        .count();
    let last_frames = resolved
        .images
        .iter()
        .filter(|media| media.role == "last_frame")
        .count();
    if images.len() != reference_images
        || videos.len() != resolved.videos.len()
        || audios.len() != resolved.audios.len()
        || first_frames != usize::from(start_frame.is_some())
        || last_frames != usize::from(end_frame.is_some())
    {
        return Err(BackendError::protocol(
            "RD 视频素材上传结果与输入数量不一致",
            json!({
                "images": images.len(), "referenceImages": reference_images,
                "videos": videos.len(), "referenceVideos": resolved.videos.len(),
                "audios": audios.len(), "referenceAudios": resolved.audios.len(),
                "startFrames": usize::from(start_frame.is_some()), "firstFrames": first_frames,
                "endFrames": usize::from(end_frame.is_some()), "lastFrames": last_frames
            }),
        ));
    }
    for reference in images
        .iter()
        .chain(videos.iter())
        .chain(audios.iter())
        .chain(start_frame.iter())
        .chain(end_frame.iter())
    {
        require_rd_public_reference_url_value(reference)?;
    }
    let prompt = video_prompt(resolved);
    let prompt = if prompt.trim().is_empty() {
        resolved.rendered_prompt.clone()
    } else {
        prompt
    };
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert(
        "prompt".into(),
        json!(seedance_task_prompt(model, resolved, prompt)),
    );
    if let Some(start_frame) = &start_frame {
        body.insert("start_frame".into(), json!([start_frame]));
    }
    if let Some(end_frame) = &end_frame {
        body.insert("end_frame".into(), json!([end_frame]));
    }
    if !images.is_empty() {
        body.insert("images".into(), json!(images));
    }
    if !videos.is_empty() {
        body.insert("reference_videos".into(), json!(videos));
    }
    if !audios.is_empty() {
        body.insert("reference_audios".into(), json!(audios));
    }
    insert_mapped_parameters(&mut body, "metadata", mapped_parameters(resolved, "root")?)?;
    body.entry("ratio").or_insert_with(|| json!("16:9"));
    Ok(Value::Object(body))
}

fn build_seedance_draft_promotion_body(
    model: &str,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !is_seedance_draft_video_model(model)
        || GatewayProfile::from_operation_schema(&resolved.operation_schema)
            != Some(GatewayProfile::SeedanceDraft)
    {
        return Err(BackendError::validation(
            "草稿转正片仅支持已接入的 Seedance 草稿样片网关协议",
            json!({ "model": model }),
        ));
    }
    let parameters = resolved
        .parameters
        .as_object()
        .ok_or_else(|| BackendError::validation("草稿转正片参数必须是对象", json!({})))?;
    let draft_task_id = parameters
        .get("draft_task_id")
        .and_then(Value::as_str)
        .filter(|id| valid_sp25_task_id(id))
        .ok_or_else(|| BackendError::validation("草稿远程任务 ID 无效", json!({})))?;
    if parameters.len() != 1
        || !resolved.images.is_empty()
        || !resolved.videos.is_empty()
        || !resolved.audios.is_empty()
        || !resolved.rendered_prompt.trim().is_empty()
        || !resolved.content.is_empty()
    {
        return Err(BackendError::validation(
            "草稿转正片必须只引用草稿任务，不能重复传入提示词、素材、时长、画幅或其他参数",
            json!({ "draftTaskId": draft_task_id }),
        ));
    }
    Ok(json!({
        "model": model,
        "prompt": "占位",
        "metadata": {
            "content": [{ "type": "draft_task", "draft_task": { "id": draft_task_id } }]
        }
    }))
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
    if resolved.parameters.get("draft_task_id").is_some() {
        ensure_request_encoding(&resolved.operation_schema, "json")?;
        return build_seedance_draft_promotion_body(model, resolved);
    }
    let seedance_draft = GatewayProfile::from_operation_schema(&resolved.operation_schema)
        == Some(GatewayProfile::SeedanceDraft);
    if seedance_draft && !is_seedance_draft_video_model(model) {
        return Err(BackendError::validation(
            "Seedance 草稿样片协议与远程模型不一致",
            json!({ "model": model }),
        ));
    }
    let has_media =
        !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty();
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
        Some("pixverse_image_inputs") => {
            return build_pixverse_video_body(
                model,
                resolved,
                &resolved
                    .images
                    .iter()
                    .map(|media| {
                        media.remote_reference.clone().ok_or_else(|| {
                            BackendError::validation("PixVerse 本地图片需要先上传", media.archive())
                        })
                    })
                    .collect::<BackendResult<Vec<_>>>()?,
            );
        }
        Some("sp25_per_use_urls") => {
            validate_sp25_video_request(model, resolved)?;
            let images = resolved
                .images
                .iter()
                .map(sp25_existing_reference_url)
                .collect::<BackendResult<Vec<_>>>()?;
            let audios = resolved
                .audios
                .iter()
                .map(sp25_existing_reference_url)
                .collect::<BackendResult<Vec<_>>>()?;
            return build_sp25_video_body(model, resolved, &images, &audios);
        }
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
    if seedance_draft {
        body.insert(prompt_field.clone(), json!("占位"));
    }
    if !prompt.trim().is_empty() {
        if !seedance_draft {
            body.insert(prompt_field, Value::String(prompt.clone()));
        }
        if has_media || seedance_draft {
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

/// 保持本地任务意图与已编码字段一致，不在客户端执行渠道能力或配额校验。
fn validate_seedance_25_video_task(
    model: &str,
    resolved: &ResolvedGeneration,
) -> BackendResult<()> {
    if !is_seedance_25_video_model(model) {
        return Ok(());
    }
    if let Some(local_type) = resolved.video_task_type
        && let Some(remote_type) = resolved.parameters["omni_reference_task_type"].as_str()
        && remote_type != local_type.omni_reference_task_type()
    {
        return Err(BackendError::validation(
            "视频任务类型与模型参数不一致，请重新选择任务类型",
            json!({ "videoTaskType": local_type, "omniReferenceTaskType": remote_type }),
        ));
    }
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        if !matches!(
            (media.media_type, media.role.as_str()),
            (
                MediaType::Image,
                "first_frame" | "last_frame" | "reference_image"
            ) | (MediaType::Video, "reference_video")
                | (MediaType::Audio, "reference_audio")
        ) {
            return Err(BackendError::validation(
                "Seedance 2.5 素材类型与用途不匹配",
                media.archive(),
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
        // 参考素材完整保留；输出时长由源视频决定，不发送 duration。
        if resolved.videos.len() != 1 {
            return Err(BackendError::validation(
                "MiniMax-H3 regeneration requires exactly one source video input",
                json!({ "videos": resolved.videos.len() }),
            ));
        }
        body.remove("duration");
    } else if task_type == "h3_context_ir" {
        // Context-IR（智能扩写）产出文本，沿用既有协议省略视频分辨率字段；
        // 连接素材完整提交，支持范围由渠道决定。
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

    for (field, has_connected_media) in [
        (
            "reference_images",
            resolved
                .images
                .iter()
                .any(|media| media.role == "reference_image"),
        ),
        (
            "reference_videos",
            task_type != "regeneration" && !resolved.videos.is_empty(),
        ),
        ("reference_audios", !resolved.audios.is_empty()),
        (
            "first_frame_image",
            resolved
                .images
                .iter()
                .any(|media| media.role == "first_frame"),
        ),
        (
            "last_frame_image",
            resolved
                .images
                .iter()
                .any(|media| media.role == "last_frame"),
        ),
        (
            "base_video_url",
            task_type == "regeneration" && !resolved.videos.is_empty(),
        ),
    ] {
        if has_connected_media && metadata_object.contains_key(field) {
            return Err(BackendError::validation(
                "model parameter collides with a connected media field",
                json!({ "parameter": field }),
            ));
        }
    }

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
                metadata_object.insert("last_frame_image".into(), Value::String(reference.clone()));
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

/// 仅验证单值帧字段与媒体角色的编码完整性；渠道配额和素材组合由服务端判断。
fn validate_minimax_h3_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    let mut first_frames = 0_usize;
    let mut last_frames = 0_usize;
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        match (media.media_type, media.role.as_str()) {
            (MediaType::Image, "first_frame") => first_frames += 1,
            (MediaType::Image, "last_frame") => last_frames += 1,
            (MediaType::Image, "reference_image")
            | (MediaType::Video, "reference_video")
            | (MediaType::Audio, "reference_audio") => {}
            _ => {
                return Err(BackendError::validation(
                    "MiniMax-H3 media role is incompatible with the resolved media type",
                    media.archive(),
                ));
            }
        }
    }
    if first_frames > 1 || last_frames > 1 {
        return Err(BackendError::validation(
            "MiniMax-H3 singleton frame fields cannot encode multiple images with the same role",
            json!({ "firstFrames": first_frames, "lastFrames": last_frames }),
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
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        if !matches!(
            (media.media_type, media.role.as_str()),
            (
                MediaType::Image,
                "first_frame" | "last_frame" | "reference_image"
            ) | (MediaType::Video, "reference_video")
                | (MediaType::Audio, "reference_audio")
                | (_, "file" | "link")
        ) {
            return Err(BackendError::validation(
                "Wan 3.0 media role is incompatible with the resolved media type",
                media.archive(),
            ));
        }
        if matches!(media.role.as_str(), "file" | "link")
            && !media.remote_reference.as_deref().is_some_and(|reference| {
                reference.starts_with("http://") || reference.starts_with("https://")
            })
        {
            return Err(BackendError::validation(
                "Wan 3.0 document/link input must reference a public http(s) URL",
                media.archive(),
            ));
        }
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

fn is_fzy_image_task(task: &TaskExecutionRecord) -> bool {
    task.adapter_id_snapshot == FZY_ADAPTER_ID
        && matches!(
            task.operation,
            GenerationOperation::TextToImage | GenerationOperation::ImageToImage
        )
}

fn is_atlascloud_image_task(task: &TaskExecutionRecord) -> bool {
    task.adapter_id_snapshot == ATLASCLOUD_ADAPTER_ID
        && matches!(
            task.operation,
            GenerationOperation::TextToImage | GenerationOperation::ImageToImage
        )
}

/// Atlas Cloud 提交回执：平台只回 `{"data":{"id":"<prediction id>"}}`——没有任务
/// 状态、没有结果链接。结果要再轮询 `GET /api/v1/model/prediction/{id}` 取。
///
/// 通用回执解析要求「任务号 + 进行中状态」或 HTTP 202 才认异步任务单，而平台
/// 这份回执只有 id，因此这里单独解析：拿不到 id 就按「已受理但没有远程身份」
/// 处理（任务层不会自动重发，避免重复计费）。
fn parse_atlascloud_image_submission(
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationSubmission> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        accepted_without_remote_id_error(
            "Atlas Cloud 已返回成功状态，但响应不是有效 JSON，无法读取 prediction id。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
            json!({ "httpStatus": response.status, "parseError": error.to_string() }),
        )
    })?;
    let task_id = value
        .pointer("/data/id")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            accepted_without_remote_id_error(
                "Atlas Cloud 已返回成功状态，但响应里没有 prediction id。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })?;
    Ok(GenerationSubmission::RemoteImageTask {
        task_id: task_id.to_string(),
    })
}

fn fzy_ambiguous_submission_error(error: BackendError) -> BackendError {
    BackendError::protocol(
        "饭众烟出图的提交结果尚未确认，任务可能已经创建。请保留本次记录和请求编号，联系管理员核查回执后再决定是否重新生成。",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

/// Atlas Cloud 视频提交回执：与出图同一层 `data` 信封，`data.id` 即 prediction id。
///
/// 平台实测的回执里**已经带了** `status`（`processing`）与 `outputs`（`null`），
/// 但应用侧只用 `data.id` 当任务号，不依赖回执里的状态。
///
/// 通用回执解析要求「任务号 + 进行中状态」或 HTTP 202 才认异步任务单，而平台的
/// 回执是 HTTP 200，因此单独解析：拿不到 id 就按「已受理但没有远程身份」处理
/// （任务层不会自动重发，避免重复计费）。
fn parse_atlascloud_video_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        accepted_without_remote_id_error(
            "Atlas Cloud 已返回成功状态，但响应不是有效 JSON，无法读取 prediction id。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
            json!({ "httpStatus": response.status, "parseError": error.to_string() }),
        )
    })?;
    value
        .pointer("/data/id")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            accepted_without_remote_id_error(
                "Atlas Cloud 已返回成功状态，但响应里没有 prediction id。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })
}

/// Atlas Cloud 视频提交结果不明确时的错误包装：平台可能已受理并计费，不能让
/// 任务层自动重发（那会变成第二次计费）。本地校验类错误原样返回。
fn atlascloud_ambiguous_submission_error(error: BackendError) -> BackendError {
    if matches!(
        error,
        BackendError::Validation { .. } | BackendError::Url(_)
    ) {
        return error;
    }
    BackendError::protocol(
        "Atlas Cloud 视频提交结果尚未确认，平台可能已受理并计费。请保留本次记录和请求编号，先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

fn parse_task_image_submission(
    task: &TaskExecutionRecord,
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationSubmission> {
    if is_atlascloud_image_task(task) {
        return parse_atlascloud_image_submission(response);
    }
    if !is_fzy_image_task(task) {
        return parse_image_submission(response);
    }
    if let Err(mut error) = require_success(response) {
        let value: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
        let code = value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // 文档明确这些响应在创建任务前拒绝；其余 5xx、未知回执与传输中断均不能自动重投。
        let rejected = matches!(
            response.status,
            400 | 401 | 402 | 403 | 404 | 413 | 422 | 429
        ) || code == "exchange_rate_unavailable";
        if rejected {
            if let BackendError::Protocol { details, .. } = &mut error {
                details["noChargeTerminal"] = json!(true);
            }
            return Err(error);
        }
        return Err(fzy_ambiguous_submission_error(error));
    }
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        fzy_ambiguous_submission_error(BackendError::protocol("出图回执不是有效 JSON。",
            json!({"httpStatus": response.status, "headers": response.headers, "rawResponse": response.body, "jsonError": error.to_string()})))
    })?;
    let id = value.get("id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty())
        .ok_or_else(|| fzy_ambiguous_submission_error(BackendError::protocol("出图回执缺少任务编号。",
            json!({"httpStatus": response.status, "headers": response.headers, "rawResponse": response.body}))))?;
    // 即使快速任务已经结束，也先保存真实远端 ID，再由原任务查询收取终态与结果。
    Ok(GenerationSubmission::RemoteImageTask {
        task_id: id.to_string(),
    })
}

fn parse_image_submission(response: &CapturedHttpResponse) -> BackendResult<GenerationSubmission> {
    require_success(response)?;
    /*
     * 2xx 但回执读不出来：与视频路径同义 —— 上游已受理（成功状态），可能已经
     * 计费，只是没拿到图、也没拿到任务号。按失败处理会让用户再点一次生成，
     * 那是第二次付费请求。
     */
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        accepted_without_remote_id_error(
            "供应商已返回成功状态，但响应不是有效 JSON，无法读取结果。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
            json!({ "httpStatus": response.status, "parseError": error.to_string() }),
        )
    })?;
    let sources = extract_image_sources(&value);
    if !sources.is_empty() {
        return Ok(GenerationSubmission::Images(sources));
    }
    // 同步接口直接带图。没有图、但有任务号和排队状态（常见是 HTTP 202）时，
    // 这是异步任务单，结果要再查 `GET /v1/images/tasks/{id}`。
    if let Some(task_id) = image_task_ticket(&value, response.status) {
        return Ok(GenerationSubmission::RemoteImageTask { task_id });
    }
    // 上游明确给了失败状态（status=failed 之类）：这是**拒绝**，没有计费。
    if let Some(message) = image_task_failure_message(&value) {
        return Err(BackendError::protocol(
            format!("image task failed: {message}"),
            json!({ "httpStatus": response.status, "rawResponse": response.body }),
        ));
    }
    // 既没有结果、也没有任务号、也没有失败状态：上游受理了但回执不可用。
    Err(accepted_without_remote_id_error(
        "供应商已返回成功状态，但响应里没有结果或任务号。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
        json!({ "httpStatus": response.status, "rawResponse": response.body }),
    ))
}

fn parse_image_observation(
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let images = extract_image_sources(&value);
    let remote_status = value
        .pointer("/output/task_status")
        .or_else(|| value.pointer("/data/status"))
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| (!images.is_empty()).then(|| "succeeded".to_string()))
        .ok_or_else(|| {
            BackendError::protocol(
                "image observation did not return status",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })?;
    let progress = value
        .pointer("/data/progress")
        .or_else(|| value.get("progress"))
        .and_then(parse_progress);
    let fail_reason = value
        .get("error")
        .filter(|value| !value.is_null())
        .cloned()
        // Atlas Cloud 的失败原因写在 `data.error` 信封里。
        .or_else(|| value.pointer("/data/error").cloned())
        .or_else(|| value.get("errorDetail").cloned())
        .or_else(|| value.get("message").cloned());
    // Grsai 把内容违规单独标记为 `violation`（终态，不再轮询）。
    let remote_failed = matches!(
        remote_status.to_ascii_lowercase().as_str(),
        "failure" | "failed" | "canceled" | "cancelled" | "error" | "violation" | "expired"
    );
    let failure = if remote_failed {
        Some(json!({
            "failReason": fail_reason,
            "errorCode": value.get("errorCode"),
            "errorDetail": value.get("errorDetail"),
            "httpStatus": response.status,
            "headers": response.headers,
            "rawResponse": response.body
        }))
    } else {
        None
    };
    Ok(GenerationObservation {
        remote_status,
        progress,
        video_url: None,
        text_content: None,
        images,
        failure,
    })
}

/// 收集成功响应里的全部图片结果。`data[].url` 与 `data[].b64_json` 同等有效：
/// 同一接口经不同网关可能回内联 Base64，也可能回托管 URL（new-api 聚合网关常见），
/// 一律接受，交给结果落盘层统一下载持久化；单项同时带两者时优先 URL。
fn extract_image_sources(value: &Value) -> Vec<ImageSource> {
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
            if let Some(url) = url.filter(|value| !value.is_empty()) {
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
    if let Some(urls) = value.pointer("/data/image_urls").and_then(Value::as_array) {
        for url in urls.iter().filter_map(Value::as_str) {
            push_unique_image_url(&mut sources, url);
        }
    }
    collect_additional_image_sources(value, &mut sources);
    sources
}

fn collect_additional_image_sources(value: &Value, sources: &mut Vec<ImageSource>) {
    const URL_ARRAYS: &[&str] = &[
        "/results",
        "/output/image_urls",
        "/result/image_urls",
        "/image_urls",
        "/images",
        // Atlas Cloud 的结果在 `data.outputs`（托管链接数组）。
        "/data/outputs",
    ];
    const URLS: &[&str] = &[
        "/output/url",
        "/output/image_url",
        "/result/url",
        "/result/image_url",
        "/image_url",
        "/url",
    ];
    const BASE64S: &[&str] = &["/output/b64_json", "/result/b64_json", "/b64_json"];
    for path in URL_ARRAYS {
        let Some(items) = value.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(url) = item.as_str() {
                push_unique_image_url(sources, url);
            } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                push_unique_image_url(sources, url);
            } else if let Some(data) = item.get("b64_json").and_then(Value::as_str) {
                push_unique_image_base64(sources, data);
            }
        }
    }
    for path in URLS {
        if let Some(url) = value.pointer(path).and_then(Value::as_str) {
            push_unique_image_url(sources, url);
        }
    }
    for path in BASE64S {
        if let Some(data) = value.pointer(path).and_then(Value::as_str) {
            push_unique_image_base64(sources, data);
        }
    }
}

fn push_unique_image_url(sources: &mut Vec<ImageSource>, url: &str) {
    let url = url.trim();
    if url.is_empty()
        || !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("data:"))
    {
        return;
    }
    if sources
        .iter()
        .any(|source| matches!(source, ImageSource::Url { url: existing, .. } if existing == url))
    {
        return;
    }
    sources.push(ImageSource::Url {
        url: url.to_string(),
        layer: None,
    });
}

fn push_unique_image_base64(sources: &mut Vec<ImageSource>, data: &str) {
    let data = data.trim();
    if data.is_empty() {
        return;
    }
    if sources.iter().any(
        |source| matches!(source, ImageSource::Base64 { data: existing, .. } if existing == data),
    ) {
        return;
    }
    sources.push(ImageSource::Base64 {
        data: data.to_string(),
        layer: None,
    });
}

/// 提交响应里没有图片、但带了任务号，并且状态还在排队或生成中。
/// HTTP 202 即使没写 status，也按任务单处理。
fn image_task_ticket(value: &Value, http_status: u16) -> Option<String> {
    let task_id = value
        .get("id")
        .or_else(|| value.get("task_id"))
        .or_else(|| value.pointer("/data/id"))
        .or_else(|| value.pointer("/data/task_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|task_id| !task_id.is_empty())?;
    let status = value
        .get("status")
        .or_else(|| value.pointer("/data/status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let in_progress = matches!(
        status.as_str(),
        "queued"
            | "pending"
            | "submitted"
            | "not_start"
            | "created"
            | "running"
            | "processing"
            | "in_progress"
    );
    (http_status == 202 || in_progress).then(|| task_id.to_string())
}

fn image_task_failure_message(value: &Value) -> Option<String> {
    let status = value
        .get("status")
        .or_else(|| value.pointer("/data/status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        status.as_str(),
        "failed" | "failure" | "canceled" | "cancelled" | "error" | "violation"
    ) {
        return None;
    }
    value
        .get("error")
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
        })
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| Some("image task failed".to_string()))
}

fn sp25_response_error(status: u16, raw: &str, fallback: &str) -> BackendError {
    let payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let error = payload.get("error").unwrap_or(&payload);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    BackendError::protocol(
        if code.is_empty() {
            format!("{message} (HTTP {status})")
        } else {
            format!("{message} ({code}, HTTP {status})")
        },
        json!({ "httpStatus": status, "error": redact_request_value(error) }),
    )
}

fn seedance_ambiguous_submission_error(error: BackendError) -> BackendError {
    if matches!(
        error,
        BackendError::Validation { .. } | BackendError::Url(_)
    ) {
        return error;
    }
    /*
     * 已经带精确标记的错误原样保留：`acceptedWithoutRemoteId` 说的是「上游**确定**
     * 已受理（2xx）、只是回执里没有任务号」，比 `ambiguousPaidSubmission` 的
     * 「可能已受理」更准确 —— 改写会丢掉这个区分，而界面正是靠它告诉用户
     * 「可能已计费，先去核对」。
     */
    if has_paid_submission_marker(&error) {
        return error;
    }
    BackendError::protocol(
        "Seedance 视频提交结果无法确认，平台可能已受理；请先核对远程任务，避免重复扣费",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

fn parse_seedance_draft_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    let parsed = parse_video_task_id(response);
    let task_id = match parsed {
        Ok(task_id) if valid_sp25_task_id(&task_id) => return Ok(task_id),
        Ok(_) => BackendError::protocol("Seedance 提交响应的 task_id 格式无效", json!({})),
        Err(error) => error,
    };
    if response.is_success() || response.status >= 500 {
        return Err(seedance_ambiguous_submission_error(task_id));
    }
    Err(task_id)
}

fn sp25_ambiguous_submission_error(error: BackendError) -> BackendError {
    // The HTTP request may already have reached the paid endpoint when a read or
    // lifecycle write fails. Only URL/validation errors are known to occur before send.
    if matches!(
        error,
        BackendError::Validation { .. } | BackendError::Url(_)
    ) {
        return error;
    }
    BackendError::protocol(
        "按次视频提交结果无法确认，平台可能已受理；请先核对远程任务，避免重复扣费",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

/// 错误是否已经带「付费提交回执不明 / 明确未计费 / 已受理但缺任务号」的标记。
///
/// 供应商专用分支与 FZY 出图各自带标记。统一判定先把它们识别出来，保证通用
/// 路径不会改写这些分支已经给出的结论。
fn has_paid_submission_marker(error: &BackendError) -> bool {
    let BackendError::Protocol { details, .. } = error else {
        return false;
    };
    details
        .get("ambiguousPaidSubmission")
        .and_then(Value::as_bool)
        == Some(true)
        || details.get("noChargeTerminal").and_then(Value::as_bool) == Some(true)
        || details
            .get("acceptedWithoutRemoteId")
            .and_then(Value::as_bool)
            == Some(true)
}

/// 「上游已受理并计费，但回执里没有任务号」的错误。
///
/// ## 为什么单独立一个标记
///
/// `ambiguousPaidSubmission` 说的是「**可能**已经受理并计费，但回执不明」
/// —— 典型来源是 5xx 与网络层中断：我们不知道上游建没建任务。
///
/// 而 2xx 是另一回事：**上游明确回了成功状态**，请求一定被受理了，计费大概率
/// 已经发生。缺的只是「任务号」这一个字段（响应体格式不符、字段名不认识、
/// 网关把回执换了形状）。用户看到「失败」会理所当然地再点一次生成 —— 那就是
/// **第二次付费请求**。
///
/// 所以这两种情况必须分开标记：
/// - `ambiguousPaidSubmission`：可能已计费 → 任务落 `Unknown`；
/// - `acceptedWithoutRemoteId`：**确定已受理**、只是缺任务号 → 同样落 `Unknown`，
///   但文案要更明确地让用户去核对远程任务，而不是「可能」。
///
/// 两种标记都会阻止自动重发（重发就是再 POST 一遍付费请求体）。
fn accepted_without_remote_id_error(message: &str, details: Value) -> BackendError {
    BackendError::protocol(
        message,
        json!({
            "acceptedWithoutRemoteId": true,
            "details": redact_request_value(&details),
        }),
    )
}

/// 网关 TTS 的 `audio_config` 采样率取值（文档声明的常用档位）。
const SPEECH_SAMPLE_RATES: [u32; 4] = [8_000, 16_000, 24_000, 48_000];

/// 画布音频节点的任务参数 → 网关 `audio_config` + 音色名。
///
/// 参数来自前端自带的键（`format` / `sample_rate` / `voice_setting_speed` /
/// `voice_setting_pitch` / `voice_setting_vol` / `speaker`），不是模型 Schema 声明的
/// 白名单键，因此这里按名字显式取；区间校验分两层：
/// - 前端语义区间（语速 0.5～2、音调 -12～12、音量 0.01～10）越界 → 直接报错；
/// - 换算成网关的整数区间后由 `speech::gateway_audio_plan` 兜底（它按文档声明的
///   `[-50,100]` / `[-12,12]` 判定），越界同样报错，不做静默截断。
///
/// `language` 在这个端点上没有对应字段（网关 TTS 契约里没有语言项），按约定忽略。
fn speech_audio_config(
    parameters: &Value,
) -> BackendResult<(SpeechAudioConfig, Option<String>)> {
    let parameters = parameters.as_object().cloned().unwrap_or_default();
    let format = parameters
        .get("format")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("wav")
        .to_ascii_lowercase();
    if format == "pcm" {
        return Err(BackendError::validation(
            "pcm 是无头裸流，应用无法校验时长也不能安全配入音轨，请改用 mp3、wav、ogg_opus 或 flac。",
            json!({ "parameter": "format", "value": format }),
        ));
    }
    let sample_rate = match parameters.get("sample_rate") {
        Some(Value::Null) | None => 24_000,
        Some(value) => {
            let rate = value.as_u64().ok_or_else(|| {
                BackendError::validation(
                    "语音采样率必须是整数。",
                    json!({ "parameter": "sample_rate", "value": value }),
                )
            })? as u32;
            if !SPEECH_SAMPLE_RATES.contains(&rate) {
                return Err(BackendError::validation(
                    "语音采样率只能是 8000、16000、24000 或 48000。",
                    json!({
                        "parameter": "sample_rate",
                        "value": rate,
                        "allowed": SPEECH_SAMPLE_RATES,
                    }),
                ));
            }
            rate
        }
    };
    let speech_rate = speech_rate_parameter(parameters.get("voice_setting_speed"), "voice_setting_speed")?;
    let loudness_rate =
        speech_rate_parameter(parameters.get("voice_setting_vol"), "voice_setting_vol")?;
    let pitch_rate = match parameters.get("voice_setting_pitch") {
        Some(Value::Null) | None => 0,
        Some(value) => {
            let pitch = value.as_i64().ok_or_else(|| {
                BackendError::validation(
                    "音调必须是整数。",
                    json!({ "parameter": "voice_setting_pitch", "value": value }),
                )
            })? as i32;
            if !(-12..=12).contains(&pitch) {
                return Err(BackendError::validation(
                    "音调只能调整 -12～12。",
                    json!({
                        "parameter": "voice_setting_pitch",
                        "value": pitch,
                        "allowed": [-12, 12],
                    }),
                ));
            }
            pitch
        }
    };
    let speaker = parameters
        .get("speaker")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(speaker) = speaker.as_deref() {
        // 音色名的合法性由语音模块统一判定（不能带空格与控制字符）。
        validate_gateway_speaker(speaker)?;
    }
    Ok((
        SpeechAudioConfig {
            format: Some(format),
            sample_rate: Some(sample_rate),
            speech_rate: Some(speech_rate),
            loudness_rate: Some(loudness_rate),
            pitch_rate: Some(pitch_rate),
            enable_subtitle: Some(false),
        },
        speaker,
    ))
}

/// 语速 / 音量：前端是倍率（语速 0.5～2、音量 0.01～10），网关要的是整数
/// `[-50,100]`，换算关系是 `round((倍率 - 1) * 100)`。
fn speech_rate_parameter(value: Option<&Value>, parameter: &str) -> BackendResult<i32> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(0);
    };
    let rate = value.as_f64().ok_or_else(|| {
        BackendError::validation(
            "语音倍率必须是数字。",
            json!({ "parameter": parameter, "value": value }),
        )
    })?;
    if !rate.is_finite() {
        return Err(BackendError::validation(
            "语音倍率必须是有限数字。",
            json!({ "parameter": parameter, "value": value }),
        ));
    }
    let (minimum, maximum) = if parameter == "voice_setting_speed" {
        (0.5_f64, 2.0_f64)
    } else {
        (0.01_f64, 10.0_f64)
    };
    if !(minimum..=maximum).contains(&rate) {
        return Err(BackendError::validation(
            format!(
                "{} 只能调整 {}～{}。",
                if parameter == "voice_setting_speed" {
                    "语速"
                } else {
                    "音量"
                },
                minimum,
                maximum
            ),
            json!({ "parameter": parameter, "value": rate, "allowed": [minimum, maximum] }),
        ));
    }
    Ok(((rate - 1.0) * 100.0).round() as i32)
}

/// 合成结果的 MIME 与文件扩展名：优先按真实字节判定，认不出时退回请求里声明的
/// 容器（网关按 `audio_config.format` 返回对应容器）。
fn audio_content_type(reply: &GatewayTtsReply, container_extension: &str) -> (String, String) {
    match infer::get(&reply.audio) {
        Some(kind) => (
            kind.mime_type().to_string(),
            kind.extension().to_ascii_lowercase(),
        ),
        None => (
            format!("audio/{}", container_extension),
            container_extension.to_string(),
        ),
    }
}

/// 从归一后的响应头里取一个值（头名一律小写）。
fn header_value(headers: &Value, name: &str) -> Option<String> {
    match headers.get(name) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Array(values)) => values
            .iter()
            .find_map(Value::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

/// 通用网关付费提交阶段的统一判定：把「上游可能已经受理并计费、但我们没拿到
/// 回执」的失败标记成 `ambiguousPaidSubmission`，任务层据此不再自动重发。
///
/// 判据按**提交阶段**给，不再按供应商家族枚举：任何走通用提交路径的供应商
/// （含以后新增的）都自动受保护，不需要再补分支。
///
/// - 发送前就能确定的失败（本地参数校验、URL、凭据、素材读取、请求构造、
///   连接都没建起来、落盘）→ 原样返回。请求根本没发出去，重发也不会变好；
///   标成「回执不明」只会白白吞掉本来可以重试的机会。
/// - 请求已经交给上游、但没拿到可信回执（网络层中断、上游 5xx）→ 标记。
///   这类失败会被任务层判为可重试，重发就是再 POST 一遍同一份付费请求体，
///   上游会再建一个任务、再扣一次费。
/// - 上游回了 2xx / 4xx → 原样返回。2xx 说明请求已被受理（回执读不出来是
///   另一类问题，且不会被自动重发）；4xx 是上游明确拒绝，没有计费。两者都
///   不构成重复扣费，不改写它们。
fn ambiguous_paid_submission(task_id: &str, error: BackendError) -> BackendError {
    // 已经带标记的错误原样保留：供应商专用分支与 FZY 出图的既有语义不动。
    if has_paid_submission_marker(&error) {
        return error;
    }
    if !is_ambiguous_paid_submission(&error) {
        return error;
    }
    warn!(
        "[provider] 付费提交回执不明确，已阻止自动重发: taskId={}, kind={}",
        task_id,
        error.payload().kind,
    );
    BackendError::protocol(
        "提交结果无法确认，平台可能已受理并计费；请先核对远程任务，避免重复扣费",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

/// 这次失败是不是「上游可能已经受理并计费、但我们没拿到回执」。
fn is_ambiguous_paid_submission(error: &BackendError) -> bool {
    match error {
        // 发送前就能确定的失败：请求根本没发出去。
        BackendError::Validation { .. }
        | BackendError::Url(_)
        | BackendError::Credential(_)
        | BackendError::NotFound(_)
        | BackendError::Conflict(_)
        | BackendError::Database(_)
        | BackendError::Io(_)
        | BackendError::Desktop(_) => false,
        // 连接都没建起来（DNS / 拒绝连接 / 代理握手）：请求确实没发出去，
        // 上游不可能建过任务，重发是安全的。
        BackendError::Transport(transport) if transport.is_connect() => false,
        // 请求构造失败（请求体序列化、请求头非法）：同样没发出去。
        BackendError::Transport(transport) if transport.is_builder() => false,
        // 网络层中断：请求可能已经送达上游并创建了任务，只是回执没读回来。
        BackendError::Transport(_) => true,
        // 上游回应的失败：只有 5xx 无法判断上游是否已经建过任务并计费。
        BackendError::Protocol { details, .. } => {
            match details.get("httpStatus").and_then(Value::as_u64) {
                Some(status) if status >= 500 => true,
                // 2xx 且回执不可用：上游已受理（成功状态），可能已经计费。
                // 这类错误在解析阶段就被标成 `acceptedWithoutRemoteId`，
                // 由 `has_paid_submission_marker` 提前拦下，不走这里。
                // 走到这里的 2xx 是「上游明确给了业务错误码」= 拒绝，没计费。
                Some(_) => false,
                // 没有状态码：无法判断上游是否已受理。
                None => true,
            }
        }
        // 响应不是 JSON：上游已受理但回执不可用，不会被自动重发。
        // 解析阶段已把这类错误转成 `acceptedWithoutRemoteId`，
        // 这里的分支只覆盖「请求体本身不是 JSON」的更早失败点。
        BackendError::Json(_) => false,
    }
}

fn sp25_submission_unknown(message: &str, details: Value) -> BackendError {
    BackendError::protocol(
        message,
        json!({ "ambiguousPaidSubmission": true, "details": redact_request_value(&details) }),
    )
}

fn parse_gateway_upload_url(response: &CapturedHttpResponse, label: &str) -> BackendResult<String> {
    if !response.is_success() {
        return Err(sp25_response_error(
            response.status,
            &response.body,
            &format!("{label}参考素材上传失败"),
        ));
    }
    let payload: Value = serde_json::from_str(&response.body)?;
    let reference = payload.get("url").and_then(Value::as_str).ok_or_else(|| {
        BackendError::protocol(
            format!("{label}素材上传响应缺少顶层 url，请重新上传素材。"),
            json!({ "httpStatus": response.status, "response": redact_request_value(&payload) }),
        )
    })?;
    require_public_reference_url_value_with(reference, label)?;
    Ok(reference.to_string())
}

fn parse_sp25_video_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    if !response.is_success() {
        let mut error =
            sp25_response_error(response.status, &response.body, "按次视频任务提交失败");
        if let BackendError::Protocol { details, .. } = &mut error {
            let no_charge = response.status < 500
                || details.pointer("/error/code").and_then(Value::as_str)
                    == Some("get_channel_failed");
            if let Some(details) = details.as_object_mut() {
                details.insert(
                    if no_charge {
                        "noChargeTerminal"
                    } else {
                        "ambiguousPaidSubmission"
                    }
                    .into(),
                    json!(true),
                );
            }
        }
        return Err(error);
    }
    let payload: Value = serde_json::from_str(&response.body).map_err(|error| {
        sp25_submission_unknown(
            "按次视频提交已返回成功状态，但响应不是有效 JSON；请先核对远程任务，避免重复扣费",
            json!({ "httpStatus": response.status, "parseError": error.to_string() }),
        )
    })?;
    let task_id = payload
        .get("task_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            sp25_submission_unknown(
                "按次视频提交响应缺少 task_id；请先核对远程任务，避免重复扣费",
                json!({ "httpStatus": response.status, "response": payload }),
            )
        })?;
    if !valid_sp25_task_id(task_id) {
        return Err(sp25_submission_unknown(
            "按次视频提交响应 task_id 格式无效；请先核对远程任务，避免重复扣费",
            json!({ "httpStatus": response.status }),
        ));
    }
    if payload.get("status").and_then(Value::as_str) != Some("queued") {
        return Err(sp25_submission_unknown(
            "按次视频提交响应状态不是 queued；请先核对远程任务，避免重复扣费",
            json!({ "taskId": task_id, "status": payload.get("status") }),
        ));
    }
    Ok(task_id.to_string())
}

fn valid_sp25_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 128
        && task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn parse_video_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    require_success(response)?;
    /*
     * 2xx 但回执读不出来：**上游已受理**（成功状态），只是我们没拿到任务号。
     *
     * 这与 4xx「上游明确拒绝」完全不同 —— 4xx 没有计费，2xx 大概率已经计费。
     * 若按失败处理，用户看到红色「失败」就会再点一次生成，那就是第二次付费
     * 请求。所以这里标记成 `acceptedWithoutRemoteId`，任务层据此落 `Unknown`
     * 并在界面上说清「可能已计费」。
     */
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        accepted_without_remote_id_error(
            "供应商已返回成功状态，但响应不是有效 JSON，无法读取任务号。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
            json!({ "httpStatus": response.status, "parseError": error.to_string() }),
        )
    })?;
    if let Some(task_id) = value
        .pointer("/output/task_id")
        .or_else(|| value.get("task_id"))
        .or_else(|| value.get("id"))
        .or_else(|| value.pointer("/data/task_id"))
        .or_else(|| value.pointer("/data/id"))
        .or_else(|| value.pointer("/result/task_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    {
        return Ok(task_id);
    }
    let code = value
        .get("code")
        .or_else(|| value.pointer("/output/code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|code| !code.is_empty());
    let message = value
        .get("message")
        .or_else(|| value.pointer("/output/message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());
    /*
     * 「上游明确拒绝」还是「已受理但回执不可用」？
     *
     * **只有明确的错误码才算拒绝。** 不能拿「有没有 message 字段」当判据 ——
     * new-api 内核（RD 网关就是它）的标准信封是
     * `{"success": true, "message": "", "data": {...}}`：`message` 是**常规字段**，
     * 不是错误标志。按字段存在性判的话，这种响应会被判成「明确拒绝」→
     * 任务落 `Failed` → 界面显示红色「失败」→ 用户再点一次生成 → **第二个付费
     * 请求**（第一笔很可能已在上游受理并计费）。
     *
     * 也不能拿 message **文本**当判据：各网关的文案千差万别（"任务创建成功"
     * 也叫 message），误判成拒绝同样是重复扣费。
     *
     * 所以判据只认**错误码**，而且错误码还得排除成功码（`0` / `200` /
     * `success` 这类）。拿不到可靠的错误码时，**一律按「已受理但回执不可用」
     * 处理**（落 `Unknown`、不自动重发、提示用户去核对）——
     *
     * 这是刻意的方向选择：不确定时判成「可能已计费」的代价是用户多跑一趟
     * 核对；判成「失败」的代价是**重复扣费**。两者的代价不对称，就往安全
     * 那边倒。
     */
    if !code.is_some_and(|code| !is_success_response_code(code)) {
        return Err(accepted_without_remote_id_error(
            "供应商已返回成功状态，但响应里没有任务号。平台可能已受理并计费，本机也没有任务号可查；请先到供应商后台确认这次请求是否扣费，再决定是否重新生成。",
            json!({ "httpStatus": response.status, "rawResponse": response.body }),
        ));
    }
    Err(BackendError::protocol(
        match (code, message) {
            (Some(code), Some(message)) => format!("video submission failed: {code}: {message}"),
            (Some(code), None) => format!("video submission failed: {code}"),
            (None, Some(message)) => message.to_string(),
            (None, None) => "供应商未返回任务号，也没有给出错误说明。".to_string(),
        },
        json!({ "httpStatus": response.status, "rawResponse": response.body }),
    ))
}

/// 这些码表示「成功」，不能当错误码用。
///
/// 网关的成功码形态很杂：`0`（部分国内网关）、`200`、`"success"`、`"ok"`、
/// `"true"` 都见过。把它们当错误码会把**成功但缺任务号**的响应判成「明确拒绝」
/// → 落 `Failed` → 用户重提交 → 重复扣费。
fn is_success_response_code(code: &str) -> bool {
    matches!(
        code.trim().to_ascii_lowercase().as_str(),
        "0" | "200" | "ok" | "success" | "true"
    )
}

fn parse_video_observation(
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let remote_status = value
        .pointer("/output/task_status")
        .or_else(|| value.pointer("/data/status"))
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
    let fail_reason = value
        .pointer("/data/fail_reason")
        .or_else(|| value.get("fail_reason"))
        .or_else(|| value.pointer("/output/message"))
        .or_else(|| value.pointer("/error/message"))
        .or_else(|| value.get("message"))
        .cloned();
    let upstream_error = value
        .get("error")
        .or_else(|| value.pointer("/data/data/data/data/error"))
        .or_else(|| value.pointer("/data/data/data/error"))
        .or_else(|| value.pointer("/data/data/error"))
        // Atlas Cloud 的失败原因写在 `data.error` 信封里（成功时是空字符串）。
        .or_else(|| value.pointer("/data/error"))
        .cloned();
    let remote_failed = matches!(
        remote_status.to_ascii_uppercase().as_str(),
        "FAILURE" | "FAILED" | "CANCELED" | "CANCELLED"
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
        images: Vec::new(),
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
        "/result_url",
        "/url",
        "/output/video_url",
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
    // Atlas Cloud 的产物在 `data.outputs`（托管链接数组）：成功时是数组，处理中是
    // `null`。图片链路已有同名分支，视频链路原本没有——不补这一条，任务会一路
    // 轮询到「成功但没有产物链接」为止。
    if let Some(url) = value
        .pointer("/data/outputs")
        .and_then(Value::as_array)
        .and_then(|outputs| outputs.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        return Some(url.to_owned());
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
        reject_html_api_response(response.status, &response.headers, &response.body, "")
    } else if (300..400).contains(&response.status) {
        /*
         * 3xx 单独处理：本客户端禁用了自动跟随重定向（307/308 会保留方法与
         * 请求体重发，而请求体里带着提示词与内联 base64 素材），所以供应商
         * 返回跳转地址时会走到这里。
         *
         * 这类错误不能落进通用分支 —— 通用分支会产出 "provider returned HTTP 302"
         * 这种英文技术串，用户既看不懂也不知道该改什么（多半是 API 地址填错、
         * 或供应商换了域名）。这里给出中文人话 + 补救动作。
         */
        Err(BackendError::protocol(
            format!(
                "供应商返回了跳转地址（HTTP {}），请求未送达。请核对该供应商的 API 地址是否正确，或联系供应商确认其接口变更。",
                response.status
            ),
            json!({
                "httpStatus": response.status,
                "redirect": true,
                "retryable": false,
            }),
        ))
    } else {
        let payload: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
        let message = payload
            .pointer("/error/message")
            .or_else(|| payload.pointer("/output/message"))
            .or_else(|| payload.get("message"))
            .or_else(|| payload.get("error"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty());
        let code = payload
            .pointer("/error/code")
            .or_else(|| payload.get("code"))
            .and_then(Value::as_str)
            .filter(|code| !code.is_empty());
        let summary = match (message, code) {
            (Some(message), Some(code)) => format!("{message} ({code}, HTTP {})", response.status),
            (Some(message), None) => format!("{message} (HTTP {})", response.status),
            _ => format!("provider returned HTTP {}", response.status),
        };
        Err(BackendError::protocol(
            summary,
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
                "retryable": response.is_retryable(),
            }),
        ))
    }
}

/// 上游 4xx 明确点名「它不认识这个字段」时，从错误正文里读出字段名。
///
/// 只认「供应商点名了参数」这一种证据：拿不到字段名、或错误其实是「字段值不合法」
/// 时一律返回 `None`，交给既有的 4xx 失败路径处理——不做无依据的猜测与重发，
/// 也不把用户填错的取值悄悄丢掉。
///
/// 覆盖的错误形状（多数网关只命中其中一条）：
/// - OpenAI 兼容（new-api 等）：`error.param` / `error.parameter` / `error.field`；
/// - 只在正文里点名的网关：`Unknown parameter: 'response_format'.`、
///   `Unknown name "response_format": Cannot find field.` 这类被引号括起来的字段名。
fn unsupported_request_field(response: &CapturedHttpResponse) -> Option<String> {
    if !(400..500).contains(&response.status) {
        return None;
    }
    let payload: Value = serde_json::from_str(&response.body).ok()?;
    let error = payload.get("error").unwrap_or(&payload);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or_default();
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| payload.get("code").and_then(Value::as_str));
    if !reports_unknown_field(message, code) {
        return None;
    }
    ["param", "parameter", "field", "name"]
        .iter()
        .find_map(|key| {
            error
                .get(*key)
                .and_then(Value::as_str)
                .or_else(|| payload.get(*key).and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|field| valid_request_field_name(field))
        .map(ToOwned::to_owned)
        .or_else(|| quoted_field_after_keyword(message))
}

/// 错误正文是否表示「上游不认识这个字段」，而不是「字段值不合法」。
///
/// 值不合法（`invalid_value` / `invalid value` / 取值范围）必须原样抛给用户：
/// 那是用户填错了取值，剥离字段重发只会把配置问题藏起来。
fn reports_unknown_field(message: &str, code: Option<&str>) -> bool {
    let code = code.unwrap_or_default().to_ascii_lowercase();
    let normalized = message.to_ascii_lowercase();
    if code.contains("invalid_value")
        || normalized.contains("invalid value")
        || normalized.contains("取值范围")
        || normalized.contains("not in the list")
    {
        return false;
    }
    if code.contains("unknown") || code.contains("unsupported") {
        return true;
    }
    const MARKERS: [&str; 12] = [
        "unknown parameter",
        "unsupported parameter",
        "unknown field",
        "unsupported field",
        "unknown name",
        "cannot find field",
        "unrecognized",
        "not supported",
        "不支持的参数",
        "不支持的字段",
        "未知参数",
        "未知字段",
    ];
    MARKERS.iter().any(|marker| normalized.contains(marker))
}

/// 从错误正文里取出被引号（`'x'` / `"x"` / `` `x` ``）括起来的字段名。
///
/// 字段名必须紧跟在 parameter / param / field / name（或中文「参数/字段/名称」）
/// 之后、且间隔里只有分隔符，避免把正文里任意引号内容当成字段名。
fn quoted_field_after_keyword(message: &str) -> Option<String> {
    const KEYWORDS: [&str; 7] = [
        "parameter",
        "param",
        "field",
        "name",
        "参数",
        "字段",
        "名称",
    ];
    // `to_ascii_lowercase` 不改动非 ASCII 字节，因此索引可以安全地用在原文上。
    let normalized = message.to_ascii_lowercase();
    let keyword_end = KEYWORDS
        .iter()
        .filter_map(|keyword| {
            normalized
                .find(keyword)
                .map(|index| (index, index + keyword.len()))
        })
        // 同一位置会同时命中 `param` 与 `parameter`：取更长的那个，否则尾部从
        // `eter…` 开始，分隔符检查必然不通过、字段名永远抓不到。
        .min_by_key(|(start, end)| (*start, std::cmp::Reverse(*end)))
        .map(|(_, end)| end)?;
    let tail = &message[keyword_end..];
    for (open, close) in [('\'', '\''), ('"', '"'), ('`', '`')] {
        let Some(start) = tail.find(open) else {
            continue;
        };
        let gap = &tail[..start];
        // 关键词与字段名之间只允许分隔符，避免跨句抓到无关的引号内容。
        if !gap.chars().all(|character| {
            character.is_whitespace()
                || matches!(
                    character,
                    ':' | '：' | '=' | '-' | '_' | ',' | '，' | '[' | '('
                )
        }) {
            continue;
        }
        let rest = &tail[start + open.len_utf8()..];
        let Some(end) = rest.find(close) else {
            continue;
        };
        let field = rest[..end].trim();
        if valid_request_field_name(field) {
            return Some(field.to_string());
        }
    }
    None
}

/// 从生成请求体里剔除一个字段：先看顶层（绝大多数参数的容器），再退到顶层对象内部
/// （Vidu / Seedance 把高级参数放进 `metadata` 这一类容器）。返回是否真的删掉了。
fn remove_request_field(body: &mut Value, field: &str) -> bool {
    let Some(object) = body.as_object_mut() else {
        return false;
    };
    if object.remove(field).is_some() {
        return true;
    }
    object
        .values_mut()
        .filter_map(Value::as_object_mut)
        .any(|nested| nested.remove(field).is_some())
}

/// 「模型定义 + 操作」维度的记忆键。同一模型定义换供应商连接会另建定义，
/// 因此这一层不需要再带连接 ID。
fn rejected_field_key(task: &TaskExecutionRecord) -> String {
    format!("{}::{}", task.model_definition_id, task.operation.as_str())
}

fn parse_model_catalog(
    response: &RawProviderResponse,
    dialect: RequestDialect,
) -> BackendResult<Vec<RemoteModelOption>> {
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

    reject_html_api_response(response.status, &response.headers, &response.body, "")?;
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
            .or_else(|| value.pointer("/data/models").and_then(Value::as_array))
            .or_else(|| value.pointer("/output/models").and_then(Value::as_array)),
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
            let mut operation_schema = infer_catalog_schema(item, id, display_name);
            // 模型名只决定能力；端点按本连接的方言落定，避免把网关上的
            // `doubao-*` 当成方舟原生端点。
            apply_request_dialect(&mut operation_schema, id, dialect);
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

/// 路径段是否是「版本根」：`v1`、`v2`、`v3beta` …
///
/// 形状是「`v` + 至少一位数字 + 可选别名后缀」，后缀只认 `beta` / `alpha`（Gemini
/// 的 `v1beta`）。`chat`、`images`、`videos`、`v1draft` 这类业务段一律不认，避免把
/// 业务路径误判成版本前缀。比较时用整段原文（而非规整成 `v1`）：`v1beta` 因此天然
/// 与 `v1` 不同，「版本冲突」判定不会被 Gemini 的 `v1beta` 别名撞上。
fn version_root(segment: &str) -> Option<&str> {
    const ALIASES: [&str; 2] = ["beta", "alpha"];
    let rest = segment
        .strip_prefix('v')
        .or_else(|| segment.strip_prefix('V'))?;
    let version_len = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let (version, alias) = rest.split_at(version_len);
    if version.is_empty() || (!alias.is_empty() && !ALIASES.contains(&alias)) {
        return None;
    }
    Some(segment)
}

/// 路径里的版本根只在前几个段内查找：Base URL 的版本前缀（`/api/v3`）出现在
/// 靠前位置，越深越可能是业务名（例如某个分组恰好叫 `v1`）。
fn version_root_within<'a>(segments: &[&'a str], limit: usize) -> Option<&'a str> {
    segments
        .iter()
        .take(limit)
        .find_map(|segment| version_root(segment))
}

pub fn endpoint(base_url: &str, path: &str) -> BackendResult<Url> {
    let mut url = Url::parse(base_url)?;
    // 路径可以带恰好一段查询串（观察路径 `GET /v1/api/result?id=…`）：查询部分
    // 不参与路径段拼接与版本根判定，最终整体设为 URL 查询；不带 `?` 的调用方
    // 行为不变（查询仍被清空）。
    let (path, query) = match path.split_once('?') {
        Some((path, query)) if !query.is_empty() => (path, Some(query.to_string())),
        _ => (path, None),
    };
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
    // 已带版本的 Base URL 是一种 drop-in 端点：用户填 `https://ark.cn-beijing.volces.com/api/v3`
    // 时，`/api/v3` 本身就是接口版本，模型契约里的 `/v1/...` 是给 OpenAI 兼容网关写的
    // 通用路径。两者拼起来会得到上游没有的 `/api/v3/v1/chat/completions`（火山方舟实测
    // 404，两次退避重试同样 404）。判定刻意保守——只认「Base 版本根与请求版本根同时出现
    // 且版本号不同」：`.../v1` + `/v1/chat/completions` 这种版本号相同的写法保持原样，
    // 免得把网关自带的版本段吃掉；上面的 v1/v1beta 别名切换已经先处理过，这里读到的是
    // 改写后的 Base 段，因此 `.../v1` + `/v1beta/...` 不会被二次削掉版本根。
    let base_version = version_root_within(&base_segments, 3);
    let request_version = requested_segments
        .first()
        .and_then(|first| version_root(first));
    let drop_request_version = matches!(
        (base_version, request_version),
        (Some(base), Some(requested)) if base != requested
    );
    let requested_segments = if drop_request_version {
        &requested_segments[1..]
    } else {
        requested_segments.as_slice()
    };
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
    url.set_query(query.as_deref());
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

/// 识别「网页兜底响应」：状态码 2xx 但响应体其实是 HTML 文档。
///
/// new-api 系网关对路由表之外的路径不回 404，而是 301 跳到自家官网，再由 SPA
/// 前端路由兜底以 HTTP 200 返回首页 HTML（魔芋网关实测：`www.moyu.info` 的
/// 未知路径 301 到 `www.moyu.cn`，任意未知路径都以 200 + 首页 HTML 接住）。
/// 凭据、直链或 API 地址一旦指错，收到的就是这种「成功状态码 + 网页」的响应，
/// 只能靠响应体识别。判定刻意保守：只认 BOM/空白之后紧跟 `<!doctype html` 或
/// `<html` 的文档开头；JSON（以 `{`/`[`/`"` 开头）、SSE（`data:`/`event:`）与
/// 媒体字节永远不命中。
pub(crate) fn looks_like_html_document(body: &[u8]) -> bool {
    let body = body
        .strip_prefix([0xEF, 0xBB, 0xBF].as_slice())
        .unwrap_or(body);
    let start = body
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(body.len());
    let body = &body[start..];
    starts_with_ignore_case(body, b"<!doctype html") || starts_with_ignore_case(body, b"<html")
}

fn starts_with_ignore_case(haystack: &[u8], prefix: &[u8]) -> bool {
    haystack.len() >= prefix.len()
        && haystack[..prefix.len()]
            .iter()
            .zip(prefix.iter())
            .all(|(byte, expected)| byte.eq_ignore_ascii_case(expected))
}

/// All JSON API transports and parsers share this check, including multipart uploads.
/// Inspect the body rather than trusting Content-Type: gateways can mislabel either format.
pub(super) fn reject_html_api_response(
    status: u16,
    headers: &Value,
    body: &str,
    url: &str,
) -> BackendResult<()> {
    if !(200..300).contains(&status) || !looks_like_html_document(body.as_bytes()) {
        return Ok(());
    }
    let mut error = html_document_rejection(
        status,
        url,
        &content_type_header(headers),
        body.as_bytes(),
        format!(
            "供应商返回了网页而不是接口数据（HTTP {status}）。请在供应商设置里核对 API 地址，并向供应商确认当前接口是否已开通。"
        ),
    );
    if let BackendError::Protocol { details, .. } = &mut error {
        details["headers"] = headers.clone();
        details["responseType"] = json!("html");
        details["retryable"] = json!(false);
    }
    Err(error)
}

/// 网页兜底响应的统一协议错误：给用户指路的文案放在摘要里，完整 HTML 只进
/// 「展开完整报错」与复制载荷，保留排障信息。
pub(crate) fn html_document_rejection(
    status: u16,
    url: &str,
    content_type: &str,
    body: &[u8],
    message: String,
) -> BackendError {
    let prefix = String::from_utf8_lossy(&body[..body.len().min(512)]).into_owned();
    BackendError::protocol(
        message,
        json!({
            "httpStatus": status,
            "url": redact_url_string(url),
            "contentType": content_type,
            "rawResponsePrefix": prefix,
            "rawResponse": String::from_utf8_lossy(body),
            "rawResponseBytes": body.len(),
        }),
    )
}

/// 从 `response_headers` 归一后的头里取 content-type（多值时取第一个）。
fn content_type_header(headers: &Value) -> String {
    match headers.get("content-type") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .find_map(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
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
