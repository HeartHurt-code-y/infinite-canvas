use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rand::Rng as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    provider::{ImageSource, ProviderRuntime, ResultDownloadAuth, redact_url_string},
    result_transfer::{
        self, TransferProgress, download_result, is_retryable_transfer, production_policy,
    },
    staging::fake_ip_aware_streaming_download_client,
    storage::{GenerationLifecycleFact, GenerationTaskLifecycle, Storage, now_ms},
    types::{GenerationResultRecord, MediaType, SaveStatus},
};

/// 把图片来源序列化为结果记录的 `source` 归档字段。Seedream 图层拆分场景下，
/// 图层元数据（zIndex/name/description/boundingBox）一并写入，供前端把每个图层
/// 单独落为可编辑对象。
fn source_archive(source: &ImageSource) -> Value {
    match source {
        ImageSource::Url { url, layer } => {
            let mut archive = json!({ "kind": "url", "url": url });
            if let Some(layer) = layer {
                archive["layer"] = json!({
                    "zIndex": layer.z_index,
                    "name": layer.name,
                    "description": layer.description,
                    "boundingBox": layer.bounding_box,
                });
            }
            archive
        }
        ImageSource::Base64 { layer, .. } => {
            let mut archive = json!({ "kind": "base64", "storedInRawProviderResponse": true });
            if let Some(layer) = layer {
                archive["layer"] = json!({
                    "zIndex": layer.z_index,
                    "name": layer.name,
                    "description": layer.description,
                    "boundingBox": layer.bounding_box,
                });
            }
            archive
        }
    }
}

/// 从供应商的原始响应正文里取出指定结果索引的 `b64_json`。
///
/// `result_index` 是 1 起的业务索引，对应 `data[]` 中的 `result_index - 1` 项；
/// 空字符串与缺失字段都视为「没有可用的 Base64」，由调用方决定是报错还是保留原始错误。
fn base64_from_provider_response(raw: &str, result_index: u32) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.get(result_index.saturating_sub(1) as usize))
        .and_then(|item| item.get("b64_json"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[derive(Clone)]
pub struct LocalResultService {
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    client: reqwest::Client,
    downloads_directory: PathBuf,
    /// 结果直链下载需要复用生成请求的身份（Bearer / Referer）。这里持有供应商运行时
    /// 而不是让每个调用方传参：保存、恢复、命令入口三条路径都要按 `taskId` 反查
    /// 冻结连接快照，集中在这里解析可以保证三条路径行为一致。
    providers: ProviderRuntime,
}

impl LocalResultService {
    pub fn new(
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        client: reqwest::Client,
        downloads_directory: PathBuf,
        providers: ProviderRuntime,
    ) -> Self {
        Self {
            storage,
            lifecycle,
            client,
            downloads_directory,
            providers,
        }
    }

    /// 按任务冻结的连接快照解析下载鉴权上下文。
    ///
    /// 这是尽力而为的增强：任务记录缺失、供应商连接已删除或凭据已撤销时返回空上下文，
    /// 下载退回原来的裸 GET，不因为拿不到身份而让保存失败。
    fn download_auth(&self, task_id: &str) -> ResultDownloadAuth {
        self.storage
            .get_task_execution(task_id)
            .ok()
            .and_then(|task| self.providers.resolve_frozen(&task).ok())
            .map(|context| ResultDownloadAuth::from_context(&context))
            .unwrap_or_default()
    }

    fn persist_result(&self, result: &GenerationResultRecord) -> BackendResult<()> {
        self.lifecycle.commit(
            &result.task_id,
            GenerationLifecycleFact::ResultChanged {
                result: result.clone(),
            },
        )?;
        Ok(())
    }

    pub fn pending_image_results(
        &self,
        task_id: &str,
        sources: &[ImageSource],
    ) -> Vec<GenerationResultRecord> {
        sources
            .iter()
            .enumerate()
            .map(|(offset, source)| GenerationResultRecord {
                task_id: task_id.to_string(),
                result_index: (offset + 1) as u32,
                media_type: MediaType::Image,
                remote_task_id: None,
                source: source_archive(source),
                save_status: SaveStatus::Pending,
                final_path: None,
                relative_path: None,
                byte_size: None,
                mime_type: None,
                sha256: None,
                saved_at: None,
                error: None,
            })
            .collect()
    }

    pub fn pending_video_result(
        &self,
        task_id: &str,
        remote_task_id: &str,
        video_url: &str,
    ) -> GenerationResultRecord {
        GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index: 1,
            media_type: MediaType::Video,
            remote_task_id: Some(remote_task_id.to_string()),
            source: json!({ "kind": "url", "url": video_url }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        }
    }

    pub fn pending_video_content_result(
        &self,
        task_id: &str,
        remote_task_id: &str,
    ) -> GenerationResultRecord {
        GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index: 1,
            media_type: MediaType::Video,
            remote_task_id: Some(remote_task_id.to_string()),
            source: json!({ "kind": "content", "remoteTaskId": remote_task_id }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        }
    }

    pub async fn save_images<F, P>(
        &self,
        task_id: &str,
        sources: Vec<ImageSource>,
        mut on_ready: F,
        on_progress: P,
    ) -> BackendResult<Vec<GenerationResultRecord>>
    where
        F: FnMut(&GenerationResultRecord, Option<String>) + Send,
        P: FnMut(u32, TransferProgress) + Send + 'static,
    {
        let total = sources.len();
        info!("[save] 开始保存图片结果: taskId={task_id}, 共 {total} 个结果待处理");
        // 先把所有结果登记为 writing 并通知前端。这样多结果响应可以同时显示，
        // 不会因为第一个文件下载较慢而延迟后续结果的预览。
        let mut pending = Vec::with_capacity(sources.len());
        for (offset, source) in sources.into_iter().enumerate() {
            let result_index = (offset + 1) as u32;
            let source_archive = source_archive(&source);
            info!(
                "[save] 处理图片结果 {}/{}: taskId={}, resultIndex={}, 来源={}",
                offset + 1,
                total,
                task_id,
                result_index,
                match &source {
                    ImageSource::Url { url, .. } => format!("url（{}）", redact_url_string(url)),
                    ImageSource::Base64 { .. } => "base64".to_string(),
                }
            );
            let mut record = GenerationResultRecord {
                task_id: task_id.to_string(),
                result_index,
                media_type: MediaType::Image,
                remote_task_id: None,
                source: source_archive,
                save_status: SaveStatus::Pending,
                final_path: None,
                relative_path: None,
                byte_size: None,
                mime_type: None,
                sha256: None,
                saved_at: None,
                error: None,
            };
            self.persist_result(&record)?;
            record.save_status = SaveStatus::Writing;
            self.persist_result(&record)?;
            on_ready(&record, preview_source(&source, MediaType::Image));
            pending.push((source, record));
        }

        let mut records = Vec::with_capacity(pending.len());
        // 下载鉴权按任务解析一次：同一个任务的全部结果共用同一份冻结连接身份。
        let auth = self.download_auth(task_id);
        let on_progress = Arc::new(Mutex::new(on_progress));
        for (source, mut record) in pending {
            let result_index = record.result_index;
            let result = match source {
                ImageSource::Url { url, .. } => {
                    let progress = Arc::clone(&on_progress);
                    match self
                        .download_with_retry(
                            &url,
                            &auth,
                            &self.download_part_path(task_id, result_index),
                            {
                                move |progress_update| {
                                    (progress
                                        .lock()
                                        .unwrap_or_else(|poisoned| poisoned.into_inner()))(
                                        result_index,
                                        progress_update,
                                    );
                                }
                            },
                        )
                        .await
                    {
                        Ok(bytes) => Ok(bytes),
                        Err(error) => self.fallback_to_base64(task_id, result_index, &url, error),
                    }
                }
                ImageSource::Base64 { data, .. } => decode_base64_image(&data),
            }
            .and_then(|bytes| self.prepare_bytes(bytes, MediaType::Image));

            match result {
                Ok(prepared) => match self
                    .commit_prepared(task_id, result_index, None, prepared)
                    .await
                {
                    Ok(saved) => record = saved,
                    Err(error) => {
                        record.save_status = match error {
                            BackendError::Conflict(_) => SaveStatus::Conflict,
                            _ => SaveStatus::Failed,
                        };
                        record.error = Some(error.runtime_record());
                        error!(
                            "[save] 图片结果提交写入失败: taskId={}, resultIndex={}, 保存状态={}, 错误: {}",
                            task_id,
                            result_index,
                            record.save_status.as_str(),
                            record
                                .error
                                .as_ref()
                                .map(|error| error.to_string())
                                .unwrap_or_default()
                        );
                        self.persist_result(&record)?;
                    }
                },
                Err(error) => {
                    record.save_status = SaveStatus::Failed;
                    record.error = Some(error.runtime_record());
                    error!(
                        "[save] 图片结果下载或解码失败: taskId={}, resultIndex={}, 保存状态=failed, 错误: {}",
                        task_id,
                        result_index,
                        record
                            .error
                            .as_ref()
                            .map(|error| error.to_string())
                            .unwrap_or_default()
                    );
                    self.persist_result(&record)?;
                }
            }
            records.push(record);
        }
        Ok(records)
    }

    pub async fn save_video(
        &self,
        task_id: &str,
        remote_task_id: &str,
        video_url: &str,
        mut on_ready: impl FnMut(&GenerationResultRecord, Option<String>) + Send,
        on_progress: impl FnMut(TransferProgress) + Send + 'static,
    ) -> BackendResult<GenerationResultRecord> {
        info!(
            "[save] 开始保存视频结果: taskId={}, remoteTaskId={}, url={}",
            task_id,
            remote_task_id,
            redact_url_string(video_url)
        );
        let mut record = GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index: 1,
            media_type: MediaType::Video,
            remote_task_id: Some(remote_task_id.to_string()),
            source: json!({ "kind": "url", "url": video_url }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        };
        self.persist_result(&record)?;
        record.save_status = SaveStatus::Writing;
        self.persist_result(&record)?;
        on_ready(&record, Some(video_url.to_string()));

        let result = self
            .download_with_retry(
                video_url,
                &self.download_auth(task_id),
                &self.download_part_path(task_id, 1),
                on_progress,
            )
            .await
            .and_then(|bytes| self.prepare_bytes(bytes, MediaType::Video));
        match result {
            Ok(prepared) => match self
                .commit_prepared(task_id, 1, Some(remote_task_id), prepared)
                .await
            {
                Ok(saved) => Ok(saved),
                Err(error) => {
                    record.save_status = match error {
                        BackendError::Conflict(_) => SaveStatus::Conflict,
                        _ => SaveStatus::Failed,
                    };
                    record.error = Some(error.runtime_record());
                    error!(
                        "[save] 视频结果提交写入失败: taskId={}, remoteTaskId={}, 保存状态={}, 错误: {}",
                        task_id,
                        remote_task_id,
                        record.save_status.as_str(),
                        record
                            .error
                            .as_ref()
                            .map(|error| error.to_string())
                            .unwrap_or_default()
                    );
                    self.persist_result(&record)?;
                    Ok(record)
                }
            },
            Err(error) => {
                record.save_status = SaveStatus::Failed;
                record.error = Some(error.runtime_record());
                error!(
                    "[save] 视频结果下载或校验失败: taskId={}, remoteTaskId={}, 保存状态=failed, 错误: {}",
                    task_id,
                    remote_task_id,
                    record
                        .error
                        .as_ref()
                        .map(|error| error.to_string())
                        .unwrap_or_default()
                );
                self.persist_result(&record)?;
                Ok(record)
            }
        }
    }

    /// 直接落盘视频字节（海外平台 content 接口 fallback 场景：视频成功但观察
    /// 响应缺失 `result_url`/`video_url` 时，已由 provider 通过
    /// `GET /v1/videos/{task_id}/content` 下载到原始字节）。
    pub async fn save_video_bytes(
        &self,
        task_id: &str,
        remote_task_id: &str,
        bytes: Vec<u8>,
        mut on_ready: impl FnMut(&GenerationResultRecord, Option<String>) + Send,
    ) -> BackendResult<GenerationResultRecord> {
        info!(
            "[save] 开始保存视频结果（content 字节直存）: taskId={}, remoteTaskId={}, 字节 {}",
            task_id,
            remote_task_id,
            bytes.len()
        );
        let mut record = GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index: 1,
            media_type: MediaType::Video,
            remote_task_id: Some(remote_task_id.to_string()),
            source: json!({ "kind": "content", "remoteTaskId": remote_task_id }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        };
        self.persist_result(&record)?;
        record.save_status = SaveStatus::Writing;
        self.persist_result(&record)?;
        on_ready(&record, None);

        let result = self.prepare_bytes(bytes, MediaType::Video);
        match result {
            Ok(prepared) => match self
                .commit_prepared(task_id, 1, Some(remote_task_id), prepared)
                .await
            {
                Ok(saved) => Ok(saved),
                Err(error) => {
                    record.save_status = match error {
                        BackendError::Conflict(_) => SaveStatus::Conflict,
                        _ => SaveStatus::Failed,
                    };
                    record.error = Some(error.runtime_record());
                    error!(
                        "[save] 视频字节提交写入失败: taskId={}, remoteTaskId={}, 保存状态={}, 错误: {}",
                        task_id,
                        remote_task_id,
                        record.save_status.as_str(),
                        record
                            .error
                            .as_ref()
                            .map(|error| error.to_string())
                            .unwrap_or_default()
                    );
                    self.persist_result(&record)?;
                    Ok(record)
                }
            },
            Err(error) => {
                record.save_status = SaveStatus::Failed;
                record.error = Some(error.runtime_record());
                error!(
                    "[save] 视频字节校验失败: taskId={}, remoteTaskId={}, 保存状态=failed, 错误: {}",
                    task_id,
                    remote_task_id,
                    record
                        .error
                        .as_ref()
                        .map(|error| error.to_string())
                        .unwrap_or_default()
                );
                self.persist_result(&record)?;
                Ok(record)
            }
        }
    }

    /// 登记 Context-IR 文本结果的待写记录（扩写文本内联在 `source.text` 中，
    /// 前端无需读取文件即可展示）。
    pub fn pending_text_result(
        &self,
        task_id: &str,
        remote_task_id: &str,
        text: &str,
    ) -> GenerationResultRecord {
        GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index: 1,
            media_type: MediaType::Text,
            remote_task_id: Some(remote_task_id.to_string()),
            source: json!({ "kind": "text", "text": text }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: Some("text/plain".into()),
            sha256: Some(sha256_bytes(text.as_bytes())),
            saved_at: None,
            error: None,
        }
    }

    /// 将 Context-IR 扩写文本保存为 `.txt` 文件并返回已落盘的记录。
    pub async fn save_text(
        &self,
        task_id: &str,
        remote_task_id: &str,
        text: &str,
        mut on_ready: impl FnMut(&GenerationResultRecord, Option<String>) + Send,
    ) -> BackendResult<GenerationResultRecord> {
        if text.trim().is_empty() {
            return Err(BackendError::protocol(
                "Context-IR text result is empty",
                json!({ "taskId": task_id, "remoteTaskId": remote_task_id }),
            ));
        }
        let mut record = self.pending_text_result(task_id, remote_task_id, text);
        self.persist_result(&record)?;
        record.save_status = SaveStatus::Writing;
        self.persist_result(&record)?;
        // 文本无需下载/校验，没有可即时预览的媒体地址，直接交回生命周期。
        on_ready(&record, None);

        let directory = self.downloads_directory.join("无限画布");
        tokio::fs::create_dir_all(&directory).await?;
        let stem = safe_file_stem(remote_task_id);
        let file_name = format!("{stem}.txt");
        let final_path = directory.join(&file_name);
        let relative_path = Path::new("无限画布").join(&file_name);
        let bytes = text.as_bytes();

        // 与 save_video 保持一致：文件写入冲突/失败不向上抛错，落回记录状态，
        // 由任务结果事件把 failed/conflict 状态带给前端。
        let write_outcome = (async {
            if tokio::fs::try_exists(&final_path).await? {
                let existing = tokio::fs::read(&final_path).await?;
                if existing != bytes {
                    return Err(BackendError::Conflict(format!(
                        "target text file already exists with different content: {}",
                        final_path.display()
                    )));
                }
                info!(
                    "[save] 文本结果目标文件已存在且内容一致，直接复用: taskId={}, 路径={}",
                    task_id,
                    final_path.display()
                );
            } else {
                let part_path = directory.join(format!(".{file_name}.{}.part", Uuid::new_v4()));
                let mut file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&part_path)
                    .await?;
                file.write_all(bytes).await?;
                file.sync_all().await?;
                drop(file);
                tokio::fs::rename(&part_path, &final_path).await?;
                info!(
                    "[save] 文本结果原子重命名完成: taskId={}, 临时文件={:?} -> 最终文件={}",
                    task_id,
                    part_path,
                    final_path.display()
                );
            }
            Ok(())
        })
        .await;

        let saved = match write_outcome {
            Ok(()) => GenerationResultRecord {
                task_id: task_id.to_string(),
                result_index: 1,
                media_type: MediaType::Text,
                remote_task_id: Some(remote_task_id.to_string()),
                source: record.source.clone(),
                save_status: SaveStatus::Succeeded,
                final_path: Some(final_path.to_string_lossy().into_owned()),
                relative_path: Some(relative_path.to_string_lossy().into_owned()),
                byte_size: Some(bytes.len() as u64),
                mime_type: Some("text/plain".into()),
                sha256: Some(sha256_bytes(bytes)),
                saved_at: Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_secs() as i64)
                        .unwrap_or_default(),
                ),
                error: None,
            },
            Err(error) => {
                let status = match &error {
                    BackendError::Conflict(_) => SaveStatus::Conflict,
                    _ => SaveStatus::Failed,
                };
                error!(
                    "[save] 文本结果写入失败: taskId={}, remoteTaskId={}, 保存状态={}, 错误: {}",
                    task_id,
                    remote_task_id,
                    status.as_str(),
                    error
                );
                GenerationResultRecord {
                    task_id: task_id.to_string(),
                    result_index: 1,
                    media_type: MediaType::Text,
                    remote_task_id: Some(remote_task_id.to_string()),
                    source: record.source.clone(),
                    save_status: status,
                    final_path: None,
                    relative_path: None,
                    byte_size: None,
                    mime_type: Some("text/plain".into()),
                    sha256: Some(sha256_bytes(bytes)),
                    saved_at: None,
                    error: Some(error.runtime_record()),
                }
            }
        };
        self.persist_result(&saved)?;
        Ok(saved)
    }

    pub async fn resume_interrupted_result(
        &self,
        mut record: GenerationResultRecord,
        on_progress: impl FnMut(TransferProgress) + Send + 'static,
    ) -> BackendResult<GenerationResultRecord> {
        info!(
            "[save] 恢复中断的本地保存: taskId={}, resultIndex={}, mediaType={}, 来源={}",
            record.task_id,
            record.result_index,
            record.media_type.as_str(),
            record
                .source
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("<未知>")
        );
        record.save_status = SaveStatus::Writing;
        record.error = None;
        self.persist_result(&record)?;

        // Context-IR 文本结果：扩写文本内联在 source.text，无需下载，直接重新落盘。
        if record.media_type == MediaType::Text {
            let text = record
                .source
                .get("text")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "interrupted text result has no inline text source",
                        json!({ "result": record }),
                    )
                })?
                .to_owned();
            let remote_task_id = record.remote_task_id.clone().unwrap_or_default();
            return self
                .save_text(&record.task_id, &remote_task_id, &text, |_, _| {})
                .await
                .map(|mut saved| {
                    saved.result_index = record.result_index;
                    saved
                });
        }

        let source = match record.source.get("kind").and_then(|value| value.as_str()) {
            Some("url") => record
                .source
                .get("url")
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .map(|value| ImageSource::Url {
                    url: value.to_string(),
                    layer: None,
                })
                .ok_or_else(|| {
                    BackendError::protocol(
                        "interrupted URL result has no source URL",
                        json!({ "result": record }),
                    )
                }),
            Some("base64") if record.media_type == MediaType::Image => self
                .recover_base64_source(&record.task_id, record.result_index)
                .map(|data| ImageSource::Base64 { data, layer: None }),
            kind => Err(BackendError::protocol(
                "interrupted result has an unsupported recovery source",
                json!({ "sourceKind": kind, "result": record }),
            )),
        };

        // 恢复同样按任务解析下载身份：断点续跑不能因为少了请求头而再次失败。
        let auth = self.download_auth(&record.task_id);
        let media_type = record.media_type;
        let outcome = match source {
            Ok(ImageSource::Url { url, .. }) => {
                match self
                    .download_with_retry(
                        &url,
                        &auth,
                        &self.download_part_path(&record.task_id, record.result_index),
                        on_progress,
                    )
                    .await
                {
                    Ok(bytes) => Ok(bytes),
                    // 只有图片结果才有内联 Base64 兜底（视频接口不返回 Base64）。
                    Err(error) if media_type == MediaType::Image => {
                        self.fallback_to_base64(&record.task_id, record.result_index, &url, error)
                    }
                    Err(error) => Err(error),
                }
                .and_then(|bytes| self.prepare_bytes(bytes, media_type))
            }
            Ok(ImageSource::Base64 { data, .. }) => decode_base64_image(&data)
                .and_then(|bytes| self.prepare_bytes(bytes, MediaType::Image)),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(prepared) => self
                .commit_prepared(
                    &record.task_id,
                    record.result_index,
                    record.remote_task_id.as_deref(),
                    prepared,
                )
                .await
                .or_else(|error| self.finish_resumed_result_failure(record, error)),
            Err(error) => self.finish_resumed_result_failure(record, error),
        }
    }

    /// 从已持久化的供应商原始响应里取出指定结果索引的 `b64_json`。
    ///
    /// 两个场景复用同一份数据：恢复中断的保存（`source` 归档只记了 `kind`，正文从
    /// 原始响应回读），以及 URL 直链下载失败后的兜底（供应商同时返回链接与 Base64 时
    /// 仍有第二条路可取）。
    fn recover_base64_source(&self, task_id: &str, result_index: u32) -> BackendResult<String> {
        let raw = self.storage.last_successful_submit_response(task_id)?;
        base64_from_provider_response(&raw, result_index).ok_or_else(|| {
            BackendError::protocol(
                "persisted provider response has no Base64 value for the result",
                json!({
                    "taskId": task_id,
                    "resultIndex": result_index,
                    "rawResponse": raw
                }),
            )
        })
    }

    /// URL 直链下载失败后的兜底：改用同一份供应商响应里的内联 Base64。
    ///
    /// 默认返回 Base64 的供应商本来就不需要这一跳；返回链接的供应商只要响应里同时
    /// 带了 Base64（文档允许二者同时存在），结果仍能保存成功，不再因为「生成成功但
    /// 直链所在域名连不上」而整张图丢失。
    ///
    /// 兜底不可用时返回**原来的下载错误**——那是用户唯一能据此排查网络/代理问题的信息。
    fn fallback_to_base64(
        &self,
        task_id: &str,
        result_index: u32,
        url: &str,
        cause: BackendError,
    ) -> BackendResult<Vec<u8>> {
        match self.recover_base64_source(task_id, result_index) {
            Ok(data) => {
                warn!(
                    "[save] 结果直链下载失败，改用同一响应中的内联 Base64 保存: taskId={task_id}, resultIndex={result_index}, url={}",
                    redact_url_string(url)
                );
                decode_base64_image(&data)
            }
            Err(absent) => {
                info!(
                    "[save] 结果直链下载失败，响应中没有可用的内联 Base64，保留原始下载错误: taskId={task_id}, resultIndex={result_index}, 兜底不可用原因={}",
                    absent.payload().message
                );
                Err(cause)
            }
        }
    }

    fn finish_resumed_result_failure(
        &self,
        mut record: GenerationResultRecord,
        error: BackendError,
    ) -> BackendResult<GenerationResultRecord> {
        record.save_status = match &error {
            BackendError::Conflict(_) => SaveStatus::Conflict,
            _ => SaveStatus::Failed,
        };
        record.error = Some(error.runtime_record());
        warn!(
            "[save] 恢复中断的保存最终失败: taskId={}, resultIndex={}, 保存状态={}, 错误: {}",
            record.task_id,
            record.result_index,
            record.save_status.as_str(),
            error.payload().message
        );
        self.persist_result(&record)?;
        Ok(record)
    }

    /// 下载远程结果字节：卡住才失败、临时文件断点续传、大文件多路 Range。
    ///
    /// 重试策略：共 6 次尝试（1 次首次 + 5 次重试），仅对传输层错误、卡住、
    /// 可重试协议错误和 5xx HTTP 错误重试；退避节奏：第 1/2/3/4/5 次重试前约等待
    /// 2s / 4s / 8s / 16s / 32s（含 ±20% 随机抖动）。已写入的临时文件会保留，
    /// 下次从已有字节接着传，不再把慢直链下到一半的数据丢掉。
    async fn download_with_retry(
        &self,
        url: &str,
        auth: &ResultDownloadAuth,
        part_path: &Path,
        on_progress: impl FnMut(TransferProgress) + Send + 'static,
    ) -> BackendResult<Vec<u8>> {
        let redacted_url = redact_url_string(url);
        let on_progress = Arc::new(Mutex::new(on_progress));
        let existing = tokio::fs::metadata(part_path)
            .await
            .ok()
            .map(|meta| meta.len())
            .unwrap_or(0);
        (on_progress
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))(
            TransferProgress {
                received: existing,
                total: None,
                bytes_per_sec: 0.0,
            },
        );
        let mut last_error = None;
        const MAX_ATTEMPTS: u32 = 6;
        for attempt in 0..MAX_ATTEMPTS {
            if attempt > 0 {
                let nominal = 2_000_u64 * 2_u64.pow(attempt - 1);
                let jitter = rand::rng().random_range(0..=(nominal / 5));
                tokio::time::sleep(std::time::Duration::from_millis(nominal + jitter)).await;
            }
            let progress = Arc::clone(&on_progress);
            let client = fake_ip_aware_streaming_download_client(
                url,
                result_transfer::streaming_client().unwrap_or_else(|_| self.client.clone()),
            )
            .await;
            match download_result(
                client,
                url,
                auth,
                part_path,
                production_policy(),
                move |update| {
                    (progress
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()))(
                        update
                    );
                },
            )
            .await
            {
                Ok(bytes) => {
                    if attempt > 0 {
                        info!(
                            "[save] 结果下载在第 {} 次尝试成功: url={redacted_url}",
                            attempt + 1
                        );
                    }
                    let _ = tokio::fs::remove_file(part_path).await;
                    return Ok(bytes);
                }
                Err(error) => {
                    let retryable = is_retryable_transfer(&error);
                    let is_last_attempt = attempt == MAX_ATTEMPTS - 1;
                    if !retryable || is_last_attempt {
                        error!(
                            "[save] 结果下载最终失败: 共尝试 {} 次, 可重试错误={retryable}, url={redacted_url}, 错误: {}",
                            attempt + 1,
                            error.payload().message
                        );
                        return Err(error);
                    }
                    warn!(
                        "[save] 结果下载失败，将从已下载字节续传: 第 {} 次尝试失败, 下次退避约 {}ms, url={redacted_url}, 错误: {}",
                        attempt + 1,
                        2_000_u64 * 2_u64.pow(attempt),
                        error.payload().message
                    );
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| {
            BackendError::protocol(
                "download retry loop exited without a result",
                json!({ "url": url }),
            )
        }))
    }

    fn download_part_path(&self, task_id: &str, result_index: u32) -> PathBuf {
        self.downloads_directory.join("无限画布").join(format!(
            ".{}.r{result_index}.download",
            safe_file_stem(task_id)
        ))
    }

    fn prepare_bytes(&self, bytes: Vec<u8>, expected: MediaType) -> BackendResult<PreparedMedia> {
        if bytes.is_empty() {
            return Err(BackendError::protocol(
                "generated media is empty",
                json!({ "expectedMediaType": expected }),
            ));
        }
        let inferred = infer::get(&bytes).ok_or_else(|| {
            BackendError::protocol(
                "generated media type could not be identified from file signature",
                json!({ "expectedMediaType": expected, "byteSize": bytes.len() }),
            )
        })?;
        let mime_type = inferred.mime_type().to_string();
        let valid = match expected {
            MediaType::Image => mime_type.starts_with("image/"),
            MediaType::Video => mime_type.starts_with("video/"),
            MediaType::Audio => mime_type.starts_with("audio/"),
            MediaType::Text => mime_type.starts_with("text/"),
        };
        if !valid {
            return Err(BackendError::protocol(
                "generated media type does not match the expected result type",
                json!({
                    "expectedMediaType": expected,
                    "detectedMimeType": mime_type,
                    "byteSize": bytes.len()
                }),
            ));
        }
        let sha256 = sha256_bytes(&bytes);
        info!(
            "[save] 媒体字节校验通过: 预期类型={}, 检测到 MIME={}, 大小 {} 字节, sha256={sha256}",
            expected.as_str(),
            mime_type,
            bytes.len()
        );
        Ok(PreparedMedia {
            bytes,
            mime_type,
            extension: inferred.extension().to_ascii_lowercase(),
            sha256,
        })
    }

    async fn commit_prepared(
        &self,
        task_id: &str,
        result_index: u32,
        remote_task_id: Option<&str>,
        prepared: PreparedMedia,
    ) -> BackendResult<GenerationResultRecord> {
        let directory = self.downloads_directory.join("无限画布");
        tokio::fs::create_dir_all(&directory).await?;
        let stem = remote_task_id
            .map(safe_file_stem)
            .unwrap_or_else(|| format!("{}-{result_index}", safe_file_stem(task_id)));
        let file_name = format!("{stem}.{}", prepared.extension);
        let final_path = directory.join(&file_name);
        let relative_path = Path::new("无限画布").join(&file_name);
        info!(
            "[save] 准备写入结果文件: taskId={}, resultIndex={}, 目标路径={}, 大小 {} 字节",
            task_id,
            result_index,
            final_path.display(),
            prepared.bytes.len()
        );

        if tokio::fs::try_exists(&final_path).await? {
            let existing = tokio::fs::read(&final_path).await?;
            if sha256_bytes(&existing) != prepared.sha256 {
                error!(
                    "[save] 目标文件已存在且内容不同，进入 conflict（不覆盖）: taskId={}, 路径={}",
                    task_id,
                    final_path.display()
                );
                return Err(BackendError::Conflict(format!(
                    "target file already exists with different content: {}",
                    final_path.display()
                )));
            }
            info!(
                "[save] 目标文件已存在且内容哈希一致，直接复用: taskId={}, 路径={}",
                task_id,
                final_path.display()
            );
        } else {
            let part_path = directory.join(format!(".{file_name}.{}.part", Uuid::new_v4()));
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&part_path)
                .await?;
            file.write_all(&prepared.bytes).await?;
            file.sync_all().await?;
            drop(file);

            if tokio::fs::try_exists(&final_path).await? {
                let existing = tokio::fs::read(&final_path).await?;
                if sha256_bytes(&existing) != prepared.sha256 {
                    error!(
                        "[save] 写入期间目标文件被其他进程创建且内容不同，进入 conflict: taskId={}, 路径={}",
                        task_id,
                        final_path.display()
                    );
                    return Err(BackendError::Conflict(format!(
                        "target file appeared with different content while saving: {}",
                        final_path.display()
                    )));
                }
                let _ = tokio::fs::remove_file(&part_path).await;
                info!(
                    "[save] 写入期间目标文件已被同内容创建，复用并清理临时文件: taskId={}, 路径={}",
                    task_id,
                    final_path.display()
                );
            } else {
                tokio::fs::rename(&part_path, &final_path).await?;
                info!(
                    "[save] 临时文件原子重命名完成: taskId={}, 临时文件={:?} -> 最终文件={}",
                    task_id,
                    part_path,
                    final_path.display()
                );
            }
        }

        let record = GenerationResultRecord {
            task_id: task_id.to_string(),
            result_index,
            media_type: if remote_task_id.is_some() {
                MediaType::Video
            } else {
                MediaType::Image
            },
            remote_task_id: remote_task_id.map(ToOwned::to_owned),
            source: self.storage.get_result(task_id, result_index)?.source,
            save_status: SaveStatus::Succeeded,
            final_path: Some(final_path.to_string_lossy().into_owned()),
            relative_path: Some(relative_path.to_string_lossy().into_owned()),
            byte_size: Some(prepared.bytes.len() as u64),
            mime_type: Some(prepared.mime_type.clone()),
            sha256: Some(prepared.sha256.clone()),
            saved_at: Some(now_ms()),
            error: None,
        };
        self.persist_result(&record)?;
        info!(
            "[save] 结果保存成功（已落盘并写入保存记录）: taskId={}, resultIndex={}, 路径={}, 大小 {} 字节, mime={}, sha256={}",
            task_id,
            result_index,
            record.final_path.as_deref().unwrap_or("<无路径>"),
            prepared.bytes.len(),
            prepared.mime_type,
            prepared.sha256
        );
        Ok(record)
    }

    pub async fn verify_local_result(
        &self,
        task_id: &str,
        result_index: u32,
    ) -> BackendResult<GenerationResultRecord> {
        let mut record = self.storage.get_result(task_id, result_index)?;
        if record.save_status != SaveStatus::Succeeded {
            return Ok(record);
        }
        let path = record.final_path.as_deref().ok_or_else(|| {
            BackendError::protocol(
                "saved result has no final path",
                json!({
                    "taskId": task_id,
                    "resultIndex": result_index
                }),
            )
        })?;
        if !tokio::fs::try_exists(path).await? {
            warn!(
                "[save] 校验发现本地结果文件已缺失，标记 local_missing: taskId={}, resultIndex={}, 路径={path}",
                task_id, result_index
            );
            record.save_status = SaveStatus::LocalMissing;
            record.error = Some(json!({
                "kind": "local_missing",
                "message": "saved local result no longer exists",
                "path": path
            }));
            self.persist_result(&record)?;
            return Ok(record);
        }
        let bytes = tokio::fs::read(path).await?;
        let actual_hash = sha256_bytes(&bytes);
        if record.sha256.as_deref() != Some(actual_hash.as_str()) {
            warn!(
                "[save] 校验发现本地结果内容与保存记录不一致，标记 conflict: taskId={}, resultIndex={}, 路径={path}",
                task_id, result_index
            );
            record.save_status = SaveStatus::Conflict;
            record.error = Some(json!({
                "kind": "content_hash_mismatch",
                "message": "saved local result content no longer matches its task record",
                "path": path,
                "expectedSha256": record.sha256,
                "actualSha256": actual_hash
            }));
            self.persist_result(&record)?;
        }
        Ok(record)
    }
}

struct PreparedMedia {
    bytes: Vec<u8>,
    mime_type: String,
    extension: String,
    sha256: String,
}

fn decode_base64_image(value: &str) -> BackendResult<Vec<u8>> {
    let encoded = value
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:"))
        .map(|(_, encoded)| encoded)
        .unwrap_or(value);
    STANDARD.decode(encoded).map_err(|error| {
        BackendError::protocol(
            "generated image Base64 could not be decoded",
            json!({ "source": error.to_string() }),
        )
    })
}

/// 返回仅用于当前会话即时预览的媒体地址。该地址不会写入画布文档；
/// 本地结果仍以 Downloads 中的最终文件为长期引用。
pub fn preview_source(source: &ImageSource, expected: MediaType) -> Option<String> {
    match source {
        ImageSource::Url { url, .. } if !url.is_empty() => Some(url.clone()),
        ImageSource::Url { .. } => None,
        ImageSource::Base64 { data, .. } => {
            let bytes = decode_base64_image(data).ok()?;
            let inferred = infer::get(&bytes)?;
            let mime_type = inferred.mime_type();
            let valid = match expected {
                MediaType::Image => mime_type.starts_with("image/"),
                MediaType::Video => mime_type.starts_with("video/"),
                MediaType::Audio => mime_type.starts_with("audio/"),
                MediaType::Text => mime_type.starts_with("text/"),
            };
            if !valid {
                return None;
            }
            Some(format!(
                "data:{mime_type};base64,{}",
                STANDARD.encode(bytes)
            ))
        }
    }
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn format_bytes_per_sec(bytes: usize, elapsed: std::time::Duration) -> String {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 || bytes == 0 {
        return "N/A".to_string();
    }
    let per_second = bytes as f64 / seconds;
    if per_second >= 1024.0 * 1024.0 {
        format!("{:.2} MB", per_second / (1024.0 * 1024.0))
    } else if per_second >= 1024.0 {
        format!("{:.2} KB", per_second / 1024.0)
    } else {
        format!("{per_second:.0} B")
    }
}

pub fn safe_file_stem(value: &str) -> String {
    let mut stem = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    while stem.ends_with([' ', '.']) {
        stem.pop();
    }
    if stem.is_empty()
        || matches!(
            stem.to_ascii_uppercase().as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    {
        stem.insert(0, '_');
    }
    stem
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_service(storage: &Arc<Storage>) -> LocalResultService {
        let lifecycle = crate::backend::storage::GenerationTaskLifecycle::new(Arc::clone(storage));
        let providers = crate::backend::provider::ProviderRuntime::new(
            Arc::clone(storage),
            lifecycle.clone(),
            crate::backend::credentials::CredentialStore::default(),
        )
        .expect("provider runtime");
        LocalResultService::new(
            Arc::clone(storage),
            lifecycle,
            // 测试直连本地回环端口，必须绕开系统/环境变量代理，
            // 否则请求会被开发机上的代理拦成 502。
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("build test client"),
            std::env::temp_dir(),
            providers,
        )
    }

    /// URL 直链下载失败后的兜底依赖「按 1 起的结果索引取回 `b64_json`」。
    /// 索引错位、空字符串或响应不可解析都必须判为「没有可用的 Base64」，
    /// 否则会把另一张图当成这张图保存下来。
    #[test]
    fn base64_fallback_reads_the_matching_result_index() {
        let raw = json!({
            "data": [
                { "url": "https://cdn.example.com/0.png", "b64_json": "first" },
                { "url": "https://cdn.example.com/1.png", "b64_json": "second" }
            ]
        })
        .to_string();

        assert_eq!(
            base64_from_provider_response(&raw, 1).as_deref(),
            Some("first")
        );
        assert_eq!(
            base64_from_provider_response(&raw, 2).as_deref(),
            Some("second")
        );
        // 文档允许结果项只有 url 没有 b64_json —— 兜底此时不可用，必须返回 None。
        let url_only = json!({ "data": [{ "url": "https://cdn.example.com/a.png" }] }).to_string();
        assert_eq!(base64_from_provider_response(&url_only, 1), None);
        // 空串与越界索引同样不可用。
        let empty = json!({ "data": [{ "b64_json": "" }] }).to_string();
        assert_eq!(base64_from_provider_response(&empty, 1), None);
        assert_eq!(base64_from_provider_response(&raw, 9), None);
        // 响应不是 JSON 时不能抛出，只表示兜底不可用。
        assert_eq!(base64_from_provider_response("<html>502</html>", 1), None);
    }

    /// 结果直链下载必须带上生成侧的身份：同源时附 `Authorization` 与 `Referer`。
    /// 这条用例真的发一次请求并检查落到线上的请求头，而不是只看构造结果。
    #[tokio::test]
    async fn url_download_sends_generation_identity_headers() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let captured = Arc::new(std::sync::Mutex::new(String::new()));
        let captured_server = Arc::clone(&captured);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).expect("read request");
            captured_server
                .lock()
                .expect("capture lock")
                .push_str(&String::from_utf8_lossy(&buffer[..read]));
            let body: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).expect("write head");
            stream.write_all(body).expect("write body");
            stream.flush().expect("flush");
        });

        let directory = tempfile::TempDir::new().expect("temp dir");
        let storage = Arc::new(
            crate::backend::storage::Storage::open(&directory.path().join("backend.sqlite"))
                .expect("open db"),
        );
        let service = test_service(&storage);
        let url = format!("http://127.0.0.1:{port}/images/a.png");
        let auth =
            ResultDownloadAuth::from_parts(&format!("http://127.0.0.1:{port}/v1"), "sk-secret");

        let bytes = service
            .download_with_retry(
                &url,
                &auth,
                &directory.path().join("identity.download"),
                |_| {},
            )
            .await
            .expect("download succeeds");
        server.join().expect("server joins");
        assert_eq!(bytes, vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

        let request = captured.lock().expect("capture lock").to_ascii_lowercase();
        assert!(
            request.contains("authorization: bearer sk-secret"),
            "same-host download must carry the bearer token, got: {request}"
        );
        assert!(
            request.contains(&format!("referer: http://127.0.0.1:{port}")),
            "download must carry a referer, got: {request}"
        );
    }

    #[test]
    fn windows_unsafe_file_names_are_deterministically_sanitized() {
        assert_eq!(safe_file_stem("task:abc/def?"), "task_abc_def_");
        assert_eq!(safe_file_stem("CON"), "_CON");
        assert_eq!(safe_file_stem("trailing. "), "trailing");
    }

    #[test]
    fn base64_data_uri_is_decoded() {
        assert_eq!(
            decode_base64_image("data:image/png;base64,aGVsbG8=").expect("decode"),
            b"hello"
        );
    }

    #[test]
    fn valid_base64_source_gets_an_image_preview_data_uri() {
        let source = ImageSource::Base64 {
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                .to_string(),
            layer: None,
        };
        let preview = preview_source(&source, MediaType::Image).expect("preview");
        assert!(preview.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn pending_text_result_carries_media_type_text_and_inline_prompt() {
        // pending_text_result 是纯构造，不读写存储；用临时库实例化 Service。
        let directory = tempfile::TempDir::new().expect("temp dir");
        let storage = Arc::new(
            crate::backend::storage::Storage::open(&directory.path().join("backend.sqlite"))
                .expect("open db"),
        );
        let service = test_service(&storage);
        let record = service.pending_text_result("task-1", "remote-1", "扩写后的完整提示词");
        assert_eq!(record.media_type, MediaType::Text);
        assert_eq!(record.media_type.as_str(), "text");
        assert_eq!(record.remote_task_id.as_deref(), Some("remote-1"));
        assert_eq!(record.source["kind"], "text");
        assert_eq!(record.source["text"], "扩写后的完整提示词");
        assert_eq!(record.save_status, SaveStatus::Pending);
        assert_eq!(record.mime_type.as_deref(), Some("text/plain"));
        // source 内联文本可被前端提取用于即时展示。
        assert_eq!(
            record.source.get("text").and_then(|value| value.as_str()),
            Some("扩写后的完整提示词")
        );
    }
}
