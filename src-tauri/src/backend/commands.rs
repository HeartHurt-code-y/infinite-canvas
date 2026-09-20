use serde_json::{Value, json};
use std::path::Path;
use tauri::{AppHandle, Emitter as _, State};
use tauri_plugin_log::log::{debug, error, info};

use super::{
    BackendState,
    blender::{BlenderEngineStatus, BlenderRenderJob, StartBlenderRenderRequest},
    commerce_sources::{self, CommerceSource},
    composer::{VideoComposerEngineStatus, VideoCompositionJobRecord},
    cover_images::{
        self, NormalizeCoverImageCommand, NormalizedCoverImage, ResumeCoverImageResultCommand,
    },
    downloader::{VideoDownloadJobRecord, VideoDownloaderEngineStatus},
    error::{BackendError, CommandResult, IntoCommandResult as _},
    frame_extractor::VideoFrameExtractionJobRecord,
    model_schema::{provider_scoped_model_definition_id, validate_schema_for_operations},
    prompt_optimize::{OptimizeVideoPromptCommand, OptimizedPromptResult},
    provider_adapter::ProviderAdapterKind,
    remotion_renderer::{
        RemotionRenderRecord, RemotionRendererPreflight, StartRemotionRenderCommand,
    },
    reverse_video::{
        DeliverReverseVideoCommand, ReverseVideoDelivery, ReverseVideoEvidence,
        ReverseVideoLearning, SaveReverseVideoEvidenceCommand,
    },
    storage::now_ms,
    storage::workflow_history::{
        SaveWorkflowHistoryCommand, WorkflowHistoryDetail, WorkflowHistoryPage,
        WorkflowHistoryQuery, WorkflowHistoryRecord,
    },
    types::{
        AssetGroupRecord, AssetImportOutputRecord, AssetKindCountCommand, AssetListCommand,
        CanvasDocumentRecord, CanvasDocumentSummary, CloudAssetKindTotals, CloudAssetRecord,
        ConnectivityTestResult, CreateAssetGroupCommand, CreateRealPersonAuthLinkCommand,
        CredentialStatus, DeleteAssetCommand, DeleteAssetGroupCommand,
        DeleteProviderTokenGroupCommand, DeleteRealPersonAssetCommand,
        DeleteRealPersonGroupCommand, GenerationOperation, GenerationResultRecord,
        GenerationTaskDetail, GenerationTaskListQuery, GenerationTaskPage, ListAssetGroupsCommand,
        LocalAssetListQuery, LocalAssetPage, ModelDefinition, ProviderConnection,
        ProviderModelBinding, ProviderTokenGroup, RealPersonAuthLink, RealPersonGroup,
        RealPersonProviderCommand, RecoveryReport, RefreshAssetCoverCommand,
        RefreshAssetMediaCommand, RefreshLocalAssetMediaCommand, RefreshStagingObjectCommand,
        RemoteModelOption, RemoteVideoTaskPage, RenameAssetCommand,
        ReplaceProviderModelBindingsCommand, SaveCanvasDocumentCommand, SaveStatus,
        SetCredentialCommand, StagingJobRecord, StartGenerationCommand, StartStagingCommand,
        StartVideoCompositionCommand, StartVideoDownloadCommand, StartVideoFrameExtractionCommand,
        TosBucketPullSummary, TosStagingConfig, UpdateAssetGroupCommand,
        UpsertProviderConnectionCommand, UpsertProviderTokenGroupCommand, VideoTaskListCommand,
    },
};

#[tauri::command]
pub async fn save_reverse_video_evidence(
    state: State<'_, BackendState>,
    command: SaveReverseVideoEvidenceCommand,
) -> CommandResult<ReverseVideoEvidence> {
    let service = state.reverse_video.clone();
    tokio::task::spawn_blocking(move || service.save_evidence(command))
        .await
        .map_err(|error| BackendError::Conflict(format!("视觉证据保存失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn get_reverse_video_learning(
    state: State<'_, BackendState>,
) -> CommandResult<ReverseVideoLearning> {
    let service = state.reverse_video.clone();
    tokio::task::spawn_blocking(move || service.get_learning())
        .await
        .map_err(|error| BackendError::Conflict(format!("案例统计读取失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn deliver_reverse_video(
    state: State<'_, BackendState>,
    command: DeliverReverseVideoCommand,
) -> CommandResult<ReverseVideoDelivery> {
    let service = state.reverse_video.clone();
    tokio::task::spawn_blocking(move || service.deliver(command))
        .await
        .map_err(|error| BackendError::Conflict(format!("反推交付保存失败：{error}")))
        .and_then(|result| result)
        .command()
}

#[tauri::command]
pub async fn fetch_commerce_sources(urls: Vec<String>) -> CommandResult<Vec<CommerceSource>> {
    commerce_sources::fetch_sources(urls).await.command()
}

#[tauri::command]
pub fn save_workflow_history(
    state: State<'_, BackendState>,
    command: SaveWorkflowHistoryCommand,
) -> CommandResult<WorkflowHistoryRecord> {
    state.storage.save_workflow_history(command).command()
}

#[tauri::command]
pub fn list_workflow_history(
    state: State<'_, BackendState>,
    query: WorkflowHistoryQuery,
) -> CommandResult<WorkflowHistoryPage> {
    state.storage.list_workflow_history(query).command()
}

#[tauri::command]
pub fn get_workflow_history(
    state: State<'_, BackendState>,
    id: String,
) -> CommandResult<WorkflowHistoryDetail> {
    state.storage.get_workflow_history(&id).command()
}

#[tauri::command]
pub fn recover_workflow_history(state: State<'_, BackendState>) -> CommandResult<u32> {
    state.storage.recover_workflow_history().command()
}

#[tauri::command]
pub async fn normalize_cover_image(
    state: State<'_, BackendState>,
    command: NormalizeCoverImageCommand,
) -> CommandResult<NormalizedCoverImage> {
    state.cover_images.normalize(command).await.command()
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
pub async fn get_blender_engine(
    state: State<'_, BackendState>,
    executable_path: Option<String>,
) -> CommandResult<BlenderEngineStatus> {
    Ok(state
        .blender
        .detect_engine(executable_path.as_deref())
        .await)
}

#[tauri::command]
pub async fn start_blender_render(
    state: State<'_, BackendState>,
    request: StartBlenderRenderRequest,
) -> CommandResult<BlenderRenderJob> {
    state.blender.start(request).await.command()
}

#[tauri::command]
pub fn get_blender_render(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<BlenderRenderJob> {
    state.blender.get(&job_id).command()
}

#[tauri::command]
pub fn cancel_blender_render(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<BlenderRenderJob> {
    state.blender.cancel(&job_id).command()
}

#[tauri::command]
pub async fn open_blender_project(
    state: State<'_, BackendState>,
    executable_path: Option<String>,
    project_path: String,
) -> CommandResult<()> {
    state
        .blender
        .open_project(executable_path.as_deref(), Path::new(&project_path))
        .await
        .command()
}

#[tauri::command]
pub fn remotion_renderer_preflight(state: State<'_, BackendState>) -> RemotionRendererPreflight {
    state.remotion_renderer.preflight()
}

#[tauri::command]
pub fn start_remotion_render(
    state: State<'_, BackendState>,
    command: StartRemotionRenderCommand,
) -> CommandResult<RemotionRenderRecord> {
    state.remotion_renderer.start(command).command()
}

#[tauri::command]
pub fn get_remotion_render(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<RemotionRenderRecord> {
    state.remotion_renderer.get(&job_id).command()
}

#[tauri::command]
pub fn cancel_remotion_render(state: State<'_, BackendState>, job_id: String) -> CommandResult<()> {
    state.remotion_renderer.cancel(&job_id).command()
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

#[tauri::command]
pub fn replace_provider_model_bindings(
    state: State<'_, BackendState>,
    command: ReplaceProviderModelBindingsCommand,
) -> CommandResult<Vec<ProviderModelBinding>> {
    validate_model_selections(&command).command()?;
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
    state.storage.delete_canvas_document(&canvas_id).command()
}

#[tauri::command]
pub fn start_generation(
    state: State<'_, BackendState>,
    command: StartGenerationCommand,
) -> CommandResult<String> {
    state.tasks.start(command).command()
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
    state.assets.delete_asset(command).await.command()
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
                json!({ "jobId": spawned_job_id, "error": record })
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

#[tauri::command]
pub fn list_local_assets(
    state: State<'_, BackendState>,
    query: Option<LocalAssetListQuery>,
) -> CommandResult<LocalAssetPage> {
    state.staging.list_local_assets(query).command()
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
pub async fn probe_mv_song(
    state: State<'_, BackendState>,
    command: super::mv_media::ProbeMvSongCommand,
) -> CommandResult<super::mv_media::MvSongProbe> {
    super::mv_media::probe_song(&state.composer, &command.source_path)
        .await
        .command()
}

#[tauri::command]
pub async fn prepare_mv_audio_window(
    state: State<'_, BackendState>,
    command: super::mv_media::PrepareMvAudioWindowCommand,
) -> CommandResult<super::mv_media::MvAudioWindow> {
    state
        .composer
        .prepare_mv_audio_window(command)
        .await
        .command()
}

#[tauri::command]
pub async fn start_mv_composition(
    state: State<'_, BackendState>,
    command: super::mv_media::StartMvCompositionCommand,
) -> CommandResult<VideoCompositionJobRecord> {
    state.composer.start_mv_composition(command).await.command()
}

#[tauri::command]
pub async fn check_mv_media_alignment(
    state: State<'_, BackendState>,
    command: super::mv_media::CheckMvAlignmentCommand,
) -> CommandResult<super::mv_media::MvMediaAlignment> {
    super::mv_media::check_alignment(&state.composer, command)
        .await
        .command()
}

#[tauri::command]
pub fn get_video_composer_engine(
    state: State<'_, BackendState>,
) -> CommandResult<VideoComposerEngineStatus> {
    Ok(state.composer.engine_status())
}

#[tauri::command]
pub async fn install_video_composer_engine(
    state: State<'_, BackendState>,
) -> CommandResult<VideoComposerEngineStatus> {
    Ok(state.composer.install_engine().await)
}

#[tauri::command]
pub fn start_video_composition(
    state: State<'_, BackendState>,
    command: StartVideoCompositionCommand,
) -> CommandResult<VideoCompositionJobRecord> {
    state.composer.start_composition(command).command()
}

#[tauri::command]
pub fn get_video_composition_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoCompositionJobRecord> {
    state.composer.get_job(&job_id).command()
}

#[tauri::command]
pub fn cancel_video_composition(
    state: State<'_, BackendState>,
    job_id: String,
) -> CommandResult<VideoCompositionJobRecord> {
    state.composer.cancel_job(&job_id).command()
}

// ---------- 画布视频抽帧（复用内置 FFmpeg 引擎） ----------

#[tauri::command]
pub fn start_video_frame_extraction(
    state: State<'_, BackendState>,
    command: StartVideoFrameExtractionCommand,
) -> CommandResult<VideoFrameExtractionJobRecord> {
    state
        .frame_extractor
        .start_extraction_with_percentages(
            &command.video_path,
            command.timestamps,
            command.percentages,
        )
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

#[cfg(test)]
mod tests {
    // 适配器 id 常量只被下面的校验用例消费（生产代码走 is_supported_adapter_id / require）。
    use super::super::provider_adapter::{ARK_ADAPTER_ID, BAILIAN_ADAPTER_ID, MOYU_ADAPTER_ID};
    use super::*;

    fn provider(base_url: &str) -> UpsertProviderConnectionCommand {
        UpsertProviderConnectionCommand {
            id: "company".into(),
            display_name: "Company".into(),
            adapter_id: MOYU_ADAPTER_ID.into(),
            base_url: base_url.into(),
            enabled: true,
        }
    }

    #[test]
    fn provider_validation_accepts_custom_paths_but_rejects_embedded_secrets() {
        assert!(validate_provider_command(&provider("https://api.example.com/openai/v1")).is_ok());
        assert!(
            validate_provider_command(&provider("https://user:pass@api.example.com/v1")).is_err()
        );
        assert!(
            validate_provider_command(&provider("https://api.example.com/v1?token=secret"))
                .is_err()
        );
        assert!(validate_provider_command(&provider("https://api.example.com/v1#models")).is_err());
    }

    #[test]
    fn provider_validation_rejects_unknown_adapters_when_saving() {
        let mut command = provider("https://api.example.com/v1");
        command.adapter_id = "unknown".into();
        assert!(validate_provider_command(&command).is_err());
    }

    #[test]
    fn provider_validation_accepts_volcengine_ark_adapter() {
        let mut command = provider("https://ark.cn-beijing.volces.com/api/v3");
        command.adapter_id = ARK_ADAPTER_ID.into();
        assert!(validate_provider_command(&command).is_ok());
    }

    #[test]
    fn provider_validation_accepts_aliyun_bailian_beijing_workspace_url() {
        let mut command = provider("https://llm-ws.cn-beijing.maas.aliyuncs.com");
        command.adapter_id = BAILIAN_ADAPTER_ID.into();
        assert!(validate_provider_command(&command).is_ok());
        command.base_url = "https://dashscope.aliyuncs.com".into();
        assert!(validate_provider_command(&command).is_err());
    }

    fn model_selection(
        provider_connection_id: &str,
        remote_model_id: &str,
        enabled_operations: Vec<GenerationOperation>,
    ) -> ReplaceProviderModelBindingsCommand {
        ReplaceProviderModelBindingsCommand {
            provider_connection_id: provider_connection_id.into(),
            selections: vec![super::super::types::ProviderModelSelection {
                model_definition_id: provider_scoped_model_definition_id(
                    provider_connection_id,
                    remote_model_id,
                ),
                display_name: "Company model".into(),
                remote_model_id: remote_model_id.into(),
                enabled: !enabled_operations.is_empty(),
                enabled_operations,
                token_group: None,
                operation_schema: json!({}),
            }],
        }
    }

    #[test]
    fn model_selection_requires_provider_scoping_and_one_generation_category() {
        let valid_image = model_selection(
            "company",
            "image-v1",
            vec![
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage,
            ],
        );
        assert!(validate_model_selections(&valid_image).is_ok());

        let disabled = model_selection("company", "declined-v1", Vec::new());
        assert!(validate_model_selections(&disabled).is_ok());

        let mixed = model_selection(
            "company",
            "mixed-v1",
            vec![
                GenerationOperation::TextToImage,
                GenerationOperation::VideoGeneration,
            ],
        );
        assert!(validate_model_selections(&mixed).is_err());

        let mut wrong_scope = model_selection(
            "company",
            "video-v1",
            vec![GenerationOperation::VideoGeneration],
        );
        wrong_scope.selections[0].model_definition_id = "remote::other::video-v1".into();
        assert!(validate_model_selections(&wrong_scope).is_err());
    }
}
