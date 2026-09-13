use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::{Datelike as _, Utc};
use futures_util::TryStreamExt as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncReadExt as _;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::{
    asset_library::{AssetLibrary, ImportStagedAsset},
    composer::VideoCompositionService,
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    image_normalize::normalize_image_for_asset_window,
    local_results::{format_bytes_per_sec, safe_file_stem},
    provider::{redact_request_value, redact_url_string, truncate_connectivity_detail},
    storage::{Storage, now_ms},
    tos_sign::{PresignParams, TosCredentials, presign_url, presign_url_with_query},
    types::{
        AssetImportOutputRecord, ConnectivityTestResult, LocalAssetKindTotals, LocalAssetListQuery,
        LocalAssetPage, LocalAssetRecord, MediaType, RefreshLocalAssetMediaCommand,
        StagingJobRecord, StagingStatus, StartStagingCommand, TosBucketPullSummary,
        TosStagingConfig,
    },
};

/// 上传进度日志的节流间隔：每累计上传 1MB 记录一次，避免大文件刷屏；到达末尾必记录。
const PROGRESS_LOG_INTERVAL_BYTES: u64 = 1024 * 1024;

/// 预签名 PUT URL 有效期：15 分钟（上传窗口）。
const PUT_URL_EXPIRY_SECS: i64 = 900;

/// 预签名 GET / DELETE URL 有效期：1 小时，需覆盖素材导入轮询（最长 300 秒）与安全重试窗口。
const LEASE_URL_EXPIRY_SECS: i64 = 3600;

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
/// 302 做实际分发是常见行为。
pub(crate) async fn fake_ip_aware_download_client(
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
        "[save] {host} 被代理软件 fake-ip 劫持（系统解析 {system_ips:?}），改用备用 DNS 的真实地址直连下载"
    );
    build_fake_ip_pinned_client(host, port, &real_ips, reqwest::redirect::Policy::default())
        .unwrap_or(fallback)
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
    send: &mut F,
) -> Result<reqwest::Response, UploadAttemptError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, UploadAttemptError>>,
{
    let mut attempt: u32 = 0;
    loop {
        match send().await {
            Ok(response) => return Ok(response),
            Err(error) if attempt < UPLOAD_MAX_RETRIES && error.is_retryable() => {
                let delay_ms = UPLOAD_RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                warn!(
                    "[staging] 对象存储上传网络失败，{delay_ms}ms 后重试 ({}/{})：{error}",
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
    client: &reqwest::Client,
    make_url: F,
) -> BackendResult<reqwest::Response>
where
    F: Fn() -> BackendResult<String>,
{
    let mut attempt: u32 = 0;
    loop {
        let url = make_url()?;
        match client.get(&url).send().await {
            Ok(response) => return Ok(response),
            Err(error) if attempt < PROBE_MAX_RETRIES => {
                let delay_ms = PROBE_RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                warn!(
                    "[staging] 连通性测试网络请求失败，{delay_ms}ms 后重试 ({}/{})：{error}",
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
}

#[derive(Debug, Clone)]
pub struct StagingLease {
    pub job_id: String,
    pub get_url: String,
    pub delete_url: Option<String>,
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
        let response = match send_probe_with_retry(&probe_client, || {
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
            import_target: command.import,
            adjustment: None,
            error: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.storage.insert_staging_job(&job)?;
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
                    local_path: job.local_path,
                    media_type: job.media_type,
                    status: job.status,
                    asset_id: job.asset_id,
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
        let mut kind_totals = LocalAssetKindTotals::default();
        // 先构造 (job, 文件名) 全集并校验 object_key，保证缺 object_key 的坏数据
        // 与旧行为一致地直接报错，同时支撑全库类型计数。
        let mut rows: Vec<(StagingJobRecord, String)> = Vec::with_capacity(jobs.len());
        for job in jobs {
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
    fn local_asset_record(&self, job: &StagingJobRecord) -> BackendResult<LocalAssetRecord> {
        let object_key = job.object_key.as_deref().ok_or_else(|| {
            BackendError::protocol(
                "local asset upload has no object key",
                json!({ "stagingJobId": job.id }),
            )
        })?;
        let lease = self.presign_existing_object(&job.id, object_key)?;
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
            preview_url: lease.get_url,
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
        self.presign_existing_object(staging_job_id, object_key)
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
        Ok(lease.get_url)
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
            if self
                .storage
                .find_local_asset_job_by_object_key(&object.key)?
                .is_some()
            {
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
                import_target: None,
                adjustment: None,
                error: None,
                created_at: timestamp,
                updated_at: timestamp,
            };
            self.storage.insert_staging_job(&job)?;
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
        let mut job = self.storage.get_staging_job(job_id)?;
        match self.run_job_inner(&mut job).await {
            Ok(()) => Ok(job),
            Err(error) => {
                job.status = StagingStatus::Failed;
                job.error = Some(error.runtime_record());
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                Err(error)
            }
        }
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
        persisted.status = StagingStatus::InUse;
        persisted.updated_at = now_ms();
        self.storage.update_staging_job(&persisted)?;
        Ok(lease)
    }

    pub async fn cleanup_lease(&self, lease: &StagingLease) -> BackendResult<()> {
        let mut job = self.storage.get_staging_job(&lease.job_id)?;
        job.status = StagingStatus::Cleaning;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        if let Some(delete_url) = &lease.delete_url {
            let response = self.client.delete(delete_url).send().await?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
                let error = BackendError::protocol(
                    format!("TOS cleanup returned HTTP {status}"),
                    redact_request_value(&json!({ "httpStatus": status, "rawResponse": raw })),
                );
                job.error = Some(error.runtime_record());
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                return Err(error);
            }
        }
        job.status = StagingStatus::Cleaned;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        Ok(())
    }

    async fn run_job_inner(&self, job: &mut StagingJobRecord) -> BackendResult<()> {
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
        let imported = self
            .assets
            .import_staged_with_progress(
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
        job.status = StagingStatus::Active;
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
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
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

        let local_path = Path::new(&job.local_path);
        let source_metadata = tokio::fs::metadata(local_path).await?;
        if !source_metadata.is_file() {
            return Err(BackendError::validation(
                "staging input must be a readable file",
                json!({ "localPath": job.local_path }),
            ));
        }
        let (mut mime_type, mut extension) = detect_local_media(local_path, job.media_type).await?;
        // avif 等摸鱼素材库不支持的图片扩展名 → 先用共享 FFmpeg 引擎转码为 webp，
        // 再对转码产物做预签名上传与素材导入；转码临时文件随本函数退出自动清理。
        let mut upload_path = local_path.to_path_buf();
        let _converted_guard = if job.media_type == MediaType::Image
            && !SUPPORTED_IMPORT_IMAGE_EXTENSIONS.contains(&extension.as_str())
        {
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
        let mut send_once = move || {
            let progress_counter = Arc::clone(&uploaded);
            let log_counter = Arc::clone(&last_logged_bytes);
            let storage = Arc::clone(&storage);
            let job_id = job_id.clone();
            let upload_path = upload_path_owned.clone();
            let put_url = put_url_owned.clone();
            let mime_type = mime_owned.clone();
            let upload_client = upload_client.clone();
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
        let response = match send_upload_with_retry(&mut send_once).await {
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

    fn presign_existing_object(
        &self,
        job_id: &str,
        object_key: &str,
    ) -> BackendResult<StagingLease> {
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> TosStagingConfig {
        TosStagingConfig {
            region: "cn-beijing".into(),
            endpoint: "tos-cn-beijing.volces.com".into(),
            bucket: "example-staging-bucket".into(),
            credential_ref: Some("tos-ak-sk".into()),
            object_prefix: "staging".into(),
            enabled: true,
        }
    }

    #[test]
    fn object_key_has_no_original_file_name_or_secret() {
        let config = sample_config();
        let key = build_object_key(&config, "png");
        assert!(key.starts_with("staging/"));
        assert!(key.ends_with(".png"));
        assert!(!key.contains("tos-ak-sk"));
        assert!(!key.contains("example-staging-bucket"));
    }

    #[test]
    fn detect_media_type_by_extension_matches_last_path_segment_only() {
        // 常规大小写与中文目录前缀。
        assert_eq!(
            detect_media_type_by_extension("staging/素材/IMG_1.PNG"),
            Some(MediaType::Image)
        );
        assert_eq!(
            detect_media_type_by_extension("video/a.MP4"),
            Some(MediaType::Video)
        );
        assert_eq!(
            detect_media_type_by_extension("audio/b.Flac"),
            Some(MediaType::Audio)
        );
        // 点出现在目录名而非文件名时不能误判。
        assert_eq!(detect_media_type_by_extension("dir.v2/file"), None);
        // 无扩展名 / 空扩展名 / 未收录格式。
        assert_eq!(detect_media_type_by_extension("noext"), None);
        assert_eq!(detect_media_type_by_extension("name."), None);
        assert_eq!(detect_media_type_by_extension("doc.pdf"), None);
        // 文件夹占位对象（键以 / 结尾）不做扩展名判断，调用方先行跳过。
        assert_eq!(detect_media_type_by_extension("staging/folder/"), None);
    }

    #[test]
    fn configure_requires_complete_direct_tos_fields() {
        // 缺少桶名时拒绝启用。
        let mut config = sample_config();
        config.bucket = " ".into();
        assert!(validate_tos_config(&config).is_err());
        // 缺少凭据引用时拒绝启用。
        let mut config = sample_config();
        config.credential_ref = None;
        assert!(validate_tos_config(&config).is_err());
        // Endpoint 带路径分隔符时拒绝。
        let mut config = sample_config();
        config.endpoint = "tos.example.com/presign".into();
        assert!(validate_tos_config(&config).is_err());
        // 未启用时跳过校验。
        let mut config = sample_config();
        config.enabled = false;
        config.bucket.clear();
        assert!(validate_tos_config(&config).is_ok());
        // 完整直连配置通过校验。
        let config = sample_config();
        assert!(validate_tos_config(&config).is_ok());
    }

    #[test]
    fn probe_verdict_classifies_tos_responses() {
        let nosuch_key =
            r#"<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>...</Message></Error>"#;
        let nosuch_bucket = r#"<Error><Code>NoSuchBucket</Code></Error>"#;
        let bad_signature = r#"<Error><Code>SignatureDoesNotMatch</Code></Error>"#;

        // 2xx 与 404 + NoSuchKey 都代表签名/凭据有效且桶可访问。
        assert_eq!(classify_probe_response(200, ""), ProbeVerdict::Ok);
        assert_eq!(classify_probe_response(204, ""), ProbeVerdict::Ok);
        assert_eq!(classify_probe_response(404, nosuch_key), ProbeVerdict::Ok);
        // 404 + JSON 形态 NoSuchKey 与 XML 形态等价：TOS 部分错误响应为 JSON，
        // 必须同样判为连通（此前只认 XML，导致误报「桶不存在」）。
        let nosuch_key_json = r#"{"Code":"NoSuchKey","Key":"staging/.connectivity-probe","Message":"The specified key does not exist.","EC":"0017-00000003"}"#;
        assert_eq!(
            classify_probe_response(404, nosuch_key_json),
            ProbeVerdict::Ok
        );
        // 404 的其他错误码视为桶不存在。
        assert_eq!(
            classify_probe_response(404, nosuch_bucket),
            ProbeVerdict::BucketMissing
        );
        // 401/403 代表凭据或签名被拒绝。
        assert_eq!(
            classify_probe_response(403, bad_signature),
            ProbeVerdict::AuthRejected
        );
        assert_eq!(classify_probe_response(401, ""), ProbeVerdict::AuthRejected);
        // 3xx 预签名重定向归因为域名/Endpoint 问题（不再静默跟随导致签名失效）。
        assert_eq!(classify_probe_response(301, ""), ProbeVerdict::Redirected);
        assert_eq!(classify_probe_response(302, ""), ProbeVerdict::Redirected);
        assert_eq!(
            classify_probe_response(307, bad_signature),
            ProbeVerdict::Redirected
        );
        assert_eq!(classify_probe_response(308, ""), ProbeVerdict::Redirected);
        // 其余非重定向状态归为服务端错误。
        assert_eq!(classify_probe_response(500, ""), ProbeVerdict::HttpError);
    }

    #[test]
    fn extract_error_code_handles_xml_shapes() {
        assert_eq!(
            extract_error_code(r#"<Error><Code>NoSuchKey</Code></Error>"#).as_deref(),
            Some("NoSuchKey")
        );
        // 带空白与属性前缀的形态。
        assert_eq!(
            extract_error_code(r#"<Error> <Code> SignatureDoesNotMatch </Code> </Error>"#)
                .as_deref(),
            Some("SignatureDoesNotMatch")
        );
        // 非 XML 或缺失 Code 时返回 None。
        assert_eq!(extract_error_code("plain text"), None);
        assert_eq!(
            extract_error_code("<Error><Message>x</Message></Error>"),
            None
        );
        // JSON 形态（火山引擎部分错误响应为 JSON，而非 XML）。
        assert_eq!(
            extract_error_code(
                r#"{"Code":"NoSuchKey","Key":"staging/.connectivity-probe","Message":"The specified key does not exist."}"#
            )
            .as_deref(),
            Some("NoSuchKey")
        );
        assert_eq!(
            extract_error_code(r#"{ "Code" : "NoSuchBucket" }"#).as_deref(),
            Some("NoSuchBucket")
        );
    }

    /// 回归测试：TOS 预签名客户端不得自动跟随重定向。
    ///
    /// 复现根因——此前 `StagingService` 复用 `ProviderRuntime` 的共享客户端，其默认
    /// `redirect::Policy::limited(10)` 会跟随重定向。TOS 对预签名请求返回 307 到规范
    /// 化 Host 时，reqwest 把同一套签名查询串重放到不同 Host，TOS 用新 Host 重算签名
    /// 即报 `SignatureDoesNotMatch`（AK 合法仍被回显）。专用客户端必须用 `Policy::none()`。
    ///
    /// 本测试启动一个会 307 到「捕获服务器」的本地服务，断言专用客户端直接拿到 307
    /// 且捕获服务器从未被访问。
    #[tokio::test]
    async fn presign_client_does_not_follow_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::Duration;

        // 捕获服务器：一旦被访问即置位，证明发生了重定向跟随。
        let captured = Arc::new(AtomicBool::new(false));
        let captured_clone = Arc::clone(&captured);
        let capture = TcpListener::bind("127.0.0.1:0").unwrap();
        let capture_addr = capture.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = capture.accept() {
                captured_clone.store(true, Ordering::SeqCst);
                let _ = stream.read(&mut [0u8; 1024]);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });

        // 重定向服务器：对任何请求返回 307 指向捕获服务器。
        let redirect = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_addr = redirect.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = redirect.accept() {
                let _ = stream.read(&mut [0u8; 1024]);
                let body = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{capture_addr}/\r\n\
                     Content-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        let client = build_presign_http_client().unwrap();
        let resp = client
            .get(format!(
                "http://{redirect_addr}/object?X-Tos-Signature=abc123"
            ))
            .send()
            .await
            .expect("request to local redirect server should succeed");

        // 关键断言：客户端未跟随重定向，原样返回 307。
        assert_eq!(
            resp.status().as_u16(),
            307,
            "presign client must not follow redirects; expected 307"
        );
        // 给捕获服务器留出时间，确认其从未被访问。
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            !captured.load(Ordering::SeqCst),
            "presign client must not follow the 307 to the capture server"
        );
    }

    /// 回归测试：连通性探针网络请求失败时按指数退避重试，直到成功。
    ///
    /// 复现根因——此前 `test_connectivity` 对 `send().await` 只发一次请求，网络瞬断时
    /// 直接返回 `network-error`。本测试用本地 TCP 服务模拟「前两次连接即读即断、第三次
    /// 正常返回 200」，断言重试后探针成功且确实发生了重试（服务端共收到 3 次连接）。
    #[tokio::test]
    async fn probe_retry_recovers_after_transient_network_failure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        // 本地服务：前两次连接「读取请求后立即关闭」（模拟网络瞬断），第三次正常返回 200。
        let connections = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_connections = Arc::clone(&connections);
        let server = std::thread::spawn(move || {
            let fail_before_success: usize = 2;
            for _ in 0..=fail_before_success {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.read(&mut [0u8; 4096]);
                if server_connections.fetch_add(1, Ordering::SeqCst) < fail_before_success {
                    drop(stream); // 模拟网络瞬断：读到请求后立即关闭连接。
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
                    let _ = stream.flush();
                }
            }
        });

        let client = build_presign_http_client().unwrap();
        // 本地回归测试用 http 直连，绕过 presign_url 固定生成的 https scheme。
        let url = format!("http://{addr}/probe");
        let response = send_probe_with_retry(&client, || Ok(url.clone()))
            .await
            .expect("probe should recover after transient failures");
        assert_eq!(response.status().as_u16(), 200);

        server.join().unwrap();
        assert_eq!(
            connections.load(Ordering::SeqCst),
            3,
            "expected 3 connection attempts (1 initial + 2 retries)"
        );
    }

    /// 回归测试：持续网络失败时，重试次数严格受 `PROBE_MAX_RETRIES` 限制并最终放弃。
    ///
    /// 本地 TCP 服务总是「读取请求后立即关闭连接」，断言请求恰好发出
    /// `PROBE_MAX_RETRIES + 1` 次（1 次初始 + 3 次重试）后以传输错误结束。
    #[tokio::test]
    async fn probe_retry_gives_up_after_max_retries() {
        use std::io::Read;
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let connections = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_connections = Arc::clone(&connections);
        let server = std::thread::spawn(move || {
            for _ in 0..(PROBE_MAX_RETRIES + 1) {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                server_connections.fetch_add(1, Ordering::SeqCst);
                let _ = stream.read(&mut [0u8; 4096]);
                drop(stream);
            }
        });

        let client = build_presign_http_client().unwrap();
        let url = format!("http://{addr}/probe");
        let result = send_probe_with_retry(&client, || Ok(url.clone())).await;
        assert!(
            matches!(result, Err(BackendError::Transport(_))),
            "probe must give up with a transport error after exhausting retries"
        );

        server.join().unwrap();
        assert_eq!(
            connections.load(Ordering::SeqCst),
            (PROBE_MAX_RETRIES + 1) as usize,
            "expected 1 initial attempt + PROBE_MAX_RETRIES retries"
        );
    }

    /// 单元测试：fake-ip 虚拟网段判定（`198.18.0.0/15` 为代理软件保留段）。
    #[test]
    fn is_fake_ip_classifies_proxy_virtual_ranges() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
        assert!(is_fake_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(is_fake_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 146))));
        assert!(is_fake_ip(IpAddr::V4(Ipv4Addr::new(198, 19, 255, 255))));
        assert!(!is_fake_ip(IpAddr::V4(Ipv4Addr::new(198, 17, 255, 255))));
        assert!(!is_fake_ip(IpAddr::V4(Ipv4Addr::new(198, 20, 0, 0))));
        assert!(!is_fake_ip(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5))));
        assert!(!is_fake_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    /// 单元测试：DoH 响应解析——只取 A 记录（`type == 1`），
    /// CNAME（`type == 5`）与 fake-ip 虚拟地址都必须排除，否则会把一个
    /// 不可路由的虚拟地址当成"真实地址"拿去直连。
    #[test]
    fn doh_a_records_picks_only_real_addresses() {
        use std::net::{IpAddr, Ipv4Addr};

        // 阿里 DoH 的实际形状（单条 A 记录）。
        let alidns = r#"{"Status":0,"TC":false,"RD":true,"RA":true,"AD":false,"CD":false,
            "Question":{"name":"cdn.example.com.","type":1},
            "Answer":[{"name":"cdn.example.com.","TTL":251,"type":1,"data":"80.87.199.46"}]}"#;
        assert_eq!(
            doh_a_records(alidns),
            vec![IpAddr::V4(Ipv4Addr::new(80, 87, 199, 46))]
        );

        // doh.pub 的实际形状：CNAME 在前、A 记录在后——只能取 A。
        let dnspod = r#"{"Status":0,"Answer":[
            {"name":"www.example.com.","type":5,"TTL":277,"data":"www.example.com.eo.dnse2.com."},
            {"name":"www.example.com.eo.dnse2.com.","type":1,"TTL":60,"data":"43.159.109.55"}]}"#;
        assert_eq!(
            doh_a_records(dnspod),
            vec![IpAddr::V4(Ipv4Addr::new(43, 159, 109, 55))]
        );

        // DoH 端点本身也被劫持时：虚拟地址必须被过滤，函数返回空以便换下一个端点。
        let hijacked =
            r#"{"Status":0,"Answer":[{"name":"cdn.example.com.","type":1,"data":"198.18.0.21"}]}"#;
        assert!(
            doh_a_records(hijacked).is_empty(),
            "fake-ip 地址不能作为兜底地址使用"
        );

        // 畸变输入一律返回空，由调用方继续尝试。
        assert!(doh_a_records("<html>502 Bad Gateway</html>").is_empty());
        assert!(doh_a_records("{}").is_empty());
        assert!(doh_a_records(r#"{"Answer":[]}"#).is_empty());
        assert!(
            doh_a_records(r#"{"Status":0,"Answer":[{"name":"h.","type":1,"data":"not-an-ip"}]}"#)
                .is_empty()
        );
    }

    /// 配置锁：`reqwest` 必须保留 `system-proxy` feature。
    ///
    /// 该 feature 让客户端自动读取 Windows 注册表 / macOS 系统配置里的代理设置
    /// （配合 `auto_sys_proxy` 默认开启）。一旦被移除，企业代理或「系统代理 + VPN」
    /// 环境下会出现「浏览器能打开直链、应用连接超时」的静默退化——没有任何编译或
    /// 运行时报错。这里用编译期嵌入的清单文本把它锁死。
    #[test]
    fn reqwest_manifest_keeps_system_proxy_support() {
        let manifest = include_str!("../../Cargo.toml");
        assert!(
            manifest.contains("system-proxy"),
            "reqwest 的 system-proxy feature 被移除：客户端将不再读取系统代理设置"
        );
        assert!(
            manifest.contains("rustls-tls-native-roots"),
            "reqwest 不再信任操作系统证书存储：企业解密代理下 TLS 校验会失败"
        );
    }

    /// 结果直链下载的 fake-ip 兜底只在**确认被劫持**时才另建客户端：
    /// 正常解析（含 IP 字面量）与不可解析输入都必须原样返回共享客户端，
    /// 避免每次下载都丢掉连接池、或对非 HTTP 输入做无意义的 DNS 解析。
    ///
    /// 用 `Debug` 中的自定义 UA 作为「同一个客户端」的可读标识。
    #[tokio::test]
    async fn fake_ip_aware_download_client_keeps_shared_client_unless_hijacked() {
        fn marked_client() -> reqwest::Client {
            reqwest::Client::builder()
                .user_agent("shared-client-marker/1")
                .build()
                .unwrap()
        }

        // 不可解析：不解析 DNS，直接回退。
        let client = fake_ip_aware_download_client("不是 URL", marked_client()).await;
        assert!(format!("{client:?}").contains("shared-client-marker/1"));

        // IP 字面量的正常解析：不是 fake-ip，回退到共享客户端。
        let client =
            fake_ip_aware_download_client("http://127.0.0.1:8080/a.png", marked_client()).await;
        assert!(format!("{client:?}").contains("shared-client-marker/1"));
    }

    /// 回归测试：上传 PUT 连接失败时按指数退避重试，直到成功。
    ///
    /// 复现客户「对象存储上传 `isConnect: true` transport error」——代理 fake-ip
    /// 环境下连接可能瞬时失败。第一次请求打到未监听端口（connection refused，
    /// 确定为 connect 错误），第二次打到本地正常服务，断言重试后成功且确已重试。
    #[tokio::test]
    async fn upload_retry_recovers_after_transient_connection_failure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let connections = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_connections = Arc::clone(&connections);
        let server = std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            server_connections.fetch_add(1, Ordering::SeqCst);
            let _ = stream.read(&mut [0u8; 4096]);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            let _ = stream.flush();
        });

        let client = build_presign_http_client().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);
        let mut send = move || {
            let client = client.clone();
            let call_counter = Arc::clone(&call_counter);
            async move {
                let n = call_counter.fetch_add(1, Ordering::SeqCst) + 1;
                let url = if n == 1 {
                    "http://127.0.0.1:1/".to_string()
                } else {
                    format!("http://{addr}/upload")
                };
                client
                    .put(url)
                    .body("payload")
                    .send()
                    .await
                    .map_err(UploadAttemptError::Http)
            }
        };
        let response = send_upload_with_retry(&mut send)
            .await
            .expect("upload should recover after transient connection failure");
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "expected 1 initial attempt + 1 retry"
        );

        server.join().unwrap();
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    /// 回归测试：持续连接失败时，重试次数严格受 `UPLOAD_MAX_RETRIES` 限制并最终放弃。
    #[tokio::test]
    async fn upload_retry_gives_up_after_max_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let client = build_presign_http_client().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);
        let mut send = move || {
            let client = client.clone();
            let call_counter = Arc::clone(&call_counter);
            async move {
                let _ = call_counter.fetch_add(1, Ordering::SeqCst);
                client
                    .put("http://127.0.0.1:1/")
                    .body("payload")
                    .send()
                    .await
                    .map_err(UploadAttemptError::Http)
            }
        };
        let error = send_upload_with_retry(&mut send)
            .await
            .expect_err("upload must give up after exhausting retries");
        assert!(
            matches!(error, UploadAttemptError::Http(ref e) if e.is_connect()),
            "expected connect error, got {error}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            (UPLOAD_MAX_RETRIES + 1) as usize,
            "expected 1 initial attempt + UPLOAD_MAX_RETRIES retries"
        );
    }

    /// 回归测试：HTTP 非 2xx（TOS 端拒绝）不触发重试，原样返回响应。
    #[tokio::test]
    async fn upload_retry_does_not_retry_http_errors() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.read(&mut [0u8; 4096]);
                let _ = stream
                    .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
                let _ = stream.flush();
            }
        });

        let client = build_presign_http_client().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);
        let mut send = move || {
            let client = client.clone();
            let call_counter = Arc::clone(&call_counter);
            async move {
                let _ = call_counter.fetch_add(1, Ordering::SeqCst);
                client
                    .put(format!("http://{addr}/upload"))
                    .body("payload")
                    .send()
                    .await
                    .map_err(UploadAttemptError::Http)
            }
        };
        let response = send_upload_with_retry(&mut send)
            .await
            .expect("HTTP error must surface as a response");
        assert_eq!(response.status().as_u16(), 500);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "HTTP 5xx must not be retried"
        );

        server.join().unwrap();
    }
}
