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

use regex::Regex;

use super::composer::VideoCompositionService;
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

/// 下载画质路由：按站点与登录态决定请求的画质档位。
///
/// 触发背景：B 站对未登录（无 SESSDATA）用户不开放 480P 以上画质，若后端
/// 一律请求最高画质（`bv*+ba/b`），会因「Requested format is not available」
/// 直接失败。路由规则：
/// - B 站未登录 → `Sd480`：把画质封顶在 480P，保证下载始终成功；
/// - B 站已登录 → `Best`：请求当前账号可用的最高画质；
/// - 其他站点 → 不设置（None），沿用引擎默认行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloadQualityMode {
    Best,
    Sd480,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloaderEngineStatus {
    pub state: VideoDownloaderEngineState,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub cookies_installed: bool,
    /// 已导入的 cookies.txt 是否包含 B 站登录态（SESSDATA）。前端据此提示
    /// B 站下载将走「最高画质」还是「480P」路由。
    pub bilibili_logged_in: bool,
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
    /// 本次任务实际采用的画质路由；非 B 站为 None。
    pub quality_mode: Option<VideoDownloadQualityMode>,
    /// 面向用户的中文画质说明（B 站下载时给出，前端可直接展示）。
    pub quality_hint: Option<String>,
    /// B 站成片下载后是否已自动去除右上角水印（非 B 站恒为 false）。
    pub watermark_removed: bool,
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
    /// 共享的视频合成服务：B 站等平台的音视频为分离 DASH 流，下载后必须用
    /// ffmpeg 合并成片。PATH 上没有 ffmpeg 时复用合成服务自带的 ffmpeg 引擎。
    composer: VideoCompositionService,
    client: reqwest::Client,
}

/// 网络爆款视频下载服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoDownloadService {
    inner: Arc<Inner>,
}

impl VideoDownloadService {
    pub fn new(
        downloads_dir: PathBuf,
        engine_dir: PathBuf,
        composer: VideoCompositionService,
    ) -> BackendResult<Self> {
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
                composer,
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
            bilibili_logged_in: cookies_have_bilibili_login(&self.cookies_path()),
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
            quality_mode: None,
            quality_hint: None,
            watermark_removed: false,
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

        // 2. 组装参数。B 站按登录态做画质路由：未登录封顶 480P（避免请求
        //    未开放画质导致「格式不可用」失败），已登录请求当前账号可用的
        //    最高画质；其他站点沿用引擎默认。B 站等平台的音视频是分离 DASH
        //    流，必须 ffmpeg 合并才能产出可用成片：优先 PATH 上的 ffmpeg，
        //    没有则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载）。
        let cookies_path = self.cookies_path();
        let quality = resolve_download_quality(&url, &cookies_path);
        if let Some(quality) = &quality {
            self.update_record(&job_id, |record| {
                record.quality_mode = Some(quality.mode);
                record.quality_hint = Some(quality.hint.clone());
            });
            tauri_plugin_log::log::info!(
                "[downloader] B 站画质路由: url={url}, mode={:?}, hint={}",
                quality.mode,
                quality.hint
            );
        }
        let ffmpeg_location = resolve_ffmpeg_location(&self.inner.composer).await;
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
        // 画质路由对应的格式选择器：Sd480 一律封顶 480P，其余走最佳画质；
        // 有 ffmpeg 时分离音视频合并封装 MP4，并显式指定 ffmpeg 位置。
        let cap_480p = quality.as_ref().is_some_and(|q| q.mode == VideoDownloadQualityMode::Sd480);
        let append_ffmpeg_args = |args: &mut Vec<String>| {
            if let Some(location) = &ffmpeg_location {
                args.extend([
                    "--ffmpeg-location".into(),
                    location.to_string_lossy().into_owned(),
                ]);
            }
        };
        if cap_480p {
            if ffmpeg_location.is_some() {
                args.extend([
                    "-f".into(),
                    "bv*[height<=480]+ba/b[height<=480]/b".into(),
                    "--merge-output-format".into(),
                    "mp4".into(),
                ]);
                append_ffmpeg_args(&mut args);
            } else {
                args.extend(["-f".into(), "b[height<=480]/b".into()]);
            }
        } else if ffmpeg_location.is_some() {
            args.extend([
                "-f".into(),
                "bv*+ba/b".into(),
                "--merge-output-format".into(),
                "mp4".into(),
            ]);
            append_ffmpeg_args(&mut args);
        } else {
            args.extend(["-f".into(), "b".into()]);
        }
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
                        // B 站成片右上角通常带「UP 主名 + bilibili」静态水印，
                        // 下载成功后自动用 delogo 去除并输出「（去水印）」副片；
                        // 后处理失败（如 ffmpeg 不可用）时保留原片，不阻断任务。
                        let (mut final_path, mut watermark_removed) = (path, false);
                        // quality 仅对 B 站链接为 Some，直接复用该判定。
                        if quality.is_some() {
                            match post_process_bilibili_watermark(
                                Path::new(&final_path),
                                &self.inner.composer,
                            )
                            .await
                            {
                                Ok(clean_path) => {
                                    final_path = clean_path.to_string_lossy().into_owned();
                                    watermark_removed = true;
                                    tauri_plugin_log::log::info!(
                                        "[downloader] B 站去水印完成: {}",
                                        final_path
                                    );
                                }
                                Err(error) => {
                                    tauri_plugin_log::log::warn!(
                                        "[downloader] B 站去水印跳过（保留原片）: {error}"
                                    );
                                }
                            }
                        }
                        let file_name = Path::new(&final_path)
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned());
                        self.update_record(&job_id, |record| {
                            record.status = VideoDownloadStatus::Completed;
                            record.progress = Some(100.0);
                            record.final_path = Some(final_path);
                            record.file_name = file_name;
                            record.watermark_removed = watermark_removed;
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

/// 是否为 B 站链接（含 b23.tv 短链）。
fn is_bilibili_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("bilibili.com") || lower.contains("b23.tv")
}

/// 已导入的 cookies.txt 是否包含 B 站登录态。B 站以 SESSDATA 作为登录凭据，
/// 只有匿名访客 Cookie（buvid3 / b_nut 等）不视为已登录。
fn cookies_have_bilibili_login(cookies_path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(cookies_path) else {
        return false;
    };
    content.lines().any(|line| {
        if line.trim_start().starts_with('#') {
            return false;
        }
        // Netscape cookies 格式：domain / includeSubdomains / path / secure /
        // expiry / name / value，共 7 列。
        let fields: Vec<&str> = line.split('\t').collect();
        fields.len() >= 7
            && fields[5] == "SESSDATA"
            && fields[0].to_ascii_lowercase().contains("bilibili.com")
    })
}

/// B 站画质路由决策：返回本次下载的画质档位与面向用户的中文说明。
/// 非 B 站链接返回 None（沿用引擎默认行为）。
struct DownloadQuality {
    mode: VideoDownloadQualityMode,
    hint: String,
}

fn resolve_download_quality(url: &str, cookies_path: &Path) -> Option<DownloadQuality> {
    if !is_bilibili_url(url) {
        return None;
    }
    if cookies_have_bilibili_login(cookies_path) {
        Some(DownloadQuality {
            mode: VideoDownloadQualityMode::Best,
            hint: "已登录 B 站：将下载当前账号可用的最高画质。".to_string(),
        })
    } else {
        Some(DownloadQuality {
            mode: VideoDownloadQualityMode::Sd480,
            hint: "未登录 B 站：将自动下载 480P 画质；导入含登录态的 Cookies 可下载最高画质。"
                .to_string(),
        })
    }
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

/// 解析本次下载可用的 ffmpeg 位置：
/// - PATH 上已存在 `ffmpeg` → 返回 `None`（yt-dlp 会自动找到，无需额外指定）；
/// - 否则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载一次），返回其
///   所在目录，供 `--ffmpeg-location` 使用；下载失败返回 `None`。
async fn resolve_ffmpeg_location(composer: &VideoCompositionService) -> Option<PathBuf> {
    if probe_ffmpeg().await {
        return None;
    }
    composer
        .ensure_ffmpeg()
        .await
        .ok()
        .and_then(|binary| binary.parent().map(Path::to_path_buf))
}

// ---------- B 站去水印后处理 ----------

/// B 站右上角水印的 delogo 区域（占画面宽/高的比例）。
///
/// 来自 1080×1920 竖屏实测：水印位于 x:724-1046 / y:36-97，换算为比例
/// x≈0.648·W、y≈0.010·H、w≈0.343·W、h≈0.049·H。delogo 只接受像素值，
/// 运行时按目标视频分辨率换算，因此横竖屏、不同分辨率都能套用。
const BILIBILI_DELOGO_X_RATIO: f64 = 0.648;
const BILIBILI_DELOGO_Y_RATIO: f64 = 0.0104;
const BILIBILI_DELOGO_W_RATIO: f64 = 0.343;
const BILIBILI_DELOGO_H_RATIO: f64 = 0.0495;

/// 把 B 站右上角水印比例换算为 delogo 的像素区域（x, y, w, h），
/// 并保证区域完全落在画面内。
fn bilibili_delogo_box(width: u32, height: u32) -> (u32, u32, u32, u32) {
    let round = |value: f64| value.round() as u32;
    let x = round(width as f64 * BILIBILI_DELOGO_X_RATIO);
    let y = round(height as f64 * BILIBILI_DELOGO_Y_RATIO);
    let w = round(width as f64 * BILIBILI_DELOGO_W_RATIO);
    let h = round(height as f64 * BILIBILI_DELOGO_H_RATIO);
    let w = w.min(width.saturating_sub(x)).max(1);
    let h = h.min(height.saturating_sub(y)).max(1);
    let x = x.min(width.saturating_sub(w));
    let y = y.min(height.saturating_sub(h));
    (x, y, w, h)
}

/// 从 `ffmpeg -i` 的流信息文本中解析首个视频流分辨率（如 1080x1920）。
/// 只认「Video: … WxH」中两位以上数字的 WxH，避开编码标签里的 0x 十六进制串。
fn parse_video_dimensions(text: &str) -> Option<(u32, u32)> {
    let re = Regex::new(r"Video:.*?(\d{2,5})x(\d{2,5})").ok()?;
    let captures = re.captures(text)?;
    let width = captures.get(1)?.as_str().parse().ok()?;
    let height = captures.get(2)?.as_str().parse().ok()?;
    Some((width, height))
}

/// 用 `ffmpeg -i` 探测视频分辨率（流信息打印在 stderr）。
async fn probe_video_dimensions(ffmpeg: &Path, source: &Path) -> Option<(u32, u32)> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command.arg("-i").arg(source).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().await.ok()?;
    parse_video_dimensions(&String::from_utf8_lossy(&output.stderr))
}

/// 解析本次后处理可用的 ffmpeg 可执行文件：
/// - PATH 上已有 `ffmpeg` → 直接使用命令名；
/// - 否则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载）返回二进制路径；
/// - 均不可用时返回 None（去水印等后处理跳过，不影响下载结果）。
async fn resolve_ffmpeg_binary(composer: &VideoCompositionService) -> Option<PathBuf> {
    if probe_ffmpeg().await {
        return Some(PathBuf::from("ffmpeg"));
    }
    composer.ensure_ffmpeg().await.ok()
}

/// 生成与源文件同目录、同扩展名、带指定后缀的路径。
/// 例：`标题 [BVxxx].mp4` + `（去水印）` → `标题 [BVxxx]（去水印）.mp4`。
fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = path.extension().map(|ext| ext.to_string_lossy().into_owned());
    let file_name = match extension {
        Some(extension) => format!("{stem}{suffix}.{extension}"),
        None => format!("{stem}{suffix}"),
    };
    path.with_file_name(file_name)
}

/// B 站下载成功后自动去除右上角水印：
/// 1. 探测成片分辨率，把实测比例换算成 delogo 像素区域；
/// 2. delogo 用周边像素插值填补水印区域，视频流重编码为 H.264
///    （兼容性最好），音频直接复制；
/// 3. 输出同目录「（去水印）」副片，不覆盖原片；任一步失败返回错误，
///    由调用方保留原片、不阻断下载任务。
async fn post_process_bilibili_watermark(
    source: &Path,
    composer: &VideoCompositionService,
) -> BackendResult<PathBuf> {
    let ffmpeg = resolve_ffmpeg_binary(composer).await.ok_or_else(|| {
        BackendError::protocol("ffmpeg 不可用，跳过去水印", Value::Null)
    })?;
    let (width, height) = probe_video_dimensions(&ffmpeg, source)
        .await
        .ok_or_else(|| BackendError::protocol("无法探测视频分辨率，跳过去水印", Value::Null))?;
    let (x, y, w, h) = bilibili_delogo_box(width, height);
    let filter = format!("delogo=x={x}:y={y}:w={w}:h={h}");
    let output = sibling_with_suffix(source, "（去水印）");
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-i")
        .arg(source)
        .args(["-vf", filter.as_str()])
        .args([
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "19",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            "-movflags", "+faststart",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let result = command.output().await?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(BackendError::protocol(
            "ffmpeg delogo 处理失败",
            serde_json::json!({
                "exitCode": result.status.code(),
                "stderr": String::from_utf8_lossy(&result.stderr).trim(),
            }),
        ));
    }
    if !output.is_file() {
        return Err(BackendError::protocol(
            "去水印未生成输出文件",
            Value::Null,
        ));
    }
    Ok(output)
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
    let combined_lower = combined.to_lowercase();
    if combined_lower.contains("requested format is not available") {
        message.push_str(
            "提示：B 站等平台音视频为分离流，需 ffmpeg 合并成片；若仍未合并成功，请更新引擎后重试。",
        );
    }
    if combined_lower.contains("cookie") {
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

    #[test]
    fn is_bilibili_url_detects_host_and_short_link() {
        assert!(is_bilibili_url("https://www.bilibili.com/video/BV155j96nE27/"));
        assert!(is_bilibili_url("https://b23.tv/AbCdEf"));
        assert!(is_bilibili_url("https://BILIBILI.COM/video/BV1/"));
        assert!(!is_bilibili_url("https://v.douyin.com/iAbCdEf/"));
        assert!(!is_bilibili_url("https://www.youtube.com/watch?v=x"));
    }

    #[test]
    fn cookies_have_bilibili_login_requires_sessdata() {
        let dir = std::env::temp_dir().join(format!("dl-cookie-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cookies.txt");
        std::fs::write(
            &path,
            "# Netscape HTTP Cookie File\n\
             .bilibili.com\tTRUE\t/\tFALSE\t0\tbuvid3\tAE6A2407-abc\n\
             .bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc123\n",
        )
        .unwrap();
        assert!(cookies_have_bilibili_login(&path));
        // 只有匿名访客 Cookie 不算已登录。
        std::fs::write(
            &path,
            ".bilibili.com\tTRUE\t/\tFALSE\t0\tbuvid3\tAE6A2407-abc\n",
        )
        .unwrap();
        assert!(!cookies_have_bilibili_login(&path));
        // 缺失文件视为未登录。
        assert!(!cookies_have_bilibili_login(&dir.join("missing.txt")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_download_quality_routes_bilibili_by_login() {
        let dir = std::env::temp_dir().join(format!("dl-quality-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let logged_in = dir.join("cookies.txt");
        std::fs::write(
            &logged_in,
            ".bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc\n",
        )
        .unwrap();

        // B 站未登录 → 480P。
        let guest = resolve_download_quality(
            "https://www.bilibili.com/video/BV1YE6gBHEoN/",
            &dir.join("none.txt"),
        )
        .unwrap();
        assert_eq!(guest.mode, VideoDownloadQualityMode::Sd480);
        assert!(guest.hint.contains("480P"));

        // B 站已登录 → 最高画质。
        let logged = resolve_download_quality(
            "https://www.bilibili.com/video/BV1YE6gBHEoN/",
            &logged_in,
        )
        .unwrap();
        assert_eq!(logged.mode, VideoDownloadQualityMode::Best);

        // 非 B 站 → 无路由。
        assert!(resolve_download_quality(
            "https://v.douyin.com/iAbCdEf/",
            &dir.join("none.txt"),
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bilibili_delogo_box_scales_by_resolution() {
        // 1080×1920 竖屏实测基准：x=700, y=20, w=370, h=95。
        assert_eq!(bilibili_delogo_box(1080, 1920), (700, 20, 370, 95));
        // 横屏按比例换算，区域仍落在画面内。
        let (x, y, w, h) = bilibili_delogo_box(1920, 1080);
        assert!(x + w <= 1920);
        assert!(y + h <= 1080);
        // 极小分辨率下至少保留 1px 区域，不越界。
        let (x, y, w, h) = bilibili_delogo_box(100, 100);
        assert!(w >= 1 && h >= 1);
        assert!(x + w <= 100 && y + h <= 100);
    }

    #[test]
    fn parse_video_dimensions_reads_ffmpeg_stream_line() {
        let sample = "\
ffmpeg version n7.1 Copyright (c) 2000-2025 the FFmpeg developers
  Stream #0:0[0x1](und): Video: av1 (libaom-av1) (Main) (av01 / 0x31307661), \
yuv420p(tv, bt709), 1080x1920 [SAR 1:1 DAR 9:16], 1014 kb/s, 30 fps";
        assert_eq!(parse_video_dimensions(sample), Some((1080, 1920)));
        assert_eq!(
            parse_video_dimensions("Stream #0:0: Video: h264, yuv420p, 1920x1080, 60 fps"),
            Some((1920, 1080))
        );
        // 编码标签里的 0x 十六进制串不应被误当成分辨率。
        assert_eq!(
            parse_video_dimensions("Video: hevc (hevc / 0x31637661), 3840x2160"),
            Some((3840, 2160))
        );
        // 无视频流信息 → None。
        assert_eq!(parse_video_dimensions("no stream information here"), None);
    }

    #[test]
    fn sibling_with_suffix_keeps_directory_and_extension() {
        let path = Path::new(r"C:\下载\无限画布\标题 [BV1abc].mp4");
        let clean = sibling_with_suffix(path, "（去水印）");
        assert_eq!(
            clean.to_string_lossy(),
            r"C:\下载\无限画布\标题 [BV1abc]（去水印）.mp4"
        );
        // 无扩展名时后缀直接拼接。
        let no_ext = Path::new(r"C:\下载\clip");
        assert_eq!(sibling_with_suffix(no_ext, "（去水印）").to_string_lossy(), r"C:\下载\clip（去水印）");
    }
}
