//! Local continuous depth and AI vocal separation. Every attempt is private until all
//! requested outputs pass validation; process-tree ownership makes cancellation real.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::{Notify, Semaphore},
};
use uuid::Uuid;

use super::{
    ai_media_runtime::{AiMediaRuntime, AiMediaRuntimeStatus},
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    mv_media::source_signature,
    process_tree::ProcessTree,
    storage::Storage,
    types::{MediaReferenceTarget, MediaType},
    video_edit_source::VideoEditSourceService,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMediaOperation {
    VideoDepth,
    AudioSeparation,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMediaMode {
    #[default]
    Lite,
    Quality,
}
fn default_existing_mode() -> AiMediaMode {
    AiMediaMode::Quality
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMediaDevice {
    #[default]
    Auto,
    Cpu,
    Cuda,
    Mps,
    Directml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMediaStatus {
    Preparing,
    Processing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}
impl AiMediaStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Processing => "processing",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

fn default_depth_size() -> u32 {
    480
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAiMediaCommand {
    pub source: MediaReferenceTarget,
    pub name: String,
    pub operation: AiMediaOperation,
    #[serde(default)]
    pub mode: AiMediaMode,
    #[serde(default)]
    pub start_seconds: f64,
    pub end_seconds: Option<f64>,
    pub audio_stream_index: Option<u32>,
    #[serde(default = "default_depth_size")]
    pub depth_max_side: u32,
    #[serde(default)]
    pub device: AiMediaDevice,
    pub source_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaOutput {
    pub result_index: u32,
    pub role: String,
    pub kind: String,
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub duration_seconds: f64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaJobRecord {
    pub job_id: String,
    pub source: MediaReferenceTarget,
    pub source_identity: String,
    pub name: String,
    pub operation: AiMediaOperation,
    #[serde(default = "default_existing_mode")]
    pub mode: AiMediaMode,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub audio_stream_index: Option<u32>,
    pub depth_max_side: u32,
    pub device: AiMediaDevice,
    #[serde(default)]
    pub actual_device: Option<String>,
    pub status: AiMediaStatus,
    pub progress: Option<f64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub outputs: Vec<AiMediaOutput>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}
impl Cancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    fn check(&self) -> BackendResult<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(invalid("AI 媒体任务已取消。"))
        } else {
            Ok(())
        }
    }
    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.cancelled.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

struct Inner {
    directory: PathBuf,
    composer: VideoCompositionService,
    sources: VideoEditSourceService,
    storage: Arc<Storage>,
    runtime: AiMediaRuntime,
    active: Mutex<HashMap<String, Arc<Cancellation>>>,
    workers: Semaphore,
}

#[derive(Clone)]
pub struct AiMediaService {
    inner: Arc<Inner>,
}

impl AiMediaService {
    pub fn new(
        downloads_dir: PathBuf,
        app_local_data_dir: PathBuf,
        resource_dir: PathBuf,
        composer: VideoCompositionService,
        sources: VideoEditSourceService,
        storage: Arc<Storage>,
    ) -> BackendResult<Self> {
        storage.initialize_ai_media()?;
        Ok(Self {
            inner: Arc::new(Inner {
                directory: downloads_dir.join("无限画布").join("AI媒体准备"),
                composer,
                sources,
                storage,
                runtime: AiMediaRuntime::new(app_local_data_dir, resource_dir),
                active: Mutex::new(HashMap::new()),
                workers: Semaphore::new(1),
            }),
        })
    }

    pub fn runtime_status(&self, mode: AiMediaMode) -> AiMediaRuntimeStatus {
        self.inner.runtime.status(mode)
    }
    pub async fn import_runtime(
        &self,
        root_path: &str,
        mode: AiMediaMode,
    ) -> BackendResult<AiMediaRuntimeStatus> {
        self.inner.runtime.import(root_path, mode).await
    }

    pub async fn start(&self, command: StartAiMediaCommand) -> BackendResult<AiMediaJobRecord> {
        self.inner.runtime.resolve(command.mode)?;
        validate_device(command.mode, command.device)?;
        if command.source.media_type() != MediaType::Video {
            return Err(invalid(
                "请选择视频素材，AI 音轨分离会处理视频中选定的音轨。",
            ));
        }
        let preview = self.inner.sources.prepare(&command.source).await?;
        let result = async {
            let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
            let before = source_signature(&preview.path).await?;
            let probe = probe_media(&ffmpeg, &preview.path).await?;
            if before != source_signature(&preview.path).await?
                || command
                    .source_identity
                    .as_ref()
                    .is_some_and(|identity| identity != &before)
            {
                return Err(changed_source());
            }
            let end = command.end_seconds.unwrap_or(probe.duration);
            validate_window(
                command.start_seconds,
                end,
                probe.duration,
                command.depth_max_side,
            )?;
            validate_source(command.operation, &probe, command.audio_stream_index)?;
            let now = now_ms();
            Ok(AiMediaJobRecord {
                job_id: format!("ai-media-{}", Uuid::new_v4()),
                source: command.source,
                source_identity: before,
                name: safe_name(&command.name),
                operation: command.operation,
                mode: command.mode,
                start_seconds: command.start_seconds,
                end_seconds: end,
                audio_stream_index: if command.operation == AiMediaOperation::AudioSeparation {
                    Some(command.audio_stream_index.unwrap_or(probe.audio[0]))
                } else {
                    None
                },
                depth_max_side: command.depth_max_side,
                device: command.device,
                actual_device: None,
                status: AiMediaStatus::Preparing,
                progress: Some(0.0),
                message: Some("等待本地推理引擎。".into()),
                outputs: Vec::new(),
                error: None,
                created_at: now,
                updated_at: now,
            })
        }
        .await;
        let released = self.inner.sources.release(&preview.preview_id).await;
        let record = result?;
        released?;
        self.launch(record.clone())?;
        Ok(record)
    }

    pub fn get(&self, job_id: &str) -> BackendResult<Option<AiMediaJobRecord>> {
        self.inner.storage.ai_media_job(job_id)
    }
    pub fn list(&self) -> BackendResult<Vec<AiMediaJobRecord>> {
        self.inner.storage.ai_media_jobs()
    }
    fn require_job(&self, job_id: &str) -> BackendResult<AiMediaJobRecord> {
        self.get(job_id)?
            .ok_or_else(|| BackendError::NotFound("AI 媒体任务不存在。".into()))
    }

    pub fn retry(&self, job_id: &str) -> BackendResult<AiMediaJobRecord> {
        let mut record = self.require_job(job_id)?;
        self.inner.runtime.resolve(record.mode)?;
        validate_device(record.mode, record.device)?;
        if record.status == AiMediaStatus::Completed {
            return Ok(record);
        }
        if matches!(
            record.status,
            AiMediaStatus::Preparing | AiMediaStatus::Processing
        ) {
            return Err(BackendError::Conflict(
                "任务仍在处理，请先取消或等待完成。".into(),
            ));
        }
        record.status = AiMediaStatus::Preparing;
        record.updated_at = now_ms();
        record.progress = Some(0.0);
        record.error = None;
        record.outputs.clear();
        record.actual_device = None;
        record.message = Some("重新校验原素材，等待本地推理引擎。".into());
        self.launch(record.clone())?;
        Ok(record)
    }

    pub fn cancel(&self, job_id: &str) -> BackendResult<AiMediaJobRecord> {
        let active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("AI 媒体状态锁不可用。"))?;
        let mut record = self.require_job(job_id)?;
        if matches!(
            record.status,
            AiMediaStatus::Completed | AiMediaStatus::Failed | AiMediaStatus::Cancelled
        ) {
            return Ok(record);
        }
        if let Some(cancel) = active.get(job_id) {
            cancel.cancel();
        }
        record.status = AiMediaStatus::Cancelled;
        record.updated_at = now_ms();
        record.error = None;
        record.message = Some("任务已取消，未发布产物。".into());
        record.outputs.clear();
        self.inner.storage.save_ai_media(&record)?;
        Ok(record)
    }

    pub fn rename_output(
        &self,
        job_id: &str,
        result_index: u32,
        name: &str,
    ) -> BackendResult<AiMediaJobRecord> {
        let _active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("AI 媒体状态锁不可用。"))?;
        let mut record = self.require_job(job_id)?;
        if record.status != AiMediaStatus::Completed {
            return Err(BackendError::Conflict("任务完成后才能命名产物。".into()));
        }
        let output = record
            .outputs
            .iter_mut()
            .find(|output| output.result_index == result_index)
            .ok_or_else(|| invalid("这个产物不存在。"))?;
        validate_name(name)?;
        let path = Path::new(&output.path);
        if !path.is_absolute() || !path.is_file() || path.metadata()?.len() == 0 {
            return Err(invalid("产物文件不存在或不可读取。"));
        }
        std::fs::File::open(path)?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| invalid("产物缺少实际扩展名。"))?;
        let suffix = format!(".{extension}");
        let trimmed = name.trim();
        let base = if trimmed
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase())
        {
            &trimmed[..trimmed.len() - suffix.len()]
        } else {
            trimmed
        };
        validate_name(base)?;
        output.name = format!("{base}{suffix}");
        record.updated_at = now_ms();
        self.inner.storage.save_ai_media(&record)?;
        Ok(record)
    }

    fn launch(&self, record: AiMediaJobRecord) -> BackendResult<()> {
        let mut active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("AI 媒体状态锁不可用。"))?;
        if active.contains_key(&record.job_id) {
            return Err(BackendError::Conflict("任务正在退出，请稍后继续。".into()));
        }
        if self.get(&record.job_id)?.is_some_and(|existing| {
            matches!(
                existing.status,
                AiMediaStatus::Preparing | AiMediaStatus::Processing | AiMediaStatus::Completed
            )
        }) {
            return Err(BackendError::Conflict(
                "任务状态已改变，请刷新后继续。".into(),
            ));
        }
        self.inner.storage.save_ai_media(&record)?;
        let cancel = Arc::new(Cancellation::default());
        active.insert(record.job_id.clone(), cancel.clone());
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.run(record, cancel).await;
        });
        Ok(())
    }

    async fn run(&self, mut record: AiMediaJobRecord, cancel: Arc<Cancellation>) {
        let result = async {
            let _permit = tokio::select! { permit = self.inner.workers.acquire() => permit.map_err(|_| invalid("本地推理队列已关闭。"))?, () = cancel.wait() => return Err(invalid("AI 媒体任务已取消。")), };
            cancel.check()?;
            let preview = self.inner.sources.prepare(&record.source).await?;
            let result = self.process(&mut record, &preview.path, &cancel).await;
            let released = self.inner.sources.release(&preview.preview_id).await;
            match (result, released) { (Err(error), _) => Err(error), (Ok(delivery), Ok(())) => Ok(delivery), (Ok(delivery), Err(error)) => { cleanup_delivery(&self.inner.directory, &delivery.directory).await; Err(error) } }
        }.await;
        let mut unregistered = None;
        {
            let _active = self.inner.active.lock();
            if _active.is_ok() && !cancel.cancelled.load(Ordering::SeqCst) {
                match result {
                    Ok(delivery) => {
                        unregistered = Some(delivery.directory);
                        record.outputs = delivery.outputs;
                        record.status = AiMediaStatus::Completed;
                        record.progress = Some(100.0);
                        record.message = Some("处理完成，产物已保存。".into());
                        record.error = None;
                    }
                    Err(error) => {
                        record.status = AiMediaStatus::Failed;
                        record.error = Some(error.to_string());
                        record.outputs.clear();
                    }
                }
                record.updated_at = now_ms();
                match self.inner.storage.save_active_ai_media(&record) {
                    Ok(true) => unregistered = None,
                    Ok(false) => (),
                    Err(error) => eprintln!("[ai-media] 无法保存任务 {}: {error}", record.job_id),
                }
            } else if let Ok(delivery) = result {
                unregistered = Some(delivery.directory);
            }
        }
        if let Some(directory) = unregistered {
            cleanup_delivery(&self.inner.directory, &directory).await;
        }
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(&record.job_id);
        }
    }

    async fn process(
        &self,
        record: &mut AiMediaJobRecord,
        source_path: &str,
        cancel: &Cancellation,
    ) -> BackendResult<Delivery> {
        cancel.check()?;
        let runtime = self.inner.runtime.resolve(record.mode)?;
        let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
        let ffprobe = ffprobe_path(&ffmpeg)?;
        cancel.check()?;
        if source_signature(source_path).await? != record.source_identity {
            return Err(changed_source());
        }
        let probe = probe_media(&ffmpeg, source_path).await?;
        validate_window(
            record.start_seconds,
            record.end_seconds,
            probe.duration,
            record.depth_max_side,
        )?;
        validate_source(record.operation, &probe, record.audio_stream_index)?;
        let job_dir = job_directory(&self.inner.directory, &record.job_id)?;
        tokio::fs::create_dir_all(&job_dir).await?;
        let attempt = Uuid::new_v4().to_string();
        let staging = job_dir.join(format!(".{attempt}.partial"));
        let final_dir = job_dir.join(&attempt);
        tokio::fs::create_dir(&staging).await?;
        let result = async {
            let request = json!({"schemaVersion":1,"operation":record.operation,"mode":record.mode,"runtimeRoot":runtime.root,"modelRoot":runtime.models,"codeRoot":runtime.code,"sourcePath":source_path,"outputDir":staging,"ffmpegPath":ffmpeg,"ffprobePath":ffprobe,"name":record.name,"startSeconds":record.start_seconds,"endSeconds":record.end_seconds,"audioStreamIndex":record.audio_stream_index,"depthMaxSide":record.depth_max_side,"device":record.device});
            let request_path = staging.join("request.json");
            tokio::fs::write(&request_path, serde_json::to_vec(&request)?).await?;
            record.status = AiMediaStatus::Processing; record.updated_at = now_ms();
            if !self.inner.storage.save_active_ai_media(record)? { return Err(invalid("任务已取消。")); }
            let response = run_worker(&runtime.python, &runtime.worker, &runtime.root, &request_path, cancel, |progress, message| {
                record.progress = Some(progress); record.message = message; record.updated_at = now_ms();
                if !self.inner.storage.save_active_ai_media(record)? { return Err(invalid("任务已取消。")); } Ok(())
            }).await?;
            cancel.check()?;
            if source_signature(source_path).await? != record.source_identity { return Err(changed_source()); }
            let mut outputs = validate_worker_outputs(record, &staging, response.outputs)?;
            let metrics = validate_manifest(record, &outputs, response.actual_device.as_deref())?;
            validate_media_files(&ffmpeg,&outputs,&metrics).await?;
            cancel.check()?;
            tokio::fs::rename(&staging, &final_dir).await?;
            for output in &mut outputs {
                let relative = Path::new(&output.path).strip_prefix(&staging).map_err(|_| invalid("产物路径无效。"))?;
                output.path = final_dir.join(relative).to_string_lossy().into_owned();
            }
            record.actual_device = response.actual_device;
            Ok(Delivery { directory: final_dir.clone(), outputs })
        }.await;
        if result.is_err() {
            cleanup_delivery(&self.inner.directory, &staging).await;
            cleanup_delivery(&self.inner.directory, &final_dir).await;
        }
        result
    }
}

struct Delivery {
    directory: PathBuf,
    outputs: Vec<AiMediaOutput>,
}
struct WorkerResult {
    outputs: Vec<AiMediaOutput>,
    actual_device: Option<String>,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}
fn changed_source() -> BackendError {
    invalid("原素材内容已改变，请重新读取信息并确认处理区间。")
}
fn validate_device(mode: AiMediaMode, device: AiMediaDevice) -> BackendResult<()> {
    if (mode == AiMediaMode::Quality && device == AiMediaDevice::Directml)
        || (mode == AiMediaMode::Lite && matches!(device, AiMediaDevice::Mps | AiMediaDevice::Cuda))
    {
        return Err(invalid("这个处理模式不支持所选设备，请选择自动或 CPU。"));
    }
    Ok(())
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn job_directory(root: &Path, id: &str) -> BackendResult<PathBuf> {
    let suffix = id
        .strip_prefix("ai-media-")
        .ok_or_else(|| invalid("任务标识无效。"))?;
    Uuid::parse_str(suffix).map_err(|_| invalid("任务标识无效。"))?;
    Ok(root.join(id))
}

async fn cleanup_delivery(root: &Path, directory: &Path) {
    // Only directories created as direct attempt children of a UUID job may be removed.
    let Some(parent) = directory.parent() else {
        return;
    };
    if parent.parent() != Some(root) {
        return;
    }
    let Some(job) = parent.file_name().and_then(|v| v.to_str()) else {
        return;
    };
    if job_directory(root, job).as_deref().ok() != Some(parent) {
        return;
    }
    let Some(attempt) = directory.file_name().and_then(|v| v.to_str()) else {
        return;
    };
    let attempt = attempt
        .strip_prefix('.')
        .and_then(|v| v.strip_suffix(".partial"))
        .unwrap_or(attempt);
    if Uuid::parse_str(attempt).is_err() {
        return;
    }
    let (Ok(actual), Ok(expected)) = (directory.canonicalize(), root.canonicalize()) else {
        return;
    };
    if !actual.starts_with(expected) {
        return;
    }
    let _ = tokio::fs::remove_dir_all(directory).await;
}

fn validate_window(start: f64, end: f64, duration: f64, depth_max_side: u32) -> BackendResult<()> {
    if !start.is_finite()
        || !end.is_finite()
        || !duration.is_finite()
        || start < 0.0
        || end <= start
        || end > duration + 0.02
    {
        return Err(invalid("处理区间必须位于素材内，且结束时间晚于开始时间。"));
    }
    if ![480, 720].contains(&depth_max_side) {
        return Err(invalid("深度分辨率仅支持 480 或 720。"));
    }
    Ok(())
}

struct MediaProbe {
    duration: f64,
    width: u32,
    height: u32,
    audio: Vec<u32>,
    frames: Option<u64>,
    audio_samples: Option<u64>,
    sample_rate: Option<u32>,
    audio_channels: Option<u32>,
    audio_codec: Option<String>,
}
fn validate_source(
    operation: AiMediaOperation,
    probe: &MediaProbe,
    audio: Option<u32>,
) -> BackendResult<()> {
    match operation {
        AiMediaOperation::VideoDepth if probe.width == 0 || probe.height == 0 => {
            Err(invalid("连续深度需要有效的视频画面。"))
        }
        AiMediaOperation::AudioSeparation if probe.audio.is_empty() => {
            Err(invalid("素材没有可分离的音轨。"))
        }
        AiMediaOperation::AudioSeparation
            if audio.is_some_and(|index| !probe.audio.contains(&index)) =>
        {
            Err(invalid("选定音轨不存在，请重新读取素材信息。"))
        }
        _ => Ok(()),
    }
}
fn ffprobe_path(ffmpeg: &Path) -> BackendResult<PathBuf> {
    let path = ffmpeg.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    if !path.is_file() {
        return Err(invalid(
            "FFprobe 运行组件缺失，不能验证连续深度与分离产物。",
        ));
    }
    Ok(path)
}
fn process_command(binary: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    ProcessTree::configure(&mut command);
    command
}
async fn probe_media(ffmpeg: &Path, path: &str) -> BackendResult<MediaProbe> {
    let probe = ffprobe_path(ffmpeg)?;
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        process_command(&probe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                path,
            ])
            .output(),
    )
    .await
    .map_err(|_| invalid("读取素材信息超时。"))??;
    if !output.status.success() {
        return Err(invalid("素材信息无法读取。"));
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| invalid("素材没有有效媒体流。"))?;
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| invalid("素材没有有效时长。"))?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let sample_rate = audio.and_then(|s| {
        s["sample_rate"]
            .as_str()
            .and_then(|v| v.parse::<u32>().ok())
    });
    let audio_samples = audio.and_then(|s| {
        let rate = sample_rate?;
        (s["time_base"].as_str() == Some(format!("1/{rate}").as_str()))
            .then(|| s["duration_ts"].as_u64())
            .flatten()
    });
    Ok(MediaProbe {
        duration,
        width: video.and_then(|s| s["width"].as_u64()).unwrap_or(0) as u32,
        height: video.and_then(|s| s["height"].as_u64()).unwrap_or(0) as u32,
        audio: streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .filter_map(|s| s["index"].as_u64().and_then(|index| index.try_into().ok()))
            .collect(),
        frames: video.and_then(|s| s["nb_frames"].as_str().and_then(|v| v.parse().ok())),
        audio_samples,
        sample_rate,
        audio_channels: audio.and_then(|s| s["channels"].as_u64().and_then(|v| v.try_into().ok())),
        audio_codec: audio.and_then(|s| s["codec_name"].as_str().map(str::to_owned)),
    })
}

fn validate_worker_outputs(
    record: &AiMediaJobRecord,
    staging: &Path,
    mut outputs: Vec<AiMediaOutput>,
) -> BackendResult<Vec<AiMediaOutput>> {
    if outputs.len() != 3 {
        return Err(invalid("AI 推理未返回全部产物。"));
    }
    let mut indices = HashSet::new();
    let mut roles = HashSet::new();
    let mut paths = HashSet::new();
    let canonical = staging.canonicalize()?;
    for output in &mut outputs {
        if !indices.insert(output.result_index)
            || !roles.insert(output.role.clone())
            || !paths.insert(output.path.clone())
            || output.result_index > 2
        {
            return Err(invalid("AI 产物索引或角色重复。"));
        }
        let path = super::ai_media_runtime::relative(&output.path)
            .ok_or_else(|| invalid("AI 产物路径越出任务目录。"))?;
        let actual = staging.join(path);
        let metadata = actual.symlink_metadata()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || !actual.canonicalize()?.starts_with(&canonical)
        {
            return Err(invalid("AI 产物缺失、为空或越出任务目录。"));
        }
        if !output.duration_seconds.is_finite() || output.duration_seconds <= 0.0 {
            return Err(invalid("AI 产物时长无效。"));
        }
        validate_name(&output.name)?;
        match (
            record.operation,
            output.role.as_str(),
            output.kind.as_str(),
            actual.extension().and_then(|v| v.to_str()),
            output.mime_type.as_str(),
        ) {
            (AiMediaOperation::VideoDepth, "depth_video", "video", Some("mp4"), "video/mp4")
                if output.width.is_some_and(|v| v > 0) && output.height.is_some_and(|v| v > 0) =>
            {
                ()
            }
            (
                AiMediaOperation::VideoDepth,
                "depth_data",
                "data",
                Some("zip"),
                "application/zip",
            ) => (),
            (_, "manifest", "data", Some("json"), "application/json") => (),
            (
                AiMediaOperation::AudioSeparation,
                "vocals" | "accompaniment",
                "audio",
                Some("wav"),
                "audio/wav",
            ) => (),
            _ => return Err(invalid("AI 产物类型、格式或角色不符合当前任务。")),
        }
        output.path = actual.to_string_lossy().into_owned();
    }
    let expected = match record.operation {
        AiMediaOperation::VideoDepth => ["depth_video", "depth_data", "manifest"],
        AiMediaOperation::AudioSeparation => ["vocals", "accompaniment", "manifest"],
    };
    if !expected.iter().all(|role| roles.contains(*role)) {
        return Err(invalid("AI 推理未返回全部角色。"));
    }
    outputs.sort_by_key(|output| output.result_index);
    Ok(outputs)
}

struct DeliveryMetrics {
    duration: f64,
    duration_tolerance: f64,
    width: u32,
    height: u32,
    frames: Option<u64>,
    samples: Option<u64>,
    sample_rate: Option<u32>,
}
async fn validate_media_files(
    ffmpeg: &Path,
    outputs: &[AiMediaOutput],
    metrics: &DeliveryMetrics,
) -> BackendResult<()> {
    for output in outputs.iter().filter(|output| output.kind != "data") {
        let measured = probe_media(ffmpeg, &output.path).await?;
        if (measured.duration - metrics.duration).abs() > metrics.duration_tolerance {
            return Err(invalid("处理产物时长与选定区间不一致。"));
        }
        if output.kind == "video"
            && (measured.width == 0 || measured.height == 0 || !measured.audio.is_empty())
        {
            return Err(invalid("深度预览必须是无音轨的视频。"));
        }
        if output.kind == "video"
            && (measured.frames != metrics.frames
                || measured.width != metrics.width
                || measured.height != metrics.height)
        {
            return Err(invalid("深度预览帧数或尺寸与深度数据清单不一致。"));
        }
        if output.kind == "audio"
            && (measured.audio.is_empty()
                || measured.audio_samples != metrics.samples
                || measured.sample_rate != metrics.sample_rate
                || measured.audio_channels != Some(2)
                || measured.audio_codec.as_deref() != Some("pcm_f32le"))
        {
            return Err(invalid(
                "人声与伴奏的样本数、采样率、通道或浮点音频格式不一致。",
            ));
        }
    }
    Ok(())
}

fn number(value: &Value, key: &str) -> BackendResult<f64> {
    value[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| invalid(&format!("产物清单缺少有效的 {key}。")))
}
fn integer(value: &Value, key: &str) -> BackendResult<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| invalid(&format!("产物清单缺少有效的 {key}。")))
}
fn output_role<'a>(outputs: &'a [AiMediaOutput], role: &str) -> BackendResult<&'a AiMediaOutput> {
    outputs
        .iter()
        .find(|output| output.role == role)
        .ok_or_else(|| invalid("产物清单角色不完整。"))
}
fn validate_manifest(
    record: &AiMediaJobRecord,
    outputs: &[AiMediaOutput],
    actual_device: Option<&str>,
) -> BackendResult<DeliveryMetrics> {
    let device = actual_device
        .filter(|device| matches!(*device, "cpu" | "cuda" | "mps" | "directml"))
        .ok_or_else(|| invalid("推理引擎没有返回实际使用的有效设备。"))?;
    let actual = match device {
        "cpu" => AiMediaDevice::Cpu,
        "cuda" => AiMediaDevice::Cuda,
        "mps" => AiMediaDevice::Mps,
        _ => AiMediaDevice::Directml,
    };
    validate_device(record.mode, actual)?;
    if record.device != AiMediaDevice::Auto && record.device != actual {
        return Err(invalid("推理引擎实际设备与任务冻结的设备不一致。"));
    }
    let manifest_output = output_role(outputs, "manifest")?;
    let path = Path::new(&manifest_output.path);
    if path.metadata()?.len() > 16 * 1024 * 1024 {
        return Err(invalid("产物清单超出读取限制。"));
    }
    let bytes = std::fs::read(path)?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if value["schemaVersion"] != 1
        || value["runtimeProfile"]
            != if record.mode == AiMediaMode::Lite {
                "lite"
            } else {
                "quality"
            }
        || value["device"].as_str() != Some(device)
        || (number(&value, "startSeconds")? - record.start_seconds).abs() > 1e-7
        || (number(&value, "endSeconds")? - record.end_seconds).abs() > 1e-7
    {
        return Err(invalid("产物清单与原任务选区或设备不一致。"));
    }
    let duration = number(&value, "durationSeconds")?;
    if duration <= 0.0
        || outputs
            .iter()
            .any(|output| (output.duration_seconds - duration).abs() > 1e-6)
    {
        return Err(invalid("产物时长与数据清单不一致。"));
    }
    let mut metrics = DeliveryMetrics {
        duration,
        duration_tolerance: 0.000001,
        width: 0,
        height: 0,
        frames: None,
        samples: None,
        sample_rate: None,
    };
    match record.operation {
        AiMediaOperation::AudioSeparation => {
            if value["operation"] != "audio_separation"
                || value["model"]
                    != if record.mode == AiMediaMode::Lite {
                        "Open-Unmix-HQ vocals"
                    } else {
                        "Demucs htdemucs"
                    }
                || value["modelLicense"] != "MIT"
                || value["format"] != "float32_wav"
                || integer(&value, "channels")? != 2
                || value["audioStreamIndex"].as_u64() != record.audio_stream_index.map(u64::from)
            {
                return Err(invalid("音轨分离清单的模型、音轨或音频格式不一致。"));
            }
            let rate: u32 = integer(&value, "sampleRate")?
                .try_into()
                .map_err(|_| invalid("分离采样率无效。"))?;
            let count = integer(&value, "sampleCount")?;
            if rate != 44100
                || count == 0
                || count
                    != ((record.end_seconds - record.start_seconds) * f64::from(rate)).round()
                        as u64
                || (duration - count as f64 / f64::from(rate)).abs() > 1e-8
                || number(&value, "peakAmplitude")? < 0.0
                || !(0.0..=0.00001).contains(&number(&value, "reconstructionRmse")?)
            {
                return Err(invalid("音轨分离的样本数、增益或重建残差无效。"));
            }
            for role in ["vocals", "accompaniment"] {
                let output = output_role(outputs, role)?;
                if value["outputs"][role].as_str()
                    != Path::new(&output.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                {
                    return Err(invalid("音轨分离清单引用了其他文件。"));
                }
            }
            metrics.samples = Some(count);
            metrics.sample_rate = Some(rate);
            metrics.duration_tolerance = 2.0 / f64::from(rate);
        }
        AiMediaOperation::VideoDepth => {
            if value["operation"] != "video_depth"
                || value["model"] != "Video-Depth-Anything-Small"
                || value["modelLicense"] != "Apache-2.0"
                || value["depthType"] != "relative_inverse_depth"
                || value["units"] != "relative"
                || value["dataType"] != "float32"
                || value["temporalWindow"] != 32
                || value["overlap"] != 10
                || value["timestamps"] != "depth-timestamps.jsonl"
            {
                return Err(invalid("深度数据模型、数值类型或时序清单不一致。"));
            }
            let width: u32 = integer(&value, "width")?
                .try_into()
                .map_err(|_| invalid("深度宽度无效。"))?;
            let height: u32 = integer(&value, "height")?
                .try_into()
                .map_err(|_| invalid("深度高度无效。"))?;
            let frames = integer(&value, "frameCount")?;
            let first = number(&value, "firstSourcePtsSeconds")?;
            let last_duration = number(&value, "lastFrameDurationSeconds")?;
            if width == 0
                || height == 0
                || width.max(height) > record.depth_max_side
                || frames == 0
                || first < record.start_seconds - 1e-6
                || first >= record.end_seconds
                || last_duration <= 0.0
                || duration > record.end_seconds - first + 1e-6
                || (number(&value, "selectionOffsetSeconds")? - (first - record.start_seconds))
                    .abs()
                    > 1e-7
            {
                return Err(invalid("深度尺寸、帧数或首帧选区偏移无效。"));
            }
            let preview = output_role(outputs, "depth_video")?;
            if value["preview"].as_str()
                != Path::new(&preview.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                || preview.width != Some(width)
                || preview.height != Some(height)
            {
                return Err(invalid("深度预览与数值数据尺寸不一致。"));
            }
            validate_depth_archive(
                output_role(outputs, "depth_data")?,
                &bytes,
                &value,
                width,
                height,
                frames,
                first,
                record.end_seconds,
                duration,
                last_duration,
            )?;
            metrics.width = width;
            metrics.height = height;
            metrics.frames = Some(frames);
            metrics.duration_tolerance = last_duration + 0.000002;
        }
    }
    Ok(metrics)
}

#[allow(clippy::too_many_arguments)]
fn validate_depth_archive(
    output: &AiMediaOutput,
    manifest_bytes: &[u8],
    manifest: &Value,
    width: u32,
    height: u32,
    frame_count: u64,
    first: f64,
    end: f64,
    duration: f64,
    last_duration: f64,
) -> BackendResult<()> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&output.path)?)
        .map_err(|_| invalid("深度数据不是有效 ZIP 文件。"))?;
    let chunks = manifest["chunks"]
        .as_array()
        .ok_or_else(|| invalid("深度数据缺少数值分块。"))?;
    if chunks.is_empty() || archive.len() != chunks.len() + 2 {
        return Err(invalid("深度数据分块数量与清单不一致。"));
    }
    let mut expected = HashMap::new();
    let mut next_frame = 0u64;
    for (index, chunk) in chunks.iter().enumerate() {
        let path = format!("chunks/{index:06}.npz");
        let count = integer(chunk, "frameCount")?;
        if chunk["path"] != path
            || integer(chunk, "startFrame")? != next_frame
            || count == 0
            || count > 16
        {
            return Err(invalid("深度数值分块缺帧、重复或顺序无效。"));
        }
        next_frame = next_frame
            .checked_add(count)
            .ok_or_else(|| invalid("深度分块帧数溢出。"))?;
        let bytes = count
            .checked_mul(u64::from(width))
            .and_then(|v| v.checked_mul(u64::from(height)))
            .and_then(|v| v.checked_mul(4))
            .ok_or_else(|| invalid("深度分块大小溢出。"))?;
        expected.insert(path, (bytes, bytes + count * 8 + 65536));
    }
    if next_frame != frame_count {
        return Err(invalid("深度分块帧数与清单不一致。"));
    }
    expected.insert(
        "depth-manifest.json".into(),
        (manifest_bytes.len() as u64, manifest_bytes.len() as u64),
    );
    expected.insert(
        "depth-timestamps.jsonl".into(),
        (frame_count * 16, frame_count.saturating_mul(256)),
    );
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| invalid("深度 ZIP 目录损坏。"))?;
        let name =
            std::str::from_utf8(file.name_raw()).map_err(|_| invalid("深度 ZIP 文件名无效。"))?;
        let Some((minimum, maximum)) = expected.get(name) else {
            return Err(invalid("深度 ZIP 含清单外文件。"));
        };
        if !names.insert(name.to_owned())
            || super::ai_media_runtime::relative(name).is_none()
            || file.is_dir()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || file.size() < *minimum
            || file.size() > *maximum
        {
            return Err(invalid("深度 ZIP 路径、数值文件大小或重复条目无效。"));
        }
    }
    {
        let file = archive
            .by_name("depth-manifest.json")
            .map_err(|_| invalid("深度 ZIP 缺少清单。"))?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(file, 16 * 1024 * 1024 + 1),
            &mut bytes,
        )?;
        if bytes != manifest_bytes {
            return Err(invalid("深度 ZIP 内外清单不一致。"));
        }
    }
    let file = archive
        .by_name("depth-timestamps.jsonl")
        .map_err(|_| invalid("深度 ZIP 缺少逐帧时间戳。"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut frame = 0u64;
    let mut previous = None;
    loop {
        let mut line = Vec::new();
        let mut limited = std::io::Read::take(&mut reader, 4097);
        let count = std::io::BufRead::read_until(&mut limited, b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count > 4096 || !line.ends_with(b"\n") {
            return Err(invalid("深度时间戳条目无效。"));
        }
        let timestamp: Value = serde_json::from_slice(&line)?;
        let pts = number(&timestamp, "sourcePtsSeconds")?;
        if integer(&timestamp, "frame")? != frame
            || pts < first - 1e-7
            || pts >= end
            || previous.is_some_and(|prior| pts <= prior)
            || (number(&timestamp, "outputPtsSeconds")? - (pts - first)).abs() > 1e-7
        {
            return Err(invalid("深度时间戳缺帧、重复或不匹配原片。"));
        }
        if frame == 0 && (pts - first).abs() > 1e-7 {
            return Err(invalid("深度首帧时间戳无效。"));
        }
        previous = Some(pts);
        frame += 1;
        if frame > frame_count {
            return Err(invalid("深度时间戳数量超出清单。"));
        }
    }
    if frame != frame_count
        || previous.is_none_or(|last| (last - first + last_duration - duration).abs() > 1e-6)
    {
        return Err(invalid("深度帧数、最后帧时长与清单不一致。"));
    }
    Ok(())
}

fn safe_name(name: &str) -> String {
    let value: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .take(50)
        .collect();
    let value = value.trim().trim_end_matches(['.', ' ']);
    if value.is_empty() {
        "AI媒体".into()
    } else if validate_name(value).is_ok() {
        value.into()
    } else {
        "AI媒体".into()
    }
}
fn validate_name(name: &str) -> BackendResult<()> {
    let name = name.trim();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']));
    if name.is_empty()
        || name.encode_utf16().count() > 100
        || name.len() > 220
        || name.ends_with('.')
        || reserved
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return Err(invalid("产物名称无效，请使用有效的本地文件名。"));
    }
    Ok(())
}

async fn run_worker(
    python: &Path,
    worker: &Path,
    runtime_root: &Path,
    request: &Path,
    cancel: &Cancellation,
    mut update: impl FnMut(f64, Option<String>) -> BackendResult<()>,
) -> BackendResult<WorkerResult> {
    cancel.check()?;
    let mut command = process_command(python);
    command
        .args(["-I", "-B", "-X", "utf8", "-u"])
        .arg(worker)
        .arg("--request")
        .arg(request)
        .current_dir(runtime_root)
        .env("PYTHONNOUSERSITE", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("OMP_NUM_THREADS", "4")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let tree = ProcessTree::attach(&child)?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| invalid("无法读取 AI 推理进度。"))?,
    );
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| invalid("无法读取 AI 推理日志。"))?;
    let errors = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut output = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(count) = reader.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            if output.len() > 16384 {
                output.drain(..output.len() - 16384);
            }
        }
        output
    });
    let result = async {
        let mut finished = None; let mut last_progress = -1.0; let mut last_update = std::time::Instant::now();
        loop {
            let mut bytes = Vec::new();
            // Capped reads avoid accepting an unbounded model log into application memory.
            let mut limited = (&mut stdout).take(65537);
            let count = tokio::select! { () = cancel.wait() => return Err(invalid("AI 媒体任务已取消。")), count = limited.read_until(b'\n', &mut bytes) => count?, };
            if count == 0 { break; }
            if count > 65536 || !bytes.ends_with(b"\n") { return Err(invalid("AI 推理进度协议超出限制。")); }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid("AI 推理进度协议无效。"))?;
            match value["type"].as_str() {
                Some("progress") => {
                    let progress = value["progress"].as_f64().filter(|value| value.is_finite()).ok_or_else(|| invalid("AI 推理进度无效。"))?.clamp(0.0, 99.0);
                    if progress >= last_progress && (progress - last_progress >= 0.5 || last_update.elapsed() >= Duration::from_secs(1)) { update(progress, value["message"].as_str().map(|m| m.chars().take(500).collect()))?; last_progress = progress; last_update = std::time::Instant::now(); }
                }
                Some("result") if finished.is_none() => { finished = Some(WorkerResult { outputs: serde_json::from_value(value["outputs"].clone())?, actual_device: value["actualDevice"].as_str().or_else(|| value["device"].as_str()).map(str::to_owned) }); }
                Some("error") => return Err(invalid(value["message"].as_str().unwrap_or("AI 推理失败。"))),
                _ => return Err(invalid("AI 推理返回未知或重复终态消息。")),
            }
        }
        let status = tokio::select! { () = cancel.wait() => return Err(invalid("AI 媒体任务已取消。")), status = child.wait() => status?, };
        if !status.success() { let stderr = errors.await.map_err(|error| invalid(&format!("读取 AI 日志失败：{error}")))?; return Err(BackendError::protocol("本地 AI 推理失败。", json!({"detail":String::from_utf8_lossy(&stderr)}))); }
        finished.ok_or_else(|| invalid("AI 推理退出但没有完成产物。"))
    }.await;
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    drop(tree);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> AiMediaJobRecord {
        AiMediaJobRecord {
            job_id: format!("ai-media-{}", Uuid::new_v4()),
            source: MediaReferenceTarget::LocalFile {
                path: "/source.mp4".into(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            source_identity: "sha256".into(),
            name: "第01集".into(),
            operation: AiMediaOperation::AudioSeparation,
            mode: AiMediaMode::Quality,
            start_seconds: 1.0,
            end_seconds: 3.0,
            audio_stream_index: Some(3),
            depth_max_side: 480,
            device: AiMediaDevice::Auto,
            actual_device: None,
            status: AiMediaStatus::Processing,
            progress: Some(30.0),
            message: None,
            outputs: Vec::new(),
            error: None,
            created_at: 1,
            updated_at: 1,
        }
    }
    fn outputs() -> Vec<AiMediaOutput> {
        ["vocals", "accompaniment", "manifest"]
            .iter()
            .enumerate()
            .map(|(index, role)| AiMediaOutput {
                result_index: index as u32,
                role: (*role).into(),
                kind: if *role == "manifest" { "data" } else { "audio" }.into(),
                path: format!(
                    "{role}.{}",
                    if *role == "manifest" { "json" } else { "wav" }
                ),
                name: format!(
                    "{role}.{}",
                    if *role == "manifest" { "json" } else { "wav" }
                ),
                mime_type: if *role == "manifest" {
                    "application/json"
                } else {
                    "audio/wav"
                }
                .into(),
                duration_seconds: 2.0,
                width: None,
                height: None,
            })
            .collect()
    }
    #[test]
    fn source_window_audio_and_resolution_are_checked() {
        for (start, end, duration, size) in [
            (f64::NAN, 2.0, 3.0, 480),
            (0.0, 0.0, 3.0, 480),
            (-1.0, 2.0, 3.0, 480),
            (0.0, 4.0, 3.0, 480),
            (0.0, 2.0, 3.0, 1080),
        ] {
            assert!(validate_window(start, end, duration, size).is_err());
        }
        assert!(validate_window(0.0, 2.0, 3.0, 720).is_ok());
        let probe = MediaProbe {
            duration: 3.0,
            width: 1920,
            height: 1080,
            audio: vec![3, 5],
            frames: None,
            audio_samples: None,
            sample_rate: None,
            audio_channels: None,
            audio_codec: None,
        };
        assert!(validate_source(AiMediaOperation::AudioSeparation, &probe, Some(4)).is_err());
        assert!(validate_source(AiMediaOperation::AudioSeparation, &probe, Some(5)).is_ok());
    }
    #[test]
    fn outputs_require_both_roles_and_cannot_escape_attempt_directory() {
        let temp = tempfile::tempdir().unwrap();
        for role in ["vocals", "accompaniment"] {
            std::fs::write(temp.path().join(format!("{role}.wav")), b"wave").unwrap();
        }
        std::fs::write(temp.path().join("manifest.json"), b"{}").unwrap();
        assert!(validate_worker_outputs(&record(), temp.path(), outputs()).is_ok());
        let mut invalid = outputs();
        invalid[1].path = "../accompaniment.wav".into();
        assert!(validate_worker_outputs(&record(), temp.path(), invalid).is_err());
        let mut invalid = outputs();
        invalid[1].result_index = 0;
        assert!(validate_worker_outputs(&record(), temp.path(), invalid).is_err());
        let mut invalid = outputs();
        invalid[1].role = "vocals".into();
        assert!(validate_worker_outputs(&record(), temp.path(), invalid).is_err());
    }
    #[test]
    fn persisted_cancel_cannot_be_overwritten_and_restart_pauses_jobs() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp.path().join("jobs.sqlite")).unwrap();
        storage.initialize_ai_media().unwrap();
        let mut job = record();
        storage.save_ai_media(&job).unwrap();
        storage.initialize_ai_media().unwrap();
        let paused = storage.ai_media_job(&job.job_id).unwrap().unwrap();
        assert_eq!(paused.status, AiMediaStatus::Paused);
        assert_eq!(paused.source_identity, job.source_identity);
        assert_eq!(paused.audio_stream_index, Some(3));
        assert!(!storage.save_active_ai_media(&job).unwrap());
        job.status = AiMediaStatus::Preparing;
        storage.save_ai_media(&job).unwrap();
        let mut cancelled = job.clone();
        cancelled.status = AiMediaStatus::Cancelled;
        storage.save_ai_media(&cancelled).unwrap();
        job.status = AiMediaStatus::Completed;
        assert!(!storage.save_active_ai_media(&job).unwrap());
        assert_eq!(
            storage.ai_media_job(&job.job_id).unwrap().unwrap().status,
            AiMediaStatus::Cancelled
        );
    }
    #[test]
    fn unicode_labels_do_not_change_identity_and_reserved_paths_are_rejected() {
        assert_eq!(safe_name("第01集/镜头\nA"), "第01集_镜头_A");
        for name in ["CON.wav", "../outside", "", "A.", "COM1"] {
            assert!(validate_name(name).is_err());
        }
        assert!(validate_name("第01集_人声.wav").is_ok());
        assert!(job_directory(Path::new("/jobs"), "../../escape").is_err());
    }

    #[test]
    fn mode_defaults_preserve_existing_jobs_and_reject_unsupported_devices() {
        let mut value = serde_json::to_value(record()).unwrap();
        value.as_object_mut().unwrap().remove("mode");
        assert_eq!(
            serde_json::from_value::<AiMediaJobRecord>(value.clone())
                .unwrap()
                .mode,
            AiMediaMode::Quality
        );
        assert_eq!(
            serde_json::from_value::<StartAiMediaCommand>(value)
                .unwrap()
                .mode,
            AiMediaMode::Lite
        );
        assert!(validate_device(AiMediaMode::Lite, AiMediaDevice::Cuda).is_err());
        assert!(validate_device(AiMediaMode::Lite, AiMediaDevice::Mps).is_err());
        assert!(validate_device(AiMediaMode::Quality, AiMediaDevice::Directml).is_err());
        assert!(validate_device(AiMediaMode::Lite, AiMediaDevice::Directml).is_ok());
    }

    #[test]
    fn audio_manifest_checks_selected_stream_and_exact_sample_count() {
        let temp = tempfile::tempdir().unwrap();
        let mut output = outputs();
        for item in &mut output {
            item.path = temp.path().join(&item.path).to_string_lossy().into_owned();
        }
        let manifest = json!({"schemaVersion":1,"operation":"audio_separation","runtimeProfile":"quality","model":"Demucs htdemucs","modelLicense":"MIT","device":"cpu","startSeconds":1.0,"endSeconds":3.0,"durationSeconds":2.0,"audioStreamIndex":3,"channels":2,"format":"float32_wav","sampleRate":44100,"sampleCount":88200,"peakAmplitude":0.5,"reconstructionRmse":0.0000001,"outputs":{"vocals":"vocals.wav","accompaniment":"accompaniment.wav"}});
        let path = &output[2].path;
        std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            validate_manifest(&record(), &output, Some("cpu"))
                .unwrap()
                .samples,
            Some(88200)
        );
        for (key, value) in [
            ("sampleCount", json!(88201)),
            ("audioStreamIndex", json!(5)),
            ("runtimeProfile", json!("lite")),
            ("reconstructionRmse", json!(0.1)),
        ] {
            let mut mismatch = manifest.clone();
            mismatch[key] = value;
            std::fs::write(path, serde_json::to_vec(&mismatch).unwrap()).unwrap();
            assert!(
                validate_manifest(&record(), &output, Some("cpu")).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn depth_zip_requires_complete_chunks_and_matching_monotonic_source_pts() {
        fn write_zip(path: &Path, manifest: &[u8], pts: &str, chunk_path: &str) {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, bytes) in [
                ("depth-manifest.json", manifest),
                ("depth-timestamps.jsonl", pts.as_bytes()),
                (chunk_path, &[0u8; 512]),
            ] {
                zip.start_file(name, options).unwrap();
                std::io::Write::write_all(&mut zip, bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("depth-data.zip");
        let manifest =
            json!({"chunks":[{"path":"chunks/000000.npz","startFrame":0,"frameCount":2}]});
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let output = AiMediaOutput {
            result_index: 1,
            role: "depth_data".into(),
            kind: "data".into(),
            path: path.to_string_lossy().into_owned(),
            name: "depth.zip".into(),
            mime_type: "application/zip".into(),
            duration_seconds: 1.75,
            width: None,
            height: None,
        };
        let good = "{\"frame\":0,\"sourcePtsSeconds\":1.25,\"outputPtsSeconds\":0.0}\n{\"frame\":1,\"sourcePtsSeconds\":2.25,\"outputPtsSeconds\":1.0}\n";
        write_zip(&path, &bytes, good, "chunks/000000.npz");
        assert!(
            validate_depth_archive(&output, &bytes, &manifest, 2, 2, 2, 1.25, 3.0, 1.75, 0.75)
                .is_ok()
        );
        let duplicate = good.replace("2.25", "1.25");
        write_zip(&path, &bytes, &duplicate, "chunks/000000.npz");
        assert!(
            validate_depth_archive(&output, &bytes, &manifest, 2, 2, 2, 1.25, 3.0, 1.75, 0.75)
                .is_err()
        );
        write_zip(&path, &bytes, good, "../chunks/000000.npz");
        assert!(
            validate_depth_archive(&output, &bytes, &manifest, 2, 2, 2, 1.25, 3.0, 1.75, 0.75)
                .is_err()
        );
        write_zip(&path, &bytes, good, "chunks/000000.npz");
        assert!(
            validate_depth_archive(&output, &bytes, &manifest, 2, 2, 2, 1.25, 3.0, 1.75, 0.7)
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "requires explicit runtime/source/FFmpeg env paths and executes two real local models"]
    async fn real_prepared_worker_outputs_pass_native_delivery_validation() {
        fn env_path(name: &str) -> PathBuf {
            let path = PathBuf::from(
                std::env::var(name).unwrap_or_else(|_| panic!("Set {name} explicitly.")),
            );
            assert!(path.is_absolute());
            path
        }
        let root = env_path("IC_AI_MEDIA_TEST_RUNTIME");
        let source = env_path("IC_AI_MEDIA_TEST_SOURCE");
        let ffmpeg = env_path("IC_AI_MEDIA_TEST_FFMPEG");
        let mode = match std::env::var("IC_AI_MEDIA_TEST_MODE")
            .unwrap_or_else(|_| "lite".into())
            .as_str()
        {
            "lite" => AiMediaMode::Lite,
            "quality" => AiMediaMode::Quality,
            value => panic!("Unsupported IC_AI_MEDIA_TEST_MODE: {value}. Use lite or quality."),
        };
        let ready: fn(&Path) -> bool = if mode == AiMediaMode::Lite {
            super::super::ai_media_runtime::runtime_ready
        } else {
            super::super::ai_media_runtime::quality_runtime_ready
        };
        assert!(
            ready(&root),
            "prepared {mode:?} runtime failed pinned manifest or complete membership validation"
        );
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("runtime-manifest.json")).unwrap())
                .unwrap();
        let python = root.join(manifest["pythonPath"].as_str().unwrap());
        let worker = root.join("worker/worker.py");
        let temp = tempfile::tempdir().unwrap();
        let cancel = Cancellation::default();
        for operation in [
            AiMediaOperation::AudioSeparation,
            AiMediaOperation::VideoDepth,
        ] {
            let directory = temp
                .path()
                .join(if operation == AiMediaOperation::VideoDepth {
                    "depth"
                } else {
                    "audio"
                });
            std::fs::create_dir(&directory).unwrap();
            let request = json!({"schemaVersion":1,"operation":operation,"mode":mode,"sourcePath":source,"outputDir":directory,"ffmpegPath":ffmpeg,"ffprobePath":ffprobe_path(&ffmpeg).unwrap(),"name":"第01集_本地实测","startSeconds":0.2,"endSeconds":1.9,"audioStreamIndex":1,"depthMaxSide":480,"device":"cpu"});
            let request_path = directory.join("request.json");
            std::fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
            let response = run_worker(
                &python,
                &worker,
                &root,
                &request_path,
                &cancel,
                |progress, message| {
                    eprintln!("{operation:?}: {progress} {}", message.unwrap_or_default());
                    Ok(())
                },
            )
            .await
            .unwrap();
            let mut job = record();
            job.operation = operation;
            job.mode = mode;
            job.audio_stream_index = Some(1);
            job.start_seconds = 0.2;
            job.end_seconds = 1.9;
            let outputs = validate_worker_outputs(&job, &directory, response.outputs).unwrap();
            let metrics =
                validate_manifest(&job, &outputs, response.actual_device.as_deref()).unwrap();
            validate_media_files(&ffmpeg, &outputs, &metrics)
                .await
                .unwrap();
            if operation == AiMediaOperation::VideoDepth {
                assert_eq!(metrics.frames, Some(51));
            } else {
                assert_eq!(metrics.samples, Some(74970));
            }
        }
    }

    fn test_python() -> PathBuf {
        let path =
            PathBuf::from(std::env::var("IC_AI_MEDIA_TEST_PYTHON").expect(
                "Set IC_AI_MEDIA_TEST_PYTHON to the explicit development Python executable.",
            ));
        assert!(path.is_absolute() && path.is_file());
        path
    }

    #[tokio::test]
    #[ignore = "requires IC_AI_MEDIA_TEST_PYTHON; does not execute inference models"]
    async fn python_worker_progress_and_terminal_result_are_received() {
        let temp = tempfile::tempdir().unwrap();
        let worker = temp.path().join("worker.py");
        std::fs::write(&worker, "import json,sys\nassert sys.flags.utf8_mode == 1\nprint(json.dumps({'type':'progress','progress':5,'message':'正在加载第01集'},ensure_ascii=False),flush=True)\nprint(json.dumps({'type':'progress','progress':95,'message':'正在保存人声与伴奏'},ensure_ascii=False),flush=True)\nprint(json.dumps({'type':'result','device':'cpu','outputs':[{'resultIndex':0,'role':'vocals','kind':'audio','path':'人声.wav','name':'第01集 · 人声.wav','mimeType':'audio/wav','durationSeconds':1.0}]},ensure_ascii=False),flush=True)\n").unwrap();
        let cancel = Cancellation::default();
        let mut received = Vec::new();
        let result = run_worker(
            &test_python(),
            &worker,
            temp.path(),
            &temp.path().join("request.json"),
            &cancel,
            |progress, message| {
                received.push((progress, message));
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            received.iter().map(|value| value.0).collect::<Vec<_>>(),
            vec![5.0, 95.0]
        );
        assert_eq!(result.actual_device.as_deref(), Some("cpu"));
        assert_eq!(received[0].1.as_deref(), Some("正在加载第01集"));
        assert_eq!(received[1].1.as_deref(), Some("正在保存人声与伴奏"));
        assert_eq!(result.outputs[0].name, "第01集 · 人声.wav");
    }

    #[tokio::test]
    #[ignore = "requires IC_AI_MEDIA_TEST_PYTHON; does not execute inference models"]
    async fn python_worker_failure_and_bounded_protocol_are_errors() {
        let temp = tempfile::tempdir().unwrap();
        let worker = temp.path().join("worker.py");
        let cancel = Cancellation::default();
        std::fs::write(
            &worker,
            "import sys\nsys.stderr.write('GPU out of memory')\nsys.exit(2)\n",
        )
        .unwrap();
        let error = run_worker(
            &test_python(),
            &worker,
            temp.path(),
            &temp.path().join("request.json"),
            &cancel,
            |_, _| Ok(()),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(error, BackendError::Protocol { .. }));
        assert!(
            error
                .payload()
                .details
                .to_string()
                .contains("GPU out of memory")
        );
        std::fs::write(&worker,"import json\nprint(json.dumps({'type':'error','message':'Model checksum mismatch'}),flush=True)\n").unwrap();
        let error = run_worker(
            &test_python(),
            &worker,
            temp.path(),
            &temp.path().join("request.json"),
            &cancel,
            |_, _| Ok(()),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("Model checksum mismatch"));
        std::fs::write(&worker, "print('x'*70000,flush=True)\n").unwrap();
        let error = run_worker(
            &test_python(),
            &worker,
            temp.path(),
            &temp.path().join("request.json"),
            &cancel,
            |_, _| Ok(()),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("协议超出限制"));
    }

    #[tokio::test]
    #[ignore = "requires IC_AI_MEDIA_TEST_PYTHON; exercises actual process-tree cancellation"]
    async fn python_worker_cancellation_stops_descendant_processes() {
        let temp = tempfile::tempdir().unwrap();
        let worker = temp.path().join("worker.py");
        let pulse = temp.path().join("pulse.bin");
        let pulse_python = serde_json::to_string(&pulse.to_string_lossy()).unwrap();
        let child = format!(
            "import time\nf=open({pulse_python},'ab',buffering=0)\nwhile True:\n f.write(b'x')\n time.sleep(0.025)\n"
        );
        let script = format!(
            "import subprocess,sys,time,json\nsubprocess.Popen([sys.executable,'-I','-c',{}])\ntime.sleep(0.2)\nprint(json.dumps({{'type':'progress','progress':10,'message':'running'}}),flush=True)\ntime.sleep(60)\n",
            serde_json::to_string(&child).unwrap()
        );
        std::fs::write(&worker, script).unwrap();
        let cancel = Arc::new(Cancellation::default());
        let worker_cancel = Arc::clone(&cancel);
        let python = test_python();
        let directory = temp.path().to_path_buf();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut sender = Some(ready_tx);
        let handle = tokio::spawn(async move {
            run_worker(
                &python,
                &worker,
                &directory,
                &directory.join("request.json"),
                &worker_cancel,
                |_, _| {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(());
                    }
                    Ok(())
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(10), ready_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(pulse.is_file());
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        tokio::time::sleep(Duration::from_millis(100)).await;
        let before = pulse.metadata().unwrap().len();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            pulse.metadata().unwrap().len(),
            before,
            "child continues running after cancellation"
        );
    }
}
