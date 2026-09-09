//! 本地媒体缩略图管线：为画布产物卡片、抽帧预览等场景的本地图片生成小图，
//! 避免 WebView 解码多张全尺寸原图（生成图可达数 MB～数十 MB，抽帧图成批出现）。
//!
//! PNG/JPEG 源用 image crate 纯 Rust 缩放（项目仅启用这两种解码 feature）；
//! 其余格式（webp/gif 等）解码失败时返回 `None`，前端回退原图，不影响可用性。
//! 缓存键 = sha256(源路径 | 源大小 | 源修改时间 | 目标边长)，源文件变化或目标
//! 尺寸变化都会生成新缓存条目；命中缓存时不解码源文件。

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager as _;

use super::error::{BackendError, BackendResult};
use super::types::BackendErrorPayload;

/// 单个源文件的大小上限：异常巨大的文件不做缩放（前端回退原图）。
const SOURCE_SIZE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

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
        .map(|duration| duration.as_millis())
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
    if let Ok(metadata) = fs::metadata(&target) {
        if metadata.len() > 0 {
            // 缓存命中：只读文件头取尺寸；缓存文件损坏时删除后走重建。
            let header = image::ImageReader::open(&target).map(|reader| reader.into_dimensions());
            match header {
                Ok(Ok(dimensions)) => {
                    return Ok(Some(MediaThumbnail {
                        path: target.to_string_lossy().into_owned(),
                        width: dimensions.0,
                        height: dimensions.1,
                    }));
                }
                _ => {
                    let _ = fs::remove_file(&target);
                }
            }
        }
    }
    let Ok(image) = image::ImageReader::open(source_path)?
        .with_guessed_format()?
        .decode()
    else {
        return Ok(None);
    };
    let thumbnail = image.thumbnail(max_dimension, max_dimension).to_rgb8();
    fs::create_dir_all(directory)?;
    let file = fs::File::create(&target)?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 85);
    thumbnail.write_with_encoder(encoder).map_err(|error| {
        BackendError::protocol(
            "media thumbnail encode failed",
            json!({ "source": error.to_string() }),
        )
    })?;
    Ok(Some(MediaThumbnail {
        path: target.to_string_lossy().into_owned(),
        width: thumbnail.width(),
        height: thumbnail.height(),
    }))
}

/// 生成（或命中磁盘缓存）本地图片的缩略图。不可缩放的格式返回 `None`，前端回退原图。
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        create_thumbnail(&directory, &source_path, max_dimension)
    })
    .await
    .map_err(|error| {
        BackendError::protocol(
            "media thumbnail task failed",
            json!({ "source": error.to_string() }),
        )
        .payload()
    })?;
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
}
