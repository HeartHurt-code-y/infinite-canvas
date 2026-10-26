//! PixVerse gateway contract: images/IDs at the root, feature switches in metadata.
//! Source: https://doc.moyu.info/9563101m0.md
//!
//! 对父模块的接口面只有五个函数：[`prepare_pixverse_video_body`]（图片/视频/音频
//! 上传 + 提交体）、`build_pixverse_video_body`（纯请求体）、
//! [`parse_pixverse_video_task_id`] 与 [`parse_observation`]（响应解析）、
//! `ambiguous_submission_error`（模糊失败包装）。家族身份的判定不在本模块，
//! 见 `gateway_profile::GatewayProfile`。
use reqwest::multipart;
use serde_json::{Map, Value, json};
use url::Url;
use uuid::Uuid;

use crate::backend::error::{BackendError, BackendResult};
use crate::backend::storage::{GenerationLifecycleFact, TaskExecutionRecord};
use crate::backend::types::MediaType;

use super::{
    CapturedHttpResponse, GenerationObservation, ProviderRuntime, ResolvedGeneration,
    ResolvedMedia, ResolvedProviderContext, endpoint, ensure_request_encoding,
    insert_mapped_parameters, mapped_parameters, parse_video_observation, redact_request_value,
    require_success, sanitize_url, valid_sp25_task_id, video_prompt,
};

impl ProviderRuntime {
    pub(super) async fn prepare_pixverse_video_body(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        let model = task.remote_model_id_snapshot.as_deref().ok_or_else(|| {
            BackendError::validation("PixVerse 任务缺少模型 ID", json!({ "taskId": task.id }))
        })?;
        ensure_request_encoding(&resolved.operation_schema, "json")?;
        let mut images = Vec::with_capacity(resolved.images.len());
        for media in &resolved.images {
            images.push(
                self.upload_pixverse_reference(task, attempt_id, context, media)
                    .await?,
            );
        }
        let mut videos = Vec::with_capacity(resolved.videos.len());
        for media in &resolved.videos {
            videos.push(
                self.upload_pixverse_reference(task, attempt_id, context, media)
                    .await?,
            );
        }
        let mut audios = Vec::with_capacity(resolved.audios.len());
        for media in &resolved.audios {
            audios.push(
                self.upload_pixverse_reference(task, attempt_id, context, media)
                    .await?,
            );
        }
        build_body_with_media(model, resolved, &images, &videos, &audios)
    }

    async fn upload_pixverse_reference(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        media: &ResolvedMedia,
    ) -> BackendResult<String> {
        let is_image = media.media_type == MediaType::Image;
        if is_image && media.bytes.is_none() {
            return existing_reference(media);
        }
        let (path, field, id_field) = if is_image {
            ("/pixverse/openapi/v2/image/upload", "image", "img_id")
        } else {
            ("/pixverse/openapi/v2/media/upload", "file", "media_id")
        };
        // Use the stable media type, never a URL suffix (an Audio asset can have a .jpg URL).
        let media_type = match media.media_type {
            MediaType::Audio => "audio",
            MediaType::Video => "video",
            _ => "image",
        };
        let mut form = multipart::Form::new();
        if let Some(bytes) = &media.bytes {
            let part = multipart::Part::bytes(bytes.clone())
                .file_name(media.file_name.clone())
                .mime_str(&media.mime_type)?;
            form = form.part(field, part);
        } else {
            form = form.text("file_url", existing_reference(media)?);
        }
        if !is_image {
            form = form.text("media_type", media_type);
        }
        let url = upload_endpoint(&context.base_url, path)?;
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: "upload".into(),
                request: json!({
                    "providerConnectionId": context.provider_connection_id,
                    "adapterId": context.adapter_id, "credentialReference": context.api_key_ref,
                    "method": "POST", "url": sanitize_url(&url), "bodyType": "multipart",
                    "mediaType": media_type,
                    "fileUrl": media.remote_reference.as_deref().map(super::redact_url_string),
                    "file": { "field": field, "fileName": media.file_name,
                        "mimeType": media.mime_type, "byteSize": media.byte_size,
                        "sha256": media.sha256, "stableIdentity": media.stable_identity }
                }),
            },
        )?;
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("POST / phase=upload / taskId={}", task.id),
                self.client
                    .post(url)
                    .bearer_auth(&context.api_key)
                    .multipart(form),
            )
            .await?;
        parse_upload_id(&response, id_field)
    }
}

fn upload_endpoint(base_url: &str, path: &str) -> BackendResult<Url> {
    // /pixverse is a sibling of /v1. Preserve a self-hosted gateway prefix.
    let mut base = Url::parse(base_url)?;
    let base_path = base.path().trim_end_matches('/').to_string();
    if let Some(prefix) = base_path.strip_suffix("/v1") {
        base.set_path(prefix);
    }
    endpoint(base.as_str(), path)
}

fn existing_reference(media: &ResolvedMedia) -> BackendResult<String> {
    media
        .remote_reference
        .clone()
        .ok_or_else(|| BackendError::validation("PixVerse 素材需要先上传取得引用", media.archive()))
}

pub(super) fn build_pixverse_video_body(
    model: &str,
    resolved: &ResolvedGeneration,
    images: &[String],
) -> BackendResult<Value> {
    let videos = resolved
        .videos
        .iter()
        .map(existing_reference)
        .collect::<BackendResult<Vec<_>>>()?;
    let audios = resolved
        .audios
        .iter()
        .map(existing_reference)
        .collect::<BackendResult<Vec<_>>>()?;
    build_body_with_media(model, resolved, images, &videos, &audios)
}

fn build_body_with_media(
    model: &str,
    resolved: &ResolvedGeneration,
    images: &[String],
    videos: &[String],
    audios: &[String],
) -> BackendResult<Value> {
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    if images.len() != resolved.images.len()
        || videos.len() != resolved.videos.len()
        || audios.len() != resolved.audios.len()
    {
        return Err(BackendError::protocol(
            "PixVerse 素材上传结果数量不匹配",
            json!({}),
        ));
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    let prompt = video_prompt(resolved);
    let prompt = if prompt.trim().is_empty() {
        &resolved.rendered_prompt
    } else {
        &prompt
    };
    if !prompt.trim().is_empty() {
        body.insert("prompt".into(), json!(prompt));
    }
    if !images.is_empty() {
        let mut ordered = resolved.images.iter().zip(images).collect::<Vec<_>>();
        ordered.sort_by_key(|(media, _)| match media.role.as_str() {
            "first_frame" => 0,
            "last_frame" => 2,
            _ => 1,
        });
        body.insert(
            "images".into(),
            json!(ordered.iter().map(|(_, id)| id).collect::<Vec<_>>()),
        );
    }
    // Preserve the exact explicit metadata object. Nested fields take precedence over
    // schema defaults; metadata.duration is also documented to override root duration.
    let explicit_metadata = resolved.parameters.get("metadata");
    if explicit_metadata.is_some_and(|value| !value.is_object()) {
        return Err(BackendError::validation(
            "PixVerse metadata 必须是 JSON 对象",
            json!({}),
        ));
    }
    let mut parameters = mapped_parameters(resolved, "root")?;
    parameters
        .retain(|parameter| !(parameter.container == "root" && parameter.field == "metadata"));
    // Field locations remain protocol facts even when C1 or an old catalog does
    // not declare a switch in its UI capabilities.
    for parameter in &mut parameters {
        if matches!(
            parameter.field.as_str(),
            "action"
                | "quality"
                | "generate_audio_switch"
                | "generate_multi_clip_switch"
                | "sound_effect_switch"
                | "sound_effect_content"
                | "lip_sync_switch"
                | "lip_sync_tts_content"
                | "lip_sync_tts_speaker_id"
                | "template_id"
                | "video_media_id"
                | "audio_media_id"
                | "source_video_id"
                | "restyle_id"
        ) {
            parameter.container = "metadata".into();
        }
    }
    insert_mapped_parameters(&mut body, "metadata", parameters)?;
    if let Some(metadata) = explicit_metadata.and_then(Value::as_object) {
        body.entry("metadata")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| BackendError::validation("PixVerse metadata 字段冲突", json!({})))?
            .extend(metadata.clone());
    }
    let image_count = body
        .get("images")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let metadata = body
        .entry("metadata")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| BackendError::validation("PixVerse metadata 字段冲突", json!({})))?;
    metadata.entry("quality").or_insert_with(|| json!("540p"));
    for field in [
        "video_media_id",
        "audio_media_id",
        "source_video_id",
        "restyle_id",
    ] {
        if let Some(Value::String(id)) = metadata.get(field) {
            let encoded = numeric_id(id);
            metadata.insert(field.into(), encoded);
        }
    }
    for (field, references) in [("video_media_id", videos), ("audio_media_id", audios)] {
        if !references.is_empty() {
            // The provider decides media-count limits. Preserve every reference; for
            // multiple inputs send an array in the same field rather than dropping any.
            let ids = references
                .iter()
                .map(|id| numeric_id(id))
                .collect::<Vec<_>>();
            let value = if ids.len() == 1 {
                ids[0].clone()
            } else {
                json!(ids)
            };
            let value = match metadata.get(field) {
                Some(explicit) if explicit != &value => json!([explicit, value]),
                _ => value,
            };
            metadata.insert(field.into(), value);
        }
    }
    if !metadata.contains_key("action") {
        if resolved
            .images
            .iter()
            .any(|media| media.role == "last_frame")
        {
            metadata.insert("action".into(), json!("transition"));
        } else if image_count > 1
            || metadata
                .get("image_references")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
        {
            metadata.insert("action".into(), json!("fusion"));
        }
    }
    if !metadata.contains_key("duration") && !body.contains_key("duration") {
        body.insert("duration".into(), json!(5));
    }
    Ok(Value::Object(body))
}

fn numeric_id(id: &str) -> Value {
    id.parse::<u64>().map_or_else(|_| json!(id), |id| json!(id))
}

fn parse_upload_id(response: &CapturedHttpResponse, id_field: &str) -> BackendResult<String> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    if value.get("ErrCode").and_then(Value::as_i64) != Some(0) {
        return Err(BackendError::protocol(
            format!(
                "PixVerse 素材上传失败：{}",
                value
                    .get("ErrMsg")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            ),
            json!({ "response": redact_request_value(&value) }),
        ));
    }
    let id = match value
        .get("Resp")
        .and_then(|response| response.get(id_field))
    {
        Some(Value::Number(number)) if number.as_u64().is_some_and(|id| id > 0) => {
            number.to_string()
        }
        Some(Value::String(id)) => id.clone(),
        _ => {
            return Err(BackendError::protocol(
                format!("PixVerse 上传响应缺少有效 {id_field}"),
                json!({}),
            ));
        }
    };
    if id.len() > 128
        || !id.bytes().all(|byte| byte.is_ascii_digit())
        || !id.bytes().any(|byte| byte != b'0')
    {
        return Err(BackendError::protocol(
            format!("PixVerse 上传响应 {id_field} 无效"),
            json!({}),
        ));
    }
    Ok(id)
}

pub(super) fn ambiguous_submission_error(error: BackendError) -> BackendError {
    if matches!(
        error,
        BackendError::Validation { .. } | BackendError::Url(_)
    ) {
        return error;
    }
    BackendError::protocol(
        "PixVerse 提交结果无法确认，平台可能已受理；请先核对远程任务，避免重复扣费",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

pub(super) fn parse_pixverse_video_task_id(
    response: &CapturedHttpResponse,
) -> BackendResult<String> {
    let result = (|| {
        require_success(response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let task_id = payload
            .get("task_id")
            .and_then(Value::as_str)
            .filter(|id| valid_sp25_task_id(id))
            .ok_or_else(|| {
                BackendError::protocol("PixVerse 提交响应缺少有效 task_id", json!({}))
            })?;
        if payload
            .get("id")
            .is_some_and(|id| id.as_str() != Some(task_id))
        {
            return Err(BackendError::protocol(
                "PixVerse 提交响应的 id 与 task_id 不一致",
                json!({}),
            ));
        }
        // HTTP success + a nonempty task_id is accepted even with status="".
        Ok(task_id.to_string())
    })();
    result.map_err(|error| {
        if response.is_success() || response.status >= 500 {
            ambiguous_submission_error(error)
        } else {
            error
        }
    })
}

pub(super) fn parse_observation(
    response: &CapturedHttpResponse,
    expected_task_id: &str,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    for field in ["/data/task_id", "/data/id", "/task_id", "/id"] {
        if value
            .pointer(field)
            .is_some_and(|id| id.as_str() != Some(expected_task_id))
        {
            return Err(BackendError::protocol(
                "PixVerse 查询响应返回了不匹配的任务身份",
                json!({ "field": field }),
            ));
        }
    }
    // data.status is authoritative. Never let top-level query status/code override it.
    let task_data = value
        .get("data")
        .filter(|data| data.get("status").is_some())
        .unwrap_or(&value);
    let mut observation = parse_video_observation(&CapturedHttpResponse {
        call_id: response.call_id.clone(),
        status: response.status,
        headers: response.headers.clone(),
        body: task_data.to_string(),
    })?;
    observation.progress = observation
        .progress
        .or_else(|| value.get("progress").and_then(super::parse_progress));
    Ok(observation)
}
