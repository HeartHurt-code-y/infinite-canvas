//! 图片节点的本地意图编译与个人预设。不会向 liblib 发送请求。
//!
//! 原站 upscaler 是私有服务。本项目通过用户选择的图生图模型做高清重建，
//! 不承诺确定的输出像素；模型、凭据、素材和结果仍由 TaskService 冻结与恢复。
use std::{io::Write as _, path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    storage::now_ms,
    types::{GenerationOperation, MediaType, PromptSegment, StartGenerationCommand},
};

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasImageMode {
    #[default]
    Auto,
    ImageToImage,
    Upscale,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CanvasImageStyle {
    pub name: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCanvasImageCommand {
    pub generation: StartGenerationCommand,
    #[serde(default)]
    pub mode: CanvasImageMode,
    pub target_resolution: Option<String>,
    pub style: Option<CanvasImageStyle>,
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
    if let Some(style) = command.style {
        validate_text(&style.name, 100, "风格名称")?;
        validate_text(&style.prompt, 10000, "风格描述")?;
        generation.prompt.push(PromptSegment::Text { text: format!("\n画面风格「{}」：{}", style.name.trim(), style.prompt.trim()) });
    }
    if matches!(command.mode, CanvasImageMode::Upscale) {
        let resolution = command.target_resolution.as_deref().unwrap_or("2K");
        if !matches!(resolution, "1K" | "2K" | "4K") {
            return Err(BackendError::validation("请选择 1K、2K 或 4K 高清目标", Value::Null));
        }
        generation.operation = GenerationOperation::ImageToImage;
        generation.prompt.push(PromptSegment::Text { text: format!("\n对参考图片进行高清重建，目标清晰度 {resolution}。保留原图主体、身份、构图、文字和色彩，提升边缘、纹理与细节，减少压缩噪声，不添加新物体。实际输出尺寸遵循当前模型的参数。") });
    }
    Ok(generation)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasImagePreset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub text: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCanvasImagePresetCommand {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub text: String,
}

// 所有窗口共用同一把锁，读取、修改、原子替换构成一次事务。
static PRESETS_LOCK: Mutex<()> = Mutex::new(());

fn validate_text(value: &str, max: usize, label: &str) -> BackendResult<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(BackendError::validation(format!("{label}不能为空，且不能超过 {max} 字"), Value::Null));
    }
    Ok(())
}

fn read_presets(directory: &Path) -> BackendResult<Vec<CanvasImagePreset>> {
    let path = directory.join("canvas-image-presets.json");
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn list_presets(directory: &Path) -> BackendResult<Vec<CanvasImagePreset>> {
    let _guard = PRESETS_LOCK.lock().map_err(|_| BackendError::Conflict("预设库暂不可用，请重启应用".into()))?;
    let mut presets = read_presets(directory)?;
    presets.sort_by_key(|preset| std::cmp::Reverse(preset.updated_at));
    Ok(presets)
}

fn write_presets(directory: &Path, presets: &[CanvasImagePreset]) -> BackendResult<()> {
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec_pretty(presets)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("canvas-image-presets.json")).map_err(|error| error.error)?;
    Ok(())
}

pub fn save_preset(directory: &Path, command: SaveCanvasImagePresetCommand) -> BackendResult<CanvasImagePreset> {
    if !matches!(command.kind.as_str(), "style" | "prompt") {
        return Err(BackendError::validation("预设类型无效", Value::Null));
    }
    validate_text(&command.name, 100, "预设名称")?;
    validate_text(&command.text, 10000, "预设内容")?;
    let _guard = PRESETS_LOCK.lock().map_err(|_| BackendError::Conflict("预设库暂不可用，请重启应用".into()))?;
    let mut presets = read_presets(directory)?;
    let index = if let Some(id) = &command.id {
        Some(presets.iter().position(|preset| &preset.id == id && preset.kind == command.kind)
            .ok_or_else(|| BackendError::NotFound("这份预设已删除，请重新读取".into()))?)
    } else { None };
    if index.is_none() && presets.len() >= 500 {
        return Err(BackendError::validation("最多保存 500 份个人预设，请先清理不再使用的条目", Value::Null));
    }
    let preset = CanvasImagePreset {
        id: command.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        kind: command.kind,
        name: command.name.trim().to_string(),
        text: command.text.trim().to_string(),
        updated_at: now_ms(),
    };
    if let Some(index) = index { presets[index] = preset.clone(); } else { presets.push(preset.clone()); }
    write_presets(directory, &presets)?;
    Ok(preset)
}

pub fn delete_preset(directory: &Path, id: &str) -> BackendResult<()> {
    let _guard = PRESETS_LOCK.lock().map_err(|_| BackendError::Conflict("预设库暂不可用，请重启应用".into()))?;
    let mut presets = read_presets(directory)?;
    presets.retain(|preset| preset.id != id);
    write_presets(directory, &presets)
}
