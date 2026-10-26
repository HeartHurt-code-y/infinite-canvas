//! 视频抽帧：输入任意本地视频，按指定的秒数抽取关键帧图片。
//!
//! 复用视频合成服务自带的 FFmpeg 引擎（缺失时自动按需下载，与下载器共用同
//! 一套引擎）。抽出的图片默认落在系统下载目录的「无限画布/抽帧」子目录，
//! 产物作为图片资产卡片接入画布，可连入后续生成节点（图片参考）与其他工作流。
//!
//! 注意：抽帧产物是普通本地文件，不含任何账号凭据或会话信息。

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use ts_rs::TS;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::composer::VideoCompositionService;
use super::error::{BackendError, BackendResult};
use super::storage::Storage;

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 内存中最多保留的任务数；超出后清掉已终态的最旧记录，防止长会话无界增长。
const JOB_RETAIN_LIMIT: usize = 100;

// Share decoding only for nearby points. Sparse requests keep input seeking, and each JPEG
// encoder uses one thread so a dense request does not multiply the engine's worker count.
const FRAME_BATCH_LIMIT: usize = 8;
const FRAME_BATCH_MAX_GAP: f64 = 0.5;
const FRAME_BATCH_MAX_SPAN: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VideoFrameExtractionStatus {
    /// 正在准备 FFmpeg 引擎。
    PreparingEngine,
    Processing,
    /// An interrupted task keeps its verified frames and can continue explicitly.
    Paused,
    Completed,
    Failed,
    Cancelled,
}

/// 单张抽帧结果的落地信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFrame {
    /// 图片文件绝对路径（前端经 convertFileSrc 展示）。
    pub path: String,
    /// 抽取时刻（秒）。
    pub timestamp_seconds: f64,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub byte_size: u64,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSourceFingerprint {
    pub byte_size: u64,
    pub modified_at_ms: Option<u64>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameExtractionJobRecord {
    pub job_id: String,
    /// 输入视频的绝对路径。
    pub video_path: String,
    pub status: VideoFrameExtractionStatus,
    /// 0-100；引擎准备阶段为 None。
    pub progress: Option<f64>,
    pub frames: Vec<ExtractedFrame>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub output_directory: String,
    #[serde(default)]
    pub requested_timestamps: Vec<f64>,
    #[serde(default)]
    pub requested_percentages: Vec<f64>,
    #[serde(default)]
    pub resolved_timestamps: Vec<f64>,
    #[serde(default)]
    pub source_fingerprint: Option<FrameSourceFingerprint>,
}

struct JobEntry {
    record: VideoFrameExtractionJobRecord,
    cancelled: Arc<AtomicBool>,
    /// A cancelled process may still be releasing handles. Do not overlap retries.
    running: bool,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, JobEntry>>,
    downloads_dir: PathBuf,
    composer: VideoCompositionService,
    storage: Option<Arc<Storage>>,
}

/// 画布视频抽帧服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoFrameExtractionService {
    inner: Arc<Inner>,
}

impl VideoFrameExtractionService {
    pub fn new_with_storage(
        downloads_dir: PathBuf,
        composer: VideoCompositionService,
        storage: Arc<Storage>,
    ) -> BackendResult<Self> {
        storage.ensure_frame_extraction_storage()?;
        let mut jobs = HashMap::new();
        for mut record in storage.list_frame_extraction_jobs()? {
            if matches!(
                record.status,
                VideoFrameExtractionStatus::PreparingEngine
                    | VideoFrameExtractionStatus::Processing
            ) {
                record.status = VideoFrameExtractionStatus::Paused;
                record.error = Some("应用已重启，已保留完成帧；点击继续抽帧恢复任务".to_string());
                record.updated_at = now_ms();
                storage.save_frame_extraction_job(&record)?;
            }
            // All resumable jobs remain accessible; terminal history is read from DB on demand.
            if jobs.len() < JOB_RETAIN_LIMIT || record.status == VideoFrameExtractionStatus::Paused
            {
                jobs.insert(
                    record.job_id.clone(),
                    JobEntry {
                        record,
                        cancelled: Arc::new(AtomicBool::new(false)),
                        running: false,
                    },
                );
            }
        }
        Ok(Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(jobs),
                downloads_dir,
                composer,
                storage: Some(storage),
            }),
        })
    }

    /// 比例采样由后端在探测实际视频时长后换算，避免生成模型实际时长与计划值略有
    /// 偏差时，99% 尾帧被误判为越界。

    /// A UUID chosen and saved by the client before IPC makes a lost submission response recoverable.
    /// A repeated request returns its original record; only retry_job resumes an interrupted run.
    pub fn start_extraction_with_request_id(
        &self,
        video_path: &str,
        timestamps: Vec<f64>,
        percentages: Vec<f64>,
        request_id: Option<String>,
    ) -> BackendResult<VideoFrameExtractionJobRecord> {
        let video_path = video_path.trim();
        if video_path.is_empty() {
            return Err(BackendError::validation(
                "请先指定要抽帧的视频文件",
                Value::Null,
            ));
        }
        let mut timestamps: Vec<f64> = timestamps
            .into_iter()
            .filter(|timestamp| timestamp.is_finite())
            .collect();
        timestamps.sort_by(|first, second| {
            first
                .partial_cmp(second)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        timestamps.dedup_by(|first, second| (*first - *second).abs() < 0.01);
        let mut percentages: Vec<f64> = percentages
            .into_iter()
            .filter(|percentage| percentage.is_finite())
            .collect();
        percentages.sort_by(|first, second| {
            first
                .partial_cmp(second)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        percentages.dedup_by(|first, second| (*first - *second).abs() < 0.0001);
        if timestamps.is_empty() && percentages.is_empty() {
            return Err(BackendError::validation(
                "请至少填写一个抽帧秒数或比例",
                Value::Null,
            ));
        }
        if !timestamps.is_empty() && !percentages.is_empty() {
            return Err(BackendError::validation(
                "抽帧秒数与比例不能同时填写",
                Value::Null,
            ));
        }
        if timestamps.iter().any(|timestamp| *timestamp < 0.0) {
            return Err(BackendError::validation("抽帧秒数不能为负数", Value::Null));
        }
        if percentages
            .iter()
            .any(|percentage| *percentage <= 0.0 || *percentage >= 1.0)
        {
            return Err(BackendError::validation(
                "抽帧比例必须大于 0 且小于 1",
                Value::Null,
            ));
        }

        let request_uuid = match request_id {
            Some(id) if id.len() == 36 => Uuid::parse_str(&id).map_err(|_| {
                BackendError::validation("抽帧提交标识必须是标准 UUID", Value::Null)
            })?,
            Some(_) => {
                return Err(BackendError::validation(
                    "抽帧提交标识必须是标准 UUID",
                    Value::Null,
                ));
            }
            None => Uuid::new_v4(),
        };
        let job_id = format!("frame-extract-{request_uuid}");
        {
            let jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
            if let Some(existing) =
                self.existing_request(&jobs, &job_id, video_path, &timestamps, &percentages)?
            {
                return Ok(existing);
            }
        }
        // Do the large-file read outside the jobs mutex, so other jobs can be polled or cancelled.
        let source_fingerprint_result = if is_remote_url(video_path) {
            Ok(None)
        } else if !Path::new(video_path).is_file() {
            Err(BackendError::validation(
                "视频文件不存在",
                serde_json::json!({ "path": video_path }),
            ))
        } else {
            fingerprint_file(Path::new(video_path)).map(Some)
        };
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        // All concurrent callers share this lock. Recheck after hashing, and persist + register
        // the winner before releasing it: no second caller can create or launch the same request.
        if let Some(existing) =
            self.existing_request(&jobs, &job_id, video_path, &timestamps, &percentages)?
        {
            return Ok(existing);
        }
        let source_fingerprint = source_fingerprint_result?;
        let now = now_ms();
        let output_directory = self.job_output_directory(&job_id);
        let record = VideoFrameExtractionJobRecord {
            job_id: job_id.clone(),
            video_path: video_path.to_string(),
            status: VideoFrameExtractionStatus::PreparingEngine,
            progress: None,
            frames: Vec::new(),
            error: None,
            created_at: now,
            updated_at: now,
            output_directory: output_directory.to_string_lossy().into_owned(),
            requested_timestamps: timestamps,
            requested_percentages: percentages,
            resolved_timestamps: Vec::new(),
            source_fingerprint,
        };
        self.persist_record(&record)?;
        retain_recent_jobs(&mut jobs);
        jobs.insert(
            job_id.clone(),
            JobEntry {
                record: record.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
                running: true,
            },
        );
        drop(jobs);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.run_extraction(job_id).await;
        });
        Ok(record)
    }

    fn existing_request(
        &self,
        jobs: &HashMap<String, JobEntry>,
        job_id: &str,
        video_path: &str,
        timestamps: &[f64],
        percentages: &[f64],
    ) -> BackendResult<Option<VideoFrameExtractionJobRecord>> {
        let existing = if let Some(entry) = jobs.get(job_id) {
            Some(entry.record.clone())
        } else if let Some(storage) = &self.inner.storage {
            storage.get_frame_extraction_job(job_id)?
        } else {
            None
        };
        if let Some(record) = &existing {
            if record.video_path != video_path
                || record.requested_timestamps != timestamps
                || record.requested_percentages != percentages
            {
                return Err(BackendError::validation(
                    "相同抽帧提交标识对应不同的视频或参数，请创建新批次",
                    serde_json::json!({ "jobId": job_id }),
                ));
            }
        }
        Ok(existing)
    }

    pub fn get_job(&self, job_id: &str) -> BackendResult<VideoFrameExtractionJobRecord> {
        let jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        if let Some(entry) = jobs.get(job_id) {
            return Ok(entry.record.clone());
        }
        drop(jobs);
        if let Some(storage) = &self.inner.storage {
            if let Some(record) = storage.get_frame_extraction_job(job_id)? {
                return Ok(record);
            }
        }
        Err(BackendError::NotFound(format!(
            "frame extraction job {job_id}"
        )))
    }

    /// Resume the exact persisted request. Existing verified frames retain their paths.
    pub fn retry_job(&self, job_id: &str) -> BackendResult<VideoFrameExtractionJobRecord> {
        let saved = self.get_job(job_id)?;
        if !is_remote_url(&saved.video_path) {
            if let Some(expected) = &saved.source_fingerprint {
                let current = fingerprint_file(Path::new(&saved.video_path))?;
                verify_source_identity(expected, &current)?;
            }
        }
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        let entry = jobs.entry(job_id.to_string()).or_insert_with(|| JobEntry {
            record: saved,
            cancelled: Arc::new(AtomicBool::new(false)),
            running: false,
        });
        if entry.running
            || matches!(
                entry.record.status,
                VideoFrameExtractionStatus::Processing
                    | VideoFrameExtractionStatus::PreparingEngine
            )
        {
            return Err(BackendError::Conflict(
                "抽帧任务仍在运行，请等待当前进程结束".to_string(),
            ));
        }
        if entry.record.status == VideoFrameExtractionStatus::Completed {
            return Ok(entry.record.clone());
        }
        if entry.record.requested_timestamps.is_empty()
            && entry.record.requested_percentages.is_empty()
        {
            return Err(BackendError::validation(
                "旧任务缺少抽帧请求，请重新选择视频创建任务",
                Value::Null,
            ));
        }
        let mut resumed = entry.record.clone();
        resumed.status = VideoFrameExtractionStatus::PreparingEngine;
        resumed.error = None;
        resumed.updated_at = now_ms();
        self.persist_record(&resumed)?;
        entry.record = resumed.clone();
        entry.cancelled = Arc::new(AtomicBool::new(false));
        entry.running = true;
        drop(jobs);
        let service = self.clone();
        let owned_id = job_id.to_string();
        tauri::async_runtime::spawn(async move {
            service.run_extraction(owned_id).await;
        });
        Ok(resumed)
    }

    /// Cancellation also interrupts FFmpeg and remote downloads, and is terminal for this run.
    pub fn cancel_job(&self, job_id: &str) -> BackendResult<VideoFrameExtractionJobRecord> {
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| BackendError::NotFound(format!("frame extraction job {job_id}")))?;
        if matches!(
            entry.record.status,
            VideoFrameExtractionStatus::PreparingEngine
                | VideoFrameExtractionStatus::Processing
                | VideoFrameExtractionStatus::Paused
        ) {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry.record.status = VideoFrameExtractionStatus::Cancelled;
            entry.record.updated_at = now_ms();
            entry.record.error = None;
            self.persist_record(&entry.record)?;
        }
        Ok(entry.record.clone())
    }

    fn persist_record(&self, record: &VideoFrameExtractionJobRecord) -> BackendResult<()> {
        if let Some(storage) = &self.inner.storage {
            storage.save_frame_extraction_job(record)?;
        }
        Ok(())
    }

    fn job_output_directory(&self, job_id: &str) -> PathBuf {
        self.inner
            .downloads_dir
            .join("无限画布")
            .join("抽帧")
            .join(job_id)
    }

    fn cancellation_flag(&self, job_id: &str) -> BackendResult<Arc<AtomicBool>> {
        self.inner
            .jobs
            .lock()
            .expect("frame jobs poisoned")
            .get(job_id)
            .map(|entry| entry.cancelled.clone())
            .ok_or_else(|| BackendError::NotFound(format!("frame extraction job {job_id}")))
    }

    fn update_record(
        &self,
        job_id: &str,
        mutate: impl FnOnce(&mut VideoFrameExtractionJobRecord),
    ) -> BackendResult<()> {
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        if let Some(entry) = jobs.get_mut(job_id) {
            if entry.cancelled.load(Ordering::Relaxed) {
                return Err(cancelled_error());
            }
            let mut updated = entry.record.clone();
            mutate(&mut updated);
            updated.updated_at = now_ms();
            self.persist_record(&updated)?;
            entry.record = updated;
        }
        Ok(())
    }

    fn checkpoint_frame(
        &self,
        job_id: &str,
        index: usize,
        frame: ExtractedFrame,
        total: usize,
    ) -> BackendResult<()> {
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| BackendError::NotFound(format!("frame extraction job {job_id}")))?;
        ensure_not_cancelled(&entry.cancelled)?;
        if index > entry.record.frames.len() {
            return Err(BackendError::protocol(
                "抽帧检查点顺序异常，请继续抽帧恢复",
                Value::Null,
            ));
        }
        let progress = (((index + 1) as f64 / total as f64) * 100.0).clamp(0.0, 99.0);
        let progress = entry
            .record
            .progress
            .map_or(progress, |value| value.max(progress));
        let updated_at = now_ms();
        if let Some(storage) = &self.inner.storage {
            storage.checkpoint_frame_extraction(job_id, index, &frame, progress, updated_at)?;
        }
        // Mutate memory only after the incremental DB transaction commits.
        entry.record.frames.truncate(index);
        entry.record.frames.push(frame);
        entry.record.progress = Some(progress);
        entry.record.updated_at = updated_at;
        Ok(())
    }

    fn fail_job(&self, job_id: &str, message: String) {
        if self.is_cancelled(job_id) {
            return;
        }
        let result = self.update_record(job_id, |record| {
            record.status = VideoFrameExtractionStatus::Failed;
            record.error = Some(message);
        });
        if let Err(error) = result {
            // A disk/DB failure must stop processing; surface it without claiming a checkpoint.
            if let Some(entry) = self
                .inner
                .jobs
                .lock()
                .expect("frame jobs poisoned")
                .get_mut(job_id)
            {
                if !entry.cancelled.load(Ordering::Relaxed) {
                    entry.record.status = VideoFrameExtractionStatus::Failed;
                    entry.record.error = Some(format!("保存抽帧进度失败：{error}"));
                }
            }
        }
    }

    fn is_cancelled(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .expect("frame jobs poisoned")
            .get(job_id)
            .is_some_and(|entry| entry.cancelled.load(Ordering::Relaxed))
    }

    /// FFmpeg 二进制：系统（PATH + 平台兜底目录）可用则直接用，否则复用合成服务内置引擎。
    async fn resolve_ffmpeg_binary(&self) -> Option<PathBuf> {
        if let Some(system) = super::system_ffmpeg::resolve().await {
            return Some(system.path);
        }
        self.inner.composer.ensure_ffmpeg().await.ok()
    }

    async fn run_extraction(&self, job_id: String) {
        if let Err(error) = self.perform_extraction(&job_id).await {
            self.fail_job(&job_id, error.to_string());
        }
        if let Some(entry) = self
            .inner
            .jobs
            .lock()
            .expect("frame jobs poisoned")
            .get_mut(&job_id)
        {
            entry.running = false;
        }
    }

    async fn perform_extraction(&self, job_id: &str) -> BackendResult<()> {
        let cancelled = self.cancellation_flag(job_id)?;
        let ffmpeg = cancellable(&cancelled, self.resolve_ffmpeg_binary())
            .await?
            .ok_or_else(|| BackendError::protocol("FFmpeg 不可用，无法执行抽帧", Value::Null))?;
        self.update_record(job_id, |record| {
            record.status = VideoFrameExtractionStatus::Processing;
        })?;
        let saved = self.get_job(job_id)?;
        let out_dir = if saved.output_directory.is_empty() {
            self.job_output_directory(job_id)
        } else {
            PathBuf::from(&saved.output_directory)
        };
        tokio::fs::create_dir_all(&out_dir).await?;

        // RAII removes remote source bytes on success, validation failure and cancellation.
        let temporary_source = if is_remote_url(&saved.video_path) {
            Some(TemporaryFile(out_dir.join(format!(
                ".source-{}{}",
                Uuid::new_v4(),
                remote_extension(&saved.video_path)
            ))))
        } else {
            None
        };
        let local_source = if let Some(temporary) = &temporary_source {
            cancellable(
                &cancelled,
                download_remote_video(&saved.video_path, &temporary.0),
            )
            .await??
        } else {
            PathBuf::from(&saved.video_path)
        };
        let fingerprint = fingerprint_file_async(local_source.clone(), cancelled.clone()).await?;
        if let Some(expected) = &saved.source_fingerprint {
            verify_source_identity(expected, &fingerprint)?;
        }
        self.update_record(job_id, |record| {
            record.source_fingerprint = Some(fingerprint.clone());
            record.output_directory = out_dir.to_string_lossy().into_owned();
        })?;

        let duration = probe_video_duration(&ffmpeg, &local_source, &cancelled).await?;
        let timestamps = if !saved.resolved_timestamps.is_empty() {
            saved.resolved_timestamps.clone()
        } else if saved.requested_percentages.is_empty() {
            saved.requested_timestamps.clone()
        } else {
            saved
                .requested_percentages
                .iter()
                .map(|percentage| (duration * percentage).min((duration - 0.01).max(0.0)))
                .collect()
        };
        for timestamp in &timestamps {
            if *timestamp >= duration {
                return Err(BackendError::validation(
                    format!(
                        "抽帧秒数 {} 超过视频时长 {:.3} 秒",
                        format_seconds(*timestamp),
                        duration
                    ),
                    Value::Null,
                ));
            }
        }
        self.update_record(job_id, |record| {
            record.resolved_timestamps = timestamps.clone();
        })?;

        let stem = safe_stem(&if is_remote_url(&saved.video_path) {
            remote_stem(&saved.video_path)
        } else {
            video_stem(Path::new(&saved.video_path))
        });
        let mut frames = Vec::with_capacity(timestamps.len());
        let mut saved_frames: Vec<_> = saved.frames.iter().collect();
        saved_frames.sort_by(|a, b| a.timestamp_seconds.total_cmp(&b.timestamp_seconds));
        let existing_frame = |timestamp: f64| {
            let index = saved_frames
                .partition_point(|frame| frame.timestamp_seconds < timestamp - 0.000001);
            saved_frames.get(index).copied().filter(|frame| {
                (frame.timestamp_seconds - timestamp).abs() < 0.000001
                    && verified_frame(frame, &out_dir)
            })
        };
        let mut index = 0;
        while index < timestamps.len() {
            ensure_not_cancelled(&cancelled)?;
            if let Some(frame) = existing_frame(timestamps[index]) {
                self.checkpoint_frame(job_id, index, frame.clone(), timestamps.len())?;
                frames.push(frame.clone());
                index += 1;
                continue;
            }
            let end = frame_batch_end(&timestamps, index);
            let mut targets = Vec::with_capacity(end - index);
            for (offset, timestamp) in timestamps[index..end].iter().copied().enumerate() {
                let next = index + offset;
                if next > index && existing_frame(timestamp).is_some() {
                    break;
                }
                let candidate = out_dir.join(format!(
                    "{:06}-{stem}@{}.jpg",
                    next + 1,
                    format_seconds(timestamp)
                ));
                // Never overwrite a damaged/changed prior artifact or an uncheckpointed file.
                let output = if candidate.exists() {
                    out_dir.join(format!(
                        "{:06}-{stem}@{}-{}.jpg",
                        next + 1,
                        format_seconds(timestamp),
                        Uuid::new_v4()
                    ))
                } else {
                    candidate
                };
                targets.push(FrameExtractionTarget { timestamp, output });
            }
            extract_frame_batch(&ffmpeg, &local_source, &targets, &cancelled, |frame| {
                self.checkpoint_frame(job_id, frames.len(), frame.clone(), timestamps.len())?;
                frames.push(frame);
                Ok(())
            })
            .await?;
            index += targets.len();
        }
        // Source changes while processing invalidate the whole attempt; retained outputs stay visible.
        let final_fingerprint = fingerprint_file_async(local_source, cancelled.clone()).await?;
        verify_source_identity(&fingerprint, &final_fingerprint)?;
        if frames.iter().any(|frame| !verified_frame(frame, &out_dir)) {
            return Err(BackendError::protocol(
                "抽帧输出不完整或已被修改，请继续抽帧修复",
                Value::Null,
            ));
        }
        self.update_record(job_id, |record| {
            record.status = VideoFrameExtractionStatus::Completed;
            record.progress = Some(100.0);
            record.error = None;
        })?;
        Ok(())
    }
}

/// 用 ffmpeg 探测视频时长（秒）；无法读取或取消时返回错误。
async fn probe_video_duration(
    ffmpeg: &Path,
    source: &Path,
    cancelled: &Arc<AtomicBool>,
) -> BackendResult<f64> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .arg("-i")
        .arg(source)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = run_cancellable_command(command, cancelled).await?;
    let text = String::from_utf8_lossy(&output.stderr);
    parse_duration(&text)
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| {
            BackendError::validation("无法读取视频时长，请确认该文件是有效的视频", Value::Null)
        })
}

/// 从 ffmpeg 探测文本解析 `Duration: HH:MM:SS.xx`。
/// 合成服务在缺少 ffprobe 时也复用这里（macOS 的 ffmpeg 发行包不含 ffprobe）。
pub(crate) fn parse_duration(text: &str) -> Option<f64> {
    let re = Regex::new(r"Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)").ok()?;
    let captures = re.captures(text)?;
    let hours: f64 = captures.get(1)?.as_str().parse().ok()?;
    let minutes: f64 = captures.get(2)?.as_str().parse().ok()?;
    let seconds: f64 = captures.get(3)?.as_str().parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

struct FrameExtractionTarget {
    timestamp: f64,
    output: PathBuf,
}

fn frame_batch_end(timestamps: &[f64], start: usize) -> usize {
    let mut end = start + 1;
    while end < timestamps.len()
        && end - start < FRAME_BATCH_LIMIT
        && timestamps[end] - timestamps[end - 1] <= FRAME_BATCH_MAX_GAP
        && timestamps[end] - timestamps[start] <= FRAME_BATCH_MAX_SPAN
    {
        end += 1;
    }
    end
}

/// One input decode, independent output seeks: close points can legitimately share a source
/// frame, including VFR media. Publish/checkpoint each verified output before handling the next.
async fn extract_frame_batch(
    ffmpeg: &Path,
    source: &Path,
    targets: &[FrameExtractionTarget],
    cancelled: &Arc<AtomicBool>,
    mut on_frame: impl FnMut(ExtractedFrame) -> BackendResult<()>,
) -> BackendResult<()> {
    let Some(first) = targets.first() else {
        return Ok(());
    };
    let temporary: Vec<_> = targets
        .iter()
        .map(|target| {
            TemporaryFile(
                target
                    .output
                    .with_file_name(format!(".frame-{}.jpg", Uuid::new_v4())),
            )
        })
        .collect();
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .arg("-n")
        .arg("-ss")
        .arg(format_seconds(first.timestamp))
        .arg("-i")
        .arg(source);
    for (target, temporary) in targets.iter().zip(&temporary) {
        command
            .arg("-ss")
            .arg(format_seconds(target.timestamp - first.timestamp))
            .args(["-frames:v", "1", "-q:v", "2", "-threads:v", "1"])
            .arg(&temporary.0);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let result = run_cancellable_command(command, cancelled).await?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(BackendError::protocol(
            "ffmpeg 抽帧失败",
            serde_json::json!({ "detail": truncate_text(&stderr, 400) }),
        ));
    }
    for (target, temporary) in targets.iter().zip(&temporary) {
        ensure_not_cancelled(cancelled)?;
        let frame = publish_frame(&temporary.0, target.timestamp, &target.output, cancelled)?;
        on_frame(frame)?;
    }
    Ok(())
}

fn publish_frame(
    temporary: &Path,
    timestamp_seconds: f64,
    output: &Path,
    cancelled: &Arc<AtomicBool>,
) -> BackendResult<ExtractedFrame> {
    let mut frame = inspect_frame(temporary, timestamp_seconds)?;
    ensure_not_cancelled(cancelled)?;
    // create_new works on removable disks too and cannot clobber a prior artifact.
    let mut source_file = std::fs::File::open(temporary)?;
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    if let Err(error) =
        std::io::copy(&mut source_file, &mut destination).and_then(|_| destination.sync_all())
    {
        drop(destination);
        let _ = std::fs::remove_file(output);
        return Err(error.into());
    }
    drop(destination);
    frame.path = output.to_string_lossy().into_owned();
    Ok(frame)
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cancelled_error() -> BackendError {
    BackendError::Conflict("抽帧任务已取消".to_string())
}

fn ensure_not_cancelled(cancelled: &Arc<AtomicBool>) -> BackendResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

async fn cancellable<T>(
    cancelled: &Arc<AtomicBool>,
    future: impl std::future::Future<Output = T>,
) -> BackendResult<T> {
    ensure_not_cancelled(cancelled)?;
    tokio::select! {
        result = future => { ensure_not_cancelled(cancelled)?; Ok(result) },
        _ = async {
            loop {
                if cancelled.load(Ordering::Relaxed) { break; }
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
            }
        } => Err(cancelled_error()),
    }
}

/// Drain both pipes while FFmpeg runs, and reap it before releasing temporary input files.
/// In particular, Windows cannot remove a downloaded source while a killed child still owns it.
async fn run_cancellable_command(
    mut command: tokio::process::Command,
    cancelled: &Arc<AtomicBool>,
) -> BackendResult<std::process::Output> {
    ensure_not_cancelled(cancelled)?;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let status = async {
        let wait_result = cancellable(cancelled, child.wait()).await;
        match wait_result {
            Ok(status) => status.map_err(BackendError::from),
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(error)
            }
        }
    };
    let (stdout_result, stderr_result, status_result) = tokio::join!(
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut stdout_bytes),
        tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut stderr_bytes),
        status,
    );
    let status = status_result?;
    stdout_result?;
    stderr_result?;
    Ok(std::process::Output {
        status,
        stdout: stdout_bytes,
        stderr: stderr_bytes,
    })
}

fn fingerprint_file(path: &Path) -> BackendResult<FrameSourceFingerprint> {
    fingerprint_file_cancellable(path, None)
}

fn fingerprint_file_cancellable(
    path: &Path,
    cancelled: Option<&Arc<AtomicBool>>,
) -> BackendResult<FrameSourceFingerprint> {
    let mut file = std::fs::File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() == 0 {
        return Err(BackendError::validation(
            "源视频文件为空或不可读取",
            Value::Null,
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if let Some(flag) = cancelled {
            ensure_not_cancelled(flag)?;
        }
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(BackendError::validation(
            "读取期间源视频已被修改，请重新创建抽帧任务",
            Value::Null,
        ));
    }
    Ok(FrameSourceFingerprint {
        byte_size: after.len(),
        modified_at_ms: after
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64),
        sha256: hex::encode(digest.finalize()),
    })
}

async fn fingerprint_file_async(
    path: PathBuf,
    cancelled: Arc<AtomicBool>,
) -> BackendResult<FrameSourceFingerprint> {
    let flag = cancelled.clone();
    cancellable(
        &cancelled,
        tauri::async_runtime::spawn_blocking(move || {
            fingerprint_file_cancellable(&path, Some(&flag))
        }),
    )
    .await?
    .map_err(|error| BackendError::Conflict(format!("读取源视频失败：{error}")))?
}

fn verify_source_identity(
    expected: &FrameSourceFingerprint,
    current: &FrameSourceFingerprint,
) -> BackendResult<()> {
    if expected.byte_size != current.byte_size || expected.sha256 != current.sha256 {
        return Err(BackendError::validation(
            "源视频内容已被替换，请重新创建抽帧任务；已有帧保留",
            Value::Null,
        ));
    }
    Ok(())
}

fn inspect_frame(path: &Path, timestamp_seconds: f64) -> BackendResult<ExtractedFrame> {
    let fingerprint = fingerprint_file(path)?;
    let decoded = image::open(path).map_err(|error| {
        BackendError::protocol(
            "抽帧图片无效或不完整",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(BackendError::protocol("抽帧图片尺寸无效", Value::Null));
    }
    Ok(ExtractedFrame {
        path: path.to_string_lossy().into_owned(),
        timestamp_seconds,
        width: decoded.width(),
        height: decoded.height(),
        byte_size: fingerprint.byte_size,
        sha256: fingerprint.sha256,
    })
}

fn verified_frame(frame: &ExtractedFrame, directory: &Path) -> bool {
    let path = Path::new(&frame.path);
    if path.parent() != Some(directory) || frame.sha256.is_empty() {
        return false;
    }
    inspect_frame(path, frame.timestamp_seconds).is_ok_and(|actual| {
        actual.byte_size == frame.byte_size
            && actual.sha256 == frame.sha256
            && actual.width == frame.width
            && actual.height == frame.height
    })
}

fn safe_stem(stem: &str) -> String {
    stem.chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .take(80)
        .collect()
}

/// 视频文件名（去掉扩展名）作为抽帧产物前缀。
fn video_stem(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "视频".to_string())
}

/// 秒数转文件名友好的字符串：整数去尾零（3 → "3"），小数保留（3.5 → "3.5"）。
fn format_seconds(seconds: f64) -> String {
    let rounded = seconds.round();
    if (seconds - rounded).abs() < f64::EPSILON * 8.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{seconds}")
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut result: String = trimmed.chars().take(max_chars).collect();
    result.push('…');
    result
}

/// 判断是否为可下载的远程 http(s) 视频地址。
fn is_remote_url(source: &str) -> bool {
    let lower = source.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 从远程 URL 提取文件名主干（去掉扩展名与查询参数），用作抽帧产物前缀。
fn remote_stem(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query.rsplit('/').next().unwrap_or("");
    let stem = match last.rfind('.') {
        Some(index) if index > 0 => &last[..index],
        _ => last,
    }
    .trim();
    if stem.is_empty() {
        "remote-video".to_string()
    } else {
        stem.to_string()
    }
}

/// 从远程 URL 提取扩展名；无扩展名或异常时回退 .mp4。
fn remote_extension(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query.rsplit('/').next().unwrap_or("");
    let ext = match last.rfind('.') {
        Some(index) if index > 0 && index + 1 < last.len() => &last[index + 1..],
        _ => "",
    }
    .trim();
    if ext.is_empty() || ext.contains('/') || ext.len() > 8 || is_remote_url(ext) {
        ".mp4".to_string()
    } else {
        format!(".{ext}")
    }
}

/// 下载远程视频到本地文件，供 ffmpeg 抽帧使用。成功返回本地路径。
async fn download_remote_video(url: &str, target: &Path) -> BackendResult<PathBuf> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|error| {
            BackendError::protocol(
                "初始化下载客户端失败",
                serde_json::json!({ "detail": error.to_string() }),
            )
        })?;
    let mut response = client.get(url).send().await.map_err(|error| {
        BackendError::protocol(
            "无法连接远程视频地址",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })?;
    if !response.status().is_success() {
        return Err(BackendError::protocol(
            "远程视频下载返回异常状态",
            serde_json::json!({ "status": response.status().as_u16(), "url": url }),
        ));
    }
    let mut file = tokio::fs::File::create(target).await.map_err(|error| {
        BackendError::protocol(
            "创建远程视频临时文件失败",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })?;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        BackendError::protocol(
            "下载远程视频中断",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })? {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| {
                BackendError::protocol(
                    "写入远程视频临时文件失败",
                    serde_json::json!({ "detail": error.to_string() }),
                )
            })?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.ok();
    drop(file);
    Ok(target.to_path_buf())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 内存任务上限：超出后丢弃最旧的已终态记录。
fn retain_recent_jobs(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < JOB_RETAIN_LIMIT {
        return;
    }
    let mut terminal: Vec<(String, i64)> = jobs
        .iter()
        .filter(|(_, entry)| {
            !entry.running
                && matches!(
                    entry.record.status,
                    VideoFrameExtractionStatus::Completed
                        | VideoFrameExtractionStatus::Failed
                        | VideoFrameExtractionStatus::Cancelled
                )
        })
        .map(|(key, entry)| (key.clone(), entry.record.updated_at))
        .collect();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    let remove_count = jobs.len().saturating_sub(JOB_RETAIN_LIMIT - 1);
    for (key, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&key);
    }
}
