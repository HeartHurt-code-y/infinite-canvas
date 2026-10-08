use super::*;
use crate::backend::frame_extractor::VideoFrameExtractionJobRecord;

impl Storage {
    /// Keep the request and every frame checkpoint in the existing workspace DB.
    pub fn ensure_frame_extraction_storage(&self) -> BackendResult<()> {
        self.lock()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS video_frame_extraction_jobs (
               job_id TEXT PRIMARY KEY,
               record_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_video_frame_extraction_updated
               ON video_frame_extraction_jobs(updated_at DESC);",
        )?;
        Ok(())
    }

    pub fn save_frame_extraction_job(
        &self,
        record: &VideoFrameExtractionJobRecord,
    ) -> BackendResult<()> {
        self.lock()?.execute(
            "INSERT INTO video_frame_extraction_jobs(job_id, record_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(job_id) DO UPDATE SET record_json = excluded.record_json,
               updated_at = excluded.updated_at",
            params![
                record.job_id,
                serde_json::to_string(record)?,
                record.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_frame_extraction_job(
        &self,
        job_id: &str,
    ) -> BackendResult<Option<VideoFrameExtractionJobRecord>> {
        let encoded: Option<String> = self
            .lock()?
            .query_row(
                "SELECT record_json FROM video_frame_extraction_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .optional()?;
        encoded
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn list_frame_extraction_jobs(&self) -> BackendResult<Vec<VideoFrameExtractionJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT record_json FROM video_frame_extraction_jobs ORDER BY updated_at DESC",
        )?;
        let encoded = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        encoded
            .into_iter()
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .collect()
    }
}
