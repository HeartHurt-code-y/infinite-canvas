use std::collections::HashMap;
use serde_json::{Map, Value, json};
use super::{BackendError, BackendResult, CompiledContentItem, MediaType, ResolvedGeneration, ResolvedMedia};

/// Flat creation fields and explicit metadata slots, not Seedance's content array.
/// https://doc.moyu.info/9606564m0.md
pub(super) fn build_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    let values = resolved.parameters.as_object().ok_or_else(|| invalid("视频参数必须为对象。"))?;
    let duration = values.get("duration").map_or(Some(10), Value::as_i64)
        .filter(|value| (3..=30).contains(value)).ok_or_else(|| invalid("可灵 4.0 时长须为 3–30 秒的整数。"))?;
    let resolution = values.get("resolution").and_then(Value::as_str).unwrap_or("1080p");
    let aspect = values.get("aspect_ratio").and_then(Value::as_str).unwrap_or("auto");
    if !matches!(resolution, "720p" | "1080p") { return Err(invalid("此可灵 4.0 接口只支持 720P 和 1080P。")); }
    if !matches!(aspect, "auto" | "16:9" | "9:16" | "1:1" | "21:9") { return Err(invalid("可灵 4.0 的画幅无效，请重新选择。")); }
    if !resolved.audios.is_empty() { return Err(invalid("此可灵 4.0 接口不接受音频文件；音色参考请填写可灵音色 ID。")); }
    let elements = ids(values.get("element_ids"), 7, "主体")?;
    let voices = ids(values.get("voice_ids"), 3, "音色")?;
    if resolved.images.len() > 10 || resolved.videos.len() > 5
        || resolved.images.len() + resolved.videos.len() + elements.len() + voices.len() > 15 {
        return Err(invalid("可灵 4.0 最多接受 10 张图、5 段视频、7 个主体和 3 个音色，所有参考合计不超过 15 项。"));
    }
    let first = unique_role(&resolved.images, "first_frame", "首帧")?;
    let last = unique_role(&resolved.images, "last_frame", "尾帧")?;
    let base = unique_role(&resolved.videos, "base_video", "待编辑视频")?;
    let middle = resolved.images.iter().filter(|image| image.role == "middle_frame").collect::<Vec<_>>();
    let references = resolved.images.iter().filter(|image| image.role == "reference_image").collect::<Vec<_>>();
    if resolved.images.iter().any(|image| !matches!(image.role.as_str(), "first_frame" | "middle_frame" | "last_frame" | "reference_image"))
        || resolved.videos.iter().any(|video| !matches!(video.role.as_str(), "reference_video" | "base_video")) {
        return Err(invalid("可灵 4.0 的素材角色无效，请重新指定素材用途。"));
    }
    if first.is_none() && (last.is_some() || !middle.is_empty()) { return Err(invalid("尾帧和中间帧必须同时连接首帧，否则上游不会使用这些图片。")); }
    if !elements.is_empty() && references.is_empty() && resolved.videos.is_empty() && voices.is_empty() {
        return Err(invalid("主体 ID 需要与参考图、参考视频、待编辑视频或音色一起使用。"));
    }
    let mut total_seconds = 0.0;
    for video in &resolved.videos {
        if let Some(seconds) = video.duration_seconds {
            if !(3.0..=30.0).contains(&seconds) { return Err(invalid("可灵 4.0 的输入视频须为 3–30 秒，全部输入视频合计不超过 30 秒。")); }
            total_seconds += seconds;
        }
        let extension = video.file_name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
        if matches!(extension.as_str(), "mov" | "webm" | "mkv" | "avi") {
            return Err(invalid("此网关的可灵 4.0 视频输入请使用 MP4（H.264），先转换视频格式再生成。"));
        }
    }
    if total_seconds > 30.0 { return Err(invalid("可灵 4.0 的输入视频总时长不能超过 30 秒。")); }
    let mut metadata = Map::new();
    let mut tokens = HashMap::new();
    // Gateway image numbering: first, middle, last, then reference images.
    for (index, image) in first.into_iter().chain(middle.iter().copied()).chain(last).chain(references.iter().copied()).enumerate() {
        tokens.insert((MediaType::Image, image.type_position), format!("@image_{}", index + 1));
    }
    if let Some(image) = first { metadata.insert("first_frame".into(), reference(image)?); }
    if let Some(image) = last { metadata.insert("last_frame".into(), reference(image)?); }
    if !middle.is_empty() { metadata.insert("middle_frames".into(), Value::Array(middle.into_iter().map(reference).collect::<BackendResult<_>>()?)); }
    if !references.is_empty() { metadata.insert("refer_images".into(), Value::Array(references.into_iter().map(reference).collect::<BackendResult<_>>()?)); }
    let videos = resolved.videos.iter().filter(|video| video.role == "reference_video").collect::<Vec<_>>();
    for (index, video) in videos.iter().enumerate() { tokens.insert((MediaType::Video, video.type_position), format!("@video_{}", index + 1)); }
    if !videos.is_empty() { metadata.insert("videos".into(), Value::Array(videos.into_iter().map(reference).collect::<BackendResult<_>>()?)); }
    if let Some(video) = base {
        metadata.insert("base_video".into(), reference(video)?);
        tokens.insert((MediaType::Video, video.type_position), "待编辑视频".to_string());
    }
    if !elements.is_empty() { metadata.insert("element_ids".into(), json!(elements)); }
    if !voices.is_empty() { metadata.insert("voice_ids".into(), json!(voices)); }
    // Live upstream rejects multi_shot=false (code 1201). Leave shot planning
    // to the model/prompt instead of exposing a switch with an invalid off state.
    let prompt = if resolved.content.is_empty() { resolved.rendered_prompt.clone() } else {
        let mut prompt = String::new();
        for item in &resolved.content {
            match item {
                CompiledContentItem::Text(text) => prompt.push_str(text),
                CompiledContentItem::Media { media_type, type_position } => {
                    let token = tokens.get(&(*media_type, *type_position)).ok_or_else(|| invalid("提示词引用的素材没有对应的可灵输入槽位。"))?;
                    prompt.push_str(token);
                }
            }
        }
        prompt
    };
    let english = prompt.chars().filter(char::is_ascii).count();
    let other = prompt.chars().count() - english;
    if prompt.trim().is_empty() || english as f64 / 26_000.0 + other as f64 / 11_000.0 > 1.0 {
        return Err(invalid("请填写有效提示词；纯英文最多 26000 字符，其他语言最多 11000 字符，混合内容按比例计算。"));
    }
    // Only supported creation fields; never forward stale audio/seed/cfg settings.
    let mut body = json!({"model": model, "prompt": prompt, "duration": duration, "resolution": resolution, "watermark": false});
    if aspect != "auto" { body["aspect_ratio"] = json!(aspect); }
    if !metadata.is_empty() { body["metadata"] = Value::Object(metadata); }
    Ok(body)
}

fn invalid(message: &str) -> BackendError { BackendError::validation(message, json!({})) }

fn unique_role<'a>(media: &'a [ResolvedMedia], role: &str, label: &str) -> BackendResult<Option<&'a ResolvedMedia>> {
    let mut matches = media.iter().filter(|item| item.role == role);
    let first = matches.next();
    if matches.next().is_some() { return Err(invalid(&format!("可灵 4.0 只能指定一个{label}。"))); }
    Ok(first)
}

fn reference(media: &ResolvedMedia) -> BackendResult<Value> {
    let url = media.remote_reference.as_deref().filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .ok_or_else(|| invalid("可灵素材需要可公开读取的图片或 MP4 链接，请先完成素材上传。"))?;
    Ok(json!(url))
}

fn ids(value: Option<&Value>, limit: usize, label: &str) -> BackendResult<Vec<String>> {
    let result = match value {
        None => Vec::new(),
        Some(Value::String(text)) => text.split(|c: char| c == ',' || c == '，' || c.is_whitespace())
            .filter(|item| !item.is_empty()).map(str::to_string).collect(),
        Some(Value::Array(values)) => values.iter().map(|value| value.as_str().filter(|id| !id.trim().is_empty())
            .map(|id| id.trim().to_string()).ok_or_else(|| invalid("素材 ID 须为非空文本。"))).collect::<BackendResult<Vec<_>>>()?,
        _ => return Err(invalid("素材 ID 格式无效，请用逗号或换行分隔。")),
    };
    if result.len() > limit { return Err(invalid(&format!("可灵 4.0 最多引用 {limit} 个{label}。"))); }
    Ok(result)
}
