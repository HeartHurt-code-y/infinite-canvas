use super::*;

impl Storage {
    /// Look up only the remote identities on the requested page. Scope matching
    /// against the frozen endpoint and credential reference happens in the caller.
    pub fn find_remote_video_tasks(
        &self,
        provider_connection_id: &str,
        remote_task_ids: &[String],
    ) -> BackendResult<Vec<TaskExecutionRecord>> {
        if remote_task_ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id FROM generation_tasks
             WHERE operation = 'video_generation' AND provider_connection_id = ?1
               AND remote_task_id IN (SELECT value FROM json_each(?2))",
        )?;
        let ids = statement
            .query_map(
                params![
                    provider_connection_id,
                    serde_json::to_string(remote_task_ids)?
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        ids.iter().map(|id| self.get_task_execution(id)).collect()
    }
}
