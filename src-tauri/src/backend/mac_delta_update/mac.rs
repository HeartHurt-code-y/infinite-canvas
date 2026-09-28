use super::{
    DeltaEntry, DeltaManifest, FileSource, MAX_MANIFEST_BYTES, MacDeltaUpdateStatus, pack_tree,
    validate_manifest,
};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read as _};
use std::os::unix::fs::{PermissionsExt as _, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt as _;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager as _};
use tauri_plugin_updater::UpdaterExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::time::timeout;
use url::Url;

const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const OBJECT_PATH: &str = "/infinite-canvas/updates/mac-delta/objects/";

static RUNNING: AtomicBool = AtomicBool::new(false);
static STATUS: LazyLock<Mutex<MacDeltaUpdateStatus>> =
    LazyLock::new(|| Mutex::new(MacDeltaUpdateStatus::default()));
static READY: LazyLock<Mutex<Option<Prepared>>> = LazyLock::new(|| Mutex::new(None));

struct Prepared {
    version: String,
    full_signature: String,
    descriptor_signature: String,
    staging: tempfile::TempDir,
    archive_sha256: String,
}

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    url: String,
    signature: String,
}

fn set_status(change: impl FnOnce(&mut MacDeltaUpdateStatus)) {
    change(&mut STATUS.lock().expect("macOS delta status poisoned"));
}

pub fn status() -> MacDeltaUpdateStatus {
    STATUS.lock().expect("macOS delta status poisoned").clone()
}

fn trusted_origin() -> Result<Url, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../../tauri.conf.json"))
        .map_err(|_| "读取内置 macOS 更新源失败")?;
    let endpoint = config["plugins"]["updater"]["endpoints"][0]
        .as_str()
        .ok_or("内置 macOS 更新源缺失")?;
    Url::parse(endpoint).map_err(|_| "内置 macOS 更新源无效".into())
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn trusted_url(raw: &str, expected_path: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "macOS 差分地址无效")?;
    let origin = trusted_origin()?;
    if url.scheme() != "https"
        || !same_origin(&url, &origin)
        || url.path() != expected_path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("macOS 差分地址不属于可信更新源".into());
    }
    Ok(url)
}

fn trusted_object_base(raw: &str) -> Result<Url, String> {
    trusted_url(raw, OBJECT_PATH)
}

fn verify_manifest_signature(bytes: &[u8], signature: &str) -> Result<(), String> {
    if signature.len() > 8192 {
        return Err("macOS 差分清单签名过大".into());
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../../../tauri.conf.json"))
        .map_err(|_| "读取内置更新公钥失败")?;
    let encoded_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("内置更新公钥缺失")?;
    let key = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|_| "内置更新公钥编码无效")?;
    let key = PublicKey::decode(std::str::from_utf8(&key).map_err(|_| "内置更新公钥编码无效")?)
        .map_err(|_| "内置更新公钥无效")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|_| "macOS 差分签名编码无效")?;
    let sig =
        Signature::decode(std::str::from_utf8(&decoded).map_err(|_| "macOS 差分签名编码无效")?)
            .map_err(|_| "macOS 差分签名格式无效")?;
    key.verify(bytes, &sig, false)
        .map_err(|_| "macOS 差分清单签名校验失败".into())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建 macOS 差分下载客户端失败：{error}"))
}

async fn get_manifest(client: &reqwest::Client, url: Url) -> Result<Vec<u8>, String> {
    let response = timeout(NETWORK_IDLE_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "macOS 差分清单连接超时")?
        .map_err(|error| format!("下载 macOS 差分清单失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 macOS 差分清单失败：HTTP {}",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = timeout(NETWORK_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| "读取 macOS 差分清单超时")?
    {
        let chunk = chunk.map_err(|error| format!("读取 macOS 差分清单失败：{error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err("macOS 差分清单过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn source_app_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("定位当前应用失败：{error}"))?;
    let path = tauri_plugin_updater::extract_path_from_executable(&exe)
        .map_err(|error| format!("定位当前应用包失败：{error}"))?;
    let info =
        fs::symlink_metadata(&path).map_err(|error| format!("读取当前应用包失败：{error}"))?;
    if !info.is_dir()
        || info.file_type().is_symlink()
        || path.extension().is_none_or(|s| s != "app")
    {
        return Err("当前运行位置不是实体 .app，无法做包级差分".into());
    }
    Ok(path)
}

fn file_hash(path: &Path) -> Result<(u64, String), String> {
    let mut input =
        BufReader::new(File::open(path).map_err(|error| format!("读取差分文件失败：{error}"))?);
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = input
            .read(&mut buffer)
            .map_err(|error| format!("读取差分文件失败：{error}"))?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or("差分文件过大")?;
        digest.update(&buffer[..n]);
    }
    Ok((count, hex::encode(digest.finalize())))
}

fn metadata_mode(path: &Path) -> Result<(fs::Metadata, u32), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|error| format!("检查 macOS 应用文件失败：{error}"))?;
    let mode = meta.permissions().mode() & 0o7777;
    Ok((meta, mode))
}

fn ensure_real_parent_dirs(root: &Path, relative: &str) -> Result<(), String> {
    let mut path = root.to_path_buf();
    for component in relative.split('/').take(relative.split('/').count() - 1) {
        path.push(component);
        let meta = fs::symlink_metadata(&path).map_err(|_| "本地应用缺少差分基线目录")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("本地应用差分基线目录类型不匹配".into());
        }
    }
    Ok(())
}

async fn fetch_object(
    client: &reqwest::Client,
    object_base: &Url,
    sha256: &str,
    size: u64,
    destination: &Path,
) -> Result<(), String> {
    let url = object_base
        .join(sha256)
        .map_err(|_| "macOS 差分对象地址无效")?;
    let response = timeout(NETWORK_IDLE_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "macOS 差分对象连接超时")?
        .map_err(|error| format!("下载 macOS 差分对象失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 macOS 差分对象失败：HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != size)
    {
        return Err("macOS 差分对象长度与签名清单不符".into());
    }
    let mut output = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("创建 macOS 差分对象失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut count = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = timeout(NETWORK_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| "读取 macOS 差分对象超时")?
    {
        let chunk = chunk.map_err(|error| format!("读取 macOS 差分对象失败：{error}"))?;
        count = count
            .checked_add(chunk.len() as u64)
            .ok_or("macOS 差分对象过大")?;
        if count > size {
            return Err("macOS 差分对象超出签名清单长度".into());
        }
        digest.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("保存 macOS 差分对象失败：{error}"))?;
        set_status(|status| status.downloaded_bytes += chunk.len() as u64);
    }
    output
        .flush()
        .await
        .map_err(|error| format!("保存 macOS 差分对象失败：{error}"))?;
    output
        .sync_all()
        .await
        .map_err(|error| format!("同步 macOS 差分对象失败：{error}"))?;
    if count != size || hex::encode(digest.finalize()) != sha256 {
        return Err("macOS 差分对象哈希或长度不匹配".into());
    }
    Ok(())
}

fn verify_tree(root: &Path, manifest: &DeltaManifest) -> Result<(), String> {
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("读取暂存应用真实路径失败：{error}"))?;
    let expected: HashSet<&str> = manifest.files.iter().map(DeltaEntry::path).collect();
    fn visit(
        root: &Path,
        directory: &Path,
        expected: &HashSet<&str>,
        seen: &mut HashSet<String>,
    ) -> Result<(), String> {
        for item in
            fs::read_dir(directory).map_err(|error| format!("读取暂存应用目录失败：{error}"))?
        {
            let item = item.map_err(|error| format!("读取暂存应用目录失败：{error}"))?;
            let path = item.path();
            let relative = path.strip_prefix(root).map_err(|_| "暂存应用路径越界")?;
            let relative = relative
                .to_str()
                .ok_or("暂存应用存在非 UTF-8 路径")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if !expected.contains(relative.as_str()) || !seen.insert(relative) {
                return Err("暂存应用包含未签名或重复文件".into());
            }
            let meta = fs::symlink_metadata(&path)
                .map_err(|error| format!("读取暂存文件失败：{error}"))?;
            if meta.is_dir() && !meta.file_type().is_symlink() {
                visit(root, &path, expected, seen)?;
            }
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    visit(root, root, &expected, &mut seen)?;
    if seen.len() != expected.len() {
        return Err("暂存应用缺少签名清单中的文件".into());
    }
    for entry in &manifest.files {
        let path = root.join(entry.path());
        let (meta, mode) = metadata_mode(&path)?;
        match entry {
            DeltaEntry::Dir { mode: expected, .. }
                if meta.is_dir() && !meta.file_type().is_symlink() && mode == *expected => {}
            DeltaEntry::File {
                mode: expected,
                size,
                sha256,
                ..
            } if meta.is_file() && !meta.file_type().is_symlink() && mode == *expected => {
                if file_hash(&path)? != (*size, sha256.clone()) {
                    return Err("暂存应用文件哈希与签名清单不符".into());
                }
            }
            DeltaEntry::Symlink { target, .. } if meta.file_type().is_symlink() => {
                if fs::read_link(&path).map_err(|_| "读取暂存链接失败")? != Path::new(target)
                {
                    return Err("暂存应用符号链接与签名清单不符".into());
                }
                let real = fs::canonicalize(&path).map_err(|_| "暂存应用符号链接悬空或循环")?;
                if !real.starts_with(&canonical_root) || real == canonical_root {
                    return Err("暂存应用符号链接指向应用外".into());
                }
            }
            _ => return Err("暂存应用文件类型或权限与签名清单不符".into()),
        }
    }
    let result = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(root)
        .output()
        .map_err(|error| format!("执行 macOS 代码签名校验失败：{error}"))?;
    if !result.status.success() {
        return Err("暂存应用代码签名校验失败，已取消差分安装".into());
    }
    Ok(())
}

fn verify_archive_roundtrip(
    archive_path: &Path,
    staging: &Path,
    manifest: &DeltaManifest,
) -> Result<(), String> {
    let extracted = staging.join("archive-check").join(&manifest.app_name);
    fs::create_dir_all(&extracted)
        .map_err(|error| format!("创建 macOS 更新归档验证目录失败：{error}"))?;
    let archive =
        File::open(archive_path).map_err(|error| format!("读取 macOS 更新归档失败：{error}"))?;
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let mut count = 0usize;
    for item in tar
        .entries()
        .map_err(|error| format!("读取 macOS 更新条目失败：{error}"))?
    {
        let mut item = item.map_err(|error| format!("读取 macOS 更新条目失败：{error}"))?;
        let expected = manifest.files.get(count).ok_or("macOS 更新归档条目过多")?;
        let path = item.path().map_err(|_| "macOS 更新归档路径无效")?;
        let mut components = path.components();
        if components.next().and_then(|part| part.as_os_str().to_str())
            != Some(manifest.app_name.as_str())
        {
            return Err("macOS 更新归档应用根路径不匹配".into());
        }
        let relative: PathBuf = components.collect();
        if relative != Path::new(expected.path()) {
            return Err("macOS 更新归档路径与签名清单不匹配".into());
        }
        let entry_type = item.header().entry_type();
        match expected {
            DeltaEntry::Dir { mode, .. }
                if entry_type.is_dir() && item.header().mode().ok() == Some(*mode) => {}
            DeltaEntry::File { mode, size, .. }
                if entry_type.is_file()
                    && item.header().mode().ok() == Some(*mode)
                    && item.header().size().ok() == Some(*size) => {}
            DeltaEntry::Symlink { target, .. }
                if entry_type.is_symlink()
                    && item.link_name().ok().flatten().as_deref() == Some(Path::new(target)) => {}
            _ => return Err("macOS 更新归档类型或属性与签名清单不匹配".into()),
        }
        item.unpack(extracted.join(relative))
            .map_err(|error| format!("验证 macOS 更新归档解包失败：{error}"))?;
        count += 1;
    }
    if count != manifest.files.len() {
        return Err("macOS 更新归档缺少签名清单条目".into());
    }
    verify_tree(&extracted, manifest)
}

async fn prepare_inner(app: &AppHandle, version: &str) -> Result<Option<Prepared>, String> {
    let update = app
        .updater()
        .map_err(|error| format!("读取 macOS 更新源失败：{error}"))?
        .check()
        .await
        .map_err(|error| format!("检查 macOS 更新失败：{error}"))?
        .ok_or("macOS 更新已不再可用")?;
    if update.version != version {
        return Err("macOS 差分目标版本与当前更新源不一致".into());
    }
    let descriptor = match update.raw_json.get("macDeltaManifest") {
        Some(value) => serde_json::from_value::<Descriptor>(value.clone())
            .map_err(|_| "macOS 差分清单引用格式无效")?,
        None => return Ok(None),
    };
    let url = trusted_url(
        &descriptor.url,
        &format!("/infinite-canvas/updates/mac-delta/{version}/darwin-aarch64/manifest.json"),
    )?;
    let client = http_client()?;
    let bytes = get_manifest(&client, url).await?;
    verify_manifest_signature(&bytes, &descriptor.signature)?;
    let manifest: DeltaManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("macOS 差分清单格式无效：{error}"))?;
    validate_manifest(&manifest, &update.current_version, version)?;
    let object_base = trusted_object_base(&manifest.object_base_url)?;
    let base_app = source_app_path()?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("读取 macOS 应用数据目录失败：{error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("创建 macOS 更新暂存目录失败：{error}"))?;
    // Staged app, archive, round-trip extraction and Tauri's replacement/backup
    // can coexist briefly. Keep a margin before any large copy or download.
    let target_bytes = manifest.files.iter().try_fold(0u64, |total, entry| {
        if let DeltaEntry::File { size, .. } = entry {
            total.checked_add(*size).ok_or("macOS 应用包大小溢出")
        } else {
            Ok(total)
        }
    })?;
    let required = target_bytes
        .saturating_mul(4)
        .saturating_add(512 * 1024 * 1024);
    let available = fs2::available_space(&data_dir)
        .map_err(|error| format!("检查 macOS 更新磁盘空间失败：{error}"))?;
    if available < required {
        return Err(format!(
            "macOS 差分安装需要约 {} GiB 可用空间，当前空间不足",
            (required + (1 << 30) - 1) / (1 << 30)
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix("mac-delta-")
        .tempdir_in(data_dir)
        .map_err(|error| format!("创建 macOS 更新暂存目录失败：{error}"))?;
    let app_root = staging.path().join(&manifest.app_name);
    let object_root = staging.path().join("objects");
    fs::create_dir(&app_root).map_err(|error| format!("创建 macOS 暂存应用失败：{error}"))?;
    fs::create_dir(&object_root).map_err(|error| format!("创建 macOS 对象暂存区失败：{error}"))?;
    let mut object_sizes = HashMap::new();
    let mut reused = 0u64;
    for entry in &manifest.files {
        if let DeltaEntry::File {
            size,
            sha256,
            source,
            ..
        } = entry
        {
            match source {
                FileSource::Base => reused += *size,
                FileSource::Object => {
                    if let Some(previous) = object_sizes.insert(sha256.clone(), *size) {
                        if previous != *size {
                            return Err("macOS 差分对象哈希对应多个长度".into());
                        }
                    }
                }
            }
        }
    }
    set_status(|status| {
        status.total_bytes = object_sizes.values().sum();
        status.reused_bytes = reused;
    });
    for entry in &manifest.files {
        if let DeltaEntry::Dir { path, .. } = entry {
            fs::create_dir(app_root.join(path))
                .map_err(|error| format!("创建 macOS 暂存目录失败：{error}"))?;
        }
    }
    for entry in &manifest.files {
        if let DeltaEntry::File {
            path,
            mode,
            size,
            sha256,
            source,
        } = entry
        {
            let destination = app_root.join(path);
            match source {
                FileSource::Base => {
                    ensure_real_parent_dirs(&base_app, path)?;
                    let source_path = base_app.join(path);
                    let (meta, source_mode) = metadata_mode(&source_path)?;
                    if !meta.is_file()
                        || meta.file_type().is_symlink()
                        || source_mode != *mode
                        || meta.len() != *size
                    {
                        return Err("本地应用差分基线文件类型、权限或大小不匹配".into());
                    }
                    fs::copy(&source_path, &destination)
                        .map_err(|error| format!("复制本地 macOS 差分基线失败：{error}"))?;
                    if file_hash(&destination)? != (*size, sha256.clone()) {
                        return Err("本地应用差分基线文件哈希不匹配".into());
                    }
                }
                FileSource::Object => {
                    let object = object_root.join(sha256);
                    if !object.exists() {
                        fetch_object(&client, &object_base, sha256, *size, &object).await?;
                    }
                    fs::copy(&object, &destination)
                        .map_err(|error| format!("复制 macOS 差分对象失败：{error}"))?;
                }
            }
            fs::set_permissions(&destination, fs::Permissions::from_mode(*mode))
                .map_err(|error| format!("设置 macOS 文件权限失败：{error}"))?;
        }
    }
    for entry in &manifest.files {
        if let DeltaEntry::Symlink { path, target } = entry {
            symlink(target, app_root.join(path))
                .map_err(|error| format!("创建 macOS 符号链接失败：{error}"))?;
        }
    }
    for entry in manifest.files.iter().rev() {
        if let DeltaEntry::Dir { path, mode } = entry {
            fs::set_permissions(app_root.join(path), fs::Permissions::from_mode(*mode))
                .map_err(|error| format!("设置 macOS 目录权限失败：{error}"))?;
        }
    }
    verify_tree(&app_root, &manifest)?;
    let archive_path = staging.path().join("prepared.app.tar.gz");
    pack_tree(&app_root, &manifest, &archive_path)?;
    verify_archive_roundtrip(&archive_path, staging.path(), &manifest)?;
    let (_, archive_sha256) = file_hash(&archive_path)?;
    Ok(Some(Prepared {
        version: version.to_owned(),
        full_signature: update.signature,
        descriptor_signature: descriptor.signature,
        staging,
        archive_sha256,
    }))
}

pub async fn prepare(app: &AppHandle, version: &str) -> Result<bool, String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("macOS 差分更新已在进行中".into());
    }
    let _guard = RunningGuard;
    *READY.lock().expect("macOS delta ready poisoned") = None;
    set_status(|status| {
        *status = MacDeltaUpdateStatus {
            preparing: true,
            ..Default::default()
        }
    });
    let result = prepare_inner(app, version).await;
    match result {
        Ok(Some(prepared)) => {
            *READY.lock().expect("macOS delta ready poisoned") = Some(prepared);
            set_status(|status| {
                status.preparing = false;
                status.ready = true;
            });
            Ok(true)
        }
        Ok(None) => {
            set_status(|status| {
                status.preparing = false;
            });
            Ok(false)
        }
        Err(error) => {
            set_status(|status| {
                status.preparing = false;
                status.error = Some(error.clone());
            });
            Err(error)
        }
    }
}

pub async fn install(app: &AppHandle, version: &str) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("macOS 差分更新已在进行中".into());
    }
    let _guard = RunningGuard;
    let preflight = async {
        let prepared = READY
            .lock()
            .expect("macOS delta ready poisoned")
            .take()
            .ok_or("macOS 差分更新尚未准备好")?;
        if prepared.version != version {
            return Err("macOS 差分更新版本已变化".into());
        }
        let update = app
            .updater()
            .map_err(|error| format!("读取 macOS 更新源失败：{error}"))?
            .check()
            .await
            .map_err(|error| format!("复查 macOS 更新失败：{error}"))?
            .ok_or("macOS 更新已不再可用")?;
        let descriptor = update
            .raw_json
            .get("macDeltaManifest")
            .and_then(|value| serde_json::from_value::<Descriptor>(value.clone()).ok())
            .ok_or("macOS 差分清单引用已移除")?;
        if update.version != version
            || update.signature != prepared.full_signature
            || descriptor.signature != prepared.descriptor_signature
        {
            return Err("macOS 更新清单已变化，请重新检查更新".into());
        }
        let archive = prepared.staging.path().join("prepared.app.tar.gz");
        let bytes = fs::read(&archive)
            .map_err(|error| format!("读取已验证的 macOS 更新包失败：{error}"))?;
        if hex::encode(Sha256::digest(&bytes)) != prepared.archive_sha256 {
            return Err("macOS 更新归档在准备后发生变化".into());
        }
        Ok((prepared, update, bytes))
    }
    .await;
    let (_prepared, update, bytes) =
        preflight.map_err(|error: String| format!("MAC_DELTA_PREINSTALL: {error}"))?;
    update
        .install(bytes)
        .map_err(|error| format!("MAC_DELTA_INSTALL: {error}"))
}
