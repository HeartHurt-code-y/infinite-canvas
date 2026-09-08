//! Local, origin-clean video previews. Stable media identities are resolved afresh here;
//! preview paths and cache leases never replace generation inputs or enter canvas history.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use fs2::FileExt as _;
use futures_util::{StreamExt as _, future::BoxFuture};
use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use uuid::Uuid;

use super::{
    BackendState,
    asset_library::AssetLibrary,
    error::{BackendError, BackendResult, CommandResult, IntoCommandResult as _},
    local_results::LocalResultService,
    staging::{StagingService, fake_ip_aware_client},
    types::{CloudAssetIdentity, MediaReferenceTarget, MediaType, SaveStatus},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedVideoEditSource {
    pub preview_id: String,
    pub path: String,
}

trait SourceRecords: Send + Sync {
    fn asset_url(&self, identity: CloudAssetIdentity) -> BoxFuture<'_, BackendResult<String>>;
    fn local_asset_url(&self, job_id: &str) -> BackendResult<String>;
    fn local_result_path<'a>(
        &'a self,
        task_id: &'a str,
        result_index: u32,
    ) -> BoxFuture<'a, BackendResult<String>>;
}

struct ProjectSourceRecords {
    assets: AssetLibrary,
    staging: StagingService,
    results: LocalResultService,
}

impl SourceRecords for ProjectSourceRecords {
    fn asset_url(&self, identity: CloudAssetIdentity) -> BoxFuture<'_, BackendResult<String>> {
        Box::pin(self.assets.preview_content_url(identity, MediaType::Video))
    }

    fn local_asset_url(&self, job_id: &str) -> BackendResult<String> {
        Ok(self
            .staging
            .local_asset_lease(job_id, MediaType::Video)?
            .get_url)
    }

    fn local_result_path<'a>(
        &'a self,
        task_id: &'a str,
        result_index: u32,
    ) -> BoxFuture<'a, BackendResult<String>> {
        Box::pin(async move {
            let record = self
                .results
                .verify_local_result(task_id, result_index)
                .await?;
            if record.save_status != SaveStatus::Succeeded || record.media_type != MediaType::Video
            {
                return Err(BackendError::validation(
                    "本地视频结果不存在、已被修改或尚未保存完成。",
                    json!({ "generationTaskId": task_id, "resultIndex": result_index }),
                ));
            }
            record.final_path.ok_or_else(|| {
                BackendError::validation("本地视频结果没有可读取的文件。", json!({}))
            })
        })
    }
}

/// Each process holds an OS file lock. A later process may collect only unlocked
/// session directories bearing this service's marker, including interrupted downloads.
struct PreviewCache {
    directory: PathBuf,
    session_lock: Option<File>,
}

impl PreviewCache {
    fn new(root: &Path) -> BackendResult<Self> {
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        cleanup_stale_sessions(&root);
        let directory = root.join(format!("session-{}", Uuid::new_v4()));
        fs::create_dir(&directory)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join(".preview-session.lock"))?;
        lock.try_lock_exclusive()?;
        Ok(Self {
            directory,
            session_lock: Some(lock),
        })
    }
}

impl Drop for PreviewCache {
    fn drop(&mut self) {
        // Closing the lock allows the next app start to retry files still held by a WebView.
        self.session_lock.take();
        remove_session_files(&self.directory);
    }
}

fn cleanup_stale_sessions(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_prefix("session-") else {
            continue;
        };
        if Uuid::parse_str(id).is_err()
            || !entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        {
            continue;
        }
        let path = entry.path();
        // Never follow a symlink or remove anything outside the dedicated cache root.
        if !fs::canonicalize(&path).is_ok_and(|resolved| resolved.parent() == Some(root)) {
            continue;
        }
        let Ok(lock) = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join(".preview-session.lock"))
        else {
            continue;
        };
        if lock.try_lock_exclusive().is_err() {
            continue;
        }
        // Windows cannot rename a directory containing an open lock file. The session
        // UUID is never reused, so cleanup can release the lock before removing its marker.
        remove_preview_files(&path);
        drop(lock);
        remove_session_files(&path);
    }
}

fn remove_preview_files(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let owned = name
            .to_str()
            .and_then(|name| name.strip_prefix("preview-"))
            .and_then(|name| name.rsplit_once('.'))
            .is_some_and(|(id, _)| Uuid::parse_str(id).is_ok());
        if owned
            && entry
                .file_type()
                .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn remove_session_files(directory: &Path) {
    remove_preview_files(directory);
    // Keep the marker if a WebView still has a media file open: retry next startup.
    let only_marker = fs::read_dir(directory).is_ok_and(|entries| {
        entries
            .flatten()
            .all(|entry| entry.file_name() == ".preview-session.lock")
    });
    if only_marker {
        let _ = fs::remove_file(directory.join(".preview-session.lock"));
        let _ = fs::remove_dir(directory);
    }
}

struct PendingPreview {
    path: PathBuf,
    keep: bool,
}

impl Drop for PendingPreview {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Clone)]
pub struct VideoEditSourceService {
    records: Arc<dyn SourceRecords>,
    client: reqwest::Client,
    cache: Arc<PreviewCache>,
    // None denotes a user's own local file: releasing that lease must never delete it.
    leases: Arc<Mutex<HashMap<String, Option<PathBuf>>>>,
}

impl VideoEditSourceService {
    pub fn new(
        assets: AssetLibrary,
        staging: StagingService,
        results: LocalResultService,
        directory: PathBuf,
    ) -> BackendResult<Self> {
        // Keep the project's native proxy/TLS and timeout behavior. Redirects are explicit
        // so every new host gets its own fake-IP resolution, without forwarding credentials.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("InfiniteCanvas/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Self::with_records(
            Arc::new(ProjectSourceRecords {
                assets,
                staging,
                results,
            }),
            client,
            &directory,
        )
    }

    fn with_records(
        records: Arc<dyn SourceRecords>,
        client: reqwest::Client,
        directory: &Path,
    ) -> BackendResult<Self> {
        Ok(Self {
            records,
            client,
            cache: Arc::new(PreviewCache::new(directory)?),
            leases: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn prepare(
        &self,
        target: &MediaReferenceTarget,
    ) -> BackendResult<PreparedVideoEditSource> {
        if target.media_type() != MediaType::Video {
            return Err(BackendError::validation(
                "局部视频编辑需要视频素材。",
                json!({}),
            ));
        }
        let (path, owned) = match target {
            MediaReferenceTarget::LocalFile { path, .. } => {
                (readable_local_path(path).await?, false)
            }
            MediaReferenceTarget::LocalResult {
                generation_task_id,
                result_index,
                ..
            } => {
                let path = self
                    .records
                    .local_result_path(generation_task_id, *result_index)
                    .await?;
                (readable_local_path(&path).await?, false)
            }
            MediaReferenceTarget::Asset {
                provider_connection_id,
                asset_id,
                ..
            } => {
                let url = self
                    .records
                    .asset_url(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.clone(),
                        asset_id: asset_id.clone(),
                    })
                    .await?;
                (self.download(&url).await?, true)
            }
            MediaReferenceTarget::LocalAsset { staging_job_id, .. } => {
                let url = self.records.local_asset_url(staging_job_id)?;
                (self.download(&url).await?, true)
            }
            MediaReferenceTarget::Url { url, .. } => (self.download(url).await?, true),
        };
        let preview_id = Uuid::new_v4().to_string();
        self.leases
            .lock()
            .expect("video preview leases poisoned")
            .insert(preview_id.clone(), owned.then(|| path.clone()));
        Ok(PreparedVideoEditSource {
            preview_id,
            path: path.to_string_lossy().into_owned(),
        })
    }

    async fn download(&self, url: &str) -> BackendResult<PathBuf> {
        let mut parsed = url::Url::parse(url)
            .map_err(|_| BackendError::validation("视频链接无效。", json!({})))?;
        let mut redirects = 0;
        let response = loop {
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(BackendError::validation(
                    "远程视频及跳转目标需要 HTTP 或 HTTPS 地址。",
                    json!({}),
                ));
            }
            // Literal IPs already identify the destination and need no DNS replacement.
            let client = if matches!(parsed.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_))) {
                self.client.clone()
            } else {
                fake_ip_aware_client(parsed.as_str(), self.client.clone()).await
            };
            let response = client
                .get(parsed.clone())
                .send()
                .await
                .map_err(redacted_transport)?;
            if !response.status().is_redirection() {
                break response;
            }
            if redirects == 5 {
                return Err(BackendError::protocol(
                    "视频链接跳转次数过多，请使用最终的视频地址。",
                    json!({}),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    BackendError::protocol("视频链接没有返回有效的跳转地址。", json!({}))
                })?;
            parsed = parsed
                .join(location)
                .map_err(|_| BackendError::validation("视频链接跳转地址无效。", json!({})))?;
            redirects += 1;
        };
        if !response.status().is_success() {
            return Err(BackendError::protocol(
                format!(
                    "视频下载失败（HTTP {}），请检查素材读取权限或链接是否过期。",
                    response.status().as_u16()
                ),
                json!({ "httpStatus": response.status().as_u16() }),
            ));
        }
        let mut pending = PendingPreview {
            path: self
                .cache
                .directory
                .join(format!("preview-{}.part", Uuid::new_v4())),
            keep: false,
        };
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending.path)
            .await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk.map_err(redacted_transport)?).await?;
        }
        file.flush().await?;
        drop(file);
        let mut header = vec![0_u8; 16 * 1024];
        let read = tokio::fs::File::open(&pending.path)
            .await?
            .read(&mut header)
            .await?;
        let detected = infer::get(&header[..read])
            .filter(|kind| kind.mime_type().starts_with("video/"))
            .ok_or_else(|| {
                BackendError::validation(
                    "下载内容不是可识别的视频文件，请确认链接指向视频正文。",
                    json!({}),
                )
            })?;
        let destination = pending.path.with_extension(detected.extension());
        tokio::fs::rename(&pending.path, &destination).await?;
        pending.path = destination.clone();
        pending.keep = true;
        Ok(destination)
    }

    pub async fn release(&self, preview_id: &str) -> BackendResult<()> {
        let path = self
            .leases
            .lock()
            .expect("video preview leases poisoned")
            .get(preview_id)
            .cloned();
        if let Some(Some(path)) = path {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        self.leases
            .lock()
            .expect("video preview leases poisoned")
            .remove(preview_id);
        Ok(())
    }
}

fn redacted_transport(error: reqwest::Error) -> BackendError {
    BackendError::Transport(error.without_url())
}

async fn readable_local_path(path: &str) -> BackendResult<PathBuf> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| BackendError::validation("本地视频文件不存在或无法读取。", json!({})))?;
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(BackendError::validation(
            "本地视频必须是非空文件。",
            json!({}),
        ));
    }
    tokio::fs::File::open(&path).await?;
    Ok(path)
}

#[tauri::command]
pub async fn prepare_video_edit_source(
    state: tauri::State<'_, BackendState>,
    target: MediaReferenceTarget,
) -> CommandResult<PreparedVideoEditSource> {
    state.video_edit_sources.prepare(&target).await.command()
}

#[tauri::command]
pub async fn release_video_edit_source(
    state: tauri::State<'_, BackendState>,
    preview_id: String,
) -> CommandResult<()> {
    state
        .video_edit_sources
        .release(&preview_id)
        .await
        .command()
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read as _, Write as _},
        net::TcpListener,
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    #[derive(Default)]
    struct TestRecords {
        remote_url: String,
        result_path: String,
        requests: Mutex<Vec<String>>,
    }

    impl SourceRecords for TestRecords {
        fn asset_url(&self, identity: CloudAssetIdentity) -> BoxFuture<'_, BackendResult<String>> {
            self.requests.lock().unwrap().push(format!(
                "asset:{}:{}",
                identity.provider_connection_id, identity.asset_id
            ));
            Box::pin(async { Ok(self.remote_url.clone()) })
        }
        fn local_asset_url(&self, job_id: &str) -> BackendResult<String> {
            self.requests
                .lock()
                .unwrap()
                .push(format!("local_asset:{job_id}"));
            Ok(self.remote_url.clone())
        }
        fn local_result_path<'a>(
            &'a self,
            task_id: &'a str,
            result_index: u32,
        ) -> BoxFuture<'a, BackendResult<String>> {
            self.requests
                .lock()
                .unwrap()
                .push(format!("local_result:{task_id}:{result_index}"));
            Box::pin(async { Ok(self.result_path.clone()) })
        }
    }

    fn video_bytes() -> Vec<u8> {
        b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom\x00\x00\x00\x08mdat".to_vec()
    }

    fn server(
        reply: impl Fn(&str, usize, &str) -> Vec<u8> + Send + 'static,
        requests: usize,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let origin = url.clone();
        let worker = thread::spawn(move || {
            for index in 0..requests {
                let deadline = Instant::now() + Duration::from_secs(10);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "video test HTTP request did not arrive"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut bytes = [0_u8; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = stream.read(&mut bytes).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&bytes[..count]);
                }
                stream
                    .write_all(&reply(&origin, index, &String::from_utf8_lossy(&request)))
                    .unwrap();
            }
        });
        (url, worker)
    }

    fn ok_video() -> Vec<u8> {
        let body = video_bytes();
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend(body);
        response
    }

    fn service(directory: &Path, records: Arc<TestRecords>) -> VideoEditSourceService {
        VideoEditSourceService::with_records(
            records,
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            directory,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn video_edit_source_downloads_redirect_without_cors_and_releases_only_owned_copy() {
        let directory = tempfile::tempdir().unwrap();
        let (url, server) = server(
            |origin, index, request| {
                if index == 0 {
                    assert!(request.starts_with("GET /redirect?signature=secret "));
                    format!("HTTP/1.1 302 Found\r\nLocation: {origin}/media\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
                } else {
                    assert!(request.starts_with("GET /media "));
                    assert!(!request.to_ascii_lowercase().contains("authorization:"));
                    ok_video() // Deliberately lacks Access-Control-Allow-Origin.
                }
            },
            2,
        );
        let service = service(directory.path(), Arc::new(TestRecords::default()));
        let preview = service
            .prepare(&MediaReferenceTarget::Url {
                url: format!("{url}/redirect?signature=secret"),
                media_type: MediaType::Video,
                canvas_node_key: Some("video-a".into()),
            })
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(&preview.path).unwrap(), video_bytes());
        assert!(Path::new(&preview.path).starts_with(directory.path().canonicalize().unwrap()));
        assert!(preview.path.ends_with(".mp4"));
        service.release("../../outside.mp4").await.unwrap();
        assert!(Path::new(&preview.path).exists());
        service.release(&preview.preview_id).await.unwrap();
        service.release(&preview.preview_id).await.unwrap();
        assert!(!Path::new(&preview.path).exists());
    }

    #[tokio::test]
    async fn video_edit_source_resolves_all_stable_sources_and_never_deletes_originals() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.mp4");
        fs::write(&original, video_bytes()).unwrap();
        let (url, server) = server(|_, _, _| ok_video(), 2);
        let records = Arc::new(TestRecords {
            remote_url: format!("{url}/fresh-signed-video"),
            result_path: original.to_string_lossy().into_owned(),
            ..TestRecords::default()
        });
        let service = service(&directory.path().join("cache"), Arc::clone(&records));
        let sources = [
            MediaReferenceTarget::Asset {
                provider_connection_id: "cloud-original".into(),
                asset_id: "asset-video-1".into(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            MediaReferenceTarget::LocalAsset {
                staging_job_id: "upload-job-2".into(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            MediaReferenceTarget::LocalResult {
                generation_task_id: "generation-3".into(),
                result_index: 4,
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            MediaReferenceTarget::LocalFile {
                path: original.to_string_lossy().into_owned(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
        ];
        for (index, source) in sources.iter().enumerate() {
            let preview = service.prepare(source).await.unwrap();
            assert_eq!(fs::read(&preview.path).unwrap(), video_bytes());
            if index >= 2 {
                assert_eq!(Path::new(&preview.path), original.canonicalize().unwrap());
            }
            service.release(&preview.preview_id).await.unwrap();
            assert!(original.exists());
        }
        server.join().unwrap();
        assert_eq!(
            *records.requests.lock().unwrap(),
            [
                "asset:cloud-original:asset-video-1",
                "local_asset:upload-job-2",
                "local_result:generation-3:4"
            ]
        );
    }

    #[tokio::test]
    async fn video_edit_source_bounds_redirects_and_rejects_non_http_targets() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path(), Arc::new(TestRecords::default()));
        let (url, worker) = server(
            |_, _, _| {
                b"HTTP/1.1 302 Found\r\nLocation: file:///private?token=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            },
            1,
        );
        let error = service
            .prepare(&MediaReferenceTarget::Url {
                url,
                media_type: MediaType::Video,
                canvas_node_key: None,
            })
            .await
            .unwrap_err();
        assert!(
            !serde_json::to_string(&error.payload())
                .unwrap()
                .contains("secret")
        );
        worker.join().unwrap();
        let (url, worker) = server(
            |_, _, _| {
                b"HTTP/1.1 302 Found\r\nLocation: /again?signature=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            },
            6,
        );
        let error = service
            .prepare(&MediaReferenceTarget::Url {
                url,
                media_type: MediaType::Video,
                canvas_node_key: None,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("跳转次数过多"));
        assert!(
            !serde_json::to_string(&error.payload())
                .unwrap()
                .contains("secret")
        );
        worker.join().unwrap();
        assert_eq!(fs::read_dir(&service.cache.directory).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn video_edit_source_failed_or_non_video_download_leaves_no_partial_file_or_secret() {
        let directory = tempfile::tempdir().unwrap();
        let (url, server) = server(
            |_, index, _| {
                match index {
            0 => b"HTTP/1.1 403 Forbidden\r\nContent-Length: 18\r\nConnection: close\r\n\r\nupstream-secret!!!".to_vec(),
            1 => b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\npartial".to_vec(),
            _ => b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nhtml".to_vec(),
        }
            },
            3,
        );
        let service = service(directory.path(), Arc::new(TestRecords::default()));
        for _ in 0..3 {
            let error = service
                .prepare(&MediaReferenceTarget::Url {
                    url: format!("{url}/video?token=secret"),
                    media_type: MediaType::Video,
                    canvas_node_key: None,
                })
                .await
                .unwrap_err();
            let error = serde_json::to_string(&error.payload()).unwrap();
            assert!(!error.contains("secret"));
            assert_eq!(
                fs::read_dir(&service.cache.directory).unwrap().count(),
                1,
                "only session lock remains"
            );
            assert!(service.leases.lock().unwrap().is_empty());
        }
        server.join().unwrap();
    }

    #[tokio::test]
    async fn video_edit_source_rejects_missing_files_non_video_targets_and_non_http_urls() {
        let directory = tempfile::tempdir().unwrap();
        let records = Arc::new(TestRecords::default());
        let service = service(directory.path(), Arc::clone(&records));
        for target in [
            MediaReferenceTarget::LocalFile {
                path: directory
                    .path()
                    .join("missing.mp4")
                    .to_string_lossy()
                    .into_owned(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            MediaReferenceTarget::Url {
                url: "file:///outside.mp4".into(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            MediaReferenceTarget::Asset {
                provider_connection_id: "provider".into(),
                asset_id: "image-1".into(),
                media_type: MediaType::Image,
                canvas_node_key: None,
            },
        ] {
            assert!(service.prepare(&target).await.is_err());
        }
        assert!(records.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn video_edit_source_cancelled_download_removes_the_partial_file() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/slow", listener.local_addr().unwrap());
        let (sent, ready) = tokio::sync::oneshot::channel();
        let (close, closed) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0_u8; 2048];
            assert!(socket.read(&mut buffer).unwrap() > 0);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 200000\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            socket.write_all(&video_bytes()).unwrap();
            sent.send(()).unwrap();
            let _ = closed.recv_timeout(Duration::from_secs(5));
        });
        let service = service(root.path(), Arc::new(TestRecords::default()));
        let download_service = service.clone();
        let task = tokio::spawn(async move {
            download_service
                .prepare(&MediaReferenceTarget::Url {
                    url,
                    media_type: MediaType::Video,
                    canvas_node_key: None,
                })
                .await
        });
        ready.await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !fs::read_dir(&service.cache.directory)
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "part")
            })
        {
            assert!(
                Instant::now() < deadline,
                "download did not create its pending file"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(fs::read_dir(&service.cache.directory).unwrap().count(), 1);
        assert!(service.leases.lock().unwrap().is_empty());
        close.send(()).unwrap();
        worker.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "requires packaged FFmpeg binaries; run explicitly for cross-origin video preview validation"]
    async fn video_edit_source_real_mp4_survives_redirect_download_and_ffprobe() {
        let root = tempfile::tempdir().unwrap();
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ffmpeg");
        let ffmpeg = binaries.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        let ffprobe = binaries.join(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        assert!(
            ffmpeg.is_file() && ffprobe.is_file(),
            "prepare packaged FFmpeg first"
        );
        let original = root.path().join("original-three-seconds.mp4");
        let mut command = tokio::process::Command::new(ffmpeg);
        command
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:r=24",
                "-t",
                "3",
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&original)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let generated = command.output().await.unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let bytes = fs::read(&original).unwrap();
        let (url, worker) = server(
            move |origin, index, _| {
                if index == 0 {
                    format!("HTTP/1.1 302 Found\r\nLocation: {origin}/actual.mp4\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
                } else {
                    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).into_bytes();
                    response.extend_from_slice(&bytes);
                    response
                }
            },
            2,
        );
        let service = service(&root.path().join("cache"), Arc::new(TestRecords::default()));
        let preview = service
            .prepare(&MediaReferenceTarget::Url {
                url: format!("{url}/redirect"),
                media_type: MediaType::Video,
                canvas_node_key: None,
            })
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(
            fs::read(&preview.path).unwrap(),
            fs::read(&original).unwrap()
        );
        let mut probe = tokio::process::Command::new(ffprobe);
        probe
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(&preview.path)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        probe.creation_flags(0x08000000);
        let output = probe.output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let video = value["streams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|stream| stream["codec_type"] == "video")
            .unwrap();
        assert_eq!(video["width"], 320);
        assert_eq!(video["height"], 240);
        let duration = value["format"]["duration"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!((duration - 3.0).abs() < 0.01, "actual duration {duration}");
        service.release(&preview.preview_id).await.unwrap();
        assert!(!Path::new(&preview.path).exists());
        assert!(original.is_file());
    }

    #[test]
    fn video_edit_source_restart_cleans_stale_sessions_but_keeps_active_and_unrelated_files() {
        let root = tempfile::tempdir().unwrap();
        let active = PreviewCache::new(root.path()).unwrap();
        let active_file = active
            .directory
            .join(format!("preview-{}.mp4", Uuid::new_v4()));
        fs::write(&active_file, video_bytes()).unwrap();
        let stale = root.path().join(format!("session-{}", Uuid::new_v4()));
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join(".preview-session.lock"), []).unwrap();
        fs::write(
            stale.join(format!("preview-{}.part", Uuid::new_v4())),
            b"partial",
        )
        .unwrap();
        let unrelated = root.path().join("other-task");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("original.mp4"), video_bytes()).unwrap();
        let later = PreviewCache::new(root.path()).unwrap();
        assert!(active_file.exists());
        assert!(!stale.exists());
        assert!(unrelated.join("original.mp4").exists());
        drop(later);
        assert!(active_file.exists());
        drop(active);
        assert!(!active_file.exists());
        assert!(unrelated.join("original.mp4").exists());
    }
}
