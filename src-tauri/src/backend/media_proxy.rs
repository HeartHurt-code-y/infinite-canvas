//! Native media protocol for HTTP(S) videos whose origins do not allow WebView CORS.
//! This transports bytes; refreshing expiring provider URLs belongs to the asset library.
//!
//! 图片预览在这里落盘复用（见 `media_cache`）：自定义协议的响应 WebView 不会缓存，
//! 素材库卡片与画布节点每次重挂载都会重新下载同一张图；同一份素材下载一次之后，
//! 后续请求（含重启后、签名过期后、远端暂时不可达时）直接由本地副本应答。
//!
//! 同一上游地址的并发取字节会合并成一次（见 `fetch_shared`），且整包传输预算按体积
//! 放宽（见 `transfer_budget`）：几十 MB 的原图在弱网/并发下本来就慢，固定 120s 会把
//! 「慢但在推进」的下载判成失败，而这正是「预览不可用」最常见的成因。

use std::{
    collections::HashMap,
    path::{Path as StdPath, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use tauri::{
    Manager as _, UriSchemeContext, UriSchemeResponder,
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri},
};
use tokio::{
    io::{AsyncReadExt as _, AsyncSeekExt as _},
    sync::watch,
};
use url::Url;

use super::{
    BackendState,
    media_cache::{MediaCache, is_cacheable_content_type, permits_storage},
};

pub const MEDIA_PROXY_SCHEME: &str = "assetproxy";

/// 上游单次返回的最大分块（8 MiB）。WebView 视频栈用 `Range: bytes=X-` 探测/续播大媒体，
/// 把开放区间钳制为固定窗口后，每个请求的内存上界恒定，避免整段视频常驻内存。
/// 说明：Tauri 自定义协议的响应体必须是完整 `Vec<u8>`，无法向 WebView 真流式；
/// 分块是约束内存的唯一手段。若上游不支持 Range 返回 200 全量，则退化为旧行为（全量缓冲）。
const MAX_RANGE_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// 连接超时（含 DNS/TLS）：与体积无关，继续保持短超时以便快速失败。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 相邻两次读到数据的最大间隔：链路真的卡死时在这里结束，而不是无限期挂着。
const READ_GAP_TIMEOUT: Duration = Duration::from_secs(60);
/// 整包传输的基础预算：小响应沿用原来的 120s。
const BASE_TRANSFER_BUDGET: Duration = Duration::from_secs(120);
/// 大媒体按「等效最低速率」放大预算。36 MB 的手机原图在 1~2 MB/s 下约 20~35s，
/// 但并发、弱网、跨国链路会成倍变慢；取 64 KiB/s 作为下限，既容得下慢速大图，
/// 又能在链路彻底不动时于约十分钟内收敛（配合 `READ_GAP_TIMEOUT`）。
const MIN_TRANSFER_BYTES_PER_SECOND: u64 = 64 * 1024;
/// 传输预算上限：再慢也不无限等待，避免坏链路长期占用连接与内存。
const MAX_TRANSFER_BUDGET: Duration = Duration::from_secs(20 * 60);

/// 本地兜底整包读取的体积上限。
///
/// 无 Range 的请求要一次读完整文件；上游代理路径本来就整包缓冲，这里沿用同一量级
/// （与磁盘缓存的单条上限一致）即可覆盖图片素材，又不会为了一个异常大的本地文件
/// 分配几百 MB 内存。视频由 WebView 以 Range 分块请求，不落在这条路径上。
const MAX_LOCAL_FULL_BYTES: u64 = 128 * 1024 * 1024;

/// 上游取不到字节时可用的本地副本。
#[derive(Debug, Clone)]
pub struct LocalMediaSource {
    pub path: PathBuf,
}

/// 把「上游媒体地址」解析成本地副本的能力。
///
/// 生产实现是 [`super::staging::StagingService`]：只认当前暂存桶内的对象地址，并按对象键
/// 回到素材导入任务取出原始文件；拿不到映射时返回 `None`，绝不按任意地址读本机文件。
pub trait LocalMediaFallback: Send + Sync {
    fn resolve(&self, url: &Url) -> Option<LocalMediaSource>;
}

/// 一次本地兜底读取要回答的内容：状态、响应体、以及附加头。
struct LocalCopy {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// 请求里的字节区间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestedRange {
    /// `bytes=start-` 或 `bytes=start-end`（`end` 为闭区间端点）。
    FromTo(u64, Option<u64>),
    /// `bytes=-n`：末尾 n 个字节。
    Suffix(u64),
}

/// 解析单区间字节请求；多区间、非 bytes 单位与非法写法一律返回 `None`（按整包处理）。
fn parse_requested_range(raw: &str) -> Option<RequestedRange> {
    let spec = raw.trim().strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() {
        let length = end.parse::<u64>().ok()?;
        return (length > 0).then_some(RequestedRange::Suffix(length));
    }
    let start = start.parse::<u64>().ok()?;
    if end.is_empty() {
        return Some(RequestedRange::FromTo(start, None));
    }
    let end = end.parse::<u64>().ok()?;
    (end >= start).then_some(RequestedRange::FromTo(start, Some(end)))
}

/// 按文件长度把请求区间换算成实际读取窗口 `[start, end]`（含端点）。
///
/// 开放区间与末尾区间都按 [`MAX_RANGE_CHUNK_BYTES`] 收口：WebView 的 `<video>` 从
/// `bytes=0-` 开始探测，不钳制就会为一个请求把整段视频读进内存（与上游路径同样的理由）。
/// 两者返回的都是「从请求位置到文件末尾」的子窗口，客户端按内容范围继续请求下一段。
fn resolve_window(range: RequestedRange, length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }
    match range {
        RequestedRange::Suffix(tail) => {
            let tail = tail.min(length).min(MAX_RANGE_CHUNK_BYTES);
            Some((length - tail, length - 1))
        }
        RequestedRange::FromTo(start, end) => {
            if start >= length {
                return None;
            }
            let end = end.unwrap_or(u64::MAX).min(length - 1);
            let end = end.min(start.saturating_add(MAX_RANGE_CHUNK_BYTES - 1));
            Some((start, end))
        }
    }
}

/// 内容类型：优先按文件头嗅探，其次按扩展名兜底，都识别不出时交给 WebView 自行判断。
fn local_content_type(path: &StdPath, head: &[u8]) -> Option<String> {
    if let Some(detected) = infer::get(head) {
        return Some(detected.mime_type().to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)?;
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        _ => return None,
    };
    Some(mime.to_string())
}

/// 读取本地副本：按请求区间（或整包）读窗口，并给出与一次性响应一致的头。
///
/// 文件读不出来、超出整包上限或区间不可满足时返回 `None`/416，由调用方回落到错误响应。
async fn read_local_copy(
    path: &StdPath,
    content_type: Option<String>,
    requested: Option<RequestedRange>,
    is_head: bool,
) -> Option<LocalCopy> {
    let length = tokio::fs::metadata(path).await.ok()?.len();
    let mut headers = HeaderMap::new();
    if let Some(content_type) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        headers.insert("content-type", content_type);
    }
    if requested.is_none() && length > MAX_LOCAL_FULL_BYTES {
        return None;
    }
    let window = match requested {
        Some(range) => match resolve_window(range, length) {
            Some(window) => Some(window),
            None => {
                headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
                headers.insert(
                    "content-range",
                    HeaderValue::from_str(&format!("bytes */{length}")).ok()?,
                );
                return Some(LocalCopy {
                    status: StatusCode::RANGE_NOT_SATISFIABLE,
                    headers,
                    body: Vec::new(),
                });
            }
        },
        None => None,
    };
    let (status, start, count) = match window {
        Some((start, end)) => (
            StatusCode::PARTIAL_CONTENT,
            start,
            end.saturating_sub(start) + 1,
        ),
        None => (StatusCode::OK, 0, length),
    };
    headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if let Some((start, end)) = window {
        headers.insert(
            "content-range",
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}")).ok()?,
        );
    }
    if let Ok(value) = HeaderValue::from_str(&count.to_string()) {
        headers.insert("content-length", value);
    }
    if is_head {
        return Some(LocalCopy {
            status,
            headers,
            body: Vec::new(),
        });
    }
    let mut file = tokio::fs::File::open(path).await.ok()?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    }
    let mut body = Vec::new();
    file.take(count).read_to_end(&mut body).await.ok()?;
    (body.len() as u64 == count).then_some(LocalCopy {
        status,
        headers,
        body,
    })
}

/// 上游取不到字节时的最终兜底：按对象键回到导入任务，用本地原始文件应答。
///
/// 素材入库把导入时的暂存租约地址交给上游（`public_url`），导入成功后暂存对象立刻被清理；
/// 而上游素材记录仍原样回放那个地址，于是上游必然报错、磁盘缓存里也没有这份字节 ——
/// 预览就此永久停在「预览不可用」。导入时的原始文件与暂存对象是同一份内容，按对象键取回
/// 即可恢复预览；图片顺带落盘，之后连源文件都不再需要。
async fn serve_local_copy(
    fallback: Option<&dyn LocalMediaFallback>,
    upstream_url: &Url,
    request_headers: &HeaderMap,
    cache: Option<&MediaCache>,
    is_head: bool,
) -> Option<Response<Vec<u8>>> {
    let source = fallback?.resolve(upstream_url)?;
    let requested = request_headers
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_requested_range);
    let mut head = [0_u8; 4 * 1024];
    let sniffed = match tokio::fs::File::open(&source.path).await {
        Ok(mut file) => {
            let read = file.read(&mut head).await.unwrap_or(0);
            local_content_type(&source.path, &head[..read])
        }
        Err(_) => return None,
    };
    let copy = read_local_copy(&source.path, sniffed.clone(), requested, is_head).await?;
    // 完整、图片、上游未禁止存储的响应同样落盘：下一次（含签名过期后）直接命中本地字节。
    if copy.status == StatusCode::OK && !is_head {
        if let (Some(cache), Some(content_type)) = (cache, sniffed.as_deref()) {
            if is_cacheable_content_type(Some(content_type))
                && cache.accepts_length(Some(copy.body.len() as u64))
            {
                cache.store(upstream_url, Some(content_type), &copy.body);
            }
        }
    }
    let mut headers = copy.headers;
    if copy.status == StatusCode::OK && cache.is_some() {
        headers.insert(
            "cache-control",
            HeaderValue::from_static("private, max-age=86400"),
        );
    }
    Some(build_response(copy.status, headers, copy.body))
}

/// 按内容长度算出的整包传输预算：小响应 120s，大响应按等效最低速率放大并封顶。
///
/// 长度未知（分块响应、错误页）时沿用基础预算。
fn transfer_budget(content_length: Option<u64>) -> Duration {
    let Some(length) = content_length else {
        return BASE_TRANSFER_BUDGET;
    };
    let scaled = Duration::from_secs(length / MIN_TRANSFER_BYTES_PER_SECOND + 1);
    scaled.clamp(BASE_TRANSFER_BUDGET, MAX_TRANSFER_BUDGET)
}

/// 上游取字节的失败分类。
///
/// 只保留固定的种类字符串：reqwest 的错误详情可能包含签名地址，绝不回显给 WebView，
/// 日志里也只记分类（见 `kind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamFailure {
    Timeout,
    Redirect,
    Unavailable,
}

impl UpstreamFailure {
    fn from_error(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else if error.is_redirect() {
            Self::Redirect
        } else {
            Self::Unavailable
        }
    }

    fn kind(self) -> &'static str {
        match self {
            Self::Timeout => "media_source_timeout",
            Self::Redirect => "media_source_redirect_error",
            Self::Unavailable => "media_source_unavailable",
        }
    }
}

/// 一次上游取字节的结果：完整响应，或分类后的失败。
enum FetchedUpstream {
    Media {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    },
    Failed(UpstreamFailure),
}

type SharedOutcome = Arc<FetchedUpstream>;
/// 在途槽位：领导请求完成后把结果写进 watch 通道，等待者立刻拿到同一份。
type SharedSlot = watch::Sender<Option<SharedOutcome>>;

/// 同一上游地址的在途取字节登记表。
///
/// 画布素材节点会同时发两条取字节请求（`<img>` 与前端会话字节缓存），两条都指向同一个
/// `assetproxy` 地址；几十 MB 的大图各下一份不仅互相抢带宽，还会把两条都拖过传输预算，
/// 于是双双失败成「预览不可用」。这里让并发请求共享同一次上游取字节。
///
/// 键用完整上游地址而不是「主机 + 路径」：续签前后的签名不同、有效性也不同，把新签名
/// 合并到过期签名上会把本来能成功的请求一起拖掉。Range 请求与 HEAD 不参与合并。
fn in_flight() -> &'static Mutex<HashMap<String, SharedSlot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, SharedSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记表锁：中毒（持锁线程 panic）时照常取用，长驻进程不为一次 panic 永久失效。
fn lock_in_flight() -> MutexGuard<'static, HashMap<String, SharedSlot>> {
    in_flight()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 领导请求的登记凭据。
///
/// 请求被取消或 panic 时也要把槽位摘掉：登记表里的 sender 克隆会让通道一直「活着」，
/// 只靠等待侧发现通道关闭是不够的 —— 后来的请求会挂在一个已经没人推进的槽位上。
struct InFlightGuard {
    key: String,
    slot: SharedSlot,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut slots = lock_in_flight();
        if slots
            .get(&self.key)
            .is_some_and(|entry| entry.same_channel(&self.slot))
        {
            slots.remove(&self.key);
        }
    }
}

/// 取字节：同地址已有在途请求时等它的结果，否则自己成为领导请求。
async fn fetch_shared(url: &Url, request_headers: &HeaderMap) -> SharedOutcome {
    let key = url.as_str().to_owned();
    loop {
        let (slot, is_leader) = {
            let mut slots = lock_in_flight();
            match slots.get(&key) {
                Some(existing) => (existing.clone(), false),
                None => {
                    let (sender, _receiver) = watch::channel(None);
                    slots.insert(key.clone(), sender.clone());
                    (sender, true)
                }
            }
        };
        let guard = is_leader.then(|| InFlightGuard {
            key: key.clone(),
            slot: slot.clone(),
        });
        if !is_leader {
            let mut receiver = slot.subscribe();
            // 先到的请求落定后立刻拿到同一份结果；领导请求被取消（发送端消失）时摘掉
            // 这条死槽位、自己接手重取一次，既不会无限等待，也不会空转。
            match receiver.wait_for(|outcome| outcome.is_some()).await {
                Ok(outcome) => {
                    if let Some(shared) = (*outcome).clone() {
                        return shared;
                    }
                    continue;
                }
                Err(_) => {
                    let mut slots = lock_in_flight();
                    if slots
                        .get(&key)
                        .is_some_and(|entry| entry.same_channel(&slot))
                    {
                        slots.remove(&key);
                    }
                    continue;
                }
            }
        }
        let outcome = Arc::new(
            match fetch_upstream(url, Method::GET, request_headers).await {
                Ok((status, headers, body)) => FetchedUpstream::Media {
                    status,
                    headers,
                    body,
                },
                Err(failure) => FetchedUpstream::Failed(failure),
            },
        );
        // 用 `send_replace` 而不是 `send`：watch 在「一个接收端都没有」时会拒绝写入，
        // 而这里必须无条件发布结果 —— 后到的请求可能刚好在写入前后才订阅。
        slot.send_replace(Some(outcome.clone()));
        // 结果已发布：登记表只服务「同时在途」的请求，落定即摘除（Drop 兜住取消与 panic）。
        drop(guard);
        return outcome;
    }
}

/// 取出共享结果：独占引用时直接拿走（几十 MB 的图不为一次响应多复制一份字节），
/// 仍有其他等待者时复制一份。
fn take_outcome(shared: SharedOutcome) -> FetchedUpstream {
    match Arc::try_unwrap(shared) {
        Ok(owned) => owned,
        Err(shared) => match &*shared {
            FetchedUpstream::Media {
                status,
                headers,
                body,
            } => FetchedUpstream::Media {
                status: *status,
                headers: headers.clone(),
                body: body.clone(),
            },
            FetchedUpstream::Failed(failure) => FetchedUpstream::Failed(*failure),
        },
    }
}

/// 把开放区间 `bytes=X-` 钳制为 `bytes=X-{X+chunk-1}`；有界区间、后缀区间与
/// 多区间请求保持原样（返回 None 即不修改）。
fn clamp_open_ended_range(header: &HeaderValue) -> Option<HeaderValue> {
    let raw = header.to_str().ok()?;
    let start = raw.trim().strip_prefix("bytes=")?.strip_suffix('-')?;
    let start: u64 = start.parse().ok()?;
    let end = start
        .saturating_add(MAX_RANGE_CHUNK_BYTES)
        .saturating_sub(1);
    HeaderValue::from_str(&format!("bytes={start}-{end}")).ok()
}

/// Use Tauri's persistent async runtime; never block a WebView callback or create a
/// short-lived runtime whose I/O drivers have already been dropped.
pub fn handle_media_proxy_request<R: tauri::Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // 缓存目录按应用数据目录解析；解析失败（路径不可用）时退化为直连穿透。
    let cache = context
        .app_handle()
        .path()
        .app_local_data_dir()
        .ok()
        .map(|directory| MediaCache::new(preview_cache_directory(&directory)));
    // 本地兜底：暂存对象在导入成功后即被清理，上游素材记录却仍回放那个地址，
    // 于是取字节必然失败。按对象键回到导入任务用原始文件应答（见 `serve_local_copy`）。
    let fallback = context
        .app_handle()
        .try_state::<BackendState>()
        .map(|state| state.staging.clone());
    tauri::async_runtime::spawn(async move {
        responder.respond(
            proxy_response(
                request,
                cache.as_ref(),
                fallback.as_ref().map(|value| value as _),
            )
            .await,
        );
    });
}

/// 预览媒体缓存目录：与缩略图缓存同级，便于用户按需整体清理。
fn preview_cache_directory(local_data: &std::path::Path) -> PathBuf {
    local_data.join("media-preview-cache")
}

async fn proxy_response(
    request: Request<Vec<u8>>,
    cache: Option<&MediaCache>,
    fallback: Option<&dyn LocalMediaFallback>,
) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return build_response(StatusCode::NO_CONTENT, HeaderMap::new(), Vec::new());
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", false);
    }
    let is_head = request.method() == Method::HEAD;
    let Some(upstream_url) = extract_upstream_url(request.uri()) else {
        return error_response(StatusCode::BAD_REQUEST, "invalid_media_source", is_head);
    };
    // Range 请求（视频探测/续播）不参与缓存：分块响应不是完整内容。
    let range_requested = request.headers().contains_key("range");
    if let Some(cache) = cache {
        if !range_requested {
            if let Some(cached) = cache.read(&upstream_url) {
                return cached_response(cached.content_type, cached.body, is_head);
            }
        }
    }
    // 完整 GET 参与在途合并；Range/HEAD 各自带语义，逐一转发。
    let fetched = if request.method() == Method::GET && !range_requested {
        fetch_shared(&upstream_url, request.headers()).await
    } else {
        Arc::new(
            match fetch_upstream(&upstream_url, request.method().clone(), request.headers()).await {
                Ok((status, headers, body)) => FetchedUpstream::Media {
                    status,
                    headers,
                    body,
                },
                Err(failure) => FetchedUpstream::Failed(failure),
            },
        )
    };
    match take_outcome(fetched) {
        FetchedUpstream::Media {
            status,
            mut headers,
            body,
        } => {
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                headers.insert("content-length", HeaderValue::from_static("0"));
                build_response(status, headers, Vec::new())
            } else if status.is_success() {
                store_cacheable(
                    cache,
                    &upstream_url,
                    &status,
                    &headers,
                    &body,
                    range_requested,
                );
                let cached_control =
                    response_cache_header(cache, &status, &headers, &body, range_requested);
                if let Some(value) = cached_control {
                    headers.insert("cache-control", value);
                }
                build_response(status, headers, body)
            } else {
                // 远端明确报错（常见于签名过期）：本地有副本时继续用副本，
                // 不必把一屏已经下载过的预览打成「预览不可用」。
                if let Some(cache) = cache {
                    if let Some(cached) = cache.read(&upstream_url) {
                        return cached_response(cached.content_type, cached.body, is_head);
                    }
                }
                // 暂存对象已被清理（上游回放的是导入时的死地址）：用导入时的原始文件应答。
                if let Some(response) =
                    serve_local_copy(fallback, &upstream_url, request.headers(), cache, is_head)
                        .await
                {
                    return response;
                }
                // Upstream error pages can echo signed URLs or authentication details.
                let status = if status.is_redirection() {
                    StatusCode::BAD_GATEWAY
                } else {
                    status
                };
                error_response(status, "upstream_media_error", is_head)
            }
        }
        FetchedUpstream::Failed(failure) => {
            let kind = failure.kind();
            // Reqwest's Display may include a signed URL; record only a fixed category.
            tauri_plugin_log::log::warn!("media proxy failed: {kind}");
            if let Some(cache) = cache {
                if let Some(cached) = cache.read(&upstream_url) {
                    return cached_response(cached.content_type, cached.body, is_head);
                }
            }
            if let Some(response) =
                serve_local_copy(fallback, &upstream_url, request.headers(), cache, is_head).await
            {
                return response;
            }
            error_response(StatusCode::BAD_GATEWAY, kind, is_head)
        }
    }
}

/// 命中本地副本时的响应：长度按缓存文件重算，不再回放上游那一次的元数据。
fn cached_response(
    content_type: Option<String>,
    body: Vec<u8>,
    is_head: bool,
) -> Response<Vec<u8>> {
    let mut headers = HeaderMap::new();
    if let Some(content_type) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        headers.insert("content-type", content_type);
    }
    headers.insert("accept-ranges", HeaderValue::from_static("none"));
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, max-age=86400"),
    );
    let length = body.len();
    let body = if is_head { Vec::new() } else { body };
    if let Ok(value) = HeaderValue::from_str(&length.to_string()) {
        headers.insert("content-length", value);
    }
    build_response(StatusCode::OK, headers, body)
}

/// 判断这份响应是否值得落盘；只有完整、图片、未被上游禁止的响应才写入。
fn store_cacheable(
    cache: Option<&MediaCache>,
    upstream_url: &Url,
    status: &StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    range_requested: bool,
) {
    let Some(cache) = cache else {
        return;
    };
    if range_requested || *status != StatusCode::OK {
        return;
    }
    let content_type = header_str(headers, "content-type");
    if !is_cacheable_content_type(content_type)
        || !permits_storage(header_str(headers, "cache-control"))
    {
        return;
    }
    if !cache.accepts_length(header_u64(headers, "content-length").or(Some(body.len() as u64))) {
        return;
    }
    cache.store(upstream_url, content_type, body);
}

/// 落盘成功的响应附上缓存指令，让 WebView 在内存里也复用同一份内容。
fn response_cache_header(
    cache: Option<&MediaCache>,
    status: &StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    range_requested: bool,
) -> Option<HeaderValue> {
    let cache = cache?;
    if range_requested || *status != StatusCode::OK {
        return None;
    }
    let content_type = header_str(headers, "content-type");
    if !is_cacheable_content_type(content_type) {
        return None;
    }
    if !cache.accepts_length(Some(body.len() as u64)) {
        return None;
    }
    Some(HeaderValue::from_static("private, max-age=86400"))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    header_str(headers, name)?.trim().parse().ok()
}

fn extract_upstream_url(uri: &Uri) -> Option<Url> {
    let query = uri.query()?;
    let source = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "src")?
        .1;
    let url = Url::parse(&source).ok()?;
    valid_upstream(&url).then_some(url)
}

fn valid_upstream(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

async fn fetch_upstream(
    url: &Url,
    method: Method,
    request_headers: &HeaderMap,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), UpstreamFailure> {
    let client = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(CONNECT_TIMEOUT)
        // 整包预算按体积另算（见 `transfer_budget`）：这里只保留「链路卡死」的读间隔保护，
        // 不用固定总超时把慢但在推进的大图下载判死。
        .read_timeout(READ_GAP_TIMEOUT)
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("media redirect limit reached")
            } else if !valid_upstream(attempt.url()) {
                attempt.error("unsupported media redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| UpstreamFailure::Unavailable)?;
    // Range 单独处理：开放区间钳制为固定窗口，约束单请求内存；其余区间原样转发。
    // 先计算 outgoing（method 之后被 move），再构建请求。
    let outgoing_range = request_headers.get("range").map(|value| {
        if method == Method::GET {
            clamp_open_ended_range(value).unwrap_or_else(|| value.clone())
        } else {
            value.clone()
        }
    });
    let mut builder = client
        .request(method, url.clone())
        .header("accept-encoding", "identity");
    // Intentionally do not forward WebView cookies, authorization, origin or referer.
    // These two validators are needed for seek and resumed media requests.
    if let Some(value) = request_headers.get("if-range") {
        builder = builder.header("if-range", value.clone());
    }
    if let Some(outgoing) = outgoing_range {
        builder = builder.header("range", outgoing);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| UpstreamFailure::from_error(&error))?;
    let status = response.status();
    let mut headers = HeaderMap::new();
    // A response allowlist excludes hop-by-hop headers, Set-Cookie and upstream CORS.
    // Preserve range metadata and validators, including on HEAD and 416 responses.
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "content-encoding",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
        "expires",
    ] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(name, value.clone());
        }
    }
    // 整包预算按这次响应声明的大小算：几十 MB 的图允许慢，但仍在有限时间内收敛。
    let budget = transfer_budget(header_u64(&headers, "content-length"));
    let body = tokio::time::timeout(budget, response.bytes())
        .await
        .map_err(|_| UpstreamFailure::Timeout)?
        .map_err(|error| UpstreamFailure::from_error(&error))?
        .to_vec();
    Ok((status, headers, body))
}

fn build_response(status: StatusCode, mut headers: HeaderMap, body: Vec<u8>) -> Response<Vec<u8>> {
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Range, If-Range, Content-Type"),
    );
    headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static(
            "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
        ),
    );
    headers.insert("allow", HeaderValue::from_static("GET, HEAD, OPTIONS"));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn error_response(status: StatusCode, error: &str, is_head: bool) -> Response<Vec<u8>> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    let body = if is_head {
        Vec::new()
    } else {
        serde_json::json!({ "error": error })
            .to_string()
            .into_bytes()
    };
    build_response(status, headers, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
    };

    struct HttpFixture {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl HttpFixture {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let worker = thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut buffer = Vec::new();
                    loop {
                        let mut chunk = [0u8; 1024];
                        let Ok(count) = stream.read(&mut chunk) else {
                            break;
                        };
                        if count == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..count]);
                        if buffer.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let request = String::from_utf8_lossy(&buffer).into_owned();
                    let first = request.lines().next().unwrap_or_default();
                    let path = first.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let is_head = first.starts_with("HEAD ");
                    let lower = request.to_ascii_lowercase();
                    let (status, mut headers, body) = match path.as_str() {
                        "/redirect" => (
                            "302 Found",
                            format!("Location: http://localhost:{port}/media\r\n"),
                            "",
                        ),
                        "/loop" => ("302 Found", "Location: /loop\r\n".into(), ""),
                        "/unsupported" => ("302 Found", "Location: file:///secret.mp4\r\n".into(), ""),
                        "/fail" => ("503 Service Unavailable", String::new(), "secret-signed-url"),
                        "/media" if lower.contains("range: bytes=1-3") => (
                            "206 Partial Content",
                            "Content-Range: bytes 1-3/5\r\n".into(),
                            "ide",
                        ),
                        // 代理对开放区间 `bytes=0-` 的钳制请求：上游以分块 206 响应。
                        "/media" if lower.contains("range: bytes=0-") => (
                            "206 Partial Content",
                            format!("Content-Range: bytes 0-{}/5\r\n", MAX_RANGE_CHUNK_BYTES - 1),
                            "video",
                        ),
                        "/media" if lower.contains("range: bytes=99-") => (
                            "416 Range Not Satisfiable",
                            "Content-Range: bytes */5\r\n".into(),
                            "",
                        ),
                        "/cors" => (
                            "200 OK",
                            "Access-Control-Allow-Origin: https://upstream.example\r\nSet-Cookie: secret=1\r\n".into(),
                            "video",
                        ),
                        // 图片预览：缓存测试用的可缓存响应。更具体的路径必须先匹配，
                        // 否则会被下面的 `/image` 兜底吃掉。
                        "/image-no-store" => (
                            "200 OK",
                            "Content-Type: image/png\r\nCache-Control: no-store\r\n".into(),
                            "PNGBYTES",
                        ),
                        // 同一路径先成功、后失败：用于验证「远端报错时本地副本接管」。
                        "/image-flaky" if lower.contains("x-fail") => (
                            "503 Service Unavailable",
                            "Content-Type: text/plain\r\n".into(),
                            "secret-signed-url",
                        ),
                        path if path.starts_with("/image") => (
                            "200 OK",
                            "Content-Type: image/png\r\nCache-Control: public, max-age=3600\r\n".into(),
                            if path == "/image-deny" { "" } else { "PNGBYTES" },
                        ),
                        _ => ("200 OK", String::new(), "video"),
                    };
                    // 图片路径自带 Content-Type，不再追加视频头。路径要在 `request` 被 move
                    // 进夹具记录之前转成自有字符串（它借用自 `request`）。
                    let is_image_response = path.starts_with("/image");
                    captured.lock().unwrap().push(request);
                    if !is_image_response {
                        headers.push_str(&format!(
                            "Content-Type: video/mp4\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"media-v1\"\r\nConnection: close\r\n",
                            body.len(),
                        ));
                    } else if !headers.contains("Content-Length:") {
                        headers.push_str(&format!("Content-Length: {}\r\n", body.len()));
                    }
                    let response = format!(
                        "HTTP/1.1 {status}\r\n{headers}\r\n{}",
                        if is_head { "" } else { body },
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                stop,
                worker: Some(worker),
            }
        }

        fn request(&self, method: Method, path: &str) -> tauri::http::request::Builder {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut()
                .append_pair("src", &format!("{}{path}", self.url));
            Request::builder().method(method).uri(url.as_str())
        }
    }

    impl Drop for HttpFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    /// 无缓存穿透语义：既有的传输层用例只关心代理转发，不关心缓存与本地兜底。
    async fn proxy_response_uncached(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        proxy_response(request, None, None).await
    }

    /// 固定映射的本地兜底替身：把指定上游地址映射到一份本地文件，其余地址不兜底。
    #[derive(Default)]
    struct StubLocalFallback {
        mapped: std::sync::Mutex<HashMap<String, PathBuf>>,
    }

    impl StubLocalFallback {
        fn with(self, url: &str, path: &StdPath) -> Self {
            self.mapped
                .lock()
                .unwrap()
                .insert(url.to_string(), path.to_path_buf());
            self
        }
    }

    impl LocalMediaFallback for StubLocalFallback {
        fn resolve(&self, url: &Url) -> Option<LocalMediaSource> {
            self.mapped
                .lock()
                .unwrap()
                .get(url.as_str())
                .map(|path| LocalMediaSource { path: path.clone() })
        }
    }

    /// 代理请求构造：`src` 指向夹具服务器的路径。
    fn fixture_request(method: Method, base: &str, path: &str) -> Request<Vec<u8>> {
        let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
        url.query_pairs_mut()
            .append_pair("src", &format!("{base}{path}"));
        Request::builder()
            .method(method)
            .uri(url.as_str())
            .body(Vec::new())
            .unwrap()
    }

    #[tokio::test]
    async fn serves_the_imported_local_file_when_upstream_cannot_deliver() {
        // 素材入库后暂存对象即被清理，上游记录仍回放那个地址：上游报错、缓存也没有字节，
        // 预览会永久停在「预览不可用」。导入时的原始文件是同一份内容，必须用它接管。
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let directory = tempfile::tempdir().unwrap();
        let image_path = directory.path().join("imported.png");
        std::fs::write(&image_path, b"\x89PNG\r\n\x1a\nIMPORTED").unwrap();
        // 夹具的 `/fail` 固定 503（签名过期或对象已被清理的上游都是这个形态）。
        let source = format!("{}/fail", server.url);
        let fallback = StubLocalFallback::default().with(&source, &image_path);

        let response = proxy_response(
            fixture_request(Method::GET, &server.url, "/fail"),
            Some(&cache),
            Some(&fallback),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"\x89PNG\r\n\x1a\nIMPORTED");
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(
            response.headers()["content-length"],
            response.body().len().to_string()
        );
        // 图片顺带落盘：之后连源文件都不再需要，续签出的任何签名都命中同一份字节。
        assert!(
            cache.read(&Url::parse(&source).unwrap()).is_some(),
            "本地兜底应答的图片必须落盘复用"
        );
    }

    #[tokio::test]
    async fn serves_local_video_ranges_so_playback_can_seek() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let directory = tempfile::tempdir().unwrap();
        let video_path = directory.path().join("imported.mp4");
        // 12 字节的可辨识载荷：只断言被请求的窗口。
        std::fs::write(&video_path, b"0123456789ab").unwrap();
        // 夹具服务器的 `/fail` 固定 503（上游取不到字节），本地兜底按同一地址接管。
        let source = format!("{}/fail", server.url);
        let fallback = StubLocalFallback::default().with(&source, &video_path);
        let request = |range: &str| {
            let mut builder = Request::builder()
                .method(Method::GET)
                .header("range", range);
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut()
                .append_pair("src", &format!("{}/fail", server.url));
            builder = builder.uri(url.as_str());
            builder.body(Vec::new()).unwrap()
        };

        let ranged = proxy_response(request("bytes=2-5"), Some(&cache), Some(&fallback)).await;
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.body(), b"2345");
        assert_eq!(ranged.headers()["content-range"], "bytes 2-5/12");
        assert_eq!(ranged.headers()["content-length"], "4");

        // 开放区间按固定窗口收口：不能因为 `bytes=0-` 就把整段媒体读进内存。
        let open_ended = proxy_response(request("bytes=0-"), Some(&cache), Some(&fallback)).await;
        assert_eq!(open_ended.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(open_ended.body(), b"0123456789ab");
        assert_eq!(
            open_ended.headers()["content-range"],
            format!("bytes 0-11/12")
        );

        // 越界区间按标准语义回 416，不静默返回整包。
        let unsatisfiable =
            proxy_response(request("bytes=99-"), Some(&cache), Some(&fallback)).await;
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()["content-range"], "bytes */12");
    }

    #[tokio::test]
    async fn keeps_the_upstream_error_when_no_local_copy_maps_the_url() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let fallback = StubLocalFallback::default();
        let response = proxy_response(
            fixture_request(Method::GET, &server.url, "/fail"),
            Some(&cache),
            Some(&fallback),
        )
        .await;
        assert!(response.status().is_server_error());
        assert_eq!(response.headers()["content-type"], "application/json");
    }

    #[test]
    fn parses_single_byte_ranges_and_rejects_the_rest() {
        assert_eq!(
            parse_requested_range("bytes=0-"),
            Some(RequestedRange::FromTo(0, None))
        );
        assert_eq!(
            parse_requested_range("bytes=10-20"),
            Some(RequestedRange::FromTo(10, Some(20)))
        );
        assert_eq!(
            parse_requested_range("bytes=-500"),
            Some(RequestedRange::Suffix(500))
        );
        // 多区间、倒序区间、非 bytes 单位：按整包处理，不猜语义。
        assert_eq!(parse_requested_range("bytes=0-1,5-6"), None);
        assert_eq!(parse_requested_range("bytes=9-2"), None);
        assert_eq!(parse_requested_range("chunks=0-"), None);
    }

    #[test]
    fn bounds_local_windows_to_the_chunk_limit() {
        assert_eq!(
            resolve_window(RequestedRange::FromTo(0, None), 100),
            Some((0, 99))
        );
        assert_eq!(
            resolve_window(RequestedRange::FromTo(0, None), 10 * 1024 * 1024),
            Some((0, MAX_RANGE_CHUNK_BYTES - 1))
        );
        assert_eq!(resolve_window(RequestedRange::Suffix(4), 10), Some((6, 9)));
        // 末尾区间同样收口：一个 `bytes=-10G` 不能把整段媒体读进内存。
        assert_eq!(
            resolve_window(RequestedRange::Suffix(u64::MAX), 10 * 1024 * 1024),
            Some((
                10 * 1024 * 1024 - MAX_RANGE_CHUNK_BYTES,
                10 * 1024 * 1024 - 1
            ))
        );
        assert_eq!(resolve_window(RequestedRange::FromTo(10, None), 10), None);
    }

    fn test_cache() -> (tempfile::TempDir, MediaCache) {
        let directory = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(directory.path().join("media-preview-cache"));
        (directory, cache)
    }

    #[tokio::test]
    async fn follows_a_no_cors_http_redirect_and_preserves_the_media_body() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/redirect")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"video");
        assert_eq!(response.headers()["content-type"], "video/mp4");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn forwards_range_and_if_range_but_not_webview_credentials_across_hosts() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/redirect")
                .header("range", "bytes=1-3")
                .header("if-range", "\"media-v1\"")
                .header("cookie", "session=secret")
                .header("authorization", "Bearer secret")
                .header("referer", "https://app.example/?signed=secret")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"ide");
        assert_eq!(response.headers()["content-range"], "bytes 1-3/5");
        assert_eq!(response.headers()["content-length"], "3");
        for request in server.requests.lock().unwrap().iter() {
            let request = request.to_ascii_lowercase();
            assert!(request.contains("range: bytes=1-3"));
            assert!(request.contains("if-range: \"media-v1\""));
            assert!(!request.contains("secret"));
        }
    }

    #[tokio::test]
    async fn clamps_open_ended_ranges_to_a_bounded_chunk_and_passes_the_partial_response() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/media")
                .header("range", "bytes=0-")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        // 上游收到钳制后的分块请求，206 分块响应（头/体）原样透传给 WebView。
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"video");
        assert_eq!(
            response.headers()["content-range"],
            format!("bytes 0-{}/5", MAX_RANGE_CHUNK_BYTES - 1)
        );
        let requests = server.requests.lock().unwrap();
        let last = requests.last().unwrap().to_ascii_lowercase();
        assert!(last.contains(&format!("range: bytes=0-{}", MAX_RANGE_CHUNK_BYTES - 1)));
        assert!(!last.contains("\nrange: bytes=0-\r\n"));
    }

    #[test]
    fn range_clamping_only_rewrites_open_ended_byte_ranges() {
        let clamp = |value: &str| {
            clamp_open_ended_range(&HeaderValue::from_str(value).unwrap())
                .and_then(|header| header.to_str().ok().map(str::to_owned))
        };
        assert_eq!(
            clamp("bytes=8388607-").as_deref(),
            Some("bytes=8388607-16777214")
        );
        // 有界区间、后缀区间、多区间与非 bytes 单位不重写。
        assert_eq!(clamp("bytes=1-3").as_deref(), None);
        assert_eq!(clamp("bytes=-500").as_deref(), None);
        assert_eq!(clamp("bytes=0-1,5-6").as_deref(), None);
        assert_eq!(clamp("chunks=0-").as_deref(), None);
    }

    #[tokio::test]
    async fn preserves_head_and_unsatisfiable_ranges() {
        let server = HttpFixture::new();
        let head = proxy_response_uncached(
            server
                .request(Method::HEAD, "/media")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()["content-length"], "5");
        let range = proxy_response_uncached(
            server
                .request(Method::GET, "/media")
                .header("range", "bytes=99-")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(range.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(range.headers()["content-range"], "bytes */5");
        assert_eq!(range.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn replaces_upstream_cors_and_omits_cookies() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/cors")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(
            response
                .headers()
                .get_all("access-control-allow-origin")
                .iter()
                .count(),
            1
        );
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(!response.headers().contains_key("set-cookie"));
    }

    #[tokio::test]
    async fn bounds_redirects_and_redacts_upstream_failures() {
        let server = HttpFixture::new();
        for path in ["/loop", "/unsupported", "/fail"] {
            let response = proxy_response_uncached(
                server.request(Method::GET, path).body(Vec::new()).unwrap(),
            )
            .await;
            assert!(response.status().is_server_error());
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            let body = String::from_utf8_lossy(response.body());
            assert!(!body.contains("secret"));
            assert!(!body.contains(&server.url));
        }
        assert!(server.requests.lock().unwrap().len() <= 8);
    }

    #[tokio::test]
    async fn provides_cors_for_preflight_invalid_sources_and_unsupported_methods() {
        for (method, status) in [
            (Method::OPTIONS, StatusCode::NO_CONTENT),
            (Method::POST, StatusCode::METHOD_NOT_ALLOWED),
            (Method::GET, StatusCode::BAD_REQUEST),
        ] {
            let response = proxy_response_uncached(
                Request::builder()
                    .method(method)
                    .uri("http://assetproxy.localhost/video")
                    .body(Vec::new())
                    .unwrap(),
            )
            .await;
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            assert_eq!(
                response.headers()["access-control-allow-headers"],
                "Range, If-Range, Content-Type"
            );
        }
    }

    #[tokio::test]
    async fn serves_a_repeated_image_preview_from_the_local_copy_without_asking_upstream_again() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = Url::parse(&format!("{}/image.png?sig=first", server.url)).unwrap();
        let request = || {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", source.as_str());
            Request::builder()
                .method(Method::GET)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap()
        };

        let first = proxy_response(request(), Some(&cache), None).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.body(), b"PNGBYTES");
        assert_eq!(server.requests.lock().unwrap().len(), 1);

        // 第二次（重开面板 / 重挂载卡片 / 重启后同一素材）：不再打扰上游，直接回本地副本。
        let second = proxy_response(request(), Some(&cache), None).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.body(), b"PNGBYTES");
        assert_eq!(second.headers()["content-length"], "8");
        assert_eq!(second.headers()["content-type"], "image/png");
        assert_eq!(second.headers()["cache-control"], "private, max-age=86400");
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "命中缓存后不得再请求上游"
        );

        // 续签换了签名参数：仍是同一对象，继续命中同一份副本。
        let resigned = Url::parse(&format!("{}/image.png?sig=second", server.url)).unwrap();
        assert!(cache.read(&resigned).is_some());
    }

    #[tokio::test]
    async fn falls_back_to_the_local_copy_when_upstream_fails() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = format!("{}/image-flaky", server.url);
        let signed = Url::parse(&format!("{source}?sig=1")).unwrap();
        let request = |fail: bool| {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut()
                .append_pair("src", &format!("{source}?sig={}", if fail { 2 } else { 1 }));
            let builder = Request::builder().method(Method::GET).uri(url.as_str());
            let builder = if fail {
                builder.header("x-fail", "1")
            } else {
                builder
            };
            builder.body(Vec::new()).unwrap()
        };

        // 先成功取一次：字节落盘。
        let first = proxy_response(request(false), Some(&cache), None).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert!(cache.read(&signed).is_some());

        // 远端随后报错（典型是签名过期 / 网络不可达）：本地副本接管，预览不再变成「不可用」。
        let second = proxy_response(request(true), Some(&cache), None).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.body(), b"PNGBYTES");
        assert_eq!(second.headers()["content-type"], "image/png");
        // 上游错误正文可能带签名或认证细节，不能被透传出去。
        assert!(!String::from_utf8_lossy(second.body()).contains("secret"));
    }

    #[test]
    fn transfer_budget_grows_with_size_and_stays_bounded() {
        // 长度未知（分块响应 / 错误页）沿用基础预算。
        assert_eq!(transfer_budget(None), BASE_TRANSFER_BUDGET);
        assert_eq!(transfer_budget(Some(2 * 1024 * 1024)), BASE_TRANSFER_BUDGET);
        // 36 MB 的手机原图：按 64 KiB/s 的等效最低速率放宽到十分钟量级，
        // 不再用固定 120s 把「慢但在推进」的下载判死。
        assert!(transfer_budget(Some(36_852_238)) > BASE_TRANSFER_BUDGET * 4);
        // 再大也封顶，避免坏链路长期占用连接与内存。
        assert_eq!(transfer_budget(Some(u64::MAX / 2)), MAX_TRANSFER_BUDGET);
    }

    #[tokio::test]
    async fn merges_concurrent_requests_for_the_same_upstream_into_one_fetch() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = format!("{}/image.png", server.url);
        let request = || {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", &source);
            Request::builder()
                .method(Method::GET)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap()
        };

        // 画布节点会同时发 `<img>` 与前端会话字节缓存两条请求：只允许打扰上游一次。
        let (first, second) = tokio::join!(
            proxy_response(request(), Some(&cache), None),
            proxy_response(request(), Some(&cache), None),
        );

        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(first.body(), b"PNGBYTES");
        assert_eq!(second.body(), b"PNGBYTES");
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "同一上游地址的并发请求必须共享同一次取字节"
        );
    }

    #[tokio::test]
    async fn keeps_distinct_signatures_of_the_same_object_separate() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let request = |signature: u8| {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair(
                "src",
                &format!("{}/image-no-store?sig={signature}", server.url),
            );
            Request::builder()
                .method(Method::GET)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap()
        };

        // 续签前后的地址指向同一对象，但有效性不同：旧签名的失败不能拖累新签名，
        // 因此合并键是完整地址而不是「主机 + 路径」（不落盘的响应用于固定这一行为）。
        let (stale, fresh) = tokio::join!(
            proxy_response(request(1), Some(&cache), None),
            proxy_response(request(2), Some(&cache), None),
        );

        assert_eq!(stale.status(), StatusCode::OK);
        assert_eq!(fresh.status(), StatusCode::OK);
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_cancelled_leader_request_does_not_block_or_spin_later_requests() {
        use std::{future::Future as _, task::Poll};

        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = format!("{}/image.png", server.url);
        let request = || {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", &source);
            Request::builder()
                .method(Method::GET)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap()
        };

        // 推进一次即登记成领导请求并停在上游等待；随后直接丢弃它，模拟 WebView 侧取消。
        let mut leader = Box::pin(proxy_response(request(), Some(&cache), None));
        futures_util::future::poll_fn(|context| {
            let _ = leader.as_mut().poll(context);
            Poll::Ready(())
        })
        .await;
        drop(leader);

        // 后来的请求必须自己接手：既不能挂在死槽位上，也不能空转重试。
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            proxy_response(request(), Some(&cache), None),
        )
        .await
        .expect("领导请求被取消后，后续请求必须自行接手");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"PNGBYTES");
    }

    #[tokio::test]
    async fn does_not_cache_video_bodies_ranges_or_no_store_images() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();

        // 视频正文：不落盘（按 Range 播放）。
        let video = proxy_response(
            server
                .request(Method::GET, "/media")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
            None,
        )
        .await;
        assert_eq!(video.status(), StatusCode::OK);
        assert!(
            cache
                .read(&Url::parse(&format!("{}/media", server.url)).unwrap())
                .is_none()
        );

        // 上游声明 no-store：尊重其意图，不落盘。
        let no_store = proxy_response(
            server
                .request(Method::GET, "/image-no-store")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
            None,
        )
        .await;
        assert_eq!(no_store.status(), StatusCode::OK);
        assert!(
            cache
                .read(&Url::parse(&format!("{}/image-no-store", server.url)).unwrap())
                .is_none()
        );

        // Range 请求（视频续播）即使是图片也不写缓存：分块响应不是完整内容。
        let ranged = proxy_response(
            server
                .request(Method::GET, "/image.png")
                .header("range", "bytes=0-3")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
            None,
        )
        .await;
        assert!(ranged.status().is_success());
        assert!(
            cache
                .read(&Url::parse(&format!("{}/image.png", server.url)).unwrap())
                .is_none()
        );
    }

    #[tokio::test]
    async fn answers_head_from_the_local_copy_without_a_body() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = Url::parse(&format!("{}/image.png", server.url)).unwrap();
        cache.store(&source, Some("image/png"), b"PNGBYTES");

        let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
        url.query_pairs_mut().append_pair("src", source.as_str());
        let response = proxy_response(
            Request::builder()
                .method(Method::HEAD)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
            None,
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()["content-length"], "8");
        assert_eq!(server.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn accepts_native_and_webview_proxy_uris_without_corrupting_signed_queries() {
        let original = "https://cdn.example/video.mp4?token=a%2Bb&signature=x+y";
        for prefix in [
            "assetproxy://video",
            "assetproxy://localhost/video",
            "http://assetproxy.localhost/video",
        ] {
            let mut url = Url::parse(prefix).unwrap();
            url.query_pairs_mut().append_pair("src", original);
            let uri: Uri = url.as_str().parse().unwrap();
            assert_eq!(extract_upstream_url(&uri).unwrap().as_str(), original);
        }
        for source in [
            "file:///C:/video.mp4",
            "data:video/mp4,test",
            "https://user:secret@cdn.example/video",
        ] {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", source);
            assert!(extract_upstream_url(&url.as_str().parse().unwrap()).is_none());
        }
    }
}
