use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use rand::Rng as _;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncReadExt as _;
use uuid::Uuid;

use super::{
    asset_library::{
        AssetDelivery, AssetLibrary, AssetReadTrace, ResolveAsset, ResolvedAssetAccess,
    },
    composer::{VideoCompositionService, VideoComposerEngineState},
    error::{BackendError, BackendResult},
    gateway_profile::GatewayProfile,
    local_base64_assets::{LocalBase64Library, extension_for_mime},
    local_results::{LocalResultService, safe_file_stem, sha256_bytes},
    media_source,
    media_proxy::MAX_MEDIA_FULL_BYTES,
    model_schema::{is_moyu_kling_v4_model, is_seedream_image_model, seedance_reference_limits},
    provider::{
        CompiledContentItem, ProviderRuntime, ResolvedGeneration, ResolvedMedia,
        redact_request_value, redact_url_string,
    },
    staging::{StagingLease, StagingService, fake_ip_aware_client},
    storage::TaskExecutionRecord,
    types::{
        ExplicitMediaInput, GenerationOperation, MediaReferenceTarget, MediaType, PromptSegment,
        SaveStatus, StartGenerationCommand,
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

// 这是选择传输方式的预算，不是模型的输入上限。按整组 Base64 长度计算，
// 给提示词、参数和网关转发的 JSON 留空间。
const FZY_IMAGE_INLINE_BUDGET: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct MediaResolver {
    providers: ProviderRuntime,
    assets: AssetLibrary,
    local_results: LocalResultService,
    staging: StagingService,
    local_base64_assets: LocalBase64Library,
    /// FFmpeg 引擎：量出参考素材的真实时长。Seedance 对参考音频/参考视频有
    /// 硬性时长上限，超限后由供应商以 400 拒绝，本地先量出来才能提前拦下。
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
    use_original_cloud_media: bool,
    /// 是否需要量出素材的真实时长（只有对参考素材时长有硬上限的模型才需要）。
    probe_duration: bool,
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
    rendered_segments: Vec<String>,
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
    let mut rendered_segments = Vec::with_capacity(prompt.len());
    let mut content = Vec::with_capacity(prompt.len());
    for segment in prompt {
        let start = rendered_prompt.len();
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
        rendered_segments.push(rendered_prompt[start..].to_string());
    }
    Ok(MediaPlan {
        inputs,
        rendered_prompt,
        rendered_segments,
        content,
    })
}

/// Check new requests against the public capabilities before opening files or staging media.
/// Resumed observations continue to use the frozen task and its original contract.
pub(crate) fn validate_new_video_request(
    adapter: &str,
    model: &str,
    command: &mut StartGenerationCommand,
    operation_schema: &Value,
) -> BackendResult<()> {
    use super::{canvas_model_capabilities as capabilities, types::VideoTaskType};

    let policy = capabilities::video_capabilities(adapter, model);
    let pixverse = GatewayProfile::from_operation_schema(operation_schema) == Some(GatewayProfile::PixVerse);
    if policy.is_none() && !pixverse {
        return Ok(());
    }
    let plan = build_media_plan(&command.prompt, &command.explicit_media)?;
    let count = |kind| plan.inputs.iter().filter(|input| input.target.media_type() == kind).count();
    let images = count(MediaType::Image);
    let videos = count(MediaType::Video);
    let audios = count(MediaType::Audio);
    let has_role = |role: &str| plan.inputs.iter().any(|input| input.role == role);
    let invalid = |reason: &str| BackendError::validation(reason, json!({ "model": model }));

    if pixverse {
        let value = |key: &str| command.parameters["metadata"].get(key).or_else(|| command.parameters.get(key));
        let v6 = model.eq_ignore_ascii_case("pixverse-v6");
        let action = value("action").and_then(Value::as_str).filter(|action| !action.is_empty())
            .unwrap_or_else(|| {
                if has_role("last_frame") { "transition" }
                else if images > 1 || (v6 && videos > 0) || value("image_references").and_then(Value::as_array).is_some_and(|items| !items.is_empty()) { "fusion" }
                else if images == 1 { "img" }
                else { "text" }
            });
        let requested_omni = value("reference_mode").and_then(Value::as_str) == Some("omni")
            || value("video_references").and_then(Value::as_array).is_some_and(|items| !items.is_empty());
        for requested in [Some(action), requested_omni.then_some("fusion_omni")].into_iter().flatten() {
            if let Some(reason) = capabilities::pixverse_action_restriction(model, requested) {
                return Err(invalid(reason));
            }
        }
        let omni = v6 && action == "fusion" && (requested_omni || videos > 0);
        if videos > 0 && !omni && matches!(action, "text" | "img" | "transition" | "fusion" | "avatar") {
            return Err(invalid("当前 PixVerse 模式不接收视频素材；请更换模式或移除视频。"));
        }
        if audios > 0 && matches!(action, "text" | "img" | "transition" | "fusion" | "extend") {
            return Err(invalid("当前 PixVerse 模式不接收音频素材。"));
        }
        if action == "img" && images != 1 || action == "transition" && images != 2 {
            return Err(invalid("PixVerse 图生视频需要 1 张图片，首尾帧需要 2 张图片。"));
        }
        if action == "extend" {
            let source_ids = ["source_video_id", "video_media_id"].into_iter()
                .filter(|key| value(key).is_some_and(|id| !id.is_null() && id.as_str() != Some(""))).count();
            if videos + source_ids != 1 {
                return Err(invalid("PixVerse 视频延长需要且仅能使用一个视频来源。"));
            }
        }
        return Ok(());
    }

    let Some(policy) = policy else { return Ok(()); };
    let frame_mode = if has_role("middle_frame") { Some("multi_frame") }
        else if has_role("last_frame") { Some("first_last_frame") }
        else if has_role("first_frame") { Some("first_frame") } else { None };
    let explicit_mode = match command.video_task_type {
        Some(VideoTaskType::FirstFrame) => Some("first_frame"),
        Some(VideoTaskType::FirstLastFrame) => Some("first_last_frame"),
        Some(VideoTaskType::Reference) => Some("reference"),
        Some(VideoTaskType::Edit) => Some("edit"),
        Some(VideoTaskType::Extend) => Some("extend"),
        _ => None,
    };
    let legacy_mode = command.parameters.get("omni_reference_task_type").and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "edit" | "extend"));
    let mode = explicit_mode.or(legacy_mode).or(frame_mode).unwrap_or_else(|| {
        if plan.inputs.is_empty() { "text" }
        else if images == 1 && videos == 0 && audios == 0 && (policy.veo.is_some() || !policy.supports_mode("reference")) { "first_frame" }
        else { "reference" }
    });
    if [Some(mode), frame_mode, legacy_mode].into_iter().flatten().any(|mode| !policy.supports_mode(mode))
        || plan.inputs.iter().any(|input| !policy.input_kinds.iter().any(|kind| kind == input.target.media_type().as_str()))
        || policy.max_images.is_some_and(|maximum| images > maximum)
        || policy.required_kind.as_ref().is_some_and(|kind| !plan.inputs.iter().any(|input| input.target.media_type().as_str() == kind))
    {
        return Err(invalid(&policy.reason));
    }
    if matches!(mode, "edit" | "extend") && videos == 0 {
        return Err(invalid("请先连接要编辑或延长的视频。"));
    }
    if operation_schema.pointer("/request/mediaEncoding").and_then(Value::as_str) == Some("wan_media_array")
        && matches!(mode, "first_frame" | "first_last_frame")
        && (images != if mode == "first_frame" { 1 } else { 2 } || videos > 0 || audios > 0)
    {
        return Err(invalid("万相的首帧或首尾帧不能与其他参考素材混用。"));
    }
    if let Some(version) = operation_schema.pointer("/request/veoMediaVersion").and_then(Value::as_str) {
        if mode == "first_frame" && images != 1 || mode == "first_last_frame" && images != 2
            || mode == "reference" && images == 0
        {
            return Err(invalid("Veo 单首帧需要 1 张图，首尾帧需要 2 张图，参考图模式需要 1 至 3 张图。"));
        }
        let duration = command.parameters["duration"].as_i64().unwrap_or(8);
        let high_resolution = command.parameters["resolution"].as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case("1080p") || value.eq_ignore_ascii_case("4k"));
        if (version == "3" || mode == "reference" || high_resolution) && duration != 8 {
            return Err(invalid("Veo 3、参考图模式或 1080P 及以上分辨率需要 8 秒时长。"));
        }
        command.video_task_type = Some(match mode {
            "first_frame" => VideoTaskType::FirstFrame,
            "first_last_frame" => VideoTaskType::FirstLastFrame,
            "reference" => VideoTaskType::Reference,
            _ => VideoTaskType::Auto,
        });
    }
    Ok(())
}

impl MediaResolver {
    pub fn new(
        providers: ProviderRuntime,
        assets: AssetLibrary,
        local_results: LocalResultService,
        staging: StagingService,
        local_base64_assets: LocalBase64Library,
        composer: VideoCompositionService,
    ) -> Self {
        Self {
            providers,
            assets,
            local_results,
            staging,
            local_base64_assets,
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
                // 的暂存对象。
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
                "each local generation task represents one request; batch requests require separate tasks",
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
            rendered_segments,
            content,
        } = build_media_plan(&command.prompt, &command.explicit_media)?;
        let parameters = super::video_storyboard::compile(
            &command.parameters,
            task.remote_model_id_snapshot.as_deref().unwrap_or_default(),
            &rendered_segments,
            inputs.iter().any(|input| input.target.media_type() == MediaType::Video),
        )?;
        let operation_schema = command
            .model_operation_schema_snapshot
            .clone()
            .unwrap_or_else(|| json!({}));
        let request_profile = operation_schema
            .get("requestProfileId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let media_encoding = operation_schema
            .pointer("/request/mediaEncoding")
            .and_then(Value::as_str);
        let fzy_image_inputs = task.operation == GenerationOperation::ImageToImage
            && media_encoding == Some("fzy_image_inputs");
        let veo_frames = operation_schema.pointer("/request/veoMediaVersion").is_some();
        let veo_tail_position = if veo_frames && command.video_task_type == Some(super::types::VideoTaskType::FirstLastFrame) {
            inputs.iter().find(|input| input.role == "last_frame").or_else(|| inputs.last())
                .map(|input| input.type_position)
        } else { None };
        // 已注册网关家族（按次、RD、PixVerse）通过供应商上传接口处理本地素材，
        // 因此解析阶段必须拿到本地字节；纯 URL 素材不受影响。
        let needs_local_bytes = GatewayProfile::from_profile_id(request_profile)
            .is_some_and(GatewayProfile::needs_local_bytes)
            || image_edit_needs_local_bytes(
                task.operation,
                task.remote_model_id_snapshot.as_deref(),
                media_encoding,
            )
            // 网关语音合成的音色复刻要把参考音频以 Base64 内联进请求体
            // （`audio_data`），因此解析阶段必须拿到本地字节，而不是公网 URL。
            || task.operation == GenerationOperation::SpeechGeneration;
        // Seedance 全模态参考对参考音频/参考视频有硬性时长上限，超限后由供应商
        // 以 400 InvalidParameter 拒绝（"the parameter audio total duration
        // (seconds) ... must be less than or equal to 30.2"）。只有这些模型需要
        // 量素材时长，其它模型不受影响，也不必多付一次 ffprobe。
        let seedance = seedance_reference_limits(
            task.remote_model_id_snapshot.as_deref().unwrap_or_default(),
        ).is_some();
        let use_original_cloud_media = task.operation == GenerationOperation::VideoGeneration
            && seedance
            && command.use_original_cloud_media == Some(true);
        let probe_duration = seedance || is_moyu_kling_v4_model(task.remote_model_id_snapshot.as_deref().unwrap_or_default());
        for input in inputs {
            let is_veo_tail = veo_tail_position == Some(input.type_position);
            let inline_veo_image = is_veo_tail || (veo_frames && command.video_task_type == Some(super::types::VideoTaskType::Reference));
            let fzy_remote_image = fzy_image_inputs
                && input.target.media_type() == MediaType::Image
                && match input.target {
                    MediaReferenceTarget::Url { url, .. } => url.starts_with("https://"),
                    MediaReferenceTarget::LocalAsset { .. } => true,
                    _ => false,
                };
            let (resolved, lease) = self
                .resolve_target(
                    task,
                    attempt_id,
                    ResolveTargetRequest {
                        target: input.target,
                        type_position: input.type_position,
                        role: if is_veo_tail { "last_frame" } else { input.role },
                        display_name: input.display_name,
                        prompt_segment_index: input.prompt_segment_index,
                        content_index: input.content_index,
                        needs_local_bytes: (needs_local_bytes && !fzy_remote_image) || inline_veo_image,
                        use_original_cloud_media,
                        probe_duration,
                    },
                )
                .await
                .map_err(|error| {
                    if let Some(segment_index) = input.prompt_segment_index {
                        let mention_id = match &command.prompt[segment_index] {
                            PromptSegment::MediaReference { mention_id, .. } => mention_id,
                            PromptSegment::Text { .. } => unreachable!("planned media reference"),
                        };
                        let source = error.payload();
                        let reason = source.message
                            .strip_prefix("validation error: ")
                            .or_else(|| source.message.strip_prefix("protocol error: "))
                            .unwrap_or(&source.message);
                        let message = format!(
                            "参考{}{}「{}」解析失败：{}",
                            input.target.media_type().position_label(),
                            input.type_position,
                            input.display_name,
                            reason,
                        );
                        let details = json!({
                                "mentionId": mention_id,
                                "segmentIndex": segment_index,
                                "mediaType": input.target.media_type(),
                                "typePosition": input.type_position,
                                "displayName": input.display_name,
                                "target": input.target,
                                "sourceError": error.runtime_record()
                            });
                        if source.kind == "validation" {
                            BackendError::validation(message, details)
                        } else {
                            BackendError::protocol(message, details)
                        }
                    } else {
                        error
                    }
                })?;
            if let Some(lease) = lease {
                staging_leases.push(lease);
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

        validate_media_encoding(task.operation, &images, &videos, &audios)?;
        if fzy_image_inputs {
            self.stage_large_fzy_image_inputs(&mut images, staging_leases).await?;
        }

        // 每类数组直接遵循已经校验的同类编号；供应商不能再决定另一套顺序。
        images.sort_by_key(|media| media.type_position);
        videos.sort_by_key(|media| media.type_position);
        audios.sort_by_key(|media| media.type_position);

        let mut resolved = ResolvedGeneration {
            rendered_prompt,
            content,
            images,
            videos,
            audios,
            parameters,
            video_task_type: command.video_task_type,
            operation_schema,
        };
        super::provider::normalize_seedance_task(task.remote_model_id_snapshot.as_deref().unwrap_or_default(), &mut resolved)?;
        Ok(resolved)
    }

    async fn stage_large_fzy_image_inputs(
        &self,
        images: &mut [ResolvedMedia],
        staging_leases: &mut Vec<StagingLease>,
    ) -> BackendResult<()> {
        let inline_bytes: usize = images.iter().filter_map(|image| {
            image.bytes.as_ref().map(|bytes| {
                // "data:" + MIME + ";base64," + padded Base64
                13 + image.mime_type.len() + bytes.len().div_ceil(3) * 4
            })
        }).sum();
        if inline_bytes <= FZY_IMAGE_INLINE_BUDGET || !self.staging.generation_input_enabled()? {
            return Ok(());
        }
        for image in images {
            let Some(bytes) = image.bytes.as_deref() else {
                continue;
            };
            // 暂存解析时已校验并计算哈希的原件，避免重新读取可能已被替换的源文件。
            let temporary = tempfile::NamedTempFile::new()?.into_temp_path();
            tokio::fs::write(&temporary, bytes).await?;
            let lease = self
                .staging
                .stage_for_remote_input(&temporary.to_string_lossy(), MediaType::Image)
                .await?;
            image.remote_reference = Some(lease.get_url.clone());
            image.bytes = None;
            staging_leases.push(lease);
        }
        Ok(())
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
            use_original_cloud_media,
            probe_duration,
        } = request;
        match target {
            MediaReferenceTarget::Asset {
                provider_connection_id,
                asset_id,
                media_type,
                canvas_node_key,
            } => {
                let preserve_asset_identity = !use_original_cloud_media
                    && task.operation == GenerationOperation::VideoGeneration
                    && seedance_reference_limits(task.remote_model_id_snapshot.as_deref().unwrap_or_default()).is_some();
                let resolution =
                    with_transport_retry("云端素材解析", ASSET_RESOLVE_RETRIES, || {
                        self.assets.resolve(ResolveAsset {
                            identity: super::types::CloudAssetIdentity {
                                provider_connection_id: provider_connection_id.clone(),
                                asset_id: asset_id.clone(),
                            },
                            expected_media_type: *media_type,
                            delivery: if needs_local_bytes {
                                AssetDelivery::Bytes
                            } else if use_original_cloud_media {
                                AssetDelivery::OriginalFile
                            } else {
                                AssetDelivery::RemoteReadable {
                                    destination_provider_connection_id: task
                                        .provider_connection_id
                                        .clone(),
                                    destination_credential_ref: task.api_key_ref_snapshot.clone(),
                                    preserve_asset_identity,
                                }
                            },
                            trace: AssetReadTrace { task, attempt_id },
                        })
                    })
                    .await;
                let resolved = match resolution {
                    Ok(resolved) => resolved,
                    Err(error) => {
                        let unavailable = matches!(
                            &error,
                            BackendError::Validation { details, .. }
                                if details.get("assetUnavailable").and_then(serde_json::Value::as_bool) == Some(true)
                        );
                        if unavailable && !preserve_asset_identity {
                            if let Some(source) = self.staging.imported_asset_source_for_generation(
                                asset_id, provider_connection_id, *media_type,
                            )? {
                                // 云端身份已失效时，只复用该连接、该素材的导入原件。
                                // 沿用 LocalFile 的类型/大小校验与临时租约回收，不重建云素材。
                                let local_target = MediaReferenceTarget::LocalFile {
                                    path: source.local_path,
                                    media_type: *media_type,
                                    canvas_node_key: canvas_node_key.clone(),
                                };
                                let (mut media, lease) = Box::pin(self.resolve_target(
                                    task, attempt_id,
                                    ResolveTargetRequest {
                                        target: &local_target, type_position, role, display_name,
                                        prompt_segment_index, content_index,
                                        needs_local_bytes, use_original_cloud_media, probe_duration,
                                    },
                                )).await?;
                                media.stable_identity = json!({
                                    "kind": "asset",
                                    "providerConnectionId": provider_connection_id,
                                    "assetId": asset_id,
                                    "canvasNodeKey": canvas_node_key,
                                    "resolvedFrom": "local_original",
                                });
                                info!("[resolve] 云素材不可读取，改用同一素材的本地导入原件: taskId={}, assetId={}", task.id, asset_id);
                                return Ok((media, lease));
                            }
                        }
                        return Err(error);
                    }
                };
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
                let duration_seconds = if probe_duration {
                    self.probe_media_duration(
                        *media_type,
                        &resolved.mime_type,
                        None,
                        bytes.as_deref(),
                        remote_reference.as_deref(),
                    )
                    .await
                } else {
                    None
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
                        duration_seconds,
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
                let duration_seconds = if probe_duration {
                    self.probe_media_duration(
                        *media_type,
                        detected.mime_type(),
                        None,
                        Some(bytes.as_slice()),
                        Some(get_url.as_str()),
                    )
                    .await
                } else {
                    None
                };
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
                        duration_seconds,
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
            MediaReferenceTarget::LocalBase64Asset {
                asset_id,
                media_type,
                canvas_node_key,
            } => {
                let record = self.local_base64_assets.get(asset_id, *media_type)?;
                // 仅在本次模型协议要求公网 URL 时临时中转。该分支全程按文件流处理，
                // 大视频不会先把 Base64 解码成完整 Vec 再复制一份到磁盘。
                let (bytes, hash, remote_reference, lease, duration_seconds) = if needs_local_bytes {
                    let (_, bytes) = self.local_base64_assets.read_bytes(asset_id, *media_type)?;
                    if let Some(detected) = infer::get(&bytes) {
                        validate_detected_type(*media_type, detected.mime_type())?;
                    }
                    let hash = sha256_bytes(&bytes);
                    let duration_seconds = if probe_duration {
                        self.probe_media_duration(
                            *media_type,
                            &record.mime_type,
                            None,
                            Some(bytes.as_slice()),
                            None,
                        )
                        .await
                    } else {
                        None
                    };
                    (Some(bytes), hash, None, None, duration_seconds)
                } else {
                    let path = self
                        .local_base64_assets
                        .decoded_path(asset_id, *media_type)?;
                    // 临时文件删除前先量时长：读本地文件比让 ffprobe 去取公网
                    // 地址快得多，也不依赖签名地址还有效。
                    let duration_seconds = if probe_duration {
                        self.probe_media_duration(
                            *media_type,
                            &record.mime_type,
                            Some(path.as_path()),
                            None,
                            None,
                        )
                        .await
                    } else {
                        None
                    };
                    let hash_result = LocalBase64Library::sha256_path(&path);
                    if hash_result.is_err() {
                        let _ = std::fs::remove_file(&path);
                    }
                    let hash = hash_result?;
                    let stage_result = self
                        .staging
                        .stage_for_remote_input(path.to_string_lossy().as_ref(), *media_type)
                        .await;
                    let _ = std::fs::remove_file(&path);
                    let lease = stage_result.map_err(|error| match error {
                        BackendError::Validation { message, .. } if message.starts_with("TOS staging") => {
                            BackendError::validation(
                                "当前模型要求公网素材 URL；本地 Base64 素材已保存在本机，生成时需配置临时对象存储中转",
                                json!({ "assetId": asset_id, "cause": message }),
                            )
                        }
                        other => other,
                    })?;
                    (None, hash, Some(lease.get_url.clone()), Some(lease), duration_seconds)
                };
                let file_name =
                    media_file_name(display_name, extension_for_mime(&record.mime_type));
                Ok((
                    ResolvedMedia {
                        media_type: *media_type,
                        type_position,
                        role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({
                            "kind": "local_base64_asset",
                            "assetId": asset_id,
                            "canvasNodeKey": canvas_node_key,
                        }),
                        mime_type: record.mime_type,
                        duration_seconds,
                        byte_size: record.byte_size,
                        sha256: hash,
                        file_name,
                        bytes,
                        remote_reference,
                        prompt_segment_index,
                        content_index,
                    },
                    lease,
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
                let duration_seconds = if probe_duration {
                    self.probe_media_duration(
                        *media_type,
                        detected.mime_type(),
                        Some(Path::new(path)),
                        Some(bytes.as_slice()),
                        None,
                    )
                    .await
                } else {
                    None
                };
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
                        duration_seconds,
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
                /*
                 * 任意本地文件（如视频抽帧产物）：直接读取磁盘字节，不依赖对象存储。
                 *
                 * 这里其实有两条语义完全不同的路径，内存口径必须分开：
                 *
                 * - **需要整块字节**（供应商按 multipart 直传这份素材）：字节必须整份
                 *   留在内存里，于是按共享上限 [`MAX_MEDIA_FULL_BYTES`] 拒绝超限文件。
                 *   这个上限与媒体代理的单条上限一致 —— 同一份素材从「代理」取与从
                 *   「本机文件」取不该一个放行一个拒绝。
                 * - **只要一个公网 URL**（素材先暂存到对象存储，再由供应商去抓）：字节
                 *   **不需要**进内存，暂存服务是按文件流上传的。这里只做两件小事：
                 *   读文件头判断类型、按块流式算 sha256。
                 *
                 * 旧实现两条路径都 `tokio::fs::read` 整文件：原始视频动辄几百 MB，
                 * 即使用户只要一个公网 URL，也会先把整段视频读进内存（Windows 上表现为
                 * 整个应用被系统杀掉，不是 Rust panic）。
                 */
                const MAX_LOCAL_FILE_STREAM_BYTES: u64 = 2 * 1024 * 1024 * 1024;
                let metadata = tokio::fs::metadata(path).await?;
                let byte_size = metadata.len();
                let (detected, hash, bytes, remote_reference, lease) = if needs_local_bytes {
                    if byte_size > MAX_MEDIA_FULL_BYTES {
                        return Err(BackendError::validation(
                            format!(
                                "本机素材文件过大（{} MB），当前模型需要把这份素材整份上传，无法作为参考素材使用。",
                                byte_size / (1024 * 1024)
                            ),
                            json!({ "path": path, "byteSize": byte_size }),
                        ));
                    }
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
                    let hash = sha256_bytes(&bytes);
                    (detected, hash, Some(bytes), None, None)
                } else {
                    // 这条路径的字节不进内存，2 GiB 只是「别给一个明显异常的文件做
                    // 哈希与上传」的兜底，不是内存上限：原始视频本来就远大于 128 MiB。
                    if byte_size > MAX_LOCAL_FILE_STREAM_BYTES {
                        return Err(BackendError::validation(
                            format!(
                                "本机素材文件过大（{} MB），无法作为参考素材使用。",
                                byte_size / (1024 * 1024)
                            ),
                            json!({ "path": path, "byteSize": byte_size }),
                        ));
                    }
                    let detected = detect_local_file_media_type(path).await?;
                    validate_detected_type(*media_type, detected.mime_type())?;
                    let hash = sha256_file(path).await?;
                    let lease = self
                        .staging
                        .stage_for_remote_input(path.as_str(), *media_type)
                        .await?;
                    let remote_reference = Some(lease.get_url.clone());
                    (detected, hash, None, remote_reference, Some(lease))
                };
                let duration_seconds = if probe_duration {
                    self.probe_media_duration(
                        *media_type,
                        detected.mime_type(),
                        Some(Path::new(path)),
                        None,
                        None,
                    )
                    .await
                } else {
                    None
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
                        duration_seconds,
                        byte_size,
                        sha256: hash,
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes,
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
                // Public style references must also work with multipart/data-URI models.
                // Download image bytes only when the selected request encoding needs them.
                if *media_type == MediaType::Image && needs_local_bytes {
                    let bytes = self.download_asset_bytes(url).await?;
                    let detected = infer::get(&bytes).ok_or_else(|| BackendError::validation(
                        "素材链接没有返回可识别的图片，请重新选择。", Value::Null))?;
                    validate_detected_type(*media_type, detected.mime_type())?;
                    return Ok((ResolvedMedia {
                        media_type: *media_type, type_position, role: role.to_string(),
                        display_name: display_name.to_string(),
                        stable_identity: json!({"kind":"url","url":redact_url_string(url),"canvasNodeKey":canvas_node_key}),
                        mime_type: detected.mime_type().to_string(), duration_seconds: None,
                        byte_size: bytes.len() as u64, sha256: sha256_bytes(&bytes),
                        file_name: media_file_name(display_name, detected.extension()),
                        bytes: Some(bytes), remote_reference: None,
                        prompt_segment_index, content_index,
                    }, None));
                }
                // 扩展名仅用于产物命名展示；URL 无扩展名时退化为占位后缀。
                let url_extension = url
                    .split('?')
                    .next()
                    .and_then(|path| path.rsplit('.').next())
                    .filter(|segment| !segment.contains('/') && !segment.is_empty())
                    .unwrap_or("url");
                // 公网地址只能让 ffprobe 自己去取；取不到就按「未知时长」处理。
                let duration_seconds = if probe_duration {
                    self.probe_media_duration(*media_type, "", None, None, Some(url)).await
                } else {
                    None
                };
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
                        duration_seconds,
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

    /// 量出参考素材的真实时长（秒）。
    ///
    /// Seedance 全模态参考对参考音频/参考视频有硬性时长上限，超限后由供应商
    /// 以 400 InvalidParameter 拒绝（"the parameter audio total duration
    /// (seconds) specified in the request is not valid: ... must be less than or
    /// equal to 30.2 for model doubao-seedance-2-5 in r2v"）。本地量出真实
    /// 时长，请求构造阶段就能在提交前拦下来。
    ///
    /// 三条取值路径按代价排序：本地文件 → 已经读进内存的字节（落一份临时
    /// 文件再量）→ 公网地址（交给 ffprobe 自己取，带短超时）。都拿不到就返回
    /// `None`：量不到时长不等于素材违规，不在这里误伤用户。
    async fn probe_media_duration(
        &self,
        media_type: MediaType,
        mime_type: &str,
        local_path: Option<&Path>,
        bytes: Option<&[u8]>,
        remote_reference: Option<&str>,
    ) -> Option<f64> {
        if !matches!(media_type, MediaType::Audio | MediaType::Video) {
            return None;
        }
        let status = self.composer.engine_status();
        if status.state != VideoComposerEngineState::Ready {
            // 引擎没就绪就不探测：补装引擎可能耗时数分钟，不能让它卡住生成。
            return None;
        }
        let ffmpeg = PathBuf::from(status.binary_path?);
        let audio = matches!(media_type, MediaType::Audio);
        if let Some(path) = local_path {
            return media_source::stream_duration(&ffmpeg, &path.to_string_lossy(), audio)
                .await
                .ok();
        }
        if let Some(bytes) = bytes {
            // 落盘量时长的代价与素材体积成正比：超大文件不值得为一次校验
            // 再写一遍磁盘，跳过即可（未知时长不会误伤请求）。
            const MAX_PROBE_BYTES: usize = 64 * 1024 * 1024;
            if bytes.len() > MAX_PROBE_BYTES {
                return None;
            }
            let temporary = std::env::temp_dir().join(format!(
                "canvas-reference-probe-{}.{}",
                Uuid::new_v4(),
                probe_extension(mime_type)
            ));
            if tokio::fs::write(&temporary, bytes).await.is_err() {
                return None;
            }
            let duration = media_source::stream_duration(
                &ffmpeg,
                &temporary.to_string_lossy(),
                audio,
            )
            .await
            .ok();
            let _ = tokio::fs::remove_file(&temporary).await;
            return duration;
        }
        let reference = remote_reference?;
        if !(reference.starts_with("http://") || reference.starts_with("https://")) {
            return None;
        }
        media_source::stream_duration_with_timeout(
            &ffmpeg,
            reference,
            audio,
            std::time::Duration::from_secs(20),
        )
        .await
        .ok()
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
                format!(
                    "引用素材下载失败（HTTP {status}）。链接可能已失效：请更换素材链接或重新上传。"
                ),
                redact_request_value(&json!({
                    "httpStatus": status,
                    "url": url,
                    "rawResponse": raw
                })),
            ));
        }
        let bytes = response.bytes().await?.to_vec();
        // 2xx 但响应体是网页（网关把失效直链兜底到自家首页）：必不是素材文件。
        if super::provider::looks_like_html_document(&bytes) {
            return Err(super::provider::html_document_rejection(
                status,
                url,
                "",
                &bytes,
                "引用素材链接返回的是网页而不是素材文件。链接可能已失效：请更换素材链接或重新上传。".into(),
            ));
        }
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

/// 临时探测文件用的扩展名。
///
/// ffprobe 靠容器 magic 也能识别文件，扩展名只是让它少走一次猜测；给不出
/// 常见扩展名时用 `bin`（magic 仍然有效）。
fn probe_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "audio/mpeg" | "audio/mpeg3" => "mp3",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/flac" | "audio/x-flac" => "flac",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        _ => "bin",
    }
}

/// 只读文件头判断本机素材的媒体类型。
///
/// 类型判断只需要文件签名（都在文件开头），不必为了一个 `infer::get` 把几百 MB 的
/// 原始视频读进内存：这条路径服务于「只要一个公网 URL」的分支，字节随后由暂存
/// 服务按文件流上传。
async fn detect_local_file_media_type(path: &str) -> BackendResult<infer::Type> {
    const HEADER_BYTES: usize = 64 * 1024;
    let mut file = tokio::fs::File::open(path).await?;
    let mut head = vec![0_u8; HEADER_BYTES];
    let read = file.read(&mut head).await?;
    head.truncate(read);
    infer::get(&head).ok_or_else(|| {
        BackendError::protocol(
            "local file media type could not be identified from file signature",
            json!({ "path": path, "byteSize": read }),
        )
    })
}

/// 流式计算本机文件的 sha256：按固定大小分块读，内存占用与文件体积无关。
///
/// 摘要要的是「这份文件的身份」，不是「把文件读进来」：原始视频几百 MB 时，
/// 一次性读进内存既慢又会推高进程峰值。
async fn sha256_file(path: &str) -> BackendResult<String> {
    const CHUNK_BYTES: usize = 1024 * 1024;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(hex::encode(&digest[..]))
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
    media_encoding: Option<&str>,
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
    // 饭众烟先解析本机参考图，再按整组的体积选择 data URI 或临时 URL。
    if matches!(media_encoding, Some("fzy_image_inputs" | "atlascloud_canvas_media_tool")) {
        return true;
    }
    if remote_model_id.is_some_and(is_seedream_image_model) {
        return false;
    }
    media_encoding != Some("seedream_image_urls")
}

/// 只拦截当前编码器无法保留的媒体类型，避免付费请求静默漏掉用户素材。
/// 提示词是否可空、是否必须有参考图以及模型能力交给远端服务判定。
fn validate_media_encoding(
    operation: GenerationOperation,
    images: &[ResolvedMedia],
    videos: &[ResolvedMedia],
    audios: &[ResolvedMedia],
) -> BackendResult<()> {
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
        GenerationOperation::ImageToImage if !videos.is_empty() || !audios.is_empty() => {
            Err(BackendError::validation(
                "image-to-image cannot encode video or audio references",
                json!({
                    "videos": videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "audios": audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>()
                }),
            ))
        }
        // 画布音频节点只接受一段音频参考（音色复刻的 `audio_data`），图片与视频
        // 在这个端点没有对应字段，带上去只会被上游忽略——那等于静默丢掉用户素材，
        // 因此在本地就拦下并说明原因。
        GenerationOperation::SpeechGeneration if !images.is_empty() || !videos.is_empty() => {
            Err(BackendError::validation(
                "音频生成只接受一段音频作为音色参考，不支持图片或视频素材。",
                json!({
                    "images": images.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "videos": videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>()
                }),
            ))
        }
        // 网关 TTS 的音色复刻只有一个 `audio_data` 字段：多段参考音频无法表达，
        // 静默取第一段会让用户以为参考了全部。
        GenerationOperation::SpeechGeneration if audios.len() > 1 => {
            Err(BackendError::validation(
                "音频生成最多只能引用 1 段参考音频，请只保留一段音色参考。",
                json!({
                    "audios": audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
                    "limit": 1
                }),
            ))
        }
        _ => Ok(()),
    }
}
