//! Persistent long-video agent: plan, approve, generate children, reconcile, compose.
//! Public-site code documents the behavior; this is the project's own implementation.
pub mod model;
mod render;

use super::{
    asset_library::AssetLibrary,
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    local_base64_assets::LocalBase64Library,
    local_results::LocalResultService,
    prompt_optimize::{self, PromptReferenceInput, PromptVisionDeps},
    provider::ProviderRuntime,
    staging::StagingService,
    storage::{GenerationTaskLifecycle, Storage},
    tasks::GenerationTaskService,
    types::{
        ExplicitMediaInput, GenerationOperation, GenerationTaskStatus, MediaReferenceTarget,
        MediaType, PromptSegment, SaveStatus,
    },
};
use model::*;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter as _};
use tauri_plugin_log::log::warn;
use uuid::Uuid;

struct Inner {
    app: AppHandle,
    storage: Arc<Storage>,
    tasks: GenerationTaskService,
    composer: VideoCompositionService,
    providers: ProviderRuntime,
    lifecycle: GenerationTaskLifecycle,
    assets: AssetLibrary,
    staging: StagingService,
    base64: LocalBase64Library,
    results: LocalResultService,
    directory: PathBuf,
    running: Mutex<HashSet<String>>,
    /// Acceptance of a new child and pause/cancel are ordered under this short lock.
    dispatch: Mutex<()>,
}
#[derive(Clone)]
pub struct LongVideoService {
    inner: Arc<Inner>,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}
fn event(record: &mut LongVideoRecord, message: impl Into<String>) {
    record.job.events.push(LongVideoEvent {
        at: chrono::Utc::now().timestamp_millis(),
        message: message.into(),
    });
    // 主任务记录每次写入都会整体重写（片段、提示词、快照都在同一段 JSON 里），
    // 过程记录不能无限长：只保留最近若干条。
    const MAX_EVENTS: usize = 300;
    if record.job.events.len() > MAX_EVENTS {
        let overflow = record.job.events.len() - MAX_EVENTS;
        let _ = record.job.events.drain(..overflow);
    }
}
fn needs_attention(record: &mut LongVideoRecord, message: &str, error: Option<Value>) {
    if record.job.status.running() {
        record.job.status = LongVideoStatus::NeedsAttention;
        record.job.yield_reason = Some("task_attention".into());
        record.job.error = Some(error.unwrap_or_else(|| json!({"message":message})));
        event(record, message);
    }
}

/// 终态片段：已经拿到成片，或子任务已明确失败／回执不明／被中断／被取消。
/// 这类片段不会被自动重新提交，只能由用户明确重试，或只合成已成功的部分。
fn terminal_shot_status(status: &str) -> bool {
    matches!(
        status,
        "succeeded" | "failed" | "unknown" | "interrupted" | "cancelled"
    )
}

/// 终态且**不会再产出文件**的片段：明确失败、被中断、被取消。
///
/// 与 `terminal_shot_status` 的区别在「回执不明」和「已生成但本地没存下来」：
/// 前者远端结果可能后才回来，后者用户点「恢复片段下载」就能把文件救回来——
/// 这两种都必须继续回读，否则片段会永远停在未知/未保存，合成时也永远等它。
fn settled_shot_status(status: &str) -> bool {
    matches!(status, "failed" | "interrupted" | "cancelled")
}

/// 子任务创建后多久还算「正常等待派发」。超过这个时间还停在「已创建且没有远端 id」，
/// 就是上次中断留下的孤儿。
const ORPHAN_GRACE_MS: i64 = 120_000;

/// 片段槽位：决定这个镜头现在该被观察、该被提交，还是该等待用户决定。
enum ShotSlot {
    /// 已保存成片。
    Done,
    /// 从未提交，或用户明确要求重试：可以提交。
    Pending,
    /// 子任务在途：只回读状态，绝不重新提交。
    InFlight,
    /// 子任务明确失败或回执不明：等用户决定。
    Blocked,
}

/// 一个片段子任务的当前状态快照。
struct ShotObservation {
    index: usize,
    /// 读到状态的子任务身份：写回前要确认它仍是该片段的最新一次尝试。
    task_id: String,
    status: String,
    progress: Option<f64>,
    error: Option<Value>,
    final_path: Option<String>,
    result_index: Option<u32>,
}

/// 从模型输出里找出可能的 JSON 对象片段。
///
/// 文本模型经常在 JSON 前后加解释、Markdown 围栏，或在说明里写 "{占位符}" 这类带花括号的散文。
/// 逐个候选按括号配对截取（跳过字符串里的括号与转义），由调用方逐个尝试解析，
/// 第一个能解析成 JSON 的才算数——只取第一个 `{` 会把整条长视频卡死在规划阶段，
/// 而重新规划要再花一次文本模型调用。
fn extract_json_candidates(text: &str) -> Vec<&str> {
    const MAX_CANDIDATES: usize = 8;
    let mut candidates = Vec::new();
    let mut offset = 0usize;
    while let Some(found) = text[offset..].find('{') {
        let start = offset + found;
        if let Some(end) = balanced_json_end(text, start) {
            candidates.push(&text[start..end]);
            if candidates.len() >= MAX_CANDIDATES {
                break;
            }
        }
        offset = start + 1;
        if offset >= text.len() {
            break;
        }
    }
    candidates
}

/// 返回从 `start` 开始的第一个完整 JSON 对象的结束下标（含右花括号）。
fn balanced_json_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for offset in start..bytes.len() {
        match bytes[offset] {
            b'\\' if in_string => {
                escaped = !escaped;
                continue;
            }
            b'"' if !escaped => {
                in_string = !in_string;
                escaped = false;
                continue;
            }
            b'{' if !in_string => {
                depth += 1;
                continue;
            }
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset + 1);
                }
                continue;
            }
            _ => {
                escaped = false;
                continue;
            }
        }
    }
    None
}

/// 冻结档案里该模型真正声明的单片段时长档位。
///
/// 冻结 Schema 不是服务端白名单（真实约束在渠道侧），但提前把明显非法的档位夹住，
/// 比把非法值原样打给供应商、让整条长视频在第一个片段就失败要好。
fn duration_allowed_seconds(schema: &Value, key: &str) -> Vec<u32> {
    schema
        .get("parameters")
        .and_then(Value::as_object)
        .and_then(|parameters| parameters.get(key))
        .and_then(Value::as_object)
        .and_then(|definition| definition.get("enum").or_else(|| definition.get("options")))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_u64().map(|value| value as u32))
                .filter(|value| *value > 0)
                .collect()
        })
        .unwrap_or_default()
}

/// 把用户填的单片段时长夹到模型允许的档位上；同距时取更小的，避免超出用户要的时长。
fn effective_segment_seconds(schema: &Value, key: &str, requested: u32) -> u32 {
    let allowed = duration_allowed_seconds(schema, key);
    if allowed.is_empty() {
        return requested.max(1);
    }
    if allowed.contains(&requested) {
        return requested;
    }
    allowed
        .iter()
        .copied()
        .min_by_key(|value| (value.abs_diff(requested), *value))
        .unwrap_or(requested)
}

impl LongVideoService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        storage: Arc<Storage>,
        tasks: GenerationTaskService,
        composer: VideoCompositionService,
        providers: ProviderRuntime,
        lifecycle: GenerationTaskLifecycle,
        assets: AssetLibrary,
        staging: StagingService,
        base64: LocalBase64Library,
        results: LocalResultService,
        directory: PathBuf,
    ) -> BackendResult<Self> {
        storage.initialize_long_video()?;
        Ok(Self {
            inner: Arc::new(Inner {
                app,
                storage,
                tasks,
                composer,
                providers,
                lifecycle,
                assets,
                staging,
                base64,
                results,
                directory,
                running: Mutex::new(HashSet::new()),
                dispatch: Mutex::new(()),
            }),
        })
    }

    pub fn list(&self, canvas_id: &str) -> BackendResult<Vec<LongVideoJob>> {
        self.inner
            .storage
            .long_video_records(Some(canvas_id))?
            .into_iter()
            .map(|record| self.get(&record.job.id))
            .collect()
    }
    pub fn get(&self, id: &str) -> BackendResult<LongVideoJob> {
        let record = self.inner.storage.long_video_record(id)?;
        let updates = self.observe_shots(&record)?;
        if updates.is_empty() {
            return Ok(record.job);
        }
        let job_id = record.job.id.clone();
        Ok(self
            .apply_observations(&job_id, &updates)?
            .unwrap_or(record.job))
    }
    /// 回读所有在途片段的子任务状态。已受理的远端任务只读状态，绝不自动重新提交。
    ///
    /// 这里用 `get_progress`（摘要 + 结果表）而不是完整任务详情：完整详情会把每次供应商
    /// 调用的原始响应与全部事件载荷都读出来，片段一多、轮询一密就是成倍的数据库读取。
    fn observe_shots(&self, record: &LongVideoRecord) -> BackendResult<Vec<ShotObservation>> {
        let mut updates = Vec::new();
        for (index, shot) in record.job.shots.iter().enumerate() {
            // 待重试的片段由用户明确驱动，这里不能拿旧任务的状态盖回去。
            if shot.final_path.is_some() || shot.status == "pending_retry" {
                continue;
            }
            // 终态且不会再产出文件的片段不再回读。
            // 但「回执不明」（远端结果可能后才回来）与「已生成但本地没存下来」
            // （用户点「恢复片段下载」就能救回来）必须继续回读——
            // 否则这两类片段会永远停在未知/未保存，合成时也永远等不到它们。
            if settled_shot_status(&shot.status) {
                continue;
            }
            let Some(task_id) = shot.attempts.last() else {
                continue;
            };
            if !self.inner.storage.long_video_child_exists(task_id)? {
                continue;
            }
            let Ok(progress) = self.inner.tasks.get_progress(task_id) else {
                continue;
            };
            // 孤儿子任务：任务记录建了却没人执行（进程死在「创建任务」与「派发任务」之间，
            // 或执行体自己崩了）。它在任务表里看起来是「已创建且没有远端 id」，
            // 但没有任何东西会推进它——放着不管，这个片段会永远占着并发窗口，
            // 整条任务卡在生成中，而用户连「重试」按钮都看不到（状态不是失败）。
            // 给一段宽限期（正常任务是创建后立刻派发的），过了就当它失败，让用户能重试这一段。
            if progress.summary.status == GenerationTaskStatus::Created
                && progress.summary.remote_task_id.is_none()
                && chrono::Utc::now().timestamp_millis() - progress.summary.created_at
                    > ORPHAN_GRACE_MS
            {
                // 顺手把这个僵尸任务落成已取消：生成历史里留一条永远停在「已创建」的任务，
                // 只会让人以为还有东西在跑。
                let _ = self.inner.tasks.cancel(task_id);
                updates.push(ShotObservation {
                    index,
                    task_id: task_id.clone(),
                    status: "failed".into(),
                    progress: None,
                    error: Some(json!({
                        "message": "片段任务没有在途执行（可能是上次中断留下的残留），请重试该片段。"
                    })),
                    final_path: None,
                    result_index: None,
                });
                continue;
            }
            let result = progress.results.iter().find(|result| {
                result.media_type == MediaType::Video
                    && result.save_status == SaveStatus::Succeeded
                    && result.final_path.is_some()
            });
            // 远端成功与本地落盘是两个阶段。下载仍在排队/写入时必须占住原槽位，
            // 不能把 succeeded + 无路径当成异常终态，提前停止整条编排。
            let saving = progress.summary.status == GenerationTaskStatus::Succeeded
                && progress.results.iter().any(|result| {
                    result.media_type == MediaType::Video
                        && matches!(result.save_status, SaveStatus::Pending | SaveStatus::Writing)
                });
            let status = if result.is_some() {
                "succeeded".into()
            } else if saving {
                "saving".into()
            } else {
                progress.summary.status.as_str().into()
            };
            let shot_progress = if result.is_some() {
                Some(100.0)
            } else {
                progress.summary.progress
            };
            let error = if result.is_some() {
                None
            } else {
                progress.final_error.clone()
            };
            let observed_path = result.and_then(|result| result.final_path.clone());
            // 「没有变化」要连落盘路径一起比：片段状态可能早就成了「已保存」，
            // 而文件是用户后来点「恢复片段下载」才补回来的——只比状态/进度会把它当成没变化，
            // 路径永远捡不回来，这个片段就永远进不了成片。
            if shot.status == status
                && shot.progress == shot_progress
                && shot.error == error
                && shot.final_path == observed_path
            {
                continue;
            }
            updates.push(ShotObservation {
                index,
                task_id: task_id.clone(),
                status,
                progress: shot_progress,
                error,
                final_path: observed_path,
                result_index: result.map(|result| result.result_index),
            });
        }
        Ok(updates)
    }
    /// 把观察到的片段状态写回主任务。索引一律按当前记录重新取，
    /// 不能拿旧快照的下标去索引新记录（重新规划会清空镜头列表）。
    fn apply_observations(
        &self,
        id: &str,
        updates: &[ShotObservation],
    ) -> BackendResult<Option<LongVideoJob>> {
        if updates.is_empty() {
            return Ok(None);
        }
        // 观察写回不推进 revision：后台进度不该让用户的乐观锁失效。
        let updated = self.inner.storage.observe_long_video(id, |record| {
            let mut saved = Vec::new();
            for update in updates {
                let Some(shot) = record.job.shots.get_mut(update.index) else {
                    continue;
                };
                // 待重试的片段由用户明确驱动：一条**过期**的观察不能把「等待重试」这个标记
                // 盖回「失败」——否则用户刚点的重试会被前端那次轮询读到的旧状态抹掉，
                // 编排随后又把任务拉回「需要处理」，用户等于白点了一次（还要再花钱重试）。
                if shot.final_path.is_some()
                    || shot.status == "pending_retry"
                    || shot.attempts.last() != Some(&update.task_id)
                {
                    continue;
                }
                shot.status = update.status.clone();
                shot.progress = update.progress;
                shot.error = update.error.clone();
                if let Some(path) = &update.final_path {
                    shot.final_path = Some(path.clone());
                    shot.result_index = update.result_index;
                    shot.status = "succeeded".into();
                    shot.progress = Some(100.0);
                    shot.error = None;
                    saved.push(update.index);
                }
            }
            for index in &saved {
                event(record, format!("第 {} 个片段已保存。", index + 1));
            }
            Ok(())
        })?;
        Ok(Some(updated.job))
    }
    /// 所有画布上仍在进行的长视频编排（跨画布）。
    ///
    /// 界面入口是按画布的：用户切到别的画布后，另一张画布上的编排还在按额度提交片段，
    /// 而「结束编排」按钮在另一张画布上——没有这份清单，用户根本不知道还有钱在花。
    pub fn list_active(&self) -> BackendResult<Vec<LongVideoJob>> {
        Ok(self
            .inner
            .storage
            .long_video_records(None)?
            .into_iter()
            .filter(|record| {
                !matches!(
                    record.job.status,
                    LongVideoStatus::Completed | LongVideoStatus::Cancelled
                )
            })
            .map(|record| record.job)
            .collect())
    }
    /// 结束一张画布上的全部长视频编排，返回被结束的编排数量。
    pub fn cancel_canvas(&self, canvas_id: &str) -> BackendResult<u32> {
        let mut cancelled = 0u32;
        for record in self.inner.storage.long_video_records(Some(canvas_id))? {
            if !matches!(
                record.job.status,
                LongVideoStatus::Completed | LongVideoStatus::Cancelled
            ) {
                // 一条失败不能中断整轮：后面那些编排还在按额度提交片段，
                // 而清空画布之后它们的界面入口已经没了——中断等于让它们继续烧钱。
                match self.control(LongVideoControl {
                    job_id: record.job.id,
                    action: LongVideoAction::Cancel,
                    revision: None,
                    submission_budget: None,
                    shots: None,
                    continuity: None,
                }) {
                    Ok(_) => cancelled += 1,
                    Err(error) => {
                        warn!(
                            "[long-video] 结束画布 {canvas_id} 上的长视频编排失败（继续处理其余编排）：{error}"
                        );
                    }
                }
            }
        }
        Ok(cancelled)
    }
    /// 结束某个节点上的长视频编排，返回被结束的编排数量。
    ///
    /// 画布上删掉生成节点只是前端状态变化，后端并不知道——长视频的 worker 会继续
    /// 每 1.2 秒提交一个新片段（有额度上限，但每一段都是真金白银），而它的界面入口
    /// 是按节点过滤的：节点没了，用户连暂停/结束都点不到，编排成了一个还在烧钱的隐形任务。
    /// 所以删节点时必须显式叫停它。
    pub fn cancel_node(&self, canvas_id: &str, node_key: &str) -> BackendResult<u32> {
        let mut cancelled = 0u32;
        for record in self.inner.storage.long_video_records(Some(canvas_id))? {
            if record.job.source_node_id != node_key {
                continue;
            }
            if !matches!(
                record.job.status,
                LongVideoStatus::Completed | LongVideoStatus::Cancelled
            ) {
                // 与 cancel_canvas 一样：一条失败不能中断整轮。
                match self.control(LongVideoControl {
                    job_id: record.job.id,
                    action: LongVideoAction::Cancel,
                    revision: None,
                    submission_budget: None,
                    shots: None,
                    continuity: None,
                }) {
                    Ok(_) => cancelled += 1,
                    Err(error) => {
                        warn!(
                            "[long-video] 结束节点 {node_key} 上的长视频编排失败（继续处理其余编排）：{error}"
                        );
                    }
                }
            }
        }
        Ok(cancelled)
    }
    fn changed(&self, job: &LongVideoJob) {
        let _ = self.inner.app.emit(
            "long-video:changed",
            json!({"jobId":job.id,"canvasId":job.canvas_id}),
        );
    }

    pub fn start(&self, command: StartLongVideoCommand) -> BackendResult<LongVideoJob> {
        if Uuid::parse_str(&command.request_id).is_err() {
            return Err(invalid("长视频请求缺少有效的提交身份，请重新打开节点。"));
        }
        if command.generation.operation != GenerationOperation::VideoGeneration {
            return Err(invalid("长视频必须使用视频生成模型。"));
        }
        if !(30..=300).contains(&command.target_seconds)
            || command.segment_seconds == 0
            || command.segment_seconds > 300
            || command.duration_parameter.trim().is_empty()
        {
            return Err(invalid(
                "请选择 30～300 秒目标时长，并填写有效的单片段时长。",
            ));
        }
        if command.submission_budget == 0 {
            return Err(invalid("请设置至少一次片段任务额度。"));
        }
        let _dispatch = self
            .inner
            .dispatch
            .lock()
            .map_err(|_| BackendError::Conflict("长视频任务暂时忙，请重试。".into()))?;
        // 冻结视频模型与规划模型：长视频的每个片段都用这份冻结档案提交，运行中不再随模型设置变化。
        let video_profile = self.inner.tasks.freeze_profile(
            &command.generation.provider_connection_id,
            &command.generation.model_definition_id,
            GenerationOperation::VideoGeneration,
        )?;
        let planner_profile = self.inner.tasks.freeze_profile(
            &command.planner_provider_id,
            &command.planner_model_id,
            GenerationOperation::TextGeneration,
        )?;
        let mut command = command;
        // 单片段时长夹到模型真正声明的档位上。镜头数由「目标时长 ÷ 有效单片段时长」得出，
        // 而不是把 300 秒直接塞进一次视频请求——那既不是原站的行为，模型也不会这么生成。
        command.segment_seconds = effective_segment_seconds(
            &video_profile.operation_schema,
            &command.duration_parameter,
            command.segment_seconds,
        );
        // 幂等：同一个提交身份只能对应同一份归一化后的内容（归一化之后再比对，
        // 否则用户填的 7 秒被夹成 6 秒时，重复提交会被误判成内容变了）。
        // stale_request_id：命中一条已结束的旧任务时，先记下它的提交身份，
        // 等到真的要插入新记录前再删（提前删的话，中途报错就等于白删了一条任务）。
        let mut stale_request_id: Option<String> = None;
        match self.inner.storage.long_video_record(&command.request_id) {
            Ok(existing) => {
                if serde_json::to_value(&existing.command)? != serde_json::to_value(&command)? {
                    return Err(BackendError::Conflict(
                        "同一个提交身份对应的长视频内容已经改变，请新建请求。".into(),
                    ));
                }
                // 命中的旧任务已经结束（被取消或已完成）：直接复用它等于什么都没发生——
                // 用户点「生成」只会看到一条「已结束」的任务。
                // 这里先记下来，**真正删除推迟到插入新记录之前**：中间还有「这个节点是否已被
                // 占用」的检查，它失败的话任务就白删了（标题、镜头、事件、成片指针全丢）。
                if matches!(
                    existing.job.status,
                    LongVideoStatus::Completed | LongVideoStatus::Cancelled
                ) {
                    stale_request_id = Some(command.request_id.clone());
                } else {
                    return Ok(existing.job);
                }
            }
            Err(error) => {
                // 只有「记录在、但 JSON 解析不了」才当成废数据：它还占着 request_id 的
                // 唯一约束，不清掉这个节点之后再也起不来长视频。
                // 其它错误（数据库忙等之类）不能当成废数据删——那会把一条好任务删掉。
                if matches!(&error, BackendError::Json(_)) {
                    warn!(
                        "[long-video] 清理无法解析的长视频记录（requestId={}）：{error}",
                        command.request_id
                    );
                    self.inner
                        .storage
                        .delete_long_video_by_request_id(&command.request_id)?;
                } else if !matches!(&error, BackendError::NotFound(_)) {
                    return Err(error);
                }
            }
        }
        if let Some(existing) = self
            .inner
            .storage
            .long_video_records(Some(&command.generation.canvas_id))?
            .into_iter()
            .find(|record| {
                record.job.source_node_id == command.generation.source_node_id
                    && !matches!(
                        record.job.status,
                        LongVideoStatus::Completed | LongVideoStatus::Cancelled
                    )
            })
        {
            return Err(BackendError::validation(
                "这个节点已有长视频任务，请在创作过程中继续或结束原任务。",
                json!({"jobId":existing.job.id}),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let mut record = LongVideoRecord {
            job: LongVideoJob {
                id: id.clone(),
                request_id: command.request_id.clone(),
                canvas_id: command.generation.canvas_id.clone(),
                source_node_id: command.generation.source_node_id.clone(),
                title: command
                    .generation
                    .output_name
                    .clone()
                    .unwrap_or_else(|| "超长视频".into()),
                status: LongVideoStatus::Planning,
                revision: 0,
                target_seconds: command.target_seconds,
                segment_seconds: command.segment_seconds,
                composition_progress: 0.0,
                submission_budget: command.submission_budget,
                reserved_submissions: 0,
                planner_task_id: Uuid::new_v4().to_string(),
                continuity: String::new(),
                shots: Vec::new(),
                output: None,
                error: None,
                yield_reason: None,
                created_at: now,
                updated_at: now,
                events: Vec::new(),
            },
            script_approved: !command.approve_script,
            command,
            video_profile,
            planner_profile,
        };
        event(
            &mut record,
            "已保存创作需求与模型快照，开始规划镜头。文本规划会调用所选文本模型。",
        );
        // 到这一步所有检查都过了，才把那条已结束的旧记录换成新的。
        // 换用同一个事务：插入失败时旧记录还在，不会白丢一条任务（标题、镜头、事件、成片指针）。
        match &stale_request_id {
            Some(request_id) => {
                self.inner
                    .storage
                    .replace_long_video_by_request_id(request_id, &record)?;
            }
            None => self.inner.storage.insert_long_video(&record)?,
        }

        self.changed(&record.job);
        self.spawn(id);
        Ok(record.job)
    }

    pub fn control(&self, command: LongVideoControl) -> BackendResult<LongVideoJob> {
        let _dispatch = self
            .inner
            .dispatch
            .lock()
            .map_err(|_| BackendError::Conflict("长视频任务暂时忙，请重试。".into()))?;
        let mut query_ids = Vec::new();
        let mut retryable = HashSet::new();
        let mut uncertain = 0usize;
        if matches!(command.action, LongVideoAction::RetryFailed) {
            for shot in self
                .inner
                .storage
                .long_video_record(&command.job_id)?
                .job
                .shots
            {
                if let Some(task_id) = shot.attempts.last() {
                    // 子任务从未落地：没有向供应商发过请求，可以安全重试，且不重复占用额度。
                    let Ok(detail) = self.inner.tasks.get(task_id) else {
                        retryable.insert(task_id.clone());
                        continue;
                    };
                    let unsent = detail.calls.iter().all(|call| call.sent_at.is_none());
                    // 回执不明、被中断、被取消：原请求可能已到达供应商甚至还在供应商那边跑着，
                    // 不能自动重提，但用户明确点击重试后可以再发一次。
                    // 否则这个片段是死路——既不能自动重试也不能恢复，用户只能整条任务作废重来。
                    let maybe_still_running = matches!(
                        detail.summary.status,
                        GenerationTaskStatus::Unknown
                            | GenerationTaskStatus::Interrupted
                            | GenerationTaskStatus::Cancelled
                    );
                    if maybe_still_running {
                        uncertain += 1;
                    }
                    // 可重试的终态：明确失败、回执不明、被中断、被取消，
                    // 加上「从没发出过请求」的孤儿（记录建了却没人执行）。
                    // 正在跑的任务不在名单里：重试它们会造成重复提交。
                    // 用户点重试时任务不在运行态，所以此刻还停在「已创建」的任务必然是孤儿，
                    // 不会与正在派发的新任务撞车。
                    let retryable_status = matches!(
                        detail.summary.status,
                        GenerationTaskStatus::Failed
                            | GenerationTaskStatus::Unknown
                            | GenerationTaskStatus::Interrupted
                            | GenerationTaskStatus::Cancelled
                    );
                    if detail.summary.status != GenerationTaskStatus::Succeeded
                        && (retryable_status || unsent)
                    {
                        retryable.insert(task_id.clone());
                    }
                }
            }
        }
        let record=self.inner.storage.mutate_long_video(&command.job_id,|record| {
            if let Some(revision)=command.revision && revision!=record.job.revision { return Err(BackendError::Conflict("创作过程已更新，请读取最新状态后再操作。".into())); }
            if matches!(record.job.status,LongVideoStatus::Completed|LongVideoStatus::Cancelled) && !matches!(command.action,LongVideoAction::Query) {
                return Err(invalid("任务已经结束；已完成片段和成片仍可回收。"));
            }
            match command.action {
                LongVideoAction::Pause=>{
                    if record.job.status.running() { record.job.status=LongVideoStatus::Paused; record.job.yield_reason=Some("user_pause".into()); event(record,"已暂停后续提交；已受理的远端片段继续执行，恢复时回读原任务。" ); }
                }
                LongVideoAction::Cancel=>{ record.job.status=LongVideoStatus::Cancelled; record.job.yield_reason=None; event(record,"已结束长视频编排；已受理的片段任务保留在历史中，成功片段仍可回收。" ); }
                LongVideoAction::Approve=>{
                    if record.job.status!=LongVideoStatus::AwaitingApproval { return Err(invalid("请等待镜头规划完成后确认。")); }
                    if let Some(edits)=&command.shots {
                        if edits.len()!=record.job.shots.len() { return Err(invalid("镜头数量已改变，请重新读取镜头清单。")); }
                        for (shot,edit) in record.job.shots.iter_mut().zip(edits) {
                            if shot.id!=edit.id || edit.prompt.trim().is_empty() { return Err(invalid("每个镜头都需要完整的提示词。")); }
                            shot.title=edit.title.clone(); shot.prompt=edit.prompt.clone();
                        }
                    }
                    if let Some(continuity)=&command.continuity { record.job.continuity=continuity.clone(); }
                    record.script_approved=true;
                    record.job.status=LongVideoStatus::Generating; record.job.error=None; record.job.yield_reason=None;
                    event(record,"镜头清单已确认，开始生成片段。" );
                }
                LongVideoAction::SetBudget=>{
                    let budget=command.submission_budget.ok_or_else(||invalid("请填写片段任务额度。"))?;
                    if budget<record.job.reserved_submissions { return Err(invalid("额度不能少于已经预留的片段任务次数。")); }
                    record.job.submission_budget=budget; event(record,format!("片段任务额度已调整为 {budget} 次。"));
                    // 额度用尽时任务停在「等待增加任务额度」：保存额度就直接继续，
                    // 否则用户必须再点一次「继续原任务」，而只保存不继续的任务会一直冻着。
                    if record.job.status==LongVideoStatus::AwaitingBudget {
                        record.job.status=if record.job.shots.is_empty() {LongVideoStatus::Planning} else if !record.script_approved {LongVideoStatus::AwaitingApproval} else {LongVideoStatus::Generating};
                        record.job.yield_reason=None;
                        event(record,"额度已补充，继续生成片段。");
                    }
                }
                LongVideoAction::Resume=>{
                    if record.job.status.running() { return Ok(()); }
                    if record.job.status==LongVideoStatus::AwaitingApproval { return Err(invalid("请先确认镜头清单。")); }
                    record.job.status=if record.job.shots.is_empty() {LongVideoStatus::Planning} else if !record.script_approved {LongVideoStatus::AwaitingApproval} else if record.job.shots.iter().all(|shot|shot.final_path.is_some()) {LongVideoStatus::Composing} else {LongVideoStatus::Generating};
                    record.job.error=None; record.job.yield_reason=None; event(record,"继续原长视频任务，先核对已有片段身份与结果。" );
                }
                LongVideoAction::RetryFailed=>{
                    if record.job.status.running() { return Err(invalid("请等待当前处理停止后重试失败片段。")); }
                    let mut retried=0;
                    for shot in &mut record.job.shots {
                        if let Some(task_id)=shot.attempts.last() {
                            if retryable.contains(task_id) && shot.final_path.is_none() {
                                shot.status="pending_retry".into(); shot.error=None; shot.progress=None; retried+=1;
                            }
                        }
                    }
                    if retried==0 { return Err(invalid("没有可安全重试的失败片段：回执不明、或请求可能已发出的片段不会自动重提，避免重复付费。")); }
                    record.job.status=LongVideoStatus::Generating; record.job.error=None; record.job.yield_reason=None;
                    event(record,format!("已明确请求重试 {retried} 个失败片段；每个新任务会占用额度并可能产生费用。{}",if uncertain>0 {"其中包含回执不明的片段：原请求可能已到达供应商，重试可能产生重复费用。"}else{""}));
                }
                LongVideoAction::Replan=>{
                    if record.job.status.running() || record.job.reserved_submissions>0 { return Err(invalid("仅能在尚未提交视频片段时重新规划。")); }
                    record.job.planner_task_id=Uuid::new_v4().to_string(); record.job.shots.clear(); record.job.status=LongVideoStatus::Planning;
                    record.script_approved=!record.command.approve_script;
                    record.job.error=None; record.job.yield_reason=None; event(record,"已明确请求重新规划，将新增一次文本模型调用。" );
                }
                LongVideoAction::ComposePartial=>{
                    if record.job.status.running() || !record.job.shots.iter().any(|shot|shot.final_path.is_some()) { return Err(invalid("请先暂停任务，并等待至少一个片段保存成功。")); }
                    // 片段齐全时这不是「部分成片」：用户可能只是要重新合成一次（例如上次合成被中断）。
                    let partial = record.job.shots.iter().any(|shot| shot.final_path.is_none());
                    record.job.status = LongVideoStatus::Composing;
                    record.job.error = None;
                    let message = if partial {
                        "仅使用已成功保存的片段合成，成片将标注为部分成片。"
                    } else {
                        "全部片段都已保存，重新合成完整成片。"
                    };
                    event(record, message);
                }
                LongVideoAction::Query=>{
                    query_ids=record.job.shots.iter().flat_map(|shot|shot.attempts.last().cloned()).collect();
                    event(record,"查询原片段任务，不重新提交生成。" );
                }
            }
            Ok(())
        })?;
        for id in query_ids {
            if let Ok(detail) = self.inner.tasks.get(&id)
                && detail.summary.remote_task_id.is_some()
                && detail.summary.status != GenerationTaskStatus::Succeeded
            {
                let _ = self.inner.tasks.query_remote_now(&id);
            }
        }
        self.changed(&record.job);
        if record.job.status.running() {
            self.spawn(record.job.id.clone());
        }
        Ok(record.job)
    }

    fn spawn(&self, id: String) {
        let Ok(mut running) = self.inner.running.lock() else {
            return;
        };
        if !running.insert(id.clone()) {
            return;
        }
        drop(running);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = service.run(&id).await;
            if let Err(error) = result {
                if let Ok(record) = service.inner.storage.observe_long_video(&id, |record| {
                    needs_attention(
                        record,
                        "处理停止，请查看报错后继续原任务。",
                        Some(error.runtime_record()),
                    );
                    Ok(())
                }) {
                    service.changed(&record.job);
                }
            }
            if let Ok(mut running) = service.inner.running.lock() {
                running.remove(&id);
            }
            // A resume may race with the old worker observing a pause. Do not lose that wake-up.
            if service.get(&id).is_ok_and(|job| job.status.running()) {
                service.spawn(id);
            }
        });
    }

    async fn run(&self, id: &str) -> BackendResult<()> {
        loop {
            let record = self.inner.storage.long_video_record(id)?;
            match record.job.status {
                LongVideoStatus::Planning => self.plan(record).await?,
                LongVideoStatus::Generating => self.advance_segments(record).await?,
                LongVideoStatus::Composing => {
                    self.compose(&record).await?;
                }
                _ => return Ok(()),
            }
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }
    }

    async fn plan(&self, record: LongVideoRecord) -> BackendResult<()> {
        let id = &record.job.id;
        let task_id = &record.job.planner_task_id;
        let segment_seconds = record.command.segment_seconds.max(1);
        let count = record.command.target_seconds.div_ceil(segment_seconds);
        let brief = record
            .command
            .generation
            .prompt
            .iter()
            .map(|segment| match segment {
                PromptSegment::Text { text } => text.clone(),
                PromptSegment::MediaReference {
                    display_name_snapshot,
                    ..
                } => format!("@{display_name_snapshot}"),
            })
            .collect::<Vec<_>>()
            .join("");
        let input = format!(
            "长视频镜头规划请求（不是剧本创作，输出格式一律以系统提示词的 JSON 合同为准）。\n全片目标：{} 秒。请规划恰好 {count} 个连续镜头，每镜头请求生成 {segment_seconds} 秒，最后一镜在成片阶段裁切至目标余量。只输出 JSON 对象。\n用户创作需求：\n{brief}",
            record.command.target_seconds
        );
        let mut references: Vec<PromptReferenceInput> = record
            .command
            .generation
            .explicit_media
            .iter()
            .map(|item| PromptReferenceInput {
                target: item.target.clone(),
                display_name: item.display_name_snapshot.clone(),
            })
            .collect();
        for segment in &record.command.generation.prompt {
            if let PromptSegment::MediaReference {
                target,
                display_name_snapshot,
                ..
            } = segment
            {
                if !references.iter().any(|item| item.target == *target) {
                    references.push(PromptReferenceInput {
                        target: target.clone(),
                        display_name: display_name_snapshot.clone(),
                    });
                }
            }
        }
        let created = {
            let _dispatch = self
                .inner
                .dispatch
                .lock()
                .map_err(|_| invalid("长视频任务暂时忙。"))?;
            if self.get(id)?.status != LongVideoStatus::Planning {
                return Ok(());
            }
            let mut command = record.command.generation.clone();
            command.source_node_id = format!("long-video:{id}:plan");
            command.operation = GenerationOperation::TextGeneration;
            command.provider_connection_id = record.planner_profile.provider.id.clone();
            command.model_definition_id = record.planner_profile.model_definition_id.clone();
            command.parameters = json!({});
            command.prompt = vec![PromptSegment::Text {
                text: input.clone(),
            }];
            command.explicit_media.clear();
            command.generation_count = 1;
            command.video_task_type = None;
            self.inner
                .tasks
                .prepare_frozen_child(task_id, command, &record.planner_profile)?
        };
        if created {
            let deps = PromptVisionDeps {
                app: &self.inner.app,
                storage: &self.inner.storage,
                lifecycle: &self.inner.lifecycle,
                providers: &self.inner.providers,
                assets: &self.inner.assets,
                staging: &self.inner.staging,
                local_base64_assets: &self.inner.base64,
                local_results: &self.inner.results,
            };
            prompt_optimize::run_long_video_planner(&deps, task_id, input, references).await?;
        }
        let detail = self.inner.tasks.get(task_id)?;
        let Some(output) = detail.text_output else {
            self.inner.storage.observe_long_video(id, |record| {
                needs_attention(
                    record,
                    "原文本规划任务尚无完整结果，请查看历史。回执不明时不会自动重新调用。",
                    detail.final_error,
                );
                Ok(())
            })?;
            return Ok(());
        };
        let raw = output.raw_model_output.trim();
        // 逐个候选尝试：第一个能解析成 JSON 的对象才算数（容忍围栏、前后解释、说明文字里的花括号）。
        let mut parsed = None;
        let mut parse_error = String::new();
        for candidate in extract_json_candidates(raw) {
            match serde_json::from_str::<Value>(candidate) {
                Ok(value) => {
                    parsed = Some(value);
                    break;
                }
                Err(error) => {
                    parse_error = error.to_string();
                }
            }
        }
        let Some(value) = parsed else {
            return Err(BackendError::protocol(
                "文本模型没有返回完整镜头清单，请查看规划任务原文或重新规划。",
                json!({"taskId":task_id,"source":parse_error,"excerpt":raw.chars().take(400).collect::<String>()}),
            ));
        };
        let planned = value
            .get("shots")
            .and_then(Value::as_array)
            .filter(|shots| !shots.is_empty() && shots.len() <= 200)
            .ok_or_else(|| invalid("规划结果没有可用的镜头清单，请重新规划。"))?;
        // 镜头数与目标不一致时不直接判死：多出来的镜头按目标时长截断，
        // 少掉的镜头如实记录能覆盖的时长；只有覆盖不到目标的一半才要求重新规划
        // （继续生成只会得到明显偏短的成片，白花片段任务的钱）。
        let needed = count as usize;
        let selected = if planned.len() > needed {
            &planned[..needed]
        } else {
            planned.as_slice()
        };
        let coverage = (selected.len() as u32).saturating_mul(segment_seconds);
        if coverage.saturating_mul(2) < record.command.target_seconds {
            let message = format!(
                "文本模型只规划了 {} 个镜头，按 {segment_seconds} 秒单片段只能覆盖 {coverage} 秒，目标 {} 秒；请重新规划或调整单片段时长。",
                selected.len(),
                record.command.target_seconds
            );
            self.inner.storage.observe_long_video(id, |record| {
                needs_attention(record, &message, None);
                Ok(())
            })?;
            return Ok(());
        }
        let shots = selected
            .iter()
            .enumerate()
            .map(|(index, shot)| {
                let prompt = shot
                    .get("prompt")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| invalid("规划结果中有空镜头提示词，请重新规划。"))?;
                Ok(LongVideoShot {
                    id: Uuid::new_v4().to_string(),
                    title: shot
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("镜头")
                        .into(),
                    prompt: prompt.into(),
                    duration_seconds: segment_seconds.min(
                        record
                            .command
                            .target_seconds
                            .saturating_sub(index as u32 * segment_seconds),
                    ),
                    attempts: Vec::new(),
                    status: "pending".into(),
                    progress: None,
                    result_index: None,
                    final_path: None,
                    error: None,
                })
            })
            .collect::<BackendResult<Vec<_>>>()?;
        let planned_count = planned.len();
        let updated = self.inner.storage.observe_long_video(id, |record| {
            if record.job.planner_task_id != *task_id {
                return Ok(());
            }
            record.job.shots = shots;
            record.job.continuity = value
                .get("continuity")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into();
            if let Some(title) = value.get("title").and_then(Value::as_str) {
                let title = title
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(72)
                    .collect::<String>();
                if !title.trim().is_empty() {
                    record.job.title = title;
                }
            }
            if record.job.status == LongVideoStatus::Planning {
                record.job.status = if record.command.approve_script {
                    LongVideoStatus::AwaitingApproval
                } else {
                    LongVideoStatus::Generating
                };
                record.job.yield_reason = record
                    .command
                    .approve_script
                    .then(|| "script_ask_for_approve".into());
            }
            if planned_count > selected.len() {
                event(
                    record,
                    format!(
                        "模型规划了 {planned_count} 个镜头，已按目标时长保留前 {} 个。",
                        selected.len()
                    ),
                );
            }
            if coverage < record.command.target_seconds {
                let target_seconds = record.command.target_seconds;
                event(
                    record,
                    format!(
                        "按 {segment_seconds} 秒单片段，这 {} 个镜头可覆盖 {coverage} 秒（目标 {target_seconds} 秒）。",
                        selected.len()
                    ),
                );
            }
            event(
                record,
                format!("镜头规划完成，共 {} 个镜头。", selected.len()),
            );
            Ok(())
        })?;
        self.changed(&updated.job);
        Ok(())
    }

    /// 推进片段生成：先回读在途片段，再按并发窗口补充提交。
    ///
    /// 原站是并发排队出片段（客户端有 unlimited_queue / unlimited_concurrency_exceeded 两种挂起原因），
    /// 串行提交会让 5 分钟视频的耗时不可接受。这里按窗口并发，但守住三条底线：
    /// 已受理的远端任务只回读状态、绝不自动重新提交；额度按新建片段任务次数计；
    /// 尾帧承接要求上一镜头先出片，此时窗口恒为 1。
    async fn advance_segments(&self, record: LongVideoRecord) -> BackendResult<()> {
        let id = record.job.id.clone();
        let updates = self.observe_shots(&record)?;
        if !updates.is_empty() {
            if let Some(job) = self.apply_observations(&id, &updates)? {
                self.changed(&job);
            }
        }
        let fresh = self.inner.storage.long_video_record(&id)?;
        if fresh.job.status != LongVideoStatus::Generating {
            return Ok(());
        }
        // 全部片段都已保存：进入合成。
        if !fresh.job.shots.is_empty()
            && fresh.job.shots.iter().all(|shot| shot.final_path.is_some())
        {
            let updated = self.inner.storage.observe_long_video(&id, |record| {
                if record.job.status == LongVideoStatus::Generating {
                    record.job.status = LongVideoStatus::Composing;
                    event(record, "全部片段已保存，开始合成成片。");
                }
                Ok(())
            })?;
            self.changed(&updated.job);
            return Ok(());
        }
        // 有片段明确失败或回执不明：停止继续提交，等用户决定重试或只合成成功部分。
        // 但用户刚点了「重试失败片段」时先让这些重试跑完——否则只要还有一个别的终态片段，
        // 这里就会把任务拉回「需要处理」，重试永远轮不到（点一次重试、循环一次）。
        let has_pending_retry = fresh
            .job
            .shots
            .iter()
            .any(|shot| shot.status == "pending_retry");
        if !has_pending_retry {
            if let Some(index) =
                fresh.job.shots.iter().position(|shot| {
                    shot.final_path.is_none() && terminal_shot_status(&shot.status)
                })
            {
                let message = format!(
                    "第 {} 个片段未完成，请查询原任务；明确失败的片段可单独重试。",
                    index + 1
                );
                let error = fresh.job.shots[index].error.clone();
                let updated = self.inner.storage.observe_long_video(&id, |record| {
                    needs_attention(record, &message, error);
                    Ok(())
                })?;
                self.changed(&updated.job);
                return Ok(());
            }
        }
        let chaining = fresh.command.link_previous_frame;
        let window: u32 = if chaining {
            1
        } else {
            fresh.command.max_concurrent_segments.clamp(1, 8)
        };
        let mut in_flight: u32 = 0;
        for index in 0..fresh.job.shots.len() {
            let Some(shot) = fresh.job.shots.get(index) else {
                continue;
            };
            if shot.final_path.is_some() {
                continue;
            }
            // 尾帧承接要求上一镜头已经出片，片段必须按顺序等待。
            if chaining
                && fresh.job.shots[..index]
                    .iter()
                    .any(|previous| previous.final_path.is_none())
            {
                break;
            }
            match self.slot_of(shot)? {
                ShotSlot::Done => {}
                ShotSlot::Blocked => {}
                ShotSlot::InFlight => {
                    in_flight += 1;
                    if in_flight >= window {
                        break;
                    }
                }
                ShotSlot::Pending => {
                    if in_flight >= window {
                        break;
                    }
                    self.submit_shot(&fresh, index).await?;
                    in_flight += 1;
                    // 额度用尽时状态会变成「等待增加任务额度」，停止继续提交。
                    if self.inner.storage.long_video_record(&id)?.job.status
                        != LongVideoStatus::Generating
                    {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    /// 这个镜头现在处于什么状态。
    fn slot_of(&self, shot: &LongVideoShot) -> BackendResult<ShotSlot> {
        if shot.final_path.is_some() {
            return Ok(ShotSlot::Done);
        }
        // 用户明确要求重试：旧任务的结果不再作数，等着重新提交。
        if shot.status == "pending_retry" {
            return Ok(ShotSlot::Pending);
        }
        let Some(task_id) = shot.attempts.last() else {
            return Ok(ShotSlot::Pending);
        };
        // 预留了身份但子任务从未落地：没有向供应商发过请求，可以直接补交。
        if !self.inner.storage.long_video_child_exists(task_id)? {
            return Ok(ShotSlot::Pending);
        }
        if terminal_shot_status(&shot.status) {
            return Ok(ShotSlot::Blocked);
        }
        Ok(ShotSlot::InFlight)
    }
    /// 为一个片段建立任务身份并提交。额度只在新建片段任务时占用。
    async fn submit_shot(&self, record: &LongVideoRecord, index: usize) -> BackendResult<()> {
        let id = record.job.id.clone();
        let Some(shot) = record.job.shots.get(index) else {
            return Err(invalid("片段不存在。"));
        };
        let shot_id = shot.id.clone();
        let shot_prompt = shot.prompt.clone();
        // 尾帧承接要先抽出上一镜头的尾帧，这一步要读文件，放在提交锁之外。
        let previous_frame = if record.command.link_previous_frame && index > 0 {
            match record
                .job
                .shots
                .get(index - 1)
                .and_then(|previous| previous.final_path.clone())
            {
                Some(path) => Some(self.last_frame(record, &path, index - 1).await?),
                None => None,
            }
        } else {
            None
        };
        // 原身份从未落地时复用它：额度在预留时已经计过，不重复占用。
        let reuse = match shot.attempts.last() {
            Some(task_id) if !self.inner.storage.long_video_child_exists(task_id)? => {
                Some(task_id.clone())
            }
            _ => None,
        };
        let _dispatch = self
            .inner
            .dispatch
            .lock()
            .map_err(|_| invalid("长视频任务暂时忙。"))?;
        let reserved = self.inner.storage.observe_long_video(&id, |record| {
            if record.job.status != LongVideoStatus::Generating {
                return Ok(());
            }
            if reuse.is_none() {
                if record.job.reserved_submissions >= record.job.submission_budget {
                    record.job.status = LongVideoStatus::AwaitingBudget;
                    record.job.yield_reason = Some("submission_budget".into());
                    event(record, "已达到片段任务额度，请调整额度后继续。");
                    return Ok(());
                }
                record.job.reserved_submissions += 1;
                let Some(shot) = record.job.shots.get_mut(index) else {
                    return Err(invalid("片段不存在。"));
                };
                shot.attempts.push(Uuid::new_v4().to_string());
            }
            {
                let Some(shot) = record.job.shots.get_mut(index) else {
                    return Err(invalid("片段不存在。"));
                };
                shot.status = "created".into();
                shot.error = None;
                shot.progress = None;
            }
            if reuse.is_some() {
                event(
                    record,
                    format!("第 {} 个片段沿用原任务身份重新提交。", index + 1),
                );
            } else {
                event(
                    record,
                    format!("已为第 {} 个片段预留任务身份与额度。", index + 1),
                );
            }
            Ok(())
        })?;
        if reserved.job.status != LongVideoStatus::Generating {
            self.changed(&reserved.job);
            return Ok(());
        }
        let task_id = reserved
            .job
            .shots
            .get(index)
            .and_then(|shot| shot.attempts.last().cloned())
            .ok_or_else(|| invalid("片段缺少任务身份。"))?;
        let mut command = reserved.command.generation.clone();
        command.source_node_id = format!("long-video:{id}:{shot_id}");
        command.output_name = Some(format!("{} - 镜头 {}", reserved.job.title, index + 1));
        command.generation_count = 1;
        let mut parameters = command.parameters.as_object().cloned().unwrap_or_default();
        parameters.insert(
            reserved.command.duration_parameter.clone(),
            json!(reserved.command.segment_seconds),
        );
        command.parameters = Value::Object(parameters);
        command.prompt.insert(0,PromptSegment::Text{text:format!("只生成第 {} / {} 个镜头，单片段 {} 秒。\n全片连续性：{}\n本镜头：{shot_prompt}\n以下为全片创作参考，按本镜头范围执行：\n",index+1,reserved.job.shots.len(),reserved.command.segment_seconds,reserved.job.continuity)});
        if let Some(path) = previous_frame
            && !command
                .explicit_media
                .iter()
                .any(|input| input.role == "first_frame")
        {
            let max_position = command
                .explicit_media
                .iter()
                .filter(|input| input.target.media_type() == MediaType::Image)
                .filter_map(|input| input.type_position)
                .chain(command.prompt.iter().filter_map(|input| match input {
                    PromptSegment::MediaReference {
                        target,
                        type_position,
                        ..
                    } if target.media_type() == MediaType::Image => *type_position,
                    _ => None,
                }))
                .max()
                .unwrap_or(0);
            let max_content = command
                .explicit_media
                .iter()
                .filter_map(|input| input.content_index)
                .chain(command.prompt.iter().filter_map(|input| match input {
                    PromptSegment::MediaReference { content_index, .. } => *content_index,
                    _ => None,
                }))
                .max()
                .unwrap_or(0);
            command.explicit_media.push(ExplicitMediaInput {
                target: MediaReferenceTarget::LocalFile {
                    path,
                    media_type: MediaType::Image,
                    canvas_node_key: Some(format!("long-video:{id}:continuity:{index}")),
                },
                role: "first_frame".into(),
                display_name_snapshot: "上一镜头尾帧".into(),
                type_position: Some(max_position + 1),
                content_index: Some(max_content + 1),
            });
        }
        match self
            .inner
            .tasks
            .prepare_frozen_child(&task_id, command, &reserved.video_profile)
        {
            Ok(true) => self.inner.tasks.dispatch_frozen_child(&task_id),
            Ok(false) => {
                // 子任务已存在：说明它已经被创建过（并发重复提交或上一轮留下的），
                // 不能重新派发（会重复付费）。它的状态由观察路径负责；
                // 真正没人执行的孤儿由观察路径按宽限期判定为失败。
            }
            Err(error) => {
                // 子任务没有落地：明确标记失败，用户改完设置可以单独重试，且不重复占用额度。
                let detail = error.runtime_record();
                let message = "片段任务没有提交成功，请检查模型参数后重试该片段。";
                let updated = self.inner.storage.observe_long_video(&id, |record| {
                    {
                        let Some(shot) = record.job.shots.get_mut(index) else {
                            return Ok(());
                        };
                        shot.status = "failed".into();
                        shot.error = Some(detail.clone());
                    }
                    needs_attention(
                        record,
                        message,
                        Some(json!({"message":message,"source":detail})),
                    );
                    Ok(())
                })?;
                self.changed(&updated.job);
                return Ok(());
            }
        }
        // 这个镜头重做后它的尾帧就变了：删掉缓存的尾帧，下一个镜头重新抽，
        // 否则会拿上一版的尾帧去承接，视觉上是接错片段。
        //
        // 这里必须同步删除：上面的 dispatch 锁是非 Send 的 std::sync::MutexGuard，
        // 跨 await 持有会让整个 worker 的 future 失去 Send，tauri 的 spawn 收不了它。
        // 删的是一个本地小文件，同步 unlink 的开销可以忽略。
        let _ = std::fs::remove_file(
            self.work_directory(record)
                .join(format!("tail-{index}.png")),
        );
        self.changed(&reserved.job);
        Ok(())
    }
}
