//! Public LibTV model-version `versionIntro` recipes. No private asset IDs or
//! LibTV version numbers are passed through to an unrelated generation provider.
use std::sync::LazyLock;
use serde_json::{Value, json};
use super::{error::{BackendError, BackendResult}, types::{GenerationOperation, PromptSegment, StartGenerationCommand}};

static CATALOG: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../../shared/video-effect-templates.json")).expect("bundled video effect catalog"));

pub fn apply(command: &mut StartGenerationCommand) -> BackendResult<Option<Value>> {
    let Some(selection) = command.parameters.get("__canvas_effects").cloned() else { return Ok(None); };
    if command.operation != GenerationOperation::VideoGeneration || command.parameters.get(super::video_storyboard::LOCAL_KEY).is_some() {
        return Err(BackendError::validation("特效模板仅用于普通视频生成；使用智能分镜时请先移除特效模板", json!({})));
    }
    let ids: Vec<u64> = serde_json::from_value(selection).map_err(|_| BackendError::validation("特效模板版本格式无效", json!({})))?;
    if ids.is_empty() || ids.len() > 6 || ids.iter().enumerate().any(|(index, id)| ids[..index].contains(id)) {
        return Err(BackendError::validation("请选择 1–6 个不重复的特效模板", json!({})));
    }
    let mut recipes = Vec::new();
    let mut instructions = String::from("\n\n【已选择的特效模板】以下模板提供运镜、光影、场景变化与动作节奏。若用户正文或实际参考素材已明确主体，保留该主体身份，模板示例中的人物、产品名称只用于说明效果。视频时长、画幅、音频开关与分辨率以本次实际参数为准；模板内部时间线按总时长等比安排，不擅自改变生成参数。\n");
    for id in ids {
        let item = CATALOG["items"].as_array().and_then(|items| items.iter().find(|item| item["versionId"].as_u64() == Some(id)))
            .ok_or_else(|| BackendError::validation("特效模板版本不可用，请重新选择", json!({"versionId": id})))?;
        let intro = &item["versionIntro"];
        if intro["type"] != "camera" || intro["subType"] != "framing" || intro["templateInfo"].as_array().is_none_or(|items| !items.is_empty()) {
            return Err(BackendError::validation("该特效需要尚未支持的模板输入，请更换特效", json!({"versionId": id})));
        }
        let config = &intro["promptConfig"];
        let system_prompt = config["systemPrompt"].as_str().filter(|text| !text.trim().is_empty())
            .ok_or_else(|| BackendError::validation("特效模板没有可执行的提示词", json!({"versionId": id})))?;
        instructions.push_str(&format!("\n特效：{}\n", item["name"].as_str().unwrap_or_default()));
        for text in [config["prefix"].as_str().unwrap_or_default(), system_prompt, intro["effectPrompt"].as_str().unwrap_or_default(), config["suffix"].as_str().unwrap_or_default()] {
            if !text.trim().is_empty() { instructions.push_str(text); instructions.push('\n'); }
        }
        // Freeze the original recipe, including example references, for history.
        // Example/private provider assets are never silently imported as user media.
        recipes.push(item.clone());
    }
    command.parameters.as_object_mut().expect("effect selection requires object").remove("__canvas_effects");
    command.prompt.push(PromptSegment::Text { text: instructions });
    Ok(Some(Value::Array(recipes)))
}
