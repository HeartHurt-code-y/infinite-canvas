use std::collections::HashMap;

use rand::Rng as _;
use serde_json::{Value, json};
use tauri_plugin_log::log::{error, info, warn};

use super::{
    asset_library::{
        AssetDelivery, AssetLibrary, AssetReadTrace, ResolveAsset, ResolvedAssetAccess,
    },
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    local_results::{LocalResultService, safe_file_stem, sha256_bytes},
    model_schema::{is_seedance_25_video_model, is_seedream_image_model},
    provider::{
        CompiledContentItem, ProviderRuntime, ResolvedGeneration, ResolvedMedia,
        redact_request_value, redact_url_string, seedance_video_task_type,
    },
    staging::{StagingLease, StagingService, fake_ip_aware_client},
    storage::TaskExecutionRecord,
    types::{
        ExplicitMediaInput, GenerationOperation, MediaReferenceTarget, MediaType, PromptSegment,
        SaveStatus, StartGenerationCommand, VideoTaskType,
    },
};

/// 云端素材解析遇传输层故障（超时/连接失败等瞬时网络错误，例如请求素材库网关
/// `/v1/assets/get` 失败）时的自动指数退避重试次数。`3` 表示除首次尝试外再自动
/// 重试 3 次（共尝试 4 次），退避节奏为约 2s / 4s / 8s。
const ASSET_RESOLVE_RETRIES: u32 = 3;

/// 本地素材库对象字节下载遇传输层故障（连接失败/超时等瞬时网络错误，例如代理
/// fake-ip 抖动导致对象存储连接被拒）时的自动指数退避重试次数。`3` 表示除首次
/// 尝试外再自动重试 3 次（共尝试 4 次），退避节奏为约 2s / 4s / 8s。
const LOCAL_ASSET_DOWNLOAD_RETRIES: u32 = 3;

#[derive(Clone)]
pub struct MediaResolver {
    providers: ProviderRuntime,
    assets: AssetLibrary,
    local_results: LocalResultService,
    staging: StagingService,
    composer: VideoCompositionService,
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
    /// 前端按输入（连线）顺序分配的全局序号，用于确定 content 数组顺序。
    content_index: Option<u32>,
    /// 图生图参考图是否必须读成本地字节。Seedream 图生图要公网 URL，不能走这条。
    needs_local_bytes: bool,
}

#[derive(Debug)]
struct PlannedMediaInput<'a> {
    target: &'a MediaReferenceTarget,
    display_name: &'a str,
    role: &'a str,
    type_position: u32,
    content_index: Option<u32>,
    prompt_segment_index: Option<usize>,
}

#[derive(Debug)]
struct MediaPlan<'a> {
    inputs: Vec<PlannedMediaInput<'a>>,
    rendered_prompt: String,
    content: Vec<CompiledContentItem>,
}

struct MediaDeclaration<'a> {
    target: &'a MediaReferenceTarget,
    display_name: &'a str,
    role: Option<&'a str>,
    type_position: Option<u32>,
    content_index: Option<u32>,
    prompt_segment_index: Option<usize>,
}

/// 冻结后的输入位置只有一个来源。先验证完整计划，再读取文件或请求远程素材。
/// 旧请求完全没有位置时，保留引用首次出现、未引用显式输入追加的历史顺序。
fn build_media_plan<'a>(
    prompt: &'a [PromptSegment],
    explicit_media: &'a [ExplicitMediaInput],
) -> BackendResult<MediaPlan<'a>> {
    let declarations = prompt
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| match segment {
            PromptSegment::Text { .. } => None,
            PromptSegment::MediaReference {
                target,
                display_name_snapshot,
                type_position,
                content_index,
                ..
            } => Some(MediaDeclaration {
                target,
                display_name: display_name_snapshot,
                role: None,
                type_position: *type_position,
                content_index: *content_index,
                prompt_segment_index: Some(index),
            }),
        })
        .chain(explicit_media.iter().map(|input| MediaDeclaration {
            target: &input.target,
            display_name: &input.display_name_snapshot,
            role: Some(if input.role.trim().is_empty() {
                default_reference_role(input.target.media_type())
            } else {
                input.role.as_str()
            }),
            type_position: input.type_position,
            content_index: input.content_index,
            prompt_segment_index: None,
        }));
    let mut targets = HashMap::<&MediaReferenceTarget, usize>::new();
    let mut unique = Vec::<MediaDeclaration<'a>>::new();
    for declaration in declarations {
        if declaration.target.media_type() == MediaType::Text {
            return Err(BackendError::validation(
                "text results cannot be used as media inputs",
                json!({ "target": declaration.target }),
            ));
        }
        if let Some(&index) = targets.get(declaration.target) {
            let existing = &mut unique[index];
            if matches!((existing.role, declaration.role), (Some(a), Some(b)) if a != b)
                || matches!((existing.type_position, declaration.type_position), (Some(a), Some(b)) if a != b)
                || matches!((existing.content_index, declaration.content_index), (Some(a), Some(b)) if a != b)
            {
                return Err(BackendError::validation(
                    "repeated media target has conflicting frozen metadata",
                    json!({
                        "target": declaration.target,
                        "roles": [existing.role, declaration.role],
                        "typePositions": [existing.type_position, declaration.type_position],
                        "contentIndices": [existing.content_index, declaration.content_index]
                    }),
                ));
            }
            // 显示名不参与身份校验；旧芯片可保留旧快照，媒体归档采用显式输入的当前名称。
            if declaration.role.is_some() {
                existing.display_name = declaration.display_name;
            }
            existing.role = existing.role.or(declaration.role);
            existing.type_position = existing.type_position.or(declaration.type_position);
            existing.content_index = existing.content_index.or(declaration.content_index);
        } else {
            targets.insert(declaration.target, unique.len());
            unique.push(declaration);
        }
    }

    let has_positions = unique
        .iter()
        .any(|input| input.type_position.is_some() || input.content_index.is_some());
    if has_positions {
        // 缺少编号的旧式片段可以从同目标的显式输入继承，但独立目标不能混用两套编号。
        if let Some(input) = unique
            .iter()
            .find(|input| input.type_position.is_none() || input.content_index.is_none())
        {
            return Err(BackendError::validation(
                "numbered media inputs require both typePosition and contentIndex",
                json!({ "target": input.target }),
            ));
        }
        unique.sort_by_key(|input| input.content_index);
    }
    let mut counts = HashMap::<MediaType, u32>::new();
    let mut inputs = Vec::with_capacity(unique.len());
    for (index, input) in unique.into_iter().enumerate() {
        let count = counts.entry(input.target.media_type()).or_default();
        *count += 1;
        let content_index = index as u32 + 1;
        if has_positions
            && (input.type_position != Some(*count) || input.content_index != Some(content_index))
        {
            return Err(BackendError::validation(
                "media positions must be continuous and match their connection order",
                json!({
                    "target": input.target,
                    "typePosition": input.type_position,
                    "expectedTypePosition": count,
                    "contentIndex": input.content_index,
                    "expectedContentIndex": content_index
                }),
            ));
        }
        inputs.push(PlannedMediaInput {
            target: input.target,
            display_name: input.display_name,
            role: input
                .role
                .unwrap_or_else(|| default_reference_role(input.target.media_type())),
            type_position: *count,
            // None keeps the provider's historical mixed-media expansion for old commands.
            content_index: has_positions.then_some(content_index),
            prompt_segment_index: input.prompt_segment_index,
        });
    }

    let by_target = inputs
        .iter()
        .map(|input| (input.target, input))
        .collect::<HashMap<_, _>>();
    let mut rendered_prompt = String::new();
    let mut content = Vec::with_capacity(prompt.len());
    for segment in prompt {
        match segment {
            PromptSegment::Text { text } => {
                rendered_prompt.push_str(text);
                content.push(CompiledContentItem::Text(text.clone()));
            }
            PromptSegment::MediaReference {
                target,
                display_name_snapshot,
                ..
            } => {
                let input = by_target[target];
                rendered_prompt.push_str(&format!(
                    "[{}{}：{}]",
                    target.media_type().position_label(),
                    input.type_position,
                    display_name_snapshot
                ));
                content.push(CompiledContentItem::Media {
                    media_type: target.media_type(),
                    type_position: input.type_position,
                });
            }
        }
    }
    Ok(MediaPlan {
        inputs,
        rendered_prompt,
        content,
    })
}

impl MediaResolver {
    pub fn new(
        providers: ProviderRuntime,
        assets: AssetLibrary,
        local_results: LocalResultService,
        staging: StagingService,
        composer: VideoCompositionService,
    ) -> Self {
        Self {
            providers,
            assets,
            local_results,
            staging,
            composer,
        }
    }

    pub async fn resolve(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<ResolvedBundle> {
        let mut staging_leases = Vec::new();
        match self
            .resolve_generation(task, attempt_id, &mut staging_leases)
            .await
        {
            Ok(generation) => Ok(ResolvedBundle {
                generation,
                staging_leases,
            }),
            Err(error) => {
                // resolve 未返回 bundle 时，任务服务无法取得租约；在这里回收已创建
                // 的暂存对象，包含当前视频探测失败前刚取得的租约。
                for lease in &staging_leases {
                    if let Err(cleanup_error) = self.staging.cleanup_lease(lease).await {
                        warn!(
                            "[resolve] 失败任务暂存回收失败: taskId={}, jobId={}, error={}",
                            task.id,
                            lease.job_id,
                            cleanup_error.runtime_record()
                        );
                    }
                }
                Err(error)
            }
        }
    }

    async fn resolve_generation(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        staging_leases: &mut Vec<StagingLease>,
    ) -> BackendResult<ResolvedGeneration> {
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
        let MediaPlan {
            inputs,
            rendered_prompt,
            content,
        } = build_media_plan(&command.prompt, &command.explicit_media)?;
        let operation_schema = command
            .model_operation_schema_snapshot
            .clone()
            .unwrap_or_else(|| json!({}));
        let needs_local_bytes = image_edit_needs_local_bytes(
            task.operation,
            task.remote_model_id_snapshot.as_deref(),
            &operation_schema,
        );
        let task_type = seedance_video_task_type(command.video_task_type, &command.parameters);
        let probe_task_videos = task.operation == GenerationOperation::VideoGeneration
            && task
                .remote_model_id_snapshot
                .as_deref()
                .is_some_and(is_seedance_25_video_model)
            && matches!(task_type, VideoTaskType::Edit | VideoTaskType::Extend);
        for input in inputs {
            let (mut resolved, lease) = self
                .resolve_target(
                    task,
                    attempt_id,
                    ResolveTargetRequest {
                        target: input.target,
                        type_position: input.type_position,
                        role: input.role,
                        display_name: input.display_name,
                        prompt_segment_index: input.prompt_segment_index,
                        content_index: input.content_index,
                        needs_local_bytes,
                    },
                )
                .await
                .map_err(|error| {
                    if let Some(segment_index) = input.prompt_segment_index {
                        let mention_id = match &command.prompt[segment_index] {
                            PromptSegment::MediaReference { mention_id, .. } => mention_id,
                            PromptSegment::Text { .. } => unreachable!("planned media reference"),
                        };
                        BackendError::protocol(
                            "media reference resolution failed",
                            json!({
                                "mentionId": mention_id,
                                "segmentIndex": segment_index,
                                "mediaType": input.target.media_type(),
                                "typePosition": input.type_position,
                                "target": input.target,
                                "sourceError": error.runtime_record()
                            }),
                        )
                    } else {
                        error
                    }
                })?;
            if let Some(lease) = lease {
                staging_leases.push(lease);
            }
            if probe_task_videos && resolved.media_type == MediaType::Video {
                let minimum_seconds = if task_type == VideoTaskType::Edit {
                    4
                } else {
                    2
                };
                let duration = self.probe_input_video_duration(task, attempt_id, input.target, &resolved).await.map_err(|error| {
                    BackendError::validation(
                        format!("无法确认参考视频「{}」的实际时长，当前任务要求 {minimum_seconds}–30 秒，请检查素材是否可读取", input.display_name),
                        redact_request_value(&json!({ "media": resolved.archive(), "sourceError": error.runtime_record() })),
                    )
                })?;
                resolved.duration_seconds = Some(duration);
            }
            info!(
                "[resolve] 媒体输入解析成功: taskId={}, {}{}, 名称={}, 角色={}, 大小 {} 字节, mime={}",
                task.id,
                input.target.media_type().position_label(),
                input.type_position,
                input.display_name,
                input.role,
                resolved.byte_size,
                resolved.mime_type
            );
            push_media(resolved, &mut images, &mut videos, &mut audios);
        }

        validate_compiled_operation(
            task.operation,
            &rendered_prompt,
            &images,
            &videos,
            &audios,
            &operation_schema,
        )?;

        // 每类数组直接遵循已经校验的同类编号；供应商不能再决定另一套顺序。
        images.sort_by_key(|media| media.type_position);
        videos.sort_by_key(|media| media.type_position);
        audios.sort_by_key(|media| media.type_position);

        Ok(ResolvedGeneration {
            rendered_prompt,
            content,
            images,
            videos,
            audios,
            parameters: command.parameters,
            video_task_type: command.video_task_type,
            operation_schema,
        })
    }

    async fn probe_input_video_duration(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        target: &MediaReferenceTarget,
        media: &ResolvedMedia,
    ) -> BackendResult<f64> {
        match target {
            MediaReferenceTarget::LocalFile { path, .. } => {
                self.composer.probe_video_duration(path).await
            }
            MediaReferenceTarget::LocalResult {
                generation_task_id,
                result_index,
                ..
            } => {
                let record = self
                    .local_results
                    .verify_local_result(generation_task_id, *result_index)
                    .await?;
                let path = record.final_path.ok_or_else(|| {
                    BackendError::validation("本地视频结果没有可读取的文件", media.archive())
                })?;
                self.composer.probe_video_duration(&path).await
            }
            MediaReferenceTarget::Asset {
                provider_connection_id,
                asset_id,
                ..
            } => {
                // Asset:// 是模型引用身份，不能交给 ffprobe。使用同一素材服务解析
                // 可下载的真实字节，避免相信名称、封面或前端 duration 元数据。
                let asset = self
                    .assets
                    .resolve(ResolveAsset {
                        identity: super::types::CloudAssetIdentity {
                            provider_connection_id: provider_connection_id.clone(),
                            asset_id: asset_id.clone(),
                        },
                        expected_media_type: MediaType::Video,
                        delivery: AssetDelivery::Bytes,
                        trace: AssetReadTrace { task, attempt_id },
                    })
                    .await?;
                let ResolvedAssetAccess::Bytes(bytes) = asset.access else {
                    return Err(BackendError::protocol(
                        "视频时长校验未取得可读取的素材字节",
                        media.archive(),
                    ));
                };
                self.composer.probe_video_bytes_duration(&bytes).await
            }
            MediaReferenceTarget::LocalAsset { .. } | MediaReferenceTarget::Url { .. } => {
                let source = media.remote_reference.as_deref().ok_or_else(|| {
                    BackendError::validation("视频没有可读取的来源", media.archive())
                })?;
                self.composer.probe_video_duration(source).await
            }
        }
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
            content_index,
            needs_local_bytes,
        } = request;
        match target {
            MediaReferenceTarget::Asset {
                provider_connection_id,
                asset_id,
                media_type,
                canvas_node_key,
            } => {
                let resolved =
                    with_transport_retry("云端素材解析", ASSET_RESOLVE_RETRIES, || {
                        self.assets.resolve(ResolveAsset {
                            identity: super::types::CloudAssetIdentity {
                                provider_connection_id: provider_connection_id.clone(),
                                asset_id: asset_id.clone(),
                            },
                            expected_media_type: *media_type,
                            delivery: if needs_local_bytes {
                                AssetDelivery::Bytes
                            } else {
                                AssetDelivery::RemoteReadable {
                                    destination_provider_connection_id: task
                                        .provider_connection_id
                                        .clone(),
                                }
                            },
                            trace: AssetReadTrace { task, attempt_id },
                        })
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
                        duration_seconds: None,
                        byte_size: resolved.byte_size as u64,
                        sha256: resolved.sha256,
                        file_name: media_file_name(display_name, &resolved.file_extension),
                        bytes,
                        remote_reference,
                        prompt_segment_index,
                        content_index,
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
                // 每次尝试都重新签发一次地址：预签名地址是短期凭据，瞬时网络故障重试
                // 时必须换新签名，不能复用已经失败过的地址。
                let (bytes, get_url) = download_with_fresh_lease(
                    LOCAL_ASSET_DOWNLOAD_RETRIES,
                    || {
                        self.staging
                            .local_asset_lease(staging_job_id, *media_type)
                            .map(|lease| lease.get_url)
                    },
                    |url: String| async move { self.download_asset_bytes(&url).await },
                )
                .await?;
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
                        duration_seconds: None,
                        byte_size: bytes.len() as u64,
                        sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: needs_local_bytes.then_some(bytes),
                        remote_reference: (!needs_local_bytes).then_some(get_url),
                        prompt_segment_index,
                        content_index,
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
                let (remote_reference, lease) = if needs_local_bytes {
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
                        duration_seconds: None,
                        byte_size: bytes.len() as u64,
                        sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: needs_local_bytes.then_some(bytes),
                        remote_reference,
                        prompt_segment_index,
                        content_index,
                    },
                    lease,
                ))
            }
            MediaReferenceTarget::LocalFile {
                path,
                media_type,
                canvas_node_key,
            } => {
                // 任意本地文件（如视频抽帧产物）：直接读取磁盘字节，不依赖对象存储。
                let bytes = tokio::fs::read(path).await?;
                let detected = infer::get(&bytes).ok_or_else(|| {
                    BackendError::protocol(
                        "local file media type could not be identified from file signature",
                        json!({
                            "path": path,
                            "byteSize": bytes.len()
                        }),
                    )
                })?;
                validate_detected_type(*media_type, detected.mime_type())?;
                let (remote_reference, lease) = if needs_local_bytes {
                    (None, None)
                } else {
                    let lease = self
                        .staging
                        .stage_for_remote_input(path.as_str(), *media_type)
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
                            "kind": "local_file",
                            "path": path,
                            "canvasNodeKey": canvas_node_key
                        }),
                        mime_type: detected.mime_type().to_string(),
                        duration_seconds: None,
                        byte_size: bytes.len() as u64,
                        sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: needs_local_bytes.then_some(bytes),
                        remote_reference,
                        prompt_segment_index,
                        content_index,
                    },
                    lease,
                ))
            }
            MediaReferenceTarget::Url {
                url,
                media_type,
                canvas_node_key,
            } => {
                // 文档/网页生视频（file/link）：素材本身是公网 http(s) URL，
                // 不下载、不经对象存储，直接把 URL 作为远端可读引用交给供应商抓取。
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(BackendError::validation(
                        "url media input must reference a public http(s) URL",
                        json!({ "url": redact_url_string(url) }),
                    ));
                }
                // 扩展名仅用于产物命名展示；URL 无扩展名时退化为占位后缀。
                let url_extension = url
                    .split('?')
                    .next()
                    .and_then(|path| path.rsplit('.').next())
                    .filter(|segment| !segment.contains('/') && !segment.is_empty())
                    .unwrap_or("url");
                Ok((
                    ResolvedMedia {
                        media_type: *media_type,
                        type_position,
                        role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({
                            "kind": "url",
                            "url": redact_url_string(url),
                            "canvasNodeKey": canvas_node_key
                        }),
                        mime_type: String::new(),
                        duration_seconds: None,
                        byte_size: 0,
                        sha256: String::new(),
                        file_name: media_file_name(display_name, url_extension),
                        bytes: None,
                        remote_reference: Some(url.clone()),
                        prompt_segment_index,
                        content_index,
                    },
                    None,
                ))
            }
        }
    }

    /// 读取一个对象存储预签名地址的字节。
    ///
    /// 代理 fake-ip 环境下用备用 DNS 拿真实 IP 直连，避免下载暂存对象时连接失败
    /// （与素材库下载路径一致）；单次尝试的失败由调用方的重试策略处理。
    async fn download_asset_bytes(&self, url: &str) -> BackendResult<Vec<u8>> {
        let redacted_url = redact_url_string(url);
        info!("[resolve] 开始下载引用素材字节: url={redacted_url}");
        let started_at = std::time::Instant::now();
        let client = fake_ip_aware_client(url, self.providers.client().clone()).await;
        let response = client.get(url).send().await?;
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

/// 下载一份本地素材库对象：每次尝试都重新签发一次读取地址再下载。
///
/// 预签名地址是短期凭据：重试必须换新签名，复用上一次失败请求的地址没有意义。
/// 仅传输层瞬时失败（连接失败、超时等）按 `retries` 指数退避重试；HTTP 非 2xx、
/// 校验等确定性错误直接返回。返回字节与最后一次成功尝试实际使用的读取地址。
async fn download_with_fresh_lease<L, D, Fut>(
    retries: u32,
    fresh_url: L,
    download: D,
) -> BackendResult<(Vec<u8>, String)>
where
    L: Fn() -> BackendResult<String>,
    D: Fn(String) -> Fut,
    Fut: std::future::Future<Output = BackendResult<Vec<u8>>>,
{
    download_with_fresh_lease_inner(retries, media_retry_delay_ms, fresh_url, download).await
}

/// `download_with_fresh_lease` 的实现体，退避延迟由 `delay_ms`（接收 1 起的重试序号）
/// 注入，便于测试用 0 延迟验证「每次尝试重新签发」的控制流而无需真实等待。
async fn download_with_fresh_lease_inner<L, D, Fut, Delay>(
    retries: u32,
    delay_ms: Delay,
    fresh_url: L,
    download: D,
) -> BackendResult<(Vec<u8>, String)>
where
    L: Fn() -> BackendResult<String>,
    D: Fn(String) -> Fut,
    Fut: std::future::Future<Output = BackendResult<Vec<u8>>>,
    Delay: Fn(u32) -> u64,
{
    let fresh_url = &fresh_url;
    let download = &download;
    with_transport_retry_inner("引用素材字节下载", retries, delay_ms, || async move {
        let url = fresh_url()?;
        let bytes = download(url.clone()).await?;
        Ok((bytes, url))
    })
    .await
}

/// 对可能因瞬时网络故障失败的解析操作执行指数退避自动重试。
///
/// 仅对传输层错误（`BackendError::Transport`，如向素材库网关请求 `/v1/assets/get`
/// 时超时、连接失败等）重试；协议、校验等确定性错误直接返回，不做重试。
/// `retries` 表示除首次尝试外的额外重试次数，退避节奏与生成任务自动重试一致：
/// 第 1/2/3 次重试前约等待 2s / 4s / 8s（含 ±20% 抖动）。
async fn with_transport_retry<T, F, Fut>(
    label: &str,
    retries: u32,
    operation: F,
) -> BackendResult<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = BackendResult<T>>,
{
    with_transport_retry_inner(label, retries, media_retry_delay_ms, operation).await
}

/// `with_transport_retry` 的实现体，退避延迟由 `delay_ms`（接收 1 起的重试序号）
/// 注入，便于测试用 0 延迟验证控制流而无需真实等待。
async fn with_transport_retry_inner<T, F, Fut, D>(
    label: &str,
    retries: u32,
    delay_ms: D,
    operation: F,
) -> BackendResult<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = BackendResult<T>>,
    D: Fn(u32) -> u64,
{
    let mut last_error = None;
    for attempt in 0..=retries {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms(attempt))).await;
        }
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let is_transport = matches!(&error, BackendError::Transport(_));
                if !is_transport || attempt == retries {
                    if is_transport {
                        error!(
                            "[resolve] {label} 传输层失败且自动重试已耗尽: 共尝试 {} 次, 错误: {}",
                            retries + 1,
                            error.payload().message
                        );
                    }
                    return Err(error);
                }
                warn!(
                    "[resolve] {label} 传输层失败，自动指数退避重试: 第 {} 次尝试失败, 下次退避约 {}ms, 错误: {}",
                    attempt + 1,
                    delay_ms(attempt + 1),
                    error.payload().message
                );
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        BackendError::protocol(
            "retry loop exited without a result",
            json!({ "operation": label }),
        )
    }))
}

/// 媒体解析自动重试的指数退避延迟：第 1/2/3 次重试前约 2s / 4s / 8s，含 ±20% 抖动。
fn media_retry_delay_ms(retry_index: u32) -> u64 {
    let nominal = 2_000_u64 * 2_u64.pow(retry_index.saturating_sub(1));
    nominal + rand::rng().random_range(0..=(nominal / 5))
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
        // 文本产物不参与媒体输入解析，仅占位以保持穷尽性。
        MediaType::Text => {}
    }
}

fn default_reference_role(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "reference_image",
        MediaType::Video => "reference_video",
        MediaType::Audio => "reference_audio",
        MediaType::Text => "reference_video",
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
        MediaType::Text => mime.starts_with("text/"),
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

fn image_edit_needs_local_bytes(
    operation: GenerationOperation,
    remote_model_id: Option<&str>,
    operation_schema: &Value,
) -> bool {
    // 图生图参考图投递形态由模型契约决定，不能一律按「图生图 = 本地字节」处理：
    // - GPT Image 等走 multipart `/v1/images/edits`，Gemini 走 data URI，都需要 bytes。
    // - Seedream 走 JSON `POST /v1/images/generations`，`image` 只接受公网可读 URL
    //   （https://doc.moyu.info/9280685m0.md）。上一节点本地产物必须暂存后再把
    //   remote_reference 交给构建器，否则会出现
    //   `seedream image input has no remote-readable reference`。
    if operation != GenerationOperation::ImageToImage {
        return false;
    }
    if remote_model_id.is_some_and(is_seedream_image_model) {
        return false;
    }
    operation_schema
        .pointer("/request/mediaEncoding")
        .and_then(Value::as_str)
        != Some("seedream_image_urls")
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

    fn mention(target: &MediaReferenceTarget, position: Option<(u32, u32)>) -> PromptSegment {
        PromptSegment::MediaReference {
            mention_id: "mention".into(),
            target: target.clone(),
            display_name_snapshot: "reference".into(),
            type_position: position.map(|value| value.0),
            content_index: position.map(|value| value.1),
        }
    }

    fn explicit(
        target: &MediaReferenceTarget,
        role: &str,
        position: Option<(u32, u32)>,
    ) -> ExplicitMediaInput {
        ExplicitMediaInput {
            target: target.clone(),
            role: role.into(),
            display_name_snapshot: "reference".into(),
            type_position: position.map(|value| value.0),
            content_index: position.map(|value| value.1),
        }
    }

    #[test]
    fn numbered_plan_keeps_connection_order_when_prompt_mentions_are_reversed_and_repeated() {
        let first = asset_target("asset-1", Some("node-1"));
        let second = asset_target("asset-2", Some("node-2"));
        let prompt = vec![
            mention(&second, Some((2, 2))),
            PromptSegment::Text {
                text: " follows ".into(),
            },
            mention(&first, Some((1, 1))),
            mention(&second, Some((2, 2))),
        ];
        let inputs = vec![
            explicit(&first, "reference_image", Some((1, 1))),
            explicit(&second, "reference_image", Some((2, 2))),
        ];
        let plan = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(plan.inputs.len(), 2);
        assert_eq!(plan.inputs[0].target, &first);
        assert_eq!(plan.inputs[1].target, &second);
        assert_eq!(plan.inputs[0].type_position, 1);
        assert_eq!(plan.inputs[1].type_position, 2);
        assert_eq!(plan.inputs[0].prompt_segment_index, Some(2));
        assert_eq!(plan.inputs[1].prompt_segment_index, Some(0));
        assert_eq!(
            plan.rendered_prompt,
            "[图片2：reference] follows [图片1：reference][图片2：reference]"
        );
        assert!(matches!(
            plan.content[0],
            CompiledContentItem::Media {
                type_position: 2,
                ..
            }
        ));
        assert!(matches!(
            plan.content[2],
            CompiledContentItem::Media {
                type_position: 1,
                ..
            }
        ));
        assert!(matches!(
            plan.content[3],
            CompiledContentItem::Media {
                type_position: 2,
                ..
            }
        ));
    }

    #[test]
    fn mentioned_frame_inputs_keep_the_roles_of_their_connections() {
        let first = asset_target("asset-1", Some("node-1"));
        let last = asset_target("asset-2", Some("node-2"));
        let prompt = vec![
            mention(&last, Some((2, 2))),
            mention(&first, Some((1, 1))),
            mention(&last, Some((2, 2))),
        ];
        let inputs = vec![
            explicit(&first, "first_frame", Some((1, 1))),
            explicit(&last, "last_frame", Some((2, 2))),
        ];
        let plan = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(plan.inputs.len(), 2);
        assert_eq!(plan.inputs[0].role, "first_frame");
        assert_eq!(plan.inputs[1].role, "last_frame");
    }

    #[test]
    fn mixed_media_have_independent_positions_and_keep_unmentioned_inputs() {
        let first = asset_target("asset-1", Some("node-1"));
        let second = asset_target("asset-2", Some("node-2"));
        let video = local_result_target("video-task", 0, Some("video-node"));
        let audio = MediaReferenceTarget::LocalFile {
            path: "C:/reference.mp3".into(),
            media_type: MediaType::Audio,
            canvas_node_key: Some("audio-node".into()),
        };
        let prompt = vec![
            mention(&audio, Some((1, 4))),
            mention(&second, Some((2, 3))),
            mention(&video, Some((1, 2))),
        ];
        let inputs = vec![
            explicit(&first, "", Some((1, 1))),
            explicit(&video, "", Some((1, 2))),
            explicit(&second, "", Some((2, 3))),
            explicit(&audio, "", Some((1, 4))),
        ];
        let plan = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(
            plan.inputs
                .iter()
                .map(|input| (
                    input.target.media_type(),
                    input.type_position,
                    input.content_index
                ))
                .collect::<Vec<_>>(),
            vec![
                (MediaType::Image, 1, Some(1)),
                (MediaType::Video, 1, Some(2)),
                (MediaType::Image, 2, Some(3)),
                (MediaType::Audio, 1, Some(4)),
            ]
        );
        assert_eq!(plan.inputs[0].prompt_segment_index, None);
        assert_eq!(plan.inputs[0].role, "reference_image");
        assert_eq!(plan.inputs[1].role, "reference_video");
        assert_eq!(plan.inputs[3].role, "reference_audio");
        assert_eq!(
            plan.rendered_prompt,
            "[音频1：reference][图片2：reference][视频1：reference]"
        );
    }

    #[test]
    fn same_source_on_distinct_canvas_instances_remains_distinct() {
        for (first, second) in [
            (
                asset_target("same-asset", Some("node-1")),
                asset_target("same-asset", Some("node-2")),
            ),
            (
                local_result_target("same-task", 0, Some("node-1")),
                local_result_target("same-task", 0, Some("node-2")),
            ),
        ] {
            let prompt = vec![
                mention(&first, Some((1, 1))),
                mention(&first, Some((1, 1))),
                mention(&second, Some((2, 2))),
            ];
            let inputs = vec![
                explicit(&first, "", Some((1, 1))),
                explicit(&second, "", Some((2, 2))),
            ];
            let plan = build_media_plan(&prompt, &inputs).unwrap();
            assert_eq!(plan.inputs.len(), 2);
            assert_eq!(plan.inputs[0].target, &first);
            assert_eq!(plan.inputs[1].target, &second);
        }
    }

    #[test]
    fn conflicting_zero_sparse_or_reversed_positions_are_rejected_before_resolution() {
        let first = asset_target("asset-1", Some("node-1"));
        let second = asset_target("asset-2", Some("node-2"));
        for (a, b) in [
            ((1, 1), (1, 2)), // duplicate type position
            ((1, 1), (2, 1)), // duplicate global position
            ((1, 1), (2, 3)), // global gap
            ((1, 1), (3, 2)), // type gap
            ((0, 1), (2, 2)), // zero type position
            ((1, 0), (2, 2)), // zero global position
            ((2, 1), (1, 2)), // type order disagrees with connection order
        ] {
            let inputs = vec![
                explicit(&first, "", Some(a)),
                explicit(&second, "", Some(b)),
            ];
            assert!(
                matches!(
                    build_media_plan(&[], &inputs),
                    Err(BackendError::Validation { .. })
                ),
                "accepted {a:?}, {b:?}"
            );
        }
    }

    #[test]
    fn repeated_target_cannot_change_its_position_or_role() {
        let target = asset_target("asset-1", Some("node-1"));
        let prompt = vec![mention(&target, Some((1, 1)))];
        for position in [(2, 1), (1, 2)] {
            let inputs = vec![explicit(&target, "", Some(position))];
            assert!(build_media_plan(&prompt, &inputs).is_err());
        }
        let inputs = vec![
            explicit(&target, "first_frame", Some((1, 1))),
            explicit(&target, "last_frame", Some((1, 1))),
        ];
        assert!(build_media_plan(&prompt, &inputs).is_err());
        let conflicting_mentions = vec![
            mention(&target, Some((1, 1))),
            mention(&target, Some((2, 2))),
        ];
        assert!(build_media_plan(&conflicting_mentions, &[]).is_err());
    }

    #[test]
    fn renamed_snapshots_keep_the_same_identity_and_media_position() {
        let target = asset_target("asset-1", Some("node-1"));
        for position in [None, Some((1, 1))] {
            let mut renamed_mention = mention(&target, position);
            if let PromptSegment::MediaReference {
                display_name_snapshot,
                ..
            } = &mut renamed_mention
            {
                *display_name_snapshot = "renamed reference".into();
            }
            let prompt = vec![mention(&target, position), renamed_mention];
            let mut current_input = explicit(&target, "first_frame", position);
            current_input.display_name_snapshot = "current connection name".into();
            let inputs = vec![current_input];
            let plan = build_media_plan(&prompt, &inputs).unwrap();
            assert_eq!(plan.inputs.len(), 1);
            assert_eq!(plan.inputs[0].target, &target);
            assert_eq!(plan.inputs[0].display_name, "current connection name");
            assert_eq!(plan.inputs[0].role, "first_frame");
            assert_eq!(
                plan.rendered_prompt,
                "[图片1：reference][图片1：renamed reference]"
            );
        }
    }

    #[test]
    fn reference_can_inherit_frozen_positions_but_independent_unnumbered_inputs_are_rejected() {
        let first = asset_target("asset-1", Some("node-1"));
        let second = asset_target("asset-2", Some("node-2"));
        let prompt = vec![mention(&second, None)];
        let inputs = vec![
            explicit(&first, "", Some((1, 1))),
            explicit(&second, "last_frame", Some((2, 2))),
        ];
        let plan = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(plan.rendered_prompt, "[图片2：reference]");
        assert_eq!(plan.inputs[1].role, "last_frame");
        assert!(build_media_plan(&prompt, &inputs[..1]).is_err());
        let mut partial = explicit(&first, "", Some((1, 1)));
        partial.content_index = None;
        assert!(build_media_plan(&[], &[partial]).is_err());
    }

    #[test]
    fn legacy_plan_keeps_first_reference_order_and_appends_remaining_explicit_inputs() {
        let first = asset_target("asset-1", Some("node-1"));
        let second = asset_target("asset-2", Some("node-2"));
        let third = asset_target("asset-3", Some("node-3"));
        let prompt = vec![
            mention(&second, None),
            mention(&first, None),
            mention(&second, None),
        ];
        let inputs = vec![
            explicit(&third, "", None),
            explicit(&first, "first_frame", None),
            explicit(&second, "", None),
        ];
        let plan = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(
            plan.inputs
                .iter()
                .map(|input| input.target)
                .collect::<Vec<_>>(),
            vec![&second, &first, &third]
        );
        assert_eq!(
            plan.inputs
                .iter()
                .map(|input| input.type_position)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(
            plan.inputs
                .iter()
                .all(|input| input.content_index.is_none())
        );
        assert_eq!(plan.inputs[1].role, "first_frame");
        assert_eq!(
            plan.rendered_prompt,
            "[图片1：reference][图片2：reference][图片1：reference]"
        );
    }

    #[test]
    fn text_and_unreferenced_workflow_inputs_keep_their_existing_contract() {
        let prompt = vec![PromptSegment::Text {
            text: "An ordinary prompt mentioning 图2 as text".into(),
        }];
        let pure_text = build_media_plan(&prompt, &[]).unwrap();
        assert!(pure_text.inputs.is_empty());
        assert_eq!(
            pure_text.rendered_prompt,
            "An ordinary prompt mentioning 图2 as text"
        );
        let target = asset_target("workflow-asset", None);
        let inputs = vec![explicit(&target, "reference_image", Some((1, 1)))];
        let workflow = build_media_plan(&prompt, &inputs).unwrap();
        assert_eq!(workflow.inputs.len(), 1);
        assert_eq!(workflow.inputs[0].prompt_segment_index, None);
        assert_eq!(workflow.rendered_prompt, pure_text.rendered_prompt);
    }

    /// 生成一个不依赖真实网络、确定性的传输层错误，用于验证重试控制流。
    async fn transport_error() -> BackendError {
        let client = reqwest::Client::new();
        BackendError::Transport(client.get("not a url").send().await.unwrap_err())
    }

    #[tokio::test]
    async fn transport_retry_recovers_after_transient_failures() {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let result = with_transport_retry_inner(
            "test",
            3,
            |_| 0,
            || {
                let attempts = &attempts;
                async move {
                    if attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                        Err(transport_error().await)
                    } else {
                        Ok("ok")
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        // 首次失败 + 1 次重试后成功，第 3 次尝试命中成功分支。
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn transport_retry_exhausts_after_configured_retries() {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let result: BackendResult<i32> = with_transport_retry_inner(
            "test",
            3,
            |_| 0,
            || {
                let attempts = &attempts;
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(transport_error().await)
                }
            },
        )
        .await;
        assert!(matches!(result, Err(BackendError::Transport(_))));
        // 首次尝试 + 3 次自动重试 = 共 4 次尝试。
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn transport_retry_does_not_retry_non_transport_errors() {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let result: BackendResult<i32> = with_transport_retry_inner(
            "test",
            3,
            |_| 0,
            || {
                let attempts = &attempts;
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(BackendError::protocol("deterministic", json!({})))
                }
            },
        )
        .await;
        assert!(matches!(result, Err(BackendError::Protocol { .. })));
        // 确定性错误不做重试，只尝试一次。
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn media_retry_delay_is_exponential_with_jitter() {
        for (index, nominal) in [(1, 2_000), (2, 4_000), (3, 8_000)] {
            let delay = media_retry_delay_ms(index);
            assert!(delay >= nominal);
            assert!(delay <= nominal + nominal / 5);
        }
    }

    #[test]
    fn seedream_image_to_image_does_not_prefer_local_bytes() {
        // 客户反馈：生成一张图后把本地产物连到下一节点二次改图，5.0 / 5.0 pro
        // 都报 `seedream image input has no remote-readable reference`。原因不是
        // 模型不支持参考图，而是图生图曾一律按 multipart/Gemini 需要本地字节处理，
        // 上一节点 local_result 不会被暂存成公网 URL。
        let seedream = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-260128",
            &[GenerationOperation::ImageToImage],
        );
        let seedream_pro = super::super::model_schema::default_model_schema(
            "doubao-seedream-5-0-pro-260628",
            &[GenerationOperation::ImageToImage],
        );
        let gemini = super::super::model_schema::default_model_schema(
            "gemini-3-pro-image-preview",
            &[GenerationOperation::ImageToImage],
        );
        let gpt_image = super::super::model_schema::default_model_schema(
            "gpt-image-2",
            &[GenerationOperation::ImageToImage],
        );
        assert!(
            !image_edit_needs_local_bytes(
                GenerationOperation::ImageToImage,
                Some("doubao-seedream-5-0-260128"),
                &seedream["image_to_image"],
            ),
            "Seedream 5.0 图生图必须暂存/签发远端可读 URL"
        );
        assert!(
            !image_edit_needs_local_bytes(
                GenerationOperation::ImageToImage,
                Some("doubao-seedream-5-0-pro-260628"),
                &seedream_pro["image_to_image"],
            ),
            "Seedream 5.0 pro 图生图必须暂存/签发远端可读 URL"
        );
        assert!(
            !image_edit_needs_local_bytes(
                GenerationOperation::ImageToImage,
                None,
                &seedream["image_to_image"],
            ),
            "即使模型 id 缺失，seedream_image_urls 契约也不能改走本地字节"
        );
        assert!(
            !image_edit_needs_local_bytes(
                GenerationOperation::ImageToImage,
                Some("doubao-seedream-5-0-260128"),
                &json!({}),
            ),
            "旧画布若没冻结 mediaEncoding，仍按模型 id 识别 Seedream"
        );
        assert!(image_edit_needs_local_bytes(
            GenerationOperation::ImageToImage,
            Some("gemini-3-pro-image-preview"),
            &gemini["image_to_image"],
        ));
        assert!(image_edit_needs_local_bytes(
            GenerationOperation::ImageToImage,
            Some("gpt-image-2"),
            &gpt_image["image_to_image"],
        ));
        assert!(!image_edit_needs_local_bytes(
            GenerationOperation::VideoGeneration,
            Some("doubao-seedream-5-0-260128"),
            &json!({}),
        ));
    }

    /// 回归：本地素材库对象下载曾因单次连接失败（代理 fake-ip 抖动）直接判定
    /// 任务失败。现在每次尝试都重新签发读取地址，并只对传输层失败重试。
    #[tokio::test]
    async fn local_asset_download_reissues_a_lease_for_every_retry() {
        let issued = std::sync::Mutex::new(0_u32);
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let (bytes, url) = download_with_fresh_lease_inner(
            3,
            |_| 0,
            || {
                let mut issued = issued.lock().unwrap();
                *issued += 1;
                Ok(format!(
                    "https://staging.example/object?signature={}",
                    *issued
                ))
            },
            |url: String| {
                let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Err(transport_error().await)
                    } else {
                        Ok(url.into_bytes())
                    }
                }
            },
        )
        .await
        .expect("transient connect failures must be retried");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(
            *issued.lock().unwrap(),
            3,
            "every attempt must reissue its own presigned url"
        );
        // 返回值里的地址是第 3 次成功尝试用的那份签名，不是首次失败的地址。
        assert_eq!(String::from_utf8(bytes).unwrap(), url);
        assert!(url.ends_with("signature=3"));
    }

    #[tokio::test]
    async fn local_asset_download_does_not_retry_deterministic_failures() {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let result: BackendResult<(Vec<u8>, String)> = download_with_fresh_lease_inner(
            3,
            |_| 0,
            || Ok("https://staging.example/object?signature=1".to_string()),
            |_url: String| {
                attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    Err::<Vec<u8>, _>(BackendError::protocol(
                        "asset download returned HTTP 403",
                        json!({ "httpStatus": 403 }),
                    ))
                }
            },
        )
        .await;
        assert!(matches!(result, Err(BackendError::Protocol { .. })));
        // 确定性错误只尝试一次，不重新签发地址也不退避等待。
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
