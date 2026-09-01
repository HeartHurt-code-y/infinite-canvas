//! 网络爆款视频下载：内置 yt-dlp 引擎的本地下载服务。
//!
//! 引擎策略：后端在首次下载（或用户手动触发）时，把官方独立构建的 yt-dlp
//! 二进制下载到应用数据目录并校验官方 SHA-256，此后所有下载都通过该引擎执行。
//! 锁定版本必须包含可用的抖音（douyin.com）提取器；抖音风控变化频繁，同时
//! 提供「更新引擎」命令拉取最新稳定版，保证提取器能持续跟上站点改动。
//!
//! 下载产物与生成结果、合成产物一致，落在系统下载目录的「无限画布」子目录。
//! 任务记录只保存在内存中（与画布上的合成节点运行状态一致），产物卡片本身
//! 随画布文档持久化。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use super::error::{BackendError, BackendResult};

/// 内置引擎锁定的 yt-dlp 版本（官方 latest release，含 DouyinIE 提取器）。
pub const YT_DLP_VERSION: &str = "2026.08.19";

/// GitHub API 需要显式 User-Agent，且下载源固定为官方 release。
const YT_DLP_RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const YT_DLP_LATEST_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOAD_USER_AGENT: &str = "infinite-canvas-video-downloader";

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 平台对应的官方独立构建产物名与锁定版本的 SHA-256（来自官方 SHA2-256SUMS）。
fn engine_artifact() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        (
            "yt-dlp.exe",
            "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
        )
    } else if cfg!(target_os = "macos") {
        (
            "yt-dlp_macos",
            "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202",
        )
    } else {
        (
            "yt-dlp_linux",
            "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a",
        )
    }
}

fn engine_binary_file_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloadStatus {
    /// 正在获取/更新 yt-dlp 引擎（首次使用或引擎缺失时）。
    PreparingEngine,
    Downloading,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloaderEngineState {
    NotInstalled,
    Installing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloaderEngineStatus {
    pub state: VideoDownloaderEngineState,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub cookies_installed: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadJobRecord {
    pub job_id: String,
    pub url: String,
    pub status: VideoDownloadStatus,
    /// 0-100；引擎准备阶段为 None。
    pub progress: Option<f64>,
    pub final_path: Option<String>,
    pub file_name: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

struct JobEntry {
    record: VideoDownloadJobRecord,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
struct EngineRuntime {
    installing: bool,
    last_error: Option<String>,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, JobEntry>>,
    engine: std::sync::Mutex<EngineRuntime>,
    /// 串行化引擎安装/更新，避免并发重复下载二进制。
    engine_lock: AsyncMutex<()>,
    downloads_dir: PathBuf,
    engine_dir: PathBuf,
    client: reqwest::Client,
}

/// 网络爆款视频下载服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoDownloadService {
    inner: Arc<Inner>,
}

impl VideoDownloadService {
    pub fn new(downloads_dir: PathBuf, engine_dir: PathBuf) -> BackendResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent(DOWNLOAD_USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()?;
        Ok(Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                engine: std::sync::Mutex::new(EngineRuntime::default()),
                engine_lock: AsyncMutex::new(()),
                downloads_dir,
                engine_dir,
                client,
            }),
        })
    }

    // ---------- 引擎管理 ----------

    fn binary_path(&self) -> PathBuf {
        self.inner.engine_dir.join(engine_binary_file_name())
    }

    fn cookies_path(&self) -> PathBuf {
        self.inner.engine_dir.join("cookies.txt")
    }

    fn installed_version(&self) -> Option<String> {
        std::fs::read_to_string(self.inner.engine_dir.join("version.txt"))
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    }

    /// 汇总当前引擎状态。版本以 version.txt 为准（更新后与锁定版本不同）。
    pub fn engine_status(&self) -> VideoDownloaderEngineStatus {
        let binary_exists = self.binary_path().is_file();
        let runtime = self.inner.engine.lock().expect("engine runtime poisoned");
        let state = if runtime.installing {
            VideoDownloaderEngineState::Installing
        } else if binary_exists {
            VideoDownloaderEngineState::Ready
        } else if runtime.last_error.is_some() {
            VideoDownloaderEngineState::Failed
        } else {
            VideoDownloaderEngineState::NotInstalled
        };
        VideoDownloaderEngineStatus {
            state,
            version: binary_exists.then(|| {
                self.installed_version()
                    .unwrap_or_else(|| YT_DLP_VERSION.to_string())
            }),
            binary_path: binary_exists.then(|| self.binary_path().to_string_lossy().into_owned()),
            cookies_installed: self.cookies_path().is_file(),
            last_error: runtime.last_error.clone(),
        }
    }

    /// 安装（或补装）锁定版本的引擎；已就绪时直接返回当前状态。
    pub async fn install_engine(&self) -> VideoDownloaderEngineStatus {
        self.run_engine_install(|| async { Ok(YT_DLP_VERSION.to_string()) })
            .await
    }

    /// 拉取最新稳定版引擎。抖音等站点的提取器修复随新版本发布，用兜底升级
    /// 保持引擎可用。已是最新且二进制存在时为无操作。
    pub async fn update_engine(&self) -> VideoDownloaderEngineStatus {
        self.run_engine_install(|| async {
            let response = self
                .inner
                .client
                .get(YT_DLP_LATEST_API)
                .send()
                .await?
                .error_for_status()?;
            let payload: Value = response.json().await?;
            let tag = payload
                .get("tag_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "yt-dlp latest release response has no tag_name",
                        Value::Null,
                    )
                })?;
            Ok(tag.to_string())
        })
        .await
    }

    async fn run_engine_install<F, Fut>(&self, resolve_version: F) -> VideoDownloaderEngineStatus
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = BackendResult<String>>,
    {
        {
            let mut runtime = self.inner.engine.lock().expect("engine runtime poisoned");
            if runtime.installing {
                return self.engine_status();
            }
            runtime.installing = true;
            runtime.last_error = None;
        }
        let install_result: BackendResult<String> = async {
            let _guard = self.inner.engine_lock.lock().await;
            let version = resolve_version().await?;
            let binary_path = self.binary_path();
            if version == YT_DLP_VERSION && binary_path.is_file() {
                return Ok(version);
            }
            self.install_engine_version(&version).await?;
            Ok(version)
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
            tauri_plugin_log::log::error!("[downloader] yt-dlp 引擎安装/更新失败: {error}");
        }
        self.engine_status()
    }

    /// 下载指定版本的官方独立构建并校验 SHA-256；锁定版本使用内嵌哈希，
    /// 其他版本实时读取该 release 的官方 SHA2-256SUMS。
    async fn install_engine_version(&self, version: &str) -> BackendResult<()> {
        let (artifact, embedded_sha) = engine_artifact();
        tokio::fs::create_dir_all(&self.inner.engine_dir).await?;
        let binary_path = self.binary_path();
        let temp_path = self.inner.engine_dir.join(format!("{artifact}.download"));
        let expected_sha = if version == YT_DLP_VERSION {
            embedded_sha.to_string()
        } else {
            self.fetch_release_checksum(version, artifact).await?
        };

        let url = format!("{YT_DLP_RELEASE_BASE}/{version}/{artifact}");
        let response = self
            .inner
            .client
            .get(&url)
            .send()
            .await?
            .error_for_status()?;
        let mut file = tokio::fs::File::create(&temp_path).await?;
        let mut hasher = Sha256::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);

        let actual_sha = hex::encode(hasher.finalize());
        if actual_sha != expected_sha {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(BackendError::protocol(
                "downloaded yt-dlp engine failed SHA-256 verification",
                serde_json::json!({
                    "version": version,
                    "artifact": artifact,
                    "expectedSha256": expected_sha,
                    "actualSha256": actual_sha,
                }),
            ));
        }

        // Windows 上 rename 无法覆盖已存在的文件（引擎更新场景），先移除旧二进制。
        if tokio::fs::try_exists(&binary_path).await? {
            let _ = tokio::fs::remove_file(&binary_path).await;
        }
        tokio::fs::rename(&temp_path, &binary_path).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            tokio::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
                .await?;
        }
        tokio::fs::write(self.inner.engine_dir.join("version.txt"), version).await?;

        // 完整性校验通过后仍要求引擎能真实执行（拦截杀毒软件隔离、平台不匹配等）。
        let reported = self.probe_binary_version(&binary_path).await?;
        tauri_plugin_log::log::info!(
            "[downloader] yt-dlp 引擎就绪: version={version}, 引擎自报版本={reported}"
        );
        Ok(())
    }

    async fn fetch_release_checksum(&self, version: &str, artifact: &str) -> BackendResult<String> {
        let url = format!("{YT_DLP_RELEASE_BASE}/{version}/SHA2-256SUMS");
        let response = self
            .inner
            .client
            .get(&url)
            .send()
            .await?
            .error_for_status()?;
        let text = response.text().await?;
        checksum_line_for(&text, artifact).ok_or_else(|| {
            BackendError::protocol(
                "yt-dlp release checksum file does not contain the platform artifact",
                serde_json::json!({ "version": version, "artifact": artifact }),
            )
        })
    }

    async fn probe_binary_version(&self, binary: &Path) -> BackendResult<String> {
        let mut command = tokio::process::Command::new(binary);
        command.arg("--version").stdin(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().await?;
        if !output.status.success() {
            return Err(BackendError::protocol(
                "yt-dlp engine binary is not executable",
                serde_json::json!({
                    "exitCode": output.status.code(),
                    "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                }),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    // ---------- Cookies ----------

    /// 导入浏览器导出的 cookies.txt。抖音要求较新的匿名 Cookies（无需登录），
    /// 引擎目录存在 cookies.txt 时所有下载自动携带。
    pub fn import_cookies(&self, source: &Path) -> BackendResult<VideoDownloaderEngineStatus> {
        let metadata = std::fs::metadata(source).map_err(|error| {
            BackendError::validation(
                "cookies 文件不存在或不可读",
                serde_json::json!({ "source": source.to_string_lossy(), "error": error.to_string() }),
            )
        })?;
        if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
            return Err(BackendError::validation(
                "cookies 文件为空或超过 2MB，请重新从浏览器扩展导出",
                serde_json::json!({ "byteSize": metadata.len() }),
            ));
        }
        std::fs::create_dir_all(&self.inner.engine_dir)?;
        std::fs::copy(source, self.cookies_path()).map_err(|error| {
            BackendError::Io(std::io::Error::new(
                error.kind(),
                format!("cookies 写入失败: {error}"),
            ))
        })?;
        Ok(self.engine_status())
    }

    pub fn clear_cookies(&self) -> BackendResult<VideoDownloaderEngineStatus> {
        match std::fs::remove_file(self.cookies_path()) {
            Ok(()) => {}
            // 文件本就不存在时视为清除成功。
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(BackendError::Io(error)),
        }
        Ok(self.engine_status())
    }

    // ---------- 下载任务 ----------

    /// 创建并启动一个下载任务。任务记录保存在内存中，前端轮询进度。
    pub fn start_download(&self, url: &str) -> BackendResult<VideoDownloadJobRecord> {
        let url = normalize_download_url(url)?;
        let job_id = format!("download-{}", Uuid::new_v4());
        let now = now_ms();
        let record = VideoDownloadJobRecord {
            job_id: job_id.clone(),
            url: url.clone(),
            status: VideoDownloadStatus::PreparingEngine,
            progress: None,
            final_path: None,
            file_name: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        {
            let mut jobs = self.inner.jobs.lock().expect("download jobs poisoned");
            retain_recent_jobs(&mut jobs);
            jobs.insert(
                job_id.clone(),
                JobEntry {
                    record: record.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.run_download(job_id, url).await;
        });
        Ok(record)
    }

    pub fn get_job(&self, job_id: &str) -> BackendResult<VideoDownloadJobRecord> {
        let jobs = self.inner.jobs.lock().expect("download jobs poisoned");
        jobs.get(job_id)
            .map(|entry| entry.record.clone())
            .ok_or_else(|| BackendError::NotFound(format!("download job {job_id}")))
    }

    /// 请求取消。run_download 在轮询窗口内感知标记并终止子进程。
    pub fn cancel_job(&self, job_id: &str) -> BackendResult<VideoDownloadJobRecord> {
        let mut jobs = self.inner.jobs.lock().expect("download jobs poisoned");
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| BackendError::NotFound(format!("download job {job_id}")))?;
        if matches!(
            entry.record.status,
            VideoDownloadStatus::PreparingEngine | VideoDownloadStatus::Downloading
        ) {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry.record.status = VideoDownloadStatus::Cancelled;
            entry.record.updated_at = now_ms();
        }
        Ok(entry.record.clone())
    }

    fn update_record(&self, job_id: &str, mutate: impl FnOnce(&mut VideoDownloadJobRecord)) {
        let mut jobs = self.inner.jobs.lock().expect("download jobs poisoned");
        if let Some(entry) = jobs.get_mut(job_id) {
            mutate(&mut entry.record);
            entry.record.updated_at = now_ms();
        }
    }

    fn set_progress(&self, job_id: &str, percent: f64) {
        self.update_record(job_id, |record| {
            let percent = percent.clamp(0.0, 100.0);
            // 进度只进不退：yt-dlp 分段（视频+音频）时百分比会回跳。
            record.progress = Some(
                record
                    .progress
                    .map_or(percent, |current| current.max(percent)),
            );
        });
    }

    fn fail_job(&self, job_id: &str, message: String) {
        self.update_record(job_id, |record| {
            record.status = VideoDownloadStatus::Failed;
            record.error = Some(message);
        });
    }

    async fn run_download(&self, job_id: String, url: String) {
        // 1. 确保引擎就绪（缺失时自动下载锁定版本）。
        let binary = match self.ensure_engine().await {
            Ok(binary) => binary,
            Err(error) => {
                self.fail_job(&job_id, format!("下载引擎准备失败：{error}"));
                return;
            }
        };
        if self.is_cancelled(&job_id) {
            return;
        }
        self.update_record(&job_id, |record| {
            record.status = VideoDownloadStatus::Downloading;
        });

        // 2. 组装参数。系统有 ffmpeg 时合并最佳画质+音质并封装 MP4；
        //    没有时退回单一最佳封装格式（抖音通常本身就是完整 MP4）。
        let has_ffmpeg = probe_ffmpeg().await;
        let directory = self.inner.downloads_dir.join("无限画布");
        if let Err(error) = tokio::fs::create_dir_all(&directory).await {
            self.fail_job(&job_id, format!("下载目录创建失败：{error}"));
            return;
        }
        let output_template = directory.join("%(title)s [%(id)s].%(ext)s");
        let mut args: Vec<String> = vec![
            "--newline".into(),
            "--no-quiet".into(),
            "--no-simulate".into(),
            "--print".into(),
            "after_move:filepath".into(),
            "--no-playlist".into(),
            "--trim-filenames".into(),
            "120".into(),
            "-o".into(),
            output_template.to_string_lossy().into_owned(),
        ];
        if has_ffmpeg {
            args.extend([
                "-f".into(),
                "bv*+ba/b".into(),
                "--merge-output-format".into(),
                "mp4".into(),
            ]);
        } else {
            args.extend(["-f".into(), "b".into()]);
        }
        let cookies_path = self.cookies_path();
        if cookies_path.is_file() {
            args.extend([
                "--cookies".into(),
                cookies_path.to_string_lossy().into_owned(),
            ]);
        }
        args.push(url);

        // 3. 启动引擎子进程。
        let mut command = tokio::process::Command::new(&binary);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.fail_job(&job_id, format!("下载引擎启动失败：{error}"));
                return;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // 4. 并行读取输出：stdout 收最终文件路径，stderr 解析进度并保留错误尾部。
        let path_task = tauri::async_runtime::spawn(collect_final_path(stdout));
        let progress_service = self.clone();
        let progress_job_id = job_id.clone();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut tail: VecDeque<String> = VecDeque::new();
            let Some(stderr) = stderr else {
                return tail;
            };
            use tokio::io::AsyncBufReadExt as _;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(percent) = parse_progress_percent(&line) {
                    progress_service.set_progress(&progress_job_id, percent);
                }
                if tail.len() >= 24 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail
        });

        // 5. 等待退出；取消请求在 200ms 轮询窗口内触发 kill。
        let cancelled = self.cancel_flag(&job_id);
        let wait_result = tokio::select! {
            status = child.wait() => status,
            _ = wait_for_cancel(cancelled) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return;
            }
        };
        let stdout_path = path_task.await.unwrap_or_default();
        let stderr_tail = stderr_task.await.unwrap_or_default();

        match wait_result {
            Ok(status) if status.success() => {
                let final_path = resolve_final_path(&stdout_path, &stderr_tail);
                match final_path {
                    Some(path) if Path::new(&path).is_file() => {
                        let file_name = Path::new(&path)
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned());
                        self.update_record(&job_id, |record| {
                            record.status = VideoDownloadStatus::Completed;
                            record.progress = Some(100.0);
                            record.final_path = Some(path);
                            record.file_name = file_name;
                        });
                    }
                    Some(path) => {
                        self.fail_job(&job_id, format!("引擎报告的输出文件不存在：{path}"));
                    }
                    None => {
                        self.fail_job(&job_id, "下载结束但无法确定输出文件路径。".into());
                    }
                }
            }
            Ok(status) => {
                self.fail_job(&job_id, failure_message(&stderr_tail, &status.to_string()));
            }
            Err(error) => {
                self.fail_job(&job_id, format!("下载进程异常退出：{error}"));
            }
        }
    }

    async fn ensure_engine(&self) -> BackendResult<PathBuf> {
        let binary_path = self.binary_path();
        if binary_path.is_file() {
            return Ok(binary_path);
        }
        self.install_engine().await;
        if binary_path.is_file() {
            return Ok(binary_path);
        }
        let runtime = self.inner.engine.lock().expect("engine runtime poisoned");
        let detail = runtime
            .last_error
            .clone()
            .unwrap_or_else(|| "引擎仍未就绪".to_string());
        Err(BackendError::protocol(
            "yt-dlp engine is not available after install attempt",
            serde_json::json!({ "detail": detail }),
        ))
    }

    fn is_cancelled(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .expect("download jobs poisoned")
            .get(job_id)
            .is_some_and(|entry| entry.cancelled.load(Ordering::Relaxed))
    }

    fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        self.inner
            .jobs
            .lock()
            .expect("download jobs poisoned")
            .get(job_id)
            .map_or_else(
                || Arc::new(AtomicBool::new(false)),
                |entry| entry.cancelled.clone(),
            )
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 校验并规范用户输入的下载地址：提取第一个 http(s) URL（抖音分享口令常
/// 混在一段文案里），其余形式一律拒绝。
fn normalize_download_url(raw: &str) -> BackendResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BackendError::validation(
            "请先粘贴要下载的视频链接",
            Value::Null,
        ));
    }
    if trimmed.len() > 2048 {
        return Err(BackendError::validation(
            "链接过长，请确认粘贴的是视频地址",
            Value::Null,
        ));
    }
    let url = extract_first_url(trimmed).ok_or_else(|| {
        BackendError::validation(
            "未在输入中找到 http(s) 视频链接",
            serde_json::json!({ "input": trimmed }),
        )
    })?;
    Ok(url)
}

/// 从分享文案中提取第一个 http(s) URL；找不到返回 None。
/// 抖音等分享口令常把链接夹在一段文案里，且链接尾部可能紧跟中文标点。
fn extract_first_url(text: &str) -> Option<String> {
    text.split(|character: char| character.is_whitespace() || character == '<' || character == '>')
        .find(|token| is_http_url_prefix(token))
        .map(|token| {
            token
                .trim_end_matches(|character: char| {
                    "。，,;、！!？?）)】]」》\"'“”‘’…·".contains(character)
                })
                .to_string()
        })
}

fn is_http_url_prefix(token: &str) -> bool {
    token
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        || token
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
}

/// 任务记录只保留有限的终态条目，避免长期会话无限增长。
fn retain_recent_jobs(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < 100 {
        return;
    }
    let mut terminal: Vec<(String, i64)> = jobs
        .iter()
        .filter(|(_, entry)| {
            matches!(
                entry.record.status,
                VideoDownloadStatus::Completed
                    | VideoDownloadStatus::Failed
                    | VideoDownloadStatus::Cancelled
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

async fn wait_for_cancel(flag: Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 探测系统 ffmpeg（PATH 上可用即认为可合并音视频流）。
async fn probe_ffmpeg() -> bool {
    let mut command = tokio::process::Command::new("ffmpeg");
    command.arg("-version").stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

/// 解析 `[download]  45.2% of ...` 形式的进度行。
fn parse_progress_percent(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let percent_end = rest.find('%')?;
    rest[..percent_end].trim().parse::<f64>().ok()
}

/// 汇总 stdout 中 `--print after_move:filepath` 的输出（最后一个非空行）。
async fn collect_final_path(stdout: Option<impl tokio::io::AsyncRead + Unpin>) -> Option<String> {
    let stdout = stdout?;
    use tokio::io::AsyncBufReadExt as _;
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut last = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            last = Some(trimmed.to_string());
        }
    }
    last
}

/// 从 stderr 兜底提取最终文件路径（yt-dlp 正常会通过 after_move:filepath
/// 打印；该兜底覆盖 --print 输出缺失的边缘情况）。
fn resolve_final_path(
    stdout_path: &Option<String>,
    stderr_tail: &VecDeque<String>,
) -> Option<String> {
    if let Some(path) = stdout_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return Some(path.to_string());
    }
    for line in stderr_tail.iter().rev() {
        if let Some(path) = extract_already_downloaded(line).or_else(|| extract_merger_path(line)) {
            return Some(path);
        }
    }
    None
}

/// 解析 `[download] <路径> has already been downloaded`。
fn extract_already_downloaded(line: &str) -> Option<String> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let marker = " has already been downloaded";
    let end = rest.find(marker)?;
    let path = rest[..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// 解析 `[Merger] Merging formats into "<路径>"`。
fn extract_merger_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("[Merger]")?.trim_start();
    let marker = "Merging formats into \"";
    let start = rest.find(marker)? + marker.len();
    let remainder = rest.get(start..)?;
    let end = remainder.find('"')?;
    let path = remainder[..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// 组装失败信息：优先给引擎 stderr 尾部（包含 yt-dlp 的真实错误），并附
/// 抖音 Cookies 提示（抖音最常见失败原因就是 Cookies 过期）。
fn failure_message(stderr_tail: &VecDeque<String>, fallback: &str) -> String {
    let relevant: Vec<&str> = stderr_tail
        .iter()
        .map(String::as_str)
        .filter(|line| {
            !line.starts_with("[download]") && !line.is_empty() && !line.starts_with("[Merger]")
        })
        .collect();
    let mut message = if relevant.is_empty() {
        format!("下载失败（{fallback}）。")
    } else {
        let tail: String = relevant
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(|line| format!("{line}\n"))
            .collect();
        format!("下载失败：\n{tail}")
    };
    let combined = stderr_tail.iter().fold(String::new(), |mut acc, line| {
        acc.push_str(line);
        acc
    });
    if combined.to_lowercase().contains("cookie") {
        message.push_str(
            "提示：抖音等站点需要较新的浏览器 Cookies，可在节点内导入 cookies.txt 后重试。",
        );
    }
    message
}

/// 在官方 SHA2-256SUMS 内容中找指定产物的校验值。
fn checksum_line_for(content: &str, artifact: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let checksum = parts.next()?;
        let name = parts.next()?;
        (name == artifact)
            .then(|| checksum.to_lowercase())
            .filter(|checksum| {
                checksum.len() == 64 && checksum.chars().all(|c| c.is_ascii_hexdigit())
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_progress_percent_extracts_download_percentage() {
        assert_eq!(
            parse_progress_percent("[download]   4.6% of    5.83MiB at  821.53KiB/s ETA 00:07"),
            Some(4.6)
        );
        assert_eq!(
            parse_progress_percent("[download] 100.0% of 1.00MiB"),
            Some(100.0)
        );
        assert_eq!(
            parse_progress_percent("[download] Destination: a.mp4"),
            None
        );
        assert_eq!(parse_progress_percent("[Merger] Merging formats"), None);
    }

    #[test]
    fn extract_first_url_picks_url_inside_share_text() {
        let share =
            "8.15 Kfx:/ 复制打开抖音看看【某作者】的作品 https://v.douyin.com/iAbCdEf/ 太搞笑了";
        assert_eq!(
            extract_first_url(share).as_deref(),
            Some("https://v.douyin.com/iAbCdEf/")
        );
        assert_eq!(extract_first_url("纯文本没有链接"), None);
        assert_eq!(
            extract_first_url("http://a.com/x https://b.com/y").as_deref(),
            Some("http://a.com/x")
        );
    }

    #[test]
    fn extract_already_downloaded_parses_existing_file() {
        assert_eq!(
            extract_already_downloaded(
                r"[download] C:\下载\无限画布\标题 [123].mp4 has already been downloaded"
            )
            .as_deref(),
            Some(r"C:\下载\无限画布\标题 [123].mp4")
        );
        assert_eq!(extract_already_downloaded("[download] 50% of 1MiB"), None);
    }

    #[test]
    fn extract_merger_path_parses_quoted_target() {
        assert_eq!(
            extract_merger_path(r#"[Merger] Merging formats into "无限画布/标题 [42].mp4""#)
                .as_deref(),
            Some("无限画布/标题 [42].mp4")
        );
    }

    #[test]
    fn checksum_line_for_matches_platform_artifact() {
        let content = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a  yt-dlp.exe\n\
                       58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a  yt-dlp_linux\n";
        assert_eq!(
            checksum_line_for(content, "yt-dlp.exe").as_deref(),
            Some("66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a")
        );
        assert_eq!(checksum_line_for(content, "yt-dlp_macos"), None);
    }

    #[test]
    fn normalize_download_url_trims_and_extracts() {
        assert_eq!(
            normalize_download_url("  https://v.douyin.com/iAbCdEf/  ").unwrap(),
            "https://v.douyin.com/iAbCdEf/"
        );
        assert!(normalize_download_url("看一看").is_err());
        assert!(normalize_download_url("   ").is_err());
    }
}
