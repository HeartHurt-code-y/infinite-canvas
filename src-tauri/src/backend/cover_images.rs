//! 封面交付尺寸归一化。复用应用已有 FFmpeg，以完整保留内容的缩放补边输出严格3:4 PNG。

use std::{
    io::Read as _,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    local_results::LocalResultService,
    storage::Storage,
    types::{GenerationResultRecord, MediaType, SaveStatus},
};

const COVER_WIDTH: u32 = 1080;
const COVER_HEIGHT: u32 = 1440;
// 只约束归一化器产生的固定尺寸交付图，不限制输入源图文件大小。
// 1080×1440 RGB24 原始像素约4.67MB，额外空间用于PNG过滤行和编码开销。
const MAX_COVER_PNG_BYTES: u64 = 5 * 1024 * 1024;
const COVER_FILTER: &str = "scale=1080:1440:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1440:(ow-iw)/2:(oh-ih)/2:color=0x171717,setsar=1,format=rgb24";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeCoverImageCommand {
    pub source_path: String,
    pub output_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCoverImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCoverImageResultCommand {
    pub task_id: String,
    pub result_index: u32,
}

/// 仅恢复指定的已生成图片结果；不恢复其他任务、不提交任何新的模型请求。
pub async fn resume_cover_image_result(
    storage: &Storage,
    local_results: &LocalResultService,
    command: ResumeCoverImageResultCommand,
) -> BackendResult<GenerationResultRecord> {
    if command.task_id.trim().is_empty() || command.result_index == 0 {
        return Err(BackendError::validation(
            "请指定需要恢复保存的封面结果",
            Value::Null,
        ));
    }
    let detail = storage.get_task_detail(&command.task_id)?;
    let result = select_resumable_cover_result(&detail.results, &command)?;
    local_results.resume_interrupted_result(result).await
}

fn select_resumable_cover_result(
    results: &[GenerationResultRecord],
    command: &ResumeCoverImageResultCommand,
) -> BackendResult<GenerationResultRecord> {
    let result = results
        .iter()
        .find(|result| {
            result.task_id == command.task_id && result.result_index == command.result_index
        })
        .ok_or_else(|| {
            BackendError::validation(
                "原任务没有指定的已生成封面结果，无法仅恢复保存",
                Value::Null,
            )
        })?;
    if result.media_type != MediaType::Image {
        return Err(BackendError::validation(
            "只能恢复图片类型的封面结果",
            Value::Null,
        ));
    }
    if !matches!(
        result.save_status,
        SaveStatus::Failed
            | SaveStatus::Interrupted
            | SaveStatus::LocalMissing
            | SaveStatus::Conflict
    ) {
        return Err(BackendError::validation(
            "该封面结果不处于可恢复的保存失败状态",
            json!({"saveStatus": result.save_status}),
        ));
    }
    if !matches!(
        result.source.get("kind").and_then(Value::as_str),
        Some("url" | "base64")
    ) {
        return Err(BackendError::validation(
            "原封面结果没有可恢复的图片来源，无法仅恢复保存",
            Value::Null,
        ));
    }
    Ok(result.clone())
}

#[derive(Clone)]
pub struct CoverImageService {
    downloads_directory: PathBuf,
    composer: VideoCompositionService,
}

impl CoverImageService {
    pub fn new(downloads_directory: PathBuf, composer: VideoCompositionService) -> Self {
        Self {
            downloads_directory,
            composer,
        }
    }

    pub async fn normalize(
        &self,
        command: NormalizeCoverImageCommand,
    ) -> BackendResult<NormalizedCoverImage> {
        validate_output_id(&command.output_id)?;
        let source = validate_source(&command.source_path)?;
        let ffmpeg = self.composer.ensure_ffmpeg().await?;
        let downloads = self.downloads_directory.canonicalize()?;
        let directory = downloads.join("无限画布").join("封面");
        tokio::fs::create_dir_all(&directory).await?;
        let directory = directory.canonicalize()?;
        if !directory.starts_with(&downloads) {
            return Err(BackendError::validation(
                "封面输出目录必须位于下载目录内",
                Value::Null,
            ));
        }
        // 每次输出独立文件，重试不能覆盖已完成的交付物。
        let output = directory.join(format!("{}-{}.png", command.output_id, Uuid::new_v4()));
        let result = normalize_with_ffmpeg(&ffmpeg, &source, &output).await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&output).await;
        }
        result
    }
}

fn validate_output_id(output_id: &str) -> BackendResult<()> {
    if output_id.is_empty()
        || output_id.len() > 100
        || !output_id
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'-' | b'_'))
    {
        return Err(BackendError::validation("封面输出标识无效", Value::Null));
    }
    Ok(())
}

fn validate_source(source: &str) -> BackendResult<PathBuf> {
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err(BackendError::validation(
            "封面归一化需要已保存的本地图片文件",
            Value::Null,
        ));
    }
    let path = path.canonicalize()?;
    let mut file = std::fs::File::open(&path)?;
    let size = file.metadata()?.len();
    if size == 0 {
        return Err(BackendError::validation("封面图片不能为空", Value::Null));
    }
    let mut header = [0u8; 8192];
    let read = file.read(&mut header)?;
    let valid_type = infer::get(&header[..read]).is_some_and(|kind| {
        matches!(
            kind.mime_type(),
            "image/png"
                | "image/jpeg"
                | "image/webp"
                | "image/bmp"
                | "image/tiff"
                | "image/gif"
                | "image/avif"
                | "image/heic"
                | "image/heif"
        )
    });
    if !valid_type {
        return Err(BackendError::validation(
            "封面来源不是受支持的真实图片文件",
            Value::Null,
        ));
    }
    Ok(path)
}

async fn normalize_with_ffmpeg(
    ffmpeg: &Path,
    source: &Path,
    output: &Path,
) -> BackendResult<NormalizedCoverImage> {
    let mut process = tokio::process::Command::new(ffmpeg);
    process
        .args([
            "-nostdin",
            "-n",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
        ])
        .arg("-i")
        .arg(source)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            COVER_FILTER,
            "-threads",
            "2",
            "-f",
            "image2",
            "-c:v",
            "png",
            "-pix_fmt",
            "rgb24",
            "-map_metadata",
            "-1",
        ])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(0x0800_0000);
    let result = tokio::time::timeout(Duration::from_secs(90), process.output())
        .await
        .map_err(|_| BackendError::protocol("封面尺寸处理超时，请重试当前步骤", Value::Null))??;
    if !result.status.success() {
        return Err(BackendError::protocol(
            "封面尺寸处理失败",
            json!({"source": String::from_utf8_lossy(&result.stderr).chars().take(2000).collect::<String>()}),
        ));
    }
    let (width, height) = verify_cover_png(output)?;
    Ok(NormalizedCoverImage {
        path: output.to_string_lossy().into_owned(),
        width,
        height,
    })
}

fn verify_cover_png(output: &Path) -> BackendResult<(u32, u32)> {
    let mut file = std::fs::File::open(output)?;
    if file.metadata()?.len() > MAX_COVER_PNG_BYTES {
        return Err(BackendError::protocol(
            "封面PNG超过视觉检查允许的5MiB容量",
            Value::Null,
        ));
    }
    let mut header = [0u8; 29];
    file.read_exact(&mut header)?;
    if header[..8] != *b"\x89PNG\r\n\x1a\n" || header[12..16] != *b"IHDR" {
        return Err(BackendError::protocol(
            "封面交付物不是有效PNG图片",
            Value::Null,
        ));
    }
    let width = u32::from_be_bytes(header[16..20].try_into().expect("fixed PNG width"));
    let height = u32::from_be_bytes(header[20..24].try_into().expect("fixed PNG height"));
    if width != COVER_WIDTH || height != COVER_HEIGHT {
        return Err(BackendError::protocol(
            "封面交付物尺寸不是1080×1440",
            json!({"width": width, "height": height}),
        ));
    }
    // IHDR位深和颜色类型直接来自实际文件，防止16位或RGBA输出突破审核载荷预算。
    if header[24..29] != [8, 2, 0, 0, 0] {
        return Err(BackendError::protocol(
            "封面交付物必须为8位RGB PNG图片",
            Value::Null,
        ));
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_id_rejects_paths_and_windows_streams() {
        for invalid in [
            "",
            "../result",
            "C:\\cover",
            "cover:stream",
            "a/b",
            "a\\b",
            "..",
            "封面",
        ] {
            assert!(validate_output_id(invalid).is_err(), "{invalid}");
        }
        assert!(validate_output_id(&"a".repeat(101)).is_err());
        assert!(validate_output_id("cover-run_123-456").is_ok());
    }

    #[test]
    fn input_requires_real_local_image_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("pretend.png");
        std::fs::write(&source, "file 'https://invalid.test/image'").unwrap();
        assert!(validate_source(source.to_str().unwrap()).is_err());
        assert!(validate_source("relative.png").is_err());
        assert!(validate_source("https://invalid.test/image.png").is_err());
        assert!(validate_source(temp.path().to_str().unwrap()).is_err());
        std::fs::write(&source, []).unwrap();
        assert!(validate_source(source.to_str().unwrap()).is_err());
    }

    #[test]
    fn input_accepts_image_larger_than_former_source_byte_limit() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("large.png");
        std::fs::write(&source, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(100 * 1024 * 1024 + 1)
            .unwrap();

        assert_eq!(
            validate_source(source.to_str().unwrap()).unwrap(),
            source.canonicalize().unwrap()
        );
    }

    #[test]
    fn output_dimensions_are_checked_from_png_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend_from_slice(&1080u32.to_be_bytes());
        header.extend_from_slice(&1440u32.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        std::fs::write(&source, &header).unwrap();
        assert_eq!(verify_cover_png(&source).unwrap(), (1080, 1440));
        header[20..24].copy_from_slice(&1441u32.to_be_bytes());
        std::fs::write(&source, &header).unwrap();
        assert!(verify_cover_png(&source).is_err());
        header[12] = b'X';
        std::fs::write(&source, &header).unwrap();
        assert!(verify_cover_png(&source).is_err());
    }

    #[test]
    fn cover_output_rejects_large_or_high_bit_depth_pngs() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("image.png");
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend_from_slice(&1080u32.to_be_bytes());
        header.extend_from_slice(&1440u32.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        for (bit_depth, color_type) in [(16, 2), (8, 6), (16, 6)] {
            header[24] = bit_depth;
            header[25] = color_type;
            std::fs::write(&source, &header).unwrap();
            assert!(verify_cover_png(&source).is_err());
        }
        header[24] = 8;
        header[25] = 2;
        std::fs::write(&source, &header).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(MAX_COVER_PNG_BYTES + 1)
            .unwrap();
        assert!(verify_cover_png(&source).is_err());
    }

    #[test]
    fn cover_recovery_targets_only_failed_image_results() {
        let record = GenerationResultRecord {
            task_id: "cover-task".to_string(),
            result_index: 2,
            media_type: MediaType::Image,
            remote_task_id: None,
            source: json!({"kind": "base64", "storedInRawProviderResponse": true}),
            save_status: SaveStatus::Failed,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: Some("image/png".to_string()),
            sha256: None,
            saved_at: None,
            error: Some(json!({"message": "disk full"})),
        };
        let command = ResumeCoverImageResultCommand {
            task_id: "cover-task".to_string(),
            result_index: 2,
        };
        for status in [
            SaveStatus::Failed,
            SaveStatus::Interrupted,
            SaveStatus::LocalMissing,
            SaveStatus::Conflict,
        ] {
            let mut candidate = record.clone();
            candidate.save_status = status;
            let selected = select_resumable_cover_result(&[candidate], &command).unwrap();
            assert_eq!(selected.result_index, 2);
        }
        for status in [
            SaveStatus::Pending,
            SaveStatus::Writing,
            SaveStatus::Succeeded,
        ] {
            let mut candidate = record.clone();
            candidate.save_status = status;
            assert!(select_resumable_cover_result(&[candidate], &command).is_err());
        }
        let mut candidate = record.clone();
        candidate.media_type = MediaType::Video;
        assert!(select_resumable_cover_result(&[candidate], &command).is_err());
        let mut candidate = record.clone();
        candidate.result_index = 1;
        assert!(select_resumable_cover_result(&[candidate], &command).is_err());
        let mut candidate = record;
        candidate.source = json!({"kind": "unknown"});
        assert!(select_resumable_cover_result(&[candidate], &command).is_err());
        assert!(select_resumable_cover_result(&[], &command).is_err());
    }

    #[tokio::test]
    #[ignore = "requires INFINITE_CANVAS_TEST_FFMPEG pointing at the installed project engine"]
    async fn installed_engine_preserves_whole_landscape_portrait_and_exact_cover_images() {
        let ffmpeg = PathBuf::from(std::env::var("INFINITE_CANVAS_TEST_FFMPEG").unwrap());
        let temp = tempfile::tempdir().unwrap();
        for (width, height, padded_pixel, source_format) in [
            (1920, 1080, Some((540usize, 0usize)), "rgb24"),
            (900, 1600, Some((0usize, 720usize)), "rgba"),
            (900, 1200, None, "rgb48be"),
        ] {
            let source = temp.path().join(format!("source-{width}.png"));
            let output = temp.path().join(format!("cover-{width}-{height}.png"));
            let mut fixture = tokio::process::Command::new(&ffmpeg);
            fixture
                .args(["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("color=red:s={width}x{height}:d=1"))
                .args(["-frames:v", "1", "-threads", "1", "-pix_fmt", source_format])
                .arg(&source);
            #[cfg(windows)]
            fixture.creation_flags(0x0800_0000);
            assert!(fixture.output().await.unwrap().status.success());
            let actual = normalize_with_ffmpeg(
                &ffmpeg,
                &validate_source(source.to_str().unwrap()).unwrap(),
                &output,
            )
            .await
            .unwrap();
            assert_eq!((actual.width, actual.height), (1080, 1440));
            let mut decoder = tokio::process::Command::new(&ffmpeg);
            decoder
                .args(["-nostdin", "-v", "error", "-i"])
                .arg(&output)
                .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
            #[cfg(windows)]
            decoder.creation_flags(0x0800_0000);
            let decoded = decoder.output().await.unwrap();
            assert!(decoded.status.success());
            assert_eq!(decoded.stdout.len(), 1080 * 1440 * 3);
            let pixel =
                |x: usize, y: usize| &decoded.stdout[(y * 1080 + x) * 3..(y * 1080 + x) * 3 + 3];
            let center = pixel(540, 720);
            assert!(center[0] > 240 && center[1] < 8 && center[2] < 8);
            if let Some((x, y)) = padded_pixel {
                assert_eq!(pixel(x, y), &[23, 23, 23], "image was cropped or stretched");
            } else {
                assert!(pixel(0, 0)[0] > 240);
            }
        }
    }
}
