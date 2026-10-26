//! Signed macOS app-tree delta. The normal Tauri full updater remains the fallback.
//! A Tauri-generated tar.gz cannot be patched from an installed .app: its original
//! tar metadata and gzip stream are not retained by the installation.

#[cfg(any(target_os = "macos", test))]
use std::collections::{HashMap, HashSet};
#[cfg(any(target_os = "macos", test))]
use std::path::{Component, Path, PathBuf};
#[cfg(any(target_os = "macos", test))]
use std::{fs, io};

#[cfg(any(target_os = "macos", test))]
use flate2::{Compression, GzBuilder};
#[cfg(any(target_os = "macos", test))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(any(target_os = "macos", test))]
use unicode_normalization::UnicodeNormalization as _;

#[cfg(target_os = "macos")]
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
#[cfg(any(target_os = "macos", test))]
const MAX_ENTRIES: usize = 200_000;
#[cfg(any(target_os = "macos", test))]
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
#[cfg(any(target_os = "macos", test))]
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacDeltaUpdateStatus {
    pub preparing: bool,
    pub ready: bool,
    pub error: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub reused_bytes: u64,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeltaManifest {
    schema_version: u32,
    base_version: String,
    version: String,
    platform: String,
    app_name: String,
    #[cfg_attr(
        not(target_os = "macos"),
        expect(
            dead_code,
            reason = "仅 macOS 安装器读取下载地址，其他平台保留完整清单以运行校验测试"
        )
    )]
    object_base_url: String,
    files: Vec<DeltaEntry>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum DeltaEntry {
    Dir {
        path: String,
        mode: u32,
    },
    File {
        path: String,
        mode: u32,
        size: u64,
        sha256: String,
        #[cfg_attr(
            not(target_os = "macos"),
            expect(
                dead_code,
                reason = "仅 macOS 安装器按来源组装文件，其他平台测试保留完整清单契约"
            )
        )]
        source: FileSource,
    },
    Symlink {
        path: String,
        target: String,
    },
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileSource {
    Base,
    Object,
}

#[cfg(any(target_os = "macos", test))]
impl DeltaEntry {
    fn path(&self) -> &str {
        match self {
            Self::Dir { path, .. } | Self::File { path, .. } | Self::Symlink { path, .. } => path,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

#[cfg(any(target_os = "macos", test))]
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(any(target_os = "macos", test))]
fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(|c| c.is_control())
        || value.split('/').count() > 32
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.ends_with(' '))
    {
        return Err("macOS 差分清单路径无效".into());
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("macOS 差分清单路径无效".into());
    }
    Ok(path)
}

#[cfg(any(target_os = "macos", test))]
fn resolve_link(path: &str, target: &str) -> Result<PathBuf, String> {
    if target.is_empty()
        || target.len() > 1024
        || target.contains('\\')
        || target.contains(':')
        || target.chars().any(|c| c.is_control())
    {
        return Err("macOS 差分符号链接无效".into());
    }
    let target_path = Path::new(target);
    if target_path.is_absolute() {
        return Err("macOS 差分符号链接不能指向应用外".into());
    }
    let mut result = PathBuf::new();
    for component in Path::new(path)
        .parent()
        .unwrap_or(Path::new(""))
        .components()
    {
        if let Component::Normal(name) = component {
            result.push(name);
        }
    }
    for component in target_path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => result.push(name),
            Component::ParentDir => {
                if !result.pop() {
                    return Err("macOS 差分符号链接越过应用边界".into());
                }
            }
            _ => return Err("macOS 差分符号链接不能指向应用外".into()),
        }
    }
    if result.as_os_str().is_empty() {
        return Err("macOS 差分符号链接指向应用根目录".into());
    }
    Ok(result)
}

/// Resolve every path segment, including links in the middle of a framework
/// path (for example `Versions/Current -> A`). A single lexical target check
/// would incorrectly reject valid `Resources -> Versions/Current/Resources`.
#[cfg(any(target_os = "macos", test))]
fn resolve_manifest_link(path: &str, paths: &HashMap<&str, &DeltaEntry>) -> Result<(), String> {
    let mut current = path.to_owned();
    let mut followed = HashSet::new();
    loop {
        let parts: Vec<&str> = current.split('/').collect();
        let mut prefix = String::new();
        let mut expanded = false;
        for (index, segment) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            let node = paths
                .get(prefix.as_str())
                .ok_or("macOS 差分符号链接目标缺失")?;
            match node {
                DeltaEntry::Symlink { target, .. } => {
                    if !followed.insert(prefix.clone()) {
                        return Err("macOS 差分符号链接成环".into());
                    }
                    let mut next = resolve_link(&prefix, target)?;
                    for rest in &parts[index + 1..] {
                        next.push(rest);
                    }
                    current = next
                        .to_str()
                        .ok_or("macOS 差分符号链接路径无效")?
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    expanded = true;
                    break;
                }
                DeltaEntry::Dir { .. } => {}
                DeltaEntry::File { .. } if index == parts.len() - 1 => {}
                DeltaEntry::File { .. } => {
                    return Err("macOS 差分符号链接穿过非目录".into());
                }
            }
        }
        if !expanded {
            return Ok(());
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn validate_manifest(manifest: &DeltaManifest, current: &str, target: &str) -> Result<(), String> {
    if manifest.schema_version != 1
        || manifest.platform != "darwin-aarch64"
        || manifest.base_version != current
        || manifest.version != target
        || !valid_version(current)
        || !valid_version(target)
        || manifest.app_name != "无限画布.app"
        || manifest.files.is_empty()
        || manifest.files.len() > MAX_ENTRIES
    {
        return Err("macOS 差分清单版本、平台或格式不匹配".into());
    }
    let mut prior: Option<&str> = None;
    let mut paths: HashMap<&str, &DeltaEntry> = HashMap::new();
    let mut folded = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        let path = entry.path();
        safe_relative_path(path)?;
        if prior.is_some_and(|previous| previous.as_bytes() >= path.as_bytes()) {
            return Err("macOS 差分清单路径未排序或重复".into());
        }
        prior = Some(path);
        if !folded.insert(path.nfc().collect::<String>().to_lowercase()) {
            return Err("macOS 差分清单路径存在大小写或 Unicode 冲突".into());
        }
        paths.insert(path, entry);
        match entry {
            DeltaEntry::Dir { mode, .. } => validate_mode(*mode)?,
            DeltaEntry::File {
                mode, size, sha256, ..
            } => {
                validate_mode(*mode)?;
                if *size > MAX_FILE_BYTES || !valid_hash(sha256) {
                    return Err("macOS 差分清单文件大小或哈希无效".into());
                }
                total = total.checked_add(*size).ok_or("macOS 差分清单大小溢出")?;
                if total > MAX_TOTAL_BYTES {
                    return Err("macOS 差分清单文件总量过大".into());
                }
            }
            DeltaEntry::Symlink { target, .. } => {
                resolve_link(path, target)?;
            }
        }
    }
    if !matches!(paths.get("Contents"), Some(DeltaEntry::Dir { .. })) {
        return Err("macOS 差分清单缺少 Contents 目录".into());
    }
    for entry in &manifest.files {
        let path = entry.path();
        if let Some(parent) = path.rsplit_once('/').map(|(parent, _)| parent) {
            if !matches!(paths.get(parent), Some(DeltaEntry::Dir { .. })) {
                return Err("macOS 差分清单父目录缺失或不是目录".into());
            }
        }
        if let DeltaEntry::Symlink { .. } = entry {
            resolve_manifest_link(path, &paths)?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn validate_mode(mode: u32) -> Result<(), String> {
    if mode > 0o7777 || (mode & 0o7000) != 0 {
        return Err("macOS 差分清单包含不安全的权限位".into());
    }
    Ok(())
}

/// Produce the same shape of tar.gz accepted by Tauri's macOS installer: every
/// entry has a single .app prefix, which the updater strips on extraction.
/// Archive bytes are authenticated by the signed tree manifest, not by the
/// signature of the independently built full fallback archive.
#[cfg(any(target_os = "macos", test))]
fn pack_tree(root: &Path, manifest: &DeltaManifest, output: &Path) -> Result<(), String> {
    let file =
        fs::File::create(output).map_err(|error| format!("创建 macOS 更新归档失败：{error}"))?;
    let gzip = GzBuilder::new()
        .mtime(0)
        .write(file, Compression::default());
    let mut tar = tar::Builder::new(gzip);
    for entry in &manifest.files {
        let name = format!("{}/{}", manifest.app_name, entry.path());
        let mut header = tar::Header::new_gnu();
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        match entry {
            DeltaEntry::Dir { mode, .. } => {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_mode(*mode);
                header.set_size(0);
                header.set_cksum();
                tar.append_data(&mut header, format!("{name}/"), io::empty())
                    .map_err(|error| format!("写入 macOS 目录归档失败：{error}"))?;
            }
            DeltaEntry::File { mode, size, .. } => {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_mode(*mode);
                header.set_size(*size);
                header.set_cksum();
                let mut source = fs::File::open(root.join(entry.path()))
                    .map_err(|error| format!("读取 macOS 更新文件失败：{error}"))?;
                tar.append_data(&mut header, name, &mut source)
                    .map_err(|error| format!("写入 macOS 文件归档失败：{error}"))?;
            }
            DeltaEntry::Symlink { target, .. } => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_mode(0o777);
                header.set_size(0);
                header
                    .set_link_name(target)
                    .map_err(|error| format!("写入 macOS 链接目标失败：{error}"))?;
                header.set_cksum();
                tar.append_data(&mut header, name, io::empty())
                    .map_err(|error| format!("写入 macOS 链接归档失败：{error}"))?;
            }
        }
    }
    let gzip = tar
        .into_inner()
        .map_err(|error| format!("结束 macOS tar 归档失败：{error}"))?;
    let mut file = gzip
        .finish()
        .map_err(|error| format!("结束 macOS gzip 归档失败：{error}"))?;
    use std::io::Write as _;
    file.flush()
        .map_err(|error| format!("保存 macOS 更新归档失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步 macOS 更新归档失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac;

#[cfg(target_os = "macos")]
pub use mac::{install, prepare, status};

#[cfg(not(target_os = "macos"))]
pub fn status() -> MacDeltaUpdateStatus {
    MacDeltaUpdateStatus::default()
}

#[cfg(not(target_os = "macos"))]
pub async fn prepare(_app: &tauri::AppHandle, _version: &str) -> Result<bool, String> {
    Err("仅 macOS 支持应用包差分更新".into())
}

#[cfg(not(target_os = "macos"))]
pub async fn install(_app: &tauri::AppHandle, _version: &str) -> Result<(), String> {
    Err("仅 macOS 支持应用包差分更新".into())
}
