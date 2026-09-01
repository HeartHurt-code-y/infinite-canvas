use std::collections::HashMap;

use serde_json::{Value, json};
use tauri_plugin_log::log::{info, warn};

use super::{
    asset_library::{
        AssetDelivery, AssetLibrary, AssetReadTrace, ResolveAsset, ResolvedAssetAccess,
    },
    error::{BackendError, BackendResult},
    local_results::{LocalResultService, safe_file_stem, sha256_bytes},
    provider::{
        CompiledContentItem, ProviderRuntime, ResolvedGeneration, ResolvedMedia,
        redact_request_value, redact_url_string,
    },
    staging::{StagingLease, StagingService},
    storage::TaskExecutionRecord,
    types::{
        GenerationOperation, MediaReferenceTarget, MediaType, PromptSegment, SaveStatus,
        StartGenerationCommand,
    },
};

#[derive(Clone)]
pub struct MediaResolver {
    providers: ProviderRuntime,
    assets: AssetLibrary,
    local_results: LocalResultService,
    staging: StagingService,
}

pub struct ResolvedBundle {
    pub generation: ResolvedGeneration,
    pub staging_leases: Vec<StagingLease>,
}

struct ResolveTargetRequest<'a> {
    target: &'a MediaReferenceTarget,
    type_position: u32,
    role: &'a str,
    display_name: &'a str,
    prompt_segment_index: Option<usize>,
}

impl MediaResolver {
    pub fn new(
        providers: ProviderRuntime,
        assets: AssetLibrary,
        local_results: LocalResultService,
        staging: StagingService,
    ) -> Self {
        Self {
            providers,
            assets,
            local_results,
            staging,
        }
    }

    pub async fn resolve(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<ResolvedBundle> {
        let command: StartGenerationCommand = serde_json::from_value(task.logical_request.clone())?;
        if command.generation_count != 1 {
            return Err(BackendError::validation(
                "the configured Moyu MVP operations do not expose a generation count parameter",
                json!({ "generationCount": command.generation_count, "supported": 1 }),
            ));
        }

        info!(
            "[resolve] 开始解析提示词媒体引用: taskId={}, attemptId={}, 提示词片段 {} 个, 显式媒体输入 {} 个",
            task.id,
            attempt_id,
            command.prompt.len(),
            command.explicit_media.len()
        );

        let mut images = Vec::new();
        let mut videos = Vec::new();
        let mut audios = Vec::new();
        let mut content = Vec::new();
        let mut rendered_prompt = String::new();
        let mut staging_leases = Vec::new();
        let mut resolved_targets = HashMap::<MediaReferenceTarget, u32>::new();

        for (segment_index, segment) in command.prompt.iter().enumerate() {
            match segment {
                PromptSegment::Text { text } => {
                    rendered_prompt.push_str(text);
                    content.push(CompiledContentItem::Text(text.clone()));
                }
                PromptSegment::MediaReference {
                    mention_id,
                    target,
                    display_name_snapshot,
                } => {
                    let media_type = target.media_type();
                    let type_position = match plan_target_resolution(
                        &resolved_targets,
                        target,
                        &images,
                        &videos,
                        &audios,
                    ) {
                        TargetResolutionPlan::Reuse(type_position) => {
                            info!(
                                "[resolve] 复用已解析提示词媒体引用: taskId={}, 片段 #{}, {}{}, 名称={}",
                                task.id,
                                segment_index,
                                media_type.position_label(),
                                type_position,
                                display_name_snapshot
                            );
                            type_position
                        }
                        TargetResolutionPlan::Resolve(type_position) => {
                            let role = default_reference_role(media_type).to_string();
                            let (resolved, lease) = self
                                .resolve_target(
                                    task,
                                    attempt_id,
                                    ResolveTargetRequest {
                                        target,
                                        type_position,
                                        role: &role,
                                        display_name: display_name_snapshot,
                                        prompt_segment_index: Some(segment_index),
                                    },
                                )
                                .await
                                .map_err(|error| {
                                    BackendError::protocol(
                                        "media reference resolution failed",
                                        json!({
                                            "mentionId": mention_id,
                                            "segmentIndex": segment_index,
                                            "mediaType": media_type,
                                            "typePosition": type_position,
                                            "target": target,
                                            "sourceError": error.runtime_record()
                                        }),
                                    )
                                })?;
                            if let Some(lease) = lease {
                                staging_leases.push(lease);
                            }
                            info!(
                                "[resolve] 提示词引用解析成功: taskId={}, 片段 #{}, {}{}, 名称={}, 角色={}, 大小 {} 字节, mime={}",
                                task.id,
                                segment_index,
                                media_type.position_label(),
                                type_position,
                                display_name_snapshot,
                                role,
                                resolved.byte_size,
                                resolved.mime_type
                            );
                            resolved_targets.insert(target.clone(), type_position);
                            push_media(resolved, &mut images, &mut videos, &mut audios);
                            type_position
                        }
                    };
                    let marker = format!(
                        "[{}{}：{}]",
                        media_type.position_label(),
                        type_position,
                        display_name_snapshot
                    );
                    rendered_prompt.push_str(&marker);
                    content.push(CompiledContentItem::Media {
                        media_type,
                        type_position,
                    });
                }
            }
        }

        for input in &command.explicit_media {
            let media_type = input.target.media_type();
            if let Some(type_position) = resolved_type_position(&resolved_targets, &input.target) {
                info!(
                    "[resolve] 跳过重复显式媒体输入: taskId={}, {}{}, 名称={}",
                    task.id,
                    media_type.position_label(),
                    type_position,
                    input.display_name_snapshot
                );
                continue;
            }
            let type_position = next_position(media_type, &images, &videos, &audios);
            let role = if input.role.trim().is_empty() {
                default_reference_role(media_type)
            } else {
                input.role.as_str()
            };
            let (resolved, lease) = self
                .resolve_target(
                    task,
                    attempt_id,
                    ResolveTargetRequest {
                        target: &input.target,
                        type_position,
                        role,
                        display_name: &input.display_name_snapshot,
                        prompt_segment_index: None,
                    },
                )
                .await?;
            if let Some(lease) = lease {
                staging_leases.push(lease);
            }
            info!(
                "[resolve] 显式媒体输入解析成功: taskId={}, {}{}, 名称={}, 角色={}, 大小 {} 字节, mime={}",
                task.id,
                media_type.position_label(),
                type_position,
                input.display_name_snapshot,
                role,
                resolved.byte_size,
                resolved.mime_type
            );
            resolved_targets.insert(input.target.clone(), type_position);
            push_media(resolved, &mut images, &mut videos, &mut audios);
        }

        let operation_schema = command
            .model_operation_schema_snapshot
            .clone()
            .unwrap_or_else(|| json!({}));
        validate_compiled_operation(
            task.operation,
            &rendered_prompt,
            &images,
            &videos,
            &audios,
            &operation_schema,
        )?;

        Ok(ResolvedBundle {
            generation: ResolvedGeneration {
                rendered_prompt,
                content,
                images,
                videos,
                audios,
                parameters: command.parameters,
                operation_schema,
            },
            staging_leases,
        })
    }

    async fn resolve_target(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        request: ResolveTargetRequest<'_>,
    ) -> BackendResult<(ResolvedMedia, Option<StagingLease>)> {
        let ResolveTargetRequest {
            target,
            type_position,
            role,
            display_name,
            prompt_segment_index,
        } = request;
        match target {
            MediaReferenceTarget::Asset {
                provider_connection_id,
                asset_id,
                media_type,
                canvas_node_key,
            } => {
                let needs_bytes = task.operation == GenerationOperation::ImageToImage;
                let resolved = self
                    .assets
                    .resolve(ResolveAsset {
                        identity: super::types::CloudAssetIdentity {
                            provider_connection_id: provider_connection_id.clone(),
                            asset_id: asset_id.clone(),
                        },
                        expected_media_type: *media_type,
                        delivery: if needs_bytes {
                            AssetDelivery::Bytes
                        } else {
                            AssetDelivery::RemoteReadable {
                                destination_credential_ref: task.api_key_ref_snapshot.clone(),
                            }
                        },
                        trace: AssetReadTrace { task, attempt_id },
                    })
                    .await?;
                let (bytes, remote_reference) = match resolved.access {
                    ResolvedAssetAccess::Bytes(bytes) => (Some(bytes), None),
                    ResolvedAssetAccess::RemoteReference(reference) => {
                        info!(
                            "[resolve] 云端素材已解析为远端可读引用: taskId={}, assetId={}, mime={}",
                            task.id, asset_id, resolved.mime_type
                        );
                        (None, Some(reference))
                    }
                };
                Ok((
                    ResolvedMedia {
                        media_type: *media_type,
                        type_position,
                        role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({
                            "kind": "asset",
                            "providerConnectionId": provider_connection_id,
                            "assetId": asset_id,
                            "canvasNodeKey": canvas_node_key
                        }),
                        mime_type: resolved.mime_type,
                        byte_size: resolved.byte_size as u64,
                        sha256: resolved.sha256,
                        file_name: media_file_name(display_name, &resolved.file_extension),
                        bytes,
                        remote_reference,
                        prompt_segment_index,
                    },
                    None,
                ))
            }
            MediaReferenceTarget::LocalAsset {
                staging_job_id,
                media_type,
                canvas_node_key,
            } => {
                // 本地素材目录只保存稳定 job id；每次生成都重新签发对象存储读取地址，
                // 不读取供应商素材库，也不会把永久素材对象加入任务结束后的清理列表。
                let lease = self
                    .staging
                    .local_asset_lease(staging_job_id, *media_type)?;
                let bytes = self.download_asset_bytes(&lease.get_url).await?;
                let detected = infer::get(&bytes).ok_or_else(|| {
                    BackendError::protocol(
                        "local library asset media type could not be identified from file signature",
                        json!({
                            "stagingJobId": staging_job_id,
                            "byteSize": bytes.len()
                        }),
                    )
                })?;
                validate_detected_type(*media_type, detected.mime_type())?;
                let needs_bytes = task.operation == GenerationOperation::ImageToImage;
                Ok((
                    ResolvedMedia {
                        media_type: *media_type,
                        type_position,
                        role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({
                            "kind": "local_asset",
                            "stagingJobId": staging_job_id,
                            "canvasNodeKey": canvas_node_key
                        }),
                        mime_type: detected.mime_type().to_string(),
                        byte_size: bytes.len() as u64,
                        sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: needs_bytes.then_some(bytes),
                        remote_reference: (!needs_bytes).then_some(lease.get_url),
                        prompt_segment_index,
                    },
                    None,
                ))
            }
            MediaReferenceTarget::LocalResult {
                generation_task_id,
                result_index,
                media_type,
                canvas_node_key,
            } => {
                let record = self
                    .local_results
                    .verify_local_result(generation_task_id, *result_index)
                    .await?;
                if record.save_status != SaveStatus::Succeeded {
                    return Err(BackendError::validation(
                        "local generation result is not available",
                        json!({ "result": record }),
                    ));
                }
                if record.media_type != *media_type {
                    return Err(BackendError::validation(
                        "local result media type does not match the reference",
                        json!({ "expected": media_type, "actual": record.media_type }),
                    ));
                }
                let path = record.final_path.as_deref().ok_or_else(|| {
                    BackendError::protocol(
                        "saved local result has no path",
                        json!({ "generationTaskId": generation_task_id, "resultIndex": result_index }),
                    )
                })?;
                let bytes = tokio::fs::read(path).await?;
                let detected = infer::get(&bytes).ok_or_else(|| {
                    BackendError::protocol(
                        "local result media type could not be identified from file signature",
                        json!({ "path": path, "byteSize": bytes.len() }),
                    )
                })?;
                validate_detected_type(*media_type, detected.mime_type())?;
                let needs_bytes = task.operation == GenerationOperation::ImageToImage;
                let (remote_reference, lease) = if needs_bytes {
                    (None, None)
                } else {
                    let lease = self
                        .staging
                        .stage_for_remote_input(path, *media_type)
                        .await?;
                    (Some(lease.get_url.clone()), Some(lease))
                };
                Ok((
                    ResolvedMedia {
                        media_type: *media_type,
                        type_position,
                        role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({
                            "kind": "local_result",
                            "generationTaskId": generation_task_id,
                            "resultIndex": result_index,
                            "canvasNodeKey": canvas_node_key
                        }),
                        mime_type: detected.mime_type().to_string(),
                        byte_size: bytes.len() as u64,
                        sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: needs_bytes.then_some(bytes),
                        remote_reference,
                        prompt_segment_index,
                    },
                    lease,
                ))
            }
        }
    }

    async fn download_asset_bytes(&self, url: &str) -> BackendResult<Vec<u8>> {
        let redacted_url = redact_url_string(url);
        info!("[resolve] 开始下载引用素材字节: url={redacted_url}");
        let started_at = std::time::Instant::now();
        let response = self.providers.client().get(url).send().await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
            warn!(
                "[resolve] 引用素材下载失败: HTTP {status}, 耗时 {}ms, url={redacted_url}",
                started_at.elapsed().as_millis()
            );
            return Err(BackendError::protocol(
                format!("asset download returned HTTP {status}"),
                redact_request_value(&json!({
                    "httpStatus": status,
                    "url": url,
                    "rawResponse": raw
                })),
            ));
        }
        let bytes = response.bytes().await?.to_vec();
        info!(
            "[resolve] 引用素材下载完成: HTTP {status}, 耗时 {}ms, 下载 {} 字节, url={redacted_url}",
            started_at.elapsed().as_millis(),
            bytes.len()
        );
        Ok(bytes)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum TargetResolutionPlan {
    Reuse(u32),
    Resolve(u32),
}

fn plan_target_resolution(
    resolved_targets: &HashMap<MediaReferenceTarget, u32>,
    target: &MediaReferenceTarget,
    images: &[ResolvedMedia],
    videos: &[ResolvedMedia],
    audios: &[ResolvedMedia],
) -> TargetResolutionPlan {
    match resolved_type_position(resolved_targets, target) {
        Some(type_position) => TargetResolutionPlan::Reuse(type_position),
        None => TargetResolutionPlan::Resolve(next_position(
            target.media_type(),
            images,
            videos,
            audios,
        )),
    }
}

fn resolved_type_position(
    resolved_targets: &HashMap<MediaReferenceTarget, u32>,
    target: &MediaReferenceTarget,
) -> Option<u32> {
    resolved_targets.get(target).copied()
}

fn next_position(
    media_type: MediaType,
    images: &[ResolvedMedia],
    videos: &[ResolvedMedia],
    audios: &[ResolvedMedia],
) -> u32 {
    let length = match media_type {
        MediaType::Image => images.len(),
        MediaType::Video => videos.len(),
        MediaType::Audio => audios.len(),
    };
    length as u32 + 1
}

fn push_media(
    media: ResolvedMedia,
    images: &mut Vec<ResolvedMedia>,
    videos: &mut Vec<ResolvedMedia>,
    audios: &mut Vec<ResolvedMedia>,
) {
    match media.media_type {
        MediaType::Image => images.push(media),
        MediaType::Video => videos.push(media),
        MediaType::Audio => audios.push(media),
    }
}

fn default_reference_role(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "reference_image",
        MediaType::Video => "reference_video",
        MediaType::Audio => "reference_audio",
    }
}

fn media_file_name(display_name: &str, extension: &str) -> String {
    format!("{}.{}", safe_file_stem(display_name), extension)
}

fn validate_detected_type(expected: MediaType, mime: &str) -> BackendResult<()> {
    let valid = match expected {
        MediaType::Image => mime.starts_with("image/"),
        MediaType::Video => mime.starts_with("video/"),
        MediaType::Audio => mime.starts_with("audio/"),
    };
    if valid {
        Ok(())
    } else {
        Err(BackendError::validation(
            "resolved media type does not match its stable reference",
            json!({ "expectedMediaType": expected, "detectedMimeType": mime }),
        ))
    }
}

fn validate_compiled_operation(
    operation: GenerationOperation,
    prompt: &str,
    images: &[ResolvedMedia],
    videos: &[ResolvedMedia],
    audios: &[ResolvedMedia],
    operation_schema: &Value,
) -> BackendResult<()> {
    let has_media = !images.is_empty() || !videos.is_empty() || !audios.is_empty();
    let accepts_media_only_prompt = operation == GenerationOperation::VideoGeneration
        && has_media
        && operation_schema
            .pointer("/request/promptMode")
            .and_then(Value::as_str)
            == Some("prompt_or_media");
    if prompt.trim().is_empty() && !accepts_media_only_prompt {
        return Err(BackendError::validation(
            "compiled prompt must not be empty",
            json!({ "operation": operation }),
        ));
    }
    match operation {
        GenerationOperation::TextToImage
            if !images.is_empty() || !videos.is_empty() || !audios.is_empty() =>
        {
            Err(BackendError::validation(
                "text-to-image cannot encode media references",
                json!({
                    "images": images.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "videos": videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "audios": audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>()
                }),
            ))
        }
        GenerationOperation::ImageToImage if images.is_empty() => Err(BackendError::validation(
            "image-to-image requires at least one image",
            json!({ "operation": operation }),
        )),
        GenerationOperation::ImageToImage if !videos.is_empty() || !audios.is_empty() => {
            Err(BackendError::validation(
                "image-to-image cannot encode video or audio references",
                json!({
                    "videos": videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "audios": audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>()
                }),
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset_target(asset_id: &str, canvas_node_key: Option<&str>) -> MediaReferenceTarget {
        MediaReferenceTarget::Asset {
            provider_connection_id: "company".into(),
            asset_id: asset_id.into(),
            media_type: MediaType::Image,
            canvas_node_key: canvas_node_key.map(str::to_string),
        }
    }

    fn local_result_target(
        task_id: &str,
        result_index: u32,
        canvas_node_key: Option<&str>,
    ) -> MediaReferenceTarget {
        MediaReferenceTarget::LocalResult {
            generation_task_id: task_id.into(),
            result_index,
            media_type: MediaType::Video,
            canvas_node_key: canvas_node_key.map(str::to_string),
        }
    }

    fn resolved_media(media_type: MediaType, type_position: u32) -> ResolvedMedia {
        ResolvedMedia {
            media_type,
            type_position,
            role: default_reference_role(media_type).into(),
            display_name: "reference".into(),
            stable_identity: json!({}),
            mime_type: match media_type {
                MediaType::Image => "image/png",
                MediaType::Video => "video/mp4",
                MediaType::Audio => "audio/mpeg",
            }
            .into(),
            byte_size: 1,
            sha256: "x".into(),
            file_name: "reference.bin".into(),
            bytes: None,
            remote_reference: None,
            prompt_segment_index: Some(0),
        }
    }

    #[test]
    fn each_media_type_has_an_independent_position_sequence() {
        let mut images = Vec::new();
        let videos = Vec::new();
        let audios = Vec::new();
        assert_eq!(
            next_position(MediaType::Image, &images, &videos, &audios),
            1
        );
        images.push(ResolvedMedia {
            media_type: MediaType::Image,
            type_position: 1,
            role: "reference_image".into(),
            display_name: "A".into(),
            stable_identity: json!({}),
            mime_type: "image/png".into(),
            byte_size: 1,
            sha256: "x".into(),
            file_name: "a.png".into(),
            bytes: None,
            remote_reference: None,
            prompt_segment_index: Some(0),
        });
        assert_eq!(
            next_position(MediaType::Video, &images, &videos, &audios),
            1
        );
        assert_eq!(
            next_position(MediaType::Audio, &images, &videos, &audios),
            1
        );
        assert_eq!(
            next_position(MediaType::Image, &images, &videos, &audios),
            2
        );
    }

    #[test]
    fn repeated_asset_target_reuses_the_first_resolution_and_position() {
        let target = asset_target("asset-1", Some("node-1"));
        let first = resolved_media(MediaType::Image, 1);
        let images = vec![first.clone()];
        let mut resolved_targets = HashMap::new();
        resolved_targets.insert(target.clone(), first.type_position);

        assert_eq!(
            plan_target_resolution(&resolved_targets, &target, &images, &[], &[]),
            TargetResolutionPlan::Reuse(1)
        );
        assert_eq!(resolved_type_position(&resolved_targets, &target), Some(1));
    }

    #[test]
    fn same_asset_on_different_canvas_nodes_is_a_distinct_target() {
        let first_target = asset_target("asset-1", Some("node-1"));
        let second_target = asset_target("asset-1", Some("node-2"));
        let first = resolved_media(MediaType::Image, 1);
        let images = vec![first.clone()];
        let mut resolved_targets = HashMap::new();
        resolved_targets.insert(first_target, first.type_position);

        assert_eq!(
            plan_target_resolution(&resolved_targets, &second_target, &images, &[], &[]),
            TargetResolutionPlan::Resolve(2)
        );
        assert_eq!(
            resolved_type_position(&resolved_targets, &second_target),
            None
        );
    }

    #[test]
    fn repeated_local_result_target_is_deduplicated_too() {
        let target = local_result_target("task-1", 0, Some("output-node-1"));
        let first = resolved_media(MediaType::Video, 1);
        let videos = vec![first.clone()];
        let mut resolved_targets = HashMap::new();
        resolved_targets.insert(target.clone(), first.type_position);

        assert_eq!(
            plan_target_resolution(&resolved_targets, &target, &[], &videos, &[]),
            TargetResolutionPlan::Reuse(1)
        );
    }

    #[test]
    fn repeated_local_result_source_on_distinct_canvas_nodes_is_not_deduplicated() {
        let first_target = local_result_target("task-1", 0, Some("output-node-1"));
        let second_target = local_result_target("task-1", 0, Some("output-node-2"));
        let first = resolved_media(MediaType::Video, 1);
        let videos = vec![first.clone()];
        let mut resolved_targets = HashMap::new();
        resolved_targets.insert(first_target, first.type_position);

        assert_eq!(
            plan_target_resolution(&resolved_targets, &second_target, &[], &videos, &[]),
            TargetResolutionPlan::Resolve(2)
        );
    }
}
