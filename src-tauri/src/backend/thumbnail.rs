//! 本地媒体缩略图管线：为画布产物卡片、抽帧预览等场景生成图片小图或视频封面，
//! 避免 WebView 解码多张全尺寸原图（生成图可达数 MB～数十 MB，抽帧图成批出现）。
//!
//! PNG/JPEG 源用 image crate 纯 Rust 缩放（项目仅启用这两种解码 feature）；
//! 其余格式（webp/gif 等）解码失败时返回 `None`，前端回退原图，不影响可用性。
//! 视频复用已就绪的 FFmpeg 组件解码首帧，不依赖 WebView 的元数据预加载/中点定位。
//! 封面写到独立缓存，绝不重编码、替换或修改原视频；没有引擎时保留浏览器预览兜底。
//! 缓存键 = sha256(源路径 | 源大小 | 源修改时间 | 源内容身份 | 目标边长)，源文件
//! 被覆写（同一路径换了内容）或目标尺寸变化都会生成新缓存条目；命中缓存时不解码
//! 源文件。内容身份在**查缓存之前**就并进键里，因此旧缩略图不会被当成命中返回。

use std::{
    fs,
    io::{Read as _, Seek as _, SeekFrom, Write as _},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager as _;

use super::error::{BackendError, BackendResult};
use super::types::BackendErrorPayload;

/// 单个源文件的大小上限：异常巨大的文件不做缩放（前端回退原图）。
const SOURCE_SIZE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const VIDEO_POSTER_TIMEOUT: Duration = Duration::from_secs(15);
const VIDEO_POSTER_SIZE_LIMIT_BYTES: usize = 16 * 1024 * 1024;

/// 整文件摘要的取样上限：不超过这个体积的源按整文件算内容身份。
const CONTENT_DIGEST_FULL_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
/// 超过上面的体积时，只摘要首尾各这么多字节。
const CONTENT_DIGEST_EDGE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaThumbnail {
    /// 缩略图绝对路径（可能命中磁盘缓存），前端转 asset:// 协议展示。
    pub path: String,
    pub width: u32,
    pub height: u32,
}

fn cache_directory(app: &tauri::AppHandle) -> BackendResult<PathBuf> {
    Ok(app.path().app_local_data_dir()?.join("media-thumbnails"))
}

fn cache_path(directory: &Path, source: &Path, max_dimension: u32) -> BackendResult<PathBuf> {
    let metadata = fs::metadata(source)?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(source.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    // 内容身份必须并进键里（而不是命中之后再校验）：命中判定一旦返回旧缩略图，
    // 校验就来不及了 —— 那时用户已经看到上一版的图。
    hasher.update(content_identity(source, &metadata));
    hasher.update(max_dimension.to_le_bytes());
    Ok(directory.join(format!(
        "media-thumb-{}.jpg",
        hex::encode(hasher.finalize())
    )))
}

/// 源文件的内容身份摘要。
///
/// 为什么不能只看「路径 + 大小 + 修改时间」：文件系统的时间戳精度有限（Windows 的
/// 文件修改时间按系统时钟节拍更新，同一节拍内覆写同一个路径且大小不变时，这三个值
/// 完全相同），而「同路径覆写」在本项目里很常见 —— 生成任务重跑会把新图片写到同一个
/// 本地路径。键里没有内容身份时，旧缩略图会被当成命中返回。
///
/// 取样按体积分档，在「身份准确」与「代价可控」之间取平衡：
///
/// - 不超过 [`CONTENT_DIGEST_FULL_LIMIT_BYTES`] 的源按**整文件**摘要。典型图片几 MB，
///   多读一次的成本可以忽略，身份也最准；
/// - 更大的源（原始视频动辄几百 MB）只摘要「首尾各一段 + 大小 + 修改时间」，避免为了
///   一个缩略图把整段视频读一遍。代价是「只改了中间内容」这种情况可能漏检，但视频
///   首帧极少只改中间，且视频路径还有取帧后的二次校验兜底。
fn content_identity(source: &Path, metadata: &fs::Metadata) -> Vec<u8> {
    let length = metadata.len();
    let mut hasher = Sha256::new();
    // 域分隔前缀：内容摘要不能与键里其它字段的字节流混为一谈。
    hasher.update(b"content-identity-v1");
    hasher.update(length.to_le_bytes());
    if length <= CONTENT_DIGEST_FULL_LIMIT_BYTES {
        hasher.update(b"full");
        match fs::read(source) {
            Ok(bytes) => hasher.update(&bytes),
            // 读不出来时只留下长度标记：宁可让这一条缓存不命中，也不要用弱身份
            // 命中上一份内容的缩略图。
            Err(_) => hasher.update(b"unreadable"),
        }
    } else {
        hasher.update(b"edge");
        let edge = CONTENT_DIGEST_EDGE_BYTES as usize;
        match fs::File::open(source) {
            Ok(mut file) => {
                let mut head = vec![0_u8; edge];
                let head_read = read_exact_upto(&mut file, &mut head);
                head.truncate(head_read);
                hasher.update(&(head_read as u64).to_le_bytes());
                hasher.update(&head);
                if length > CONTENT_DIGEST_EDGE_BYTES {
                    let tail_start = length - CONTENT_DIGEST_EDGE_BYTES;
                    if file.seek(SeekFrom::Start(tail_start)).is_ok() {
                        let mut tail = vec![0_u8; edge];
                        let tail_read = read_exact_upto(&mut file, &mut tail);
                        tail.truncate(tail_read);
                        hasher.update(&(tail_read as u64).to_le_bytes());
                        hasher.update(&tail);
                    }
                }
            }
            Err(_) => {
                hasher.update(b"unreadable");
            }
        }
    }
    let digest = hasher.finalize();
    digest.to_vec()
}

/// 读满缓冲区或读到文件结束，返回实际读到的字节数。
///
/// 单次 `read` 可能短读。摘要必须对同一份文件**稳定**：短读会让两次读出不同的字节数，
/// 于是同一份内容算出两个摘要、缓存键跟着抖动，缓存永远命不中。
fn read_exact_upto(file: &mut fs::File, buffer: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => break,
        }
    }
    filled
}

/// 预期中的「不可缩放」（格式不支持、文件损坏、源缺失）统一返回 `Ok(None)`，
/// 前端回退原图即可；只有真正的 I/O/编码意外才向上抛错。
fn create_thumbnail(
    directory: &Path,
    source: &str,
    max_dimension: u32,
) -> BackendResult<Option<MediaThumbnail>> {
    let source_path = Path::new(source);
    if !source_path.is_file() {
        return Ok(None);
    }
    if fs::metadata(source_path)?.len() > SOURCE_SIZE_LIMIT_BYTES {
        return Ok(None);
    }
    let target = cache_path(directory, source_path, max_dimension)?;
    if let Some(cached) = read_cached_thumbnail(&target) {
        return Ok(Some(cached));
    }
    let Ok(image) = image::ImageReader::open(source_path)?
        .with_guessed_format()?
        .decode()
    else {
        return Ok(None);
    };
    let thumbnail = image.thumbnail(max_dimension, max_dimension).to_rgb8();
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut temporary, 85);
    thumbnail.write_with_encoder(encoder).map_err(|error| {
        BackendError::protocol(
            "media thumbnail encode failed",
            json!({ "source": error.to_string() }),
        )
    })?;
    temporary.as_file().sync_all()?;
    // 源文件在解码期间被替换时，不把新内容登记到旧缓存身份下（与视频取帧同一条规矩）。
    if cache_path(directory, source_path, max_dimension)? != target {
        return Ok(None);
    }
    publish_thumbnail(temporary, &target)
}

fn read_cached_thumbnail(target: &Path) -> Option<MediaThumbnail> {
    if fs::metadata(target).ok()?.len() == 0 {
        let _ = fs::remove_file(target);
        return None;
    }
    let dimensions = image::ImageReader::open(target)
        .ok()
        .and_then(|reader| reader.into_dimensions().ok());
    let Some((width, height)) = dimensions.filter(|(width, height)| *width > 0 && *height > 0)
    else {
        let _ = fs::remove_file(target);
        return None;
    };
    Some(MediaThumbnail {
        path: target.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// 完整写入后原子发布；同时请求同一封面时保留先到的完整缓存。
fn publish_thumbnail(
    temporary: tempfile::NamedTempFile,
    target: &Path,
) -> BackendResult<Option<MediaThumbnail>> {
    if let Err(error) = temporary.persist_noclobber(target) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.error.into());
        }
    }
    Ok(read_cached_thumbnail(target))
}

fn is_video_source(source: &Path) -> bool {
    source
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "mpeg" | "mpg" | "ts"
            )
        })
}

async fn create_video_thumbnail(
    directory: &Path,
    source: &str,
    max_dimension: u32,
    ffmpeg: Option<&Path>,
) -> BackendResult<Option<MediaThumbnail>> {
    let source = Path::new(source);
    if !source.is_file() {
        return Ok(None);
    }
    let target = cache_path(directory, source, max_dimension)?;
    if let Some(cached) = read_cached_thumbnail(&target) {
        return Ok(Some(cached));
    }
    let Some(ffmpeg) = ffmpeg else {
        return Ok(None);
    };
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .args([
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-i",
        ])
        .arg(source)
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf"])
        // 先按实际显示宽高比（DAR，含非方形像素 SAR）算尺寸，再转方形像素。
        // 只设置 setsar=1 会挤压变形；显式表达式兼容没有 reset_sar 的旧 FFmpeg。
        .arg(format!(
            "scale=w='max(1,trunc(if(gte(dar,1),min({max_dimension},iw*sar),min({max_dimension},ih)*dar)))':h='max(1,trunc(if(gte(dar,1),min({max_dimension},iw*sar)/dar,min({max_dimension},ih))))',setsar=1"
        ))
        .args(["-threads", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = match tokio::time::timeout(VIDEO_POSTER_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => return Ok(None),
    };
    if output.stdout.len() > VIDEO_POSTER_SIZE_LIMIT_BYTES {
        return Ok(None);
    }
    let Ok(decoded) = image::load_from_memory_with_format(&output.stdout, image::ImageFormat::Jpeg)
    else {
        return Ok(None);
    };
    if decoded.width() == 0
        || decoded.height() == 0
        || decoded.width() > max_dimension
        || decoded.height() > max_dimension
        // 源文件在取帧时被替换，不把新文件内容登记到旧缓存身份下。
        || cache_path(directory, source, max_dimension)? != target
    {
        return Ok(None);
    }
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(&output.stdout)?;
    temporary.as_file().sync_all()?;
    publish_thumbnail(temporary, &target)
}

/// 生成本地图片缩略图或视频首帧封面。没有视频引擎时返回 `None`，不自动下载组件。
#[tauri::command]
pub async fn create_media_thumbnail(
    app: tauri::AppHandle,
    source_path: String,
    max_dimension: Option<u32>,
) -> Result<Option<MediaThumbnail>, BackendErrorPayload> {
    let max_dimension = max_dimension.unwrap_or(512).clamp(64, 2048);
    let directory = match cache_directory(&app) {
        Ok(directory) => directory,
        Err(_) => return Ok(None),
    };
    let result = if is_video_source(Path::new(&source_path)) {
        let ffmpeg = app
            .try_state::<super::BackendState>()
            .and_then(|state| state.composer.engine_status().binary_path)
            .map(PathBuf::from);
        create_video_thumbnail(&directory, &source_path, max_dimension, ffmpeg.as_deref()).await
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            create_thumbnail(&directory, &source_path, max_dimension)
        })
        .await
        .map_err(|error| {
            BackendError::protocol(
                "media thumbnail task failed",
                json!({ "source": error.to_string() }),
            )
            .payload()
        })?
    };
    match result {
        Ok(thumbnail) => Ok(thumbnail),
        Err(error) => {
            tauri_plugin_log::log::warn!("media thumbnail failed: {error}");
            Ok(None)
        }
    }
}
