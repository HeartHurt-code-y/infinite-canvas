//! 饭众烟统一视频合同。来源：/api-docs/video-generations、video-task、assets-uploads。
//! 与图片、其他网关共用任务生命周期及上传传输；本模块只负责视频请求与回执。
use serde_json::{Map, Value, json};

use super::{
    CapturedHttpResponse, GenerationObservation, ProviderRuntime, ResolvedGeneration,
    ResolvedProviderContext, checked_observe_path, encode_query_value, ensure_request_encoding,
    insert_mapped_parameters, mapped_parameters, parse_progress,
    require_public_reference_url_value_with, require_success, video_prompt,
};
use crate::backend::{
    error::{BackendError, BackendResult},
    storage::TaskExecutionRecord,
    types::MediaType,
};

impl ProviderRuntime {
    pub(super) async fn prepare_fzy_video_body(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        let model = task
            .remote_model_id_snapshot
            .as_deref()
            .filter(|model| !model.trim().is_empty())
            .ok_or_else(|| {
                BackendError::validation("请先选择并保存视频模型。", json!({ "taskId": task.id }))
            })?;
        let media = resolved
            .images
            .iter()
            .chain(&resolved.videos)
            .chain(&resolved.audios);
        let mut planned = Vec::new();
        for input in media.clone() {
            let reference = if let Some(bytes) = &input.bytes {
                if bytes.is_empty() {
                    return Err(BackendError::validation(
                        "参考素材文件为空，请重新选择有内容的图片、视频或音频。",
                        input.archive(),
                    ));
                }
                "https://upload.invalid/reference".to_string()
            } else {
                input.remote_reference.clone().ok_or_else(|| {
                    BackendError::validation(
                        "参考素材无法读取，请重新选择本地文件或有效的公网链接。",
                        input.archive(),
                    )
                })?
            };
            planned.push(reference);
        }
        // 在上传前检查字段冲突与完整编码；占位地址只存在于这次内存校验中。
        build_video_body(model, resolved, &planned)?;
        let mut references = Vec::with_capacity(planned.len());
        for input in media {
            references.push(
                self.gateway_reference_url(task, attempt_id, context, input, "饭众烟视频")
                    .await?,
            );
        }
        build_video_body(model, resolved, &references)
    }
}

pub(super) fn build_video_body(
    model: &str,
    resolved: &ResolvedGeneration,
    references: &[String],
) -> BackendResult<Value> {
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let media = resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios);
    if references.len() != media.clone().count() {
        return Err(BackendError::protocol(
            "参考素材上传结果不完整，请保留本次记录后重试。",
            json!({ "inputs": media.count(), "references": references.len() }),
        ));
    }
    let mut arrays: Map<String, Value> = Map::new();
    for (input, reference) in media.zip(references) {
        require_public_reference_url_value_with(reference, "饭众烟视频")?;
        if matches!(input.role.as_str(), "first_frame" | "last_frame")
            && input.media_type != MediaType::Image
        {
            return Err(BackendError::validation(
                "首尾帧必须使用图片，请重新指定图片素材或改为音视频参考。",
                input.archive(),
            ));
        }
        let field = match (input.media_type, input.role.as_str()) {
            (MediaType::Image, "first_frame") => "start_frame",
            (MediaType::Image, "last_frame") => "end_frame",
            (MediaType::Image, _) => "images",
            (MediaType::Video, _) => "reference_videos",
            (MediaType::Audio, _) => "reference_audios",
            (MediaType::Text, _) => {
                return Err(BackendError::validation(
                    "视频接口不能直接接收文档或网页素材，请先提取文字并放进提示词。",
                    input.archive(),
                ));
            }
        };
        arrays
            .entry(field)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("reference array")
            .push(json!(reference));
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    let prompt = video_prompt(resolved);
    body.insert(
        "prompt".into(),
        json!(if prompt.trim().is_empty() {
            &resolved.rendered_prompt
        } else {
            &prompt
        }),
    );
    body.extend(arrays);
    insert_mapped_parameters(&mut body, "metadata", mapped_parameters(resolved, "root")?)?;
    let has_values = |field: &str| {
        body.get(field)
            .is_some_and(|value| value.as_array().is_some_and(|values| !values.is_empty()))
    };
    let start = has_values("start_frame");
    let end = has_values("end_frame");
    if start != end || ((start || end) && has_values("images")) {
        return Err(BackendError::validation(
            "首尾帧需要成对使用，且不能同时连接参考图。请补齐首帧和尾帧，或把图片都设为参考图。",
            json!({ "hasStartFrame": start, "hasEndFrame": end, "hasReferenceImages": has_values("images") }),
        ));
    }
    Ok(Value::Object(body))
}

pub(super) fn ambiguous_submission_error(error: BackendError) -> BackendError {
    BackendError::protocol(
        "饭众烟视频的提交结果尚未确认，任务可能已经创建。请保留本次记录和请求编号，联系管理员核查后再决定是否重新生成。",
        json!({ "ambiguousPaidSubmission": true, "source": error.runtime_record() }),
    )
}

fn response_details(response: &CapturedHttpResponse) -> Value {
    json!({ "httpStatus": response.status, "headers": response.headers, "rawResponse": response.body })
}

pub(super) fn parse_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    if let Err(mut error) = require_success(response) {
        let payload: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
        let code = payload
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // upstream_submit_failed 即使伴随 4xx 也不能视为安全拒绝。
        let unknown = matches!(
            code,
            "upstream_submit_failed" | "video_submission_unknown" | "video_receipt_unconfirmed"
        );
        if !unknown
            && (matches!(
                response.status,
                400 | 401 | 402 | 403 | 404 | 413 | 422 | 429
            ) || code == "exchange_rate_unavailable")
        {
            if let BackendError::Protocol { details, .. } = &mut error {
                details["noChargeTerminal"] = json!(true);
            }
            return Err(error);
        }
        return Err(ambiguous_submission_error(error));
    }
    let value: Value = serde_json::from_str(&response.body).map_err(|_| {
        ambiguous_submission_error(BackendError::protocol(
            "视频回执不是有效 JSON。",
            response_details(response),
        ))
    })?;
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            ambiguous_submission_error(BackendError::protocol(
                "视频回执缺少任务编号。",
                response_details(response),
            ))
        })
}

pub(super) fn observe_path(remote_task_id: &str) -> BackendResult<String> {
    if matches!(remote_task_id, "" | "." | "..") {
        return Err(BackendError::validation(
            "远程任务编号无效，请保留记录并联系管理员核查。",
            json!({ "remoteTaskId": remote_task_id }),
        ));
    }
    checked_observe_path(format!(
        "/v1/video/generations/{}",
        encode_query_value(remote_task_id)
    ))
}

pub(super) fn parse_observation(
    response: &CapturedHttpResponse,
    remote_task_id: &str,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body).map_err(|_| {
        BackendError::protocol(
            "视频任务查询响应不是有效 JSON，请稍后查询原任务。",
            response_details(response),
        )
    })?;
    if value.get("id").and_then(Value::as_str) != Some(remote_task_id) {
        return Err(BackendError::protocol(
            "返回的视频任务编号不匹配，请保留记录并查询原任务。",
            response_details(response),
        ));
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .ok_or_else(|| {
            BackendError::protocol(
                "视频查询响应缺少任务状态，请稍后查询原任务。",
                response_details(response),
            )
        })?;
    let video_url = value
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|result| result.get("url").and_then(Value::as_str))
        .map(str::trim)
        .find(|url| !url.is_empty())
        .map(ToOwned::to_owned);
    if let Some(url) = &video_url {
        require_public_reference_url_value_with(url, "饭众烟视频结果")?;
    }
    if status == "success" && video_url.is_none() {
        return Err(BackendError::protocol(
            "视频任务已结束，但未返回可下载的视频链接。请查询原任务或联系管理员核查结果。",
            response_details(response),
        ));
    }
    let failed = matches!(status, "failed" | "expired");
    let failure = failed.then(|| {
        let mut details = response_details(response);
        details["failReason"] = value.get("errorDetail").cloned().unwrap_or(Value::Null);
        details["errorCode"] = value.get("errorCode").cloned().unwrap_or(Value::Null);
        details["errorDetail"] = value.get("errorDetail").cloned().unwrap_or(Value::Null);
        details
    });
    Ok(GenerationObservation {
        remote_status: status.to_string(),
        progress: value.get("progress").and_then(parse_progress),
        video_url,
        text_content: None,
        images: Vec::new(),
        failure,
    })
}
