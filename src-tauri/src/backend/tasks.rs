use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use rand::Rng as _;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Emitter as _};
use tauri_plugin_log::log::{error, info, warn};
use tauri_plugin_notification::NotificationExt as _;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    gateway_profile::{DEFAULT_VIDEO_POLL_INTERVAL, GatewayPollCadence, GatewayProfile},
    local_results::LocalResultService,
    media::{MediaResolver, ResolvedBundle},
    model_schema::{
        RequestDialect, apply_request_dialect, atlascloud_image_operation_schema_for,
        default_model_schema, is_seedance_draft_video_model, normalize_parameters,
        refresh_pixverse_video_defaults,
    },
    provider::{GenerationObservation, GenerationSubmission, ProviderRuntime, parse_token_usage},
    staging::StagingService,
    storage::{
        GenerationLifecycleFact, GenerationOperationalEvent, GenerationRemoteObservation,
        GenerationTaskLifecycle, NewTask, PersistedTaskTransition, PersistedTaskTransitionEvent,
        Storage, TaskExecutionRecord,
    },
    types::{
        GenerationOperation, GenerationResultRecord, GenerationTaskDetail, GenerationTaskListQuery,
        GenerationTaskPage, GenerationTaskProgress, GenerationTaskStatus, RecoveryReport,
        StartGenerationCommand,
    },
};

const MAX_AUTOMATIC_RETRIES: u32 = 3;
#[path = "tasks/long_video.rs"]
mod long_video;
pub(crate) use long_video::FrozenGenerationProfile;
const WAN_VIDEO_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// 视频任务的轮询策略：家族任务按网关家族档案的节奏（`GatewayProfile::poll_cadence`），
/// 其余任务按模型推导的恒定间隔（万相系 15 秒，其他 5 秒）。
#[derive(Clone, Copy)]
struct VideoPollingPolicy {
    family: Option<GatewayProfile>,
    cadence: GatewayPollCadence,
}

impl VideoPollingPolicy {
    fn for_model(model_id: Option<&str>, dialect: RequestDialect) -> Self {
        let family = GatewayProfile::for_dialect(model_id, dialect);
        let cadence = family
            .map(GatewayProfile::poll_cadence)
            .unwrap_or_else(|| GatewayPollCadence::uniform(video_poll_interval(model_id)));
        Self { family, cadence }
    }

    fn next_wait(self, elapsed: std::time::Duration) -> Option<std::time::Duration> {
        self.cadence.next_poll_wait(elapsed)
    }
}

#[derive(Default)]
struct VideoPollRegistry {
    slots: Mutex<HashMap<String, Weak<VideoPollSlot>>>,
}

#[derive(Default)]
struct VideoPollSlot {
    gate: Arc<tokio::sync::Mutex<()>>,
    wake: tokio::sync::Notify,
}

impl VideoPollRegistry {
    fn slot(&self, task_id: &str) -> BackendResult<Arc<VideoPollSlot>> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| BackendError::Conflict("video polling registry is unavailable".into()))?;
        slots.retain(|_, slot| slot.strong_count() > 0);
        if let Some(slot) = slots.get(task_id).and_then(Weak::upgrade) {
            return Ok(slot);
        }
        let slot = Arc::new(VideoPollSlot::default());
        slots.insert(task_id.to_string(), Arc::downgrade(&slot));
        Ok(slot)
    }
}

/// 生成任务的运行时取消位。
///
/// 库里的 `cancelled` 状态负责跨重启收敛；这里的 AtomicBool 负责让当前进程里
/// 正在跑的轮询与提交尽快停下，不必等下一个轮询周期。
#[derive(Default)]
struct CancellationRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CancellationRegistry {
    /// 任务入队时登记取消位：「没取消」与「已取消」必须是同一个读法。
    fn register(&self, task_id: &str) {
        let mut flags = self.lock_flags();
        flags
            .entry(task_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    }

    /// 置位取消：让正在跑的轮询与提交尽快看到。
    fn request_cancel(&self, task_id: &str) {
        let mut flags = self.lock_flags();
        flags
            .entry(task_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self, task_id: &str) -> bool {
        self.lock_flags()
            .get(task_id)
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }

    fn lock_flags(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        // 取消位只是一道快判据：锁中毒时不该让整个任务管线停摆。
        self.flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct SuccessfulSubmission {
    attempt_id: String,
    call_id: String,
    submission: GenerationSubmission,
    tokens: Option<super::types::TokenUsage>,
}

struct SuccessfulObservation {
    attempt_id: String,
    call_id: String,
    observation: GenerationObservation,
    tokens: Option<super::types::TokenUsage>,
}

/// 冻结任务时以绑定的远端模型 ID 为准。旧库中的 model_definitions 可能仍存着
/// Seedance 通用档案；已注册家族必须使用已知的专属协议，不能让旧档案决定
/// 素材暂存或付费请求的形状。其他型号和操作继续沿用已保存的自定义 Schema。
fn operation_schema_for_start(
    stored_operations: &Value,
    operation: GenerationOperation,
    remote_model_id: Option<&str>,
    dialect: RequestDialect,
) -> Option<Value> {
    if operation == GenerationOperation::VideoGeneration && dialect == RequestDialect::FzyAi {
        let mut refreshed = stored_operations.clone();
        apply_request_dialect(&mut refreshed, remote_model_id.unwrap_or_default(), dialect);
        return refreshed.get(operation.as_str()).cloned();
    }
    /*
     * Atlas Cloud 的视频契约（Vidu Q4 参考图生视频）同样按模型成员与操作确定：
     * 提交端点是 `/api/v1/model/generateVideo`，参考图走 `reference_images`、
     * 参考音频走 `reference_audios`，参数表也整张换过。这里按**请求的操作**
     * 重新给出 Atlas 档案，而不是照抄存档里的槽位——存档可能还是旧版本按模型名
     * 推导出的魔芋 Vidu 契约（`/v1/video/generations` + 顶层 `images`），
     * 照抄会把付费请求发到 Atlas 上并不存在的路径上。
     */
    if operation == GenerationOperation::VideoGeneration
        && dialect == RequestDialect::AtlasCloud
    {
        let mut refreshed = stored_operations.clone();
        apply_request_dialect(&mut refreshed, remote_model_id.unwrap_or_default(), dialect);
        return refreshed.get(operation.as_str()).cloned();
    }
    /*
     * Atlas Cloud 的图片契约按模型家族与操作确定：编辑成员只有「参考图编辑」，
     * 文生图成员只有「文生图」。这里按**请求的操作**重新给出 Atlas 档案，
     * 而不是照抄存档里的槽位——存档可能是旧版本按通用网关写的（Atlas 上没有
     * `/v1/images/generations` 这个端点），照抄会把付费请求发到不存在的路径上。
     */
    if matches!(
        operation,
        GenerationOperation::TextToImage | GenerationOperation::ImageToImage
    ) && dialect == RequestDialect::AtlasCloud
        && let Some(schema) = remote_model_id
            .and_then(|model_id| atlascloud_image_operation_schema_for(model_id, operation))
    {
        return Some(schema);
    }
    if operation == GenerationOperation::VideoGeneration
        && let Some(model_id) = remote_model_id
        && let Some(family) = GatewayProfile::from_model_id(model_id)
    {
        match family {
            // PixVerse 的已知合同属于兼容网关；同名模型在其他连接上，不能把
            // 供应商自定义的原生路径替换成魔芋路径。
            GatewayProfile::PixVerse if dialect == RequestDialect::OpenAiCompatible => {
                if stored_operations.get(operation.as_str()).is_none() {
                    return default_model_schema(model_id, &[operation])
                        .get(operation.as_str())
                        .cloned();
                }
                let mut refreshed = stored_operations.clone();
                refresh_pixverse_video_defaults(&mut refreshed, model_id);
                return refreshed.get(operation.as_str()).cloned();
            }
            // 按次与 RD 必须整体使用代码内的规范契约。
            GatewayProfile::Sp25PerUse | GatewayProfile::RdVideo => {
                return default_model_schema(model_id, &[operation])
                    .get(operation.as_str())
                    .cloned();
            }
            _ => {}
        }
    }
    stored_operations.get(operation.as_str()).cloned()
}

#[derive(Clone)]
pub struct GenerationTaskService {
    app: AppHandle,
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    providers: ProviderRuntime,
    media: MediaResolver,
    local_results: LocalResultService,
    staging: StagingService,
    video_polls: Arc<VideoPollRegistry>,
    draft_promotions: Arc<Mutex<()>>,
    cancellations: Arc<CancellationRegistry>,
}

impl GenerationTaskService {
    pub fn new(
        app: AppHandle,
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        providers: ProviderRuntime,
        media: MediaResolver,
        local_results: LocalResultService,
        staging: StagingService,
    ) -> Self {
        Self {
            app,
            storage,
            lifecycle,
            providers,
            media,
            local_results,
            staging,
            video_polls: Arc::new(VideoPollRegistry::default()),
            draft_promotions: Arc::new(Mutex::new(())),
            cancellations: Arc::new(CancellationRegistry::default()),
        }
    }

    pub fn start(&self, command: StartGenerationCommand) -> BackendResult<String> {
        let operation = command.operation;
        let source_node_id = command.source_node_id.clone();
        match self.start_inner(command) {
            Ok(task_id) => Ok(task_id),
            Err(error) => {
                let payload = error.payload();
                warn!(
                    "[generation] 任务创建失败（未创建本地任务）: sourceNode={source_node_id}, operation={}, 错误类型={}, 详情={}",
                    operation.as_str(),
                    payload.kind,
                    payload.message
                );
                Err(error)
            }
        }
    }

    /// 找到已接受的客户端任务身份时，只允许返回同一份请求的原任务。
    fn existing_client_task(&self, task_id: &str, request_hash: &str) -> BackendResult<Option<String>> {
        match self.storage.get_task_detail(task_id) {
            Ok(detail) => {
                if detail.logical_request.get("clientRequestHash").and_then(Value::as_str) == Some(request_hash) {
                    Ok(Some(task_id.to_string()))
                } else {
                    Err(BackendError::Conflict("生成任务身份已被另一份请求使用，请重新创建批次。".into()))
                }
            }
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn start_inner(&self, mut command: StartGenerationCommand) -> BackendResult<String> {
        validate_start_command(&command)?;
        let client_identity = if let Some(raw_id) = command.client_task_id.as_deref() {
            let parsed = Uuid::parse_str(raw_id).map_err(|_| BackendError::validation(
                "批量任务身份无效", json!({ "clientTaskId": raw_id }),
            ))?;
            let task_id = parsed.to_string();
            let request_hash = hex::encode(Sha256::digest(serde_json::to_vec(&command)?));
            if let Some(existing) = self.existing_client_task(&task_id, &request_hash)? {
                return Ok(existing);
            }
            Some((task_id, request_hash))
        } else {
            None
        };
        let provider = self
            .storage
            .get_provider_connection(&command.provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider.id }),
            ));
        }
        let binding = self.storage.get_binding(
            &command.provider_connection_id,
            &command.model_definition_id,
        )?;
        if !binding.enabled || !binding.enabled_operations.contains(&command.operation) {
            return Err(BackendError::validation(
                "provider does not expose this model operation",
                json!({
                    "providerConnectionId": command.provider_connection_id,
                    "modelDefinitionId": command.model_definition_id,
                    "operation": command.operation,
                    "binding": binding
                }),
            ));
        }
        let model = self
            .storage
            .list_model_definitions()?
            .into_iter()
            .find(|model| model.id == command.model_definition_id)
            .ok_or_else(|| {
                BackendError::NotFound(format!("model definition {}", command.model_definition_id))
            })?;
        let mut operation_schema = operation_schema_for_start(
            &model.operations,
            command.operation,
            binding.remote_model_id.as_deref(),
            RequestDialect::for_adapter(&provider.adapter_id),
        )
        .ok_or_else(|| {
            BackendError::validation(
                "model definition does not declare this operation",
                json!({
                    "modelDefinitionId": model.id,
                    "operation": command.operation,
                    "operations": model.operations
                }),
            )
        })?;
        if command.operation == GenerationOperation::VideoGeneration
            && let Some(model_id) = binding.remote_model_id.as_deref()
            && is_seedance_draft_video_model(model_id)
        {
            let mut schema =
                default_model_schema(model_id, &[GenerationOperation::VideoGeneration]);
            apply_request_dialect(
                &mut schema,
                model_id,
                RequestDialect::for_adapter(&provider.adapter_id),
            );
            operation_schema = schema["video_generation"].clone();
            if command.parameters.get("draft_task_id").is_some() {
                return Err(BackendError::validation(
                    "请从已成功的草稿样片历史详情生成正片",
                    json!({ "sourceNodeId": command.source_node_id }),
                ));
            }
        }
        if !operation_schema.is_object() {
            return Err(BackendError::validation(
                "model operation schema must be a JSON object",
                json!({
                    "modelDefinitionId": model.id,
                    "operation": command.operation,
                    "operationSchema": operation_schema
                }),
            ));
        }
        let supplied_parameters = if command.parameters.is_null() {
            json!({})
        } else {
            command.parameters.clone()
        };
        command.parameters = normalize_parameters(&operation_schema, &supplied_parameters)?;
        if let Some(model_id) = binding.remote_model_id.as_deref() {
            super::canvas_model_capabilities::validate_operation(&provider.adapter_id, model_id, command.operation)?;
            if command.operation == GenerationOperation::VideoGeneration {
                if operation_schema.pointer("/request/mediaEncoding").and_then(Value::as_str) == Some("veo_image_urls")
                    && let Some(version) = super::canvas_model_capabilities::video_capabilities(&provider.adapter_id, model_id)
                        .and_then(|policy| policy.veo.as_deref())
                {
                    operation_schema["request"]["veoMediaVersion"] = json!(version);
                }
                super::media::validate_new_video_request(&provider.adapter_id, model_id, &mut command, &operation_schema)?;
            }
        }
        command.model_operation_schema_snapshot = Some(operation_schema);
        // 模型绑定指定了令牌分组时，用该分组的密钥；否则用供应商主 API Key。
        // 先解析出密钥引用并校验其可用（resolve 会读取凭据），再冻结进任务快照。
        let task_api_key_ref = self.storage.resolve_binding_credential_ref(
            &command.provider_connection_id,
            binding.token_group.as_deref(),
        )?;
        self.providers
            .resolve_token_group(&provider.id, binding.token_group.as_deref())?;

        let remote_model_id = binding
            .remote_model_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                BackendError::validation(
                    "the selected provider/model binding has no saved remote model id",
                    json!({
                        "providerConnectionId": command.provider_connection_id,
                        "modelDefinitionId": command.model_definition_id
                    }),
                )
            })?;
        let remote_model_id = if remote_model_id == super::model_schema::ATLASCLOUD_REGION_EDIT_BINDING {
            super::model_schema::ATLASCLOUD_REGION_EDIT_MODEL
        } else {
            remote_model_id
        };
        super::video_storyboard::validate(&command.parameters, remote_model_id, command.prompt.len())?;
        let video_effects = super::video_effects::apply(&mut command)?;
        let mut logical_request = serde_json::to_value(&command)?;
        if let Some(effects) = video_effects { logical_request["videoEffectsSnapshot"] = effects; }
        if let Some((_, request_hash)) = &client_identity {
            logical_request["clientRequestHash"] = json!(request_hash);
        }
        let task_id = client_identity.as_ref().map(|(id, _)| id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
        let creation = self.lifecycle.create(NewTask {
            id: &task_id,
            canvas_id: &command.canvas_id,
            source_node_id: &command.source_node_id,
            operation: command.operation,
            provider: &provider,
            api_key_ref: &task_api_key_ref,
            model_definition_id: &command.model_definition_id,
            remote_model_id: Some(remote_model_id),
            logical_request: &logical_request,
        });
        if let Err(error) = creation {
            // 同一身份并发创建时，数据库主键只允许一个成功；失败方回读原任务。
            if let Some((_, request_hash)) = &client_identity {
                if let Some(existing) = self.existing_client_task(&task_id, request_hash)? {
                    return Ok(existing);
                }
            }
            return Err(error);
        }
        self.cancellations.register(&task_id);
        info!(
            "[generation] 任务已创建，即将进入后台执行: taskId={task_id}, canvasId={}, sourceNode={}, operation={}, provider={}（{}）, model={}, 远程模型={remote_model_id}, 提示词片段={} 个, 显式媒体输入={} 个, 生成数量={}",
            command.canvas_id,
            command.source_node_id,
            command.operation.as_str(),
            provider.display_name,
            provider.id,
            command.model_definition_id,
            command.prompt.len(),
            command.explicit_media.len(),
            command.generation_count
        );
        self.emit(
            "generation:created",
            &json!({ "taskId": task_id, "sourceNodeId": command.source_node_id }),
        );
        let service = self.clone();
        let spawned_task_id = task_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.execute(&spawned_task_id).await {
                let _ = service.finish_with_execution_error(&spawned_task_id, error);
            }
        });
        Ok(task_id)
    }

    pub fn list(&self, query: GenerationTaskListQuery) -> BackendResult<GenerationTaskPage> {
        self.storage.list_tasks(&query)
    }

    pub fn get(&self, task_id: &str) -> BackendResult<GenerationTaskDetail> {
        self.storage.get_task_detail(task_id)
    }

    pub fn get_progress(&self, task_id: &str) -> BackendResult<GenerationTaskProgress> {
        self.storage.get_task_progress(task_id)
    }

    /// 用户主动取消在途生成任务。
    ///
    /// 先置运行时取消位（让正在跑的轮询与提交尽快停下），再把任务落成
    /// `cancelled` 终态。终态任务不动：已经成功/失败的历史不该被改写。
    pub fn cancel(&self, task_id: &str) -> BackendResult<GenerationTaskDetail> {
        let task = self.storage.get_task_execution(task_id)?;
        if task.status == GenerationTaskStatus::Cancelled {
            return self.get(task_id);
        }
        if task.status.is_terminal() {
            return Err(BackendError::Conflict(format!(
                "生成任务已经结束（{}），无法取消。",
                task_status_label(task.status)
            )));
        }
        self.cancellations.request_cancel(task_id);
        // 唤醒正在等待的轮询，让它立刻看到取消位，而不是干等一个轮询周期。
        if let Ok(slot) = self.video_polls.slot(task_id) {
            slot.wake.notify_one();
        }
        let reason = json!({
            "kind": "generation_cancelled",
            "message": "任务已被取消，不再继续查询供应商或保存产物。",
        });
        match self.commit_fact(
            task_id,
            GenerationLifecycleFact::CancellationRequested { reason },
        ) {
            Ok(()) => {}
            Err(error) => {
                // 取消与收尾并发：任务可能刚好跑完了，以库里的事实为准。
                let current = self.storage.get_task_execution(task_id)?;
                if current.status.is_terminal() {
                    return Err(BackendError::Conflict(format!(
                        "生成任务已经结束（{}），无法取消。",
                        task_status_label(current.status)
                    )));
                }
                return Err(error);
            }
        }
        info!("[generation] 生成任务已取消: taskId={task_id}");
        self.get(task_id)
    }

    /// 画布被删除时收敛在途任务：先置运行时取消位，让轮询尽快停下。
    ///
    /// 落库由 [`Storage::delete_canvas_document`] 在删除画布的同一个事务里完成，
    /// 终态历史任务保持原样。
    pub fn cancel_canvas_tasks(&self, canvas_id: &str) -> BackendResult<Vec<String>> {
        let task_ids = self
            .storage
            .list_nonterminal_task_ids_for_canvas(canvas_id)?;
        for task_id in &task_ids {
            self.cancellations.request_cancel(task_id);
            if let Ok(slot) = self.video_polls.slot(task_id) {
                slot.wake.notify_one();
            }
        }
        if !task_ids.is_empty() {
            info!(
                "[generation] 画布删除：已请求取消 {} 个在途生成任务: canvasId={canvas_id}",
                task_ids.len()
            );
        }
        Ok(task_ids)
    }

    /// 轮询/提交前的取消检查。
    ///
    /// 运行时取消位是进程内的快判据；库里的 `cancelled` 是跨重启的落点。
    /// 返回 true 表示这个任务不要再向供应商发起任何请求。
    fn stop_for_cancellation(&self, task_id: &str) -> BackendResult<bool> {
        let status = self.storage.get_task_execution(task_id)?.status;
        if status == GenerationTaskStatus::Cancelled {
            return Ok(true);
        }
        if !self.cancellations.is_cancelled(task_id) {
            return Ok(false);
        }
        if status.is_terminal() {
            // 任务刚好在取消落库前跑完了：以库里的事实为准，不再追问。
            return Ok(true);
        }
        let reason = json!({
            "kind": "generation_cancelled",
            "message": "任务已被取消，不再继续查询供应商或保存产物。",
        });
        match self.commit_fact(
            task_id,
            GenerationLifecycleFact::CancellationRequested { reason },
        ) {
            Ok(()) => {
                info!("[generation] 任务已取消，停止轮询与提交: taskId={task_id}");
                Ok(true)
            }
            Err(error) => {
                // 取消与收尾并发时任务可能已经落成别的终态：以库里的事实为准。
                if self
                    .storage
                    .get_task_execution(task_id)?
                    .status
                    .is_terminal()
                {
                    Ok(true)
                } else {
                    Err(error)
                }
            }
        }
    }

    pub fn promote_seedance_draft(&self, source_task_id: &str) -> BackendResult<String> {
        let _guard = self.draft_promotions.lock().map_err(|_| {
            BackendError::Conflict("draft promotion registry is unavailable".into())
        })?;
        let source = self.storage.get_task_execution(source_task_id)?;
        let observed_response = self.storage.last_successful_observe_response(source_task_id)?;
        let prepared = super::seedance_draft::prepare_promotion(&source, observed_response.as_deref())?;
        if let Some(task_id) = self.storage.seedance_draft_final_task_id(source_task_id)? {
            return Ok(task_id);
        }
        // Validate the original credential scope before persisting a new task.
        self.providers.resolve_frozen(&source)?;
        validate_start_command(&prepared.command)?;
        let task_id = Uuid::new_v4().to_string();
        self.lifecycle.create(NewTask {
            id: &task_id,
            canvas_id: &prepared.command.canvas_id,
            source_node_id: &prepared.command.source_node_id,
            operation: GenerationOperation::VideoGeneration,
            provider: &prepared.provider,
            api_key_ref: &source.api_key_ref_snapshot,
            model_definition_id: &source.model_definition_id,
            remote_model_id: Some(&prepared.remote_model_id),
            logical_request: &prepared.logical_request,
        })?;
        self.cancellations.register(&task_id);
        self.emit(
            "generation:created",
            &json!({
                "taskId": task_id, "sourceNodeId": prepared.command.source_node_id,
                "seedanceDraftSourceTaskId": source_task_id,
            }),
        );
        let service = self.clone();
        let spawned_task_id = task_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.execute(&spawned_task_id).await {
                let _ = service.finish_with_execution_error(&spawned_task_id, error);
            }
        });
        Ok(task_id)
    }

    pub fn recover(&self) -> BackendResult<RecoveryReport> {
        let tasks = self.storage.list_nonterminal_tasks()?;
        let mut report = RecoveryReport {
            recovered_video_tasks: 0,
            interrupted_image_tasks: 0,
            resumed_local_saves: 0,
            failed_to_recover: Vec::new(),
        };
        for task in tasks {
            let resumable = task
                .remote_task_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
                && matches!(
                    task.operation,
                    GenerationOperation::VideoGeneration
                        | GenerationOperation::TextToImage
                        | GenerationOperation::ImageToImage
                );
            if resumable {
                if matches!(
                    task.status,
                    GenerationTaskStatus::Created
                        | GenerationTaskStatus::Submitting
                        | GenerationTaskStatus::RetryWait
                ) {
                    if let Err(error) = self.commit_fact(
                        &task.id,
                        GenerationLifecycleFact::RecoveryRemoteResumed {
                            remote_task_id: task
                                .remote_task_id
                                .clone()
                                .expect("checked remote task identity"),
                        },
                    ) {
                        report
                            .failed_to_recover
                            .push(format!("{}: {}", task.id, error));
                        continue;
                    }
                }
                report.recovered_video_tasks += 1;
                let kind = if task.operation == GenerationOperation::VideoGeneration {
                    "视频"
                } else {
                    "图片"
                };
                info!(
                    "[generation] 启动恢复: 恢复{kind}任务轮询: taskId={}, remoteTaskId={}",
                    task.id,
                    task.remote_task_id.as_deref().unwrap_or("<缺失>")
                );
                let service = self.clone();
                let task_id = task.id.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = service.poll_video(&task_id).await {
                        let _ = service.finish_with_execution_error(&task_id, error);
                    }
                });
            } else {
                let detail = self.storage.get_task_detail(&task.id)?;
                let request_may_have_been_sent =
                    detail.calls.iter().any(|call| call.sent_at.is_some());
                let status = if request_may_have_been_sent {
                    GenerationTaskStatus::Unknown
                } else {
                    GenerationTaskStatus::Interrupted
                };
                warn!(
                    "[generation] 启动恢复: 非可恢复任务标记终态: taskId={}, operation={}, 标记状态={}, 请求可能已到达供应商={request_may_have_been_sent}",
                    task.id,
                    task.operation.as_str(),
                    status.as_str()
                );
                let error = json!({
                    "kind": "process_interrupted",
                    "message": "application restarted while a non-recoverable local request was incomplete",
                    "requestMayHaveReachedProvider": request_may_have_been_sent
                });
                if let Err(recovery_error) = self.commit_fact(
                    &task.id,
                    GenerationLifecycleFact::RecoveryTerminated {
                        conclusion: status,
                        error,
                    },
                ) {
                    report
                        .failed_to_recover
                        .push(format!("{}: {}", task.id, recovery_error));
                } else {
                    report.interrupted_image_tasks += 1;
                }
            }
        }

        for mut job in self.storage.list_recoverable_staging_jobs()? {
            job.status = match job.status {
                // 已完成对象存储上传、可以继续导入的，保持不变。
                super::types::StagingStatus::Staged => job.status,
                /*
                 * 导入中断：
                 *  - 海外路径（`overseas_db_id` 已有）→ 供应商侧已受理，可以续查，保持；
                 *  - 国内路径 → 进程是在「写 importing」与「写 active」两次独立事务
                 *    之间被终止的，**没有任何恢复入口**（`resume_import_job` 要求
                 *    `overseas_db_id.is_some()`），行会永远卡在「导入中」，
                 *    用户重试还会生成重复的云端素材。置为可重试态，让它能被看到与重做。
                 */
                super::types::StagingStatus::Importing if job.overseas_db_id.is_some() => {
                    job.status
                }
                super::types::StagingStatus::Importing => super::types::StagingStatus::Interrupted,
                /*
                 * 清理中断：删除对象没做完（网络失败/进程被杀）。保持 `Cleaning` 会让
                 * 任务永远显示「清理中」，而清理本身已不可恢复 → 落成失败更诚实。
                 */
                super::types::StagingStatus::Cleaning => super::types::StagingStatus::Failed,
                _ => super::types::StagingStatus::Interrupted,
            };
            job.updated_at = super::storage::now_ms();
            let _ = self.storage.update_staging_job(&job);
        }

        /*
         * 暂存对象回收：进程崩溃、被杀、删除请求失败，都会留下没人删除的 TOS
         * 中转对象（`interrupted` / `in_use` / `failed` 三条死路状态此前全都没有
         * 删除路径，每次泄漏一整个素材）。
         *
         * 回收是纯后台动作：失败只记日志并按退避重试，不阻塞启动、不影响应用可用。
         */
        let staging = self.staging.clone();
        tauri::async_runtime::spawn(async move {
            staging.run_staging_cleanup_loop().await;
        });

        for result in self.lifecycle.recover_interrupted_results()? {
            report.resumed_local_saves += 1;
            info!(
                "[generation] 启动恢复: 恢复中断的本地保存: taskId={}, resultIndex={}, mediaType={}",
                result.task_id,
                result.result_index,
                result.media_type.as_str()
            );
            let service = self.clone();
            tauri::async_runtime::spawn(async move {
                let task_id = result.task_id.clone();
                let result_index = result.result_index;
                let progress_service = service.clone();
                let progress_task_id = task_id.clone();
                match service
                    .local_results
                    .resume_interrupted_result(result, move |progress| {
                        progress_service.emit_save_progress(
                            &progress_task_id,
                            result_index,
                            progress,
                        );
                    })
                    .await
                {
                    Ok(result) => {
                        let payload = json!({
                            "taskId": task_id,
                            "resultIndex": result_index,
                            "result": result
                        });
                        let _ = service.commit_fact(
                            &task_id,
                            GenerationLifecycleFact::OperationalEvent {
                                event_type: GenerationOperationalEvent::LocalSaveRecovered,
                                payload: payload.clone(),
                            },
                        );
                        service.emit("generation:result-saved", &payload);
                    }
                    Err(error) => {
                        let payload = error.runtime_record();
                        let _ = service.commit_fact(
                            &task_id,
                            GenerationLifecycleFact::OperationalEvent {
                                event_type: GenerationOperationalEvent::LocalSaveRecoveryFailed,
                                payload,
                            },
                        );
                    }
                }
            });
        }
        info!(
            "[generation] 启动恢复完成: 恢复远程任务 {} 个, 标记中断任务 {} 个, 恢复本地保存 {} 个, 恢复失败 {} 个{}",
            report.recovered_video_tasks,
            report.interrupted_image_tasks,
            report.resumed_local_saves,
            report.failed_to_recover.len(),
            if report.failed_to_recover.is_empty() {
                String::new()
            } else {
                format!("（{}）", report.failed_to_recover.join("; "))
            }
        );
        Ok(report)
    }

    pub fn query_remote_now(&self, task_id: &str) -> BackendResult<()> {
        info!("[generation] 用户手动触发视频任务状态查询: taskId={task_id}");
        let task = self.storage.get_task_execution(task_id)?;
        let kling_transient = task.status == GenerationTaskStatus::Unknown
            && task.remote_model_id_snapshot.as_deref().is_some_and(super::model_schema::is_moyu_kling_v4_model);
        let pollable = matches!(
            task.operation,
            GenerationOperation::VideoGeneration
                | GenerationOperation::TextToImage
                | GenerationOperation::ImageToImage
        );
        if !pollable
            || task
                .remote_task_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty())
            || (!kling_transient && !matches!(
                task.status,
                GenerationTaskStatus::Queued | GenerationTaskStatus::Running
            ))
        {
            return Err(BackendError::validation(
                "only a queued or running remote generation task with a remote task id can resume polling",
                json!({ "taskId": task_id, "status": task.status }),
            ));
        }
        let slot = self.video_polls.slot(task_id)?;
        let Ok(poll_guard) = slot.gate.clone().try_lock_owned() else {
            // Reuse the existing worker and leave its retry health untouched.
            slot.wake.notify_one();
            return Ok(());
        };
        self.commit_fact(task_id, if kling_transient {
            GenerationLifecycleFact::RecoveryRemoteResumed { remote_task_id: task.remote_task_id.clone().unwrap_or_default() }
        } else { GenerationLifecycleFact::ManualObservationRequested })?;
        let service = self.clone();
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            let _poll_guard = poll_guard;
            if let Err(error) = service
                .poll_video_loop(&task_id, Vec::new(), &slot.wake)
                .await
            {
                let _ = service.finish_with_execution_error(&task_id, error);
            }
        });
        Ok(())
    }

    async fn execute(&self, task_id: &str) -> BackendResult<()> {
        info!("[generation] 开始后台执行任务: taskId={task_id}");
        // 任务可能刚创建就被取消了：别再往下走。
        if self.stop_for_cancellation(task_id)? {
            return Ok(());
        }
        let task = self.storage.get_task_execution(task_id)?;
        let resolve_attempt_id = Uuid::new_v4().to_string();
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::BeginResolution {
                attempt_id: resolve_attempt_id.clone(),
            },
        )?;
        let bundle = match self.media.resolve(&task, &resolve_attempt_id).await {
            Ok(bundle) => {
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::ResolutionSucceeded {
                        attempt_id: resolve_attempt_id.clone(),
                        resolved_request: bundle.generation.archive(),
                    },
                )?;
                info!(
                    "[generation] 媒体引用解析完成: taskId={task_id}, 渲染后提示词 {} 字符, 图片 {} 个, 视频 {} 个, 音频 {} 个, TOS 暂存 {} 个",
                    bundle.generation.rendered_prompt.chars().count(),
                    bundle.generation.images.len(),
                    bundle.generation.videos.len(),
                    bundle.generation.audios.len(),
                    bundle.staging_leases.len()
                );
                bundle
            }
            Err(error) => {
                let record = error.runtime_record();
                error!(
                    "[generation] 媒体引用解析失败，任务转入 failed（未发送任何供应商请求）: taskId={task_id}, 错误: {record}"
                );
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::ResolutionFailed {
                        attempt_id: resolve_attempt_id,
                        error: record,
                    },
                )?;
                return Ok(());
            }
        };
        let Some(success) = self.submit_with_retry(&task, &bundle).await? else {
            self.cleanup_staging_leases(task_id, &bundle.staging_leases)
                .await;
            return Ok(());
        };

        match success.submission {
            GenerationSubmission::Images(images) => {
                info!(
                    "[generation] 供应商返回图片结果 {} 个，开始本地保存: taskId={task_id}",
                    images.len()
                );
                self.cleanup_staging_leases(task_id, &bundle.staging_leases)
                    .await;
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::SubmissionImagesAccepted {
                        attempt_id: success.attempt_id,
                        call_id: success.call_id,
                        tokens: success.tokens,
                        results: self.local_results.pending_image_results(task_id, &images),
                    },
                )?;
                let event_service = self.clone();
                let progress_service = self.clone();
                let progress_task_id = task_id.to_string();
                let results = self
                    .local_results
                    .save_images(
                        task_id,
                        images,
                        move |record, preview_src| {
                            event_service.emit_result_ready(record, preview_src);
                        },
                        move |result_index, progress| {
                            progress_service.emit_save_progress(
                                &progress_task_id,
                                result_index,
                                progress,
                            );
                        },
                    )
                    .await?;
                for result in results {
                    let error_suffix = result
                        .error
                        .as_ref()
                        .map(|error| format!("，错误: {error}"))
                        .unwrap_or_default();
                    info!(
                        "[generation] 图片结果处理完成: taskId={task_id}, resultIndex={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                        result.result_index,
                        result.save_status.as_str(),
                        result.final_path,
                        result
                            .byte_size
                            .map(|size| size.to_string())
                            .unwrap_or_default(),
                    );
                    self.emit(
                        "generation:result-saved",
                        &json!({ "taskId": task_id, "result": result }),
                    );
                }
                Ok(())
            }
            GenerationSubmission::Audio {
                bytes,
                mime_type,
                extension,
            } => {
                info!(
                    "[generation] 供应商返回音频结果（{} 字节），开始本地保存: taskId={task_id}",
                    bytes.len()
                );
                self.cleanup_staging_leases(task_id, &bundle.staging_leases)
                    .await;
                // 生命周期事实（`SubmissionImagesAccepted`）本身与媒体类型无关：
                // 它登记待写结果并把任务推进到成功终态，音频复用同一条路径。
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::SubmissionImagesAccepted {
                        attempt_id: success.attempt_id,
                        call_id: success.call_id,
                        tokens: success.tokens,
                        results: vec![self.local_results.pending_audio_result(
                            task_id,
                            &mime_type,
                            bytes.len() as u64,
                        )],
                    },
                )?;
                let event_service = self.clone();
                let result = self
                    .local_results
                    .save_audio(
                        task_id,
                        bytes,
                        &mime_type,
                        &extension,
                        move |record, preview_src| {
                            event_service.emit_result_ready(record, preview_src);
                        },
                    )
                    .await?;
                let error_suffix = result
                    .error
                    .as_ref()
                    .map(|error| format!("，错误: {error}"))
                    .unwrap_or_default();
                info!(
                    "[generation] 音频结果处理完成: taskId={task_id}, resultIndex={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                    result.result_index,
                    result.save_status.as_str(),
                    result.final_path,
                    result
                        .byte_size
                        .map(|size| size.to_string())
                        .unwrap_or_default(),
                );
                self.emit(
                    "generation:result-saved",
                    &json!({ "taskId": task_id, "result": result }),
                );
                Ok(())
            }
            GenerationSubmission::RemoteImageTask {
                task_id: remote_task_id,
            }
            | GenerationSubmission::RemoteVideoTask {
                task_id: remote_task_id,
            } => {
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::SubmissionRemoteAccepted {
                        attempt_id: success.attempt_id,
                        call_id: success.call_id,
                        tokens: success.tokens,
                        remote_task_id: remote_task_id.clone(),
                    },
                )?;
                let kind = if task.operation == GenerationOperation::VideoGeneration {
                    "视频"
                } else {
                    "图片"
                };
                info!(
                    "[generation] {kind}任务已提交成功，获得远程任务 ID，进入轮询阶段: taskId={task_id}, remoteTaskId={remote_task_id}"
                );
                self.poll_video_with_leases(task_id, bundle.staging_leases)
                    .await
            }
        }
    }

    async fn submit_with_retry(
        &self,
        task: &TaskExecutionRecord,
        bundle: &ResolvedBundle,
    ) -> BackendResult<Option<SuccessfulSubmission>> {
        let mut backoff_ms = None;
        for retry_index in 0..=MAX_AUTOMATIC_RETRIES {
            // 提交前先看取消：被取消的任务不能再向供应商发起任何付费请求。
            if self.stop_for_cancellation(&task.id)? {
                info!(
                    "[generation] 任务已取消，跳过供应商提交: taskId={}, 第 {} 次提交尝试",
                    task.id,
                    retry_index + 1
                );
                return Ok(None);
            }
            let attempt_id = Uuid::new_v4().to_string();
            /*
             * 提交前的最后一查（纯内存，不查库、无全局连接锁争用）。
             *
             * 上面的 stop_for_cancellation 之后还有一次 DB 写（BeginSubmission）
             * + 素材上传 + TCP/TLS 握手 + HTTP 请求，这段时间里到达的取消拦不住
             * 这次请求 —— 用户点「取消」后供应商照样受理并计费，而本地任务会落成
             * cancelled，界面显示「已取消」。这里把窗口压到最小。
             */
            if self.cancellations.is_cancelled(&task.id) {
                info!(
                    "[generation] 任务已取消，跳过供应商提交（提交前内存复查）: taskId={}",
                    task.id
                );
                return Ok(None);
            }
            self.commit_fact(
                &task.id,
                GenerationLifecycleFact::BeginSubmission {
                    attempt_id: attempt_id.clone(),
                    backoff_ms,
                },
            )?;
            info!(
                "[generation] 提交尝试开始: taskId={}, attemptId={}, 第 {} 次尝试（共最多 {} 次）, operation={}",
                task.id,
                attempt_id,
                retry_index + 1,
                MAX_AUTOMATIC_RETRIES + 1,
                task.operation.as_str()
            );
            match self
                .providers
                .submit(task, &attempt_id, &bundle.generation)
                .await
            {
                Ok((submission, response)) => {
                    match &submission {
                        GenerationSubmission::Images(images) => {
                            info!(
                                "[generation] 提交尝试成功: taskId={}, attemptId={}, 返回图片结果 {} 个",
                                task.id,
                                attempt_id,
                                images.len()
                            );
                        }
                        GenerationSubmission::RemoteImageTask {
                            task_id: remote_task_id,
                        }
                        | GenerationSubmission::RemoteVideoTask {
                            task_id: remote_task_id,
                        } => {
                            info!(
                                "[generation] 提交尝试成功: taskId={}, attemptId={}, 返回远程任务 {remote_task_id}",
                                task.id, attempt_id
                            );
                        }
                        GenerationSubmission::Audio { bytes, .. } => {
                            info!(
                                "[generation] 提交尝试成功: taskId={}, attemptId={}, 返回音频结果 {} 字节",
                                task.id,
                                attempt_id,
                                bytes.len()
                            );
                        }
                    }
                    return Ok(Some(SuccessfulSubmission {
                        attempt_id,
                        call_id: response.call_id.clone(),
                        submission,
                        tokens: parse_token_usage(&response),
                    }));
                }
                Err(error) => {
                    let record = error.runtime_record();
                    let retryable = is_retryable_generation_error(&error);
                    warn!(
                        "[generation] 提交尝试失败: taskId={}, attemptId={}, 第 {} 次尝试, 可自动重试={retryable}, 错误: {record}",
                        task.id,
                        attempt_id,
                        retry_index + 1
                    );
                    if !retryable || retry_index == MAX_AUTOMATIC_RETRIES {
                        let exhausted = retry_index == MAX_AUTOMATIC_RETRIES && retryable;
                        let conclusion = if matches!(&error, BackendError::Transport(transport)
                            if !super::provider::is_dispatch_failure(transport))
                            || matches!(&error, BackendError::Protocol { details, .. }
                                if details.get("ambiguousPaidSubmission").and_then(Value::as_bool) == Some(true))
                            /*
                             * 「上游已受理（2xx）但回执里没有任务号」：确定已经计费，
                             * 只是我们拿不到远程身份去核对。落 `Unknown` 而不是
                             * `Failed` —— 界面上的「失败」会让用户再点一次生成，
                             * 那就是第二次付费请求。
                             */
                            || matches!(&error, BackendError::Protocol { details, .. }
                                if details.get("acceptedWithoutRemoteId").and_then(Value::as_bool) == Some(true))
                        {
                            GenerationTaskStatus::Unknown
                        } else {
                            GenerationTaskStatus::Failed
                        };
                        self.commit_fact(
                            &task.id,
                            GenerationLifecycleFact::SubmissionTerminated {
                                attempt_id,
                                conclusion,
                                error: record,
                                retries_exhausted: exhausted,
                            },
                        )?;
                        if exhausted {
                            self.emit_retry_exhausted_notice(&task.id, &error);
                        }
                        return Ok(None);
                    }
                    let delay = retry_delay_ms(retry_index + 1);
                    self.commit_fact(
                        &task.id,
                        GenerationLifecycleFact::SubmissionRetryScheduled {
                            attempt_id,
                            retry_index: retry_index + 1,
                            delay_ms: delay,
                            error: record,
                        },
                    )?;
                    self.emit_retry_notice(&task.id, retry_index + 1, delay, Some(&error), false);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    backoff_ms = Some(delay);
                }
            }
        }
        Err(BackendError::protocol(
            "submission retry loop exited without a result",
            json!({ "taskId": task.id }),
        ))
    }

    async fn finish_remote_images(
        &self,
        task_id: &str,
        observed: SuccessfulObservation,
        staging_leases: &[super::staging::StagingLease],
    ) -> BackendResult<()> {
        let SuccessfulObservation {
            attempt_id,
            call_id,
            observation,
            tokens,
        } = observed;
        let remote_status = observation.remote_status;
        let images = observation.images;
        if images.is_empty() {
            error!(
                "[generation] 远端图片任务已结束但没有图片: taskId={task_id}, 远端状态={remote_status}"
            );
            let failure = json!({
                "kind": "remote_generation_failure",
                "message": "image task completed without an image payload",
                "remoteStatus": remote_status
            });
            self.commit_fact(
                task_id,
                GenerationLifecycleFact::ObservationApplied {
                    attempt_id,
                    call_id,
                    tokens,
                    observation: GenerationRemoteObservation::Failed {
                        progress: None,
                        error: failure,
                    },
                },
            )?;
            self.cleanup_staging_leases(task_id, staging_leases).await;
            return Ok(());
        }

        info!(
            "[generation] 供应商返回图片结果 {} 个，开始本地保存: taskId={task_id}",
            images.len()
        );
        // 一次远端任务可能返回多张图（实测 Atlas/Midjourney 同一次提交有 4 张、
        // 也有 3 张，张数由上游当次决定）：必须把**全部**结果登记进生命周期事实。
        // 只登记第一条的话，其余结果写库时会被守卫判为「未登记」而失败，
        // 图片一张都落不了盘。
        let pending = self.local_results.pending_image_results(task_id, &images);
        if pending.is_empty() {
            return Err(BackendError::protocol(
                "image task completed without an image payload",
                json!({ "taskId": task_id, "remoteStatus": remote_status }),
            ));
        }
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::ObservationApplied {
                attempt_id,
                call_id,
                tokens,
                observation: GenerationRemoteObservation::Succeeded { results: pending },
            },
        )?;
        let event_service = self.clone();
        let progress_service = self.clone();
        let progress_task_id = task_id.to_string();
        let results = self
            .local_results
            .save_images(
                task_id,
                images,
                move |record, preview_src| {
                    event_service.emit_result_ready(record, preview_src);
                },
                move |result_index, progress| {
                    progress_service.emit_save_progress(&progress_task_id, result_index, progress);
                },
            )
            .await?;
        for result in results {
            let error_suffix = result
                .error
                .as_ref()
                .map(|error| format!("，错误: {error}"))
                .unwrap_or_default();
            info!(
                "[generation] 图片结果处理完成: taskId={task_id}, resultIndex={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                result.result_index,
                result.save_status.as_str(),
                result.final_path,
                result
                    .byte_size
                    .map(|size| size.to_string())
                    .unwrap_or_default(),
            );
            self.emit(
                "generation:result-saved",
                &json!({ "taskId": task_id, "result": result }),
            );
        }
        self.cleanup_staging_leases(task_id, staging_leases).await;
        Ok(())
    }

    async fn poll_video(&self, task_id: &str) -> BackendResult<()> {
        self.poll_video_with_leases(task_id, Vec::new()).await
    }

    async fn poll_video_with_leases(
        &self,
        task_id: &str,
        staging_leases: Vec<super::staging::StagingLease>,
    ) -> BackendResult<()> {
        let slot = self.video_polls.slot(task_id)?;
        let _poll_guard = slot.gate.lock().await;
        // A manual query may have finished before the submission/recovery worker
        // acquired the gate. Its staging leases still need their normal cleanup.
        if self
            .storage
            .get_task_execution(task_id)?
            .status
            .is_terminal()
        {
            self.cleanup_staging_leases(task_id, &staging_leases).await;
            return Ok(());
        }
        self.poll_video_loop(task_id, staging_leases, &slot.wake)
            .await
    }

    async fn poll_video_loop(
        &self,
        task_id: &str,
        staging_leases: Vec<super::staging::StagingLease>,
        wake: &tokio::sync::Notify,
    ) -> BackendResult<()> {
        let initial_task = self.storage.get_task_execution(task_id)?;
        let poll_policy = VideoPollingPolicy::for_model(
            initial_task.remote_model_id_snapshot.as_deref(),
            RequestDialect::for_adapter(&initial_task.adapter_id_snapshot),
        );
        // Each observation worker gets a bounded window. Manual recovery starts
        // another window against the existing frozen remote identity; it never
        // returns to the paid submission path.
        let poll_started = tokio::time::Instant::now();
        loop {
            // 每轮轮询前先看取消：命中就停下，不再向供应商发起新的查询。
            if self.stop_for_cancellation(task_id)? {
                self.cleanup_staging_leases(task_id, &staging_leases).await;
                return Ok(());
            }
            let mut successful_observation = None;
            let mut backoff_ms = None;
            for retry_index in 0..=MAX_AUTOMATIC_RETRIES {
                // 查询重试的退避期间也可能被取消：查询前再确认一次。
                if self.stop_for_cancellation(task_id)? {
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                if poll_policy.next_wait(poll_started.elapsed()).is_none() {
                    self.stop_expired_video_polling(
                        task_id,
                        poll_policy.cadence.window_secs().unwrap_or_default(),
                    )?;
                    return Ok(());
                }
                let attempt_id = Uuid::new_v4().to_string();
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::BeginObservation {
                        attempt_id: attempt_id.clone(),
                        backoff_ms,
                    },
                )?;
                let task = self.storage.get_task_execution(task_id)?;
                match self.providers.observe(&task, &attempt_id).await {
                    Ok((value, response)) => {
                        successful_observation = Some(SuccessfulObservation {
                            attempt_id,
                            call_id: response.call_id.clone(),
                            observation: value,
                            tokens: parse_token_usage(&response),
                        });
                        break;
                    }
                    Err(error) => {
                        let record = error.runtime_record();
                        warn!(
                            "[generation] 视频状态查询尝试失败: taskId={}, attemptId={}, 第 {} 次观察尝试, 可自动重试={}, 错误: {record}",
                            task_id,
                            attempt_id,
                            retry_index + 1,
                            is_retryable_generation_error(&error)
                        );
                        if !is_retryable_generation_error(&error) {
                            error!(
                                "[generation] 视频状态查询遇到不可重试错误，任务转入终态: taskId={task_id}"
                            );
                            let conclusion = if matches!(error, BackendError::Transport(_)) {
                                GenerationTaskStatus::Unknown
                            } else {
                                GenerationTaskStatus::Failed
                            };
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationTerminated {
                                    attempt_id,
                                    conclusion,
                                    error: record,
                                },
                            )?;
                            return Ok(());
                        }
                        if retry_index == MAX_AUTOMATIC_RETRIES {
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationDegraded {
                                    attempt_id,
                                    error: record,
                                },
                            )?;
                            error!(
                                "[generation] 视频状态查询重试耗尽，标记查询健康状态为 degraded 并停止自动轮询（用户可手动重新查询）: taskId={task_id}"
                            );
                            self.emit_retry_exhausted_notice(task_id, &error);
                            return Ok(());
                        }
                        let mut delay = retry_delay_ms(retry_index + 1);
                        if let Some(floor) = poll_policy
                            .cadence
                            .retry_delay_floor(poll_started.elapsed())
                        {
                            delay = delay.max(floor.as_millis() as u64);
                        }
                        warn!(
                            "[generation] 视频状态查询失败，进入查询重试: taskId={task_id}, 第 {}/{MAX_AUTOMATIC_RETRIES} 次查询重试, 退避 {delay}ms（只重试查询，不会重新提交生成）",
                            retry_index + 1
                        );
                        self.commit_fact(
                            task_id,
                            GenerationLifecycleFact::ObservationRetryScheduled {
                                attempt_id,
                                retry_index: retry_index + 1,
                                delay_ms: delay,
                                error: record,
                            },
                        )?;
                        self.emit_retry_notice(task_id, retry_index + 1, delay, Some(&error), true);
                        let retry_wait = std::time::Duration::from_millis(delay);
                        let retry_wait = poll_policy
                            .cadence
                            .bound_retry_wait(retry_wait, poll_started.elapsed());
                        tokio::time::sleep(retry_wait).await;
                        backoff_ms = Some(delay);
                    }
                }
            }

            let successful_observation = successful_observation.ok_or_else(|| {
                BackendError::protocol(
                    "video observation loop produced no observation",
                    json!({ "taskId": task_id }),
                )
            })?;
            let SuccessfulObservation {
                attempt_id,
                call_id,
                observation,
                tokens,
            } = successful_observation;
            let image_task = matches!(
                self.storage.get_task_execution(task_id)?.operation,
                GenerationOperation::TextToImage | GenerationOperation::ImageToImage
            );
            let kind = if image_task { "图片" } else { "视频" };
            let remote_status = observation.remote_status.to_ascii_uppercase();
            let remote_status = if poll_policy
                .family
                .is_some_and(GatewayProfile::empty_remote_status_means_pending)
                && remote_status.trim().is_empty()
            {
                "PENDING"
            } else {
                remote_status.as_str()
            };
            match remote_status {
                // `created` 是 Atlas Cloud 等平台的「已受理、尚未开始」状态：它属于
                // 排队而不是终态，落到未知分支会让任务直接停摆。
                "NOT_START" | "SUBMITTED" | "QUEUED" | "PENDING" | "CREATED" => {
                    info!(
                        "[generation] {kind}任务远端排队中: taskId={}, 远端状态={}, 进度={:?}",
                        task_id, observation.remote_status, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Queued {
                                progress: observation.progress,
                            },
                        },
                    )?;
                }
                "IN_PROGRESS" | "PROCESSING" | "RUNNING" => {
                    info!(
                        "[generation] {kind}任务远端生成中: taskId={}, 远端状态={}, 进度={:?}",
                        task_id, observation.remote_status, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Running {
                                progress: observation.progress,
                            },
                        },
                    )?;
                }
                "SUCCESS" | "SUCCEEDED" | "COMPLETED" => {
                    if image_task {
                        return self
                            .finish_remote_images(
                                task_id,
                                SuccessfulObservation {
                                    attempt_id,
                                    call_id,
                                    observation,
                                    tokens,
                                },
                                &staging_leases,
                            )
                            .await;
                    }
                    let task = self.storage.get_task_execution(task_id)?;
                    let remote_task_id = task.remote_task_id.as_deref().ok_or_else(|| {
                        BackendError::protocol(
                            "successful video task has no remote task id",
                            json!({ "taskId": task_id }),
                        )
                    })?;
                    let event_service = self.clone();
                    // Context-IR（h3_context_ir）任务产出扩写文本（透传层
                    // `data.data.task.content.prompt`），无 result_url，走文本保存通道。
                    let result = if let Some(text) = observation.text_content.as_deref() {
                        info!(
                            "[generation] Context-IR 扩写成功，开始保存文本结果: taskId={}, remoteTaskId={}, 文本 {} 字符",
                            task_id,
                            remote_task_id,
                            text.chars().count()
                        );
                        self.commit_fact(
                            task_id,
                            GenerationLifecycleFact::ObservationApplied {
                                attempt_id,
                                call_id,
                                tokens,
                                observation: GenerationRemoteObservation::Succeeded {
                                    results: vec![self.local_results.pending_text_result(
                                        task_id,
                                        remote_task_id,
                                        text,
                                    )],
                                },
                            },
                        )?;
                        self.local_results
                            .save_text(task_id, remote_task_id, text, move |record, preview_src| {
                                event_service.emit_result_ready(record, preview_src);
                            })
                            .await?
                    } else {
                        match observation.video_url.as_deref() {
                            Some(video_url) => {
                                info!(
                                    "[generation] 视频生成成功，开始保存结果: taskId={}, remoteTaskId={}, videoUrl={}",
                                    task_id,
                                    remote_task_id,
                                    super::provider::redact_url_string(video_url)
                                );
                                self.commit_fact(
                                    task_id,
                                    GenerationLifecycleFact::ObservationApplied {
                                        attempt_id,
                                        call_id,
                                        tokens,
                                        observation: GenerationRemoteObservation::Succeeded {
                                            results: vec![self.local_results.pending_video_result(
                                                task_id,
                                                remote_task_id,
                                                video_url,
                                            )],
                                        },
                                    },
                                )?;
                                self.local_results
                                    .save_video(
                                        task_id,
                                        remote_task_id,
                                        video_url,
                                        {
                                            let event_service = event_service.clone();
                                            move |record, preview_src| {
                                                event_service
                                                    .emit_result_ready(record, preview_src);
                                            }
                                        },
                                        {
                                            let progress_service = event_service.clone();
                                            let progress_task_id = task_id.to_string();
                                            move |progress| {
                                                progress_service.emit_save_progress(
                                                    &progress_task_id,
                                                    1,
                                                    progress,
                                                );
                                            }
                                        },
                                    )
                                    .await?
                            }
                            None => {
                                info!(
                                    "[generation] 视频生成成功但观察响应缺失 result_url，尝试通过 content 接口获取视频字节: taskId={}, remoteTaskId={}",
                                    task_id, remote_task_id
                                );
                                let bytes = self
                                    .providers
                                    .fetch_video_content(&task, &attempt_id)
                                    .await?;
                                info!(
                                    "[generation] content 接口下载完成: taskId={}, remoteTaskId={}, 字节 {}",
                                    task_id,
                                    remote_task_id,
                                    bytes.len()
                                );
                                self.commit_fact(
                                    task_id,
                                    GenerationLifecycleFact::ObservationApplied {
                                        attempt_id,
                                        call_id,
                                        tokens,
                                        observation: GenerationRemoteObservation::Succeeded {
                                            results: vec![
                                                self.local_results.pending_video_content_result(
                                                    task_id,
                                                    remote_task_id,
                                                ),
                                            ],
                                        },
                                    },
                                )?;
                                self.local_results
                                    .save_video_bytes(
                                        task_id,
                                        remote_task_id,
                                        bytes,
                                        move |record, preview_src| {
                                            event_service.emit_result_ready(record, preview_src);
                                        },
                                    )
                                    .await?
                            }
                        }
                    };
                    let error_suffix = result
                        .error
                        .as_ref()
                        .map(|error| format!("，错误: {error}"))
                        .unwrap_or_default();
                    info!(
                        "[generation] 视频结果处理完成: taskId={}, remoteTaskId={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                        task_id,
                        remote_task_id,
                        result.save_status.as_str(),
                        result.final_path,
                        result
                            .byte_size
                            .map(|size| size.to_string())
                            .unwrap_or_default()
                    );
                    self.emit(
                        "generation:result-saved",
                        &json!({ "taskId": task_id, "result": result }),
                    );
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                "FAILURE" | "FAILED" | "CANCELED" | "CANCELLED" | "VIOLATION" | "EXPIRED" => {
                    let failure = json!({
                        "kind": "remote_generation_failure",
                        "message": super::provider::video_failure_message(kind, &remote_status, observation.failure.as_ref().unwrap_or(&serde_json::Value::Null), initial_task.resolved_request.as_ref().and_then(|request| request.get("parameters"))),
                        "remoteStatus": observation.remote_status,
                        "remote": observation.failure
                    });
                    error!(
                        "[generation] 远端视频任务报告失败: taskId={}, 进度={:?}, 详情: {failure}",
                        task_id, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Failed {
                                progress: observation.progress,
                                error: failure,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                "UNKNOWN" => {
                    warn!("[generation] 远端视频任务状态未知，任务转入 unknown: taskId={task_id}");
                    let unknown = json!({
                        "kind": "remote_generation_unknown",
                        "message": "remote video task reported UNKNOWN",
                        "remoteStatus": observation.remote_status,
                    });
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Unknown {
                                progress: observation.progress,
                                error: unknown,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                other => {
                    if image_task && !observation.images.is_empty() {
                        return self
                            .finish_remote_images(
                                task_id,
                                SuccessfulObservation {
                                    attempt_id,
                                    call_id,
                                    observation,
                                    tokens,
                                },
                                &staging_leases,
                            )
                            .await;
                    }
                    let error = json!({
                        "kind": "unknown_remote_status",
                        "message": format!("unknown remote video status: {other}"),
                        "remoteStatus": other
                    });
                    warn!(
                        "[generation] 远端视频任务返回未知状态，任务转入 unknown: taskId={}, 远端状态={other}",
                        task_id
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Unknown {
                                progress: observation.progress,
                                error,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
            }
            let Some(poll_interval) = poll_policy.next_wait(poll_started.elapsed()) else {
                self.stop_expired_video_polling(
                    task_id,
                    poll_policy.cadence.window_secs().unwrap_or_default(),
                )?;
                return Ok(());
            };
            let _ = tokio::time::timeout(poll_interval, wake.notified()).await;
        }
    }

    fn stop_expired_video_polling(&self, task_id: &str, window_secs: u64) -> BackendResult<()> {
        let task = self.storage.get_task_execution(task_id)?;
        let reason = json!({
            "kind": "remote_polling_window_expired",
            "message": "已达到 10 分钟自动查询时限，可手动查询原任务继续获取结果，不会重新提交生成",
            "remoteTaskId": task.remote_task_id,
            "queryOnly": true,
            "windowSeconds": window_secs,
        });
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::ObservationPollingExpired {
                error: reason.clone(),
            },
        )?;
        warn!(
            "[generation] PixVerse 自动查询达到 10 分钟时限，保留任务状态及远端 ID，用户可手动查询: taskId={task_id}"
        );
        self.emit(
            "generation:polling-stopped",
            &json!({ "taskId": task_id, "reason": reason, "queryOnly": true }),
        );
        let _ = self
            .app
            .notification()
            .builder()
            .title("生成任务自动查询已停止")
            .body("PixVerse 任务已查询 10 分钟，可手动查询原任务继续获取结果")
            .show();
        Ok(())
    }

    async fn cleanup_staging_leases(
        &self,
        task_id: &str,
        staging_leases: &[super::staging::StagingLease],
    ) {
        for lease in staging_leases {
            if let Err(error) = self.staging.cleanup_lease(lease).await {
                let _ = self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::OperationalEvent {
                        event_type: GenerationOperationalEvent::StagingCleanupFailed,
                        payload: error.runtime_record(),
                    },
                );
            }
        }
    }

    fn emit_retry_notice(
        &self,
        task_id: &str,
        retry_index: u32,
        delay_ms: u64,
        error: Option<&BackendError>,
        query_only: bool,
    ) {
        let payload = json!({
            "taskId": task_id,
            "retry": retry_index,
            "maxRetries": MAX_AUTOMATIC_RETRIES,
            "delayMs": delay_ms,
            "queryOnly": query_only,
            "reason": error.map(BackendError::runtime_record),
            "risk": "请求可能已被供应商接收，自动重试可能造成重复生成或重复计费"
        });
        self.emit("generation:retry", &payload);
        let _ = self
            .app
            .notification()
            .builder()
            .title("生成任务自动重试")
            .body(format!(
                "任务 {task_id} 将进行第 {retry_index}/{MAX_AUTOMATIC_RETRIES} 次重试"
            ))
            .show();
    }

    fn emit_retry_exhausted_notice(&self, task_id: &str, error: &BackendError) {
        let payload = error.payload();
        error!(
            "[generation] 自动重试已耗尽，不再安排下一次重试: taskId={}, 错误类型={}, 详情={}",
            task_id, payload.kind, payload.message
        );
        let payload = json!({
            "taskId": task_id,
            "maxRetries": MAX_AUTOMATIC_RETRIES,
            "reason": error.runtime_record()
        });
        self.emit("generation:retry-exhausted", &payload);
        let _ = self
            .app
            .notification()
            .builder()
            .title("生成任务自动重试已耗尽")
            .body(format!("任务 {task_id} 已停止自动重试"))
            .show();
    }

    fn commit_fact(&self, task_id: &str, fact: GenerationLifecycleFact) -> BackendResult<()> {
        let receipt = self.lifecycle.commit(task_id, fact)?;
        if let Some(persisted) = receipt.transition.as_ref() {
            self.emit_persisted_transition(persisted);
        }
        Ok(())
    }

    fn emit_persisted_transition(&self, persisted: &PersistedTaskTransition) {
        let Some(event) = persisted.event.as_ref() else {
            return;
        };
        match event {
            PersistedTaskTransitionEvent::StateChanged {
                status,
                progress,
                error,
                ..
            } => {
                info!(
                    "[generation] 任务状态更新: taskId={}, status={}, progress={:?}, 携带错误={}",
                    persisted.task_id,
                    status.as_str(),
                    progress,
                    error.is_some()
                );
                self.emit(
                    "generation:state-changed",
                    &json!({
                        "taskId": persisted.task_id,
                        "status": status,
                        "progress": progress,
                        "error": error,
                    }),
                );
            }
            PersistedTaskTransitionEvent::QueryHealthChanged { health, .. } => {
                info!(
                    "[generation] 视频查询健康状态更新: taskId={}, queryHealth={}",
                    persisted.task_id,
                    health.as_str()
                );
            }
        }
    }

    fn finish_with_execution_error(&self, task_id: &str, error: BackendError) -> BackendResult<()> {
        // 任务已经落成终态（例如被取消）时不再改写它：终态历史不能被覆盖。
        if let Ok(task) = self.storage.get_task_execution(task_id)
            && task.status.is_terminal()
        {
            info!(
                "[generation] 任务已是终态（{}），忽略后台异常: taskId={task_id}",
                task.status.as_str()
            );
            return Ok(());
        }
        let status = if matches!(error, BackendError::Transport(_)) {
            GenerationTaskStatus::Unknown
        } else {
            GenerationTaskStatus::Failed
        };
        let record = error.runtime_record();
        error!(
            "[generation] 任务后台执行异常终止: taskId={task_id}, 最终状态={}, 错误: {record}",
            status.as_str()
        );
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::ExecutionTerminated {
                conclusion: status,
                error: record,
            },
        )
    }

    fn emit(&self, event: &str, payload: &Value) {
        if let Err(error) = self.app.emit(event, payload) {
            tauri_plugin_log::log::error!("failed to emit {event}: {error}");
        }
    }

    fn emit_result_ready(&self, result: &GenerationResultRecord, preview_src: Option<String>) {
        self.emit(
            "generation:result-ready",
            &json!({
                "taskId": result.task_id,
                "result": result,
                "previewSrc": preview_src
            }),
        );
    }

    fn emit_save_progress(
        &self,
        task_id: &str,
        result_index: u32,
        progress: super::result_transfer::TransferProgress,
    ) {
        self.emit(
            "generation:result-save-progress",
            &json!({
                "taskId": task_id,
                "resultIndex": result_index,
                "received": progress.received as f64,
                "total": progress.total.map(|value| value as f64),
                "bytesPerSec": if progress.bytes_per_sec.is_finite() {
                    progress.bytes_per_sec
                } else {
                    0.0
                },
            }),
        );
    }
}

/// 任务状态的人话标签：给用户看的文案里不要直接抛英文枚举值。
fn task_status_label(status: GenerationTaskStatus) -> &'static str {
    match status {
        GenerationTaskStatus::Succeeded => "已成功",
        GenerationTaskStatus::Failed => "已失败",
        GenerationTaskStatus::Unknown => "状态未知",
        GenerationTaskStatus::Interrupted => "已中断",
        GenerationTaskStatus::Cancelled => "已取消",
        _ => "进行中",
    }
}

fn validate_start_command(command: &StartGenerationCommand) -> BackendResult<()> {
    if command.output_name.as_ref().is_some_and(|name| {
        name.trim().is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control)
    }) {
        return Err(BackendError::validation(
            "任务产物名称须为 1–100 个字符",
            json!({}),
        ));
    }
    let mut missing = Vec::new();
    if command.canvas_id.trim().is_empty() {
        missing.push("canvasId");
    }
    if command.source_node_id.trim().is_empty() {
        missing.push("sourceNodeId");
    }
    if command.provider_connection_id.trim().is_empty() {
        missing.push("providerConnectionId");
    }
    if command.model_definition_id.trim().is_empty() {
        missing.push("modelDefinitionId");
    }
    if command.generation_count != 1 {
        return Err(BackendError::validation(
            "each local generation task represents one request; batch requests require separate tasks",
            json!({ "generationCount": command.generation_count, "supported": 1 }),
        ));
    }
    if !missing.is_empty() {
        return Err(BackendError::validation(
            "generation command is missing required identities",
            json!({ "missing": missing }),
        ));
    }
    Ok(())
}

fn retry_delay_ms(retry_index: u32) -> u64 {
    let nominal = 2_000_u64 * 2_u64.pow(retry_index.saturating_sub(1));
    nominal + rand::rng().random_range(0..=(nominal / 5))
}

fn is_retryable_generation_error(error: &BackendError) -> bool {
    match error {
        BackendError::Transport(_) => true,
        BackendError::Protocol { details, .. } => {
            if details
                .get("ambiguousPaidSubmission")
                .and_then(Value::as_bool)
                == Some(true)
                || details.get("noChargeTerminal").and_then(Value::as_bool) == Some(true)
                /*
                 * 「上游已受理但回执里没有任务号」：重发就是再 POST 一遍付费请求体，
                 * 上游会再建一个任务、再扣一次费。必须挡住。
                 */
                || details
                    .get("acceptedWithoutRemoteId")
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                return false;
            }
            details
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    details
                        .get("httpStatus")
                        .and_then(Value::as_u64)
                        .is_some_and(|status| (500..600).contains(&status))
                })
        }
        _ => false,
    }
}

fn video_poll_interval(model_id: Option<&str>) -> std::time::Duration {
    if model_id.is_some_and(|model_id| {
        let identity = model_id.to_ascii_lowercase();
        identity.contains("wan3.0-video") || identity.contains("wan3-0-video")
    }) {
        WAN_VIDEO_POLL_INTERVAL
    } else {
        DEFAULT_VIDEO_POLL_INTERVAL
    }
}
