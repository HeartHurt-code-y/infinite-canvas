//! 画布视频合成：内置 FFmpeg 引擎的确定性合成服务。
//!
//! 引擎策略：安装包内置构建优先；精简更新包没有内置资源时，从应用数据目录
//! 的已校验版本化组件仓库加载；两者均不可用时沿用原有的下载目录，首次使用
//! （或用户手动触发）时把官方独立构建的 FFmpeg 下载到应用数据目录。下载与解包复用
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

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use super::error::{BackendError, BackendResult};

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// FFmpeg 引擎状态。视频合成（video_composer）节点已下线，前端不再消费该枚举，
/// 因此不再导出 TS 绑定。
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

#[derive(Debug)]
struct EngineRuntime {
    installing: bool,
    last_error: Option<String>,
}

struct Inner {
    engine: std::sync::Mutex<EngineRuntime>,
    /// 串行化引擎安装，避免并发重复下载二进制。
    engine_lock: AsyncMutex<()>,
    /// 可写引擎目录（应用数据目录）；下载回退的落点与版本记录位置。
    engine_dir: PathBuf,
    /// 安装包资源目录（只读）。其 `ffmpeg/` 子目录为构建期预置的内置引擎。
    resource_dir: PathBuf,
}

/// ffprobe 是否为本平台的必备引擎文件。
///
/// macOS 的 ffmpeg 发行包（evermeet.cx / osxexperts.net）只打包 ffmpeg；
/// `ffmpeg-sidecar` 的下载解包在 macOS 上同样只有 ffmpeg。把 ffprobe 当成
/// 硬性条件会导致：内置引擎被判定“不完整” → 每次调用都重下一份 22–100 MiB
/// 的归档，而且永远凑不齐。因此 macOS 上 ffprobe 属于“有则更好”，
/// 缺失时由 `probe_media_via_ffmpeg` 用 `ffmpeg -i` 兜底。
const FFPROBE_REQUIRED: bool = !cfg!(target_os = "macos");

/// 引擎目录是否可用：必须有 ffmpeg，ffprobe 按平台要求。
pub(crate) fn engine_ready_in(directory: &Path) -> bool {
    let ffmpeg = directory.join(VideoCompositionService::ffmpeg_binary_name());
    if !ffmpeg.is_file() {
        return false;
    }
    !FFPROBE_REQUIRED
        || directory
            .join(VideoCompositionService::ffprobe_binary_name())
            .is_file()
}

/// 画布视频合成服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoCompositionService {
    inner: Arc<Inner>,
}

/// 即使异步探测被取消，也移除临时媒体副本。

impl VideoCompositionService {
    /// FFmpeg 合成引擎安装包内置构建（resources/ffmpeg）优先；缺失时回退到应用
    /// 数据目录并按官方构建下载。功能组件下载已下线，因此不再有版本化运行时组件。
    ///
    /// 视频合成任务（`video_composer` 节点）已下线，本服务现在只负责**引擎**：
    /// 合成、抽帧、下载转码都从这里取 ffmpeg 可执行文件。
    pub fn new(engine_dir: PathBuf, resource_dir: PathBuf) -> BackendResult<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                engine: std::sync::Mutex::new(EngineRuntime {
                    installing: false,
                    last_error: None,
                }),
                engine_lock: AsyncMutex::new(()),
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

    /// 内置引擎是否完整可用。
    fn has_builtin_engine(&self) -> bool {
        engine_ready_in(&self.builtin_engine_dir())
    }

    /// 生效引擎目录：内置构建优先，其次是下载目录。
    fn active_engine_dir(&self) -> PathBuf {
        if self.has_builtin_engine() {
            return self.builtin_engine_dir();
        }
        self.inner.engine_dir.clone()
    }

    fn ffmpeg_binary(&self) -> PathBuf {
        self.active_engine_dir().join(Self::ffmpeg_binary_name())
    }

    /// 版本记录写在可写的旧引擎目录。非下载引擎还需匹配二进制的路径、
    /// 大小和修改时间，防止切换到持久化组件后沿用上一个引擎的版本。
    fn installed_version(&self) -> Option<String> {
        let binary = self.ffmpeg_binary();
        let recorded = std::fs::read_to_string(self.inner.engine_dir.join("version-source.txt"));
        match recorded {
            Ok(recorded) if recorded.trim() != Self::binary_fingerprint(&binary)? => return None,
            Err(_) if binary.parent()? != self.inner.engine_dir => return None,
            _ => {}
        }
        std::fs::read_to_string(self.inner.engine_dir.join("version.txt"))
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    }

    fn binary_fingerprint(binary: &Path) -> Option<String> {
        let metadata = std::fs::metadata(binary).ok()?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos();
        Some(format!(
            "{}:{}:{modified}",
            binary.display(),
            metadata.len()
        ))
    }

    /// 汇总当前引擎状态。版本以 version.txt 为准，不在这里探测（命令线程禁止阻塞）。
    pub fn engine_status(&self) -> VideoComposerEngineStatus {
        let binary_exists = self.ffmpeg_binary().is_file();
        let runtime = self
            .inner
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
            let mut runtime = self
                .inner
                .engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
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
            if engine_ready_in(&self.active_engine_dir()) {
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
            let mut runtime = self
                .inner
                .engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let binary = self.ffmpeg_binary();
        let reported = self.probe_binary_version(&binary).await?;
        tokio::fs::write(self.inner.engine_dir.join("version.txt"), &reported).await?;
        if let Some(fingerprint) = Self::binary_fingerprint(&binary) {
            tokio::fs::write(
                self.inner.engine_dir.join("version-source.txt"),
                fingerprint,
            )
            .await?;
        }
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

    // ---------- 合成任务 ----------
}
