//! 图片意图编译：公开样图风格参考、专用超分、预设与翻译。
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::Value;

use super::{
    error::{BackendError, BackendResult},
    types::{GenerationOperation, MediaReferenceTarget, MediaType, PromptSegment, StartGenerationCommand},
};

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasImageMode {
    #[default]
    Auto,
    ImageToImage,
    Upscale,
    MaskedEdit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCanvasImageCommand {
    pub generation: StartGenerationCommand,
    #[serde(default)]
    pub mode: CanvasImageMode,
    pub style_reference: Option<super::image_style_market::ImageStyleReference>,
    pub upscale_scale: Option<u32>,
    pub preset: Option<super::image_presets::ImagePresetSelection>,
    pub camera_control: Option<super::camera_control::CanvasCameraControl>,
    #[serde(default)]
    pub panorama: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartImageTranslationCommand {
    pub task_id: String,
    pub generation: StartGenerationCommand,
}

pub static TRANSLATION_START_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
struct TranslationInput {
    language: String,
    items: Vec<TranslationItem>,
}

#[derive(Deserialize)]
struct TranslationItem {
    index: usize,
    text: String,
}

pub fn validate_translation(generation: &StartGenerationCommand) -> BackendResult<()> {
    if generation.operation != GenerationOperation::TextGeneration || !generation.explicit_media.is_empty()
        || generation.generation_count != 1 || generation.prompt.len() != 1 {
        return Err(BackendError::validation("提示词翻译只接受一份文字输入", Value::Null));
    }
    let Some(PromptSegment::Text { text }) = generation.prompt.first() else {
        return Err(BackendError::validation("提示词翻译不能上传媒体", Value::Null));
    };
    if text.len() > 300_000 {
        return Err(BackendError::validation("翻译内容过长，请减少文字后重试", Value::Null));
    }
    let input: TranslationInput = serde_json::from_str(text)
        .map_err(|_| BackendError::validation("翻译文字条目无效", Value::Null))?;
    let mut indices = std::collections::HashSet::new();
    if !matches!(input.language.as_str(), "English" | "Chinese") || input.items.is_empty()
        || input.items.len() > 2000 || input.items.iter().map(|item| item.text.chars().count()).sum::<usize>() > 40000
        || input.items.iter().any(|item| item.text.trim().is_empty() || !indices.insert(item.index)) {
        return Err(BackendError::validation("请选择中文或英语，并提供不重复的文字条目（总计不超过 40000 字）", Value::Null));
    }
    Ok(())
}

pub fn compile(command: StartCanvasImageCommand) -> BackendResult<StartGenerationCommand> {
    let mut generation = command.generation;
    // 新提交的快照仅由本地编译器生成，不能接受调用方伪造的历史记录。
    generation.image_preset_snapshot = None;
    generation.camera_control_snapshot = None;
    if !matches!(generation.operation, GenerationOperation::TextToImage | GenerationOperation::ImageToImage) {
        return Err(BackendError::validation("图片节点只能提交图片任务", Value::Null));
    }
    if matches!(command.mode, CanvasImageMode::MaskedEdit) {
        let media = &generation.explicit_media;
        let valid_media = media.len() == 2 && ["image", "mask"].into_iter().all(|role|
            media.iter().filter(|item| item.role == role && matches!(item.target,
                MediaReferenceTarget::LocalFile { media_type: MediaType::Image, .. })).count() == 1
        );
        if !valid_media || !matches!(generation.prompt.as_slice(), [PromptSegment::Text { text }] if !text.trim().is_empty()) {
            return Err(BackendError::validation("扩图和重绘需要一张底图、一张蒙版和一份文字描述。", Value::Null));
        }
        generation.operation = GenerationOperation::ImageToImage;
        return Ok(generation);
    }
    if matches!(command.mode, CanvasImageMode::Upscale) {
        generation.operation = GenerationOperation::ImageToImage;
        generation.parameters = serde_json::json!({"outscale":command.upscale_scale.unwrap_or(2),"output_format":"png"});
        generation.generation_count = 1;
        // Retain media mentions so images pasted into the prompt remain valid inputs.
        // The dedicated provider encoder sends no prompt to the upscaler.
        return Ok(generation);
    }
    if let Some(style) = command.style_reference {
        super::image_style_market::validate_reference(&style)?;
        let next_position = generation.explicit_media.iter().filter_map(|item| item.type_position)
            .chain(generation.prompt.iter().filter_map(|item| match item { PromptSegment::MediaReference { type_position, .. } => *type_position, _ => None })).max().unwrap_or(0) + 1;
        let next_index = generation.explicit_media.iter().filter_map(|item| item.content_index)
            .chain(generation.prompt.iter().filter_map(|item| match item { PromptSegment::MediaReference { content_index, .. } => *content_index, _ => None })).max().unwrap_or(0) + 1;
        generation.prompt.push(PromptSegment::Text { text: format!("\n风格参考（{}）：", style.name) });
        generation.prompt.push(PromptSegment::MediaReference {
            mention_id: format!("style-reference:{}", style.id),
            target: MediaReferenceTarget::Url { url: style.image_url, media_type: MediaType::Image, canvas_node_key: None },
            display_name_snapshot: format!("风格参考：{}", style.name),
            type_position: Some(next_position), content_index: Some(next_index),
        });
        generation.prompt.push(PromptSegment::Text { text: "。只参考这张样图的画风、色彩与质感，主体内容遵循用户描述；不要复制样图里的文字、水印和排版。".into() });
    }
    let has_image = generation.explicit_media.iter().any(|input| input.target.media_type() == MediaType::Image)
        || generation.prompt.iter().any(|segment| matches!(segment, PromptSegment::MediaReference { target, .. } if target.media_type() == MediaType::Image));
    if matches!(command.mode, CanvasImageMode::ImageToImage | CanvasImageMode::Upscale) && !has_image {
        return Err(BackendError::validation("请通过上传或画布参考连接一张图片，再生成", Value::Null));
    }
    if has_image { generation.operation = GenerationOperation::ImageToImage; }
    let camera_locked = command.panorama || command.preset.as_ref().is_some_and(|preset| preset.scene == "720_panoramic");
    if let Some(preset) = command.preset {
        super::image_presets::compile(preset, &mut generation, has_image)?;
    }
    if !camera_locked && let Some(camera_control) = command.camera_control {
        super::camera_control::compile(camera_control, &mut generation)?;
    }
    Ok(generation)
}
