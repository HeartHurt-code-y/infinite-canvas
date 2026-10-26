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
//!
//! 体积与并发是两个维度，缺一不可：许可池（8 个）只限并发数，不限单条体积；整包路径
//! 也没有 Range 那种分块收口。因此每条响应体另有硬上界（见 [`MAX_MEDIA_FULL_BYTES`]），
//! 超限即回落本机副本或回 413 —— 没有这一条，一次异常大的响应就能把进程内存吃光。

use std::{
    collections::{HashMap, HashSet},
    path::{Path as StdPath, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use futures_util::future::join_all;
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
    protocol_reply::{self, MEDIA_PROXY_RESPONSE_POOL, ProtocolReplyGuard, WARM_PREVIEW_RESPONSE_POOL},
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

/// 单条媒体字节「整块进内存」时的体积上限（跨模块共享口径）。
///
/// 三条路径共用这一个数：上游整包响应、代理的本地整包兜底，以及 `media.rs` 里
/// 必须把素材整份留在内存里的解析分支。口径必须统一 —— 同一份素材从「代理」取与从
/// 「本机文件」取是两条不同的路，上限不一致就会出现「从代理取 128 MiB 被拒、
/// 从本机取 2 GiB 放行」这种自相矛盾的行为。
///
/// 取值 128 MiB，与磁盘缓存的单条上限（`media_cache::CacheLimits::default`）一致：
/// 超过这个体积的预览本来就落不了盘，代理再把它整包塞进内存毫无意义。
pub(crate) const MAX_MEDIA_FULL_BYTES: u64 = 128 * 1024 * 1024;

/// 上游整包（非 Range）响应的体积上限。
///
/// 与 [`MAX_MEDIA_FULL_BYTES`] 同值，但语义不同：整包路径没有 [`MAX_RANGE_CHUNK_BYTES`]
/// 那种分块收口，必须在这里给出硬上界 —— 许可池只限并发数、不限单条体积，一次异常大的
/// 响应（或上游忽略 Range 直接回整段视频）就能把进程内存吃光。
const MAX_UPSTREAM_FULL_BYTES: u64 = MAX_MEDIA_FULL_BYTES;

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
    /// 按云端素材身份回到导入时的原始文件。
    ///
    /// 上游列表并不总是回放暂存地址：可能换成自己的 CDN、`asset://` 占位，或干脆没有
    /// `url`。这些地址无法按对象键映射到暂存桶，但导入任务已经记下了 `asset_id` 与本地
    /// 路径。默认不映射任何身份。
    fn resolve_asset_id(&self, asset_id: &str) -> Option<LocalMediaSource> {
        let _ = asset_id;
        None
    }
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
    if requested.is_none() && length > MAX_MEDIA_FULL_BYTES {
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
    serve_resolved_local_copy(source, Some(upstream_url), request_headers, cache, is_head).await
}

/// 按云端素材身份用导入时的原始文件应答；若同时有上游地址，图片顺带按该地址落盘。
async fn serve_imported_asset(
    fallback: Option<&dyn LocalMediaFallback>,
    asset_id: &str,
    cache_url: Option<&Url>,
    request_headers: &HeaderMap,
    cache: Option<&MediaCache>,
    is_head: bool,
) -> Option<Response<Vec<u8>>> {
    let source = fallback?.resolve_asset_id(asset_id)?;
    serve_resolved_local_copy(source, cache_url, request_headers, cache, is_head).await
}

async fn serve_resolved_local_copy(
    source: LocalMediaSource,
    cache_url: Option<&Url>,
    request_headers: &HeaderMap,
    cache: Option<&MediaCache>,
    is_head: bool,
) -> Option<Response<Vec<u8>>> {
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
        if let (Some(cache), Some(content_type), Some(url)) = (cache, sniffed.as_deref(), cache_url)
        {
            if is_cacheable_content_type(Some(content_type))
                && cache.accepts_length(Some(copy.body.len() as u64))
            {
                cache.store(url, Some(content_type), &copy.body);
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
    /// 上游响应体超过单条上限：整包路径没有分块收口，只能在这里中止。
    TooLarge,
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
            Self::TooLarge => "media_source_too_large",
        }
    }

    /// 回给 WebView 的状态码。
    ///
    /// 超限是「这份素材本身太大，取不到」而不是「上游坏了」：本地有副本时先回落副本，
    /// 确实没有副本时回 413，让调用方能区分「换个素材」与「稍后重试」。
    fn status(self) -> StatusCode {
        match self {
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::BAD_GATEWAY,
        }
    }
}

/// 一次上游取字节的结果：完整响应，或分类后的失败。
///
/// 响应体用 `Arc<Vec<u8>>` 而不是裸 `Vec<u8>`：同一上游地址的并发请求共享同一次取字节
/// （见 `fetch_shared`），跟随请求若各自持有一份字节，几十 MB 的原图就会被复制多份，
/// 内存峰值随并发数线性膨胀。
///
/// 用 `Arc<Vec<u8>>` 而不是 `Arc<[u8]>`：响应最终必须交出独占的 `Vec<u8>`，`Arc<[u8]>`
/// 每次都要复制一份；`Arc<Vec<u8>>` 在只剩一个持有者时可以把原缓冲直接拿走。
enum FetchedUpstream {
    Media {
        status: StatusCode,
        headers: HeaderMap,
        body: Arc<Vec<u8>>,
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
                    body: Arc::new(body),
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
/// 仍有其他等待者时只复制引用计数，不复制字节本身。
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
                body: Arc::clone(body),
            },
            FetchedUpstream::Failed(failure) => FetchedUpstream::Failed(*failure),
        },
    }
}

/// 把共享字节取成响应体：只剩一个持有者时直接拿走原缓冲（不为一次响应多复制一份
/// 几十 MB 的字节），还有人持有时复制一份。
fn take_shared_body(body: Arc<Vec<u8>>) -> Vec<u8> {
    Arc::try_unwrap(body).unwrap_or_else(|shared| (*shared).clone())
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
    let cache = preview_cache().or_else(|| {
        context
            .app_handle()
            .path()
            .app_local_data_dir()
            .ok()
            .map(|directory| MediaCache::new(preview_cache_directory(&directory)))
    });
    // 本地兜底：暂存对象在导入成功后即被清理，上游素材记录却仍回放那个地址，
    // 于是取字节必然失败。按对象键回到导入任务用原始文件应答（见 `serve_local_copy`）。
    let fallback = context
        .app_handle()
        .try_state::<BackendState>()
        .map(|state| state.staging.clone());
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        /*
         * 兜底守卫在任务一开始就接管 responder。
         *
         * 响应计算期间任何 panic（缓存文件损坏 / JSON 解析失败 / 内部 expect）都会
         * 让这个 spawn 任务 unwind，responder 随之被 drop —— WebKit 的自定义协议
         * 任务就永远等不到 didFinish：预览**永久转圈**，macOS 上还会触发
         * "No response sent" NSException。守卫的 Drop 会 fire-and-forget 回一个
         * 503，保证任务一定有终态。
         */
        let mut guard = ProtocolReplyGuard::new(&app, responder);
        /*
         * 先取许可、再算响应。
         *
         * 许可必须覆盖「整段响应计算 + 主线程投递」：如果先算完响应再取许可，
         * 响应体此刻已经在内存里了，限流就名存实亡（真正的在途响应体上界是
         * 「许可数 × 单条响应体上限」）。
         */
        let Some(_permit) = MEDIA_PROXY_RESPONSE_POOL.acquire().await else {
            if let Some(responder) = guard.take_responder() {
                protocol_reply::respond_unavailable(&app, responder, "media_proxy_busy");
            }
            return;
        };
        let response = proxy_response(
            request,
            cache.as_ref(),
            fallback.as_ref().map(|value| value as _),
        )
        .await;
        let Some(responder) = guard.take_responder() else {
            return;
        };
        protocol_reply::deliver_protocol_response(&app, responder, response).await;
    });
}

/// 预览媒体缓存目录：与缩略图缓存同级，便于用户按需整体清理。
pub(crate) fn preview_cache_directory(local_data: &std::path::Path) -> PathBuf {
    local_data.join("media-preview-cache")
}

fn preview_cache_dir_slot() -> &'static Mutex<Option<PathBuf>> {
    static DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    DIR.get_or_init(|| Mutex::new(None))
}

/// 启动时钉死缓存目录，浏览暖缓存与协议处理共用同一份副本。
pub(crate) fn configure_preview_cache_directory(directory: PathBuf) {
    *preview_cache_dir_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(directory);
}

fn preview_cache_dir() -> Option<PathBuf> {
    preview_cache_dir_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn preview_cache() -> Option<MediaCache> {
    preview_cache_dir().map(MediaCache::new)
}

/// 浏览/回读给出仍有效的图片预览时，后台把字节落入磁盘缓存。
///
/// 海外 TOS 预签名会过期。`/v1/assets/get` 修好后会返回新签名，回读路径会立刻用上并再暖一次。
/// 修好之前，有效期内先落到本机，过期后协议层用同一对象键的副本应答。
/// 未配置缓存目录（单元测试）时直接返回，避免向示例域名发请求。
pub(crate) fn schedule_warm_image_previews(urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    let Some(dir) = preview_cache_dir() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        warm_image_previews(urls, Arc::new(MediaCache::new(dir))).await;
    });
}

const WARM_CONCURRENCY: usize = 4;

pub(crate) async fn warm_image_previews(urls: Vec<String>, cache: Arc<MediaCache>) {
    let mut prepared = Vec::new();
    let mut seen = HashSet::new();
    let now = SystemTime::now();
    for raw in urls {
        let Ok(url) = Url::parse(raw.trim()) else {
            continue;
        };
        if !valid_upstream(&url) || signed_url_expired(&url, now) {
            continue;
        }
        let key = format!("{}{}", url.host_str().unwrap_or_default(), url.path());
        if !seen.insert(key) {
            continue;
        }
        if cache.read(&url).is_some() {
            continue;
        }
        prepared.push(url);
    }
    for chunk in prepared.chunks(WARM_CONCURRENCY) {
        let futs = chunk.iter().cloned().map(|url| {
            let cache = Arc::clone(&cache);
            async move {
                warm_one(cache, url).await;
            }
        });
        join_all(futs).await;
    }
}

async fn warm_one(cache: Arc<MediaCache>, url: Url) {
    /*
     * 后台预热必须给前台预览让路：拿不到预热许可就直接跳过这张图
     * （前台有按需加载路径，不会丢预览），而不是排队等前台释放。
     */
    let Some(_permit) = WARM_PREVIEW_RESPONSE_POOL.try_acquire() else {
        return;
    };
    if cache.read(&url).is_some() {
        return;
    }
    let outcome = fetch_media_outcome(&url, Method::GET, &HeaderMap::new(), false).await;
    match take_outcome(outcome) {
        FetchedUpstream::Media {
            status,
            headers,
            body,
        } => {
            if status.is_success() {
                store_cacheable(
                    Some(cache.as_ref()),
                    &url,
                    &status,
                    &headers,
                    body.as_slice(),
                    false,
                );
            }
        }
        FetchedUpstream::Failed(failure) => {
            tauri_plugin_log::log::warn!("media preview warm failed: {}", failure.kind());
        }
    }
}

/// 只识别火山 TOS 的 `X-Tos-Date` + `X-Tos-Expires`；无法识别的地址按未过期处理。
pub(crate) fn signed_url_expired(url: &Url, now: SystemTime) -> bool {
    let mut date = None;
    let mut expires = None;
    for (key, value) in url.query_pairs() {
        if key.eq_ignore_ascii_case("X-Tos-Date") {
            date = Some(value.into_owned());
        } else if key.eq_ignore_ascii_case("X-Tos-Expires") {
            expires = Some(value.into_owned());
        }
    }
    let Some(date) = date else {
        return false;
    };
    let Some(expires) = expires else {
        return false;
    };
    let Ok(issued) = chrono::NaiveDateTime::parse_from_str(&date, "%Y%m%dT%H%M%SZ") else {
        return false;
    };
    let Ok(ttl) = expires.parse::<i64>() else {
        return false;
    };
    if ttl < 0 {
        return false;
    }
    let Some(expiry) = issued
        .and_utc()
        .checked_add_signed(chrono::Duration::seconds(ttl))
    else {
        return false;
    };
    DateTime::<Utc>::from(now) >= expiry
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
    let asset_id = extract_asset_id(request.uri());
    let src_url = extract_upstream_url(request.uri());
    let Some(mut upstream_url) = preferred_upstream(src_url, asset_id.as_deref()) else {
        if let Some(asset_id) = asset_id.as_deref() {
            if let Some(response) =
                serve_imported_asset(fallback, asset_id, None, request.headers(), cache, is_head)
                    .await
            {
                return response;
            }
        }
        tauri_plugin_log::log::warn!(
            "media proxy rejected: invalid_media_source, path={}, query_id={}, path_id={}, has_src={}",
            request.uri().path(),
            query_param(request.uri(), "assetId").is_some(),
            extract_asset_id_from_path(request.uri().path()).is_some(),
            query_param(request.uri(), "src").is_some()
        );
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
    // 预览路径不按 X-Tos-Date 短接：本机时钟或登记表里的旧签名都可能误判过期，
    // 宁可多打一次 TOS，由对象存储决定 200 还是 403。浏览暖缓存仍会跳过看起来
    // 已过期的地址（那不是用户正在看的那张图）。列表侧另有一条汇总日志。
    // 完整 GET 参与在途合并；Range/HEAD 各自带语义，逐一转发。
    let fetched = fetch_media_outcome(
        &upstream_url,
        request.method().clone(),
        request.headers(),
        range_requested,
    )
    .await;
    let fetched = if let Some(registered) =
        registry_retry_url(&fetched, &upstream_url, asset_id.as_deref())
    {
        upstream_url = registered;
        fetch_media_outcome(
            &upstream_url,
            request.method().clone(),
            request.headers(),
            range_requested,
        )
        .await
    } else {
        fetched
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
                    body.as_slice(),
                    range_requested,
                );
                let cached_control =
                    response_cache_header(cache, &status, &headers, body.as_slice(), range_requested);
                if let Some(value) = cached_control {
                    headers.insert("cache-control", value);
                }
                build_response(status, headers, take_shared_body(body))
            } else {
                // 远端明确报错（常见于签名过期）：本地有副本时继续用副本，
                // 不必把一屏已经下载过的预览打成「预览不可用」。
                tauri_plugin_log::log::warn!(
                    "media proxy upstream_media_error: status={}",
                    status.as_u16()
                );
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
                if let Some(asset_id) = asset_id.as_deref() {
                    if let Some(response) = serve_imported_asset(
                        fallback,
                        asset_id,
                        Some(&upstream_url),
                        request.headers(),
                        cache,
                        is_head,
                    )
                    .await
                    {
                        return response;
                    }
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
            // 超限时上游那份字节取不到，但本机副本往往还在：先回落副本，再考虑报错。
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
            if let Some(asset_id) = asset_id.as_deref() {
                if let Some(response) = serve_imported_asset(
                    fallback,
                    asset_id,
                    Some(&upstream_url),
                    request.headers(),
                    cache,
                    is_head,
                )
                .await
                {
                    return response;
                }
            }
            error_response(failure.status(), kind, is_head)
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
    let source = query_param(uri, "src")?;
    let url = Url::parse(&source).ok()?;
    valid_upstream(&url).then_some(url)
}

fn extract_asset_id(uri: &Uri) -> Option<String> {
    if let Some(raw) = query_param(uri, "assetId") {
        let id = normalize_asset_id(&raw);
        if !id.is_empty() {
            return Some(id);
        }
    }
    extract_asset_id_from_path(uri.path())
}

/// `http://assetproxy.localhost/{assetId}`：身份在路径上，不依赖 WebView 是否保留 query。
fn extract_asset_id_from_path(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let segment = trimmed.split('/').next().unwrap_or("");
    let decoded = percent_decode_component(segment)?;
    if decoded.eq_ignore_ascii_case("video") || decoded.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let id = normalize_asset_id(&decoded);
    (!id.is_empty()).then_some(id)
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key != name {
            continue;
        }
        // 预览地址由前端 `encodeURIComponent` 写入：只做百分号解码。
        // `application/x-www-form-urlencoded` 会把 `+` 变成空格，而 TOS 签名经常含 `+`，
        // 改坏后上游 403，卡片就会整页停在「预览不可用」。
        let decoded = percent_decode_component(value)?;
        return (!decoded.is_empty()).then_some(decoded);
    }
    None
}

fn percent_decode_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn normalize_asset_id(raw: &str) -> String {
    raw.trim()
        .strip_prefix("asset://")
        .unwrap_or_else(|| raw.trim())
        .trim()
        .to_string()
}

fn preview_registry() -> &'static Mutex<HashMap<String, Url>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Url>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_preview_registry() -> MutexGuard<'static, HashMap<String, Url>> {
    preview_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 浏览/回读云素材时记下完整预览地址，供媒体代理按素材身份取字节。
///
/// 签名 TOS 地址很长，塞进 WebView 的 `assetproxy?src=` 后可能被截断或二次解码；
/// 客户令牌拉来的素材本机又没有导入原图，截断后的 403 就会整页「预览不可用」。
pub(crate) fn remember_asset_preview_url(asset_id: &str, preview_url: Option<&str>) {
    let id = normalize_asset_id(asset_id);
    if id.is_empty() {
        return;
    }
    let Some(raw) = preview_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let Ok(url) = Url::parse(raw) else {
        return;
    };
    if !valid_upstream(&url) {
        return;
    }
    lock_preview_registry().insert(id, url);
}

fn lookup_asset_preview_url(asset_id: &str) -> Option<Url> {
    let id = normalize_asset_id(asset_id);
    if id.is_empty() {
        return None;
    }
    lock_preview_registry().get(&id).cloned()
}

fn preferred_upstream(src: Option<Url>, asset_id: Option<&str>) -> Option<Url> {
    let registered = asset_id.and_then(lookup_asset_preview_url);
    match (src, registered) {
        (None, registered) => registered,
        (Some(src), None) => Some(src),
        // 有登记地址时以浏览/回读时的完整签名为准：WebView 传来的 src 可能被截断或二次解码。
        (Some(_src), Some(registered)) => Some(registered),
    }
}

fn outcome_needs_registry_retry(outcome: &FetchedUpstream) -> bool {
    match outcome {
        // 体积超限与地址无关：换登记地址重试拿到的还是同一份超大的对象，不再重试。
        FetchedUpstream::Failed(UpstreamFailure::TooLarge) => false,
        FetchedUpstream::Failed(_) => true,
        FetchedUpstream::Media { status, .. } => {
            *status != StatusCode::RANGE_NOT_SATISFIABLE && !status.is_success()
        }
    }
}

fn registry_retry_url(
    fetched: &FetchedUpstream,
    attempted: &Url,
    asset_id: Option<&str>,
) -> Option<Url> {
    if !outcome_needs_registry_retry(fetched) {
        return None;
    }
    let registered = lookup_asset_preview_url(asset_id?)?;
    (registered.as_str() != attempted.as_str()).then_some(registered)
}

async fn fetch_media_outcome(
    url: &Url,
    method: Method,
    request_headers: &HeaderMap,
    range_requested: bool,
) -> SharedOutcome {
    if method == Method::GET && !range_requested {
        fetch_shared(url, request_headers).await
    } else {
        Arc::new(match fetch_upstream(url, method, request_headers).await {
            Ok((status, headers, body)) => FetchedUpstream::Media {
                status,
                headers,
                body: Arc::new(body),
            },
            Err(failure) => FetchedUpstream::Failed(failure),
        })
    }
}

fn valid_upstream(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn upstream_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
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
            .expect("media proxy client")
    })
}

/// 读取上游响应体，累计超过 `limit` 立刻中止。
///
/// 不能直接用 `response.bytes()`：自定义协议的响应必须是一块完整的 `Vec<u8>`，没有
/// 流式退路，那一步会把整包**无上界**地读进内存。整包路径又没有 [`MAX_RANGE_CHUNK_BYTES`]
/// 那种分块收口，一次异常大的响应（或上游忽略 Range 直接回整段视频）就能把进程内存吃光；
/// 许可池只限并发数、不限单条体积，8 个许可各带一份超大响应同样是峰值无界。
///
/// 这里按块读并守住上限：声明的 `content-length` 超限就直接拒绝（不必先下载），
/// 未声明长度的分块响应则边读边判。
async fn read_body_capped(
    mut response: reqwest::Response,
    limit: u64,
) -> Result<Vec<u8>, UpstreamFailure> {
    let declared = response.content_length();
    if declared.is_some_and(|length| length > limit) {
        return Err(UpstreamFailure::TooLarge);
    }
    // 声明长度可信时按它预分配，避免大响应在增长过程中反复搬运（峰值会翻倍）。
    let mut body = match declared {
        Some(length) => Vec::with_capacity(length as usize),
        None => Vec::new(),
    };
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| UpstreamFailure::from_error(&error))?
    {
        if body.len() as u64 + chunk.len() as u64 > limit {
            return Err(UpstreamFailure::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_upstream(
    url: &Url,
    method: Method,
    request_headers: &HeaderMap,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), UpstreamFailure> {
    let client = upstream_http_client();
    let is_head = method == Method::HEAD;
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
    // 体积上限与时间预算各管一件事：预算管「多久没动静」，上限管「最多搬多少字节」。
    let body = if is_head {
        // HEAD 只回响应头、一个字节都不搬：体积上限对它没有意义 —— 大视频的 HEAD 探测
        // 仍要能拿到自己的 content-length，否则一次 HEAD 就会被判成「素材过大」。
        Vec::new()
    } else {
        tokio::time::timeout(
            budget,
            read_body_capped(response, MAX_UPSTREAM_FULL_BYTES),
        )
        .await
        .map_err(|_| UpstreamFailure::Timeout)??
    };
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
