//! 工作流运行历史：持久化完整断点、事件与模型任务归属，使用CAS防止旧回调覆盖进度。

use std::sync::LazyLock;

use regex::Regex;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    Storage, checked_sql_integer, json_sql_error, now_ms, task_summary_from_row, task_summary_sql,
};
use crate::backend::{
    error::{BackendError, BackendResult},
    provider::redact_url_string,
    types::GenerationTaskSummary,
};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_history (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  workflow_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_history_updated ON workflow_history(updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_canvas ON workflow_history(canvas_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_node ON workflow_history(source_node_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS workflow_history_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_history(id),
  created_at INTEGER NOT NULL,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_history_events_run ON workflow_history_events(run_id,created_at,id);
CREATE TABLE IF NOT EXISTS workflow_history_tasks (
  run_id TEXT NOT NULL REFERENCES workflow_history(id),
  task_id TEXT PRIMARY KEY REFERENCES generation_tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_history_tasks_run ON workflow_history_tasks(run_id,task_id);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowKind {
    Knowledge,
    Film,
    ComicDrama,
    Commerce,
    Remotion,
    XhsCover,
    ReverseVideo,
}

impl WorkflowKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Knowledge => "knowledge",
            Self::Film => "film",
            Self::ComicDrama => "comicDrama",
            Self::Commerce => "commerce",
            Self::Remotion => "remotion",
            Self::XhsCover => "xhsCover",
            Self::ReverseVideo => "reverseVideo",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryRecord {
    pub id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub workflow_kind: WorkflowKind,
    pub title: String,
    pub status: String,
    pub progress: f64,
    pub message: String,
    #[serde(default)]
    pub error: Option<String>,
    pub node_snapshot: Value,
    pub models: Value,
    pub attempt_count: u32,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryEvent {
    #[serde(default)]
    pub id: String,
    pub phase: String,
    pub progress: f64,
    pub message: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkflowHistoryCommand {
    pub record: WorkflowHistoryRecord,
    #[serde(default)]
    pub event: Option<WorkflowHistoryEvent>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryQuery {
    pub canvas_id: Option<String>,
    pub source_node_id: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryDetail {
    pub record: WorkflowHistoryRecord,
    pub events: Vec<WorkflowHistoryEvent>,
    pub tasks: Vec<GenerationTaskSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryPage {
    pub items: Vec<WorkflowHistoryRecord>,
    pub next_cursor: Option<String>,
}

fn valid_progress(progress: f64) -> BackendResult<()> {
    if !progress.is_finite() || !(0.0..=100.0).contains(&progress) {
        return Err(BackendError::validation(
            "工作流历史进度必须为0至100",
            Value::Null,
        ));
    }
    Ok(())
}

fn validate_record(record: &WorkflowHistoryRecord) -> BackendResult<()> {
    for (name, value) in [
        ("id", &record.id),
        ("canvasId", &record.canvas_id),
        ("sourceNodeId", &record.source_node_id),
        ("status", &record.status),
    ] {
        if value.trim().is_empty() || value.len() > 512 {
            return Err(BackendError::validation(
                "工作流历史标识或状态无效",
                json!({"field": name}),
            ));
        }
    }
    if !record
        .node_snapshot
        .pointer("/config/checkpoint")
        .is_some_and(Value::is_object)
        || !record.models.is_array()
        || record.node_snapshot.get("key").and_then(Value::as_str)
            != Some(record.source_node_id.as_str())
    {
        return Err(BackendError::validation(
            "工作流历史必须保留对应节点和完整执行断点",
            Value::Null,
        ));
    }
    valid_progress(record.progress)?;
    checked_sql_integer(record.revision, "revision")?;
    Ok(())
}

static INLINE_MEDIA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"data:[A-Za-z0-9.+/-]+;base64,[A-Za-z0-9+/=\r\n]+").expect("inline media pattern")
});
static SECRET_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._~+/-]{12,}=*)")
        .expect("secret token pattern")
});
static URL_IN_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s<>"']+"#).expect("URL pattern"));

/// 保留用于续跑的长剧本与JSON；只去掉秘密及内联二进制，不能套用日志的文本截断策略。
fn sanitize_text(value: &str) -> String {
    let trimmed = value.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
    {
        let sanitized = sanitize_value(&parsed);
        return if sanitized == parsed {
            value.to_string()
        } else {
            serde_json::to_string(&sanitized).expect("JSON value serializes")
        };
    }
    if trimmed.len() > 512
        && trimmed.len() % 4 == 0
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return "<内联图片数据已排除>".to_string();
    }
    let cleaned = INLINE_MEDIA.replace_all(value, "<内联图片数据已排除>");
    let cleaned = SECRET_TOKEN.replace_all(&cleaned, "<敏感凭据已排除>");
    URL_IN_TEXT
        .replace_all(&cleaned, |capture: &regex::Captures<'_>| {
            let original = &capture[0];
            let redacted = redact_url_string(original);
            if url::Url::parse(original).ok() == url::Url::parse(&redacted).ok() {
                original.to_string()
            } else {
                redacted
            }
        })
        .into_owned()
}

pub(crate) fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .filter_map(|(key, value)| {
                    let key_normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    if key_normalized.contains("credential")
                        || key_normalized.contains("apikey")
                        || key_normalized.contains("password")
                        || key_normalized.contains("secret")
                        || matches!(
                            key_normalized.as_str(),
                            "authorization" | "cookie" | "accesstoken" | "refreshtoken" | "token"
                        )
                    {
                        None
                    } else if matches!(key_normalized.as_str(), "base64" | "b64json") {
                        Some((
                            key.clone(),
                            Value::String("<内联图片数据已排除>".to_string()),
                        ))
                    } else {
                        Some((key.clone(), sanitize_value(value)))
                    }
                })
                .collect(),
        ),
        Value::String(text) => Value::String(sanitize_text(text)),
        other => other.clone(),
    }
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowHistoryRecord> {
    serde_json::from_str(&row.get::<_, String>(0)?).map_err(json_sql_error)
}

fn write_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    mut event: WorkflowHistoryEvent,
    timestamp: i64,
) -> BackendResult<()> {
    valid_progress(event.progress)?;
    if event.phase.trim().is_empty() || event.phase.len() > 512 {
        return Err(BackendError::validation(
            "工作流历史事件阶段无效",
            Value::Null,
        ));
    }
    if event.id.is_empty() {
        event.id = Uuid::new_v4().to_string();
    }
    if event.id.len() > 512 {
        return Err(BackendError::validation("工作流事件标识无效", Value::Null));
    }
    event.created_at = timestamp;
    event.message = sanitize_text(&event.message);
    event.error = event.error.as_deref().map(sanitize_text);
    transaction.execute(
        "INSERT INTO workflow_history_events(id,run_id,created_at,event_json) VALUES(?1,?2,?3,?4)",
        params![event.id, run_id, timestamp, serde_json::to_string(&event)?],
    )?;
    Ok(())
}

impl Storage {
    pub fn save_workflow_history(
        &self,
        command: SaveWorkflowHistoryCommand,
    ) -> BackendResult<WorkflowHistoryRecord> {
        let mut record = command.record;
        validate_record(&record)?;
        record.node_snapshot = sanitize_value(&record.node_snapshot);
        record.models = sanitize_value(&record.models);
        record.title = sanitize_text(&record.title);
        record.message = sanitize_text(&record.message);
        record.error = record.error.as_deref().map(sanitize_text);
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = transaction
            .query_row(
                "SELECT record_json FROM workflow_history WHERE id=?1",
                params![record.id],
                read_record,
            )
            .optional()?;
        if let Some(previous) = &previous {
            if record.revision != previous.revision {
                return Err(BackendError::Conflict(format!(
                    "工作流历史已更新，请读取最新进度（当前版本{}，提交版本{}）",
                    previous.revision, record.revision
                )));
            }
            if record.canvas_id != previous.canvas_id
                || record.workflow_kind != previous.workflow_kind
            {
                return Err(BackendError::Conflict(
                    "工作流历史不能切换所属画布或工作流类型".to_string(),
                ));
            }
            record.created_at = previous.created_at;
            record.updated_at = now_ms().max(previous.updated_at.saturating_add(1));
        } else {
            if record.revision != 0 {
                return Err(BackendError::Conflict(
                    "新的工作流历史必须从版本0创建".to_string(),
                ));
            }
            record.created_at = now_ms();
            record.updated_at = record.created_at;
        }
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| BackendError::Conflict("工作流历史版本超出范围".to_string()))?;
        let revision = checked_sql_integer(record.revision, "revision")?;
        let encoded = serde_json::to_string(&record)?;
        if encoded.len() > 32 * 1024 * 1024 {
            return Err(BackendError::validation(
                "工作流断点快照超过32MiB，请移除内联媒体后重试",
                Value::Null,
            ));
        }
        transaction.execute("INSERT INTO workflow_history(id,canvas_id,source_node_id,workflow_kind,status,revision,created_at,updated_at,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET source_node_id=excluded.source_node_id,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at,record_json=excluded.record_json", params![record.id,record.canvas_id,record.source_node_id,record.workflow_kind.as_str(),record.status,revision,record.created_at,record.updated_at,encoded])?;
        if let Some(event) = command.event {
            write_event(&transaction, &record.id, event, record.updated_at)?;
        }
        transaction.commit()?;
        Ok(record)
    }

    pub fn list_workflow_history(
        &self,
        query: WorkflowHistoryQuery,
    ) -> BackendResult<WorkflowHistoryPage> {
        let limit = query.limit.unwrap_or(50).clamp(1, 200) as i64;
        let offset = query
            .cursor
            .as_deref()
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| BackendError::validation("工作流历史分页游标无效", Value::Null))?
            .unwrap_or(0);
        if offset < 0 {
            return Err(BackendError::validation(
                "工作流历史分页游标不能为负数",
                Value::Null,
            ));
        }
        let statuses = query
            .statuses
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let connection = self.lock()?;
        let mut statement = connection.prepare("SELECT record_json FROM workflow_history WHERE (?1 IS NULL OR canvas_id=?1) AND (?2 IS NULL OR source_node_id=?2) AND (?3 IS NULL OR status IN (SELECT value FROM json_each(?3))) ORDER BY updated_at DESC,id LIMIT ?4 OFFSET ?5")?;
        let mut items = statement
            .query_map(
                params![
                    query.canvas_id,
                    query.source_node_id,
                    statuses,
                    limit + 1,
                    offset
                ],
                read_record,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > limit as usize {
            items.pop();
            Some(offset.saturating_add(limit).to_string())
        } else {
            None
        };
        Ok(WorkflowHistoryPage { items, next_cursor })
    }

    pub fn get_workflow_history(&self, id: &str) -> BackendResult<WorkflowHistoryDetail> {
        let connection = self.lock()?;
        let record = connection
            .query_row(
                "SELECT record_json FROM workflow_history WHERE id=?1",
                params![id],
                read_record,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("workflow history {id}")))?;
        let mut event_statement = connection.prepare(
            "SELECT event_json FROM workflow_history_events WHERE run_id=?1 ORDER BY created_at,id",
        )?;
        let events = event_statement
            .query_map(params![id], |row| {
                serde_json::from_str::<WorkflowHistoryEvent>(&row.get::<_, String>(0)?)
                    .map_err(json_sql_error)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut task_statement = connection.prepare(&task_summary_sql("WHERE id IN (SELECT task_id FROM workflow_history_tasks WHERE run_id=?1) ORDER BY created_at,id"))?;
        let tasks = task_statement
            .query_map(params![id], task_summary_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(WorkflowHistoryDetail {
            record,
            events,
            tasks,
        })
    }

    /// 仅在应用启动时显式调用；不能在读取历史时暂停仍活跃的任务。
    pub fn recover_workflow_history(&self) -> BackendResult<u32> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let records = {
            let mut statement = transaction.prepare("SELECT record_json FROM workflow_history WHERE status IN ('planning','generating','qc','composing') ORDER BY updated_at,id")?;
            statement
                .query_map([], read_record)?
                .collect::<Result<Vec<_>, _>>()?
        };
        for mut record in records.iter().cloned() {
            let old_phase = record.status.clone();
            record.status = "paused".to_string();
            record.message = "应用重新启动，已保留执行断点，可继续制作。".to_string();
            record.error = None;
            record.updated_at = now_ms().max(record.updated_at.saturating_add(1));
            record.revision += 1;
            let checkpoint = record
                .node_snapshot
                .pointer_mut("/config/checkpoint")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    BackendError::validation("历史断点不完整，无法恢复", json!({"id":record.id}))
                })?;
            if !checkpoint
                .get("lastActivePhase")
                .is_some_and(Value::is_string)
            {
                checkpoint.insert("lastActivePhase".to_string(), Value::String(old_phase));
            }
            checkpoint.insert("phase".to_string(), json!("paused"));
            checkpoint.insert("error".to_string(), Value::Null);
            checkpoint.insert("updatedAt".to_string(), json!(record.updated_at));
            transaction.execute("UPDATE workflow_history SET status='paused',revision=?2,updated_at=?3,record_json=?4 WHERE id=?1", params![record.id,checked_sql_integer(record.revision,"revision")?,record.updated_at,serde_json::to_string(&record)?])?;
            write_event(
                &transaction,
                &record.id,
                WorkflowHistoryEvent {
                    id: String::new(),
                    phase: "paused".to_string(),
                    progress: record.progress,
                    message: record.message.clone(),
                    error: None,
                    created_at: 0,
                },
                record.updated_at,
            )?;
        }
        transaction.commit()?;
        Ok(records.len() as u32)
    }
}

/// 由任务创建事务调用：不能让明确要求归档的付费调用失去历史归属。
pub(super) fn associate_task(
    transaction: &Transaction<'_>,
    task: &super::NewTask<'_>,
) -> BackendResult<()> {
    let Some(value) = task.logical_request.get("workflowRunId") else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let run_id = value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| BackendError::validation("工作流运行标识无效", Value::Null))?;
    let belongs = transaction
        .query_row(
            "SELECT 1 FROM workflow_history WHERE id=?1 AND canvas_id=?2 AND source_node_id=?3",
            params![run_id, task.canvas_id, task.source_node_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !belongs {
        return Err(BackendError::validation(
            "工作流历史尚未保存或不属于当前节点，请先保存运行记录",
            json!({"workflowRunId":run_id}),
        ));
    }
    transaction.execute(
        "INSERT INTO workflow_history_tasks(run_id,task_id) VALUES(?1,?2)",
        params![run_id, task.id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::backend::{
        prompt_optimize::OptimizeVideoPromptCommand,
        storage::{GenerationLifecycleFact, GenerationTaskLifecycle, NewTask},
        types::{GenerationOperation, GenerationTaskStatus, StartGenerationCommand},
    };

    fn record(id: &str, status: &str) -> WorkflowHistoryRecord {
        WorkflowHistoryRecord {
            id: id.into(),
            canvas_id: "canvas-1".into(),
            source_node_id: "node-1".into(),
            workflow_kind: WorkflowKind::Knowledge,
            title: "知识视频工作流".into(),
            status: status.into(),
            progress: 35.0,
            message: "正在生成".into(),
            error: None,
            node_snapshot: json!({"key":"node-1","kind":"knowledge_video_workflow","x":12,"y":34,"config":{"brief":"制作科普视频","models":{"text":{"providerId":"project-provider","modelDefinitionId":"project-text"}},"checkpoint":{"phase":status,"lastActivePhase":"generating","runId":id,"manifest":"{\"shots\":[{\"id\":\"shot1\"}]}","shots":[{"taskId":"media-existing","imagePath":"C:\\output\\cover.png"}]}}}),
            models: json!([{"role":"text","providerId":"project-provider","providerName":"项目供应商","modelDefinitionId":"project-text","modelName":"文本模型"}]),
            attempt_count: 1,
            revision: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn save(
        storage: &Storage,
        record: WorkflowHistoryRecord,
    ) -> BackendResult<WorkflowHistoryRecord> {
        storage.save_workflow_history(SaveWorkflowHistoryCommand {
            event: Some(WorkflowHistoryEvent {
                id: String::new(),
                phase: record.status.clone(),
                progress: record.progress,
                message: record.message.clone(),
                error: record.error.clone(),
                created_at: 0,
            }),
            record,
        })
    }

    #[test]
    fn persists_all_workflows_and_preserves_complete_sanitized_checkpoints() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.sqlite");
        let storage = Storage::open(&path).unwrap();
        let long_document = "完整正文与可恢复的镜头计划。".repeat(5000);
        for (index, kind) in [
            WorkflowKind::Knowledge,
            WorkflowKind::Film,
            WorkflowKind::ComicDrama,
            WorkflowKind::Commerce,
            WorkflowKind::Remotion,
            WorkflowKind::XhsCover,
            WorkflowKind::ReverseVideo,
        ]
        .into_iter()
        .enumerate()
        {
            let mut next = record(&format!("run-{index}"), "planning");
            next.workflow_kind = kind;
            next.node_snapshot["config"]["checkpoint"]["script"] = json!(long_document);
            next.node_snapshot["config"]["apiKey"] = json!("plain-secret-value");
            next.node_snapshot["config"]["checkpoint"]["image"] =
                json!(format!("data:image/png;base64,{}", "A".repeat(4000)));
            next.node_snapshot["config"]["checkpoint"]["b64_json"] = json!("A".repeat(4000));
            next.node_snapshot["config"]["checkpoint"]["manifest"] = json!(json!({"shots":[{"prompt":long_document,"token":"nested-secret","url":"https://host.test/media?token=signed-secret"}]}).to_string());
            next.models[0]["credentialRef"] = json!("secret-ref");
            next.error = Some("request rejected Bearer abcdefghijklmnop1234".into());
            let saved = save(&storage, next).unwrap();
            assert_eq!(saved.revision, 1);
            assert!(saved.created_at > 0);
        }
        drop(storage);
        let reopened = Storage::open(&path).unwrap();
        let page = reopened
            .list_workflow_history(WorkflowHistoryQuery::default())
            .unwrap();
        assert_eq!(page.items.len(), 7);
        for item in page.items {
            let detail = reopened.get_workflow_history(&item.id).unwrap();
            assert_eq!(
                detail.record.status, "planning",
                "reads must not auto-pause active runs"
            );
            assert_eq!(detail.events.len(), 1);
            assert_eq!(
                detail.record.node_snapshot["config"]["checkpoint"]["script"],
                long_document
            );
            let manifest: Value = serde_json::from_str(
                detail.record.node_snapshot["config"]["checkpoint"]["manifest"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(manifest["shots"][0]["prompt"], long_document);
            assert_eq!(manifest["shots"][0]["url"], "https://host.test/media");
            let serialized = serde_json::to_string(&detail).unwrap();
            for secret in [
                "plain-secret-value",
                "nested-secret",
                "signed-secret",
                "secret-ref",
                "abcdefghijklmnop1234",
                "data:image/png;base64",
                &"A".repeat(4000),
            ] {
                assert!(!serialized.contains(secret), "history retained {secret}");
            }
        }
    }

    #[test]
    fn rejects_stale_revision_atomically_and_allows_same_canvas_node_rebinding() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("history.sqlite")).unwrap();
        let initial = save(&storage, record("run", "planning")).unwrap();
        let mut updated = initial.clone();
        updated.status = "generating".into();
        updated.attempt_count = 2;
        updated.source_node_id = "restored-node".into();
        updated.node_snapshot["key"] = json!("restored-node");
        let updated = save(&storage, updated).unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.created_at, initial.created_at);
        assert!(matches!(
            save(&storage, initial),
            Err(BackendError::Conflict(_))
        ));
        let mut cross_canvas = updated.clone();
        cross_canvas.canvas_id = "another-canvas".into();
        assert!(matches!(
            save(&storage, cross_canvas),
            Err(BackendError::Conflict(_))
        ));
        let detail = storage.get_workflow_history("run").unwrap();
        assert_eq!(detail.record.source_node_id, "restored-node");
        assert_eq!(
            detail.events.len(),
            2,
            "rejected writes must not leave orphan events"
        );
        assert_eq!(detail.record.status, "generating");
    }

    #[test]
    fn competing_connections_accept_only_one_update_of_the_same_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.sqlite");
        let first = Arc::new(Storage::open(&path).unwrap());
        let initial = save(&first, record("run", "planning")).unwrap();
        let second = Arc::new(Storage::open(&path).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let handles = [Arc::clone(&first), second]
            .into_iter()
            .enumerate()
            .map(|(index, storage)| {
                let mut record = initial.clone();
                record.progress = (index + 1) as f64 * 20.0;
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    save(&storage, record)
                })
            })
            .collect::<Vec<_>>();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, Err(BackendError::Conflict(_))))
                .count(),
            1
        );
        let detail = first.get_workflow_history("run").unwrap();
        assert_eq!(detail.record.revision, 2);
        assert_eq!(detail.events.len(), 2);
    }

    #[test]
    fn restart_recovery_is_idempotent_and_retains_saved_media_and_decisions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.sqlite");
        let storage = Storage::open(&path).unwrap();
        let statuses = [
            "planning",
            "generating",
            "qc",
            "composing",
            "awaiting_approval",
            "done",
            "failed",
            "paused",
        ];
        for status in statuses {
            save(&storage, record(status, status)).unwrap();
        }
        drop(storage);
        let storage = Storage::open(&path).unwrap();
        assert_eq!(storage.recover_workflow_history().unwrap(), 4);
        assert_eq!(storage.recover_workflow_history().unwrap(), 0);
        for status in statuses {
            let detail = storage.get_workflow_history(status).unwrap();
            if ["planning", "generating", "qc", "composing"].contains(&status) {
                assert_eq!(detail.record.status, "paused");
                assert_eq!(detail.record.revision, 2);
                assert_eq!(
                    detail.record.node_snapshot["config"]["checkpoint"]["phase"],
                    "paused"
                );
                assert_eq!(
                    detail.record.node_snapshot["config"]["checkpoint"]["lastActivePhase"],
                    "generating"
                );
                assert_eq!(
                    detail.record.node_snapshot["config"]["checkpoint"]["shots"][0]["taskId"],
                    "media-existing"
                );
                assert_eq!(detail.events.len(), 2);
            } else {
                assert_eq!(detail.record.status, status);
                assert_eq!(detail.record.revision, 1);
                assert_eq!(detail.events.len(), 1);
            }
        }
    }

    #[test]
    fn history_filters_and_offset_pages_only_return_matching_records() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("history.sqlite")).unwrap();
        for index in 0..5 {
            let mut item = record(
                &format!("run-{index}"),
                if index % 2 == 0 { "done" } else { "failed" },
            );
            if index == 4 {
                item.canvas_id = "canvas-2".into();
            }
            save(&storage, item).unwrap();
        }
        let query = WorkflowHistoryQuery {
            canvas_id: Some("canvas-1".into()),
            source_node_id: Some("node-1".into()),
            statuses: Some(vec!["failed".into()]),
            limit: Some(1),
            ..Default::default()
        };
        let first = storage.list_workflow_history(query.clone()).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.next_cursor.as_deref(), Some("1"));
        let second = storage
            .list_workflow_history(WorkflowHistoryQuery {
                cursor: first.next_cursor,
                ..query
            })
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].id, second.items[0].id);
        assert!(second.next_cursor.is_none());
        assert!(
            storage
                .list_workflow_history(WorkflowHistoryQuery {
                    statuses: Some(vec![]),
                    ..Default::default()
                })
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            storage
                .list_workflow_history(WorkflowHistoryQuery {
                    cursor: Some("-1".into()),
                    ..Default::default()
                })
                .is_err()
        );
    }

    fn create_task(
        storage: &Storage,
        task_id: &str,
        source_node_id: &str,
        run_id: Option<&str>,
    ) -> BackendResult<()> {
        let provider = storage.get_provider_connection("provider-sd20")?;
        storage.insert_task(NewTask {
            id: task_id,
            canvas_id: "canvas-1",
            source_node_id,
            operation: GenerationOperation::TextGeneration,
            provider: &provider,
            api_key_ref: &provider.api_key_ref,
            model_definition_id: "project-model",
            remote_model_id: Some("remote-model"),
            logical_request: &json!({"workflowRunId":run_id,"userPrompt":"需要保留归属的策划调用"}),
        })
    }

    #[test]
    fn task_creation_links_failed_text_calls_and_rejects_cross_run_or_missing_history_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::open(&directory.path().join("history.sqlite")).unwrap());
        let first = save(&storage, record("first", "planning")).unwrap();
        save(&storage, record("second", "planning")).unwrap();
        create_task(&storage, "first-text", "node-1", Some("first")).unwrap();
        GenerationTaskLifecycle::new(Arc::clone(&storage))
            .commit(
                "first-text",
                GenerationLifecycleFact::ExecutionTerminated {
                    conclusion: GenerationTaskStatus::Failed,
                    error: json!({"message":"HTTP 401"}),
                },
            )
            .unwrap();
        create_task(&storage, "second-text", "node-1", Some("second")).unwrap();
        create_task(&storage, "legacy", "node-1", None).unwrap();
        for (id, node, run) in [
            ("unrelated", "other-node", "first"),
            ("missing", "node-1", "missing-history"),
        ] {
            assert!(create_task(&storage, id, node, Some(run)).is_err());
            assert!(
                storage.get_task_detail(id).is_err(),
                "failed link must roll back paid task creation"
            );
        }
        let detail = storage.get_workflow_history("first").unwrap();
        assert_eq!(detail.tasks.len(), 1);
        assert_eq!(detail.tasks[0].id, "first-text");
        assert_eq!(detail.tasks[0].status, GenerationTaskStatus::Failed);
        let mut moved = first;
        moved.source_node_id = "restored-node".into();
        moved.node_snapshot["key"] = json!("restored-node");
        save(&storage, moved).unwrap();
        create_task(&storage, "continued-text", "restored-node", Some("first")).unwrap();
        assert!(create_task(&storage, "old-node-text", "node-1", Some("first")).is_err());
        assert_eq!(
            storage.get_workflow_history("first").unwrap().tasks.len(),
            2
        );
        assert_eq!(
            storage.get_workflow_history("second").unwrap().tasks.len(),
            1
        );
    }

    #[test]
    fn both_generation_commands_accept_optional_workflow_run_id_without_breaking_legacy_payloads() {
        let mut media = json!({"canvasId":"canvas-1","sourceNodeId":"node-1","operation":"image_to_image","providerConnectionId":"project","modelDefinitionId":"model","prompt":[]});
        assert!(
            serde_json::from_value::<StartGenerationCommand>(media.clone())
                .unwrap()
                .workflow_run_id
                .is_none()
        );
        media["workflowRunId"] = json!("run-media");
        assert_eq!(
            serde_json::from_value::<StartGenerationCommand>(media)
                .unwrap()
                .workflow_run_id
                .as_deref(),
            Some("run-media")
        );
        let mut text = json!({"canvasId":"canvas-1","sourceNodeId":"node-1","providerConnectionId":"project","modelDefinitionId":"model","mode":"xhs_cover_plan","userPrompt":"封面"});
        assert!(
            serde_json::from_value::<OptimizeVideoPromptCommand>(text.clone())
                .unwrap()
                .workflow_run_id
                .is_none()
        );
        text["workflowRunId"] = json!("run-text");
        assert_eq!(
            serde_json::from_value::<OptimizeVideoPromptCommand>(text)
                .unwrap()
                .workflow_run_id
                .as_deref(),
            Some("run-text")
        );
    }

    #[test]
    fn safe_manifest_and_input_signature_strings_keep_exact_original_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("history.sqlite")).unwrap();
        let manifest = " \n{\"zTitle\": \"完整标题\", \"url\": \"https://example.com\", \"aShots\": [ {\"id\": \"shot-1\", \"prompt\": \"保留 空格与 Bearer token 教程主题\"} ]}\n ";
        let input_signature = "{\"brief\":\"制作封面\",\"options\":{\"style\":\"headline\",\"portraits\":[{\"localPath\":\"C:/参考/人物.png\",\"displayName\":\"人物\"}]}}";
        let mut entry = record("stable-text", "paused");
        entry.node_snapshot["config"]["checkpoint"]["manifest"] = json!(manifest);
        entry.node_snapshot["config"]["checkpoint"]["inputSignature"] = json!(input_signature);
        save(&storage, entry).unwrap();
        let detail = storage.get_workflow_history("stable-text").unwrap();
        assert_eq!(
            detail.record.node_snapshot["config"]["checkpoint"]["manifest"],
            manifest
        );
        assert_eq!(
            detail.record.node_snapshot["config"]["checkpoint"]["inputSignature"],
            input_signature
        );
    }
}
