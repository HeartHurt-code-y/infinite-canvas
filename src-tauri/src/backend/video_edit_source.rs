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
    fn asset_url(&self, identity: CloudAssetIdentity, media_type: MediaType) -> BoxFuture<'_, BackendResult<String>>;
    fn local_asset_url(&self, job_id: &str, media_type: MediaType) -> BackendResult<String>;
    fn local_result_path<'a>(
        &'a self,
        task_id: &'a str,
        result_index: u32,
        media_type: MediaType,
    ) -> BoxFuture<'a, BackendResult<String>>;
}

struct ProjectSourceRecords {
    assets: AssetLibrary,
    staging: StagingService,
    results: LocalResultService,
}

impl SourceRecords for ProjectSourceRecords {
    fn asset_url(&self, identity: CloudAssetIdentity, media_type: MediaType) -> BoxFuture<'_, BackendResult<String>> {
        Box::pin(self.assets.preview_content_url(identity, media_type))
    }

    fn local_asset_url(&self, job_id: &str, media_type: MediaType) -> BackendResult<String> {
        Ok(self
            .staging
            .local_asset_lease(job_id, media_type)?
            .get_url)
    }

    fn local_result_path<'a>(
        &'a self,
        task_id: &'a str,
        result_index: u32,
        media_type: MediaType,
    ) -> BoxFuture<'a, BackendResult<String>> {
        Box::pin(async move {
            let record = self
                .results
                .verify_local_result(task_id, result_index)
                .await?;
            if record.save_status != SaveStatus::Succeeded || record.media_type != media_type
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
    local_base64_assets: Option<super::local_base64_assets::LocalBase64Library>,
    // None denotes a user's own local file: releasing that lease must never delete it.
    leases: Arc<Mutex<HashMap<String, Option<PathBuf>>>>,
}

impl VideoEditSourceService {
    pub fn new(
        assets: AssetLibrary,
        staging: StagingService,
        results: LocalResultService,
        directory: PathBuf,
        local_base64_assets: super::local_base64_assets::LocalBase64Library,
    ) -> BackendResult<Self> {
        // Keep the project's native proxy/TLS and timeout behavior. Redirects are explicit
        // so every new host gets its own fake-IP resolution, without forwarding credentials.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("InfiniteCanvas/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut service = Self::with_records(
            Arc::new(ProjectSourceRecords {
                assets,
                staging,
                results,
            }),
            client,
            &directory,
        )?;
        service.local_base64_assets = Some(local_base64_assets);
        Ok(service)
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
            local_base64_assets: None,
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
        self.prepare_media(target).await
    }

    /// Resolve an Agent input through the same identity, download and lease rules as video editing.
    pub(crate) async fn prepare_media(&self, target: &MediaReferenceTarget) -> BackendResult<PreparedVideoEditSource> {
        let media_type = target.media_type();
        if media_type == MediaType::Text { return Err(BackendError::validation("文字不是可下载媒体。", json!({}))); }
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
                    .local_result_path(generation_task_id, *result_index, media_type)
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
                    }, media_type)
                    .await?;
                (self.download(&url, media_type).await?, true)
            }
            MediaReferenceTarget::LocalAsset { staging_job_id, .. } => {
                let url = self.records.local_asset_url(staging_job_id, media_type)?;
                (self.download(&url, media_type).await?, true)
            }
            MediaReferenceTarget::LocalBase64Asset { asset_id, .. } => {
                let library = self.local_base64_assets.as_ref().ok_or_else(|| {
                    BackendError::Conflict("local Base64 library is unavailable".into())
                })?;
                (library.decoded_path(asset_id, media_type)?, true)
            }
            MediaReferenceTarget::Url { url, .. } => (self.download(url, media_type).await?, true),
        };
        let preview_id = Uuid::new_v4().to_string();
        self.leases
            .lock()
            // 锁中毒不直接 panic：panic 发生在 Tauri command 里**不会**转成命令错误，
            // 前端的 invoke 永远不返回（表现为界面挂死、也收不到任何错误事件）。
            // 恢复式取锁（`into_inner`）与同仓库 media_proxy 的写法一致。
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(preview_id.clone(), owned.then(|| path.clone()));
        Ok(PreparedVideoEditSource {
            preview_id,
            path: path.to_string_lossy().into_owned(),
        })
    }

    async fn download(&self, url: &str, media_type: MediaType) -> BackendResult<PathBuf> {
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
            .filter(|kind| kind.mime_type().starts_with(&format!("{}/", media_type.as_str())))
            .ok_or_else(|| {
                BackendError::validation(
                    "下载内容与素材类型不一致，请确认链接指向媒体正文。",
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
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
