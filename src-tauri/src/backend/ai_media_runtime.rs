//! Optional, pinned local inference runtime. Neither PATH Python nor an untrusted manifest
//! may become an inference executable.
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    ai_media::AiMediaMode,
    error::{BackendError, BackendResult},
    runtime_components::RuntimeComponent,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaRuntimeStatus {
    pub mode: AiMediaMode,
    pub ready: bool,
    pub root_path: Option<String>,
    pub error: Option<String>,
    pub video_depth_ready: bool,
    pub audio_separation_ready: bool,
    pub version: Option<String>,
}

#[derive(Clone)]
pub struct AiMediaRuntime {
    lite: RuntimeComponent,
    quality: RuntimeComponent,
    store: PathBuf,
}

pub struct ResolvedAiMediaRuntime {
    pub root: PathBuf,
    pub python: PathBuf,
    pub worker: PathBuf,
    pub models: PathBuf,
    pub code: PathBuf,
}

impl AiMediaRuntime {
    pub fn new(app_local_data_dir: PathBuf, resource_dir: PathBuf) -> Self {
        #[cfg(debug_assertions)]
        let resource_dir = {
            let _ = resource_dir;
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
        };
        Self::from_resources(app_local_data_dir, resource_dir)
    }
    fn from_resources(app_local_data_dir: PathBuf, resource_dir: PathBuf) -> Self {
        let store = app_local_data_dir.join("runtime-components");
        Self {
            lite: RuntimeComponent::new(
                store.clone(),
                resource_dir.join("ai-media-runtime"),
                "ai-media-runtime",
                "runtime-manifest.json",
            ),
            quality: RuntimeComponent::new(
                store.clone(),
                resource_dir.join("ai-media-quality-runtime"),
                "ai-media-quality-runtime",
                "runtime-manifest.json",
            ),
            store,
        }
    }

    pub fn status(&self, mode: AiMediaMode) -> AiMediaRuntimeStatus {
        match self.resolve(mode) {
            Ok(runtime) => AiMediaRuntimeStatus {
                mode,
                ready: true,
                root_path: Some(runtime.root.to_string_lossy().into_owned()),
                error: None,
                video_depth_ready: true,
                audio_separation_ready: true,
                version: Some(
                    if mode == AiMediaMode::Lite {
                        "ai-media-onnx-v1"
                    } else {
                        "ai-media-v1"
                    }
                    .into(),
                ),
            },
            Err(error) => AiMediaRuntimeStatus {
                mode,
                ready: false,
                root_path: None,
                error: Some(error.to_string()),
                video_depth_ready: false,
                audio_separation_ready: false,
                version: None,
            },
        }
    }

    pub fn resolve(&self, mode: AiMediaMode) -> BackendResult<ResolvedAiMediaRuntime> {
        let (pin, inventory_pin) = pins(mode);
        if pin.is_empty() || inventory_pin.is_empty() {
            return Err(invalid(
                "此应用版本未配置对应模式的运行包校验信息，请先更新应用，再导入与版本匹配的独立 AI 媒体组件。",
            ));
        }
        let (component, ready) = self.component(mode);
        let root = component.resolve(ready).ok_or_else(|| invalid("连续深度与 AI 音轨分离运行包未安装，或版本/文件校验失败。请导入与当前版本匹配的运行包。"))?;
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("runtime-manifest.json"))?)?;
        Ok(ResolvedAiMediaRuntime {
            python: root.join(
                relative(manifest["pythonPath"].as_str().unwrap_or_default())
                    .ok_or_else(|| invalid("运行包 Python 路径无效。"))?,
            ),
            worker: root.join("worker/worker.py"),
            models: root.join("models"),
            code: root.join(if mode == AiMediaMode::Lite {
                "code"
            } else {
                "code/video-depth-anything"
            }),
            root,
        })
    }

    pub async fn import(
        &self,
        root_path: &str,
        mode: AiMediaMode,
    ) -> BackendResult<AiMediaRuntimeStatus> {
        let (pin, inventory) = pins(mode);
        if pin.is_empty() || inventory.is_empty() {
            return Err(invalid(
                "此应用版本未配置对应模式的运行包校验信息，请先更新应用，再导入与版本匹配的独立 AI 媒体组件。",
            ));
        }
        let root = PathBuf::from(root_path);
        if !root.is_absolute() || !root.is_dir() {
            return Err(invalid("请选择 AI 媒体运行包的完整本地目录。"));
        }
        let component = RuntimeComponent::new(
            self.store.clone(),
            root,
            if mode == AiMediaMode::Lite {
                "ai-media-runtime"
            } else {
                "ai-media-quality-runtime"
            },
            "runtime-manifest.json",
        );
        let ready: fn(&Path) -> bool = if mode == AiMediaMode::Lite {
            runtime_ready
        } else {
            quality_runtime_ready
        };
        tokio::task::spawn_blocking(move || component.migrate(ready, |_, _| {}))
            .await
            .map_err(|error| invalid(&format!("运行包导入任务失败：{error}")))?
            .map_err(|error| invalid(&error))?;
        let status = self.status(mode);
        if !status.ready {
            return Err(invalid(status.error.as_deref().unwrap_or("运行包不可用。")));
        }
        Ok(status)
    }
    fn component(&self, mode: AiMediaMode) -> (&RuntimeComponent, fn(&Path) -> bool) {
        match mode {
            AiMediaMode::Lite => (&self.lite, runtime_ready),
            AiMediaMode::Quality => (&self.quality, quality_runtime_ready),
        }
    }
}

fn pins(mode: AiMediaMode) -> (&'static str, &'static str) {
    match mode {
        AiMediaMode::Lite => (
            option_env!("IC_AI_MEDIA_MANIFEST_SHA256").unwrap_or(""),
            option_env!("IC_AI_MEDIA_INVENTORY_SHA256").unwrap_or(""),
        ),
        AiMediaMode::Quality => (
            option_env!("IC_AI_MEDIA_QUALITY_MANIFEST_SHA256").unwrap_or(""),
            option_env!("IC_AI_MEDIA_QUALITY_INVENTORY_SHA256").unwrap_or(""),
        ),
    }
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

pub(crate) fn relative(path: &str) -> Option<PathBuf> {
    let value = Path::new(path);
    if path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || value.is_absolute()
        || !value
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return None;
    }
    Some(value.to_path_buf())
}

pub(crate) fn runtime_ready(root: &Path) -> bool {
    profile_ready(root, AiMediaMode::Lite)
}
pub(crate) fn quality_runtime_ready(root: &Path) -> bool {
    profile_ready(root, AiMediaMode::Quality)
}
fn profile_ready(root: &Path, mode: AiMediaMode) -> bool {
    let (pin, inventory_pin) = pins(mode);
    if pin.len() != 64 || inventory_pin.len() != 64 {
        return false;
    }
    let path = root.join("runtime-manifest.json");
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if metadata.len() > 2 * 1024 * 1024 {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if hex::encode(Sha256::digest(&bytes)) != pin {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    if value["schemaVersion"] != 1
        || value["runtimeVersion"]
            != if mode == AiMediaMode::Lite {
                "ai-media-onnx-v1"
            } else {
                "ai-media-v1"
            }
        || value["runtimeProfile"]
            != if mode == AiMediaMode::Lite {
                "lite"
            } else {
                "quality"
            }
        || value["platform"] != platform
        || value["arch"] != arch
        || value["workerPath"] != "worker/worker.py"
        || value["modelRoot"] != "models"
        || value["codeRoot"]
            != if mode == AiMediaMode::Lite {
                "code"
            } else {
                "code/video-depth-anything"
            }
        || value["inventory"]["path"] != "files-manifest.json"
        || value["inventory"]["sha256"].as_str() != Some(inventory_pin)
    {
        return false;
    }
    let Some(python) = value["pythonPath"].as_str().and_then(relative) else {
        return false;
    };
    if !root.join(python).is_file()
        || !root.join("worker/worker.py").is_file()
        || !root.join("files-manifest.json").is_file()
    {
        return false;
    }
    let Some(models) = value["models"].as_array() else {
        return false;
    };
    let depth = models.iter().any(|m| {
        m["id"] == "video-depth-anything-small"
            && m["license"] == "Apache-2.0"
            && m["path"]
                .as_str()
                .and_then(relative)
                .is_some_and(|path| root.join(path).is_file())
    });
    let audio = models.iter().any(|m| {
        m["id"]
            == if mode == AiMediaMode::Lite {
                "open-unmix-hq"
            } else {
                "htdemucs"
            }
            && m["license"] == "MIT"
            && m["path"]
                .as_str()
                .and_then(relative)
                .is_some_and(|path| root.join(path).is_file())
    });
    depth && audio && inventory_membership_valid(root, inventory_pin)
}

struct TreeMembership {
    inventory_pin: String,
    directories: Vec<(PathBuf, SystemTime)>,
}
fn inventory_membership_valid(root: &Path, inventory_pin: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, TreeMembership>>> = OnceLock::new();
    let Ok(canonical) = root.canonicalize() else {
        return false;
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if cache.get(&canonical).is_some_and(|cached| {
            cached.inventory_pin == inventory_pin
                && cached.directories.iter().all(|(path, stamp)| {
                    path.symlink_metadata().is_ok_and(|metadata| {
                        !is_link(&metadata)
                            && metadata.is_dir()
                            && metadata.modified().ok().as_ref() == Some(stamp)
                    })
                })
        }) {
            return true;
        }
    }
    let inventory_path = root.join("files-manifest.json");
    let Ok(metadata) = inventory_path.symlink_metadata() else {
        return false;
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > 32 * 1024 * 1024 {
        return false;
    }
    let Ok(bytes) = std::fs::read(&inventory_path) else {
        return false;
    };
    if hex::encode(Sha256::digest(&bytes)) != inventory_pin {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let Some(files) = value.as_array() else {
        return false;
    };
    let mut allowed = HashSet::new();
    for file in files {
        let Some(path) = file["path"].as_str().and_then(relative) else {
            return false;
        };
        if !allowed.insert(path) {
            return false;
        }
    }
    allowed.insert(PathBuf::from("runtime-manifest.json"));
    allowed.insert(PathBuf::from("files-manifest.json"));
    let mut missing = allowed.clone();
    allowed.insert(PathBuf::from(".complete.json"));
    let mut directories = Vec::new();
    fn walk(
        root: &Path,
        path: &Path,
        allowed: &HashSet<PathBuf>,
        missing: &mut HashSet<PathBuf>,
        directories: &mut Vec<(PathBuf, SystemTime)>,
    ) -> Result<(), ()> {
        let metadata = path.symlink_metadata().map_err(|_| ())?;
        if is_link(&metadata) || !path.canonicalize().map_err(|_| ())?.starts_with(root) {
            return Err(());
        }
        if metadata.is_dir() {
            directories.push((path.to_path_buf(), metadata.modified().map_err(|_| ())?));
            for entry in std::fs::read_dir(path).map_err(|_| ())? {
                walk(
                    root,
                    &entry.map_err(|_| ())?.path(),
                    allowed,
                    missing,
                    directories,
                )?;
            }
        } else {
            let relative = path.strip_prefix(root).map_err(|_| ())?;
            if !metadata.is_file() || !allowed.contains(relative) {
                return Err(());
            }
            missing.remove(relative);
        }
        Ok(())
    }
    if walk(
        &canonical,
        &canonical,
        &allowed,
        &mut missing,
        &mut directories,
    )
    .is_err()
        || !missing.is_empty()
    {
        return false;
    }
    if let Ok(mut cache) = cache.lock() {
        cache.insert(
            canonical,
            TreeMembership {
                inventory_pin: inventory_pin.into(),
                directories,
            },
        );
    }
    true
}
fn is_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_paths_cannot_escape_or_invoke_an_external_python() {
        for path in [
            "../python.exe",
            "/usr/bin/python3",
            "C:/python.exe",
            "a/../../p",
            "python\\python.exe",
            "",
        ] {
            assert!(relative(path).is_none(), "{path}");
        }
        assert_eq!(
            relative("python/python.exe"),
            Some(PathBuf::from("python/python.exe"))
        );
    }
    #[test]
    fn missing_runtime_is_explicitly_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let runtime =
            AiMediaRuntime::from_resources(temp.path().join("data"), temp.path().join("resources"));
        let status = runtime.status(AiMediaMode::Lite);
        assert!(!status.ready);
        assert!(!status.video_depth_ready);
        assert!(status.error.is_some());
        assert!(runtime.resolve(AiMediaMode::Lite).is_err());
        assert!(runtime.resolve(AiMediaMode::Quality).is_err());
    }
    #[test]
    fn complete_inventory_rejects_unlisted_python_even_after_membership_was_cached() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("worker")).unwrap();
        std::fs::write(temp.path().join("worker/worker.py"), b"pass").unwrap();
        std::fs::write(temp.path().join("runtime-manifest.json"), b"{}").unwrap();
        let inventory=serde_json::to_vec(&serde_json::json!([{"path":"worker/worker.py","sha256":"unused-in-membership-test","bytes":4}])).unwrap();
        let pin = hex::encode(Sha256::digest(&inventory));
        std::fs::write(temp.path().join("files-manifest.json"), inventory).unwrap();
        assert!(inventory_membership_valid(temp.path(), &pin));
        std::fs::write(
            temp.path().join("worker/injected.py"),
            b"print('unexpected')",
        )
        .unwrap();
        assert!(!inventory_membership_valid(temp.path(), &pin));
    }
}
