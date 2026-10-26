use serde_json::{Value, json};
use std::path::Path;
use tauri::{AppHandle, Emitter as _, Manager as _, State};
use tauri_plugin_log::log::{debug, error, info};

use super::{
    BackendState,
    brand_design::{
        self, BrandDesignExportResult, BrandDesignImage, ExportBrandDesignBundleCommand,
        ReadBrandDesignImageCommand,
    },
    brand_models::{
        ArchiveBrandModelCommand, BrandModelProfile, BrandModelVersion, BrandModelVersionCommand,
        SaveBrandModelVersionCommand,
    },
    cover_images::{
        self, NormalizeCoverImageCommand, NormalizedCoverImage, ResumeCoverImageResultCommand,
    },
    downloader::{VideoCookieBrowser, VideoDownloadJobRecord, VideoDownloaderEngineStatus},
    error::{BackendError, BackendResult, CommandResult, IntoCommandResult as _},
    frame_extractor::VideoFrameExtractionJobRecord,
    mac_delta_update::{self, MacDeltaUpdateStatus},
    material_transfer,
    model_schema::{
        GATEWAY_TTS_REQUEST_PROFILE, provider_scoped_model_definition_id,
        validate_schema_for_operations,
    },
    prompt_optimize::{OptimizeVideoPromptCommand, OptimizedPromptResult},
    provider_adapter::ProviderAdapterKind,
    resource_update::{self, RuntimeResourceUpdateStatus},
    speech::{
        self, ComposeDubbedVideoCommand, DubbedVideo, GetSpeechRequestStatusCommand,
        ListSpeechVoicesCommand, SpeechRequestStatus, SpeechVoice, SynthesizeSpeechCommand,
        SynthesizedSpeech,
    },
    storage::now_ms,
    types::{
        AssetGroupRecord, AssetImportOutputRecord, AssetKindCountCommand, AssetListCommand,
        AssetStatusObservation, CanvasDocumentRecord, CanvasDocumentSummary, CloudAssetKindTotals,
        CloudAssetRecord, ConnectivityTestResult, CreateAssetGroupCommand,
        CreateLocalBase64AssetGroupCommand, CreateRealPersonAuthLinkCommand, CredentialStatus,
        DeleteAssetCommand, DeleteAssetGroupCommand, DeleteLocalBase64AssetCommand,
        DeleteLocalBase64AssetGroupCommand, DeleteProviderTokenGroupCommand,
        DeleteRealPersonAssetCommand, DeleteRealPersonGroupCommand, GenerationModelCatalogEntry,
        GenerationOperation, GenerationResultRecord, GenerationTaskDetail, GenerationTaskListQuery,
        GenerationTaskPage, GenerationTaskProgress, ImportLocalBase64AssetCommand,
        ImportedAssetSource, ListAssetGroupsCommand, LocalAssetListQuery, LocalAssetPage,
        LocalBase64AssetGroupRecord, LocalBase64AssetPage, LocalBase64AssetRecord, MediaType,
        ModelDefinition, MoveLocalBase64AssetsCommand, ObserveAssetStatusCommand,
        ProviderConnection, ProviderModelBinding, ProviderModelSelection, ProviderTokenGroup,
        RealPersonAuthLink, RealPersonGroup, RealPersonProviderCommand, RecoveryReport,
        RefreshAssetCoverCommand, RefreshAssetMediaCommand, RefreshLocalAssetMediaCommand,
        RefreshStagingObjectCommand, RemoteModelOption, RemoteVideoTaskPage, RenameAssetCommand,
        ReplaceProviderModelBindingsCommand, SaveCanvasDocumentCommand, SaveExistingAssetCommand,
        SaveExistingAssetResult, SaveStatus, SetCredentialCommand, StagingJobRecord,
        StartGenerationCommand, StartStagingCommand, StartVideoDownloadCommand,
        StartVideoFrameExtractionCommand, TosBucketPullSummary, TosStagingConfig,
        UpdateAssetGroupCommand, UpsertProviderConnectionCommand, UpsertProviderTokenGroupCommand,
        VideoTaskListCommand, WorkspaceUiPrefs,
    },
    video_clip::StartVideoClipCommand,
    video_preparation::{
        StartVideoPreparationCommand, VideoPreparationJobRecord, VideoPreparationProbe,
    },
};

#[tauri::command]
pub async fn prepare_macos_delta_update(app: AppHandle, version: String) -> Result<bool, String> {
    mac_delta_update::prepare(&app, &version).await
}

#[tauri::command]
pub fn get_macos_delta_update_status() -> MacDeltaUpdateStatus {
    mac_delta_update::status()
}

#[tauri::command]
pub async fn install_prepared_macos_delta_update(
    app: AppHandle,
    version: String,
) -> Result<(), String> {
    mac_delta_update::install(&app, &version).await
}

#[tauri::command]
pub async fn normalize_cover_image(
    state: State<'_, BackendState>,
    command: NormalizeCoverImageCommand,
) -> CommandResult<NormalizedCoverImage> {
    state.cover_images.normalize(command).await.command()
}

#[tauri::command]
pub async fn read_brand_design_image(
    command: ReadBrandDesignImageCommand,
) -> CommandResult<BrandDesignImage> {
    tokio::task::spawn_blocking(move || brand_design::read_image(command))
        .await
        .map_err(|error| BackendError::Conflict(format!("设计图片读取失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn export_brand_design_bundle(
    command: ExportBrandDesignBundleCommand,
) -> CommandResult<BrandDesignExportResult> {
    tokio::task::spawn_blocking(move || brand_design::export_bundle(command))
        .await
        .map_err(|error| BackendError::Conflict(format!("品牌设计交付失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn list_brand_models(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<BrandModelProfile>> {
    let library = state.brand_models.clone();
    tokio::task::spawn_blocking(move || library.list())
        .await
        .map_err(|_| BackendError::Conflict("模特库读取失败，请重试打开".into()))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn save_brand_model_version(
    state: State<'_, BackendState>,
    command: SaveBrandModelVersionCommand,
) -> CommandResult<BrandModelProfile> {
    let library = state.brand_models.clone();
    tokio::task::spawn_blocking(move || library.save(command))
        .await
        .map_err(|_| BackendError::Conflict("模特版本保存失败，请重试保存".into()))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn approve_brand_model_version(
    state: State<'_, BackendState>,
    command: BrandModelVersionCommand,
) -> CommandResult<BrandModelProfile> {
    let library = state.brand_models.clone();
    tokio::task::spawn_blocking(move || library.approve(command))
        .await
        .map_err(|_| BackendError::Conflict("模特身份批准失败，请刷新后重试".into()))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn validate_brand_model_version(
    state: State<'_, BackendState>,
    command: BrandModelVersionCommand,
) -> CommandResult<BrandModelVersion> {
    let library = state.brand_models.clone();
    tokio::task::spawn_blocking(move || library.validate(command))
        .await
        .map_err(|_| BackendError::Conflict("模特身份检查失败，请刷新后重试".into()))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn archive_brand_model(
    state: State<'_, BackendState>,
    command: ArchiveBrandModelCommand,
) -> CommandResult<BrandModelProfile> {
    let library = state.brand_models.clone();
    tokio::task::spawn_blocking(move || library.archive(command))
        .await
        .map_err(|_| BackendError::Conflict("模特归档状态保存失败，请重试".into()))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn resume_cover_image_result(
    state: State<'_, BackendState>,
    command: ResumeCoverImageResultCommand,
) -> CommandResult<GenerationResultRecord> {
    cover_images::resume_cover_image_result(&state.storage, &state.local_results, command)
        .await
        .command()
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeGenerationResultCommand {
    pub task_id: String,
    pub result_index: u32,
}

/// 手动触发恢复单个生成结果的本地保存（图片/视频均可）。
///
/// 仅对 save_status 为 failed / interrupted / local_missing / conflict 的结果生效；
/// 成功或进行中的结果拒绝恢复。内部复用 `LocalResultService::resume_interrupted_result`，
/// 走与应用启动自动恢复相同的下载 + 校验 + 落盘流程（含指数退避重试）。
/// 成功后 emit `generation:result-saved` 事件，前端结果卡片自动刷新。
#[tauri::command]
pub async fn resume_generation_result(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: ResumeGenerationResultCommand,
) -> CommandResult<GenerationResultRecord> {
    if command.task_id.trim().is_empty() || command.result_index == 0 {
        return Err(BackendError::validation(
            "请指定需要恢复保存的生成结果",
            Value::Null,
        ))
        .command();
    }
    let result = match state
        .storage
        .get_result(&command.task_id, command.result_index)
    {
        Ok(result) => result,
        Err(error) => return Err(error).command(),
    };
    if !matches!(
        result.save_status,
        SaveStatus::Failed
            | SaveStatus::Interrupted
            | SaveStatus::LocalMissing
            | SaveStatus::Conflict
    ) {
        return Err(BackendError::validation(
            "该结果保存状态无需恢复（仅 failed/interrupted/local_missing/conflict 可手动恢复）",
            json!({
                "taskId": command.task_id,
                "resultIndex": command.result_index,
                "saveStatus": result.save_status.as_str(),
            }),
        ))
        .command();
    }
    info!(
        "[command] 手动触发恢复生成结果保存: taskId={}, resultIndex={}, mediaType={}, 当前saveStatus={}",
        command.task_id,
        command.result_index,
        result.media_type.as_str(),
        result.save_status.as_str()
    );
    let app_for_progress = app.clone();
    let progress_task_id = command.task_id.clone();
    let progress_result_index = command.result_index;
    match state
        .local_results
        .resume_interrupted_result(result, move |progress| {
            let _ = app_for_progress.emit(
                "generation:result-save-progress",
                json!({
                    "taskId": progress_task_id,
                    "resultIndex": progress_result_index,
                    "received": progress.received as f64,
                    "total": progress.total.map(|value| value as f64),
                    "bytesPerSec": if progress.bytes_per_sec.is_finite() {
                        progress.bytes_per_sec
                    } else {
                        0.0
                    },
                }),
            );
        })
        .await
    {
        Ok(saved) => {
            let _ = app.emit(
                "generation:result-saved",
                json!({
                    "taskId": command.task_id,
                    "resultIndex": command.result_index,
                    "result": saved,
                }),
            );
            Ok(saved).command()
        }
        Err(error) => Err(error).command(),
    }
}

#[tauri::command]
pub fn upsert_provider_connection(
    state: State<'_, BackendState>,
    command: UpsertProviderConnectionCommand,
) -> CommandResult<ProviderConnection> {
    validate_provider_command(&command).command()?;
    state.storage.upsert_provider_connection(&command).command()
}

#[tauri::command]
pub fn list_provider_connections(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<ProviderConnection>> {
    state.storage.list_provider_connections().command()
}

#[tauri::command]
pub fn set_credential(
    state: State<'_, BackendState>,
    command: SetCredentialCommand,
) -> CommandResult<CredentialStatus> {
    super::provider::preserve_asset_library_token_when_replacing_provider_key(
        &state.credentials,
        &command.credential_ref,
        &command.secret,
    )
    .command()?;
    state
        .credentials
        .set(&command.credential_ref, &command.secret)
        .command()?;
    state.credentials.status(&command.credential_ref).command()
}

#[tauri::command]
pub fn delete_credential(
    state: State<'_, BackendState>,
    credential_ref: String,
) -> CommandResult<()> {
    state.credentials.delete(&credential_ref).command()
}

#[tauri::command]
pub fn get_credential_status(
    state: State<'_, BackendState>,
    credential_ref: String,
) -> CommandResult<CredentialStatus> {
    state.credentials.status(&credential_ref).command()
}

/// 按引用名回读已保存的凭据明文。用于设置界面在重新打开时把已保存的密钥
/// 以明文回填到输入框（用户明确要求凭据「持久化一直显露」）。
///
/// 仅在本机凭据库内读取；这不是任何对外网络请求，读取失败（如不存在）由调用方
/// 降级为「留空沿用」语义。
#[tauri::command]
pub fn get_credential(
    state: State<'_, BackendState>,
    credential_ref: String,
) -> CommandResult<String> {
    state.credentials.get(&credential_ref).command()
}

/// 创作台模型目录：一次 IPC 拿齐「供应商 + 模型 + 参数能力表」。
///
/// 数据全部来自本地已配置项（供应商连接 / 模型定义 / 模型绑定），不触网；
/// 前端据此渲染模型下拉与参数面板，不再自己按模型名推断能力。
#[tauri::command]
pub fn list_generation_models(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<GenerationModelCatalogEntry>> {
    build_generation_model_catalog(&state).command()
}

fn build_generation_model_catalog(
    state: &State<'_, BackendState>,
) -> BackendResult<Vec<GenerationModelCatalogEntry>> {
    let providers = state.storage.list_provider_connections()?;
    let definitions = state.storage.list_model_definitions()?;
    let bindings = state.storage.list_bindings(None)?;
    // 按 id 建索引：绑定数 × 供应商数线性查找会在模型多时退化成 O(n²)，
    // 而创作台每次进入都要拉一次目录，这里用 HashMap 把它压回 O(n)。
    let providers: std::collections::HashMap<&str, &ProviderConnection> = providers
        .iter()
        .filter(|provider| provider.enabled)
        .map(|provider| (provider.id.as_str(), provider))
        .collect();
    let definitions: std::collections::HashMap<&str, &ModelDefinition> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();
    let mut entries = Vec::with_capacity(bindings.len());
    for binding in bindings {
        if !binding.enabled {
            continue;
        }
        let Some(provider) = providers.get(binding.provider_connection_id.as_str()) else {
            continue;
        };
        let Some(definition) = definitions.get(binding.model_definition_id.as_str()) else {
            continue;
        };
        let remote_model_id = binding
            .remote_model_id
            .clone()
            .or_else(|| definition.remote_model_id.clone())
            .unwrap_or_else(|| binding.model_definition_id.clone());
        entries.push(GenerationModelCatalogEntry {
            provider_connection_id: binding.provider_connection_id.clone(),
            provider_display_name: provider.display_name.clone(),
            model_definition_id: binding.model_definition_id.clone(),
            remote_model_id,
            display_name: definition.display_name.clone(),
            operations: binding.enabled_operations.clone(),
            operation_schema: definition.operations.clone(),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_model_definitions(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<ModelDefinition>> {
    state.storage.list_model_definitions().command()
}

#[tauri::command]
pub fn list_provider_model_bindings(
    state: State<'_, BackendState>,
    provider_connection_id: Option<String>,
) -> CommandResult<Vec<ProviderModelBinding>> {
    state
        .storage
        .list_bindings(provider_connection_id.as_deref())
        .command()
}

#[tauri::command]
pub async fn fetch_provider_models(
    state: State<'_, BackendState>,
    provider_connection_id: String,
    token_group: Option<String>,
) -> CommandResult<Vec<RemoteModelOption>> {
    state
        .providers
        .list_models(&provider_connection_id, token_group.as_deref())
        .await
        .command()
}

#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, BackendState>,
    provider_connection_id: String,
    token_group: Option<String>,
) -> CommandResult<ConnectivityTestResult> {
    state
        .providers
        .test_connection(&provider_connection_id, token_group.as_deref())
        .await
        .command()
}

#[tauri::command]
pub fn list_provider_token_groups(
    state: State<'_, BackendState>,
    provider_connection_id: String,
) -> CommandResult<Vec<ProviderTokenGroup>> {
    state
        .storage
        .list_provider_token_groups(&provider_connection_id)
        .command()
}

#[tauri::command]
pub fn upsert_provider_token_group(
    state: State<'_, BackendState>,
    command: UpsertProviderTokenGroupCommand,
) -> CommandResult<ProviderTokenGroup> {
    let group = state
        .storage
        .upsert_provider_token_group(&command)
        .command()?;
    // 分组密钥只写入 Windows 凭据管理器，不落库；为空表示沿用已保存密钥。
    if let Some(secret) = command.secret.filter(|value| !value.trim().is_empty()) {
        state
            .credentials
            .set(&group.credential_ref, &secret)
            .command()?;
    }
    Ok(group)
}

#[tauri::command]
pub fn delete_provider_token_group(
    state: State<'_, BackendState>,
    command: DeleteProviderTokenGroupCommand,
) -> CommandResult<()> {
    let credential_ref = state
        .storage
        .delete_provider_token_group(&command.provider_connection_id, &command.group_name)
        .command()?;
    if let Some(credential_ref) = credential_ref {
        // best-effort 清理已保存的分组密钥；凭据本身不存在不算错误。
        let _ = state.credentials.delete(&credential_ref);
    }
    Ok(())
}

/// 应用能执行的语音合成协议只有两种：豆包语音 OpenSpeech 的 SSE 接口，以及
/// OpenAI 兼容网关的 `POST /v1/tts/create`（魔芋 `seed-audio` 系）。端点由连接
/// 适配器决定，因此这里按连接判定，不看模型显示名，也不按域名猜。
fn validate_speech_bindings(
    provider_connection_id: &str,
    adapter_id: &str,
    selections: &[ProviderModelSelection],
) -> BackendResult<()> {
    let is_voice_connection = adapter_id == super::provider_adapter::DOUBAO_VOICE_ADAPTER_ID;
    let gateway_connection =
        ProviderAdapterKind::parse(adapter_id) == Some(ProviderAdapterKind::Moyu);
    for selection in selections {
        if !selection.enabled {
            continue;
        }
        if is_voice_connection {
            if selection.remote_model_id != "seed-tts-2.0"
                || selection.enabled_operations != vec![GenerationOperation::SpeechGeneration]
            {
                return Err(BackendError::validation(
                    "豆包语音连接只允许绑定 seed-tts-2.0 语音生成模型",
                    json!({"remoteModelId": selection.remote_model_id}),
                ));
            }
            continue;
        }
        if !selection
            .enabled_operations
            .contains(&GenerationOperation::SpeechGeneration)
        {
            continue;
        }
        let profile = selection
            .operation_schema
            .pointer("/speech_generation/requestProfileId")
            .and_then(Value::as_str);
        if !gateway_connection || profile != Some(GATEWAY_TTS_REQUEST_PROFILE) {
            return Err(BackendError::validation(
                if gateway_connection {
                    "该语音模型的合成端点不是应用已接入的网关 /v1/tts/create，请重新拉取模型目录后启用语音生成。"
                } else {
                    "语音生成模型只能绑定在独立的火山豆包语音连接或 OpenAI 兼容网关连接上。"
                },
                json!({
                    "providerConnectionId": provider_connection_id,
                    "remoteModelId": selection.remote_model_id,
                    "requestProfileId": profile,
                }),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn replace_provider_model_bindings(
    state: State<'_, BackendState>,
    command: ReplaceProviderModelBindingsCommand,
) -> CommandResult<Vec<ProviderModelBinding>> {
    validate_model_selections(&command).command()?;
    let provider = state
        .storage
        .get_provider_connection(&command.provider_connection_id)
        .command()?;
    validate_speech_bindings(
        &command.provider_connection_id,
        &provider.adapter_id,
        &command.selections,
    )
    .command()?;
    state
        .storage
        .replace_provider_model_bindings(&command)
        .command()
}

#[tauri::command]
pub fn save_canvas_document(
    state: State<'_, BackendState>,
    command: SaveCanvasDocumentCommand,
) -> CommandResult<CanvasDocumentRecord> {
    if command.id.trim().is_empty() || !command.document.is_object() {
        return Err(BackendError::validation(
            "canvas document requires an id and a JSON object",
            json!({ "canvasId": command.id, "documentType": command.document }),
        )
        .payload());
    }
    state.storage.save_canvas_document(&command).command()
}

#[tauri::command]
pub fn get_canvas_document(
    state: State<'_, BackendState>,
    canvas_id: String,
) -> CommandResult<CanvasDocumentRecord> {
    state.storage.get_canvas_document(&canvas_id).command()
}

#[tauri::command]
pub fn list_canvas_documents(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<CanvasDocumentSummary>> {
    state.storage.list_canvas_documents().command()
}

#[tauri::command]
pub fn delete_canvas_document(
    state: State<'_, BackendState>,
    canvas_id: String,
) -> CommandResult<()> {
    // 画布没了，在途生成任务不能继续轮询供应商、继续把产物写进磁盘：
    // 先置运行时取消位让轮询尽快停下，落库由存储层在删除画布的同一个事务里完成。
    state.tasks.cancel_canvas_tasks(&canvas_id).command()?;
    state.storage.delete_canvas_document(&canvas_id).command()
}

/// 准备签名资源补丁：按资源清单下载并校验应用自带资源（如内置 FFmpeg）。
#[tauri::command]
pub async fn prepare_runtime_components_for_update(
    app: AppHandle,
    version: String,
    manifest_url: String,
    signature: String,
) -> Result<(), String> {
    resource_update::prepare_runtime_components_for_update(
        &app,
        &version,
        &manifest_url,
        &signature,
    )
    .await
}

/// 查询资源补丁的准备进度。
#[tauri::command]
pub fn get_runtime_component_update_status() -> RuntimeResourceUpdateStatus {
    resource_update::runtime_component_update_status()
}

#[tauri::command]
pub fn start_generation(
    state: State<'_, BackendState>,
    command: StartGenerationCommand,
) -> CommandResult<String> {
    state.tasks.start(command).command()
}

/// 智能剪辑合成：校验模式目录与素材槽位后，复用既有生成任务管线下发。
#[tauri::command]
pub fn start_video_clip(
    state: State<'_, BackendState>,
    command: StartVideoClipCommand,
) -> CommandResult<String> {
    state.video_clip.start(command).command()
}

#[tauri::command]
pub fn promote_seedance_draft(
    state: State<'_, BackendState>,
    task_id: String,
) -> CommandResult<String> {
    state.tasks.promote_seedance_draft(&task_id).command()
}

#[tauri::command]
pub fn rename_generation_result(
    state: State<'_, BackendState>,
    task_id: String,
    result_index: u32,
    name: String,
) -> CommandResult<()> {
    state
        .storage
        .rename_generation_result(&task_id, result_index, &name)
        .command()
}

/// 独立提示词节点：调用已配置的文本模型生成或优化提示词；
/// 连入的图片素材会先解析为视觉理解内容块再随请求发送。
#[tauri::command]
pub async fn run_prompt_node(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: OptimizeVideoPromptCommand,
) -> CommandResult<OptimizedPromptResult> {
    let deps = super::prompt_optimize::PromptVisionDeps {
        app: &app,
        storage: &state.storage,
        lifecycle: &state.lifecycle,
        providers: &state.providers,
        assets: &state.assets,
        staging: &state.staging,
        local_base64_assets: &state.local_base64_assets,
        local_results: &state.local_results,
    };
    super::prompt_optimize::optimize_video_prompt(&deps, command)
        .await
        .command()
}

#[tauri::command]
pub fn list_generation_tasks(
    state: State<'_, BackendState>,
    query: GenerationTaskListQuery,
) -> CommandResult<GenerationTaskPage> {
    state.tasks.list(query).command()
}

#[tauri::command]
pub fn get_generation_task(
    state: State<'_, BackendState>,
    task_id: String,
) -> CommandResult<GenerationTaskDetail> {
    state.tasks.get(&task_id).command()
}

#[tauri::command]
pub fn get_generation_task_progress(
    state: State<'_, BackendState>,
    task_id: String,
) -> CommandResult<GenerationTaskProgress> {
    state.tasks.get_progress(&task_id).command()
}

/// 取消在途生成任务：停止向供应商轮询、停止把产物写进磁盘。
/// 终态任务（已成功/已失败）不动，历史保留。
#[tauri::command]
pub fn cancel_generation_task(
    state: State<'_, BackendState>,
    task_id: String,
) -> CommandResult<GenerationTaskDetail> {
    state.tasks.cancel(&task_id).command()
}

#[tauri::command]
pub fn recover_generation_tasks(state: State<'_, BackendState>) -> CommandResult<RecoveryReport> {
    state.tasks.recover().command()
}

#[tauri::command]
pub fn query_video_task_now(state: State<'_, BackendState>, task_id: String) -> CommandResult<()> {
    state.tasks.query_remote_now(&task_id).command()
}

#[tauri::command]
pub async fn list_remote_video_tasks(
    state: State<'_, BackendState>,
    command: VideoTaskListCommand,
) -> CommandResult<RemoteVideoTaskPage> {
    super::remote_video_tasks::list(&state.providers, &state.storage, &command)
        .await
        .command()
}

#[tauri::command]
pub async fn list_assets(
    state: State<'_, BackendState>,
    command: AssetListCommand,
) -> CommandResult<Vec<CloudAssetRecord>> {
    state.assets.browse(command).await.command()
}

/// 按类型统计云端素材数量（扫描当前连接/分组范围内的全部页），驱动素材面板类型 Tab 角标。
#[tauri::command]
pub async fn count_assets_by_kind(
    state: State<'_, BackendState>,
    command: AssetKindCountCommand,
) -> CommandResult<CloudAssetKindTotals> {
    state.assets.count_assets_by_kind(command).await.command()
}

#[tauri::command]
pub async fn refresh_asset_cover(
    state: State<'_, BackendState>,
    command: RefreshAssetCoverCommand,
) -> CommandResult<String> {
    state.assets.refresh_asset_cover(command).await.command()
}

#[tauri::command]
pub async fn refresh_asset_media(
    state: State<'_, BackendState>,
    command: RefreshAssetMediaCommand,
) -> CommandResult<String> {
    state.assets.refresh_asset_media(command).await.command()
}

#[tauri::command]
pub async fn create_real_person_auth_link(
    state: State<'_, BackendState>,
    command: CreateRealPersonAuthLinkCommand,
) -> CommandResult<RealPersonAuthLink> {
    state
        .assets
        .create_real_person_auth_link(command)
        .await
        .command()
}

#[tauri::command]
pub async fn list_real_person_groups(
    state: State<'_, BackendState>,
    command: RealPersonProviderCommand,
) -> CommandResult<Vec<RealPersonGroup>> {
    state
        .assets
        .list_real_person_groups(command)
        .await
        .command()
}

#[tauri::command]
pub async fn delete_real_person_asset(
    state: State<'_, BackendState>,
    command: DeleteRealPersonAssetCommand,
) -> CommandResult<String> {
    state
        .assets
        .delete_real_person_asset(command)
        .await
        .command()
}

#[tauri::command]
pub async fn delete_real_person_group(
    state: State<'_, BackendState>,
    command: DeleteRealPersonGroupCommand,
) -> CommandResult<()> {
    state
        .assets
        .delete_real_person_group(command)
        .await
        .command()
}

#[tauri::command]
pub async fn delete_asset(
    state: State<'_, BackendState>,
    command: DeleteAssetCommand,
) -> CommandResult<String> {
    let asset_id = command.id.clone();
    let provider_connection_id = command.provider_connection_id.clone();
    let deleted = state.assets.delete_asset(command).await.command()?;
    if let Err(error) = material_transfer::remove_imported_source(
        &state.material_transfer_root,
        &state.storage,
        &provider_connection_id,
        &asset_id,
    ) {
        error!("[assets] 已删除云端素材，清理本机回退正文失败: {error}");
    }
    Ok(deleted)
}

/// 复核素材库里尚未就绪的云端素材。失败结论由前端删除并通知；传输失败不在这里删除。
#[tauri::command]
pub async fn observe_asset_status(
    state: State<'_, BackendState>,
    command: ObserveAssetStatusCommand,
) -> CommandResult<AssetStatusObservation> {
    state.assets.observe_asset_status(command).await.command()
}

#[tauri::command]
pub async fn list_asset_groups(
    state: State<'_, BackendState>,
    command: ListAssetGroupsCommand,
) -> CommandResult<Vec<AssetGroupRecord>> {
    state.assets.list_asset_groups(command).await.command()
}

#[tauri::command]
pub async fn create_asset_group(
    state: State<'_, BackendState>,
    command: CreateAssetGroupCommand,
) -> CommandResult<AssetGroupRecord> {
    state.assets.create_asset_group(command).await.command()
}

#[tauri::command]
pub async fn rename_asset(
    state: State<'_, BackendState>,
    command: RenameAssetCommand,
) -> CommandResult<String> {
    state.assets.rename_asset(command).await.command()
}

/// 更新云端素材库分组信息（火山引擎 `UpdateAssetGroup`：名称/描述）。
#[tauri::command]
pub async fn update_asset_group(
    state: State<'_, BackendState>,
    command: UpdateAssetGroupCommand,
) -> CommandResult<String> {
    state.assets.update_asset_group(command).await.command()
}

/// 删除云端素材库分组及其全部素材（火山引擎 `DeleteAssetGroup`，不可逆）。
#[tauri::command]
pub async fn delete_asset_group(
    state: State<'_, BackendState>,
    command: DeleteAssetGroupCommand,
) -> CommandResult<String> {
    state.assets.delete_asset_group(command).await.command()
}

#[tauri::command]
pub fn configure_tos_staging(
    state: State<'_, BackendState>,
    config: TosStagingConfig,
) -> CommandResult<()> {
    state.staging.configure(&config).command()
}

#[tauri::command]
pub fn get_tos_staging_config(
    state: State<'_, BackendState>,
) -> CommandResult<Option<TosStagingConfig>> {
    state.storage.get_tos_config().command()
}

#[tauri::command]
pub fn get_workspace_ui_prefs(state: State<'_, BackendState>) -> CommandResult<WorkspaceUiPrefs> {
    state.storage.get_workspace_ui_prefs().command()
}

#[tauri::command]
pub fn save_workspace_ui_prefs(
    state: State<'_, BackendState>,
    prefs: WorkspaceUiPrefs,
) -> CommandResult<()> {
    state.storage.save_workspace_ui_prefs(&prefs).command()
}

#[tauri::command]
pub async fn test_tos_connectivity(
    state: State<'_, BackendState>,
) -> CommandResult<ConnectivityTestResult> {
    state.staging.test_connectivity().await.command()
}

/// 拉取整个存储桶（或指定前缀）下的对象文件到本地素材索引。
/// 列举走火山引擎 TOS ListObjectsV2（分页预签名 GET），素材正文不下载，
/// 本地索引写入后预览仍按需签发对象存储预签名 URL。
#[tauri::command]
pub async fn pull_tos_bucket_assets(
    state: State<'_, BackendState>,
    prefix: Option<String>,
) -> CommandResult<TosBucketPullSummary> {
    let started_at = std::time::Instant::now();
    info!("[staging] pull_tos_bucket_assets 命令开始: prefix={prefix:?}（None/空表示整个桶）");
    let staging = state.staging.clone();
    match staging.pull_bucket_assets(prefix.as_deref()).await {
        Ok(summary) => {
            info!(
                "[staging] pull_tos_bucket_assets 命令成功: 总对象 {}, 新导入 {}, 已存在跳过 {}, 非媒体忽略 {}, 耗时 {}ms",
                summary.total_objects,
                summary.imported,
                summary.skipped_existing,
                summary.ignored_unsupported,
                started_at.elapsed().as_millis()
            );
            Ok(summary)
        }
        Err(bad_request) => {
            let record = bad_request.runtime_record();
            error!(
                "[staging] pull_tos_bucket_assets 命令失败: 耗时 {}ms, 错误: {record}",
                started_at.elapsed().as_millis()
            );
            Err(bad_request.payload())
        }
    }
}

#[tauri::command]
pub fn start_staging_upload(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: StartStagingCommand,
) -> CommandResult<String> {
    let started_at = std::time::Instant::now();
    info!(
        "[staging] start_staging_upload 命令开始: localPath={}, purpose={}, mediaType={}, import={}",
        command.local_path,
        command.purpose,
        command.media_type.as_str(),
        match &command.import {
            Some(target) => format!(
                "导入素材库（providerConnectionId={}, name={:?}）",
                target.provider_connection_id, target.name
            ),
            None => "无（仅生成输入中转）".to_string(),
        }
    );

    let job = match state.staging.create_job(command) {
        Ok(job) => {
            info!(
                "[staging] 暂存任务记录创建成功: jobId={}, 耗时 {}ms",
                job.id,
                started_at.elapsed().as_millis()
            );
            job
        }
        Err(bad_request) => {
            let record = bad_request.runtime_record();
            error!(
                "[staging] 暂存任务记录创建失败: 耗时 {}ms, 错误: {record}",
                started_at.elapsed().as_millis()
            );
            return Err(bad_request.payload());
        }
    };

    let staging = state.staging.clone();
    let storage = state.storage.clone();
    let job_id = job.id.clone();
    let spawned_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let run_started_at = std::time::Instant::now();
        info!("[staging] 后台暂存执行开始: jobId={spawned_job_id}");
        let event = match staging.run_job(&spawned_job_id).await {
            Ok(job) => {
                info!(
                    "[staging] 后台暂存执行成功: jobId={}, 最终状态={}, assetId={:?}, 已上传 {}/{} 字节, 总耗时 {}ms",
                    spawned_job_id,
                    job.status.as_str(),
                    job.asset_id,
                    job.bytes_uploaded,
                    job.bytes_total
                        .map(|total| total.to_string())
                        .unwrap_or_else(|| "未知".to_string()),
                    run_started_at.elapsed().as_millis()
                );
                json!({ "jobId": spawned_job_id, "job": job })
            }
            Err(runtime_error) => {
                let record = runtime_error.runtime_record();
                error!(
                    "[staging] 后台暂存执行失败: jobId={}, 总耗时 {}ms, 错误: {record}",
                    spawned_job_id,
                    run_started_at.elapsed().as_millis()
                );
                if matches!(
                    &runtime_error,
                    BackendError::Protocol { details, .. }
                        if details.get("terminalStatus").and_then(Value::as_str)
                            .is_some_and(|status| status.eq_ignore_ascii_case("TimedOut"))
                ) {
                    match storage.get_staging_job(&spawned_job_id) {
                        Ok(job) => json!({ "jobId": spawned_job_id, "job": job }),
                        Err(_) => json!({ "jobId": spawned_job_id, "error": record }),
                    }
                } else {
                    json!({ "jobId": spawned_job_id, "error": record })
                }
            }
        };
        if let Err(emit_error) = app.emit("staging:state-changed", event) {
            error!(
                "[staging] staging:state-changed 事件发射失败: jobId={spawned_job_id}, 错误: {emit_error}"
            );
        }
    });
    info!(
        "[staging] start_staging_upload 命令完成（后台任务已启动）: jobId={}, 命令总耗时 {}ms",
        job_id,
        started_at.elapsed().as_millis()
    );
    Ok(job_id)
}

/// 对已被海外平台接受的上传只按本机保存的 db_id 续查，绝不再次上传文件。
#[tauri::command]
pub fn resume_staging_import(
    app: AppHandle,
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<String> {
    // 请求阶段先校验任务身份，避免后台才报一个与按钮点击无关的错误。
    let job = state.storage.get_staging_job(&job_id).command()?;
    if job.purpose != "asset_import" || job.overseas_db_id.is_none() || job.asset_id.is_some() {
        return Err(BackendError::validation(
            "staging job has no unresolved overseas upload to query",
            json!({ "jobId": job_id }),
        )
        .payload());
    }
    let staging = state.staging.clone();
    let storage = state.storage.clone();
    let spawned_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let event = match staging.resume_import_job(&spawned_job_id).await {
            Ok(job) => json!({ "jobId": spawned_job_id, "job": job }),
            // 同一任务已有查询在途时复用那次后台查询，避免第二个错误事件
            // 把前端仍在执行的任务误判为失败。
            Err(BackendError::Conflict(_)) => return,
            Err(runtime_error) => {
                let record = runtime_error.runtime_record();
                error!("[staging] 海外素材续查失败: jobId={spawned_job_id}, 错误: {record}");
                match storage.get_staging_job(&spawned_job_id) {
                    Ok(job) => json!({ "jobId": spawned_job_id, "job": job }),
                    Err(_) => json!({ "jobId": spawned_job_id, "error": record }),
                }
            }
        };
        if let Err(emit_error) = app.emit("staging:state-changed", event) {
            error!(
                "[staging] 海外素材续查事件发射失败: jobId={spawned_job_id}, 错误: {emit_error}"
            );
        }
    });
    Ok(job_id)
}

#[tauri::command]
pub fn list_local_assets(
    state: State<'_, BackendState>,
    query: Option<LocalAssetListQuery>,
) -> CommandResult<LocalAssetPage> {
    state.staging.list_local_assets(query).command()
}

#[tauri::command]
pub async fn import_local_base64_asset(
    state: State<'_, BackendState>,
    command: ImportLocalBase64AssetCommand,
) -> CommandResult<LocalBase64AssetRecord> {
    let library = state.local_base64_assets.clone();
    tauri::async_runtime::spawn_blocking(move || library.import(command))
        .await
        .map_err(|error| {
            BackendError::Conflict(format!("local import worker failed: {error}")).payload()
        })?
        .command()
}

#[tauri::command]
pub async fn save_existing_asset_to_library(
    state: State<'_, BackendState>,
    command: SaveExistingAssetCommand,
) -> CommandResult<SaveExistingAssetResult> {
    material_transfer::save_existing_asset(
        &state.assets,
        &state.staging,
        &state.local_base64_assets,
        &state.storage,
        &state.material_transfer_root,
        command,
    )
    .await
    .command()
}

#[tauri::command]
pub fn list_local_base64_assets(
    state: State<'_, BackendState>,
    query: Option<LocalAssetListQuery>,
) -> CommandResult<LocalBase64AssetPage> {
    state.local_base64_assets.list(query).command()
}

#[tauri::command]
pub fn refresh_local_base64_asset_media(
    state: State<'_, BackendState>,
    asset_id: String,
    media_type: MediaType,
) -> CommandResult<String> {
    state
        .local_base64_assets
        .refresh_media(&asset_id, media_type)
        .command()
}

#[tauri::command]
pub fn list_local_base64_asset_groups(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<LocalBase64AssetGroupRecord>> {
    state.local_base64_assets.list_groups().command()
}

#[tauri::command]
pub fn create_local_base64_asset_group(
    state: State<'_, BackendState>,
    command: CreateLocalBase64AssetGroupCommand,
) -> CommandResult<LocalBase64AssetGroupRecord> {
    state
        .local_base64_assets
        .create_group(&command.name)
        .command()
}

/// 删除本地素材分组：组内素材保留并回到未分组，不删除素材正文。
#[tauri::command]
pub fn delete_local_base64_asset_group(
    state: State<'_, BackendState>,
    command: DeleteLocalBase64AssetGroupCommand,
) -> CommandResult<()> {
    state
        .local_base64_assets
        .delete_group(&command.id)
        .command()
}

/// 批量移动本地素材到分组；返回实际命中的素材数。
#[tauri::command]
pub fn move_local_base64_assets(
    state: State<'_, BackendState>,
    command: MoveLocalBase64AssetsCommand,
) -> CommandResult<u64> {
    state
        .local_base64_assets
        .move_assets(&command.asset_ids, command.group_id.as_deref())
        .command()
}

/// 删除本地 Base64 素材：移除 `.b64` 正文、解码缓存与 SQLite 行，不可恢复。
#[tauri::command]
pub fn delete_local_base64_asset(
    state: State<'_, BackendState>,
    command: DeleteLocalBase64AssetCommand,
) -> CommandResult<String> {
    state
        .local_base64_assets
        .delete_asset(&command.id)
        .map(|_| command.id)
        .command()
}

/// 本地素材预览续签：按素材身份重新签发对象存储只读地址，供画布节点恢复过期签名。
#[tauri::command]
pub fn refresh_local_asset_media(
    state: State<'_, BackendState>,
    command: RefreshLocalAssetMediaCommand,
) -> CommandResult<String> {
    let started_at = std::time::Instant::now();
    let staging_job_id = command.staging_job_id.clone();
    match state.staging.refresh_local_asset_media(command) {
        Ok(url) => {
            info!(
                "[staging] refresh_local_asset_media 命令成功: stagingJobId={staging_job_id}, 耗时 {}ms",
                started_at.elapsed().as_millis()
            );
            Ok(url)
        }
        Err(error) => {
            let record = error.runtime_record();
            error!(
                "[staging] refresh_local_asset_media 命令失败: stagingJobId={staging_job_id}, 耗时 {}ms, 错误: {record}",
                started_at.elapsed().as_millis()
            );
            Err(error.payload())
        }
    }
}

/// 过期暂存对象地址续签：素材库把导入时的租约地址当预览地址回放，租约一小时后必失效，
/// 这里按同一对象键重新签发，供画布节点与素材清单恢复预览。
#[tauri::command]
pub fn refresh_staging_object_url(
    state: State<'_, BackendState>,
    command: RefreshStagingObjectCommand,
) -> CommandResult<String> {
    state.staging.refresh_staging_object_url(command).command()
}

/// 按云端素材身份找回导入时的本机原件。没有记录或文件已不在时返回 null。
#[tauri::command]
pub fn resolve_imported_asset_source(
    state: State<'_, BackendState>,
    asset_id: String,
) -> CommandResult<Option<ImportedAssetSource>> {
    let started_at = std::time::Instant::now();
    match state.staging.imported_asset_source(&asset_id) {
        Ok(source) => {
            info!(
                "[staging] resolve_imported_asset_source 命令成功: assetId={}, 找到原件={}, 耗时 {}ms",
                asset_id.trim(),
                source.is_some(),
                started_at.elapsed().as_millis()
            );
            Ok(source)
        }
        Err(error) => {
            let record = error.runtime_record();
            error!(
                "[staging] resolve_imported_asset_source 命令失败: assetId={}, 耗时 {}ms, 错误: {record}",
                asset_id.trim(),
                started_at.elapsed().as_millis()
            );
            Err(error.payload())
        }
    }
}

/// 列出产物上传到云端素材库的入库记录：应用重启后前端据此重建
/// `jobId → 产物节点` 映射并恢复在途上传行，不必让用户重传一次。
#[tauri::command]
pub fn list_asset_import_outputs(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<AssetImportOutputRecord>> {
    let started_at = std::time::Instant::now();
    match state.staging.list_asset_import_outputs() {
        Ok(records) => {
            info!(
                "[staging] list_asset_import_outputs 命令成功: 恢复候选 {} 条, 耗时 {}ms",
                records.len(),
                started_at.elapsed().as_millis()
            );
            Ok(records)
        }
        Err(error) => {
            let record = error.runtime_record();
            error!(
                "[staging] list_asset_import_outputs 命令失败: 耗时 {}ms, 错误: {record}",
                started_at.elapsed().as_millis()
            );
            Err(error.payload())
        }
    }
}

#[tauri::command]
pub fn get_staging_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<StagingJobRecord> {
    let started_at = std::time::Instant::now();
    // 前端进度轮询会每秒调用本命令，常规路径降级为 debug 避免刷屏；失败仍以 error 记录。
    debug!("[staging] get_staging_job 命令开始: jobId={job_id}");
    match state.storage.get_staging_job(&job_id) {
        Ok(job) => {
            debug!(
                "[staging] get_staging_job 命令成功: jobId={}, 状态={}, 已上传 {}/{} 字节, purpose={}, 耗时 {}ms",
                job_id,
                job.status.as_str(),
                job.bytes_uploaded,
                job.bytes_total
                    .map(|total| total.to_string())
                    .unwrap_or_else(|| "未知".to_string()),
                job.purpose,
                started_at.elapsed().as_millis()
            );
            Ok(job)
        }
        Err(not_found) => {
            let record = not_found.runtime_record();
            error!(
                "[staging] get_staging_job 命令失败: jobId={}, 耗时 {}ms, 错误: {record}",
                job_id,
                started_at.elapsed().as_millis()
            );
            Err(not_found.payload())
        }
    }
}

#[tauri::command]
pub async fn verify_local_result(
    state: State<'_, BackendState>,
    task_id: String,
    result_index: u32,
) -> CommandResult<GenerationResultRecord> {
    let local_results = state.local_results.clone();
    local_results
        .verify_local_result(&task_id, result_index)
        .await
        .command()
}

#[tauri::command]
pub fn backend_health(state: State<'_, BackendState>) -> CommandResult<Value> {
    let providers = state.storage.list_provider_connections().command()?;
    let models = state.storage.list_model_definitions().command()?;
    Ok(json!({
        "database": "ready",
        "providerConnectionCount": providers.len(),
        "modelDefinitionCount": models.len(),
        "timestamp": now_ms()
    }))
}

fn validate_provider_command(
    command: &UpsertProviderConnectionCommand,
) -> Result<(), BackendError> {
    if command.id.trim().is_empty()
        || command.display_name.trim().is_empty()
        || command.adapter_id.trim().is_empty()
        || command.base_url.trim().is_empty()
    {
        return Err(BackendError::validation(
            "provider connection requires id, display name, adapter id, and base URL",
            json!({ "command": command }),
        ));
    }
    if !super::provider_adapter::is_supported_adapter_id(&command.adapter_id) {
        return Err(BackendError::validation(
            "provider adapter is not supported",
            json!({
                "adapterId": command.adapter_id,
                "supported": super::provider_adapter::SUPPORTED_ADAPTER_IDS,
            }),
        ));
    }
    let url = url::Url::parse(&command.base_url)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(BackendError::validation(
            "provider base URL must be an absolute HTTP or HTTPS URL",
            json!({ "baseUrl": command.base_url }),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BackendError::validation(
            "provider base URL must not contain credentials, query parameters, or a fragment",
            json!({ "baseUrl": command.base_url }),
        ));
    }
    ProviderAdapterKind::require(&command.adapter_id)?
        .normalize_base_url(command.base_url.clone())?;
    Ok(())
}

fn validate_model_selections(
    command: &ReplaceProviderModelBindingsCommand,
) -> Result<(), BackendError> {
    if command.provider_connection_id.trim().is_empty() {
        return Err(BackendError::validation(
            "provider connection id must not be empty",
            json!({ "command": command }),
        ));
    }

    let mut model_ids = std::collections::HashSet::new();
    for selection in &command.selections {
        if selection.model_definition_id.trim().is_empty()
            || selection.display_name.trim().is_empty()
            || selection.remote_model_id.trim().is_empty()
        {
            return Err(BackendError::validation(
                "selected model requires ids and a display name",
                json!({ "selection": selection }),
            ));
        }
        if selection.enabled != !selection.enabled_operations.is_empty() {
            return Err(BackendError::validation(
                "enabled models require operations and disabled models must not expose operations",
                json!({ "selection": selection }),
            ));
        }
        if !model_ids.insert(selection.model_definition_id.as_str()) {
            return Err(BackendError::validation(
                "selected model definition ids must be unique",
                json!({ "modelDefinitionId": selection.model_definition_id }),
            ));
        }
        let expected_model_definition_id = provider_scoped_model_definition_id(
            &command.provider_connection_id,
            &selection.remote_model_id,
        );
        if selection.model_definition_id != expected_model_definition_id {
            return Err(BackendError::validation(
                "selected model definition must be scoped to its provider connection",
                json!({
                    "providerConnectionId": command.provider_connection_id,
                    "remoteModelId": selection.remote_model_id,
                    "modelDefinitionId": selection.model_definition_id,
                    "expectedModelDefinitionId": expected_model_definition_id
                }),
            ));
        }
        let has_image_operation = selection.enabled_operations.iter().any(|operation| {
            matches!(
                operation,
                GenerationOperation::TextToImage | GenerationOperation::ImageToImage
            )
        });
        let has_video_operation = selection
            .enabled_operations
            .contains(&GenerationOperation::VideoGeneration);
        if has_image_operation && has_video_operation {
            return Err(BackendError::validation(
                "a saved model must be classified as either an image model or a video model",
                json!({
                    "modelDefinitionId": selection.model_definition_id,
                    "enabledOperations": selection.enabled_operations
                }),
            ));
        }
        if !selection.operation_schema.is_null() && !selection.operation_schema.is_object() {
            return Err(BackendError::validation(
                "selected model operation schema must be a JSON object",
                json!({
                    "modelDefinitionId": selection.model_definition_id,
                    "operationSchema": selection.operation_schema
                }),
            ));
        }
        if selection.enabled {
            validate_schema_for_operations(
                &selection.operation_schema,
                &selection.remote_model_id,
                &selection.enabled_operations,
            )?;
        }
    }
    Ok(())
}

// ---------- 网络爆款视频下载（内置 yt-dlp 引擎） ----------

#[tauri::command]
pub fn get_video_downloader_engine(
    state: State<'_, BackendState>,
) -> CommandResult<VideoDownloaderEngineStatus> {
    Ok(state.downloader.engine_status())
}

#[tauri::command]
pub async fn install_video_downloader_engine(
    state: State<'_, BackendState>,
) -> CommandResult<VideoDownloaderEngineStatus> {
    Ok(state.downloader.install_engine().await)
}

#[tauri::command]
pub async fn update_video_downloader_engine(
    state: State<'_, BackendState>,
) -> CommandResult<VideoDownloaderEngineStatus> {
    Ok(state.downloader.update_engine().await)
}

#[tauri::command]
pub fn import_downloader_cookies(
    state: State<'_, BackendState>,
    source_path: String,
) -> CommandResult<VideoDownloaderEngineStatus> {
    state
        .downloader
        .import_cookies(Path::new(&source_path))
        .command()
}

#[tauri::command]
pub fn clear_downloader_cookies(
    state: State<'_, BackendState>,
) -> CommandResult<VideoDownloaderEngineStatus> {
    state.downloader.clear_cookies().command()
}

#[tauri::command]
pub fn set_downloader_cookie_browser(
    state: State<'_, BackendState>,
    browser: Option<VideoCookieBrowser>,
) -> CommandResult<VideoDownloaderEngineStatus> {
    state.downloader.set_cookie_browser(browser).command()
}

#[tauri::command]
pub fn start_video_download(
    state: State<'_, BackendState>,
    command: StartVideoDownloadCommand,
) -> CommandResult<VideoDownloadJobRecord> {
    state.downloader.start_download(&command.url).command()
}

#[tauri::command]
pub fn get_video_download_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoDownloadJobRecord> {
    state.downloader.get_job(&job_id).command()
}

#[tauri::command]
pub fn cancel_video_download(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoDownloadJobRecord> {
    state.downloader.cancel_job(&job_id).command()
}

// ---------- 画布视频合成（内置 FFmpeg 引擎） ----------

#[tauri::command]
pub fn list_speech_voices(
    state: State<'_, BackendState>,
    command: ListSpeechVoicesCommand,
) -> CommandResult<Vec<SpeechVoice>> {
    speech::list_voices(&state.storage, &state.providers, command).command()
}

#[tauri::command]
pub async fn get_speech_request_status(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: GetSpeechRequestStatusCommand,
) -> CommandResult<SpeechRequestStatus> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(BackendError::from)
        .command()?;
    speech::get_request_status(&state.composer, &downloads, command)
        .await
        .command()
}

#[tauri::command]
pub async fn synthesize_speech(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: SynthesizeSpeechCommand,
) -> CommandResult<SynthesizedSpeech> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(BackendError::from)
        .command()?;
    speech::synthesize(
        &state.storage,
        &state.providers,
        &state.composer,
        &downloads,
        command,
    )
    .await
    .command()
}

#[tauri::command]
pub async fn compose_dubbed_video(
    app: AppHandle,
    state: State<'_, BackendState>,
    command: ComposeDubbedVideoCommand,
) -> CommandResult<DubbedVideo> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(BackendError::from)
        .command()?;
    speech::compose_dubbed_video(&state.composer, &downloads, command)
        .await
        .command()
}

// ---------- 画布视频抽帧（复用内置 FFmpeg 引擎） ----------

#[tauri::command]
pub async fn start_video_frame_extraction(
    state: State<'_, BackendState>,
    command: StartVideoFrameExtractionCommand,
) -> CommandResult<VideoFrameExtractionJobRecord> {
    let service = state.frame_extractor.clone();
    tokio::task::spawn_blocking(move || {
        service.start_extraction_with_request_id(
            &command.video_path,
            command.timestamps,
            command.percentages,
            command.request_id,
        )
    })
    .await
    .map_err(|error| BackendError::Conflict(format!("抽帧任务启动失败：{error}")))
    .and_then(|result| result)
    .command()
}

#[tauri::command]
pub fn get_video_frame_extraction_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoFrameExtractionJobRecord> {
    state.frame_extractor.get_job(&job_id).command()
}

#[tauri::command]
pub fn cancel_video_frame_extraction(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoFrameExtractionJobRecord> {
    state.frame_extractor.cancel_job(&job_id).command()
}

#[tauri::command]
pub async fn retry_video_frame_extraction(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoFrameExtractionJobRecord> {
    let service = state.frame_extractor.clone();
    tokio::task::spawn_blocking(move || service.retry_job(&job_id))
        .await
        .map_err(|error| BackendError::Conflict(format!("抽帧任务恢复失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn probe_video_preparation(
    state: State<'_, BackendState>,
    source: super::types::MediaReferenceTarget,
) -> CommandResult<VideoPreparationProbe> {
    state.video_preparation.probe(source).await.command()
}

#[tauri::command]
pub async fn start_video_preparation(
    state: State<'_, BackendState>,
    command: StartVideoPreparationCommand,
) -> CommandResult<VideoPreparationJobRecord> {
    state.video_preparation.start(command).await.command()
}

#[tauri::command]
pub fn get_video_preparation_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoPreparationJobRecord> {
    state
        .video_preparation
        .get(&job_id)
        .and_then(|record| {
            record.ok_or_else(|| BackendError::NotFound(format!("视频准备任务不存在：{job_id}")))
        })
        .command()
}

#[tauri::command]
pub fn list_video_preparation_jobs(
    state: State<'_, BackendState>,
) -> CommandResult<Vec<VideoPreparationJobRecord>> {
    state.video_preparation.list().command()
}

#[tauri::command]
pub fn retry_video_preparation_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoPreparationJobRecord> {
    state.video_preparation.retry(&job_id).command()
}

#[tauri::command]
pub fn cancel_video_preparation_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoPreparationJobRecord> {
    state.video_preparation.cancel(&job_id).command()
}

#[tauri::command]
pub fn rename_video_preparation_output(
    state: State<'_, BackendState>,
    job_id: String,
    name: String,
) -> CommandResult<VideoPreparationJobRecord> {
    state
        .video_preparation
        .rename_output(&job_id, &name)
        .command()
}
