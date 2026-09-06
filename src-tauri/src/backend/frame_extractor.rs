//! 视频抽帧：输入任意本地视频，按指定的秒数抽取关键帧图片。
//!
//! 复用视频合成服务自带的 FFmpeg 引擎（缺失时自动按需下载，与下载器共用同
//! 一套引擎）。抽出的图片默认落在系统下载目录的「无限画布/抽帧」子目录，
//! 产物作为图片资产卡片接入画布，可连入后续生成节点（图片参考）与其他工作流。
//!
//! 注意：抽帧产物是普通本地文件，不含任何账号凭据或会话信息。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::composer::VideoCompositionService;
use super::error::{BackendError, BackendResult};

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 内存中最多保留的任务数；超出后清掉已终态的最旧记录，防止长会话无界增长。
const JOB_RETAIN_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoFrameExtractionStatus {
    /// 正在准备 FFmpeg 引擎。
    PreparingEngine,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

/// 单张抽帧结果的落地信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFrame {
    /// 图片文件绝对路径（前端经 convertFileSrc 展示）。
    pub path: String,
    /// 抽取时刻（秒）。
    pub timestamp_seconds: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameExtractionJobRecord {
    pub job_id: String,
    /// 输入视频的绝对路径。
    pub video_path: String,
    pub status: VideoFrameExtractionStatus,
    /// 0-100；引擎准备阶段为 None。
    pub progress: Option<f64>,
    pub frames: Vec<ExtractedFrame>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

struct JobEntry {
    record: VideoFrameExtractionJobRecord,
    cancelled: Arc<AtomicBool>,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, JobEntry>>,
    downloads_dir: PathBuf,
    composer: VideoCompositionService,
}

/// 画布视频抽帧服务。可克隆后在异步任务中使用。
#[derive(Clone)]
pub struct VideoFrameExtractionService {
    inner: Arc<Inner>,
}

impl VideoFrameExtractionService {
    pub fn new(downloads_dir: PathBuf, composer: VideoCompositionService) -> Self {
        Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                downloads_dir,
                composer,
            }),
        }
    }

    /// 比例采样由后端在探测实际视频时长后换算，避免生成模型实际时长与计划值略有
    /// 偏差时，99% 尾帧被误判为越界。
    pub fn start_extraction_with_percentages(
        &self,
        video_path: &str,
        timestamps: Vec<f64>,
        percentages: Vec<f64>,
    ) -> BackendResult<VideoFrameExtractionJobRecord> {
        let video_path = video_path.trim();
        if video_path.is_empty() {
            return Err(BackendError::validation(
                "请先指定要抽帧的视频文件",
                Value::Null,
            ));
        }
        if !is_remote_url(video_path) && !Path::new(video_path).is_file() {
            return Err(BackendError::validation(
                "视频文件不存在",
                serde_json::json!({ "path": video_path }),
            ));
        }
        let mut timestamps: Vec<f64> = timestamps
            .into_iter()
            .filter(|timestamp| timestamp.is_finite())
            .collect();
        timestamps.sort_by(|first, second| {
            first
                .partial_cmp(second)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        timestamps.dedup_by(|first, second| (*first - *second).abs() < 0.01);
        let mut percentages: Vec<f64> = percentages
            .into_iter()
            .filter(|percentage| percentage.is_finite())
            .collect();
        percentages.sort_by(|first, second| {
            first
                .partial_cmp(second)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        percentages.dedup_by(|first, second| (*first - *second).abs() < 0.0001);
        if timestamps.is_empty() && percentages.is_empty() {
            return Err(BackendError::validation(
                "请至少填写一个抽帧秒数或比例",
                Value::Null,
            ));
        }
        if !timestamps.is_empty() && !percentages.is_empty() {
            return Err(BackendError::validation(
                "抽帧秒数与比例不能同时填写",
                Value::Null,
            ));
        }
        if timestamps.iter().any(|timestamp| *timestamp < 0.0) {
            return Err(BackendError::validation("抽帧秒数不能为负数", Value::Null));
        }
        if percentages
            .iter()
            .any(|percentage| *percentage <= 0.0 || *percentage >= 1.0)
        {
            return Err(BackendError::validation(
                "抽帧比例必须大于 0 且小于 1",
                Value::Null,
            ));
        }

        let job_id = format!("frame-extract-{}", Uuid::new_v4());
        let now = now_ms();
        let record = VideoFrameExtractionJobRecord {
            job_id: job_id.clone(),
            video_path: video_path.to_string(),
            status: VideoFrameExtractionStatus::PreparingEngine,
            progress: None,
            frames: Vec::new(),
            error: None,
            created_at: now,
            updated_at: now,
        };
        {
            let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
            retain_recent_jobs(&mut jobs);
            jobs.insert(
                job_id.clone(),
                JobEntry {
                    record: record.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let service = self.clone();
        let owned_video_path = video_path.to_string();
        tauri::async_runtime::spawn(async move {
            service
                .run_extraction(job_id, owned_video_path, timestamps, percentages)
                .await;
        });
        Ok(record)
    }

    pub fn get_job(&self, job_id: &str) -> BackendResult<VideoFrameExtractionJobRecord> {
        let jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        jobs.get(job_id)
            .map(|entry| entry.record.clone())
            .ok_or_else(|| BackendError::NotFound(format!("frame extraction job {job_id}")))
    }

    /// 请求取消。run_extraction 在逐帧间隔感知标记并提前结束。
    pub fn cancel_job(&self, job_id: &str) -> BackendResult<VideoFrameExtractionJobRecord> {
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| BackendError::NotFound(format!("frame extraction job {job_id}")))?;
        if matches!(
            entry.record.status,
            VideoFrameExtractionStatus::PreparingEngine | VideoFrameExtractionStatus::Processing
        ) {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry.record.status = VideoFrameExtractionStatus::Cancelled;
            entry.record.updated_at = now_ms();
        }
        Ok(entry.record.clone())
    }

    fn update_record(&self, job_id: &str, mutate: impl FnOnce(&mut VideoFrameExtractionJobRecord)) {
        let mut jobs = self.inner.jobs.lock().expect("frame jobs poisoned");
        if let Some(entry) = jobs.get_mut(job_id) {
            mutate(&mut entry.record);
            entry.record.updated_at = now_ms();
        }
    }

    fn set_progress(&self, job_id: &str, percent: f64) {
        self.update_record(job_id, |record| {
            let percent = percent.clamp(0.0, 99.0);
            record.progress = Some(
                record
                    .progress
                    .map_or(percent, |current| current.max(percent)),
            );
        });
    }

    fn fail_job(&self, job_id: &str, message: String) {
        self.update_record(job_id, |record| {
            record.status = VideoFrameExtractionStatus::Failed;
            record.error = Some(message);
        });
    }

    fn is_cancelled(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .expect("frame jobs poisoned")
            .get(job_id)
            .is_some_and(|entry| entry.cancelled.load(Ordering::Relaxed))
    }

    /// FFmpeg 二进制：PATH 中可用则直接用，否则复用合成服务内置引擎。
    async fn resolve_ffmpeg_binary(&self) -> Option<PathBuf> {
        if probe_ffmpeg().await {
            return Some(PathBuf::from("ffmpeg"));
        }
        self.inner.composer.ensure_ffmpeg().await.ok()
    }

    async fn run_extraction(
        &self,
        job_id: String,
        video_path: String,
        timestamps: Vec<f64>,
        percentages: Vec<f64>,
    ) {
        // 1. 确保引擎就绪。
        let ffmpeg = match self.resolve_ffmpeg_binary().await {
            Some(ffmpeg) => ffmpeg,
            None => {
                self.fail_job(&job_id, "FFmpeg 不可用，无法执行抽帧".to_string());
                return;
            }
        };
        self.update_record(&job_id, |record| {
            record.status = VideoFrameExtractionStatus::Processing;
        });

        // 2. 输出目录：系统下载目录/无限画布/抽帧。
        let out_dir = self.inner.downloads_dir.join("无限画布").join("抽帧");
        if let Err(error) = tokio::fs::create_dir_all(&out_dir).await {
            self.fail_job(&job_id, format!("创建抽帧目录失败：{error}"));
            return;
        }

        // 3. 云端/远程 http(s) 视频：先下载到本地临时文件，ffmpeg 只吃本地路径。
        //    抽取完成后删除临时文件，帧图片留在抽帧目录。
        let mut downloaded_remote: Option<PathBuf> = None;
        let local_source: PathBuf = if is_remote_url(&video_path) {
            let remote_dir = out_dir.join(".remote");
            if let Err(error) = tokio::fs::create_dir_all(&remote_dir).await {
                self.fail_job(&job_id, format!("创建远程视频临时目录失败：{error}"));
                return;
            }
            let target = remote_dir.join(format!(
                "{}-{}{}",
                remote_stem(&video_path),
                job_id.rsplit('-').next().unwrap_or("tmp"),
                remote_extension(&video_path)
            ));
            match download_remote_video(&video_path, &target).await {
                Ok(path) => {
                    downloaded_remote = Some(path.clone());
                    path
                }
                Err(error) => {
                    self.fail_job(&job_id, format!("下载远程视频失败：{error}"));
                    return;
                }
            }
        } else {
            PathBuf::from(&video_path)
        };

        // 4. 探测视频时长，校验每个抽帧秒数落在 [0, 时长) 内。
        let duration = match probe_video_duration(&ffmpeg, &local_source).await {
            Some(duration) => duration,
            None => {
                self.fail_job(
                    &job_id,
                    "无法读取视频时长，请确认该文件是有效的视频".to_string(),
                );
                return;
            }
        };
        let timestamps = if percentages.is_empty() {
            timestamps
        } else {
            percentages
                .into_iter()
                .map(|percentage| {
                    // 留出一帧安全边界；极短视频仍至少从 0.01 秒取样。
                    (duration * percentage)
                        .min((duration - 0.01).max(0.01))
                        .max(0.01)
                })
                .collect()
        };
        for timestamp in &timestamps {
            if *timestamp >= duration {
                self.fail_job(
                    &job_id,
                    format!(
                        "抽帧秒数 {} 超过视频时长 {:.1} 秒",
                        format_seconds(*timestamp),
                        duration
                    ),
                );
                return;
            }
        }

        let stem = if is_remote_url(&video_path) {
            remote_stem(&video_path)
        } else {
            video_stem(Path::new(&video_path))
        };

        // 5. 逐秒抽帧；单帧失败即终止任务并保留已产出帧。
        let mut frames: Vec<ExtractedFrame> = Vec::with_capacity(timestamps.len());
        let source_text = local_source.to_string_lossy().into_owned();
        for (index, timestamp) in timestamps.iter().enumerate() {
            if self.is_cancelled(&job_id) {
                return;
            }
            let output = out_dir.join(format!("{stem}@{}.jpg", format_seconds(*timestamp)));
            match extract_frame(&ffmpeg, &source_text, *timestamp, &output).await {
                Ok((width, height)) => {
                    frames.push(ExtractedFrame {
                        path: output.to_string_lossy().into_owned(),
                        timestamp_seconds: *timestamp,
                        width,
                        height,
                    });
                    self.update_record(&job_id, |record| {
                        record.frames = frames.clone();
                    });
                }
                Err(error) => {
                    self.fail_job(
                        &job_id,
                        format!("抽取第 {} 秒帧失败：{error}", format_seconds(*timestamp)),
                    );
                    return;
                }
            }
            self.set_progress(
                &job_id,
                ((index + 1) as f64 / timestamps.len() as f64) * 100.0,
            );
        }

        // 6. 清理远程临时文件（尽力而为，不阻断结果）。
        if let Some(remote) = downloaded_remote.take() {
            let _ = tokio::fs::remove_file(&remote).await;
        }

        self.update_record(&job_id, |record| {
            record.status = VideoFrameExtractionStatus::Completed;
            record.progress = Some(100.0);
        });
    }
}

/// PATH 中是否可直接调用 ffmpeg。
async fn probe_ffmpeg() -> bool {
    let mut command = tokio::process::Command::new("ffmpeg");
    command.arg("-version").stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

/// 用 ffmpeg 探测视频时长（秒）；解析失败返回 None。
async fn probe_video_duration(ffmpeg: &Path, source: &Path) -> Option<f64> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command.arg("-i").arg(source).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().await.ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    parse_duration(&text)
}

/// 从 ffmpeg 探测文本解析 `Duration: HH:MM:SS.xx`。
fn parse_duration(text: &str) -> Option<f64> {
    let re = Regex::new(r"Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)").ok()?;
    let captures = re.captures(text)?;
    let hours: f64 = captures.get(1)?.as_str().parse().ok()?;
    let minutes: f64 = captures.get(2)?.as_str().parse().ok()?;
    let seconds: f64 = captures.get(3)?.as_str().parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// 用 ffmpeg 从 source 的 timestamp 秒抽取 1 帧到 output（jpg，高质量）。
/// 成功返回 (宽, 高)。
async fn extract_frame(
    ffmpeg: &Path,
    source: &str,
    timestamp_seconds: f64,
    output: &Path,
) -> BackendResult<(u32, u32)> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .arg("-y")
        .arg("-ss")
        .arg(format_seconds(timestamp_seconds))
        .arg("-i")
        .arg(source)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let result = command.output().await?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(BackendError::protocol(
            "ffmpeg 抽帧失败",
            serde_json::json!({ "detail": truncate_text(&stderr, 400) }),
        ));
    }
    if !output.is_file() {
        return Err(BackendError::protocol("抽帧未生成图片文件", Value::Null));
    }
    let dimensions = parse_video_dimensions(&String::from_utf8_lossy(&result.stderr));
    Ok(dimensions.unwrap_or((0, 0)))
}

/// 从 ffmpeg 探测文本解析 `Video: ... 1920x1080 ...`。
fn parse_video_dimensions(text: &str) -> Option<(u32, u32)> {
    let re = Regex::new(r"Video:.*?(\d{2,5})x(\d{2,5})").ok()?;
    let captures = re.captures(text)?;
    let width = captures.get(1)?.as_str().parse().ok()?;
    let height = captures.get(2)?.as_str().parse().ok()?;
    Some((width, height))
}

/// 视频文件名（去掉扩展名）作为抽帧产物前缀。
fn video_stem(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "视频".to_string())
}

/// 秒数转文件名友好的字符串：整数去尾零（3 → "3"），小数保留（3.5 → "3.5"）。
fn format_seconds(seconds: f64) -> String {
    let rounded = seconds.round();
    if (seconds - rounded).abs() < f64::EPSILON * 8.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{seconds}")
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut result: String = trimmed.chars().take(max_chars).collect();
    result.push('…');
    result
}

/// 判断是否为可下载的远程 http(s) 视频地址。
fn is_remote_url(source: &str) -> bool {
    let lower = source.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 从远程 URL 提取文件名主干（去掉扩展名与查询参数），用作抽帧产物前缀。
fn remote_stem(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query.rsplit('/').next().unwrap_or("");
    let stem = match last.rfind('.') {
        Some(index) if index > 0 => &last[..index],
        _ => last,
    }
    .trim();
    if stem.is_empty() {
        "remote-video".to_string()
    } else {
        stem.to_string()
    }
}

/// 从远程 URL 提取扩展名；无扩展名或异常时回退 .mp4。
fn remote_extension(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query.rsplit('/').next().unwrap_or("");
    let ext = match last.rfind('.') {
        Some(index) if index > 0 && index + 1 < last.len() => &last[index + 1..],
        _ => "",
    }
    .trim();
    if ext.is_empty() || ext.contains('/') || ext.len() > 8 || is_remote_url(ext) {
        ".mp4".to_string()
    } else {
        format!(".{ext}")
    }
}

/// 下载远程视频到本地文件，供 ffmpeg 抽帧使用。成功返回本地路径。
async fn download_remote_video(url: &str, target: &Path) -> BackendResult<PathBuf> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|error| {
            BackendError::protocol(
                "初始化下载客户端失败",
                serde_json::json!({ "detail": error.to_string() }),
            )
        })?;
    let mut response = client.get(url).send().await.map_err(|error| {
        BackendError::protocol(
            "无法连接远程视频地址",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })?;
    if !response.status().is_success() {
        return Err(BackendError::protocol(
            "远程视频下载返回异常状态",
            serde_json::json!({ "status": response.status().as_u16(), "url": url }),
        ));
    }
    let mut file = tokio::fs::File::create(target).await.map_err(|error| {
        BackendError::protocol(
            "创建远程视频临时文件失败",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })?;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        BackendError::protocol(
            "下载远程视频中断",
            serde_json::json!({ "detail": error.to_string() }),
        )
    })? {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| {
                BackendError::protocol(
                    "写入远程视频临时文件失败",
                    serde_json::json!({ "detail": error.to_string() }),
                )
            })?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.ok();
    drop(file);
    Ok(target.to_path_buf())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 内存任务上限：超出后丢弃最旧的已终态记录。
fn retain_recent_jobs(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < JOB_RETAIN_LIMIT {
        return;
    }
    let mut terminal: Vec<(String, i64)> = jobs
        .iter()
        .filter(|(_, entry)| {
            matches!(
                entry.record.status,
                VideoFrameExtractionStatus::Completed
                    | VideoFrameExtractionStatus::Failed
                    | VideoFrameExtractionStatus::Cancelled
            )
        })
        .map(|(key, entry)| (key.clone(), entry.record.updated_at))
        .collect();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    let remove_count = jobs.len().saturating_sub(JOB_RETAIN_LIMIT - 1);
    for (key, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_duration_line() {
        assert_eq!(
            parse_duration("  Duration: 00:00:15.93, start: 0.000000, bitrate: 1234 kb/s"),
            Some(15.93)
        );
        assert_eq!(
            parse_duration("Duration: 01:02:03.50, start: 0.000000"),
            Some(3723.5)
        );
    }

    #[test]
    fn parses_video_dimensions_from_probe_text() {
        assert_eq!(
            parse_video_dimensions("Stream #0:0: Video: h264 (High), yuv420p, 1920x1080"),
            Some((1920, 1080))
        );
        assert_eq!(
            parse_video_dimensions("  Stream #0:0: Video: av1, yuv420p, 1080x1920, 29.97 fps"),
            Some((1080, 1920))
        );
        assert_eq!(parse_video_dimensions("no video stream here"), None);
    }

    #[test]
    fn formats_seconds_without_trailing_zeros() {
        assert_eq!(format_seconds(3.0), "3");
        assert_eq!(format_seconds(3.5), "3.5");
        assert_eq!(format_seconds(8.25), "8.25");
        assert_eq!(format_seconds(0.0), "0");
    }

    #[test]
    fn extracts_stem_without_extension() {
        assert_eq!(
            video_stem(Path::new("C:\\视频\\标题 [BV123].mp4")),
            "标题 [BV123]"
        );
        assert_eq!(video_stem(Path::new("clip.mp4")), "clip");
    }

    #[test]
    fn detects_remote_urls() {
        assert!(is_remote_url("https://cdn.example.com/train.mp4"));
        assert!(is_remote_url("HTTP://EXAMPLE.COM/video.mp4?token=1"));
        assert!(!is_remote_url("C:\\下载\\视频.mp4"));
        assert!(!is_remote_url(""));
        assert!(!is_remote_url("  "));
    }

    #[test]
    fn derives_stem_and_extension_from_remote_urls() {
        assert_eq!(remote_stem("https://cdn.example.com/train.mp4"), "train");
        assert_eq!(
            remote_extension("https://cdn.example.com/train.mp4"),
            ".mp4"
        );
        assert_eq!(
            remote_stem("https://example.com/列车进站参考.mp4?token=abc"),
            "列车进站参考"
        );
        assert_eq!(remote_stem("https://example.com/"), "remote-video");
        assert_eq!(remote_extension("https://example.com/live"), ".mp4");
    }

    #[test]
    fn validates_inputs_before_creating_job() {
        let service = VideoFrameExtractionService::new(
            PathBuf::from("C:\\tmp\\downloads"),
            // composer 不会被触达（校验在创建任务前失败）。
            VideoCompositionService::new(
                PathBuf::from("C:\\tmp\\downloads"),
                PathBuf::from("C:\\tmp\\engine"),
                PathBuf::from("C:\\tmp\\resources"),
            )
            .expect("composer"),
        );
        let empty = service.start_extraction_with_percentages("", vec![1.0], vec![]);
        assert!(matches!(empty, Err(BackendError::Validation { .. })));
        let missing = service.start_extraction_with_percentages(
            "C:\\definitely\\missing\\file.mp4",
            vec![1.0],
            vec![],
        );
        assert!(matches!(missing, Err(BackendError::Validation { .. })));
        let no_timestamps = service.start_extraction_with_percentages(
            "C:\\definitely\\missing\\file.mp4",
            vec![],
            vec![],
        );
        assert!(matches!(
            no_timestamps,
            Err(BackendError::Validation { .. })
        ));
        let negative = service.start_extraction_with_percentages(
            "C:\\definitely\\missing\\file.mp4",
            vec![-1.0],
            vec![],
        );
        assert!(matches!(negative, Err(BackendError::Validation { .. })));
    }
}
