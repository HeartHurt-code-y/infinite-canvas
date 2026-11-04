use super::*;

impl Storage {
    /// Register only this dedicated model. Other bindings and token groups are untouched.
    pub fn ensure_image_upscaler(&self, provider_id: &str) -> BackendResult<String> {
        self.ensure_canvas_image_tool(provider_id, super::super::model_schema::ATLASCLOUD_UPSCALER_MODEL,
            "图片高清（2× / 4×）", super::super::model_schema::atlascloud_upscaler_schema())
    }

    pub fn ensure_image_region_editor(&self, provider_id: &str) -> BackendResult<String> {
        self.ensure_canvas_image_tool(provider_id, super::super::model_schema::ATLASCLOUD_REGION_EDIT_BINDING,
            "扩图与重绘（FLUX Dev）", super::super::model_schema::atlascloud_region_edit_schema())
    }

    fn ensure_canvas_image_tool(&self, provider_id: &str, remote_id: &str, name: &str, operation: Value) -> BackendResult<String> {
        self.ensure_canvas_media_tool(provider_id, remote_id, name, super::super::types::GenerationOperation::ImageToImage, operation)
    }

    pub fn ensure_canvas_media_tool(&self, provider_id: &str, remote_id: &str, name: &str, operation: super::super::types::GenerationOperation, schema: Value) -> BackendResult<String> {
        let provider = self.get_provider_connection(provider_id)?;
        if !provider.enabled || provider.adapter_id != super::super::provider_adapter::ATLASCLOUD_ADAPTER_ID {
            return Err(BackendError::validation(format!("{name}需要已启用的 Atlas Cloud 连接，请在全局设置中配置。"), Value::Null));
        }
        let id = provider_scoped_model_definition_id(provider_id, remote_id);
        let enabled_operations = json!([operation.as_str()]).to_string();
        let schema = json!({(operation.as_str()): schema});
        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO model_definitions (id,display_name,remote_model_id,operations_json,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?5) ON CONFLICT(id) DO UPDATE SET operations_json=excluded.operations_json,updated_at=excluded.updated_at",
            params![id,name,remote_id,serde_json::to_string(&schema)?,timestamp])?;
        transaction.execute("INSERT INTO provider_model_bindings (provider_connection_id,model_definition_id,enabled_operations_json,remote_model_id,enabled,token_group,created_at,updated_at)
            VALUES (?1,?2,?3,?4,1,NULL,?5,?5) ON CONFLICT(provider_connection_id,model_definition_id) DO UPDATE SET
            enabled_operations_json=excluded.enabled_operations_json,enabled=1,updated_at=excluded.updated_at",
            params![provider_id,id,enabled_operations,remote_id,timestamp])?;
        transaction.commit()?;
        Ok(id)
    }
}
