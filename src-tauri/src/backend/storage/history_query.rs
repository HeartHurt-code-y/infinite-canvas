//! History predicates are added only when enabled, so scope/range indexes remain usable.
//! SQL fragments are static; all request values, including cursors and search, stay bound.

use rusqlite::types::Value as SqlValue;
use serde::Serialize;

use super::task_summary_sql;
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
