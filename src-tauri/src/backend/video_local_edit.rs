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
