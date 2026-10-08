//! A build-pinned component catalog extends the existing native runtime trust chain.
//! Downloads and extracted trees remain unpublished until both trust layers validate.
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use fs2::FileExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use url::Url;
use uuid::Uuid;

use super::component_archive::{
    ComponentFile, check_cancel, extract_zip, hash_file, is_link, safe_relative, valid_sha256,
    validate_files, verify_tree,
};
use super::component_download::download_zip;
use super::runtime_components::RuntimeComponent;

const IDS: [&str; 7] = [
    "blender",
    "remotion-runtime",
    "ffmpeg",
    "gpt-image-2-style-library",
    "ai-media-runtime",
    "ai-media-quality-runtime",
    "pose-runtime",
];
const FEATURES: [(&str, &str, &[&str]); 8] = [
    ("white-model-render", "白模渲染", &["blender", "ffmpeg"]),
    ("motion-capture", "动作捕捉", &["pose-runtime"]),
    (
        "image-style-library",
        "图片风格案例库",
        &["gpt-image-2-style-library"],
    ),
    ("animation-render", "动画渲染", &["remotion-runtime"]),
    ("browser-download", "浏览器素材下载", &["remotion-runtime"]),
    ("media-processing", "媒体处理", &["ffmpeg"]),
    (
        "ai-media-lite",
        "AI 媒体轻量组件",
        &["ai-media-runtime", "ffmpeg"],
    ),
    (
        "ai-media-quality",
        "AI 媒体质量组件",
        &["ai-media-quality-runtime", "ffmpeg"],
    ),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentCatalog {
    schema_version: u32,
    application_version: String,
    platform: String,
    components: Vec<CatalogComponent>,
    features: Vec<CatalogFeature>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogComponent {
    id: String,
    title: String,
    description: String,
    version: String,
    manifest_path: String,
    manifest_sha256: String,
    bundle_path: String,
    dependencies: Vec<String>,
    archive: CatalogArchive,
    files: Vec<ComponentFile>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogArchive {
    format: String,
    url: String,
    size: u64,
    sha256: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogFeature {
    id: String,
    title: String,
    components: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManagerStatus {
    pub edition: String,
    pub catalog_ready: bool,
    pub catalog_error: Option<String>,
    pub components: Vec<RuntimeComponentStatus>,
    pub transfer: ComponentTransferStatus,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponentStatus {
    pub id: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub state: String,
    pub root_path: Option<String>,
    pub installed_bytes: u64,
    pub download_bytes: u64,
    pub dependencies: Vec<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFeatureStatus {
    pub id: String,
    pub title: String,
    pub ready: bool,
    pub missing_components: Vec<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentTransferStatus {
    pub active: bool,
    pub component_id: Option<String>,
    pub phase: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub reused_bytes: u64,
    pub downloaded_bytes: u64,
    pub error: Option<String>,
}
impl Default for ComponentTransferStatus {
    fn default() -> Self {
        Self {
            active: false,
            component_id: None,
            phase: "idle".into(),
            completed_bytes: 0,
            total_bytes: 0,
            reused_bytes: 0,
            downloaded_bytes: 0,
            error: None,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    path: PathBuf,
    bytes: u64,
    modified: Option<SystemTime>,
    directory: bool,
    link: bool,
    #[cfg(unix)]
    mode: u32,
}
#[derive(Clone)]
struct CachedComponent {
    root: Option<PathBuf>,
    bytes: u64,
    error: Option<String>,
    stamps: Vec<Stamp>,
}
struct Inner {
    data: PathBuf,
    resources: PathBuf,
    native: HashMap<&'static str, RuntimeComponent>,
    catalog: Result<ComponentCatalog, String>,
    edition: String,
    cache: Mutex<HashMap<String, CachedComponent>>,
    checking: Mutex<HashSet<String>>,
    verification_gate: Mutex<()>,
    generation: AtomicU64,
    transfer: Mutex<ComponentTransferStatus>,
    cancel: Mutex<Arc<AtomicBool>>,
}
#[derive(Clone)]
pub struct ComponentManager {
    inner: Arc<Inner>,
}

fn spec(id: &str) -> Option<(&'static str, &'static str, &'static str, fn(&Path) -> bool)> {
    match id {
        "blender" => Some((
            "blender",
            "blender",
            "manifest.json",
            super::blender::blender_runtime_ready,
        )),
        "remotion-runtime" => Some((
            "remotion-runtime",
            "remotion-runtime",
            "runtime-manifest.json",
            super::remotion_renderer::runtime_ready,
        )),
        "ffmpeg" => Some((
            "ffmpeg",
            "ffmpeg",
            "manifest.json",
            super::composer::engine_ready_in,
        )),
        "gpt-image-2-style-library" => Some((
            "gpt-image-2-style-library",
            "skills/gpt-image-2-style-library",
            "data/manifest.json",
            super::gpt_image_style_library::style_component_ready,
        )),
        "ai-media-runtime" => Some((
            "ai-media-runtime",
            "ai-media-runtime",
            "runtime-manifest.json",
            super::ai_media_runtime::runtime_ready,
        )),
        "ai-media-quality-runtime" => Some((
            "ai-media-quality-runtime",
            "ai-media-quality-runtime",
            "runtime-manifest.json",
            super::ai_media_runtime::quality_runtime_ready,
        )),
        "pose-runtime" => Some((
            "pose-runtime",
            "pose-runtime",
            "runtime-manifest.json",
            pose_runtime_ready,
        )),
        _ => None,
    }
}
fn native_pin(id: &str) -> &'static str {
    match id {
        "blender" => env!("IC_BLENDER_MANIFEST_SHA256"),
        "remotion-runtime" => env!("IC_REMOTION_MANIFEST_SHA256"),
        "ffmpeg" => env!("IC_FFMPEG_MANIFEST_SHA256"),
        "gpt-image-2-style-library" => env!("IC_STYLE_MANIFEST_SHA256"),
        "ai-media-runtime" => env!("IC_AI_MEDIA_MANIFEST_SHA256"),
        "ai-media-quality-runtime" => env!("IC_AI_MEDIA_QUALITY_MANIFEST_SHA256"),
        "pose-runtime" => option_env!("IC_POSE_MANIFEST_SHA256").unwrap_or(""),
        _ => "",
    }
}
fn dependencies(id: &str) -> Vec<String> {
    if matches!(
        id,
        "blender" | "ai-media-runtime" | "ai-media-quality-runtime"
    ) {
        vec!["ffmpeg".into()]
    } else {
        vec![]
    }
}
fn archive_url(catalog: &ComponentCatalog, component: &CatalogComponent) -> Result<Url, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|error| error.to_string())?;
    let trusted = Url::parse(
        config["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .ok_or("内置更新源缺失")?,
    )
    .map_err(|error| error.to_string())?;
    let url = Url::parse(&component.archive.url).map_err(|_| "组件下载地址无效")?;
    let expected_path = format!(
        "/infinite-canvas/updates/components/{}/{}/{}-{}.zip",
        catalog.platform, catalog.application_version, component.id, component.archive.sha256
    );
    if url.scheme() != "https"
        || url.host_str() != trusted.host_str()
        || url.port_or_known_default() != trusted.port_or_known_default()
        || url.path() != expected_path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("组件下载地址不属于当前版本的可信更新源".into());
    }
    Ok(url)
}
fn load_catalog(resources: &Path) -> Result<ComponentCatalog, String> {
    let expected = option_env!("IC_COMPONENT_CATALOG_SHA256").unwrap_or("");
    if !valid_sha256(expected) {
        return Err("当前应用没有受信任的组件目录".into());
    }
    let path = resources.join("component-catalog.json");
    let metadata = path.symlink_metadata().map_err(|_| "组件目录文件缺失")?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err("组件目录路径或大小无效".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return Err("组件目录与应用内置信任摘要不匹配".into());
    }
    let catalog: ComponentCatalog =
        serde_json::from_slice(&bytes).map_err(|error| format!("组件目录格式无效：{error}"))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}
fn validate_catalog(catalog: &ComponentCatalog) -> Result<(), String> {
    if catalog.schema_version != 1
        || catalog.application_version != env!("CARGO_PKG_VERSION")
        || Some(catalog.platform.as_str())
            != component_platform(std::env::consts::OS, std::env::consts::ARCH)
        || catalog.components.len() != IDS.len()
        || catalog.features.len() != FEATURES.len()
    {
        return Err("组件目录与当前应用版本或平台不匹配".into());
    }
    let mut ids = HashSet::new();
    for component in &catalog.components {
        let (_, bundle, manifest, _) = spec(&component.id).ok_or("组件目录含未知组件")?;
        if !ids.insert(component.id.as_str())
            || component.bundle_path != bundle
            || component.manifest_path != manifest
            || component.dependencies != dependencies(&component.id)
            || component.title.trim().is_empty()
            || component.title.len() > 256
            || component.description.len() > 4096
            || component.version.is_empty()
            || component.version.len() > 128
            || !valid_sha256(&component.manifest_sha256)
            || component.manifest_sha256 != native_pin(&component.id)
            || component.archive.format != "zip"
            || !valid_sha256(&component.archive.sha256)
            || component.archive.size == 0
            || component.archive.size > 8 * 1024 * 1024 * 1024
        {
            return Err(format!("组件 {} 的版本、信任摘要或依赖无效", component.id));
        }
        safe_relative(&component.bundle_path)?;
        validate_files(&component.files)?;
        if component.files.iter().any(|file| {
            if cfg!(target_os = "macos") {
                file.mode.is_none()
            } else {
                file.is_symlink()
            }
        }) {
            return Err("组件文件类型或权限与当前平台不匹配".into());
        }
        if !component.files.iter().any(|file| {
            file.path == manifest
                && file.sha256 == component.manifest_sha256
                && file.size <= 2 * 1024 * 1024
        }) {
            return Err("组件目录未包含受信任原生清单".into());
        }
        archive_url(catalog, component)?;
    }
    let mut features = HashSet::new();
    for feature in &catalog.features {
        let (_, _, required) = FEATURES
            .iter()
            .find(|(id, _, _)| *id == feature.id)
            .ok_or("组件目录含未知功能")?;
        if !features.insert(feature.id.as_str())
            || feature.title.trim().is_empty()
            || feature.title.len() > 256
            || feature
                .components
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                != *required
        {
            return Err("组件目录功能依赖与当前应用不匹配".into());
        }
    }
    for id in IDS {
        dependency_closure(catalog, id)?;
    }
    Ok(())
}
fn component_platform(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        _ => None,
    }
}
fn dependency_closure(
    catalog: &ComponentCatalog,
    id: &str,
) -> Result<Vec<CatalogComponent>, String> {
    fn visit(
        catalog: &ComponentCatalog,
        id: &str,
        visiting: &mut HashSet<String>,
        seen: &mut HashSet<String>,
        result: &mut Vec<CatalogComponent>,
    ) -> Result<(), String> {
        if seen.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.into()) {
            return Err("组件依赖存在循环".into());
        }
        let component = catalog
            .components
            .iter()
            .find(|component| component.id == id)
            .ok_or("组件不存在")?;
        for dependency in &component.dependencies {
            visit(catalog, dependency, visiting, seen, result)?;
        }
        visiting.remove(id);
        seen.insert(id.into());
        result.push(component.clone());
        Ok(())
    }
    let mut result = Vec::new();
    visit(
        catalog,
        id,
        &mut HashSet::new(),
        &mut HashSet::new(),
        &mut result,
    )?;
    Ok(result)
}

pub(crate) fn pose_runtime_ready(root: &Path) -> bool {
    let manifest_pin = option_env!("IC_POSE_MANIFEST_SHA256").unwrap_or("");
    let inventory_pin = option_env!("IC_POSE_INVENTORY_SHA256").unwrap_or("");
    if !valid_sha256(manifest_pin) || !valid_sha256(inventory_pin) {
        return false;
    }
    let Ok(bytes) = fs::read(root.join("runtime-manifest.json")) else {
        return false;
    };
    if bytes.len() > 2 * 1024 * 1024 || hex::encode(Sha256::digest(&bytes)) != manifest_pin {
        return false;
    }
    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    if manifest["schemaVersion"] != 1
        || manifest["component"] != "pose-runtime"
        || manifest["inventory"]["path"] != "files-manifest.json"
        || manifest["inventory"]["sha256"].as_str() != Some(inventory_pin)
        || manifest["inventory"]["count"] != 6
        || manifest["runtime"]["package"] != "@mediapipe/tasks-vision"
        || manifest["runtime"]["wasmPath"] != "wasm"
        || manifest["model"]["path"] != "pose_landmarker_full.task"
    {
        return false;
    }
    let Ok(inventory) = fs::read(root.join("files-manifest.json")) else {
        return false;
    };
    if inventory.len() > 16 * 1024 * 1024 || hex::encode(Sha256::digest(inventory)) != inventory_pin
    {
        return false;
    }
    [
        "wasm/vision_wasm_internal.js",
        "wasm/vision_wasm_internal.wasm",
        "wasm/vision_wasm_nosimd_internal.js",
        "wasm/vision_wasm_nosimd_internal.wasm",
        "pose_landmarker_full.task",
        "LICENSE.txt",
    ]
    .iter()
    .all(|path| {
        root.join(path)
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_file() && !is_link(&metadata))
    })
}

fn stamp(path: PathBuf) -> Stamp {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    match path.symlink_metadata() {
        Ok(metadata) => Stamp {
            path,
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
            directory: metadata.is_dir(),
            link: is_link(&metadata),
            #[cfg(unix)]
            mode: metadata.permissions().mode(),
        },
        Err(_) => Stamp {
            path,
            bytes: 0,
            modified: None,
            directory: false,
            link: false,
            #[cfg(unix)]
            mode: 0,
        },
    }
}
fn unchanged(stamps: &[Stamp]) -> bool {
    stamps.iter().all(|old| *old == stamp(old.path.clone()))
}
fn critical_stamps(root: &Path, manifest: &str) -> Vec<Stamp> {
    let mut paths = vec![
        PathBuf::new(),
        PathBuf::from(manifest),
        PathBuf::from("files-manifest.json"),
        PathBuf::from(".complete.json"),
    ];
    // Metadata for the manifest, inventory and executable entry points is cheap to poll.
    // A full inventory scan runs on first use and every explicit repair operation.
    for path in [
        "blender.exe",
        "blender.app/Contents/MacOS/Blender",
        "ffmpeg.exe",
        "ffprobe.exe",
        "ffmpeg",
        "ffprobe",
        "node/node.exe",
        "node.exe",
        "browser/chrome-headless-shell.exe",
        "node/bin/node",
        "python/python.exe",
        "python/bin/python3",
        "worker/worker.py",
        "render.mjs",
        "pose_landmarker_full.task",
        "wasm/vision_wasm_internal.wasm",
        "wasm/vision_wasm_nosimd_internal.wasm",
        "wasm/vision_wasm_internal.js",
        "wasm/vision_wasm_nosimd_internal.js",
        "data/cases.json",
        "data/templates.json",
    ] {
        if root.join(path).exists() {
            paths.push(PathBuf::from(path));
        }
    }
    if let Ok(bytes) = fs::read(root.join(manifest)) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            for key in [
                "executable",
                "pythonPath",
                "workerPath",
                "browserExecutable",
            ] {
                if let Some(path) = value[key]
                    .as_str()
                    .and_then(|value| safe_relative(value).ok())
                {
                    paths.push(path);
                }
            }
        }
    }
    paths
        .into_iter()
        .map(|relative| stamp(root.join(relative)))
        .collect()
}

impl ComponentManager {
    pub fn new(data_dir: PathBuf, resource_dir: PathBuf) -> Self {
        let catalog = load_catalog(&resource_dir);
        let native = IDS
            .into_iter()
            .map(|id| {
                let (name, bundle, manifest, _) = spec(id).unwrap();
                (
                    name,
                    RuntimeComponent::new(
                        data_dir.join("runtime-components"),
                        resource_dir.join(bundle),
                        name,
                        manifest,
                    ),
                )
            })
            .collect();
        Self {
            inner: Arc::new(Inner {
                data: data_dir,
                resources: resource_dir,
                native,
                catalog,
                edition: option_env!("IC_DISTRIBUTION_EDITION")
                    .unwrap_or("offline")
                    .into(),
                cache: Mutex::new(HashMap::new()),
                checking: Mutex::new(HashSet::new()),
                verification_gate: Mutex::new(()),
                generation: AtomicU64::new(0),
                transfer: Mutex::new(ComponentTransferStatus::default()),
                cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            }),
        }
    }
    fn runtime_component(&self, id: &str) -> Result<(RuntimeComponent, fn(&Path) -> bool), String> {
        let (name, _, _, ready) = spec(id).ok_or("组件不存在")?;
        Ok((
            self.inner.native.get(name).ok_or("组件不存在")?.clone(),
            ready,
        ))
    }
    fn probe_stamps(&self, id: &str) -> Vec<Stamp> {
        let (_, bundle, manifest, _) = spec(id).expect("validated component ID");
        let mut stamps = critical_stamps(&self.inner.resources.join(bundle), manifest);
        let parent = self.inner.data.join("runtime-components").join(id);
        stamps.push(stamp(parent.clone()));
        stamps.extend(critical_stamps(&parent.join(native_pin(id)), manifest));
        stamps
    }
    fn verify_now(&self, id: &str, force: bool) -> CachedComponent {
        self.verify_with_cancel(id, force, &AtomicBool::new(false))
    }
    fn verify_with_cancel(&self, id: &str, force: bool, cancel: &AtomicBool) -> CachedComponent {
        let _gate = loop {
            if check_cancel(cancel).is_err() {
                return CachedComponent {
                    root: None,
                    bytes: 0,
                    error: Some("组件安装已取消".into()),
                    stamps: vec![],
                };
            }
            match self.inner.verification_gate.try_lock() {
                Ok(gate) => break gate,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(error) => panic!("component verification mutex poisoned: {error}"),
            }
        };
        if !force {
            if let Some(cached) = self
                .inner
                .cache
                .lock()
                .unwrap()
                .get(id)
                .filter(|cached| unchanged(&cached.stamps))
                .cloned()
            {
                return cached;
            }
        }
        let generation = self.inner.generation.load(Ordering::Acquire);
        let (_, bundle, manifest, _) = spec(id).expect("validated component ID");
        let (runtime, ready) = self.runtime_component(id).expect("validated component ID");
        let catalog_component = self.inner.catalog.as_ref().ok().and_then(|catalog| {
            catalog
                .components
                .iter()
                .find(|component| component.id == id)
        });
        let bundled = self.inner.resources.join(bundle);
        let stored = self
            .inner
            .data
            .join("runtime-components")
            .join(id)
            .join(native_pin(id));
        let mut error = None;
        let mut root = None;
        if let Some(component) = catalog_component {
            if !stored.exists() && stored.parent().is_some_and(Path::is_dir) {
                let recovery = guarded_component_dir(&self.inner.data, id).and_then(|parent| {
                    restore_previous(&parent, &component.manifest_sha256, cancel, |candidate| {
                        check_cancel(cancel)?;
                        if verify_tree(candidate, &component.files, true, cancel).is_err() {
                            check_cancel(cancel)?;
                            return Ok(false);
                        }
                        let marker_path = candidate.join(".complete.json");
                        if !marker_path.symlink_metadata().is_ok_and(|metadata| {
                            metadata.is_file() && !is_link(&metadata) && metadata.len() <= 4096
                        }) {
                            return Ok(false);
                        }
                        let marker: serde_json::Value = serde_json::from_slice(
                            &fs::read(marker_path).map_err(|error| error.to_string())?,
                        )
                        .map_err(|error| error.to_string())?;
                        Ok(marker["schemaVersion"] == 1
                            && marker["component"] == id
                            && marker["manifestSha256"] == component.manifest_sha256
                            && marker["fileCount"].as_u64() == Some(component.files.len() as u64)
                            && marker["totalBytes"].as_u64()
                                == Some(component.files.iter().map(|file| file.size).sum())
                            && runtime.verified_candidate(candidate, ready))
                    })
                });
                if let Err(reason) = recovery {
                    error = Some(reason);
                }
            }
            for (candidate, persistent) in [(bundled.clone(), false), (stored.clone(), true)] {
                if !candidate.exists() {
                    continue;
                }
                let result = verify_tree(&candidate, &component.files, persistent, cancel)
                    .and_then(|_| {
                        check_cancel(cancel)?;
                        if if persistent {
                            runtime.stored_ready(&candidate, ready)
                        } else {
                            runtime.verified_candidate(&candidate, ready)
                        } {
                            Ok(())
                        } else {
                            Err("组件原生信任校验失败".into())
                        }
                    });
                match result {
                    Ok(()) => {
                        root = Some(candidate);
                        error = None;
                        break;
                    }
                    Err(reason) => error = Some(reason),
                }
            }
        } else {
            // Full distributions may predate the ZIP catalog. Their native
            // resources retain the existing pins and remain usable independently of it.
            root = runtime.resolve(ready);
            if root.is_none() && (bundled.exists() || stored.exists()) {
                error = Some("组件缺失文件或原生信任校验失败".into());
            }
        }
        if check_cancel(cancel).is_err() {
            return CachedComponent {
                root: None,
                bytes: 0,
                error: Some("组件安装已取消".into()),
                stamps: vec![],
            };
        }
        let bytes = if root.is_some() {
            catalog_component
                .map(|component| component.files.iter().map(|file| file.size).sum())
                .unwrap_or(0)
        } else {
            0
        };
        let mut stamps = self.probe_stamps(id);
        if let Some(root) = &root {
            stamps.extend(critical_stamps(root, manifest));
        }
        let cached = CachedComponent {
            root,
            bytes,
            error,
            stamps,
        };
        if generation == self.inner.generation.load(Ordering::Acquire) {
            self.inner
                .cache
                .lock()
                .unwrap()
                .insert(id.into(), cached.clone());
        }
        cached
    }
    fn feature_component_ready(&self, id: &str) -> CachedComponent {
        let cached = self.verify_now(id, false);
        if let Some(expected) = &cached.root {
            let (native, ready) = self.runtime_component(id).expect("validated component ID");
            // RuntimeComponent retains metadata stamps for its complete native inventory.
            // Feature activation checks those stamps too, catching nested Python/DLL loss
            // without putting thousands of stats or repeated hashes in status polling.
            if native.resolve(ready).as_ref() != Some(expected) {
                self.invalidate(id);
                return self.verify_now(id, true);
            }
        }
        cached
    }
    fn cached_or_schedule(&self, id: &str) -> Option<CachedComponent> {
        if let Some(cached) = self
            .inner
            .cache
            .lock()
            .unwrap()
            .get(id)
            .filter(|cached| unchanged(&cached.stamps))
            .cloned()
        {
            return Some(cached);
        }
        if self.inner.checking.lock().unwrap().insert(id.into()) {
            let manager = self.clone();
            let id = id.to_owned();
            std::thread::spawn(move || {
                manager.verify_now(&id, false);
                manager.inner.checking.lock().unwrap().remove(&id);
            });
        }
        None
    }
    fn invalidate(&self, id: &str) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        self.inner.cache.lock().unwrap().remove(id);
    }
    pub fn status(&self) -> ComponentManagerStatus {
        let components = IDS
            .into_iter()
            .map(|id| {
                let catalog = self.inner.catalog.as_ref().ok().and_then(|catalog| {
                    catalog
                        .components
                        .iter()
                        .find(|component| component.id == id)
                });
                let cached = self.cached_or_schedule(id);
                let root = cached.as_ref().and_then(|cached| cached.root.as_ref());
                let error = cached.as_ref().and_then(|cached| cached.error.clone());
                RuntimeComponentStatus {
                    id: id.into(),
                    title: catalog
                        .map(|component| component.title.clone())
                        .unwrap_or_else(|| id.into()),
                    description: catalog
                        .map(|component| component.description.clone())
                        .unwrap_or_default(),
                    version: catalog
                        .map(|component| component.version.clone())
                        .unwrap_or_default(),
                    state: if root.is_some() {
                        "ready"
                    } else if error.is_some() {
                        "damaged"
                    } else {
                        "not_installed"
                    }
                    .into(),
                    root_path: root.map(|root| root.to_string_lossy().into_owned()),
                    installed_bytes: catalog
                        .map(|component| component.files.iter().map(|file| file.size).sum())
                        .unwrap_or_else(|| cached.map(|cached| cached.bytes).unwrap_or(0)),
                    download_bytes: catalog.map(|component| component.archive.size).unwrap_or(0),
                    dependencies: dependencies(id),
                    error,
                }
            })
            .collect();
        ComponentManagerStatus {
            edition: self.inner.edition.clone(),
            catalog_ready: self.inner.catalog.is_ok(),
            catalog_error: self.inner.catalog.as_ref().err().cloned(),
            components,
            transfer: self.inner.transfer.lock().unwrap().clone(),
        }
    }
    pub fn feature_status(&self, feature_id: &str) -> RuntimeFeatureStatus {
        let Some((id, default_title, required)) =
            FEATURES.iter().find(|(id, _, _)| *id == feature_id)
        else {
            return RuntimeFeatureStatus {
                id: feature_id.into(),
                title: feature_id.into(),
                ready: false,
                missing_components: vec![],
                error: Some("功能不存在".into()),
            };
        };
        // The caller runs this operation on a blocking pool. A bundled component must
        // finish its first validation before reporting that the feature needs installing.
        let statuses: Vec<(&str, CachedComponent)> = required
            .iter()
            .map(|id| (*id, self.feature_component_ready(id)))
            .collect();
        let missing_components: Vec<String> = required
            .iter()
            .filter(|id| {
                !statuses
                    .iter()
                    .any(|(component_id, cached)| component_id == *id && cached.root.is_some())
            })
            .map(|id| (*id).into())
            .collect();
        let title = self
            .inner
            .catalog
            .as_ref()
            .ok()
            .and_then(|catalog| catalog.features.iter().find(|feature| feature.id == *id))
            .map(|feature| feature.title.clone())
            .unwrap_or_else(|| (*default_title).into());
        let error = required.iter().find_map(|id| {
            statuses
                .iter()
                .find(|(component_id, _)| component_id == id)
                .and_then(|(_, cached)| cached.error.clone())
        });
        RuntimeFeatureStatus {
            id: (*id).into(),
            title,
            ready: missing_components.is_empty(),
            missing_components,
            error,
        }
    }
    pub fn component_asset_root(&self, id: &str) -> Result<PathBuf, String> {
        spec(id).ok_or("组件不存在")?;
        let verified = self.feature_component_ready(id);
        verified
            .root
            .ok_or_else(|| verified.error.unwrap_or_else(|| "所需组件尚未安装".into()))
    }
    pub fn cancel(&self) {
        self.inner
            .cancel
            .lock()
            .unwrap()
            .store(true, Ordering::Release);
    }
    fn begin(&self, id: &str) -> Result<TransferGuard, String> {
        let mut status = self.inner.transfer.lock().unwrap();
        if status.active {
            return Err("已有组件安装任务正在进行".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *self.inner.cancel.lock().unwrap() = Arc::clone(&cancel);
        *status = ComponentTransferStatus {
            active: true,
            component_id: Some(id.into()),
            phase: "verifying".into(),
            ..Default::default()
        };
        Ok(TransferGuard {
            manager: self.clone(),
            cancel,
            finished: false,
        })
    }
    fn phase(&self, id: &str, phase: &str, completed: u64, total: u64) {
        let mut transfer = self.inner.transfer.lock().unwrap();
        if transfer.component_id.as_deref() != Some(id) {
            transfer.reused_bytes = 0;
            transfer.downloaded_bytes = 0;
        }
        transfer.component_id = Some(id.into());
        transfer.phase = phase.into();
        transfer.completed_bytes = completed;
        transfer.total_bytes = total;
    }
    pub async fn install(&self, id: &str, repair: bool) -> Result<(), String> {
        let catalog = self.inner.catalog.as_ref().map_err(Clone::clone)?;
        let components = dependency_closure(catalog, id)?;
        let mut guard = self.begin(id)?;
        let result = async {
            for component in components {
                check_cancel(&guard.cancel)?;
                self.install_one(&component, repair, None, Arc::clone(&guard.cancel))
                    .await?;
            }
            Ok(())
        }
        .await;
        guard.finish(&result);
        result
    }
    pub async fn import_archive(&self, id: &str, path: &Path) -> Result<(), String> {
        let catalog = self.inner.catalog.as_ref().map_err(Clone::clone)?;
        let component = catalog
            .components
            .iter()
            .find(|component| component.id == id)
            .ok_or("组件不存在")?
            .clone();
        let mut guard = self.begin(id)?;
        let result = self
            .install_one(
                &component,
                true,
                Some(path.to_path_buf()),
                Arc::clone(&guard.cancel),
            )
            .await;
        guard.finish(&result);
        result
    }
    async fn install_one(
        &self,
        component: &CatalogComponent,
        repair: bool,
        import: Option<PathBuf>,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        self.phase(&component.id, "verifying", 0, component.archive.size);
        let manager = self.clone();
        let id = component.id.clone();
        let verify_cancel = Arc::clone(&cancel);
        let ready = tokio::task::spawn_blocking(move || {
            manager.verify_with_cancel(&id, repair, &verify_cancel)
        })
        .await
        .map_err(|error| error.to_string())?;
        check_cancel(&cancel)?;
        if import.is_none() && ready.root.is_some() {
            self.phase(
                &component.id,
                "ready",
                component.archive.size,
                component.archive.size,
            );
            return Ok(());
        }
        self.invalidate(&component.id);
        let parent = guarded_component_dir(&self.inner.data, &component.id)?;
        let lock_path = parent.join(".migration.lock");
        if lock_path
            .symlink_metadata()
            .is_ok_and(|metadata| !metadata.is_file() || is_link(&metadata))
        {
            return Err("组件安装锁路径不可信".into());
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| error.to_string())?;
        loop {
            check_cancel(&cancel)?;
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(150)).await
                }
                Err(error) => return Err(format!("获取组件安装锁失败：{error}")),
            }
        }
        let cleanup_parent = parent.clone();
        let lock = tokio::task::spawn_blocking(move || -> Result<_, String> {
            cleanup_stale_stages(&cleanup_parent)?;
            Ok(lock)
        })
        .await
        .map_err(|error| error.to_string())??;
        let bytes = validate_files(&component.files)?;
        let downloads = guarded_child(&parent, ".downloads")?;
        let partial = downloads.join(format!("{}.partial", component.archive.sha256));
        let cached_bytes = partial
            .symlink_metadata()
            .ok()
            .filter(|metadata| metadata.is_file() && !is_link(metadata))
            .map(|metadata| metadata.len().min(component.archive.size))
            .unwrap_or(0);
        let required_space = bytes
            .saturating_add(if import.is_some() {
                0
            } else {
                component.archive.size.saturating_sub(cached_bytes)
            })
            .saturating_add(64 * 1024 * 1024);
        if fs2::available_space(&parent).map_err(|error| error.to_string())? < required_space {
            return Err(format!(
                "组件安装空间不足，需要至少 {} MiB 可用空间",
                required_space.div_ceil(1024 * 1024)
            ));
        }
        let archive = if let Some(path) = import {
            path
        } else {
            let catalog = self.inner.catalog.as_ref().map_err(Clone::clone)?;
            let url = archive_url(catalog, component)?;
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| error.to_string())?;
            self.phase(&component.id, "downloading", 0, component.archive.size);
            download_zip(
                &client,
                &url,
                &partial,
                component.archive.size,
                &component.archive.sha256,
                Arc::clone(&cancel),
                |progress| {
                    let mut status = self.inner.transfer.lock().unwrap();
                    status.completed_bytes = progress.completed;
                    status.total_bytes = progress.total;
                    status.reused_bytes = progress.reused;
                    status.downloaded_bytes = progress.downloaded;
                },
            )
            .await?;
            partial
        };
        check_cancel(&cancel)?;
        let staging = parent.join(format!(".component-stage-{}", Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|error| error.to_string())?;
        // Keep the component lock inside the blocking worker even if the command future
        // is dropped. A second process cannot race the extraction or publication.
        let staged_component = component.clone();
        let manager = self.clone();
        let staged_parent = parent.clone();
        let staged_root = staging.clone();
        let staged_cancel = Arc::clone(&cancel);
        let result = tokio::task::spawn_blocking(move || {
            let _lock = lock;
            let result = (|| -> Result<(), String> {
            manager.phase(&staged_component.id, "verifying", 0, staged_component.archive.size);
            if hash_file(&archive, &staged_cancel)? != (staged_component.archive.sha256.clone(), staged_component.archive.size) { return Err("组件压缩包大小或 SHA-256 不匹配".into()); }
            manager.phase(&staged_component.id, "extracting", 0, bytes);
            extract_zip(&archive, &staged_root, staged_component.archive.size, &staged_component.archive.sha256, &staged_component.files, &staged_cancel, |completed, total| manager.phase(&staged_component.id, "extracting", completed, total))?;
            let (runtime, ready) = manager.runtime_component(&staged_component.id)?;
            if !runtime.verified_candidate(&staged_root, ready) { return Err("组件原生清单、执行文件或模型校验失败".into()); }
            check_cancel(&staged_cancel)?;
            let marker = serde_json::json!({ "schemaVersion":1, "component":staged_component.id, "manifestSha256":staged_component.manifest_sha256, "fileCount":staged_component.files.len(), "totalBytes":bytes });
            let mut file = OpenOptions::new().create_new(true).write(true).open(staged_root.join(".complete.json")).map_err(|error| error.to_string())?;
            file.write_all(&serde_json::to_vec(&marker).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?; file.sync_all().map_err(|error| error.to_string())?;
            // Windows cannot rename the component directory while this marker is open.
            drop(file);
            manager.phase(&staged_component.id, "installing", bytes, bytes);
            let destination = staged_parent.join(&staged_component.manifest_sha256);
            let canonical_stage = staged_root.canonicalize().map_err(|error| error.to_string())?;
            publish_atomic(&staged_parent, &staged_root, &destination, |from, to| fs::rename(from, to), || {
                runtime.retarget_critical_cache(&canonical_stage, &destination);
                runtime.stored_ready(&destination, ready)
            })?;
            manager.invalidate(&staged_component.id);
            let (_, _, manifest, _) = spec(&staged_component.id).ok_or("组件不存在")?;
            let mut stamps = manager.probe_stamps(&staged_component.id); stamps.extend(critical_stamps(&destination, manifest));
            manager.inner.cache.lock().unwrap().insert(staged_component.id.clone(), CachedComponent { root: Some(destination), bytes, error: None, stamps });
            manager.phase(&staged_component.id, "ready", bytes, bytes); Ok(())
            })();
            if result.is_err() && staged_root.exists() {
                if let Err(cleanup) = remove_guarded_stage(&staged_parent, &staged_root) { return Err(format!("{}；暂存清理已停止：{cleanup}", result.unwrap_err())); }
            }
            result
        }).await.map_err(|error| error.to_string())?;
        if result.is_err() {
            self.invalidate(&component.id);
        }
        result
    }
}

struct TransferGuard {
    manager: ComponentManager,
    cancel: Arc<AtomicBool>,
    finished: bool,
}
impl TransferGuard {
    fn finish(&mut self, result: &Result<(), String>) {
        self.finished = true;
        let mut transfer = self.manager.inner.transfer.lock().unwrap();
        transfer.active = false;
        transfer.phase = if result.is_ok() {
            "ready"
        } else if self.cancel.load(Ordering::Acquire) {
            "cancelled"
        } else {
            "error"
        }
        .into();
        transfer.error = result.as_ref().err().cloned();
    }
}
impl Drop for TransferGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.store(true, Ordering::Release);
            let mut transfer = self.manager.inner.transfer.lock().unwrap();
            transfer.active = false;
            transfer.phase = "cancelled".into();
            transfer.error = Some("组件安装任务已结束，缓存可继续使用".into());
        }
    }
}

fn guarded_child(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = safe_relative(name)?;
    if relative.components().count() != 1 {
        return Err("组件存储子目录无效".into());
    }
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let parent_metadata = parent
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !parent_metadata.is_dir() || is_link(&parent_metadata) {
        return Err("组件存储父目录不可信".into());
    }
    let child = parent.join(relative);
    match fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let metadata = child
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || is_link(&metadata)
        || child
            .canonicalize()
            .map_err(|error| error.to_string())?
            .parent()
            != Some(canonical_parent.as_path())
    {
        return Err("组件存储路径越界或包含链接".into());
    }
    Ok(child)
}
fn guarded_component_dir(data: &Path, id: &str) -> Result<PathBuf, String> {
    spec(id).ok_or("组件不存在")?;
    fs::create_dir_all(data).map_err(|error| error.to_string())?;
    let metadata = data.symlink_metadata().map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("应用数据目录不可信".into());
    }
    guarded_child(&guarded_child(data, "runtime-components")?, id)
}
fn remove_guarded_stage(parent: &Path, stage: &Path) -> Result<(), String> {
    let name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("暂存目录名称无效")?;
    if stage.parent() != Some(parent)
        || Uuid::parse_str(
            name.strip_prefix(".component-stage-")
                .ok_or("拒绝清理非组件暂存目录")?,
        )
        .is_err()
    {
        return Err("拒绝清理非随机组件暂存目录".into());
    }
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let metadata = parent
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("暂存父目录不可信".into());
    }
    fn validate(path: &Path, parent: &Path) -> Result<(), String> {
        let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if metadata.file_type().is_symlink() {
            // Remove the link itself only. Never traverse its target during cleanup.
            return Ok(());
        }
        if is_link(&metadata)
            || (!metadata.is_dir() && !metadata.is_file())
            || !path
                .canonicalize()
                .map_err(|error| error.to_string())?
                .starts_with(parent)
        {
            return Err("暂存目录含链接或越界文件，停止清理".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
                validate(&entry.map_err(|error| error.to_string())?.path(), parent)?;
            }
        }
        Ok(())
    }
    let stage_metadata = stage
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !stage_metadata.is_dir()
        || is_link(&stage_metadata)
        || stage
            .canonicalize()
            .map_err(|error| error.to_string())?
            .parent()
            != Some(canonical_parent.as_path())
    {
        return Err("暂存根目录不可信".into());
    }
    validate(stage, &canonical_parent)?;
    fn remove(path: &Path, root: &Path, parent: &Path) -> Result<(), String> {
        // Recheck every ancestor immediately before each delete. Never recurse through
        // a reparse point, even one which happens to target another place in the store.
        let mut current = path;
        loop {
            let metadata = current
                .symlink_metadata()
                .map_err(|error| error.to_string())?;
            let removable_link = cfg!(unix) && current == path && metadata.file_type().is_symlink();
            if !removable_link
                && (is_link(&metadata)
                    || !current
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        .starts_with(parent))
            {
                return Err("暂存路径被替换，停止清理".into());
            }
            if current == root {
                break;
            }
            current = current.parent().ok_or("暂存路径越界")?;
        }
        let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if metadata.file_type().is_symlink() {
            return fs::remove_file(path).map_err(|error| error.to_string());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
                remove(
                    &entry.map_err(|error| error.to_string())?.path(),
                    root,
                    parent,
                )?;
            }
            fs::remove_dir(path).map_err(|error| error.to_string())?;
        } else if metadata.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        } else {
            return Err("暂存目录含特殊文件".into());
        }
        Ok(())
    }
    remove(stage, stage, &canonical_parent)
}
fn cleanup_stale_stages(parent: &Path) -> Result<(), String> {
    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with(".component-stage-"))
        {
            remove_guarded_stage(parent, &entry.path())?;
        }
    }
    Ok(())
}
/// Recovery after a process exits between the two publication renames. Every
/// candidate must match the same pinned inventory; prefer the newest trusted copy.
fn restore_previous(
    parent: &Path,
    digest: &str,
    cancel: &AtomicBool,
    mut trusted: impl FnMut(&Path) -> Result<bool, String>,
) -> Result<bool, String> {
    if !valid_sha256(digest) {
        return Err("恢复目标摘要无效".into());
    }
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let metadata = parent
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("恢复组件目录不可信".into());
    }
    let destination = parent.join(digest);
    if destination.exists() {
        return Ok(false);
    }
    let mut backups: Vec<PathBuf> = fs::read_dir(parent)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            Uuid::parse_str(name.to_str()?.strip_prefix(".previous-")?).ok()?;
            Some(entry.path())
        })
        .collect();
    if backups.is_empty() {
        return Ok(false);
    }
    let lock_path = parent.join(".migration.lock");
    if lock_path
        .symlink_metadata()
        .is_ok_and(|metadata| !metadata.is_file() || is_link(&metadata))
    {
        return Err("恢复组件锁路径不可信".into());
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| error.to_string())?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
        Err(error) => return Err(error.to_string()),
    }
    if destination.exists() {
        return Ok(false);
    }
    backups.sort_by_key(|path| {
        std::cmp::Reverse(
            path.symlink_metadata()
                .and_then(|info| info.modified())
                .ok(),
        )
    });
    let mut selected = None;
    for candidate in backups {
        check_cancel(cancel)?;
        if !candidate
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata))
            || candidate
                .canonicalize()
                .map_err(|error| error.to_string())?
                .parent()
                != Some(canonical_parent.as_path())
        {
            continue;
        }
        if trusted(&candidate)? {
            selected = Some(candidate);
            break;
        }
    }
    let Some(candidate) = selected else {
        return Ok(false);
    };
    check_cancel(cancel)?;
    if destination.symlink_metadata().is_ok() {
        return Ok(false);
    }
    fs::rename(candidate, &destination).map_err(|error| format!("恢复已验证组件失败：{error}"))?;
    Ok(true)
}
fn publish_atomic(
    parent: &Path,
    staging: &Path,
    destination: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    verified: impl FnOnce() -> bool,
) -> Result<Option<PathBuf>, String> {
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    for path in [staging, destination] {
        if path.parent() != Some(parent) || path == parent {
            return Err("组件提交路径超出组件目录".into());
        }
        if let Ok(metadata) = path.symlink_metadata() {
            if !metadata.is_dir()
                || is_link(&metadata)
                || path
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .parent()
                    != Some(canonical_parent.as_path())
            {
                return Err("组件提交路径不可信".into());
            }
        }
    }
    let previous = if destination.exists() {
        let previous = parent.join(format!(".previous-{}", Uuid::new_v4()));
        rename(destination, &previous).map_err(|error| format!("保留旧组件失败：{error}"))?;
        Some(previous)
    } else {
        None
    };
    if let Err(error) = rename(staging, destination) {
        if let Some(previous) = &previous {
            rename(previous, destination).map_err(|rollback| {
                format!(
                    "提交失败：{error}；回滚失败：{rollback}；旧组件保留在 {}",
                    previous.display()
                )
            })?;
        }
        return Err(if previous.is_some() {
            format!("提交组件失败，旧组件已恢复：{error}")
        } else {
            format!("提交组件失败，暂存组件未启用：{error}")
        });
    }
    if !verified() {
        rename(destination, staging)
            .map_err(|error| format!("发布后校验失败，隔离新组件失败：{error}"))?;
        if let Some(previous) = &previous {
            rename(previous, destination).map_err(|error| {
                format!(
                    "发布后校验失败，回滚失败：{error}；旧组件保留在 {}",
                    previous.display()
                )
            })?;
        }
        return Err(if previous.is_some() {
            "发布后组件校验失败，旧组件已恢复"
        } else {
            "发布后组件校验失败，新组件已隔离"
        }
        .into());
    }
    // Prior content-addressed versions and the replaced directory remain available for
    // rollback. Component installation never deletes another version automatically.
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn component_platform_maps_only_supported_architectures() {
        assert_eq!(
            component_platform("windows", "x86_64"),
            Some("windows-x86_64")
        );
        assert_eq!(
            component_platform("macos", "aarch64"),
            Some("darwin-aarch64")
        );
        assert_eq!(component_platform("macos", "x86_64"), Some("darwin-x86_64"));
        assert_eq!(component_platform("windows", "aarch64"), None);
        assert_eq!(component_platform("macos", "arm"), None);
        assert_eq!(component_platform("linux", "x86_64"), None);
    }
    #[cfg(unix)]
    #[test]
    fn stamp_cache_detects_permission_changes() {
        use std::os::unix::fs::PermissionsExt as _;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("engine");
        fs::write(&path, b"bytes").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let stamps = vec![stamp(path.clone())];
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!unchanged(&stamps));
    }
    #[test]
    fn atomic_publish_restores_previous_on_rename_or_final_verification_failure() {
        for fail_rename in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let staging = temp.path().join(".stage");
            let destination = temp.path().join("a".repeat(64));
            fs::create_dir(&staging).unwrap();
            fs::create_dir(&destination).unwrap();
            fs::write(staging.join("payload"), b"new").unwrap();
            fs::write(destination.join("payload"), b"old").unwrap();
            let mut calls = 0;
            assert!(
                publish_atomic(
                    temp.path(),
                    &staging,
                    &destination,
                    |from, to| {
                        calls += 1;
                        if fail_rename && calls == 2 {
                            Err(std::io::Error::other("fixture failure"))
                        } else {
                            fs::rename(from, to)
                        }
                    },
                    || false
                )
                .is_err()
            );
            assert_eq!(fs::read(destination.join("payload")).unwrap(), b"old");
            assert_eq!(fs::read(staging.join("payload")).unwrap(), b"new");
        }
    }
    #[test]
    fn atomic_publish_retains_prior_directory_and_rejects_outside_destination() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("store");
        fs::create_dir(&parent).unwrap();
        let staging = parent.join(".stage");
        let destination = parent.join("a".repeat(64));
        fs::create_dir(&staging).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("payload"), b"old").unwrap();
        let previous = publish_atomic(
            &parent,
            &staging,
            &destination,
            |from, to| fs::rename(from, to),
            || true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(fs::read(previous.join("payload")).unwrap(), b"old");
        assert!(
            publish_atomic(
                &parent,
                &destination,
                &temp.path().join("outside"),
                |from, to| fs::rename(from, to),
                || true
            )
            .is_err()
        );
        assert!(destination.is_dir());
    }
    #[test]
    fn stamp_cache_detects_manifest_changes_and_unknown_features_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("manifest.json");
        fs::write(&path, b"old").unwrap();
        let stamps = vec![stamp(path.clone())];
        assert!(unchanged(&stamps));
        fs::write(path, b"changed").unwrap();
        assert!(!unchanged(&stamps));
        let manager =
            ComponentManager::new(temp.path().join("data"), temp.path().join("resources"));
        let status = manager.feature_status("unknown");
        assert!(!status.ready);
        assert!(status.error.is_some());
    }
    #[test]
    fn guarded_stage_cleanup_only_removes_its_random_owned_directory() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp
            .path()
            .join(format!(".component-stage-{}", Uuid::new_v4()));
        fs::create_dir_all(stage.join("nested")).unwrap();
        fs::write(stage.join("nested/payload"), b"bytes").unwrap();
        let previous = temp.path().join("a".repeat(64));
        fs::create_dir(&previous).unwrap();
        fs::write(previous.join("keep"), b"old").unwrap();
        remove_guarded_stage(temp.path(), &stage).unwrap();
        assert!(!stage.exists());
        assert!(remove_guarded_stage(temp.path(), &previous).is_err());
        assert_eq!(fs::read(previous.join("keep")).unwrap(), b"old");
    }
    #[cfg(unix)]
    #[test]
    fn guarded_stage_cleanup_removes_links_without_following_targets() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp
            .path()
            .join(format!(".component-stage-{}", Uuid::new_v4()));
        let outside = temp.path().join("outside");
        fs::create_dir(&stage).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"outside-bytes").unwrap();
        std::os::unix::fs::symlink(&outside, stage.join("alias")).unwrap();
        remove_guarded_stage(temp.path(), &stage).unwrap();
        assert!(!stage.exists());
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside-bytes");
    }
    #[test]
    fn restart_recovers_a_unique_verified_previous_after_first_publication_rename() {
        let temp = tempfile::tempdir().unwrap();
        let digest = "a".repeat(64);
        let current = temp.path().join(&digest);
        fs::create_dir(&current).unwrap();
        fs::write(current.join("payload"), b"trusted-old").unwrap();
        let backup = temp.path().join(format!(".previous-{}", Uuid::new_v4()));
        fs::rename(&current, &backup).unwrap();
        let untrusted = temp.path().join(format!(".previous-{}", Uuid::new_v4()));
        fs::create_dir(&untrusted).unwrap();
        fs::write(untrusted.join("payload"), b"untrusted").unwrap();
        assert!(
            restore_previous(temp.path(), &digest, &AtomicBool::new(false), |path| Ok(
                fs::read(path.join("payload")).unwrap() == b"trusted-old"
            ))
            .unwrap()
        );
        assert_eq!(fs::read(current.join("payload")).unwrap(), b"trusted-old");
        assert!(!backup.exists());
        assert!(untrusted.is_dir());
        assert!(
            !restore_previous(temp.path(), &digest, &AtomicBool::new(false), |_| panic!(
                "healthy current must not scan backups"
            ))
            .unwrap()
        );
    }
    #[test]
    fn restart_recovers_equivalent_verified_backups_without_discarding_other_copies() {
        let temp = tempfile::tempdir().unwrap();
        let digest = "b".repeat(64);
        let first = temp.path().join(format!(".previous-{}", Uuid::new_v4()));
        let second = temp.path().join(format!(".previous-{}", Uuid::new_v4()));
        for backup in [&first, &second] {
            fs::create_dir(backup).unwrap();
            fs::write(backup.join("payload"), b"same-pinned-inventory").unwrap();
        }
        assert!(
            restore_previous(temp.path(), &digest, &AtomicBool::new(false), |path| {
                Ok(fs::read(path.join("payload")).unwrap() == b"same-pinned-inventory")
            })
            .unwrap()
        );
        assert_eq!(
            fs::read(temp.path().join(&digest).join("payload")).unwrap(),
            b"same-pinned-inventory"
        );
        assert_ne!(first.exists(), second.exists());
    }
    #[tokio::test]
    #[ignore = "requires prepared catalog and content-addressed component ZIPs; no network is used"]
    async fn prepared_archives_import_into_fresh_store_and_repair_with_native_resolvers() {
        let resources = PathBuf::from(
            std::env::var("IC_COMPONENT_SMOKE_RESOURCES")
                .expect("set IC_COMPONENT_SMOKE_RESOURCES to prepared resource directory"),
        );
        let archives = PathBuf::from(std::env::var("IC_COMPONENT_SMOKE_ARCHIVES").expect(
            "set IC_COMPONENT_SMOKE_ARCHIVES to directory containing catalog ZIP filenames",
        ));
        let ids = std::env::var("IC_COMPONENT_SMOKE_IDS")
            .unwrap_or_else(|_| "pose-runtime,blender,remotion-runtime".into());
        let temp = tempfile::tempdir().unwrap();
        let fresh_resources = temp.path().join("resources");
        fs::create_dir(&fresh_resources).unwrap();
        fs::copy(
            resources.join("component-catalog.json"),
            fresh_resources.join("component-catalog.json"),
        )
        .unwrap();
        let manager = ComponentManager::new(temp.path().join("appdata"), fresh_resources);
        let catalog = manager
            .inner
            .catalog
            .as_ref()
            .expect("catalog must match compiled pin")
            .clone();
        for id in ids.split(',') {
            let component = catalog
                .components
                .iter()
                .find(|component| component.id == id)
                .expect("known smoke component");
            assert!(
                manager.component_asset_root(id).is_err(),
                "fresh store cannot fall back to bundled {id}"
            );
            let filename = Url::parse(&component.archive.url)
                .unwrap()
                .path_segments()
                .unwrap()
                .next_back()
                .unwrap()
                .to_owned();
            let archive = archives.join(filename);
            manager.import_archive(id, &archive).await.unwrap();
            let expected_root = manager
                .inner
                .data
                .join("runtime-components")
                .join(id)
                .join(&component.manifest_sha256);
            assert_eq!(manager.component_asset_root(id).unwrap(), expected_root);
            let (native, ready) = manager.runtime_component(id).unwrap();
            assert_eq!(native.resolve(ready), Some(expected_root.clone()));
            let payload = component
                .files
                .iter()
                .find(|file| {
                    file.path != component.manifest_path
                        && file.path != "files-manifest.json"
                        && file.size > 0
                        && file.size < 1024 * 1024
                })
                .expect("small repair fixture payload");
            let original = fs::read(expected_root.join(&payload.path)).unwrap();
            fs::write(expected_root.join(&payload.path), b"repair-damage-fixture").unwrap();
            assert!(
                manager.verify_now(id, true).root.is_none(),
                "full repair validation must find damaged {id}"
            );
            manager.import_archive(id, &archive).await.unwrap();
            assert_eq!(
                fs::read(expected_root.join(&payload.path)).unwrap(),
                original
            );
            let (native, ready) = manager.runtime_component(id).unwrap();
            assert_eq!(native.resolve(ready), Some(expected_root));
            assert!(
                fs::read_dir(manager.inner.data.join("runtime-components").join(id))
                    .unwrap()
                    .any(|entry| entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".previous-")),
                "repair must preserve old version"
            );
            println!("verified fresh install, native resolution and repair: {id}");
        }
        if ids.split(',').count() == catalog.components.len() {
            for feature in &catalog.features {
                assert!(
                    manager.feature_status(&feature.id).ready,
                    "installed dependency closure must make {} ready",
                    feature.id
                );
            }
        }
    }
}
