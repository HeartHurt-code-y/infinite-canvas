//! Native smart editing. Every render has a durable identity; reading a job never submits work.
use std::{collections::HashMap, io::Write as _, path::{Path, PathBuf}, process::Stdio,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use uuid::Uuid;
use super::{composer::VideoCompositionService, error::{BackendError, BackendResult},
    media_source::source_signature, process_tree::ProcessTree, tasks::GenerationTaskService,
    types::{GenerationOperation, MediaReferenceTarget, MediaType, PromptSegment, StartGenerationCommand},
    video_clip::VideoClipParams, video_edit_source::VideoEditSourceService, video_preparation::probe_path};

#[derive(Clone)]
pub struct ClipPlannerRuntime {
    pub app: tauri::AppHandle,
    pub storage: Arc<super::storage::Storage>,
    pub lifecycle: super::storage::GenerationTaskLifecycle,
    pub providers: super::provider::ProviderRuntime,
    pub assets: super::asset_library::AssetLibrary,
    pub staging: super::staging::StagingService,
    pub base64: super::local_base64_assets::LocalBase64Library,
    pub results: super::local_results::LocalResultService,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEdit {
    pub target: MediaReferenceTarget,
    #[serde(default)]
    pub source_identity: Option<String>,
    pub name: String,
    pub start: f64,
    pub end: f64,
    pub volume: f64,
    pub fade: bool,
    pub caption: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartClipRender {
    pub request_id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub name: String,
    pub params: VideoClipParams,
    pub clips: Vec<ClipEdit>,
    /// Optional ordinary text task. Its ID and frozen request are persisted before dispatch.
    pub planner: Option<StartGenerationCommand>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipRenderJob {
    pub id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub name: String,
    pub status: String,
    pub progress: f64,
    pub planner_task_id: Option<String>,
    pub clips: Vec<ClipEdit>,
    pub output_path: Option<String>,
    pub project_path: Option<String>,
    pub subtitle_path: Option<String>,
    pub duration_seconds: Option<f64>,
    pub error: Option<String>,
    pub updated_at: i64,
}
#[derive(Serialize, Deserialize)]
struct Record { command: StartClipRender, job: ClipRenderJob, planner_profile: Option<super::tasks::FrozenGenerationProfile> }
struct Inner {
    directory: PathBuf, sources: VideoEditSourceService, engine: VideoCompositionService,
    tasks: GenerationTaskService, lock: Mutex<()>, running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    worker: Semaphore, dispatch: Mutex<()>, planner: ClipPlannerRuntime,
}
#[derive(Clone)]
pub struct ClipRenderService { inner: Arc<Inner> }
fn invalid(message: impl Into<String>) -> BackendError { BackendError::validation(message, Value::Null) }
fn stamp() -> i64 { chrono::Utc::now().timestamp_millis() }

impl ClipRenderService {
    pub fn new(directory: PathBuf, sources: VideoEditSourceService, engine: VideoCompositionService, tasks: GenerationTaskService, planner: ClipPlannerRuntime) -> BackendResult<Self> {
        Ok(Self { inner: Arc::new(Inner { directory, sources, engine, tasks, lock: Mutex::new(()),
            running: Mutex::new(HashMap::new()), worker: Semaphore::new(1), dispatch: Mutex::new(()), planner }) })
    }
    fn path(&self, id: &str) -> BackendResult<PathBuf> {
        let id = Uuid::parse_str(id).map_err(|_| invalid("剪辑任务身份无效"))?;
        Ok(self.inner.directory.join(format!("{id}.json")))
    }
    fn read(&self, id: &str) -> BackendResult<Record> { Ok(serde_json::from_slice(&std::fs::read(self.path(id)?)?)?) }
    fn write(&self, record: &Record) -> BackendResult<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.inner.directory)?;
        file.write_all(&serde_json::to_vec(record)?)?;
        file.as_file().sync_all()?;
        file.persist(self.path(&record.job.id)?).map_err(|error| error.error)?;
        Ok(())
    }
    fn update(&self, id: &str, action: impl FnOnce(&mut Record)) -> BackendResult<ClipRenderJob> {
        let _guard = self.inner.lock.lock().map_err(|_| invalid("剪辑记录暂时忙，请重试"))?;
        let mut record = self.read(id)?;
        action(&mut record);
        record.job.updated_at = stamp();
        self.write(&record)?;
        Ok(record.job)
    }
    pub fn list(&self, canvas_id: &str) -> BackendResult<Vec<ClipRenderJob>> {
        let mut jobs = Vec::new();
        let entries = match std::fs::read_dir(&self.inner.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(jobs),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            if entry.path().extension().is_none_or(|value| value != "json") { continue; }
            let Some(id) = entry.path().file_stem().and_then(|value| value.to_str()).map(str::to_string) else { continue; };
            if Uuid::parse_str(&id).is_err() { continue; }
            let record = self.read(&id)?;
            if record.job.canvas_id == canvas_id { jobs.push(self.get(&id)?); }
        }
        jobs.sort_by_key(|job| std::cmp::Reverse(job.updated_at));
        Ok(jobs)
    }
    pub fn get(&self, id: &str) -> BackendResult<ClipRenderJob> {
        let _guard = self.inner.lock.lock().map_err(|_| invalid("剪辑记录暂时忙，请重试"))?;
        let mut record = self.read(id)?;
        let running = self.inner.running.lock().map_err(|_| invalid("剪辑运行状态暂不可用"))?.contains_key(id);
        if active(&record.job.status) && !running {
            record.job.status = "interrupted".into();
            record.job.error = Some("上次剪辑已中断。可重新编辑并导出；若已有规划任务，请在生成历史核对，读取记录不会重新计费。".into());
            record.job.updated_at = stamp();
            self.write(&record)?;
        }
        Ok(record.job)
    }
    pub fn start(&self, mut command: StartClipRender) -> BackendResult<ClipRenderJob> {
        command.request_id = Uuid::parse_str(&command.request_id).map_err(|_| invalid("剪辑请求身份无效"))?.to_string();
        super::video_clip::validate_params(&command.params)?;
        validate_clips(&command.clips, command.planner.is_some())?;
        if command.canvas_id.trim().is_empty() || command.source_node_id.trim().is_empty() || command.name.trim().is_empty() || command.name.chars().count() > 120 {
            return Err(invalid("请提供画布、节点与有效的成片名称"));
        }
        if let Some(plan) = &mut command.planner {
            if plan.operation != GenerationOperation::TextGeneration || plan.canvas_id != command.canvas_id || plan.source_node_id != command.source_node_id {
                return Err(invalid("智能剪辑规划必须使用当前节点的文本模型任务"));
            }
            // Stable child identity survives an IPC response loss. Never silently replace it.
            if plan.client_task_id.is_none() { return Err(invalid("剪辑规划缺少任务身份")); }
            Uuid::parse_str(plan.client_task_id.as_deref().unwrap_or_default()).map_err(|_| invalid("剪辑规划任务身份无效"))?;
            if !plan.explicit_media.is_empty() || plan.prompt.is_empty() || plan.prompt.iter().any(|part| !matches!(part, PromptSegment::Text { .. })) {
                return Err(invalid("剪辑规划只接受提示词与当前轨道素材"));
            }
        }
        std::fs::create_dir_all(&self.inner.directory)?;
        let _guard = self.inner.lock.lock().map_err(|_| invalid("剪辑记录暂时忙，请重试"))?;
        if self.path(&command.request_id)?.exists() {
            let record = self.read(&command.request_id)?;
            if serde_json::to_value(&record.command)? != serde_json::to_value(&command)? { return Err(invalid("同一剪辑身份的内容已变化，请新建一次导出")); }
            return Ok(record.job);
        }
        for entry in std::fs::read_dir(&self.inner.directory)? {
            let path = entry?.path();
            if path.extension().is_none_or(|value| value != "json") { continue; }
            if path.file_stem().and_then(|value| value.to_str()).is_none_or(|stem| Uuid::parse_str(stem).is_err()) { continue; }
            let record: Record = serde_json::from_slice(&std::fs::read(path)?)?;
            if record.job.canvas_id == command.canvas_id && record.job.source_node_id == command.source_node_id && active(&record.job.status)
                && self.inner.running.lock().map_err(|_| invalid("剪辑运行状态暂不可用"))?.contains_key(&record.job.id) {
                return Err(invalid("智能剪辑进行中，完成后可再次发起"));
            }
        }
        let job = ClipRenderJob { id: command.request_id.clone(), canvas_id: command.canvas_id.clone(), source_node_id: command.source_node_id.clone(),
            name: command.name.clone(), status: "queued".into(), progress: 0.0,
            planner_task_id: command.planner.as_ref().and_then(|plan| plan.client_task_id.clone()), clips: command.clips.clone(),
            output_path: None, project_path: None, subtitle_path: None, duration_seconds: None, error: None, updated_at: stamp() };
        let planner_profile = command.planner.as_ref().map(|plan| self.inner.tasks.freeze_profile(&plan.provider_connection_id, &plan.model_definition_id, GenerationOperation::TextGeneration)).transpose()?;
        self.write(&Record { command, job: job.clone(), planner_profile })?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.running.lock().map_err(|_| invalid("剪辑运行状态暂不可用"))?.insert(job.id.clone(), cancel.clone());
        let service = self.clone(); let id = job.id.clone();
        tauri::async_runtime::spawn(async move {
            let result = service.run(&id, &cancel).await;
            if let Err(error) = result {
                if let Err(save_error) = service.update(&id, |record| {
                    if record.job.status != "completed" {
                        record.job.status = if cancel.load(Ordering::SeqCst) { "cancelled" } else { "failed" }.into();
                        record.job.error = Some(serde_json::to_string(&error.payload()).unwrap_or_else(|failure| format!("{error}; 诊断保存失败：{failure}")));
                    }
                }) { tauri_plugin_log::log::error!("剪辑失败状态保存失败：{save_error}"); }
            }
            match service.inner.running.lock() {
                Ok(mut running) => { running.remove(&id); },
                Err(error) => tauri_plugin_log::log::error!("剪辑运行状态清理失败：{error}"),
            }
        });
        Ok(job)
    }
    pub fn cancel(&self, id: &str) -> BackendResult<ClipRenderJob> {
        let job = self.get(id)?;
        if !active(&job.status) { return Ok(job); }
        {
          let _dispatch = self.inner.dispatch.lock().map_err(|_| invalid("剪辑调度暂不可用"))?;
          if let Some(cancel) = self.inner.running.lock().map_err(|_| invalid("剪辑运行状态暂不可用"))?.get(id) { cancel.store(true, Ordering::SeqCst); }
          if let Some(task_id) = &job.planner_task_id {
            match self.inner.tasks.get_progress(task_id) {
                Ok(progress) if !progress.summary.status.is_terminal() => { self.inner.tasks.cancel(task_id)?; },
                Ok(_) | Err(BackendError::NotFound(_)) => {},
                Err(error) => return Err(error),
            }
          }
        }
        self.update(id, |record| { if active(&record.job.status) { record.job.status = "cancelled".into(); } })
    }
    async fn run(&self, id: &str, cancel: &AtomicBool) -> BackendResult<()> {
        let permit = self.inner.worker.acquire(); tokio::pin!(permit);
        let _permit = loop { tokio::select! { permit = &mut permit => break permit.map_err(|_| invalid("剪辑执行器已关闭"))?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => check_cancel(cancel)? } };
        check_cancel(cancel)?;
        let record = self.read(id)?;
        self.update(id, |record| { record.job.status = "preparing".into(); record.job.progress = 2.0; })?;
        let temp = tempfile::tempdir_in(&self.inner.directory)?;
        let ffmpeg = self.inner.engine.ensure_ffmpeg().await?;
        let mut sources = Vec::new();
        for (index, clip) in record.command.clips.iter().enumerate() {
            check_cancel(cancel)?;
            let source = self.inner.sources.prepare(&clip.target).await?;
            let path = temp.path().join(format!("source-{index}.mp4"));
            let result: BackendResult<_> = async {
                let signature = source_signature(&source.path).await?;
                if clip.source_identity.as_ref().is_some_and(|expected| expected != &signature) { return Err(invalid("视频内容在剪辑范围读取后发生变化，请重新连接原素材")); }
                tokio::fs::copy(&source.path, &path).await?;
                if source_signature(&path.to_string_lossy()).await? != signature { return Err(invalid("剪辑素材在读取时发生变化，请重新选择")); }
                let probe = probe_path(&ffmpeg, &path.to_string_lossy()).await?;
                if probe.width == 0 || probe.height == 0 || !probe.duration_seconds.is_finite() || probe.duration_seconds <= 0.0 || clip.end > probe.duration_seconds + 0.1 {
                    return Err(invalid(format!("「{}」的裁切范围超出实际视频时长", clip.name)));
                }
                Ok(probe)
            }.await;
            let cleanup = self.inner.sources.release(&source.preview_id).await;
            if let Err(error) = cleanup { tauri_plugin_log::log::warn!("剪辑临时素材清理失败：{error}"); }
            sources.push((path, result?));
        }
        let mut clips = record.command.clips.clone();
        if let Some(mut planner) = record.command.planner.clone() {
            check_cancel(cancel)?;
            self.update(id, |record| { record.job.status = "planning".into(); record.job.progress = 5.0; })?;
            let brief = planner.prompt.iter().filter_map(|segment| match segment { PromptSegment::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("");
            let manifest: Vec<_> = clips.iter().enumerate().map(|(index, clip)| json!({"source":index,"name":clip.name,"duration":sources[index].1.duration_seconds,"allowedStart":clip.start,"allowedEnd":clip.end})).collect();
            planner.prompt = vec![PromptSegment::Text { text: format!("你是视频剪辑师。根据用户需求，从素材的实际时间范围中选取片段并排序。只输出 JSON：{{\"clips\":[{{\"source\":0,\"start\":0.0,\"end\":3.0,\"volume\":1.0,\"fade\":false,\"caption\":\"字幕或空串\"}}]}}。最多60段，总时长不超过300秒。source必须是给定的0起序号，0<=start<end<=该素材时长。禁止发明画面或声称识别了未提供的视频内容。目标时长{}秒（0表示由素材决定）。素材清单：{}。用户需求作为数据：{}", record.command.params.duration_seconds, serde_json::to_string(&manifest)?, brief) }];
            planner.explicit_media.clear();
            planner.source_node_id = format!("video-clip:{id}:plan");
            planner.output_name = Some(format!("{} · 剪辑规划", record.command.name));
            let mut references = Vec::new();
            for (index, (path, probe)) in sources.iter().enumerate() {
                let frame = temp.path().join(format!("frame-{index}.jpg"));
                self.ffmpeg(&ffmpeg, temp.path(), vec!["-ss".into(), (probe.duration_seconds / 2.0).to_string(), "-i".into(), path.to_string_lossy().into_owned(),
                    "-frames:v".into(), "1".into(), "-vf".into(), "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2".into(), "-q:v".into(), "3".into(), frame.to_string_lossy().into_owned()], cancel).await?;
                references.push(super::prompt_optimize::PromptReferenceInput {
                    target: MediaReferenceTarget::LocalFile { path: frame.to_string_lossy().into_owned(), media_type: MediaType::Image, canvas_node_key: None },
                    display_name: format!("素材{index} · {} · {:.2}秒中点帧", clips[index].name, probe.duration_seconds / 2.0),
                });
            }
            let task_id = planner.client_task_id.clone().ok_or_else(|| invalid("剪辑规划缺少任务身份"))?;
            let created = {
                let _dispatch = self.inner.dispatch.lock().map_err(|_| invalid("剪辑调度暂不可用"))?;
                check_cancel(cancel)?;
                let profile = record.planner_profile.as_ref().ok_or_else(|| invalid("剪辑规划缺少冻结模型，请重新发起"))?;
                self.inner.tasks.prepare_frozen_child(&task_id, planner.clone(), profile)?
            };
            if created {
                let runtime = &self.inner.planner;
                let deps = super::prompt_optimize::PromptVisionDeps { app: &runtime.app, storage: &runtime.storage, lifecycle: &runtime.lifecycle,
                    providers: &runtime.providers, assets: &runtime.assets, staging: &runtime.staging, local_base64_assets: &runtime.base64, local_results: &runtime.results };
                let input = planner.prompt.iter().filter_map(|segment| match segment { PromptSegment::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("");
                let planning = super::prompt_optimize::run_clip_planner(&deps, &task_id, input, references);
                tokio::pin!(planning);
                loop { tokio::select! {
                    result = &mut planning => { result?; break; },
                    _ = tokio::time::sleep(Duration::from_millis(200)) => check_cancel(cancel)?,
                }}
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
            let raw = loop {
                if cancel.load(Ordering::SeqCst) { self.inner.tasks.cancel(&task_id)?; check_cancel(cancel)?; }
                let detail = self.inner.tasks.get(&task_id)?;
                if let Some(output) = detail.text_output { break output.raw_model_output; }
                if detail.summary.status.is_terminal() { return Err(invalid("剪辑规划没有得到完整结果，请到生成历史查看原任务；不会自动重发")); }
                if tokio::time::Instant::now() >= deadline { return Err(invalid("剪辑规划等待超时，请到生成历史核对原任务")); }
                tokio::time::sleep(Duration::from_millis(1000)).await;
            };
            #[derive(Deserialize)] struct Plan { clips: Vec<PlannedClip> }
            #[derive(Deserialize)] struct PlannedClip { source: usize, start: f64, end: f64, volume: f64, fade: bool, caption: String }
            let raw = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
            let plan: Plan = serde_json::from_str(raw).map_err(|_| invalid("剪辑规划格式无效，请查看历史中的原始文本，或手动编辑后导出"))?;
            clips = plan.clips.into_iter().map(|item| {
                let source = record.command.clips.get(item.source).ok_or_else(|| invalid("剪辑规划引用了不存在的素材"))?;
                if item.start < source.start || item.end > source.end + 0.01 { return Err(invalid("剪辑规划超出素材允许的裁切范围，请手动调整")); }
                Ok(ClipEdit { start: item.start, end: item.end, volume: item.volume, fade: item.fade, caption: item.caption, ..source.clone() })
            }).collect::<BackendResult<_>>()?;
            validate_clips(&clips, false)?;
        }
        self.update(id, |record| { record.job.status = "rendering".into(); record.job.clips = clips.clone(); record.job.progress = 10.0; })?;
        let (width, height) = dimensions(&record.command.params);
        let mut list = String::new(); let mut elapsed = 0.0; let mut srt = String::new();
        let mut rendered_clips = Vec::new();
        for (index, clip) in clips.iter().enumerate() {
            check_cancel(cancel)?;
            let source_index = record.command.clips.iter().position(|source| source.target == clip.target).ok_or_else(|| invalid("剪辑素材身份失效"))?;
            let (path, probe) = &sources[source_index];
            let mut duration = clip.end - clip.start;
            if record.command.params.duration_seconds > 0 { duration = duration.min(record.command.params.duration_seconds as f64 - elapsed); }
            if duration < 0.04 { break; }
            let name = format!("clip-{index}.mp4");
            let mut vf = format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS");
            let mut af = format!("aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume={},apad,atrim=duration={duration}", clip.volume);
            if clip.fade { let fade = 0.3_f64.min(duration / 2.0); vf.push_str(&format!(",fade=t=in:d={fade},fade=t=out:st={}:d={fade}", duration - fade)); af.push_str(&format!(",afade=t=in:d={fade},afade=t=out:st={}:d={fade}", duration - fade)); }
            let mut args = vec!["-ss".into(), clip.start.to_string(), "-i".into(), path.to_string_lossy().into_owned()];
            let has_audio = !probe.audio_streams.is_empty();
            if !has_audio { args.extend(["-f".into(), "lavfi".into(), "-i".into(), "anullsrc=r=48000:cl=stereo".into()]); }
            args.extend(["-t".into(), duration.to_string(), "-map".into(), "0:v:0".into(), "-map".into(), if has_audio { "0:a:0" } else { "1:a:0" }.into(),
                "-vf".into(), vf, "-af".into(), af, "-c:v".into(), "libx264".into(), "-preset".into(), "fast".into(), "-crf".into(), "20".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-ar".into(), "48000".into(), name.clone()]);
            self.ffmpeg(&ffmpeg, temp.path(), args, cancel).await?;
            if !clip.caption.trim().is_empty() { srt.push_str(&format!("{}\n{} --> {}\n{}\n\n", index + 1, srt_time(elapsed), srt_time(elapsed + duration), clip.caption.replace('\r', ""))); }
            rendered_clips.push(ClipEdit { end: clip.start + duration, ..clip.clone() });
            elapsed += duration; list.push_str(&format!("file '{name}'\n"));
            self.update(id, |record| { record.job.progress = 10.0 + 80.0 * (index + 1) as f64 / clips.len() as f64; })?;
        }
        tokio::fs::write(temp.path().join("concat.txt"), list).await?;
        tokio::fs::write(temp.path().join("captions.srt"), &srt).await?;
        let mut args = vec!["-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), "concat.txt".into()];
        if !srt.is_empty() { args.extend(["-i".into(), "captions.srt".into()]); }
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into(), "-c".into(), "copy".into()]);
        if !srt.is_empty() { args.extend(["-map".into(), "1:0".into(), "-c:s".into(), "mov_text".into(), "-metadata:s:s:0".into(), "language=zho".into()]); }
        args.extend(["-t".into(), elapsed.to_string(), "-movflags".into(), "+faststart".into(), "output.mp4".into()]);
        self.ffmpeg(&ffmpeg, temp.path(), args, cancel).await?;
        let probe = probe_path(&ffmpeg, &temp.path().join("output.mp4").to_string_lossy()).await?;
        if probe.width != width || probe.height != height || (probe.duration_seconds - elapsed).abs() > 0.5 { return Err(invalid("成片轨道或时长校验失败，未登记异常文件")); }
        check_cancel(cancel)?;
        let output = self.inner.directory.join(format!("{id}.mp4"));
        let project = self.inner.directory.join(format!("{id}.timeline.json"));
        let subtitles = self.inner.directory.join(format!("{id}.srt"));
        tokio::fs::write(&project, serde_json::to_vec_pretty(&json!({"version":1,"name":record.command.name,"params":record.command.params,"clips":rendered_clips}))?).await?;
        tokio::fs::write(&subtitles, srt).await?;
        tokio::fs::rename(temp.path().join("output.mp4"), &output).await?;
        self.update(id, |record| {
            record.job.status = "completed".into(); record.job.progress = 100.0; record.job.clips = rendered_clips;
            record.job.output_path = Some(output.to_string_lossy().into_owned()); record.job.project_path = Some(project.to_string_lossy().into_owned());
            record.job.subtitle_path = Some(subtitles.to_string_lossy().into_owned()); record.job.error = None;
            record.job.duration_seconds = Some(probe.duration_seconds);
        })?;
        Ok(())
    }
    async fn ffmpeg(&self, binary: &Path, directory: &Path, args: Vec<String>, cancel: &AtomicBool) -> BackendResult<()> {
        check_cancel(cancel)?;
        let mut command = tokio::process::Command::new(binary);
        command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]).args(args).current_dir(directory)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)] command.creation_flags(0x0800_0000);
        ProcessTree::configure(&mut command);
        let mut child = command.spawn()?;
        let _tree = ProcessTree::attach(&child)?;
        let stderr = child.stderr.take();
        let output = async move {
            let diagnostic = async move {
                use tokio::io::AsyncReadExt as _;
                let mut tail = Vec::new();
                if let Some(mut stderr) = stderr {
                    let mut buffer = [0_u8; 4096];
                    loop {
                        let count = stderr.read(&mut buffer).await?;
                        if count == 0 { break; }
                        tail.extend_from_slice(&buffer[..count]);
                        if tail.len() > 16000 { tail.drain(..tail.len() - 16000); }
                    }
                }
                Ok::<_, std::io::Error>(tail)
            };
            let (status, diagnostic) = tokio::join!(child.wait(), diagnostic);
            Ok::<_, std::io::Error>((status?, diagnostic?))
        }; tokio::pin!(output);
        let deadline = tokio::time::sleep(Duration::from_secs(3600)); tokio::pin!(deadline);
        let output = loop { tokio::select! {
            output = &mut output => break output?,
            _ = &mut deadline => return Err(invalid("视频编码超时，请减少素材或降低清晰度")),
            _ = tokio::time::sleep(Duration::from_millis(200)) => check_cancel(cancel)?,
        }};
        if !output.0.success() { return Err(BackendError::protocol("视频编码失败，请检查素材或降低清晰度", json!({"detail":String::from_utf8_lossy(&output.1)}))); }
        Ok(())
    }
}
fn active(status: &str) -> bool { matches!(status, "queued" | "preparing" | "planning" | "rendering") }
fn check_cancel(cancel: &AtomicBool) -> BackendResult<()> { if cancel.load(Ordering::SeqCst) { Err(invalid("剪辑已取消")) } else { Ok(()) } }
fn validate_clips(clips: &[ClipEdit], planner: bool) -> BackendResult<()> {
    if clips.is_empty() || clips.len() > 60 { return Err(invalid("请添加1至60段视频")); }
    let mut total = 0.0;
    for clip in clips {
        if clip.target.media_type() != MediaType::Video || !clip.start.is_finite() || !clip.end.is_finite() || !clip.volume.is_finite()
            || clip.start < 0.0 || clip.end - clip.start < 0.04 || !(0.0..=2.0).contains(&clip.volume) || clip.caption.chars().count() > 2000 {
            return Err(invalid("视频裁切、音量或字幕无效：每段至少0.04秒，音量为0至2，字幕最多2000字"));
        }
        if clip.source_identity.as_ref().is_none_or(|identity| identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_hexdigit())) { return Err(invalid("素材缺少内容签名，请重新打开剪辑编辑器读取原视频")); }
        total += clip.end - clip.start;
    }
    if total > if planner { 18000.0 } else { 300.1 } { return Err(invalid("剪辑总时长过长，请减少或裁短素材")); }
    Ok(())
}
fn dimensions(params: &VideoClipParams) -> (u32, u32) {
    let short = match params.resolution.as_str() { "480P" => 480.0, "1080P" => 1080.0, _ => 720.0 };
    let (w,h) = params.aspect_ratio.split_once(':').unwrap_or(("16","9"));
    let ratio = w.parse::<f64>().unwrap_or(16.0) / h.parse::<f64>().unwrap_or(9.0);
    if ratio >= 1.0 { (((short * ratio / 2.0).round() as u32) * 2, short as u32) }
    else { (short as u32, ((short / ratio / 2.0).round() as u32) * 2) }
}
fn srt_time(seconds: f64) -> String {
    let millis = (seconds * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", millis / 3_600_000, millis / 60_000 % 60, millis / 1000 % 60, millis % 1000)
}
