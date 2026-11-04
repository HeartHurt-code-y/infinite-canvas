//! LibTV's native multi_shot/multi_prompt contract. Local segment ranges are never
//! sent upstream; material identities are resolved once by the ordinary resolver.
use serde::Deserialize;
use serde_json::{Value, json};
use super::error::{BackendError, BackendResult};

pub const LOCAL_KEY: &str = "__canvas_storyboard";

#[derive(Deserialize)]
struct ShotRange { start: usize, end: usize, duration: u32 }

fn supported(model: &str) -> bool {
    matches!(model.to_ascii_lowercase().as_str(),
        "kling-v3" | "kling-v3.0" | "kling-v3-omni" | "kling-v3.0-omni" |
        "kling-video-v3" | "kling-video-v3.0" | "kling-video-v3-omni" | "kling-video-v3.0-omni" |
        "kling-3.0" | "kling-3.0-omni")
}

fn ranges(parameters: &Value, model: &str, segment_count: usize) -> BackendResult<Option<Vec<ShotRange>>> {
    let Some(value) = parameters.get(LOCAL_KEY) else { return Ok(None); };
    if !supported(model) {
        return Err(BackendError::validation("当前模型不支持智能分镜，请切回可灵 3.0 或关闭智能分镜", json!({"model": model})));
    }
    let ranges: Vec<ShotRange> = serde_json::from_value(value.clone()).map_err(|_| BackendError::validation("智能分镜数据格式无效", json!({})))?;
    let duration = ["duration", "duration_seconds", "seconds"].iter().find_map(|key| parameters.get(key))
        .and_then(|value| value.as_u64().or_else(|| value.as_str().and_then(|value| value.parse().ok())));
    let mut cursor = 0;
    let valid = (1..=6).contains(&ranges.len()) && ranges.iter().all(|shot| {
        let valid = shot.start == cursor && shot.end > shot.start && shot.end <= segment_count && shot.duration >= 1;
        cursor = shot.end;
        valid
    }) && cursor == segment_count;
    let sum = ranges.iter().map(|shot| u64::from(shot.duration)).sum::<u64>();
    if !valid || duration != Some(sum) || !(3..=15).contains(&sum) {
        return Err(BackendError::validation("分镜需要 1–6 个镜头、每镜至少 1 秒，总时长必须与视频时长一致（3–15 秒）", json!({"duration": duration, "shotSeconds": sum})));
    }
    Ok(Some(ranges))
}

/// Validate before creating a task or doing any upload/provider request.
pub fn validate(parameters: &Value, model: &str, segment_count: usize) -> BackendResult<()> {
    ranges(parameters, model, segment_count).map(|_| ())
}

pub fn compile(parameters: &Value, model: &str, rendered_segments: &[String], has_video: bool) -> BackendResult<Value> {
    let Some(ranges) = ranges(parameters, model, rendered_segments.len())? else { return Ok(parameters.clone()); };
    if has_video {
        return Err(BackendError::validation("自定义智能分镜暂不支持参考视频，请移除视频参考或关闭分镜", json!({"model": model})));
    }
    let mut prompts = Vec::with_capacity(ranges.len());
    for (index, shot) in ranges.iter().enumerate() {
        let prompt = rendered_segments[shot.start..shot.end].concat();
        if prompt.trim().is_empty() || prompt.chars().count() > 512 {
            return Err(BackendError::validation("每个镜头需要 1–512 字的提示词（含展开后的运镜与素材名称）", json!({"shot": index + 1, "characters": prompt.chars().count()})));
        }
        prompts.push(json!({"index": index + 1, "prompt": prompt, "duration": shot.duration.to_string()}));
    }
    let mut parameters = parameters.clone();
    let object = parameters.as_object_mut().ok_or_else(|| BackendError::validation("视频参数格式无效", json!({})))?;
    object.remove(LOCAL_KEY);
    object.insert("multi_shot".into(), json!(true));
    object.insert("shot_type".into(), json!("customize"));
    object.insert("multi_prompt".into(), Value::Array(prompts));
    Ok(parameters)
}
