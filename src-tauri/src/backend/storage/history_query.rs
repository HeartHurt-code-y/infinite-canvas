//! History predicates are added only when enabled, so scope/range indexes remain usable.
//! SQL fragments are static; all request values, including cursors and search, stay bound.

use rusqlite::types::Value as SqlValue;
use serde::Serialize;

use super::{task_summary_sql, workflow_history::WorkflowHistoryQuery};
use crate::backend::{error::BackendResult, types::GenerationTaskListQuery};

pub(super) struct HistoryListSql {
    pub sql: String,
    pub parameters: Vec<SqlValue>,
}

#[derive(Default)]
struct HistoryFilters {
    predicates: Vec<&'static str>,
    parameters: Vec<SqlValue>,
}

impl HistoryFilters {
    fn scoped<T: Serialize>(
        canvas_id: Option<&str>,
        source_node_id: Option<&str>,
        statuses: Option<&T>,
        created_from: Option<i64>,
        created_to: Option<i64>,
    ) -> BackendResult<Self> {
        let mut filters = Self::default();
        if let Some(canvas_id) = canvas_id {
            filters.push("canvas_id = ?", [canvas_id.to_owned().into()]);
        }
        if let Some(source_node_id) = source_node_id {
            filters.push("source_node_id = ?", [source_node_id.to_owned().into()]);
        }
        if let Some(statuses) = statuses {
            // JSON keeps the number of bindings bounded, even for a large status list.
            // An explicitly empty list must still match nothing, unlike an absent filter.
            filters.push(
                "status IN (SELECT value FROM json_each(?))",
                [serde_json::to_string(statuses)?.into()],
            );
        }
        if let Some(created_from) = created_from {
            filters.push("created_at >= ?", [created_from.into()]);
        }
        if let Some(created_to) = created_to {
            filters.push("created_at <= ?", [created_to.into()]);
        }
        Ok(filters)
    }

    fn push(&mut self, predicate: &'static str, parameters: impl IntoIterator<Item = SqlValue>) {
        self.predicates.push(predicate);
        self.parameters.extend(parameters);
    }

    fn where_clause(&self) -> String {
        if self.predicates.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.predicates.join(" AND "))
        }
    }
}

pub(super) fn tasks(
    query: &GenerationTaskListQuery,
    fetch_limit: i64,
) -> BackendResult<HistoryListSql> {
    let mut filters = HistoryFilters::scoped(
        query.canvas_id.as_deref(),
        query.source_node_id.as_deref(),
        query.statuses.as_ref(),
        query.created_from,
        query.created_to,
    )?;
    if let Some(cursor) = &query.cursor {
        filters.push(
            "(created_at < ? OR (created_at = ? AND id > ?))",
            [
                cursor.created_at.into(),
                cursor.created_at.into(),
                cursor.id.clone().into(),
            ],
        );
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        filters.push(
            "(instr(lower(COALESCE(json_extract(logical_request_json, '$.outputName'), '')), lower(?)) > 0
              OR instr(lower(id), lower(?)) > 0 OR instr(lower(COALESCE(remote_task_id, '')), lower(?)) > 0
              OR EXISTS (SELECT 1 FROM generation_results r WHERE r.task_id = generation_tasks.id AND instr(lower(COALESCE(r.final_path, '')), lower(?)) > 0)
              OR EXISTS (SELECT 1 FROM generation_result_names n WHERE n.task_id = generation_tasks.id AND instr(lower(n.name), lower(?)) > 0))",
            std::iter::repeat_n(SqlValue::Text(search.to_owned()), 5),
        );
    }
    let sql = format!(
        "{} ORDER BY created_at DESC, id ASC LIMIT ?",
        task_summary_sql(&filters.where_clause()),
    );
    filters.parameters.push(fetch_limit.into());
    Ok(HistoryListSql {
        sql,
        parameters: filters.parameters,
    })
}

pub(super) fn workflows(
    query: &WorkflowHistoryQuery,
    fetch_limit: i64,
    offset: i64,
) -> BackendResult<HistoryListSql> {
    let mut filters = HistoryFilters::scoped(
        query.canvas_id.as_deref(),
        query.source_node_id.as_deref(),
        query.statuses.as_ref(),
        query.created_from,
        query.created_to,
    )?;
    let sql = format!(
        "SELECT id,canvas_id,source_node_id,workflow_kind,title,status,progress,created_at,updated_at
         FROM workflow_history {} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
        filters.where_clause(),
    );
    filters
        .parameters
        .extend([fetch_limit.into(), offset.into()]);
    Ok(HistoryListSql {
        sql,
        parameters: filters.parameters,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, params_from_iter};
    use serde_json::json;

    use super::*;
    use crate::backend::{
        storage::{NewTask, Storage},
        types::GenerationOperation,
    };

    fn storage() -> (tempfile::TempDir, Storage) {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("history-query.sqlite")).unwrap();
        (directory, storage)
    }

    fn assert_scope_index(storage: &Storage, query: HistoryListSql, index: &str) {
        let connection = storage.lock().unwrap();
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {}", query.sql))
            .unwrap();
        let plan = statement
            .query_map(params_from_iter(query.parameters), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|step| step.contains("SEARCH ") && step.contains(index)),
            "expected {index}, got {plan:?}",
        );
        eprintln!("{index}: {plan:?}");
    }

    #[test]
    fn sql_conditions_use_existing_scope_indexes_in_bundled_sqlite() {
        let (_directory, storage) = storage();
        for (field, generation_index, workflow_index) in [
            (
                "canvasId",
                "idx_generation_tasks_canvas_created",
                "idx_workflow_history_canvas",
            ),
            (
                "sourceNodeId",
                "idx_generation_tasks_node_created",
                "idx_workflow_history_node",
            ),
        ] {
            let mut value = json!({"createdFrom": 0, "createdTo": 10000});
            value[field] = json!("scope'with-quotes");
            let task_query: GenerationTaskListQuery =
                serde_json::from_value(value.clone()).unwrap();
            let workflow_query: WorkflowHistoryQuery = serde_json::from_value(value).unwrap();
            assert_scope_index(&storage, tasks(&task_query, 51).unwrap(), generation_index);
            assert_scope_index(
                &storage,
                workflows(&workflow_query, 51, 0).unwrap(),
                workflow_index,
            );
        }
    }

    // Characterize the previous query against real list calls, including absent/empty
    // filters and composite cursor boundaries. The old OR form is only a test oracle.
    #[test]
    fn sql_conditions_preserve_task_filters_search_and_composite_pages() {
        let (_directory, storage) = storage();
        let provider = storage.get_provider_connection("provider-sd20").unwrap();
        for index in 0..7 {
            let id = format!("task-{index}");
            storage
                .insert_task(NewTask {
                    id: &id,
                    canvas_id: if index % 3 == 0 { "other" } else { "scope'quoted" },
                    source_node_id: if index % 2 == 0 { "node" } else { "other" },
                    operation: GenerationOperation::TextToImage,
                    provider: &provider,
                    api_key_ref: &provider.api_key_ref,
                    model_definition_id: "gpt-image-2",
                    remote_model_id: Some("gpt-image-2"),
                    logical_request: &json!({"outputName": if index % 2 == 0 { "NeEdLe" } else { "plain" }}),
                })
                .unwrap();
            storage
                .lock()
                .unwrap()
                .execute(
                    "UPDATE generation_tasks SET created_at=?1,status=?2 WHERE id=?3",
                    params![
                        1000 + i64::try_from(index / 2).unwrap() * 1000,
                        ["created", "failed", "succeeded"][index % 3],
                        id
                    ],
                )
                .unwrap();
        }
        const LEGACY: &str = "SELECT id FROM generation_tasks
            WHERE (?1 IS NULL OR canvas_id=?1)
            AND (?2 IS NULL OR source_node_id=?2)
            AND (?3 IS NULL OR status IN (SELECT value FROM json_each(?3)))
            AND (?4 IS NULL OR created_at < ?4 OR (created_at=?4 AND id > ?9))
            AND (?5 IS NULL OR created_at >= ?5) AND (?6 IS NULL OR created_at <= ?6)
            AND (?8 IS NULL OR instr(lower(COALESCE(json_extract(logical_request_json,'$.outputName'),'')),lower(?8)) > 0
              OR instr(lower(id),lower(?8)) > 0 OR instr(lower(COALESCE(remote_task_id,'')),lower(?8)) > 0
              OR EXISTS (SELECT 1 FROM generation_results r WHERE r.task_id=generation_tasks.id AND instr(lower(COALESCE(r.final_path,'')),lower(?8)) > 0)
              OR EXISTS (SELECT 1 FROM generation_result_names n WHERE n.task_id=generation_tasks.id AND instr(lower(n.name),lower(?8)) > 0))
            ORDER BY created_at DESC,id ASC LIMIT ?7";
        for mask in 0..64 {
            for statuses in [json!(null), json!([]), json!(["created", "failed"])] {
                let query: GenerationTaskListQuery = serde_json::from_value(json!({
                    "canvasId": (mask & 1 != 0).then_some("scope'quoted"),
                    "sourceNodeId": (mask & 2 != 0).then_some("node"),
                    "createdFrom": (mask & 4 != 0).then_some(2000),
                    "createdTo": (mask & 8 != 0).then_some(3000),
                    "cursor": (mask & 16 != 0).then_some(json!({"createdAt": 2000, "id": "task-2"})),
                    "search": (mask & 32 != 0).then_some(" nEEdLE "),
                    "statuses": statuses,
                    "limit": 2,
                }))
                .unwrap();
                let expected = {
                    let connection = storage.lock().unwrap();
                    let mut statement = connection.prepare(LEGACY).unwrap();
                    statement
                        .query_map(
                            params![
                                query.canvas_id,
                                query.source_node_id,
                                query
                                    .statuses
                                    .as_ref()
                                    .map(serde_json::to_string)
                                    .transpose()
                                    .unwrap(),
                                query.cursor.as_ref().map(|cursor| cursor.created_at),
                                query.created_from,
                                query.created_to,
                                3,
                                query.search.as_deref().map(str::trim),
                                query.cursor.as_ref().map(|cursor| cursor.id.as_str()),
                            ],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                };
                let actual = storage.list_tasks(&query).unwrap();
                assert_eq!(actual.next_cursor.is_some(), expected.len() > 2);
                assert_eq!(
                    actual
                        .items
                        .iter()
                        .map(|item| item.id.as_str())
                        .collect::<Vec<_>>(),
                    expected
                        .iter()
                        .take(2)
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    "task filter mask {mask}, statuses {:?}",
                    query.statuses,
                );
            }
        }
    }

    #[test]
    fn sql_conditions_preserve_workflow_filters_empty_statuses_and_offset_pages() {
        let (_directory, storage) = storage();
        for index in 0..7 {
            storage.lock().unwrap().execute(
                "INSERT INTO workflow_history(id,canvas_id,source_node_id,workflow_kind,status,revision,created_at,updated_at,title,progress,record_json)
                 VALUES(?1,?2,?3,'knowledge',?4,1,?5,?6,'工作流',0,'{}')",
                params![format!("run-{index}"), if index % 3 == 0 { "other" } else { "scope'quoted" },
                    if index % 2 == 0 { "node" } else { "other" }, ["done", "failed", "paused"][index % 3],
                    1000 + i64::try_from(index / 2).unwrap() * 1000, 10000 - i64::try_from(index).unwrap()],
            ).unwrap();
        }
        const LEGACY: &str = "SELECT id FROM workflow_history
            WHERE (?1 IS NULL OR canvas_id=?1) AND (?2 IS NULL OR source_node_id=?2)
            AND (?3 IS NULL OR status IN (SELECT value FROM json_each(?3)))
            AND (?4 IS NULL OR created_at >= ?4) AND (?5 IS NULL OR created_at <= ?5)
            ORDER BY updated_at DESC,id LIMIT ?6 OFFSET ?7";
        for mask in 0..16 {
            for statuses in [
                json!(null),
                json!([]),
                json!(["done", "failed"]),
                json!(["' OR 1=1 --"]),
            ] {
                for offset in [0, 1] {
                    let query: WorkflowHistoryQuery = serde_json::from_value(json!({
                        "canvasId": (mask & 1 != 0).then_some("scope'quoted"),
                        "sourceNodeId": (mask & 2 != 0).then_some("node"),
                        "createdFrom": (mask & 4 != 0).then_some(2000),
                        "createdTo": (mask & 8 != 0).then_some(3000),
                        "statuses": statuses,
                        "cursor": offset.to_string(),
                        "limit": 2,
                    }))
                    .unwrap();
                    let expected = {
                        let connection = storage.lock().unwrap();
                        let mut statement = connection.prepare(LEGACY).unwrap();
                        statement
                            .query_map(
                                params![
                                    query.canvas_id,
                                    query.source_node_id,
                                    query
                                        .statuses
                                        .as_ref()
                                        .map(serde_json::to_string)
                                        .transpose()
                                        .unwrap(),
                                    query.created_from,
                                    query.created_to,
                                    3,
                                    offset
                                ],
                                |row| row.get::<_, String>(0),
                            )
                            .unwrap()
                            .collect::<Result<Vec<_>, _>>()
                            .unwrap()
                    };
                    let actual = storage.list_workflow_history(query).unwrap();
                    assert_eq!(
                        actual.next_cursor,
                        (expected.len() > 2).then(|| (offset + 2).to_string())
                    );
                    assert_eq!(
                        actual
                            .items
                            .iter()
                            .map(|item| item.id.as_str())
                            .collect::<Vec<_>>(),
                        expected
                            .iter()
                            .take(2)
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        "workflow filter mask {mask}, offset {offset}",
                    );
                }
            }
        }
    }
}
