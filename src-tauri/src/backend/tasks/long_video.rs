//! Long-video children use the ordinary lifecycle with a durable, caller-assigned identity.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FrozenGenerationProfile {
    pub provider: super::super::types::ProviderConnection,
    pub api_key_ref: String,
    pub model_definition_id: String,
    pub remote_model_id: String,
    pub operation: GenerationOperation,
    pub operation_schema: Value,
}

impl GenerationTaskService {
    pub(crate) fn freeze_profile(
        &self,
        provider_id: &str,
        model_id: &str,
        operation: GenerationOperation,
    ) -> BackendResult<FrozenGenerationProfile> {
        let provider = self.storage.get_provider_connection(provider_id)?;
        let binding = self.storage.get_binding(provider_id, model_id)?;
        if !provider.enabled || !binding.enabled || !binding.enabled_operations.contains(&operation)
        {
            return Err(BackendError::validation(
                "所选连接或模型不可用，请重新选择。",
                json!({"providerId":provider_id,"modelId":model_id}),
            ));
        }
        let remote_model_id = binding
            .remote_model_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                BackendError::validation("请先保存该模型的远端模型 ID。", Value::Null)
            })?;
        let model = self
            .storage
            .list_model_definitions()?
            .into_iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| BackendError::NotFound("模型定义不存在。".into()))?;
        let operation_schema = operation_schema_for_start(
            &model.operations,
            operation,
            Some(&remote_model_id),
            RequestDialect::for_adapter(&provider.adapter_id),
        )
        .ok_or_else(|| {
            BackendError::validation("模型没有配置该操作的接口。", json!({"operation":operation}))
        })?;
        let api_key_ref = self
            .storage
            .resolve_binding_credential_ref(provider_id, binding.token_group.as_deref())?;
        self.providers
            .resolve_token_group(provider_id, binding.token_group.as_deref())?;
        Ok(FrozenGenerationProfile {
            provider,
            api_key_ref,
            model_definition_id: model_id.into(),
            remote_model_id,
            operation,
            operation_schema,
        })
    }

    /// Only creates a local record. The owner persists the child ID before calling this.
    /// Re-entry returns the original record and never repeats a paid submission.
    pub(crate) fn prepare_frozen_child(
        &self,
        task_id: &str,
        mut command: StartGenerationCommand,
        profile: &FrozenGenerationProfile,
    ) -> BackendResult<bool> {
        if self.storage.long_video_child_exists(task_id)? {
            let existing = self.get(task_id)?;
            if existing.summary.canvas_id != command.canvas_id
                || existing.summary.source_node_id != command.source_node_id
                || existing.summary.operation != command.operation
                || existing.summary.provider_connection_id != profile.provider.id
            {
                return Err(BackendError::Conflict("长视频片段任务身份冲突。".into()));
            }
            return Ok(false);
        }
        validate_start_command(&command)?;
        if command.operation != profile.operation
            || command.provider_connection_id != profile.provider.id
            || command.model_definition_id != profile.model_definition_id
        {
            return Err(BackendError::Conflict(
                "长视频任务与冻结模型不一致，请新建任务。".into(),
            ));
        }
        command.parameters = normalize_parameters(&profile.operation_schema, &command.parameters)?;
        command.model_operation_schema_snapshot = Some(profile.operation_schema.clone());
        let request = serde_json::to_value(&command)?;
        self.lifecycle.create(NewTask {
            id: task_id,
            canvas_id: &command.canvas_id,
            source_node_id: &command.source_node_id,
            operation: command.operation,
            provider: &profile.provider,
            api_key_ref: &profile.api_key_ref,
            model_definition_id: &profile.model_definition_id,
            remote_model_id: Some(&profile.remote_model_id),
            logical_request: &request,
        })?;
        self.cancellations.register(task_id);
        self.emit(
            "generation:created",
            &json!({"taskId":task_id,"sourceNodeId":command.source_node_id}),
        );
        Ok(true)
    }

    pub(crate) fn dispatch_frozen_child(&self, task_id: &str) {
        let service = self.clone();
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.execute(&task_id).await {
                let _ = service.finish_with_execution_error(&task_id, error);
            }
        });
    }
}
