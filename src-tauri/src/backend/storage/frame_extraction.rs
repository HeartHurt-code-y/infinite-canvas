use super::*;
use crate::backend::frame_extractor::{ExtractedFrame, VideoFrameExtractionJobRecord};

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
               ON video_frame_extraction_jobs(updated_at DESC);
             CREATE TABLE IF NOT EXISTS video_frame_extraction_checkpoints (
               job_id TEXT PRIMARY KEY,
               frame_count INTEGER NOT NULL,
               progress REAL NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS video_frame_extraction_frame_checkpoints (
               job_id TEXT NOT NULL,
               frame_index INTEGER NOT NULL,
               frame_json TEXT NOT NULL,
               PRIMARY KEY (job_id, frame_index)
             );",
        )?;
        Ok(())
    }

    pub fn save_frame_extraction_job(
        &self,
        record: &VideoFrameExtractionJobRecord,
    ) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
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
        // Phase changes compact incremental checkpoints into the complete legacy record.
        transaction.execute(
            "DELETE FROM video_frame_extraction_checkpoints WHERE job_id = ?1",
            params![record.job_id],
        )?;
        transaction.execute(
            "DELETE FROM video_frame_extraction_frame_checkpoints WHERE job_id = ?1",
            params![record.job_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Write only this frame and constant-size progress, without re-encoding the request/history.
    pub fn checkpoint_frame_extraction(
        &self,
        job_id: &str,
        index: usize,
        frame: &ExtractedFrame,
        progress: f64,
        updated_at: i64,
    ) -> BackendResult<()> {
        let index = i64::try_from(index)
            .ok()
            .filter(|index| *index < i64::MAX)
            .ok_or_else(|| BackendError::protocol("抽帧数量过大，无法保存进度", Value::Null))?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "INSERT INTO video_frame_extraction_checkpoints(job_id, frame_count, progress, updated_at)
             SELECT job_id, ?2, ?3, ?4 FROM video_frame_extraction_jobs WHERE job_id = ?1
             ON CONFLICT(job_id) DO UPDATE SET frame_count = excluded.frame_count,
               progress = excluded.progress, updated_at = excluded.updated_at",
            params![job_id, index + 1, progress, updated_at],
        )?;
        if changed == 0 {
            return Err(BackendError::NotFound(format!(
                "frame extraction job {job_id}"
            )));
        }
        transaction.execute(
            "INSERT INTO video_frame_extraction_frame_checkpoints(job_id, frame_index, frame_json)
             VALUES (?1, ?2, ?3) ON CONFLICT(job_id, frame_index)
             DO UPDATE SET frame_json = excluded.frame_json",
            params![job_id, index, serde_json::to_string(frame)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get_frame_extraction_job(
        &self,
        job_id: &str,
    ) -> BackendResult<Option<VideoFrameExtractionJobRecord>> {
        let connection = self.lock()?;
        let encoded: Option<String> = connection
            .query_row(
                "SELECT record_json FROM video_frame_extraction_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .optional()?;
        encoded
            .map(|value| restore_frame_checkpoints(&connection, &value))
            .transpose()
    }

    pub fn list_frame_extraction_jobs(&self) -> BackendResult<Vec<VideoFrameExtractionJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT jobs.record_json FROM video_frame_extraction_jobs jobs
             LEFT JOIN video_frame_extraction_checkpoints checkpoint USING(job_id)
             ORDER BY COALESCE(checkpoint.updated_at, jobs.updated_at) DESC",
        )?;
        let encoded = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        encoded
            .into_iter()
            .map(|value| restore_frame_checkpoints(&connection, &value))
            .collect()
    }
}

fn restore_frame_checkpoints(
    connection: &Connection,
    encoded: &str,
) -> BackendResult<VideoFrameExtractionJobRecord> {
    let mut record: VideoFrameExtractionJobRecord = serde_json::from_str(encoded)?;
    let checkpoint: Option<(i64, f64, i64)> = connection
        .query_row(
            "SELECT frame_count, progress, updated_at FROM video_frame_extraction_checkpoints
             WHERE job_id = ?1",
            params![record.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((count, progress, updated_at)) = checkpoint {
        let frame_count = usize::try_from(count).map_err(|_| {
            BackendError::protocol("抽帧检查点数量异常，请重新创建抽帧任务", Value::Null)
        })?;
        record.frames.truncate(frame_count);
        let mut statement = connection.prepare_cached(
            "SELECT frame_index, frame_json FROM video_frame_extraction_frame_checkpoints
             WHERE job_id = ?1 AND frame_index < ?2 ORDER BY frame_index",
        )?;
        let rows = statement.query_map(params![record.job_id, count], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (index, frame) = row?;
            let index = usize::try_from(index).map_err(|_| {
                BackendError::protocol("抽帧检查点顺序异常，请重新创建抽帧任务", Value::Null)
            })?;
            let frame = serde_json::from_str(&frame)?;
            if index < record.frames.len() {
                record.frames[index] = frame;
            } else if index == record.frames.len() {
                record.frames.push(frame);
            } else {
                return Err(BackendError::protocol(
                    "抽帧检查点不完整，请重新创建抽帧任务",
                    Value::Null,
                ));
            }
        }
        if record.frames.len() != frame_count {
            return Err(BackendError::protocol(
                "抽帧检查点不完整，请重新创建抽帧任务",
                Value::Null,
            ));
        }
        record.progress = Some(progress);
        record.updated_at = updated_at;
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(index: usize) -> ExtractedFrame {
        ExtractedFrame {
            path: format!("/frames/{index}.jpg"),
            timestamp_seconds: index as f64,
            width: 16,
            height: 16,
            byte_size: 128,
            sha256: "a".repeat(64),
        }
    }

    fn record(job_id: &str) -> VideoFrameExtractionJobRecord {
        serde_json::from_value(json!({
            "jobId": job_id, "videoPath": "/video.mp4", "status": "processing",
            "progress": 0.0, "frames": [], "error": null, "createdAt": 1, "updatedAt": 2,
            "requestedTimestamps": (0..100).collect::<Vec<_>>(),
            "resolvedTimestamps": (0..100).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[test]
    fn incremental_frames_restore_without_rewriting_the_full_record_and_compact_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite");
        let storage = Storage::open(&path).unwrap();
        storage.ensure_frame_extraction_storage().unwrap();
        let mut saved = record("frames");
        saved.frames.push(frame(0));
        storage.save_frame_extraction_job(&saved).unwrap();
        let original: String = storage
            .lock()
            .unwrap()
            .query_row(
                "SELECT record_json FROM video_frame_extraction_jobs WHERE job_id = 'frames'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for index in 0..100 {
            storage
                .checkpoint_frame_extraction(
                    "frames",
                    index,
                    &frame(index),
                    (index as f64).min(99.0),
                    index as i64 + 10,
                )
                .unwrap();
        }
        let unchanged: String = storage
            .lock()
            .unwrap()
            .query_row(
                "SELECT record_json FROM video_frame_extraction_jobs WHERE job_id = 'frames'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original, unchanged);
        drop(storage);
        let storage = Storage::open(&path).unwrap();
        storage.ensure_frame_extraction_storage().unwrap();
        let mut restored = storage.get_frame_extraction_job("frames").unwrap().unwrap();
        assert_eq!(restored.frames.len(), 100);
        assert_eq!(restored.frames[99].path, "/frames/99.jpg");
        assert_eq!(restored.requested_timestamps, saved.requested_timestamps);
        assert_eq!(restored.progress, Some(99.0));
        assert_eq!(restored.updated_at, 109);
        assert_eq!(
            storage.list_frame_extraction_jobs().unwrap()[0]
                .frames
                .len(),
            100
        );
        restored.status = crate::backend::frame_extractor::VideoFrameExtractionStatus::Completed;
        restored.progress = Some(100.0);
        storage.save_frame_extraction_job(&restored).unwrap();
        let remaining: i64 = storage
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM video_frame_extraction_frame_checkpoints",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(
            storage
                .get_frame_extraction_job("frames")
                .unwrap()
                .unwrap()
                .frames
                .len(),
            100
        );
    }

    #[test]
    fn checkpoint_rolls_back_progress_if_the_frame_cannot_be_saved() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("workspace.sqlite")).unwrap();
        storage.ensure_frame_extraction_storage().unwrap();
        storage
            .save_frame_extraction_job(&record("frames"))
            .unwrap();
        storage
            .checkpoint_frame_extraction("frames", 0, &frame(0), 1.0, 10)
            .unwrap();
        storage.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_frame_checkpoint BEFORE INSERT ON video_frame_extraction_frame_checkpoints
             BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;"
        ).unwrap();
        assert!(
            storage
                .checkpoint_frame_extraction("frames", 1, &frame(1), 2.0, 11)
                .is_err()
        );
        let restored = storage.get_frame_extraction_job("frames").unwrap().unwrap();
        assert_eq!(restored.frames.len(), 1);
        assert_eq!(restored.progress, Some(1.0));
        assert_eq!(restored.updated_at, 10);
        assert!(
            storage
                .checkpoint_frame_extraction("missing", 0, &frame(0), 1.0, 10)
                .is_err()
        );
    }
}
