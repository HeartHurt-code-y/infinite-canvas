//! 生成结果直链落盘：卡住才失败、断点续传、大文件多路 Range。
//!
//! 供应商 CDN 可能把单连接压到十几 KB/s。旧实现用 90 秒总超时，慢但还在走的
//! 下载会被判失败，已下字节随重试丢掉，大约 10 分钟后彻底放弃。这里改为：
//! - 只要还在进数据就不超时；连续收不到新字节才算卡住；
//! - 有强 ETag 的 `.download` 临时文件按同一实体续传，其它结果整段重下；
//! - 有强 ETag 且支持 206 的大文件拆成最多 4 路，全部分段绑定同一实体。

use std::{
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::{StreamExt, future::join_all};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{info, warn};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::{
    error::{BackendError, BackendResult},
    provider::{ResultDownloadAuth, redact_url_string},
};

/// 生产策略：1 分钟无新字节视为卡住，整次最多 30 分钟；大于 2 MiB 且支持 Range 时最多 4 路。
pub fn production_policy() -> TransferPolicy {
    TransferPolicy {
        stall: Duration::from_secs(60),
        overall: Duration::from_secs(30 * 60),
        parallel_min: 2 * 1024 * 1024,
        max_parts: 4,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TransferPolicy {
    pub stall: Duration,
    pub overall: Duration,
    pub parallel_min: u64,
    pub max_parts: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct TransferProgress {
    pub received: u64,
    pub total: Option<u64>,
    pub bytes_per_sec: f64,
}

/// 结果下载专用客户端：没有整段总超时（避免 10 分钟的慢直链被 90s/300s 杀掉）。
/// 卡住检测在读循环里做，不依赖 reqwest 的全局 timeout。
pub fn streaming_client() -> BackendResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent("InfiniteCanvas/0.1")
        .build()?)
}

pub async fn download_result(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    policy: TransferPolicy,
    on_progress: impl FnMut(TransferProgress) + Send + 'static,
) -> BackendResult<Vec<u8>> {
    match tokio::time::timeout(
        policy.overall,
        download_inner(client, url, auth, part_path, policy, on_progress),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(retryable_protocol(
            "result download exceeded time budget",
            json!({
                "overallMs": policy.overall.as_millis(),
                "url": redact_url_string(url),
            }),
        )),
    }
}

async fn download_inner(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    policy: TransferPolicy,
    on_progress: impl FnMut(TransferProgress) + Send + 'static,
) -> BackendResult<Vec<u8>> {
    if let Some(parent) = part_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Parallel writes may leave holes even when the file has its final length.
    // Keep this marker across errors, timeouts and application restarts; such a
    // file is not a contiguous prefix and cannot be resumed using metadata.len().
    let parallel_marker = parallel_marker_path(part_path);
    if tokio::fs::try_exists(&parallel_marker).await? {
        let file = open_part(part_path, true).await?;
        drop(file);
        remove_identity(part_path).await?;
        tokio::fs::remove_file(&parallel_marker).await?;
    }
    let existing = tokio::fs::metadata(part_path)
        .await
        .ok()
        .map(|meta| meta.len())
        .unwrap_or(0);
    let progress = ProgressEmitter::new(existing, on_progress);
    if existing > 0 {
        info!(
            "[save] 结果下载从已有 {} 字节续传: url={}",
            existing,
            redact_url_string(url)
        );
        resume_from(
            client,
            url,
            auth,
            part_path,
            existing,
            policy.stall,
            &progress,
        )
        .await?;
    } else {
        start_fresh(client, url, auth, part_path, policy, &progress).await?;
    }
    progress.emit_now();
    let bytes = tokio::fs::read(part_path).await?;
    if bytes.is_empty() {
        return Err(BackendError::protocol(
            "generated media is empty",
            json!({ "url": redact_url_string(url) }),
        ));
    }
    // 走到这里响应必为 2xx；但网关会把未知路径兜底成自家首页（HTTP 200 + HTML），
    // 靠状态码拦不住，只能认响应体：文档开头必不是媒体文件。
    if super::provider::looks_like_html_document(&bytes) {
        return Err(super::provider::html_document_rejection(
            200,
            url,
            "",
            &bytes,
            "生成产物链接返回的是网页而不是媒体文件。链接可能已失效或被网关重定向到了网站首页：请重新查询任务获取新的产物链接。".into(),
        ));
    }
    remove_identity(part_path).await?;
    Ok(bytes)
}

async fn start_fresh(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    policy: TransferPolicy,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    // Some signed video URLs are rate limited by request count. A single-stream
    // policy must start with one ordinary GET instead of spending a request on
    // a Range probe before the actual download.
    if policy.max_parts <= 1 {
        return stream_full(client, url, auth, part_path, policy.stall, progress).await;
    }
    let probe = send_range(&client, url, auth, 0, Some(0), None).await?;
    let status = probe.status().as_u16();
    if status == 206 {
        let total = content_range(probe.headers())
            .filter(|range| range.start == 0 && range.end == 0)
            .map(|range| range.total);
        let etag = strong_etag(probe.headers());
        drop_body(probe, policy.stall).await?;
        let (Some(total), Some(etag)) = (total, etag) else {
            // Byte offsets alone cannot prove that multiple requests refer to
            // one representation. Without a strong validator use one response.
            return stream_full(client, url, auth, part_path, policy.stall, progress).await;
        };
        progress.set_total(Some(total));
        if total >= policy.parallel_min && policy.max_parts > 1 {
            info!(
                "[save] 结果直链支持 Range 且体积 {} 字节，改用 {} 路并行下载: url={}",
                total,
                policy.max_parts,
                redact_url_string(url)
            );
            return download_parallel(
                DownloadRequest {
                    client,
                    url,
                    auth,
                    part_path,
                },
                total,
                &etag,
                policy,
                progress,
            )
            .await;
        }
        return stream_full(client, url, auth, part_path, policy.stall, progress).await;
    }
    if status != 200 {
        return Err(http_error(status, probe).await);
    }
    let content_length = header_u64(probe.headers(), "content-length");
    progress.set_total(content_length);
    if content_length == Some(1) {
        drop_body(probe, policy.stall).await?;
        return stream_full(client, url, auth, part_path, policy.stall, progress).await;
    }
    let mut file = open_part(part_path, true).await?;
    persist_identity(part_path, url, probe.headers(), content_length).await?;
    stream_into(&mut file, probe, content_length, policy.stall, progress).await
}

async fn resume_from(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    have: u64,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let Some(identity) = read_identity(part_path, url, have).await else {
        progress.reset_received();
        return stream_full(client, url, auth, part_path, stall, progress).await;
    };
    let response = send_range(
        &client,
        url,
        auth,
        have,
        None,
        Some(RangeCondition::IfRange(&identity.etag)),
    )
    .await?;
    let status = response.status().as_u16();
    if status == 416 {
        // Older versions preallocated parallel downloads and accepted 416 as
        // completion. Discard that possibly hole-filled file and let the retry
        // loop reserve a fresh GET, preserving single-request download policies.
        drop(response);
        let file = open_part(part_path, true).await?;
        drop(file);
        remove_identity(part_path).await?;
        progress.reset_received();
        return Err(retryable_protocol(
            "result download range is unsatisfiable; partial file reset for retry",
            json!({ "previousByteCount": have }),
        ));
    }
    if status == 206 {
        let range = validate_range(response.headers(), have, None, Some(identity.total))?;
        validate_etag(response.headers(), &identity.etag)?;
        progress.set_total(Some(range.total));
        let mut file = open_part(part_path, false).await?;
        file.seek(SeekFrom::Start(have)).await?;
        return stream_into(&mut file, response, Some(range.len()), stall, progress).await;
    }
    if status != 200 {
        return Err(http_error(status, response).await);
    }
    warn!(
        "[save] 续传 Range 被忽略，改为整段重下: url={}",
        redact_url_string(url)
    );
    progress.reset_received();
    let mut file = open_part(part_path, true).await?;
    let total = header_u64(response.headers(), "content-length");
    progress.set_total(total);
    persist_identity(part_path, url, response.headers(), total).await?;
    stream_into(&mut file, response, total, stall, progress).await
}

struct DownloadRequest<'a> {
    client: reqwest::Client,
    url: &'a str,
    auth: &'a ResultDownloadAuth,
    part_path: &'a Path,
}

async fn download_parallel(
    request: DownloadRequest<'_>,
    total: u64,
    etag: &str,
    policy: TransferPolicy,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let DownloadRequest {
        client,
        url,
        auth,
        part_path,
    } = request;
    let ranges = split_ranges(total, policy.max_parts);
    let marker = parallel_marker_path(part_path);
    tokio::fs::write(&marker, b"parallel download incomplete").await?;
    let file = open_part(part_path, true).await?;
    file.set_len(total).await?;
    drop(file);
    let jobs = ranges.into_iter().map(|(start, end)| {
        let client = client.clone();
        let auth = auth.clone();
        let url = url.to_string();
        let path = part_path.to_path_buf();
        let progress = progress.clone();
        let etag = etag.to_string();
        async move {
            download_span(
                DownloadRequest {
                    client,
                    url: &url,
                    auth: &auth,
                    part_path: &path,
                },
                start,
                end,
                total,
                &etag,
                policy.stall,
                &progress,
            )
            .await
        }
    });
    for result in join_all(jobs).await {
        result?;
    }
    tokio::fs::remove_file(marker).await?;
    Ok(())
}

async fn download_span(
    request: DownloadRequest<'_>,
    start: u64,
    end: u64,
    total: u64,
    etag: &str,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let DownloadRequest {
        client,
        url,
        auth,
        part_path,
    } = request;
    let response = send_range(
        &client,
        url,
        auth,
        start,
        Some(end),
        Some(RangeCondition::IfMatch(etag)),
    )
    .await?;
    let status = response.status().as_u16();
    if status == 200 {
        return Err(retryable_protocol(
            "range download ignored by server",
            json!({ "start": start, "end": end }),
        ));
    }
    if status != 206 {
        if status == 412 {
            return Err(retryable_protocol(
                "result download entity changed",
                json!({ "httpStatus": status }),
            ));
        }
        return Err(http_error(status, response).await);
    }
    let range = validate_range(response.headers(), start, Some(end), Some(total))?;
    validate_etag(response.headers(), etag)?;
    let mut file = open_part(part_path, false).await?;
    file.seek(SeekFrom::Start(start)).await?;
    stream_into(&mut file, response, Some(range.len()), stall, progress).await
}

async fn stream_full(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let response = auth
        .apply(client.get(url), url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(http_error(status, response).await);
    }
    let total = header_u64(response.headers(), "content-length");
    progress.set_total(total);
    let mut file = open_part(part_path, true).await?;
    persist_identity(part_path, url, response.headers(), total).await?;
    stream_into(&mut file, response, total, stall, progress).await
}

enum RangeCondition<'a> {
    IfMatch(&'a str),
    IfRange(&'a str),
}

async fn send_range(
    client: &reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    start: u64,
    end: Option<u64>,
    condition: Option<RangeCondition<'_>>,
) -> BackendResult<reqwest::Response> {
    let range = match end {
        Some(end) => format!("bytes={start}-{end}"),
        None => format!("bytes={start}-"),
    };
    let request = auth
        .apply(client.get(url), url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::RANGE, range);
    let request = match condition {
        Some(RangeCondition::IfMatch(etag)) => request.header(reqwest::header::IF_MATCH, etag),
        Some(RangeCondition::IfRange(etag)) => request.header(reqwest::header::IF_RANGE, etag),
        None => request,
    };
    Ok(request.send().await?)
}

async fn stream_into(
    file: &mut tokio::fs::File,
    response: reqwest::Response,
    expected: Option<u64>,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let mut stream = response.bytes_stream();
    let mut received = 0_u64;
    loop {
        match tokio::time::timeout(stall, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                received += chunk.len() as u64;
                if expected.is_some_and(|length| received > length) {
                    return Err(retryable_protocol(
                        "result download exceeded expected byte count",
                        json!({ "expected": expected, "received": received }),
                    ));
                }
                file.write_all(&chunk).await?;
                progress.add(chunk.len() as u64);
            }
            Ok(Some(Err(error))) => return Err(error.into()),
            Ok(None) => {
                file.flush().await?;
                if expected.is_some_and(|length| received != length) {
                    return Err(retryable_protocol(
                        "result download ended before expected byte count",
                        json!({ "expected": expected, "received": received }),
                    ));
                }
                return Ok(());
            }
            Err(_) => {
                return Err(retryable_protocol(
                    "result download stalled",
                    json!({ "stallMs": stall.as_millis() }),
                ));
            }
        }
    }
}

async fn drop_body(response: reqwest::Response, stall: Duration) -> BackendResult<()> {
    let mut stream = response.bytes_stream();
    loop {
        match tokio::time::timeout(stall, stream.next()).await {
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => return Err(error.into()),
            Ok(None) => return Ok(()),
            Err(_) => {
                return Err(retryable_protocol(
                    "result download stalled",
                    json!({ "stallMs": stall.as_millis() }),
                ));
            }
        }
    }
}

async fn open_part(path: &Path, truncate: bool) -> BackendResult<tokio::fs::File> {
    Ok(tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(truncate)
        .open(path)
        .await?)
}

fn split_ranges(total: u64, parts: u32) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let parts = u64::from(parts.max(1)).min(total);
    let chunk = total.div_ceil(parts);
    (0..parts)
        .filter_map(|index| {
            let start = index * chunk;
            if start >= total {
                return None;
            }
            let end = (start + chunk - 1).min(total - 1);
            Some((start, end))
        })
        .collect()
}

fn header_u64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}

#[derive(Serialize, Deserialize)]
struct PartialIdentity {
    etag: String,
    total: u64,
    // A validator only identifies versions of one resource. Hash the exact URL
    // to bind the sidecar without retaining signed URLs or their credentials.
    url_sha256: String,
}

fn is_strong_etag(value: &str) -> bool {
    value.len() >= 2
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|byte| *byte >= 0x21 && *byte != b'"' && *byte != 0x7f)
}

fn strong_etag(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| is_strong_etag(value))
        .map(ToOwned::to_owned)
}

fn validate_etag(headers: &reqwest::header::HeaderMap, expected: &str) -> BackendResult<()> {
    if strong_etag(headers).as_deref() == Some(expected) {
        return Ok(());
    }
    Err(retryable_protocol(
        "result download entity validator changed or is missing",
        json!({}),
    ))
}

fn identity_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".identity");
    PathBuf::from(name)
}

async fn remove_identity(part_path: &Path) -> BackendResult<()> {
    match tokio::fs::remove_file(identity_path(part_path)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn persist_identity(
    part_path: &Path,
    url: &str,
    headers: &reqwest::header::HeaderMap,
    total: Option<u64>,
) -> BackendResult<()> {
    // Call only after truncating the corresponding file: an interrupted sidecar
    // update must never bind a new entity to a previous entity's prefix.
    if let (Some(etag), Some(total)) = (strong_etag(headers), total.filter(|total| *total > 0)) {
        let identity = PartialIdentity {
            etag,
            total,
            url_sha256: hex::encode(Sha256::digest(url.as_bytes())),
        };
        tokio::fs::write(identity_path(part_path), serde_json::to_vec(&identity)?).await?;
    } else {
        remove_identity(part_path).await?;
    }
    Ok(())
}

async fn read_identity(part_path: &Path, url: &str, have: u64) -> Option<PartialIdentity> {
    let bytes = tokio::fs::read(identity_path(part_path)).await.ok()?;
    let identity: PartialIdentity = serde_json::from_slice(&bytes).ok()?;
    (identity.total > 0
        && have <= identity.total
        && is_strong_etag(&identity.etag)
        && identity.url_sha256 == hex::encode(Sha256::digest(url.as_bytes())))
    .then_some(identity)
}

fn parallel_marker_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".parallel");
    PathBuf::from(name)
}

#[derive(Debug, Clone, Copy)]
struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

impl ContentRange {
    fn len(self) -> u64 {
        self.end - self.start + 1
    }
}

fn content_range(headers: &reqwest::header::HeaderMap) -> Option<ContentRange> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let (span, total) = value.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let range = ContentRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
        total: total.parse().ok()?,
    };
    (range.start <= range.end && range.end < range.total).then_some(range)
}

fn validate_range(
    headers: &reqwest::header::HeaderMap,
    start: u64,
    end: Option<u64>,
    total: Option<u64>,
) -> BackendResult<ContentRange> {
    if let Some(range) = content_range(headers)
        && range.start == start
        && range.end == end.unwrap_or(range.total - 1)
        && total.is_none_or(|total| range.total == total)
        && header_u64(headers, "content-length").is_none_or(|length| length == range.len())
    {
        return Ok(range);
    }
    Err(retryable_protocol(
        "result download returned an inconsistent byte range",
        json!({
            "start": start,
            "end": end,
            "total": total,
            "contentRange": headers.get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()),
            "contentLength": header_u64(headers, "content-length"),
        }),
    ))
}

fn retryable_protocol(message: impl Into<String>, mut details: serde_json::Value) -> BackendError {
    if let Some(object) = details.as_object_mut() {
        object.insert("retryable".into(), json!(true));
    }
    BackendError::protocol(message, details)
}

pub fn is_retryable_transfer(error: &BackendError) -> bool {
    matches!(error, BackendError::Transport(_))
        || matches!(error, BackendError::Protocol { details, .. } if details
            .get("httpStatus")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|status| (500..600).contains(&status))
            || details.get("retryable").and_then(serde_json::Value::as_bool) == Some(true))
}

async fn http_error(status: u16, response: reqwest::Response) -> BackendError {
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or("<non-UTF8 header>").to_string(),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let raw_response =
        String::from_utf8_lossy(&response.bytes().await.unwrap_or_default()).into_owned();
    BackendError::protocol(
        format!("result download returned HTTP {status}"),
        json!({ "httpStatus": status, "headers": headers, "rawResponse": raw_response }),
    )
}

type ProgressCallback = Arc<Mutex<Box<dyn FnMut(TransferProgress) + Send>>>;

struct ProgressEmitter {
    started: Instant,
    last_emit: Arc<Mutex<Instant>>,
    received: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
    on_progress: ProgressCallback,
}

impl ProgressEmitter {
    fn new(received: u64, on_progress: impl FnMut(TransferProgress) + Send + 'static) -> Self {
        let emitter = Self {
            started: Instant::now(),
            last_emit: Arc::new(Mutex::new(Instant::now())),
            received: Arc::new(AtomicU64::new(received)),
            total: Arc::new(AtomicU64::new(0)),
            on_progress: Arc::new(Mutex::new(Box::new(on_progress))),
        };
        // 探测 Content-Length / 建连可能要好几秒，先把 0 B 推到卡片，避免看起来像卡死。
        emitter.emit_now();
        emitter
    }

    fn set_total(&self, total: Option<u64>) {
        self.total.store(total.unwrap_or(0), Ordering::Relaxed);
        self.emit_now();
    }

    fn reset_received(&self) {
        self.received.store(0, Ordering::Relaxed);
    }

    fn add(&self, n: u64) {
        self.received.fetch_add(n, Ordering::Relaxed);
        self.emit(false);
    }

    fn emit_now(&self) {
        self.emit(true);
    }

    fn emit(&self, force: bool) {
        let mut last = self
            .last_emit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !force && last.elapsed() < Duration::from_millis(200) {
            return;
        }
        *last = Instant::now();
        drop(last);
        let received = self.received.load(Ordering::Relaxed);
        let total_raw = self.total.load(Ordering::Relaxed);
        let total = (total_raw > 0).then_some(total_raw);
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        let progress = TransferProgress {
            received,
            total,
            bytes_per_sec: received as f64 / elapsed,
        };
        (self
            .on_progress
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))(progress);
    }
}

impl Clone for ProgressEmitter {
    fn clone(&self) -> Self {
        Self {
            started: self.started,
            last_emit: Arc::clone(&self.last_emit),
            received: Arc::clone(&self.received),
            total: Arc::clone(&self.total),
            on_progress: Arc::clone(&self.on_progress),
        }
    }
}
