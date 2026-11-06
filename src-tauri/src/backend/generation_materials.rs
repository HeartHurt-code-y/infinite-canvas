//! Optional generation preflight backed by the existing user-owned asset library.
//! Imports reuse its durable content/scope receipts; this module never submits a generation.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

use super::{
    BackendState,
    error::{BackendError, BackendResult},
    material_transfer,
    types::{
        CloudAssetIdentity, CloudAssetStatus, ExistingMaterialSource, ExistingMaterialSourceKind,
        ImportLocalBase64AssetCommand, MaterialLibraryDestination, MediaReferenceTarget, MediaType,
        ObserveAssetStatusCommand, SaveExistingAssetCommand,
    },
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyGenerationMaterialCommand {
    pub target: MediaReferenceTarget,
    pub display_name: String,
    /// Used only when a local material needs to enter the cloud library.
    pub provider_connection_id: Option<String>,
    pub generation_provider_connection_id: Option<String>,
    pub generation_model_definition_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedGenerationMaterial {
    pub target: MediaReferenceTarget,
    pub reused: bool,
}

async fn wait_ready(state: &BackendState, provider_id: &str, asset_id: &str, media_type: MediaType) -> BackendResult<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let observation = state
            .assets
            .observe_asset_status(ObserveAssetStatusCommand {
                provider_connection_id: provider_id.to_string(),
                id: asset_id.to_string(),
            })
            .await?;
        if observation.missing {
            return Err(BackendError::validation(
                "素材库中已没有这份素材，请重新入库或更换参考素材。",
                json!({ "assetId": asset_id, "missing": true }),
            ));
        }
        match observation.status {
            CloudAssetStatus::Ready => return Ok(state.assets.material_transfer_record(
                CloudAssetIdentity { provider_connection_id: provider_id.to_string(), asset_id: asset_id.to_string() },
                media_type,
            ).await?.id),
            CloudAssetStatus::Failed | CloudAssetStatus::Deleted => {
                return Err(BackendError::protocol(
                    observation.failure_reason.unwrap_or_else(|| {
                        "素材审核未通过，请在素材库检查审核原因或更换素材。".into()
                    }),
                    json!({ "assetId": asset_id, "status": observation.raw_status }),
                ));
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(BackendError::protocol(
                "素材仍在审核，本次没有提交生成。请在素材库查看原素材的审核状态，完成后再生成。",
                json!({ "assetId": asset_id, "providerConnectionId": provider_id, "status": observation.raw_status }),
            ));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn verified(
    state: &BackendState,
    command: &VerifyGenerationMaterialCommand,
    target: MediaReferenceTarget,
    reused: bool,
) -> BackendResult<VerifiedGenerationMaterial> {
    if let (Some(provider_id), Some(model_id)) = (
        command.generation_provider_connection_id.as_deref(),
        command.generation_model_definition_id.as_deref(),
    ) {
        let binding = state.storage.get_binding(provider_id, model_id)?;
        let remote_model = binding.remote_model_id.as_deref().unwrap_or(model_id);
        if super::model_schema::seedance_reference_limits(remote_model).is_some()
            && let MediaReferenceTarget::Asset { asset_id, media_type, .. } = &target
        {
            let response = state.providers.generation_asset_get(provider_id, model_id, asset_id).await?;
            super::asset_library::verified_generation_asset_id(&response, provider_id, asset_id, *media_type)?;
        }
    }
    Ok(VerifiedGenerationMaterial { target, reused })
}

pub async fn verify(
    state: &BackendState,
    command: VerifyGenerationMaterialCommand,
) -> BackendResult<VerifiedGenerationMaterial> {
    let media_type = command.target.media_type();
    if media_type == MediaType::Text || matches!(&command.target, MediaReferenceTarget::Url { .. })
    {
        return Err(BackendError::validation(
            "文档和网页不属于素材库合规审核的媒体。",
            json!({ "target": command.target }),
        ));
    }
    let canvas_node_key = match &command.target {
        MediaReferenceTarget::Asset {
            provider_connection_id,
            asset_id,
            canvas_node_key,
            ..
        } => {
            match wait_ready(state, provider_connection_id, asset_id, media_type).await {
                Ok(asset_id) if command.provider_connection_id.as_deref().is_none_or(|selected| selected == provider_connection_id) => {
                    return verified(state, &command, MediaReferenceTarget::Asset {
                        provider_connection_id: provider_connection_id.clone(), asset_id, media_type,
                        canvas_node_key: canvas_node_key.clone(),
                    }, true).await;
                }
                Ok(_) => {}
                Err(BackendError::Validation { details, .. }) if details.get("missing").and_then(serde_json::Value::as_bool) == Some(true) => {}
                Err(error) => return Err(error),
            }
            canvas_node_key.clone()
        }
        MediaReferenceTarget::LocalBase64Asset {
            canvas_node_key, ..
        }
        | MediaReferenceTarget::LocalAsset {
            canvas_node_key, ..
        }
        | MediaReferenceTarget::LocalFile {
            canvas_node_key, ..
        }
        | MediaReferenceTarget::LocalResult {
            canvas_node_key, ..
        } => canvas_node_key.clone(),
        MediaReferenceTarget::Url { .. } => unreachable!(),
    };
    let provider_id = command.provider_connection_id.as_deref().map(str::trim).filter(|v| !v.is_empty())
        .ok_or_else(|| BackendError::validation(
            "自动校验素材需要云端素材库连接。请在高级设置中选择素材库，或关闭自动校验后直接交给生成服务处理。", json!({}),
        ))?.to_string();
    let source = match &command.target {
        MediaReferenceTarget::Asset { provider_connection_id, asset_id, .. } => ExistingMaterialSource {
            kind: ExistingMaterialSourceKind::Cloud,
            asset_id: asset_id.clone(), provider_connection_id: Some(provider_connection_id.clone()), media_type,
        },
        MediaReferenceTarget::LocalBase64Asset { asset_id, .. } => ExistingMaterialSource {
            kind: ExistingMaterialSourceKind::LocalBase64,
            asset_id: asset_id.clone(),
            provider_connection_id: None,
            media_type,
        },
        MediaReferenceTarget::LocalAsset { staging_job_id, .. } => ExistingMaterialSource {
            kind: ExistingMaterialSourceKind::ObjectStorage,
            asset_id: staging_job_id.clone(),
            provider_connection_id: None,
            media_type,
        },
        MediaReferenceTarget::LocalFile { path, .. } => {
            local_source(state, path.clone(), &command.display_name, media_type).await?
        }
        MediaReferenceTarget::LocalResult {
            generation_task_id,
            result_index,
            ..
        } => {
            let record = state
                .storage
                .get_result(generation_task_id, *result_index)?;
            if record.media_type != media_type {
                return Err(BackendError::validation(
                    "产物类型与所选素材身份不一致，请重新选择。",
                    json!({ "taskId": generation_task_id, "resultIndex": result_index }),
                ));
            }
            let path = record.final_path.ok_or_else(|| {
                BackendError::validation(
                    "参考产物还没有保存完成。请等保存完成后再生成。",
                    json!({ "taskId": generation_task_id, "resultIndex": result_index }),
                )
            })?;
            local_source(state, path, &command.display_name, media_type).await?
        }
        _ => unreachable!(),
    };
    let result = material_transfer::save_existing_asset(
        &state.assets,
        &state.staging,
        &state.local_base64_assets,
        &state.storage,
        &state.material_transfer_root,
        SaveExistingAssetCommand {
            source,
            destination: MaterialLibraryDestination::Cloud,
            target_provider_connection_id: Some(provider_id.clone()),
            group_id: None,
            name: Some(command.display_name.clone()),
        },
    )
    .await?;
    let asset_id = wait_ready(state, &provider_id, &result.asset_id, media_type).await?;
    verified(state, &command, MediaReferenceTarget::Asset {
            provider_connection_id: provider_id,
            asset_id,
            media_type,
            canvas_node_key,
        }, result.reused).await
}

async fn local_source(
    state: &BackendState,
    path: String,
    name: &str,
    media_type: MediaType,
) -> BackendResult<ExistingMaterialSource> {
    let library = state.local_base64_assets.clone();
    let name = name.to_string();
    let record = tauri::async_runtime::spawn_blocking(move || {
        library.import(ImportLocalBase64AssetCommand {
            local_path: path,
            name: Some(name),
            group_id: None,
        })
    })
    .await
    .map_err(|error| BackendError::Conflict(format!("素材入库线程退出：{error}")))??;
    if record.media_type != media_type {
        return Err(BackendError::validation(
            "文件实际类型与参考素材身份不一致，请重新选择。",
            json!({ "expected": media_type, "actual": record.media_type }),
        ));
    }
    Ok(ExistingMaterialSource {
        kind: ExistingMaterialSourceKind::LocalBase64,
        asset_id: record.id,
        provider_connection_id: None,
        media_type,
    })
}
