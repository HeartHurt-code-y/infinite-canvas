//! Video preparation with stable source identities, durable jobs and isolated deliveries.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::{Notify, Semaphore},
};
use uuid::Uuid;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    mv_media::source_signature,
    process_tree::ProcessTree,
    storage::Storage,
    types::MediaReferenceTarget,
    video_edit_source::VideoEditSourceService,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoPreparationOperation {
    ExtractAudio,
    SilentVideo,
    ClipVideo,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoPreparationAudioFormat {
    #[default]
    Wav,
    Original,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoPreparationStatus {
    Preparing,
    Processing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl VideoPreparationStatus {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoPreparationCommand {
    pub source: MediaReferenceTarget,
    pub name: String,
    pub operation: VideoPreparationOperation,
    #[serde(default)]
    pub start_seconds: f64,
    pub end_seconds: Option<f64>,
    pub audio_stream_index: Option<u32>,
    #[serde(default)]
    pub format: VideoPreparationAudioFormat,
    pub source_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreparationAudioStream {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
    pub channels: u32,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreparationProbe {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub audio_streams: Vec<VideoPreparationAudioStream>,
    pub source_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreparationOutput {
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
pub struct VideoPreparationJobRecord {
    pub job_id: String,
    pub source: MediaReferenceTarget,
    pub source_identity: String,
    pub name: String,
    pub operation: VideoPreparationOperation,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub audio_stream_index: Option<u32>,
    pub format: VideoPreparationAudioFormat,
    pub status: VideoPreparationStatus,
    pub progress: Option<f64>,
    pub output: Option<VideoPreparationOutput>,
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
            Err(invalid("视频准备任务已取消。"))
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
    active: Mutex<HashMap<String, Arc<Cancellation>>>,
    workers: Semaphore,
}

#[derive(Clone)]
pub struct VideoPreparationService {
    inner: Arc<Inner>,
}

impl VideoPreparationService {
    pub fn new(
        downloads_dir: PathBuf,
        composer: VideoCompositionService,
        sources: VideoEditSourceService,
        storage: Arc<Storage>,
    ) -> BackendResult<Self> {
        storage.initialize_video_preparation()?;
        Ok(Self {
            inner: Arc::new(Inner {
                directory: downloads_dir.join("无限画布").join("视频准备"),
                composer,
                sources,
                storage,
                active: Mutex::new(HashMap::new()),
                workers: Semaphore::new(2),
            }),
        })
    }

    pub async fn probe(
        &self,
        source: MediaReferenceTarget,
    ) -> BackendResult<VideoPreparationProbe> {
        let preview = self.inner.sources.prepare(&source).await?;
        let result = async {
            let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
            let before = source_signature(&preview.path).await?;
            let mut probe = probe_path(&ffmpeg, &preview.path).await?;
            require_video(&probe)?;
            if before != source_signature(&preview.path).await? {
                return Err(changed_source());
            }
            probe.source_identity = before;
            Ok(probe)
        }
        .await;
        let released = self.inner.sources.release(&preview.preview_id).await;
        match result {
            Err(error) => Err(error),
            Ok(probe) => {
                released?;
                Ok(probe)
            }
        }
    }

    pub async fn start(
        &self,
        command: StartVideoPreparationCommand,
    ) -> BackendResult<VideoPreparationJobRecord> {
        let probe = self.probe(command.source.clone()).await?;
        if command
            .source_identity
            .as_ref()
            .is_some_and(|identity| identity != &probe.source_identity)
        {
            return Err(changed_source());
        }
        let end = command.end_seconds.unwrap_or(probe.duration_seconds);
        validate_window(command.start_seconds, end, probe.duration_seconds)?;
        let audio = selected_audio(&probe, command.operation, command.audio_stream_index)?;
        if command.operation == VideoPreparationOperation::ExtractAudio
            && command.format == VideoPreparationAudioFormat::Original
        {
            original_audio_format(audio.as_ref().expect("validated audio"))?;
        }
        let now = now_ms();
        let record = VideoPreparationJobRecord {
            job_id: format!("video-preparation-{}", Uuid::new_v4()),
            source: command.source,
            source_identity: probe.source_identity,
            name: safe_name(&command.name),
            operation: command.operation,
            start_seconds: command.start_seconds,
            end_seconds: end,
            audio_stream_index: audio.as_ref().map(|stream| stream.index),
            format: command.format,
            status: VideoPreparationStatus::Preparing,
            progress: Some(0.0),
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        self.launch(record.clone())?;
        Ok(record)
    }

    pub fn get(&self, job_id: &str) -> BackendResult<Option<VideoPreparationJobRecord>> {
        self.inner.storage.video_preparation_job(job_id)
    }
    pub fn list(&self) -> BackendResult<Vec<VideoPreparationJobRecord>> {
        self.inner.storage.video_preparation_jobs()
    }

    pub fn retry(&self, job_id: &str) -> BackendResult<VideoPreparationJobRecord> {
        let mut record = self.require_job(job_id)?;
        if record.status == VideoPreparationStatus::Completed {
            return Ok(record);
        }
        if matches!(
            record.status,
            VideoPreparationStatus::Preparing | VideoPreparationStatus::Processing
        ) {
            return Err(BackendError::Conflict(
                "任务仍在处理，请先取消或等待完成。".into(),
            ));
        }
        record.status = VideoPreparationStatus::Preparing;
        record.updated_at = now_ms();
        record.progress = Some(0.0);
        record.error = None;
        record.output = None;
        self.launch(record.clone())?;
        Ok(record)
    }

    pub fn cancel(&self, job_id: &str) -> BackendResult<VideoPreparationJobRecord> {
        let active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("视频任务状态锁不可用。"))?;
        let mut record = self.require_job(job_id)?;
        if record.status == VideoPreparationStatus::Completed {
            return Ok(record);
        }
        if let Some(cancel) = active.get(job_id) {
            cancel.cancel();
        }
        record.status = VideoPreparationStatus::Cancelled;
        record.updated_at = now_ms();
        record.error = None;
        self.inner.storage.save_video_preparation(&record)?;
        Ok(record)
    }

    /// Change the delivery label after completion without moving its media or source.
    pub fn rename_output(
        &self,
        job_id: &str,
        name: &str,
    ) -> BackendResult<VideoPreparationJobRecord> {
        // Completion, cancellation and renaming share this lock. A completed worker
        // cannot write its pre-rename snapshot after the new label has been committed.
        let _active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("视频任务状态锁不可用。"))?;
        rename_saved_output(&self.inner.storage, job_id, name)
    }

    fn require_job(&self, job_id: &str) -> BackendResult<VideoPreparationJobRecord> {
        self.get(job_id)?
            .ok_or_else(|| BackendError::NotFound("视频准备任务不存在。".into()))
    }

    fn launch(&self, record: VideoPreparationJobRecord) -> BackendResult<()> {
        let mut active = self
            .inner
            .active
            .lock()
            .map_err(|_| invalid("视频任务状态锁不可用。"))?;
        if active.contains_key(&record.job_id) {
            return Err(BackendError::Conflict("任务正在退出，请稍后继续。".into()));
        }
        if self.get(&record.job_id)?.is_some_and(|existing| {
            matches!(
                existing.status,
                VideoPreparationStatus::Preparing
                    | VideoPreparationStatus::Processing
                    | VideoPreparationStatus::Completed
            )
        }) {
            return Err(BackendError::Conflict(
                "任务状态已改变，请刷新后继续。".into(),
            ));
        }
        self.inner.storage.save_video_preparation(&record)?;
        let cancel = Arc::new(Cancellation::default());
        active.insert(record.job_id.clone(), cancel.clone());
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.run(record, cancel).await;
        });
        Ok(())
    }

    async fn run(&self, mut record: VideoPreparationJobRecord, cancel: Arc<Cancellation>) {
        let result = async {
            let _permit = tokio::select! {
                result = self.inner.workers.acquire() => result.map_err(|_| invalid("媒体任务队列已关闭。"))?,
                () = cancel.wait() => return Err(invalid("视频准备任务已取消。")),
            };
            cancel.check()?;
            // Always resolve the persisted target again; preview paths are only temporary leases.
            let preview = self.inner.sources.prepare(&record.source).await?;
            let processed = self.process(&mut record, &preview.path, &cancel).await;
            let released = self.inner.sources.release(&preview.preview_id).await;
            match processed {
                Err(error) => Err(error),
                Ok(output) => match released {
                    Ok(()) => Ok(output),
                    Err(error) => {
                        let _ = tokio::fs::remove_file(&output.path).await;
                        Err(error)
                    }
                },
            }
        }.await;
        let mut unregistered = None;
        // Serialize the terminal commit with cancel/retry. If completion wins, cancel sees
        // the completed record; if cancel wins, this output is removed before registration.
        {
            let active = self.inner.active.lock();
            if active.is_ok() && !cancel.cancelled.load(Ordering::SeqCst) {
                match result {
                    Ok(output) => {
                        unregistered = Some(output.path.clone());
                        record.output = Some(output);
                        record.status = VideoPreparationStatus::Completed;
                        record.progress = Some(100.0);
                        record.error = None;
                    }
                    Err(error) => {
                        record.status = VideoPreparationStatus::Failed;
                        record.error = Some(error.to_string());
                    }
                }
                record.updated_at = now_ms();
                match self.inner.storage.save_active_video_preparation(&record) {
                    Ok(true) => unregistered = None,
                    Ok(false) => (),
                    Err(error) => eprintln!(
                        "[video-preparation] 无法保存任务 {}: {error}",
                        record.job_id
                    ),
                }
            } else if let Ok(output) = result {
                unregistered = Some(output.path);
            }
        }
        if let Some(path) = unregistered {
            let _ = tokio::fs::remove_file(path).await;
        }
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(&record.job_id);
        }
    }

    async fn process(
        &self,
        record: &mut VideoPreparationJobRecord,
        source_path: &str,
        cancel: &Cancellation,
    ) -> BackendResult<VideoPreparationOutput> {
        cancel.check()?;
        let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
        cancel.check()?;
        if source_signature(source_path).await? != record.source_identity {
            return Err(changed_source());
        }
        let probe = probe_path(&ffmpeg, source_path).await?;
        require_video(&probe)?;
        validate_window(
            record.start_seconds,
            record.end_seconds,
            probe.duration_seconds,
        )?;
        let audio = selected_audio(&probe, record.operation, record.audio_stream_index)?;
        let (extension, mime) = output_format(record, audio.as_ref())?;
        let directory = job_directory(&self.inner.directory, &record.job_id)?;
        tokio::fs::create_dir_all(&directory).await?;
        let attempt = Uuid::new_v4();
        let temp = directory.join(format!(".{attempt}.partial.{extension}"));
        let final_path = directory.join(format!("{}-{attempt}.{extension}", record.name));
        record.status = VideoPreparationStatus::Processing;
        record.updated_at = now_ms();
        if !self.inner.storage.save_active_video_preparation(record)? {
            return Err(invalid("任务已取消。"));
        }
        let result = async {
            let args = processing_arguments(record, source_path, &temp);
            let duration = record.end_seconds - record.start_seconds;
            run_ffmpeg(
                &ffmpeg,
                &args,
                cancel,
                |progress| {
                    record.progress = Some(progress);
                    record.updated_at = now_ms();
                    self.inner
                        .storage
                        .save_active_video_preparation(record)
                        .map(|_| ())
                },
                duration,
            )
            .await?;
            cancel.check()?;
            if source_signature(source_path).await? != record.source_identity {
                return Err(changed_source());
            }
            let measured = probe_path(&ffmpeg, &temp.to_string_lossy()).await?;
            validate_output(record, &measured)?;
            if tokio::fs::metadata(&temp).await?.len() == 0 {
                return Err(invalid("媒体处理输出为空。"));
            }
            cancel.check()?;
            tokio::fs::rename(&temp, &final_path).await?;
            Ok(VideoPreparationOutput {
                kind: if record.operation == VideoPreparationOperation::ExtractAudio {
                    "audio"
                } else {
                    "video"
                }
                .into(),
                path: final_path.to_string_lossy().into_owned(),
                name: format!("{}.{extension}", record.name),
                mime_type: mime.into(),
                duration_seconds: measured.duration_seconds,
                width: (measured.width > 0).then_some(measured.width),
                height: (measured.height > 0).then_some(measured.height),
            })
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        result
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}
fn changed_source() -> BackendError {
    invalid("原视频内容已改变，请重新读取视频信息并确认处理区间。")
}

fn rename_saved_output(
    storage: &Storage,
    job_id: &str,
    name: &str,
) -> BackendResult<VideoPreparationJobRecord> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > 80 || name.len() > 180 {
        return Err(invalid("请输入名称，最多 80 个字符（中文最多 60 个）。"));
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
        || name.ends_with('.')
    {
        return Err(invalid(
            "名称不能包含路径或系统保留字符，也不能以句点结尾。",
        ));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
    {
        return Err(invalid("这个名称被系统保留，请换一个名称。"));
    }
    let mut record = storage
        .video_preparation_job(job_id)?
        .ok_or_else(|| BackendError::NotFound("视频准备任务不存在。".into()))?;
    if record.status != VideoPreparationStatus::Completed {
        return Err(BackendError::Conflict(
            "请等待视频准备任务成功完成后再命名。".into(),
        ));
    }
    let output = record
        .output
        .as_mut()
        .ok_or_else(|| invalid("任务没有已完成的产物。"))?;
    let path = Path::new(&output.path);
    if !path.is_absolute() || !path.is_file() || path.metadata()?.len() == 0 {
        return Err(invalid("产物文件不存在或不可读取，请检查本地文件。"));
    }
    std::fs::File::open(path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("产物缺少实际文件扩展名。"))?;
    let suffix = format!(".{extension}");
    let base = if name
        .to_ascii_lowercase()
        .ends_with(&suffix.to_ascii_lowercase())
    {
        &name[..name.len() - suffix.len()]
    } else {
        name
    };
    if base.trim().is_empty() {
        return Err(invalid("请输入产物名称。"));
    }
    record.name = base.to_string();
    output.name = format!("{base}{suffix}");
    record.updated_at = now_ms();
    storage.save_video_preparation(&record)?;
    Ok(record)
}

fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .take(96)
        .collect();
    let mut name = name.trim().trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        name = "视频准备".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    {
        name.insert(0, '_');
    }
    name
}

fn job_directory(root: &Path, job_id: &str) -> BackendResult<PathBuf> {
    let uuid = job_id
        .strip_prefix("video-preparation-")
        .ok_or_else(|| invalid("视频准备任务身份无效。"))?;
    Uuid::parse_str(uuid).map_err(|_| invalid("视频准备任务身份无效。"))?;
    Ok(root.join(job_id))
}

fn require_video(probe: &VideoPreparationProbe) -> BackendResult<()> {
    if probe.width == 0 || probe.height == 0 {
        Err(invalid("文件没有可读取的视频画面。"))
    } else {
        Ok(())
    }
}

fn validate_window(start: f64, end: f64, duration: f64) -> BackendResult<()> {
    if !start.is_finite()
        || !end.is_finite()
        || start < 0.0
        || end <= start
        || end > duration + 0.001
    {
        return Err(invalid(
            "处理区间必须在原片时长内，结束时间必须大于开始时间。",
        ));
    }
    Ok(())
}

fn selected_audio(
    probe: &VideoPreparationProbe,
    operation: VideoPreparationOperation,
    index: Option<u32>,
) -> BackendResult<Option<VideoPreparationAudioStream>> {
    if operation == VideoPreparationOperation::SilentVideo {
        return Ok(None);
    }
    let audio = if let Some(index) = index {
        Some(
            probe
                .audio_streams
                .iter()
                .find(|stream| stream.index == index)
                .ok_or_else(|| invalid("选中的音轨已不存在，请重新读取视频信息。"))?
                .clone(),
        )
    } else {
        probe.audio_streams.first().cloned()
    };
    if operation == VideoPreparationOperation::ExtractAudio && audio.is_none() {
        return Err(invalid("该视频没有音轨，无法提取音频。"));
    }
    Ok(audio)
}

fn original_audio_format(
    audio: &VideoPreparationAudioStream,
) -> BackendResult<(&'static str, &'static str)> {
    match audio.codec.as_str() {
        "aac" | "alac" => Ok(("m4a", "audio/mp4")),
        "mp3" => Ok(("mp3", "audio/mpeg")),
        "opus" => Ok(("opus", "audio/ogg")),
        "vorbis" => Ok(("ogg", "audio/ogg")),
        "flac" => Ok(("flac", "audio/flac")),
        codec if codec.starts_with("pcm_") => Ok(("wav", "audio/wav")),
        _ => Err(invalid("该音轨编码暂不支持无损提取容器，请选择 WAV。")),
    }
}

fn output_format(
    record: &VideoPreparationJobRecord,
    audio: Option<&VideoPreparationAudioStream>,
) -> BackendResult<(&'static str, &'static str)> {
    if record.operation != VideoPreparationOperation::ExtractAudio {
        return Ok(("mp4", "video/mp4"));
    }
    if record.format == VideoPreparationAudioFormat::Wav {
        Ok(("wav", "audio/wav"))
    } else {
        original_audio_format(audio.ok_or_else(|| invalid("视频没有音轨。"))?)
    }
}

fn processing_arguments(
    record: &VideoPreparationJobRecord,
    source: &str,
    temp: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-v", "error", "-n", "-ss"]
        .into_iter()
        .map(String::from)
        .collect();
    args.extend([
        format!("{:.9}", record.start_seconds),
        "-i".into(),
        source.into(),
        "-t".into(),
        format!("{:.9}", record.end_seconds - record.start_seconds),
    ]);
    match record.operation {
        VideoPreparationOperation::ExtractAudio => {
            args.extend([
                "-map".into(),
                format!("0:{}", record.audio_stream_index.expect("validated audio")),
                "-vn".into(),
                "-c:a".into(),
                if record.format == VideoPreparationAudioFormat::Wav {
                    "pcm_s16le"
                } else {
                    "copy"
                }
                .into(),
            ]);
            if record.format == VideoPreparationAudioFormat::Wav {
                // Preserve a delayed audio stream on the source timeline. Resetting each
                // stream's first PTS independently would remove intentional A/V offsets.
                args.extend(["-af".into(), "aresample=async=1:first_pts=0,apad".into()]);
            }
        }
        VideoPreparationOperation::SilentVideo | VideoPreparationOperation::ClipVideo => {
            args.extend([
                "-map".into(),
                "0:V:0".into(),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "fast".into(),
                "-crf".into(),
                "18".into(),
                "-vf".into(),
                "pad=ceil(iw/2)*2:ceil(ih/2)*2".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if record.operation == VideoPreparationOperation::SilentVideo
                || record.audio_stream_index.is_none()
            {
                args.push("-an".into());
            } else {
                args.extend([
                    "-map".into(),
                    format!("0:{}", record.audio_stream_index.unwrap()),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "192k".into(),
                ]);
            }
            args.extend(["-movflags".into(), "+faststart".into()]);
        }
    }
    args.extend([
        "-map_metadata".into(),
        "-1".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        temp.to_string_lossy().into_owned(),
    ]);
    args
}

fn validate_output(
    record: &VideoPreparationJobRecord,
    probe: &VideoPreparationProbe,
) -> BackendResult<()> {
    if record.operation == VideoPreparationOperation::ExtractAudio {
        if probe.audio_streams.is_empty() || probe.width > 0 {
            return Err(invalid("输出音轨校验失败。"));
        }
    } else {
        require_video(probe)?;
        if record.operation == VideoPreparationOperation::SilentVideo
            && !probe.audio_streams.is_empty()
        {
            return Err(invalid("无声视频仍包含音轨，输出校验失败。"));
        }
        if record.operation == VideoPreparationOperation::ClipVideo
            && record.audio_stream_index.is_some()
            && probe.audio_streams.is_empty()
        {
            return Err(invalid("裁切输出丢失选中的音轨。"));
        }
    }
    let expected = record.end_seconds - record.start_seconds;
    let tolerance = if record.format == VideoPreparationAudioFormat::Original
        && record.operation == VideoPreparationOperation::ExtractAudio
    {
        0.25
    } else {
        0.15_f64.max(if probe.fps > 0.0 {
            2.0 / probe.fps
        } else {
            0.15
        })
    };
    if (probe.duration_seconds - expected).abs() > tolerance {
        return Err(BackendError::protocol(
            "输出时长与所选区间不一致。",
            json!({"expected": expected, "actual": probe.duration_seconds, "tolerance": tolerance}),
        ));
    }
    Ok(())
}

fn command(binary: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    ProcessTree::configure(&mut command);
    command
}

async fn run_ffmpeg(
    binary: &Path,
    args: &[String],
    cancel: &Cancellation,
    mut update: impl FnMut(f64) -> BackendResult<()>,
    duration: f64,
) -> BackendResult<()> {
    cancel.check()?;
    let mut command = command(binary);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let tree = ProcessTree::attach(&child)?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| invalid("无法读取媒体处理进度。"))?,
    )
    .lines();
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| invalid("无法读取媒体处理日志。"))?;
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
    let mut last_progress = -1.0;
    let result = async {
        loop {
            let line = tokio::select! {
                () = cancel.wait() => return Err(invalid("视频准备任务已取消。")),
                line = lines.next_line() => line?,
            };
            let Some(line) = line else { break; };
            if let Some(micros) = line.strip_prefix("out_time_us=").and_then(|value| value.parse::<f64>().ok()) {
                let progress = (micros / 1_000_000.0 / duration * 100.0).clamp(0.0, 99.0);
                if progress - last_progress >= 1.0 { update(progress)?; last_progress = progress; }
            }
        }
        let status = tokio::select! { () = cancel.wait() => return Err(invalid("视频准备任务已取消。")), status = child.wait() => status? };
        if !status.success() {
            let stderr = errors.await.map_err(|error| invalid(&format!("读取媒体日志失败：{error}")))?;
            return Err(BackendError::protocol("本地视频处理失败。", json!({"detail": String::from_utf8_lossy(&stderr)})));
        }
        Ok(())
    }.await;
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    drop(tree);
    result
}

async fn probe_path(ffmpeg: &Path, path: &str) -> BackendResult<VideoPreparationProbe> {
    let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    let has_ffprobe = ffprobe.is_file();
    let mut command = command(if has_ffprobe { &ffprobe } else { ffmpeg });
    if has_ffprobe {
        command.args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
        ]);
    } else {
        command.args(["-hide_banner", "-nostdin", "-i", path]);
    }
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| invalid("读取视频信息超时。"))??;
    if has_ffprobe {
        if !output.status.success() {
            return Err(BackendError::protocol(
                "无法读取视频信息。",
                json!({"detail": String::from_utf8_lossy(&output.stderr)}),
            ));
        }
        parse_probe_json(&output.stdout)
    } else {
        parse_probe_text(&String::from_utf8_lossy(&output.stderr))
    }
}

fn positive_duration(value: &Value) -> Option<f64> {
    value
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| value.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
}
fn frame_rate(value: &str) -> f64 {
    let result = if let Some((n, d)) = value.split_once('/') {
        n.parse::<f64>().unwrap_or(0.0) / d.parse::<f64>().unwrap_or(0.0)
    } else {
        value.parse().unwrap_or(0.0)
    };
    if result.is_finite() && result > 0.0 {
        result
    } else {
        0.0
    }
}

fn parse_probe_json(bytes: &[u8]) -> BackendResult<VideoPreparationProbe> {
    let value: Value = serde_json::from_slice(bytes)?;
    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| invalid("媒体没有可读取的流。"))?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let duration = video
        .and_then(|s| positive_duration(&s["duration"]))
        .or_else(|| positive_duration(&value["format"]["duration"]))
        .or_else(|| {
            streams
                .iter()
                .filter_map(|s| positive_duration(&s["duration"]))
                .max_by(|a, b| a.total_cmp(b))
        })
        .ok_or_else(|| invalid("媒体没有有效时长。"))?;
    let audio_streams = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| VideoPreparationAudioStream {
            index: s["index"].as_u64().unwrap_or(0) as u32,
            codec: s["codec_name"].as_str().unwrap_or("unknown").into(),
            language: s["tags"]["language"].as_str().map(String::from),
            channels: s["channels"].as_u64().unwrap_or(0) as u32,
            sample_rate: s["sample_rate"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
        })
        .collect();
    Ok(VideoPreparationProbe {
        duration_seconds: duration,
        width: video.and_then(|s| s["width"].as_u64()).unwrap_or(0) as u32,
        height: video.and_then(|s| s["height"].as_u64()).unwrap_or(0) as u32,
        fps: video
            .map(|s| frame_rate(s["avg_frame_rate"].as_str().unwrap_or("0")))
            .unwrap_or(0.0),
        audio_streams,
        source_identity: String::new(),
    })
}

fn parse_probe_text(text: &str) -> BackendResult<VideoPreparationProbe> {
    let duration_re = Regex::new(r"Duration:\s*(\d+):(\d+):([\d.]+)").unwrap();
    let duration = duration_re
        .captures(text)
        .map(|c| {
            c[1].parse::<f64>().unwrap_or(0.0) * 3600.0
                + c[2].parse::<f64>().unwrap_or(0.0) * 60.0
                + c[3].parse::<f64>().unwrap_or(0.0)
        })
        .filter(|d| *d > 0.0)
        .ok_or_else(|| invalid("媒体没有有效时长。"))?;
    let dimensions = Regex::new(r"(?:^|[, ])(\d{2,6})x(\d{2,6})(?:[, \[])").unwrap();
    let fps_re = Regex::new(r"([\d.]+) fps").unwrap();
    let audio_re = Regex::new(
        r"Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Audio: ([^ ,]+).*?(\d+) Hz, ([^,]+)",
    )
    .unwrap();
    let video_line = text
        .lines()
        .find(|line| line.contains("Video:") && !line.contains("attached pic"));
    let (width, height) = video_line
        .and_then(|line| dimensions.captures(line))
        .map(|c| (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0)))
        .unwrap_or((0, 0));
    let audio_streams = text
        .lines()
        .filter_map(|line| {
            let c = audio_re.captures(line)?;
            let channels = match c[5].trim() {
                "mono" => 1,
                "stereo" => 2,
                value if value.starts_with("5.1") => 6,
                value if value.starts_with("7.1") => 8,
                value => value
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            };
            Some(VideoPreparationAudioStream {
                index: c[1].parse().ok()?,
                codec: c[3].into(),
                language: c.get(2).map(|v| v.as_str().into()),
                channels,
                sample_rate: c[4].parse().ok()?,
            })
        })
        .collect();
    Ok(VideoPreparationProbe {
        duration_seconds: duration,
        width,
        height,
        fps: video_line
            .and_then(|line| fps_re.captures(line))
            .map(|c| frame_rate(&c[1]))
            .unwrap_or(0.0),
        audio_streams,
        source_identity: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::types::MediaType;

    fn record(name: &str, operation: VideoPreparationOperation) -> VideoPreparationJobRecord {
        VideoPreparationJobRecord {
            job_id: format!("video-preparation-{}", Uuid::new_v4()),
            source: MediaReferenceTarget::LocalFile {
                path: "C:/source.mp4".into(),
                media_type: MediaType::Video,
                canvas_node_key: None,
            },
            source_identity: "a".repeat(64),
            name: safe_name(name),
            operation,
            start_seconds: 0.2,
            end_seconds: 1.2,
            audio_stream_index: Some(2),
            format: VideoPreparationAudioFormat::Wav,
            status: VideoPreparationStatus::Processing,
            progress: Some(20.0),
            output: None,
            error: None,
            created_at: 1,
            updated_at: 2,
        }
    }

    #[test]
    fn video_preparation_rejects_invalid_windows_and_audio_selection() {
        for (start, end) in [
            (f64::NAN, 1.0),
            (-1.0, 1.0),
            (1.0, 1.0),
            (2.0, 1.0),
            (0.0, 3.0),
            (0.0, f64::INFINITY),
        ] {
            assert!(validate_window(start, end, 2.0).is_err());
        }
        assert!(validate_window(0.0, 2.0, 2.0).is_ok());
        let probe = VideoPreparationProbe {
            duration_seconds: 2.0,
            width: 160,
            height: 90,
            fps: 25.0,
            audio_streams: vec![],
            source_identity: String::new(),
        };
        assert!(selected_audio(&probe, VideoPreparationOperation::ExtractAudio, None).is_err());
        assert!(
            selected_audio(&probe, VideoPreparationOperation::ClipVideo, None)
                .unwrap()
                .is_none()
        );
        assert!(selected_audio(&probe, VideoPreparationOperation::ClipVideo, Some(8)).is_err());
    }

    #[test]
    fn video_preparation_ffprobe_and_macos_fallback_preserve_global_audio_indices() {
        let probe = parse_probe_json(br#"{"format":{"duration":"2.2"},"streams":[{"index":0,"codec_type":"video","width":1920,"height":1080,"duration":"2.0","avg_frame_rate":"30000/1001"},{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"tags":{"language":"eng"}},{"index":4,"codec_type":"audio","codec_name":"opus","sample_rate":"48000","channels":1,"tags":{"language":"zho"}}]}"#).unwrap();
        assert_eq!(probe.duration_seconds, 2.0);
        assert!((probe.fps - 29.97002997).abs() < 0.00001);
        let audio = selected_audio(&probe, VideoPreparationOperation::ExtractAudio, Some(4))
            .unwrap()
            .unwrap();
        assert_eq!(audio.language.as_deref(), Some("zho"));
        assert_eq!(original_audio_format(&audio).unwrap().0, "opus");
        let fallback = parse_probe_text("Duration: 00:00:02.00, start: 0.0\n Stream #0:0: Video: h264, yuv420p, 1920x1080, 29.97 fps\n Stream #0:4[0x5](zho): Audio: aac, 48000 Hz, stereo, fltp").unwrap();
        assert_eq!((fallback.width, fallback.height), (1920, 1080));
        assert_eq!(fallback.audio_streams[0].index, 4);
        assert_eq!(fallback.audio_streams[0].channels, 2);
        assert_eq!(fallback.audio_streams[0].sample_rate, 48000);
    }

    #[test]
    fn video_preparation_persistence_recovers_paused_and_cancellation_wins() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("test.sqlite");
        let storage = Storage::open(&database).unwrap();
        storage.initialize_video_preparation().unwrap();
        let mut job = record("E001_同名", VideoPreparationOperation::ExtractAudio);
        storage.save_video_preparation(&job).unwrap();
        drop(storage);
        let storage = Storage::open(&database).unwrap();
        storage.initialize_video_preparation().unwrap();
        let recovered = storage.video_preparation_job(&job.job_id).unwrap().unwrap();
        assert_eq!(recovered.status, VideoPreparationStatus::Paused);
        assert_eq!(recovered.source, job.source);
        assert_eq!(recovered.source_identity, job.source_identity);
        job.status = VideoPreparationStatus::Cancelled;
        storage.save_video_preparation(&job).unwrap();
        job.status = VideoPreparationStatus::Completed;
        assert!(!storage.save_active_video_preparation(&job).unwrap());
        assert_eq!(
            storage
                .video_preparation_job(&job.job_id)
                .unwrap()
                .unwrap()
                .status,
            VideoPreparationStatus::Cancelled
        );
        assert_eq!(storage.video_preparation_jobs().unwrap().len(), 1);
    }

    #[test]
    fn video_preparation_output_rename_survives_restart_without_moving_media() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("rename.sqlite");
        let path = directory.path().join("immutable-source-name.wav");
        std::fs::write(&path, b"retained output content").unwrap();
        let storage = Storage::open(&database).unwrap();
        storage.initialize_video_preparation().unwrap();
        let mut job = record("original", VideoPreparationOperation::ExtractAudio);
        job.status = VideoPreparationStatus::Completed;
        job.output = Some(VideoPreparationOutput {
            kind: "audio".into(),
            path: path.to_string_lossy().into_owned(),
            name: "original.wav".into(),
            mime_type: "audio/wav".into(),
            duration_seconds: 1.0,
            width: None,
            height: None,
        });
        storage.save_video_preparation(&job).unwrap();
        let renamed =
            rename_saved_output(&storage, &job.job_id, "第01集_镜头003_对白.WAV").unwrap();
        assert_eq!(renamed.name, "第01集_镜头003_对白");
        assert_eq!(
            renamed.output.as_ref().unwrap().name,
            "第01集_镜头003_对白.wav"
        );
        assert_eq!(
            renamed.output.as_ref().unwrap().path,
            job.output.as_ref().unwrap().path
        );
        assert_eq!(renamed.source, job.source);
        assert_eq!(renamed.source_identity, job.source_identity);
        assert_eq!(renamed.job_id, job.job_id);
        assert_eq!(renamed.operation, job.operation);
        assert_eq!(std::fs::read(&path).unwrap(), b"retained output content");
        drop(storage);
        let reopened = Storage::open(&database).unwrap();
        reopened.initialize_video_preparation().unwrap();
        let recovered = reopened
            .video_preparation_job(&job.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, VideoPreparationStatus::Completed);
        assert_eq!(recovered.output.unwrap().name, "第01集_镜头003_对白.wav");
        let misleading = rename_saved_output(&reopened, &job.job_id, "声音.mp4").unwrap();
        assert_eq!(misleading.output.unwrap().name, "声音.mp4.wav");
    }

    #[test]
    fn video_preparation_output_rename_rejects_invalid_names_states_and_missing_files() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("rename-invalid.sqlite")).unwrap();
        storage.initialize_video_preparation().unwrap();
        let path = directory.path().join("result.mp4");
        std::fs::write(&path, b"media").unwrap();
        let mut job = record("original", VideoPreparationOperation::ClipVideo);
        job.output = Some(VideoPreparationOutput {
            kind: "video".into(),
            path: path.to_string_lossy().into_owned(),
            name: "original.mp4".into(),
            mime_type: "video/mp4".into(),
            duration_seconds: 1.0,
            width: Some(160),
            height: Some(90),
        });
        storage.save_video_preparation(&job).unwrap();
        assert!(rename_saved_output(&storage, &job.job_id, "未完成").is_err());
        job.status = VideoPreparationStatus::Completed;
        storage.save_video_preparation(&job).unwrap();
        for name in [
            "",
            "  ",
            "../镜头",
            "镜头:003",
            "CON",
            "con.txt",
            "LPT9",
            "角色.",
            "角\n色",
            &"字".repeat(61),
            &"a".repeat(81),
        ] {
            assert!(
                rename_saved_output(&storage, &job.job_id, name).is_err(),
                "unexpected accepted name: {name}"
            );
        }
        assert_eq!(
            storage
                .video_preparation_job(&job.job_id)
                .unwrap()
                .unwrap()
                .name,
            "original"
        );
        std::fs::remove_file(&path).unwrap();
        assert!(rename_saved_output(&storage, &job.job_id, "有效名称").is_err());
        assert_eq!(
            storage
                .video_preparation_job(&job.job_id)
                .unwrap()
                .unwrap()
                .name,
            "original"
        );
    }

    #[test]
    fn video_preparation_same_names_are_isolated_and_output_validation_checks_audio() {
        let a = record("CON../镜头", VideoPreparationOperation::SilentVideo);
        let b = record("CON../镜头", VideoPreparationOperation::SilentVideo);
        assert_eq!(a.name, b.name);
        assert_ne!(
            job_directory(Path::new("root"), &a.job_id).unwrap(),
            job_directory(Path::new("root"), &b.job_id).unwrap()
        );
        assert!(job_directory(Path::new("root"), "../../outside").is_err());
        let mut probe = VideoPreparationProbe {
            duration_seconds: 1.0,
            width: 160,
            height: 90,
            fps: 25.0,
            audio_streams: vec![VideoPreparationAudioStream {
                index: 1,
                codec: "aac".into(),
                language: None,
                channels: 2,
                sample_rate: 48000,
            }],
            source_identity: String::new(),
        };
        assert!(validate_output(&a, &probe).is_err());
        probe.audio_streams.clear();
        assert!(validate_output(&a, &probe).is_ok());
        probe.duration_seconds = 3.0;
        assert!(validate_output(&a, &probe).is_err());
    }

    #[tokio::test]
    async fn video_preparation_real_ffmpeg_extract_clip_silent_and_source_hash() {
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/ffmpeg")
            .join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
        if !ffmpeg.is_file() {
            eprintln!("skip: bundled FFmpeg not available on this test host");
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        let cancel = Cancellation::default();
        let args: Vec<String> = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=25:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=2",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:1",
            "language=zho",
            "-progress",
            "pipe:1",
        ]
        .into_iter()
        .map(String::from)
        .chain([source.to_string_lossy().into_owned()])
        .collect();
        run_ffmpeg(&ffmpeg, &args, &cancel, |_| Ok(()), 2.0)
            .await
            .unwrap();
        let probe = probe_path(&ffmpeg, &source.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(probe.audio_streams.len(), 2);
        assert_eq!(probe.audio_streams[1].index, 2);
        assert_eq!(probe.audio_streams[1].language.as_deref(), Some("zho"));
        let hash = source_signature(&source.to_string_lossy()).await.unwrap();
        assert_eq!(hash.len(), 64);
        for (operation, format, ext) in [
            (
                VideoPreparationOperation::ExtractAudio,
                VideoPreparationAudioFormat::Wav,
                "wav",
            ),
            (
                VideoPreparationOperation::ExtractAudio,
                VideoPreparationAudioFormat::Original,
                "m4a",
            ),
            (
                VideoPreparationOperation::SilentVideo,
                VideoPreparationAudioFormat::Wav,
                "mp4",
            ),
            (
                VideoPreparationOperation::ClipVideo,
                VideoPreparationAudioFormat::Wav,
                "mp4",
            ),
        ] {
            let mut job = record("同一镜头", operation);
            job.format = format;
            let output_dir = job_directory(directory.path(), &job.job_id).unwrap();
            tokio::fs::create_dir_all(&output_dir).await.unwrap();
            let output = output_dir.join(format!("result.{ext}"));
            let args = processing_arguments(&job, &source.to_string_lossy(), &output);
            run_ffmpeg(&ffmpeg, &args, &cancel, |_| Ok(()), 1.0)
                .await
                .unwrap();
            let output_probe = probe_path(&ffmpeg, &output.to_string_lossy())
                .await
                .unwrap();
            validate_output(&job, &output_probe).unwrap();
            if operation == VideoPreparationOperation::ExtractAudio {
                assert_eq!(output_probe.audio_streams.len(), 1);
            }
            assert!(tokio::fs::metadata(output).await.unwrap().len() > 0);
        }
        let mut changed = tokio::fs::read(&source).await.unwrap();
        changed.push(0);
        tokio::fs::write(&source, changed).await.unwrap();
        assert_ne!(
            hash,
            source_signature(&source.to_string_lossy()).await.unwrap()
        );
    }

    #[tokio::test]
    async fn video_preparation_keeps_delayed_audio_aligned_with_source_timeline() {
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/ffmpeg")
            .join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
        if !ffmpeg.is_file() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("delayed.mkv");
        let cancel = Cancellation::default();
        let args: Vec<String> = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=25:duration=2",
            "-itsoffset",
            "0.4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=1.6",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-c:a",
            "pcm_s16le",
            "-progress",
            "pipe:1",
        ]
        .into_iter()
        .map(String::from)
        .chain([source.to_string_lossy().into_owned()])
        .collect();
        run_ffmpeg(&ffmpeg, &args, &cancel, |_| Ok(()), 2.0)
            .await
            .unwrap();
        for operation in [
            VideoPreparationOperation::ExtractAudio,
            VideoPreparationOperation::ClipVideo,
        ] {
            let mut job = record("offset", operation);
            job.start_seconds = 0.0;
            job.end_seconds = 2.0;
            job.audio_stream_index = Some(1);
            let output =
                directory
                    .path()
                    .join(if operation == VideoPreparationOperation::ExtractAudio {
                        "aligned.wav"
                    } else {
                        "aligned.mp4"
                    });
            run_ffmpeg(
                &ffmpeg,
                &processing_arguments(&job, &source.to_string_lossy(), &output),
                &cancel,
                |_| Ok(()),
                2.0,
            )
            .await
            .unwrap();
            validate_output(
                &job,
                &probe_path(&ffmpeg, &output.to_string_lossy())
                    .await
                    .unwrap(),
            )
            .unwrap();
            if operation == VideoPreparationOperation::ExtractAudio {
                let decoded = command(&ffmpeg)
                    .args(["-v", "error", "-i"])
                    .arg(&output)
                    .args([
                        "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
                    ])
                    .output()
                    .await
                    .unwrap();
                assert!(decoded.status.success());
                assert!(
                    decoded.stdout[..33600].iter().all(|value| *value == 0),
                    "leading source silence must be preserved"
                );
                assert!(
                    decoded.stdout[42000..50000].iter().any(|value| *value != 0),
                    "selected audio must follow the original delay"
                );
            } else {
                let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
                    "ffprobe.exe"
                } else {
                    "ffprobe"
                });
                if ffprobe.is_file() {
                    let measured = command(&ffprobe)
                        .args(["-v", "error", "-show_streams", "-of", "json"])
                        .arg(&output)
                        .output()
                        .await
                        .unwrap();
                    let streams: Value = serde_json::from_slice(&measured.stdout).unwrap();
                    let audio = streams["streams"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|stream| stream["codec_type"] == "audio")
                        .unwrap();
                    let start = audio["start_time"]
                        .as_str()
                        .unwrap()
                        .parse::<f64>()
                        .unwrap();
                    assert!(
                        (0.35..0.55).contains(&start),
                        "audio/video relative offset changed: {start}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn video_preparation_cancellation_terminates_ffmpeg() {
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/ffmpeg")
            .join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
        if !ffmpeg.is_file() {
            return;
        }
        let cancel = Arc::new(Cancellation::default());
        let trigger = cancel.clone();
        let args: Vec<String> = [
            "-hide_banner",
            "-v",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=25",
            "-f",
            "null",
            "-",
            "-progress",
            "pipe:1",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let work = tauri::async_runtime::spawn(async move {
            run_ffmpeg(&ffmpeg, &args, &cancel, |_| Ok(()), 1000.0).await
        });
        tokio::time::sleep(Duration::from_millis(250)).await;
        trigger.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), work)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
}
