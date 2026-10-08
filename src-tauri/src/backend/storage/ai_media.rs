//! Durable AI preparation jobs keep their original reference and each output index.
use rusqlite::{OptionalExtension, params};

use super::Storage;
use crate::backend::{
    ai_media::{AiMediaJobRecord, AiMediaStatus},
    error::BackendResult,
};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ai_media_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_media_updated ON ai_media_jobs(updated_at DESC, job_id);
"#;

impl Storage {
    pub(crate) fn initialize_ai_media(&self) -> BackendResult<()> {
        let mut connection = self.lock()?;
        connection.execute_batch(SCHEMA)?;
        let transaction = connection.transaction()?;
        let mut interrupted = Vec::new();
        {
            let mut statement = transaction.prepare(
                "SELECT record_json FROM ai_media_jobs WHERE status IN ('preparing','processing')",
            )?;
            for row in statement.query_map([], |row| row.get::<_, String>(0))? {
                let mut record: AiMediaJobRecord = serde_json::from_str(&row?)?;
                record.status = AiMediaStatus::Paused;
                record.updated_at = chrono::Utc::now().timestamp_millis();
                record.message =
                    Some("应用重启后任务已暂停，继续时将校验原素材并重新处理选定区间。".into());
                record.outputs.clear();
                interrupted.push(record);
            }
        }
        for record in interrupted {
            transaction.execute("UPDATE ai_media_jobs SET status='paused', updated_at=?2, record_json=?3 WHERE job_id=?1", params![record.job_id, record.updated_at, serde_json::to_string(&record)?])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn save_ai_media(&self, record: &AiMediaJobRecord) -> BackendResult<()> {
        self.lock()?.execute("INSERT INTO ai_media_jobs(job_id,status,updated_at,record_json) VALUES(?1,?2,?3,?4) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,record_json=excluded.record_json", params![record.job_id, record.status.as_str(), record.updated_at, serde_json::to_string(record)?])?;
        Ok(())
    }

    pub(crate) fn save_active_ai_media(&self, record: &AiMediaJobRecord) -> BackendResult<bool> {
        Ok(self.lock()?.execute("UPDATE ai_media_jobs SET status=?2,updated_at=?3,record_json=?4 WHERE job_id=?1 AND status IN ('preparing','processing')", params![record.job_id, record.status.as_str(), record.updated_at, serde_json::to_string(record)?])? == 1)
    }

    pub(crate) fn ai_media_job(&self, job_id: &str) -> BackendResult<Option<AiMediaJobRecord>> {
        self.lock()?
            .query_row(
                "SELECT record_json FROM ai_media_jobs WHERE job_id=?1",
                [job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str(&json)?))
            .transpose()
    }

    pub(crate) fn ai_media_jobs(&self) -> BackendResult<Vec<AiMediaJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT record_json FROM ai_media_jobs ORDER BY updated_at DESC,job_id LIMIT 200",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
}
