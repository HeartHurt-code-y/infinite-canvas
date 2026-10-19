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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::backend::credentials::CredentialStore;
    use crate::backend::model_schema::default_model_schema;
    use crate::backend::provider::{CompiledContentItem, GenerationSubmission, ResolvedMedia};
    use crate::backend::storage::{GenerationTaskLifecycle, NewTask, Storage};
    use crate::backend::types::{
        GenerationOperation, MediaType, UpsertProviderConnectionCommand, VideoTaskType,
    };
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        time::{Duration, Instant},
    };

    fn generation(parameters: Value) -> ResolvedGeneration {
        ResolvedGeneration {
            rendered_prompt: "猫咪伸懒腰".into(),
            content: vec![CompiledContentItem::Text("猫咪伸懒腰".into())],
            images: vec![],
            videos: vec![],
            audios: vec![],
            parameters,
            video_task_type: Some(VideoTaskType::Auto),
            operation_schema: default_model_schema(
                "PixVerse-V6",
                &[GenerationOperation::VideoGeneration],
            )["video_generation"]
                .clone(),
        }
    }

    fn image(reference: Option<&str>, bytes: Option<Vec<u8>>) -> ResolvedMedia {
        ResolvedMedia {
            media_type: MediaType::Image,
            type_position: 1,
            role: "reference_image".into(),
            display_name: "人物图".into(),
            stable_identity: json!({ "kind": "local_file", "path": "portrait.png" }),
            mime_type: "image/png".into(),
            byte_size: 12,
            duration_seconds: None,
            sha256: "fixture".into(),
            file_name: "portrait.png".into(),
            bytes,
            remote_reference: reference.map(ToOwned::to_owned),
            prompt_segment_index: None,
            content_index: Some(1),
        }
    }

    fn response(status: u16, body: Value) -> CapturedHttpResponse {
        CapturedHttpResponse {
            call_id: "fixture".into(),
            status,
            headers: json!({}),
            body: body.to_string(),
        }
    }

    #[test]
    fn pixverse_text_fields_and_explicit_metadata_are_preserved() {
        let request = generation(json!({
            "aspect_ratio": "21:9", "duration": 15, "seed": 10, "quality": "540p",
            "generate_audio_switch": false, "generate_multi_clip_switch": true,
            "metadata": { "quality": "1080p", "generate_audio_switch": true, "duration": 8, "future_switch": true },
            "future_root": "keep"
        }));
        let body = build_pixverse_video_body("PixVerse-V6", &request, &[]).unwrap();
        assert_eq!(body["aspect_ratio"], "21:9");
        assert_eq!(body["duration"], 15);
        assert_eq!(body["seed"], 10);
        assert_eq!(body["metadata"]["duration"], 8);
        assert_eq!(body["metadata"]["quality"], "1080p");
        assert_eq!(body["metadata"]["generate_audio_switch"], true);
        assert_eq!(body["metadata"]["generate_multi_clip_switch"], true);
        assert_eq!(body["metadata"]["future_switch"], true);
        assert_eq!(body["future_root"], "keep");
        assert!(body.get("images").is_none());
        assert!(body.get("content").is_none());
        assert!(body["metadata"].get("action").is_none());
    }

    #[test]
    fn pixverse_images_have_explicit_duration_and_preserve_template_only_requests() {
        let mut request = generation(json!({ "template_id": 100023 }));
        request.rendered_prompt.clear();
        request.content.clear();
        request
            .images
            .push(image(Some("https://example.com/image.png"), None));
        let body = build_pixverse_video_body("PixVerse-C1", &request, &["4929800001234567".into()])
            .unwrap();
        assert_eq!(body["images"], json!(["4929800001234567"]));
        assert_eq!(body["duration"], 5);
        assert_eq!(body["metadata"]["template_id"], 100023);
        assert!(body.get("prompt").is_none());
        request.parameters = json!({ "metadata": { "duration": 7 } });
        let body = build_pixverse_video_body("PixVerse-V6", &request, &["4929800001234567".into()])
            .unwrap();
        assert!(body.get("duration").is_none());
        assert_eq!(body["metadata"]["duration"], 7);
    }

    #[test]
    fn pixverse_c1_explicit_metadata_switches_do_not_depend_on_ui_capabilities() {
        let mut request = generation(json!({ "generate_multi_clip_switch": true,
            "sound_effect_switch": true, "sound_effect_content": "风声", "lip_sync_switch": true,
            "lip_sync_tts_content": "你好", "lip_sync_tts_speaker_id": "speaker-1" }));
        request.operation_schema = default_model_schema(
            "PixVerse-C1",
            &[GenerationOperation::VideoGeneration],
        )["video_generation"]
            .clone();
        let body = build_pixverse_video_body("PixVerse-C1", &request, &[]).unwrap();
        for (field, value) in request.parameters.as_object().unwrap() {
            assert_eq!(body["metadata"].get(field), Some(value));
            assert!(body.get(field).is_none());
        }
    }

    #[test]
    fn pixverse_three_images_and_audio_reach_request_compilation() {
        let mut request = generation(json!({
            "duration": 8, "quality": "720p",
            "metadata": { "audio_media_id": 429048496816171_u64 }
        }));
        for id in ["11", "12", "13"] {
            request.images.push(image(Some(id), None));
        }
        let mut audio = image(Some("429048496816171"), None);
        audio.media_type = MediaType::Audio;
        audio.role = "reference_audio".into();
        audio.file_name = "周敏之教授.wav".into();
        audio.mime_type = "audio/wav".into();
        request.audios.push(audio);
        let body = build_pixverse_video_body(
            "PixVerse-V6",
            &request,
            &["11".into(), "12".into(), "13".into()],
        )
        .expect("connected audio must be encoded and left to the provider to judge");
        assert_eq!(body["images"], json!(["11", "12", "13"]));
        assert_eq!(body["metadata"]["audio_media_id"], 429048496816171_u64);
        assert_eq!(body["metadata"]["action"], "fusion");
    }

    #[test]
    fn pixverse_encoding_preserves_tail_frames_and_explicit_image_inputs() {
        let mut request = generation(json!({ "images": ["2"] }));
        request
            .images
            .push(image(Some("https://example.com/image.png"), None));
        assert!(build_pixverse_video_body("PixVerse-V6", &request, &["1".into()]).is_err());
        request.parameters = json!({});
        request.images[0].role = "last_frame".into();
        let body = build_pixverse_video_body("PixVerse-V6", &request, &["1".into()]).unwrap();
        assert_eq!(body["metadata"]["action"], "transition");
        assert_eq!(body["images"], json!(["1"]));
        request.images.clear();
        request.parameters =
            json!({ "images": ["4929800001234567"], "metadata": { "action": "fusion" } });
        let body = build_pixverse_video_body("PixVerse-V6", &request, &[]).unwrap();
        assert_eq!(body["images"][0], "4929800001234567");
        assert_eq!(body["metadata"]["action"], "fusion");
    }

    #[test]
    fn pixverse_upload_preserves_large_ids_and_reports_platform_errors() {
        let payload: Value =
            serde_json::from_str(r#"{"ErrCode":0,"Resp":{"img_id":18446744073709551615}}"#)
                .unwrap();
        assert_eq!(
            parse_upload_id(&response(200, payload), "img_id").unwrap(),
            "18446744073709551615"
        );
        for payload in [
            json!({ "ErrCode": 400017, "ErrMsg": "invalid image" }),
            json!({ "ErrCode": 0, "Resp": { "img_id": 0 } }),
        ] {
            assert!(parse_upload_id(&response(200, payload), "img_id").is_err());
        }
    }

    #[test]
    fn pixverse_submission_accepts_empty_status_and_protects_ambiguous_responses() {
        assert_eq!(
            parse_pixverse_video_task_id(&response(
                200,
                json!({ "id": "4929809973433869", "task_id": "4929809973433869", "status": "" })
            ))
            .unwrap(),
            "4929809973433869"
        );
        for payload in [
            json!({ "status": "" }),
            json!({ "id": "other", "task_id": "4929809973433869" }),
        ] {
            let error = parse_pixverse_video_task_id(&response(200, payload)).unwrap_err();
            assert_eq!(
                error.runtime_record()["details"]["ambiguousPaidSubmission"],
                true
            );
        }
    }

    #[test]
    fn pixverse_observation_preserves_progress_failure_and_task_identity() {
        let observed = parse_observation(
            &response(
                200,
                json!({
                    "id": "1", "task_id": "1", "status": "success", "progress": "100%",
                    "data": { "status": "SUCCESS", "result_url": "https://example.com/result.mp4" }
                }),
            ),
            "1",
        )
        .unwrap();
        assert_eq!(observed.remote_status, "SUCCESS");
        assert_eq!(observed.progress, Some(100.0));
        assert_eq!(
            observed.video_url.as_deref(),
            Some("https://example.com/result.mp4")
        );
        let observed = parse_observation(
            &response(
                200,
                json!({ "task_id": "1", "status": "failure", "fail_reason": "moderation failed" }),
            ),
            "1",
        )
        .unwrap();
        assert_eq!(observed.failure.unwrap()["failReason"], "moderation failed");
        assert!(
            parse_observation(
                &response(200, json!({ "task_id": "other", "status": "pending" })),
                "1"
            )
            .is_err()
        );
        for (status, expected) in [("IN_PROGRESS", false), ("FAILURE", true), ("QUEUED", false)] {
            let observed = parse_observation(
                &response(
                    200,
                    json!({
                        "code": "success", "status": "success",
                        "data": { "task_id": "1", "status": status, "progress": "50%",
                            "fail_reason": "provider rejected audio", "result_url": "" }
                    }),
                ),
                "1",
            )
            .unwrap();
            assert_eq!(observed.remote_status, status);
            assert_eq!(observed.failure.is_some(), expected);
            if expected {
                assert_eq!(
                    observed.failure.unwrap()["failReason"],
                    "provider rejected audio"
                );
            }
        }
        assert!(
            parse_observation(
                &response(
                    200,
                    json!({
                        "code": "success", "data": { "task_id": "other", "status": "SUCCESS" }
                    })
                ),
                "1"
            )
            .is_err()
        );
    }

    #[test]
    fn pixverse_frames_are_ordered_and_explicit_actions_and_new_parameters_reach_server() {
        let mut request = generation(
            json!({ "metadata": { "source_video_id": "18446744073709551615" },
            "restyle_id": "337045047335104", "duration": 30, "quality": "4k" }),
        );
        let mut last = image(Some("22"), None);
        last.role = "last_frame".into();
        let mut first = image(Some("11"), None);
        first.role = "first_frame".into();
        request.images = vec![last, first];
        let body = build_pixverse_video_body("PixVerse-C1", &request, &["22".into(), "11".into()])
            .unwrap();
        assert_eq!(body["images"], json!(["11", "22"]));
        assert_eq!(body["metadata"]["action"], "transition");
        assert_eq!(body["metadata"]["source_video_id"], u64::MAX);
        assert_eq!(body["metadata"]["restyle_id"], 337045047335104_u64);
        assert_eq!(body["metadata"]["quality"], "4k");
        assert_eq!(body["duration"], 30);
        request.parameters = json!({ "action": "future_action", "images": "future-image-format" });
        request.images.clear();
        let body = build_pixverse_video_body("PixVerse-C1", &request, &[]).unwrap();
        assert_eq!(body["metadata"]["action"], "future_action");
        assert_eq!(body["images"], "future-image-format");
        assert_eq!(body["duration"], 5);
        assert_eq!(body["metadata"]["quality"], "540p");
    }

    #[test]
    fn pixverse_multiple_media_references_are_left_to_server_without_dropping_inputs() {
        let mut request =
            generation(json!({ "metadata": { "source_video_id": 30, "action": "lip_sync" } }));
        for id in ["11", "12"] {
            let mut video = image(Some(id), None);
            video.media_type = MediaType::Video;
            request.videos.push(video);
            let mut audio = image(Some(id), None);
            audio.media_type = MediaType::Audio;
            request.audios.push(audio);
        }
        let body = build_pixverse_video_body("PixVerse-V6", &request, &[]).unwrap();
        assert_eq!(body["metadata"]["video_media_id"], json!([11, 12]));
        assert_eq!(body["metadata"]["audio_media_id"], json!([11, 12]));
        assert_eq!(body["metadata"]["source_video_id"], 30);
    }

    #[test]
    fn pixverse_upload_path_is_a_sibling_of_v1_and_preserves_gateway_prefix() {
        for (base, expected) in [
            (
                "https://example.com/v1/",
                "https://example.com/pixverse/openapi/v2/image/upload",
            ),
            (
                "https://example.com/gateway/v1",
                "https://example.com/gateway/pixverse/openapi/v2/image/upload",
            ),
            (
                "https://example.com",
                "https://example.com/pixverse/openapi/v2/image/upload",
            ),
        ] {
            assert_eq!(
                upload_endpoint(base, "/pixverse/openapi/v2/image/upload")
                    .unwrap()
                    .as_str(),
                expected
            );
        }
    }

    fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        let length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while bytes.len() - header_end < length {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
        }
        (headers, bytes[header_end..header_end + length].to_vec())
    }

    async fn submit_to_mock(
        request: ResolvedGeneration,
        responses: Vec<(u16, Value)>,
    ) -> (
        BackendResult<(GenerationSubmission, CapturedHttpResponse)>,
        Vec<(String, Vec<u8>)>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let mut captured = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            for (status, payload) in responses {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                captured.push(read_request(&mut stream));
                let body = payload.to_string();
                write!(stream, "HTTP/1.1 {status} response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            captured
        });
        let directory = tempfile::TempDir::new().unwrap();
        let storage = Arc::new(Storage::open(&directory.path().join("db.sqlite")).unwrap());
        let provider = storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: "pixverse-test".into(),
                display_name: "PixVerse".into(),
                adapter_id: "moyu_v1".into(),
                base_url: format!("http://127.0.0.1:{port}/v1"),
                enabled: true,
            })
            .unwrap();
        let credentials = CredentialStore::file(directory.path().join("credentials.json"));
        credentials
            .set("pixverse-frozen-group", "sk-frozen")
            .unwrap();
        credentials
            .set(&provider.api_key_ref, "sk-current")
            .unwrap();
        let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
        lifecycle
            .create(NewTask {
                id: "pixverse-task",
                canvas_id: "canvas-1",
                source_node_id: "video-1",
                operation: GenerationOperation::VideoGeneration,
                provider: &provider,
                api_key_ref: "pixverse-frozen-group",
                model_definition_id: "pixverse-v6",
                remote_model_id: Some("PixVerse-V6"),
                logical_request: &json!({}),
            })
            .unwrap();
        for fact in [
            GenerationLifecycleFact::BeginResolution {
                attempt_id: "resolve".into(),
            },
            GenerationLifecycleFact::ResolutionSucceeded {
                attempt_id: "resolve".into(),
                resolved_request: json!({}),
            },
            GenerationLifecycleFact::BeginSubmission {
                attempt_id: "submit".into(),
                backoff_ms: None,
            },
        ] {
            lifecycle.commit("pixverse-task", fact).unwrap();
        }
        let task = storage.get_task_execution("pixverse-task").unwrap();
        // Current connection edits must not redirect either upload or paid submission.
        storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: provider.id.clone(),
                display_name: "changed".into(),
                adapter_id: "moyu_v1".into(),
                base_url: "https://changed.example.com".into(),
                enabled: true,
            })
            .unwrap();
        let runtime = ProviderRuntime::new(storage, lifecycle, credentials).unwrap();
        let result = runtime.submit(&task, "submit", &request).await;
        (result, server.join().unwrap())
    }

    #[tokio::test]
    async fn pixverse_local_image_upload_uses_frozen_credentials_and_submits_once() {
        let mut request =
            generation(json!({ "duration": 5, "quality": "720p", "generate_audio_switch": true }));
        request
            .images
            .push(image(None, Some(b"\x89PNG\r\n\x1a\nimage".to_vec())));
        let (result, calls) = submit_to_mock(
            request,
            vec![
                (
                    200,
                    json!({ "ErrCode": 0, "Resp": { "img_id": 4929800001234567_u64 } }),
                ),
                (200, json!({ "task_id": "4929809973433869", "status": "" })),
            ],
        )
        .await;
        assert!(
            matches!(result.unwrap().0, GenerationSubmission::RemoteVideoTask { task_id } if task_id == "4929809973433869")
        );
        assert_eq!(calls.len(), 2);
        assert!(
            calls[0]
                .0
                .starts_with("POST /pixverse/openapi/v2/image/upload HTTP/1.1")
        );
        assert!(
            String::from_utf8_lossy(&calls[0].1)
                .contains("name=\"image\"; filename=\"portrait.png\"")
        );
        assert!(
            calls[1]
                .0
                .starts_with("POST /v1/video/generations HTTP/1.1")
        );
        assert!(calls.iter().all(|(headers, _)| {
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-frozen")
        }));
        let body: Value = serde_json::from_slice(&calls[1].1).unwrap();
        assert_eq!(body["images"], json!(["4929800001234567"]));
        assert_eq!(body["metadata"]["quality"], "720p");
        assert_eq!(body["metadata"]["generate_audio_switch"], true);
    }

    #[tokio::test]
    async fn pixverse_channel_rejection_keeps_error_and_does_not_strip_and_resubmit() {
        let (result, calls) = submit_to_mock(
            generation(json!({ "duration": 5, "quality": "720p" })),
            vec![(
                400,
                json!({ "error": { "message": "Unknown parameter: quality",
                "code": "pixverse_submit_failed", "param": "quality" } }),
            )],
        )
        .await;
        let error = result.unwrap_err().runtime_record();
        assert_eq!(calls.len(), 1);
        assert_eq!(error["details"]["httpStatus"], 400);
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("pixverse_submit_failed")
        );
        let body: Value = serde_json::from_slice(&calls[0].1).unwrap();
        assert_eq!(body["metadata"]["quality"], "720p");
    }

    #[tokio::test]
    async fn pixverse_three_images_and_local_or_cloud_audio_are_uploaded_and_submitted() {
        for bytes in [None, Some(b"RIFF....WAVEaudio".to_vec())] {
            let mut request = generation(json!({ "duration": 8, "quality": "720p" }));
            for name in ["person", "room", "pose"] {
                request.images.push(image(
                    Some(&format!("https://example.com/{name}.png")),
                    None,
                ));
            }
            let mut audio = image(
                Some("https://example.com/asset/asset-20261017205449-pxngg.jpg"),
                bytes.clone(),
            );
            audio.media_type = MediaType::Audio;
            audio.role = "reference_audio".into();
            audio.file_name = "周敏之教授.wav".into();
            audio.mime_type = "audio/wav".into();
            request.audios.push(audio);
            let (result, calls) = submit_to_mock(request, vec![
                (200, json!({ "ErrCode": 0, "Resp": { "media_id": u64::MAX, "media_type": "audio" } })),
                (200, json!({ "task_id": "4929809973433869", "status": "" })),
            ]).await;
            result.unwrap();
            assert_eq!(calls.len(), 2);
            assert!(
                calls[0]
                    .0
                    .starts_with("POST /pixverse/openapi/v2/media/upload HTTP/1.1")
            );
            let multipart = String::from_utf8_lossy(&calls[0].1);
            assert!(multipart.contains("name=\"media_type\"\r\n\r\naudio"));
            if bytes.is_some() {
                assert!(multipart.contains("name=\"file\"; filename=\"周敏之教授.wav\""));
                assert!(multipart.contains("RIFF....WAVEaudio"));
            } else {
                assert!(multipart.contains("name=\"file_url\""));
                assert!(multipart.contains("asset-20261017205449-pxngg.jpg"));
            }
            assert!(calls.iter().all(|(headers, _)| {
                headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer sk-frozen")
            }));
            let body: Value = serde_json::from_slice(&calls[1].1).unwrap();
            assert_eq!(body["metadata"]["audio_media_id"], u64::MAX);
            assert_eq!(body["metadata"]["action"], "fusion");
            assert_eq!(body["images"].as_array().unwrap().len(), 3);
            assert!(body.get("audio_media_id").is_none());
        }
    }

    #[tokio::test]
    async fn pixverse_video_and_audio_ids_reach_lip_sync_and_service_errors_are_preserved() {
        let mut request = generation(
            json!({ "duration": 60, "quality": "4k", "action": "lip_sync", "future_flag": true }),
        );
        for media_type in [MediaType::Video, MediaType::Audio] {
            let mut media = image(Some("https://example.com/source"), None);
            media.media_type = media_type;
            media.role = if media_type == MediaType::Video {
                "reference_video"
            } else {
                "reference_audio"
            }
            .into();
            if media_type == MediaType::Video {
                request.videos.push(media);
            } else {
                request.audios.push(media);
            }
        }
        let (result, calls) = submit_to_mock(request, vec![
            (200, json!({ "ErrCode": 0, "Resp": { "media_id": 429048494022506_u64 } })),
            (200, json!({ "ErrCode": 0, "Resp": { "media_id": 429048496816171_u64 } })),
            (400, json!({ "error": { "code": "pixverse_submit_failed", "message": "[400017] invalid param" } })),
        ]).await;
        let error = result.unwrap_err().runtime_record();
        assert_eq!(error["details"]["httpStatus"], 400);
        assert!(error.to_string().contains("[400017] invalid param"));
        assert_eq!(calls.len(), 3);
        assert!(String::from_utf8_lossy(&calls[0].1).contains("name=\"media_type\"\r\n\r\nvideo"));
        assert!(String::from_utf8_lossy(&calls[1].1).contains("name=\"media_type\"\r\n\r\naudio"));
        let body: Value = serde_json::from_slice(&calls[2].1).unwrap();
        assert_eq!(body["metadata"]["video_media_id"], 429048494022506_u64);
        assert_eq!(body["metadata"]["audio_media_id"], 429048496816171_u64);
        assert_eq!(body["metadata"]["action"], "lip_sync");
        assert_eq!(body["duration"], 60);
        assert_eq!(body["metadata"]["quality"], "4k");
        assert_eq!(body["future_flag"], true);
    }
}
