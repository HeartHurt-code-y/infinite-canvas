//! 本地声明式动画渲染。模型只能提供经过校验的数据，执行入口始终来自应用自带资源。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::error::{BackendError, BackendResult};
use super::storage::now_ms;

const RENDER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CANCEL_GRACE: Duration = Duration::from_secs(5);
const MAX_CONCURRENT_JOBS: usize = 2;
const MAX_CACHED_JOBS: usize = 100;
const MAX_PLAN_BYTES: usize = 64 * 1024;

/// 动画运行时内 Node 与 Chrome headless-shell 的相对路径。
///
/// 必须与 `scripts/prepare-remotion-runtime.mjs` 的 `nodeName`
/// （`process.platform === "win32" ? "node.exe" : "node"`）以及 Remotion
/// `ensureBrowser` 落盘的浏览器文件名一致：Windows 带 `.exe`，其他平台不带。
/// 曾因这里硬编码 `node.exe`，macOS 安装包里明明已经完整打包了 `node`，
/// 应用却永远判定「动画渲染资源缺失」——preflight 直接拦住，无法渲染。
///
/// 参数化 `os` 而不是直接读 `cfg!`，是为了让这条映射能在任意平台
/// （包括跑 `quality` 的 Linux CI）被单测钉住；否则「只在苹果上错」的
/// 取值永远不会被执行到。
fn runtime_paths(os: &str) -> (&'static str, &'static str) {
    if os == "windows" {
        ("node.exe", "browser/chrome-headless-shell.exe")
    } else {
        ("node", "browser/chrome-headless-shell")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotionRenderStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemotionRenderFormat {
    Gif,
    Mp4,
    Both,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRemotionRenderCommand {
    pub plan: Value,
    pub format: RemotionRenderFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotionRenderRecord {
    pub id: String,
    pub status: RemotionRenderStatus,
    pub progress: f64,
    pub message: String,
    pub error: Option<String>,
    pub gif_path: Option<String>,
    pub video_path: Option<String>,
    pub preview_path: Option<String>,
    pub project_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotionRendererPreflight {
    pub ready: bool,
    pub message: String,
}

struct JobEntry {
    record: RemotionRenderRecord,
    cancelled: Arc<AtomicBool>,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, JobEntry>>,
    jobs_dir: PathBuf,
    runtime_candidates: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct RemotionRenderService {
    inner: Arc<Inner>,
}

impl RemotionRenderService {
    pub fn new(downloads_dir: PathBuf, resource_dir: PathBuf) -> Self {
        let mut runtime_candidates = vec![resource_dir.join("remotion-runtime")];
        if cfg!(debug_assertions) {
            runtime_candidates
                .push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remotion-runtime"));
            runtime_candidates
                .push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/remotion-runtime"));
        }
        Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                jobs_dir: downloads_dir.join("无限画布").join("动画逻辑图"),
                runtime_candidates,
            }),
        }
    }

    fn runtime_dir(&self) -> Option<PathBuf> {
        self.inner
            .runtime_candidates
            .iter()
            .find(|path| runtime_ready(path))
            .cloned()
    }

    pub fn preflight(&self) -> RemotionRendererPreflight {
        let ready = self.runtime_dir().is_some();
        RemotionRendererPreflight {
            ready,
            message: if ready {
                "本地动画渲染引擎已就绪，无需额外供应商或 API 密钥".into()
            } else if cfg!(debug_assertions) {
                "本地动画渲染资源缺失或不完整，请运行项目的动画运行时准备命令，然后重新检查环境"
                    .into()
            } else {
                "本地动画渲染资源缺失或不完整，请修复安装或重新安装包含动画引擎的完整安装包".into()
            },
        }
    }

    pub fn start(
        &self,
        command: StartRemotionRenderCommand,
    ) -> BackendResult<RemotionRenderRecord> {
        validate_plan(&command.plan)?;
        let runtime = self
            .runtime_dir()
            .ok_or_else(|| invalid(self.preflight().message))?;
        let mut jobs = self.inner.jobs.lock().expect("animation jobs poisoned");
        if jobs
            .values()
            .filter(|job| job.record.status == RemotionRenderStatus::Running)
            .count()
            >= MAX_CONCURRENT_JOBS
        {
            return Err(BackendError::Conflict(
                "已有两个动画正在渲染，请等待其中一个完成后再开始".into(),
            ));
        }
        prune_cache(&mut jobs);
        let id = Uuid::new_v4().to_string();
        let directory = self.inner.jobs_dir.join(&id);
        std::fs::create_dir_all(&directory)?;
        write_json(
            &directory.join("input.json"),
            &json!({ "plan": command.plan, "format": command.format }),
        )?;
        let now = now_ms();
        let record = RemotionRenderRecord {
            id: id.clone(),
            status: RemotionRenderStatus::Running,
            progress: 0.0,
            message: "正在准备本地动画渲染".into(),
            error: None,
            gif_path: None,
            video_path: None,
            preview_path: None,
            project_path: None,
            created_at: now,
            updated_at: now,
        };
        write_json(&directory.join("job.json"), &record)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.clone(),
            JobEntry {
                record: record.clone(),
                cancelled: Arc::clone(&cancelled),
            },
        );
        drop(jobs);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = service
                .render(&id, &directory, &runtime, command.format, &cancelled)
                .await;
            service.finish(&id, outcome, cancelled.load(Ordering::Acquire));
        });
        Ok(record)
    }

    pub fn get(&self, id: &str) -> BackendResult<RemotionRenderRecord> {
        let directory = self.job_dir(id)?;
        let mut jobs = self.inner.jobs.lock().expect("animation jobs poisoned");
        if let Some(job) = jobs.get(id) {
            return Ok(job.record.clone());
        }
        let bytes = read_limited(&directory.join("job.json"), 64 * 1024)?;
        let mut record: RemotionRenderRecord = serde_json::from_slice(&bytes)?;
        if record.id != id {
            return Err(invalid("动画任务记录与目录不匹配"));
        }
        // 只有当前进程创建的任务才有活跃子进程；磁盘上的 running 是上次退出的检查点。
        if record.status == RemotionRenderStatus::Running {
            record.status = RemotionRenderStatus::Failed;
            record.message = "上次动画渲染因应用退出而中断，可重新渲染".into();
            record.error = Some(record.message.clone());
            record.updated_at = now_ms();
            write_json(&directory.join("job.json"), &record)?;
        }
        validate_record_paths(&directory, &record)?;
        prune_cache(&mut jobs);
        jobs.insert(
            id.into(),
            JobEntry {
                record: record.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(record)
    }

    pub fn cancel(&self, id: &str) -> BackendResult<()> {
        let directory = self.job_dir(id)?;
        self.get(id)?;
        let mut jobs = self.inner.jobs.lock().expect("animation jobs poisoned");
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| BackendError::NotFound(format!("animation job {id}")))?;
        if job.record.status != RemotionRenderStatus::Running {
            return Ok(());
        }
        std::fs::write(directory.join("cancel"), b"cancel")?;
        job.cancelled.store(true, Ordering::Release);
        job.record.message = "正在停止动画渲染并清理子进程".into();
        job.record.updated_at = now_ms();
        write_json(&directory.join("job.json"), &job.record)
    }

    fn job_dir(&self, id: &str) -> BackendResult<PathBuf> {
        if Uuid::parse_str(id)
            .map(|uuid| uuid.to_string() != id)
            .unwrap_or(true)
        {
            return Err(invalid("无效的动画任务编号"));
        }
        let directory = self.inner.jobs_dir.join(id);
        if directory.exists() {
            let root = self.inner.jobs_dir.canonicalize()?;
            if !directory.canonicalize()?.starts_with(root) {
                return Err(invalid("动画任务目录超出输出位置"));
            }
        }
        Ok(directory)
    }

    fn update_progress(&self, id: &str, progress: f64, message: &str) {
        let mut jobs = self.inner.jobs.lock().expect("animation jobs poisoned");
        if let Some(job) = jobs.get_mut(id) {
            if job.record.status != RemotionRenderStatus::Running
                || job.cancelled.load(Ordering::Acquire)
            {
                return;
            }
            let progress = progress.clamp(0.0, 99.0).max(job.record.progress);
            if job.record.progress == progress && job.record.message == message {
                return;
            }
            job.record.progress = progress;
            job.record.message = message.chars().take(300).collect();
            job.record.updated_at = now_ms();
            if let Err(error) =
                write_json(&self.inner.jobs_dir.join(id).join("job.json"), &job.record)
            {
                tauri_plugin_log::log::warn!("animation progress persistence failed: {error}");
            }
        }
    }

    fn finish(&self, id: &str, result: BackendResult<RenderOutputs>, cancelled: bool) {
        let mut jobs = self.inner.jobs.lock().expect("animation jobs poisoned");
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        // 再读取消标记，覆盖任务结束与取消命令恰好交错的窗口。
        if cancelled || job.cancelled.load(Ordering::Acquire) {
            job.record.status = RemotionRenderStatus::Cancelled;
            job.record.message = "动画渲染已取消".into();
            job.record.error = None;
        } else {
            match result {
                Ok(output) => {
                    job.record.status = RemotionRenderStatus::Succeeded;
                    job.record.progress = 100.0;
                    job.record.message = "动画与可编辑工程已导出".into();
                    job.record.gif_path = output.gif_path;
                    job.record.video_path = output.video_path;
                    job.record.preview_path = Some(output.preview_path);
                    job.record.project_path = Some(output.project_path);
                }
                Err(error) => {
                    job.record.status = RemotionRenderStatus::Failed;
                    job.record.message = "动画渲染失败，可修正后重新渲染".into();
                    job.record.error = Some(error.to_string());
                }
            }
        }
        job.record.updated_at = now_ms();
        if let Err(error) = write_json(&self.inner.jobs_dir.join(id).join("job.json"), &job.record)
        {
            job.record.status = RemotionRenderStatus::Failed;
            job.record.error = Some(format!("无法保存动画任务状态：{error}"));
            tauri_plugin_log::log::error!("animation completion persistence failed: {error}");
        }
    }

    async fn render(
        &self,
        id: &str,
        directory: &Path,
        runtime: &Path,
        format: RemotionRenderFormat,
        cancelled: &AtomicBool,
    ) -> BackendResult<RenderOutputs> {
        if cancelled.load(Ordering::Acquire) {
            return Err(invalid("动画渲染已取消"));
        }
        let log_path = directory.join("renderer.log");
        let log = std::fs::File::create(&log_path)?;
        let (node_binary, _) = runtime_paths(std::env::consts::OS);
        let mut command = tokio::process::Command::new(runtime.join(node_binary));
        command
            .arg(runtime.join("render.mjs"))
            .arg(directory)
            .current_dir(runtime)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        // 非 Windows：让渲染进程自成进程组，取消/超时时能连同 Chrome、ffmpeg 一起回收。
        ProcessTree::configure(&mut command);
        let mut child = command.spawn()?;
        // 子进程树绑定操作系统 Job，异常、取消和应用退出都会回收 Chrome/FFmpeg。
        let process_tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error.into());
            }
        };
        let began = Instant::now();
        let mut cancellation_started = None;
        loop {
            if cancelled.load(Ordering::Acquire) && cancellation_started.is_none() {
                // cancel() 已写文件；此处再次尽力写入也覆盖内部取消入口。
                let _ = std::fs::write(directory.join("cancel"), b"cancel");
                cancellation_started = Some(Instant::now());
            }
            if began.elapsed() >= RENDER_TIMEOUT {
                drop(process_tree);
                let _ = child.kill().await;
                return Err(invalid(
                    "动画渲染超过 15 分钟，已停止全部渲染进程。请缩短时长或降低画布尺寸后重试",
                ));
            }
            if cancellation_started.is_some_and(|instant| instant.elapsed() >= CANCEL_GRACE) {
                drop(process_tree);
                let _ = child.kill().await;
                return Err(invalid("动画渲染已取消"));
            }
            if let Some(status) = child.try_wait()? {
                drop(process_tree);
                if status.code() == Some(130) {
                    cancelled.store(true, Ordering::Release);
                }
                if cancelled.load(Ordering::Acquire) || status.code() == Some(130) {
                    return Err(invalid("动画渲染已取消"));
                }
                if !status.success() {
                    let detail = read_log_tail(&log_path);
                    return Err(invalid(format!(
                        "本地动画引擎退出（{}）：{}",
                        status
                            .code()
                            .map_or_else(|| "未知".into(), |code| code.to_string()),
                        detail
                    )));
                }
                return validate_outputs(directory, format);
            }
            if let Ok(bytes) = read_limited(&directory.join("progress.json"), 16 * 1024) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(progress) =
                        value["progress"].as_f64().filter(|value| value.is_finite())
                    {
                        self.update_progress(
                            id,
                            progress,
                            value["message"].as_str().unwrap_or("正在渲染动画"),
                        );
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

fn runtime_ready(directory: &Path) -> bool {
    let (node_binary, browser_binary) = runtime_paths(std::env::consts::OS);
    [
        node_binary,
        "render.mjs",
        "plan.mjs",
        "Composition.tsx",
        "bundle/index.html",
        "runtime-manifest.json",
        browser_binary,
        "node_modules/@remotion/renderer/package.json",
    ]
    .iter()
    .all(|relative| {
        std::fs::metadata(directory.join(relative))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    })
}

fn prune_cache(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < MAX_CACHED_JOBS {
        return;
    }
    if let Some(id) = jobs
        .values()
        .filter(|job| job.record.status != RemotionRenderStatus::Running)
        .min_by_key(|job| job.record.updated_at)
        .map(|job| job.record.id.clone())
    {
        jobs.remove(&id);
    }
}

fn invalid(message: impl Into<String>) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn write_json(path: &Path, value: &impl Serialize) -> BackendResult<()> {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(value)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn read_limited(path: &Path, limit: u64) -> BackendResult<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(invalid("动画任务文件超过大小限制"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("动画任务文件超过大小限制"));
    }
    Ok(bytes)
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return "未提供错误详情".into();
    };
    let length = file.metadata().map_or(0, |metadata| metadata.len());
    let _ = file.seek(SeekFrom::Start(length.saturating_sub(4 * 1024)));
    let mut bytes = Vec::new();
    let _ = file.take(4 * 1024).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

struct RenderOutputs {
    gif_path: Option<String>,
    video_path: Option<String>,
    preview_path: String,
    project_path: String,
}

fn output_file(directory: &Path, relative: &str) -> BackendResult<String> {
    let root = directory.canonicalize()?;
    let path = directory.join(relative).canonicalize()?;
    if !path.starts_with(&root) || !path.is_file() || std::fs::metadata(&path)?.len() == 0 {
        return Err(invalid(format!("动画输出文件无效：{relative}")));
    }
    let mut header = [0_u8; 12];
    let read = std::fs::File::open(&path)?.read(&mut header)?;
    let valid = match relative {
        "animation.gif" => read >= 6 && (&header[..6] == b"GIF87a" || &header[..6] == b"GIF89a"),
        "animation.mp4" => read >= 12 && &header[4..8] == b"ftyp",
        "preview.png" => read >= 8 && &header[..8] == b"\x89PNG\r\n\x1a\n",
        _ => false,
    };
    if !valid {
        return Err(invalid(format!("动画输出内容与格式不符：{relative}")));
    }
    // 返回用户常规路径，避免 Windows canonicalize 的 \\?\ 前缀进入画布素材系统。
    Ok(directory.join(relative).to_string_lossy().into_owned())
}

fn validate_outputs(
    directory: &Path,
    format: RemotionRenderFormat,
) -> BackendResult<RenderOutputs> {
    let gif_path = if format != RemotionRenderFormat::Mp4 {
        Some(output_file(directory, "animation.gif")?)
    } else {
        None
    };
    let video_path = if format != RemotionRenderFormat::Gif {
        Some(output_file(directory, "animation.mp4")?)
    } else {
        None
    };
    let preview_path = output_file(directory, "preview.png")?;
    let project = directory.join("project");
    let root = directory.canonicalize()?;
    if !project.is_dir() || !project.canonicalize()?.starts_with(&root) {
        return Err(invalid("动画可编辑工程没有导出"));
    }
    let mut has_file = false;
    for entry in std::fs::read_dir(&project)? {
        let path = entry?.path();
        if !path.canonicalize()?.starts_with(&root) {
            return Err(invalid("动画工程文件超出任务目录"));
        }
        if path.is_file() && std::fs::metadata(path)?.len() > 0 {
            has_file = true;
        }
    }
    if !has_file {
        return Err(invalid("动画可编辑工程为空"));
    }
    Ok(RenderOutputs {
        gif_path,
        video_path,
        preview_path,
        project_path: project.to_string_lossy().into_owned(),
    })
}

fn validate_record_paths(directory: &Path, record: &RemotionRenderRecord) -> BackendResult<()> {
    for (value, relative) in [
        (&record.gif_path, "animation.gif"),
        (&record.video_path, "animation.mp4"),
        (&record.preview_path, "preview.png"),
        (&record.project_path, "project"),
    ] {
        if let Some(value) = value {
            if Path::new(value) != directory.join(relative) {
                return Err(invalid("动画任务记录包含无效输出路径"));
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnimationPlan {
    schema_version: String,
    template: String,
    title: String,
    subtitle: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
    duration_in_frames: u32,
    background: String,
    palette: Vec<String>,
    elements: Vec<AnimationElement>,
    connections: Vec<AnimationConnection>,
    stagger_frames: u32,
    hold_frames: u32,
    spring_damping: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnimationElement {
    id: String,
    label: String,
    detail: Option<String>,
    value: Option<f64>,
    group: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnimationConnection {
    from: String,
    to: String,
    label: Option<String>,
}

pub fn validate_plan(value: &Value) -> BackendResult<()> {
    if serde_json::to_vec(value)?.len() > MAX_PLAN_BYTES {
        return Err(invalid("动画计划超过大小限制"));
    }
    let plan: AnimationPlan = serde_json::from_value(value.clone())
        .map_err(|error| invalid(format!("动画计划格式不正确：{error}")))?;
    let templates = [
        "cycle-flowchart",
        "morandi-grid",
        "cute-flowchart",
        "compare-flowchart",
        "skills-flowchart",
        "terminal-flowchart",
        "person-card",
        "timeline",
        "code-showcase",
        "pie-chart",
        "custom",
    ];
    if plan.schema_version != "animation-plan.v1" || !templates.contains(&plan.template.as_str()) {
        return Err(invalid("动画计划版本或模板不受支持"));
    }
    if !bounded_text(&plan.title, 1, 60)
        || plan
            .subtitle
            .as_ref()
            .is_some_and(|text| !bounded_text(text, 0, 160))
    {
        return Err(invalid("动画标题或副标题长度超出限制"));
    }
    if [plan.width, plan.height]
        .iter()
        .any(|size| !(320..=1920).contains(size) || size % 2 != 0)
        || plan.fps != 30
        || !(90..=900).contains(&plan.duration_in_frames)
    {
        return Err(invalid(
            "动画尺寸须为 320–1920 的偶数，帧率 30，时长 90–900 帧",
        ));
    }
    if !hex_color(&plan.background)
        || !(1..=8).contains(&plan.palette.len())
        || plan.palette.iter().any(|color| !hex_color(color))
    {
        return Err(invalid("动画颜色必须使用 #RRGGBB，调色板需要 1–8 种颜色"));
    }
    if !(1..=12).contains(&plan.elements.len()) || plan.connections.len() > 24 {
        return Err(invalid("动画需要 1–12 个元素，最多 24 条连接"));
    }
    if !(1..=60).contains(&plan.stagger_frames)
        || plan.hold_frames < 60
        || plan.hold_frames >= plan.duration_in_frames
        || !plan.spring_damping.is_finite()
        || plan.spring_damping.fract() != 0.0
        || !(8.0..=200.0).contains(&plan.spring_damping)
    {
        return Err(invalid("动画节奏参数超出范围，结尾至少需要静置 60 帧"));
    }
    if (plan.elements.len() as u32 - 1) * plan.stagger_frames + 30 + plan.hold_frames
        > plan.duration_in_frames
    {
        return Err(invalid("动画时长不足以展示所有元素并保留结尾静置"));
    }
    let mut ids = HashSet::new();
    for element in &plan.elements {
        if element.id.is_empty()
            || element.id.len() > 48
            || !element
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || !ids.insert(element.id.as_str())
        {
            return Err(invalid(
                "动画元素编号必须唯一且只包含字母、数字、下划线或连字符",
            ));
        }
        if !bounded_text(&element.label, 1, 40)
            || element
                .detail
                .as_ref()
                .is_some_and(|text| !bounded_text(text, 0, 240))
            || element
                .group
                .as_ref()
                .is_some_and(|text| !bounded_text(text, 0, 40))
        {
            return Err(invalid("动画元素文字长度超出限制"));
        }
        if element
            .value
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(invalid("动画数值必须是非负有限数"));
        }
        for (coordinate, minimum, maximum) in [
            (element.x, 0.0, plan.width as f64),
            (element.y, 0.0, plan.height as f64),
            (element.width, 40.0, plan.width as f64),
            (element.height, 40.0, plan.height as f64),
        ] {
            if coordinate
                .is_some_and(|number| !number.is_finite() || number < minimum || number > maximum)
            {
                return Err(invalid("动画元素位置或尺寸超出画布"));
            }
        }
        if plan.template == "custom"
            || [element.x, element.y, element.width, element.height]
                .iter()
                .any(Option::is_some)
        {
            let (Some(x), Some(y), Some(width), Some(height)) =
                (element.x, element.y, element.width, element.height)
            else {
                return Err(invalid("自定义布局必须明确提供每个元素的位置和尺寸"));
            };
            if x + width > plan.width as f64 || y + height > plan.height as f64 {
                return Err(invalid("自定义布局元素超出画布"));
            }
        }
    }
    let mut connections = HashSet::new();
    for connection in &plan.connections {
        if !ids.contains(connection.from.as_str())
            || !ids.contains(connection.to.as_str())
            || connection.from == connection.to
            || connection
                .label
                .as_ref()
                .is_some_and(|text| !bounded_text(text, 0, 40))
        {
            return Err(invalid(
                "动画连接需要引用两个不同的已知元素，标签最多 40 字",
            ));
        }
        if !connections.insert((connection.from.as_str(), connection.to.as_str())) {
            return Err(invalid("同一方向的动画连接不能重复"));
        }
    }
    if plan.template == "pie-chart"
        && (plan.elements.iter().any(|element| element.value.is_none())
            || !plan
                .elements
                .iter()
                .filter_map(|element| element.value)
                .sum::<f64>()
                .is_finite()
            || plan
                .elements
                .iter()
                .filter_map(|element| element.value)
                .sum::<f64>()
                <= 0.0)
    {
        return Err(invalid("饼图各项必须提供非负数值且总和大于零"));
    }
    Ok(())
}

fn bounded_text(value: &str, minimum: usize, maximum: usize) -> bool {
    let length = value.chars().count();
    length >= minimum
        && length <= maximum
        && (minimum == 0 || !value.trim().is_empty())
        && !value.contains('\0')
}

fn hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

use super::process_tree::ProcessTree;

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Value {
        json!({ "schemaVersion": "animation-plan.v1", "template": "morandi-grid", "title": "动画",
            "width": 800, "height": 600, "fps": 30, "durationInFrames": 150,
            "background": "#FFFFFF", "palette": ["#222222"], "elements": [{ "id": "one", "label": "第一步" }],
            "connections": [], "staggerFrames": 30, "holdFrames": 60, "springDamping": 10 })
    }

    #[test]
    fn validates_data_plan_and_rejects_executable_or_external_fields() {
        assert!(validate_plan(&plan()).is_ok());
        for key in ["code", "script", "html", "url", "audioUrl"] {
            let mut value = plan();
            value[key] = json!("untrusted");
            assert!(validate_plan(&value).is_err(), "{key}");
        }
        let mut value = plan();
        value["elements"][0]["src"] = json!("https://invalid.example/image.png");
        assert!(validate_plan(&value).is_err());
    }

    #[test]
    fn validates_timing_geometry_and_colors() {
        for (key, value) in [
            ("width", json!(801)),
            ("fps", json!(60)),
            ("background", json!("url(file)")),
            ("holdFrames", json!(59)),
            ("staggerFrames", json!(0)),
            ("durationInFrames", json!(89)),
        ] {
            let mut candidate = plan();
            candidate[key] = value;
            assert!(validate_plan(&candidate).is_err(), "{key}");
        }
        let mut candidate = plan();
        candidate["template"] = json!("custom");
        assert!(validate_plan(&candidate).is_err());
        candidate["elements"][0] =
            json!({ "id":"one", "label":"布局", "x":10, "y":10, "width":100, "height":100 });
        assert!(validate_plan(&candidate).is_ok());
        candidate["elements"][0]["x"] = json!(750);
        assert!(validate_plan(&candidate).is_err());
        candidate = plan();
        candidate["elements"] = json!([{ "id":"one", "label":"一" }, { "id":"two", "label":"二" }]);
        candidate["durationInFrames"] = json!(90);
        assert!(validate_plan(&candidate).is_err());
    }

    #[test]
    fn rejects_bad_connections_duplicate_ids_and_empty_pies() {
        let mut candidate = plan();
        candidate["connections"] = json!([{ "from":"one", "to":"missing" }]);
        assert!(validate_plan(&candidate).is_err());
        candidate["connections"] = json!([{ "from":"one", "to":"one" }]);
        assert!(validate_plan(&candidate).is_err());
        candidate = plan();
        candidate["elements"] = json!([{ "id":"one", "label":"一" }, { "id":"one", "label":"二" }]);
        assert!(validate_plan(&candidate).is_err());
        candidate = plan();
        candidate["template"] = json!("pie-chart");
        assert!(validate_plan(&candidate).is_err());
        candidate["elements"][0]["value"] = json!(0);
        assert!(validate_plan(&candidate).is_err());
        candidate["elements"][0]["value"] = json!(25);
        assert!(validate_plan(&candidate).is_ok());
    }

    #[test]
    fn rejects_duplicate_directed_connections_but_allows_reverse_edges() {
        let mut candidate = plan();
        candidate["elements"] = json!([{ "id":"one", "label":"一" }, { "id":"two", "label":"二" }]);
        candidate["connections"] = json!([
            { "from":"one", "to":"two", "label":"第一条" },
            { "from":"one", "to":"two", "label":"另一个标签" }
        ]);
        assert!(
            validate_plan(&candidate)
                .unwrap_err()
                .to_string()
                .contains("不能重复")
        );
        candidate["connections"][1] = json!({ "from":"two", "to":"one" });
        assert!(validate_plan(&candidate).is_ok());
    }

    /// 钉住各平台的运行时文件名：macOS 拿到的是 `node`，不是 `node.exe`。
    /// 这条用例在 Linux CI 上也会跑，因此「只在苹果上错」的取值不会再漏过。
    #[test]
    fn runtime_paths_match_the_prepare_script_for_every_platform() {
        assert_eq!(
            runtime_paths("windows"),
            ("node.exe", "browser/chrome-headless-shell.exe")
        );
        assert_eq!(
            runtime_paths("macos"),
            ("node", "browser/chrome-headless-shell")
        );
        assert_eq!(
            runtime_paths("linux"),
            ("node", "browser/chrome-headless-shell")
        );
    }

    #[test]
    fn preflight_requires_the_validation_module_and_export_template() {
        let directory = tempfile::tempdir().unwrap();
        let (node_binary, browser_binary) = runtime_paths(std::env::consts::OS);
        for name in [
            node_binary,
            "render.mjs",
            "bundle/index.html",
            "runtime-manifest.json",
            browser_binary,
            "node_modules/@remotion/renderer/package.json",
        ] {
            let path = directory.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"fixture").unwrap();
        }
        assert!(!runtime_ready(directory.path()));
        std::fs::write(directory.path().join("plan.mjs"), b"fixture").unwrap();
        assert!(!runtime_ready(directory.path()));
        std::fs::write(directory.path().join("Composition.tsx"), b"fixture").unwrap();
        assert!(runtime_ready(directory.path()));
        std::fs::write(directory.path().join("plan.mjs"), b"").unwrap();
        assert!(!runtime_ready(directory.path()));
    }

    fn output_fixtures(directory: &Path) {
        std::fs::write(directory.join("animation.gif"), b"GIF89a------").unwrap();
        std::fs::write(directory.join("animation.mp4"), b"\0\0\0\x18ftypmp42").unwrap();
        std::fs::write(directory.join("preview.png"), b"\x89PNG\r\n\x1a\n----").unwrap();
        std::fs::create_dir(directory.join("project")).unwrap();
        std::fs::write(directory.join("project/plan.json"), b"{}").unwrap();
    }

    #[test]
    fn success_requires_requested_real_outputs_preview_and_project() {
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_outputs(directory.path(), RemotionRenderFormat::Both).is_err());
        output_fixtures(directory.path());
        assert!(validate_outputs(directory.path(), RemotionRenderFormat::Both).is_ok());
        std::fs::write(directory.path().join("animation.gif"), b"not-a-gif").unwrap();
        assert!(validate_outputs(directory.path(), RemotionRenderFormat::Both).is_err());
        assert!(validate_outputs(directory.path(), RemotionRenderFormat::Mp4).is_ok());
    }

    #[test]
    fn reload_marks_interrupted_jobs_failed_and_rejects_path_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let service = RemotionRenderService::new(directory.path().into(), directory.path().into());
        let id = Uuid::new_v4().to_string();
        let job_dir = service.inner.jobs_dir.join(&id);
        std::fs::create_dir_all(&job_dir).unwrap();
        let record = RemotionRenderRecord {
            id: id.clone(),
            status: RemotionRenderStatus::Running,
            progress: 50.0,
            message: "渲染中".into(),
            error: None,
            gif_path: None,
            video_path: None,
            preview_path: None,
            project_path: None,
            created_at: 1,
            updated_at: 1,
        };
        write_json(&job_dir.join("job.json"), &record).unwrap();
        let recovered = service.get(&id).unwrap();
        assert_eq!(recovered.status, RemotionRenderStatus::Failed);
        assert!(recovered.error.unwrap().contains("中断"));
        assert!(service.get("../elsewhere").is_err());
        service.cancel(&id).unwrap();
        assert_eq!(
            service.get(&id).unwrap().status,
            RemotionRenderStatus::Failed
        );
    }

    #[test]
    fn missing_runtime_fails_before_creating_a_render_job() {
        let directory = tempfile::tempdir().unwrap();
        let service = RemotionRenderService {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                jobs_dir: directory.path().join("jobs"),
                runtime_candidates: vec![directory.path().join("missing")],
            }),
        };
        assert!(!service.preflight().ready);
        assert!(
            service
                .start(StartRemotionRenderCommand {
                    plan: plan(),
                    format: RemotionRenderFormat::Both
                })
                .is_err()
        );
        assert!(!service.inner.jobs_dir.exists());
    }

    /// 显式验证自带 Node/Chrome 的真实渲染链路；常规单测不会启动渲染进程。
    #[tokio::test]
    #[ignore = "需要先准备 src-tauri/resources/remotion-runtime；显式运行本地渲染集成验证"]
    async fn bundled_runtime_renders_complete_deliverables_through_service() {
        let directory = tempfile::tempdir().unwrap();
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        assert!(
            runtime_ready(&resources.join("remotion-runtime")),
            "先运行项目的动画运行时准备命令"
        );
        let service = RemotionRenderService::new(directory.path().into(), resources);
        let mut candidate = plan();
        candidate["width"] = json!(320);
        candidate["height"] = json!(320);
        candidate["durationInFrames"] = json!(90);
        let started = service
            .start(StartRemotionRenderCommand {
                plan: candidate,
                format: RemotionRenderFormat::Both,
            })
            .unwrap();
        assert_eq!(started.status, RemotionRenderStatus::Running);
        let began = Instant::now();
        let completed = loop {
            let record = service.get(&started.id).unwrap();
            if record.status != RemotionRenderStatus::Running {
                break record;
            }
            if began.elapsed() >= Duration::from_secs(180) {
                service.cancel(&started.id).unwrap();
                for _ in 0..40 {
                    if service.get(&started.id).unwrap().status != RemotionRenderStatus::Running {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                panic!("真实动画渲染没有在 180 秒内完成，已请求取消");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        assert_eq!(
            completed.status,
            RemotionRenderStatus::Succeeded,
            "{}",
            completed.error.as_deref().unwrap_or(&completed.message)
        );
        assert_eq!(completed.progress, 100.0);
        for output in [
            &completed.gif_path,
            &completed.video_path,
            &completed.preview_path,
        ] {
            let path = Path::new(output.as_ref().expect("渲染必须提供全部媒体路径"));
            assert!(path.starts_with(directory.path()));
            assert!(path.metadata().unwrap().len() > 0);
        }
        let project = Path::new(completed.project_path.as_ref().unwrap());
        assert!(project.join("Composition.tsx").is_file());
        assert!(project.join("plan.json").is_file());
        assert!(project.join("package.json").is_file());
        // 新实例从持久化记录读取同一完整交付，覆盖 start/get/finish/恢复的闭环。
        let restored = RemotionRenderService::new(
            directory.path().into(),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        );
        assert_eq!(
            restored.get(&started.id).unwrap().status,
            RemotionRenderStatus::Succeeded
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn closing_job_terminates_the_renderer_and_its_child_process() {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut c_void;
            fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        fn is_running(id: u32) -> bool {
            let handle = unsafe { OpenProcess(0x1000, 0, id) };
            if handle.is_null() {
                return false;
            }
            let mut code = 0;
            let success = unsafe { GetExitCodeProcess(handle, &mut code) };
            unsafe {
                CloseHandle(handle);
            }
            success != 0 && code == 259
        }
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child-pid.txt");
        let script = format!(
            r#"$PidFile = '{}'
$worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $PidFile -Value $worker.Id
Wait-Process -Id $worker.Id
"#,
            pid_file.to_string_lossy().replace('\'', "''")
        );
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = tokio::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(script)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        let mut descendant = None;
        for _ in 0..100 {
            descendant = std::fs::read_to_string(&pid_file).ok().and_then(|text| {
                text.trim_start_matches('\u{feff}')
                    .trim()
                    .parse::<u32>()
                    .ok()
            });
            if descendant.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let descendant = descendant.expect("child process should report its id");
        assert!(is_running(descendant));
        drop(tree);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if !is_running(descendant) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            !is_running(descendant),
            "renderer descendants must not survive cancellation"
        );
    }
}
