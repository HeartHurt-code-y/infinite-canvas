//! 图片预设的本地编译器。scene/菜单元数据来自静态客户端；生成指令由本项目实现，
//! 不是恢复出的 liblib 服务端提示词。与前端读取同一份版本化目录。
use std::{collections::BTreeMap, sync::LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    error::{BackendError, BackendResult},
    types::{PromptSegment, StartGenerationCommand},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePresetSelection {
    pub scene: String,
    pub version: u32,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

/// 只随 logical_request 落盘；不会作为供应商请求参数发送。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenImagePreset {
    pub scene: String,
    pub version: u32,
    pub label: String,
    pub instruction_origin: String,
    pub options: BTreeMap<String, String>,
    pub compiled_instruction: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    version: u32,
    instruction_origin: String,
    groups: Vec<PresetGroup>,
}

#[derive(Deserialize)]
struct PresetGroup {
    presets: Vec<Preset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    scene: String,
    label: String,
    input_requirement: String,
    instruction: String,
    #[serde(default)]
    options: Vec<PresetOption>,
}

#[derive(Deserialize)]
struct PresetOption {
    key: String,
    label: String,
    default: String,
    values: Vec<OptionValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionValue {
    value: String,
    instruction: String,
    preset_label: Option<String>,
    legacy: Option<LegacyOptionValue>,
}

#[derive(Deserialize)]
struct LegacyOptionValue {
    key: String,
    value: String,
}

static CATALOG: LazyLock<Result<Catalog, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/canvas-image-presets.json"))
        .map_err(|error| error.to_string())
});

pub fn compile(
    selection: ImagePresetSelection,
    generation: &mut StartGenerationCommand,
    has_image: bool,
) -> BackendResult<()> {
    let catalog = CATALOG.as_ref().map_err(|error| BackendError::validation(
        "内置图片预设目录读取失败，请更新应用后重试", Value::String(error.clone()),
    ))?;
    // v1 人像参数只在本次请求中归一化；历史任务的冻结指令与结果保持原样。
    let legacy_selection = selection.version == 1;
    if !legacy_selection && selection.version != catalog.version {
        return Err(BackendError::validation("这份图片预设的版本已变化，请重新选择预设后生成", Value::Null));
    }
    let preset = catalog.groups.iter().flat_map(|group| &group.presets)
        .find(|preset| preset.scene == selection.scene)
        .ok_or_else(|| BackendError::validation("这份图片预设已不可用，请清除后重新选择", Value::Null))?;
    let has_text = generation.prompt.iter().any(|segment| matches!(segment, PromptSegment::Text { text } if !text.trim().is_empty()));
    match preset.input_requirement.as_str() {
        "image" if !has_image => return Err(BackendError::validation(
            format!("「{}」需要参考图片，请先上传或从画布引用图片", preset.label), Value::Null,
        )),
        "prompt" if !has_text => return Err(BackendError::validation(
            format!("请先填写「{}」的剧情描述，再生成", preset.label), Value::Null,
        )),
        "prompt_or_image" if !has_text && !has_image => return Err(BackendError::validation(
            format!("请为「{}」填写描述或连接参考图片", preset.label), Value::Null,
        )),
        "image" | "prompt" | "prompt_or_image" => {},
        _ => return Err(BackendError::validation("这份图片预设的输入定义无效，请更新应用", Value::Null)),
    }
    if selection.options.iter().any(|(key, value)| !preset.options.iter().any(|option| {
        &option.key == key || legacy_selection && option.values.iter().any(|item| {
            item.legacy.as_ref().is_some_and(|legacy| &legacy.key == key && &legacy.value == value)
        })
    })) {
        return Err(BackendError::validation("图片预设包含失效选项，请重新选择预设", Value::Null));
    }
    let mut options = BTreeMap::new();
    let mut label = preset.label.clone();
    let mut option_instructions = String::new();
    for option in &preset.options {
        let legacy_value = legacy_selection.then(|| option.values.iter().find(|item| {
            item.legacy.as_ref().is_some_and(|legacy| selection.options.get(&legacy.key) == Some(&legacy.value))
        })).flatten();
        let value = selection.options.get(&option.key)
            .or_else(|| legacy_value.map(|item| &item.value)).unwrap_or(&option.default);
        let selected = option.values.iter().find(|item| &item.value == value)
            .ok_or_else(|| BackendError::validation(
                format!("「{}」的{}选项已失效，请重新选择", preset.label, option.label), Value::Null,
            ))?;
        if let Some(selected_label) = &selected.preset_label {
            label = selected_label.clone();
        }
        if !selected.instruction.is_empty() {
            option_instructions.push_str(&format!("\n{}：{}", option.label, selected.instruction));
        }
        options.insert(option.key.clone(), selected.value.clone());
    }
    let instruction = format!("\n\n图片预设「{}」：\n{}{}", label, preset.instruction, option_instructions);
    // 不改写现有文字、附件、素材身份或引用顺序，编译文本追加为独立片段。
    generation.prompt.push(PromptSegment::Text { text: instruction.clone() });
    generation.image_preset_snapshot = Some(FrozenImagePreset {
        scene: preset.scene.clone(),
        version: catalog.version,
        label,
        instruction_origin: catalog.instruction_origin.clone(),
        options,
        compiled_instruction: instruction,
    });
    Ok(())
}
