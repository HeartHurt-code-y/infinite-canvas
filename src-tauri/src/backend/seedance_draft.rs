use serde_json::{Value, json};

use super::{
    error::{BackendError, BackendResult},
    gateway_profile::GatewayProfile,
    model_schema::is_seedance_draft_video_model,
    provider_adapter::MOYU_ADAPTER_ID,
    storage::TaskExecutionRecord,
    types::{
        GenerationOperation, GenerationTaskStatus, ProviderConnection, StartGenerationCommand,
    },
};

pub(crate) struct PreparedDraftPromotion {
    pub command: StartGenerationCommand,
    pub logical_request: Value,
    pub provider: ProviderConnection,
    pub remote_model_id: String,
}

/// A final video reuses the original credential scope and the remote draft identity.
/// Canvas media, generation defaults and workflow approval never carry into this request.
pub(crate) fn prepare_promotion(
    task: &TaskExecutionRecord,
    observed_response: Option<&str>,
) -> BackendResult<PreparedDraftPromotion> {
    let remote_model_id = task.remote_model_id_snapshot.as_deref().unwrap_or_default();
    if task.operation != GenerationOperation::VideoGeneration
        || task.status != GenerationTaskStatus::Succeeded
        || task.adapter_id_snapshot != MOYU_ADAPTER_ID
        || !is_seedance_draft_video_model(remote_model_id)
    {
        return Err(BackendError::validation(
            "仅此接口已成功的 Seedance 2.5 草稿样片可以生成正片",
            json!({ "taskId": task.id }),
        ));
    }
    let source: StartGenerationCommand = serde_json::from_value(task.logical_request.clone())?;
    if source.parameters.get("draft").and_then(Value::as_bool) != Some(true)
        || source
            .model_operation_schema_snapshot
            .as_ref()
            .and_then(|schema| schema.get("requestProfileId"))
            .and_then(Value::as_str)
            != Some(GatewayProfile::SeedanceDraft.profile_id())
        || task
            .logical_request
            .get("seedanceDraftSourceTaskId")
            .is_some()
        || source.provider_connection_id != task.provider_connection_id
        || source.model_definition_id != task.model_definition_id
    {
        return Err(BackendError::validation(
            "来源任务不是可审核的草稿样片，或冻结身份不一致",
            json!({ "taskId": task.id }),
        ));
    }
    // A gateway may accept draft:true but produce a normal video. The request alone
    // never proves that the returned remote task can be reused as a draft.
    let observed = observed_response.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let mut envelope = observed.as_ref();
    let mut mode = None;
    for _ in 0..8 {
        let Some(value) = envelope else { break };
        if let Some(draft) = value.get("draft").and_then(Value::as_bool) {
            mode = Some(draft);
        }
        envelope = value.get("data");
    }
    if mode != Some(true) {
        return Err(BackendError::validation(
            if mode == Some(false) {
                "供应商返回的是普通视频（draft:false），没有生成可复用的样片，不能转正片。原视频已保留；请联系该供应商核对样片支持，或在清晰度中选择 1080P 直接生成。"
            } else {
                "供应商未确认样片身份，暂不能转正片。原视频已保留，请在任务详情中核对供应商返回。"
            },
            json!({ "taskId": task.id, "reason": "seedance_draft_not_confirmed", "providerDraft": mode }),
        ));
    }
    let remote_task_id = task
        .remote_task_id
        .as_deref()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 256
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .ok_or_else(|| {
            BackendError::validation(
                "草稿样片缺少有效的远程任务 ID",
                json!({ "taskId": task.id }),
            )
        })?;
    let output_name = source
        .output_name
        .as_ref()
        .map(|name| format!("{}_正片", name.chars().take(97).collect::<String>()));
    let command = StartGenerationCommand {
        client_task_id: None,
        camera_control_snapshot: None,
        image_preset_snapshot: None,
        output_name,
        workflow_run_id: None,
        canvas_id: source.canvas_id,
        source_node_id: source.source_node_id,
        operation: GenerationOperation::VideoGeneration,
        provider_connection_id: task.provider_connection_id.clone(),
        model_definition_id: task.model_definition_id.clone(),
        prompt: Vec::new(),
        explicit_media: Vec::new(),
        parameters: json!({ "draft_task_id": remote_task_id }),
        video_task_type: None,
        use_original_cloud_media: None,
        model_operation_schema_snapshot: source.model_operation_schema_snapshot,
        generation_count: 1,
    };
    let mut logical_request = serde_json::to_value(&command)?;
    logical_request["seedanceDraftSourceTaskId"] = json!(task.id);
    Ok(PreparedDraftPromotion {
        command,
        logical_request,
        provider: ProviderConnection {
            id: task.provider_connection_id.clone(),
            display_name: task.provider_display_name_snapshot.clone(),
            adapter_id: task.adapter_id_snapshot.clone(),
            base_url: task.base_url_snapshot.clone(),
            api_key_ref: task.api_key_ref_snapshot.clone(),
            enabled: true,
            created_at: 0,
            updated_at: 0,
        },
        remote_model_id: remote_model_id.to_string(),
    })
}
