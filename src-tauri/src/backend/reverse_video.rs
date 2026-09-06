//! Local evidence and delivery for video reverse analysis. No downloader or model provider here.
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    storage::{Storage, workflow_history::sanitize_value},
};

const MAX_SHEET_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES: usize = 14 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMetadata {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSheet {
    #[serde(flatten)]
    pub metadata: SheetMetadata,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSheet {
    #[serde(flatten)]
    pub metadata: SheetMetadata,
    pub local_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRepresentativeFrame {
    pub data_url: String,
    pub display_name: String,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepresentativeFrame {
    pub local_path: String,
    pub display_name: String,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseVideoEvidence {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub overview_frame_count: u32,
    pub tail_frame_count: u32,
    pub sheets: Vec<EvidenceSheet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub representative_frames: Vec<RepresentativeFrame>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReverseVideoEvidenceCommand {
    pub run_id: String,
    pub video_path: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub overview_frame_count: u32,
    pub tail_frame_count: u32,
    pub sheets: Vec<InputSheet>,
    #[serde(default)]
    pub representative_frames: Vec<InputRepresentativeFrame>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverReverseVideoCommand {
    pub run_id: String,
    pub source_url: String,
    pub video_path: String,
    pub title: String,
    pub markdown: String,
    pub prompt_text: String,
    pub tags: Vec<String>,
    pub analysis: BTreeMap<String, String>,
    pub evidence: Option<ReverseVideoEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseVideoDelivery {
    pub case_id: String,
    pub directory: String,
    pub video_path: String,
    pub markdown_path: String,
    pub text_path: String,
    pub case_path: String,
    pub case_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseVideoLearning {
    pub case_count: u32,
    pub summary: String,
}

#[derive(Clone)]
pub struct ReverseVideoService {
    downloads_directory: PathBuf,
    storage: Arc<Storage>,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn clean_text(value: &str) -> String {
    sanitize_value(&Value::String(value.to_string()))
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn check_video(path: &Path) -> BackendResult<PathBuf> {
    let canonical = path.canonicalize()?;
    if !canonical.is_file() || fs::metadata(&canonical)?.len() == 0 {
        return Err(invalid(
            "原视频文件不存在或为空，请在项目下载器完成下载后继续",
        ));
    }
    match canonical
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4" | "mov" | "webm" | "mkv" | "m4v" | "avi" | "ts" | "flv") => Ok(canonical),
        _ => Err(invalid("反推工作流只接受本地视频文件")),
    }
}

fn verify_destination(path: &Path, directory: &Path) -> BackendResult<()> {
    if path.parent() != Some(directory) {
        return Err(invalid("交付文件必须位于当前运行目录内"));
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !path.canonicalize()?.starts_with(directory)
        {
            return Err(invalid("交付位置不是当前运行目录中的普通文件"));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, directory: &Path, bytes: &[u8]) -> BackendResult<()> {
    verify_destination(path, directory)?;
    let temporary = directory.join(format!("{}.partial", Uuid::new_v4()));
    let result = (|| -> BackendResult<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_dimensions(duration: f64, width: u32, height: u32) -> BackendResult<()> {
    if !duration.is_finite()
        || duration <= 0.0
        || duration > 24.0 * 60.0 * 60.0
        || width == 0
        || height == 0
        || width > 32768
        || height > 32768
    {
        return Err(invalid("视频时长或尺寸无效"));
    }
    Ok(())
}

fn decode_image(data_url: &str, total: &mut usize) -> BackendResult<(&'static str, Vec<u8>)> {
    let (extension, encoded) = if let Some(value) = data_url.strip_prefix("data:image/jpeg;base64,")
    {
        ("jpg", value)
    } else if let Some(value) = data_url.strip_prefix("data:image/png;base64,") {
        ("png", value)
    } else {
        return Err(invalid("视觉证据必须是 JPEG 或 PNG 图片"));
    };
    if encoded.len() > MAX_SHEET_BYTES * 4 / 3 + 8 {
        return Err(invalid("单张视觉证据超过 4 MB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("视觉证据图片编码无效"))?;
    *total += bytes.len();
    if bytes.len() > MAX_SHEET_BYTES || *total > MAX_EVIDENCE_BYTES {
        return Err(invalid("视觉证据总大小超过 14 MB"));
    }
    if (extension == "jpg" && !bytes.starts_with(&[0xff, 0xd8, 0xff]))
        || (extension == "png" && !bytes.starts_with(b"\x89PNG\r\n\x1a\n"))
    {
        return Err(invalid("视觉证据正文与图片类型不符"));
    }
    let format = if extension == "jpg" {
        image::ImageFormat::Jpeg
    } else {
        image::ImageFormat::Png
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| invalid("视觉证据图片无法完整解码或尺寸过大"))?;
    Ok((extension, bytes))
}

impl ReverseVideoService {
    pub fn new(downloads_directory: PathBuf, storage: Arc<Storage>) -> Self {
        Self {
            downloads_directory,
            storage,
        }
    }

    fn run_directory(&self, run_id: &str) -> BackendResult<PathBuf> {
        let id = Uuid::parse_str(run_id).map_err(|_| invalid("反推运行标识必须是 UUID"))?;
        if run_id != id.hyphenated().to_string() {
            return Err(invalid("反推运行标识格式无效"));
        }
        let downloads = self.downloads_directory.canonicalize()?;
        let mut current = downloads.clone();
        for part in ["无限画布", "视频反推", run_id] {
            let next = current.join(part);
            if !next.exists() {
                fs::create_dir(&next)?;
            }
            let canonical = next.canonicalize()?;
            if canonical.parent() != Some(current.as_path())
                || !canonical.starts_with(&downloads)
                || !canonical.is_dir()
            {
                return Err(invalid("反推交付目录必须位于项目下载目录内"));
            }
            current = canonical;
        }
        Ok(current)
    }

    pub fn save_evidence(
        &self,
        command: SaveReverseVideoEvidenceCommand,
    ) -> BackendResult<ReverseVideoEvidence> {
        check_video(Path::new(&command.video_path))?;
        validate_dimensions(command.duration, command.width, command.height)?;
        if command.sheets.is_empty()
            || command.sheets.len() > 16
            || command.representative_frames.len() > 3
            || command.overview_frame_count == 0
            || command
                .overview_frame_count
                .saturating_add(command.tail_frame_count)
                < 6
            || command.tail_frame_count == 0
        {
            return Err(invalid(
                "视觉证据需至少覆盖 6 帧并包含加密尾帧，联系表最多 16 张",
            ));
        }
        let directory = self.run_directory(&command.run_id)?;
        let mut sheets = Vec::new();
        let mut total = 0;
        for (index, input) in command.sheets.into_iter().enumerate() {
            let metadata = input.metadata;
            if metadata
                .phase
                .as_deref()
                .is_some_and(|phase| !matches!(phase, "overview" | "tail"))
                || metadata
                    .first_time
                    .is_some_and(|time| !time.is_finite() || time < 0.0 || time > command.duration)
                || metadata
                    .last_time
                    .is_some_and(|time| !time.is_finite() || time < 0.0 || time > command.duration)
                || matches!((metadata.first_time, metadata.last_time), (Some(first), Some(last)) if first > last)
                || metadata.frame_count == Some(0)
            {
                return Err(invalid("联系表时间码或帧数无效"));
            }
            let (extension, bytes) = decode_image(&input.data_url, &mut total)?;
            let output = directory.join(format!("证据-{:02}.{extension}", index + 1));
            atomic_write(&output, &directory, &bytes)?;
            sheets.push(EvidenceSheet {
                metadata: SheetMetadata {
                    display_name: clean_text(&metadata.display_name),
                    ..metadata
                },
                local_path: output.to_string_lossy().into_owned(),
            });
        }
        let mut representative_frames = Vec::new();
        for (index, frame) in command.representative_frames.into_iter().enumerate() {
            if !frame.time.is_finite() || frame.time < 0.0 || frame.time > command.duration {
                return Err(invalid("代表帧时间码无效"));
            }
            let (extension, bytes) = decode_image(&frame.data_url, &mut total)?;
            let output = directory.join(format!("关键帧-{:02}.{extension}", index + 1));
            atomic_write(&output, &directory, &bytes)?;
            representative_frames.push(RepresentativeFrame {
                local_path: output.to_string_lossy().into_owned(),
                display_name: clean_text(&frame.display_name),
                time: frame.time,
            });
        }
        let evidence = ReverseVideoEvidence {
            duration: command.duration,
            width: command.width,
            height: command.height,
            overview_frame_count: command.overview_frame_count,
            tail_frame_count: command.tail_frame_count,
            sheets,
            representative_frames,
        };
        atomic_write(
            &directory.join("视觉证据.json"),
            &directory,
            &serde_json::to_vec_pretty(&evidence)?,
        )?;
        Ok(evidence)
    }

    pub fn deliver(
        &self,
        command: DeliverReverseVideoCommand,
    ) -> BackendResult<ReverseVideoDelivery> {
        if command.title.trim().is_empty()
            || command.markdown.trim().is_empty()
            || command.prompt_text.trim().is_empty()
        {
            return Err(invalid(
                "交付必须包含标题、完整 Markdown 和独立的纯文本提示词",
            ));
        }
        if command.markdown.len() > 4 * 1024 * 1024
            || command.prompt_text.len() > 2 * 1024 * 1024
            || command.tags.len() > 32
            || command.tags.iter().any(|tag| tag.len() > 256)
            || command.analysis.len() > 32
            || serde_json::to_vec(&command.analysis)?.len() > 256 * 1024
            || command.title.len() > 1024
        {
            return Err(invalid("反推交付文本超过允许大小"));
        }
        if !command.source_url.is_empty() {
            let source = url::Url::parse(&command.source_url)?;
            if !matches!(source.scheme(), "http" | "https") {
                return Err(invalid("视频来源须为 HTTP(S) 链接"));
            }
        }
        let directory = self.run_directory(&command.run_id)?;
        let source = check_video(Path::new(&command.video_path))?;
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("mp4")
            .to_ascii_lowercase();
        let video = directory.join(format!("原视频.{extension}"));
        verify_destination(&video, &directory)?;
        if source != video
            && (!video.is_file() || fs::metadata(&video)?.len() != fs::metadata(&source)?.len())
        {
            let temporary = directory.join(format!("{}.partial", Uuid::new_v4()));
            let result = (|| -> BackendResult<()> {
                fs::copy(&source, &temporary)?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(&temporary)?
                    .sync_all()?;
                fs::rename(&temporary, &video)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }
        if let Some(evidence) = &command.evidence {
            validate_dimensions(evidence.duration, evidence.width, evidence.height)?;
            for sheet in &evidence.sheets {
                let path = Path::new(&sheet.local_path).canonicalize()?;
                if path.parent() != Some(directory.as_path()) || !path.is_file() {
                    return Err(invalid("视觉证据必须来自本次反推运行目录"));
                }
            }
            for frame in &evidence.representative_frames {
                let path = Path::new(&frame.local_path).canonicalize()?;
                if path.parent() != Some(directory.as_path()) || !path.is_file() {
                    return Err(invalid("代表帧必须来自本次反推运行目录"));
                }
            }
        }
        let markdown = directory.join("反推提示词.md");
        let text = directory.join("反推提示词.txt");
        let case_path = directory.join("case.json");
        let record = sanitize_value(&json!({
            "id": command.run_id, "title": command.title, "sourceUrl": command.source_url,
            "videoPath": video.to_string_lossy(), "markdownPath": markdown.to_string_lossy(),
            "textPath": text.to_string_lossy(), "tags": command.tags, "analysis": command.analysis,
            "evidence": command.evidence,
        }));
        atomic_write(
            &markdown,
            &directory,
            clean_text(&command.markdown).as_bytes(),
        )?;
        atomic_write(
            &text,
            &directory,
            clean_text(&command.prompt_text).as_bytes(),
        )?;
        atomic_write(&case_path, &directory, &serde_json::to_vec_pretty(&record)?)?;
        let case_count = self
            .storage
            .save_reverse_video_case(&command.run_id, &record)?;
        Ok(ReverseVideoDelivery {
            case_id: command.run_id,
            directory: directory.to_string_lossy().into_owned(),
            video_path: video.to_string_lossy().into_owned(),
            markdown_path: markdown.to_string_lossy().into_owned(),
            text_path: text.to_string_lossy().into_owned(),
            case_path: case_path.to_string_lossy().into_owned(),
            case_count,
        })
    }

    pub fn get_learning(&self) -> BackendResult<ReverseVideoLearning> {
        let cases = self.storage.reverse_video_cases()?;
        if cases.is_empty() {
            return Ok(ReverseVideoLearning {
                case_count: 0,
                summary: "当前尚无已完成的本地反推案例。只依据本次真实画面分析，不使用预置案例。"
                    .into(),
            });
        }
        let mut counts: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
        let mut duration = 0.0;
        let mut measured = 0;
        let mut portrait = 0;
        for case in &cases {
            if let Some(value) = case.pointer("/evidence/duration").and_then(Value::as_f64) {
                duration += value;
                measured += 1;
            }
            if case
                .pointer("/evidence/height")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > case
                    .pointer("/evidence/width")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            {
                portrait += 1;
            }
            for tag in case
                .get("tags")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                *counts
                    .entry("标签".into())
                    .or_default()
                    .entry(tag.to_string())
                    .or_default() += 1;
            }
            for field in ["scene", "camera", "color", "structure", "hook"] {
                if let Some(value) = case
                    .get("analysis")
                    .and_then(|analysis| analysis.get(field))
                    .and_then(Value::as_str)
                {
                    if !value.trim().is_empty() {
                        *counts
                            .entry(field.into())
                            .or_default()
                            .entry(value.chars().take(300).collect())
                            .or_default() += 1;
                    }
                }
            }
        }
        let mut summary = format!(
            "本机已完成案例：{}。竖屏案例：{}。这些是观察样本的频率统计，不代表热度、平台推荐规则或因果验证。",
            cases.len(),
            portrait
        );
        if measured > 0 {
            summary.push_str(&format!(
                "平均时长：{:.1} 秒。",
                duration / f64::from(measured)
            ));
        }
        for (dimension, values) in counts {
            let mut values: Vec<_> = values.into_iter().collect();
            values.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            summary.push_str(&format!(
                "\n{dimension}：{}",
                values
                    .into_iter()
                    .take(5)
                    .map(|(value, count)| format!("{value}（{count}）"))
                    .collect::<Vec<_>>()
                    .join("；")
            ));
        }
        Ok(ReverseVideoLearning {
            case_count: cases.len().try_into().unwrap_or(u32::MAX),
            summary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, ReverseVideoService, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::open(&temporary.path().join("cases.sqlite3")).unwrap());
        let source = temporary.path().join("source.mp4");
        fs::write(&source, b"fixture video bytes").unwrap();
        let service = ReverseVideoService::new(temporary.path().to_path_buf(), storage);
        (temporary, service, source)
    }

    fn png_data_url() -> String {
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(20, 20)
            .write_to(&mut buffer, image::ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(buffer.into_inner())
        )
    }

    fn evidence_command(source: &Path, run_id: &str) -> SaveReverseVideoEvidenceCommand {
        SaveReverseVideoEvidenceCommand {
            run_id: run_id.into(),
            video_path: source.to_string_lossy().into_owned(),
            duration: 19.3,
            width: 720,
            height: 1280,
            overview_frame_count: 39,
            tail_frame_count: 31,
            sheets: vec![InputSheet {
                metadata: SheetMetadata {
                    display_name: "全片 0–19.3 秒".into(),
                    phase: Some("overview".into()),
                    first_time: Some(0.0),
                    last_time: Some(19.3),
                    frame_count: Some(39),
                },
                data_url: png_data_url(),
            }],
            representative_frames: vec![InputRepresentativeFrame {
                display_name: "结尾定格".into(),
                time: 19.3,
                data_url: png_data_url(),
            }],
        }
    }

    fn delivery_command(source: &Path, run_id: &str) -> DeliverReverseVideoCommand {
        DeliverReverseVideoCommand {
            run_id: run_id.into(),
            source_url: "https://example.test/video/1?token=private-secret".into(),
            video_path: source.to_string_lossy().into_owned(),
            title: "真实片段".into(),
            markdown: "# 完整分析\n末尾动作\n\n纯提示词另存。".into(),
            prompt_text: "人物向右行走，末尾停下，声音待听觉确认。".into(),
            tags: vec!["跟拍".into(), "竖屏".into()],
            analysis: BTreeMap::from([
                ("scene".into(), "石壁".into()),
                ("camera".into(), "跟拍".into()),
                ("apiKey".into(), "secret-credential".into()),
            ]),
            evidence: None,
        }
    }

    #[test]
    fn reverse_video_delivery_writes_four_files_and_sqlite_retry_is_idempotent() {
        let (temporary, service, source) = setup();
        assert_eq!(service.get_learning().unwrap().case_count, 0);
        let id = Uuid::new_v4().to_string();
        let evidence = service
            .save_evidence(evidence_command(&source, &id))
            .unwrap();
        assert_eq!(evidence.representative_frames.len(), 1);
        assert!(Path::new(&evidence.representative_frames[0].local_path).is_file());
        let mut command = delivery_command(&source, &id);
        command.evidence = Some(evidence);
        let first = service.deliver(command.clone()).unwrap();
        assert_eq!(first.case_count, 1);
        assert_eq!(
            fs::read(&first.video_path).unwrap(),
            fs::read(&source).unwrap()
        );
        assert_eq!(
            fs::read_to_string(&first.text_path).unwrap(),
            command.prompt_text
        );
        assert_eq!(
            fs::read_to_string(&first.markdown_path).unwrap(),
            command.markdown
        );
        let case = fs::read_to_string(&first.case_path).unwrap();
        assert!(!case.contains("private-secret"));
        assert!(!case.contains("secret-credential"));
        assert!(!case.contains("base64"));
        let again = service.deliver(command).unwrap();
        assert_eq!(again.case_count, 1);
        assert_eq!(again.case_id, first.case_id);
        assert_eq!(again.directory, first.directory);
        drop(service);
        let reopened = ReverseVideoService::new(
            temporary.path().to_path_buf(),
            Arc::new(Storage::open(&temporary.path().join("cases.sqlite3")).unwrap()),
        );
        let learning = reopened.get_learning().unwrap();
        assert_eq!(learning.case_count, 1);
        assert!(learning.summary.contains("19.3"));
        assert!(learning.summary.contains("跟拍（1）"));
        assert!(learning.summary.contains("不代表热度"));
    }

    #[test]
    fn reverse_video_failed_delivery_is_not_learned_and_can_retry_existing_files() {
        let (_temporary, service, source) = setup();
        let id = Uuid::new_v4().to_string();
        let directory = service.run_directory(&id).unwrap();
        fs::create_dir(directory.join("反推提示词.txt")).unwrap();
        let command = delivery_command(&source, &id);
        assert!(service.deliver(command.clone()).is_err());
        assert!(directory.join("原视频.mp4").is_file());
        assert_eq!(service.get_learning().unwrap().case_count, 0);
        fs::remove_dir(directory.join("反推提示词.txt")).unwrap();
        assert_eq!(service.deliver(command).unwrap().case_count, 1);
    }

    #[test]
    fn reverse_video_rejects_traversal_and_foreign_evidence() {
        let (_temporary, service, source) = setup();
        for id in ["../outside", "C:\\outside", "run-123", ""] {
            assert!(
                service
                    .save_evidence(evidence_command(&source, id))
                    .is_err()
            );
            assert!(service.deliver(delivery_command(&source, id)).is_err());
        }
        let first_id = Uuid::new_v4().to_string();
        let second_id = Uuid::new_v4().to_string();
        let evidence = service
            .save_evidence(evidence_command(&source, &first_id))
            .unwrap();
        let mut second = delivery_command(&source, &second_id);
        second.evidence = Some(evidence);
        assert!(service.deliver(second).is_err());
        assert_eq!(service.get_learning().unwrap().case_count, 0);
    }

    #[test]
    fn reverse_video_rejects_forged_image_invalid_time_and_empty_plain_prompt() {
        let (_temporary, service, source) = setup();
        let id = Uuid::new_v4().to_string();
        let mut forged = evidence_command(&source, &id);
        forged.sheets[0].data_url = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\ntruncated")
        );
        assert!(service.save_evidence(forged).is_err());
        let mut reversed = evidence_command(&source, &id);
        reversed.sheets[0].metadata.first_time = Some(20.0);
        assert!(service.save_evidence(reversed).is_err());
        let mut delivery = delivery_command(&source, &id);
        delivery.prompt_text.clear();
        assert!(service.deliver(delivery).is_err());
        assert_eq!(service.get_learning().unwrap().case_count, 0);
    }

    #[test]
    fn reverse_video_statistics_only_include_committed_real_cases() {
        let (_temporary, service, source) = setup();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        service
            .save_evidence(evidence_command(&source, &first))
            .unwrap();
        assert_eq!(service.get_learning().unwrap().case_count, 0);
        service.deliver(delivery_command(&source, &first)).unwrap();
        service.deliver(delivery_command(&source, &second)).unwrap();
        let learning = service.get_learning().unwrap();
        assert_eq!(learning.case_count, 2);
        assert!(learning.summary.contains("跟拍（2）"));
        assert!(!learning.summary.contains("7671479773969339249"));
    }

    #[test]
    fn reverse_video_short_clip_counts_both_overview_and_tail_evidence() {
        let (_temporary, service, source) = setup();
        let id = Uuid::new_v4().to_string();
        let mut command = evidence_command(&source, &id);
        command.duration = 2.0;
        command.overview_frame_count = 5;
        command.tail_frame_count = 13;
        command.sheets[0].metadata.last_time = Some(2.0);
        command.sheets[0].metadata.frame_count = Some(5);
        command.representative_frames[0].time = 2.0;
        let evidence = service.save_evidence(command).unwrap();
        assert_eq!(evidence.duration, 2.0);
        assert_eq!(evidence.overview_frame_count, 5);
        assert_eq!(evidence.tail_frame_count, 13);
    }
}
