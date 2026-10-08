use serde_json::{Value, json};

use super::{
    error::{BackendError, BackendResult},
    model_schema::{MOYU_SEEDANCE_DRAFT_PROFILE, is_seedance_draft_video_model},
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
            != Some(MOYU_SEEDANCE_DRAFT_PROFILE)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn draft_task() -> TaskExecutionRecord {
        TaskExecutionRecord {
            id: "local-draft".into(),
            operation: GenerationOperation::VideoGeneration,
            status: GenerationTaskStatus::Succeeded,
            provider_connection_id: "provider-original".into(),
            provider_display_name_snapshot: "原连接".into(),
            adapter_id_snapshot: MOYU_ADAPTER_ID.into(),
            base_url_snapshot: "https://www.moyu.info".into(),
            api_key_ref_snapshot: "provider:original:token-group:sd2-asset".into(),
            model_definition_id: "model-original".into(),
            remote_model_id_snapshot: Some("doubao-seedance-2-5-260628".into()),
            remote_task_id: Some("cgt-20260930102030-abcde".into()),
            logical_request: json!({
                "canvasId": "canvas-original", "sourceNodeId": "node-original",
                "operation": "video_generation", "providerConnectionId": "provider-original",
                "modelDefinitionId": "model-original", "outputName": "海边样片",
                "workflowRunId": "old-approved-workflow", "prompt": [{"kind":"text","text":"海边"}],
                "parameters": {"draft": true, "duration": 5, "ratio": "16:9", "resolution": "480p", "generate_audio": true},
                "modelOperationSchemaSnapshot": {"requestProfileId": MOYU_SEEDANCE_DRAFT_PROFILE},
                "generationCount": 1
            }),
            resolved_request: None,
        }
    }

    #[test]
    fn seedance_draft_promotion_preserves_identity_without_media_or_defaults() {
        let task = draft_task();
        let prepared = prepare_promotion(&task).unwrap();
        assert_eq!(prepared.provider.base_url, task.base_url_snapshot);
        assert_eq!(prepared.provider.api_key_ref, task.api_key_ref_snapshot);
        assert_eq!(
            prepared.remote_model_id,
            task.remote_model_id_snapshot.unwrap()
        );
        assert_eq!(
            prepared.command.parameters,
            json!({"draft_task_id":"cgt-20260930102030-abcde"})
        );
        assert!(prepared.command.prompt.is_empty());
        assert!(prepared.command.explicit_media.is_empty());
        assert!(prepared.command.workflow_run_id.is_none());
        assert_eq!(
            prepared
                .command
                .model_operation_schema_snapshot
                .as_ref()
                .unwrap()["requestProfileId"],
            MOYU_SEEDANCE_DRAFT_PROFILE
        );
        assert_eq!(
            prepared.command.output_name.as_deref(),
            Some("海边样片_正片")
        );
        assert_eq!(
            prepared.logical_request["seedanceDraftSourceTaskId"],
            "local-draft"
        );
        assert_eq!(prepared.logical_request["canvasId"], "canvas-original");
    }

    #[test]
    fn seedance_draft_promotion_rejects_unfinished_normal_native_or_identityless_tasks() {
        let source = draft_task();
        for variant in 0..7 {
            let mut task = source.clone();
            match variant {
                0 => task.status = GenerationTaskStatus::Running,
                1 => task.logical_request["parameters"]["draft"] = json!(false),
                2 => task.adapter_id_snapshot = "volcengine_ark_v1".into(),
                3 => task.remote_task_id = None,
                4 => task.remote_task_id = Some("../../other-task".into()),
                5 => task.logical_request["providerConnectionId"] = json!("another-provider"),
                _ => task.logical_request["seedanceDraftSourceTaskId"] = json!("another-draft"),
            }
            assert!(prepare_promotion(&task).is_err(), "variant {variant}");
        }
    }
}
