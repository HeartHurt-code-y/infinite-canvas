//! 本地媒体缩略图管线：为画布产物卡片、抽帧预览等场景生成图片小图或视频封面，
//! 避免 WebView 解码多张全尺寸原图（生成图可达数 MB～数十 MB，抽帧图成批出现）。
//!
//! PNG/JPEG 源用 image crate 纯 Rust 缩放（项目仅启用这两种解码 feature）；
//! 其余格式（webp/gif 等）解码失败时返回 `None`，前端回退原图，不影响可用性。
//! 视频复用已就绪的 FFmpeg 组件解码首帧，不依赖 WebView 的元数据预加载/中点定位。
//! 封面写到独立缓存，绝不重编码、替换或修改原视频；没有引擎时保留浏览器预览兜底。
//! 缓存键 = sha256(源路径 | 源大小 | 源修改时间 | 目标边长)，源文件变化或目标
//! 尺寸变化都会生成新缓存条目；命中缓存时不解码源文件。

use std::{
    fs,
    io::Write as _,
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
    hasher.update(max_dimension.to_le_bytes());
    Ok(directory.join(format!(
        "media-thumb-{}.jpg",
        hex::encode(hasher.finalize())
    )))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_png(directory: &Path, width: u32, height: u32) -> PathBuf {
        let path = directory.join("source.png");
        image::DynamicImage::new_rgb8(width, height)
            .write_to(
                &mut std::io::BufWriter::new(fs::File::create(&path).unwrap()),
                image::ImageFormat::Png,
            )
            .unwrap();
        path
    }

    #[test]
    fn creates_a_scaled_jpeg_thumbnail_and_reuses_the_cache() {
        let directory = tempfile::tempdir().unwrap();
        let source = write_test_png(directory.path(), 2048, 1024);

        let first = create_thumbnail(directory.path(), source.to_str().unwrap(), 512)
            .unwrap()
            .expect("png source is scalable");
        assert_eq!((first.width, first.height), (512, 256));
        let encoded = fs::read(&first.path).unwrap();
        assert_eq!(&encoded[..2], b"\xff\xd8", "thumbnail must be a JPEG");

        // 第二次调用命中缓存（同一路径），且不再依赖源文件。
        let second = create_thumbnail(directory.path(), source.to_str().unwrap(), 512)
            .unwrap()
            .expect("cache hit");
        assert_eq!(second.path, first.path);
    }

    #[test]
    fn returns_none_for_unscalable_or_missing_sources() {
        let directory = tempfile::tempdir().unwrap();
        let text = directory.path().join("source.txt");
        fs::write(&text, "not an image").unwrap();
        assert_eq!(
            create_thumbnail(directory.path(), text.to_str().unwrap(), 512).unwrap(),
            None
        );
        assert_eq!(
            create_thumbnail(
                directory.path(),
                directory.path().join("missing.png").to_str().unwrap(),
                512
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn cache_key_changes_when_the_target_dimension_changes() {
        let directory = tempfile::tempdir().unwrap();
        let source = write_test_png(directory.path(), 800, 600);
        let small = create_thumbnail(directory.path(), source.to_str().unwrap(), 256)
            .unwrap()
            .expect("scalable");
        let large = create_thumbnail(directory.path(), source.to_str().unwrap(), 512)
            .unwrap()
            .expect("scalable");
        assert_ne!(small.path, large.path);
        assert_eq!((small.width, small.height), (256, 192));
    }

    #[tokio::test]
    #[ignore = "requires INFINITE_CANVAS_TEST_FFMPEG pointing at the installed project engine"]
    async fn installed_engine_creates_video_poster_without_changing_source() {
        let ffmpeg = PathBuf::from(std::env::var("INFINITE_CANVAS_TEST_FFMPEG").unwrap());
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("short-video.mp4");
        let mut fixture = std::process::Command::new(&ffmpeg);
        fixture
            .args([
                "-nostdin",
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=320x640:r=24:d=0.125",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-threads",
                "1",
            ])
            .arg(&source);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            fixture.creation_flags(0x0800_0000);
        }
        assert!(fixture.output().unwrap().status.success());
        let original = fs::read(&source).unwrap();
        let poster = create_video_thumbnail(
            directory.path(),
            source.to_str().unwrap(),
            256,
            Some(&ffmpeg),
        )
        .await
        .unwrap()
        .expect("a valid local video needs a poster even when it is shorter than a seek target");
        assert_eq!((poster.width, poster.height), (128, 256));
        assert_eq!(fs::read(&source).unwrap(), original);
        let decoded = image::open(&poster.path).unwrap().to_rgb8();
        let center = decoded.get_pixel(64, 128);
        assert!(center[0] > 240 && center[1] < 12 && center[2] < 12);
        // 引擎后来不可用时仍能展示已完成缓存，不再次启动解码器。
        let cached = create_video_thumbnail(directory.path(), source.to_str().unwrap(), 256, None)
            .await
            .unwrap()
            .expect("cache hit without engine");
        assert_eq!(poster, cached);
        let corrupt = directory.path().join("corrupt.mp4");
        fs::write(&corrupt, "not a video").unwrap();
        assert_eq!(
            create_video_thumbnail(
                directory.path(),
                corrupt.to_str().unwrap(),
                256,
                Some(&ffmpeg)
            )
            .await
            .unwrap(),
            None,
        );
        assert!(
            fs::read_dir(directory.path()).unwrap().all(|entry| {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                name == "short-video.mp4"
                    || name == "corrupt.mp4"
                    || name.starts_with("media-thumb-")
            }),
            "failed decoding must not leave temporary cache files"
        );
    }

    #[tokio::test]
    async fn video_poster_missing_source_or_engine_returns_none() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("video.MP4");
        assert!(is_video_source(&source));
        assert_eq!(
            create_video_thumbnail(directory.path(), source.to_str().unwrap(), 512, None)
                .await
                .unwrap(),
            None
        );
        fs::write(&source, "engine is unavailable").unwrap();
        assert_eq!(
            create_video_thumbnail(directory.path(), source.to_str().unwrap(), 512, None)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    #[ignore = "requires INFINITE_CANVAS_TEST_FFMPEG pointing at the installed project engine"]
    async fn installed_engine_preserves_anamorphic_video_display_ratio() {
        let ffmpeg = PathBuf::from(std::env::var("INFINITE_CANVAS_TEST_FFMPEG").unwrap());
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("anamorphic.mp4");
        let mut fixture = tokio::process::Command::new(&ffmpeg);
        fixture
            .args([
                "-nostdin",
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=720x576:r=24:d=0.125",
                "-vf",
                "setsar=64/45",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-threads",
                "1",
            ])
            .arg(&source);
        #[cfg(windows)]
        fixture.creation_flags(0x0800_0000);
        assert!(fixture.output().await.unwrap().status.success());
        let original = fs::read(&source).unwrap();
        let poster = create_video_thumbnail(
            directory.path(),
            source.to_str().unwrap(),
            512,
            Some(&ffmpeg),
        )
        .await
        .unwrap()
        .expect("anamorphic poster");
        assert_eq!(
            (poster.width, poster.height),
            (512, 288),
            "720x576 with SAR64:45 must remain 16:9, not 5:4"
        );
        assert_eq!(fs::read(&source).unwrap(), original);
    }
}
