//! Prepare a signed, file-addressed runtime resource release before installing a slim updater.
//! Each component is assembled in a private staging directory and published only after every
//! file matches the signed inventory. Previously usable component versions are never removed.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use fs2::FileExt as _;
use futures_util::StreamExt as _;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager as _};
use tokio::time::timeout;
use url::Url;
use uuid::Uuid;

/// 运行资源是否就绪的探针：`fn(资源目录) -> bool`。
///
/// 功能组件下载已下线，这里只保留签名资源更新流程自己用到的探针类型。
type RuntimeReadyProbe = fn(&Path) -> bool;

const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 200_000;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

static RUNNING: AtomicBool = AtomicBool::new(false);
static STATUS: LazyLock<Mutex<RuntimeResourceUpdateStatus>> =
    LazyLock::new(|| Mutex::new(RuntimeResourceUpdateStatus::default()));

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceUpdateStatus {
    pub ready: bool,
    pub preparing: bool,
    pub error: Option<String>,
    pub completed_components: usize,
    pub total_components: usize,
    pub current_component: Option<String>,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub reused_bytes: u64,
    pub downloaded_bytes: u64,
}

pub fn runtime_component_update_status() -> RuntimeResourceUpdateStatus {
    STATUS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceManifest {
    schema_version: u32,
    version: String,
    platform: String,
    object_base_url: String,
    components: Vec<ResourceComponent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceComponent {
    name: String,
    manifest_path: String,
    manifest_sha256: String,
    files: Vec<ResourceFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteMarker<'a> {
    schema_version: u32,
    component: &'a str,
    manifest_sha256: &'a str,
    file_count: u64,
    total_bytes: u64,
}

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

fn update_status(change: impl FnOnce(&mut RuntimeResourceUpdateStatus)) {
    change(
        &mut STATUS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
}

pub async fn prepare_runtime_components_for_update(
    app: &AppHandle,
    version: &str,
    manifest_url: &str,
    signature: &str,
) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("资源更新已在进行中".into());
    }
    let _guard = RunningGuard;
    update_status(|status| {
        *status = RuntimeResourceUpdateStatus {
            preparing: true,
            ..Default::default()
        };
    });
    let result = prepare(app, version, manifest_url, signature).await;
    update_status(|status| {
        status.preparing = false;
        status.ready = result.is_ok();
        status.error = result.as_ref().err().cloned();
        status.current_component = None;
    });
    result
}

async fn prepare(
    app: &AppHandle,
    version: &str,
    manifest_url: &str,
    signature: &str,
) -> Result<(), String> {
    if !valid_version(version) {
        return Err("资源更新版本无效".into());
    }
    let manifest_url = trusted_manifest_url(manifest_url)?;
    let signature = decode_release_signature(signature)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建资源下载客户端失败：{error}"))?;
    let response = timeout(
        NETWORK_IDLE_TIMEOUT,
        client.get(manifest_url.clone()).send(),
    )
    .await
    .map_err(|_| "下载资源清单等待响应超时")?
    .map_err(|error| format!("下载资源清单失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载资源清单失败：HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = timeout(NETWORK_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| "读取资源清单超时")?
    {
        let chunk = chunk.map_err(|error| format!("读取资源清单失败：{error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err("资源清单过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|_| "读取内置更新公钥失败")?;
    let encoded_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("内置更新公钥缺失")?;
    let key_text = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|_| "内置更新公钥编码无效")?;
    let public_key =
        PublicKey::decode(std::str::from_utf8(&key_text).map_err(|_| "内置更新公钥编码无效")?)
            .map_err(|_| "内置更新公钥无效")?;
    public_key
        .verify(&bytes, &signature, false)
        .map_err(|_| "资源清单签名校验失败")?;
    let manifest: ResourceManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("资源清单格式无效：{error}"))?;
    validate_manifest(&manifest, version, &manifest_url)?;
    let base_url = Url::parse(&manifest.object_base_url).map_err(|_| "资源对象地址无效")?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("读取应用数据目录失败：{error}"))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取内置资源目录失败：{error}"))?;
    let store = data_dir.join("runtime-components");
    // 只处理当前版本认识的组件：清单里可能有已下线组件的历史条目。
    let supported = supported_components(&manifest);
    let total_bytes = supported
        .iter()
        .flat_map(|component| &component.files)
        .map(|file| file.size)
        .sum();
    update_status(|status| {
        status.total_components = supported.len();
        status.total_bytes = total_bytes;
    });
    for component in &supported {
        update_status(|status| status.current_component = Some(component.name.clone()));
        prepare_component(&client, &base_url, &store, &resource_dir, component).await?;
        update_status(|status| status.completed_components += 1);
    }
    Ok(())
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn decode_release_signature(encoded: &str) -> Result<Signature, String> {
    if encoded.len() > 8192 {
        return Err("资源清单签名过大".into());
    }
    // Tauri's .sig file and latest.json signature field contain base64 of the
    // four-line Minisign document, not the four lines directly.
    let text = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "资源清单签名编码无效")?;
    if text.len() > 4096 {
        return Err("资源清单签名过大".into());
    }
    Signature::decode(std::str::from_utf8(&text).map_err(|_| "资源清单签名编码无效")?)
        .map_err(|_| "资源清单签名格式无效".into())
}

fn updater_base() -> Result<Url, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|_| "读取内置更新地址失败")?;
    let endpoint = config["plugins"]["updater"]["endpoints"][0]
        .as_str()
        .ok_or("内置更新地址缺失")?;
    let url = Url::parse(endpoint).map_err(|_| "内置更新地址无效")?;
    let mut base = url.clone();
    base.set_path("/infinite-canvas/updates/");
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn trusted_manifest_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "资源清单地址无效")?;
    let base = updater_base()?;
    if url.scheme() != "https"
        || !same_origin(&url, &base)
        || !url.path().starts_with(base.path())
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("资源清单地址不属于可信更新源".into());
    }
    Ok(url)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_path(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.len() > 1024 || value.contains('\\') || value.contains(':') {
        return None;
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    for segment in value.split('/') {
        let stem = segment.split('.').next()?.to_ascii_uppercase();
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&stem.as_str())
        {
            return None;
        }
    }
    Some(path)
}

type ComponentSpec = (&'static str, &'static str, RuntimeReadyProbe);

fn component_spec(name: &str) -> Option<ComponentSpec> {
    match name {
        "ffmpeg" => Some(("ffmpeg", "manifest.json", super::composer::engine_ready_in)),
        _ => None,
    }
}

/**
 * 清单里当前版本认识的组件。
 *
 * 历史渠道仍在分发含**已下线组件**（blender / remotion-runtime / 风格库）的清单，
 * 这些功能对应的代码与入口都已删除，装了也没有地方用。但因为其中一个不认识就让
 * 整次资源更新失败，用户会被永远卡在旧版本、连安装包都下载不了——
 * 所以认不出来的组件直接跳过，只处理认识的。
 */
fn supported_components(manifest: &ResourceManifest) -> Vec<&ResourceComponent> {
    manifest
        .components
        .iter()
        .filter(|component| component_spec(&component.name).is_some())
        .collect()
}

fn validate_manifest(
    manifest: &ResourceManifest,
    version: &str,
    manifest_url: &Url,
) -> Result<(), String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("当前平台不支持按文件更新运行资源".into());
    }
    if manifest.schema_version != 1
        || manifest.version != version
        || manifest.platform != "windows-x86_64"
    {
        return Err("资源清单版本或平台不匹配".into());
    }
    /*
     * 组件数量不写死：写死会在「可发布组件集合」变化时立刻失效
     * （发布端 scripts/runtime-resource-release.mjs 的 RESOURCE_COMPONENTS 只产 1 个
     * ffmpeg，客户端却要求恰好 4 个 → 带资源清单的更新渠道 100% 失败）。
     * 真正的约束在下面的循环里：每个组件名必须在 component_spec 白名单内、
     * 名字唯一、且至少有一个组件。
     */
    let supported = supported_components(&manifest);
    if supported.is_empty() {
        return Err("资源清单组件数量不正确".into());
    }
    let base = Url::parse(&manifest.object_base_url).map_err(|_| "资源对象地址无效")?;
    if base.scheme() != "https"
        || !same_origin(&base, manifest_url)
        || base.path() != "/infinite-canvas/updates/resources/objects/"
        || base.username() != ""
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("资源对象地址不属于可信更新源".into());
    }
    let mut names = HashSet::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    for component in &supported {
        let Some((_, native_manifest, _)) = component_spec(&component.name) else {
            continue;
        };
        if !names.insert(component.name.as_str())
            || component.manifest_path != native_manifest
            || !valid_sha256(&component.manifest_sha256)
            || component.files.is_empty()
        {
            return Err("资源清单组件信息无效".into());
        }
        let mut paths = HashSet::new();
        let mut found_manifest = false;
        for file in &component.files {
            if !valid_sha256(&file.sha256) || file.size > MAX_FILE_BYTES {
                return Err("资源清单文件摘要或大小无效".into());
            }
            let Some(path) = safe_path(&file.path) else {
                return Err("资源清单文件路径无效".into());
            };
            if file.path.eq_ignore_ascii_case(".complete.json")
                || !paths.insert(file.path.to_ascii_lowercase())
                || path.components().count() > 32
            {
                return Err("资源清单文件路径重复或保留".into());
            }
            if file.path == component.manifest_path {
                found_manifest = file.sha256 == component.manifest_sha256;
            }
            total_files = total_files.saturating_add(1);
            total_bytes = total_bytes.saturating_add(file.size);
        }
        if !found_manifest {
            return Err("资源清单未包含匹配的组件清单".into());
        }
    }
    if total_files > MAX_FILES || total_bytes > MAX_TOTAL_BYTES {
        return Err("资源清单超出允许的文件数量或容量".into());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut input = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hash.update(&buffer[..read]);
    }
    Ok((hex::encode(hash.finalize()), size))
}

fn verified_source_map(root: &Path, wanted: &HashSet<&str>) -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    if !root
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir())
    {
        return found;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return found;
    };
    fn visit(
        canonical_root: &Path,
        dir: &Path,
        wanted: &HashSet<&str>,
        found: &mut HashMap<String, PathBuf>,
        remaining: &mut usize,
        active: &mut HashSet<PathBuf>,
    ) {
        let Ok(resolved_dir) = dir.canonicalize() else {
            return;
        };
        if !resolved_dir.starts_with(canonical_root) || !active.insert(resolved_dir.clone()) {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            active.remove(&resolved_dir);
            return;
        };
        for entry in entries.flatten() {
            if *remaining == 0 || found.len() == wanted.len() {
                break;
            }
            let path = entry.path();
            let Ok(meta) = path.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if !path
                .canonicalize()
                .is_ok_and(|resolved| resolved.starts_with(canonical_root))
            {
                continue;
            }
            if meta.is_dir() {
                visit(canonical_root, &path, wanted, found, remaining, active);
            } else if meta.is_file() && meta.len() <= MAX_FILE_BYTES {
                *remaining -= 1;
                if let Ok((digest, _)) = hash_file(&path) {
                    if wanted.contains(digest.as_str()) {
                        found.entry(digest).or_insert(path);
                    }
                }
            }
        }
        active.remove(&resolved_dir);
    }
    let mut remaining = MAX_FILES;
    visit(
        &canonical_root,
        &canonical_root,
        wanted,
        &mut found,
        &mut remaining,
        &mut HashSet::new(),
    );
    found
}

async fn prepare_component(
    client: &reqwest::Client,
    base_url: &Url,
    store: &Path,
    resource_dir: &Path,
    component: &ResourceComponent,
) -> Result<(), String> {
    let (bundle_relative, _, _) = component_spec(&component.name).ok_or("未知资源组件")?;
    let component_dir = store.join(&component.name);
    fs::create_dir_all(&component_dir).map_err(|error| format!("创建资源目录失败：{error}"))?;
    let store_root = store.canonicalize().map_err(|_| "资源存储目录不可读取")?;
    let canonical_component = component_dir
        .canonicalize()
        .map_err(|_| "资源组件目录不可读取")?;
    if !component_dir
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir())
        || canonical_component.parent() != Some(store_root.as_path())
    {
        return Err("资源组件目录路径不可信".into());
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(component_dir.join(".migration.lock"))
        .map_err(|error| format!("打开资源锁失败：{error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("获取资源锁失败：{error}"))?;
    let destination = component_dir.join(&component.manifest_sha256);
    let cache_dir = component_dir.join(".objects");
    if verify_tree(&destination, component) {
        let size: u64 = component.files.iter().map(|file| file.size).sum();
        update_status(|status| {
            status.completed_bytes += size;
            status.reused_bytes += size;
        });
        cleanup_component_cache(&cache_dir, component);
        return Ok(());
    }
    let wanted: HashSet<&str> = component
        .files
        .iter()
        .map(|file| file.sha256.as_str())
        .collect();
    let mut reusable = HashMap::new();
    let bundled_root = resource_dir.join(bundle_relative);
    if bundled_root.canonicalize().is_ok_and(|path| {
        resource_dir
            .canonicalize()
            .is_ok_and(|parent| path.starts_with(parent))
    }) {
        reusable.extend(verified_source_map(&bundled_root, &wanted));
    }
    // A prior component may be only partly intact. Its good files are still safe to reuse
    // because every candidate is compared to a digest authenticated by the release manifest.
    if let Ok(versions) = fs::read_dir(&component_dir) {
        let Ok(parent) = component_dir.canonicalize() else {
            return Err("资源组件目录不可读取".into());
        };
        for version in versions.flatten() {
            let path = version.path();
            let name = version.file_name();
            if !name.to_str().is_some_and(valid_sha256)
                || !path
                    .symlink_metadata()
                    .is_ok_and(|meta| meta.file_type().is_dir())
                || !path
                    .canonicalize()
                    .is_ok_and(|resolved| resolved.starts_with(&parent))
            {
                continue;
            }
            for (digest, path) in verified_source_map(&path, &wanted) {
                reusable.entry(digest).or_insert(path);
            }
            if reusable.len() == wanted.len() {
                break;
            }
        }
    }
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&component_dir)
        .map_err(|error| format!("创建资源暂存目录失败：{error}"))?;
    for file in &component.files {
        let relative = safe_path(&file.path).ok_or("资源路径无效")?;
        let target = staging.path().join(relative);
        fs::create_dir_all(target.parent().ok_or("资源目标路径无效")?)
            .map_err(|error| format!("创建资源子目录失败：{error}"))?;
        if let Some(source_path) = reusable.get(&file.sha256) {
            let copied = fs::copy(source_path, &target)
                .map_err(|error| format!("复用本机资源失败：{error}"))?;
            if copied != file.size || hash_file(&target)? != (file.sha256.clone(), file.size) {
                return Err(format!("复用 {} 的资源校验失败", component.name));
            }
            update_status(|status| {
                status.reused_bytes += file.size;
                status.completed_bytes += file.size;
            });
        } else {
            fs::create_dir_all(&cache_dir)
                .map_err(|error| format!("创建资源下载缓存失败：{error}"))?;
            if !cache_dir
                .symlink_metadata()
                .is_ok_and(|meta| meta.file_type().is_dir())
                || !cache_dir
                    .canonicalize()
                    .is_ok_and(|path| path.parent() == Some(canonical_component.as_path()))
            {
                return Err("资源下载缓存目录路径不可信".into());
            }
            let cache_path = cache_dir.join(&file.sha256);
            let cached = ensure_cached_object(client, base_url, file, &cache_path).await?;
            let copied = fs::copy(&cache_path, &target)
                .map_err(|error| format!("复制已验证资源对象失败：{error}"))?;
            if copied != file.size || hash_file(&target)? != (file.sha256.clone(), file.size) {
                return Err(format!("{} 的资源对象复制校验失败", component.name));
            }
            if cached {
                update_status(|status| {
                    status.reused_bytes += file.size;
                    status.completed_bytes += file.size;
                });
            }
        }
    }
    let total_bytes: u64 = component.files.iter().map(|file| file.size).sum();
    let marker = CompleteMarker {
        schema_version: 1,
        component: &component.name,
        manifest_sha256: &component.manifest_sha256,
        file_count: component.files.len() as u64,
        total_bytes,
    };
    fs::write(
        staging.path().join(".complete.json"),
        serde_json::to_vec(&marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入资源完成标记失败：{error}"))?;
    if !verify_tree(staging.path(), component) {
        return Err(format!("{} 的资源暂存目录校验失败", component.name));
    }
    let quarantine = component_dir.join(format!(".invalid-{}", Uuid::new_v4()));
    let moved_old = if destination.exists() {
        fs::rename(&destination, &quarantine)
            .map_err(|error| format!("隔离损坏资源目录失败：{error}"))?;
        true
    } else {
        false
    };
    if let Err(error) = fs::rename(staging.path(), &destination) {
        if moved_old {
            let _ = fs::rename(&quarantine, &destination);
        }
        return Err(format!("发布资源目录失败：{error}"));
    }
    cleanup_component_cache(&cache_dir, component);
    Ok(())
}

fn cached_object_matches(path: &Path, file: &ResourceFile) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_file() && meta.len() == file.size)
        && hash_file(path).ok() == Some((file.sha256.clone(), file.size))
}

async fn ensure_cached_object(
    client: &reqwest::Client,
    base_url: &Url,
    file: &ResourceFile,
    cache_path: &Path,
) -> Result<bool, String> {
    if cached_object_matches(cache_path, file) {
        return Ok(true);
    }
    if let Ok(meta) = cache_path.symlink_metadata() {
        if !meta.file_type().is_file() {
            return Err("资源下载缓存路径类型不可信".into());
        }
        fs::remove_file(cache_path).map_err(|error| format!("清理损坏资源缓存失败：{error}"))?;
    }
    let cache_dir = cache_path.parent().ok_or("资源下载缓存路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(cache_dir)
        .map_err(|error| format!("创建资源下载暂存文件失败：{error}"))?;
    download_object(client, base_url, file, temporary.as_file_mut()).await?;
    temporary
        .persist(cache_path)
        .map_err(|error| format!("发布已验证资源缓存失败：{}", error.error))?;
    Ok(false)
}

fn cleanup_component_cache(cache_dir: &Path, component: &ResourceComponent) {
    if !cache_dir
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir())
    {
        return;
    }
    for file in &component.files {
        let path = cache_dir.join(&file.sha256);
        if cached_object_matches(&path, file) {
            let _ = fs::remove_file(path);
        }
    }
}

fn verify_tree(root: &Path, component: &ResourceComponent) -> bool {
    if !root
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir())
    {
        return false;
    }
    let Ok(marker) = fs::read(root.join(".complete.json")) else {
        return false;
    };
    if marker.len() > 4096 {
        return false;
    }
    let Ok(marker) = serde_json::from_slice::<serde_json::Value>(&marker) else {
        return false;
    };
    if marker["schemaVersion"].as_u64() != Some(1)
        || marker["component"].as_str() != Some(component.name.as_str())
        || marker["manifestSha256"].as_str() != Some(component.manifest_sha256.as_str())
        || marker["fileCount"].as_u64() != Some(component.files.len() as u64)
        || marker["totalBytes"].as_u64()
            != Some(component.files.iter().map(|file| file.size).sum::<u64>())
    {
        return false;
    }
    for file in &component.files {
        let Some(relative) = safe_path(&file.path) else {
            return false;
        };
        let path = root.join(relative);
        if !path
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() == file.size)
            || hash_file(&path).ok() != Some((file.sha256.clone(), file.size))
        {
            return false;
        }
    }
    let expected: HashSet<&str> = component
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    fn only_expected_files(
        root: &Path,
        dir: &Path,
        expected: &HashSet<&str>,
        seen: &mut HashSet<String>,
    ) -> bool {
        let Ok(entries) = fs::read_dir(dir) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            let path = entry.path();
            let Ok(meta) = path.symlink_metadata() else {
                return false;
            };
            if meta.file_type().is_symlink()
                || !path
                    .canonicalize()
                    .is_ok_and(|resolved| resolved.starts_with(root))
            {
                return false;
            }
            if meta.is_dir() {
                if !only_expected_files(root, &path, expected, seen) {
                    return false;
                }
            } else if meta.is_file() {
                let Ok(relative) = path.strip_prefix(root) else {
                    return false;
                };
                let name = relative.to_string_lossy().replace('\\', "/");
                if name != ".complete.json"
                    && (!expected.contains(name.as_str()) || !seen.insert(name))
                {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    }
    let mut seen = HashSet::new();
    only_expected_files(&canonical_root, &canonical_root, &expected, &mut seen)
        && seen.len() == expected.len()
}

async fn download_object(
    client: &reqwest::Client,
    base_url: &Url,
    file: &ResourceFile,
    output: &mut fs::File,
) -> Result<(), String> {
    let url = base_url
        .join(&file.sha256)
        .map_err(|_| "资源对象地址无效")?;
    let response = timeout(NETWORK_IDLE_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "下载资源对象等待响应超时")?
        .map_err(|error| format!("下载资源对象失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载资源对象失败：HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut digest = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = timeout(NETWORK_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| "读取资源对象超时")?
    {
        let chunk = chunk.map_err(|error| format!("读取资源对象失败：{error}"))?;
        received = received.saturating_add(chunk.len() as u64);
        if received > file.size {
            return Err("资源对象超出清单大小".into());
        }
        digest.update(&chunk);
        output
            .write_all(&chunk)
            .map_err(|error| format!("写入资源对象失败：{error}"))?;
        update_status(|status| {
            status.downloaded_bytes += chunk.len() as u64;
            status.completed_bytes += chunk.len() as u64;
        });
    }
    output
        .sync_all()
        .map_err(|error| format!("同步资源对象失败：{error}"))?;
    if received != file.size || hex::encode(digest.finalize()) != file.sha256 {
        return Err("资源对象内容哈希不匹配".into());
    }
    Ok(())
}
