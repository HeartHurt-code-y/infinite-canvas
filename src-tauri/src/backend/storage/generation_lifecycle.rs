use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::{Storage, now_ms};
use crate::backend::{
    error::{BackendError, BackendResult},
    types::{
        GenerationOperation, GenerationResultRecord, GenerationTaskStatus, QueryHealth, SaveStatus,
        TokenUsage,
    },
};

/// 生成任务 lifecycle persistence 的 deep interface。
///
/// 调用方只提交已经发生的 typed fact。implementation 在一个 SQLite transaction
/// 内维护任务投影、执行尝试、远端身份、token、结果行和审计事件；网络与文件 I/O
/// 始终发生在 transaction 之外。
#[derive(Clone)]
pub struct GenerationTaskLifecycle {
    storage: Arc<Storage>,
}

impl GenerationTaskLifecycle {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }

    pub fn create(&self, task: super::NewTask<'_>) -> BackendResult<()> {
        self.storage.insert_task(task)
    }

    pub fn commit(
        &self,
        task_id: &str,
        fact: GenerationLifecycleFact,
    ) -> BackendResult<GenerationLifecycleReceipt> {
        self.storage.commit_generation_lifecycle(task_id, fact)
    }

    pub fn recover_interrupted_results(&self) -> BackendResult<Vec<GenerationResultRecord>> {
        self.storage.mark_incomplete_results_interrupted()
    }
}

#[derive(Debug, Clone)]
pub enum GenerationLifecycleFact {
    RecoveryRemoteResumed {
        remote_task_id: String,
    },
    RecoveryTerminated {
        conclusion: GenerationTaskStatus,
        error: Value,
    },
    ManualObservationRequested,
    ExecutionTerminated {
        conclusion: GenerationTaskStatus,
        error: Value,
    },
    BeginResolution {
        attempt_id: String,
    },
    BeginTextGeneration {
        attempt_id: String,
    },
    ExecutionRequestResolved {
        resolved_request: Value,
    },
    ResolutionSucceeded {
        attempt_id: String,
        resolved_request: Value,
    },
    ResolutionFailed {
        attempt_id: String,
        error: Value,
    },
    BeginSubmission {
        attempt_id: String,
        backoff_ms: Option<u64>,
    },
    SubmissionRetryScheduled {
        attempt_id: String,
        retry_index: u32,
        delay_ms: u64,
        error: Value,
    },
    SubmissionImagesAccepted {
        attempt_id: String,
        call_id: String,
        tokens: Option<TokenUsage>,
        results: Vec<GenerationResultRecord>,
    },
    SubmissionRemoteAccepted {
        attempt_id: String,
        call_id: String,
        tokens: Option<TokenUsage>,
        remote_task_id: String,
    },
    SubmissionTerminated {
        attempt_id: String,
        conclusion: GenerationTaskStatus,
        error: Value,
        retries_exhausted: bool,
    },
    BeginObservation {
        attempt_id: String,
        backoff_ms: Option<u64>,
    },
    ObservationRetryScheduled {
        attempt_id: String,
        retry_index: u32,
        delay_ms: u64,
        error: Value,
    },
    ObservationDegraded {
        attempt_id: String,
        error: Value,
    },
    ObservationTerminated {
        attempt_id: String,
        conclusion: GenerationTaskStatus,
        error: Value,
    },
    ObservationApplied {
        attempt_id: String,
        call_id: String,
        tokens: Option<TokenUsage>,
        observation: GenerationRemoteObservation,
    },
    TextGenerationSucceeded {
        attempt_id: String,
        call_id: String,
        tokens: Option<TokenUsage>,
        optimized_prompt: String,
        raw_model_output: String,
    },
    TextGenerationFailed {
        attempt_id: String,
        conclusion: GenerationTaskStatus,
        error: Value,
    },
    ProviderCallPrepared {
        call_id: String,
        attempt_id: String,
        phase: String,
        request: Value,
    },
    ProviderCallSent {
        call_id: String,
        sent_at: i64,
    },
    ProviderCallResponded {
        call_id: String,
        sent_at: i64,
        status: u16,
        headers: Value,
        raw_response: String,
    },
    ProviderCallFailed {
        call_id: String,
        sent_at: i64,
        error: Value,
    },
    ResultChanged {
        result: GenerationResultRecord,
    },
    OperationalEvent {
        event_type: GenerationOperationalEvent,
        payload: Value,
    },
}

#[derive(Debug, Clone)]
pub enum GenerationRemoteObservation {
    Queued { progress: Option<f64> },
    Running { progress: Option<f64> },
    Succeeded { result: GenerationResultRecord },
    Failed { progress: Option<f64>, error: Value },
    Unknown { progress: Option<f64>, error: Value },
}

#[derive(Debug, Clone, Copy)]
pub enum GenerationOperationalEvent {
    StagingCleanupFailed,
    LocalSaveRecovered,
    LocalSaveRecoveryFailed,
}

impl GenerationOperationalEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::StagingCleanupFailed => "staging_cleanup_failed",
            Self::LocalSaveRecovered => "local_save_recovered",
            Self::LocalSaveRecoveryFailed => "local_save_recovery_failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationLifecycleReceipt {
    pub transition: Option<PersistedTaskTransition>,
}

/// 生成任务 persistence 的唯一状态写 interface。
///
/// Variant 表达已经发生的领域事实；调用方不能直接补丁任务行。implementation
/// 负责推导目标状态、验证迁移，并把任务行与审计事件放进同一个 SQLite transaction。
#[derive(Debug, Clone)]
pub enum GenerationTaskTransition {
    BeginSubmitting,
    ScheduleSubmissionRetry,
    AcceptRemoteVideo { remote_task_id: String },
    ObserveQueued { progress: Option<f64> },
    ObserveRunning { progress: Option<f64> },
    Succeed,
    Fail { progress: Option<f64>, error: Value },
    BecomeUnknown { progress: Option<f64>, error: Value },
    Interrupt { error: Value },
    ChangeQueryHealth { health: QueryHealth },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PersistedTaskTransitionEvent {
    StateChanged {
        from_status: GenerationTaskStatus,
        status: GenerationTaskStatus,
        from_query_health: QueryHealth,
        query_health: QueryHealth,
        progress: Option<f64>,
        error: Option<Value>,
    },
    QueryHealthChanged {
        from_health: QueryHealth,
        health: QueryHealth,
    },
}

/// SQLite commit 后的规范化结果。`event == None` 表示等价迁移已经提交过，
/// 因而本次是幂等 no-op；调用方不得重复发送实时事件。
#[derive(Debug, Clone, PartialEq)]
pub struct PersistedTaskTransition {
    pub task_id: String,
    pub status: GenerationTaskStatus,
    pub query_health: QueryHealth,
    pub event: Option<PersistedTaskTransitionEvent>,
}

#[derive(Debug)]
struct CurrentTaskState {
    operation: GenerationOperation,
    status: GenerationTaskStatus,
    query_health: QueryHealth,
    remote_task_id: Option<String>,
    progress: Option<f64>,
    final_error: Option<Value>,
    completed_at: Option<i64>,
}

#[derive(Debug)]
struct NextTaskState {
    status: GenerationTaskStatus,
    query_health: QueryHealth,
    remote_task_id: Option<String>,
    progress: Option<f64>,
    final_error: Option<Value>,
    completed_at: Option<i64>,
    event: Option<PersistedTaskTransitionEvent>,
}

impl Storage {
    fn commit_generation_lifecycle(
        &self,
        task_id: &str,
        fact: GenerationLifecycleFact,
    ) -> BackendResult<GenerationLifecycleReceipt> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        ensure_task_exists(&transaction, task_id)?;
        let mut transition = None;

        match fact {
            GenerationLifecycleFact::RecoveryRemoteResumed { remote_task_id } => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::AcceptRemoteVideo { remote_task_id },
                )?);
            }
            GenerationLifecycleFact::RecoveryTerminated { conclusion, error }
            | GenerationLifecycleFact::ExecutionTerminated { conclusion, error } => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    terminal_transition(task_id, conclusion, error)?,
                )?);
            }
            GenerationLifecycleFact::ManualObservationRequested => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::ChangeQueryHealth {
                        health: QueryHealth::Healthy,
                    },
                )?);
            }
            GenerationLifecycleFact::BeginResolution { attempt_id } => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::BeginSubmitting,
                )?);
                insert_attempt(&transaction, task_id, &attempt_id, 1, "resolve", None)?;
            }
            GenerationLifecycleFact::BeginTextGeneration { attempt_id } => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::BeginSubmitting,
                )?);
                insert_attempt(
                    &transaction,
                    task_id,
                    &attempt_id,
                    1,
                    "text_generation",
                    None,
                )?;
            }
            GenerationLifecycleFact::ExecutionRequestResolved { resolved_request } => {
                persist_resolved_request(&transaction, task_id, &resolved_request)?;
            }
            GenerationLifecycleFact::ResolutionSucceeded {
                attempt_id,
                resolved_request,
            } => {
                finish_attempt(&transaction, task_id, &attempt_id, "succeeded", None)?;
                persist_resolved_request(&transaction, task_id, &resolved_request)?;
            }
            GenerationLifecycleFact::ResolutionFailed { attempt_id, error } => {
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::Fail {
                        progress: None,
                        error,
                    },
                )?);
            }
            GenerationLifecycleFact::BeginSubmission {
                attempt_id,
                backoff_ms,
            } => {
                let current = load_current_task_state(&transaction, task_id)?;
                if current.status == GenerationTaskStatus::RetryWait {
                    transition = Some(commit_task_transition_in(
                        &transaction,
                        task_id,
                        GenerationTaskTransition::BeginSubmitting,
                    )?);
                } else if current.status != GenerationTaskStatus::Submitting {
                    return Err(illegal_transition(
                        task_id,
                        current.status,
                        "begin a submission attempt",
                    ));
                }
                insert_attempt(
                    &transaction,
                    task_id,
                    &attempt_id,
                    next_attempt_number(&transaction, task_id, "submit")?,
                    "submit",
                    backoff_ms,
                )?;
            }
            GenerationLifecycleFact::SubmissionRetryScheduled {
                attempt_id,
                retry_index,
                delay_ms,
                error,
            } => {
                require_completed_call_for_attempt(&transaction, task_id, &attempt_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::ScheduleSubmissionRetry,
                )?);
                append_event(
                    &transaction,
                    task_id,
                    "automatic_retry",
                    &retry_payload(task_id, retry_index, delay_ms, &error, false),
                )?;
            }
            GenerationLifecycleFact::SubmissionImagesAccepted {
                attempt_id,
                call_id,
                tokens,
                results,
            } => {
                if results.is_empty() {
                    return Err(BackendError::validation(
                        "a successful image submission must contain at least one result",
                        json!({ "taskId": task_id }),
                    ));
                }
                require_successful_call(&transaction, task_id, &attempt_id, &call_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "succeeded", None)?;
                persist_tokens(&transaction, task_id, tokens.as_ref())?;
                for result in &results {
                    require_pending_result(task_id, result)?;
                    upsert_result(&transaction, result)?;
                }
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::Succeed,
                )?);
            }
            GenerationLifecycleFact::SubmissionRemoteAccepted {
                attempt_id,
                call_id,
                tokens,
                remote_task_id,
            } => {
                require_successful_call(&transaction, task_id, &attempt_id, &call_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "succeeded", None)?;
                persist_tokens(&transaction, task_id, tokens.as_ref())?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::AcceptRemoteVideo { remote_task_id },
                )?);
            }
            GenerationLifecycleFact::SubmissionTerminated {
                attempt_id,
                conclusion,
                error,
                retries_exhausted,
            } => {
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    terminal_transition(task_id, conclusion, error.clone())?,
                )?);
                if retries_exhausted {
                    append_event(
                        &transaction,
                        task_id,
                        "automatic_retry_exhausted",
                        &json!({ "taskId": task_id, "reason": error }),
                    )?;
                }
            }
            GenerationLifecycleFact::BeginObservation {
                attempt_id,
                backoff_ms,
            } => {
                require_remote_observation(
                    task_id,
                    &load_current_task_state(&transaction, task_id)?,
                )?;
                insert_attempt(
                    &transaction,
                    task_id,
                    &attempt_id,
                    next_attempt_number(&transaction, task_id, "observe")?,
                    "observe",
                    backoff_ms,
                )?;
            }
            GenerationLifecycleFact::ObservationRetryScheduled {
                attempt_id,
                retry_index,
                delay_ms,
                error,
            } => {
                require_completed_call_for_attempt(&transaction, task_id, &attempt_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::ChangeQueryHealth {
                        health: QueryHealth::RetryWait,
                    },
                )?);
                append_event(
                    &transaction,
                    task_id,
                    "automatic_retry",
                    &retry_payload(task_id, retry_index, delay_ms, &error, true),
                )?;
            }
            GenerationLifecycleFact::ObservationDegraded { attempt_id, error } => {
                require_completed_call_for_attempt(&transaction, task_id, &attempt_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::ChangeQueryHealth {
                        health: QueryHealth::Degraded,
                    },
                )?);
                append_event(
                    &transaction,
                    task_id,
                    "automatic_retry_exhausted",
                    &json!({ "taskId": task_id, "reason": error }),
                )?;
            }
            GenerationLifecycleFact::ObservationTerminated {
                attempt_id,
                conclusion,
                error,
            } => {
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    terminal_transition(task_id, conclusion, error)?,
                )?);
            }
            GenerationLifecycleFact::ObservationApplied {
                attempt_id,
                call_id,
                tokens,
                observation,
            } => {
                require_successful_call(&transaction, task_id, &attempt_id, &call_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "succeeded", None)?;
                persist_tokens(&transaction, task_id, tokens.as_ref())?;
                let applied = match observation {
                    GenerationRemoteObservation::Queued { progress } => {
                        GenerationTaskTransition::ObserveQueued { progress }
                    }
                    GenerationRemoteObservation::Running { progress } => {
                        GenerationTaskTransition::ObserveRunning { progress }
                    }
                    GenerationRemoteObservation::Succeeded { result } => {
                        require_pending_result(task_id, &result)?;
                        upsert_result(&transaction, &result)?;
                        GenerationTaskTransition::Succeed
                    }
                    GenerationRemoteObservation::Failed { progress, error } => {
                        GenerationTaskTransition::Fail { progress, error }
                    }
                    GenerationRemoteObservation::Unknown { progress, error } => {
                        GenerationTaskTransition::BecomeUnknown { progress, error }
                    }
                };
                transition = Some(commit_task_transition_in(&transaction, task_id, applied)?);
            }
            GenerationLifecycleFact::TextGenerationSucceeded {
                attempt_id,
                call_id,
                tokens,
                optimized_prompt,
                raw_model_output,
            } => {
                require_successful_call(&transaction, task_id, &attempt_id, &call_id)?;
                finish_attempt(&transaction, task_id, &attempt_id, "succeeded", None)?;
                persist_tokens(&transaction, task_id, tokens.as_ref())?;
                append_event(
                    &transaction,
                    task_id,
                    "text_output",
                    &json!({
                        "optimizedPrompt": optimized_prompt,
                        "rawModelOutput": raw_model_output,
                    }),
                )?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::Succeed,
                )?);
            }
            GenerationLifecycleFact::TextGenerationFailed {
                attempt_id,
                conclusion,
                error,
            } => {
                finish_attempt(&transaction, task_id, &attempt_id, "failed", Some(&error))?;
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    terminal_transition(task_id, conclusion, error)?,
                )?);
            }
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id,
                attempt_id,
                phase,
                request,
            } => insert_provider_call(
                &transaction,
                task_id,
                &call_id,
                &attempt_id,
                &phase,
                &request,
            )?,
            GenerationLifecycleFact::ProviderCallSent { call_id, sent_at } => {
                let updated = transaction.execute(
                    "UPDATE provider_calls SET sent_at = ?3
                     WHERE task_id = ?1 AND id = ?2
                       AND sent_at IS NULL AND response_received_at IS NULL",
                    params![task_id, call_id, sent_at],
                )?;
                require_single_call_update(task_id, &call_id, updated)?;
            }
            GenerationLifecycleFact::ProviderCallResponded {
                call_id,
                sent_at,
                status,
                headers,
                raw_response,
            } => {
                let received_at = now_ms();
                let updated = transaction.execute(
                    "UPDATE provider_calls SET response_received_at = ?4, duration_ms = ?5,
                            http_status = ?6, response_headers_json = ?7, raw_response = ?8
                     WHERE task_id = ?1 AND id = ?2
                       AND sent_at = ?3 AND response_received_at IS NULL",
                    params![
                        task_id,
                        call_id,
                        sent_at,
                        received_at,
                        received_at - sent_at,
                        status,
                        serde_json::to_string(&headers)?,
                        raw_response,
                    ],
                )?;
                require_single_call_update(task_id, &call_id, updated)?;
            }
            GenerationLifecycleFact::ProviderCallFailed {
                call_id,
                sent_at,
                error,
            } => {
                let received_at = now_ms();
                let updated = transaction.execute(
                    "UPDATE provider_calls SET response_received_at = ?4, duration_ms = ?5,
                            runtime_error_json = ?6
                     WHERE task_id = ?1 AND id = ?2
                       AND sent_at = ?3 AND response_received_at IS NULL",
                    params![
                        task_id,
                        call_id,
                        sent_at,
                        received_at,
                        received_at - sent_at,
                        serde_json::to_string(&error)?,
                    ],
                )?;
                require_single_call_update(task_id, &call_id, updated)?;
            }
            GenerationLifecycleFact::ResultChanged { result } => {
                if result.task_id != task_id {
                    return Err(BackendError::Conflict(format!(
                        "result belongs to task {}, not {task_id}",
                        result.task_id
                    )));
                }
                validate_result_change(&transaction, task_id, &result)?;
                upsert_result(&transaction, &result)?;
                append_event(
                    &transaction,
                    task_id,
                    "result_save_changed",
                    &json!({
                        "resultIndex": result.result_index,
                        "saveStatus": result.save_status,
                        "error": result.error,
                    }),
                )?;
            }
            GenerationLifecycleFact::OperationalEvent {
                event_type,
                payload,
            } => append_event(&transaction, task_id, event_type.as_str(), &payload)?,
        }

        transaction.commit()?;
        Ok(GenerationLifecycleReceipt { transition })
    }
}

fn commit_task_transition_in(
    transaction: &Transaction<'_>,
    task_id: &str,
    transition: GenerationTaskTransition,
) -> BackendResult<PersistedTaskTransition> {
    let current = load_current_task_state(transaction, task_id)?;
    let timestamp = now_ms();
    let next = decide_transition(task_id, &current, transition, timestamp)?;

    if next.event.is_none() {
        return Ok(PersistedTaskTransition {
            task_id: task_id.to_string(),
            status: current.status,
            query_health: current.query_health,
            event: None,
        });
    }

    let updated = transaction.execute(
        "UPDATE generation_tasks
         SET status = ?2, query_health = ?3, remote_task_id = ?4, progress = ?5,
             final_error_json = ?6, updated_at = ?7, completed_at = ?8
         WHERE id = ?1 AND status = ?9 AND query_health = ?10",
        params![
            task_id,
            next.status.as_str(),
            next.query_health.as_str(),
            next.remote_task_id,
            next.progress,
            next.final_error
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            timestamp,
            next.completed_at,
            current.status.as_str(),
            current.query_health.as_str(),
        ],
    )?;
    if updated != 1 {
        return Err(BackendError::Conflict(format!(
            "generation task {task_id} changed while committing a transition"
        )));
    }

    let (event_type, payload) = transition_event(next.event.as_ref().expect("checked above"));
    append_event_at(transaction, task_id, event_type, &payload, timestamp)?;
    Ok(PersistedTaskTransition {
        task_id: task_id.to_string(),
        status: next.status,
        query_health: next.query_health,
        event: next.event,
    })
}

fn ensure_task_exists(transaction: &Transaction<'_>, task_id: &str) -> BackendResult<()> {
    let exists = transaction
        .query_row(
            "SELECT 1 FROM generation_tasks WHERE id = ?1",
            params![task_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| BackendError::NotFound(format!("generation task {task_id}")))
}

fn load_current_task_state(
    transaction: &Transaction<'_>,
    task_id: &str,
) -> BackendResult<CurrentTaskState> {
    let row = transaction
        .query_row(
            "SELECT operation, status, query_health, remote_task_id, progress,
                    final_error_json, completed_at
             FROM generation_tasks WHERE id = ?1",
            params![task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| BackendError::NotFound(format!("generation task {task_id}")))?;
    Ok(CurrentTaskState {
        operation: GenerationOperation::try_from(row.0.as_str()).map_err(|error| {
            BackendError::Conflict(format!(
                "generation task {task_id} has invalid persisted operation: {error}"
            ))
        })?,
        status: GenerationTaskStatus::try_from(row.1.as_str()).map_err(|error| {
            BackendError::Conflict(format!(
                "generation task {task_id} has invalid persisted status: {error}"
            ))
        })?,
        query_health: parse_query_health(task_id, &row.2)?,
        remote_task_id: row.3,
        progress: row.4,
        final_error: row
            .5
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        completed_at: row.6,
    })
}

fn transition_event(event: &PersistedTaskTransitionEvent) -> (&'static str, Value) {
    match event {
        PersistedTaskTransitionEvent::StateChanged {
            from_status,
            status,
            from_query_health,
            query_health,
            progress,
            error,
        } => (
            "state_changed",
            json!({
                "fromStatus": from_status,
                "status": status,
                "fromQueryHealth": from_query_health,
                "queryHealth": query_health,
                "progress": progress,
                "error": error,
            }),
        ),
        PersistedTaskTransitionEvent::QueryHealthChanged {
            from_health,
            health,
        } => (
            "query_health_changed",
            json!({
                "fromQueryHealth": from_health,
                "queryHealth": health,
            }),
        ),
    }
}

fn insert_attempt(
    transaction: &Transaction<'_>,
    task_id: &str,
    attempt_id: &str,
    attempt_number: u32,
    phase: &str,
    backoff_ms: Option<u64>,
) -> BackendResult<()> {
    let backoff_ms = backoff_ms
        .map(|value| {
            i64::try_from(value).map_err(|_| {
                BackendError::validation(
                    "backoffMs exceeds the SQLite integer range",
                    json!({ "backoffMs": value }),
                )
            })
        })
        .transpose()?;
    transaction.execute(
        "INSERT INTO generation_attempts
         (id, task_id, attempt_number, phase, started_at, backoff_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            attempt_id,
            task_id,
            attempt_number,
            phase,
            now_ms(),
            backoff_ms
        ],
    )?;
    Ok(())
}

fn next_attempt_number(
    transaction: &Transaction<'_>,
    task_id: &str,
    phase: &str,
) -> BackendResult<u32> {
    let current = transaction.query_row(
        "SELECT COALESCE(MAX(attempt_number), 0)
         FROM generation_attempts WHERE task_id = ?1 AND phase = ?2",
        params![task_id, phase],
        |row| row.get::<_, u32>(0),
    )?;
    current.checked_add(1).ok_or_else(|| {
        BackendError::Conflict(format!(
            "generation task {task_id} exhausted attempt numbers for phase {phase}"
        ))
    })
}

fn finish_attempt(
    transaction: &Transaction<'_>,
    task_id: &str,
    attempt_id: &str,
    outcome: &str,
    error: Option<&Value>,
) -> BackendResult<()> {
    let updated = transaction.execute(
        "UPDATE generation_attempts
         SET finished_at = ?3, outcome = ?4, error_json = ?5
         WHERE task_id = ?1 AND id = ?2 AND finished_at IS NULL",
        params![
            task_id,
            attempt_id,
            now_ms(),
            outcome,
            error.map(serde_json::to_string).transpose()?,
        ],
    )?;
    if updated != 1 {
        return Err(BackendError::Conflict(format!(
            "generation attempt {attempt_id} for task {task_id} is missing or already finished"
        )));
    }
    Ok(())
}

fn persist_resolved_request(
    transaction: &Transaction<'_>,
    task_id: &str,
    request: &Value,
) -> BackendResult<()> {
    let serialized = serde_json::to_string(request)?;
    let existing = transaction.query_row(
        "SELECT resolved_request_json FROM generation_tasks WHERE id = ?1",
        params![task_id],
        |row| row.get::<_, Option<String>>(0),
    )?;
    if let Some(existing) = existing {
        if existing == serialized {
            return Ok(());
        }
        return Err(BackendError::Conflict(format!(
            "generation task {task_id} already has a different resolved request"
        )));
    }
    transaction.execute(
        "UPDATE generation_tasks SET resolved_request_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, serialized, now_ms()],
    )?;
    Ok(())
}

fn persist_tokens(
    transaction: &Transaction<'_>,
    task_id: &str,
    tokens: Option<&TokenUsage>,
) -> BackendResult<()> {
    let Some(tokens) = tokens else {
        return Ok(());
    };
    transaction.execute(
        "UPDATE generation_tasks SET tokens_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, serde_json::to_string(tokens)?, now_ms()],
    )?;
    Ok(())
}

fn require_pending_result(task_id: &str, result: &GenerationResultRecord) -> BackendResult<()> {
    if result.task_id != task_id || result.save_status != SaveStatus::Pending {
        return Err(BackendError::validation(
            "accepted generation results must belong to the task and start as pending",
            json!({
                "taskId": task_id,
                "resultTaskId": result.task_id,
                "resultIndex": result.result_index,
                "saveStatus": result.save_status,
            }),
        ));
    }
    Ok(())
}

fn validate_result_change(
    transaction: &Transaction<'_>,
    task_id: &str,
    result: &GenerationResultRecord,
) -> BackendResult<()> {
    let current = transaction
        .query_row(
            "SELECT media_type, remote_task_id, source_json, save_status
             FROM generation_results WHERE task_id = ?1 AND result_index = ?2",
            params![task_id, result.result_index],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            BackendError::Conflict(format!(
                "generation result {task_id}/{} must be registered by a successful lifecycle fact before it can be saved",
                result.result_index
            ))
        })?;
    if current.0 != result.media_type.as_str()
        || current.1 != result.remote_task_id
        || serde_json::from_str::<Value>(&current.2)? != result.source
    {
        return Err(BackendError::Conflict(format!(
            "generation result {task_id}/{} cannot change its persisted identity or source",
            result.result_index
        )));
    }
    let allowed = match current.3.as_str() {
        "pending" => matches!(
            result.save_status,
            SaveStatus::Pending | SaveStatus::Writing | SaveStatus::Interrupted
        ),
        "writing" => matches!(
            result.save_status,
            SaveStatus::Writing
                | SaveStatus::Succeeded
                | SaveStatus::Failed
                | SaveStatus::Interrupted
                | SaveStatus::Conflict
        ),
        "interrupted" => matches!(
            result.save_status,
            SaveStatus::Writing | SaveStatus::Failed | SaveStatus::Conflict
        ),
        "succeeded" => matches!(
            result.save_status,
            SaveStatus::Succeeded | SaveStatus::LocalMissing | SaveStatus::Conflict
        ),
        "failed" => result.save_status == SaveStatus::Failed,
        "local_missing" => result.save_status == SaveStatus::LocalMissing,
        "conflict" => result.save_status == SaveStatus::Conflict,
        status => {
            return Err(BackendError::Conflict(format!(
                "generation result {task_id}/{} has invalid persisted save status {status}",
                result.result_index
            )));
        }
    };
    if !allowed {
        return Err(BackendError::Conflict(format!(
            "generation result {task_id}/{} cannot change save status from {} to {}",
            result.result_index,
            current.3,
            result.save_status.as_str()
        )));
    }
    Ok(())
}

fn upsert_result(
    transaction: &Transaction<'_>,
    result: &GenerationResultRecord,
) -> BackendResult<()> {
    let byte_size = result
        .byte_size
        .map(|value| {
            i64::try_from(value).map_err(|_| {
                BackendError::validation(
                    "byteSize exceeds the SQLite integer range",
                    json!({ "byteSize": value }),
                )
            })
        })
        .transpose()?;
    transaction.execute(
        "INSERT INTO generation_results
         (task_id, result_index, media_type, remote_task_id, source_json, save_status,
          final_path, relative_path, byte_size, mime_type, sha256, saved_at, error_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(task_id, result_index) DO UPDATE SET
           source_json = excluded.source_json,
           save_status = excluded.save_status,
           final_path = excluded.final_path,
           relative_path = excluded.relative_path,
           byte_size = excluded.byte_size,
           mime_type = excluded.mime_type,
           sha256 = excluded.sha256,
           saved_at = excluded.saved_at,
           error_json = excluded.error_json",
        params![
            result.task_id,
            result.result_index,
            result.media_type.as_str(),
            result.remote_task_id,
            serde_json::to_string(&result.source)?,
            result.save_status.as_str(),
            result.final_path,
            result.relative_path,
            byte_size,
            result.mime_type,
            result.sha256,
            result.saved_at,
            result
                .error
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        ],
    )?;
    Ok(())
}

fn insert_provider_call(
    transaction: &Transaction<'_>,
    task_id: &str,
    call_id: &str,
    attempt_id: &str,
    phase: &str,
    request: &Value,
) -> BackendResult<()> {
    let attempt_exists = transaction
        .query_row(
            "SELECT 1 FROM generation_attempts
             WHERE task_id = ?1 AND id = ?2 AND finished_at IS NULL",
            params![task_id, attempt_id],
            |_| Ok(()),
        )
        .optional()?;
    if attempt_exists.is_none() {
        return Err(BackendError::Conflict(format!(
            "provider call {call_id} references missing attempt {attempt_id} for task {task_id}"
        )));
    }
    transaction.execute(
        "INSERT INTO provider_calls(id, task_id, attempt_id, phase, request_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            call_id,
            task_id,
            attempt_id,
            phase,
            serde_json::to_string(request)?,
        ],
    )?;
    Ok(())
}

fn require_successful_call(
    transaction: &Transaction<'_>,
    task_id: &str,
    attempt_id: &str,
    call_id: &str,
) -> BackendResult<()> {
    let status = transaction
        .query_row(
            "SELECT http_status FROM provider_calls
             WHERE task_id = ?1 AND attempt_id = ?2 AND id = ?3
               AND response_received_at IS NOT NULL",
            params![task_id, attempt_id, call_id],
            |row| row.get::<_, Option<u16>>(0),
        )
        .optional()?;
    match status.flatten() {
        Some(status) if (200..300).contains(&status) => Ok(()),
        _ => Err(BackendError::Conflict(format!(
            "generation task {task_id} cannot finish attempt {attempt_id} without successful call evidence {call_id}"
        ))),
    }
}

fn require_completed_call_for_attempt(
    transaction: &Transaction<'_>,
    task_id: &str,
    attempt_id: &str,
) -> BackendResult<()> {
    let exists = transaction
        .query_row(
            "SELECT 1 FROM provider_calls
             WHERE task_id = ?1 AND attempt_id = ?2
               AND response_received_at IS NOT NULL
             LIMIT 1",
            params![task_id, attempt_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| {
        BackendError::Conflict(format!(
            "generation task {task_id} cannot retry attempt {attempt_id} without completed call evidence"
        ))
    })
}

fn require_single_call_update(task_id: &str, call_id: &str, updated: usize) -> BackendResult<()> {
    if updated != 1 {
        return Err(BackendError::Conflict(format!(
            "provider call {call_id} does not belong to generation task {task_id}"
        )));
    }
    Ok(())
}

fn append_event(
    transaction: &Transaction<'_>,
    task_id: &str,
    event_type: &str,
    payload: &Value,
) -> BackendResult<()> {
    append_event_at(transaction, task_id, event_type, payload, now_ms())
}

fn append_event_at(
    transaction: &Transaction<'_>,
    task_id: &str,
    event_type: &str,
    payload: &Value,
    timestamp: i64,
) -> BackendResult<()> {
    transaction.execute(
        "INSERT INTO generation_task_events(task_id, event_type, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            task_id,
            event_type,
            serde_json::to_string(payload)?,
            timestamp,
        ],
    )?;
    Ok(())
}

fn retry_payload(
    task_id: &str,
    retry_index: u32,
    delay_ms: u64,
    error: &Value,
    query_only: bool,
) -> Value {
    json!({
        "taskId": task_id,
        "retry": retry_index,
        "maxRetries": 3,
        "delayMs": delay_ms,
        "queryOnly": query_only,
        "reason": error,
        "risk": "请求可能已被供应商接收，自动重试可能造成重复生成或重复计费"
    })
}

fn terminal_transition(
    task_id: &str,
    conclusion: GenerationTaskStatus,
    error: Value,
) -> BackendResult<GenerationTaskTransition> {
    match conclusion {
        GenerationTaskStatus::Failed => Ok(GenerationTaskTransition::Fail {
            progress: None,
            error,
        }),
        GenerationTaskStatus::Unknown => Ok(GenerationTaskTransition::BecomeUnknown {
            progress: None,
            error,
        }),
        GenerationTaskStatus::Interrupted => Ok(GenerationTaskTransition::Interrupt { error }),
        status => Err(BackendError::validation(
            "lifecycle terminal conclusion must be failed, unknown, or interrupted",
            json!({ "taskId": task_id, "status": status }),
        )),
    }
}

fn decide_transition(
    task_id: &str,
    current: &CurrentTaskState,
    transition: GenerationTaskTransition,
    timestamp: i64,
) -> BackendResult<NextTaskState> {
    if current.status.is_terminal() {
        return decide_terminal_replay(task_id, current, transition);
    }

    let mut next = NextTaskState {
        status: current.status,
        query_health: current.query_health,
        remote_task_id: current.remote_task_id.clone(),
        progress: current.progress,
        final_error: current.final_error.clone(),
        completed_at: current.completed_at,
        event: None,
    };
    let original_status = current.status;
    let original_health = current.query_health;

    match transition {
        GenerationTaskTransition::BeginSubmitting => {
            require_status(
                task_id,
                current.status,
                &[
                    GenerationTaskStatus::Created,
                    GenerationTaskStatus::RetryWait,
                ],
                "begin submitting",
            )?;
            next.status = GenerationTaskStatus::Submitting;
        }
        GenerationTaskTransition::ScheduleSubmissionRetry => {
            require_status(
                task_id,
                current.status,
                &[GenerationTaskStatus::Submitting],
                "schedule submission retry",
            )?;
            next.status = GenerationTaskStatus::RetryWait;
        }
        GenerationTaskTransition::AcceptRemoteVideo { remote_task_id } => {
            require_status(
                task_id,
                current.status,
                &[
                    GenerationTaskStatus::Created,
                    GenerationTaskStatus::Submitting,
                    GenerationTaskStatus::RetryWait,
                ],
                "accept remote video task",
            )?;
            if !polls_remote_generation(current.operation) {
                return Err(illegal_transition(
                    task_id,
                    current.status,
                    "accept remote task for an operation that does not poll",
                ));
            }
            let remote_task_id = remote_task_id.trim();
            if remote_task_id.is_empty() {
                return Err(BackendError::validation(
                    "remote generation task id cannot be empty",
                    json!({ "taskId": task_id }),
                ));
            }
            if let Some(existing) = current.remote_task_id.as_deref()
                && existing != remote_task_id
            {
                return Err(BackendError::Conflict(format!(
                    "generation task {task_id} is already bound to remote task {existing}"
                )));
            }
            next.remote_task_id = Some(remote_task_id.to_string());
            next.status = GenerationTaskStatus::Queued;
            next.progress = Some(0.0);
        }
        GenerationTaskTransition::ObserveQueued { progress } => {
            require_remote_observation(task_id, current)?;
            // A late QUEUED observation must not move a task backwards from RUNNING.
            if current.status != GenerationTaskStatus::Running {
                next.status = GenerationTaskStatus::Queued;
            }
            next.query_health = QueryHealth::Healthy;
            next.progress = merge_progress(task_id, current.progress, progress)?;
        }
        GenerationTaskTransition::ObserveRunning { progress } => {
            require_remote_observation(task_id, current)?;
            next.status = GenerationTaskStatus::Running;
            next.query_health = QueryHealth::Healthy;
            next.progress = merge_progress(task_id, current.progress, progress)?;
        }
        GenerationTaskTransition::Succeed => {
            require_status(
                task_id,
                current.status,
                &[
                    GenerationTaskStatus::Submitting,
                    GenerationTaskStatus::Queued,
                    GenerationTaskStatus::Running,
                ],
                "succeed",
            )?;
            next.status = GenerationTaskStatus::Succeeded;
            if matches!(
                current.status,
                GenerationTaskStatus::Queued | GenerationTaskStatus::Running
            ) {
                next.query_health = QueryHealth::Healthy;
            }
            next.progress = Some(100.0);
            next.final_error = None;
            next.completed_at = Some(timestamp);
        }
        GenerationTaskTransition::Fail { progress, error } => {
            require_failure_source(task_id, current.status, "fail")?;
            next.status = GenerationTaskStatus::Failed;
            if matches!(
                current.status,
                GenerationTaskStatus::Queued | GenerationTaskStatus::Running
            ) {
                next.query_health = QueryHealth::Healthy;
            }
            next.progress = merge_progress(task_id, current.progress, progress)?;
            next.final_error = Some(error);
            next.completed_at = Some(timestamp);
        }
        GenerationTaskTransition::BecomeUnknown { progress, error } => {
            require_failure_source(task_id, current.status, "become unknown")?;
            next.status = GenerationTaskStatus::Unknown;
            if matches!(
                current.status,
                GenerationTaskStatus::Queued | GenerationTaskStatus::Running
            ) {
                next.query_health = QueryHealth::Healthy;
            }
            next.progress = merge_progress(task_id, current.progress, progress)?;
            next.final_error = Some(error);
            next.completed_at = Some(timestamp);
        }
        GenerationTaskTransition::Interrupt { error } => {
            if current.remote_task_id.is_some() {
                return Err(illegal_transition(
                    task_id,
                    current.status,
                    "interrupt a task that has a recoverable remote identity",
                ));
            }
            next.status = GenerationTaskStatus::Interrupted;
            next.final_error = Some(error);
            next.completed_at = Some(timestamp);
        }
        GenerationTaskTransition::ChangeQueryHealth { health } => {
            require_remote_observation(task_id, current)?;
            validate_query_health_transition(task_id, current.query_health, health)?;
            next.query_health = health;
        }
    }

    if next.status == current.status
        && next.query_health == current.query_health
        && next.remote_task_id == current.remote_task_id
        && next.progress == current.progress
        && next.final_error == current.final_error
        && next.completed_at == current.completed_at
    {
        return Ok(next);
    }

    next.event = if next.status != original_status
        || next.progress != current.progress
        || next.final_error != current.final_error
        || next.remote_task_id != current.remote_task_id
    {
        Some(PersistedTaskTransitionEvent::StateChanged {
            from_status: original_status,
            status: next.status,
            from_query_health: original_health,
            query_health: next.query_health,
            progress: next.progress,
            error: next.final_error.clone(),
        })
    } else if next.query_health != original_health {
        Some(PersistedTaskTransitionEvent::QueryHealthChanged {
            from_health: original_health,
            health: next.query_health,
        })
    } else {
        None
    };
    Ok(next)
}

fn decide_terminal_replay(
    task_id: &str,
    current: &CurrentTaskState,
    transition: GenerationTaskTransition,
) -> BackendResult<NextTaskState> {
    let replayed_status = match &transition {
        GenerationTaskTransition::Succeed => Some(GenerationTaskStatus::Succeeded),
        GenerationTaskTransition::Fail { .. } => Some(GenerationTaskStatus::Failed),
        GenerationTaskTransition::BecomeUnknown { .. } => Some(GenerationTaskStatus::Unknown),
        GenerationTaskTransition::Interrupt { .. } => Some(GenerationTaskStatus::Interrupted),
        _ => None,
    };
    if replayed_status == Some(current.status) {
        return Ok(NextTaskState {
            status: current.status,
            query_health: current.query_health,
            remote_task_id: current.remote_task_id.clone(),
            progress: current.progress,
            final_error: current.final_error.clone(),
            completed_at: current.completed_at,
            event: None,
        });
    }
    Err(BackendError::Conflict(format!(
        "generation task {task_id} is already terminal ({})",
        current.status.as_str()
    )))
}

fn require_status(
    task_id: &str,
    current: GenerationTaskStatus,
    allowed: &[GenerationTaskStatus],
    action: &str,
) -> BackendResult<()> {
    if allowed.contains(&current) {
        Ok(())
    } else {
        Err(illegal_transition(task_id, current, action))
    }
}

fn require_failure_source(
    task_id: &str,
    current: GenerationTaskStatus,
    action: &str,
) -> BackendResult<()> {
    require_status(
        task_id,
        current,
        &[
            GenerationTaskStatus::Created,
            GenerationTaskStatus::Submitting,
            GenerationTaskStatus::RetryWait,
            GenerationTaskStatus::Queued,
            GenerationTaskStatus::Running,
        ],
        action,
    )
}

fn require_remote_observation(task_id: &str, current: &CurrentTaskState) -> BackendResult<()> {
    require_status(
        task_id,
        current.status,
        &[GenerationTaskStatus::Queued, GenerationTaskStatus::Running],
        "record remote observation",
    )?;
    if !polls_remote_generation(current.operation) || current.remote_task_id.is_none() {
        return Err(illegal_transition(
            task_id,
            current.status,
            "record remote observation without a remote task identity",
        ));
    }
    Ok(())
}

fn polls_remote_generation(operation: GenerationOperation) -> bool {
    matches!(
        operation,
        GenerationOperation::VideoGeneration
            | GenerationOperation::TextToImage
            | GenerationOperation::ImageToImage
    )
}

fn merge_progress(
    task_id: &str,
    current: Option<f64>,
    incoming: Option<f64>,
) -> BackendResult<Option<f64>> {
    let Some(incoming) = incoming else {
        return Ok(current);
    };
    if !incoming.is_finite() || !(0.0..=100.0).contains(&incoming) {
        return Err(BackendError::validation(
            "generation task progress must be a finite percentage between 0 and 100",
            json!({ "taskId": task_id, "progress": incoming }),
        ));
    }
    Ok(Some(current.map_or(incoming, |value| value.max(incoming))))
}

fn validate_query_health_transition(
    task_id: &str,
    current: QueryHealth,
    next: QueryHealth,
) -> BackendResult<()> {
    let valid = current == next
        || matches!(
            (current, next),
            (QueryHealth::Healthy, QueryHealth::RetryWait)
                | (QueryHealth::RetryWait, QueryHealth::Healthy)
                | (QueryHealth::RetryWait, QueryHealth::Degraded)
                | (QueryHealth::Degraded, QueryHealth::Healthy)
        );
    if valid {
        Ok(())
    } else {
        Err(BackendError::Conflict(format!(
            "generation task {task_id} cannot change query health from {} to {}",
            current.as_str(),
            next.as_str()
        )))
    }
}

fn parse_query_health(task_id: &str, value: &str) -> BackendResult<QueryHealth> {
    match value {
        "healthy" => Ok(QueryHealth::Healthy),
        "retry_wait" => Ok(QueryHealth::RetryWait),
        "degraded" => Ok(QueryHealth::Degraded),
        _ => Err(BackendError::Conflict(format!(
            "generation task {task_id} has invalid persisted query health: {value}"
        ))),
    }
}

fn illegal_transition(task_id: &str, current: GenerationTaskStatus, action: &str) -> BackendError {
    BackendError::Conflict(format!(
        "generation task {task_id} cannot {action} from {}",
        current.as_str()
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::*;
    use crate::backend::storage::NewTask;
    use crate::backend::types::{MediaType, SaveStatus};

    fn task_lifecycle(
        task_id: &str,
        operation: GenerationOperation,
    ) -> (TempDir, Arc<Storage>, GenerationTaskLifecycle) {
        let directory = TempDir::new().expect("temp dir");
        let storage =
            Arc::new(Storage::open(&directory.path().join("backend.sqlite")).expect("open db"));
        let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
        let provider = storage
            .get_provider_connection("provider-sd20")
            .expect("seeded provider");
        lifecycle
            .create(NewTask {
                id: task_id,
                canvas_id: "canvas-1",
                source_node_id: "node-1",
                operation,
                provider: &provider,
                api_key_ref: &provider.api_key_ref,
                model_definition_id: "model-1",
                remote_model_id: Some("remote-model-1"),
                logical_request: &json!({ "prompt": "frozen" }),
            })
            .expect("create task");
        (directory, storage, lifecycle)
    }

    fn begin_submission(lifecycle: &GenerationTaskLifecycle, task_id: &str) {
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::BeginResolution {
                    attempt_id: "resolve-1".into(),
                },
            )
            .expect("begin resolution");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ResolutionSucceeded {
                    attempt_id: "resolve-1".into(),
                    resolved_request: json!({ "renderedPrompt": "frozen" }),
                },
            )
            .expect("finish resolution");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::BeginSubmission {
                    attempt_id: "submit-1".into(),
                    backoff_ms: None,
                },
            )
            .expect("begin submission");
    }

    fn record_successful_call(
        lifecycle: &GenerationTaskLifecycle,
        task_id: &str,
        attempt_id: &str,
        call_id: &str,
        phase: &str,
    ) {
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallPrepared {
                    call_id: call_id.into(),
                    attempt_id: attempt_id.into(),
                    phase: phase.into(),
                    request: json!({ "method": "POST" }),
                },
            )
            .expect("prepare call");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallSent {
                    call_id: call_id.into(),
                    sent_at: 1,
                },
            )
            .expect("send call");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallResponded {
                    call_id: call_id.into(),
                    sent_at: 1,
                    status: 200,
                    headers: json!({}),
                    raw_response: "{}".into(),
                },
            )
            .expect("finish call");
    }

    fn record_failed_call(
        lifecycle: &GenerationTaskLifecycle,
        task_id: &str,
        attempt_id: &str,
        call_id: &str,
        phase: &str,
    ) {
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallPrepared {
                    call_id: call_id.into(),
                    attempt_id: attempt_id.into(),
                    phase: phase.into(),
                    request: json!({ "method": "GET" }),
                },
            )
            .expect("prepare failed call");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallSent {
                    call_id: call_id.into(),
                    sent_at: 1,
                },
            )
            .expect("send failed call");
        lifecycle
            .commit(
                task_id,
                GenerationLifecycleFact::ProviderCallFailed {
                    call_id: call_id.into(),
                    sent_at: 1,
                    error: json!({ "kind": "transport" }),
                },
            )
            .expect("finish failed call");
    }

    #[test]
    fn creation_persists_snapshot_and_created_event_through_the_lifecycle_interface() {
        let (_directory, storage, _lifecycle) =
            task_lifecycle("task-created", GenerationOperation::TextToImage);
        let detail = storage
            .get_task_detail("task-created")
            .expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Created);
        assert_eq!(detail.events.len(), 1);
        assert_eq!(detail.events[0].event_type, "created");
    }

    #[test]
    fn remote_submission_finishes_attempt_and_binds_identity_atomically() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-video", GenerationOperation::VideoGeneration);
        begin_submission(&lifecycle, "task-video");
        record_successful_call(
            &lifecycle,
            "task-video",
            "submit-1",
            "submit-call-1",
            "submit",
        );

        lifecycle
            .commit(
                "task-video",
                GenerationLifecycleFact::SubmissionRemoteAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "submit-call-1".into(),
                    tokens: Some(TokenUsage {
                        prompt_tokens: Some(3),
                        completion_tokens: Some(5),
                        total_tokens: Some(8),
                    }),
                    remote_task_id: "remote-7".into(),
                },
            )
            .expect("accept remote task");

        let detail = storage.get_task_detail("task-video").expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Queued);
        assert_eq!(detail.summary.remote_task_id.as_deref(), Some("remote-7"));
        assert_eq!(
            detail.summary.tokens.and_then(|usage| usage.total_tokens),
            Some(8)
        );
        assert_eq!(
            detail
                .attempts
                .iter()
                .find(|attempt| attempt.id == "submit-1")
                .and_then(|attempt| attempt.outcome.as_deref()),
            Some("succeeded")
        );
    }

    #[test]
    fn image_success_and_pending_results_share_one_commit() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-image", GenerationOperation::TextToImage);
        begin_submission(&lifecycle, "task-image");
        record_successful_call(
            &lifecycle,
            "task-image",
            "submit-1",
            "submit-call-1",
            "submit",
        );
        let result = GenerationResultRecord {
            task_id: "task-image".into(),
            result_index: 1,
            media_type: MediaType::Image,
            remote_task_id: None,
            source: json!({ "kind": "url", "url": "https://example.invalid/result.png" }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        };

        lifecycle
            .commit(
                "task-image",
                GenerationLifecycleFact::SubmissionImagesAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "submit-call-1".into(),
                    tokens: None,
                    results: vec![result],
                },
            )
            .expect("accept image results");

        let detail = storage.get_task_detail("task-image").expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Succeeded);
        assert_eq!(detail.results.len(), 1);
        assert_eq!(detail.results[0].save_status, SaveStatus::Pending);
    }

    #[test]
    fn success_without_matching_call_evidence_rolls_back_the_whole_fact() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-no-evidence", GenerationOperation::TextToImage);
        begin_submission(&lifecycle, "task-no-evidence");
        let result = GenerationResultRecord {
            task_id: "task-no-evidence".into(),
            result_index: 1,
            media_type: MediaType::Image,
            remote_task_id: None,
            source: json!({ "kind": "url", "url": "https://example.invalid/result.png" }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        };

        let error = lifecycle
            .commit(
                "task-no-evidence",
                GenerationLifecycleFact::SubmissionImagesAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "missing-call".into(),
                    tokens: None,
                    results: vec![result],
                },
            )
            .expect_err("missing call evidence");
        assert!(matches!(error, BackendError::Conflict(_)));

        let detail = storage
            .get_task_detail("task-no-evidence")
            .expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Submitting);
        assert!(detail.results.is_empty());
        let attempt = detail
            .attempts
            .iter()
            .find(|attempt| attempt.id == "submit-1")
            .expect("submit attempt");
        assert!(attempt.finished_at.is_none());
    }

    #[test]
    fn result_save_status_can_only_advance_through_the_lifecycle_interface() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-result", GenerationOperation::TextToImage);
        begin_submission(&lifecycle, "task-result");
        record_successful_call(
            &lifecycle,
            "task-result",
            "submit-1",
            "submit-call-1",
            "submit",
        );
        let mut result = GenerationResultRecord {
            task_id: "task-result".into(),
            result_index: 1,
            media_type: MediaType::Image,
            remote_task_id: None,
            source: json!({ "kind": "url", "url": "https://example.invalid/result.png" }),
            save_status: SaveStatus::Pending,
            final_path: None,
            relative_path: None,
            byte_size: None,
            mime_type: None,
            sha256: None,
            saved_at: None,
            error: None,
        };
        lifecycle
            .commit(
                "task-result",
                GenerationLifecycleFact::SubmissionImagesAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "submit-call-1".into(),
                    tokens: None,
                    results: vec![result.clone()],
                },
            )
            .expect("register result");
        result.save_status = SaveStatus::Writing;
        lifecycle
            .commit(
                "task-result",
                GenerationLifecycleFact::ResultChanged {
                    result: result.clone(),
                },
            )
            .expect("start save");
        result.save_status = SaveStatus::Succeeded;
        result.final_path = Some("C:/Downloads/无限画布/task-result-1.png".into());
        result.relative_path = Some("无限画布/task-result-1.png".into());
        result.byte_size = Some(4);
        result.mime_type = Some("image/png".into());
        result.sha256 = Some("hash".into());
        result.saved_at = Some(2);
        lifecycle
            .commit(
                "task-result",
                GenerationLifecycleFact::ResultChanged {
                    result: result.clone(),
                },
            )
            .expect("finish save");

        result.save_status = SaveStatus::Writing;
        let error = lifecycle
            .commit(
                "task-result",
                GenerationLifecycleFact::ResultChanged { result },
            )
            .expect_err("succeeded result cannot return to writing");
        assert!(matches!(error, BackendError::Conflict(_)));
        assert_eq!(
            storage
                .get_result("task-result", 1)
                .expect("persisted result")
                .save_status,
            SaveStatus::Succeeded
        );
    }

    #[test]
    fn observation_retry_and_success_update_attempt_health_tokens_and_state_together() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-observe", GenerationOperation::VideoGeneration);
        begin_submission(&lifecycle, "task-observe");
        record_successful_call(
            &lifecycle,
            "task-observe",
            "submit-1",
            "submit-call-1",
            "submit",
        );
        lifecycle
            .commit(
                "task-observe",
                GenerationLifecycleFact::SubmissionRemoteAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "submit-call-1".into(),
                    tokens: None,
                    remote_task_id: "remote-observe".into(),
                },
            )
            .expect("accept remote task");
        lifecycle
            .commit(
                "task-observe",
                GenerationLifecycleFact::BeginObservation {
                    attempt_id: "observe-1".into(),
                    backoff_ms: None,
                },
            )
            .expect("begin observation");
        record_failed_call(
            &lifecycle,
            "task-observe",
            "observe-1",
            "observe-call-1",
            "observe",
        );
        lifecycle
            .commit(
                "task-observe",
                GenerationLifecycleFact::ObservationRetryScheduled {
                    attempt_id: "observe-1".into(),
                    retry_index: 1,
                    delay_ms: 2_000,
                    error: json!({ "kind": "transport" }),
                },
            )
            .expect("schedule retry");
        lifecycle
            .commit(
                "task-observe",
                GenerationLifecycleFact::BeginObservation {
                    attempt_id: "observe-2".into(),
                    backoff_ms: Some(2_000),
                },
            )
            .expect("begin retry observation");
        record_successful_call(
            &lifecycle,
            "task-observe",
            "observe-2",
            "observe-call-2",
            "observe",
        );
        lifecycle
            .commit(
                "task-observe",
                GenerationLifecycleFact::ObservationApplied {
                    attempt_id: "observe-2".into(),
                    call_id: "observe-call-2".into(),
                    tokens: None,
                    observation: GenerationRemoteObservation::Running {
                        progress: Some(42.0),
                    },
                },
            )
            .expect("apply observation");

        let detail = storage
            .get_task_detail("task-observe")
            .expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Running);
        assert_eq!(detail.summary.query_health, QueryHealth::Healthy);
        assert_eq!(detail.summary.progress, Some(42.0));
        assert_eq!(detail.attempts[2].outcome.as_deref(), Some("failed"));
        assert_eq!(detail.attempts[3].outcome.as_deref(), Some("succeeded"));
        assert!(
            detail
                .events
                .iter()
                .any(|event| event.event_type == "automatic_retry")
        );
    }

    #[test]
    fn invalid_observation_rolls_back_attempt_completion_and_task_projection() {
        let (_directory, storage, lifecycle) =
            task_lifecycle("task-invalid", GenerationOperation::VideoGeneration);
        begin_submission(&lifecycle, "task-invalid");
        record_successful_call(
            &lifecycle,
            "task-invalid",
            "submit-1",
            "submit-call-1",
            "submit",
        );
        lifecycle
            .commit(
                "task-invalid",
                GenerationLifecycleFact::SubmissionRemoteAccepted {
                    attempt_id: "submit-1".into(),
                    call_id: "submit-call-1".into(),
                    tokens: None,
                    remote_task_id: "remote-invalid".into(),
                },
            )
            .expect("accept remote task");
        lifecycle
            .commit(
                "task-invalid",
                GenerationLifecycleFact::BeginObservation {
                    attempt_id: "observe-invalid".into(),
                    backoff_ms: None,
                },
            )
            .expect("begin observation");
        record_successful_call(
            &lifecycle,
            "task-invalid",
            "observe-invalid",
            "observe-call-invalid",
            "observe",
        );

        let error = lifecycle
            .commit(
                "task-invalid",
                GenerationLifecycleFact::ObservationApplied {
                    attempt_id: "observe-invalid".into(),
                    call_id: "observe-call-invalid".into(),
                    tokens: None,
                    observation: GenerationRemoteObservation::Running {
                        progress: Some(101.0),
                    },
                },
            )
            .expect_err("invalid progress");
        assert!(matches!(error, BackendError::Validation { .. }));

        let detail = storage
            .get_task_detail("task-invalid")
            .expect("task detail");
        assert_eq!(detail.summary.status, GenerationTaskStatus::Queued);
        assert_eq!(detail.summary.progress, Some(0.0));
        let attempt = detail
            .attempts
            .iter()
            .find(|attempt| attempt.id == "observe-invalid")
            .expect("observation attempt");
        assert!(attempt.finished_at.is_none());
        assert!(attempt.outcome.is_none());
    }
}
