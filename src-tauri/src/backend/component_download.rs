//! Resume only a content-addressed catalog object; never append an unvalidated HTTP range.
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use tokio::io::{AsyncSeekExt as _, AsyncWriteExt as _};
use url::Url;

use super::component_archive::{check_cancel, hash_file, is_link, valid_sha256};

#[derive(Debug, Clone, Copy)]
pub(crate) struct DownloadProgress {
    pub completed: u64,
    pub total: u64,
    pub reused: u64,
    pub downloaded: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumeMetadata {
    url: String,
    size: u64,
    sha256: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

fn read_resume(path: &Path, url: &Url, size: u64, digest: &str) -> Option<ResumeMetadata> {
    let metadata = path.symlink_metadata().ok()?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > 8192 {
        return None;
    }
    let record: ResumeMetadata = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (record.url == url.as_str() && record.size == size && record.sha256 == digest).then_some(record)
}

fn write_resume(path: &Path, record: &ResumeMetadata) -> Result<(), String> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| !metadata.is_file() || is_link(&metadata))
    {
        return Err("组件续传记录路径不可信".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().ok_or("续传目录无效")?)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(&serde_json::to_vec(record).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

async fn cancellable<F: Future>(
    future: F,
    cancel: &AtomicBool,
    duration: Duration,
) -> Result<F::Output, String> {
    let deadline = Instant::now() + duration;
    let mut future = Box::pin(future);
    loop {
        check_cancel(cancel)?;
        match tokio::time::timeout(Duration::from_millis(150), &mut future).await {
            Ok(output) => return Ok(output),
            Err(_) if Instant::now() >= deadline => {
                return Err("组件下载等待响应超时，已保存可续传部分".into());
            }
            Err(_) => {}
        }
    }
}

fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let range = value.strip_prefix("bytes ")?;
    let (span, total) = range.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

pub(crate) async fn download_zip(
    client: &Client,
    url: &Url,
    partial: &Path,
    size: u64,
    digest: &str,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<(), String> {
    if url.scheme() != "https" {
        #[cfg(not(test))]
        return Err("组件压缩包必须通过 HTTPS 下载".into());
        #[cfg(test)]
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
            return Err("测试组件地址不是本机 fixture".into());
        }
    }
    if !valid_sha256(digest) || size == 0 || size > 8 * 1024 * 1024 * 1024 {
        return Err("组件压缩包校验参数无效".into());
    }
    let parent = partial.parent().ok_or("组件下载缓存路径无效")?;
    let parent_metadata = parent
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if is_link(&parent_metadata) || !parent_metadata.is_dir() {
        return Err("组件下载缓存目录不可信".into());
    }
    let mut offset = match partial.symlink_metadata() {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => metadata.len(),
        Ok(_) => return Err("组件下载暂存文件是链接或特殊文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.to_string()),
    };
    let resume_path = partial.with_extension("resume.json");
    let resume = read_resume(&resume_path, url, size, digest);
    if offset == size {
        let path = partial.to_path_buf();
        let cancel_hash = Arc::clone(&cancel);
        let actual = tokio::task::spawn_blocking(move || hash_file(&path, &cancel_hash))
            .await
            .map_err(|error| error.to_string())??;
        if actual == (digest.to_string(), size) {
            progress(DownloadProgress {
                completed: size,
                total: size,
                reused: size,
                downloaded: 0,
            });
            return Ok(());
        }
        offset = 0;
    } else if offset > size || (offset > 0 && resume.is_none()) {
        offset = 0;
    }
    let mut restarted = false;
    loop {
        check_cancel(&cancel)?;
        let mut request = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(validator) = resume
                .as_ref()
                .and_then(|record| record.etag.as_ref().or(record.last_modified.as_ref()))
            {
                request = request.header(reqwest::header::IF_RANGE, validator);
            }
        }
        let response = cancellable(request.send(), &cancel, Duration::from_secs(30))
            .await?
            .map_err(|error| format!("组件下载失败：{error}"))?;
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 && !restarted {
            // Do not discard the old prefix until a valid full response arrives.
            offset = 0;
            restarted = true;
            continue;
        }
        let append = match response.status() {
            StatusCode::PARTIAL_CONTENT => {
                let range = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(content_range)
                    .ok_or("组件续传响应缺少有效 Content-Range")?;
                if range.0 != offset
                    || range.1 < range.0
                    || range.1 >= size
                    || range.2 != size
                    || response
                        .content_length()
                        .is_some_and(|length| length != range.1 - range.0 + 1)
                {
                    return Err("组件续传响应与当前压缩包不匹配".into());
                }
                true
            }
            StatusCode::OK => {
                if response
                    .content_length()
                    .is_some_and(|length| length != size)
                {
                    return Err("组件完整下载响应大小不匹配".into());
                }
                false
            }
            other => return Err(format!("组件下载失败：HTTP {other}")),
        };
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|value| value.as_bytes() != b"identity")
        {
            return Err("组件下载响应不能使用额外内容编码".into());
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.starts_with("W/") && value.len() <= 1024)
            .map(str::to_owned);
        let last_modified = response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 1024)
            .map(str::to_owned);
        if append
            && offset > 0
            && resume.as_ref().is_some_and(|record| {
                if let Some(expected) = &record.etag {
                    etag.as_ref() != Some(expected)
                } else if let Some(expected) = &record.last_modified {
                    last_modified.as_ref() != Some(expected)
                } else {
                    false
                }
            })
        {
            if restarted {
                return Err("组件续传对象版本反复改变".into());
            }
            offset = 0;
            restarted = true;
            continue;
        }
        let next_resume = ResumeMetadata {
            url: url.as_str().into(),
            size,
            sha256: digest.into(),
            etag,
            last_modified,
        };
        write_resume(&resume_path, &next_resume)?;
        let metadata = partial.symlink_metadata();
        if metadata
            .as_ref()
            .is_ok_and(|metadata| !metadata.is_file() || is_link(metadata))
        {
            return Err("组件暂存文件被替换".into());
        }
        let std_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(partial)
            .map_err(|error| error.to_string())?;
        let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
        if partial
            .canonicalize()
            .map_err(|error| error.to_string())?
            .parent()
            != Some(canonical_parent.as_path())
        {
            return Err("组件下载文件超出缓存目录".into());
        }
        let mut file = tokio::fs::File::from_std(std_file);
        if !append {
            file.set_len(0).await.map_err(|error| error.to_string())?;
            offset = 0;
        }
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| error.to_string())?;
        let reused = offset;
        let mut downloaded = 0u64;
        progress(DownloadProgress {
            completed: offset,
            total: size,
            reused,
            downloaded,
        });
        let mut stream = response.bytes_stream();
        let result = async {
            loop {
                let chunk = cancellable(stream.next(), &cancel, Duration::from_secs(60)).await?;
                let Some(chunk) = chunk else {
                    break;
                };
                let chunk = chunk.map_err(|error| format!("读取组件下载字节失败：{error}"))?;
                if offset
                    .checked_add(chunk.len() as u64)
                    .is_none_or(|next| next > size)
                {
                    return Err("组件下载超过可信压缩包大小".to_string());
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| error.to_string())?;
                offset += chunk.len() as u64;
                downloaded += chunk.len() as u64;
                progress(DownloadProgress {
                    completed: offset,
                    total: size,
                    reused,
                    downloaded,
                });
                check_cancel(&cancel)?;
            }
            if offset != size {
                return Err("组件下载尚不完整，已保存可续传部分".into());
            }
            Ok(())
        }
        .await;
        // Flush even on cancellation or a transient transport failure.
        file.sync_all().await.map_err(|error| error.to_string())?;
        result?;
        let path = partial.to_path_buf();
        let cancel_hash = Arc::clone(&cancel);
        let actual = tokio::task::spawn_blocking(move || hash_file(&path, &cancel_hash))
            .await
            .map_err(|error| error.to_string())??;
        if actual != (digest.to_string(), size) {
            return Err("组件完整压缩包 SHA-256 不匹配，重试将重新下载".into());
        }
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Read as _;
    use std::net::TcpListener;
    use std::sync::atomic::Ordering;
    fn fixture(
        responses: Vec<(&'static str, &'static str, &'static [u8])>,
    ) -> (Url, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/component.zip",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, headers, body) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                while !bytes.ends_with(b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                write!(
                    socket,
                    "HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n"
                )
                .unwrap();
                socket.write_all(body).unwrap();
            }
            requests
        });
        (url, thread)
    }
    fn client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    fn seed_resume(path: &Path, url: &Url) {
        write_resume(
            &path.with_extension("resume.json"),
            &ResumeMetadata {
                url: url.as_str().into(),
                size: 8,
                sha256: hex::encode(Sha256::digest(b"abcdefgh")),
                etag: Some("\"v1\"".into()),
                last_modified: None,
            },
        )
        .unwrap();
    }
    #[tokio::test]
    async fn resumes_206_and_restarts_when_200_ignores_range() {
        for partial_response in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("object.partial");
            std::fs::write(&path, b"abcd").unwrap();
            let response = if partial_response {
                (
                    "206 Partial Content",
                    "Content-Length: 4\r\nETag: \"v1\"\r\nContent-Range: bytes 4-7/8\r\n",
                    b"efgh".as_slice(),
                )
            } else {
                ("200 OK", "Content-Length: 8\r\n", b"abcdefgh".as_slice())
            };
            let (url, server) = fixture(vec![response]);
            seed_resume(&path, &url);
            download_zip(
                &client(),
                &url,
                &path,
                8,
                &hex::encode(Sha256::digest(b"abcdefgh")),
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"abcdefgh");
            assert!(
                server.join().unwrap()[0]
                    .to_lowercase()
                    .contains("range: bytes=4-")
            );
        }
    }
    #[tokio::test]
    async fn unsatisfiable_range_retries_full_without_appending() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("object.partial");
        std::fs::write(&path, b"abc").unwrap();
        let (url, server) = fixture(vec![
            (
                "416 Range Not Satisfiable",
                "Content-Length: 0\r\nContent-Range: bytes */8\r\n",
                b"",
            ),
            ("200 OK", "Content-Length: 8\r\n", b"abcdefgh"),
        ]);
        seed_resume(&path, &url);
        download_zip(
            &client(),
            &url,
            &path,
            8,
            &hex::encode(Sha256::digest(b"abcdefgh")),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].to_lowercase().contains("range: bytes=3-"));
        assert!(!requests[1].to_lowercase().contains("range:"));
        assert_eq!(std::fs::read(path).unwrap(), b"abcdefgh");
    }
    #[tokio::test]
    async fn cancellation_preserves_prefix_and_next_request_resumes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("object.partial");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/component.zip",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            socket.read(&mut buffer).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcd").unwrap();
            socket.flush().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            let _ = socket.write_all(b"efgh");
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&cancel);
        assert!(
            download_zip(
                &client(),
                &url,
                &path,
                8,
                &hex::encode(Sha256::digest(b"abcdefgh")),
                cancel,
                move |progress| {
                    if progress.downloaded > 0 {
                        signal.store(true, Ordering::Release);
                    }
                }
            )
            .await
            .is_err()
        );
        server.join().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abcd");
        let (url, server) = fixture(vec![(
            "206 Partial Content",
            "Content-Length: 4\r\nETag: \"v1\"\r\nContent-Range: bytes 4-7/8\r\n",
            b"efgh",
        )]);
        // Same immutable object, but the fixture uses a new listening port.
        seed_resume(&path, &url);
        download_zip(
            &client(),
            &url,
            &path,
            8,
            &hex::encode(Sha256::digest(b"abcdefgh")),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .unwrap();
        assert!(
            server.join().unwrap()[0]
                .to_lowercase()
                .contains("range: bytes=4-")
        );
    }
    #[tokio::test]
    async fn changed_etag_restarts_a_full_response() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("object.partial");
        std::fs::write(&path, b"abcd").unwrap();
        let (url, server) = fixture(vec![
            (
                "206 Partial Content",
                "Content-Length: 4\r\nETag: \"v2\"\r\nContent-Range: bytes 4-7/8\r\n",
                b"efgh",
            ),
            (
                "200 OK",
                "Content-Length: 8\r\nETag: \"v2\"\r\n",
                b"abcdefgh",
            ),
        ]);
        seed_resume(&path, &url);
        download_zip(
            &client(),
            &url,
            &path,
            8,
            &hex::encode(Sha256::digest(b"abcdefgh")),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].to_lowercase().contains("if-range: \"v1\""));
        assert!(!requests[1].to_lowercase().contains("range:"));
    }
}
