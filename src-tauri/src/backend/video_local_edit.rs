use std::{fs, io::Cursor, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::json;
use tauri::Manager as _;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    types::BackendErrorPayload,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVideoEditFrame {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

fn save_frame(
    directory: &Path,
    prefix: &str,
    image_data_url: &str,
    invalid_message: &str,
) -> BackendResult<SavedVideoEditFrame> {
    let invalid = || BackendError::validation(invalid_message, json!({}));
    let encoded = image_data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(invalid)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(invalid());
    }
    let image = image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png)
        .decode()
        .map_err(|_| invalid())?;
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("{prefix}-{}.png", Uuid::new_v4()));
    fs::write(&path, bytes)?;
    Ok(SavedVideoEditFrame {
        path: path.to_string_lossy().into_owned(),
        width: image.width(),
        height: image.height(),
    })
}

/// Store the real annotated frame as a reusable local image, never inline it in a canvas archive.
#[tauri::command]
pub async fn save_video_edit_frame(
    app: tauri::AppHandle,
    image_data_url: String,
) -> Result<SavedVideoEditFrame, BackendErrorPayload> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| BackendError::from(error).payload())?
        .join("video-edit-frames");
    tauri::async_runtime::spawn_blocking(move || {
        save_frame(
            &directory,
            "video-edit",
            &image_data_url,
            "视频标注帧必须是有效的 PNG 图片。",
        )
    })
    .await
        .map_err(|error| {
            BackendError::protocol("保存视频标注帧失败。", json!({"source": error.to_string()}))
                .payload()
        })?
        .map_err(|error| error.payload())
}

/// 导演台机位截图：站位图只保存为本地 PNG，不把像素写进画布存档。
#[tauri::command]
pub async fn save_white_model_still(
    app: tauri::AppHandle,
    image_data_url: String,
) -> Result<SavedVideoEditFrame, BackendErrorPayload> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| BackendError::from(error).payload())?
        .join("white-model-stills");
    tauri::async_runtime::spawn_blocking(move || {
        save_frame(
            &directory,
            "still",
            &image_data_url,
            "站位图必须是有效的 PNG 图片。",
        )
    })
    .await
    .map_err(|error| {
        BackendError::protocol("保存站位图失败。", json!({"source": error.to_string()})).payload()
    })?
    .map_err(|error| error.payload())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_edit_frame_is_decoded_and_saved_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(320, 240)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let data = format!("data:image/png;base64,{}", STANDARD.encode(png.get_ref()));
        let first = save_frame(
            directory.path(),
            "video-edit",
            &data,
            "视频标注帧必须是有效的 PNG 图片。",
        )
        .unwrap();
        let second = save_frame(
            directory.path(),
            "still",
            &data,
            "站位图必须是有效的 PNG 图片。",
        )
        .unwrap();
        assert_eq!((first.width, first.height), (320, 240));
        assert_ne!(first.path, second.path);
        assert!(first.path.contains("video-edit-"));
        assert!(second.path.contains("still-"));
        assert_eq!(fs::read(&first.path).unwrap(), *png.get_ref());
    }

    #[test]
    fn video_edit_frame_rejects_forged_or_truncated_images_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        for data in [
            "data:image/jpeg;base64,AAAA",
            "data:image/png;base64,invalid",
            "data:image/png;base64,iVBORw0KGgo=",
        ] {
            assert!(save_frame(
                directory.path(),
                "video-edit",
                data,
                "视频标注帧必须是有效的 PNG 图片。"
            )
            .is_err());
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
