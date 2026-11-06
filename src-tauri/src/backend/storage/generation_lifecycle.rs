use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::{Storage, now_ms};
use crate::backend::{
    error::{BackendError, BackendResult},
    gateway_profile::GatewayProfile,
    types::{
        GenerationOperation, GenerationResultRecord, GenerationTaskStatus, MediaType, QueryHealth,
        SaveStatus, TokenUsage,
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
    /// 用户主动取消（或画布删除连带取消）。这是一个终态事实：
    /// 任务不再向供应商发起请求，也不再把产物写进磁盘。
    CancellationRequested {
        reason: Value,
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
    ObservationPollingExpired {
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
        /// 这次调用是否**根本没送达上游**（连接层失败：DNS 解析失败 / 连接被拒 /
        /// TLS 握手失败）。
        ///
        /// 刻意与「响应体读取失败 / 4xx / 5xx」区分开：那些请求已经到达供应商、
        /// 可能已经计费，绝不能算「未发出」。为 true 时把 `provider_calls.dispatch_failed`
        /// 置 1，「已发出」的守卫判据据此放行（草稿可以重新提升为正片）。
        dispatch_failed: bool,
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
    /// 远端任务成功时要登记的结果。**可能有多条**：Atlas 上的 Midjourney V8.2
    /// 一次任务实测返回过 4 张、也返回过 3 张，张数由上游当次决定。
    ///
    /// 必须把全部结果一次登记进去：写库时的守卫（`validate_result_change`）
    /// 只允许改写「已由生命周期登记过」的行，少登记一条，后续那张图写库就会
    /// 被判为「未登记」而失败——任务却已经进了成功终态，于是图一张都落不了
    /// 盘，用户只看到一个「成功」但没有任何产物。
    Succeeded { results: Vec<GenerationResultRecord> },
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
    AcceptRemoteVideo {
        remote_task_id: String,
    },
    ObserveQueued {
        progress: Option<f64>,
    },
    ObserveRunning {
        progress: Option<f64>,
    },
    Succeed,
    Fail {
        progress: Option<f64>,
        error: Value,
    },
    BecomeUnknown {
        progress: Option<f64>,
        error: Value,
    },
    Interrupt {
        error: Value,
    },
    /// 取消：与 Interrupt 不同，允许取消已经拿到远端身份的任务——
    /// 远端任务由供应商继续跑完，我们只是不再认领它的结果。
    Cancel {
        reason: Value,
    },
    ChangeQueryHealth {
        health: QueryHealth,
    },
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
            GenerationLifecycleFact::CancellationRequested { reason } => {
                transition = Some(commit_task_transition_in(
                    &transaction,
                    task_id,
                    GenerationTaskTransition::Cancel { reason },
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
            GenerationLifecycleFact::ObservationPollingExpired { error } => {
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
                    "polling_expired",
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
                    GenerationRemoteObservation::Succeeded { results } => {
                        if results.is_empty() {
                            return Err(BackendError::protocol(
                                "successful observation carried no result to register",
                                json!({ "taskId": task_id }),
                            ));
                        }
                        // 全部结果都要登记：只登记第一条会让其余结果写库时被守卫拒绝。
                        for result in &results {
                            require_pending_result(task_id, result)?;
                            upsert_result(&transaction, result)?;
                        }
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
            /*
             * `sent_at` 的语义是「本机在那一刻发起了这次请求」，**不是**「供应商已收到」。
             *
             * provider 层为了能在 send() 之前就留下痕迹（请求构造失败也要留档），是在
             * request.send() 之前先写 sent_at 的；因此 DNS 失败、连接被拒这类根本没送达
             * 上游的调用同样会带着 sent_at。「是否真的送达上游」由 `dispatch_failed` 决定：
             * 连接层失败时由 `ProviderCallFailed` 在同一个事务里把它置 1，
             * 守卫 SQL（storage.rs 的草稿阻断与正片查找）据此判「未发出」。
             */
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
                dispatch_failed,
            } => {
                let received_at = now_ms();
                let updated = transaction.execute(
                    "UPDATE provider_calls SET response_received_at = ?4, duration_ms = ?5,
                            runtime_error_json = ?6, dispatch_failed = ?7
                     WHERE task_id = ?1 AND id = ?2
                       AND sent_at = ?3 AND response_received_at IS NULL",
                    params![
                        task_id,
                        call_id,
                        sent_at,
                        received_at,
                        received_at - sent_at,
                        serde_json::to_string(&error)?,
                        dispatch_failed,
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
    let stored_source: Value = serde_json::from_str(&current.2)?;
    if current.0 != result.media_type.as_str()
        || current.1 != result.remote_task_id
        || (stored_source != result.source
            && (!matches!(current.3.as_str(), "pending" | "writing" | "interrupted")
                || !allowed_sp25_signed_url_refresh(transaction, task_id, result, &stored_source)?))
    {
        return Err(BackendError::Conflict(format!(
            "generation result {task_id}/{} cannot change its persisted identity or source",
            result.result_index
        )));
    }
    let sp25_recovery = matches!(current.3.as_str(), "failed" | "local_missing" | "conflict")
        && result.save_status == SaveStatus::Writing
        && is_reobservable_video_result_task(transaction, task_id, result)?;
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
        "failed" => result.save_status == SaveStatus::Failed || sp25_recovery,
        "local_missing" => result.save_status == SaveStatus::LocalMissing || sp25_recovery,
        "conflict" => result.save_status == SaveStatus::Conflict || sp25_recovery,
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

fn allowed_sp25_signed_url_refresh(
    transaction: &Transaction<'_>,
    task_id: &str,
    result: &GenerationResultRecord,
    stored_source: &Value,
) -> BackendResult<bool> {
    if result.media_type != MediaType::Video {
        return Ok(false);
    }
    let Some(stored) = stored_source.as_object() else {
        return Ok(false);
    };
    let Some(updated) = result.source.as_object() else {
        return Ok(false);
    };
    if stored.get("kind").and_then(Value::as_str) != Some("url")
        || updated.get("kind").and_then(Value::as_str) != Some("url")
    {
        return Ok(false);
    }
    let old_url = stored
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new_url = updated
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if old_url.is_empty()
        || new_url.is_empty()
        || !url::Url::parse(new_url)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
    {
        return Ok(false);
    }
    let mut previous_without_url = stored.clone();
    let mut updated_without_url = updated.clone();
    previous_without_url.remove("url");
    updated_without_url.remove("url");
    if previous_without_url != updated_without_url {
        return Ok(false);
    }
    is_sp25_video_result_task(transaction, task_id, result)
}

/// 该结果属于「可以按远程任务重查后重新保存」的视频结果。
///
/// 判据：视频、有远程任务号、且任务所属家族已登记协议。**不要求产物是签名直链**——
/// Atlas Cloud 的视频产物是公开托管链接（重查任务拿到的是同一个链接），同样允许
/// 「failed → writing」的恢复重跑；把它排除在外会让一次成功的生成再也无法落盘。
fn is_reobservable_video_result_task(
    transaction: &Transaction<'_>,
    task_id: &str,
    result: &GenerationResultRecord,
) -> BackendResult<bool> {
    if result.media_type != MediaType::Video || result.remote_task_id.is_none() {
        return Ok(false);
    }
    let (model_id, task_remote_id, adapter_id): (Option<String>, Option<String>, String) = transaction.query_row(
        "SELECT remote_model_id_snapshot, remote_task_id, adapter_id_snapshot FROM generation_tasks WHERE id = ?1",
        params![task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(
        GatewayProfile::for_frozen_snapshot(model_id.as_deref(), &adapter_id).is_some()
            && task_remote_id == result.remote_task_id,
    )
}

/// 该结果属于「产物是带签名的直链」家族：链接会过期，允许重查任务换新链接。
fn is_sp25_video_result_task(
    transaction: &Transaction<'_>,
    task_id: &str,
    result: &GenerationResultRecord,
) -> BackendResult<bool> {
    if result.media_type != MediaType::Video || result.remote_task_id.is_none() {
        return Ok(false);
    }
    let (model_id, task_remote_id, adapter_id): (Option<String>, Option<String>, String) = transaction.query_row(
        "SELECT remote_model_id_snapshot, remote_task_id, adapter_id_snapshot FROM generation_tasks WHERE id = ?1",
        params![task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(
        GatewayProfile::for_frozen_snapshot(model_id.as_deref(), &adapter_id)
            .is_some_and(GatewayProfile::uses_signed_result_url)
            && task_remote_id == result.remote_task_id,
    )
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
        GenerationTaskStatus::Cancelled => Ok(GenerationTaskTransition::Cancel { reason: error }),
        status => Err(BackendError::validation(
            "lifecycle terminal conclusion must be failed, unknown, interrupted, or cancelled",
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
        GenerationTaskTransition::Cancel { reason } => {
            require_status(
                task_id,
                current.status,
                &[
                    GenerationTaskStatus::Created,
                    GenerationTaskStatus::Submitting,
                    GenerationTaskStatus::RetryWait,
                    GenerationTaskStatus::Queued,
                    GenerationTaskStatus::Running,
                ],
                "cancel",
            )?;
            // 取消不回收远端身份：远端任务由供应商继续跑完，我们只是不再认领结果。
            next.status = GenerationTaskStatus::Cancelled;
            next.final_error = Some(reason);
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
    // A legacy Kling gateway UNKNOWN observation is transient, not a new
    // generation. Resume only the same acknowledged remote identity and only
    // this explicit observation error; other terminal tasks remain immutable.
    if let GenerationTaskTransition::AcceptRemoteVideo { remote_task_id } = &transition
        && current.status == GenerationTaskStatus::Unknown
        && current.operation == GenerationOperation::VideoGeneration
        && !remote_task_id.trim().is_empty()
        && current.remote_task_id.as_deref() == Some(remote_task_id.as_str())
        && current.final_error.as_ref().and_then(|error| error.get("kind")).and_then(Value::as_str) == Some("remote_generation_unknown") {
        return Ok(NextTaskState {
            status: GenerationTaskStatus::Queued, query_health: QueryHealth::Healthy,
            remote_task_id: current.remote_task_id.clone(), progress: current.progress,
            final_error: None, completed_at: None,
            event: Some(PersistedTaskTransitionEvent::StateChanged {
                from_status: current.status, status: GenerationTaskStatus::Queued,
                from_query_health: current.query_health, query_health: QueryHealth::Healthy,
                progress: current.progress, error: None,
            }),
        });
    }
    let replayed_status = match &transition {
        GenerationTaskTransition::Succeed => Some(GenerationTaskStatus::Succeeded),
        GenerationTaskTransition::Fail { .. } => Some(GenerationTaskStatus::Failed),
        GenerationTaskTransition::BecomeUnknown { .. } => Some(GenerationTaskStatus::Unknown),
        GenerationTaskTransition::Interrupt { .. } => Some(GenerationTaskStatus::Interrupted),
        GenerationTaskTransition::Cancel { .. } => Some(GenerationTaskStatus::Cancelled),
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
                | (QueryHealth::Healthy, QueryHealth::Degraded)
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
