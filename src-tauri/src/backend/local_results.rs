use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use rand::Rng as _;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    provider::{ImageSource, redact_url_string},
    storage::{GenerationLifecycleFact, GenerationTaskLifecycle, Storage, now_ms},
    types::{GenerationResultRecord, MediaType, SaveStatus},
};

#[derive(Clone)]
pub struct LocalResultService {
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    client: reqwest::Client,
    downloads_directory: PathBuf,
}

impl LocalResultService {
    pub fn new(
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        client: reqwest::Client,
        downloads_directory: PathBuf,
    ) -> Self {
        Self {
            storage,
            lifecycle,
            client,
            downloads_directory,
        }
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
                source: match source {
                    ImageSource::Url(url) => json!({ "kind": "url", "url": url }),
                    ImageSource::Base64(_) => {
                        json!({ "kind": "base64", "storedInRawProviderResponse": true })
                    }
                },
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

    pub async fn save_images<F>(
        &self,
        task_id: &str,
        sources: Vec<ImageSource>,
        mut on_ready: F,
    ) -> BackendResult<Vec<GenerationResultRecord>>
    where
        F: FnMut(&GenerationResultRecord, Option<String>) + Send,
    {
        let total = sources.len();
        info!("[save] 开始保存图片结果: taskId={task_id}, 共 {total} 个结果待处理");
        // 先把所有结果登记为 writing 并通知前端。这样多结果响应可以同时显示，
        // 不会因为第一个文件下载较慢而延迟后续结果的预览。
        let mut pending = Vec::with_capacity(sources.len());
        for (offset, source) in sources.into_iter().enumerate() {
            let result_index = (offset + 1) as u32;
            let source_archive = match &source {
                ImageSource::Url(url) => json!({ "kind": "url", "url": url }),
                ImageSource::Base64(_) => {
                    json!({ "kind": "base64", "storedInRawProviderResponse": true })
                }
            };
            info!(
                "[save] 处理图片结果 {}/{}: taskId={}, resultIndex={}, 来源={}",
                offset + 1,
                total,
                task_id,
                result_index,
                match &source {
                    ImageSource::Url(url) => format!("url（{}）", redact_url_string(url)),
                    ImageSource::Base64(_) => "base64".to_string(),
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
        for (source, mut record) in pending {
            let result_index = record.result_index;
            let result = match source {
                ImageSource::Url(url) => self.download_with_retry(&url).await,
                ImageSource::Base64(value) => decode_base64_image(&value),
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
            .download_with_retry(video_url)
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
                .map(|value| ImageSource::Url(value.to_string()))
                .ok_or_else(|| {
                    BackendError::protocol(
                        "interrupted URL result has no source URL",
                        json!({ "result": record }),
                    )
                }),
            Some("base64") if record.media_type == MediaType::Image => {
                self.recover_base64_source(&record).map(ImageSource::Base64)
            }
            kind => Err(BackendError::protocol(
                "interrupted result has an unsupported recovery source",
                json!({ "sourceKind": kind, "result": record }),
            )),
        };

        let outcome = match source {
            Ok(ImageSource::Url(url)) => self
                .download_with_retry(&url)
                .await
                .and_then(|bytes| self.prepare_bytes(bytes, record.media_type)),
            Ok(ImageSource::Base64(value)) => decode_base64_image(&value)
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

    fn recover_base64_source(&self, record: &GenerationResultRecord) -> BackendResult<String> {
        let raw = self
            .storage
            .last_successful_submit_response(&record.task_id)?;
        let value: serde_json::Value = serde_json::from_str(&raw)?;
        value
            .get("data")
            .and_then(|value| value.as_array())
            .and_then(|items| items.get(record.result_index.saturating_sub(1) as usize))
            .and_then(|item| item.get("b64_json"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                BackendError::protocol(
                    "persisted provider response has no Base64 value for the interrupted result",
                    json!({
                        "taskId": record.task_id,
                        "resultIndex": record.result_index,
                        "rawResponse": raw
                    }),
                )
            })
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

    async fn download_with_retry(&self, url: &str) -> BackendResult<Vec<u8>> {
        let redacted_url = redact_url_string(url);
        let mut last_error = None;
        for attempt in 0..=3_u32 {
            if attempt > 0 {
                let nominal = 2_000_u64 * 2_u64.pow(attempt - 1);
                let jitter = rand::rng().random_range(0..=(nominal / 5));
                tokio::time::sleep(std::time::Duration::from_millis(nominal + jitter)).await;
            }
            match self.download_once(url).await {
                Ok(bytes) => {
                    return Ok(bytes);
                }
                Err(error) => {
                    let retryable = matches!(&error, BackendError::Transport(_))
                        || matches!(&error, BackendError::Protocol { details, .. }
                            if details.get("httpStatus").and_then(|value| value.as_u64()).is_some_and(|status| (500..600).contains(&status)));
                    if !retryable || attempt == 3 {
                        error!(
                            "[save] 结果下载最终失败: 共尝试 {} 次, 可重试错误={retryable}, url={redacted_url}, 错误: {}",
                            attempt + 1,
                            error.payload().message
                        );
                        return Err(error);
                    }
                    warn!(
                        "[save] 结果下载失败，将自动重试: 第 {} 次尝试失败, 下次退避约 {}ms, url={redacted_url}, 错误: {}",
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

    async fn download_once(&self, url: &str) -> BackendResult<Vec<u8>> {
        let redacted_url = redact_url_string(url);
        let started_at = std::time::Instant::now();
        let response = self.client.get(url).send().await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
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
            let raw_response = String::from_utf8_lossy(&response.bytes().await?).into_owned();
            warn!(
                "[save] 结果下载单次请求失败: HTTP {status}, 耗时 {}ms, url={redacted_url}",
                started_at.elapsed().as_millis()
            );
            return Err(BackendError::protocol(
                format!("result download returned HTTP {status}"),
                json!({ "httpStatus": status, "headers": headers, "rawResponse": raw_response }),
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk?);
        }
        info!(
            "[save] 结果下载单次请求完成: HTTP {status}, 耗时 {}ms, 下载 {} 字节, 平均速度 {}/s, url={redacted_url}",
            started_at.elapsed().as_millis(),
            bytes.len(),
            format_bytes_per_sec(bytes.len(), started_at.elapsed())
        );
        Ok(bytes)
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
        ImageSource::Url(url) if !url.is_empty() => Some(url.clone()),
        ImageSource::Url(_) => None,
        ImageSource::Base64(value) => {
            let bytes = decode_base64_image(value).ok()?;
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
        let source = ImageSource::Base64(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                .to_string(),
        );
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
        let service = LocalResultService::new(
            Arc::clone(&storage),
            crate::backend::storage::GenerationTaskLifecycle::new(Arc::clone(&storage)),
            reqwest::Client::new(),
            directory.path().to_path_buf(),
        );
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
