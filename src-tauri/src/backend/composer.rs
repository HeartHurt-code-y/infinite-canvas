//! 画布视频合成：内置 FFmpeg 引擎的确定性合成服务。
//!
//! 引擎策略分两级：安装包内置构建优先（构建期由 `scripts/prepare-ffmpeg.mjs`
//! 下载官方 Windows 构建到 `resources/ffmpeg/` 并随包分发，只读）；资源目录
//! 缺失或不完整时，回退到与 yt-dlp 下载器一致的策略——首次使用（或用户手动
//! 触发）时把官方独立构建的 FFmpeg 下载到应用数据目录。下载与解包复用
//! `ffmpeg-sidecar` crate（它会按平台选择官方构建源），但安装位置由本服务
//! 指定为应用数据目录——crate 默认安装到可执行文件同目录，打包安装后会落在
//! 不可写的 Program Files。合成产物与下载产物、生成结果一致，落在系统下载
//! 目录的「无限画布」子目录。
//!
//! 合成实现取代前端 MediaRecorder 实时录制：各输入（本地文件或 http(s) 地址）
//! 先用 ffprobe 探测时长/尺寸/音轨，再经 filter_complex 统一缩放补边到首段尺寸
//! （钳制 1920×1080、取偶、不裁切）、统一帧率、补静音音轨，最后 concat 重编码为
//! H.264/AAC MP4（yuv420p + faststart）。进度来自 ffmpeg `-progress pipe:1` 的
//! out_time；取消通过终止子进程完成。任务记录只保存在内存中，前端轮询进度。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tokio::io::AsyncBufReadExt as _;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use super::error::{BackendError, BackendResult};
use super::types::StartVideoCompositionCommand;

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 合成输出基准帧率；与画布 MediaRecorder 路径的 captureStream(30) 一致。
const OUTPUT_FPS: u32 = 30;
/// 合成输出尺寸钳制上限；与前端 compositionCanvasSize 一致。
const OUTPUT_MAX_WIDTH: f64 = 1920.0;
const OUTPUT_MAX_HEIGHT: f64 = 1080.0;
/// 远程输入的读超时（ffmpeg -rw_timeout，单位微秒）。
const REMOTE_READ_TIMEOUT_MICROS: &str = "30000000";
/// 进度轮询期间进度条封顶值；100 只在编码成功收尾时写入。
const PROCESSING_PROGRESS_CAP: f64 = 99.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoComposerEngineState {
    NotInstalled,
    Installing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoComposerEngineStatus {
    pub state: VideoComposerEngineState,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCompositionStatus {
    /// 正在准备引擎或探测输入元数据。
    PreparingEngine,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCompositionJobRecord {
    pub job_id: String,
    pub status: VideoCompositionStatus,
    /// 0-100；引擎准备与探测阶段为 None。
    pub progress: Option<f64>,
    pub final_path: Option<String>,
    pub file_name: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug)]
struct EngineRuntime {
    installing: bool,
    last_error: Option<String>,
}

struct CompositionJobEntry {
    record: VideoCompositionJobRecord,
    cancelled: Arc<AtomicBool>,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, CompositionJobEntry>>,
    engine: std::sync::Mutex<EngineRuntime>,
    /// 串行化引擎安装，避免并发重复下载二进制。
    engine_lock: AsyncMutex<()>,
    downloads_dir: PathBuf,
    /// 可写引擎目录（应用数据目录）；下载回退的落点与版本记录位置。
    engine_dir: PathBuf,
    /// 安装包资源目录（只读）。其 `ffmpeg/` 子目录为构建期预置的内置引擎。
    resource_dir: PathBuf,
}

/// 画布视频合成服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoCompositionService {
    inner: Arc<Inner>,
}

/// ffprobe 探测结果：合成编排所需的全部元数据。
#[derive(Debug, Clone, PartialEq)]
struct MediaProbe {
    duration_seconds: f64,
    width: i64,
    height: i64,
    has_audio: bool,
}

impl VideoCompositionService {
    pub fn new(
        downloads_dir: PathBuf,
        engine_dir: PathBuf,
        resource_dir: PathBuf,
    ) -> BackendResult<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                engine: std::sync::Mutex::new(EngineRuntime {
                    installing: false,
                    last_error: None,
                }),
                engine_lock: AsyncMutex::new(()),
                downloads_dir,
                engine_dir,
                resource_dir,
            }),
        })
    }

    // ---------- 引擎管理 ----------

    fn ffmpeg_binary_name() -> &'static str {
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }
    }

    fn ffprobe_binary_name() -> &'static str {
        if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        }
    }

    /// 安装包内置引擎目录（只读资源）。
    fn builtin_engine_dir(&self) -> PathBuf {
        self.inner.resource_dir.join("ffmpeg")
    }

    /// 内置引擎是否完整可用（ffmpeg + ffprobe 都在资源目录中）。
    fn has_builtin_engine(&self) -> bool {
        let directory = self.builtin_engine_dir();
        directory.join(Self::ffmpeg_binary_name()).is_file()
            && directory.join(Self::ffprobe_binary_name()).is_file()
    }

    /// 生效引擎目录：内置构建完整时优先使用只读资源目录，否则回退到应用数据目录。
    fn active_engine_dir(&self) -> PathBuf {
        if self.has_builtin_engine() {
            self.builtin_engine_dir()
        } else {
            self.inner.engine_dir.clone()
        }
    }

    fn ffmpeg_binary(&self) -> PathBuf {
        self.active_engine_dir().join(Self::ffmpeg_binary_name())
    }

    fn ffprobe_binary(&self) -> PathBuf {
        self.active_engine_dir().join(Self::ffprobe_binary_name())
    }

    /// 生效引擎版本记录。version.txt 始终写在可写的应用数据目录
    /// （资源目录只读不可写），内置与下载引擎共用同一记录位置。
    fn installed_version(&self) -> Option<String> {
        std::fs::read_to_string(self.inner.engine_dir.join("version.txt"))
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    }

    /// 汇总当前引擎状态。版本以 version.txt 为准，不在这里探测（命令线程禁止阻塞）。
    pub fn engine_status(&self) -> VideoComposerEngineStatus {
        let binary_exists = self.ffmpeg_binary().is_file();
        let runtime = self.inner.engine.lock().expect("engine runtime poisoned");
        let state = if runtime.installing {
            VideoComposerEngineState::Installing
        } else if binary_exists {
            VideoComposerEngineState::Ready
        } else if runtime.last_error.is_some() {
            VideoComposerEngineState::Failed
        } else {
            VideoComposerEngineState::NotInstalled
        };
        VideoComposerEngineStatus {
            state,
            version: binary_exists.then(|| self.installed_version()).flatten(),
            binary_path: binary_exists.then(|| self.ffmpeg_binary().to_string_lossy().into_owned()),
            last_error: runtime.last_error.clone(),
        }
    }

    /// 安装（或补装）引擎；已就绪时直接返回当前状态。
    pub async fn install_engine(&self) -> VideoComposerEngineStatus {
        {
            let mut runtime = self.inner.engine.lock().expect("engine runtime poisoned");
            if runtime.installing {
                // 已有其他调用方正在安装：直接基于当前持有的锁构造状态返回，
                // 禁止调用 engine_status()——它会再次 lock 同一把 std Mutex，
                // 而 std Mutex 不可重入，重入会导致死锁（并发首次安装时必现）。
                return VideoComposerEngineStatus {
                    state: VideoComposerEngineState::Installing,
                    version: None,
                    binary_path: None,
                    last_error: runtime.last_error.clone(),
                };
            }
            runtime.installing = true;
            runtime.last_error = None;
        }
        let install_result: BackendResult<String> = async {
            let _guard = self.inner.engine_lock.lock().await;
            if self.ffmpeg_binary().is_file() && self.ffprobe_binary().is_file() {
                return match self.installed_version() {
                    Some(version) => Ok(version),
                    None => self.probe_and_record_version().await,
                };
            }
            self.download_engine().await?;
            self.probe_and_record_version().await
        }
        .await;
        {
            let mut runtime = self.inner.engine.lock().expect("engine runtime poisoned");
            runtime.installing = false;
            if let Err(ref error) = install_result {
                runtime.last_error = Some(error.to_string());
            }
        }
        if let Err(error) = install_result {
            tauri_plugin_log::log::error!("[composer] FFmpeg 引擎安装失败: {error}");
        }
        self.engine_status()
    }

    /// 获取已就绪的 ffmpeg 可执行文件路径；引擎未安装时自动安装。
    ///
    /// 素材导入等需要本地转码的模块复用同一套 FFmpeg 引擎，
    /// 避免为单个功能重复下载独立二进制。
    ///
    /// 并发安全：多个任务首次同时触发安装时，本方法会等待正在进行的安装
    /// 完成后返回就绪路径，而不是对“正在安装”的状态直接报错。
    pub async fn ensure_ffmpeg(&self) -> BackendResult<PathBuf> {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        loop {
            let status = self.install_engine().await;
            match status.state {
                VideoComposerEngineState::Ready => return Ok(self.ffmpeg_binary()),
                VideoComposerEngineState::Installing if std::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                _ => {
                    return Err(BackendError::protocol(
                        "ffmpeg engine is not ready",
                        json!({
                            "state": format!("{:?}", status.state),
                            "lastError": status.last_error,
                        }),
                    ));
                }
            }
        }
    }

    /// 用 ffmpeg-sidecar 的平台感知下载逻辑把官方构建拉到自建引擎目录。
    /// 下载与解包是阻塞 IO，放入阻塞线程池执行。
    async fn download_engine(&self) -> BackendResult<()> {
        let engine_dir = self.inner.engine_dir.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            std::fs::create_dir_all(&engine_dir).map_err(|error| error.to_string())?;
            let url = ffmpeg_sidecar::download::ffmpeg_download_url()
                .map_err(|error| error.to_string())?;
            let archive_path = ffmpeg_sidecar::download::download_ffmpeg_package_with_progress(
                url,
                &engine_dir,
                |_| {},
            )
            .map_err(|error| error.to_string())?;
            // 需要完整解包：without_extras 变体只装 ffmpeg，而合成依赖 ffprobe 探测元数据。
            ffmpeg_sidecar::download::unpack_ffmpeg(&archive_path, &engine_dir)
                .map_err(|error| error.to_string())?;
            Ok(())
        })
        .await
        .map_err(|error| {
            BackendError::protocol(
                "ffmpeg engine install task panicked",
                serde_json::json!({ "source": error.to_string() }),
            )
        })?;
        outcome.map_err(|source| {
            BackendError::protocol(
                "ffmpeg engine download failed",
                serde_json::json!({ "source": source }),
            )
        })
    }

    /// 完整性之外还要求引擎能真实执行（拦截杀毒软件隔离、平台不匹配等）。
    /// 探测对象是当前生效二进制（内置或下载回退），版本记录写入可写目录。
    async fn probe_and_record_version(&self) -> BackendResult<String> {
        let reported = self.probe_binary_version(&self.ffmpeg_binary()).await?;
        tokio::fs::write(self.inner.engine_dir.join("version.txt"), &reported).await?;
        tauri_plugin_log::log::info!("[composer] FFmpeg 引擎就绪: version={reported}");
        Ok(reported)
    }

    async fn probe_binary_version(&self, binary: &Path) -> BackendResult<String> {
        let mut command = tokio::process::Command::new(binary);
        command.arg("-version").stdin(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().await?;
        if !output.status.success() {
            return Err(BackendError::protocol(
                "ffmpeg binary is not executable",
                serde_json::json!({
                    "exitCode": output.status.code(),
                    "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                }),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        // 首行形如「ffmpeg version 7.1-essentials_build-... Copyright ...」。
        let version = stdout
            .lines()
            .find_map(|line| line.strip_prefix("ffmpeg version "))
            .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
            .filter(|version| !version.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "ffmpeg -version output is not parseable",
                    serde_json::json!({ "stdout": stdout.trim() }),
                )
            })?;
        Ok(version)
    }

    async fn ensure_engine(&self) -> BackendResult<(PathBuf, PathBuf)> {
        if self.ffmpeg_binary().is_file() && self.ffprobe_binary().is_file() {
            return Ok((self.ffmpeg_binary(), self.ffprobe_binary()));
        }
        self.install_engine().await;
        if self.ffmpeg_binary().is_file() && self.ffprobe_binary().is_file() {
            return Ok((self.ffmpeg_binary(), self.ffprobe_binary()));
        }
        let runtime = self.inner.engine.lock().expect("engine runtime poisoned");
        let detail = runtime
            .last_error
            .clone()
            .unwrap_or_else(|| "引擎仍未就绪".to_string());
        Err(BackendError::protocol(
            "ffmpeg engine is not available after install attempt",
            serde_json::json!({ "detail": detail }),
        ))
    }

    // ---------- 合成任务 ----------

    /// 创建并启动一个合成任务。任务记录保存在内存中，前端轮询进度。
    pub fn start_composition(
        &self,
        command: StartVideoCompositionCommand,
    ) -> BackendResult<VideoCompositionJobRecord> {
        if command.inputs.len() < 2 {
            return Err(BackendError::validation(
                "至少需要 2 段视频才能合成",
                serde_json::json!({ "inputCount": command.inputs.len() }),
            ));
        }
        let mut sources: Vec<String> = Vec::with_capacity(command.inputs.len());
        for input in &command.inputs {
            let source = input.source.trim();
            if source.is_empty() {
                return Err(BackendError::validation(
                    format!("输入「{}」缺少可合成的视频来源", input.name),
                    serde_json::json!({ "key": input.key }),
                ));
            }
            if !is_remote_source(source) && !Path::new(source).is_file() {
                return Err(BackendError::validation(
                    format!("输入「{}」的视频文件不存在", input.name),
                    serde_json::json!({ "source": source }),
                ));
            }
            sources.push(source.to_string());
        }
        let file_name = composed_video_file_name(&command.output_name, chrono::Local::now());
        let directory = self.inner.downloads_dir.join("无限画布");
        let output_path = unique_output_path(&directory, &file_name);

        let job_id = format!("composition-{}", Uuid::new_v4());
        let now = now_ms();
        let record = VideoCompositionJobRecord {
            job_id: job_id.clone(),
            status: VideoCompositionStatus::PreparingEngine,
            progress: None,
            final_path: None,
            file_name: Some(file_name.clone()),
            width: None,
            height: None,
            duration_seconds: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        {
            let mut jobs = self.inner.jobs.lock().expect("composition jobs poisoned");
            retain_recent_jobs(&mut jobs);
            jobs.insert(
                job_id.clone(),
                CompositionJobEntry {
                    record: record.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service
                .run_composition(job_id, sources, output_path, file_name)
                .await;
        });
        Ok(record)
    }

    pub fn get_job(&self, job_id: &str) -> BackendResult<VideoCompositionJobRecord> {
        let jobs = self.inner.jobs.lock().expect("composition jobs poisoned");
        jobs.get(job_id)
            .map(|entry| entry.record.clone())
            .ok_or_else(|| BackendError::NotFound(format!("composition job {job_id}")))
    }

    /// 请求取消。run_composition 在轮询窗口内感知标记并终止子进程。
    pub fn cancel_job(&self, job_id: &str) -> BackendResult<VideoCompositionJobRecord> {
        let mut jobs = self.inner.jobs.lock().expect("composition jobs poisoned");
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| BackendError::NotFound(format!("composition job {job_id}")))?;
        if matches!(
            entry.record.status,
            VideoCompositionStatus::PreparingEngine | VideoCompositionStatus::Processing
        ) {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry.record.status = VideoCompositionStatus::Cancelled;
            entry.record.updated_at = now_ms();
        }
        Ok(entry.record.clone())
    }

    fn update_record(&self, job_id: &str, mutate: impl FnOnce(&mut VideoCompositionJobRecord)) {
        let mut jobs = self.inner.jobs.lock().expect("composition jobs poisoned");
        if let Some(entry) = jobs.get_mut(job_id) {
            mutate(&mut entry.record);
            entry.record.updated_at = now_ms();
        }
    }

    fn set_progress(&self, job_id: &str, percent: f64) {
        self.update_record(job_id, |record| {
            let percent = percent.clamp(0.0, PROCESSING_PROGRESS_CAP);
            record.progress = Some(
                record
                    .progress
                    .map_or(percent, |current| current.max(percent)),
            );
        });
    }

    fn fail_job(&self, job_id: &str, message: String) {
        self.update_record(job_id, |record| {
            record.status = VideoCompositionStatus::Failed;
            record.error = Some(message);
        });
    }

    fn is_cancelled(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .expect("composition jobs poisoned")
            .get(job_id)
            .is_some_and(|entry| entry.cancelled.load(Ordering::Relaxed))
    }

    fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        self.inner
            .jobs
            .lock()
            .expect("composition jobs poisoned")
            .get(job_id)
            .map_or_else(
                || Arc::new(AtomicBool::new(false)),
                |entry| entry.cancelled.clone(),
            )
    }

    async fn run_composition(
        &self,
        job_id: String,
        sources: Vec<String>,
        output_path: PathBuf,
        file_name: String,
    ) {
        // 1. 确保引擎就绪（缺失时自动下载官方构建）。
        let (ffmpeg, ffprobe) = match self.ensure_engine().await {
            Ok(paths) => paths,
            Err(error) => {
                self.fail_job(&job_id, format!("合成引擎准备失败：{error}"));
                return;
            }
        };
        if self.is_cancelled(&job_id) {
            return;
        }

        // 2. 探测各输入的时长/尺寸/音轨。
        let mut probes: Vec<MediaProbe> = Vec::with_capacity(sources.len());
        for (index, source) in sources.iter().enumerate() {
            match probe_media(&ffprobe, source).await {
                Ok(probe) => probes.push(probe),
                Err(error) => {
                    self.fail_job(&job_id, format!("第 {} 段视频无法读取：{error}", index + 1));
                    return;
                }
            }
        }
        if self.is_cancelled(&job_id) {
            return;
        }
        self.update_record(&job_id, |record| {
            record.status = VideoCompositionStatus::Processing;
            record.progress = Some(0.0);
        });

        // 3. 输出尺寸跟随首段视频（与画布 MediaRecorder 路径同一规则）。
        let (width, height) = composition_canvas_size(probes[0].width, probes[0].height);
        let total_duration: f64 = probes.iter().map(|probe| probe.duration_seconds).sum();
        let filter = build_composition_filter(&probes, width, height);

        // 4. 启动 ffmpeg 子进程。
        let mut command = tokio::process::Command::new(&ffmpeg);
        command
            .args(composition_args(&sources, &filter, &output_path))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.fail_job(&job_id, format!("合成引擎启动失败：{error}"));
                return;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // 5. 并行读取输出：stdout 解析 -progress 进度，stderr 保留错误尾部。
        let progress_service = self.clone();
        let progress_job_id = job_id.clone();
        let total = total_duration;
        let stdout_task = tauri::async_runtime::spawn(async move {
            let Some(stdout) = stdout else {
                return;
            };
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(micros) = parse_progress_micros(&line) {
                    let percent = (micros as f64 / 1_000_000.0) / total * 100.0;
                    if percent.is_finite() {
                        progress_service.set_progress(&progress_job_id, percent);
                    }
                }
            }
        });
        let stderr_task = tauri::async_runtime::spawn(collect_stderr_tail(stderr));

        // 6. 等待退出；取消请求在 200ms 轮询窗口内触发 kill。
        let cancelled = self.cancel_flag(&job_id);
        let wait_result = tokio::select! {
            status = child.wait() => status,
            _ = wait_for_cancel(cancelled) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                remove_partial_output(&output_path).await;
                return;
            }
        };
        let stderr_tail = stderr_task.await.unwrap_or_default();

        match wait_result {
            Ok(status) if status.success() => {
                if !output_path.is_file() {
                    self.fail_job(&job_id, "合成结束但输出文件不存在。".into());
                    return;
                }
                self.update_record(&job_id, |record| {
                    record.status = VideoCompositionStatus::Completed;
                    record.progress = Some(100.0);
                    record.final_path = Some(output_path.to_string_lossy().into_owned());
                    record.file_name = Some(file_name);
                    record.width = Some(width);
                    record.height = Some(height);
                    record.duration_seconds = Some(total_duration);
                });
                tauri_plugin_log::log::info!(
                    "[composer] 视频合成完成: duration={total_duration:.2}s, output={}",
                    output_path.display()
                );
            }
            Ok(status) => {
                remove_partial_output(&output_path).await;
                self.fail_job(&job_id, failure_message(&stderr_tail, &status.to_string()));
            }
            Err(error) => {
                remove_partial_output(&output_path).await;
                self.fail_job(&job_id, format!("合成进程异常退出：{error}"));
            }
        }
        let _ = stdout_task.await;
    }
}

/// 校验源（http(s) 地址或存在的本地文件）并返回去重后的输出路径。
fn unique_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let extension_index = file_name.rfind('.').unwrap_or(file_name.len());
    let (base, extension) = file_name.split_at(extension_index);
    let mut candidate = directory.join(file_name);
    let mut suffix = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{base}-{suffix}{extension}"));
        suffix += 1;
    }
    candidate
}

/// 判断来源是否为远程地址（ffmpeg 原生支持 http(s) 拉流）。
fn is_remote_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

/// 与前端 composedVideoFileName 相同的清洗规则：去控制字符、去扩展名、
/// 替换文件系统非法字符、去尾部空白点、截断 80 字符，空值回退「合成视频」。
fn sanitize_output_base_name(raw: &str) -> String {
    let printable: String = raw.chars().filter(|character| *character >= ' ').collect();
    let without_extension = printable
        .trim()
        .replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "-");
    let without_extension = without_extension
        .trim_end()
        .strip_suffix(".mp4")
        .or_else(|| without_extension.trim_end().strip_suffix(".webm"))
        .unwrap_or(without_extension.trim_end())
        .to_string();
    let base: String = without_extension
        .trim_end_matches(['.', ' '])
        .chars()
        .take(80)
        .collect();
    if base.is_empty() {
        "合成视频".to_string()
    } else {
        base
    }
}

/// 合成输出的最终文件名：`{清洗后名称}-{YYYYMMDD-HHMMSS}.mp4`。
fn composed_video_file_name(raw: &str, now: chrono::DateTime<chrono::Local>) -> String {
    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    format!("{}-{stamp}.mp4", sanitize_output_base_name(raw))
}

/// 与前端 compositionCanvasSize 一致：跟随首段视频，等比钳制到 1920×1080 内，
/// 像素取偶（部分编码器要求），最小 2。
fn composition_canvas_size(source_width: i64, source_height: i64) -> (i64, i64) {
    let width = if source_width > 0 { source_width } else { 1280 };
    let height = if source_height > 0 {
        source_height
    } else {
        720
    };
    let scale = f64::min(
        1.0,
        f64::min(
            OUTPUT_MAX_WIDTH / width as f64,
            OUTPUT_MAX_HEIGHT / height as f64,
        ),
    );
    let even = |value: f64| (((value / 2.0).round() as i64).max(1)) * 2;
    (even(width as f64 * scale), even(height as f64 * scale))
}

/// 组装 ffmpeg 参数：输入序列 + filter_complex + H.264/AAC 编码与 faststart，
/// 并用 `-progress pipe:1` 输出机器可读进度。
fn composition_args(sources: &[String], filter: &str, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-rw_timeout".into(),
        REMOTE_READ_TIMEOUT_MICROS.into(),
    ];
    for source in sources {
        args.push("-i".into());
        args.push(source.clone());
    }
    args.extend(["-filter_complex".into(), filter.to_string()]);
    args.extend([
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ]);
    args.push(output.to_string_lossy().into_owned());
    args
}

/// 构建合成 filter_complex：各输入统一缩放补边到目标尺寸（不裁切）、统一帧率、
/// 像素比归一；无音轨的输入用 anullsrc 补静音段；最后 concat 为单一输出。
fn build_composition_filter(
    probes: &[MediaProbe],
    target_width: i64,
    target_height: i64,
) -> String {
    let mut chains: Vec<String> = Vec::with_capacity(probes.len() * 2 + 1);
    for (index, probe) in probes.iter().enumerate() {
        chains.push(format!(
            "[{index}:v]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,\
             pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={OUTPUT_FPS}[v{index}]"
        ));
        if probe.has_audio {
            chains.push(format!(
                "[{index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]"
            ));
        } else {
            chains.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=duration={:.3},\
                 aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]",
                probe.duration_seconds
            ));
        }
    }
    let video_labels: String = (0..probes.len())
        .map(|index| format!("[v{index}]"))
        .collect();
    let audio_labels: String = (0..probes.len())
        .map(|index| format!("[a{index}]"))
        .collect();
    chains.push(format!(
        "{video_labels}{audio_labels}concat=n={}:v=1:a=1[vout][aout]",
        probes.len()
    ));
    chains.join(";")
}

/// 解析 ffmpeg `-progress` 输出行。out_time_us/out_time_ms 单位都是微秒
/// （ffmpeg 历史遗留：out_time_ms 名不副实）。
fn parse_progress_micros(line: &str) -> Option<i64> {
    let (key, value) = line.split_once('=')?;
    let micros = match key.trim() {
        "out_time_us" | "out_time_ms" => value.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    (micros > 0).then_some(micros)
}

/// 解析 ffprobe JSON 输出（-print_format json -show_format -show_streams）。
fn parse_probe_json(payload: &str) -> BackendResult<MediaProbe> {
    let value: serde_json::Value = serde_json::from_str(payload)?;
    let duration = value
        .pointer("/format/duration")
        .and_then(serde_json::Value::as_str)
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| {
            value
                .pointer("/streams")
                .and_then(serde_json::Value::as_array)
                .map(|streams| {
                    streams
                        .iter()
                        .filter(|stream| stream["codec_type"] == "video")
                        .find_map(|stream| stream["duration"].as_str()?.parse::<f64>().ok())
                })
                .unwrap_or(None)
        })
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| {
            BackendError::protocol(
                "ffprobe output has no usable duration",
                serde_json::json!({ "duration": value.pointer("/format/duration") }),
            )
        })?;
    let video = value
        .pointer("/streams")
        .and_then(serde_json::Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream["codec_type"] == "video")
        })
        .ok_or_else(|| {
            BackendError::protocol(
                "ffprobe output has no video stream",
                serde_json::Value::Null,
            )
        })?;
    Ok(MediaProbe {
        duration_seconds: duration,
        width: video["width"].as_i64().unwrap_or(0),
        height: video["height"].as_i64().unwrap_or(0),
        has_audio: value
            .pointer("/streams")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "audio")),
    })
}

/// ffprobe 单个输入并提取合成所需的元数据。
async fn probe_media(ffprobe: &Path, source: &str) -> BackendResult<MediaProbe> {
    let mut command = tokio::process::Command::new(ffprobe);
    command
        .args([
            "-v".to_string(),
            "error".to_string(),
            "-print_format".to_string(),
            "json".to_string(),
            "-show_format".to_string(),
            "-show_streams".to_string(),
            source.to_string(),
        ])
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().await?;
    if !output.status.success() {
        return Err(BackendError::protocol(
            "ffprobe exited with non-zero status",
            serde_json::json!({
                "exitCode": output.status.code(),
                "stderr": String::from_utf8_lossy(&output.stderr).trim(),
            }),
        ));
    }
    parse_probe_json(&String::from_utf8_lossy(&output.stdout))
}

async fn collect_stderr_tail(stderr: Option<tokio::process::ChildStderr>) -> VecDeque<String> {
    let mut tail: VecDeque<String> = VecDeque::new();
    let Some(stderr) = stderr else {
        return tail;
    };
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tail.len() >= 24 {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    tail
}

/// 组装失败信息：优先给 ffmpeg stderr 尾部（包含真实编码错误）。
fn failure_message(stderr_tail: &VecDeque<String>, fallback: &str) -> String {
    let relevant: Vec<&str> = stderr_tail
        .iter()
        .map(String::as_str)
        .filter(|line| !line.is_empty())
        .collect();
    if relevant.is_empty() {
        return format!("视频合成失败（{fallback}）。");
    }
    let tail: String = relevant
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|line| format!("{line}\n"))
        .collect();
    format!("视频合成失败：\n{tail}")
}

/// 删除合成中断产生的残缺输出（无 moov 的 MP4 不可播放）。
async fn remove_partial_output(output_path: &Path) {
    if output_path.is_file() {
        let _ = tokio::fs::remove_file(output_path).await;
    }
}

async fn wait_for_cancel(flag: Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 任务记录只存内存，超过 100 条时按 updated_at 清理最旧的已结束任务。
fn retain_recent_jobs(jobs: &mut HashMap<String, CompositionJobEntry>) {
    if jobs.len() < 100 {
        return;
    }
    let mut terminal: Vec<(String, i64)> = jobs
        .iter()
        .filter(|(_, entry)| {
            matches!(
                entry.record.status,
                VideoCompositionStatus::Completed
                    | VideoCompositionStatus::Failed
                    | VideoCompositionStatus::Cancelled
            )
        })
        .map(|(key, entry)| (key.clone(), entry.record.updated_at))
        .collect();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    let remove_count = terminal.len().saturating_sub(50);
    for (key, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&key);
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composition_canvas_size_clamps_and_rounds_even() {
        // 超限等比缩小：3840×2160 → 1920×1080。
        assert_eq!(composition_canvas_size(3840, 2160), (1920, 1080));
        // 竖屏跟随首段比例：1080×1920 → 608×1080。
        assert_eq!(composition_canvas_size(1080, 1920), (608, 1080));
        // 奇数像素取偶。
        assert_eq!(composition_canvas_size(641, 361), (642, 362));
        // 无效尺寸回退 1280×720。
        assert_eq!(composition_canvas_size(0, 0), (1280, 720));
    }

    #[test]
    fn sanitize_output_base_name_follows_canvas_rules() {
        assert_eq!(sanitize_output_base_name("我的 视频?.mp4"), "我的 视频-");
        assert_eq!(sanitize_output_base_name("预告片..."), "预告片");
        assert_eq!(
            sanitize_output_base_name("a<b>c:d\"e/f\\g|h?i*j"),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(sanitize_output_base_name("   "), "合成视频");
        assert_eq!(sanitize_output_base_name("…"), "…");
    }

    #[test]
    fn composed_video_file_name_appends_timestamp() {
        use chrono::TimeZone as _;
        let now = chrono::Local
            .with_ymd_and_hms(2026, 8, 31, 9, 5, 3)
            .single()
            .unwrap();
        assert_eq!(
            composed_video_file_name("测试", now),
            "测试-20260831-090503.mp4"
        );
        assert_eq!(
            composed_video_file_name("   ", now),
            "合成视频-20260831-090503.mp4"
        );
    }

    #[test]
    fn unique_output_path_deduplicates_with_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let first = unique_output_path(directory.path(), "out.mp4");
        std::fs::File::create(&first).unwrap();
        let second = unique_output_path(directory.path(), "out.mp4");
        assert_ne!(first, second);
        assert!(second.ends_with("out-2.mp4"));
    }

    #[test]
    fn parse_progress_micros_reads_ffmpeg_progress_lines() {
        assert_eq!(
            parse_progress_micros("out_time_us=1500000"),
            Some(1_500_000)
        );
        // ffmpeg 历史遗留：out_time_ms 实际也是微秒。
        assert_eq!(parse_progress_micros("out_time_ms=250000"), Some(250_000));
        assert_eq!(parse_progress_micros("progress=continue"), None);
        assert_eq!(parse_progress_micros("out_time_us=-1"), None);
        assert_eq!(parse_progress_micros("frame=12"), None);
    }

    #[test]
    fn build_composition_filter_normalizes_and_concats() {
        let probes = vec![
            MediaProbe {
                duration_seconds: 3.0,
                width: 1920,
                height: 1080,
                has_audio: true,
            },
            MediaProbe {
                duration_seconds: 2.5,
                width: 720,
                height: 1280,
                has_audio: false,
            },
        ];
        let filter = build_composition_filter(&probes, 1920, 1080);
        assert!(filter.contains("[0:v]scale=1920:1080:force_original_aspect_ratio=decrease"));
        assert!(filter.contains("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black"));
        assert!(filter.contains("setsar=1,fps=30"));
        assert!(filter.contains("[0:a]aresample=48000"));
        assert!(filter.contains("anullsrc=r=48000:cl=stereo,atrim=duration=2.500"));
        assert!(filter.contains("[v0][v1][a0][a1]concat=n=2:v=1:a=1[vout][aout]"));
    }

    #[test]
    fn parse_probe_json_reads_format_and_streams() {
        let payload = r#"{
            "format": { "duration": "12.5" },
            "streams": [
                { "codec_type": "video", "width": 1920, "height": 1080 },
                { "codec_type": "audio" }
            ]
        }"#;
        let probe = parse_probe_json(payload).unwrap();
        assert_eq!(probe.duration_seconds, 12.5);
        assert_eq!(probe.width, 1920);
        assert_eq!(probe.height, 1080);
        assert!(probe.has_audio);
    }

    #[test]
    fn parse_probe_json_rejects_missing_duration_or_video() {
        let no_duration = r#"{
            "format": {},
            "streams": [ { "codec_type": "video", "width": 100, "height": 100 } ]
        }"#;
        assert!(parse_probe_json(no_duration).is_err());

        let no_video = r#"{
            "format": { "duration": "3.0" },
            "streams": [ { "codec_type": "audio" } ]
        }"#;
        assert!(parse_probe_json(no_video).is_err());
    }

    #[test]
    fn composition_args_orders_inputs_before_filters() {
        let sources = vec!["a.mp4".to_string(), "https://example.com/b.mp4".to_string()];
        let args = composition_args(&sources, "[v0][v1]concat[vout][aout]", Path::new("out.mp4"));
        let input_positions: Vec<usize> = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| arg.as_str() == "-i")
            .map(|(index, _)| index)
            .collect();
        assert_eq!(input_positions, vec![5, 7]);
        assert_eq!(args[6], "a.mp4");
        assert_eq!(args[8], "https://example.com/b.mp4");
        assert!(args.contains(&"[vout]".to_string()));
        assert!(args.contains(&"+faststart".to_string()));
        assert_eq!(*args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn is_remote_source_accepts_only_http_schemes() {
        assert!(is_remote_source("https://example.com/a.mp4"));
        assert!(is_remote_source("http://example.com/a.mp4"));
        assert!(!is_remote_source(r"C:\视频\a.mp4"));
        assert!(!is_remote_source("ftp://example.com/a.mp4"));
    }

    #[test]
    fn builtin_engine_takes_precedence_over_download_dir() {
        let resource = tempfile::tempdir().unwrap();
        let builtin = resource.path().join("ffmpeg");
        std::fs::create_dir_all(&builtin).unwrap();
        std::fs::write(
            builtin.join(VideoCompositionService::ffmpeg_binary_name()),
            b"fixture",
        )
        .unwrap();
        std::fs::write(
            builtin.join(VideoCompositionService::ffprobe_binary_name()),
            b"fixture",
        )
        .unwrap();
        let download = tempfile::tempdir().unwrap();
        let service = VideoCompositionService::new(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            download.path().to_path_buf(),
            resource.path().to_path_buf(),
        )
        .unwrap();
        assert!(service.has_builtin_engine());
        assert_eq!(
            service.ffmpeg_binary(),
            builtin.join(VideoCompositionService::ffmpeg_binary_name())
        );
        assert_eq!(
            service.ffprobe_binary(),
            builtin.join(VideoCompositionService::ffprobe_binary_name())
        );
        assert_eq!(
            service.engine_status().binary_path,
            Some(builtin.join(VideoCompositionService::ffmpeg_binary_name()).to_string_lossy().into_owned())
        );
    }

    #[test]
    fn builtin_missing_or_partial_falls_back_to_download_dir() {
        let resource = tempfile::tempdir().unwrap();
        let download = tempfile::tempdir().unwrap();
        let service = VideoCompositionService::new(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            download.path().to_path_buf(),
            resource.path().to_path_buf(),
        )
        .unwrap();
        assert!(!service.has_builtin_engine());
        assert_eq!(
            service.ffmpeg_binary(),
            download.path().join(VideoCompositionService::ffmpeg_binary_name())
        );
        assert_eq!(
            service.ffprobe_binary(),
            download.path().join(VideoCompositionService::ffprobe_binary_name())
        );

        // 只放 ffmpeg 缺 ffprobe：仍视为不完整，整体回退到下载目录。
        let partial = resource.path().join("ffmpeg");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(
            partial.join(VideoCompositionService::ffmpeg_binary_name()),
            b"fixture",
        )
        .unwrap();
        assert!(!service.has_builtin_engine());
        assert_eq!(
            service.ffmpeg_binary(),
            download.path().join(VideoCompositionService::ffmpeg_binary_name())
        );
    }
}
