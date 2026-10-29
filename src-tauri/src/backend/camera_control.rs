//! 摄像机控制的本地图片生成编译器。
//! 提示词逐字取自原站公开配置 186；选择 key 保持本地稳定标识。
//! 本地按相机、镜头、焦距、光圈顺序追加片段，不宣称恢复了原站服务端的拼接顺序。
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{error::{BackendError, BackendResult}, types::{PromptSegment, StartGenerationCommand}};

#[derive(Debug, Clone, Deserialize)]
pub struct CanvasCameraControl {
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    pub camera: String,
    pub lens: String,
    pub focal: String,
    pub aperture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenCameraControl {
    pub version: u32,
    pub instruction_origin: String,
    pub camera: String,
    pub camera_name: String,
    pub lens: String,
    pub lens_name: String,
    pub focal: String,
    pub focal_length_mm: f64,
    pub aperture: String,
    pub aperture_value: f64,
    pub compiled_instruction: String,
    /// 旧任务保留原有编译文本；只有采用原站片段的新任务携带这份来源快照。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<FrozenCameraControlSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenCameraControlSource {
    pub config_id: String,
    /// 解码并排版后的配置存档摘要，不是 HTTP 外层响应摘要。
    pub config_sha256: String,
    pub assembly: String,
    pub fragments: Vec<FrozenCameraControlFragment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenCameraControlFragment {
    pub category: String,
    pub source_key: String,
    pub prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    // 版本表示选择结构；提示词来源版本由 instruction_origin 和配置摘要记录。
    version: u32,
    instruction_origin: String,
    instruction_assembly: String,
    source_config_id: String,
    source_config_sha256: String,
    camera: Vec<Item>,
    lens: Vec<Item>,
    focal: Vec<Item>,
    aperture: Vec<Item>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    key: String,
    name: String,
    value: Option<f64>,
    source_key: String,
    prompt: String,
}

static CATALOG: LazyLock<Result<Catalog, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/canvas-camera-control.json"))
        .map_err(|error| error.to_string())
});

fn selected<'a>(items: &'a [Item], key: &str, label: &str) -> BackendResult<&'a Item> {
    items.iter().find(|item| item.key == key).ok_or_else(|| BackendError::validation(
        format!("摄像机的{label}选项已失效，请打开摄像机重新选择"), Value::Null,
    ))
}

pub fn compile(control: CanvasCameraControl, generation: &mut StartGenerationCommand) -> BackendResult<()> {
    // 关闭时不让残留的旧参数影响普通图片任务。
    if !control.enabled { return Ok(()); }
    let catalog = CATALOG.as_ref().map_err(|error| BackendError::validation(
        "摄像机目录读取失败，请更新应用后重试", Value::String(error.clone()),
    ))?;
    if control.version != catalog.version {
        return Err(BackendError::validation("摄像机目录版本已变化，请打开摄像机重新选择参数", Value::Null));
    }
    let camera = selected(&catalog.camera, &control.camera, "相机")?;
    let lens = selected(&catalog.lens, &control.lens, "镜头")?;
    let focal = selected(&catalog.focal, &control.focal, "焦距")?;
    let aperture = selected(&catalog.aperture, &control.aperture, "光圈")?;
    let focal_length_mm = focal.value.filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| BackendError::validation("摄像机焦距目录无效，请更新应用", Value::Null))?;
    let aperture_value = aperture.value.filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| BackendError::validation("摄像机光圈目录无效，请更新应用", Value::Null))?;
    let mut instruction = String::new();
    let mut fragments = Vec::with_capacity(4);
    for (category, item) in [("camera", camera), ("lens", lens), ("focal", focal), ("aperture", aperture)] {
        if item.source_key.trim().is_empty() || item.prompt.trim().is_empty() {
            return Err(BackendError::validation("摄像机提示词目录不完整，请更新应用后重试", Value::Null));
        }
        // 原文自带前导逗号与空格；不 trim、翻译、润色或插入额外摄影说明。
        instruction.push_str(&item.prompt);
        fragments.push(FrozenCameraControlFragment {
            category: category.to_string(),
            source_key: item.source_key.clone(),
            prompt: item.prompt.clone(),
        });
    }
    generation.prompt.push(PromptSegment::Text { text: instruction.clone() });
    generation.camera_control_snapshot = Some(FrozenCameraControl {
        version: catalog.version,
        instruction_origin: catalog.instruction_origin.clone(),
        camera: camera.key.clone(), camera_name: camera.name.clone(),
        lens: lens.key.clone(), lens_name: lens.name.clone(),
        focal: focal.key.clone(), focal_length_mm,
        aperture: aperture.key.clone(), aperture_value,
        compiled_instruction: instruction,
        source: Some(FrozenCameraControlSource {
            config_id: catalog.source_config_id.clone(),
            config_sha256: catalog.source_config_sha256.clone(),
            assembly: catalog.instruction_assembly.clone(),
            fragments,
        }),
    });
    Ok(())
}
