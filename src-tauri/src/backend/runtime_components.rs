//! Keep large, versioned offline resources outside the application install directory.
//!
//! A full installer is the trusted source. Migration copies (never hard-links) every file,
//! checks the copy byte-for-byte by SHA-256, and publishes the directory only after it is
//! complete. Runtime lookup keeps using the bundled copy while migration runs.

use std::collections::HashSet;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use fs2::FileExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

#[derive(Clone)]
pub struct RuntimeComponent {
    store_base: PathBuf,
    bundled_root: PathBuf,
    name: &'static str,
    manifest_relative: &'static str,
    verified_critical: Arc<Mutex<Option<VerifiedCritical>>>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
    #[cfg(unix)]
    mode: u32,
}

struct VerifiedCritical {
    root: PathBuf,
    stamps: Vec<FileStamp>,
}

pub struct ComponentPlan {
    pub component: RuntimeComponent,
    pub ready: fn(&Path) -> bool,
}

/// Read-only check for the slim NSIS installer. It intentionally never accepts the old
/// installation directory: a WiX uninstall can remove that directory before the new app runs.
pub fn check_persistent_components(app_local_data_dir: &Path) -> Result<(), String> {
    let store = app_local_data_dir.join("runtime-components");
    let checks: [(&str, &str, fn(&Path) -> bool); 4] = [
        (
            "blender",
            "manifest.json",
            super::blender::blender_runtime_ready,
        ),
        (
            "remotion-runtime",
            "runtime-manifest.json",
            super::remotion_renderer::runtime_ready,
        ),
        ("ffmpeg", "manifest.json", super::composer::engine_ready_in),
        (
            "gpt-image-2-style-library",
            "data/manifest.json",
            super::gpt_image_style_library::style_component_ready,
        ),
    ];
    for (name, manifest, ready) in checks {
        let component = RuntimeComponent::new(store.clone(), PathBuf::new(), name, manifest);
        if component.stored_root(ready).is_none() {
            return Err(format!("持久组件 {name} 缺失、版本不兼容或校验失败"));
        }
    }
    Ok(())
}

/// Native manifest hashes compiled into this executable. The release builder compares these
/// against the signed file inventory before publishing a slim installer.
pub fn compiled_manifest_pins() -> serde_json::Value {
    serde_json::json!({
        "blender": env!("IC_BLENDER_MANIFEST_SHA256"),
        "remotion-runtime": env!("IC_REMOTION_MANIFEST_SHA256"),
        "ffmpeg": env!("IC_FFMPEG_MANIFEST_SHA256"),
        "gpt-image-2-style-library": env!("IC_STYLE_MANIFEST_SHA256"),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponentMigrationStatus {
    pub ready: bool,
    pub preparing: bool,
    pub error: Option<String>,
    pub completed_components: usize,
    pub total_components: usize,
    pub current_component: Option<String>,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

pub struct RuntimeComponentMigration {
    status: Mutex<RuntimeComponentMigrationStatus>,
}

impl RuntimeComponentMigration {
    pub fn start(plans: Vec<ComponentPlan>) -> Arc<Self> {
        let migration = Arc::new(Self {
            status: Mutex::new(RuntimeComponentMigrationStatus {
                ready: plans.is_empty(),
                preparing: !plans.is_empty(),
                error: None,
                completed_components: 0,
                total_components: plans.len(),
                current_component: None,
                completed_bytes: 0,
                total_bytes: 0,
            }),
        });
        if !plans.is_empty() {
            let state = Arc::clone(&migration);
            std::thread::spawn(move || {
                // 组件就绪过滤（resolve → critical_files_ready）会校验 GB 级关键文件，
                // 只允许在后台线程执行；主线程 setup 绝不为它停留。内置与持久副本
                // 均不存在的可选组件在这里就地剔除，避免单个缺失组件在 migrate()
                // 里以错误中止整个迁移。
                let plans: Vec<ComponentPlan> = plans
                    .into_iter()
                    .filter(|plan| plan.component.resolve(plan.ready).is_some())
                    .collect();
                {
                    let mut status = state.status.lock().expect("migration status poisoned");
                    status.total_components = plans.len();
                    if plans.is_empty() {
                        status.preparing = false;
                        status.ready = true;
                        status.current_component = None;
                    }
                }
                if plans.is_empty() {
                    return;
                }
                let retention_plans = plans
                    .iter()
                    .map(|plan| (plan.component.clone(), plan.ready))
                    .collect::<Vec<_>>();
                let estimates = plans
                    .iter()
                    .map(|plan| plan.component.estimate_bytes(plan.ready))
                    .collect::<Result<Vec<_>, _>>();
                let estimates = match estimates {
                    Ok(estimates) => estimates,
                    Err(error) => {
                        let mut status = state.status.lock().expect("migration status poisoned");
                        status.preparing = false;
                        status.error = Some(error);
                        return;
                    }
                };
                {
                    let mut status = state.status.lock().expect("migration status poisoned");
                    status.total_bytes = estimates.iter().sum();
                }
                let mut completed_bytes = 0u64;
                for (plan, estimated_bytes) in plans.into_iter().zip(estimates) {
                    let name = plan.component.name.to_string();
                    {
                        let mut status = state.status.lock().expect("migration status poisoned");
                        status.current_component = Some(name.clone());
                    }
                    let result = plan.component.migrate(plan.ready, |copied, total| {
                        let mut status = state.status.lock().expect("migration status poisoned");
                        status.completed_bytes = completed_bytes
                            + if total == 0 {
                                0
                            } else {
                                copied.saturating_mul(estimated_bytes) / total
                            };
                    });
                    let mut status = state.status.lock().expect("migration status poisoned");
                    if let Err(error) = result {
                        status.preparing = false;
                        status.current_component = Some(name);
                        status.error = Some(error);
                        return;
                    }
                    completed_bytes += estimated_bytes;
                    status.completed_bytes = completed_bytes;
                    status.completed_components += 1;
                }
                let mut status = state.status.lock().expect("migration status poisoned");
                status.current_component = None;
                status.preparing = false;
                status.ready = true;
                drop(status);
                // All four release components are now usable. Retain one previous on-disk
                // version per component for rollback; cleanup never gates application startup.
                for (component, ready) in retention_plans {
                    if let Err(error) = component.cleanup_old_versions(ready) {
                        tauri_plugin_log::log::warn!(
                            "cleanup of old {} runtime resources skipped: {error}",
                            component.name
                        );
                    }
                }
            });
        }
        migration
    }

    pub fn status(&self) -> RuntimeComponentMigrationStatus {
        self.status
            .lock()
            .expect("migration status poisoned")
            .clone()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteMarker {
    schema_version: u32,
    component: String,
    manifest_sha256: String,
    file_count: u64,
    total_bytes: u64,
}

#[derive(Debug)]
struct SourceFile {
    relative: PathBuf,
    source: PathBuf,
    bytes: u64,
    #[cfg(target_os = "macos")]
    link_target: Option<PathBuf>,
}

impl RuntimeComponent {
    pub fn new(
        store_base: PathBuf,
        bundled_root: PathBuf,
        name: &'static str,
        manifest_relative: &'static str,
    ) -> Self {
        Self {
            store_base,
            bundled_root,
            name,
            manifest_relative,
            verified_critical: Arc::new(Mutex::new(None)),
        }
    }

    /// Prefer signed installer resources while they exist. A slim installer can omit them
    /// after the bridge release has copied and validated the persistent version.
    pub fn resolve(&self, ready: fn(&Path) -> bool) -> Option<PathBuf> {
        if self.bundled_ready(ready) {
            return Some(self.bundled_root.clone());
        }
        self.stored_root(ready)
    }

    pub fn stored_root(&self, ready: fn(&Path) -> bool) -> Option<PathBuf> {
        let parent = self.component_dir();
        let mut candidates = fs::read_dir(parent)
            .ok()?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, path))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.0.cmp(&left.0));
        candidates
            .into_iter()
            .map(|(_, path)| path)
            .find(|path| self.stored_ready(path, ready))
    }

    /// Copies once on a background thread. The caller owns progress reporting and the update
    /// gate; a failed migration must never be reported as a usable slim-update foundation.
    pub fn migrate(
        &self,
        ready: fn(&Path) -> bool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), String> {
        if !self.bundled_ready(ready) {
            if self.resolve(ready).is_some() {
                progress(1, 1);
                return Ok(());
            }
            return Err(format!("{} 的内置资源和持久副本均不可用", self.name));
        }
        let manifest_sha256 = self
            .manifest_hash(&self.bundled_root)
            .ok_or_else(|| format!("{} 的内置资源清单缺失", self.name))?;
        if !ready(&self.bundled_root) {
            return Err(format!("{} 的内置资源不完整", self.name));
        }
        let destination = self.component_dir().join(&manifest_sha256);
        if self.stored_ready(&destination, ready) {
            progress(1, 1);
            return Ok(());
        }
        fs::create_dir_all(self.component_dir())
            .map_err(|error| format!("创建 {} 的持久目录失败：{error}", self.name))?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.component_dir().join(".migration.lock"))
            .map_err(|error| format!("打开 {} 的迁移锁失败：{error}", self.name))?;
        lock.lock_exclusive()
            .map_err(|error| format!("获取 {} 的迁移锁失败：{error}", self.name))?;
        if self.stored_ready(&destination, ready) {
            progress(1, 1);
            return Ok(());
        }
        cleanup_incomplete_staging(&self.component_dir())?;
        let source_root = self
            .bundled_root
            .canonicalize()
            .map_err(|error| format!("读取 {} 的资源目录失败：{error}", self.name))?;
        let mut files = Vec::new();
        let mut directories = Vec::new();
        collect_files(
            &self.bundled_root,
            Path::new(""),
            &source_root,
            &mut HashSet::new(),
            &mut directories,
            &mut files,
        )?;
        files.sort_by(|left, right| left.relative.cmp(&right.relative));
        let total_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
        progress(0, total_bytes);
        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(self.component_dir())
            .map_err(|error| format!("创建 {} 的迁移目录失败：{error}", self.name))?;
        for directory in directories {
            fs::create_dir_all(staging.path().join(directory))
                .map_err(|error| format!("创建 {} 的资源子目录失败：{error}", self.name))?;
        }
        let mut copied_bytes = 0;
        for file in &files {
            let target = staging.path().join(&file.relative);
            fs::create_dir_all(target.parent().expect("relative file has parent"))
                .map_err(|error| format!("创建 {} 的资源子目录失败：{error}", self.name))?;
            #[cfg(target_os = "macos")]
            if let Some(link) = &file.link_target {
                if fs::read_link(&file.source).ok().as_ref() != Some(link) {
                    return Err(format!("{} 的资源软链接在复制前已改变", self.name));
                }
                std::os::unix::fs::symlink(link, &target)
                    .map_err(|error| format!("复制 {} 的资源软链接失败：{error}", self.name))?;
                if fs::read_link(&target).ok().as_ref() != Some(link) {
                    return Err(format!("{} 的资源软链接副本校验失败", self.name));
                }
                copied_bytes += file.bytes;
                progress(copied_bytes, total_bytes);
                continue;
            }
            let copied = fs::copy(&file.source, &target)
                .map_err(|error| format!("复制 {} 的资源失败：{error}", self.name))?;
            if copied != file.bytes || hash_file(&file.source)? != hash_file(&target)? {
                return Err(format!("{} 的资源副本校验失败", self.name));
            }
            copied_bytes += file.bytes;
            progress(copied_bytes, total_bytes);
        }
        #[cfg(target_os = "macos")]
        {
            let staged_root = staging
                .path()
                .canonicalize()
                .map_err(|error| error.to_string())?;
            for file in &files {
                if file.link_target.is_some() {
                    let target = staging
                        .path()
                        .join(&file.relative)
                        .canonicalize()
                        .map_err(|_| "资源软链接副本悬空或循环")?;
                    if !target.starts_with(&staged_root) {
                        return Err("资源软链接副本超出暂存目录".into());
                    }
                }
            }
        }
        if self.manifest_hash(staging.path()).as_deref() != Some(&manifest_sha256)
            || !ready(staging.path())
        {
            return Err(format!("{} 的迁移副本不完整", self.name));
        }
        let marker = CompleteMarker {
            schema_version: 1,
            component: self.name.into(),
            manifest_sha256,
            file_count: files.len() as u64,
            total_bytes,
        };
        fs::write(
            staging.path().join(".complete.json"),
            serde_json::to_vec(&marker).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("写入 {} 的完成标记失败：{error}", self.name))?;
        if !self.valid_content(staging.path(), ready) || !self.critical_files_ready(staging.path())
        {
            return Err(format!("{} 的完成标记校验失败", self.name));
        }
        if destination.exists() {
            // Preserve a damaged previous version until a verified replacement is published.
            let quarantine = self
                .component_dir()
                .join(format!(".invalid-{}", Uuid::new_v4()));
            fs::rename(&destination, quarantine)
                .map_err(|error| format!("隔离 {} 的旧副本失败：{error}", self.name))?;
        }
        let staged_root = staging
            .path()
            .canonicalize()
            .map_err(|error| format!("确认 {} 的迁移目录失败：{error}", self.name))?;
        fs::rename(staging.path(), &destination)
            .map_err(|error| format!("发布 {} 的持久副本失败：{error}", self.name))?;
        self.retarget_critical_cache(&staged_root, &destination);
        if !self.stored_ready(&destination, ready) {
            return Err(format!("{} 的持久副本发布后校验失败", self.name));
        }
        Ok(())
    }

    fn component_dir(&self) -> PathBuf {
        self.store_base.join(self.name)
    }

    fn cleanup_old_versions(&self, ready: fn(&Path) -> bool) -> Result<(), String> {
        let bundled_target = self
            .manifest_hash(&self.bundled_root)
            .map(|digest| self.component_dir().join(digest))
            .filter(|root| self.stored_ready(root, ready));
        let Some(current) = bundled_target.or_else(|| self.stored_root(ready)) else {
            return Err("当前持久资源不存在，未清理旧版本".into());
        };
        let parent = self.component_dir();
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(parent.join(".migration.lock"))
            .map_err(|error| error.to_string())?;
        lock.lock_exclusive().map_err(|error| error.to_string())?;
        if !self.stored_ready(&current, ready) {
            return Err("当前持久资源校验失败，未清理旧版本".into());
        }
        let canonical_store = self
            .store_base
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
        if !parent
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_dir())
            || canonical_parent.parent() != Some(canonical_store.as_path())
        {
            return Err("资源组件目录路径不可信，未清理旧版本".into());
        }
        let mut older = Vec::new();
        for entry in fs::read_dir(&parent).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.len() != 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || path == current
                || !path
                    .symlink_metadata()
                    .is_ok_and(|meta| meta.file_type().is_dir())
                || !path
                    .canonicalize()
                    .is_ok_and(|resolved| resolved.parent() == Some(canonical_parent.as_path()))
            {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            older.push((modified, path));
        }
        older.sort_by(|left, right| right.0.cmp(&left.0));
        let mut kept_rollback = false;
        for (_, path) in older {
            if !kept_rollback && self.rollback_version_ready(&path, ready) {
                kept_rollback = true;
                continue;
            }
            // Check again immediately before the recursive operation. Never recurse through
            // an untrusted link, quarantine, staging directory, or path outside this component.
            if path
                .symlink_metadata()
                .is_ok_and(|meta| meta.file_type().is_dir())
                && path
                    .canonicalize()
                    .is_ok_and(|resolved| resolved.parent() == Some(canonical_parent.as_path()))
                && !tree_contains_reparse(&path, &canonical_parent)
            {
                if let Err(error) = fs::remove_dir_all(&path) {
                    tauri_plugin_log::log::warn!(
                        "failed to remove old runtime component {}: {error}",
                        path.display()
                    );
                }
            }
        }
        Ok(())
    }

    fn rollback_version_ready(&self, root: &Path, ready: fn(&Path) -> bool) -> bool {
        let manifest = root.join(self.manifest_relative);
        if !manifest
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= 2 * 1024 * 1024)
        {
            return false;
        }
        let Some(expected) = root.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        if hash_file(&manifest).ok().as_deref() != Some(expected) {
            return false;
        }
        let Ok(marker) = fs::read(root.join(".complete.json")) else {
            return false;
        };
        if marker.len() > 4096 {
            return false;
        }
        let Ok(marker) = serde_json::from_slice::<CompleteMarker>(&marker) else {
            return false;
        };
        marker.schema_version == 1
            && marker.component == self.name
            && marker.manifest_sha256 == expected
            && ready(root)
            && self.critical_files_ready(root)
    }

    fn estimate_bytes(&self, ready: fn(&Path) -> bool) -> Result<u64, String> {
        if self.bundled_ready(ready) {
            let mut files = Vec::new();
            let mut directories = Vec::new();
            let canonical_root = self
                .bundled_root
                .canonicalize()
                .map_err(|error| error.to_string())?;
            collect_files(
                &self.bundled_root,
                Path::new(""),
                &canonical_root,
                &mut HashSet::new(),
                &mut directories,
                &mut files,
            )?;
            Ok(files.iter().map(|file| file.bytes).sum())
        } else if let Some(root) = self.stored_root(ready) {
            let marker =
                fs::read(root.join(".complete.json")).map_err(|error| error.to_string())?;
            let marker: CompleteMarker =
                serde_json::from_slice(&marker).map_err(|error| error.to_string())?;
            Ok(marker.total_bytes)
        } else {
            Err(format!("{} 的内置资源和持久副本均不可用", self.name))
        }
    }

    fn bundled_ready(&self, ready: fn(&Path) -> bool) -> bool {
        self.manifest_hash(&self.bundled_root).is_some()
            && ready(&self.bundled_root)
            && self.critical_files_ready(&self.bundled_root)
    }

    pub(crate) fn stored_ready(&self, root: &Path, ready: fn(&Path) -> bool) -> bool {
        if !root
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_dir())
        {
            return false;
        }
        let Ok(parent) = self.component_dir().canonicalize() else {
            return false;
        };
        if !root
            .canonicalize()
            .is_ok_and(|path| path.starts_with(parent))
        {
            return false;
        }
        let Some(manifest_sha256) = self.manifest_hash(root) else {
            return false;
        };
        root.file_name().and_then(|name| name.to_str()) == Some(manifest_sha256.as_str())
            && self.valid_content(root, ready)
            && self.critical_files_ready(root)
    }

    fn valid_content(&self, root: &Path, ready: fn(&Path) -> bool) -> bool {
        let Ok(marker_bytes) = fs::read(root.join(".complete.json")) else {
            return false;
        };
        if marker_bytes.len() > 4096 {
            return false;
        }
        let Ok(marker) = serde_json::from_slice::<CompleteMarker>(&marker_bytes) else {
            return false;
        };
        marker.schema_version == 1
            && marker.component == self.name
            && self.manifest_hash(root).as_deref() == Some(marker.manifest_sha256.as_str())
            && ready(root)
    }

    fn manifest_hash(&self, root: &Path) -> Option<String> {
        let path = root.join(self.manifest_relative);
        let metadata = path.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
            return None;
        }
        let root = root.canonicalize().ok()?;
        if !path.canonicalize().ok()?.starts_with(root) {
            return None;
        }
        let digest = hash_file(&path).ok()?;
        self.trusted_manifest(&path, &digest).then_some(digest)
    }

    /// The component manager adds exact archive/inventory validation before this native
    /// check. Keeping this check here preserves the same executable pins as bundled lookup.
    pub(crate) fn verified_candidate(&self, root: &Path, ready: fn(&Path) -> bool) -> bool {
        self.manifest_hash(root).is_some() && ready(root) && self.critical_files_ready(root)
    }

    fn trusted_manifest(&self, path: &Path, digest: &str) -> bool {
        if self.name == "test-component" {
            return true;
        }
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return false;
        };
        let pinned = match self.name {
            "blender" => {
                let inventory = env!("IC_BLENDER_INVENTORY_SHA256");
                let executable = env!("IC_BLENDER_EXECUTABLE");
                pinned_text(env!("IC_BLENDER_MANIFEST_SHA256"), Some(digest))
                    && pinned_text(inventory, value["inventory"]["sha256"].as_str())
                    && pinned_text(executable, value["executable"].as_str())
            }
            "remotion-runtime" => {
                let inventory = env!("IC_REMOTION_INVENTORY_SHA256");
                pinned_text(env!("IC_REMOTION_MANIFEST_SHA256"), Some(digest))
                    && pinned_text(inventory, value["inventory"]["sha256"].as_str())
            }
            "ai-media-runtime" => {
                // Optional does not mean untrusted: never execute an imported
                // Python pack whose inventory was not pinned by this build.
                let expected = env!("IC_AI_MEDIA_MANIFEST_SHA256");
                let inventory = env!("IC_AI_MEDIA_INVENTORY_SHA256");
                !expected.is_empty()
                    && !inventory.is_empty()
                    && pinned_text(expected, Some(digest))
                    && pinned_text(inventory, value["inventory"]["sha256"].as_str())
            }
            "ai-media-quality-runtime" => {
                let expected = env!("IC_AI_MEDIA_QUALITY_MANIFEST_SHA256");
                let inventory = env!("IC_AI_MEDIA_QUALITY_INVENTORY_SHA256");
                !expected.is_empty()
                    && !inventory.is_empty()
                    && pinned_text(expected, Some(digest))
                    && pinned_text(inventory, value["inventory"]["sha256"].as_str())
            }
            "pose-runtime" => {
                let expected = option_env!("IC_POSE_MANIFEST_SHA256").unwrap_or("");
                let inventory = option_env!("IC_POSE_INVENTORY_SHA256").unwrap_or("");
                !expected.is_empty()
                    && !inventory.is_empty()
                    && pinned_text(expected, Some(digest))
                    && pinned_text(inventory, value["inventory"]["sha256"].as_str())
            }
            "gpt-image-2-style-library" => {
                let expected = env!("IC_STYLE_MANIFEST_SHA256");
                pinned_text(expected, Some(digest))
            }
            _ => true,
        };
        if !pinned {
            return false;
        }
        if self.name != "ffmpeg" {
            return true;
        }
        if !pinned_text(env!("IC_FFMPEG_MANIFEST_SHA256"), Some(digest)) {
            return false;
        }
        let ffmpeg_pin = env!("IC_FFMPEG_SHA256");
        if (ffmpeg_pin.is_empty() && !cfg!(debug_assertions))
            || (!ffmpeg_pin.is_empty() && value["ffmpegSha256"].as_str() != Some(ffmpeg_pin))
        {
            return false;
        }
        let ffprobe_pin = env!("IC_FFPROBE_SHA256");
        ffprobe_pin_matches(&value, ffprobe_pin, cfg!(target_os = "macos"))
            || (cfg!(debug_assertions) && ffprobe_pin.is_empty())
    }

    fn critical_files_ready(&self, root: &Path) -> bool {
        #[cfg(target_os = "macos")]
        if !self.executable_modes_ready(root) {
            return false;
        }
        let Some(targets) = self.critical_targets(root) else {
            return false;
        };
        if targets.is_empty() {
            return true;
        }
        let Ok(canonical_root) = root.canonicalize() else {
            return false;
        };
        let mut stamps = Vec::with_capacity(targets.len());
        for (relative, _) in &targets {
            let path = root.join(relative);
            let Ok(canonical) = path.canonicalize() else {
                return false;
            };
            if !canonical.starts_with(&canonical_root) {
                return false;
            }
            let Ok(metadata) = path.metadata() else {
                return false;
            };
            if !metadata.is_file() {
                return false;
            }
            let Ok(modified) = metadata.modified() else {
                return false;
            };
            stamps.push(FileStamp {
                path: canonical,
                bytes: metadata.len(),
                modified,
                #[cfg(unix)]
                mode: {
                    use std::os::unix::fs::PermissionsExt as _;
                    metadata.permissions().mode()
                },
            });
        }
        {
            let cache = self
                .verified_critical
                .lock()
                .expect("component validation cache poisoned");
            if cache
                .as_ref()
                .is_some_and(|cached| cached.root == canonical_root && cached.stamps == stamps)
            {
                return true;
            }
        }
        // dev 构建只做元数据级校验（存在性、位于根内、文件类型、大小、修改时间已在
        // 上方逐项检查），跳过逐文件 SHA-256：dev 树由本仓库 prepare 脚本生成，而
        // debug 模式的 sha2 实现慢 10-50 倍，对 ffmpeg/blender/remotion 的关键可执行
        // 文件（约 1.6GB）全量哈希实测阻塞 30-100 秒，叠加 Defender 实时扫描更久；
        // 该哈希又可能被同步 command 在主线程触发（preflight / 引擎状态查询），
        // 直接把窗口冻成“未响应”。防篡改校验属于发布场景，release 不受影响。
        if cfg!(debug_assertions) {
            return true;
        }
        for ((_, expected), stamp) in targets.iter().zip(&stamps) {
            if hash_file(&stamp.path).ok().as_deref() != Some(expected.as_str()) {
                return false;
            }
        }
        *self
            .verified_critical
            .lock()
            .expect("component validation cache poisoned") = Some(VerifiedCritical {
            root: canonical_root,
            stamps,
        });
        true
    }

    #[cfg(target_os = "macos")]
    fn executable_modes_ready(&self, root: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt as _;
        if !matches!(
            self.name,
            "blender"
                | "ffmpeg"
                | "remotion-runtime"
                | "ai-media-runtime"
                | "ai-media-quality-runtime"
        ) {
            return true;
        }
        let Some(manifest) = fs::read(root.join(self.manifest_relative))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        else {
            return false;
        };
        let paths = match self.name {
            "ffmpeg" => {
                let mut paths = vec!["ffmpeg"];
                if manifest["ffprobeSha256"].is_string() {
                    paths.push("ffprobe");
                }
                paths
            }
            "remotion-runtime" => {
                vec!["node", manifest["browserExecutable"].as_str().unwrap_or("")]
            }
            "blender" => vec![manifest["executable"].as_str().unwrap_or("")],
            _ => vec![manifest["pythonPath"].as_str().unwrap_or("")],
        };
        paths.into_iter().all(|relative| {
            safe_relative(relative)
                .and_then(|relative| root.join(relative).metadata().ok())
                .is_some_and(|metadata| {
                    let mode = metadata.permissions().mode();
                    metadata.is_file() && mode & 0o111 != 0 && mode & 0o6000 == 0
                })
        })
    }

    pub(crate) fn retarget_critical_cache(&self, previous_root: &Path, destination: &Path) {
        let Ok(destination) = destination.canonicalize() else {
            return;
        };
        let mut cache = self
            .verified_critical
            .lock()
            .expect("component validation cache poisoned");
        let Some(cached) = cache.as_mut() else {
            return;
        };
        if cached.root != previous_root {
            return;
        }
        for stamp in &mut cached.stamps {
            let Ok(relative) = stamp.path.strip_prefix(previous_root) else {
                return;
            };
            stamp.path = destination.join(relative);
        }
        cached.root = destination;
    }

    fn critical_targets(&self, root: &Path) -> Option<Vec<(PathBuf, String)>> {
        if self.name == "test-component" {
            return Some(Vec::new());
        }
        let bytes = fs::read(root.join(self.manifest_relative)).ok()?;
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let targets = match self.name {
            "ffmpeg" => ffmpeg_targets(root, &manifest, cfg!(target_os = "macos"))?,
            "blender" | "ai-media-runtime" | "ai-media-quality-runtime" | "pose-runtime" => {
                inventory_targets(root, &manifest)?
            }
            "remotion-runtime" => {
                if manifest["inventory"].is_object() {
                    inventory_targets(root, &manifest)?
                } else if cfg!(debug_assertions) {
                    let critical = manifest["criticalSha256"].as_object()?;
                    if critical.len() < 5 {
                        return None;
                    }
                    critical
                        .iter()
                        .map(|(path, digest)| {
                            Some((safe_relative(path)?, digest.as_str()?.to_owned()))
                        })
                        .collect::<Option<Vec<_>>>()?
                } else {
                    return None;
                }
            }
            "gpt-image-2-style-library" => manifest["files"]
                .as_array()?
                .iter()
                .map(|entry| {
                    Some((
                        safe_relative(entry["path"].as_str()?)?,
                        entry["sha256"].as_str()?.to_owned(),
                    ))
                })
                .collect::<Option<Vec<_>>>()?,
            _ => return Some(Vec::new()),
        };
        if targets.iter().any(|(_, digest)| {
            digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return None;
        }
        Some(targets)
    }
}

fn tree_contains_reparse(root: &Path, allowed_parent: &Path) -> bool {
    fn visit(path: &Path, allowed_parent: &Path) -> Result<(), ()> {
        let metadata = path.symlink_metadata().map_err(|_| ())?;
        #[cfg(target_os = "macos")]
        if metadata.file_type().is_symlink() {
            // remove_dir_all removes the link itself; never recurse into its target.
            return path
                .canonicalize()
                .ok()
                .filter(|resolved| resolved.starts_with(allowed_parent))
                .map(|_| ())
                .ok_or(());
        }
        if metadata.file_type().is_symlink()
            || !path
                .canonicalize()
                .is_ok_and(|resolved| resolved.starts_with(allowed_parent))
        {
            return Err(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt as _;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(());
            }
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| ())? {
                visit(&entry.map_err(|_| ())?.path(), allowed_parent)?;
            }
        } else if !metadata.is_file() {
            return Err(());
        }
        Ok(())
    }
    visit(root, allowed_parent).is_err()
}

fn safe_relative(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    (!path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_))))
    .then_some(path)
}

fn cleanup_incomplete_staging(component_dir: &Path) -> Result<(), String> {
    let canonical_parent = component_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    for entry in fs::read_dir(component_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with(".staging-") {
            continue;
        }
        let path = entry.path();
        if !path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_dir())
            || !path
                .canonicalize()
                .is_ok_and(|resolved| resolved.starts_with(&canonical_parent))
        {
            return Err("暂存目录路径不可信，已停止资源迁移".into());
        }
        fs::remove_dir_all(path).map_err(|error| format!("清理中断的资源暂存目录失败：{error}"))?;
    }
    Ok(())
}

fn pinned_text(expected: &str, actual: Option<&str>) -> bool {
    if expected.is_empty() {
        cfg!(debug_assertions)
    } else {
        actual == Some(expected)
    }
}

fn ffprobe_pin_matches(manifest: &serde_json::Value, expected: &str, optional: bool) -> bool {
    if !expected.is_empty() {
        manifest["ffprobeSha256"].as_str() == Some(expected)
    } else {
        optional
            && manifest.get("ffprobeSha256") == Some(&serde_json::Value::Null)
            && manifest["ffprobeUnavailable"] == true
    }
}

fn ffmpeg_targets(
    root: &Path,
    manifest: &serde_json::Value,
    ffprobe_optional: bool,
) -> Option<Vec<(PathBuf, String)>> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut targets = vec![(
        PathBuf::from(format!("ffmpeg{suffix}")),
        manifest["ffmpegSha256"].as_str()?.to_owned(),
    )];
    if let Some(hash) = manifest["ffprobeSha256"].as_str() {
        targets.push((PathBuf::from(format!("ffprobe{suffix}")), hash.to_owned()));
    } else if !ffprobe_optional
        || manifest.get("ffprobeSha256") != Some(&serde_json::Value::Null)
        || manifest["ffprobeUnavailable"] != true
        || root.join(format!("ffprobe{suffix}")).exists()
    {
        return None;
    }
    Some(targets)
}

fn inventory_targets(root: &Path, manifest: &serde_json::Value) -> Option<Vec<(PathBuf, String)>> {
    let relative = safe_relative(manifest["inventory"]["path"].as_str()?)?;
    let inventory = root.join(relative);
    let canonical_root = root.canonicalize().ok()?;
    if !inventory.canonicalize().ok()?.starts_with(&canonical_root) {
        return None;
    }
    let bytes = fs::read(&inventory).ok()?;
    if bytes.len() > 16 * 1024 * 1024
        || hex::encode(Sha256::digest(&bytes)) != manifest["inventory"]["sha256"].as_str()?
    {
        return None;
    }
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&bytes).ok()?;
    if entries.len() as u64 != manifest["inventory"]["count"].as_u64()? {
        return None;
    }
    #[cfg(target_os = "macos")]
    for entry in &entries {
        use std::os::unix::fs::PermissionsExt as _;
        let relative = safe_relative(entry["path"].as_str()?)?;
        let path = root.join(&relative);
        let metadata = path.symlink_metadata().ok()?;
        let kind = entry
            .get("type")
            .map(|kind| kind.as_str())
            .unwrap_or(Some("file"))?;
        match kind {
            "file" => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return None;
                }
                if let Some(mode) = entry["mode"].as_u64() {
                    if metadata.permissions().mode() & 0o7777 != (mode as u32 & 0o777) {
                        return None;
                    }
                }
            }
            "symlink" => {
                let target = entry["target"].as_str()?;
                super::component_archive::link_destination(entry["path"].as_str()?, target).ok()?;
                if !metadata.file_type().is_symlink()
                    || fs::read_link(&path).ok()?.to_str() != Some(target)
                {
                    return None;
                }
                let resolved = path.canonicalize().ok()?;
                let resolved_metadata = fs::metadata(&resolved).ok()?;
                if !resolved.starts_with(&canonical_root)
                    || (!resolved_metadata.is_file() && !resolved_metadata.is_dir())
                    || (resolved_metadata.is_dir()
                        && path.parent()?.canonicalize().ok()?.starts_with(&resolved))
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    entries
        .into_iter()
        .filter(|entry| {
            entry
                .get("type")
                .is_none_or(|kind| kind.as_str() == Some("file"))
        })
        .map(|entry| {
            Some((
                safe_relative(entry["path"].as_str()?)?,
                entry["sha256"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

fn collect_files(
    source: &Path,
    relative: &Path,
    canonical_root: &Path,
    active_directories: &mut HashSet<PathBuf>,
    directories: &mut Vec<PathBuf>,
    files: &mut Vec<SourceFile>,
) -> Result<(), String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("读取资源路径失败：{error}"))?;
    if !canonical.starts_with(canonical_root) || !active_directories.insert(canonical.clone()) {
        return Err("资源目录含越界或循环链接".into());
    }
    for entry in fs::read_dir(source).map_err(|error| format!("列出资源文件失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取资源文件失败：{error}"))?;
        let name = PathBuf::from(entry.file_name());
        if !name
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("资源文件名无效".into());
        }
        let item_relative = relative.join(name);
        let item = entry.path();
        let resolved = item
            .canonicalize()
            .map_err(|error| format!("解析资源链接失败：{error}"))?;
        if !resolved.starts_with(canonical_root) {
            return Err("资源链接超出内置目录".into());
        }
        let metadata =
            fs::metadata(&resolved).map_err(|error| format!("读取资源元数据失败：{error}"))?;
        #[cfg(target_os = "macos")]
        if item
            .symlink_metadata()
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            let target = fs::read_link(&item).map_err(|error| error.to_string())?;
            let target_text = target.to_str().ok_or("资源软链接目标编码无效")?;
            let path_text = item_relative.to_str().ok_or("资源软链接路径编码无效")?;
            super::component_archive::link_destination(path_text, target_text)?;
            if (!metadata.is_file() && !metadata.is_dir())
                || (metadata.is_dir()
                    && item
                        .parent()
                        .ok_or("资源软链接路径无效")?
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        .starts_with(&resolved))
            {
                return Err("资源软链接类型无效或指向祖先目录".into());
            }
            files.push(SourceFile {
                relative: item_relative,
                source: item,
                bytes: target_text.len() as u64,
                link_target: Some(target),
            });
            continue;
        }
        if metadata.is_dir() {
            directories.push(item_relative.clone());
            collect_files(
                &item,
                &item_relative,
                canonical_root,
                active_directories,
                directories,
                files,
            )?;
        } else if metadata.is_file() {
            files.push(SourceFile {
                relative: item_relative,
                source: resolved,
                bytes: metadata.len(),
                #[cfg(target_os = "macos")]
                link_target: None,
            });
        } else {
            return Err("资源含不支持的文件类型".into());
        }
    }
    active_directories.remove(&canonical);
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_ready(root: &Path) -> bool {
        root.join("runtime/tool.exe").is_file()
    }

    fn write_inventory_manifest(root: &Path, entries: serde_json::Value) -> serde_json::Value {
        let bytes = serde_json::to_vec(&entries).unwrap();
        fs::write(root.join("files-manifest.json"), &bytes).unwrap();
        let manifest = serde_json::json!({
            "inventory": {
                "path": "files-manifest.json",
                "sha256": hex::encode(Sha256::digest(&bytes)),
                "count": entries.as_array().unwrap().len(),
            }
        });
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        manifest
    }

    #[test]
    fn native_pose_inventory_accepts_untyped_regular_files_and_explicit_file_entries() {
        let temp = tempfile::tempdir().unwrap();
        let plain = "pose_landmarker_full.task";
        let typed = "LICENSE.txt";
        fs::write(temp.path().join(plain), b"pose-model").unwrap();
        fs::write(temp.path().join(typed), b"license").unwrap();
        let plain_digest = hex::encode(Sha256::digest(b"pose-model"));
        let typed_digest = hex::encode(Sha256::digest(b"license"));
        let manifest = write_inventory_manifest(
            temp.path(),
            serde_json::json!([
                {"path": plain, "size": 10, "sha256": plain_digest},
                {"path": typed, "type": "file", "size": 7, "sha256": typed_digest},
            ]),
        );
        assert_eq!(
            inventory_targets(temp.path(), &manifest),
            Some(vec![
                (PathBuf::from(plain), plain_digest),
                (PathBuf::from(typed), typed_digest),
            ])
        );
        let component = RuntimeComponent::new(
            temp.path().join("store"),
            temp.path().into(),
            "pose-runtime",
            "manifest.json",
        );
        assert!(component.critical_files_ready(temp.path()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_inventory_checks_framework_links_and_file_permissions() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};
        let temp = tempfile::tempdir().unwrap();
        let engine_relative = "Framework/Versions/A/Resources/engine";
        let link_relative = "Framework/Resources";
        fs::create_dir_all(temp.path().join("Framework/Versions/A/Resources")).unwrap();
        let engine = temp.path().join(engine_relative);
        fs::write(&engine, b"engine-bytes").unwrap();
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        symlink("A", temp.path().join("Framework/Versions/Current")).unwrap();
        let link = temp.path().join(link_relative);
        symlink("Versions/Current/Resources", &link).unwrap();
        let digest = hex::encode(Sha256::digest(b"engine-bytes"));
        let manifest = write_inventory_manifest(
            temp.path(),
            serde_json::json!([
                {"path": engine_relative, "type": "file", "mode": 0o755, "sha256": digest},
                {"path": "Framework/Versions/Current", "type": "symlink", "target": "A"},
                {"path": link_relative, "type": "symlink", "target": "Versions/Current/Resources"},
            ]),
        );
        assert_eq!(
            inventory_targets(temp.path(), &manifest),
            Some(vec![(PathBuf::from(engine_relative), digest)])
        );
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(inventory_targets(temp.path(), &manifest).is_none());
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(temp.path(), &link).unwrap();
        assert!(inventory_targets(temp.path(), &manifest).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_executable_readiness_rejects_removed_execute_permission() {
        use std::os::unix::fs::PermissionsExt as _;
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("manifest.json"),
            b"{\"ffprobeSha256\":null}",
        )
        .unwrap();
        let engine = temp.path().join("ffmpeg");
        fs::write(&engine, b"engine-bytes").unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("store"),
            temp.path().into(),
            "ffmpeg",
            "manifest.json",
        );
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(component.executable_modes_ready(temp.path()));
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!component.executable_modes_ready(temp.path()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn migration_preserves_framework_symlinks_and_executable_permissions() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("bundle/component");
        fs::create_dir_all(bundled.join("runtime/Framework/Versions/A/Resources")).unwrap();
        fs::write(bundled.join("manifest.json"), b"version-1").unwrap();
        fs::write(bundled.join("runtime/tool.exe"), b"runtime-bytes").unwrap();
        fs::set_permissions(
            bundled.join("runtime/tool.exe"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(
            bundled.join("runtime/Framework/Versions/A/Resources/payload"),
            b"payload",
        )
        .unwrap();
        symlink("A", bundled.join("runtime/Framework/Versions/Current")).unwrap();
        symlink(
            "Versions/Current/Resources",
            bundled.join("runtime/Framework/Resources"),
        )
        .unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("appdata/runtime-components"),
            bundled,
            "test-component",
            "manifest.json",
        );
        component.migrate(fixture_ready, |_, _| {}).unwrap();
        let stored = component.stored_root(fixture_ready).unwrap();
        assert_eq!(
            fs::read_link(stored.join("runtime/Framework/Versions/Current")).unwrap(),
            PathBuf::from("A")
        );
        assert_eq!(
            fs::read(stored.join("runtime/Framework/Resources/payload")).unwrap(),
            b"payload"
        );
        assert_eq!(
            fs::metadata(stored.join("runtime/tool.exe"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn migration_publishes_only_verified_complete_copy_and_survives_bundle_removal() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("bundle/component");
        fs::create_dir_all(bundled.join("runtime")).unwrap();
        fs::write(bundled.join("manifest.json"), b"version-1").unwrap();
        fs::write(bundled.join("runtime/tool.exe"), b"runtime-bytes").unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("appdata/runtime-components"),
            bundled.clone(),
            "test-component",
            "manifest.json",
        );
        assert_eq!(component.resolve(fixture_ready), Some(bundled.clone()));
        component.migrate(fixture_ready, |_, _| {}).unwrap();
        let stored = component
            .component_dir()
            .join(component.manifest_hash(&bundled).unwrap());
        assert!(component.stored_ready(&stored, fixture_ready));
        fs::remove_dir_all(&bundled).unwrap();
        assert_eq!(component.resolve(fixture_ready), Some(stored.clone()));
        fs::write(stored.join("manifest.json"), b"tampered").unwrap();
        assert_eq!(component.resolve(fixture_ready), None);
    }

    #[test]
    fn cleanup_retains_current_and_one_prior_sha_version_only() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("bundle/component");
        fs::create_dir_all(bundled.join("runtime")).unwrap();
        fs::write(bundled.join("manifest.json"), b"current").unwrap();
        fs::write(bundled.join("runtime/tool.exe"), b"runtime-bytes").unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("appdata/runtime-components"),
            bundled.clone(),
            "test-component",
            "manifest.json",
        );
        component.migrate(fixture_ready, |_, _| {}).unwrap();
        let current = component
            .component_dir()
            .join(component.manifest_hash(&bundled).unwrap());
        let mut older = Vec::new();
        for index in 0..3 {
            let manifest = format!("old-{index}");
            let name = hex::encode(Sha256::digest(manifest.as_bytes()));
            let path = component.component_dir().join(&name);
            fs::create_dir_all(path.join("runtime")).unwrap();
            fs::write(path.join("manifest.json"), &manifest).unwrap();
            fs::write(path.join("runtime/tool.exe"), b"runtime-bytes").unwrap();
            fs::write(
                path.join(".complete.json"),
                serde_json::to_vec(&CompleteMarker {
                    schema_version: 1,
                    component: "test-component".into(),
                    manifest_sha256: name.clone(),
                    file_count: 2,
                    total_bytes: manifest.len() as u64 + b"runtime-bytes".len() as u64,
                })
                .unwrap(),
            )
            .unwrap();
            older.push(name);
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        fs::write(
            component
                .component_dir()
                .join(&older[2])
                .join("manifest.json"),
            b"damaged",
        )
        .unwrap();
        let ignored = component.component_dir().join(".objects");
        fs::create_dir_all(&ignored).unwrap();
        component.cleanup_old_versions(fixture_ready).unwrap();
        assert!(current.is_dir());
        assert!(ignored.is_dir());
        assert_eq!(
            older
                .iter()
                .filter(|name| component.component_dir().join(name).exists())
                .count(),
            1
        );
        assert!(component.component_dir().join(&older[1]).is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_guard_rejects_nested_junction() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("runtime-components");
        let old = parent.join("a".repeat(64));
        let outside = temp.path().join("outside");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let script = temp.path().join("junction.ps1");
        fs::write(&script, "param([string]$Link,[string]$Target)\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n").unwrap();
        use std::os::windows::process::CommandExt as _;
        let output = std::process::Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-File")
            .arg(&script)
            .arg("-Link")
            .arg(old.join("escape"))
            .arg("-Target")
            .arg(&outside)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed: {output:?}"
        );
        assert!(tree_contains_reparse(&old, &parent.canonicalize().unwrap()));
        assert!(outside.join("keep.txt").is_file());
    }

    #[test]
    fn incomplete_store_cannot_pass_readiness() {
        let temp = tempfile::tempdir().unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("store"),
            temp.path().join("missing"),
            "test-component",
            "manifest.json",
        );
        let incomplete = component.component_dir().join("version");
        fs::create_dir_all(incomplete.join("runtime")).unwrap();
        fs::write(incomplete.join("manifest.json"), b"version-1").unwrap();
        fs::write(incomplete.join("runtime/tool.exe"), b"runtime-bytes").unwrap();
        assert_eq!(component.resolve(fixture_ready), None);
    }

    #[test]
    fn pinned_ffmpeg_manifest_rejects_changed_bundled_executables() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("ffmpeg");
        fs::create_dir_all(&bundled).unwrap();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        fs::write(bundled.join(format!("ffmpeg{suffix}")), b"changed-ffmpeg").unwrap();
        fs::write(bundled.join(format!("ffprobe{suffix}")), b"changed-ffprobe").unwrap();
        fs::write(
            bundled.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "ffmpegSha256": env!("IC_FFMPEG_SHA256"),
                "ffprobeSha256": env!("IC_FFPROBE_SHA256"),
            }))
            .unwrap(),
        )
        .unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("store"),
            bundled,
            "ffmpeg",
            "manifest.json",
        );
        assert_eq!(
            component.resolve(super::super::composer::engine_ready_in),
            None
        );
    }

    #[test]
    fn optional_macos_ffprobe_requires_a_matching_manifest_state() {
        let temp = tempfile::tempdir().unwrap();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let mut manifest = serde_json::json!({
            "ffmpegSha256": "a".repeat(64),
            "ffprobeSha256": null,
            "ffprobeUnavailable": true,
        });
        assert!(ffprobe_pin_matches(&manifest, "", true));
        assert!(!ffprobe_pin_matches(&manifest, "", false));
        assert_eq!(
            ffmpeg_targets(temp.path(), &manifest, true).unwrap().len(),
            1
        );
        assert!(ffmpeg_targets(temp.path(), &manifest, false).is_none());

        fs::write(temp.path().join(format!("ffprobe{suffix}")), b"probe").unwrap();
        assert!(ffmpeg_targets(temp.path(), &manifest, true).is_none());

        manifest["ffprobeSha256"] = serde_json::json!("b".repeat(64));
        manifest["ffprobeUnavailable"] = serde_json::json!(false);
        assert!(ffprobe_pin_matches(&manifest, &"b".repeat(64), true));
        assert_eq!(
            ffmpeg_targets(temp.path(), &manifest, true).unwrap().len(),
            2
        );
    }

    #[test]
    fn style_reference_images_resolve_from_persistent_copy_after_bundle_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("bundle/skills/gpt-image-2-style-library");
        fs::create_dir_all(bundled.join("data")).unwrap();
        fs::create_dir_all(bundled.join("assets/images")).unwrap();
        for name in ["manifest.json", "cases.json", "templates.json"] {
            fs::write(bundled.join("data").join(name), b"fixture").unwrap();
        }
        fs::write(bundled.join("assets/images/case1.jpg"), b"image-bytes").unwrap();
        let component = RuntimeComponent::new(
            temp.path().join("appdata/runtime-components"),
            bundled.clone(),
            "test-component",
            "data/manifest.json",
        );
        component
            .migrate(
                super::super::gpt_image_style_library::style_component_ready,
                |_, _| {},
            )
            .unwrap();
        fs::remove_dir_all(bundled).unwrap();
        let stored = component
            .resolve(super::super::gpt_image_style_library::style_component_ready)
            .unwrap();
        assert_eq!(
            fs::read(stored.join("assets/images/case1.jpg")).unwrap(),
            b"image-bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn internal_directory_link_is_materialized_as_files_in_the_persistent_copy() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("bundle");
        fs::create_dir_all(bundled.join("node_modules/.pnpm/package")).unwrap();
        fs::write(bundled.join("manifest.json"), b"version-1").unwrap();
        fs::write(
            bundled.join("node_modules/.pnpm/package/index.js"),
            b"module-bytes",
        )
        .unwrap();
        let script = temp.path().join("junction.ps1");
        fs::write(
            &script,
            "param([string]$Link,[string]$Target)\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n",
        )
        .unwrap();
        use std::os::windows::process::CommandExt as _;
        let output = std::process::Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-File")
            .arg(script)
            .arg("-Link")
            .arg(bundled.join("node_modules/alias"))
            .arg("-Target")
            .arg(bundled.join("node_modules/.pnpm/package"))
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed: {output:?}"
        );
        let component = RuntimeComponent::new(
            temp.path().join("appdata/runtime-components"),
            bundled.clone(),
            "test-component",
            "manifest.json",
        );
        component
            .migrate(
                |root| root.join("node_modules/alias/index.js").is_file(),
                |_, _| {},
            )
            .unwrap();
        fs::remove_dir_all(bundled).unwrap();
        let stored = component
            .resolve(|root| root.join("node_modules/alias/index.js").is_file())
            .unwrap();
        assert_eq!(
            fs::read(stored.join("node_modules/alias/index.js")).unwrap(),
            b"module-bytes"
        );
        assert!(
            stored
                .join("node_modules/alias")
                .metadata()
                .unwrap()
                .is_dir()
        );
        assert!(
            !stored
                .join("node_modules/alias")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    #[ignore = "requires prepared Remotion resources; run explicitly when changing junction or inventory handling"]
    fn prepared_remotion_inventory_matches_every_logical_file_after_junction_expansion() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remotion-runtime");
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("runtime-manifest.json")).unwrap()).unwrap();
        let inventory = inventory_targets(&root, &manifest).unwrap();
        let mut directories = Vec::new();
        let mut files = Vec::new();
        collect_files(
            &root,
            Path::new(""),
            &root.canonicalize().unwrap(),
            &mut HashSet::new(),
            &mut directories,
            &mut files,
        )
        .unwrap();
        let actual = files
            .iter()
            .filter(|file| {
                file.relative != Path::new("runtime-manifest.json")
                    && file.relative != Path::new("files-manifest.json")
            })
            .map(|file| (file.relative.clone(), file.bytes))
            .collect::<std::collections::HashMap<_, _>>();
        let inventory_rows: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(root.join("files-manifest.json")).unwrap()).unwrap();
        let expected: std::collections::HashMap<_, _> = inventory_rows
            .iter()
            .map(|row| {
                (
                    safe_relative(row["path"].as_str().unwrap()).unwrap(),
                    row["size"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(inventory.len(), expected.len());
        assert_eq!(actual, expected);
        assert_eq!(
            actual.len(),
            manifest["inventory"]["count"].as_u64().unwrap() as usize
        );
    }
}
