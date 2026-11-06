//! Seedance task constraints and model-facing references. UI defaults alone cannot
//! protect restored tasks or non-UI callers. The resolved archive records these values.
use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
use serde_json::json;

use super::{BackendError, BackendResult, CompiledContentItem, GatewayProfile, MediaType, ResolvedGeneration, VideoTaskType,
    is_seedance_25_video_model, seedance_reference_limits, seedance_video_task_type, video_prompt};

fn uses_task_contract(model: &str) -> bool {
    is_seedance_25_video_model(model) && seedance_reference_limits(model).is_some()
}

/// Moyu draft+edit rejects the documented -1 with an explicit `edit` hint,
/// while the same source, prompt and -1 succeed with `auto` (2026-11-06).
/// Keep the local edit intent and its prompt; adapt only this gateway wire hint.
pub(super) fn wire_task_type(resolved: &ResolvedGeneration) -> &'static str {
    let mode = seedance_video_task_type(resolved.video_task_type, &resolved.parameters);
    if mode == VideoTaskType::Edit
        && resolved.parameters["draft"].as_bool() == Some(true)
        && GatewayProfile::from_operation_schema(&resolved.operation_schema) == Some(GatewayProfile::SeedanceDraft) {
        "auto"
    } else { mode.omni_reference_task_type() }
}

pub(crate) fn normalize_task(model: &str, resolved: &mut ResolvedGeneration) -> BackendResult<()> {
    if !uses_task_contract(model) || resolved.parameters.get("draft_task_id").is_some() { return Ok(()); }
    let mode = seedance_video_task_type(resolved.video_task_type, &resolved.parameters);
    let frame = resolved.images.iter().any(|media| matches!(media.role.as_str(), "first_frame" | "last_frame"));
    resolved.video_task_type.get_or_insert(mode);
    let automatic_video = !resolved.videos.is_empty() && mode == VideoTaskType::Auto;
    if !frame && resolved.operation_schema.pointer("/parameters/omni_reference_task_type").is_some() {
        resolved.parameters["omni_reference_task_type"] = json!(wire_task_type(resolved));
    }
    if matches!(mode, VideoTaskType::Edit | VideoTaskType::Extend) && resolved.videos.is_empty() {
        return Err(BackendError::validation("请先连接要编辑或延长的视频。", json!({"videoTaskType": mode})));
    }
    if frame || automatic_video || matches!(mode, VideoTaskType::Edit | VideoTaskType::Extend) {
        resolved.parameters["ratio"] = json!("adaptive");
    }
    if automatic_video || mode == VideoTaskType::Edit {
        resolved.parameters["duration"] = json!(-1);
    }
    Ok(())
}

fn model_reference(media_type: MediaType, position: u32) -> String {
    let kind = match media_type { MediaType::Image => "image", MediaType::Video => "video", MediaType::Audio => "audio", MediaType::Text => "text" };
    let label = REFERENCE_ALIASES[kind].first().expect("reference display label");
    format!("@{label}{position}")
}

static REFERENCE_ALIASES: LazyLock<BTreeMap<String, Vec<String>>> = LazyLock::new(||
    serde_json::from_str(include_str!("../../../../shared/prompt-reference-aliases.json")).expect("bundled reference aliases"));

static ENGLISH_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    let mut aliases = REFERENCE_ALIASES.values().flatten().filter(|alias| alias.is_ascii()).map(|alias|
        if alias.ends_with(' ') { format!("{}[ \\t]+", regex::escape(alias.trim_end())) } else { regex::escape(alias) }
    ).collect::<Vec<_>>();
    aliases.sort_by_key(|alias| std::cmp::Reverse(alias.len()));
    Regex::new(&format!(r"(?i)(^|[^a-z0-9_@./\\-])@?({})([1-9][0-9]*)", aliases.join("|"))).expect("reference expression")
});

/// Handle common pasted aliases even when AutoLink is off. Filenames and URLs
/// are not aliases; an unavailable numbered reference must never silently drift.
fn text_references(text: &str, resolved: &ResolvedGeneration) -> BackendResult<String> {
    let mut rendered = String::new();
    let mut offset = 0;
    for capture in ENGLISH_REFERENCE.captures_iter(text) {
        let matched = capture.get(0).expect("whole match");
        if text[matched.end()..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || "_.@/\\-".contains(c)) { continue; }
        let kind = REFERENCE_ALIASES.iter().find(|(_, aliases)| aliases.iter().any(|alias| alias.trim_end().eq_ignore_ascii_case(capture[2].trim_end()))).map(|(kind, _)| kind.as_str());
        let media_type = match kind { Some("video") => MediaType::Video, Some("image") => MediaType::Image, _ => MediaType::Audio };
        let position = capture[3].parse::<u32>().map_err(|_| BackendError::validation("素材引用编号无效", json!({"reference": &capture[0]})))?;
        if resolved.media(media_type, position).is_none() {
            return Err(BackendError::validation("提示词引用了未连接的素材，请检查视频 / 图片 / 音频编号。", json!({"reference": &capture[0], "typePosition": position})));
        }
        rendered.push_str(&text[offset..matched.start()]);
        rendered.push_str(&capture[1]);
        rendered.push_str(&model_reference(media_type, position));
        offset = matched.end();
    }
    rendered.push_str(&text[offset..]);
    Ok(rendered)
}

pub(super) fn prompt(model: &str, resolved: &ResolvedGeneration) -> BackendResult<String> {
    if seedance_reference_limits(model).is_none() { return Ok(video_prompt(resolved)); }
    let mut prompt = String::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) => prompt.push_str(&text_references(text, resolved)?),
            CompiledContentItem::Media { media_type, type_position } => {
                prompt.push_str(&model_reference(*media_type, *type_position));
            }
        }
    }
    Ok(prompt)
}

/// This gateway envelope reports a request-conversion rejection before upstream dispatch.
pub(super) fn rejected_channel_asset(payload: &serde_json::Value) -> Option<(u64, &str)> {
    if payload["code"].as_str() != Some("build_request_failed")
        || !payload.get("data").is_some_and(serde_json::Value::is_null)
        || payload.get("task_id").is_some()
        || payload.get("id").is_some()
    {
        return None;
    }
    let message = payload["message"].as_str()?
        .strip_prefix("convert request payload failed: asset ref: not found for channel ")?;
    let (channel, asset_id) = message.split_once(": ")?;
    Some((channel.parse().ok()?, asset_id.trim()))
}

pub(crate) fn failure_message(kind: &str, status: &str, failure: &serde_json::Value, parameters: Option<&serde_json::Value>) -> String {
    let code = failure.pointer("/upstreamError/code").or_else(|| failure.pointer("/error/code")).and_then(serde_json::Value::as_str).unwrap_or_default();
    let reason = failure.get("failReason").or_else(|| failure.pointer("/upstreamError/message")).and_then(serde_json::Value::as_str).unwrap_or_default();
    let follows_source = parameters.is_some_and(|p| p["ratio"].as_str() == Some("adaptive") && p["duration"].as_i64() == Some(-1));
    if code == "NotFound.asset_id"
        || ["failReason", "upstreamError", "error"].iter()
            .filter_map(|key| failure.get(*key))
            .any(super::super::asset_library::asset_lookup_missing)
    {
        return "平台已返回任务号，随后报告生成渠道无法读取云端素材。需保留审核身份时，请用任务号向供应商核对该渠道的素材映射。".to_string();
    }
    match code {
        "OutputVideoSensitiveContentDetected" => "供应商生成后的视频未通过上游内容审核（OutputVideoSensitiveContentDetected）。这不是本地参数校验失败；应用不会自动重发，结算请以供应商记录为准。".to_string(),
        "InvalidParameter.TaskTypeConstraint" if follows_source && (reason.contains("`duration` must be -1") || reason.contains("`ratio` must be `adaptive`")) => "本次已提交跟随原片的画幅与时长（adaptive / -1），上游仍返回参数冲突。请凭任务 ID 核对供应商的参数转发；实际请求与原始回执已保留，应用未自动重发。".to_string(),
        "InvalidParameter.TaskTypeConstraint" => "上游识别的任务类型与参数不兼容：视频编辑须跟随原片画幅与时长，视频延长须跟随原片画幅。请核对任务模式与提示词，完整上游错误已保留。".to_string(),
        "InvalidParameter.TaskTypeMismatch" => "所选任务类型与上游从提示词识别的任务不一致。请核对「参考生视频 / 视频编辑 / 视频延长」与提示词意图，完整上游错误已保留。".to_string(),
        _ if status == "EXPIRED" => format!("远端{kind}任务已过期，请查看原任务详情并确认结算状态后再决定是否重新生成。"),
        _ => format!("远端{kind}任务失败，请展开完整报错查看原因。"),
    }
}
