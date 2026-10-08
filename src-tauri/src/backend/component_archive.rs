//! ZIP archives are untrusted until their catalog digest and exact file inventory match.
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComponentFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || value.chars().any(char::is_control)
        || value.split('/').count() > 32
    {
        return Err("组件文件路径无效".into());
    }
    for part in value.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("组件文件路径含保留名称或越界片段".into());
        }
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("组件文件路径不能指向包外".into());
    }
    Ok(path)
}

pub(crate) fn path_key(value: &str) -> String {
    value.nfc().collect::<String>().to_lowercase()
}

pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

pub(crate) fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("组件安装已取消".into())
    } else {
        Ok(())
    }
}

pub(crate) fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("读取组件文件失败：{error}"))?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("组件文件不能是链接或特殊文件".into());
    }
    let mut file = File::open(path).map_err(|error| format!("打开组件文件失败：{error}"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check_cancel(cancel)?;
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取组件字节失败：{error}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        bytes = bytes.checked_add(count as u64).ok_or("组件文件大小溢出")?;
    }
    Ok((hex::encode(hash.finalize()), bytes))
}

pub(crate) fn validate_files(files: &[ComponentFile]) -> Result<u64, String> {
    if files.is_empty() || files.len() > 200_000 {
        return Err("组件文件数量无效".into());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for file in files {
        safe_relative(&file.path)?;
        if path_key(&file.path) == ".complete.json"
            || !names.insert(path_key(&file.path))
            || !valid_sha256(&file.sha256)
            || file.size > 8 * 1024 * 1024 * 1024
            || file
                .mode
                .is_some_and(|mode| mode & !0o777 != 0 || mode & 0o6000 != 0)
        {
            return Err("组件文件清单含重复路径、摘要或权限错误".into());
        }
        total = total.checked_add(file.size).ok_or("组件解压大小溢出")?;
        if total > 20 * 1024 * 1024 * 1024 {
            return Err("组件解压容量超过限制".into());
        }
    }
    for file in files {
        let mut prefix = String::new();
        for part in file.path.split('/').take(file.path.split('/').count() - 1) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if names.contains(&path_key(&prefix)) {
                return Err("组件清单文件与目录冲突".into());
            }
        }
    }
    Ok(total)
}

fn create_safe_parents(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    if let Some(parent) = relative.parent() {
        for part in parent.components() {
            current.push(part.as_os_str());
            match fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("创建组件解压目录失败：{error}")),
            }
            let metadata = current
                .symlink_metadata()
                .map_err(|error| error.to_string())?;
            if is_link(&metadata)
                || !metadata.is_dir()
                || !current
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .starts_with(root)
            {
                return Err("组件解压目录被链接或包外路径替换".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn verify_tree(
    root: &Path,
    files: &[ComponentFile],
    allow_marker: bool,
    cancel: &AtomicBool,
) -> Result<(), String> {
    validate_files(files)?;
    let metadata = root.symlink_metadata().map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("组件根目录不可信".into());
    }
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let expected: HashMap<String, &ComponentFile> =
        files.iter().map(|file| (file.path.clone(), file)).collect();
    let mut seen = HashSet::new();
    fn walk(
        root: &Path,
        path: &Path,
        expected: &HashMap<String, &ComponentFile>,
        seen: &mut HashSet<String>,
        allow_marker: bool,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        check_cancel(cancel)?;
        let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
        if is_link(&metadata)
            || !path
                .canonicalize()
                .map_err(|error| error.to_string())?
                .starts_with(root)
        {
            return Err("组件目录包含链接或包外文件".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
                walk(
                    root,
                    &entry.map_err(|error| error.to_string())?.path(),
                    expected,
                    seen,
                    allow_marker,
                    cancel,
                )?;
            }
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if allow_marker && relative == ".complete.json" {
                return Ok(());
            }
            let file = expected
                .get(&relative)
                .ok_or_else(|| format!("组件存在未登记文件：{relative}"))?;
            if !seen.insert(relative.clone())
                || metadata.len() != file.size
                || hash_file(path, cancel)? != (file.sha256.clone(), file.size)
            {
                return Err(format!("组件文件校验失败：{relative}"));
            }
        } else {
            return Err("组件存在特殊文件".into());
        }
        Ok(())
    }
    walk(
        &canonical,
        &canonical,
        &expected,
        &mut seen,
        allow_marker,
        cancel,
    )?;
    if seen.len() != expected.len() {
        return Err("组件文件不完整".into());
    }
    Ok(())
}

pub(crate) fn extract_zip(
    archive: &Path,
    staging: &Path,
    archive_size: u64,
    archive_sha256: &str,
    files: &[ComponentFile],
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let total = validate_files(files)?;
    if !valid_sha256(archive_sha256)
        || hash_file(archive, cancel)? != (archive_sha256.into(), archive_size)
    {
        return Err("组件压缩包大小或 SHA-256 校验失败".into());
    }
    let metadata = staging
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if is_link(&metadata)
        || !metadata.is_dir()
        || fs::read_dir(staging)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
    {
        return Err("组件解压必须使用新的空暂存目录".into());
    }
    let root = staging.canonicalize().map_err(|error| error.to_string())?;
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| format!("组件 ZIP 损坏：{error}"))?;
    if zip.len() > files.len().saturating_mul(33) || zip.len() > 400_000 {
        return Err("组件 ZIP 条目过多".into());
    }
    let expected: HashMap<String, &ComponentFile> =
        files.iter().map(|file| (file.path.clone(), file)).collect();
    let mut seen = HashSet::new();
    let mut extracted = HashSet::new();
    let mut completed = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    for index in 0..zip.len() {
        check_cancel(cancel)?;
        let mut member = zip
            .by_index(index)
            .map_err(|error| format!("读取组件 ZIP 条目失败：{error}"))?;
        let directory = member.is_dir();
        let name = if directory {
            member.name().trim_end_matches('/').to_string()
        } else {
            member.name().to_string()
        };
        let relative = safe_relative(&name)?;
        if !seen.insert(path_key(&name)) {
            return Err("组件 ZIP 含重复成员".into());
        }
        if member.unix_mode().is_some_and(|mode| {
            let kind = mode & 0o170000;
            (kind != 0 && kind != if directory { 0o040000 } else { 0o100000 }) || mode & 0o6000 != 0
        }) {
            return Err("组件 ZIP 含符号链接或特殊成员".into());
        }
        if directory {
            if member.size() != 0
                || !files
                    .iter()
                    .any(|file| file.path.starts_with(&(name.clone() + "/")))
            {
                return Err("组件 ZIP 含未登记目录".into());
            }
            continue;
        }
        let file = expected
            .get(&name)
            .ok_or_else(|| format!("组件 ZIP 含未登记文件：{name}"))?;
        if member.size() != file.size {
            return Err(format!("组件 ZIP 文件大小不匹配：{name}"));
        }
        if !matches!(
            member.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err("组件 ZIP 压缩格式不支持".into());
        }
        create_safe_parents(&root, &relative)?;
        let target = root.join(&relative);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("创建组件文件失败：{error}"))?;
        let mut hash = Sha256::new();
        let mut written = 0u64;
        loop {
            check_cancel(cancel)?;
            let count = member
                .read(&mut buffer)
                .map_err(|error| format!("组件 ZIP 数据损坏：{error}"))?;
            if count == 0 {
                break;
            }
            written = written
                .checked_add(count as u64)
                .ok_or("组件文件大小溢出")?;
            if written > file.size {
                return Err("组件 ZIP 实际解压大小超出清单".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| error.to_string())?;
            hash.update(&buffer[..count]);
            completed += count as u64;
            progress(completed, total);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        if written != file.size || hex::encode(hash.finalize()) != file.sha256 {
            return Err(format!("组件解压文件 SHA-256 不匹配：{name}"));
        }
        #[cfg(unix)]
        if let Some(mode) = file.mode {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&target, fs::Permissions::from_mode(mode))
                .map_err(|error| error.to_string())?;
        }
        extracted.insert(name);
    }
    if extracted.len() != expected.len() {
        return Err("组件 ZIP 缺少登记文件".into());
    }
    verify_tree(&root, files, false, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) -> (u64, String) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        let (hash, size) = hash_file(path, &AtomicBool::new(false)).unwrap();
        (size, hash)
    }
    fn expected(path: &str, bytes: &[u8]) -> ComponentFile {
        ComponentFile {
            path: path.into(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            mode: None,
        }
    }
    #[test]
    fn archive_validates_inventory_and_rejects_corrupt_payload() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("archive.zip");
        let (size, digest) = make_zip(&archive, &[("runtime/tool.dll", b"payload")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        extract_zip(
            &archive,
            staging.path(),
            size,
            &digest,
            &[expected("runtime/tool.dll", b"payload")],
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        let another = tempfile::tempdir_in(temp.path()).unwrap();
        assert!(
            extract_zip(
                &archive,
                another.path(),
                size,
                &digest,
                &[expected("runtime/tool.dll", b"changed")],
                &AtomicBool::new(false),
                |_, _| {}
            )
            .is_err()
        );
        fs::write(&archive, b"invalid zip").unwrap();
        let (digest, size) = hash_file(&archive, &AtomicBool::new(false)).unwrap();
        let corrupt_staging = tempfile::tempdir_in(temp.path()).unwrap();
        assert!(
            extract_zip(
                &archive,
                corrupt_staging.path(),
                size,
                &digest,
                &[expected("runtime/tool.dll", b"payload")],
                &AtomicBool::new(false),
                |_, _| {}
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_external_paths_duplicate_names_and_symlinks() {
        for name in [
            "../outside",
            "/absolute",
            "C:/outside",
            "a\\b",
            "a/../b",
            "a:stream",
            "CON.txt",
            "x./y",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
        ] {
            assert!(safe_relative(name).is_err(), "{name}");
        }
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("archive.zip");
        // Case-folding detects duplicates even if the host filesystem is case-sensitive.
        let (size, digest) = make_zip(&archive, &[("tool.dll", b"one"), ("TOOL.dll", b"two")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        assert!(
            extract_zip(
                &archive,
                staging.path(),
                size,
                &digest,
                &[expected("tool.dll", b"one")],
                &AtomicBool::new(false),
                |_, _| {}
            )
            .is_err()
        );
        let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
        zip.add_symlink("tool.dll", "../../outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        let (digest, size) = hash_file(&archive, &AtomicBool::new(false)).unwrap();
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        assert!(
            extract_zip(
                &archive,
                staging.path(),
                size,
                &digest,
                &[expected("tool.dll", b"../../outside")],
                &AtomicBool::new(false),
                |_, _| {}
            )
            .is_err()
        );
        assert!(!temp.path().join("outside").exists());
    }
}
