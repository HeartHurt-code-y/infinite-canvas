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
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl ComponentFile {
    pub(crate) fn is_symlink(&self) -> bool {
        self.kind.as_deref() == Some("symlink")
    }
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

/// Normalize a relative link target without ever crossing the component root.
/// The ZIP contract allows framework links such as `Versions/Current -> A`.
pub(crate) fn link_destination(path: &str, target: &str) -> Result<String, String> {
    safe_relative(path)?;
    if target.is_empty()
        || target.len() > 4096
        || target.starts_with('/')
        || target.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || target.chars().any(char::is_control)
        || target.split('/').count() > 32
    {
        return Err("组件软链接目标无效".into());
    }
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" => return Err("组件软链接目标含空片段".into()),
            "." => {}
            ".." => {
                parts.pop().ok_or("组件软链接目标超出组件目录")?;
            }
            other => {
                safe_relative(other)?;
                parts.push(other);
            }
        }
    }
    let relative = parts.join("/");
    safe_relative(&relative)?;
    Ok(relative)
}

fn validate_links(files: &[ComponentFile]) -> Result<(), String> {
    let links: HashMap<&str, &ComponentFile> = files
        .iter()
        .filter(|file| file.is_symlink())
        .map(|file| (file.path.as_str(), file))
        .collect();
    for file in links.values() {
        let mut destination = link_destination(&file.path, file.target.as_deref().unwrap_or(""))?;
        let mut seen = HashSet::new();
        // Resolve symlinks in every path prefix, including directory aliases.
        loop {
            if !seen.insert(destination.clone()) || seen.len() > files.len() {
                return Err("组件软链接目标含循环".into());
            }
            let mut replacement = None;
            let mut prefix = String::new();
            for part in destination.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if let Some(link) = links.get(prefix.as_str()) {
                    let resolved =
                        link_destination(&link.path, link.target.as_deref().unwrap_or(""))?;
                    let suffix = &destination[prefix.len()..];
                    replacement = Some(format!("{resolved}{suffix}"));
                    break;
                }
            }
            match replacement {
                Some(next) => destination = next,
                None => break,
            }
        }
        let target_file = files
            .iter()
            .any(|candidate| candidate.path == destination && !candidate.is_symlink());
        let target_directory = files
            .iter()
            .any(|candidate| candidate.path.starts_with(&(destination.clone() + "/")));
        if !target_file && !target_directory {
            return Err("组件软链接目标缺失".into());
        }
        let parent = file
            .path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        if target_directory && (parent == destination || parent.starts_with(&(destination + "/"))) {
            return Err("组件软链接不能指向自身的祖先目录".into());
        }
    }
    Ok(())
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
            || !matches!(file.kind.as_deref(), None | Some("file") | Some("symlink"))
        {
            return Err("组件文件清单含重复路径、摘要或权限错误".into());
        }
        if file.is_symlink() {
            let target = file.target.as_deref().ok_or("组件软链接缺少目标")?;
            link_destination(&file.path, target)?;
            if file.size != target.len() as u64
                || file.sha256 != hex::encode(Sha256::digest(target.as_bytes()))
                || file.mode != Some(0o755)
            {
                return Err("组件软链接目标、摘要或权限不匹配".into());
            }
        } else if file.target.is_some() {
            return Err("普通组件文件不能指定软链接目标".into());
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
    validate_links(files)?;
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
        if metadata.file_type().is_symlink() {
            #[cfg(not(unix))]
            return Err("此平台不支持组件软链接".into());
            #[cfg(unix)]
            {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .into_owned();
                let file = expected.get(&relative).ok_or("组件存在未登记软链接")?;
                let target = fs::read_link(path).map_err(|error| error.to_string())?;
                if !file.is_symlink()
                    || target.to_str() != file.target.as_deref()
                    || !seen.insert(relative)
                {
                    return Err("组件软链接目标与清单不匹配".into());
                }
                let resolved = path.canonicalize().map_err(|_| "组件软链接悬空或循环")?;
                let resolved_metadata =
                    fs::metadata(&resolved).map_err(|error| error.to_string())?;
                if !resolved.starts_with(root)
                    || (!resolved_metadata.is_file() && !resolved_metadata.is_dir())
                {
                    return Err("组件软链接目标超出目录或类型无效".into());
                }
                return Ok(());
            }
        }
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
                || file.is_symlink()
                || metadata.len() != file.size
                || hash_file(path, cancel)? != (file.sha256.clone(), file.size)
            {
                return Err(format!("组件文件校验失败：{relative}"));
            }
            #[cfg(unix)]
            if let Some(expected_mode) = file.mode {
                use std::os::unix::fs::PermissionsExt as _;
                if metadata.permissions().mode() & 0o7777 != expected_mode {
                    return Err(format!("组件文件权限校验失败：{relative}"));
                }
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
    let mut links = Vec::new();
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
        let expected_file = expected.get(&name).copied();
        let symlink = expected_file.is_some_and(ComponentFile::is_symlink);
        if member.unix_mode().is_some_and(|mode| {
            let kind = mode & 0o170000;
            let expected_kind = if directory {
                0o040000
            } else if symlink {
                0o120000
            } else {
                0o100000
            };
            (kind != 0 && kind != expected_kind) || mode & 0o6000 != 0
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
        let file = expected_file.ok_or_else(|| format!("组件 ZIP 含未登记文件：{name}"))?;
        if symlink
            && member
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000)
        {
            return Err("组件 ZIP 软链接类型与清单不匹配".into());
        }
        if let Some(mode) = file.mode {
            if member
                .unix_mode()
                .is_none_or(|actual| actual & 0o777 != mode)
            {
                return Err("组件 ZIP 文件权限与清单不匹配".into());
            }
        }
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
        if symlink {
            let mut payload = Vec::new();
            member
                .by_ref()
                .take(file.size + 1)
                .read_to_end(&mut payload)
                .map_err(|error| error.to_string())?;
            if payload.len() as u64 != file.size
                || hex::encode(Sha256::digest(&payload)) != file.sha256
                || std::str::from_utf8(&payload).ok() != file.target.as_deref()
            {
                return Err("组件 ZIP 软链接目标与清单不匹配".into());
            }
            links.push((target, file.target.clone().ok_or("组件软链接缺少目标")?));
            completed += file.size;
            progress(completed, total);
            extracted.insert(name);
            continue;
        }
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
    for (path, target) in links {
        check_cancel(cancel)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, path)
            .map_err(|error| format!("恢复组件软链接失败：{error}"))?;
        #[cfg(not(unix))]
        {
            let _ = (path, target);
            return Err("此平台不支持组件软链接".into());
        }
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
            kind: None,
            target: None,
        }
    }
    fn expected_link(path: &str, target: &str) -> ComponentFile {
        ComponentFile {
            mode: Some(0o755),
            kind: Some("symlink".into()),
            target: Some(target.into()),
            ..expected(path, target.as_bytes())
        }
    }
    #[test]
    fn link_inventory_rejects_escape_cycles_dangling_and_linked_parent_entries() {
        let payload = expected("Framework/Versions/A/Resources/payload", b"data");
        let valid = vec![
            payload.clone(),
            expected_link("Framework/Versions/Current", "A"),
            expected_link("Framework/Resources", "Versions/Current/Resources"),
        ];
        validate_files(&valid).unwrap();
        for bad in [
            vec![
                payload.clone(),
                expected_link("Framework/outside", "../../outside"),
            ],
            vec![expected_link("a", "b"), expected_link("b", "a")],
            vec![
                payload.clone(),
                expected_link("Framework/missing", "missing-target"),
            ],
            vec![
                payload.clone(),
                expected_link("Framework/Versions/A/Resources/up", ".."),
            ],
            vec![
                payload.clone(),
                expected_link("Framework/Versions/Current", "A"),
                expected("Framework/Versions/Current/new", b"alias-write"),
            ],
        ] {
            assert!(validate_files(&bad).is_err());
        }
        let mut corrupt = valid.clone();
        corrupt[1].sha256 = "a".repeat(64);
        assert!(validate_files(&corrupt).is_err());
        let mut bad_mode = valid;
        bad_mode[1].mode = Some(0o4777);
        assert!(validate_files(&bad_mode).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn restores_executable_modes_and_framework_links_then_detects_tampering() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("framework.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .add_symlink(
                "Framework/Versions/Current",
                "A",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer
            .add_symlink(
                "Framework/Resources",
                "Versions/Current/Resources",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer
            .start_file(
                "Framework/Versions/A/Resources/engine",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(b"engine-bytes").unwrap();
        writer.finish().unwrap();
        let (digest, size) = hash_file(&archive, &AtomicBool::new(false)).unwrap();
        let files = vec![
            ComponentFile {
                mode: Some(0o755),
                ..expected("Framework/Versions/A/Resources/engine", b"engine-bytes")
            },
            expected_link("Framework/Versions/Current", "A"),
            expected_link("Framework/Resources", "Versions/Current/Resources"),
        ];
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        extract_zip(
            &archive,
            staging.path(),
            size,
            &digest,
            &files,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(
            fs::read(staging.path().join("Framework/Resources/engine")).unwrap(),
            b"engine-bytes"
        );
        let engine = staging.path().join("Framework/Versions/A/Resources/engine");
        assert_eq!(
            fs::metadata(&engine).unwrap().permissions().mode() & 0o777,
            0o755
        );
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(verify_tree(staging.path(), &files, false, &AtomicBool::new(false)).is_err());
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        let link = staging.path().join("Framework/Resources");
        fs::remove_file(&link).unwrap();
        symlink(temp.path(), &link).unwrap();
        assert!(verify_tree(staging.path(), &files, false, &AtomicBool::new(false)).is_err());
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
