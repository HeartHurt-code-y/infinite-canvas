use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;

use super::{
    BackendState,
    error::{BackendError, CommandResult, IntoCommandResult as _},
    model_schema::{ATLASCLOUD_IMAGE_PROFILE, ATLASCLOUD_VIDEO_PROFILE},
    types::{GenerationOperation, MediaType, StartGenerationCommand},
};

pub const VIDEO_UPSCALER: &str = "atlascloud/video-upscaler";
pub const IMAGE_BACKGROUND: &str = "youchuan/v8.1/remove-background";
pub const IMAGE_LAYERS: &str = "bytedance/seedream-v5.0-pro/layer-decomposition";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasFeatureGeneration {
    VideoUpscale,
    ImageBackground,
    ImageLayers,
}

impl CanvasFeatureGeneration {
    fn spec(self) -> (GenerationOperation, MediaType, &'static str, &'static str, Value) {
        match self {
            Self::VideoUpscale => (
                GenerationOperation::VideoGeneration, MediaType::Video, VIDEO_UPSCALER, "视频高清",
                json!({"target_resolution":{"type":"string","enum":["1080p","2k"],"default":"1080p"}}),
            ),
            Self::ImageBackground => (
                GenerationOperation::ImageToImage, MediaType::Image, IMAGE_BACKGROUND, "抠图", json!({}),
            ),
            Self::ImageLayers => (
                GenerationOperation::ImageToImage, MediaType::Image, IMAGE_LAYERS, "图层分离",
                json!({"size":{"type":"string","enum":["auto","1K","1.5K","2K"],"default":"auto"}}),
            ),
        }
    }
}

#[tauri::command]
pub fn start_canvas_feature_generation(
    state: State<'_, BackendState>,
    tool: CanvasFeatureGeneration,
    mut generation: StartGenerationCommand,
) -> CommandResult<String> {
    let (operation, media, model, label, parameters) = tool.spec();
    let result = (|| {
        if generation.operation != operation || generation.generation_count != 1 ||
            !matches!(generation.explicit_media.as_slice(), [input] if input.target.media_type() == media) ||
            generation.prompt.iter().any(|segment| !matches!(segment, super::types::PromptSegment::Text { .. })) {
            return Err(BackendError::validation("请选择一项符合工具类型的素材。", Value::Null));
        }
        let video = media == MediaType::Video;
        let schema = json!({
            "profileVersion":1,
            "requestProfileId":if video { ATLASCLOUD_VIDEO_PROFILE } else { ATLASCLOUD_IMAGE_PROFILE },
            "resultType":media.as_str(),
            "request":{
                "encoding":"json",
                "path":if video { "/api/v1/model/generateVideo" } else { "/api/v1/model/generateImage" },
                "observePath":"/api/v1/model/prediction/{task_id}",
                "mediaEncoding":"atlascloud_canvas_media_tool",
                "mediaField":media.as_str(),
                "parameterContainer":"root"
            },
            "parameters":parameters,
        });
        generation.model_definition_id = state.storage.ensure_canvas_media_tool(
            &generation.provider_connection_id, model, label, operation, schema,
        )?;
        state.tasks.start(generation)
    })();
    result.command()
}
