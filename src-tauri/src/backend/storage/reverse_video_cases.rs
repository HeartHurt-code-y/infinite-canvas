use rusqlite::params;
use serde_json::Value;

use super::{Storage, now_ms};
use crate::backend::error::BackendResult;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS reverse_video_cases (
  run_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  case_json TEXT NOT NULL
);
"#;

impl Storage {
    /// The caller finishes every delivery file before committing the case.
    pub(crate) fn save_reverse_video_case(
        &self,
        run_id: &str,
        record: &Value,
    ) -> BackendResult<u32> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO reverse_video_cases(run_id,created_at,updated_at,case_json) VALUES(?1,?2,?2,?3) ON CONFLICT(run_id) DO UPDATE SET updated_at=excluded.updated_at,case_json=excluded.case_json",
            params![run_id, now_ms(), serde_json::to_string(record)?],
        )?;
        let count =
            transaction.query_row("SELECT COUNT(*) FROM reverse_video_cases", [], |row| {
                row.get(0)
            })?;
        transaction.commit()?;
        Ok(count)
    }

    pub(crate) fn reverse_video_cases(&self) -> BackendResult<Vec<Value>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT case_json FROM reverse_video_cases ORDER BY created_at,run_id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}
