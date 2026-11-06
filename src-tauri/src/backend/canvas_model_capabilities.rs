use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::json;

use super::{
    error::{BackendError, BackendResult},
    types::GenerationOperation,
};

#[derive(Deserialize)]
struct ModelSelector {
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    adapters: Vec<String>,
}

impl ModelSelector {
    fn matches(&self, adapter: &str, id: &str) -> bool {
        (self.adapters.is_empty() || self.adapters.iter().any(|value| value == adapter))
            && ((self.models.is_empty() && self.prefixes.is_empty())
                || self.models.iter().any(|model| model == id)
                || self.prefixes.iter().any(|prefix| id.starts_with(prefix)))
    }
}

#[derive(Deserialize)]
struct OperationRestriction {
    #[serde(flatten)]
    selector: ModelSelector,
    operations: Vec<GenerationOperation>,
    reason: String,
}

#[derive(Deserialize)]
struct RetiredModel {
    #[serde(flatten)]
    selector: ModelSelector,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoModelCapabilities {
    #[serde(flatten)]
    selector: ModelSelector,
    pub modes: Vec<String>,
    pub input_kinds: Vec<String>,
    pub required_kind: Option<String>,
    pub max_images: Option<usize>,
    pub veo: Option<String>,
    pub reason: String,
}

impl VideoModelCapabilities {
    pub(crate) fn supports_mode(&self, mode: &str) -> bool {
        self.modes.iter().any(|value| value == mode)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PixverseRestriction {
    #[serde(flatten)]
    selector: ModelSelector,
    #[serde(default)]
    actions: Vec<String>,
    except_actions: Option<Vec<String>>,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelCapabilities {
    retired_models: Vec<RetiredModel>,
    restricted_operations: Vec<OperationRestriction>,
    video: Vec<VideoModelCapabilities>,
    pixverse: Vec<PixverseRestriction>,
}

static CAPABILITIES: LazyLock<ModelCapabilities> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/canvas-model-capabilities.json"))
        .expect("bundled canvas model capabilities")
});

pub(crate) fn operation_restriction(
    adapter: &str,
    model: &str,
    operation: GenerationOperation,
) -> Option<&'static str> {
    let id = model.trim().to_ascii_lowercase();
    retired_model_reason(adapter, &id).or_else(|| CAPABILITIES.restricted_operations.iter()
        .find(|rule| rule.operations.contains(&operation) && rule.selector.matches(adapter, &id))
        .map(|rule| rule.reason.as_str()))
}

pub(crate) fn retired_model_reason(adapter: &str, model: &str) -> Option<&'static str> {
    let id = model.trim().to_ascii_lowercase();
    CAPABILITIES.retired_models.iter().find(|rule| rule.selector.matches(adapter, &id))
        .map(|rule| rule.reason.as_str())
}

pub(crate) fn validate_operation(
    adapter: &str,
    model: &str,
    operation: GenerationOperation,
) -> BackendResult<()> {
    if let Some(reason) = operation_restriction(adapter, model, operation) {
        return Err(BackendError::validation(reason, json!({ "model": model, "operation": operation })));
    }
    Ok(())
}

pub(crate) fn video_capabilities(adapter: &str, model: &str) -> Option<&'static VideoModelCapabilities> {
    let id = model.trim().to_ascii_lowercase();
    CAPABILITIES.video.iter().find(|rule| rule.selector.matches(adapter, &id))
}

pub(crate) fn pixverse_action_restriction(model: &str, action: &str) -> Option<&'static str> {
    let id = model.trim().to_ascii_lowercase();
    CAPABILITIES.pixverse.iter()
        .find(|rule| rule.selector.matches("", &id) && (rule.actions.iter().any(|value| value == action)
            || rule.except_actions.as_ref().is_some_and(|values| values.iter().all(|value| value != action))))
        .map(|rule| rule.reason.as_str())
}
