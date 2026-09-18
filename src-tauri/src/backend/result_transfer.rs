//! 生成结果直链落盘：卡住才失败、断点续传、大文件多路 Range。
//!
//! 供应商 CDN 可能把单连接压到十几 KB/s。旧实现用 90 秒总超时，慢但还在走的
//! 下载会被判失败，已下字节随重试丢掉，大约 10 分钟后彻底放弃。这里改为：
//! - 只要还在进数据就不超时；连续收不到新字节才算卡住；
//! - 已写入的 `.download` 临时文件下次接着传；
//! - 对支持 206 的大文件拆成最多 4 路并行 Range，绕过按连接限速。

use std::{
    io::SeekFrom,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::{StreamExt, future::join_all};
use serde_json::json;
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
    let probe = send_range(&client, url, auth, 0, Some(0)).await?;
    let status = probe.status().as_u16();
    if status == 206 {
        let total = content_range_total(probe.headers())
            .or_else(|| header_u64(probe.headers(), "content-length"));
        drop_body(probe, policy.stall).await?;
        let Some(total) = total.filter(|value| *value > 0) else {
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
            return download_parallel(client, url, auth, part_path, total, policy, progress).await;
        }
        return stream_range(
            client,
            url,
            auth,
            part_path,
            0,
            None,
            policy.stall,
            progress,
        )
        .await;
    }
    if !(200..300).contains(&status) {
        return Err(http_error(status, probe).await);
    }
    let content_length = header_u64(probe.headers(), "content-length");
    progress.set_total(content_length);
    if content_length == Some(1) {
        drop_body(probe, policy.stall).await?;
        return stream_full(client, url, auth, part_path, policy.stall, progress).await;
    }
    let mut file = open_part(part_path, false).await?;
    stream_into(&mut file, probe, policy.stall, progress).await
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
    let response = send_range(&client, url, auth, have, None).await?;
    let status = response.status().as_u16();
    if status == 416 {
        drop_body(response, stall).await?;
        return Ok(());
    }
    if status == 206 {
        if let Some(total) = content_range_total(response.headers()) {
            progress.set_total(Some(total));
            if have >= total {
                drop_body(response, stall).await?;
                return Ok(());
            }
        }
        let mut file = open_part(part_path, false).await?;
        file.seek(SeekFrom::Start(have)).await?;
        return stream_into(&mut file, response, stall, progress).await;
    }
    if !(200..300).contains(&status) {
        return Err(http_error(status, response).await);
    }
    warn!(
        "[save] 续传 Range 被忽略，改为整段重下: url={}",
        redact_url_string(url)
    );
    progress.reset_received();
    let mut file = open_part(part_path, true).await?;
    if let Some(total) = header_u64(response.headers(), "content-length") {
        progress.set_total(Some(total));
    }
    stream_into(&mut file, response, stall, progress).await
}

async fn download_parallel(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    total: u64,
    policy: TransferPolicy,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let ranges = split_ranges(total, policy.max_parts);
    let file = open_part(part_path, true).await?;
    file.set_len(total).await?;
    drop(file);
    let jobs = ranges.into_iter().map(|(start, end)| {
        let client = client.clone();
        let auth = auth.clone();
        let url = url.to_string();
        let path = part_path.to_path_buf();
        let progress = progress.clone();
        async move {
            download_span(
                &client,
                &url,
                &auth,
                &path,
                start,
                end,
                policy.stall,
                &progress,
            )
            .await
        }
    });
    for result in join_all(jobs).await {
        result?;
    }
    Ok(())
}

async fn download_span(
    client: &reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    start: u64,
    end: u64,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let response = send_range(client, url, auth, start, Some(end)).await?;
    let status = response.status().as_u16();
    if status != 206 && !(status == 200 && start == 0) {
        return Err(http_error(status, response).await);
    }
    if status == 200 {
        if let Some(length) = header_u64(response.headers(), "content-length")
            && length != end - start + 1
        {
            return Err(retryable_protocol(
                "range download ignored by server",
                json!({ "start": start, "end": end, "contentLength": length }),
            ));
        }
    }
    let mut file = open_part(part_path, false).await?;
    file.seek(SeekFrom::Start(start)).await?;
    stream_into(&mut file, response, stall, progress).await
}

async fn stream_full(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let response = auth.apply(client.get(url), url).send().await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(http_error(status, response).await);
    }
    progress.set_total(header_u64(response.headers(), "content-length"));
    let mut file = open_part(part_path, true).await?;
    stream_into(&mut file, response, stall, progress).await
}

async fn stream_range(
    client: reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    part_path: &Path,
    start: u64,
    end: Option<u64>,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let response = send_range(&client, url, auth, start, end).await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(http_error(status, response).await);
    }
    if let Some(total) = content_range_total(response.headers())
        .or_else(|| header_u64(response.headers(), "content-length"))
    {
        progress.set_total(Some(total));
    }
    let mut file = open_part(part_path, start == 0).await?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    stream_into(&mut file, response, stall, progress).await
}

async fn send_range(
    client: &reqwest::Client,
    url: &str,
    auth: &ResultDownloadAuth,
    start: u64,
    end: Option<u64>,
) -> BackendResult<reqwest::Response> {
    let range = match end {
        Some(end) => format!("bytes={start}-{end}"),
        None => format!("bytes={start}-"),
    };
    Ok(auth
        .apply(client.get(url), url)
        .header(reqwest::header::RANGE, range)
        .send()
        .await?)
}

async fn stream_into(
    file: &mut tokio::fs::File,
    response: reqwest::Response,
    stall: Duration,
    progress: &ProgressEmitter,
) -> BackendResult<()> {
    let mut stream = response.bytes_stream();
    loop {
        match tokio::time::timeout(stall, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                file.write_all(&chunk).await?;
                progress.add(chunk.len() as u64);
            }
            Ok(Some(Err(error))) => return Err(error.into()),
            Ok(None) => {
                file.flush().await?;
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

fn content_range_total(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let total = value.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse().ok()
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

struct ProgressEmitter {
    started: Instant,
    last_emit: Arc<Mutex<Instant>>,
    received: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
    on_progress: Arc<Mutex<Box<dyn FnMut(TransferProgress) + Send>>>,
}

impl ProgressEmitter {
    fn new(received: u64, on_progress: impl FnMut(TransferProgress) + Send + 'static) -> Self {
        Self {
            started: Instant::now(),
            last_emit: Arc::new(Mutex::new(Instant::now())),
            received: Arc::new(AtomicU64::new(received)),
            total: Arc::new(AtomicU64::new(0)),
            on_progress: Arc::new(Mutex::new(Box::new(on_progress))),
        }
    }

    fn set_total(&self, total: Option<u64>) {
        self.total.store(total.unwrap_or(0), Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read as _, Write as _},
        net::TcpListener,
        thread,
        time::Duration,
    };

    fn test_policy() -> TransferPolicy {
        TransferPolicy {
            stall: Duration::from_millis(250),
            overall: Duration::from_secs(4),
            parallel_min: 8,
            max_parts: 4,
        }
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(2))
            .build()
            .expect("client")
    }

    fn serve_once(
        listener: TcpListener,
        write: impl FnOnce(&mut std::net::TcpStream) + Send + 'static,
    ) {
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            write(&mut stream);
        });
    }

    fn serve_many(
        listener: TcpListener,
        handler: impl Fn(String, &mut std::net::TcpStream) + Send + Sync + 'static,
    ) {
        let handler = Arc::new(handler);
        thread::spawn(move || {
            listener.set_nonblocking(false).ok();
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                handler(request, &mut stream);
            }
        });
    }

    #[test]
    fn split_ranges_cover_the_whole_file_without_overlap() {
        assert_eq!(split_ranges(16, 4), vec![(0, 3), (4, 7), (8, 11), (12, 15)]);
        assert_eq!(split_ranges(10, 3), vec![(0, 3), (4, 7), (8, 9)]);
        assert_eq!(split_ranges(1, 4), vec![(0, 0)]);
    }

    #[tokio::test]
    async fn trickle_within_stall_window_succeeds() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        serve_once(listener, |stream| {
            let body = b"hello-media";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            for byte in body {
                stream.write_all(&[*byte]).unwrap();
                stream.flush().unwrap();
                thread::sleep(Duration::from_millis(40));
            }
        });
        let dir = tempfile::tempdir().expect("temp");
        let part = dir.path().join("a.download");
        let bytes = download_result(
            test_client(),
            &format!("http://127.0.0.1:{port}/file.bin"),
            &ResultDownloadAuth::default(),
            &part,
            test_policy(),
            |_| {},
        )
        .await
        .expect("trickle succeeds");
        assert_eq!(bytes, b"hello-media");
    }

    #[tokio::test]
    async fn stall_without_new_bytes_is_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        serve_once(listener, |stream| {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nX")
                .unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_millis(800));
        });
        let dir = tempfile::tempdir().expect("temp");
        let part = dir.path().join("stall.download");
        let error = download_result(
            test_client(),
            &format!("http://127.0.0.1:{port}/file.bin"),
            &ResultDownloadAuth::default(),
            &part,
            test_policy(),
            |_| {},
        )
        .await
        .expect_err("stall fails");
        assert!(is_retryable_transfer(&error), "{error}");
        assert!(
            tokio::fs::read(&part).await.unwrap_or_default() == b"X"
                || tokio::fs::metadata(&part).await.is_ok()
        );
    }

    #[tokio::test]
    async fn resume_appends_from_partial_file() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        serve_many(listener, |request, stream| {
            if request.to_ascii_lowercase().contains("range: bytes=4-") {
                let body = b"5678";
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-7/8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            } else {
                stream
                    .write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */8\r\nConnection: close\r\n\r\n")
                    .unwrap();
            }
        });
        let dir = tempfile::tempdir().expect("temp");
        let part = dir.path().join("resume.download");
        tokio::fs::write(&part, b"0123").await.expect("seed");
        let bytes = download_result(
            test_client(),
            &format!("http://127.0.0.1:{port}/file.bin"),
            &ResultDownloadAuth::default(),
            &part,
            test_policy(),
            |_| {},
        )
        .await
        .expect("resume succeeds");
        assert_eq!(bytes, b"01235678");
    }

    #[tokio::test]
    async fn parallel_range_assembles_the_whole_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let body = b"abcdefghijklmnop";
        serve_many(listener, move |request, stream| {
            let lower = request.to_ascii_lowercase();
            if let Some(range) = lower
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
            {
                let range = range.trim();
                if range == "0-0" {
                    stream
                        .write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/16\r\nContent-Length: 1\r\nConnection: close\r\n\r\na")
                        .unwrap();
                    return;
                }
                let (start, end) = range.split_once('-').unwrap();
                let start: usize = start.parse().unwrap();
                let end: usize = end.parse().unwrap();
                let slice = &body[start..=end];
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/16\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    slice.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(slice).unwrap();
                return;
            }
            stream
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let dir = tempfile::tempdir().expect("temp");
        let part = dir.path().join("parallel.download");
        let bytes = download_result(
            test_client(),
            &format!("http://127.0.0.1:{port}/file.bin"),
            &ResultDownloadAuth::default(),
            &part,
            test_policy(),
            |_| {},
        )
        .await
        .expect("parallel succeeds");
        assert_eq!(bytes, body);
    }
}
