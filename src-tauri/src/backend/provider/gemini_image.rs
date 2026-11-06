use base64::Engine as _;
use serde_json::{Value, json};

use super::{BackendError, BackendResult, ImageSource, ResolvedGeneration};
use crate::backend::model_schema::NANO_BANANA_21_RATIOS;

/// Konjac's documented native route preserves imageSize and thinkingConfig,
/// which cannot be expressed by its older OpenAI Images size-only contract.
pub(super) fn build_body(resolved: &ResolvedGeneration) -> BackendResult<Value> {
    if !resolved.videos.is_empty() || !resolved.audios.is_empty() || resolved.images.len() > 14 {
        return Err(BackendError::validation("此图片接口支持最多 14 张参考图片。视频请先选取参考帧，音频不受支持。", json!({"images": resolved.images.len(), "videos": resolved.videos.len(), "audios": resolved.audios.len()})));
    }
    let values = resolved.parameters.as_object().ok_or_else(|| BackendError::validation("图片参数必须为对象。", json!({})))?;
    let aspect = values.get("aspect_ratio").and_then(Value::as_str).unwrap_or("1:1");
    let resolution = values.get("resolution").and_then(Value::as_str).unwrap_or("1K");
    let thinking = values.get("thinking_level").and_then(Value::as_str).unwrap_or("medium");
    if !NANO_BANANA_21_RATIOS.contains(&aspect) || !matches!(resolution, "1K" | "2K" | "4K") || !matches!(thinking, "minimal" | "medium" | "high") {
        return Err(BackendError::validation("Nano Banana 2.1 的画幅、分辨率或思考强度无效。", json!({"aspectRatio": aspect, "imageSize": resolution, "thinkingLevel": thinking})));
    }
    let mut parts = Vec::new();
    for image in &resolved.images {
        let bytes = image.bytes.as_ref().ok_or_else(|| BackendError::validation("参考图片缺少本地字节。", image.archive()))?;
        parts.push(json!({"inlineData": {"mimeType": image.mime_type, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}}));
    }
    parts.push(json!({"text": resolved.rendered_prompt}));
    let body = json!({
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": aspect, "imageSize": resolution},
            "thinkingConfig": {"thinkingLevel": thinking, "includeThoughts": false}
        }
    });
    Ok(body)
}

pub(super) fn image_sources(value: &Value) -> Vec<ImageSource> {
    let mut sources = Vec::new();
    for candidate in value.get("candidates").and_then(Value::as_array).into_iter().flatten() {
        for part in candidate.pointer("/content/parts").and_then(Value::as_array).into_iter().flatten() {
            // Thought images are intermediate work, not deliverable results.
            if part.get("thought").and_then(Value::as_bool) == Some(true) { continue; }
            let Some(inline) = part.get("inlineData").or_else(|| part.get("inline_data")) else { continue; };
            let mime = inline.get("mimeType").or_else(|| inline.get("mime_type")).and_then(Value::as_str).unwrap_or_default();
            if mime.starts_with("image/") && let Some(data) = inline.get("data").and_then(Value::as_str).filter(|data| !data.is_empty()) {
                sources.push(ImageSource::Base64 {data: data.to_string(), layer: None});
            }
        }
    }
    sources
}
