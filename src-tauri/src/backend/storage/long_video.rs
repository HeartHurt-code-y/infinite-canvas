use super::Storage;
use crate::backend::{
    error::{BackendError, BackendResult},
    long_video::model::{LongVideoRecord, LongVideoStatus},
};
use rusqlite::{OptionalExtension, params};
use tauri_plugin_log::log::warn;

/// 逐行解析长视频记录，坏记录跳过而不是整体报错。
///
/// 长视频记录里嵌着共享的 `StartGenerationCommand`：那边一改字段形状，历史记录就解析不了。
/// 一条坏记录如果让存储层抛错，会顺着 `BackendState::initialize` 冒到启动路径上，
/// 变成「应用起不来」——为了几个长视频记录，把画布、素材、凭据一起赔进去。
fn parse_records(rows: impl Iterator<Item = rusqlite::Result<String>>) -> Vec<LongVideoRecord> {
    rows.filter_map(|row| match row {
        Ok(json) => match serde_json::from_str::<LongVideoRecord>(&json) {
            Ok(record) => Some(record),
            Err(error) => {
                warn!("[long-video] 跳过无法解析的长视频记录：{error}");
                None
            }
        },
        Err(error) => {
            warn!("[long-video] 读取长视频记录失败：{error}");
            None
        }
    })
    .collect()
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS long_video_jobs (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, canvas_id TEXT NOT NULL,
 source_node_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_long_video_canvas ON long_video_jobs(canvas_id,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_long_video_active_node ON long_video_jobs(canvas_id,source_node_id)
 WHERE status NOT IN ('completed','cancelled');
"#;

impl Storage {
    pub(crate) fn initialize_long_video(&self) -> BackendResult<()> {
        self.lock()?.execute_batch(SCHEMA)?;
        let now = chrono::Utc::now().timestamp_millis();
        // 逐行处理，而不是一次性把整张表解析出来：
        // 一条坏记录既不能阻断启动，还要把它从「同一节点只能有一个活跃任务」的唯一索引里
        // 摘出去——否则它虽然看不见，却会挡住这个节点之后的新任务（插入时撞唯一约束）。
        let rows: Vec<(String, String)> = {
            let connection = self.lock()?;
            let mut query = connection.prepare("SELECT id, record_json FROM long_video_jobs")?;
            query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (id, json) in rows {
            let Ok(mut record) = serde_json::from_str::<LongVideoRecord>(&json) else {
                warn!("[long-video] 长视频记录 {id} 无法解析，已停用该记录（不影响应用启动）");
                self.lock()?.execute(
                    "UPDATE long_video_jobs SET status='cancelled', updated_at=?2 WHERE id=?1",
                    params![id, now],
                )?;
                continue;
            };
            if record.job.status.running() {
                record.job.status = LongVideoStatus::Paused;
                record.job.yield_reason = Some("restart".into());
                record.job.updated_at = now;
                record.job.revision += 1;
                record
                    .job
                    .events
                    .push(crate::backend::long_video::model::LongVideoEvent {
                        at: record.job.updated_at,
                        message: "应用已重启，任务已暂停；继续时会回读原片段任务。".into(),
                    });
                self.lock()?.execute(
                    "UPDATE long_video_jobs SET status=?2,updated_at=?3,record_json=?4 WHERE id=?1",
                    params![
                        record.job.id,
                        record.job.status.as_str(),
                        record.job.updated_at,
                        serde_json::to_string(&record)?
                    ],
                )?;
            }
        }
        Ok(())
    }
    pub(crate) fn insert_long_video(&self, record: &LongVideoRecord) -> BackendResult<()> {
        self.lock()?.execute("INSERT INTO long_video_jobs(id,request_id,canvas_id,source_node_id,status,updated_at,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![record.job.id,record.job.request_id,record.job.canvas_id,record.job.source_node_id,record.job.status.as_str(),record.job.updated_at,serde_json::to_string(record)?])?;
        Ok(())
    }
    pub(crate) fn long_video_record(&self, id: &str) -> BackendResult<LongVideoRecord> {
        self.lock()?
            .query_row(
                "SELECT record_json FROM long_video_jobs WHERE id=?1 OR request_id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| -> BackendResult<LongVideoRecord> { Ok(serde_json::from_str(&json)?) })
            .transpose()?
            .ok_or_else(|| BackendError::NotFound("长视频任务不存在。".into()))
    }
    pub(crate) fn long_video_records(
        &self,
        canvas_id: Option<&str>,
    ) -> BackendResult<Vec<LongVideoRecord>> {
        let connection = self.lock()?;
        let mut query = connection.prepare("SELECT record_json FROM long_video_jobs WHERE (?1 IS NULL OR canvas_id=?1) ORDER BY updated_at DESC")?;
        let rows = query.query_map([canvas_id], |row| row.get::<_, String>(0))?;
        Ok(parse_records(rows))
    }
    /// Read/modify/write under one SQLite transaction. Stale worker snapshots cannot undo pause/cancel.
    ///
    /// `revision` 是用户操作用的乐观锁：只有用户意图引起的状态变化才推进它。
    /// 后台进度回写（片段进度、合成进度）不推进——否则生成期间每 1.2 秒就会把用户的
    /// 确认动作判成「创作过程已更新」而挡回去。
    pub(crate) fn mutate_long_video<F>(&self, id: &str, change: F) -> BackendResult<LongVideoRecord>
    where
        F: FnOnce(&mut LongVideoRecord) -> BackendResult<()>,
    {
        self.write_long_video(id, change, true)
    }
    /// 后台观察写回：不推进 revision。
    pub(crate) fn observe_long_video<F>(
        &self,
        id: &str,
        change: F,
    ) -> BackendResult<LongVideoRecord>
    where
        F: FnOnce(&mut LongVideoRecord) -> BackendResult<()>,
    {
        self.write_long_video(id, change, false)
    }
    fn write_long_video<F>(
        &self,
        id: &str,
        change: F,
        bump_revision: bool,
    ) -> BackendResult<LongVideoRecord>
    where
        F: FnOnce(&mut LongVideoRecord) -> BackendResult<()>,
    {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let json: String = tx.query_row(
            "SELECT record_json FROM long_video_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        let mut record: LongVideoRecord = serde_json::from_str(&json)?;
        change(&mut record)?;
        if bump_revision {
            record.job.revision += 1;
        }
        record.job.updated_at = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "UPDATE long_video_jobs SET status=?2,updated_at=?3,record_json=?4 WHERE id=?1",
            params![
                id,
                record.job.status.as_str(),
                record.job.updated_at,
                serde_json::to_string(&record)?
            ],
        )?;
        tx.commit()?;
        Ok(record)
    }
    pub(crate) fn long_video_child_exists(&self, id: &str) -> BackendResult<bool> {
        Ok(self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE id=?1)",
            [id],
            |row| row.get(0),
        )?)
    }
    /// 删掉某个提交身份对应的长视频记录。
    ///
    /// 记录存在但解析不了时（共享结构改过形状），它会同时占着 `request_id` 的唯一约束，
    /// 让这个节点之后再也起不来长视频——只能先把这批废数据清掉。
    pub(crate) fn delete_long_video_by_request_id(&self, request_id: &str) -> BackendResult<()> {
        self.lock()?.execute(
            "DELETE FROM long_video_jobs WHERE request_id=?1",
            params![request_id],
        )?;
        Ok(())
    }
    /// 用新记录替换某个提交身份下的旧记录：**删除与插入在同一个事务里**。
    ///
    /// 分成两步的话，插入失败（旧记录已经删掉）就等于白丢一条任务——
    /// 标题、镜头、事件、成片指针全没了，用户只看到一句数据库错误。
    pub(crate) fn replace_long_video_by_request_id(
        &self,
        request_id: &str,
        record: &LongVideoRecord,
    ) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        tx.execute(
            "DELETE FROM long_video_jobs WHERE request_id=?1",
            params![request_id],
        )?;
        tx.execute(
            "INSERT INTO long_video_jobs(id,request_id,canvas_id,source_node_id,status,updated_at,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                record.job.id,
                record.job.request_id,
                record.job.canvas_id,
                record.job.source_node_id,
                record.job.status.as_str(),
                record.job.updated_at,
                serde_json::to_string(record)?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}
