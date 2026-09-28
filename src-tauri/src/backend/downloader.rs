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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use uuid::Uuid;

use regex::Regex;

use super::browser_media::{self, SiteResolver};
use super::composer::VideoCompositionService;
use super::error::{BackendError, BackendResult};
use super::process_tree::ProcessTree;
use super::remotion_renderer::RemotionRenderService;

/// 内置引擎锁定的 yt-dlp 版本（官方 latest release，含 DouyinIE 提取器）。
pub const YT_DLP_VERSION: &str = "2026.08.19";

/// GitHub API 需要显式 User-Agent，且下载源固定为官方 release。
const YT_DLP_RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const YT_DLP_LATEST_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOAD_USER_AGENT: &str = "infinite-canvas-video-downloader";
/// 不读取用户级 yt-dlp 配置：配置中可能有 --cookies 输出路径，若与
/// --cookies-from-browser 同用就会把整个浏览器 CookieJar 导出到磁盘。
const YT_DLP_CONFIG_ISOLATION_ARG: &str = "--ignore-config";
const AUTO_COOKIE_PROBE_TIMEOUT: Duration = Duration::from_secs(45);

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

/// 直接从本机浏览器读取登录态。浏览器名是唯一持久化的设置；Cookie 正文
/// 由 yt-dlp 在每次下载时读取，绝不导出到应用数据目录或返回给前端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCookieBrowser {
    Auto,
    Chrome,
    Edge,
    Firefox,
    Brave,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VideoCookieSource {
    Auto,
    Browser(VideoCookieBrowser),
    ManualFile(PathBuf),
    SiteSession,
    None,
}

impl VideoCookieBrowser {
    fn as_setting_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Firefox => "firefox",
            Self::Brave => "brave",
        }
    }

    fn from_stored(value: &str) -> Option<Self> {
        match value.trim() {
            "auto" => Some(Self::Auto),
            "chrome" => Some(Self::Chrome),
            "edge" => Some(Self::Edge),
            "firefox" => Some(Self::Firefox),
            "brave" => Some(Self::Brave),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloadCredentialSource {
    Chrome,
    Edge,
    Firefox,
    Brave,
    Manual,
    SiteSession,
    None,
}

impl VideoCookieSource {
    fn credential_source(&self) -> Option<VideoDownloadCredentialSource> {
        match self {
            Self::Auto => None,
            Self::Browser(VideoCookieBrowser::Chrome) => {
                Some(VideoDownloadCredentialSource::Chrome)
            }
            Self::Browser(VideoCookieBrowser::Edge) => Some(VideoDownloadCredentialSource::Edge),
            Self::Browser(VideoCookieBrowser::Firefox) => {
                Some(VideoDownloadCredentialSource::Firefox)
            }
            Self::Browser(VideoCookieBrowser::Brave) => Some(VideoDownloadCredentialSource::Brave),
            Self::Browser(VideoCookieBrowser::Auto) => None,
            Self::ManualFile(_) => Some(VideoDownloadCredentialSource::Manual),
            Self::SiteSession => Some(VideoDownloadCredentialSource::SiteSession),
            Self::None => Some(VideoDownloadCredentialSource::None),
        }
    }
}

fn read_cookie_browser_setting(engine_dir: &Path) -> Option<VideoCookieBrowser> {
    std::fs::read_to_string(engine_dir.join("cookie-browser.txt"))
        .ok()
        .and_then(|value| VideoCookieBrowser::from_stored(&value))
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
    /// None 表示使用用户导入的 cookies.txt；Some 表示下载时读取对应浏览器。
    pub cookie_browser: Option<VideoCookieBrowser>,
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
    /// 实际下载采用的 Cookie 来源；自动模式筛选期间为 None。
    pub credential_source: Option<VideoDownloadCredentialSource>,
    /// 自动来源预检进度；预检结束后清除，不代表真实文件已下载。
    pub probe_status: Option<String>,
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
    cookie_browser: std::sync::Mutex<Option<VideoCookieBrowser>>,
    /// 串行化引擎安装/更新，避免并发重复下载二进制。
    engine_lock: AsyncMutex<()>,
    site_resolver_slots: Semaphore,
    downloads_dir: PathBuf,
    engine_dir: PathBuf,
    /// 共享的视频合成服务：B 站等平台的音视频为分离 DASH 流，下载后必须用
    /// ffmpeg 合并成片。PATH 上没有 ffmpeg 时复用合成服务自带的 ffmpeg 引擎。
    composer: VideoCompositionService,
    browser_runtime: Option<RemotionRenderService>,
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
        Self::new_with_browser_runtime(downloads_dir, engine_dir, composer, None)
    }

    pub(crate) fn new_with_browser_runtime(
        downloads_dir: PathBuf,
        engine_dir: PathBuf,
        composer: VideoCompositionService,
        browser_runtime: Option<RemotionRenderService>,
    ) -> BackendResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent(DOWNLOAD_USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()?;
        let cookie_browser = read_cookie_browser_setting(&engine_dir);
        Ok(Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                engine: std::sync::Mutex::new(EngineRuntime::default()),
                cookie_browser: std::sync::Mutex::new(cookie_browser),
                engine_lock: AsyncMutex::new(()),
                site_resolver_slots: Semaphore::new(2),
                downloads_dir,
                engine_dir,
                composer,
                browser_runtime,
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

    fn cookie_browser_path(&self) -> PathBuf {
        self.inner.engine_dir.join("cookie-browser.txt")
    }

    fn cookie_browser(&self) -> Option<VideoCookieBrowser> {
        *self
            .inner
            .cookie_browser
            .lock()
            .expect("cookie browser setting poisoned")
    }

    fn cookie_source(&self) -> VideoCookieSource {
        if let Some(browser) = self.cookie_browser() {
            if browser == VideoCookieBrowser::Auto {
                VideoCookieSource::Auto
            } else {
                VideoCookieSource::Browser(browser)
            }
        } else {
            let path = self.cookies_path();
            if path.is_file() {
                VideoCookieSource::ManualFile(path)
            } else {
                VideoCookieSource::None
            }
        }
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
            cookie_browser: self.cookie_browser(),
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
        let contents = std::fs::read_to_string(source).map_err(|error| {
            BackendError::Io(std::io::Error::new(
                error.kind(),
                format!("cookies 读取失败: {error}"),
            ))
        })?;
        // Build a private replacement first. A pre-existing import may have
        // explicit ACL entries that merely disabling inheritance would retain.
        let mut private = tempfile::Builder::new()
            .prefix("infinite-canvas-import-cookies-")
            .suffix(".txt")
            .tempfile_in(&self.inner.engine_dir)?;
        super::credentials::write_private_file(private.path(), &contents)?;
        private.as_file_mut().sync_all()?;
        let private = private.into_temp_path();
        std::fs::rename(private.to_path_buf(), self.cookies_path())?;
        if self.cookie_browser() != Some(VideoCookieBrowser::Auto) {
            self.set_cookie_browser(None)?;
        }
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

    /// 在浏览器现读与手动 cookies.txt 之间切换。仅存储非敏感浏览器名称；
    /// 已导入的文件留在本机以便切回手动模式时使用。
    pub fn set_cookie_browser(
        &self,
        browser: Option<VideoCookieBrowser>,
    ) -> BackendResult<VideoDownloaderEngineStatus> {
        let mut selected = self
            .inner
            .cookie_browser
            .lock()
            .expect("cookie browser setting poisoned");
        let setting_path = self.cookie_browser_path();
        match browser {
            Some(browser) => {
                std::fs::create_dir_all(&self.inner.engine_dir)?;
                std::fs::write(setting_path, browser.as_setting_value())?;
            }
            None => match std::fs::remove_file(setting_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(BackendError::Io(error)),
            },
        }
        *selected = browser;
        drop(selected);
        Ok(self.engine_status())
    }

    // ---------- 下载任务 ----------

    /// 创建并启动一个下载任务。任务记录保存在内存中，前端轮询进度。
    pub fn start_download(&self, url: &str) -> BackendResult<VideoDownloadJobRecord> {
        let url = normalize_download_url(url)?;
        // 队列创建时固定来源，之后切换浏览器不影响已经排队的任务。
        let cookie_source = self.cookie_source();
        let job_id = format!("download-{}", Uuid::new_v4());
        let now = now_ms();
        let record = VideoDownloadJobRecord {
            job_id: job_id.clone(),
            url: url.clone(),
            status: VideoDownloadStatus::PreparingEngine,
            progress: None,
            final_path: None,
            file_name: None,
            credential_source: cookie_source.credential_source(),
            probe_status: None,
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
            service.run_download(job_id, url, cookie_source).await;
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
            entry.record.probe_status = None;
            entry.record.updated_at = now_ms();
        }
        Ok(entry.record.clone())
    }

    fn update_record(&self, job_id: &str, mutate: impl FnOnce(&mut VideoDownloadJobRecord)) {
        let mut jobs = self.inner.jobs.lock().expect("download jobs poisoned");
        if let Some(entry) = jobs.get_mut(job_id) {
            if entry.cancelled.load(Ordering::Acquire)
                || entry.record.status == VideoDownloadStatus::Cancelled
            {
                return;
            }
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
        let mut jobs = self.inner.jobs.lock().expect("download jobs poisoned");
        let Some(entry) = jobs.get_mut(job_id) else {
            return;
        };
        if entry.cancelled.load(Ordering::Acquire)
            || matches!(
                entry.record.status,
                VideoDownloadStatus::Cancelled | VideoDownloadStatus::Completed
            )
        {
            return;
        }
        entry.record.status = VideoDownloadStatus::Failed;
        entry.record.error = Some(message);
        entry.record.probe_status = None;
        entry.record.updated_at = now_ms();
    }

    async fn run_download(&self, job_id: String, url: String, cookie_source: VideoCookieSource) {
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

        // 2. 自动来源先进行无成片预检。通过预检不代表已登录，更不代表最终下载成功。
        let ffmpeg = resolve_ffmpeg_for_download(&self.inner.composer).await;
        if self.is_cancelled(&job_id) {
            return;
        }
        // Both sites can return an empty extractor result while their official
        // browser page still exposes the exact video's stream. A user-imported
        // site cookie file may authorize a private page; otherwise the browser
        // uses an isolated public session. CDN URLs are validated separately.
        let mut rednote_video = None;
        let mut douyin_video = None;
        let mut resolved_with_imported_cookies = false;
        let mut auth_private_cookie = None;
        if let Some(runtime) = &self.inner.browser_runtime {
            let site = if super::xiaohongshu::supports_rednote_fallback(&url) {
                Some(SiteResolver::Rednote)
            } else if is_douyin_url(&url) {
                Some(SiteResolver::Douyin)
            } else {
                None
            };
            if let Some(site) = site {
                let imported_path = match &cookie_source {
                    VideoCookieSource::ManualFile(path) => Some(path.clone()),
                    VideoCookieSource::Auto => {
                        self.cookies_path().is_file().then(|| self.cookies_path())
                    }
                    _ => None,
                };
                auth_private_cookie =
                    imported_path.as_ref().and_then(
                        |path| match browser_media::scoped_cookie_copy(path, site) {
                            Ok(private) => Some(private),
                            Err(detail) => {
                                tauri_plugin_log::log::warn!(
                                    "[downloader] 已导入 Cookies 无法创建本次隔离副本: {detail}"
                                );
                                None
                            }
                        },
                    );
                let imported_cookies = auth_private_cookie.as_ref().and_then(|private| {
                    match browser_media::site_cookies_from_file(private.as_ref(), site) {
                        Ok(cookies) if !cookies.is_empty() => Some(cookies),
                        Ok(_) => None,
                        Err(detail) => {
                            tauri_plugin_log::log::warn!(
                                "[downloader] 目标站点 Cookies 无法用于隔离浏览器: {detail}"
                            );
                            None
                        }
                    }
                });
                let cancelled = self.cancel_flag(&job_id);
                let permit = tokio::select! {
                    permit = self.inner.site_resolver_slots.acquire() => permit.ok(),
                    _ = wait_for_cancel(cancelled.clone()) => return,
                };
                let Some(permit) = permit else {
                    self.fail_job(&job_id, "本地站点视频解析队列不可用。".into());
                    return;
                };
                let attempts = if imported_cookies.is_some() { 2 } else { 1 };
                for attempt in 0..attempts {
                    if self.is_cancelled(&job_id) {
                        return;
                    }
                    let cookies = if attempt == 0 {
                        imported_cookies.as_deref()
                    } else {
                        None
                    };
                    self.update_record(&job_id, |record| {
                        record.probe_status = Some(match (site, cookies.is_some()) {
                            (SiteResolver::Rednote, true) => {
                                "正在用已导入 Cookies 检查小红书官方视频流".into()
                            }
                            (SiteResolver::Douyin, true) => {
                                "正在用已导入 Cookies 检查抖音官方视频流".into()
                            }
                            (SiteResolver::Rednote, false) => {
                                "正在检查小红书未使用 Cookies 的官方视频流".into()
                            }
                            (SiteResolver::Douyin, false) => {
                                "正在检查抖音未使用 Cookies 的官方视频流".into()
                            }
                        });
                    });
                    let output =
                        browser_media::resolve(runtime, site, &url, cookies, cancelled.as_ref())
                            .await;
                    match output {
                        Ok(stdout) => match site {
                            SiteResolver::Rednote => {
                                let cdn_cookie_file: Option<&Path> = if cookies.is_some() {
                                    auth_private_cookie.as_ref().map(|file| file.as_ref())
                                } else {
                                    None
                                };
                                let result = tokio::select! {
                                    result = super::xiaohongshu::verify_browser_output(&url, &stdout, cdn_cookie_file) => Some(result),
                                    _ = wait_for_cancel(cancelled.clone()) => None,
                                };
                                match result {
                                    Some(Ok(video)) => rednote_video = video,
                                    Some(Err(detail)) => tauri_plugin_log::log::warn!(
                                        "[downloader] 小红书官方视频流校验失败: {detail}"
                                    ),
                                    None => return,
                                }
                            }
                            SiteResolver::Douyin => {
                                douyin_video = parse_douyin_browser_output(&url, &stdout);
                            }
                        },
                        Err(detail) if !self.is_cancelled(&job_id) => {
                            tauri_plugin_log::log::warn!(
                                "[downloader] 站点视频流预检不可用: {detail}"
                            );
                        }
                        Err(_) => return,
                    }
                    if rednote_video.is_some() || douyin_video.is_some() {
                        resolved_with_imported_cookies = cookies.is_some();
                        break;
                    }
                }
                drop(permit);
            }
        }
        if self.is_cancelled(&job_id) {
            return;
        }
        let requested_cookie_source = cookie_source.clone();
        let (cookie_source, _private_cookie) = if resolved_with_imported_cookies {
            let Some(private) = auth_private_cookie.take() else {
                self.fail_job(&job_id, "已导入的站点 Cookies 不可用。".into());
                return;
            };
            (
                VideoCookieSource::ManualFile(private.to_path_buf()),
                Some(private),
            )
        } else if rednote_video.is_some() {
            (VideoCookieSource::None, auth_private_cookie.take())
        } else if douyin_video.is_some() {
            (VideoCookieSource::SiteSession, auth_private_cookie.take())
        } else {
            drop(auth_private_cookie.take());
            match cookie_source {
                VideoCookieSource::Auto => {
                    match self
                        .select_auto_cookie_source(&job_id, &binary, &url, &ffmpeg)
                        .await
                    {
                        Ok(Some(selection)) => (selection.source, selection.private_cookie),
                        Ok(None) => return,
                        Err(message) => {
                            if !self.is_cancelled(&job_id) {
                                self.fail_job(&job_id, message);
                            }
                            return;
                        }
                    }
                }
                VideoCookieSource::ManualFile(original) => match private_cookie_copy(&original) {
                    Ok(private) => (
                        VideoCookieSource::ManualFile(private.to_path_buf()),
                        Some(private),
                    ),
                    Err(error) => {
                        self.fail_job(&job_id, format!("手动 Cookies 临时副本创建失败：{error}"));
                        return;
                    }
                },
                source => (source, None),
            }
        };
        if self.is_cancelled(&job_id) {
            return;
        }
        self.update_record(&job_id, |record| {
            record.credential_source = cookie_source.credential_source();
            record.probe_status = None;
        });

        // 3. 组装真实下载参数。B 站按登录态做画质路由：未登录封顶 480P（避免请求
        //    未开放画质导致「格式不可用」失败），已登录请求当前账号可用的
        //    最高画质；其他站点沿用引擎默认。B 站等平台的音视频是分离 DASH
        //    流，必须 ffmpeg 合并才能产出可用成片：优先 PATH 上的 ffmpeg，
        //    没有则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载）。
        let quality = resolve_download_quality(&url, &cookie_source);
        if let Some(quality) = &quality {
            self.update_record(&job_id, |record| {
                record.quality_mode = Some(quality.mode);
                record.quality_hint = Some(quality.hint.clone());
            });
            tauri_plugin_log::log::info!(
                "[downloader] B 站画质路由: mode={:?}, hint={}",
                quality.mode,
                quality.hint
            );
        }
        let directory = self.inner.downloads_dir.join("无限画布");
        if let Err(error) = tokio::fs::create_dir_all(&directory).await {
            self.fail_job(&job_id, format!("下载目录创建失败：{error}"));
            return;
        }
        let mut media_candidates: Vec<String> = if let Some(video) = &rednote_video {
            video
                .media_candidates
                .iter()
                .map(|candidate| candidate.media_url.clone())
                .collect()
        } else if let Some(video) = &douyin_video {
            video.media_urls.clone()
        } else {
            vec![url.clone()]
        };
        let site_candidate_count = if rednote_video.is_some() || douyin_video.is_some() {
            let count = media_candidates.len();
            // Official CDN candidates remain first. If all fail, retry the
            // original page once with the user's selected credential source.
            media_candidates.push(url.clone());
            count
        } else {
            0
        };
        let mut fallback_credentials: Option<AutoSourceSelection> = None;
        for (candidate_index, media_url) in media_candidates.iter().enumerate() {
            if self.is_cancelled(&job_id) {
                return;
            }
            let original_fallback =
                site_candidate_count > 0 && candidate_index == site_candidate_count;
            let can_retry = candidate_index + 1 < media_candidates.len();
            if original_fallback {
                let selection = if resolved_with_imported_cookies {
                    AutoSourceSelection {
                        source: cookie_source.clone(),
                        private_cookie: None,
                    }
                } else {
                    match &requested_cookie_source {
                        VideoCookieSource::Auto
                        | VideoCookieSource::Browser(VideoCookieBrowser::Auto) => {
                            match self
                                .select_auto_cookie_source(&job_id, &binary, &url, &ffmpeg)
                                .await
                            {
                                Ok(Some(selection)) => selection,
                                Ok(None) => return,
                                Err(message) => {
                                    if !self.is_cancelled(&job_id) {
                                        self.fail_job(&job_id, format!(
                                            "站点视频流均下载失败；原站链接预检也未通过：{message}"
                                        ));
                                    }
                                    return;
                                }
                            }
                        }
                        VideoCookieSource::ManualFile(original) => {
                            let private = if let Some(private) = _private_cookie.as_ref() {
                                AutoSourceSelection {
                                    source: VideoCookieSource::ManualFile(private.to_path_buf()),
                                    private_cookie: None,
                                }
                            } else {
                                let site = if rednote_video.is_some() {
                                    SiteResolver::Rednote
                                } else {
                                    SiteResolver::Douyin
                                };
                                let private = match browser_media::scoped_cookie_copy(
                                    original, site,
                                ) {
                                    Ok(private) => private,
                                    Err(detail) => {
                                        self.fail_job(&job_id, format!(
                                            "站点视频流均下载失败；原站链接无法使用已导入 Cookies：{detail}"
                                        ));
                                        return;
                                    }
                                };
                                AutoSourceSelection {
                                    source: VideoCookieSource::ManualFile(private.to_path_buf()),
                                    private_cookie: Some(private),
                                }
                            };
                            private
                        }
                        source => AutoSourceSelection {
                            source: source.clone(),
                            private_cookie: None,
                        },
                    }
                };
                if self.is_cancelled(&job_id) {
                    return;
                }
                let credential_source = selection.source.credential_source();
                fallback_credentials = Some(selection);
                self.update_record(&job_id, |record| {
                    record.progress = None;
                    record.credential_source = credential_source;
                    record.probe_status =
                        Some("站点视频流均未通过下载验收，正在重试原站链接".into());
                });
            } else if candidate_index > 0 {
                self.update_record(&job_id, |record| {
                    record.progress = None;
                    record.probe_status = Some(format!(
                        "正在尝试{}视频流 {}/{}",
                        if rednote_video.is_some() {
                            "小红书"
                        } else {
                            "抖音"
                        },
                        candidate_index + 1,
                        site_candidate_count
                    ));
                });
            }
            let active_cookie_source = fallback_credentials
                .as_ref()
                .map_or(&cookie_source, |selection| &selection.source);
            let attempt_id = if candidate_index == 0 {
                job_id.clone()
            } else {
                format!("{job_id}-{}", candidate_index + 1)
            };
            let output_template = if original_fallback {
                if let Some(video) = &rednote_video {
                    directory.join(format!(
                        "小红书视频 [{}] [{}]（原站）.%(ext)s",
                        video.note_id, attempt_id
                    ))
                } else if let Some(video) = &douyin_video {
                    directory.join(format!(
                        "抖音视频 [{}] [{}]（原站）.%(ext)s",
                        video.video_id, attempt_id
                    ))
                } else {
                    unreachable!("original fallback requires site media")
                }
            } else if let Some(video) = &rednote_video {
                directory.join(format!(
                    "小红书视频 [{}] [{}].%(ext)s",
                    video.note_id, attempt_id
                ))
            } else if let Some(video) = &douyin_video {
                directory.join(format!(
                    "抖音视频 [{}] [{}].%(ext)s",
                    video.video_id, attempt_id
                ))
            } else if super::xiaohongshu::supports_rednote_fallback(&url) {
                directory.join(format!("小红书视频 [{attempt_id}].%(ext)s"))
            } else if is_douyin_url(&url) {
                directory.join(format!("抖音视频 [{attempt_id}].%(ext)s"))
            } else {
                directory.join("%(title)s [%(id)s].%(ext)s")
            };
            let mut args = base_download_args(&output_template);
            // 画质路由对应的格式选择器：Sd480 一律封顶 480P，其余走最佳画质；
            // 有 ffmpeg 时分离音视频合并封装 MP4。ffmpeg 不在 PATH 上时才显式指定位置。
            let cap_480p = quality
                .as_ref()
                .is_some_and(|q| q.mode == VideoDownloadQualityMode::Sd480);
            append_download_format_args(&mut args, cap_480p, &ffmpeg);
            if let Err(error) = append_cookie_args(&mut args, active_cookie_source) {
                self.fail_job(
                    &job_id,
                    original_fallback_failure(original_fallback, error.to_string()),
                );
                return;
            }
            if douyin_video.is_some() && !original_fallback {
                args.extend([
                    "--add-header".into(),
                    "Referer: https://www.douyin.com/".into(),
                ]);
            }
            // Both CDN URLs and original site links can carry bearer-like
            // query tokens; neither belongs in the process argument list.
            let url_via_stdin =
                append_url_input_args(&mut args, media_url, site_candidate_count > 0);

            // 4. 启动引擎子进程。
            let mut command = tokio::process::Command::new(&binary);
            command
                .args(&args)
                .stdin(if url_via_stdin {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(CREATE_NO_WINDOW);
            ProcessTree::configure(&mut command);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    if can_retry {
                        continue;
                    }
                    self.fail_job(
                        &job_id,
                        original_fallback_failure(
                            original_fallback,
                            format!("下载引擎启动失败：{error}"),
                        ),
                    );
                    return;
                }
            };
            let process_tree = match ProcessTree::attach(&child) {
                Ok(tree) => tree,
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    if can_retry {
                        continue;
                    }
                    self.fail_job(
                        &job_id,
                        original_fallback_failure(
                            original_fallback,
                            "下载引擎进程组创建失败。".into(),
                        ),
                    );
                    return;
                }
            };
            if url_via_stdin {
                let input_result = if let Some(mut input) = child.stdin.take() {
                    let mut line = media_url.as_bytes().to_vec();
                    line.push(b'\n');
                    Some(tokio::time::timeout(Duration::from_secs(5), input.write_all(&line)).await)
                } else {
                    None
                };
                if !matches!(input_result, Some(Ok(Ok(())))) {
                    drop(process_tree);
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    if can_retry {
                        continue;
                    }
                    self.fail_job(
                        &job_id,
                        original_fallback_failure(
                            original_fallback,
                            "下载引擎无法接收站点链接。".into(),
                        ),
                    );
                    return;
                }
            }
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
                    drop(process_tree);
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return;
                }
            };
            // yt-dlp may spawn ffmpeg; close the owned tree before awaiting
            // pipe readers so an orphaned child cannot hold their pipes open.
            drop(process_tree);
            let stdout_path = path_task.await.unwrap_or_default();
            let stderr_tail = stderr_task.await.unwrap_or_default();

            match wait_result {
                Ok(status) if status.success() => {
                    let final_path = resolve_final_path(&stdout_path, &stderr_tail);
                    match final_path {
                        Some(path) if Path::new(&path).is_file() => {
                            if original_fallback {
                                if std::fs::metadata(&path)
                                    .map_or(true, |metadata| metadata.len() == 0)
                                    || !has_mp4_ftyp(Path::new(&path))
                                {
                                    self.fail_job(
                                        &job_id,
                                        "原站重试文件为空或不是有效 MP4。".into(),
                                    );
                                    return;
                                }
                                if let Some(ffmpeg_path) =
                                    resolve_ffmpeg_binary(&self.inner.composer).await
                                {
                                    if probe_video_dimensions(&ffmpeg_path, Path::new(&path))
                                        .await
                                        .is_none()
                                    {
                                        self.fail_job(
                                            &job_id,
                                            "原站重试文件缺少可解码的视频画面。".into(),
                                        );
                                        return;
                                    }
                                }
                            }
                            if let Some(video) =
                                rednote_video.as_ref().filter(|_| !original_fallback)
                            {
                                let actual_size =
                                    std::fs::metadata(&path).map(|metadata| metadata.len());
                                if actual_size.ok()
                                    != video
                                        .media_candidates
                                        .get(candidate_index)
                                        .map(|candidate| candidate.expected_size)
                                    || !has_mp4_ftyp(Path::new(&path))
                                {
                                    if can_retry {
                                        continue;
                                    }
                                    self.fail_job(
                                        &job_id,
                                        "小红书视频下载不完整，文件与官方 MP4 视频流不符。".into(),
                                    );
                                    return;
                                }
                                if let Some(ffmpeg_path) =
                                    resolve_ffmpeg_binary(&self.inner.composer).await
                                {
                                    if probe_video_dimensions(&ffmpeg_path, Path::new(&path))
                                        .await
                                        .is_none()
                                    {
                                        if can_retry {
                                            continue;
                                        }
                                        self.fail_job(
                                            &job_id,
                                            "小红书下载文件缺少可解码的视频画面。".into(),
                                        );
                                        return;
                                    }
                                }
                            }
                            if let Some(video) =
                                douyin_video.as_ref().filter(|_| !original_fallback)
                            {
                                if std::fs::metadata(&path)
                                    .map_or(true, |metadata| metadata.len() == 0)
                                    || !has_mp4_ftyp(Path::new(&path))
                                {
                                    if can_retry {
                                        continue;
                                    }
                                    self.fail_job(
                                        &job_id,
                                        "抖音视频下载不完整，文件不是有效 MP4。".into(),
                                    );
                                    return;
                                }
                                if let Some(ffmpeg_path) =
                                    resolve_ffmpeg_binary(&self.inner.composer).await
                                {
                                    let dimensions =
                                        probe_video_dimensions(&ffmpeg_path, Path::new(&path))
                                            .await;
                                    let duration =
                                        probe_video_duration_ms(&ffmpeg_path, Path::new(&path))
                                            .await;
                                    if dimensions.is_none()
                                        || duration.is_none_or(|actual| {
                                            actual.abs_diff(video.duration_ms) > 3000
                                        })
                                    {
                                        if can_retry {
                                            continue;
                                        }
                                        self.fail_job(
                                            &job_id,
                                            "抖音下载文件的视频流或时长与官方视频信息不符。".into(),
                                        );
                                        return;
                                    }
                                }
                            }
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
                            if self.is_cancelled(&job_id) {
                                return;
                            }
                            self.update_record(&job_id, |record| {
                                record.status = VideoDownloadStatus::Completed;
                                record.progress = Some(100.0);
                                record.final_path = Some(final_path);
                                record.file_name = file_name;
                                record.watermark_removed = watermark_removed;
                                record.probe_status = None;
                            });
                            return;
                        }
                        Some(path) => {
                            if can_retry {
                                continue;
                            }
                            self.fail_job(
                                &job_id,
                                original_fallback_failure(
                                    original_fallback,
                                    if original_fallback {
                                        "引擎报告的原站输出文件不存在。".into()
                                    } else {
                                        format!("引擎报告的输出文件不存在：{path}")
                                    },
                                ),
                            );
                        }
                        None => {
                            if can_retry {
                                continue;
                            }
                            self.fail_job(
                                &job_id,
                                original_fallback_failure(
                                    original_fallback,
                                    "下载结束但无法确定输出文件路径。".into(),
                                ),
                            );
                        }
                    }
                }
                Ok(status) => {
                    if can_retry {
                        continue;
                    }
                    self.fail_job(
                        &job_id,
                        original_fallback_failure(
                            original_fallback,
                            failure_message(
                                &stderr_tail,
                                &status.to_string(),
                                &url,
                                active_cookie_source,
                            ),
                        ),
                    );
                }
                Err(error) => {
                    if can_retry {
                        continue;
                    }
                    self.fail_job(
                        &job_id,
                        original_fallback_failure(
                            original_fallback,
                            format!("下载进程异常退出：{error}"),
                        ),
                    );
                }
            }
            return;
        }
    }

    async fn select_auto_cookie_source(
        &self,
        job_id: &str,
        binary: &Path,
        url: &str,
        ffmpeg: &FfmpegForDownload,
    ) -> Result<Option<AutoSourceSelection>, String> {
        let mut successes = Vec::new();
        let mut failures = Vec::new();
        let mut manual_guard: Option<tempfile::TempPath> = None;
        let bilibili = is_bilibili_url(url);
        let candidates = auto_cookie_candidates(&self.cookies_path());
        let candidate_count = candidates.len();
        for (index, source) in candidates.into_iter().enumerate() {
            if self.is_cancelled(job_id) {
                return Ok(None);
            }
            self.update_record(job_id, |record| {
                record.probe_status = Some(format!(
                    "自动预检 {}/{}：{}",
                    index + 1,
                    candidate_count,
                    cookie_source_label(&source)
                ));
            });
            let (probe_source, private_cookie) = match source {
                VideoCookieSource::ManualFile(original) => match private_cookie_copy(&original) {
                    Ok(private) => (
                        VideoCookieSource::ManualFile(private.to_path_buf()),
                        Some(private),
                    ),
                    Err(error) => {
                        failures.push(format!("已导入文件：临时副本创建失败：{error}"));
                        continue;
                    }
                },
                source => (source, None),
            };
            let result =
                probe_auto_candidate(binary, url, &probe_source, ffmpeg, self.cancel_flag(job_id))
                    .await;
            match result {
                AutoProbeResult::Cancelled => return Ok(None),
                AutoProbeResult::Success(height) => {
                    successes.push(AutoProbeSuccess {
                        source: probe_source.clone(),
                        height,
                    });
                    if !bilibili {
                        return Ok(Some(AutoSourceSelection {
                            source: probe_source,
                            private_cookie,
                        }));
                    }
                    if private_cookie.is_some() {
                        manual_guard = private_cookie;
                    }
                }
                AutoProbeResult::Failed(summary) => {
                    failures.push(format!(
                        "{}：{}",
                        cookie_source_label(&probe_source),
                        summary
                    ));
                }
            }
        }
        if let Some(selected) = choose_auto_cookie_source(url, &successes) {
            let private_cookie = if matches!(&selected, VideoCookieSource::ManualFile(_)) {
                manual_guard
            } else {
                None
            };
            return Ok(Some(AutoSourceSelection {
                source: selected,
                private_cookie,
            }));
        }
        Err(auto_failure_message(url, &failures))
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
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "b23.tv"
        || host.ends_with(".b23.tv")
        || host == "bilibili.com"
        || host.ends_with(".bilibili.com")
}

/// 抖音长链与分享短链；严格按主机匹配，避免把第三方 URL 当作抖音。
fn is_douyin_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "douyin.com"
        || host.ends_with(".douyin.com")
        || host == "iesdouyin.com"
        || host.ends_with(".iesdouyin.com")
}

/// A site share URL may itself carry a bearer-like query token. Never place
/// those URLs, or a resolved CDN URL, in the OS process argument list.
fn append_url_input_args(args: &mut Vec<String>, url: &str, force_stdin: bool) -> bool {
    if force_stdin || is_douyin_url(url) || super::xiaohongshu::supports_rednote_fallback(url) {
        args.extend(["--batch-file".into(), "-".into()]);
        true
    } else {
        args.push(url.to_string());
        false
    }
}

/// Browser output is treated as untrusted page data. Only the fixed official
/// video CDN, a matching ID, and bounded fields may enter the download path.
struct ResolvedDouyinVideo {
    video_id: String,
    duration_ms: u64,
    media_urls: Vec<String>,
}

fn parse_douyin_browser_output(input_url: &str, stdout: &[u8]) -> Option<ResolvedDouyinVideo> {
    if !is_douyin_url(input_url) || stdout.len() > 16 * 1024 {
        return None;
    }
    let result: Value = serde_json::from_slice(stdout).ok()?;
    if result.get("ok")?.as_bool()? != true {
        return None;
    }
    let video_id = result.get("videoId")?.as_str()?;
    if !(12..=22).contains(&video_id.len()) || !video_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let input = url::Url::parse(input_url).ok()?;
    if let Some(input_id) = input
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .filter(|segment| segment.len() >= 12 && segment.bytes().all(|byte| byte.is_ascii_digit()))
    {
        if input_id != video_id {
            return None;
        }
    }
    let duration_ms = result.get("durationMs")?.as_u64()?;
    if !(1..=24 * 60 * 60 * 1000).contains(&duration_ms) {
        return None;
    }
    let candidates = result.get("mediaUrls")?.as_array()?;
    if candidates.is_empty() || candidates.len() > 4 {
        return None;
    }
    let media_urls: Vec<String> = candidates
        .iter()
        .filter_map(Value::as_str)
        .filter(|url| valid_douyin_media_url(url))
        .map(str::to_string)
        .collect();
    if media_urls.is_empty() {
        return None;
    }
    Some(ResolvedDouyinVideo {
        video_id: video_id.to_string(),
        duration_ms,
        media_urls,
    })
}

fn valid_douyin_media_url(value: &str) -> bool {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|port| port == 443)
        && (host == "douyinvod.com" || host.ends_with(".douyinvod.com"))
}

/// 已导入的 cookies.txt 是否包含 B 站登录态。B 站以 SESSDATA 作为登录凭据，
/// 只有匿名访客 Cookie（buvid3 / b_nut 等）不视为已登录。
fn cookies_have_bilibili_login(cookies_path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(cookies_path) else {
        return false;
    };
    content.lines().any(|line| {
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.trim_start().starts_with('#') {
            return false;
        }
        // Netscape cookies 格式：domain / includeSubdomains / path / secure /
        // expiry / name / value，共 7 列。
        let fields: Vec<&str> = line.split('\t').collect();
        fields.len() >= 7
            && fields[5] == "SESSDATA"
            && (fields[0].eq_ignore_ascii_case("bilibili.com")
                || fields[0].eq_ignore_ascii_case(".bilibili.com"))
            && !fields[6].is_empty()
            && fields[4].parse::<i64>().map_or(true, |expiry| {
                expiry == 0 || expiry > chrono::Utc::now().timestamp()
            })
    })
}

/// 两种来源互斥；浏览器模式由 yt-dlp 在下载时现读并按请求域名匹配，
/// 不把整个浏览器的 CookieJar 导出到磁盘。
fn append_cookie_args(args: &mut Vec<String>, source: &VideoCookieSource) -> BackendResult<()> {
    match source {
        VideoCookieSource::Auto | VideoCookieSource::Browser(VideoCookieBrowser::Auto) => {
            return Err(BackendError::validation(
                "自动 Cookie 来源尚未完成预检，不能启动下载",
                Value::Null,
            ));
        }
        VideoCookieSource::Browser(browser) => args.extend([
            "--cookies-from-browser".into(),
            browser.as_setting_value().into(),
        ]),
        VideoCookieSource::ManualFile(path) => {
            args.extend(["--cookies".into(), path.to_string_lossy().into_owned()])
        }
        VideoCookieSource::SiteSession | VideoCookieSource::None => {}
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct AutoProbeSuccess {
    source: VideoCookieSource,
    height: u32,
}

enum AutoProbeResult {
    Success(u32),
    Failed(String),
    Cancelled,
}

struct AutoSourceSelection {
    source: VideoCookieSource,
    // 必须保持到真实下载进程结束，TempPath Drop 会清除临时副本。
    private_cookie: Option<tempfile::TempPath>,
}

fn private_cookie_copy(source: &Path) -> BackendResult<tempfile::TempPath> {
    let metadata = std::fs::metadata(source)?;
    if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
        return Err(BackendError::validation(
            "已导入的 Cookies 文件为空或超过 2MB，请重新导入",
            serde_json::json!({"byteSize": metadata.len()}),
        ));
    }
    let contents = std::fs::read_to_string(source)?;
    let private = tempfile::Builder::new()
        .prefix("infinite-canvas-yt-cookies-")
        .suffix(".txt")
        .tempfile()?;
    super::credentials::write_private_file(private.path(), &contents)?;
    private.as_file().sync_all()?;
    Ok(private.into_temp_path())
}

fn auto_cookie_candidates(manual_path: &Path) -> Vec<VideoCookieSource> {
    let mut candidates = vec![
        VideoCookieSource::Browser(VideoCookieBrowser::Chrome),
        VideoCookieSource::Browser(VideoCookieBrowser::Edge),
        VideoCookieSource::Browser(VideoCookieBrowser::Firefox),
    ];
    if manual_path.is_file() {
        candidates.push(VideoCookieSource::ManualFile(manual_path.to_path_buf()));
    }
    candidates.push(VideoCookieSource::None);
    candidates
}

fn choose_auto_cookie_source(
    url: &str,
    successes: &[AutoProbeSuccess],
) -> Option<VideoCookieSource> {
    let mut selected = successes.first()?;
    if is_bilibili_url(url) {
        for candidate in successes.iter().skip(1) {
            // 严格大于保留同画质时的浏览器优先顺序。
            if candidate.height > selected.height {
                selected = candidate;
            }
        }
    }
    Some(selected.source.clone())
}

fn parse_probe_height(stdout: &[u8]) -> u32 {
    String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|line| line.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

fn probe_error_summary(input_url: &str, stderr: &[u8], fallback: &str) -> String {
    let text = String::from_utf8_lossy(stderr);
    let raw_summary = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(fallback);
    // 保留无敏感值的错误类别，让自动来源失败时仍能识别小红书安全页。
    // 重定向 URL、查询参数和分享令牌仍由常规清洗逻辑隐藏。
    if text.contains("/404/sec_") && super::xiaohongshu::failure_hint(input_url, &text).is_some() {
        return "小红书短链跳转到 /404/sec_ 安全页（重定向链接已隐藏）".to_string();
    }
    let summary = sanitize_download_diagnostic(raw_summary);
    summary.chars().take(240).collect()
}

fn auto_failure_message(url: &str, failures: &[String]) -> String {
    let failure_details = failures.join("；");
    let guidance = if is_douyin_url(url)
        && failures
            .iter()
            .any(|failure| failure.to_ascii_lowercase().contains("fresh cookies"))
    {
        "抖音详情接口未返回视频；yt-dlp 即使收到有效 Cookies 也可能报“Fresh cookies”。请先确认链接在浏览器中可播放，若可播放则可能是站点验证或当前提取器限制，重新导入 Cookies 不保证解决。"
    } else if let Some(hint) = super::xiaohongshu::failure_hint(url, &failure_details) {
        hint
    } else {
        "请检查链接、浏览器登录态或站点限制。"
    };
    format!("自动 Cookie 来源预检均未找到可访问视频，尚未开始下载。{guidance}{failure_details}")
}

fn cookie_source_label(source: &VideoCookieSource) -> &'static str {
    match source {
        VideoCookieSource::Auto => "自动",
        VideoCookieSource::Browser(VideoCookieBrowser::Auto) => "自动",
        VideoCookieSource::Browser(VideoCookieBrowser::Chrome) => "Chrome",
        VideoCookieSource::Browser(VideoCookieBrowser::Edge) => "Edge",
        VideoCookieSource::Browser(VideoCookieBrowser::Firefox) => "Firefox",
        VideoCookieSource::Browser(VideoCookieBrowser::Brave) => "Brave",
        VideoCookieSource::ManualFile(_) => "已导入文件",
        VideoCookieSource::SiteSession => "站点会话",
        VideoCookieSource::None => "无 Cookies",
    }
}

fn auto_probe_args(
    url: &str,
    source: &VideoCookieSource,
    ffmpeg: &FfmpegForDownload,
) -> BackendResult<Vec<String>> {
    let mut args = vec![
        YT_DLP_CONFIG_ISOLATION_ARG.into(),
        "--simulate".into(),
        "--check-formats".into(),
        "--no-playlist".into(),
        "--print".into(),
        "%(height)s".into(),
    ];
    let cap_480p = resolve_download_quality(url, source)
        .as_ref()
        .is_some_and(|quality| quality.mode == VideoDownloadQualityMode::Sd480);
    append_download_format_args(&mut args, cap_480p, ffmpeg);
    append_cookie_args(&mut args, source)?;
    append_url_input_args(&mut args, url, false);
    Ok(args)
}

async fn probe_auto_candidate(
    binary: &Path,
    url: &str,
    source: &VideoCookieSource,
    ffmpeg: &FfmpegForDownload,
    cancelled: Arc<AtomicBool>,
) -> AutoProbeResult {
    if cancelled.load(Ordering::Relaxed) {
        return AutoProbeResult::Cancelled;
    }
    let args = match auto_probe_args(url, source, ffmpeg) {
        Ok(args) => args,
        Err(error) => return AutoProbeResult::Failed(error.to_string()),
    };
    let url_via_stdin = is_douyin_url(url) || super::xiaohongshu::supports_rednote_fallback(url);
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .stdin(if url_via_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    ProcessTree::configure(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return AutoProbeResult::Failed(format!("预检进程启动失败：{error}")),
    };
    let process_tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return AutoProbeResult::Failed("预检进程组创建失败".into());
        }
    };
    if url_via_stdin {
        let input_result = if let Some(mut input) = child.stdin.take() {
            let mut line = url.as_bytes().to_vec();
            line.push(b'\n');
            Some(tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(5), input.write_all(&line)) => result,
                _ = wait_for_cancel(cancelled.clone()) => {
                    drop(process_tree);
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return AutoProbeResult::Cancelled;
                }
            })
        } else {
            None
        };
        if !matches!(input_result, Some(Ok(Ok(())))) {
            drop(process_tree);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return AutoProbeResult::Failed("预检进程无法接收站点链接".into());
        }
    }
    use tokio::io::AsyncReadExt as _;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tauri::async_runtime::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_end(&mut bytes).await;
        }
        bytes
    });
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_end(&mut bytes).await;
        }
        bytes
    });
    let wait_result = tokio::select! {
        _ = wait_for_cancel(cancelled) => None,
        result = tokio::time::timeout(AUTO_COOKIE_PROBE_TIMEOUT, child.wait()) => Some(result),
    };
    let status = match wait_result {
        Some(Ok(Ok(status))) => status,
        Some(Ok(Err(error))) => {
            drop(process_tree);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return AutoProbeResult::Failed(format!("预检进程异常：{error}"));
        }
        Some(Err(_)) => {
            drop(process_tree);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return AutoProbeResult::Failed("预检超过 45 秒，已终止该来源".into());
        }
        None => {
            drop(process_tree);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return AutoProbeResult::Cancelled;
        }
    };
    drop(process_tree);
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    if status.success() {
        AutoProbeResult::Success(parse_probe_height(&stdout))
    } else {
        AutoProbeResult::Failed(probe_error_summary(url, &stderr, "格式不可访问"))
    }
}

fn base_download_args(output_template: &Path) -> Vec<String> {
    vec![
        YT_DLP_CONFIG_ISOLATION_ARG.into(),
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
    ]
}

/// B 站画质路由决策：返回本次下载的画质档位与面向用户的中文说明。
/// 非 B 站链接返回 None（沿用引擎默认行为）。
struct DownloadQuality {
    mode: VideoDownloadQualityMode,
    hint: String,
}

fn resolve_download_quality(url: &str, source: &VideoCookieSource) -> Option<DownloadQuality> {
    if !is_bilibili_url(url) {
        return None;
    }
    if let VideoCookieSource::Browser(browser) = source {
        return Some(DownloadQuality {
            mode: VideoDownloadQualityMode::Best,
            hint: format!(
                "将从 {} 浏览器尝试读取 B 站 Cookies，请求当前可用的最高画质；目标视频能否访问以实际下载结果为准。",
                browser.as_setting_value()
            ),
        });
    }
    if matches!(source, VideoCookieSource::ManualFile(path) if cookies_have_bilibili_login(path)) {
        Some(DownloadQuality {
            mode: VideoDownloadQualityMode::Best,
            hint: "Cookies 文件含 B 站登录凭据，请求当前可用的最高画质；目标视频能否访问以实际下载结果为准。".to_string(),
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

/// 下载时 ffmpeg 是否可用，以及要不要把目录显式传给 yt-dlp。
///
/// 系统 ffmpeg 命中 PATH 时 `location` 为空：yt-dlp 继承同一 PATH，自己能找到。
/// 这时仍然 `available`，格式选择必须走音视频分离合并，不能因为没有显式目录
/// 就退回单文件 `-f b`。
struct FfmpegForDownload {
    available: bool,
    location: Option<PathBuf>,
}

/// 按画质上限和 ffmpeg 是否可用追加 yt-dlp 格式参数。
/// 有 ffmpeg 时分离音视频再封装 MP4；只有不在 PATH 上的 ffmpeg 才追加
/// `--ffmpeg-location`。
fn append_download_format_args(args: &mut Vec<String>, cap_480p: bool, ffmpeg: &FfmpegForDownload) {
    let append_location = |args: &mut Vec<String>| {
        if let Some(location) = &ffmpeg.location {
            args.extend([
                "--ffmpeg-location".into(),
                location.to_string_lossy().into_owned(),
            ]);
        }
    };
    if ffmpeg.available && cap_480p {
        args.extend([
            "-f".into(),
            "bv*[height<=480]+ba/b[height<=480]/b".into(),
            "--merge-output-format".into(),
            "mp4".into(),
        ]);
        append_location(args);
    } else if ffmpeg.available {
        args.extend([
            "-f".into(),
            "bv*+ba/b".into(),
            "--merge-output-format".into(),
            "mp4".into(),
        ]);
        append_location(args);
    } else if cap_480p {
        args.extend(["-f".into(), "b[height<=480]/b".into()]);
    } else {
        args.extend(["-f".into(), "b".into()]);
    }
}

/// 解析本次下载可用的 ffmpeg：
/// - 系统 ffmpeg 命中 PATH → 可用，不传位置；
/// - 系统 ffmpeg 只命中平台兜底目录（macOS 上 Homebrew 的 `/opt/homebrew/bin` 等，
///   从 Finder 启动的 .app 不在 PATH 里）→ 可用，并把所在目录交给 `--ffmpeg-location`；
/// - 否则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载一次）；下载失败则不可用。
async fn resolve_ffmpeg_for_download(composer: &VideoCompositionService) -> FfmpegForDownload {
    match super::system_ffmpeg::resolve().await {
        Some(system) if system.on_path => {
            return FfmpegForDownload {
                available: true,
                location: None,
            };
        }
        Some(system) => {
            let location = system.path.parent().map(Path::to_path_buf);
            return FfmpegForDownload {
                available: location.is_some(),
                location,
            };
        }
        None => {}
    }
    let location = composer
        .ensure_ffmpeg()
        .await
        .ok()
        .and_then(|binary| binary.parent().map(Path::to_path_buf));
    FfmpegForDownload {
        available: location.is_some(),
        location,
    }
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

fn has_mp4_ftyp(path: &Path) -> bool {
    use std::io::Read as _;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 12];
    file.read_exact(&mut header).is_ok() && &header[4..8] == b"ftyp"
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

fn parse_video_duration_ms(text: &str) -> Option<u64> {
    let captures = Regex::new(r"Duration: (\d+):(\d{2}):(\d{2})(?:\.(\d+))?")
        .ok()?
        .captures(text)?;
    let hours: u64 = captures.get(1)?.as_str().parse().ok()?;
    let minutes: u64 = captures.get(2)?.as_str().parse().ok()?;
    let seconds: u64 = captures.get(3)?.as_str().parse().ok()?;
    if minutes >= 60 || seconds >= 60 {
        return None;
    }
    let fraction = captures.get(4).map_or("", |part| part.as_str());
    let millis: u64 = format!("{:<03}", fraction.chars().take(3).collect::<String>())
        .replace(' ', "0")
        .parse()
        .ok()?;
    hours
        .checked_mul(3_600_000)?
        .checked_add(minutes * 60_000)?
        .checked_add(seconds * 1000)?
        .checked_add(millis)
}

async fn probe_video_duration_ms(ffmpeg: &Path, source: &Path) -> Option<u64> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command.arg("-i").arg(source).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().await.ok()?;
    parse_video_duration_ms(&String::from_utf8_lossy(&output.stderr))
}

/// 解析本次后处理可用的 ffmpeg 可执行文件：
/// - 系统 ffmpeg（PATH 或平台兜底目录）可用 → 直接使用其路径；
/// - 否则复用视频合成服务自带的 ffmpeg 引擎（缺则按需下载）返回二进制路径；
/// - 均不可用时返回 None（去水印等后处理跳过，不影响下载结果）。
async fn resolve_ffmpeg_binary(composer: &VideoCompositionService) -> Option<PathBuf> {
    if let Some(system) = super::system_ffmpeg::resolve().await {
        return Some(system.path);
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
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned());
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
    let ffmpeg = resolve_ffmpeg_binary(composer)
        .await
        .ok_or_else(|| BackendError::protocol("ffmpeg 不可用，跳过去水印", Value::Null))?;
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
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "19",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
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
        return Err(BackendError::protocol("去水印未生成输出文件", Value::Null));
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

fn original_fallback_failure(is_original_fallback: bool, detail: String) -> String {
    if is_original_fallback {
        format!("站点视频流候选均未通过下载验收；原站链接重试也失败。\n{detail}")
    } else {
        detail
    }
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

/// 组装失败信息：优先保留 yt-dlp 的真实错误。抖音详情接口返回空数据时，
/// yt-dlp 会统一提示 Fresh cookies；有效 Cookies 也可能触发，不能据此判定过期。
fn failure_message(
    stderr_tail: &VecDeque<String>,
    fallback: &str,
    url: &str,
    cookie_source: &VideoCookieSource,
) -> String {
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
            .map(|line| format!("{}\n", sanitize_download_diagnostic(line)))
            .collect();
        format!("下载失败：\n{tail}")
    };
    let combined = stderr_tail.iter().fold(String::new(), |mut acc, line| {
        acc.push_str(line);
        acc
    });
    let combined_lower = combined.to_lowercase();
    if combined_lower.contains("requested format is not available") {
        if is_bilibili_url(url) && matches!(cookie_source, VideoCookieSource::Browser(_)) {
            message.push_str("提示：所选浏览器可能未登录 B 站，或账号无此画质。请检查浏览器登录态，或切回手动 Cookies 文件；无需登录时可选手动文件模式以按访客 480P 下载。");
        } else {
            message
                .push_str("提示：当前站点没有开放所请求的画质；请检查登录态或更新下载引擎后重试。");
        }
    }
    if is_douyin_url(url) && combined_lower.contains("fresh cookies") {
        message.push_str("提示：抖音详情接口未返回视频；yt-dlp 即使收到有效 Cookies 也可能报此错误。请先确认链接在浏览器中可播放，若可播放则可能是站点验证或当前提取器限制，重新导入 Cookies 不保证解决。");
    } else if matches!(cookie_source, VideoCookieSource::Browser(_))
        && ((combined_lower.contains("could not copy")
            && combined_lower.contains("cookie database"))
            || combined_lower.contains("could not decrypt cookies")
            || (combined_lower.contains("could not find")
                && combined_lower.contains("cookies database")))
    {
        message.push_str("提示：未能读取所选浏览器的 Cookie 数据库，不能据此判断登录态是否过期。请检查该浏览器配置文件是否存在；运行中的 Chromium 浏览器或 Windows 加密也可能阻止读取。可从浏览器手动导出当前站点的 cookies.txt 再导入应用；此次下载不会无凭据重试。");
    } else if combined_lower.contains("cookie") {
        if matches!(cookie_source, VideoCookieSource::Browser(_)) {
            message.push_str("提示：浏览器 Cookies 读取失败或登录态过期时，请先在所选浏览器登录并重试；Windows 浏览器加密限制无法读取时可手动导入 cookies.txt。此次下载不会无凭据重试。");
        } else {
            message.push_str(
                "提示：站点可能需要较新的 Cookies，请导入浏览器导出的 cookies.txt 后重试。",
            );
        }
    }
    if let Some(hint) = super::xiaohongshu::failure_hint(url, &combined) {
        message.push_str(hint);
    }
    message
}

fn sanitize_download_diagnostic(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("cookie:")
        || lower.contains("set-cookie:")
        || lower.contains("authorization:")
    {
        return "[认证请求头已隐藏]".to_string();
    }
    // 分享链接或 CDN URL 可能带签名查询参数，不能随 yt-dlp stderr 进入画布状态。
    let without_urls = Regex::new(r"(?i)https?://\S+")
        .expect("valid URL redaction regex")
        .replace_all(line, "[链接已隐藏]")
        .into_owned();
    Regex::new(
        r"(?i)\b(?:xsec_token|xsec_source|sessionid|auth_token|signature|token)\s*[=:]\s*[^&\s,;]+",
    )
    .expect("valid credential redaction regex")
    .replace_all(&without_urls, "[凭据已隐藏]")
    .into_owned()
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
    fn download_format_uses_merge_when_ffmpeg_is_on_path_without_a_location() {
        let ffmpeg = FfmpegForDownload {
            available: true,
            location: None,
        };
        let mut args = Vec::new();
        append_download_format_args(&mut args, false, &ffmpeg);
        assert_eq!(
            args,
            vec![
                "-f".to_string(),
                "bv*+ba/b".to_string(),
                "--merge-output-format".to_string(),
                "mp4".to_string(),
            ]
        );

        let mut capped = Vec::new();
        append_download_format_args(&mut capped, true, &ffmpeg);
        assert!(
            capped
                .windows(2)
                .any(|pair| pair == ["-f", "bv*[height<=480]+ba/b[height<=480]/b"])
        );
        assert!(!capped.iter().any(|arg| arg == "--ffmpeg-location"));
    }

    #[test]
    fn download_format_passes_ffmpeg_location_only_when_it_is_explicit() {
        let ffmpeg = FfmpegForDownload {
            available: true,
            location: Some(PathBuf::from("/opt/homebrew/bin")),
        };
        let mut args = Vec::new();
        append_download_format_args(&mut args, false, &ffmpeg);
        assert_eq!(
            args.iter().position(|arg| arg == "--ffmpeg-location"),
            Some(4)
        );
        assert_eq!(args[5], "/opt/homebrew/bin");
    }

    #[test]
    fn download_format_falls_back_to_single_file_without_ffmpeg() {
        let ffmpeg = FfmpegForDownload {
            available: false,
            location: None,
        };
        let mut args = Vec::new();
        append_download_format_args(&mut args, false, &ffmpeg);
        assert_eq!(args, vec!["-f".to_string(), "b".to_string()]);
        let mut capped = Vec::new();
        append_download_format_args(&mut capped, true, &ffmpeg);
        assert_eq!(
            capped,
            vec!["-f".to_string(), "b[height<=480]/b".to_string()]
        );
    }

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
        assert!(is_bilibili_url(
            "https://www.bilibili.com/video/BV155j96nE27/"
        ));
        assert!(is_bilibili_url("https://b23.tv/AbCdEf"));
        assert!(is_bilibili_url("https://BILIBILI.COM/video/BV1/"));
        assert!(!is_bilibili_url("https://v.douyin.com/iAbCdEf/"));
        assert!(!is_bilibili_url("https://www.youtube.com/watch?v=x"));
        assert!(!is_bilibili_url(
            "https://bilibili.com.attacker.example/video/BV1/"
        ));
        assert!(!is_bilibili_url(
            "https://attacker.example/watch?next=bilibili.com"
        ));
    }

    #[test]
    fn is_douyin_url_matches_only_douyin_hosts() {
        assert!(is_douyin_url("https://www.douyin.com/video/123"));
        assert!(is_douyin_url("https://v.douyin.com/abc/"));
        assert!(is_douyin_url("https://www.iesdouyin.com/share/video/123"));
        assert!(!is_douyin_url(
            "https://douyin.com.attacker.example/video/123"
        ));
        assert!(!is_douyin_url("https://example.com/watch?next=douyin.com"));
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
             #HttpOnly_.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc123\n",
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
        std::fs::write(
            &path,
            ".bilibili.com.evil.test\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc123\n",
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
            &VideoCookieSource::None,
        )
        .unwrap();
        assert_eq!(guest.mode, VideoDownloadQualityMode::Sd480);
        assert!(guest.hint.contains("480P"));

        // B 站已登录 → 最高画质。
        let logged = resolve_download_quality(
            "https://www.bilibili.com/video/BV1YE6gBHEoN/",
            &VideoCookieSource::ManualFile(logged_in.clone()),
        )
        .unwrap();
        assert_eq!(logged.mode, VideoDownloadQualityMode::Best);

        let browser = resolve_download_quality(
            "https://www.bilibili.com/video/BV1YE6gBHEoN/",
            &VideoCookieSource::Browser(VideoCookieBrowser::Edge),
        )
        .unwrap();
        assert_eq!(browser.mode, VideoDownloadQualityMode::Best);
        assert!(browser.hint.contains("以实际下载结果为准"));
        assert!(!browser.hint.contains("已登录 B 站"));

        // 非 B 站 → 无路由。
        assert!(
            resolve_download_quality("https://v.douyin.com/iAbCdEf/", &VideoCookieSource::None)
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cookie_sources_pass_only_one_yt_dlp_option() {
        let mut browser_args = base_download_args(Path::new("out.mp4"));
        append_cookie_args(
            &mut browser_args,
            &VideoCookieSource::Browser(VideoCookieBrowser::Chrome),
        )
        .unwrap();
        assert_eq!(browser_args[0], "--ignore-config");
        assert_eq!(
            browser_args
                .iter()
                .filter(|arg| *arg == "--cookies-from-browser")
                .count(),
            1
        );
        assert!(!browser_args.iter().any(|arg| arg == "--cookies"));
        assert_eq!(browser_args.last().map(String::as_str), Some("chrome"));

        let mut manual_args = base_download_args(Path::new("out.mp4"));
        append_cookie_args(
            &mut manual_args,
            &VideoCookieSource::ManualFile(PathBuf::from("cookies.txt")),
        )
        .unwrap();
        assert_eq!(manual_args[0], "--ignore-config");
        assert_eq!(
            manual_args.iter().filter(|arg| *arg == "--cookies").count(),
            1
        );
        assert!(
            !manual_args
                .iter()
                .any(|arg| arg == "--cookies-from-browser")
        );
        assert_eq!(manual_args.last().map(String::as_str), Some("cookies.txt"));

        let mut no_cookie_args = Vec::new();
        append_cookie_args(&mut no_cookie_args, &VideoCookieSource::None).unwrap();
        assert!(no_cookie_args.is_empty());
        assert!(append_cookie_args(&mut Vec::new(), &VideoCookieSource::Auto).is_err());
    }

    #[test]
    fn browser_cookie_failure_stays_visible_without_anonymous_fallback() {
        let source = VideoCookieSource::Browser(VideoCookieBrowser::Edge);
        let tail = VecDeque::from(["ERROR: Could not decrypt cookies".to_string()]);
        let message = failure_message(
            &tail,
            "exit status: 1",
            "https://www.bilibili.com/video/BV1/",
            &source,
        );
        assert!(message.contains("Could not decrypt cookies"));
        assert!(message.contains("不会无凭据重试"));
        assert!(message.contains("不能据此判断登录态是否过期"));

        let copy_tail =
            VecDeque::from(["ERROR: Could not copy Chrome cookie database".to_string()]);
        let copy_message = failure_message(
            &copy_tail,
            "exit status: 1",
            "https://www.douyin.com/video/123",
            &VideoCookieSource::Browser(VideoCookieBrowser::Chrome),
        );
        assert!(copy_message.contains("未能读取所选浏览器的 Cookie 数据库"));
        assert!(!copy_message.contains("抖音详情接口未返回视频"));

        let format_tail = VecDeque::from(["ERROR: Requested format is not available".to_string()]);
        let format_message = failure_message(
            &format_tail,
            "exit status: 1",
            "https://www.bilibili.com/video/BV1/",
            &source,
        );
        assert!(format_message.contains("浏览器可能未登录"));
    }

    #[test]
    fn douyin_empty_detail_does_not_assert_cookies_are_expired() {
        let tail = VecDeque::from([
            "WARNING: [Douyin] Failed to parse JSON: Expecting value in ''".to_string(),
            "ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed".to_string(),
        ]);
        let message = failure_message(
            &tail,
            "exit status: 1",
            "https://www.douyin.com/video/123",
            &VideoCookieSource::ManualFile(PathBuf::from("cookies.txt")),
        );
        assert!(message.contains("有效 Cookies 也可能"));
        assert!(message.contains("提取器限制"));
        assert!(!message.contains("请导入浏览器导出的 cookies.txt"));

        let auto_message = auto_failure_message(
            "https://v.douyin.com/example/",
            &[
                "Chrome：Could not copy Chrome cookie database".into(),
                "已导入文件：ERROR: Fresh cookies (not necessarily logged in) are needed".into(),
            ],
        );
        assert!(auto_message.contains("有效 Cookies 也可能"));
        assert!(auto_message.contains("Could not copy Chrome cookie database"));
        assert!(auto_message.contains("尚未开始下载"));
    }

    #[test]
    fn xiaohongshu_failure_hint_reaches_download_and_auto_errors() {
        let tail = VecDeque::from(["ERROR: [XiaoHongShu] No video formats found!".to_string()]);
        let message = failure_message(
            &tail,
            "exit status: 1",
            "https://www.xiaohongshu.com/explore/123?xsec_token=private-token",
            &VideoCookieSource::None,
        );
        assert!(message.contains("没有可供提取的视频流"));
        assert!(!message.contains("private-token"));

        let auto_message = auto_failure_message(
            "https://www.xiaohongshu.com/explore/123?xsec_token=private-token",
            &["无 Cookies：ERROR: No video formats found!".into()],
        );
        assert!(auto_message.contains("没有可供提取的视频流"));
        assert!(!auto_message.contains("private-token"));
    }

    #[test]
    fn cookie_browser_setting_persists_and_job_source_is_a_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = dir.path().join("downloads");
        let composer = VideoCompositionService::new(
            downloads.clone(),
            dir.path().join("ffmpeg"),
            dir.path().join("resources"),
        )
        .unwrap();
        let engine = dir.path().join("yt-dlp");
        let service =
            VideoDownloadService::new(downloads.clone(), engine.clone(), composer.clone()).unwrap();
        service
            .set_cookie_browser(Some(VideoCookieBrowser::Edge))
            .unwrap();
        let queued_source = service.cookie_source();
        assert_eq!(
            queued_source,
            VideoCookieSource::Browser(VideoCookieBrowser::Edge)
        );

        let restarted = VideoDownloadService::new(downloads, engine, composer).unwrap();
        assert_eq!(
            restarted.engine_status().cookie_browser,
            Some(VideoCookieBrowser::Edge)
        );
        let file = dir.path().join("cookies.txt");
        std::fs::write(&file, "# Netscape HTTP Cookie File\n").unwrap();
        restarted.import_cookies(&file).unwrap();
        assert_eq!(restarted.engine_status().cookie_browser, None);
        assert!(matches!(
            restarted.cookie_source(),
            VideoCookieSource::ManualFile(_)
        ));
        assert_eq!(
            queued_source,
            VideoCookieSource::Browser(VideoCookieBrowser::Edge)
        );

        restarted
            .set_cookie_browser(Some(VideoCookieBrowser::Auto))
            .unwrap();
        restarted.import_cookies(&file).unwrap();
        assert_eq!(
            restarted.engine_status().cookie_browser,
            Some(VideoCookieBrowser::Auto)
        );
        assert_eq!(restarted.cookie_source(), VideoCookieSource::Auto);
    }

    #[test]
    fn auto_source_order_and_bilibili_quality_choice() {
        let dir = tempfile::tempdir().unwrap();
        let manual_path = dir.path().join("cookies.txt");
        let without_manual = auto_cookie_candidates(&manual_path);
        assert_eq!(
            without_manual,
            vec![
                VideoCookieSource::Browser(VideoCookieBrowser::Chrome),
                VideoCookieSource::Browser(VideoCookieBrowser::Edge),
                VideoCookieSource::Browser(VideoCookieBrowser::Firefox),
                VideoCookieSource::None,
            ]
        );
        std::fs::write(&manual_path, "# Netscape HTTP Cookie File\n").unwrap();
        let with_manual = auto_cookie_candidates(&manual_path);
        assert_eq!(with_manual[3], VideoCookieSource::ManualFile(manual_path));
        assert_eq!(with_manual[4], VideoCookieSource::None);

        let successes = vec![
            AutoProbeSuccess {
                source: VideoCookieSource::Browser(VideoCookieBrowser::Chrome),
                height: 360,
            },
            AutoProbeSuccess {
                source: VideoCookieSource::Browser(VideoCookieBrowser::Edge),
                height: 1080,
            },
            AutoProbeSuccess {
                source: VideoCookieSource::Browser(VideoCookieBrowser::Firefox),
                height: 1080,
            },
            AutoProbeSuccess {
                source: VideoCookieSource::None,
                height: 480,
            },
        ];
        assert_eq!(
            choose_auto_cookie_source("https://www.bilibili.com/video/BV1/", &successes),
            Some(VideoCookieSource::Browser(VideoCookieBrowser::Edge))
        );
        assert_eq!(
            choose_auto_cookie_source("https://v.douyin.com/example/", &successes),
            Some(VideoCookieSource::Browser(VideoCookieBrowser::Chrome))
        );
        assert_eq!(
            choose_auto_cookie_source("https://www.xiaohongshu.com/explore/a", &successes),
            Some(VideoCookieSource::Browser(VideoCookieBrowser::Chrome))
        );
    }

    #[test]
    fn auto_probe_uses_isolated_config_and_only_one_cookie_source() {
        let ffmpeg = FfmpegForDownload {
            available: true,
            location: None,
        };
        let url = "https://www.bilibili.com/video/BV1/";
        let browser = auto_probe_args(
            url,
            &VideoCookieSource::Browser(VideoCookieBrowser::Edge),
            &ffmpeg,
        )
        .unwrap();
        assert_eq!(browser[0], "--ignore-config");
        assert!(browser.contains(&"--simulate".to_string()));
        assert!(browser.contains(&"--check-formats".to_string()));
        assert!(browser.contains(&"--no-playlist".to_string()));
        assert!(browser.contains(&"--cookies-from-browser".to_string()));
        assert!(!browser.contains(&"--cookies".to_string()));
        assert!(browser.windows(2).any(|item| item == ["-f", "bv*+ba/b"]));

        let manual = auto_probe_args(
            url,
            &VideoCookieSource::ManualFile(PathBuf::from("private.txt")),
            &ffmpeg,
        )
        .unwrap();
        assert!(manual.contains(&"--cookies".to_string()));
        assert!(!manual.contains(&"--cookies-from-browser".to_string()));
        assert_eq!(manual.last().map(String::as_str), Some(url));

        let guest = auto_probe_args(url, &VideoCookieSource::None, &ffmpeg).unwrap();
        assert!(!guest.contains(&"--cookies".to_string()));
        assert!(!guest.contains(&"--cookies-from-browser".to_string()));
        assert!(
            guest
                .windows(2)
                .any(|item| item == ["-f", "bv*[height<=480]+ba/b[height<=480]/b"])
        );
        assert!(auto_probe_args(url, &VideoCookieSource::Auto, &ffmpeg).is_err());

        let signed_site_url =
            "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a?xsec_token=private-token";
        let site_probe =
            auto_probe_args(signed_site_url, &VideoCookieSource::None, &ffmpeg).unwrap();
        assert!(
            site_probe
                .windows(2)
                .any(|item| item == ["--batch-file", "-"])
        );
        assert!(!site_probe.iter().any(|arg| arg.contains("private-token")));
        let mut direct_args = Vec::new();
        assert!(append_url_input_args(
            &mut direct_args,
            signed_site_url,
            false
        ));
        assert_eq!(
            direct_args,
            vec!["--batch-file".to_string(), "-".to_string()]
        );
        let mut cdn_args = Vec::new();
        assert!(append_url_input_args(
            &mut cdn_args,
            "https://sns-v11.rednotecdn.com/clip.mp4?sig=private-token",
            true,
        ));
        assert_eq!(cdn_args, vec!["--batch-file".to_string(), "-".to_string()]);
    }

    #[test]
    fn manual_cookie_copy_never_changes_original_and_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("cookies.txt");
        std::fs::write(
            &original,
            "# Netscape HTTP Cookie File\nsite\tTRUE\t/\tFALSE\t0\ta\tb\n",
        )
        .unwrap();
        let original_mtime = std::fs::metadata(&original).unwrap().modified().unwrap();
        let private = private_cookie_copy(&original).unwrap();
        let private_path = private.to_path_buf();
        assert_ne!(private_path, original);
        // TempPath 存活期间也须允许 yt-dlp 进程用另一文件句柄打开。
        use std::io::Read as _;
        let mut second_handle = std::fs::File::open(&private_path).unwrap();
        let mut copied = String::new();
        second_handle.read_to_string(&mut copied).unwrap();
        assert!(copied.contains("site\tTRUE"));
        drop(second_handle);
        std::fs::write(&private_path, "yt-dlp rewrote this copy").unwrap();
        assert!(
            std::fs::read_to_string(&original)
                .unwrap()
                .contains("site\tTRUE")
        );
        assert_eq!(
            std::fs::metadata(&original).unwrap().modified().unwrap(),
            original_mtime
        );
        drop(private);
        assert!(!private_path.exists());
    }

    #[test]
    fn auto_probe_height_and_failures_are_sanitized() {
        assert_eq!(parse_probe_height(b"[Bili] extracting\n360\n"), 360);
        assert_eq!(parse_probe_height(b"NA\n"), 0);
        let summary = probe_error_summary(
            "https://example.com/watch",
            b"WARNING: retry\nERROR: HTTP 403 https://example.com/watch?token=secret\n",
            "fallback",
        );
        assert!(summary.contains("[链接已隐藏]"));
        assert!(!summary.contains("secret"));
        let xhs_summary = probe_error_summary(
            "http://xhslink.com/o/example",
            b"ERROR: Unsupported URL: https://www.xiaohongshu.com/404?source=/404/sec_private-token\n",
            "fallback",
        );
        assert!(xhs_summary.contains("/404/sec_"));
        assert!(!xhs_summary.contains("private-token"));
        let xhs_auto_message = auto_failure_message(
            "http://xhslink.com/o/example",
            &[format!("无 Cookies：{xhs_summary}")],
        );
        assert!(xhs_auto_message.contains("安全拦截页"));
        assert!(!xhs_auto_message.contains("private-token"));
        assert_eq!(VideoCookieSource::Auto.credential_source(), None);
        assert_eq!(
            VideoCookieSource::None.credential_source(),
            Some(VideoDownloadCredentialSource::None)
        );
    }

    #[test]
    fn download_diagnostic_redacts_signed_urls_and_auth_headers() {
        assert_eq!(
            sanitize_download_diagnostic("ERROR https://example.com/a?token=secret denied"),
            "ERROR [链接已隐藏] denied"
        );
        assert_eq!(
            sanitize_download_diagnostic("Cookie: SESSDATA=secret"),
            "[认证请求头已隐藏]"
        );
        assert_eq!(
            sanitize_download_diagnostic("ERROR xsec_token=private-token denied"),
            "ERROR [凭据已隐藏] denied"
        );
        assert!(original_fallback_failure(true, "原站错误".into()).contains("原站链接重试也失败"));
    }

    #[test]
    fn douyin_browser_output_requires_exact_video_and_official_cdn() {
        let input = "https://www.douyin.com/video/7672064275116162235";
        let output = serde_json::json!({
            "ok": true,
            "videoId": "7672064275116162235",
            "durationMs": 70636,
            "mediaUrls": [
                "https://v1.douyinvod.com/clip.mp4?sig=private",
                "https://douyinvod.com.evil.example/clip.mp4",
                "http://v2.douyinvod.com/clip.mp4",
            ],
        });
        let video = parse_douyin_browser_output(input, output.to_string().as_bytes()).unwrap();
        assert_eq!(video.video_id, "7672064275116162235");
        assert_eq!(video.duration_ms, 70636);
        assert_eq!(video.media_urls.len(), 1);
        assert!(video.media_urls[0].starts_with("https://v1.douyinvod.com/"));
        let wrong_id = serde_json::json!({
            "ok": true,
            "videoId": "7672064275116162236",
            "durationMs": 70636,
            "mediaUrls": ["https://v1.douyinvod.com/clip.mp4"],
        });
        assert!(parse_douyin_browser_output(input, wrong_id.to_string().as_bytes()).is_none());
        assert_eq!(
            VideoCookieSource::SiteSession.credential_source(),
            Some(VideoDownloadCredentialSource::SiteSession)
        );
    }

    #[test]
    fn ffmpeg_duration_parser_reads_milliseconds() {
        assert_eq!(
            parse_video_duration_ms("Duration: 00:01:10.635, start: 0.000000"),
            Some(70_635)
        );
        assert_eq!(parse_video_duration_ms("Duration: 00:00:01.5"), Some(1500));
        assert_eq!(parse_video_duration_ms("Duration: N/A"), None);
    }

    #[test]
    fn downloaded_site_file_must_start_with_mp4_ftyp() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"\0\0\0\x18ftypisom").unwrap();
        assert!(has_mp4_ftyp(file.path()));
        std::fs::write(file.path(), b"<html>access denied</html>").unwrap();
        assert!(!has_mp4_ftyp(file.path()));
    }

    #[test]
    fn cancelling_during_file_validation_keeps_cancelled_status() {
        let dir = tempfile::tempdir().unwrap();
        let composer = VideoCompositionService::new(
            dir.path().join("downloads"),
            dir.path().join("ffmpeg"),
            dir.path().join("resources"),
        )
        .unwrap();
        let service = VideoDownloadService::new(
            dir.path().join("downloads"),
            dir.path().join("engine"),
            composer,
        )
        .unwrap();
        let job_id = "download-test".to_string();
        service.inner.jobs.lock().unwrap().insert(
            job_id.clone(),
            JobEntry {
                record: VideoDownloadJobRecord {
                    job_id: job_id.clone(),
                    url: "https://www.douyin.com/video/7672064275116162235".into(),
                    status: VideoDownloadStatus::Downloading,
                    progress: None,
                    final_path: None,
                    file_name: None,
                    credential_source: Some(VideoDownloadCredentialSource::SiteSession),
                    probe_status: None,
                    quality_mode: None,
                    quality_hint: None,
                    watermark_removed: false,
                    error: None,
                    created_at: now_ms(),
                    updated_at: now_ms(),
                },
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        service.cancel_job(&job_id).unwrap();
        service.fail_job(&job_id, "late validation failure".into());
        service.update_record(&job_id, |record| {
            record.status = VideoDownloadStatus::Completed
        });
        let record = service.get_job(&job_id).unwrap();
        assert_eq!(record.status, VideoDownloadStatus::Cancelled);
        assert!(record.error.is_none());
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
        assert_eq!(
            sibling_with_suffix(no_ext, "（去水印）").to_string_lossy(),
            r"C:\下载\clip（去水印）"
        );
    }

    /// Explicitly exercise the service task, browser resolver, yt-dlp, and file
    /// acceptance together against public examples. Kept ignored because it
    /// downloads remote media and requires a local verified yt-dlp binary.
    #[tokio::test]
    #[ignore = "requires YT_DLP_TEST_BINARY and live public video pages"]
    async fn official_site_fallback_live_downloads_complete_files() {
        let binary = std::env::var("YT_DLP_TEST_BINARY").expect("set YT_DLP_TEST_BINARY");
        let directory = tempfile::tempdir().unwrap();
        let downloads = directory.path().join("downloads");
        let engine = directory.path().join("engine");
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::copy(binary, engine.join(engine_binary_file_name())).unwrap();
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let composer = VideoCompositionService::new(
            downloads.clone(),
            directory.path().join("ffmpeg"),
            resources.clone(),
        )
        .unwrap();
        let renderer = RemotionRenderService::new(downloads.clone(), resources);
        assert!(renderer.preflight().ready);
        let service = VideoDownloadService::new_with_browser_runtime(
            downloads,
            engine,
            composer,
            Some(renderer),
        )
        .unwrap();
        service
            .set_cookie_browser(Some(VideoCookieBrowser::Auto))
            .unwrap();
        for (url, expected_source, fake_site_cookie) in [
            (
                "https://www.douyin.com/video/7672064275116162235",
                VideoDownloadCredentialSource::SiteSession,
                false,
            ),
            (
                "http://xhslink.com/o/5R8D9WCH5SX",
                VideoDownloadCredentialSource::None,
                false,
            ),
            (
                "https://www.douyin.com/video/7672064275116162235",
                VideoDownloadCredentialSource::Manual,
                true,
            ),
        ] {
            if fake_site_cookie {
                // Synthetic, non-authenticating cookie for an unused official
                // subdomain: exercise imported file -> Rust scoping -> browser
                // stdin -> yt-dlp without using any real account credential.
                let fake = directory.path().join("public-flow-fake-cookies.txt");
                std::fs::write(
                    &fake,
                    "# Netscape HTTP Cookie File\n.codex-auth-test.douyin.com\tTRUE\t/\tTRUE\t0\tpublic_flow_probe\tnot-a-login\n",
                )
                .unwrap();
                service.import_cookies(&fake).unwrap();
            }
            let started = service.start_download(url).unwrap();
            let mut finished = None;
            for _ in 0..600 {
                let record = service.get_job(&started.job_id).unwrap();
                if record.status != VideoDownloadStatus::PreparingEngine
                    && record.status != VideoDownloadStatus::Downloading
                {
                    finished = Some(record);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let record = finished.expect("live download did not finish in 150 seconds");
            assert_eq!(
                record.status,
                VideoDownloadStatus::Completed,
                "{:?}",
                record.error
            );
            assert_eq!(record.credential_source, Some(expected_source));
            let path = Path::new(record.final_path.as_deref().unwrap());
            assert!(path.is_file() && has_mp4_ftyp(path));
        }
    }
}
