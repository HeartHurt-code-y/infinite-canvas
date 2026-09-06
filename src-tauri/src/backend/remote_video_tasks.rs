use std::collections::HashMap;

use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use super::{
    error::{BackendError, BackendResult},
    provider::{ProviderRuntime, ResolvedProviderContext, endpoint},
    storage::{Storage, TaskExecutionRecord},
    types::{
        GenerationOperation, GenerationTaskStatus, RawProviderResponse, RemoteVideoTask,
        RemoteVideoTaskPage, RemoteVideoTaskStatus, VideoTaskListCommand,
    },
};

pub(super) const LIST_PATH: &str = "/v1/video/tasks";

pub async fn list(
    providers: &ProviderRuntime,
    storage: &Storage,
    command: &VideoTaskListCommand,
) -> BackendResult<RemoteVideoTaskPage> {
    let query = build_query(command)?;
    // Resolve once: the request and local matching must use the same provider
    // and group credential even if settings change while HTTP is in flight.
    let context = providers.resolve_token_group(
        &command.provider_connection_id,
        command.token_group.as_deref(),
    )?;
    let response = providers
        .send_raw_json_request(&context, Method::GET, LIST_PATH, &query, None, &[])
        .await?;
    let mut page = parse_response(&response)?;
    let ids = page
        .items
        .iter()
        .filter(|item| !item.task_id.is_empty())
        .map(|item| item.task_id.clone())
        .collect::<Vec<_>>();
    let candidates = storage.find_remote_video_tasks(&context.provider_connection_id, &ids)?;
    associate_local_tasks(&mut page, &QueryScope::from(&context), &candidates)?;
    Ok(page)
}

pub(super) fn build_query(
    command: &VideoTaskListCommand,
) -> BackendResult<Vec<(&'static str, String)>> {
    if command.start_timestamp.is_some_and(|value| value < 0)
        || command.end_timestamp.is_some_and(|value| value < 0)
        || matches!((command.start_timestamp, command.end_timestamp), (Some(start), Some(end)) if start > end)
    {
        return Err(BackendError::validation(
            "查询时间必须是有效的 Unix 秒时间戳，结束时间不能早于开始时间",
            json!({ "startTimestamp": command.start_timestamp, "endTimestamp": command.end_timestamp }),
        ));
    }
    if command.page == 0 || !(1..=100).contains(&command.page_size) {
        return Err(BackendError::validation(
            "页码必须从 1 开始，每页条数必须在 1 到 100 之间",
            json!({ "page": command.page, "pageSize": command.page_size }),
        ));
    }
    let mut query = vec![
        ("p", command.page.to_string()),
        ("page_size", command.page_size.to_string()),
    ];
    if let Some(value) = command.start_timestamp {
        query.push(("start_timestamp", value.to_string()));
    }
    if let Some(value) = command.end_timestamp {
        query.push(("end_timestamp", value.to_string()));
    }
    if let Some(status) = command
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !matches!(
            status,
            "NOT_START"
                | "SUBMITTED"
                | "QUEUED"
                | "IN_PROGRESS"
                | "SUCCESS"
                | "FAILURE"
                | "UNKNOWN"
        ) {
            return Err(BackendError::validation(
                "远程视频任务状态筛选值无效",
                json!({ "status": status }),
            ));
        }
        query.push(("status", status.to_string()));
    }
    // Omitting both dates intentionally preserves the API's server-local-day
    // default. A missing bound is never replaced with the other bound or now.
    Ok(query)
}

#[derive(Deserialize)]
struct ApiPage {
    page: u32,
    page_size: u32,
    total: u64,
    items: Vec<ApiTask>,
}

#[derive(Deserialize)]
struct ApiTask {
    task_id: String,
    submit_time: i64,
    start_time: i64,
    finish_time: i64,
    status: RemoteVideoTaskStatus,
    progress: String,
    fail_reason: String,
    prompt_tokens: u64,
    completion_tokens: u64,
}

pub(super) fn parse_response(response: &RawProviderResponse) -> BackendResult<RemoteVideoTaskPage> {
    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        BackendError::protocol(
            format!(
                "远程视频任务查询返回了无效 JSON（HTTP {}）",
                response.status
            ),
            json!({ "httpStatus": response.status, "source": error.to_string() }),
        )
    })?;
    if !(200..300).contains(&response.status) || value.get("success") == Some(&Value::Bool(false)) {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("接口未返回错误说明");
        return Err(BackendError::protocol(
            format!(
                "远程视频任务查询失败（HTTP {}）：{}",
                response.status, message
            ),
            json!({ "httpStatus": response.status, "message": message }),
        ));
    }
    if value.get("success") != Some(&Value::Bool(true)) {
        return Err(BackendError::protocol(
            "远程视频任务响应缺少有效的 success 标记",
            json!({ "httpStatus": response.status }),
        ));
    }
    let page: ApiPage = serde_json::from_value(value.get("data").cloned().unwrap_or(Value::Null))
        .map_err(|error| {
        BackendError::protocol(
            "远程视频任务列表结构无效",
            json!({ "httpStatus": response.status, "source": error.to_string() }),
        )
    })?;
    if page.page == 0
        || !(1..=100).contains(&page.page_size)
        || page.items.len() > page.page_size as usize
        || page.total < page.items.len() as u64
        || page
            .items
            .iter()
            .any(|item| item.submit_time < 0 || item.start_time < 0 || item.finish_time < 0)
    {
        return Err(BackendError::protocol(
            "远程视频任务列表包含无效的分页或时间字段",
            json!({ "httpStatus": response.status, "page": page.page, "pageSize": page.page_size, "total": page.total }),
        ));
    }
    Ok(RemoteVideoTaskPage {
        page: page.page,
        page_size: page.page_size,
        total: page.total,
        items: page
            .items
            .into_iter()
            .map(|item| {
                let video_url = (item.status == RemoteVideoTaskStatus::Success)
                    .then(|| safe_video_url(&item.fail_reason))
                    .flatten();
                let failure_reason = (item.status == RemoteVideoTaskStatus::Failure
                    && !item.fail_reason.trim().is_empty())
                .then(|| item.fail_reason.trim().to_string());
                RemoteVideoTask {
                    task_id: item.task_id,
                    submit_time: item.submit_time,
                    start_time: item.start_time,
                    finish_time: item.finish_time,
                    status: item.status,
                    progress: item.progress,
                    video_url,
                    failure_reason,
                    prompt_tokens: item.prompt_tokens,
                    completion_tokens: item.completion_tokens,
                    local_task_id: None,
                    local_task_status: None,
                    can_resume_polling: false,
                }
            })
            .collect(),
    })
}

fn safe_video_url(value: &str) -> Option<String> {
    let value = value.trim();
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| value.to_string())
}

struct QueryScope<'a> {
    provider_connection_id: &'a str,
    adapter_id: &'a str,
    base_url: &'a str,
    api_key_ref: &'a str,
}

impl<'a> From<&'a ResolvedProviderContext> for QueryScope<'a> {
    fn from(context: &'a ResolvedProviderContext) -> Self {
        Self {
            provider_connection_id: &context.provider_connection_id,
            adapter_id: &context.adapter_id,
            base_url: &context.base_url,
            api_key_ref: &context.api_key_ref,
        }
    }
}

fn associate_local_tasks(
    page: &mut RemoteVideoTaskPage,
    context: &QueryScope<'_>,
    candidates: &[TaskExecutionRecord],
) -> BackendResult<()> {
    let current_endpoint = endpoint(context.base_url, LIST_PATH)?;
    let mut matches: HashMap<&str, Option<&TaskExecutionRecord>> = HashMap::new();
    for task in candidates {
        let Some(remote_id) = task.remote_task_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        if task.operation != GenerationOperation::VideoGeneration
            || task.provider_connection_id != context.provider_connection_id
            || task.adapter_id_snapshot != context.adapter_id
            || task.api_key_ref_snapshot != context.api_key_ref
            || endpoint(&task.base_url_snapshot, LIST_PATH).ok().as_ref() != Some(&current_endpoint)
        {
            continue;
        }
        matches
            .entry(remote_id)
            .and_modify(|entry| *entry = None)
            .or_insert(Some(task));
    }
    for item in &mut page.items {
        if let Some(Some(task)) = matches.get(item.task_id.as_str()) {
            item.local_task_id = Some(task.id.clone());
            item.local_task_status = Some(task.status);
            item.can_resume_polling = matches!(
                task.status,
                GenerationTaskStatus::Queued | GenerationTaskStatus::Running
            );
        }
    }
    Ok(())
}
