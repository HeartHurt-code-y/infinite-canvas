//! Trusted Blender script + validated scene data; durable local jobs never execute user Python.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::composer::VideoCompositionService;
use super::error::{BackendError, BackendResult};
use super::process_tree::ProcessTree;
use super::storage::now_ms;

const SCRIPT: &str = include_str!("../../../tools/blender/white_model.py");
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 人形关节数（与 tools/blender/white_model.py、src/lib/whiteModelScene.ts 一致）。
const JOINT_COUNT: usize = 17;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelCameraKeyframe {
    pub time: f64,
    pub position: [f64; 3],
    pub target: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelCameraFollow {
    pub actor_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelCamera {
    pub lens: f64,
    pub interpolation: String,
    pub keyframes: Vec<WhiteModelCameraKeyframe>,
    pub follow: Option<WhiteModelCameraFollow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelKeyframe {
    pub time: f64,
    pub position: [f64; 3],
    pub yaw: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelMotionClip {
    pub fps: u32,
    pub frame_count: u32,
    /// base64 小端 int16，frame_count × 17 × 3 个样本；只作为数据保存，渲染端不解码。
    pub joints: String,
    pub source_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelMotion {
    pub kind: String,
    pub pose: Option<String>,
    pub clip: Option<WhiteModelMotionClip>,
    pub start_time: Option<f64>,
    #[serde(rename = "loop")]
    pub looped: Option<bool>,
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelObject {
    pub id: String,
    pub name: String,
    pub shape: String,
    pub color: String,
    pub size: f64,
    pub facing: String,
    pub keyframes: Vec<WhiteModelKeyframe>,
    pub motion: WhiteModelMotion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelScenePlan {
    pub version: u32,
    pub duration_seconds: f64,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub camera: WhiteModelCamera,
    pub objects: Vec<WhiteModelObject>,
}

/// 前端按方案逐帧烘焙的样本；Blender 脚本只把它们写成关键帧，不重复任何插值逻辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelBakedObject {
    pub id: String,
    /// frame_count × 4：x, y, z, yaw（度）
    pub root: Vec<f64>,
    /// 人形：frame_count × 17 × 3 局部关节坐标；几何体为 None。
    pub joints: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteModelBake {
    pub frame_count: u32,
    /// frame_count × 6：机位 xyz + 注视点 xyz
    pub camera: Vec<f64>,
    pub objects: Vec<WhiteModelBakedObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartBlenderRenderRequest {
    pub executable_path: Option<String>,
    pub source_blend_path: Option<String>,
    pub plan: WhiteModelScenePlan,
    pub bake: Option<WhiteModelBake>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderEngineStatus {
    pub available: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlenderRenderStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl BlenderRenderStatus {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderRenderJob {
    pub job_id: String,
    pub status: BlenderRenderStatus,
    pub progress: f64,
    pub message: String,
    pub error: Option<String>,
    pub video_path: Option<String>,
    pub preview_path: Option<String>,
    pub project_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

struct JobEntry {
    record: BlenderRenderJob,
    cancelled: Arc<AtomicBool>,
}

struct Inner {
    jobs: std::sync::Mutex<HashMap<String, JobEntry>>,
    jobs_dir: PathBuf,
    composer: VideoCompositionService,
    bundled_roots: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct BlenderRenderService {
    inner: Arc<Inner>,
}

fn invalid(message: impl Into<String>) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn finite_between(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite() && (minimum..=maximum).contains(&value)
}

fn valid_position(value: &[f64; 3]) -> bool {
    value
        .iter()
        .all(|coordinate| finite_between(*coordinate, -100.0, 100.0))
}

fn strictly_increasing_times<'a>(
    times: impl Iterator<Item = &'a f64>,
    duration_seconds: f64,
) -> bool {
    let mut previous = -1.0;
    for time in times {
        if !finite_between(*time, 0.0, duration_seconds) || *time <= previous {
            return false;
        }
        previous = *time;
    }
    true
}

fn valid_series(values: &[f64], expected_length: usize, limit: f64) -> bool {
    values.len() == expected_length
        && values
            .iter()
            .all(|value| finite_between(*value, -limit, limit))
}

fn validate_motion(motion: &WhiteModelMotion) -> bool {
    match motion.kind.as_str() {
        "auto" => true,
        "pose" => motion.pose.as_deref().is_some_and(|pose| {
            ["stand", "sit", "kneel", "crouch", "reach", "arms_up"].contains(&pose)
        }),
        "clip" => {
            let Some(clip) = &motion.clip else {
                return false;
            };
            (1..=120).contains(&clip.fps)
                && (1..=100_000).contains(&clip.frame_count)
                && motion.looped.is_some()
                && motion
                    .start_time
                    .is_some_and(|value| finite_between(value, -3600.0, 3600.0))
                && motion
                    .speed
                    .is_some_and(|value| finite_between(value, 0.01, 100.0))
                && base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &clip.joints)
                    .is_ok_and(|bytes| {
                        bytes.len() == clip.frame_count as usize * JOINT_COUNT * 3 * 2
                    })
        }
        _ => false,
    }
}

pub fn expected_frame_count(plan: &WhiteModelScenePlan) -> u32 {
    ((plan.duration_seconds * f64::from(plan.fps)).round() as u32).max(1)
}

pub fn validate_request(request: &StartBlenderRenderRequest) -> BackendResult<()> {
    let plan = &request.plan;
    if plan.version != 2 {
        return Err(invalid(
            "白模场景方案版本过旧，请重新打开白模工作室后再渲染",
        ));
    }
    if !finite_between(plan.duration_seconds, 1.0, 30.0)
        || !(8..=30).contains(&plan.fps)
        || !(320..=1920).contains(&plan.width)
        || !(180..=1920).contains(&plan.height)
        || plan.width % 2 != 0
        || plan.height % 2 != 0
    {
        return Err(invalid(
            "白模设置无效：时长为 1–30 秒，帧率为 8–30，宽 320–1920、高 180–1920 且尺寸为偶数",
        ));
    }
    let camera = &plan.camera;
    if !camera.lens.is_finite()
        || camera.lens < 1.0
        || !["linear", "smooth"].contains(&camera.interpolation.as_str())
        || camera.keyframes.is_empty()
        || !strictly_increasing_times(
            camera.keyframes.iter().map(|frame| &frame.time),
            plan.duration_seconds,
        )
        || camera.keyframes.iter().any(|frame| {
            !valid_position(&frame.position)
                || !valid_position(&frame.target)
                || frame.position == frame.target
        })
    {
        return Err(invalid(
            "白模机位设置无效，请检查关键帧时间、坐标和焦距，机位不能与注视点重合",
        ));
    }
    let imported = request
        .source_blend_path
        .as_deref()
        .filter(|path| !path.trim().is_empty());
    if let Some(path) = imported {
        validate_blend_path(Path::new(path))?;
    } else if plan.objects.is_empty() {
        return Err(invalid("创建白模动画至少需要一个角色或物体"));
    }
    let mut ids = HashSet::new();
    for object in &plan.objects {
        if object.id.trim().is_empty()
            || !ids.insert(object.id.as_str())
            || object.name.trim().is_empty()
            || !["box", "sphere", "cylinder", "person"].contains(&object.shape.as_str())
            || !["path", "manual"].contains(&object.facing.as_str())
            || !finite_between(object.size, 0.1, 10.0)
            || object.color.len() != 7
            || !object.color.starts_with('#')
            || !object.color[1..]
                .bytes()
                .all(|character| character.is_ascii_hexdigit())
            || object.keyframes.is_empty()
            || !validate_motion(&object.motion)
        {
            return Err(invalid(
                "白模对象设置无效，请检查唯一标识、名称、形状、颜色、尺寸、动作来源和关键帧",
            ));
        }
        if !strictly_increasing_times(
            object.keyframes.iter().map(|frame| &frame.time),
            plan.duration_seconds,
        ) || object
            .keyframes
            .iter()
            .any(|frame| !valid_position(&frame.position) || !frame.yaw.is_finite())
        {
            return Err(invalid(
                "白模关键帧须按时间严格递增，时间不能超出片长，坐标须在 -100–100 范围内",
            ));
        }
    }
    if camera.follow.as_ref().is_some_and(|follow| {
        !["aim", "track"].contains(&follow.mode.as_str()) || !ids.contains(follow.actor_id.as_str())
    }) {
        return Err(invalid("机位跟随的角色不存在或跟随方式无效"));
    }
    if imported.is_none() {
        let frame_count = expected_frame_count(plan) as usize;
        let Some(bake) = &request.bake else {
            return Err(invalid(
                "白模任务缺少逐帧烘焙数据，请重新打开白模工作室后渲染",
            ));
        };
        if bake.frame_count as usize != frame_count
            || !valid_series(&bake.camera, frame_count * 6, 100.0)
            || bake.objects.len() != plan.objects.len()
        {
            return Err(invalid("白模烘焙数据与片长、帧率或对象数量不一致"));
        }
        for (object, baked) in plan.objects.iter().zip(&bake.objects) {
            let joints_valid = match (&object.shape[..], &baked.joints) {
                ("person", Some(joints)) => {
                    valid_series(joints, frame_count * JOINT_COUNT * 3, 20.0)
                }
                ("person", None) => false,
                (_, None) => true,
                (_, Some(_)) => false,
            };
            if baked.id != object.id
                || !valid_series(&baked.root, frame_count * 4, 100_000.0)
                || baked
                    .root
                    .chunks(4)
                    .any(|frame| !valid_position(&[frame[0], frame[1], frame[2]]))
                || !joints_valid
            {
                return Err(invalid(format!(
                    "「{}」的烘焙数据无效，请重新渲染",
                    object.name
                )));
            }
        }
    }
    Ok(())
}

fn validate_blend_path(path: &Path) -> BackendResult<()> {
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("blend"))
    {
        return Err(invalid("请选择存在的本地 .blend 工程文件"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct BundledBlenderManifest {
    version: String,
    platform: String,
    arch: String,
    executable: String,
}

fn supported_version(version: &str) -> bool {
    let mut parts = version.split('.');
    parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .zip(parts.next().and_then(|part| part.parse::<u32>().ok()))
        .is_some_and(|(major, minor)| major > 4 || major == 4 && minor >= 5)
}

fn bundle_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn bundle_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn bundled_executable(root: &Path) -> BackendResult<PathBuf> {
    let manifest: BundledBlenderManifest =
        serde_json::from_slice(&read_limited(&root.join("manifest.json"), 64 * 1024)?)?;
    if !supported_version(&manifest.version)
        || ![bundle_platform(), std::env::consts::OS].contains(&manifest.platform.as_str())
        || ![bundle_arch(), std::env::consts::ARCH].contains(&manifest.arch.as_str())
    {
        return Err(invalid("内置 Blender 清单与当前系统、架构或支持版本不匹配"));
    }
    let executable = Path::new(&manifest.executable);
    if executable.is_absolute()
        || !executable
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
        || !executable.starts_with("runtime")
    {
        return Err(invalid("内置 Blender 清单的可执行路径无效"));
    }
    let executable = root.join(executable);
    if !executable.is_file() || !executable.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err(invalid("内置 Blender 可执行文件缺失或超出资源目录"));
    }
    Ok(executable)
}

fn engine_candidates(explicit: Option<&str>, bundled_roots: &[PathBuf]) -> Vec<PathBuf> {
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        // An external executable is an explicit advanced override, never an automatic dependency.
        return vec![PathBuf::from(path.trim())];
    }
    let mut seen = HashSet::new();
    bundled_roots
        .iter()
        .filter_map(|root| bundled_executable(root).ok())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn bundled_engine_repair_message() -> &'static str {
    if cfg!(debug_assertions) {
        "内置 Blender 资源缺失或不完整，请先运行 pnpm blender:prepare 准备完整应用资源，再重新检查"
    } else {
        "内置 Blender 资源缺失或不完整，请修复安装或重新安装包含白模引擎的完整应用"
    }
}

async fn detect_engine(explicit: Option<&str>, bundled_roots: &[PathBuf]) -> BlenderEngineStatus {
    let external = explicit.is_some_and(|value| !value.trim().is_empty());
    let mut unavailable = BlenderEngineStatus {
        available: false,
        executable_path: None,
        version: None,
        message: if external {
            "无法运行指定的 Blender，请检查高级设置中的可执行文件路径".into()
        } else {
            bundled_engine_repair_message().into()
        },
    };
    for path in engine_candidates(explicit, bundled_roots) {
        unavailable.executable_path = Some(path.to_string_lossy().into_owned());
        let mut command = tokio::process::Command::new(&path);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        match tokio::time::timeout(Duration::from_secs(10), command.output()).await {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let version = stdout
                    .lines()
                    .find_map(|line| line.strip_prefix("Blender "))
                    .and_then(|value| value.split_whitespace().next())
                    .unwrap_or("");
                if !supported_version(version) {
                    unavailable.message = if external {
                        format!(
                            "高级设置指定的 Blender 版本不兼容（{version}），需要 4.5 或更新版本"
                        )
                    } else {
                        format!(
                            "内置 Blender 版本不兼容（{version}）。{}",
                            bundled_engine_repair_message()
                        )
                    };
                    unavailable.version = (!version.is_empty()).then(|| version.to_string());
                    continue;
                }
                return BlenderEngineStatus {
                    available: true,
                    executable_path: Some(path.to_string_lossy().into_owned()),
                    version: Some(version.into()),
                    message: if external {
                        format!("Blender {version} 已就绪，正在使用高级设置指定的引擎")
                    } else {
                        format!("内置 Blender {version} 已就绪，无需额外安装")
                    },
                };
            }
            Ok(Ok(_)) | Ok(Err(_)) => {
                unavailable.message = if external {
                    "无法运行高级设置指定的 Blender，请检查可执行文件路径或安装完整性".into()
                } else {
                    format!("内置 Blender 无法启动。{}", bundled_engine_repair_message())
                };
            }
            Err(_) => {
                unavailable.message = if external {
                    "Blender 版本检查超时，请检查高级设置中的引擎后重试".into()
                } else {
                    format!(
                        "内置 Blender 启动检查超时。{}",
                        bundled_engine_repair_message()
                    )
                }
            }
        }
    }
    unavailable
}
impl BlenderRenderService {
    pub fn new(
        downloads_dir: PathBuf,
        composer: VideoCompositionService,
        bundled_root: Option<PathBuf>,
    ) -> Self {
        let mut bundled_roots: Vec<_> = bundled_root.into_iter().collect();
        if cfg!(debug_assertions) {
            let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/blender");
            if !bundled_roots.contains(&development) {
                bundled_roots.push(development);
            }
        }
        Self {
            inner: Arc::new(Inner {
                jobs: std::sync::Mutex::new(HashMap::new()),
                jobs_dir: downloads_dir.join("无限画布").join("白模"),
                composer,
                bundled_roots,
            }),
        }
    }

    pub async fn detect_engine(&self, explicit: Option<&str>) -> BlenderEngineStatus {
        detect_engine(explicit, &self.inner.bundled_roots).await
    }

    pub async fn start(
        &self,
        mut request: StartBlenderRenderRequest,
    ) -> BackendResult<BlenderRenderJob> {
        validate_request(&request)?;
        let engine = self.detect_engine(request.executable_path.as_deref()).await;
        if !engine.available {
            return Err(invalid(engine.message));
        }
        request.executable_path = engine.executable_path;
        request.source_blend_path = request
            .source_blend_path
            .filter(|path| !path.trim().is_empty());
        let mut jobs = self.inner.jobs.lock().expect("blender jobs poisoned");
        if jobs
            .values()
            .filter(|entry| entry.record.status.active())
            .count()
            >= 2
        {
            return Err(invalid("已有两个白模任务正在渲染，请等待其中一个完成"));
        }
        prune_jobs(&mut jobs);
        let id = Uuid::new_v4().to_string();
        let directory = self.inner.jobs_dir.join(&id);
        std::fs::create_dir_all(&directory)?;
        write_json(&directory.join("input.json"), &request)?;
        std::fs::write(directory.join("white_model.py"), SCRIPT)?;
        let now = now_ms();
        let record = BlenderRenderJob {
            job_id: id.clone(),
            status: BlenderRenderStatus::Queued,
            progress: 0.0,
            message: "白模任务已保存，正在准备渲染".into(),
            error: None,
            video_path: None,
            preview_path: None,
            project_path: None,
            width: request.plan.width,
            height: request.plan.height,
            duration_seconds: request.plan.duration_seconds,
            created_at: now,
            updated_at: now,
        };
        write_json(&directory.join("job.json"), &record)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.clone(),
            JobEntry {
                record: record.clone(),
                cancelled: cancelled.clone(),
            },
        );
        drop(jobs);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = service.render(&id, &directory, &request, &cancelled).await;
            service.finish(&id, result);
        });
        Ok(record)
    }

    fn job_dir(&self, id: &str) -> BackendResult<PathBuf> {
        if Uuid::parse_str(id).map_or(true, |uuid| uuid.to_string() != id) {
            return Err(invalid("无效的白模任务编号"));
        }
        let directory = self.inner.jobs_dir.join(id);
        if directory.exists()
            && !directory
                .canonicalize()?
                .starts_with(self.inner.jobs_dir.canonicalize()?)
        {
            return Err(invalid("白模任务目录超出输出位置"));
        }
        Ok(directory)
    }

    pub fn get(&self, id: &str) -> BackendResult<BlenderRenderJob> {
        let directory = self.job_dir(id)?;
        let mut jobs = self.inner.jobs.lock().expect("blender jobs poisoned");
        if let Some(entry) = jobs.get(id) {
            validate_record(&directory, &entry.record)?;
            return Ok(entry.record.clone());
        }
        let mut record: BlenderRenderJob =
            serde_json::from_slice(&read_limited(&directory.join("job.json"), 64 * 1024)?)?;
        if record.job_id != id {
            return Err(invalid("白模任务记录与目录不匹配"));
        }
        if record.status.active() {
            record.status = BlenderRenderStatus::Failed;
            record.message = "上次白模渲染因应用退出而中断，可重新渲染".into();
            record.error = Some(record.message.clone());
            record.video_path = None;
            record.preview_path = None;
            record.project_path = None;
            record.updated_at = now_ms();
            write_json(&directory.join("job.json"), &record)?;
        }
        validate_record(&directory, &record)?;
        prune_jobs(&mut jobs);
        jobs.insert(
            id.into(),
            JobEntry {
                record: record.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(record)
    }

    pub fn cancel(&self, id: &str) -> BackendResult<BlenderRenderJob> {
        self.get(id)?;
        let mut jobs = self.inner.jobs.lock().expect("blender jobs poisoned");
        let entry = jobs.get_mut(id).ok_or_else(|| invalid("未找到白模任务"))?;
        if entry.record.status.active() {
            entry.cancelled.store(true, Ordering::Release);
            entry.record.message = "正在取消白模任务并停止渲染进程".into();
            entry.record.updated_at = now_ms();
            write_json(
                &self.inner.jobs_dir.join(id).join("job.json"),
                &entry.record,
            )?;
        }
        Ok(entry.record.clone())
    }

    fn update(&self, id: &str, progress: f64, message: &str) -> BackendResult<()> {
        let mut jobs = self.inner.jobs.lock().expect("blender jobs poisoned");
        let entry = jobs.get_mut(id).ok_or_else(|| invalid("未找到白模任务"))?;
        if !entry.record.status.active() || entry.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        entry.record.status = BlenderRenderStatus::Running;
        entry.record.progress = progress.clamp(0.0, 99.0).max(entry.record.progress);
        entry.record.message = message.chars().take(300).collect();
        entry.record.updated_at = now_ms();
        write_json(
            &self.inner.jobs_dir.join(id).join("job.json"),
            &entry.record,
        )
    }

    fn finish(&self, id: &str, result: BackendResult<f64>) {
        let mut jobs = self.inner.jobs.lock().expect("blender jobs poisoned");
        let Some(entry) = jobs.get_mut(id) else {
            return;
        };
        let directory = self.inner.jobs_dir.join(id);
        if entry.cancelled.load(Ordering::Acquire) {
            entry.record.status = BlenderRenderStatus::Cancelled;
            entry.record.message = "白模渲染已取消".into();
            entry.record.error = None;
        } else {
            match result {
                Ok(duration) => {
                    entry.record.status = BlenderRenderStatus::Succeeded;
                    entry.record.progress = 100.0;
                    entry.record.message = "白模动画与可编辑 Blender 工程已导出".into();
                    entry.record.duration_seconds = duration;
                    entry.record.video_path =
                        Some(directory.join("output.mp4").to_string_lossy().into_owned());
                    entry.record.preview_path =
                        Some(directory.join("preview.png").to_string_lossy().into_owned());
                    entry.record.project_path =
                        Some(directory.join("scene.blend").to_string_lossy().into_owned());
                }
                Err(error) => {
                    entry.record.status = BlenderRenderStatus::Failed;
                    entry.record.message = "白模渲染失败，可修正设置或工程后重试".into();
                    entry.record.error = Some(error.to_string());
                }
            }
        }
        entry.record.updated_at = now_ms();
        if let Err(error) = write_json(&directory.join("job.json"), &entry.record) {
            entry.record.status = BlenderRenderStatus::Failed;
            entry.record.error = Some(format!("无法保存白模任务结果：{error}"));
            entry.record.video_path = None;
            entry.record.preview_path = None;
            entry.record.project_path = None;
        }
    }

    async fn render(
        &self,
        id: &str,
        directory: &Path,
        request: &StartBlenderRenderRequest,
        cancelled: &AtomicBool,
    ) -> BackendResult<f64> {
        self.update(id, 1.0, "正在准备白模视频编码引擎")?;
        let ffmpeg = tokio::select! {
            result = self.inner.composer.ensure_ffmpeg() => result?,
            _ = wait_for_cancel(cancelled) => return Err(invalid("白模渲染已取消")),
        };
        let mut command = tokio::process::Command::new(
            request
                .executable_path
                .as_ref()
                .ok_or_else(|| invalid("Blender 路径缺失"))?,
        );
        command
            .args([
                "--background",
                "--factory-startup",
                "--disable-autoexec",
                "--python-exit-code",
                "1",
                "--python",
            ])
            .arg(directory.join("white_model.py"))
            .args(["--", "--input"])
            .arg(directory.join("input.json"))
            .arg("--output")
            .arg(directory);
        self.update(id, 2.0, "正在生成 Blender 白模场景与动画帧")?;
        self.run_process(id, directory, command, "blender.log", cancelled, true)
            .await?;
        let output: PythonResult =
            serde_json::from_slice(&read_limited(&directory.join("result.json"), 16 * 1024)?)?;
        let count = expected_frame_count(&request.plan);
        if output.frame_count != count
            || output.fps != request.plan.fps
            || output.width != request.plan.width
            || output.height != request.plan.height
        {
            return Err(invalid("Blender 输出与本次冻结的时长、帧率或画幅不一致"));
        }
        for (reported, expected) in [
            (&output.project_path, "scene.blend"),
            (&output.preview_path, "preview.png"),
        ] {
            if Path::new(reported).canonicalize()? != directory.join(expected).canonicalize()? {
                return Err(invalid("Blender 返回了任务目录之外的工程或预览"));
            }
            require_output(directory, expected)?;
        }
        let dimensions = image::image_dimensions(directory.join("preview.png"))
            .map_err(|error| invalid(format!("无法读取白模预览图尺寸：{error}")))?;
        if dimensions != (request.plan.width, request.plan.height) {
            return Err(invalid("白模实际预览尺寸与本次冻结画幅不一致"));
        }
        for frame in 1..=count {
            require_output(directory, &format!("frames/frame_{frame:06}.png"))?;
        }
        self.update(id, 87.0, "白模画面已渲染，正在编码 MP4")?;
        let mut encode = tokio::process::Command::new(ffmpeg);
        encode
            .args(["-hide_banner", "-loglevel", "error", "-y", "-framerate"])
            .arg(request.plan.fps.to_string())
            .args(["-start_number", "1", "-i"])
            .arg(directory.join("frames/frame_%06d.png"))
            .arg("-frames:v")
            .arg(count.to_string())
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-an",
                "-movflags",
                "+faststart",
            ])
            .arg(directory.join("output.mp4"));
        self.run_process(id, directory, encode, "ffmpeg.log", cancelled, false)
            .await?;
        self.update(id, 98.0, "正在校验白模视频与可编辑工程")?;
        require_output(directory, "output.mp4")?;
        let duration = self
            .inner
            .composer
            .probe_video_duration(&directory.join("output.mp4").to_string_lossy())
            .await?;
        let expected_duration = f64::from(count) / f64::from(request.plan.fps);
        if !duration.is_finite() || (duration - expected_duration).abs() > 0.15 {
            return Err(invalid("白模 MP4 实际时长与导出帧数不一致"));
        }
        Ok(duration)
    }

    async fn run_process(
        &self,
        id: &str,
        directory: &Path,
        mut command: tokio::process::Command,
        log_name: &str,
        cancelled: &AtomicBool,
        read_progress: bool,
    ) -> BackendResult<()> {
        if cancelled.load(Ordering::Acquire) {
            return Err(invalid("白模渲染已取消"));
        }
        let log_path = directory.join(log_name);
        let log = std::fs::File::create(&log_path)?;
        command
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        // 非 Windows：让渲染进程自成进程组，取消/超时时连同其子进程一起回收。
        ProcessTree::configure(&mut command);
        let mut child = command.spawn()?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error.into());
            }
        };
        let start = Instant::now();
        loop {
            if cancelled.load(Ordering::Acquire) || start.elapsed() >= PROCESS_TIMEOUT {
                drop(tree);
                let _ = child.kill().await;
                return Err(invalid(if cancelled.load(Ordering::Acquire) {
                    "白模渲染已取消"
                } else {
                    "本地白模渲染超过 30 分钟，已停止进程，请降低尺寸或缩短时长后重试"
                }));
            }
            if let Some(status) = child.try_wait()? {
                drop(tree);
                return if status.success() {
                    Ok(())
                } else {
                    Err(invalid(format!(
                        "白模渲染程序退出（{status}）：{}",
                        log_tail(&log_path)
                    )))
                };
            }
            if read_progress {
                if let Ok(bytes) = read_limited(&directory.join("progress.json"), 16 * 1024) {
                    if let Ok(progress) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(value) = progress["progress"]
                            .as_f64()
                            .filter(|value| value.is_finite())
                        {
                            self.update(
                                id,
                                2.0 + value * 0.83,
                                progress["message"].as_str().unwrap_or("正在渲染白模动画"),
                            )?;
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonResult {
    frame_count: u32,
    fps: u32,
    width: u32,
    height: u32,
    project_path: String,
    preview_path: String,
}

impl BlenderRenderService {
    pub async fn open_project(
        &self,
        executable_path: Option<&str>,
        project_path: &Path,
    ) -> BackendResult<()> {
        validate_blend_path(project_path)?;
        let engine = self.detect_engine(executable_path).await;
        if !engine.available {
            return Err(invalid(engine.message));
        }
        let executable = engine
            .executable_path
            .ok_or_else(|| invalid("Blender 路径缺失"))?;
        let (program, arguments) =
            gui_launch_plan(Path::new(&executable), project_path, std::env::consts::OS);
        let mut command = tokio::process::Command::new(&program);
        command
            .args(&arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn()?;
        // The user explicitly opened a professional GUI; it lives independently of render cancellation.
        tauri::async_runtime::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(())
    }
}

/// 打开 Blender GUI 时要执行的命令与参数。
///
/// macOS 上直接 exec `Blender.app/Contents/MacOS/Blender` 会绕过 LaunchServices：
/// 窗口不激活、Dock 不注册、菜单栏不接管。改用 `open -a <Blender.app> --args ...`
/// 让系统按正常应用方式拉起；其余平台维持直接执行引擎可执行文件。
///
/// 参数化 OS 而不是读 `cfg!`，便于在任意平台（含 Linux CI）单测 macOS 分支。
fn gui_launch_plan(
    executable: &Path,
    project: &Path,
    os: &str,
) -> (PathBuf, Vec<std::ffi::OsString>) {
    if os == "macos" {
        if let Some(bundle) = app_bundle_of(executable) {
            return (
                PathBuf::from("open"),
                vec![
                    OsString::from("-a"),
                    bundle.into_os_string(),
                    OsString::from("--args"),
                    OsString::from("--disable-autoexec"),
                    project.as_os_str().to_os_string(),
                ],
            );
        }
    }
    (
        executable.to_path_buf(),
        vec![
            OsString::from("--disable-autoexec"),
            project.as_os_str().to_os_string(),
        ],
    )
}

/// 从 `<...>/Blender.app/Contents/MacOS/Blender` 反推 `.app` 包路径。
fn app_bundle_of(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|candidate| candidate.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

async fn wait_for_cancel(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn prune_jobs(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < 100 {
        return;
    }
    if let Some(id) = jobs
        .values()
        .filter(|entry| !entry.record.status.active())
        .min_by_key(|entry| entry.record.updated_at)
        .map(|entry| entry.record.job_id.clone())
    {
        jobs.remove(&id);
    }
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
        return Err(invalid("白模任务记录过大"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("白模任务记录过大"));
    }
    Ok(bytes)
}

fn log_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return "没有错误详情".into();
    };
    let length = file.metadata().map_or(0, |metadata| metadata.len());
    let _ = file.seek(SeekFrom::Start(length.saturating_sub(4096)));
    let mut bytes = Vec::new();
    let _ = file.take(4096).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().into()
}

fn require_output(directory: &Path, relative: &str) -> BackendResult<()> {
    let path = directory.join(relative);
    if !path.is_file()
        || std::fs::metadata(&path)?.len() == 0
        || !path.canonicalize()?.starts_with(directory.canonicalize()?)
    {
        return Err(invalid(format!("白模导出文件缺失或位置无效：{relative}")));
    }
    let mut header = [0_u8; 12];
    let read = std::fs::File::open(&path)?.read(&mut header)?;
    if (relative.ends_with(".png") && (read < 8 || &header[..8] != b"\x89PNG\r\n\x1a\n"))
        || (relative.ends_with(".mp4") && (read < 12 || &header[4..8] != b"ftyp"))
    {
        return Err(invalid(format!("白模输出内容与格式不符：{relative}")));
    }
    Ok(())
}

fn validate_record(directory: &Path, record: &BlenderRenderJob) -> BackendResult<()> {
    for (value, relative) in [
        (&record.video_path, "output.mp4"),
        (&record.preview_path, "preview.png"),
        (&record.project_path, "scene.blend"),
    ] {
        if record.status == BlenderRenderStatus::Succeeded {
            let path = value
                .as_ref()
                .ok_or_else(|| invalid("白模任务缺少完整导出文件"))?;
            if Path::new(path) != directory.join(relative) {
                return Err(invalid("白模任务记录包含无效输出路径"));
            }
            require_output(directory, relative)?;
        } else if value.is_some() {
            return Err(invalid("未成功的白模任务不能发布输出文件"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// macOS 上必须经 LaunchServices 打开，否则 GUI 不激活、Dock 不注册。
    #[test]
    fn macos_open_project_goes_through_launch_services() {
        let executable = Path::new(
            "/Applications/无限画布.app/Contents/Resources/blender/runtime/Blender.app/Contents/MacOS/Blender",
        );
        let project = Path::new("/tmp/白模.blend");
        let (program, arguments) = gui_launch_plan(executable, project, "macos");
        assert_eq!(program, PathBuf::from("open"));
        let rendered: Vec<String> = arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            rendered,
            vec![
                "-a",
                "/Applications/无限画布.app/Contents/Resources/blender/runtime/Blender.app",
                "--args",
                "--disable-autoexec",
                "/tmp/白模.blend",
            ]
        );
    }

    /// 无法反推 .app（非标准布局）时不能猜，退回直接执行。
    #[test]
    fn macos_open_project_falls_back_when_no_app_bundle_is_present() {
        let executable = Path::new("/usr/local/bin/blender");
        let project = Path::new("/tmp/白模.blend");
        let (program, arguments) = gui_launch_plan(executable, project, "macos");
        assert_eq!(program, executable);
        assert_eq!(arguments.len(), 2);
    }

    /// 其他平台维持原有行为：直接执行引擎 + `--disable-autoexec`。
    #[test]
    fn other_platforms_exec_the_engine_directly() {
        for os in ["windows", "linux"] {
            let executable = Path::new("C:/blender/blender.exe");
            let project = Path::new("C:/tmp/白模.blend");
            let (program, arguments) = gui_launch_plan(executable, project, os);
            assert_eq!(program, executable);
            let rendered: Vec<String> = arguments
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            assert_eq!(rendered, vec!["--disable-autoexec", "C:/tmp/白模.blend"]);
        }
    }

    /// 1 秒 × 8 帧：机位从 (6,-8,5) 推到 (5,-7,4)，圆柱从 x=-1 走到 x=1 并转 90°，
    /// 人形在原点原地站立（关节取站立姿势的骨盆/头部等简化样本）。
    fn request() -> StartBlenderRenderRequest {
        let frames = 8;
        let mut camera = Vec::new();
        let mut cylinder_root = Vec::new();
        let mut person_root = Vec::new();
        let mut joints = Vec::new();
        for frame in 0..frames {
            let factor = frame as f64 / frames as f64;
            camera.extend([6.0 - factor, -8.0 + factor, 5.0 - factor, 0.0, 0.0, 1.0]);
            cylinder_root.extend([-1.0 + 2.0 * factor, 0.0, 0.0, 90.0 * factor]);
            person_root.extend([0.0, 1.5, 0.0, 0.0]);
            for joint in 0..JOINT_COUNT {
                joints.extend([0.0, 0.0, 0.1 + joint as f64 * 0.05]);
            }
        }
        serde_json::from_value(json!({
            "executablePath": null, "sourceBlendPath": null,
            "plan": { "version": 2, "durationSeconds": 1, "fps": 8, "width": 320, "height": 180,
                "camera": { "lens": 50, "interpolation": "linear", "follow": null,
                    "keyframes": [
                        { "time": 0, "position": [6,-8,5], "target": [0,0,1] },
                        { "time": 1, "position": [5,-7,4], "target": [0,0,1] }
                    ] },
                "objects": [
                    { "id": "actor", "name": "红色圆柱", "shape": "cylinder", "color": "#ff6655", "size": 1, "facing": "manual",
                      "motion": { "kind": "auto" },
                      "keyframes": [{ "time": 0, "position": [-1,0,0], "yaw": 0 }, { "time": 1, "position": [1,0,0], "yaw": 90 }] },
                    { "id": "person", "name": "蓝色人形", "shape": "person", "color": "#698bce", "size": 1.75, "facing": "path",
                      "motion": { "kind": "pose", "pose": "stand" },
                      "keyframes": [{ "time": 0, "position": [0,1.5,0], "yaw": 0 }] }
                ]
            },
            "bake": { "frameCount": frames, "camera": camera, "objects": [
                { "id": "actor", "root": cylinder_root, "joints": null },
                { "id": "person", "root": person_root, "joints": joints }
            ] }
        })).unwrap()
    }

    fn service(directory: &Path) -> BlenderRenderService {
        service_with_bundle(
            directory,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/blender"),
        )
    }

    fn service_with_bundle(directory: &Path, bundled_root: PathBuf) -> BlenderRenderService {
        BlenderRenderService::new(
            directory.into(),
            VideoCompositionService::new(
                directory.into(),
                directory.join("engine"),
                Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
            )
            .unwrap(),
            Some(bundled_root),
        )
    }

    fn record(id: &str) -> BlenderRenderJob {
        BlenderRenderJob {
            job_id: id.into(),
            status: BlenderRenderStatus::Running,
            progress: 10.0,
            message: "运行中".into(),
            error: None,
            video_path: None,
            preview_path: None,
            project_path: None,
            width: 320,
            height: 180,
            duration_seconds: 1.0,
            created_at: now_ms(),
            updated_at: now_ms(),
        }
    }

    #[test]
    fn blender_bundled_locator_prioritizes_resources_and_preserves_explicit_override() {
        let temporary = tempfile::tempdir().unwrap();
        let packaged = temporary.path().join("packaged/blender");
        let development = temporary.path().join("development/blender");
        let binary_name = if cfg!(windows) {
            "runtime/blender.exe"
        } else if cfg!(target_os = "macos") {
            "runtime/Blender.app/Contents/MacOS/Blender"
        } else {
            "runtime/blender"
        };
        for root in [&packaged, &development] {
            let executable = root.join(binary_name);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(executable, b"fixture").unwrap();
            write_json(
                &root.join("manifest.json"),
                &json!({
                    "version": "4.5.13", "platform": bundle_platform(), "arch": bundle_arch(),
                    "executable": binary_name,
                }),
            )
            .unwrap();
        }
        let roots = [packaged.clone(), development.clone()];
        assert_eq!(
            engine_candidates(None, &roots),
            vec![packaged.join(binary_name), development.join(binary_name)]
        );
        let external = temporary.path().join(if cfg!(windows) {
            "external.exe"
        } else {
            "external"
        });
        assert_eq!(engine_candidates(external.to_str(), &roots), vec![external]);
        // No implicit fallback to PATH, AppData, or a separately installed Blender.
        assert!(engine_candidates(None, &[]).is_empty());
        write_json(
            &packaged.join("manifest.json"),
            &json!({
                "version": "4.5.13", "platform": bundle_platform(), "arch": bundle_arch(),
                "executable": "../external.exe",
            }),
        )
        .unwrap();
        assert_eq!(
            engine_candidates(None, &roots),
            vec![development.join(binary_name)]
        );
        write_json(
            &development.join("manifest.json"),
            &json!({
                "version": "4.5.13", "platform": "another-platform", "arch": bundle_arch(),
                "executable": binary_name,
            }),
        )
        .unwrap();
        assert!(engine_candidates(None, &roots).is_empty());
    }

    #[test]
    fn blender_input_validation_rejects_ambiguous_motion_and_executable_fields() {
        let base = request();
        validate_request(&base).unwrap();
        let mut bad = base.clone();
        bad.plan.objects[0].keyframes[1].time = 0.0;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.objects[0].keyframes[1].position[0] = f64::NAN;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.width = 321;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.objects.push(bad.plan.objects[0].clone());
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.source_blend_path = Some("../source.blend".into());
        assert!(validate_request(&bad).is_err());
        // 旧版方案与非法机位/跟随/动作来源。
        bad = base.clone();
        bad.plan.version = 1;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.camera.keyframes[0].target = bad.plan.camera.keyframes[0].position;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.camera.follow = Some(WhiteModelCameraFollow {
            actor_id: "missing".into(),
            mode: "aim".into(),
        });
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.camera.follow = Some(WhiteModelCameraFollow {
            actor_id: "person".into(),
            mode: "track".into(),
        });
        validate_request(&bad).unwrap();
        bad = base.clone();
        bad.plan.objects[1].motion.pose = Some("moonwalk".into());
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.plan.objects[1].motion = WhiteModelMotion {
            kind: "clip".into(),
            pose: None,
            clip: Some(WhiteModelMotionClip {
                fps: 24,
                frame_count: 2,
                joints: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    vec![0_u8; 2 * JOINT_COUNT * 3 * 2],
                ),
                source_name: "demo.mp4".into(),
            }),
            start_time: Some(0.0),
            looped: Some(true),
            speed: Some(1.0),
        };
        validate_request(&bad).unwrap();
        bad.plan.objects[1]
            .motion
            .clip
            .as_mut()
            .unwrap()
            .frame_count = 3;
        assert!(validate_request(&bad).is_err());
        let mut data = serde_json::to_value(base).unwrap();
        data["plan"]["python"] = json!("print('untrusted')");
        assert!(serde_json::from_value::<StartBlenderRenderRequest>(data).is_err());
    }

    /// 烘焙数据必须与方案逐帧、逐对象对齐；导入工程时不需要烘焙。
    #[test]
    fn blender_input_validation_checks_baked_samples_against_plan() {
        let base = request();
        let mut bad = base.clone();
        bad.bake = None;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().frame_count = 9;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().camera.pop();
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().objects[1].joints = None;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().objects[0].joints = Some(vec![0.0; 8 * JOINT_COUNT * 3]);
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().objects.swap(0, 1);
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().objects[0].root[0] = 500.0;
        assert!(validate_request(&bad).is_err());
        bad = base.clone();
        bad.bake.as_mut().unwrap().objects[1]
            .joints
            .as_mut()
            .unwrap()[5] = f64::INFINITY;
        assert!(validate_request(&bad).is_err());
        // 导入 .blend 时烘焙可省略（路径校验在真实文件上由 smoke 覆盖）。
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("scene.blend");
        std::fs::write(&project, b"BLENDER").unwrap();
        bad = base.clone();
        bad.bake = None;
        bad.source_blend_path = Some(project.to_string_lossy().into_owned());
        validate_request(&bad).unwrap();
    }

    #[tokio::test]
    async fn blender_job_cancellation_stops_process_and_restart_marks_orphan_failed() {
        let temporary = tempfile::tempdir().unwrap();
        let renderer = service(temporary.path());
        let id = Uuid::new_v4().to_string();
        let directory = renderer.inner.jobs_dir.join(&id);
        std::fs::create_dir_all(&directory).unwrap();
        let job = record(&id);
        write_json(&directory.join("job.json"), &job).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        renderer.inner.jobs.lock().unwrap().insert(
            id.clone(),
            JobEntry {
                record: job,
                cancelled: cancelled.clone(),
            },
        );
        let mut command = if cfg!(windows) {
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-Command",
                "Write-Output ready; Start-Sleep -Seconds 30",
            ]);
            command
        } else {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", "echo ready; exec sleep 30"]);
            command
        };
        command.stdin(Stdio::null());
        let worker = renderer.clone();
        let running_id = id.clone();
        let running_directory = directory.clone();
        let task = tokio::spawn(async move {
            let result = worker
                .run_process(
                    &running_id,
                    &running_directory,
                    command,
                    "cancel-test.log",
                    &cancelled,
                    false,
                )
                .await;
            assert!(result.is_err());
            worker.finish(&running_id, result.map(|()| 1.0));
        });
        let began = Instant::now();
        while !std::fs::read_to_string(directory.join("cancel-test.log"))
            .unwrap_or_default()
            .contains("ready")
        {
            assert!(
                began.elapsed() < Duration::from_secs(10),
                "取消测试子进程未启动"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        renderer.cancel(&id).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        let stopped = renderer.get(&id).unwrap();
        assert_eq!(stopped.status, BlenderRenderStatus::Cancelled);
        assert!(stopped.video_path.is_none() && stopped.project_path.is_none());
        let restarted = service(temporary.path());
        assert_eq!(
            restarted.get(&id).unwrap().status,
            BlenderRenderStatus::Cancelled
        );
        let orphan_id = Uuid::new_v4().to_string();
        let orphan_dir = renderer.inner.jobs_dir.join(&orphan_id);
        std::fs::create_dir_all(&orphan_dir).unwrap();
        write_json(&orphan_dir.join("job.json"), &record(&orphan_id)).unwrap();
        let orphan = restarted.get(&orphan_id).unwrap();
        assert_eq!(orphan.status, BlenderRenderStatus::Failed);
        assert!(orphan.error.unwrap().contains("中断"));
        assert!(restarted.get("../outside").is_err());
    }

    async fn completed(renderer: &BlenderRenderService, id: &str) -> BlenderRenderJob {
        let began = Instant::now();
        loop {
            let job = renderer.get(id).unwrap();
            if !job.status.active() {
                return job;
            }
            if began.elapsed() > Duration::from_secs(120) {
                renderer.cancel(id).unwrap();
                panic!("Blender smoke 超过 120 秒，已取消");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test]
    #[ignore = "requires packaged Blender runtime; optional INFINITE_CANVAS_BLENDER_BUNDLE selects an extracted bundle root"]
    async fn blender_real_engine_renders_mp4_and_reimports_editable_project() {
        let temporary = tempfile::tempdir().unwrap();
        let bundled_root = std::env::var_os("INFINITE_CANVAS_BLENDER_BUNDLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/blender"));
        let renderer = service_with_bundle(temporary.path(), bundled_root.clone());
        let engine = renderer.detect_engine(None).await;
        assert!(engine.available, "{}", engine.message);
        assert!(
            Path::new(engine.executable_path.as_ref().unwrap())
                .canonicalize()
                .unwrap()
                .starts_with(bundled_root.canonicalize().unwrap())
        );
        let started = renderer.start(request()).await.unwrap();
        let first = completed(&renderer, &started.job_id).await;
        assert_eq!(
            first.status,
            BlenderRenderStatus::Succeeded,
            "{:?}",
            first.error
        );
        assert!((first.duration_seconds - 1.0).abs() < 0.15);
        assert_eq!((first.width, first.height), (320, 180));
        let first_project = PathBuf::from(first.project_path.as_ref().unwrap());
        let original_bytes = std::fs::read(&first_project).unwrap();
        let mut imported = request();
        imported.source_blend_path = first.project_path.clone();
        let imported_start = renderer.start(imported).await.unwrap();
        let second = completed(&renderer, &imported_start.job_id).await;
        assert_eq!(
            second.status,
            BlenderRenderStatus::Succeeded,
            "{:?}",
            second.error
        );
        assert_ne!(first.project_path, second.project_path);
        assert_eq!(std::fs::read(first_project).unwrap(), original_bytes);
        assert_eq!(
            service_with_bundle(temporary.path(), bundled_root.clone())
                .get(&first.job_id)
                .unwrap()
                .status,
            BlenderRenderStatus::Succeeded
        );
        eprintln!(
            "Blender bundled service smoke complete: create and reimport MP4 + editable project, 320x180 / 8fps / 1s, bundle={}",
            bundled_root.display()
        );
    }
}
