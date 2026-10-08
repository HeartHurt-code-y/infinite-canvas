//! Durable local media jobs. JSON stores the stable source; no preview lease enters history.
use rusqlite::{OptionalExtension, params};

use super::Storage;
use crate::backend::{
    error::BackendResult,
    video_preparation::{VideoPreparationJobRecord, VideoPreparationStatus},
};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS video_preparation_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_preparation_updated
  ON video_preparation_jobs(updated_at DESC, job_id);
"#;

impl Storage {
    pub(crate) fn initialize_video_preparation(&self) -> BackendResult<()> {
        let mut connection = self.lock()?;
        connection.execute_batch(SCHEMA)?;
        let transaction = connection.transaction()?;
        let mut interrupted = Vec::new();
        {
            let mut statement = transaction.prepare(
                "SELECT record_json FROM video_preparation_jobs WHERE status IN ('preparing','processing')",
            )?;
            for row in statement.query_map([], |row| row.get::<_, String>(0))? {
                let mut record: VideoPreparationJobRecord = serde_json::from_str(&row?)?;
                record.status = VideoPreparationStatus::Paused;
                record.updated_at = chrono::Utc::now().timestamp_millis();
                record.error = Some(
                    "应用已重启，任务已暂停。继续时会重新校验原片并从本次区间开始处理。".into(),
                );
                interrupted.push(record);
            }
        }
        for record in interrupted {
            transaction.execute(
                "UPDATE video_preparation_jobs SET status='paused', updated_at=?2, record_json=?3 WHERE job_id=?1",
                params![record.job_id, record.updated_at, serde_json::to_string(&record)?],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn save_video_preparation(
        &self,
        record: &VideoPreparationJobRecord,
    ) -> BackendResult<()> {
        self.lock()?.execute(
            "INSERT INTO video_preparation_jobs(job_id,status,updated_at,record_json) VALUES(?1,?2,?3,?4) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,record_json=excluded.record_json",
            params![record.job_id, record.status.as_str(), record.updated_at, serde_json::to_string(record)?],
        )?;
        Ok(())
    }

    /// A worker cannot turn a persisted cancellation back into progress or completion.
    pub(crate) fn save_active_video_preparation(
        &self,
        record: &VideoPreparationJobRecord,
    ) -> BackendResult<bool> {
        Ok(self.lock()?.execute(
            "UPDATE video_preparation_jobs SET status=?2, updated_at=?3, record_json=?4 WHERE job_id=?1 AND status IN ('preparing','processing')",
            params![record.job_id, record.status.as_str(), record.updated_at, serde_json::to_string(record)?],
        )? == 1)
    }

    pub(crate) fn video_preparation_job(
        &self,
        job_id: &str,
    ) -> BackendResult<Option<VideoPreparationJobRecord>> {
        self.lock()?
            .query_row(
                "SELECT record_json FROM video_preparation_jobs WHERE job_id=?1",
                [job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str(&json)?))
            .transpose()
    }

    pub(crate) fn video_preparation_jobs(&self) -> BackendResult<Vec<VideoPreparationJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT record_json FROM video_preparation_jobs ORDER BY updated_at DESC,job_id LIMIT 200",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
}
