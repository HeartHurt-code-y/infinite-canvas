//! Local shot analysis and annotated review export.
//!
//! The source video stays on the user's machine. All media work uses the
//! application's existing FFmpeg engine; no script runtime or browser binary
//! is launched by this module.

use std::{
    collections::BTreeMap,
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use image::{Rgb, RgbImage, imageops};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Emitter as _, Manager as _};
use tokio::process::Command;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
};

const TRACK_HZ: u32 = 5;
const SHEET_COLUMNS: usize = 4;
const SHEET_CAPACITY: usize = 24;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchSourceIdentity {
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchVideoMeta {
    pub duration_seconds: f64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchCastMember {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchShot {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub seconds: f64,
    pub motion: Option<f64>,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub camera: String,
    #[serde(default = "default_transition")]
    pub transition_in: String,
    #[serde(default)]
    pub subjects: Vec<String>,
    #[serde(default)]
    pub frame: String,
    #[serde(default)]
    pub onscreen_text: String,
    #[serde(default)]
    pub audio: String,
    #[serde(default)]
    pub rhythm: String,
    #[serde(default)]
    pub rhythm_note: String,
    #[serde(default)]
    pub note: String,
    pub frame_a_path: String,
    pub frame_b_path: String,
}

fn default_transition() -> String {
    "cut".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchSheet {
    pub from_id: String,
    pub to_id: String,
    pub shot_ids: Vec<String>,
    pub frame_a_path: String,
    pub frame_b_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchShotDraft {
    pub run_id: String,
    pub video_path: String,
    pub output_dir: String,
    pub source_identity: ReelbenchSourceIdentity,
    pub meta: ReelbenchVideoMeta,
    pub scene_threshold: f64,
    pub min_shot_seconds: f64,
    pub seed_cuts: Vec<f64>,
    #[serde(default)]
    pub manual_cuts: Vec<f64>,
    #[serde(default)]
    pub cast: Vec<ReelbenchCastMember>,
    pub track_path: String,
    #[serde(default)]
    pub sheets: Vec<ReelbenchSheet>,
    pub shots: Vec<ReelbenchShot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeReelbenchCommand {
    pub video_path: String,
    pub run_id: String,
    #[serde(default)]
    pub scene_threshold: Option<f64>,
    #[serde(default)]
    pub min_shot_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecutReelbenchCommand {
    pub draft: ReelbenchShotDraft,
    #[serde(default)]
    pub split_cuts: Vec<f64>,
    #[serde(default)]
    pub merge_cuts: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReelbenchProgress<'a> {
    run_id: &'a str,
    phase: &'a str,
    current: usize,
    total: usize,
}

fn progress(app: &AppHandle, run_id: &str, phase: &str, current: usize, total: usize) {
    let _ = app.emit(
        "reelbench-progress",
        ReelbenchProgress {
            run_id,
            phase,
            current,
            total,
        },
    );
}

fn validation_error(message: impl Into<String>) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn round2(number: f64) -> f64 {
    (number * 100.0).round() / 100.0
}

fn safe_run_dir(app: &AppHandle, run_id: &str) -> BackendResult<PathBuf> {
    if run_id.is_empty()
        || run_id.len() > 80
        || !run_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(validation_error(
            "拉片运行 ID 只能使用字母、数字、短横线和下划线",
        ));
    }
    let base = app.path().app_local_data_dir()?.join("shot-analysis");
    fs::create_dir_all(&base)?;
    let base = fs::canonicalize(base)?;
    let child = base.join(run_id);
    fs::create_dir_all(&child)?;
    let child = fs::canonicalize(child)?;
    if child.parent() != Some(base.as_path()) {
        return Err(validation_error("拉片目录不能指向应用数据目录之外"));
    }
    Ok(child)
}

fn source_identity(path: &Path) -> BackendResult<ReelbenchSourceIdentity> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(validation_error("请选择本机视频文件"));
    }
    let modified_unix_ms = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(ReelbenchSourceIdentity {
        size_bytes: meta.len(),
        modified_unix_ms,
        sha256: String::new(),
    })
}

fn content_hash(path: &Path) -> BackendResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn content_hash_async(path: PathBuf) -> BackendResult<String> {
    tokio::task::spawn_blocking(move || content_hash(&path))
        .await
        .map_err(|error| BackendError::Conflict(format!("视频内容校验任务失败：{error}")))?
}

fn verify_draft(app: &AppHandle, draft: &ReelbenchShotDraft) -> BackendResult<PathBuf> {
    let expected = safe_run_dir(app, &draft.run_id)?;
    let supplied = fs::canonicalize(&draft.output_dir)?;
    if supplied != expected {
        return Err(validation_error("拉片工作目录与本次运行身份不一致"));
    }
    let video = fs::canonicalize(&draft.video_path)?;
    let current_identity = source_identity(&video)?;
    if current_identity.size_bytes != draft.source_identity.size_bytes
        || current_identity.modified_unix_ms != draft.source_identity.modified_unix_ms
    {
        return Err(BackendError::Conflict(
            "原视频已修改，请重新拆镜以更新镜头时间和关键帧".into(),
        ));
    }
    if fs::canonicalize(expected.join("track.json"))? != fs::canonicalize(&draft.track_path)? {
        return Err(validation_error("运动曲线路径与本次运行不一致"));
    }
    Ok(expected)
}

async fn verify_hash(draft: &ReelbenchShotDraft) -> BackendResult<()> {
    if draft.source_identity.sha256.len() != 64
        || content_hash_async(PathBuf::from(&draft.video_path)).await?
            != draft.source_identity.sha256
    {
        return Err(BackendError::Conflict(
            "原视频内容已变化，请重新拆镜以更新证据".into(),
        ));
    }
    Ok(())
}

fn command_failure(stage: &str, output: &std::process::Output) -> BackendError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr
        .chars()
        .rev()
        .take(1400)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    BackendError::protocol(
        format!("{stage}失败"),
        json!({ "exitCode": output.status.code(), "stderr": tail }),
    )
}

fn local_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

async fn run_program(
    program: &Path,
    args: &[String],
    stage: &str,
) -> BackendResult<std::process::Output> {
    let mut command = local_command(program);
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(3600), command.output())
        .await
        .map_err(|_| BackendError::protocol(format!("{stage}超时"), Value::Null))??;
    if !output.status.success() {
        return Err(command_failure(stage, &output));
    }
    Ok(output)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Deserialize)]
struct ProbeJson {
    format: Option<ProbeFormat>,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
}

async fn probe_video(ffmpeg: &Path, video: &Path) -> BackendResult<ReelbenchVideoMeta> {
    let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    if ffprobe.is_file() {
        let output = run_program(
            &ffprobe,
            &[
                "-v".into(),
                "error".into(),
                "-of".into(),
                "json".into(),
                "-show_entries".into(),
                "format=duration:stream=codec_type,width,height,r_frame_rate".into(),
                path_text(video),
            ],
            "读取视频信息",
        )
        .await?;
        let value: ProbeJson = serde_json::from_slice(&output.stdout)?;
        let stream = value
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .ok_or_else(|| validation_error("文件没有视频流"))?;
        let fps = stream
            .r_frame_rate
            .as_deref()
            .and_then(|fraction| {
                let (numerator, denominator) = fraction.split_once('/')?;
                let denominator = denominator.parse::<f64>().ok()?;
                (denominator > 0.0)
                    .then(|| {
                        numerator
                            .parse::<f64>()
                            .ok()
                            .map(|value| value / denominator)
                    })
                    .flatten()
            })
            .unwrap_or(0.0);
        let meta = ReelbenchVideoMeta {
            duration_seconds: round2(
                value
                    .format
                    .and_then(|format| format.duration)
                    .and_then(|duration| duration.parse::<f64>().ok())
                    .unwrap_or(0.0),
            ),
            fps: round2(fps),
            width: stream.width.unwrap_or(0),
            height: stream.height.unwrap_or(0),
            has_audio: value
                .streams
                .iter()
                .any(|stream| stream.codec_type.as_deref() == Some("audio")),
        };
        if meta.duration_seconds > 0.0 && meta.width > 0 && meta.height > 0 {
            return Ok(meta);
        }
    }
    // Some app engine packages omit ffprobe. The FFmpeg stream header is the
    // local fallback, so this workflow still needs only the installed engine.
    let mut command = local_command(ffmpeg);
    command
        .args(["-hide_banner", "-i"])
        .arg(video)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| BackendError::protocol("读取视频信息超时", Value::Null))??;
    let header = String::from_utf8_lossy(&output.stderr);
    let duration = Regex::new(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
        .expect("duration regex")
        .captures(&header)
        .and_then(|caps| {
            Some(
                caps[1].parse::<f64>().ok()? * 3600.0
                    + caps[2].parse::<f64>().ok()? * 60.0
                    + caps[3].parse::<f64>().ok()?,
            )
        })
        .unwrap_or(0.0);
    let video_line = header
        .lines()
        .find(|line| line.contains(" Video: "))
        .ok_or_else(|| validation_error("文件没有可解码的视频流"))?;
    let dimensions = Regex::new(r"\b(\d{2,5})x(\d{2,5})\b")
        .expect("dimensions regex")
        .captures(video_line)
        .ok_or_else(|| validation_error("无法读取视频分辨率"))?;
    let fps = Regex::new(r"\b(\d+(?:\.\d+)?)\s+fps\b")
        .expect("fps regex")
        .captures(video_line)
        .and_then(|caps| caps[1].parse::<f64>().ok())
        .unwrap_or(0.0);
    if duration <= 0.0 {
        return Err(validation_error("无法读取视频时长"));
    }
    Ok(ReelbenchVideoMeta {
        duration_seconds: round2(duration),
        fps: round2(fps),
        width: dimensions[1].parse().unwrap_or(0),
        height: dimensions[2].parse().unwrap_or(0),
        has_audio: header.lines().any(|line| line.contains(" Audio: ")),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MotionTrack {
    hz: u32,
    values: Vec<f64>,
}

async fn detect_scene_cuts(ffmpeg: &Path, video: &Path, threshold: f64) -> BackendResult<Vec<f64>> {
    let output = run_program(
        ffmpeg,
        &[
            "-v".into(),
            "error".into(),
            "-i".into(),
            path_text(video),
            "-an".into(),
            "-vf".into(),
            format!("scale=320:-2,select='gt(scene,{threshold:.3})',metadata=print:file=-"),
            "-f".into(),
            "null".into(),
            "-".into(),
        ],
        "检测镜头切点",
    )
    .await?;
    let times = Regex::new(r"pts_time:([0-9]+(?:\.[0-9]+)?)").expect("timestamp regex");
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(times
        .captures_iter(&stdout)
        .filter_map(|caps| caps[1].parse::<f64>().ok())
        .map(round2)
        .collect())
}

async fn measure_motion(ffmpeg: &Path, video: &Path) -> BackendResult<MotionTrack> {
    let output = run_program(
        ffmpeg,
        &[
            "-v".into(), "error".into(), "-i".into(), path_text(video),
            "-an".into(), "-vf".into(),
            format!("fps={TRACK_HZ},scale=64:36,tblend=all_mode=difference,signalstats,metadata=print:file=-:key=lavfi.signalstats.YAVG"),
            "-f".into(), "null".into(), "-".into(),
        ],
        "测量画面运动",
    )
    .await?;
    let values =
        Regex::new(r"lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)").expect("motion regex");
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(MotionTrack {
        hz: TRACK_HZ,
        values: values
            .captures_iter(&stdout)
            .filter_map(|caps| caps[1].parse::<f64>().ok())
            .map(round2)
            .collect(),
    })
}

fn motion_in(track: &MotionTrack, start: f64, end: f64) -> Option<f64> {
    if track.hz == 0 || end <= start || track.values.is_empty() {
        return None;
    }
    let inset = ((end - start) * 0.15).clamp(0.1, 0.4);
    let first = ((start + inset) * f64::from(track.hz)).ceil().max(0.0) as usize;
    let last = (((end - inset) * f64::from(track.hz)).floor().max(0.0) as usize)
        .min(track.values.len() - 1);
    let mut values = track
        .values
        .get(first..=last)?
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(round2(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }))
}

fn normalized_bounds(cuts: &[f64], duration: f64, minimum: f64) -> Vec<f64> {
    let mut sorted = cuts
        .iter()
        .copied()
        .filter(|cut| cut.is_finite() && *cut > 0.0 && *cut < duration)
        .map(round2)
        .collect::<Vec<_>>();
    sorted.sort_by(f64::total_cmp);
    sorted.dedup_by(|left, right| (*left - *right).abs() < 0.01);
    let mut bounds = vec![0.0];
    for cut in sorted {
        if cut - bounds[bounds.len() - 1] >= minimum {
            bounds.push(cut);
        }
    }
    if bounds.len() > 1 && duration - bounds[bounds.len() - 1] < minimum {
        bounds.pop();
    }
    bounds.push(duration);
    bounds
}

fn shots_from_bounds(bounds: &[f64], track: &MotionTrack, output_dir: &Path) -> Vec<ReelbenchShot> {
    bounds
        .windows(2)
        .enumerate()
        .map(|(index, range)| {
            let id = format!("S{:02}", index + 1);
            ReelbenchShot {
                id: id.clone(),
                start: range[0],
                end: range[1],
                seconds: round2(range[1] - range[0]),
                motion: motion_in(track, range[0], range[1]),
                size: String::new(),
                category: String::new(),
                camera: String::new(),
                transition_in: default_transition(),
                subjects: vec![],
                frame: String::new(),
                onscreen_text: String::new(),
                audio: String::new(),
                rhythm: String::new(),
                rhythm_note: String::new(),
                note: String::new(),
                frame_a_path: path_text(&output_dir.join("frames").join(format!("{id}a.jpg"))),
                frame_b_path: path_text(&output_dir.join("frames").join(format!("{id}b.jpg"))),
            }
        })
        .collect()
}

async fn extract_frames(
    app: &AppHandle,
    ffmpeg: &Path,
    draft: &ReelbenchShotDraft,
) -> BackendResult<()> {
    fs::create_dir_all(Path::new(&draft.output_dir).join("frames"))?;
    let video = Path::new(&draft.video_path);
    let total = draft.shots.len() * 2;
    for (index, shot) in draft.shots.iter().enumerate() {
        for (offset, path) in [
            (0.15, shot.frame_a_path.as_str()),
            (0.85, shot.frame_b_path.as_str()),
        ] {
            let at = shot.start + shot.seconds * offset;
            run_program(
                ffmpeg,
                &[
                    "-v".into(),
                    "error".into(),
                    "-y".into(),
                    "-ss".into(),
                    format!("{at:.3}"),
                    "-i".into(),
                    path_text(video),
                    "-frames:v".into(),
                    "1".into(),
                    "-q:v".into(),
                    "3".into(),
                    path.into(),
                ],
                "抽取镜头关键帧",
            )
            .await?;
            if !Path::new(path).is_file() {
                return Err(BackendError::protocol(
                    "抽帧命令结束但没有产生关键帧",
                    json!({ "shotId": shot.id, "time": at }),
                ));
            }
            progress(
                app,
                &draft.run_id,
                "frames",
                index * 2 + if offset < 0.5 { 1 } else { 2 },
                total,
            );
        }
    }
    Ok(())
}

fn glyph(character: char) -> [u8; 7] {
    match character {
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
        ],
        _ => [0; 7],
    }
}

fn draw_shot_id(canvas: &mut RgbImage, left: u32, top: u32, id: &str) {
    let width = (id.chars().count() as u32 * 12 + 8).min(108);
    for y in top..(top + 20).min(canvas.height()) {
        for x in left..(left + width).min(canvas.width()) {
            canvas.put_pixel(x, y, Rgb([4, 11, 16]));
        }
    }
    for (index, character) in id.chars().take(8).enumerate() {
        for (row, bits) in glyph(character).iter().enumerate() {
            for column in 0..5u32 {
                if (*bits & (1u8 << (4 - column))) == 0 {
                    continue;
                }
                for dy in 0..2u32 {
                    for dx in 0..2u32 {
                        canvas.put_pixel(
                            left + 4 + index as u32 * 12 + column * 2 + dx,
                            top + 3 + row as u32 * 2 + dy,
                            Rgb([221, 242, 213]),
                        );
                    }
                }
            }
        }
    }
}

fn compose_sheet(paths: &[(&str, &str)], target: &Path) -> BackendResult<()> {
    let rows = paths.len().div_ceil(SHEET_COLUMNS);
    let cell_width = 320u32;
    let cell_height = 180u32;
    let gap = 8u32;
    let width = SHEET_COLUMNS as u32 * cell_width + (SHEET_COLUMNS as u32 + 1) * gap;
    let height = rows as u32 * cell_height + (rows as u32 + 1) * gap;
    let mut canvas = RgbImage::from_pixel(width, height, Rgb([21, 27, 33]));
    for (index, (path, id)) in paths.iter().enumerate() {
        let source = image::open(path).map_err(|error| {
            BackendError::protocol(
                "读取关键帧失败",
                json!({"path":path,"error":error.to_string()}),
            )
        })?;
        let thumb = source.thumbnail(cell_width, cell_height).to_rgb8();
        let column = (index % SHEET_COLUMNS) as u32;
        let row = (index / SHEET_COLUMNS) as u32;
        let cell_x = gap + column * (cell_width + gap);
        let cell_y = gap + row * (cell_height + gap);
        let x = cell_x + (cell_width - thumb.width()) / 2;
        let y = cell_y + (cell_height - thumb.height()) / 2;
        imageops::overlay(&mut canvas, &thumb, i64::from(x), i64::from(y));
        draw_shot_id(&mut canvas, cell_x + 4, cell_y + 4, id);
    }
    canvas.save(target).map_err(|error| {
        BackendError::protocol("保存镜头联系表失败", json!({"error":error.to_string()}))
    })
}

fn write_sheets(draft: &mut ReelbenchShotDraft) -> BackendResult<()> {
    let directory = Path::new(&draft.output_dir).join("sheets");
    fs::create_dir_all(&directory)?;
    let mut sheets = Vec::new();
    for (index, shots) in draft.shots.chunks(SHEET_CAPACITY).enumerate() {
        let a = directory.join(format!("sheet-{:03}-a.jpg", index + 1));
        let b = directory.join(format!("sheet-{:03}-b.jpg", index + 1));
        compose_sheet(
            &shots
                .iter()
                .map(|shot| (shot.frame_a_path.as_str(), shot.id.as_str()))
                .collect::<Vec<_>>(),
            &a,
        )?;
        compose_sheet(
            &shots
                .iter()
                .map(|shot| (shot.frame_b_path.as_str(), shot.id.as_str()))
                .collect::<Vec<_>>(),
            &b,
        )?;
        sheets.push(ReelbenchSheet {
            from_id: shots
                .first()
                .map(|shot| shot.id.clone())
                .unwrap_or_default(),
            to_id: shots.last().map(|shot| shot.id.clone()).unwrap_or_default(),
            shot_ids: shots.iter().map(|shot| shot.id.clone()).collect(),
            frame_a_path: path_text(&a),
            frame_b_path: path_text(&b),
        });
    }
    draft.sheets = sheets;
    Ok(())
}

fn save_draft(draft: &ReelbenchShotDraft) -> BackendResult<()> {
    fs::write(
        Path::new(&draft.output_dir).join("shots.json"),
        serde_json::to_vec_pretty(draft)?,
    )?;
    Ok(())
}

pub async fn analyze(
    app: &AppHandle,
    composer: &VideoCompositionService,
    command: AnalyzeReelbenchCommand,
) -> BackendResult<ReelbenchShotDraft> {
    let threshold = command.scene_threshold.unwrap_or(0.3);
    let minimum = command.min_shot_seconds.unwrap_or(0.3);
    if !threshold.is_finite() || !(0.01..=0.95).contains(&threshold) {
        return Err(validation_error("场景检测阈值应在 0.01 到 0.95 之间"));
    }
    if !minimum.is_finite() || !(0.05..=10.0).contains(&minimum) {
        return Err(validation_error("最短镜头时长应在 0.05 到 10 秒之间"));
    }
    let video = fs::canonicalize(&command.video_path)?;
    let mut identity = source_identity(&video)?;
    identity.sha256 = content_hash_async(video.clone()).await?;
    let output = safe_run_dir(app, &command.run_id)?;
    let ffmpeg = composer.ensure_ffmpeg().await?;
    progress(app, &command.run_id, "probe", 0, 1);
    let meta = probe_video(&ffmpeg, &video).await?;
    progress(app, &command.run_id, "probe", 1, 1);
    progress(app, &command.run_id, "cuts", 0, 1);
    let cuts = detect_scene_cuts(&ffmpeg, &video, threshold).await?;
    progress(app, &command.run_id, "cuts", 1, 1);
    progress(app, &command.run_id, "motion", 0, 1);
    let track = measure_motion(&ffmpeg, &video).await?;
    progress(app, &command.run_id, "motion", 1, 1);
    let track_path = output.join("track.json");
    fs::write(&track_path, serde_json::to_vec(&track)?)?;
    let bounds = normalized_bounds(&cuts, meta.duration_seconds, minimum);
    let mut draft = ReelbenchShotDraft {
        run_id: command.run_id,
        video_path: path_text(&video),
        output_dir: path_text(&output),
        source_identity: identity,
        meta,
        scene_threshold: threshold,
        min_shot_seconds: minimum,
        seed_cuts: cuts,
        manual_cuts: vec![],
        cast: vec![],
        track_path: path_text(&track_path),
        sheets: vec![],
        shots: shots_from_bounds(&bounds, &track, &output),
    };
    extract_frames(app, &ffmpeg, &draft).await?;
    progress(app, &draft.run_id, "sheets", 0, 1);
    write_sheets(&mut draft)?;
    progress(app, &draft.run_id, "sheets", 1, 1);
    verify_hash(&draft).await?;
    save_draft(&draft)?;
    Ok(draft)
}

fn copied_annotations(target: &mut ReelbenchShot, source: &ReelbenchShot) {
    target.size = source.size.clone();
    target.category = source.category.clone();
    target.camera = source.camera.clone();
    target.transition_in = source.transition_in.clone();
    target.subjects = source.subjects.clone();
    target.frame = source.frame.clone();
    target.onscreen_text = source.onscreen_text.clone();
    target.audio = source.audio.clone();
    target.rhythm = source.rhythm.clone();
    target.rhythm_note = source.rhythm_note.clone();
    target.note = source.note.clone();
}

pub async fn recut(
    app: &AppHandle,
    composer: &VideoCompositionService,
    command: RecutReelbenchCommand,
) -> BackendResult<ReelbenchShotDraft> {
    let mut draft = command.draft;
    let directory = verify_draft(app, &draft)?;
    verify_hash(&draft).await?;
    if command.split_cuts.is_empty() && command.merge_cuts.is_empty() {
        return Ok(draft);
    }
    let track: MotionTrack = serde_json::from_slice(&fs::read(directory.join("track.json"))?)?;
    let mut bounds = vec![0.0];
    for (index, shot) in draft.shots.iter().enumerate() {
        if (shot.start - *bounds.last().unwrap_or(&0.0)).abs() > 0.02
            || shot.end <= shot.start
            || shot.id != format!("S{:02}", index + 1)
        {
            return Err(validation_error("镜头时间轴已损坏，无法补刀或并刀"));
        }
        bounds.push(shot.end);
    }
    if (bounds.last().unwrap_or(&0.0) - draft.meta.duration_seconds).abs() > 0.25 {
        return Err(validation_error("镜头尾点与原片时长不一致"));
    }
    for cut in &command.merge_cuts {
        if !cut.is_finite() {
            return Err(validation_error("并刀时间必须是有效秒数"));
        }
        let Some(position) = (1..bounds.len().saturating_sub(1))
            .find(|position| (bounds[*position] - cut).abs() <= 0.05)
        else {
            return Err(validation_error(format!(
                "{cut:.2} 秒处没有可合并的镜头边界"
            )));
        };
        bounds.remove(position);
    }
    for cut in &command.split_cuts {
        if !cut.is_finite() || *cut <= 0.0 || *cut >= draft.meta.duration_seconds {
            return Err(validation_error("补刀时间必须位于视频内部"));
        }
        let cut = round2(*cut);
        if bounds.iter().any(|existing| (existing - cut).abs() < 0.05) {
            return Err(validation_error(format!("{cut:.2} 秒处已有镜头边界")));
        }
        bounds.push(cut);
        bounds.sort_by(f64::total_cmp);
    }
    if bounds.windows(2).any(|pair| pair[1] - pair[0] < 0.05) {
        return Err(validation_error("补刀会产生短于 0.05 秒的镜头"));
    }
    let previous = draft
        .shots
        .iter()
        .map(|shot| ((shot.start * 100.0) as i64, (shot.end * 100.0) as i64))
        .zip(draft.shots.iter())
        .collect::<BTreeMap<_, _>>();
    let mut new_shots = shots_from_bounds(&bounds, &track, &directory);
    for shot in &mut new_shots {
        let key = ((shot.start * 100.0) as i64, (shot.end * 100.0) as i64);
        if let Some(old) = previous.get(&key) {
            copied_annotations(shot, old);
        } else {
            shot.note = "镜头边界已调整，请重新核对画面并填写标注".into();
        }
    }
    draft
        .manual_cuts
        .retain(|cut| bounds.iter().any(|bound| (bound - cut).abs() < 0.02));
    for cut in command.split_cuts {
        let cut = round2(cut);
        if !draft
            .manual_cuts
            .iter()
            .any(|existing| (existing - cut).abs() < 0.02)
        {
            draft.manual_cuts.push(cut);
        }
    }
    draft.manual_cuts.sort_by(f64::total_cmp);
    draft.shots = new_shots;
    let ffmpeg = composer.ensure_ffmpeg().await?;
    extract_frames(app, &ffmpeg, &draft).await?;
    progress(app, &draft.run_id, "sheets", 0, 1);
    write_sheets(&mut draft)?;
    progress(app, &draft.run_id, "sheets", 1, 1);
    verify_hash(&draft).await?;
    save_draft(&draft)?;
    Ok(draft)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchGate {
    pub id: String,
    pub ok: bool,
    pub skipped: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchValidation {
    pub ok: bool,
    pub gates: Vec<ReelbenchGate>,
    pub hints: Vec<String>,
}

const SHOT_SIZES: &[&str] = &[
    "none",
    "extreme-wide",
    "wide",
    "medium-wide",
    "medium",
    "medium-close",
    "close",
    "extreme-close",
];
const SHOT_CATEGORIES: &[&str] = &[
    "establishing",
    "subject",
    "dialogue",
    "reaction",
    "insert",
    "pov",
    "empty",
    "product",
    "text-card",
    "transition",
    "archive",
];
const CAMERA_MOVES: &[&str] = &[
    "static",
    "push-in",
    "pull-out",
    "zoom-in",
    "zoom-out",
    "pan-left",
    "pan-right",
    "tilt-up",
    "tilt-down",
    "truck-left",
    "truck-right",
    "pedestal-up",
    "pedestal-down",
    "tracking",
    "arc",
    "whip-pan",
    "handheld",
    "shake",
    "rack-focus",
    "micro-push",
    "roll",
    "drone",
];
const STRONG_MOVES: &[&str] = &[
    "push-in",
    "pull-out",
    "zoom-in",
    "zoom-out",
    "pan-left",
    "pan-right",
    "tilt-up",
    "tilt-down",
    "truck-left",
    "truck-right",
    "pedestal-up",
    "pedestal-down",
    "tracking",
    "arc",
    "whip-pan",
    "shake",
    "roll",
    "drone",
];
const TRANSITIONS: &[&str] = &[
    "cut",
    "dissolve",
    "fade-in",
    "fade-out",
    "whip",
    "match-cut",
    "wipe",
    "morph",
];
const RHYTHM_ROLES: &[&str] = &[
    "hook", "setup", "build", "beat", "turn", "payoff", "breath", "close",
];

fn gate(id: &str, issues: Vec<String>) -> ReelbenchGate {
    ReelbenchGate {
        id: id.into(),
        ok: issues.is_empty(),
        skipped: false,
        issues,
    }
}

fn contains_cjk(text: &str) -> bool {
    text.chars()
        .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
}

fn enough_text(text: &str, chinese_chars: usize, english_words: usize) -> bool {
    if contains_cjk(text) {
        text.chars()
            .filter(|character| !character.is_whitespace())
            .count()
            >= chinese_chars
    } else {
        text.split_whitespace().count() >= english_words
    }
}

fn generic_description(text: &str) -> bool {
    let trimmed = text.trim().to_lowercase();
    [
        "这个镜头",
        "画面呈现",
        "氛围感",
        "非常震撼",
        "引人入胜",
        "this shot",
        "the scene shows",
        "visually stunning",
        "cinematic feel",
    ]
    .iter()
    .any(|phrase| trimmed.contains(phrase))
}

fn validate_data(draft: &ReelbenchShotDraft, track: Option<&MotionTrack>) -> ReelbenchValidation {
    let mut gates = Vec::with_capacity(15);
    let mut hints = Vec::new();
    let shots = &draft.shots;
    let total = draft.meta.duration_seconds;

    let mut issues = Vec::new();
    if shots.is_empty() {
        issues.push("没有镜头".into());
    }
    for (index, shot) in shots.iter().enumerate() {
        if !shot.start.is_finite() || !shot.end.is_finite() || shot.end <= shot.start {
            issues.push(format!("{} 的起止时间无效", shot.id));
            continue;
        }
        if index == 0 && shot.start.abs() > 0.05 {
            issues.push(format!("首镜应从 0 秒开始，当前为 {:.2} 秒", shot.start));
        }
        if index > 0 && (shot.start - shots[index - 1].end).abs() > 0.05 {
            issues.push(format!("{} 与上一镜之间有空隙或重叠", shot.id));
        }
    }
    if let Some(last) = shots.last() {
        if (last.end - total).abs() > 0.25 {
            issues.push(format!(
                "末镜结束点 {:.2} 秒与原片 {:.2} 秒不符",
                last.end, total
            ));
        }
    }
    gates.push(gate("timeline", issues));

    let mut issues = Vec::new();
    for shot in shots {
        if !shot.seconds.is_finite() || (shot.seconds - round2(shot.end - shot.start)).abs() > 0.011
        {
            issues.push(format!("{} 的时长与起止时间不符", shot.id));
        }
        if shot.seconds > 0.0
            && shot.seconds < draft.min_shot_seconds
            && shot.note.trim().is_empty()
        {
            issues.push(format!("{} 短于最短镜头阈值，请说明是否为闪切", shot.id));
        }
    }
    gates.push(gate("duration", issues));

    gates.push(gate(
        "numbering",
        shots
            .iter()
            .enumerate()
            .filter_map(|(index, shot)| {
                let expected = format!("S{:02}", index + 1);
                (shot.id != expected).then(|| format!("第 {} 镜应编号为 {expected}", index + 1))
            })
            .collect(),
    ));

    for (id, field, vocabulary) in [
        ("size", 0, SHOT_SIZES),
        ("category", 1, SHOT_CATEGORIES),
        ("camera", 2, CAMERA_MOVES),
    ] {
        let issues = shots
            .iter()
            .filter_map(|shot| {
                let value = match field {
                    0 => &shot.size,
                    1 => &shot.category,
                    _ => &shot.camera,
                };
                (!vocabulary.contains(&value.as_str()))
                    .then(|| format!("{} 的 {id} 未填写或不在词表中", shot.id))
            })
            .collect();
        gates.push(gate(id, issues));
    }

    gates.push(gate(
        "transition",
        shots
            .iter()
            .filter_map(|shot| {
                (!shot.transition_in.is_empty()
                    && !TRANSITIONS.contains(&shot.transition_in.as_str()))
                .then(|| format!("{} 的转场类型不在词表中", shot.id))
            })
            .collect(),
    ));

    let mut issues = Vec::new();
    for shot in shots {
        if !enough_text(&shot.frame, 12, 8) {
            issues.push(format!("{} 的画面描述过短或为空", shot.id));
        }
        if generic_description(&shot.frame) {
            issues.push(format!(
                "{} 的画面描述包含空话，请写可核对的视觉事实",
                shot.id
            ));
        }
    }
    gates.push(gate("frame-text", issues));

    let mut descriptions = std::collections::HashSet::new();
    gates.push(gate(
        "dedup",
        shots
            .iter()
            .filter_map(|shot| {
                let text = shot.frame.trim();
                (!text.is_empty() && !descriptions.insert(text.to_string()))
                    .then(|| format!("{} 的画面描述与另一镜完全相同", shot.id))
            })
            .collect(),
    ));

    let cast_ids = draft
        .cast
        .iter()
        .map(|member| member.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut issues = Vec::new();
    for shot in shots {
        for subject in &shot.subjects {
            if !cast_ids.contains(subject.as_str()) {
                issues.push(format!("{} 引用了未登记的人物 {subject}", shot.id));
            }
        }
    }
    gates.push(gate("subjects", issues));

    let mut issues = Vec::new();
    for shot in shots {
        match shot.category.as_str() {
            "dialogue" if shot.audio.trim().is_empty() => {
                issues.push(format!("{} 标为对话但没有台词或声音证据", shot.id))
            }
            "text-card" if shot.onscreen_text.trim().is_empty() => {
                issues.push(format!("{} 标为字卡但没有画面文字", shot.id))
            }
            "reaction" if shot.subjects.is_empty() => {
                issues.push(format!("{} 标为反应但没有人物", shot.id))
            }
            "empty" if !shot.subjects.is_empty() => {
                issues.push(format!("{} 标为空镜但填写了人物", shot.id))
            }
            _ => {}
        }
    }
    gates.push(gate("category-evidence", issues));

    if let Some(track) = track {
        let mut issues = Vec::new();
        for shot in shots {
            let measured = motion_in(track, shot.start, shot.end);
            if let (Some(recomputed), Some(stored)) = (measured, shot.motion) {
                if (recomputed - stored).abs() > 0.05 {
                    issues.push(format!("{} 的运动量与本机测量记录不符", shot.id));
                }
            }
            if let Some(value) = measured {
                if shot.seconds >= 1.0
                    && STRONG_MOVES.contains(&shot.camera.as_str())
                    && value < 1.5
                {
                    issues.push(format!(
                        "{} 标为明显运镜，但实测运动量只有 {:.2}",
                        shot.id, value
                    ));
                }
                if shot.camera == "static" && value > 12.0 {
                    hints.push(format!(
                        "{} 标为固定机位但画面变化较大，请核对是否为主体运动",
                        shot.id
                    ));
                }
            }
        }
        gates.push(gate("motion", issues));
    } else {
        gates.push(ReelbenchGate {
            id: "motion".into(),
            ok: false,
            skipped: true,
            issues: vec!["运动曲线缺失".into()],
        });
    }

    let permitted = draft
        .seed_cuts
        .iter()
        .chain(draft.manual_cuts.iter())
        .copied()
        .collect::<Vec<_>>();
    gates.push(gate(
        "boundary",
        shots
            .iter()
            .skip(1)
            .filter_map(|shot| {
                (!permitted.iter().any(|cut| (cut - shot.start).abs() <= 0.1)).then(|| {
                    format!(
                        "{} 的起点 {:.2} 秒不在检测或人工补刀记录中",
                        shot.id, shot.start
                    )
                })
            })
            .collect(),
    ));

    let frame_dir = Path::new(&draft.output_dir).join("frames");
    let mut issues = Vec::new();
    for shot in shots {
        for (actual, suffix) in [(&shot.frame_a_path, "a"), (&shot.frame_b_path, "b")] {
            let expected = frame_dir.join(format!("{}{suffix}.jpg", shot.id));
            if Path::new(actual) != expected || !expected.is_file() {
                issues.push(format!("{} 缺少或错误引用 {} 关键帧", shot.id, suffix));
            }
        }
    }
    gates.push(gate("frames", issues));

    let tagged = shots
        .iter()
        .filter(|shot| !shot.rhythm.trim().is_empty())
        .count();
    let mut issues = Vec::new();
    if tagged > 0 && tagged != shots.len() {
        issues.push(format!(
            "节奏只标注了 {tagged}/{} 镜，应全部标注或全部留空",
            shots.len()
        ));
    }
    for shot in shots {
        if shot.rhythm.is_empty() {
            continue;
        }
        if !RHYTHM_ROLES.contains(&shot.rhythm.as_str()) {
            issues.push(format!("{} 的节奏角色不在词表中", shot.id));
        }
        if !enough_text(&shot.rhythm_note, 8, 5) || generic_description(&shot.rhythm_note) {
            issues.push(format!("{} 的节奏理由不够具体", shot.id));
        }
    }
    gates.push(gate("rhythm", issues));

    if tagged == shots.len() && tagged > 0 {
        if !shots
            .iter()
            .any(|shot| shot.start < 5.0 && shot.rhythm == "hook")
        {
            hints.push("开篇 5 秒未标出钩子，请确认是否符合创作意图".into());
        }
        if let Some(first_payoff) = shots.iter().position(|shot| shot.rhythm == "payoff") {
            if !shots[..first_payoff]
                .iter()
                .any(|shot| shot.rhythm == "setup" || shot.rhythm == "build")
            {
                hints.push(format!("{} 的兑现前没有铺垫或递进", shots[first_payoff].id));
            }
        }
        for window in shots.windows(6) {
            if window.iter().all(|shot| shot.rhythm == window[0].rhythm) {
                hints.push(format!(
                    "{} 到 {} 连续六镜同一节奏角色",
                    window[0].id, window[5].id
                ));
                break;
            }
        }
    }

    ReelbenchValidation {
        ok: gates.iter().all(|gate| gate.ok && !gate.skipped),
        gates,
        hints,
    }
}

pub async fn validate(
    app: &AppHandle,
    draft: &ReelbenchShotDraft,
) -> BackendResult<ReelbenchValidation> {
    let directory = verify_draft(app, draft)?;
    verify_hash(draft).await?;
    let track: MotionTrack = serde_json::from_slice(&fs::read(directory.join("track.json"))?)?;
    Ok(validate_data(draft, Some(&track)))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReelbenchVideoCommand {
    pub draft: ReelbenchShotDraft,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub lang: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReelbenchVideoExport {
    pub video_path: String,
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
}

fn even(number: f64) -> u32 {
    ((number.round() as u32).max(2) / 2) * 2
}

fn layout(meta: &ReelbenchVideoMeta, scale: f64) -> (u32, u32, u32, u32) {
    if meta.height > meta.width {
        let video_height = even((f64::from(meta.height) * scale).min(1080.0));
        let video_width =
            even(f64::from(video_height) * f64::from(meta.width) / f64::from(meta.height));
        let panel_width = even((f64::from(video_width) * 1.6).max(260.0));
        (video_width, video_height, panel_width, video_height)
    } else {
        let video_width = even((f64::from(meta.width) * scale).min(1920.0));
        let video_height =
            even(f64::from(video_width) * f64::from(meta.height) / f64::from(meta.width));
        let panel_height = even((f64::from(video_height) * 0.8).max(260.0));
        (video_width, video_height, video_width, panel_height)
    }
}

fn ass_time(seconds: f64) -> String {
    let centiseconds = (seconds.max(0.0) * 100.0).round() as u64;
    let hours = centiseconds / 360_000;
    let minutes = centiseconds / 6_000 % 60;
    let seconds = centiseconds / 100 % 60;
    let hundredths = centiseconds % 100;
    format!("{hours}:{minutes:02}:{seconds:02}.{hundredths:02}")
}

fn ass_escape(value: &str) -> String {
    value
        .chars()
        .take(2_000)
        .map(|character| match character {
            '\\' => '／',
            '{' => '（',
            '}' => '）',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect()
}

fn wrap_panel_text(value: &str, max_units: usize, max_lines: usize) -> String {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut units = 0;
    let mut truncated = false;
    for character in value.trim().chars() {
        let width = if contains_cjk(&character.to_string()) {
            2
        } else {
            1
        };
        if units + width > max_units && !line.is_empty() {
            lines.push(line);
            line = String::new();
            units = 0;
            if lines.len() >= max_lines {
                truncated = true;
                break;
            }
        }
        line.push(character);
        units += width;
    }
    if !line.is_empty() && lines.len() < max_lines {
        lines.push(line);
    }
    if truncated {
        if let Some(last) = lines.last_mut() {
            last.push('…');
        }
    }
    lines.join("\\N")
}

fn label<'a>(key: &'a str, lang: &str) -> &'a str {
    if lang == "en" {
        return key;
    }
    match key {
        "none" => "无景别",
        "extreme-wide" => "大远景",
        "wide" => "全景",
        "medium-wide" => "中远景",
        "medium" => "中景",
        "medium-close" => "中近景",
        "close" => "特写",
        "extreme-close" => "大特写",
        "establishing" => "定场",
        "subject" => "主体",
        "dialogue" => "对话",
        "reaction" => "反应",
        "insert" => "插入特写",
        "pov" => "主观",
        "empty" => "空镜",
        "product" => "产品展示",
        "text-card" => "字卡",
        "transition" => "转场",
        "archive" => "引用素材",
        "static" => "固定",
        "push-in" => "推",
        "pull-out" => "拉",
        "zoom-in" => "变焦推",
        "zoom-out" => "变焦拉",
        "pan-left" => "左摇",
        "pan-right" => "右摇",
        "tilt-up" => "上摇",
        "tilt-down" => "下摇",
        "truck-left" => "左移",
        "truck-right" => "右移",
        "pedestal-up" => "升",
        "pedestal-down" => "降",
        "tracking" => "跟拍",
        "arc" => "环绕",
        "whip-pan" => "甩镜",
        "handheld" => "手持微晃",
        "shake" => "剧烈晃动",
        "rack-focus" => "变焦点",
        "micro-push" => "微推",
        "roll" => "旋转",
        "drone" => "航拍",
        "hook" => "钩子",
        "setup" => "铺垫",
        "build" => "递进",
        "beat" => "重音",
        "turn" => "转折",
        "payoff" => "兑现",
        "breath" => "换气",
        _ => key,
    }
}

fn rhythm_label<'a>(key: &'a str, lang: &str) -> &'a str {
    if key == "close" && lang != "en" {
        "收口"
    } else {
        label(key, lang)
    }
}

fn ass_dialogue(start: f64, end: f64, style: &str, text: &str) -> String {
    format!(
        "Dialogue: 0,{},{},{style},,0,0,0,,{}\n",
        ass_time(start),
        ass_time(end),
        text,
    )
}

fn panel_ass(draft: &ReelbenchShotDraft, width: u32, height: u32, lang: &str) -> String {
    let font = if cfg!(windows) {
        "Microsoft YaHei"
    } else if cfg!(target_os = "macos") {
        "PingFang SC"
    } else {
        "Noto Sans CJK SC"
    };
    let scale = (f64::from(width.min(height)) / 600.0).clamp(0.55, 2.0);
    let base = (23.0 * scale).round() as u32;
    let title = (30.0 * scale).round() as u32;
    let small = (18.0 * scale).round() as u32;
    let margin = (f64::from(width) * 0.04).round().clamp(14.0, 64.0) as u32;
    let max_units = (((width - margin * 2) as f64 / f64::from(base)) * 2.0).max(18.0) as usize;
    let total = draft.meta.duration_seconds;
    let title_text = if lang == "en" {
        "SHOT REVIEW"
    } else {
        "镜头分析"
    };
    let meta_size = if lang == "en" { "SIZE" } else { "景别" };
    let meta_category = if lang == "en" { "TYPE" } else { "类别" };
    let meta_camera = if lang == "en" { "CAMERA" } else { "运镜" };
    let mut ass = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Header,{font},{title},&H00C8EAA6,&H00C8EAA6,&H00131A1F,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Main,{font},{base},&H00F2F5EE,&H00F2F5EE,&H00131A1F,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Muted,{font},{small},&H00AEBBB1,&H00AEBBB1,&H00131A1F,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Active,{font},{small},&H00D0F39D,&H00D0F39D,&H00131A1F,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
    );
    ass.push_str(&ass_dialogue(
        0.0,
        total,
        "Header",
        &format!(
            "{{\\an7\\pos({margin},{})}}{title_text}",
            (height as f64 * 0.05) as u32
        ),
    ));
    let line_y = (height as f64 * 0.18) as u32;
    let labels_y = (height as f64 * 0.29) as u32;
    let frame_y = (height as f64 * 0.40) as u32;
    let extra_y = (height as f64 * 0.60) as u32;
    let list_y = (height as f64 * 0.76) as u32;
    for (index, shot) in draft.shots.iter().enumerate() {
        let lead = format!(
            "{} / {}   {} - {}   {:.2}s",
            shot.id,
            draft.shots.len(),
            ass_time(shot.start),
            ass_time(shot.end),
            shot.seconds,
        );
        ass.push_str(&ass_dialogue(
            shot.start,
            shot.end,
            "Header",
            &format!("{{\\an7\\pos({margin},{line_y})}}{lead}"),
        ));
        let labels = format!(
            "{meta_size}  {}     {meta_category}  {}     {meta_camera}  {}",
            label(&shot.size, lang),
            label(&shot.category, lang),
            label(&shot.camera, lang),
        );
        ass.push_str(&ass_dialogue(
            shot.start,
            shot.end,
            "Muted",
            &format!("{{\\an7\\pos({margin},{labels_y})}}{}", ass_escape(&labels)),
        ));
        let description = wrap_panel_text(&ass_escape(&shot.frame), max_units, 3);
        ass.push_str(&ass_dialogue(
            shot.start,
            shot.end,
            "Main",
            &format!("{{\\an7\\pos({margin},{frame_y})}}{description}"),
        ));
        let extra = if !shot.audio.trim().is_empty() {
            if lang == "en" {
                format!("AUDIO  {}", shot.audio)
            } else {
                format!("声音  {}", shot.audio)
            }
        } else if !shot.onscreen_text.trim().is_empty() {
            if lang == "en" {
                format!("TEXT  {}", shot.onscreen_text)
            } else {
                format!("画中文字  {}", shot.onscreen_text)
            }
        } else {
            format!(
                "{}  {}",
                if lang == "en" { "RHYTHM" } else { "节奏" },
                rhythm_label(&shot.rhythm, lang)
            )
        };
        ass.push_str(&ass_dialogue(
            shot.start,
            shot.end,
            "Muted",
            &format!(
                "{{\\an7\\pos({margin},{extra_y})}}{}",
                wrap_panel_text(&ass_escape(&extra), max_units, 1)
            ),
        ));
        // Three neighboring rows enter at a cut and settle after 450 ms. The
        // current row uses a separate style so the active shot remains clear.
        for (relative, offset) in [(-1isize, 0.0), (0, 0.055), (1, 0.11)] {
            let item = index as isize + relative;
            if item < 0 || item >= draft.shots.len() as isize {
                continue;
            }
            let nearby = &draft.shots[item as usize];
            let y = list_y + (f64::from(height) * offset) as u32;
            let row = format!(
                "{}   {} - {}   {}",
                nearby.id,
                ass_time(nearby.start),
                ass_time(nearby.end),
                wrap_panel_text(&ass_escape(&nearby.frame), max_units / 2, 1)
            );
            let style = if relative == 0 { "Active" } else { "Muted" };
            ass.push_str(&ass_dialogue(
                shot.start,
                shot.end,
                style,
                &format!(
                    "{{\\an7\\move({margin},{},{margin},{y},0,450)}}{row}",
                    y + 12
                ),
            ));
        }
    }
    let bar_y = (height as f64 * 0.955) as u32;
    let bar_width = width.saturating_sub(2 * margin);
    let bar_shape = format!(
        "{{\\an7\\pos({margin},{bar_y})\\p1\\c&H455049&}}m 0 0 l {bar_width} 0 {bar_width} 4 0 4{{\\p0}}"
    );
    ass.push_str(&ass_dialogue(0.0, total, "Muted", &bar_shape));
    let playhead = format!(
        "{{\\an7\\move({margin},{},{},{},0,{})\\p1\\c&H9DF3D0&}}m 0 0 l 5 0 5 15 0 15{{\\p0}}",
        bar_y.saturating_sub(6),
        margin + bar_width.saturating_sub(5),
        bar_y.saturating_sub(6),
        (total * 1000.0).round() as u64
    );
    ass.push_str(&ass_dialogue(0.0, total, "Active", &playhead));
    ass
}

fn composition_filter(
    video_width: u32,
    video_height: u32,
    panel_width: u32,
    panel_height: u32,
    duration: f64,
    portrait: bool,
) -> String {
    let stack = if portrait { "hstack" } else { "vstack" };
    format!(
        "[0:v]scale={video_width}:{video_height}:flags=lanczos,setsar=1[v];color=c=0x151b21:s={panel_width}x{panel_height}:r=30:d={duration:.2},format=yuv420p,ass=review-panel.ass[p];[v][p]{stack}=inputs=2:shortest=1,format=yuv420p[out]"
    )
}

pub async fn export_video(
    app: &AppHandle,
    composer: &VideoCompositionService,
    command: ExportReelbenchVideoCommand,
) -> BackendResult<ReelbenchVideoExport> {
    let draft = command.draft;
    let directory = verify_draft(app, &draft)?;
    let validation = validate(app, &draft).await?;
    if !validation.ok {
        return Err(BackendError::validation(
            "镜头表未通过完整质量检查，不能导出带镜头信息的视频",
            json!({ "gates": validation.gates }),
        ));
    }
    let scale = command.scale.unwrap_or(1.0);
    if !scale.is_finite() || !(1.0..=3.0).contains(&scale) {
        return Err(validation_error("导出放大比例应在 1 到 3 之间"));
    }
    let lang = command.lang.as_deref().unwrap_or("zh");
    if !["zh", "en"].contains(&lang) {
        return Err(validation_error("导出语言应为 zh 或 en"));
    }
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let fresh_meta = probe_video(&ffmpeg, Path::new(&draft.video_path)).await?;
    if (fresh_meta.duration_seconds - draft.meta.duration_seconds).abs() > 0.25
        || fresh_meta.width != draft.meta.width
        || fresh_meta.height != draft.meta.height
    {
        return Err(BackendError::Conflict(
            "原视频信息已变化，请重新拆镜".into(),
        ));
    }
    let (video_width, video_height, panel_width, panel_height) = layout(&draft.meta, scale);
    let ass_file = directory.join("review-panel.ass");
    fs::write(
        &ass_file,
        panel_ass(&draft, panel_width, panel_height, lang),
    )?;
    let result = directory.join("review-sync.mp4");
    let filter = composition_filter(
        video_width,
        video_height,
        panel_width,
        panel_height,
        draft.meta.duration_seconds,
        draft.meta.height > draft.meta.width,
    );
    progress(app, &draft.run_id, "export", 0, 1);
    let mut command = local_command(&ffmpeg);
    command
        .current_dir(&directory)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&draft.video_path)
        .args([
            "-filter_complex",
            &filter,
            "-map",
            "[out]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-t",
        ])
        .arg(format!("{:.2}", draft.meta.duration_seconds))
        .arg(&result)
        .kill_on_drop(true);
    let timeout_seconds = ((draft.meta.duration_seconds * 8.0).ceil() as u64).clamp(120, 7200);
    let output = tokio::time::timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .map_err(|_| BackendError::protocol("合成镜头信息视频超时", Value::Null))??;
    if !output.status.success() {
        return Err(command_failure("合成镜头信息视频", &output));
    }
    let current_identity = source_identity(Path::new(&draft.video_path))?;
    if current_identity.size_bytes != draft.source_identity.size_bytes
        || current_identity.modified_unix_ms != draft.source_identity.modified_unix_ms
    {
        let _ = fs::remove_file(&result);
        return Err(BackendError::Conflict(
            "合成时原视频发生变化，请重新拆镜".into(),
        ));
    }
    if content_hash_async(PathBuf::from(&draft.video_path)).await? != draft.source_identity.sha256 {
        let _ = fs::remove_file(&result);
        return Err(BackendError::Conflict(
            "合成时原视频内容发生变化，请重新拆镜".into(),
        ));
    }
    let exported = probe_video(&ffmpeg, &result).await?;
    progress(app, &draft.run_id, "export", 1, 1);
    Ok(ReelbenchVideoExport {
        video_path: path_text(&result),
        width: exported.width,
        height: exported.height,
        duration_seconds: exported.duration_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_fixture(directory: &Path) -> (ReelbenchShotDraft, MotionTrack) {
        let frames = directory.join("frames");
        fs::create_dir_all(&frames).unwrap();
        fs::write(frames.join("S01a.jpg"), b"a").unwrap();
        fs::write(frames.join("S01b.jpg"), b"b").unwrap();
        let track = MotionTrack {
            hz: 5,
            values: vec![0.5; 11],
        };
        let shot = ReelbenchShot {
            id: "S01".into(),
            start: 0.0,
            end: 2.0,
            seconds: 2.0,
            motion: Some(0.5),
            size: "medium".into(),
            category: "subject".into(),
            camera: "static".into(),
            transition_in: "cut".into(),
            subjects: vec![],
            frame: "一名演员站在明亮房间中央缓慢转身面对镜头".into(),
            onscreen_text: String::new(),
            audio: String::new(),
            rhythm: String::new(),
            rhythm_note: String::new(),
            note: String::new(),
            frame_a_path: path_text(&frames.join("S01a.jpg")),
            frame_b_path: path_text(&frames.join("S01b.jpg")),
        };
        (
            ReelbenchShotDraft {
                run_id: "test".into(),
                video_path: String::new(),
                output_dir: path_text(directory),
                source_identity: ReelbenchSourceIdentity {
                    size_bytes: 1,
                    modified_unix_ms: 0,
                    sha256: "0".repeat(64),
                },
                meta: ReelbenchVideoMeta {
                    duration_seconds: 2.0,
                    fps: 30.0,
                    width: 640,
                    height: 360,
                    has_audio: false,
                },
                scene_threshold: 0.3,
                min_shot_seconds: 0.3,
                seed_cuts: vec![],
                manual_cuts: vec![],
                cast: vec![],
                track_path: path_text(&directory.join("track.json")),
                sheets: vec![],
                shots: vec![shot],
            },
            track,
        )
    }

    #[test]
    fn scene_bounds_merge_tiny_fragments_without_discarding_evidence() {
        assert_eq!(
            normalized_bounds(&[0.1, 0.45, 0.5, 1.7, 2.8], 3.0, 0.3),
            vec![0.0, 0.45, 1.7, 3.0]
        );
    }

    #[test]
    fn validation_requires_all_fifteen_gates_and_checks_machine_fields() {
        let directory = tempfile::tempdir().unwrap();
        let (mut draft, track) = valid_fixture(directory.path());
        let clean = validate_data(&draft, Some(&track));
        assert_eq!(clean.gates.len(), 15);
        assert!(clean.ok, "{clean:?}");
        draft.shots[0].seconds = 1.0;
        draft.shots[0].motion = Some(50.0);
        let broken = validate_data(&draft, Some(&track));
        assert!(!broken.ok);
        assert!(
            !broken
                .gates
                .iter()
                .find(|gate| gate.id == "duration")
                .unwrap()
                .ok
        );
        assert!(
            !broken
                .gates
                .iter()
                .find(|gate| gate.id == "motion")
                .unwrap()
                .ok
        );
    }

    #[test]
    fn ass_escapes_untrusted_annotation_and_video_layout_keeps_even_dimensions() {
        let escaped = ass_escape(r"{\move(0,0,99,99)} a\Nb\nnext");
        assert!(!escaped.chars().any(|ch| matches!(ch, '{' | '}' | '\\')));
        let wide = layout(
            &ReelbenchVideoMeta {
                duration_seconds: 2.0,
                fps: 30.0,
                width: 640,
                height: 360,
                has_audio: false,
            },
            2.0,
        );
        assert_eq!(wide, (1280, 720, 1280, 576));
        let tall = layout(
            &ReelbenchVideoMeta {
                duration_seconds: 2.0,
                fps: 30.0,
                width: 360,
                height: 640,
                has_audio: false,
            },
            1.0,
        );
        assert_eq!(tall, (360, 640, 576, 640));
    }

    #[test]
    fn content_hash_detects_equal_size_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.mp4");
        fs::write(&path, b"first").unwrap();
        let old = content_hash(&path).unwrap();
        fs::write(&path, b"other").unwrap();
        assert_ne!(old, content_hash(&path).unwrap());
    }

    #[tokio::test]
    async fn bundled_ffmpeg_smoke_composes_silent_and_audio_review_video() {
        let Some(binary) = std::env::var_os("REELBENCH_FFMPEG_BIN") else {
            return;
        };
        let ffmpeg = PathBuf::from(binary);
        let directory = tempfile::tempdir().unwrap();
        let (mut draft, _) = valid_fixture(directory.path());
        draft.meta.width = 320;
        draft.meta.height = 180;
        let (vw, vh, pw, ph) = layout(&draft.meta, 1.0);
        fs::write(
            directory.path().join("review-panel.ass"),
            panel_ass(&draft, pw, ph, "zh"),
        )
        .unwrap();
        let filter = composition_filter(vw, vh, pw, ph, 2.0, false);
        for with_audio in [false, true] {
            let source = directory.path().join(if with_audio {
                "audio-source.mp4"
            } else {
                "silent-source.mp4"
            });
            let output = directory.path().join(if with_audio {
                "audio-review.mp4"
            } else {
                "silent-review.mp4"
            });
            let mut input = vec![
                "-v".into(),
                "error".into(),
                "-y".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=30:duration=2".into(),
            ];
            if with_audio {
                input.extend([
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "sine=frequency=440:duration=2".into(),
                ]);
            }
            input.extend([
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if with_audio {
                input.extend(["-c:a".into(), "aac".into()]);
            }
            input.push(path_text(&source));
            run_program(&ffmpeg, &input, "测试样片生成").await.unwrap();
            let mut command = local_command(&ffmpeg);
            let result = command
                .current_dir(directory.path())
                .args(["-v", "error", "-y", "-i"])
                .arg(&source)
                .args([
                    "-filter_complex",
                    &filter,
                    "-map",
                    "[out]",
                    "-map",
                    "0:a?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-t",
                    "2",
                ])
                .arg(&output)
                .kill_on_drop(true)
                .output()
                .await
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let exported = probe_video(&ffmpeg, &output).await.unwrap();
            assert_eq!((exported.width, exported.height), (vw, vh + ph));
            assert_eq!(exported.has_audio, with_audio);
            assert!((exported.duration_seconds - 2.0).abs() <= 0.05);
        }

        let scene_source = directory.path().join("two-scenes.mp4");
        run_program(
            &ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-y".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=red:s=320x180:r=30:d=1".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=blue:s=320x180:r=30:d=1".into(),
                "-filter_complex".into(),
                "[0:v][1:v]concat=n=2:v=1:a=0[v]".into(),
                "-map".into(),
                "[v]".into(),
                "-c:v".into(),
                "libx264".into(),
                path_text(&scene_source),
            ],
            "切镜样片生成",
        )
        .await
        .unwrap();
        let cuts = detect_scene_cuts(&ffmpeg, &scene_source, 0.1)
            .await
            .unwrap();
        assert!(cuts.iter().any(|cut| (cut - 1.0).abs() <= 0.05), "{cuts:?}");
        let motion = measure_motion(&ffmpeg, &scene_source).await.unwrap();
        assert!(!motion.values.is_empty());
        let first = directory.path().join("first.jpg");
        let second = directory.path().join("second.jpg");
        for (at, target) in [(0.5, &first), (1.5, &second)] {
            run_program(
                &ffmpeg,
                &[
                    "-v".into(),
                    "error".into(),
                    "-y".into(),
                    "-ss".into(),
                    format!("{at:.3}"),
                    "-i".into(),
                    path_text(&scene_source),
                    "-frames:v".into(),
                    "1".into(),
                    "-q:v".into(),
                    "3".into(),
                    path_text(target),
                ],
                "关键帧样片生成",
            )
            .await
            .unwrap();
        }
        let sheet = directory.path().join("sheet.jpg");
        compose_sheet(
            &[
                (first.to_str().unwrap(), "S01"),
                (second.to_str().unwrap(), "S02"),
            ],
            &sheet,
        )
        .unwrap();
        assert_eq!(image::image_dimensions(sheet).unwrap(), (1320, 196));
    }
}
