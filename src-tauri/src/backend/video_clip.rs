//! 智能剪辑（video clip）后端契约。
//!
//! 规格来源：liblib.tv 画布的「智能剪辑」节点（REA 静态分析 + 活体实测）。
//! 这里照抄原站的五种模式、素材槽位（slotKey）、校验文案与提示词合成规则，
//! 再把结果组装成既有生成任务管线（`StartGenerationCommand`）下发，
//! 产物沿用同一套任务历史、结果落盘与失败重试，不另起一套任务体系。
//!
//! 对前端暴露的契约（字段名不要改）：
//! - 命令 `start_video_clip`：入参 `command`（`StartVideoClipCommand`），
//!   返回任务 ID 字符串（与 `start_generation` 同一形状）。
//! - 模式 `VideoClipMode`：snake_case 序列化，取值
//!   `default` / `explainer_video` / `batch_ad` / `talking_head_video` / `smart_mix_cut`。
//! - 素材槽位 `VideoClipMaterial.slot_key`：原站 slotKey，取值
//!   `video` / `audio` / `text` / `productImage` / `refVideo` / `generatedVideo`；
//!   `node_type` 取节点类型 `video` / `image` / `audio` / `text`。
//! - 媒体槽位必须带素材身份（`target`），不能只给 URL。
//!
//! 原站的技能标识（skill）目前只作为模式目录信息保留在
//! `VideoClipModeSpec::skill_id`，尚未真正调用技能系统。

use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use super::{
    error::{BackendError, BackendResult},
    tasks::GenerationTaskService,
    types::{
        ExplicitMediaInput, GenerationOperation, MediaReferenceTarget, PromptSegment,
        StartGenerationCommand,
    },
};

// ------------------------------------------------------------------
// 类型契约
// ------------------------------------------------------------------

/// 智能剪辑模式（原站 5 项）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VideoClipMode {
    /// 默认模式：只给一个视频槽位，提示词完全由用户写。
    Default,
    /// 讲解视频：音色 + 文稿。
    ExplainerVideo,
    /// 批量广告：产品图 + 参考视频。
    BatchAd,
    /// 口播视频：声音 + 文稿。
    TalkingHeadVideo,
    /// 素材混剪：多段生成视频卡点混剪。
    SmartMixCut,
}

impl VideoClipMode {
    /// 原站 modeKey：前端模式选择与后端模式目录共用同一套键名。
    pub fn mode_key(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::ExplainerVideo => "explainer_video",
            Self::BatchAd => "batch_ad",
            Self::TalkingHeadVideo => "talking_head_video",
            Self::SmartMixCut => "smart_mix_cut",
        }
    }

    /// 该模式在模式目录里的静态规格。
    pub fn spec(self) -> &'static VideoClipModeSpec {
        match self {
            Self::Default => &DEFAULT_MODE,
            Self::ExplainerVideo => &EXPLAINER_VIDEO_MODE,
            Self::BatchAd => &BATCH_AD_MODE,
            Self::TalkingHeadVideo => &TALKING_HEAD_VIDEO_MODE,
            Self::SmartMixCut => &SMART_MIX_CUT_MODE,
        }
    }
}

/// 智能剪辑参数（比例 / 时长 / 清晰度）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoClipParams {
    /// 画面比例，例如 "16:9"。
    pub aspect_ratio: String,
    /// 合成时长（秒）。
    pub duration_seconds: u32,
    /// 清晰度，例如 "720P"。
    pub resolution: String,
}

/// 智能剪辑的单个素材槽位条目（原站 slotKey 维度）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoClipMaterial {
    /// 原站 slotKey：video / audio / text / productImage / refVideo / generatedVideo。
    pub slot_key: String,
    /// 节点类型：video / image / audio / text。
    pub node_type: String,
    /// 素材名快照，写进任务记录供历史列表展示。
    pub display_name: String,
    /// 供应商媒体角色，例如 reference_video / reference_image / reference_audio。
    pub role: String,
    /// 文字槽位正文（`node_type == "text"` 时有值）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 媒体槽位的素材身份；文字槽位没有素材身份。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<MediaReferenceTarget>,
}

/// 智能剪辑合成请求。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartVideoClipCommand {
    pub client_task_id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    /// 合成模式（原站 5 项之一）。
    pub mode: VideoClipMode,
    /// 用户提示词（各模式的预置提示词由前端带进来）。
    pub prompt: String,
    /// 素材槽位条目。
    pub materials: Vec<VideoClipMaterial>,
    /// 比例 / 时长 / 清晰度。
    pub params: VideoClipParams,
    pub provider_connection_id: String,
    pub model_definition_id: String,
    /// 生成操作，沿用既有任务管线的操作枚举。
    pub operation: GenerationOperation,
    /// 产物名（仅本地历史与文件命名，不发给供应商）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_name: Option<String>,
}

// ------------------------------------------------------------------
// 模式目录（照抄原站）
// ------------------------------------------------------------------

/// 单个素材槽位的规格。
///
/// 目录字段（中文名、是否必填）目前只有校验路径在读；其余字段是给前端的
/// 模式目录与后续技能系统用的数据，先留在后端常量里。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct VideoClipSlotSpec {
    /// 原站 slotKey。
    pub slot_key: &'static str,
    /// 中文槽位名：报错文案里直接用它（原站 i18n 用的就是这些中文名）。
    pub label: &'static str,
    /// 该槽位接受的节点类型。
    pub accepted_node_types: &'static [&'static str],
    /// 是否必填。
    pub required: bool,
    /// 最少个数（必填槽位为 1，选填槽位为 0）。
    pub min_count: usize,
    /// 最多个数。
    pub max_count: usize,
}

/// 单个合成模式的规格。
///
/// 模式名、预置提示词、预置素材与原站技能标识是目录数据：前端按同一张表渲染
/// 模式选择，后端当前只读取槽位要求与「提示词是否必填」。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct VideoClipModeSpec {
    /// 模式枚举值。
    pub mode: VideoClipMode,
    /// 模式中文名。
    pub display_name: &'static str,
    /// 提示词是否必填。原站五个模式都要填：默认模式只是没有预置提示词。
    pub prompt_required: bool,
    /// 预置提示词（原站原文）。
    pub preset_prompt: Option<&'static str>,
    /// 预置素材槽位。原站这五个模式都没有预置素材，目录里保留位置。
    pub preset_material_slots: &'static [&'static str],
    /// 原站技能标识（暂不真正调用技能系统，只作为目录信息保留）。
    pub skill_id: Option<&'static str>,
    /// 该模式的素材槽位要求。
    pub slots: &'static [VideoClipSlotSpec],
}

// 槽位定义（中文名与原站 i18n 一致：视频 / 音频 / 文字 / 产品图 / 参考视频 / 生成视频）。
const VIDEO_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "video",
    label: "视频",
    accepted_node_types: &["video"],
    required: true,
    min_count: 1,
    max_count: 30,
};

const AUDIO_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "audio",
    label: "音频",
    accepted_node_types: &["audio"],
    required: true,
    min_count: 1,
    max_count: 1,
};

const TEXT_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "text",
    label: "文字",
    accepted_node_types: &["text"],
    required: false,
    min_count: 0,
    max_count: 10,
};

const PRODUCT_IMAGE_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "productImage",
    label: "产品图",
    accepted_node_types: &["image"],
    required: true,
    min_count: 1,
    max_count: 10,
};

const REF_VIDEO_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "refVideo",
    label: "参考视频",
    accepted_node_types: &["video"],
    required: true,
    min_count: 1,
    max_count: 1,
};

const GENERATED_VIDEO_SLOT: VideoClipSlotSpec = VideoClipSlotSpec {
    slot_key: "generatedVideo",
    label: "生成视频",
    accepted_node_types: &["video"],
    required: true,
    min_count: 5,
    max_count: 30,
};

/// 默认模式：只给一个视频槽位，提示词完全由用户写（原站无预置提示词）。
const DEFAULT_MODE: VideoClipModeSpec = VideoClipModeSpec {
    mode: VideoClipMode::Default,
    display_name: "默认模式",
    prompt_required: true,
    preset_prompt: None,
    preset_material_slots: &[],
    skill_id: None,
    slots: &[VIDEO_SLOT],
};

/// 讲解视频：音色（音频）+ 文稿（文字）。
const EXPLAINER_VIDEO_MODE: VideoClipModeSpec = VideoClipModeSpec {
    mode: VideoClipMode::ExplainerVideo,
    display_name: "讲解视频",
    prompt_required: true,
    preset_prompt: Some("根据我的音色和主题，生成讲解视频。我的主题是‘神经网络发展历史科普’"),
    preset_material_slots: &[],
    skill_id: Some("faceless-commentary-video"),
    slots: &[AUDIO_SLOT, TEXT_SLOT],
};

/// 批量广告：产品图 + 参考视频。
const BATCH_AD_MODE: VideoClipModeSpec = VideoClipModeSpec {
    mode: VideoClipMode::BatchAd,
    display_name: "批量广告",
    prompt_required: true,
    preset_prompt: Some("参考这支视频的节奏和运镜，用我的产品图批量制作广告"),
    preset_material_slots: &[],
    skill_id: Some("batch-ad-replicator"),
    slots: &[PRODUCT_IMAGE_SLOT, REF_VIDEO_SLOT],
};

/// 口播视频：声音（音频）+ 文稿（文字）。
const TALKING_HEAD_VIDEO_MODE: VideoClipModeSpec = VideoClipModeSpec {
    mode: VideoClipMode::TalkingHeadVideo,
    display_name: "口播视频",
    prompt_required: true,
    preset_prompt: Some("用我的声音和这份文稿生成口播视频，文稿主题是‘神经网络发展历史科普’"),
    preset_material_slots: &[],
    skill_id: Some("talking-head-video"),
    slots: &[AUDIO_SLOT, TEXT_SLOT],
};

/// 素材混剪：多段生成视频卡点混剪。
const SMART_MIX_CUT_MODE: VideoClipModeSpec = VideoClipModeSpec {
    mode: VideoClipMode::SmartMixCut,
    display_name: "素材混剪",
    prompt_required: true,
    preset_prompt: Some("把我的素材进行智能混剪，要卡点并突出产品"),
    preset_material_slots: &[],
    skill_id: Some("beat-sync-video-producer"),
    slots: &[GENERATED_VIDEO_SLOT],
};

/// 模式目录（原站 5 项）：前端渲染模式选择与后端校验共用这一份常量。
#[allow(dead_code)]
pub const VIDEO_CLIP_MODES: [VideoClipModeSpec; 5] = [
    DEFAULT_MODE,
    EXPLAINER_VIDEO_MODE,
    BATCH_AD_MODE,
    TALKING_HEAD_VIDEO_MODE,
    SMART_MIX_CUT_MODE,
];

// ------------------------------------------------------------------
// 校验
// ------------------------------------------------------------------

/// 槽位不满足要求时的报错。`message` 直接是原站 i18n 的中文原文，
/// 前端会把它当人话展示，所以不要在这里加前缀。
fn slot_error(spec: &VideoClipModeSpec, slot: &VideoClipSlotSpec, message: String) -> BackendError {
    BackendError::validation(
        message,
        json!({
            "mode": spec.mode.mode_key(),
            "slotKey": slot.slot_key,
            "slotLabel": slot.label,
            "minCount": slot.min_count,
            "maxCount": slot.max_count,
        }),
    )
}

/// 素材条目是否满足槽位要求：
/// - 节点类型必须落在该槽位接受的类型里（原站规则：不匹配按「缺失」处理）；
/// - 媒体槽位必须带素材身份（没有 target 的素材没法下发给供应商，同样按缺失处理）；
/// - 文字槽位没有素材身份，只有正文。
fn slot_matches(slot: &VideoClipSlotSpec, material: &VideoClipMaterial) -> bool {
    if !slot
        .accepted_node_types
        .contains(&material.node_type.as_str())
    {
        return false;
    }
    if slot.accepted_node_types.contains(&"text") {
        return true;
    }
    material.target.is_some()
}

/// 校验素材槽位：先看数量上限，再看必填/最少数量。
/// 报错文案全部照抄原站 i18n：
/// - 数量不足 → `还需添加{槽位名}（至少 {min} 个）`
/// - 数量超限 → `{槽位名}最多 {max} 个`
pub(crate) fn validate_materials(
    spec: &VideoClipModeSpec,
    materials: &[VideoClipMaterial],
) -> BackendResult<()> {
    for material in materials {
        let slot = spec.slots.iter().find(|slot| slot.slot_key == material.slot_key)
            .ok_or_else(|| BackendError::validation("当前模式不接受此素材槽位", json!({"slot":material.slot_key})))?;
        if !slot_matches(slot, material)
            || (material.node_type == "text" && material.text.as_deref().is_none_or(|text| text.trim().is_empty()))
            || material.target.as_ref().is_some_and(|target| target.media_type().as_str() != material.node_type) {
            return Err(BackendError::validation("素材类型或内容与剪辑槽位不匹配，请重新连接", json!({"slot":material.slot_key})));
        }
    }
    for slot in spec.slots {
        let assigned: Vec<&VideoClipMaterial> = materials
            .iter()
            .filter(|material| material.slot_key == slot.slot_key)
            .collect();
        if assigned.len() > slot.max_count {
            return Err(slot_error(
                spec,
                slot,
                format!("{}最多 {} 个", slot.label, slot.max_count),
            ));
        }
        let matched = assigned
            .iter()
            .filter(|material| slot_matches(slot, material))
            .count();
        if matched < slot.min_count {
            return Err(slot_error(
                spec,
                slot,
                format!("还需添加{}（至少 {} 个）", slot.label, slot.min_count),
            ));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------
// 载荷组装
// ------------------------------------------------------------------

/// 参数摘要：比例 · 清晰度 · 时长秒（原站合成提示词里的参数后缀）。
fn params_summary(params: &VideoClipParams) -> String {
    let mut parts: Vec<String> = Vec::new();
    let ratio = params.aspect_ratio.trim();
    if !ratio.is_empty() {
        parts.push(ratio.to_string());
    }
    let resolution = params.resolution.trim();
    if !resolution.is_empty() {
        parts.push(resolution.to_string());
    }
    parts.push(format!("{}s", params.duration_seconds));
    parts.join(" · ")
}

/// 合成提示词正文：用户提示词在前，文字槽位正文在后（换行分隔）。
/// 参数后缀（`，参数是 …`）在最后由调用方拼上。
fn compose_prompt_body(command: &StartVideoClipCommand, spec: &VideoClipModeSpec) -> String {
    let mut parts: Vec<String> = Vec::new();
    let user_prompt = command.prompt.trim();
    if !user_prompt.is_empty() {
        parts.push(user_prompt.to_string());
    }
    for slot in spec.slots {
        if !slot.accepted_node_types.contains(&"text") {
            continue;
        }
        for material in command
            .materials
            .iter()
            .filter(|material| material.slot_key == slot.slot_key)
            .filter(|material| material.node_type == "text")
        {
            let text = material.text.as_deref().map(str::trim).unwrap_or_default();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    parts.join("\n")
}

/// 媒体槽位 → 生成管线的显式素材输入。
/// 按模式目录里的槽位顺序排列（与原站逐槽位拼接素材的顺序一致），
/// 槽位内部保持前端给出的顺序。
fn compose_explicit_media(
    spec: &VideoClipModeSpec,
    materials: &[VideoClipMaterial],
) -> BackendResult<Vec<ExplicitMediaInput>> {
    let mut explicit_media: Vec<ExplicitMediaInput> = Vec::new();
    for slot in spec.slots {
        if slot.accepted_node_types.contains(&"text") {
            continue;
        }
        for material in materials
            .iter()
            .filter(|material| material.slot_key == slot.slot_key)
        {
            if !slot
                .accepted_node_types
                .contains(&material.node_type.as_str())
            {
                return Err(BackendError::validation("剪辑素材类型与槽位不匹配", json!({"slot":slot.slot_key})));
            }
            let Some(target) = material.target.clone() else {
                return Err(BackendError::validation("剪辑素材缺少可执行身份，请重新连接", json!({"slot":slot.slot_key})));
            };
            explicit_media.push(ExplicitMediaInput {
                target,
                role: match material.node_type.as_str() {
                    "image" => "reference_image", "audio" => "reference_audio", _ => "reference_video",
                }.into(),
                display_name_snapshot: material.display_name.clone(),
                type_position: None,
                content_index: None,
            });
        }
    }
    Ok(explicit_media)
}

/// 校验 + 组装：把智能剪辑请求翻译成既有生成管线的命令。
/// 纯函数，方便单独验证组装结果。
pub fn prepare_generation_command(
    command: &StartVideoClipCommand,
) -> BackendResult<StartGenerationCommand> {
    uuid::Uuid::parse_str(&command.client_task_id).map_err(|_| BackendError::validation("剪辑请求身份无效", json!({})))?;
    validate_params(&command.params)?;
    if command.operation != GenerationOperation::VideoGeneration {
        return Err(BackendError::validation("智能剪辑只能创建视频任务", json!({})));
    }
    let spec = command.mode.spec();
    if spec.prompt_required && command.prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "请填写提示词",
            json!({ "mode": spec.mode.mode_key(), "field": "prompt" }),
        ));
    }
    validate_materials(spec, &command.materials)?;

    let body = compose_prompt_body(command, spec);
    if body.trim().is_empty() {
        return Err(BackendError::validation(
            "请填写提示词",
            json!({ "mode": spec.mode.mode_key(), "field": "prompt" }),
        ));
    }
    // 原站合成提示词 = 用户提示词（+ 文稿正文）+`，参数是 比例 · 清晰度 · 时长`
    let instruction = match command.mode {
        VideoClipMode::ExplainerVideo => "制作讲解视频，以提供的声音参考与文稿组织旁白和对应画面，保持叙述连贯。",
        VideoClipMode::BatchAd => "制作产品广告，以产品图保持外观与品牌一致，参考视频只用于节奏、结构与运镜，不复制其中无关产品。",
        VideoClipMode::TalkingHeadVideo => "制作口播视频，遵循提供的声音参考与文稿，画面人物、口型与叙述保持一致。",
        VideoClipMode::SmartMixCut => "按用户需求组织参考视频的节奏、内容与剪辑顺序。",
        VideoClipMode::Default => "按照用户要求对所给视频进行剪辑。",
    };
    let prompt = format!("{instruction}\n{body}，参数是 {}", params_summary(&command.params));

    let mut parameters = json!({
        "aspect_ratio": command.params.aspect_ratio.trim(),
        "duration": command.params.duration_seconds,
        "resolution": command.params.resolution.trim(),
    });
    if command.params.duration_seconds == 0 { parameters.as_object_mut().expect("parameters object").remove("duration"); }

    Ok(StartGenerationCommand {
        client_task_id: Some(command.client_task_id.clone()),
        camera_control_snapshot: None,
        image_preset_snapshot: None,
        output_name: command.output_name.clone(),
        // 智能剪辑不是工作流编排任务：没有工作流运行号。
        workflow_run_id: None,
        canvas_id: command.canvas_id.clone(),
        source_node_id: command.source_node_id.clone(),
        operation: command.operation,
        provider_connection_id: command.provider_connection_id.clone(),
        model_definition_id: command.model_definition_id.clone(),
        prompt: vec![PromptSegment::Text { text: prompt }],
        explicit_media: compose_explicit_media(spec, &command.materials)?,
        parameters,
        // 智能剪辑不是 Seedance 草稿/编辑链路，任务意图不参与供应商参数方言。
        video_task_type: None,
        use_original_cloud_media: None,
        model_operation_schema_snapshot: None,
        generation_count: 1,
    })
}

pub(crate) fn validate_params(params: &VideoClipParams) -> BackendResult<()> {
    if !["21:9", "16:9", "9:16", "1:1", "4:3", "3:4"].contains(&params.aspect_ratio.as_str())
        || !["480P", "720P", "1080P"].contains(&params.resolution.as_str()) || params.duration_seconds > 300 {
        return Err(BackendError::validation("请选择支持的比例、清晰度和0至300秒时长", json!({})));
    }
    Ok(())
}

// ------------------------------------------------------------------
// 服务
// ------------------------------------------------------------------

/// 智能剪辑服务：校验模式目录 → 组装生成命令 → 下发到既有生成任务管线。
pub struct VideoClipService {
    tasks: GenerationTaskService,
}

impl VideoClipService {
    pub fn new(tasks: GenerationTaskService) -> Self {
        Self { tasks }
    }

    /// 启动一次智能剪辑合成，返回任务 ID。
    pub fn start(&self, command: StartVideoClipCommand) -> BackendResult<String> {
        let generation = prepare_generation_command(&command)?;
        self.tasks.start(generation)
    }
}
