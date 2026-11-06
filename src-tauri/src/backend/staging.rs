use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};

use chrono::{Datelike as _, Utc};
use futures_util::TryStreamExt as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncReadExt as _;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::io::ReaderStream;
use url::Url;
use uuid::Uuid;

use super::{
    asset_library::{AssetLibrary, ImportStagedAsset},
    composer::VideoCompositionService,
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    image_normalize::normalize_image_for_asset_window,
    local_results::{format_bytes_per_sec, safe_file_stem},
    media_proxy::{LocalMediaFallback, LocalMediaSource, remember_asset_preview_url},
    provider::{redact_request_value, redact_url_string, truncate_connectivity_detail},
    storage::{Storage, now_ms},
    tos_sign::{PresignParams, TosCredentials, presign_url, presign_url_with_query},
    types::{
        AssetImportOutputRecord, CloudAssetStatus, ConnectivityTestResult, ImportedAssetSource,
        LocalAssetKindTotals, LocalAssetListQuery, LocalAssetPage, LocalAssetRecord, MediaType,
        ObserveAssetStatusCommand, RefreshLocalAssetMediaCommand, RefreshStagingObjectCommand,
        StagingCleanupCandidate, StagingJobRecord, StagingStatus, StartStagingCommand,
        TosBucketPullSummary, TosStagingConfig,
    },
};

/// 上传进度日志的节流间隔：每累计上传 1MB 记录一次，避免大文件刷屏；到达末尾必记录。
const PROGRESS_LOG_INTERVAL_BYTES: u64 = 1024 * 1024;

/// 预签名 PUT URL 有效期：15 分钟（上传窗口）。
const PUT_URL_EXPIRY_SECS: i64 = 900;

/// 预签名 GET / DELETE URL 有效期：1 小时，需覆盖素材导入轮询（最长 300 秒）与安全重试窗口。
const LEASE_URL_EXPIRY_SECS: i64 = 3600;
const OVERSEAS_UPLOAD_DEADLINE_MS: i64 = 20 * 60 * 1000;

/// 连通性测试探针对象的预签名 URL 有效期：只需覆盖一次立即发出的请求。
const PROBE_URL_EXPIRY_SECS: i64 = 60;

/// 连通性测试网络请求失败时的最大额外重试次数（指数退避）。
const PROBE_MAX_RETRIES: u32 = 3;

/// 连通性测试重试的指数退避基准延迟（毫秒）：第 n 次重试前等待 `BASE_MS * 2^(n-1)`。
const PROBE_RETRY_BASE_DELAY_MS: u64 = 500;

/// 代理软件（Clash 类）fake-ip 模式使用的保留网段（RFC 2544 基准测试网段）。
/// 该模式下系统 DNS 对任意域名返回 `198.18.0.0/15` 内的虚拟 IP，直连必然失败，
/// 上传会报 `isConnect: true` 的 HTTP transport error。
const FAKE_IP_PREFIX: (u8, u8) = (198, 18);

/// 备用公共 DNS（国内可达）：**最后兜底**，走 UDP:53。
///
/// 注意：在 fake-ip 环境里 UDP:53 往往也被透明劫持（实测连直接问 `223.5.5.5`
/// 都会返回 `198.18.0.21`），所以真正有效的第一选择是下面的 DoH。
const FALLBACK_DNS_SERVERS: [std::net::Ipv4Addr; 2] = [
    std::net::Ipv4Addr::new(223, 5, 5, 5),
    std::net::Ipv4Addr::new(119, 29, 29, 29),
];

/// DoH（DNS-over-HTTPS）JSON 接口，按序尝试。
///
/// 为什么需要 DoH：代理软件的 fake-ip 劫持发生在 **UDP:53** 这一层，本机的
/// `resolve_host_real_ips` 备用 DNS 因此同样拿不到真实地址（返回空 → 兜底失效）。
/// DoH 走 HTTPS、不在 53 端口上，实测能穿透该劫持拿到真实 A 记录：
/// `nslookup <域名> 223.5.5.5` 返回 `198.18.0.21`，而 `https://223.5.5.5/resolve`
/// 返回真实 IP。两个端点都选国内服务，与目标用户群一致。
const DOH_ENDPOINTS: [&str; 2] = ["https://223.5.5.5/resolve", "https://doh.pub/resolve"];

/// 单次 DoH 查询超时。这条路径只在连接已经失败过后才走到，不能拖慢整次下载。
const DOH_TIMEOUT_MS: u64 = 4_000;

/// 对象存储上传 PUT 连接/传输失败的最大自动重试次数（指数退避）。
const UPLOAD_MAX_RETRIES: u32 = 3;

/// 对象存储上传重试的指数退避基准延迟（毫秒）：第 n 次重试前等待 `BASE_MS * 2^(n-1)`。
const UPLOAD_RETRY_BASE_DELAY_MS: u64 = 500;

/// 暂存对象回收：单轮最多处理多少行，避免一次巡检发起过多网络请求。
const CLEANUP_MAX_ROWS_PER_PASS: u32 = 50;

/// 暂存对象回收：删除失败的最大重试次数。达到上限后该行进入终态，不再重试——
/// 否则每次启动都会重试同一行，既清不掉对象也永远不放手。
const CLEANUP_MAX_RETRY_COUNT: u32 = 10;

/// 暂存对象回收：重试退避基准（毫秒）。第 n 次失败后等待 `BASE * 2^(n-1)`。
const CLEANUP_RETRY_BASE_DELAY_MS: i64 = 5 * 60 * 1000;

/// 暂存对象回收：退避上限（毫秒），6 小时。避免长时间故障时把重试压得过密。
const CLEANUP_RETRY_MAX_DELAY_MS: i64 = 6 * 60 * 60 * 1000;

/// 暂存对象回收：后台巡检间隔（毫秒）。
///
/// 之所以不能只在启动时扫一次：退避重试需要「时间到了再试」，而启动扫描一辈子
/// 只发生一次，进程连续运行期间删除失败的对象永远等不到下一次重试。
const CLEANUP_POLL_INTERVAL_MS: u64 = 5 * 60 * 1000;

/// 桶素材拉取：支持的图片扩展名。avif 等预览兼容性差的格式排除，
/// 与远程导入白名单语义保持一致。
const PULL_IMAGE_EXTENSIONS: &[&str] = &[
    "jpeg", "jpg", "png", "webp", "bmp", "gif", "tiff", "tif", "heic", "heif",
];

/// 桶素材拉取：支持的视频扩展名。
const PULL_VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "ts", "3gp",
];

/// 桶素材拉取：支持的音频扩展名。
const PULL_AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "aac", "flac", "m4a", "ogg", "opus", "wma"];

/// 桶素材拉取：ListObjectsV2 分页防御上限（每页最多 1000 个对象，即最多列举 100 万个），
/// 防止异常响应（例如 continuation-token 永不推进）导致无限循环。
const LIST_BUCKET_MAX_PAGES: u32 = 1000;

/// 摸鱼素材服务（POST /v1/assets 上游）支持的图片扩展名白名单。
/// avif 等不在列表内的格式必须先转码为 webp 再导入，否则上游会以
/// `[InvalidParameter] unsupported asset URL format` 或 `DownloadFailed` 拒绝。
const SUPPORTED_IMPORT_IMAGE_EXTENSIONS: &[&str] =
    &["jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif", "heic"];

/// Windows 下隐藏 ffmpeg 子进程的控制台窗口，避免转码时弹出黑框。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 专用于 TOS 预签名请求的 HTTP 客户端。
///
/// 关键约束：**禁止自动跟随重定向**（`redirect::Policy::none()`）。
///
/// 预签名 URL 的签名绑定到请求 Host（CanonicalRequest 中 `host` 头域参与签名）。
/// 火山引擎 TOS 在「桶域名或预签名的 URL 访问限制变更」后，常对预签名请求返回
/// `301/307` 重定向到规范化 Host。若 reqwest 自动跟随，会把同一套签名查询串
/// 重放到不同 Host 上，TOS 用新 Host 重算签名即报 `SignatureDoesNotMatch`
/// （AK 合法仍被原样回显）。因此预签名请求必须原样发往签名时的 Host，
/// 3xx 由调用方显式判定为配置/域名问题，而非静默跟随导致签名失效。
fn build_presign_http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("InfiniteCanvas/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// 判断 IPv4 是否落在代理软件 fake-ip 虚拟网段（`198.18.0.0/15`）。
pub(crate) fn is_fake_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            octets[0] == FAKE_IP_PREFIX.0 && (octets[1] == 18 || octets[1] == 19)
        }
        std::net::IpAddr::V6(_) => false,
    }
}

/// 解析主机名，返回「可直连的真实 IP 列表」。
///
/// 正常网络：直接采用系统 DNS 解析结果。
/// 代理软件 fake-ip 环境：系统解析结果全部落在 `198.18.0.0/15` 虚拟网段时，
/// 改用备用公共 DNS（223.5.5.5 / 119.29.29.29）重新解析，穿透 fake-ip 劫持。
/// 返回空列表表示未能取得可靠的真实地址，调用方应保持原行为（原样报错）。
///
/// 该解析与具体业务无关（对象存储 endpoint、生成结果直链共用）：只要客户端可能
/// 绕过代理直连某个域名，fake-ip 都会让连接落在一个不可路由的虚拟地址上。
/// 从 DoH 的 JSON 响应里取出 A 记录（`type == 1`），并过滤 fake-ip 虚拟地址。
///
/// 响应形如（两个端点一致）：
/// `{"Status":0,"Answer":[{"name":"h.","type":1,"TTL":60,"data":"1.2.3.4"}]}`
/// CNAME 链会产生 `type == 5` 的条目，必须忽略——那不是地址。
fn doh_a_records(body: &str) -> Vec<std::net::IpAddr> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    value
        .get("Answer")
        .and_then(Value::as_array)
        .map(|answers| {
            answers
                .iter()
                .filter(|answer| answer.get("type").and_then(Value::as_u64) == Some(1))
                .filter_map(|answer| answer.get("data").and_then(Value::as_str))
                .filter_map(|data| data.parse::<std::net::IpAddr>().ok())
                .filter(|ip| !is_fake_ip(*ip))
                .collect()
        })
        .unwrap_or_default()
}

/// 用 DoH 解析主机名，返回真实 A 记录；失败时返回空列表。
///
/// 复用调用方传入的共享 client，因此同样遵循系统代理配置；但会盖上自己的短超时。
async fn resolve_via_doh(client: &reqwest::Client, host: &str) -> Vec<std::net::IpAddr> {
    for endpoint in DOH_ENDPOINTS {
        let Ok(mut url) = url::Url::parse(endpoint) else {
            continue;
        };
        url.query_pairs_mut()
            .clear()
            .append_pair("name", host)
            .append_pair("type", "A");
        let response = client
            .get(url)
            .timeout(std::time::Duration::from_millis(DOH_TIMEOUT_MS))
            .send()
            .await;
        let response = match response {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                warn!(
                    "[staging] DoH 查询返回 HTTP {}: endpoint={endpoint}, host={host}",
                    response.status()
                );
                continue;
            }
            Err(error) => {
                warn!("[staging] DoH 查询失败: endpoint={endpoint}, host={host}, 错误={error}");
                continue;
            }
        };
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                warn!("[staging] DoH 响应读取失败: endpoint={endpoint}, host={host}, 错误={error}");
                continue;
            }
        };
        let ips = doh_a_records(&body);
        if !ips.is_empty() {
            return ips;
        }
        // 端点本身也可能被劫持（返回虚拟地址），继续试下一个。
        warn!(
            "[staging] DoH 未给出可用地址: endpoint={endpoint}, host={host}, 条目数={}",
            serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| value.get("Answer").and_then(Value::as_array).map(Vec::len))
                .unwrap_or(0)
        );
    }
    Vec::new()
}

pub(crate) async fn resolve_host_real_ips(
    client: &reqwest::Client,
    host: &str,
) -> Vec<std::net::IpAddr> {
    if let Ok(addrs) = tokio::net::lookup_host((host, 443)).await {
        let real: Vec<std::net::IpAddr> = addrs
            .map(|addr| addr.ip())
            .filter(|ip| !is_fake_ip(*ip))
            .collect();
        if !real.is_empty() {
            return real;
        }
        warn!(
            "[staging] 系统 DNS 解析 {host} 全部落在 fake-ip 虚拟网段（疑似代理软件劫持），改用 DoH 解析"
        );
    }
    // 第一选择是 DoH：UDP:53 在 fake-ip 环境下同样会被劫持，DoH 走 HTTPS 能穿透。
    let doh = resolve_via_doh(client, host).await;
    if !doh.is_empty() {
        info!(
            "[staging] DoH 拿到 {host} 的真实地址 {} 条，绕过 fake-ip 劫持",
            doh.len()
        );
        return doh;
    }
    // 最后退到 UDP:53：部分环境没有被劫持，仍可能拿到结果。
    let mut fallback: Vec<std::net::IpAddr> = Vec::new();
    for server in FALLBACK_DNS_SERVERS {
        let name_servers = hickory_resolver::config::NameServerConfigGroup::from_ips_clear(
            &[std::net::IpAddr::V4(server)],
            53,
            false,
        );
        let config =
            hickory_resolver::config::ResolverConfig::from_parts(None, Vec::new(), name_servers);
        let resolver = hickory_resolver::TokioAsyncResolver::tokio(
            config,
            hickory_resolver::config::ResolverOpts::default(),
        );
        match resolver.lookup_ip(host).await {
            Ok(lookup) => {
                for ip in lookup.iter() {
                    if !is_fake_ip(ip) && !fallback.contains(&ip) {
                        fallback.push(ip);
                    }
                }
                if !fallback.is_empty() {
                    break;
                }
            }
            Err(error) => {
                warn!("[staging] 备用 DNS {server} 解析 {host} 失败: {error}");
            }
        }
    }
    fallback
}

/// 构建「把主机名固定到真实 IP」的 HTTP 客户端。
///
/// 代理 fake-ip 环境下，将域名强制映射到真实 IP（`resolve_to_addrs`），直连真实
/// 地址并保持 Host/SNI 不变，从而绕过虚拟 IP 导致的连接失败；`real_ips` 为空时
/// 行为与普通客户端一致。`redirect` 由调用方决定：预签名请求必须禁止跟随，
/// 结果直链下载则需要跟随 CDN 的 3xx。
fn build_fake_ip_pinned_client(
    host: &str,
    port: u16,
    real_ips: &[std::net::IpAddr],
    redirect: reqwest::redirect::Policy,
) -> reqwest::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("InfiniteCanvas/0.1")
        .redirect(redirect);
    if !real_ips.is_empty() {
        let sockets: Vec<std::net::SocketAddr> = real_ips
            .iter()
            .map(|ip| std::net::SocketAddr::new(*ip, port))
            .collect();
        builder = builder.resolve_to_addrs(host, &sockets);
    }
    builder.build()
}

/// 构建 TOS 上传 HTTP 客户端（https，禁止跟随重定向）。
fn build_tos_upload_client(
    host: &str,
    real_ips: &[std::net::IpAddr],
) -> reqwest::Result<reqwest::Client> {
    build_fake_ip_pinned_client(host, 443, real_ips, reqwest::redirect::Policy::none())
}

/// 为任意 URL（主要是 TOS 预签名 URL）构建 fake-ip 感知的 HTTP 客户端：
/// 解析到真实 IP 时用 `resolve_to_addrs` 直连真实地址，否则回退到 `fallback`。
pub(crate) async fn fake_ip_aware_client(url: &str, fallback: reqwest::Client) -> reqwest::Client {
    let Ok(parsed) = url::Url::parse(url) else {
        return fallback;
    };
    let Some(host) = parsed.host_str() else {
        return fallback;
    };
    let real_ips = resolve_host_real_ips(&fallback, host).await;
    if real_ips.is_empty() {
        return fallback;
    }
    build_tos_upload_client(host, &real_ips).unwrap_or(fallback)
}

/// 为「生成结果直链下载」构建 fake-ip 感知的客户端。
///
/// 只有**确认**被代理软件劫持（系统 DNS 把该主机解析到 `198.18.0.0/15` 虚拟网段，
/// 且没有任何真实地址）时才另建客户端，把主机名固定到备用 DNS 解析出的真实地址，
/// 并保留 Host/SNI。正常网络原样返回 `fallback`，继续使用共享客户端——保留连接池，
/// 也不干扰 reqwest 已启用的系统代理自动读取。
///
/// 重定向策略保持默认（跟随 3xx）：结果直链没有预签名 Host 绑定约束，上游 CDN 用
/// 302 做实际分发是常见行为。钉扎客户端没有整段总超时：结果落盘可能走十几分钟的
/// 慢直链，300s 上限会把还在进数据的传输杀掉。
pub(crate) async fn fake_ip_aware_streaming_download_client(
    url: &str,
    fallback: reqwest::Client,
) -> reqwest::Client {
    let Ok(parsed) = url::Url::parse(url) else {
        return fallback;
    };
    let Some(host) = parsed.host_str() else {
        return fallback;
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let Ok(addresses) = tokio::net::lookup_host((host, port)).await else {
        return fallback;
    };
    let system_ips: Vec<std::net::IpAddr> = addresses.map(|address| address.ip()).collect();
    if system_ips.is_empty() || system_ips.iter().any(|ip| !is_fake_ip(*ip)) {
        return fallback;
    }
    let real_ips = resolve_host_real_ips(&fallback, host).await;
    if real_ips.is_empty() {
        return fallback;
    }
    warn!(
        "[save] {host} 被代理软件 fake-ip 劫持（系统解析 {system_ips:?}），改用无总超时的钉扎客户端继续下载"
    );
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .user_agent("InfiniteCanvas/0.1")
        .redirect(reqwest::redirect::Policy::default());
    if !real_ips.is_empty() {
        let sockets: Vec<std::net::SocketAddr> = real_ips
            .iter()
            .map(|ip| std::net::SocketAddr::new(*ip, port))
            .collect();
        builder = builder.resolve_to_addrs(host, &sockets);
    }
    builder.build().unwrap_or(fallback)
}

/// 判断 reqwest 错误是否属于「可重试的网络层失败」（连接、超时、请求传输失败）。
/// HTTP 非 2xx 状态不在此列——那是 TOS 端拒绝，重试无意义。
fn is_retryable_upload_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request()
}

/// 上传发送阶段可能的失败类型：本地文件读取失败或 HTTP 传输失败。
#[derive(Debug)]
enum UploadAttemptError {
    Io(std::io::Error),
    Http(reqwest::Error),
}

impl UploadAttemptError {
    /// 是否属于可重试的瞬时失败（本地文件瞬态错误或网络层错误）。
    fn is_retryable(&self) -> bool {
        match self {
            UploadAttemptError::Io(_) => true,
            UploadAttemptError::Http(error) => is_retryable_upload_error(error),
        }
    }
}

impl std::fmt::Display for UploadAttemptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UploadAttemptError::Io(error) => error.fmt(formatter),
            UploadAttemptError::Http(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for UploadAttemptError {}

/// 带指数退避重试的对象存储上传 PUT 发送。
///
/// 仅对可重试的瞬时失败（`UploadAttemptError::is_retryable`）重试，最多
/// `UPLOAD_MAX_RETRIES` 次，每次重试前等待
/// `UPLOAD_RETRY_BASE_DELAY_MS * 2^(attempt)` 毫秒；
/// `send` 每次重试都会重新调用，调用方据此重建请求体（重新打开文件流）。
async fn send_upload_with_retry<F, Fut>(
    primary_client: &reqwest::Client,
    fallback_client: Option<&reqwest::Client>,
    send: &mut F,
) -> Result<reqwest::Response, UploadAttemptError>
where
    F: FnMut(reqwest::Client) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, UploadAttemptError>>,
{
    let mut attempt: u32 = 0;
    let mut use_fallback = false;
    loop {
        let client = if use_fallback {
            fallback_client.unwrap_or(primary_client)
        } else {
            primary_client
        };
        match send(client.clone()).await {
            Ok(response) => return Ok(response),
            Err(error) if attempt < UPLOAD_MAX_RETRIES && error.is_retryable() => {
                if fallback_client.is_some()
                    && matches!(&error, UploadAttemptError::Http(error) if error.is_connect() || error.is_timeout())
                {
                    use_fallback = !use_fallback;
                }
                let next_route = if use_fallback {
                    "system-dns-proxy"
                } else if fallback_client.is_some() {
                    "pinned-ip"
                } else {
                    "default"
                };
                let delay_ms = UPLOAD_RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                warn!(
                    "[staging] 对象存储上传网络失败，{delay_ms}ms 后重试 ({}/{}), 下次路径={next_route}：{error}",
                    attempt + 1,
                    UPLOAD_MAX_RETRIES
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// 带指数退避重试的连通性探针 GET 请求。
///
/// `make_url` 每次（含重试）都会重新调用，调用方据此重新生成预签名 URL——探针 URL
/// 有效期仅 `PROBE_URL_EXPIRY_SECS` 秒，而单次连接超时最长 30 秒，若固定 URL，
/// 多次超时累计后探针 URL 会过期。
///
/// 仅对网络层失败（连接、超时等 `reqwest::Error`）重试，最多 `PROBE_MAX_RETRIES` 次，
/// 每次重试前等待 `PROBE_RETRY_BASE_DELAY_MS * 2^(attempt)` 毫秒；presign 等生成 URL 的
/// 错误直接传播（重试无意义），最后一次网络错误包装为 `BackendError::Transport`。
async fn send_probe_with_retry<F>(
    primary_client: &reqwest::Client,
    fallback_client: Option<&reqwest::Client>,
    make_url: F,
) -> BackendResult<reqwest::Response>
where
    F: Fn() -> BackendResult<String>,
{
    let mut attempt: u32 = 0;
    let mut use_fallback = false;
    loop {
        let url = make_url()?;
        let client = if use_fallback {
            fallback_client.unwrap_or(primary_client)
        } else {
            primary_client
        };
        match client.get(&url).send().await {
            Ok(response) => return Ok(response),
            Err(error) if attempt < PROBE_MAX_RETRIES => {
                if fallback_client.is_some() && (error.is_connect() || error.is_timeout()) {
                    use_fallback = !use_fallback;
                }
                let next_route = if use_fallback {
                    "system-dns-proxy"
                } else if fallback_client.is_some() {
                    "pinned-ip"
                } else {
                    "default"
                };
                let delay_ms = PROBE_RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                warn!(
                    "[staging] 连通性测试网络请求失败，{delay_ms}ms 后重试 ({}/{}), 下次路径={next_route}：{error}",
                    attempt + 1,
                    PROBE_MAX_RETRIES
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                attempt += 1;
            }
            Err(error) => return Err(BackendError::Transport(error)),
        }
    }
}

#[derive(Clone)]
pub struct StagingService {
    storage: Arc<Storage>,
    credentials: CredentialStore,
    assets: AssetLibrary,
    /// 共享 FFmpeg 引擎：素材导入遇到不支持格式（如 avif）时用于本地转码。
    composer: VideoCompositionService,
    client: reqwest::Client,
    content_gates: Arc<AsyncMutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    active_jobs: Arc<AsyncMutex<HashSet<String>>>,
    /// 已经交给供应商、还没回收的中转租约（jobId 集合）。
    ///
    /// 回收器靠它判断「这个对象此刻还有人用」：租约发出后到回收之前，
    /// 供应商随时可能正在取这个对象的字节，删掉就把正在跑的请求打断。
    /// 进程重启后这张表是空的 —— 那正是「租约随进程一起没了」的情形，
    /// 对象已经没人认领，可以回收。
    live_leases: Arc<AsyncMutex<HashSet<String>>>,
    /// 回收循环是否已经启动（保证一个进程里只有一个循环）。
    cleanup_loop_started: Arc<AtomicBool>,
}

async fn gate_for_content(
    gates: &AsyncMutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    key: &str,
) -> Arc<AsyncMutex<()>> {
    let mut gates = gates.lock().await;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(existing) = gates.get(key).and_then(Weak::upgrade) {
        return existing;
    }
    let gate = Arc::new(AsyncMutex::new(()));
    gates.insert(key.to_string(), Arc::downgrade(&gate));
    gate
}

#[derive(Debug, Clone)]
pub struct StagingLease {
    pub job_id: String,
    pub get_url: String,
    pub delete_url: Option<String>,
}

/// 一轮暂存对象回收的结果计数（只用于日志与后台统计）。
#[derive(Debug, Default, Clone, Copy)]
pub struct StagingCleanupSummary {
    /// 已确认删除（对象本来就不存在也算）的对象数。
    pub deleted: u32,
    /// 删除失败、已安排退避重试的对象数。
    pub failed: u32,
    /// 重试达上限、进入终态的对象数。
    pub abandoned: u32,
    /// 本进程里仍在使用、跳过的对象数。
    pub skipped_live: u32,
    /// 仍被其它任务持有、跳过的对象数。
    pub skipped_owned: u32,
}

/// 回收重试的退避时长：第 n 次失败后等 `BASE * 2^(n-1)`，并封顶。
fn cleanup_retry_delay_ms(retry_count: u32) -> i64 {
    let exponent = retry_count.saturating_sub(1).min(20);
    CLEANUP_RETRY_BASE_DELAY_MS
        .saturating_mul(1_i64 << exponent)
        .min(CLEANUP_RETRY_MAX_DELAY_MS)
}

fn is_overseas_terminal_error(error: &BackendError) -> bool {
    match error {
        BackendError::Protocol { details, .. } => details
            .get("terminalStatus")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                status.eq_ignore_ascii_case("failed")
                    || status.eq_ignore_ascii_case("deleted")
                    || status.eq_ignore_ascii_case("timedout")
            }),
        _ => false,
    }
}

fn is_overseas_timeout_error(error: &BackendError) -> bool {
    matches!(
        error,
        BackendError::Protocol { details, .. }
            if details.get("terminalStatus")
                .and_then(Value::as_str)
                .is_some_and(|status| status.eq_ignore_ascii_case("timedout"))
    )
}

fn overseas_timeout_error(db_id: u64) -> BackendError {
    BackendError::protocol(
        "overseas asset upload exceeded its 20-minute local deadline",
        json!({ "terminalStatus": "TimedOut", "dbId": db_id }),
    )
}

fn remaining_overseas_wait_ms(submitted_at: i64, now: i64) -> i64 {
    submitted_at
        .saturating_add(OVERSEAS_UPLOAD_DEADLINE_MS)
        .saturating_sub(now)
}

impl StagingService {
    pub fn new(
        storage: Arc<Storage>,
        credentials: CredentialStore,
        assets: AssetLibrary,
        composer: VideoCompositionService,
    ) -> BackendResult<Self> {
        let client = build_presign_http_client().map_err(|error| {
            BackendError::validation(
                "failed to build TOS presign HTTP client",
                json!({ "source": error.to_string() }),
            )
        })?;
        Ok(Self {
            storage,
            credentials,
            assets,
            composer,
            client,
            content_gates: Arc::new(AsyncMutex::new(HashMap::new())),
            active_jobs: Arc::new(AsyncMutex::new(HashSet::new())),
            live_leases: Arc::new(AsyncMutex::new(HashSet::new())),
            cleanup_loop_started: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn configure(&self, config: &TosStagingConfig) -> BackendResult<()> {
        validate_tos_config(config)?;
        self.storage.save_tos_config(config)
    }

    /// 连通性测试：对 `{objectPrefix}/.connectivity-probe` 探针对象发起一次预签名 GET。
    ///
    /// 判定依据（TOS 先验签再检查对象存在性）：
    /// - 2xx 或 404 + `NoSuchKey`：签名与 AK/SK 有效且桶存在，视为通过；
    /// - 404 + `NoSuchBucket`：桶不存在；
    /// - 401/403：凭据或签名被拒绝；
    /// - 其余：服务端异常状态。
    ///
    /// 网络层失败（DNS、超时）转换为 `ok=false` 的结果而不是错误，
    /// 保存动作本身已经成功，前端需要把两种结果分开提示。
    pub async fn test_connectivity(&self) -> BackendResult<ConnectivityTestResult> {
        let config = self
            .storage
            .get_tos_config()?
            .ok_or_else(|| BackendError::validation("TOS staging is not configured", json!({})))?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({}),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;

        let host = format!("{}.{}", config.bucket, config.endpoint);
        let probe_key = format!(
            "{}/.connectivity-probe",
            config.object_prefix.trim_matches('/')
        );
        info!(
            "[staging] 开始连通性测试: bucket={}, region={}, endpoint={}, objectKey={}",
            config.bucket, config.region, config.endpoint, probe_key
        );
        let started_at = std::time::Instant::now();
        // 代理 fake-ip 环境下用备用 DNS 拿真实 IP 直连，避免连通性测试误报失败。
        let real_ips = resolve_host_real_ips(&self.client, &host).await;
        let probe_client = match build_tos_upload_client(&host, &real_ips) {
            Ok(client) => client,
            Err(error) => {
                return Ok(ConnectivityTestResult {
                    ok: false,
                    http_status: None,
                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                    reason: Some("client-build-error".to_string()),
                    detail: Some(error.to_string()),
                });
            }
        };
        // 网络层失败按指数退避重试（最多 PROBE_MAX_RETRIES 次）；每次重试重新生成
        // 预签名 URL，避免退避等待或单次连接超时（最长 30s）累计超过探针 URL 的 60s 有效期。
        let fallback_client = (!real_ips.is_empty()).then_some(&self.client);
        let response = match send_probe_with_retry(&probe_client, fallback_client, || {
            presign_url(&PresignParams {
                method: "GET",
                host: &host,
                object_key: &probe_key,
                region: &config.region,
                credentials: &credentials,
                expires_secs: PROBE_URL_EXPIRY_SECS,
                now: Utc::now(),
            })
        })
        .await
        {
            Ok(response) => response,
            Err(BackendError::Transport(error)) => {
                return Ok(ConnectivityTestResult {
                    ok: false,
                    http_status: None,
                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                    reason: Some("network-error".to_string()),
                    detail: Some(super::provider::truncate_connectivity_detail(
                        &error.to_string(),
                    )),
                });
            }
            Err(error) => return Err(error),
        };
        let status = response.status().as_u16();
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        let verdict = classify_probe_response(status, &body);
        info!(
            "[staging] 连通性测试完成: HTTP {status}, verdict={}, 耗时 {}ms",
            verdict.reason_name().unwrap_or("ok"),
            started_at.elapsed().as_millis()
        );
        Ok(ConnectivityTestResult {
            ok: verdict.is_ok(),
            http_status: Some(status),
            elapsed_ms: started_at.elapsed().as_millis() as u64,
            reason: verdict.reason_name().map(str::to_string),
            detail: (!verdict.is_ok()).then(|| {
                let code = extract_error_code(&body)
                    .map(|code| format!("code={code}, "))
                    .unwrap_or_default();
                truncate_connectivity_detail(&format!("{code}{}", body.trim()))
            }),
        })
    }

    pub fn create_job(&self, command: StartStagingCommand) -> BackendResult<StagingJobRecord> {
        let timestamp = now_ms();
        let job = StagingJobRecord {
            id: Uuid::new_v4().to_string(),
            local_path: command.local_path,
            purpose: command.purpose,
            media_type: command.media_type,
            object_key: None,
            status: StagingStatus::Validating,
            bytes_total: None,
            bytes_uploaded: 0,
            asset_id: None,
            overseas_db_id: None,
            import_target: command.import,
            adjustment: None,
            error: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.storage.insert_staging_job(&job)?;
        if job.purpose == "local_asset" && job.import_target.is_none() {
            if let Some(config) = self.storage.get_tos_config()? {
                self.storage
                    .remember_staging_object_target(&job.id, &config)?;
            }
        }
        Ok(job)
    }

    /// 列出产物上传到云端素材库的入库记录，供应用重启后恢复绿色小点与在途上传行。
    ///
    /// 应用重启会丢掉前端的 `jobId → 产物节点` 映射：上传本身在后端继续推进，但成功事件
    /// 到达时前端已无法回查对应的产物卡片，绿色小点会永远不亮；在途上传也从面板消失。
    /// 这里把仍在推进或刚完成的上传交回前端，由前端按本地路径匹配产物节点后继续接管。
    pub fn list_asset_import_outputs(&self) -> BackendResult<Vec<AssetImportOutputRecord>> {
        let jobs = self.storage.list_asset_import_outputs()?;
        Ok(jobs
            .into_iter()
            .map(|job| {
                let group_id = job
                    .import_target
                    .as_ref()
                    .and_then(|target| target.group_id.clone());
                AssetImportOutputRecord {
                    job_id: job.id,
                    provider_connection_id: job
                        .import_target
                        .as_ref()
                        .map(|target| target.provider_connection_id.clone())
                        .unwrap_or_default(),
                    local_path: job.local_path,
                    media_type: job.media_type,
                    status: job.status,
                    asset_id: job.asset_id,
                    overseas_db_id: job.overseas_db_id,
                    group_id,
                    bytes_uploaded: job.bytes_uploaded,
                    bytes_total: job.bytes_total,
                    error: job.error,
                    created_at: job.created_at,
                    updated_at: job.updated_at,
                }
            })
            .collect())
    }

    /// 按云端素材身份找回导入时的本机原件。文件已经不在磁盘上时返回 `None`，调用方不得删除云端记录。
    pub fn imported_asset_source(
        &self,
        asset_id: &str,
    ) -> BackendResult<Option<ImportedAssetSource>> {
        self.imported_asset_source_in_scope(asset_id, None)
    }

    pub(super) fn imported_asset_source_for_generation(
        &self,
        asset_id: &str,
        provider_connection_id: &str,
        media_type: MediaType,
    ) -> BackendResult<Option<ImportedAssetSource>> {
        Ok(self
            .imported_asset_source_in_scope(asset_id, Some(provider_connection_id))?
            .filter(|source| source.media_type == media_type))
    }

    fn imported_asset_source_in_scope(
        &self,
        asset_id: &str,
        provider_connection_id: Option<&str>,
    ) -> BackendResult<Option<ImportedAssetSource>> {
        let job = match provider_connection_id {
            Some(provider) => self.storage.find_asset_import_job_by_provider_asset_id(provider, asset_id)?,
            None => self.storage.find_asset_import_job_by_asset_id(asset_id)?,
        };
        let Some(job) = job else {
            return Ok(None);
        };
        let path = PathBuf::from(job.local_path.trim());
        let file_exists = !path.as_os_str().is_empty()
            && std::fs::metadata(&path)
                .map(|meta| meta.is_file())
                .unwrap_or(false);
        if !file_exists {
            return Ok(None);
        }
        Ok(Some(ImportedAssetSource {
            local_path: path.to_string_lossy().into_owned(),
            media_type: job.media_type,
            group_id: job
                .import_target
                .as_ref()
                .and_then(|target| target.group_id.clone()),
            name: job
                .import_target
                .as_ref()
                .and_then(|target| target.name.clone()),
        }))
    }

    /// 列出本机索引中的素材，并为每个对象生成新的只读预签名 URL。
    /// 此路径不访问供应商素材库，也不要求存在供应商连接。
    ///
    /// 传入 [`LocalAssetListQuery`] 时按类型与文件名子串过滤后分页返回（仅对页内条目
    /// 预签名）；不传查询时返回全量（素材选择器等需要完整列表的场景）。
    /// `kind_totals` 始终是全库按类型计数，不受过滤影响。
    pub fn list_local_assets(
        &self,
        query: Option<LocalAssetListQuery>,
    ) -> BackendResult<LocalAssetPage> {
        let jobs = self.storage.list_local_asset_jobs()?;
        let current_config = self.storage.get_tos_config()?;
        let mut kind_totals = LocalAssetKindTotals::default();
        // 先构造 (job, 文件名) 全集并校验 object_key，保证缺 object_key 的坏数据
        // 与旧行为一致地直接报错，同时支撑全库类型计数。
        let mut rows: Vec<(StagingJobRecord, String)> = Vec::with_capacity(jobs.len());
        for job in jobs {
            if let Some(current) = current_config.as_ref() {
                let saved = self.storage.get_staging_object_target(&job.id)?;
                if !local_asset_matches_current_scope(saved.as_ref(), &job, current) {
                    continue;
                }
            }
            if job.object_key.is_none() {
                return Err(BackendError::protocol(
                    "local asset upload has no object key",
                    json!({ "stagingJobId": job.id }),
                ));
            }
            match job.media_type {
                MediaType::Image => kind_totals.image += 1,
                MediaType::Video => kind_totals.video += 1,
                MediaType::Audio => kind_totals.audio += 1,
                MediaType::Text => {}
            }
            let name = Path::new(&job.local_path)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or(&job.local_path)
                .to_string();
            rows.push((job, name));
        }
        let Some(query) = query else {
            let total = rows.len() as u64;
            let page_size = total.max(1) as u32;
            let items = rows
                .into_iter()
                .map(|(job, _)| self.local_asset_record(&job))
                .collect::<BackendResult<Vec<_>>>()?;
            return Ok(LocalAssetPage {
                items,
                total,
                page: 1,
                page_size,
                kind_totals,
            });
        };
        let media_filter = query.media_type;
        let name_filter = query
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        rows.retain(|(job, name)| {
            media_filter.is_none_or(|media| job.media_type == media)
                && name_filter
                    .as_ref()
                    .is_none_or(|needle| name.to_lowercase().contains(needle))
        });
        let total = rows.len() as u64;
        let page = query.page.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(40).clamp(1, 200);
        let skip = (page as u64 - 1) * u64::from(page_size);
        let items = rows
            .into_iter()
            .skip(usize::try_from(skip).unwrap_or(usize::MAX))
            .take(page_size as usize)
            .map(|(job, _)| self.local_asset_record(&job))
            .collect::<BackendResult<Vec<_>>>()?;
        Ok(LocalAssetPage {
            items,
            total,
            page,
            page_size,
            kind_totals,
        })
    }

    /// 将一个本地素材 staging job 转换为素材记录（含按次签发的只读预签名 URL）。
    ///
    /// 预签名失败（对象存储未配置、凭据丢失、签名被拒）不得把整页索引打掉：
    /// 卡片身份仍在 SQLite 里，预览可以空着等用户补回 TOS。
    fn local_asset_record(&self, job: &StagingJobRecord) -> BackendResult<LocalAssetRecord> {
        let object_key = job.object_key.as_deref().ok_or_else(|| {
            BackendError::protocol(
                "local asset upload has no object key",
                json!({ "stagingJobId": job.id }),
            )
        })?;
        let preview_url = match self.material_object_lease(job, object_key) {
            Ok(lease) => {
                remember_asset_preview_url(&job.id, Some(&lease.get_url));
                lease.get_url
            }
            Err(error) => {
                warn!(
                    "[staging] 本地素材预览签发失败，仍返回索引条目: stagingJobId={}, objectKey={object_key}, 错误: {error}",
                    job.id
                );
                String::new()
            }
        };
        let name = Path::new(&job.local_path)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or(&job.local_path)
            .to_string();
        Ok(LocalAssetRecord {
            id: job.id.clone(),
            name,
            media_type: job.media_type,
            object_key: object_key.to_string(),
            preview_url,
            byte_size: job.bytes_total.unwrap_or(job.bytes_uploaded),
            created_at: job.created_at,
        })
    }

    /// 为一个本地素材签发新的读取地址。对象是素材正文，不返回给任务清理流程。
    pub fn local_asset_lease(
        &self,
        staging_job_id: &str,
        expected_media_type: MediaType,
    ) -> BackendResult<StagingLease> {
        let job = self.storage.get_staging_job(staging_job_id)?;
        if job.purpose != "local_asset" || job.import_target.is_some() {
            return Err(BackendError::validation(
                "staging job is not a local library asset",
                json!({ "stagingJobId": staging_job_id, "purpose": job.purpose }),
            ));
        }
        if !matches!(job.status, StagingStatus::Staged) {
            return Err(BackendError::validation(
                "local library asset is not ready",
                json!({ "stagingJobId": staging_job_id, "status": job.status.as_str() }),
            ));
        }
        if job.media_type != expected_media_type {
            return Err(BackendError::validation(
                "local library asset media type does not match the reference",
                json!({
                    "stagingJobId": staging_job_id,
                    "expected": expected_media_type,
                    "actual": job.media_type
                }),
            ));
        }
        let object_key = job.object_key.as_deref().ok_or_else(|| {
            BackendError::protocol(
                "local library asset has no object key",
                json!({ "stagingJobId": staging_job_id }),
            )
        })?;
        self.material_object_lease(&job, object_key)
    }

    /// A synced object may not have a local source file or content hash. Its
    /// existing object is already the desired copy when the bucket matches.
    pub async fn local_asset_is_in_current_bucket(
        &self,
        staging_job_id: &str,
    ) -> BackendResult<bool> {
        let job = self.storage.get_staging_job(staging_job_id)?;
        let Some(current) = self.storage.get_tos_config()? else {
            return Ok(false);
        };
        let saved = self.storage.get_staging_object_target(staging_job_id)?;
        let same_bucket = local_asset_matches_current_scope(saved.as_ref(), &job, &current);
        if !same_bucket {
            return Ok(false);
        }
        if !self.staging_content_exists(&job).await? {
            return Err(BackendError::NotFound(format!(
                "object-storage material {} is no longer available",
                staging_job_id
            )));
        }
        Ok(true)
    }

    fn material_object_lease(
        &self,
        job: &StagingJobRecord,
        object_key: &str,
    ) -> BackendResult<StagingLease> {
        let current = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation("TOS staging is not configured", json!({ "jobId": job.id }))
        })?;
        if !current.enabled {
            return Err(BackendError::validation(
                "TOS staging is not enabled",
                json!({ "jobId": job.id }),
            ));
        }
        if let Some(config) = self.storage.get_staging_object_target(&job.id)? {
            let chosen = if same_object_scope(&config, &current) {
                &current
            } else {
                &config
            };
            return self.presign_existing_object_with_config(&job.id, object_key, chosen);
        }
        self.presign_existing_object_with_config(&job.id, object_key, &current)
    }

    /// 为一幅已入库的本地素材重新签发读取地址（画布节点预览续签）。
    ///
    /// 本地素材的预览地址是短期预签名 URL，画布文档把它持久化后必然过期；
    /// 生成链路由 `local_asset_lease` 每次重签，前端预览过去没有对应入口，
    /// 因此这里按素材身份返回同一份租约里的只读地址。
    pub fn refresh_local_asset_media(
        &self,
        command: RefreshLocalAssetMediaCommand,
    ) -> BackendResult<String> {
        let staging_job_id = command.staging_job_id.trim();
        if staging_job_id.is_empty() {
            return Err(BackendError::validation(
                "local asset refresh requires a staging job id",
                json!({ "stagingJobId": command.staging_job_id }),
            ));
        }
        let lease = self.local_asset_lease(staging_job_id, command.media_type)?;
        remember_asset_preview_url(staging_job_id, Some(&lease.get_url));
        Ok(lease.get_url)
    }

    /// 为一个已过期的暂存对象读取地址重新签名（素材预览续签的最终兜底）。
    ///
    /// 只接受指向已配置暂存桶、且对象键落在配置前缀内的地址：签名等于授予读取权限，
    /// 凭一个 URL 就能重签任意桶内对象会把续签接口变成越权读取入口。
    pub fn refresh_staging_object_url(
        &self,
        command: RefreshStagingObjectCommand,
    ) -> BackendResult<String> {
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({}),
            ));
        }
        let object_key = staging_object_key(&command.url, &config).ok_or_else(|| {
            // 不回显地址本身：带签名的 URL 等同凭据。
            BackendError::validation(
                "只支持续签当前暂存桶内的对象地址。",
                json!({ "bucket": config.bucket, "endpoint": config.endpoint }),
            )
        })?;
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;
        let host = format!("{}.{}", config.bucket, config.endpoint);
        presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now: Utc::now(),
        })
    }

    /// 拉取整个存储桶（或指定前缀）下的对象文件到本地素材索引。
    ///
    /// 依据火山引擎官方文档《ListObjectsV2》：
    /// https://www.volcengine.com/docs/6349/357812
    /// 通过预签名 GET `/?list-type=2` 分页列举（max-keys=1000，continuation-token 翻页），
    /// 对图片/视频/音频扩展名的对象写入本地索引（staging job：purpose=local_asset、
    /// status=staged），媒体正文不下载，预览仍按需签发对象存储预签名 URL；
    /// 对象键已存在本地索引的自动跳过。
    pub async fn pull_bucket_assets(
        &self,
        prefix: Option<&str>,
    ) -> BackendResult<TosBucketPullSummary> {
        let started_at = std::time::Instant::now();
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({}),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;
        let prefix = prefix.map(str::trim).unwrap_or_default();
        info!(
            "[staging] 开始拉取存储桶素材: bucket={}, prefix={:?}（空表示整个桶）",
            config.bucket, prefix
        );

        let objects = self
            .list_bucket_objects(&config, &credentials, prefix)
            .await?;

        let mut total_files: u64 = 0;
        let mut imported: u64 = 0;
        let mut skipped_existing: u64 = 0;
        let mut ignored_unsupported: u64 = 0;
        for object in &objects {
            // TOS 控制台创建的文件夹占位对象（键以 `/` 结尾），不是素材文件。
            if object.key.ends_with('/') {
                continue;
            }
            total_files += 1;
            let Some(media_type) = detect_media_type_by_extension(&object.key) else {
                ignored_unsupported += 1;
                continue;
            };
            if should_skip_bucket_object_in_config(&self.storage, &object.key, &config)? {
                skipped_existing += 1;
                continue;
            }
            let timestamp = now_ms();
            let name = object
                .key
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(&object.key)
                .to_string();
            let job = StagingJobRecord {
                id: Uuid::new_v4().to_string(),
                local_path: name,
                purpose: "local_asset".into(),
                media_type,
                object_key: Some(object.key.clone()),
                status: StagingStatus::Staged,
                bytes_total: Some(object.size),
                bytes_uploaded: object.size,
                asset_id: None,
                overseas_db_id: None,
                import_target: None,
                adjustment: None,
                error: None,
                created_at: timestamp,
                updated_at: timestamp,
            };
            self.storage.insert_staging_job(&job)?;
            self.storage
                .remember_staging_object_target(&job.id, &config)?;
            imported += 1;
            info!(
                "[staging] 存储桶对象已写入本地索引: objectKey={}, size={} 字节, mediaType={}",
                object.key,
                object.size,
                media_type.as_str()
            );
        }

        let summary = TosBucketPullSummary {
            total_objects: total_files,
            imported,
            skipped_existing,
            ignored_unsupported,
            prefix: prefix.to_string(),
        };
        info!(
            "[staging] 存储桶素材拉取完成: 总对象 {}, 新导入 {}, 已存在跳过 {}, 非媒体忽略 {}, 耗时 {}ms",
            summary.total_objects,
            summary.imported,
            summary.skipped_existing,
            summary.ignored_unsupported,
            started_at.elapsed().as_millis()
        );
        Ok(summary)
    }

    /// ListObjectsV2 分页列举桶内全部对象（官方文档：https://www.volcengine.com/docs/6349/357812）。
    ///
    /// 每页独立预签名（有效期覆盖一次请求即可，翻页参数参与签名）；
    /// 代理 fake-ip 环境下通过备用 DNS 直连真实 IP。响应按官方文档为 JSON 形态
    /// （`IsTruncated` / `NextContinuationToken` / `Contents`）。
    async fn list_bucket_objects(
        &self,
        config: &TosStagingConfig,
        credentials: &TosCredentials,
        prefix: &str,
    ) -> BackendResult<Vec<TosObjectSummary>> {
        let host = format!("{}.{}", config.bucket, config.endpoint);
        let mut continuation_token: Option<String> = None;
        let mut objects: Vec<TosObjectSummary> = Vec::new();
        for page in 1..=LIST_BUCKET_MAX_PAGES {
            let mut extra_query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("max-keys".to_string(), "1000".to_string()),
            ];
            if !prefix.is_empty() {
                extra_query.push(("prefix".to_string(), prefix.to_string()));
            }
            if let Some(token) = continuation_token.as_deref() {
                extra_query.push(("continuation-token".to_string(), token.to_string()));
            }
            let url = presign_url_with_query(
                &PresignParams {
                    method: "GET",
                    host: &host,
                    object_key: "",
                    region: &config.region,
                    credentials,
                    expires_secs: LEASE_URL_EXPIRY_SECS,
                    now: Utc::now(),
                },
                &extra_query,
            )?;
            let client = fake_ip_aware_client(&url, self.client.clone()).await;
            let page_started_at = std::time::Instant::now();
            let response = client.get(&url).send().await?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(BackendError::protocol(
                    format!("TOS ListObjectsV2 returned HTTP {status}"),
                    json!({
                        "httpStatus": status.as_u16(),
                        "bucket": config.bucket,
                        "page": page,
                        "body": truncate_connectivity_detail(&redact_url_string(&body)),
                    }),
                ));
            }
            let body = response.bytes().await?;
            let parsed: ListObjectsV2ResponseBody =
                serde_json::from_slice(&body).map_err(|error| {
                    BackendError::protocol(
                        "TOS ListObjectsV2 response does not match the documented JSON shape",
                        json!({
                            "source": error.to_string(),
                            "page": page,
                            "body": truncate_connectivity_detail(&redact_url_string(
                                &String::from_utf8_lossy(&body),
                            )),
                        }),
                    )
                })?;
            let returned = parsed.contents.len();
            objects.extend(parsed.contents.into_iter().map(|content| TosObjectSummary {
                key: content.key,
                size: content.size,
            }));
            info!(
                "[staging] ListObjectsV2 分页列举成功: page={page}, 返回 {returned} 个对象, 累计 {}, truncated={}, 耗时 {}ms",
                objects.len(),
                parsed.is_truncated,
                page_started_at.elapsed().as_millis()
            );
            if parsed.is_truncated {
                match parsed
                    .next_continuation_token
                    .filter(|token| !token.is_empty())
                {
                    Some(token) => continuation_token = Some(token),
                    None => {
                        return Err(BackendError::protocol(
                            "TOS ListObjectsV2 is truncated but returned no NextContinuationToken",
                            json!({ "page": page }),
                        ));
                    }
                }
            } else {
                return Ok(objects);
            }
        }
        Err(BackendError::protocol(
            "bucket listing exceeded the maximum number of pages",
            json!({
                "maxPages": LIST_BUCKET_MAX_PAGES,
                "pageLimitObjects": LIST_BUCKET_MAX_PAGES as u64 * 1000
            }),
        ))
    }

    pub async fn run_job(&self, job_id: &str) -> BackendResult<StagingJobRecord> {
        self.reserve_job(job_id).await?;
        let result = self.run_job_reserved(job_id).await;
        self.active_jobs.lock().await.remove(job_id);
        result
    }

    async fn run_job_reserved(&self, job_id: &str) -> BackendResult<StagingJobRecord> {
        let mut job = self.storage.get_staging_job(job_id)?;

        match self.run_job_inner(&mut job).await {
            Ok(()) => Ok(job),
            Err(error) => {
                // 一旦海外平台确认收件并发回 db_id，本机超时、网络故障及上游
                // Active + task 占位符都只表示结果未知。保留同一任务供续查，绝不重传。
                job.overseas_db_id = self.storage.get_staging_job(job_id)?.overseas_db_id;
                let timed_out = is_overseas_timeout_error(&error);
                job.status = if job.overseas_db_id.is_some() && !is_overseas_terminal_error(&error)
                {
                    StagingStatus::Importing
                } else {
                    StagingStatus::Failed
                };
                let mut record = if timed_out {
                    json!({
                        "kind": "asset_import_timeout",
                        "message": "上传超时，已清理本地待处理素材",
                        "details": {
                            "terminalStatus": "TimedOut",
                            "dbId": job.overseas_db_id,
                        }
                    })
                } else {
                    error.runtime_record()
                };
                if job.overseas_db_id.is_some() && matches!(job.status, StagingStatus::Importing) {
                    record["tokenScopeHint"] = json!(
                        "继续查询时须使用原上传的素材库连接和令牌；切换令牌可能查不到这条 db_id 记录"
                    );
                }
                if timed_out && job.overseas_db_id.is_some() {
                    let persisted = self.storage.get_staging_job(job_id)?;
                    if !matches!(persisted.status, StagingStatus::Cleaned) {
                        if let Some(object_key) = persisted.object_key.as_deref() {
                            let current_config = self.storage.get_tos_config().ok().flatten();
                            if let Some(config) = current_config
                                .as_ref()
                                .filter(|config| staging_object_matches_scope(object_key, config))
                            {
                                match self
                                    .presign_existing_object_with_config(job_id, object_key, config)
                                {
                                    Ok(lease) => {
                                        if let Err(cleanup_error) = self.cleanup_lease(&lease).await
                                        {
                                            warn!(
                                                "[staging] 超时后清理 TOS 暂存对象失败: jobId={job_id}, 错误: {cleanup_error}"
                                            );
                                        } else {
                                            job.object_key = None;
                                        }
                                    }
                                    Err(cleanup_error) => warn!(
                                        "[staging] 超时后无法重签 TOS 删除地址: jobId={job_id}, 错误: {cleanup_error}"
                                    ),
                                }
                            } else {
                                warn!(
                                    "[staging] 超时后暂存对象不在当前配置前缀内，跳过删除: jobId={job_id}"
                                );
                            }
                        }
                    } else {
                        job.object_key = None;
                    }
                }
                job.error = Some(record);
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                if matches!(job.status, StagingStatus::Importing) {
                    Ok(job)
                } else {
                    Err(error)
                }
            }
        }
    }

    /// 仅按原上传回执中的 db_id 续查；命令调用方不得重新提交文件。
    pub async fn resume_import_job(&self, job_id: &str) -> BackendResult<StagingJobRecord> {
        let job = self.storage.get_staging_job(job_id)?;
        if job.purpose != "asset_import"
            || job.overseas_db_id.is_none()
            || job.import_target.is_none()
            || job.asset_id.is_some()
            || matches!(job.status, StagingStatus::Failed)
        {
            return Err(BackendError::validation(
                "staging job has no unresolved overseas upload to query",
                json!({ "jobId": job_id }),
            ));
        }
        self.run_job(job_id).await
    }

    async fn reserve_job(&self, job_id: &str) -> BackendResult<()> {
        if !self.active_jobs.lock().await.insert(job_id.to_string()) {
            return Err(BackendError::Conflict(format!(
                "staging job {job_id} is already running"
            )));
        }
        Ok(())
    }

    pub(super) fn generation_input_enabled(&self) -> BackendResult<bool> {
        Ok(self
            .storage
            .get_tos_config()?
            .is_some_and(|config| config.enabled))
    }

    pub async fn stage_for_remote_input(
        &self,
        local_path: &str,
        media_type: MediaType,
    ) -> BackendResult<StagingLease> {
        let job = self.create_job(StartStagingCommand {
            local_path: local_path.to_string(),
            purpose: "generation_input".into(),
            media_type,
            import: None,
        })?;
        let mut persisted = self.storage.get_staging_job(&job.id)?;
        let lease = match self.upload(&mut persisted).await {
            Ok(lease) => lease,
            Err(error) => {
                persisted.status = StagingStatus::Failed;
                persisted.error = Some(error.runtime_record());
                persisted.updated_at = now_ms();
                self.storage.update_staging_job(&persisted)?;
                return Err(error);
            }
        };
        /*
         * 先登记「在用」再落 `in_use` 状态，顺序不能反：
         * 行一旦变成 `in_use` 就是回收器的候选，而回收器判断「有没有人用」靠的
         * 就是这张表。反过来登记的话，落盘与登记之间有一个窗口，回收器正好
         * 扫到就会把供应商正要用的对象删掉。
         */
        self.live_leases.lock().await.insert(persisted.id.clone());
        persisted.status = StagingStatus::InUse;
        persisted.updated_at = now_ms();
        if let Err(error) = self.storage.update_staging_job(&persisted) {
            /*
             * 对象已经传上去了、只是**状态落盘**失败。
             *
             * 之前这里直接 `?` 返回：lease 被丢弃 → TOS 上的对象无人回收，
             * 而启动恢复只把 `uploading` 改写成 `Interrupted`（该状态全仓只写不读），
             * 于是这个对象**永久残留**在对象存储里（每次泄漏一整个素材）。
             *
             * 这里 best-effort 地回收一次：清理本身失败只记日志，不掩盖原始错误。
             */
            warn!(
                "[staging] 暂存对象已上传但状态落盘失败，回收对象避免泄漏: jobId={}, error={}",
                persisted.id, error
            );
            self.live_leases.lock().await.remove(&persisted.id);
            if let Err(cleanup_error) = self.cleanup_lease(&lease).await {
                /*
                 * 清理也没成功 → `cleanup_lease` 已把行落成 `failed`（两条失败口径统一），
                 * 对象还在桶里，回收器会接手重试。
                 */
                warn!(
                    "[staging] 暂存对象回收失败（对象可能残留）: jobId={}, error={}",
                    persisted.id, cleanup_error
                );
            }
            return Err(error);
        }
        Ok(lease)
    }

    pub async fn cleanup_lease(&self, lease: &StagingLease) -> BackendResult<()> {
        let mut job = self.storage.get_staging_job(&lease.job_id)?;
        job.status = StagingStatus::Cleaning;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        if let Some(delete_url) = &lease.delete_url {
            /*
             * 删除失败有两条路径：**传输层**失败（超时/断网/代理抖动）与 **HTTP 非 2xx**。
             * 之前只有传输层那条写 `Failed`，HTTP 那条只写 error、状态留在 `Cleaning`，
             * 而 `Cleaning` 在启动恢复里会被改写成 `Failed` → 删除从此不再重试。
             * 两条口径统一成 `Failed`：行落成失败态并保留对象键，
             * 启动回收器就能接管重试（对象还在桶里，总得有人删）。
             */
            if let Err(error) = self.delete_staging_object(delete_url).await {
                job.error = Some(error.runtime_record());
                job.status = StagingStatus::Failed;
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                self.live_leases.lock().await.remove(&lease.job_id);
                return Err(error);
            }
        }
        job.status = StagingStatus::Cleaned;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        // 租约到此结束：对象要么已删，要么已是垃圾，回收器可以接管了。
        self.live_leases.lock().await.remove(&lease.job_id);
        Ok(())
    }

    /// 删除 TOS 暂存对象：2xx 与「对象不存在」都算删除完成。
    ///
    /// 404（NoSuchKey）必须当成功，两种场景都靠它收口：
    /// - 回收器可能已经删过一次（进程正好死在「已删除」与「已落库」之间）；
    /// - 对象键在上传之前就写进了行里，上传根本没成功过，桶里从来没有这个对象。
    /// 把它当失败会让这两类行永远清不掉。
    async fn delete_staging_object(&self, delete_url: &str) -> BackendResult<()> {
        let response = match self.client.delete(delete_url).send().await {
            Ok(response) => response,
            Err(error) => return Err(BackendError::Transport(error)),
        };
        let status = response.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        Err(BackendError::protocol(
            format!("TOS cleanup returned HTTP {status}"),
            redact_request_value(&json!({ "httpStatus": status.as_u16(), "rawResponse": raw })),
        ))
    }

    /// 暂存对象回收循环：后台常驻，按退避回收没人认领的中转对象。
    ///
    /// 纯后台动作：任何一步失败都只记日志，不影响应用启动，也不影响其它功能。
    pub async fn run_staging_cleanup_loop(&self) {
        /*
         * `recover()` 既被启动流程调用、也能被手动命令再次触发；用一次性标记
         * 保证同一个进程里只有一个回收循环在跑，避免两轮同时抢同一批行。
         */
        if self.cleanup_loop_started.swap(true, Ordering::SeqCst) {
            return;
        }
        loop {
            if let Err(error) = self.reap_leaked_objects().await {
                warn!("[staging] 暂存对象回收轮次失败: {error}");
            }
            tokio::time::sleep(Duration::from_millis(CLEANUP_POLL_INTERVAL_MS)).await;
        }
    }

    /// 回收一轮没人认领的 TOS 中转对象。
    ///
    /// 处理三条死路（这三种状态此前全都没有任何代码会删对象）：
    /// - `interrupted`：启动恢复把「国内导入中 / 校验中 / 授权中 / 上传中」统统改写成它，
    ///   而恢复逻辑只把它映射回自己 → 全仓只写不读，对象永远留在桶里；
    /// - `in_use`：上传成功、租约已经发出去的中转对象。进程在生成过程中被杀时行会停在这里，
    ///   而它连启动恢复的白名单都进不去 → 每个崩溃的生成过程都泄漏一个对象；
    /// - `failed`：运行失败或删除失败（HTTP 非 2xx）的行，同样没有删除路径。
    ///
    /// 幂等：删除成功（或对象本就不存在）后标记该行已回收，不再被捞出来；
    /// 进程死在「已删除」与「已落库」之间时，下一轮会重发 DELETE，
    /// 对象存储回 404 被当作「已经删掉了」，结果一致。
    pub async fn reap_leaked_objects(&self) -> BackendResult<StagingCleanupSummary> {
        let candidates = self
            .storage
            .list_staging_cleanup_candidates(CLEANUP_MAX_RETRY_COUNT, CLEANUP_MAX_ROWS_PER_PASS)?;
        let mut summary = StagingCleanupSummary::default();
        for candidate in candidates {
            /*
             * 本进程里还活着的东西不能删：正在导入的任务、已经发出去的租约，
             * 供应商随时可能正在取这个对象的字节。
             */
            if self.is_job_live(&candidate.id).await {
                summary.skipped_live += 1;
                continue;
            }
            if self.object_still_owned_by_others(&candidate).await? {
                summary.skipped_owned += 1;
                continue;
            }
            match self.delete_leaked_object(&candidate).await {
                Ok(()) => {
                    self.storage.mark_staging_object_deleted(&candidate.id)?;
                    summary.deleted += 1;
                    info!(
                        "[staging] 已回收无人认领的暂存对象: jobId={}, purpose={}, status={}",
                        candidate.id,
                        candidate.purpose,
                        candidate.status.as_str()
                    );
                }
                Err(error) => {
                    let retry_count = candidate.cleanup_retry_count + 1;
                    let terminal = retry_count >= CLEANUP_MAX_RETRY_COUNT;
                    let next_at =
                        (!terminal).then(|| now_ms() + cleanup_retry_delay_ms(retry_count));
                    self.storage.record_staging_cleanup_failure(
                        &candidate.id,
                        retry_count,
                        next_at,
                    )?;
                    if terminal {
                        summary.abandoned += 1;
                        error!(
                            "[staging] 暂存对象回收重试已达上限，停止重试（对象可能仍留在桶里，需要手动删除）: jobId={}, objectKey={}, 错误: {error}",
                            candidate.id, candidate.object_key
                        );
                    } else {
                        summary.failed += 1;
                        warn!(
                            "[staging] 暂存对象回收失败，将按退避重试: jobId={}, objectKey={}, 第 {retry_count} 次, 错误: {error}",
                            candidate.id, candidate.object_key
                        );
                    }
                }
            }
        }
        Ok(summary)
    }

    /// 这个任务在本进程里是否还活着（正在跑，或中转租约已经发出还没回收）。
    async fn is_job_live(&self, job_id: &str) -> bool {
        if self.active_jobs.lock().await.contains(job_id) {
            return true;
        }
        self.live_leases.lock().await.contains(job_id)
    }

    /// 同一个对象键是否还被别的**活着**的任务持有。
    ///
    /// 内容去重会让两个任务共用一个对象键（复用方 `complete_reused_staging_job`
    /// 会抄走原任务的对象键）。原任务若已经死在死路状态上，而复用方还活着
    /// （`staged` / `active`：对象是它的长期素材或云端素材的来源），
    /// 这时删对象等于毁掉别人的素材，因此必须跳过。
    async fn object_still_owned_by_others(
        &self,
        candidate: &StagingCleanupCandidate,
    ) -> BackendResult<bool> {
        for job in self
            .storage
            .list_staging_jobs_by_object_key(&candidate.object_key)?
        {
            if job.id == candidate.id {
                continue;
            }
            if matches!(
                job.status,
                StagingStatus::Staged | StagingStatus::Active | StagingStatus::Importing
            ) {
                warn!(
                    "[staging] 暂存对象仍被其它任务持有，跳过回收: objectKey={}, 持有方 jobId={}, status={}",
                    candidate.object_key,
                    job.id,
                    job.status.as_str()
                );
                // 终态化：这一行永远等不到「没人持有」的时刻，别再每轮重复捞它。
                self.storage.record_staging_cleanup_failure(
                    &candidate.id,
                    CLEANUP_MAX_RETRY_COUNT,
                    None,
                )?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 删除单个中转对象：重签 DELETE 地址 → 发起删除 → 成功/已不存在都算删掉了。
    async fn delete_leaked_object(&self, candidate: &StagingCleanupCandidate) -> BackendResult<()> {
        let saved = self.storage.get_staging_object_target(&candidate.id)?;
        let config = self.resolve_cleanup_config(&candidate.id, saved.as_ref())?;
        /*
         * 归属校验用「对象键里带当前桶的 scope 哈希」，不用 `staging_object_matches_scope`：
         * 后者还要求对象前缀一致，而用户改了对象前缀之后旧对象仍然属于本应用
         * （同一个桶、同一个 scope 哈希），只是不再落在新前缀下 —— 用前缀校验
         * 会把这些残留对象永远排除在回收之外。
         *
         * 校验用的是**上传时冻结的那份**配置（它才是生成这个对象键时用的那份，
         * 端点大小写之类的细节完全一致）；没有快照时才退回当前配置。
         */
        let ownership_config = saved.as_ref().unwrap_or(&config);
        if !staging_object_belongs_to_scope(&candidate.object_key, ownership_config) {
            return Err(BackendError::validation(
                "staging object does not belong to the resolved TOS bucket",
                json!({ "jobId": candidate.id, "objectKey": candidate.object_key }),
            ));
        }
        let lease = self.presign_existing_object_with_config(
            &candidate.id,
            &candidate.object_key,
            &config,
        )?;
        let delete_url = lease.delete_url.ok_or_else(|| {
            BackendError::protocol(
                "staging cleanup lease has no delete url",
                json!({ "jobId": candidate.id }),
            )
        })?;
        self.delete_staging_object(&delete_url).await
    }

    /// 解析回收该对象应当使用的桶配置。
    ///
    /// 优先用「上传时冻结的桶坐标」：用户换了桶之后旧对象仍在旧桶里，
    /// 按当前配置去删会打到新桶，既删不到旧对象还可能误删新桶里的同名键。
    /// 同桶时改用当前配置 —— 用户可能把 AK/SK 换了个凭据引用名，旧引用已失效。
    /// 凭据本身不存进配置（只存引用名），所以换密钥后旧引用照样取得到新密钥。
    fn resolve_cleanup_config(
        &self,
        job_id: &str,
        saved: Option<&TosStagingConfig>,
    ) -> BackendResult<TosStagingConfig> {
        let current = self.storage.get_tos_config()?;
        let config = match (saved, current) {
            (Some(saved), Some(current))
                if same_object_scope(saved, &current) && current.enabled =>
            {
                current
            }
            (Some(saved), _) => saved.clone(),
            (None, Some(current)) => current,
            (None, None) => {
                return Err(BackendError::validation(
                    "TOS staging is not configured",
                    json!({ "jobId": job_id }),
                ));
            }
        };
        Ok(config)
    }

    async fn run_job_inner(&self, job: &mut StagingJobRecord) -> BackendResult<()> {
        if job.overseas_db_id.is_some() {
            return self.run_job_inner_unindexed(job).await;
        }
        let target_config = if job.purpose == "local_asset" && job.import_target.is_none() {
            self.storage
                .get_staging_object_target(&job.id)?
                .or(self.storage.get_tos_config()?)
        } else {
            None
        };
        if job.purpose == "local_asset" && job.import_target.is_none() {
            if let Some(config) = target_config.as_ref() {
                // Also freeze legacy/recovered jobs that predate target snapshots.
                self.storage
                    .remember_staging_object_target(&job.id, config)?;
            }
        }
        let scope = match job.purpose.as_str() {
            "local_asset" | "asset_import" => {
                Some(staging_content_scope(job, target_config.as_ref(), &self.assets)?)
            }
            _ => None,
        };
        let Some(scope) = scope else {
            return self.run_job_inner_unindexed(job).await;
        };
        let (sha256, byte_size) = sha256_file(Path::new(&job.local_path)).await?;
        let gate_key = format!("{scope}:{byte_size}:{sha256}");
        let gate = gate_for_content(&self.content_gates, &gate_key).await;
        let _guard = gate.lock().await;
        if self
            .storage
            .find_staging_content(&scope, job.media_type, byte_size, &sha256)?
            .is_none()
        {
            self.backfill_legacy_staging_content(
                &scope,
                job.media_type,
                byte_size,
                &sha256,
                target_config.as_ref(),
            )
            .await?;
        }
        if let Some(existing) =
            self.storage
                .find_staging_content(&scope, job.media_type, byte_size, &sha256)?
        {
            if self.staging_content_exists(&existing).await? {
                job.object_key = existing.object_key.clone();
                job.bytes_total = existing.bytes_total;
                job.bytes_uploaded = existing.bytes_uploaded;
                job.asset_id = if job.import_target.is_some() {
                    existing.asset_id.clone()
                } else {
                    Some(existing.id.clone())
                };
                job.status = if job.import_target.is_some() {
                    StagingStatus::Active
                } else {
                    StagingStatus::Staged
                };
                job.updated_at = now_ms();
                self.storage
                    .complete_reused_staging_job(job, &existing.id)?;
                if job.import_target.is_none() {
                    if let Some(config) = target_config.as_ref() {
                        self.storage
                            .remember_staging_object_target(&job.id, config)?;
                    }
                }
                return Ok(());
            }
            self.storage
                .forget_staging_content(&scope, job.media_type, byte_size, &sha256)?;
        }
        self.run_job_inner_unindexed(job).await?;
        // The source could have changed during the network operation. Never
        // claim a hash for bytes that may differ from the uploaded body.
        match sha256_file(Path::new(&job.local_path)).await {
            Ok((after_hash, after_size)) if after_hash == sha256 && after_size == byte_size => {
                if let Err(error) = self.storage.remember_staging_content(
                    &scope,
                    job.media_type,
                    byte_size,
                    &sha256,
                    &job.id,
                ) {
                    warn!(
                        "[staging] 已上传素材但去重索引写入失败: jobId={}, error={error}",
                        job.id
                    );
                }
            }
            _ => warn!(
                "[staging] 上传期间源文件变化，未记录去重索引: jobId={}",
                job.id
            ),
        }
        Ok(())
    }

    async fn backfill_legacy_staging_content(
        &self,
        scope: &str,
        media_type: MediaType,
        byte_size: u64,
        sought_sha256: &str,
        target_config: Option<&TosStagingConfig>,
    ) -> BackendResult<()> {
        let config = target_config;
        for candidate in self
            .storage
            .list_unindexed_completed_staging_jobs(media_type)?
        {
            if candidate.import_target.is_none() && config.is_none() {
                continue;
            }
            if staging_content_scope(&candidate, config, &self.assets)? != scope {
                continue;
            }
            if candidate.import_target.is_none() {
                let Some(config) = config else {
                    continue;
                };
                let saved = self.storage.get_staging_object_target(&candidate.id)?;
                if !local_asset_matches_current_scope(saved.as_ref(), &candidate, config) {
                    continue;
                }
            }
            let path = Path::new(&candidate.local_path);
            if !path.is_absolute() {
                continue;
            }
            let Ok(metadata) = tokio::fs::metadata(path).await else {
                continue;
            };
            if !metadata.is_file() || metadata.len() != byte_size {
                continue;
            }
            // A file edited after the old upload is not proof of the remote
            // body's content; avoid mapping its new bytes to that old asset.
            let uploaded_at =
                UNIX_EPOCH + Duration::from_millis(candidate.created_at.max(0) as u64);
            if metadata
                .modified()
                .is_ok_and(|modified| modified > uploaded_at)
            {
                continue;
            }
            let Ok((candidate_hash, candidate_size)) = sha256_file(path).await else {
                continue;
            };
            if candidate_size != byte_size {
                continue;
            }
            if candidate_hash == sought_sha256 {
                if self.staging_content_exists(&candidate).await? {
                    self.storage.remember_staging_content(
                        scope,
                        media_type,
                        byte_size,
                        &candidate_hash,
                        &candidate.id,
                    )?;
                    break;
                }
            } else {
                // Index unchanged legacy files as we encounter their size,
                // avoiding repeated hashing on subsequent imports.
                self.storage.remember_staging_content(
                    scope,
                    media_type,
                    byte_size,
                    &candidate_hash,
                    &candidate.id,
                )?;
            }
        }
        Ok(())
    }

    async fn staging_content_exists(&self, job: &StagingJobRecord) -> BackendResult<bool> {
        if let Some(target) = job.import_target.as_ref() {
            let Some(asset_id) = job.asset_id.as_ref() else {
                return Ok(false);
            };
            // 旧版导入曾把平台审核任务号误存为素材 ID。它只能用于查询审核状态，
            // 绝不能证明已有可复用素材，否则同一文件再次上传会复用这条死记录。
            if super::asset_library::is_review_task_id(asset_id) {
                return Ok(false);
            }
            let observed = self
                .assets
                .observe_asset_status(ObserveAssetStatusCommand {
                    provider_connection_id: target.provider_connection_id.clone(),
                    id: asset_id.clone(),
                })
                .await?;
            if observed.missing
                || matches!(
                    observed.status,
                    CloudAssetStatus::Failed | CloudAssetStatus::Deleted
                )
            {
                return Ok(false);
            }
            if observed.status != CloudAssetStatus::Ready {
                return Err(BackendError::Conflict(
                    "existing cloud material is still processing; retry later".into(),
                ));
            }
            return Ok(true);
        }
        let Some(object_key) = job.object_key.as_deref() else {
            return Ok(false);
        };
        let saved = self.storage.get_staging_object_target(&job.id)?;
        let current = self.storage.get_tos_config()?;
        let config = match (saved, current) {
            (Some(saved), Some(current)) if same_object_scope(&saved, &current) => current,
            (Some(saved), _) => saved,
            (None, Some(current)) => current,
            (None, None) => {
                return Err(BackendError::validation(
                    "TOS staging is not configured",
                    json!({}),
                ));
            }
        };
        let lease = self.presign_existing_object_with_config(&job.id, object_key, &config)?;
        let client = fake_ip_aware_client(&lease.get_url, self.client.clone()).await;
        let response = client
            .get(&lease.get_url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(BackendError::protocol(
                "could not verify existing object-storage material",
                json!({ "httpStatus": response.status().as_u16() }),
            ));
        }
        Ok(true)
    }

    async fn run_job_inner_unindexed(&self, job: &mut StagingJobRecord) -> BackendResult<()> {
        if let Some(db_id) = job.overseas_db_id {
            let import_target = job.import_target.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "overseas upload is missing its provider connection",
                    json!({ "jobId": job.id, "dbId": db_id }),
                )
            })?;
            let submitted_at = self
                .storage
                .get_staging_overseas_submitted_at(&job.id)?
                .ok_or_else(|| {
                    BackendError::protocol(
                        "overseas upload has no persisted submission time",
                        json!({ "dbId": db_id }),
                    )
                })?;
            let remaining_ms = remaining_overseas_wait_ms(submitted_at, now_ms());
            if remaining_ms <= 0 {
                return Err(overseas_timeout_error(db_id));
            }
            job.status = StagingStatus::Importing;
            job.updated_at = now_ms();
            self.storage.update_staging_job(job)?;
            let identity = tokio::time::timeout(
                std::time::Duration::from_millis(remaining_ms as u64),
                self.assets.resume_overseas_import_by_db_id(
                    &import_target.provider_connection_id,
                    db_id,
                    import_target.name.as_deref(),
                ),
            )
            .await
            .map_err(|_| overseas_timeout_error(db_id))??;
            job.asset_id = Some(identity.asset_id);
            job.status = StagingStatus::Active;
            job.error = None;
            job.updated_at = now_ms();
            self.storage.update_staging_job(job)?;
            return Ok(());
        }
        let lease = self.upload(job).await?;
        let Some(import_target) = job.import_target.clone() else {
            job.status = StagingStatus::Staged;
            job.updated_at = now_ms();
            self.storage.update_staging_job(job)?;
            return Ok(());
        };

        // 进入素材库导入阶段：先落 importing 状态，让前端在对象存储上传完成后立即
        // 切换展示"上传素材库"进度。导入字节进度通过回调写入 bytes_uploaded/bytes_total
        // （海外路径：总工作量 = 2 × 文件大小；国内路径不触发回调，保持对象存储阶段字节）。
        job.status = StagingStatus::Importing;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        let import_progress = {
            let storage = Arc::clone(&self.storage);
            let job_id = job.id.clone();
            move |done: u64, total: u64| {
                let _ = storage.update_staging_import_progress(&job_id, done, total);
            }
        };
        let on_submitted = {
            let storage = Arc::clone(&self.storage);
            let job_id = job.id.clone();
            move |db_id: u64| storage.set_staging_overseas_db_id(&job_id, db_id)
        };
        let imported = self
            .assets
            .import_staged_with_progress_and_submission(
                ImportStagedAsset {
                    provider_connection_id: import_target.provider_connection_id.clone(),
                    public_url: lease.get_url.clone(),
                    media_type: job.media_type,
                    display_name: import_target.name.clone(),
                    // 分组 ID 已是字符串形态（前端选中的素材库分组 / 真人分组数值 ID），
                    // 由方言各自解析/透传；None 表示未指定分组。
                    group_id: import_target
                        .group_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                },
                Some(Arc::new(import_progress)),
                Some(Arc::new(on_submitted)),
            )
            .await;
        let identity = match imported {
            Ok(identity) => identity,
            Err(error) => {
                // 导入失败时尽力清理 TOS 暂存对象，避免残留；清理失败不影响原始错误返回。
                if let Err(cleanup_error) = self.cleanup_lease(&lease).await {
                    let record = cleanup_error.runtime_record();
                    warn!(
                        "[staging] 导入失败后清理暂存对象未成功（已忽略）: jobId={}, 错误: {record}",
                        job.id
                    );
                }
                return Err(error);
            }
        };

        job.asset_id = Some(identity.asset_id);
        job.overseas_db_id = self.storage.get_staging_job(&job.id)?.overseas_db_id;
        job.status = StagingStatus::Active;
        job.error = None;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        if let Err(cleanup_error) = self.cleanup_lease(&lease).await {
            let record = cleanup_error.runtime_record();
            warn!(
                "[staging] 暂存对象清理失败（不影响导入结果）: jobId={}, 错误: {record}",
                job.id
            );
        }
        Ok(())
    }

    async fn upload(&self, job: &mut StagingJobRecord) -> BackendResult<StagingLease> {
        let config = if job.purpose == "local_asset" && job.import_target.is_none() {
            self.storage
                .get_staging_object_target(&job.id)?
                .or(self.storage.get_tos_config()?)
        } else {
            self.storage.get_tos_config()?
        }
        .ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({ "jobId": job.id }),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;
        if job.purpose == "local_asset" && job.import_target.is_none() {
            self.storage
                .remember_staging_object_target(&job.id, &config)?;
        }

        let local_path = Path::new(&job.local_path);
        /*
         * 必须是绝对路径：相对路径会按**进程当前工作目录**解析，而工作目录
         * 随启动方式变化（从资源管理器双击、从终端、快捷方式各不相同），
         * 于是同一份配置在不同启动方式下指向不同文件，表现为「偶发地
         * 找不到文件」或更糟——读到了别处的同名文件。
         */
        if !local_path.is_absolute() {
            return Err(BackendError::validation(
                "staging input path must be absolute",
                json!({ "localPath": job.local_path }),
            ));
        }
        let source_metadata = tokio::fs::metadata(local_path).await?;
        if !source_metadata.is_file() {
            return Err(BackendError::validation(
                "staging input must be a readable file",
                json!({ "localPath": job.local_path }),
            ));
        }
        let (mut mime_type, mut extension) = detect_local_media(local_path, job.media_type).await?;
        // 只有目标是云端素材库时才按供应商格式限制转码。TOS-only 上传只保存原件，
        // 保留原始图片字节与对象键扩展名；转码临时文件随本函数退出自动清理。
        let mut upload_path = local_path.to_path_buf();
        let _converted_guard = if needs_asset_import_transcode(job, &extension) {
            let (temp_path, transcode_ext, transcode_mime) =
                transcode_local_media(&self.composer, &job.id, local_path, &extension).await?;
            mime_type = transcode_mime;
            extension = transcode_ext;
            upload_path = temp_path;
            Some(TempFileGuard(Some(upload_path.clone())))
        } else {
            None
        };
        // 云端导入前把越界图片调整进平台边长窗口（本地素材只写对象存储、不经平台预处理，
        // 保持原文件不动）。调整产物同样是临时文件，随本函数退出自动清理。
        let _normalized_guard = if job.media_type == MediaType::Image && job.import_target.is_some()
        {
            normalize_image_for_asset_window(&upload_path, &extension, &job.id).map(|normalized| {
                mime_type = normalized.mime;
                extension = normalized.extension;
                upload_path = normalized.path.clone();
                job.adjustment = Some(normalized.note);
                TempFileGuard(Some(upload_path.clone()))
            })
        } else {
            None
        };
        let metadata = tokio::fs::metadata(&upload_path).await?;
        job.bytes_total = Some(metadata.len());
        job.status = StagingStatus::Authorizing;
        job.object_key = Some(build_object_key(&config, &extension));
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        /*
         * 对象键是每次上传新生成的：旧对象的回收结论不能套到新对象上，
         * 这里把回收记账清零，让新对象重新受回收管辖。
         */
        self.storage.reset_staging_cleanup_state(&job.id)?;

        let object_key = job.object_key.clone().unwrap_or_default();
        let host = format!("{}.{}", config.bucket, config.endpoint);
        let presign_started = std::time::Instant::now();
        info!(
            "[staging] 本地生成 TOS 预签名地址: jobId={}, objectKey={}, 大小 {} 字节, mime={}, bucket={}, region={}, endpoint={}",
            job.id,
            object_key,
            metadata.len(),
            mime_type,
            config.bucket,
            config.region,
            config.endpoint
        );
        let now = Utc::now();
        let put_url = presign_url(&PresignParams {
            method: "PUT",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: PUT_URL_EXPIRY_SECS,
            now,
        })?;
        let get_url = presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        let delete_url = presign_url(&PresignParams {
            method: "DELETE",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        info!(
            "[staging] 预签名地址生成完成: jobId={}, objectKey={}, putUrl={}, getUrl={}, deleteUrl={}, 耗时 {}ms",
            job.id,
            object_key,
            redact_url_string(&put_url),
            redact_url_string(&get_url),
            redact_url_string(&delete_url),
            presign_started.elapsed().as_millis()
        );

        job.status = StagingStatus::Uploading;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        info!(
            "[staging] 开始上传到对象存储: jobId={}, objectKey={}, 大小 {} 字节",
            job.id,
            object_key,
            metadata.len()
        );
        // 解析 endpoint 真实 IP：代理 fake-ip 环境下改用备用 DNS 穿透劫持，
        // 直连真实地址（Host/SNI/预签名保持不变，签名不受影响）。
        let real_ips = resolve_host_real_ips(&self.client, &host).await;
        let upload_client = match build_tos_upload_client(&host, &real_ips) {
            Ok(client) => client,
            Err(error) => {
                return Err(BackendError::validation(
                    "failed to build TOS upload HTTP client",
                    json!({ "source": error.to_string() }),
                ));
            }
        };
        if !real_ips.is_empty() {
            info!(
                "[staging] 检测到代理 fake-ip 环境，改用真实 IP 直连对象存储: jobId={}, host={}, ips={:?}",
                job.id, host, real_ips
            );
        }
        let upload_started = std::time::Instant::now();
        let uploaded = Arc::new(AtomicU64::new(0));
        let last_logged_bytes = Arc::new(AtomicU64::new(0));
        let storage = Arc::clone(&self.storage);
        let job_id = job.id.clone();
        let total_bytes = metadata.len();
        let upload_path_owned = upload_path.clone();
        let put_url_owned = put_url.clone();
        let mime_owned = mime_type.clone();
        // 重试闭包：每次重试重新打开文件、重建流并重置进度，保证从头上传。
        let mut send_once = move |upload_client: reqwest::Client| {
            let progress_counter = Arc::clone(&uploaded);
            let log_counter = Arc::clone(&last_logged_bytes);
            let storage = Arc::clone(&storage);
            let job_id = job_id.clone();
            let upload_path = upload_path_owned.clone();
            let put_url = put_url_owned.clone();
            let mime_type = mime_owned.clone();
            let upload_started = upload_started;
            let total_bytes = total_bytes;
            async move {
                let file = tokio::fs::File::open(&upload_path)
                    .await
                    .map_err(UploadAttemptError::Io)?;
                progress_counter.store(0, Ordering::Relaxed);
                let _ = storage.update_staging_progress(&job_id, 0);
                let stream = ReaderStream::new(file).inspect_ok(move |chunk| {
                    let chunk_len = chunk.len() as u64;
                    let total =
                        progress_counter.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
                    let _ = storage.update_staging_progress(&job_id, total);
                    // 节流记录进度：每累计 1MB 或到达末尾记录一次，用于排查上传卡住。
                    let last = log_counter.load(Ordering::Relaxed);
                    let reached_end = total >= total_bytes;
                    if (total >= last + PROGRESS_LOG_INTERVAL_BYTES || reached_end)
                        && log_counter
                            .compare_exchange(last, total, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok()
                    {
                        let elapsed = upload_started.elapsed();
                        let percent = total
                            .saturating_mul(100)
                            .checked_div(total_bytes)
                            .unwrap_or(100);
                        info!(
                            "[staging] 上传进度更新: jobId={}, {}/{} 字节（{}%）, 已耗时 {}ms, 平均速度 {}/s",
                            job_id,
                            total,
                            total_bytes,
                            percent,
                            elapsed.as_millis(),
                            format_bytes_per_sec(total as usize, elapsed)
                        );
                    }
                });
                upload_client
                    .put(&put_url)
                    .header(reqwest::header::CONTENT_TYPE, &mime_type)
                    .header(reqwest::header::CONTENT_LENGTH, total_bytes)
                    .body(reqwest::Body::wrap_stream(stream))
                    .send()
                    .await
                    .map_err(UploadAttemptError::Http)
            }
        };
        let fallback_client = (!real_ips.is_empty()).then_some(&self.client);
        let response =
            match send_upload_with_retry(&upload_client, fallback_client, &mut send_once).await {
                Ok(response) => response,
                Err(UploadAttemptError::Io(error)) => return Err(BackendError::from(error)),
                Err(UploadAttemptError::Http(error)) => return Err(BackendError::from(error)),
            };
        info!(
            "[staging] 对象存储上传请求完成: jobId={}, HTTP {}, 耗时 {}ms",
            job.id,
            response.status().as_u16(),
            upload_started.elapsed().as_millis()
        );
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
            error!(
                "[staging] 对象存储上传失败: jobId={}, HTTP {status}, 耗时 {}ms, 响应体见错误详情",
                job.id,
                upload_started.elapsed().as_millis()
            );
            return Err(BackendError::protocol(
                format!("TOS upload returned HTTP {status}"),
                redact_request_value(&json!({
                    "httpStatus": status,
                    "rawResponse": raw
                })),
            ));
        }
        job.bytes_uploaded = metadata.len();
        job.status = StagingStatus::Staged;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        info!(
            "[staging] 上传全部完成: jobId={}, 共 {} 字节, 总耗时 {}ms, 平均速度 {}/s",
            job.id,
            metadata.len(),
            upload_started.elapsed().as_millis(),
            format_bytes_per_sec(metadata.len() as usize, upload_started.elapsed())
        );
        Ok(StagingLease {
            job_id: job.id.clone(),
            get_url,
            delete_url: Some(delete_url),
        })
    }

    fn presign_existing_object_with_config(
        &self,
        job_id: &str,
        object_key: &str,
        config: &TosStagingConfig,
    ) -> BackendResult<StagingLease> {
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({ "jobId": job_id }),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;
        let host = format!("{}.{}", config.bucket, config.endpoint);
        let now = Utc::now();
        let get_url = presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        let delete_url = presign_url(&PresignParams {
            method: "DELETE",
            host: &host,
            object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        Ok(StagingLease {
            job_id: job_id.to_string(),
            get_url,
            delete_url: Some(delete_url),
        })
    }
}

/// 应用暂存对象（云端素材库导入、生成输入等）在任务结束后会清理；
/// 已由应用管理的对象键都不能通过整桶同步变成第二份长期素材索引。

fn should_skip_bucket_object_in_config(
    storage: &Storage,
    object_key: &str,
    config: &TosStagingConfig,
) -> BackendResult<bool> {
    for job in storage.list_staging_jobs_by_object_key(object_key)? {
        let saved = storage.get_staging_object_target(&job.id)?;
        if local_asset_matches_current_scope(saved.as_ref(), &job, config) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn needs_asset_import_transcode(job: &StagingJobRecord, extension: &str) -> bool {
    job.import_target.is_some()
        && job.media_type == MediaType::Image
        && !SUPPORTED_IMPORT_IMAGE_EXTENSIONS.contains(&extension)
}

/// 上游取字节失败时的本地副本来源：素材导入时上传的原始文件。
///
/// 素材入库把导入时的暂存租约地址交给上游，导入成功后暂存对象立刻被清理，而上游素材记录
/// 仍原样回放那个地址 —— 上游必然取不到字节，预览于是永久停在「预览不可用」。原始文件与
/// 当时的暂存对象是同一份内容，按对象键找回来即可恢复预览。
///
/// 只接受指向当前配置暂存桶（含配置前缀）的对象地址，并且必须有对应的 `asset_import`
/// 导入记录：签名地址等同凭据，任何其他地址都不允许映射到本机文件。
impl LocalMediaFallback for StagingService {
    fn resolve(&self, url: &Url) -> Option<LocalMediaSource> {
        let config = self.storage.get_tos_config().ok().flatten()?;
        if !config.enabled {
            return None;
        }
        resolve_staging_local_source(&self.storage, &config, url)
    }

    fn resolve_asset_id(&self, asset_id: &str) -> Option<LocalMediaSource> {
        resolve_imported_local_source(&self.storage, asset_id)
    }
}

/// 本地兜底的解析实现（与 [`LocalMediaFallback`] 分离，便于不构造整套服务直接测试）。
fn resolve_staging_local_source(
    storage: &Storage,
    config: &TosStagingConfig,
    url: &Url,
) -> Option<LocalMediaSource> {
    let object_key = staging_object_key(url.as_str(), config)?;
    let job = storage
        .find_asset_import_job_by_object_key(&object_key)
        .ok()
        .flatten()?;
    let path = PathBuf::from(job.local_path.trim());
    if path.as_os_str().is_empty() || !std::fs::metadata(&path).ok()?.is_file() {
        return None;
    }
    Some(LocalMediaSource { path })
}

/// 按云端素材身份找回导入时的原始文件（与 [`LocalMediaFallback::resolve_asset_id`] 分离，便于单测）。
fn resolve_imported_local_source(storage: &Storage, asset_id: &str) -> Option<LocalMediaSource> {
    let job = storage
        .find_asset_import_job_by_asset_id(asset_id)
        .ok()
        .flatten()?;
    let path = PathBuf::from(job.local_path.trim());
    if path.as_os_str().is_empty() || !std::fs::metadata(&path).ok()?.is_file() {
        return None;
    }
    Some(LocalMediaSource { path })
}

/// 从暂存对象的预签名读取地址解出对象键；地址不指向当前配置的暂存桶时返回 `None`。
///
/// 预签名地址的 host 形如 `{bucket}.{endpoint}`（见 `presign_url` 的调用方），
/// path 即对象键；`?X-Tos-…` 查询串是签名本身，不参与解析。地址里的对象键不按百分号
/// 解码：签名按原样字节参与计算，解码后重签会得到指向另一个对象的地址。
fn staging_object_key(url: &str, config: &TosStagingConfig) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    if parsed.host_str()? != format!("{}.{}", config.bucket, config.endpoint) {
        return None;
    }
    let object_key = parsed.path().trim_start_matches('/');
    if object_key.is_empty() || object_key.contains('%') {
        return None;
    }
    let prefix = config.object_prefix.trim_matches('/');
    if !prefix.is_empty() && !object_key.starts_with(&format!("{prefix}/")) {
        return None;
    }
    Some(object_key.to_string())
}

/// 桶内对象摘要（ListObjectsV2 `Contents` 元素的字段子集）。
#[derive(Debug, Clone)]
pub struct TosObjectSummary {
    pub key: String,
    pub size: u64,
}

/// ListObjectsV2 响应体（官方文档响应示例为 JSON 形态）。
#[derive(Debug, serde::Deserialize)]
struct ListObjectsV2ResponseBody {
    #[serde(rename = "IsTruncated", default)]
    is_truncated: bool,
    #[serde(rename = "NextContinuationToken", default)]
    next_continuation_token: Option<String>,
    #[serde(rename = "Contents", default)]
    contents: Vec<ListObjectsV2Content>,
}

#[derive(Debug, serde::Deserialize)]
struct ListObjectsV2Content {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "Size", default)]
    size: u64,
}

/// 按扩展名判断对象键的素材类型；仅识别文件名（最后一段路径）的扩展名。
fn detect_media_type_by_extension(object_key: &str) -> Option<MediaType> {
    let file_name = object_key.rsplit('/').next().unwrap_or(object_key);
    let dot = file_name.rfind('.')?;
    let extension = &file_name[dot + 1..];
    if extension.is_empty() {
        return None;
    }
    let normalized = extension.to_ascii_lowercase();
    if PULL_IMAGE_EXTENSIONS.contains(&normalized.as_str()) {
        Some(MediaType::Image)
    } else if PULL_VIDEO_EXTENSIONS.contains(&normalized.as_str()) {
        Some(MediaType::Video)
    } else if PULL_AUDIO_EXTENSIONS.contains(&normalized.as_str()) {
        Some(MediaType::Audio)
    } else {
        None
    }
}

async fn detect_local_media(path: &Path, expected: MediaType) -> BackendResult<(String, String)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0_u8; 16 * 1024];
    let read = file.read(&mut buffer).await?;
    let detected = infer::get(&buffer[..read]).ok_or_else(|| {
        BackendError::validation(
            "local media type could not be identified from file signature",
            json!({ "localPath": path.to_string_lossy(), "expectedMediaType": expected }),
        )
    })?;
    let mime = detected.mime_type().to_string();
    let valid = match expected {
        MediaType::Image => mime.starts_with("image/"),
        MediaType::Video => mime.starts_with("video/"),
        MediaType::Audio => mime.starts_with("audio/"),
        MediaType::Text => mime.starts_with("text/"),
    };
    if !valid {
        return Err(BackendError::validation(
            "local media type does not match the requested staging type",
            json!({
                "localPath": path.to_string_lossy(),
                "expectedMediaType": expected,
                "detectedMimeType": mime
            }),
        ));
    }
    Ok((mime, detected.extension().to_ascii_lowercase()))
}

/// 转码临时文件的自动清理守卫：作用域结束时删除临时文件，成功与失败路径一致。
struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 将摸鱼素材库不支持的图片格式（如 avif）转码为 webp。
///
/// 复用 `VideoCompositionService` 管理的 FFmpeg 引擎（首次使用自动下载官方独立构建），
/// 避免为转码单独下载二进制。输出写入系统临时目录，由调用方负责清理。
/// 返回 `(输出路径, 扩展名, MIME)`。
async fn transcode_local_media(
    composer: &VideoCompositionService,
    job_id: &str,
    source: &Path,
    source_ext: &str,
) -> BackendResult<(PathBuf, String, String)> {
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let output = std::env::temp_dir().join(format!(
        "infinite-canvas-staging-{}-{}.webp",
        job_id,
        Uuid::new_v4()
    ));
    info!(
        "[staging] 导入素材转码: jobId={}, sourceExt={}, 目标格式=webp, 输出={}",
        job_id,
        source_ext,
        output.display()
    );
    let started = std::time::Instant::now();
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-c:v")
        .arg("libwebp")
        .arg("-quality")
        .arg("90")
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    // 转码加超时保护：ffmpeg 意外挂起（损坏文件、杀软占用等）时不能把导入
    // 任务永久卡在「准备中」，到点后杀掉子进程并按失败处理。
    const TRANSCODE_TIMEOUT_SECS: u64 = 120;
    let mut child = command.spawn()?;
    let mut stderr_reader = tokio::io::BufReader::new(child.stderr.take().ok_or_else(|| {
        BackendError::protocol(
            "ffmpeg media transcode failed",
            json!({ "jobId": job_id, "reason": "stderr pipe unavailable" }),
        )
    })?);
    let stderr_task = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt as _;
        let mut buf = String::new();
        let _ = stderr_reader.read_to_string(&mut buf).await;
        buf
    });
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(TRANSCODE_TIMEOUT_SECS),
        child.wait(),
    )
    .await
    {
        Ok(status) => status.inspect_err(|_error| {
            let _ = std::fs::remove_file(&output);
        })?,
        Err(_elapsed) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&output);
            let stderr = stderr_task.await.unwrap_or_default();
            return Err(BackendError::protocol(
                "ffmpeg media transcode timed out",
                json!({
                    "jobId": job_id,
                    "sourceExt": source_ext,
                    "timeoutSecs": TRANSCODE_TIMEOUT_SECS,
                    "stderr": stderr.trim(),
                }),
            ));
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(BackendError::protocol(
            "ffmpeg media transcode failed",
            json!({
                "jobId": job_id,
                "sourceExt": source_ext,
                "exitCode": status.code(),
                "stderr": stderr.trim(),
            }),
        ));
    }
    info!(
        "[staging] 导入素材转码完成: jobId={}, 输出={}, 耗时 {}ms",
        job_id,
        output.display(),
        started.elapsed().as_millis()
    );
    Ok((output, "webp".to_string(), "image/webp".to_string()))
}

fn build_object_key(config: &TosStagingConfig, extension: &str) -> String {
    // 作用域哈希仅区分桶/地域/Endpoint 组合，不包含任何凭据信息。
    let scope = format!("{}:{}:{}", config.bucket, config.region, config.endpoint);
    let scope_hash = hex::encode(Sha256::digest(scope.as_bytes()));
    let now = Utc::now();
    format!(
        "{}/{}/{:04}/{:02}/{:02}/{}.{}",
        config.object_prefix.trim_matches('/'),
        &scope_hash[..16],
        now.year(),
        now.month(),
        now.day(),
        safe_file_stem(&Uuid::new_v4().to_string()),
        extension
    )
}

fn staging_content_scope(
    job: &StagingJobRecord,
    config: Option<&TosStagingConfig>,
    assets: &AssetLibrary,
) -> BackendResult<String> {
    if let Some(target) = job.import_target.as_ref() {
        let group = target.group_id.as_deref().unwrap_or_default().trim();
        return Ok(serde_json::to_string(&(
            "cloud",
            target.provider_connection_id.trim(),
            assets.content_scope(&target.provider_connection_id)?,
            group,
        ))?);
    }
    let config = config
        .ok_or_else(|| BackendError::validation("TOS staging is not configured", json!({})))?;
    Ok(serde_json::to_string(&(
        "object_storage",
        config.bucket.trim(),
        config.region.trim(),
        config.endpoint.trim().to_ascii_lowercase(),
    ))?)
}

fn legacy_object_key_matches_config(job: &StagingJobRecord, config: &TosStagingConfig) -> bool {
    job.object_key
        .as_deref()
        .is_some_and(|key| staging_object_belongs_to_scope(key, config))
}

/// 对象键是否属于这个桶配置下的本应用对象。
///
/// 判据是「键里带这个桶/地域/Endpoint 组合的 scope 哈希段」——`build_object_key`
/// 生成的键永远含这一段，因此它能证明「这个键是本应用用这个桶生成的」。
///
/// 只看 scope 哈希、不看对象前缀，是有意为之：用户改了对象前缀之后，旧对象仍然
/// 属于本应用（同一个桶），只是不再落在新前缀下；用前缀校验会把这些残留对象
/// 永远排除在回收之外。
fn staging_object_belongs_to_scope(object_key: &str, config: &TosStagingConfig) -> bool {
    let scope = format!("{}:{}:{}", config.bucket, config.region, config.endpoint);
    let scope_hash = hex::encode(Sha256::digest(scope.as_bytes()));
    object_key
        .split('/')
        .any(|segment| segment == &scope_hash[..16])
}

fn local_asset_matches_current_scope(
    saved: Option<&TosStagingConfig>,
    job: &StagingJobRecord,
    current: &TosStagingConfig,
) -> bool {
    saved.map_or_else(
        || legacy_object_key_matches_config(job, current),
        |saved| same_object_scope(saved, current),
    )
}

fn same_object_scope(left: &TosStagingConfig, right: &TosStagingConfig) -> bool {
    left.bucket.trim() == right.bucket.trim()
        && left.region.trim() == right.region.trim()
        && left
            .endpoint
            .trim()
            .eq_ignore_ascii_case(right.endpoint.trim())
}

async fn sha256_file(path: &Path) -> BackendResult<(String, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size = size.saturating_add(read as u64);
    }
    Ok((hex::encode(hasher.finalize()), size))
}

/// 仅对本应用按当前桶、地域和 endpoint 生成的对象重签删除地址。
/// scope 哈希是对象键的一部分；用户切换 TOS 配置后不会误删新桶里的同名键。
fn staging_object_matches_scope(object_key: &str, config: &TosStagingConfig) -> bool {
    let scope = format!("{}:{}:{}", config.bucket, config.region, config.endpoint);
    let scope_hash = hex::encode(Sha256::digest(scope.as_bytes()));
    let expected_prefix = format!(
        "{}/{}/",
        config.object_prefix.trim_matches('/'),
        &scope_hash[..16]
    );
    object_key.starts_with(&expected_prefix) && object_key.len() > expected_prefix.len()
}

/// 直连 TOS 的配置校验：启用时桶名、地域、Endpoint、对象前缀与凭据引用必须齐备。
fn validate_tos_config(config: &TosStagingConfig) -> BackendResult<()> {
    if !config.enabled {
        return Ok(());
    }
    for (field, value) in [
        ("bucket", &config.bucket),
        ("region", &config.region),
        ("endpoint", &config.endpoint),
        ("objectPrefix", &config.object_prefix),
    ] {
        if value.trim().is_empty() {
            return Err(BackendError::validation(
                "TOS staging requires a non-empty bucket, region, endpoint and object prefix",
                json!({ "field": field, "provided": value }),
            ));
        }
    }
    if config
        .credential_ref
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err(BackendError::validation(
            "TOS staging requires saved AK/SK credentials before enabling",
            json!({ "required": ["accessKey", "secretKey"] }),
        ));
    }
    // 预签名 URL 只走 HTTPS，Endpoint 必须是纯主机名（不带 scheme 和路径）。
    if url::Url::parse(&format!("https://{}/", config.endpoint)).is_err()
        || config.endpoint.contains('/')
    {
        return Err(BackendError::validation(
            "TOS endpoint must be a bare HTTPS host such as tos-cn-beijing.volces.com",
            json!({ "endpoint": config.endpoint }),
        ));
    }
    Ok(())
}

/// 连通性测试探针响应的判定结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeVerdict {
    /// 签名与凭据有效且桶可访问（2xx，或 404 + NoSuchKey）。
    Ok,
    /// 404 且非 NoSuchKey：桶不存在。
    BucketMissing,
    /// 401/403：凭据或签名被拒绝。
    AuthRejected,
    /// 3xx：预签名请求被重定向。TOS 预签名 URL 绑定 Host，重定向会改变 Host
    /// 并破坏签名，因此连通性测试不跟随重定向，将其归因为 Endpoint/地域/桶名问题。
    Redirected,
    /// 其余非 2xx 状态。
    HttpError,
}

impl ProbeVerdict {
    fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }

    /// 机器可读的失败类别；通过时返回 None。
    fn reason_name(self) -> Option<&'static str> {
        match self {
            Self::Ok => None,
            Self::BucketMissing => Some("bucket-not-found"),
            Self::AuthRejected => Some("auth-rejected"),
            Self::Redirected => Some("redirected"),
            Self::HttpError => Some("http-error"),
        }
    }
}

/// 按官方行为判定探针响应：TOS 先验证签名再检查对象存在性，
/// 因此 404 + NoSuchKey 恰好证明 AK/SK、签名与桶都有效。
fn classify_probe_response(status: u16, body: &str) -> ProbeVerdict {
    if (200..300).contains(&status) {
        return ProbeVerdict::Ok;
    }
    match status {
        // 预签名请求不跟随重定向；3xx 直接归因为域名/Endpoint 问题。
        301 | 302 | 303 | 307 | 308 => ProbeVerdict::Redirected,
        404 if extract_error_code(body).as_deref() == Some("NoSuchKey") => ProbeVerdict::Ok,
        404 => ProbeVerdict::BucketMissing,
        401 | 403 => ProbeVerdict::AuthRejected,
        _ => ProbeVerdict::HttpError,
    }
}

/// 从 TOS 错误响应中提取 `Code` 值，例如 `NoSuchKey`、`NoSuchBucket`、`SignatureDoesNotMatch`。
///
/// 火山引擎 TOS 在不同场景下可能返回 **不同形态**的错误体：
/// - XML：`<Error><Code>NoSuchKey</Code>...</Error>`（REST 常规形态）
/// - JSON：`{"Code":"NoSuchKey","Key":"...","Message":"..."}`（部分错误响应为 JSON）
///
/// 两类形态都必须解析。若只认 XML，遇到 JSON 错误体时会漏读 `Code`，把本应判为
/// 「连通/凭据有效」的 `NoSuchKey` 误判成「桶不存在」，导致连通性测试误报失败。
fn extract_error_code(body: &str) -> Option<String> {
    // JSON 形态：{"Code":"NoSuchKey", ...}。容忍空白与键顺序。
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(code) = value.get("Code").and_then(Value::as_str) {
            return Some(code.trim().to_string());
        }
    }
    // XML 形态：<Code>NoSuchKey</Code>。
    let start = body.find("<Code>")? + "<Code>".len();
    let end = start + body[start..].find("</Code>")?;
    Some(body[start..end].trim().to_string())
}
