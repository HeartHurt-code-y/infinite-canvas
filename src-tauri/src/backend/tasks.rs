use std::sync::Arc;

use rand::Rng as _;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter as _};
use tauri_plugin_log::log::{error, info, warn};
use tauri_plugin_notification::NotificationExt as _;
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    local_results::LocalResultService,
    media::{MediaResolver, ResolvedBundle},
    model_schema::normalize_parameters,
    provider::{GenerationObservation, GenerationSubmission, ProviderRuntime, parse_token_usage},
    staging::StagingService,
    storage::{
        GenerationLifecycleFact, GenerationOperationalEvent, GenerationRemoteObservation,
        GenerationTaskLifecycle, NewTask, PersistedTaskTransition, PersistedTaskTransitionEvent,
        Storage, TaskExecutionRecord,
    },
    types::{
        GenerationOperation, GenerationResultRecord, GenerationTaskDetail, GenerationTaskListQuery,
        GenerationTaskPage, GenerationTaskStatus, RecoveryReport, StartGenerationCommand,
    },
};

const MAX_AUTOMATIC_RETRIES: u32 = 3;
const DEFAULT_VIDEO_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
const WAN_VIDEO_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

struct SuccessfulSubmission {
    attempt_id: String,
    call_id: String,
    submission: GenerationSubmission,
    tokens: Option<super::types::TokenUsage>,
}

struct SuccessfulObservation {
    attempt_id: String,
    call_id: String,
    observation: GenerationObservation,
    tokens: Option<super::types::TokenUsage>,
}

#[derive(Clone)]
pub struct GenerationTaskService {
    app: AppHandle,
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    providers: ProviderRuntime,
    media: MediaResolver,
    local_results: LocalResultService,
    staging: StagingService,
}

impl GenerationTaskService {
    pub fn new(
        app: AppHandle,
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        providers: ProviderRuntime,
        media: MediaResolver,
        local_results: LocalResultService,
        staging: StagingService,
    ) -> Self {
        Self {
            app,
            storage,
            lifecycle,
            providers,
            media,
            local_results,
            staging,
        }
    }

    pub fn start(&self, command: StartGenerationCommand) -> BackendResult<String> {
        let operation = command.operation;
        let source_node_id = command.source_node_id.clone();
        match self.start_inner(command) {
            Ok(task_id) => Ok(task_id),
            Err(error) => {
                let payload = error.payload();
                warn!(
                    "[generation] 任务创建失败（未创建本地任务）: sourceNode={source_node_id}, operation={}, 错误类型={}, 详情={}",
                    operation.as_str(),
                    payload.kind,
                    payload.message
                );
                Err(error)
            }
        }
    }

    fn start_inner(&self, mut command: StartGenerationCommand) -> BackendResult<String> {
        validate_start_command(&command)?;
        let provider = self
            .storage
            .get_provider_connection(&command.provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider.id }),
            ));
        }
        let binding = self.storage.get_binding(
            &command.provider_connection_id,
            &command.model_definition_id,
        )?;
        if !binding.enabled || !binding.enabled_operations.contains(&command.operation) {
            return Err(BackendError::validation(
                "provider does not expose this model operation",
                json!({
                    "providerConnectionId": command.provider_connection_id,
                    "modelDefinitionId": command.model_definition_id,
                    "operation": command.operation,
                    "binding": binding
                }),
            ));
        }
        let model = self
            .storage
            .list_model_definitions()?
            .into_iter()
            .find(|model| model.id == command.model_definition_id)
            .ok_or_else(|| {
                BackendError::NotFound(format!("model definition {}", command.model_definition_id))
            })?;
        let operation_schema = model
            .operations
            .get(command.operation.as_str())
            .ok_or_else(|| {
                BackendError::validation(
                    "model definition does not declare this operation",
                    json!({
                        "modelDefinitionId": model.id,
                        "operation": command.operation,
                        "operations": model.operations
                    }),
                )
            })?;
        if !operation_schema.is_object() {
            return Err(BackendError::validation(
                "model operation schema must be a JSON object",
                json!({
                    "modelDefinitionId": model.id,
                    "operation": command.operation,
                    "operationSchema": operation_schema
                }),
            ));
        }
        let supplied_parameters = if command.parameters.is_null() {
            json!({})
        } else {
            command.parameters.clone()
        };
        command.parameters = normalize_parameters(operation_schema, &supplied_parameters)?;
        command.model_operation_schema_snapshot = Some(operation_schema.clone());
        // 模型绑定指定了令牌分组时，用该分组的密钥；否则用供应商主 API Key。
        // 先解析出密钥引用并校验其可用（resolve 会读取凭据），再冻结进任务快照。
        let task_api_key_ref = self.storage.resolve_binding_credential_ref(
            &command.provider_connection_id,
            binding.token_group.as_deref(),
        )?;
        self.providers
            .resolve_token_group(&provider.id, binding.token_group.as_deref())?;

        let remote_model_id = binding
            .remote_model_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                BackendError::validation(
                    "the selected provider/model binding has no saved remote model id",
                    json!({
                        "providerConnectionId": command.provider_connection_id,
                        "modelDefinitionId": command.model_definition_id
                    }),
                )
            })?;
        let logical_request = serde_json::to_value(&command)?;
        let task_id = Uuid::new_v4().to_string();
        self.lifecycle.create(NewTask {
            id: &task_id,
            canvas_id: &command.canvas_id,
            source_node_id: &command.source_node_id,
            operation: command.operation,
            provider: &provider,
            api_key_ref: &task_api_key_ref,
            model_definition_id: &command.model_definition_id,
            remote_model_id: Some(remote_model_id),
            logical_request: &logical_request,
        })?;
        info!(
            "[generation] 任务已创建，即将进入后台执行: taskId={task_id}, canvasId={}, sourceNode={}, operation={}, provider={}（{}）, model={}, 远程模型={remote_model_id}, 提示词片段={} 个, 显式媒体输入={} 个, 生成数量={}",
            command.canvas_id,
            command.source_node_id,
            command.operation.as_str(),
            provider.display_name,
            provider.id,
            command.model_definition_id,
            command.prompt.len(),
            command.explicit_media.len(),
            command.generation_count
        );
        self.emit(
            "generation:created",
            &json!({ "taskId": task_id, "sourceNodeId": command.source_node_id }),
        );
        let service = self.clone();
        let spawned_task_id = task_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.execute(&spawned_task_id).await {
                let _ = service.finish_with_execution_error(&spawned_task_id, error);
            }
        });
        Ok(task_id)
    }

    pub fn list(&self, query: GenerationTaskListQuery) -> BackendResult<GenerationTaskPage> {
        self.storage.list_tasks(&query)
    }

    pub fn get(&self, task_id: &str) -> BackendResult<GenerationTaskDetail> {
        self.storage.get_task_detail(task_id)
    }

    pub fn recover(&self) -> BackendResult<RecoveryReport> {
        let tasks = self.storage.list_nonterminal_tasks()?;
        let mut report = RecoveryReport {
            recovered_video_tasks: 0,
            interrupted_image_tasks: 0,
            resumed_local_saves: 0,
            failed_to_recover: Vec::new(),
        };
        for task in tasks {
            if task.operation == GenerationOperation::VideoGeneration
                && task.remote_task_id.is_some()
            {
                if matches!(
                    task.status,
                    GenerationTaskStatus::Created
                        | GenerationTaskStatus::Submitting
                        | GenerationTaskStatus::RetryWait
                ) {
                    if let Err(error) = self.commit_fact(
                        &task.id,
                        GenerationLifecycleFact::RecoveryRemoteResumed {
                            remote_task_id: task
                                .remote_task_id
                                .clone()
                                .expect("checked remote task identity"),
                        },
                    ) {
                        report
                            .failed_to_recover
                            .push(format!("{}: {}", task.id, error));
                        continue;
                    }
                }
                report.recovered_video_tasks += 1;
                info!(
                    "[generation] 启动恢复: 恢复视频任务轮询: taskId={}, remoteTaskId={}",
                    task.id,
                    task.remote_task_id.as_deref().unwrap_or("<缺失>")
                );
                let service = self.clone();
                let task_id = task.id.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = service.poll_video(&task_id).await {
                        let _ = service.finish_with_execution_error(&task_id, error);
                    }
                });
            } else {
                let detail = self.storage.get_task_detail(&task.id)?;
                let request_may_have_been_sent =
                    detail.calls.iter().any(|call| call.sent_at.is_some());
                let status = if request_may_have_been_sent {
                    GenerationTaskStatus::Unknown
                } else {
                    GenerationTaskStatus::Interrupted
                };
                warn!(
                    "[generation] 启动恢复: 非可恢复任务标记终态: taskId={}, operation={}, 标记状态={}, 请求可能已到达供应商={request_may_have_been_sent}",
                    task.id,
                    task.operation.as_str(),
                    status.as_str()
                );
                let error = json!({
                    "kind": "process_interrupted",
                    "message": "application restarted while a non-recoverable local request was incomplete",
                    "requestMayHaveReachedProvider": request_may_have_been_sent
                });
                if let Err(recovery_error) = self.commit_fact(
                    &task.id,
                    GenerationLifecycleFact::RecoveryTerminated {
                        conclusion: status,
                        error,
                    },
                ) {
                    report
                        .failed_to_recover
                        .push(format!("{}: {}", task.id, recovery_error));
                } else {
                    report.interrupted_image_tasks += 1;
                }
            }
        }

        for mut job in self.storage.list_recoverable_staging_jobs()? {
            job.status = match job.status {
                super::types::StagingStatus::Staged
                | super::types::StagingStatus::Importing
                | super::types::StagingStatus::Cleaning => job.status,
                _ => super::types::StagingStatus::Interrupted,
            };
            job.updated_at = super::storage::now_ms();
            let _ = self.storage.update_staging_job(&job);
        }

        for result in self.lifecycle.recover_interrupted_results()? {
            report.resumed_local_saves += 1;
            info!(
                "[generation] 启动恢复: 恢复中断的本地保存: taskId={}, resultIndex={}, mediaType={}",
                result.task_id,
                result.result_index,
                result.media_type.as_str()
            );
            let service = self.clone();
            tauri::async_runtime::spawn(async move {
                let task_id = result.task_id.clone();
                let result_index = result.result_index;
                match service
                    .local_results
                    .resume_interrupted_result(result)
                    .await
                {
                    Ok(result) => {
                        let payload = json!({
                            "taskId": task_id,
                            "resultIndex": result_index,
                            "result": result
                        });
                        let _ = service.commit_fact(
                            &task_id,
                            GenerationLifecycleFact::OperationalEvent {
                                event_type: GenerationOperationalEvent::LocalSaveRecovered,
                                payload: payload.clone(),
                            },
                        );
                        service.emit("generation:result-saved", &payload);
                    }
                    Err(error) => {
                        let payload = error.runtime_record();
                        let _ = service.commit_fact(
                            &task_id,
                            GenerationLifecycleFact::OperationalEvent {
                                event_type: GenerationOperationalEvent::LocalSaveRecoveryFailed,
                                payload,
                            },
                        );
                    }
                }
            });
        }
        info!(
            "[generation] 启动恢复完成: 恢复视频任务 {} 个, 标记中断任务 {} 个, 恢复本地保存 {} 个, 恢复失败 {} 个{}",
            report.recovered_video_tasks,
            report.interrupted_image_tasks,
            report.resumed_local_saves,
            report.failed_to_recover.len(),
            if report.failed_to_recover.is_empty() {
                String::new()
            } else {
                format!("（{}）", report.failed_to_recover.join("; "))
            }
        );
        Ok(report)
    }

    pub fn query_remote_now(&self, task_id: &str) -> BackendResult<()> {
        info!("[generation] 用户手动触发视频任务状态查询: taskId={task_id}");
        let task = self.storage.get_task_execution(task_id)?;
        if task.operation != GenerationOperation::VideoGeneration || task.remote_task_id.is_none() {
            return Err(BackendError::validation(
                "only a video task with a remote task id can be queried",
                json!({ "taskId": task_id }),
            ));
        }
        self.commit_fact(task_id, GenerationLifecycleFact::ManualObservationRequested)?;
        let service = self.clone();
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.poll_video(&task_id).await {
                let _ = service.finish_with_execution_error(&task_id, error);
            }
        });
        Ok(())
    }

    async fn execute(&self, task_id: &str) -> BackendResult<()> {
        info!("[generation] 开始后台执行任务: taskId={task_id}");
        let task = self.storage.get_task_execution(task_id)?;
        let resolve_attempt_id = Uuid::new_v4().to_string();
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::BeginResolution {
                attempt_id: resolve_attempt_id.clone(),
            },
        )?;
        let bundle = match self.media.resolve(&task, &resolve_attempt_id).await {
            Ok(bundle) => {
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::ResolutionSucceeded {
                        attempt_id: resolve_attempt_id.clone(),
                        resolved_request: bundle.generation.archive(),
                    },
                )?;
                info!(
                    "[generation] 媒体引用解析完成: taskId={task_id}, 渲染后提示词 {} 字符, 图片 {} 个, 视频 {} 个, 音频 {} 个, TOS 暂存 {} 个",
                    bundle.generation.rendered_prompt.chars().count(),
                    bundle.generation.images.len(),
                    bundle.generation.videos.len(),
                    bundle.generation.audios.len(),
                    bundle.staging_leases.len()
                );
                bundle
            }
            Err(error) => {
                let record = error.runtime_record();
                error!(
                    "[generation] 媒体引用解析失败，任务转入 failed（未发送任何供应商请求）: taskId={task_id}, 错误: {record}"
                );
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::ResolutionFailed {
                        attempt_id: resolve_attempt_id,
                        error: record,
                    },
                )?;
                return Ok(());
            }
        };
        let Some(success) = self.submit_with_retry(&task, &bundle).await? else {
            self.cleanup_staging_leases(task_id, &bundle.staging_leases)
                .await;
            return Ok(());
        };

        match success.submission {
            GenerationSubmission::Images(images) => {
                info!(
                    "[generation] 供应商返回图片结果 {} 个，开始本地保存: taskId={task_id}",
                    images.len()
                );
                self.cleanup_staging_leases(task_id, &bundle.staging_leases)
                    .await;
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::SubmissionImagesAccepted {
                        attempt_id: success.attempt_id,
                        call_id: success.call_id,
                        tokens: success.tokens,
                        results: self.local_results.pending_image_results(task_id, &images),
                    },
                )?;
                let event_service = self.clone();
                let results = self
                    .local_results
                    .save_images(task_id, images, move |record, preview_src| {
                        event_service.emit_result_ready(record, preview_src);
                    })
                    .await?;
                for result in results {
                    let error_suffix = result
                        .error
                        .as_ref()
                        .map(|error| format!("，错误: {error}"))
                        .unwrap_or_default();
                    info!(
                        "[generation] 图片结果处理完成: taskId={task_id}, resultIndex={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                        result.result_index,
                        result.save_status.as_str(),
                        result.final_path,
                        result
                            .byte_size
                            .map(|size| size.to_string())
                            .unwrap_or_default(),
                    );
                    self.emit(
                        "generation:result-saved",
                        &json!({ "taskId": task_id, "result": result }),
                    );
                }
                Ok(())
            }
            GenerationSubmission::RemoteVideoTask {
                task_id: remote_task_id,
            } => {
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::SubmissionRemoteAccepted {
                        attempt_id: success.attempt_id,
                        call_id: success.call_id,
                        tokens: success.tokens,
                        remote_task_id: remote_task_id.clone(),
                    },
                )?;
                info!(
                    "[generation] 视频任务已提交成功，获得远程任务 ID，进入轮询阶段: taskId={task_id}, remoteTaskId={remote_task_id}"
                );
                self.poll_video_with_leases(task_id, bundle.staging_leases)
                    .await
            }
        }
    }

    async fn submit_with_retry(
        &self,
        task: &TaskExecutionRecord,
        bundle: &ResolvedBundle,
    ) -> BackendResult<Option<SuccessfulSubmission>> {
        let mut backoff_ms = None;
        for retry_index in 0..=MAX_AUTOMATIC_RETRIES {
            let attempt_id = Uuid::new_v4().to_string();
            self.commit_fact(
                &task.id,
                GenerationLifecycleFact::BeginSubmission {
                    attempt_id: attempt_id.clone(),
                    backoff_ms,
                },
            )?;
            info!(
                "[generation] 提交尝试开始: taskId={}, attemptId={}, 第 {} 次尝试（共最多 {} 次）, operation={}",
                task.id,
                attempt_id,
                retry_index + 1,
                MAX_AUTOMATIC_RETRIES + 1,
                task.operation.as_str()
            );
            match self
                .providers
                .submit(task, &attempt_id, &bundle.generation)
                .await
            {
                Ok((submission, response)) => {
                    match &submission {
                        GenerationSubmission::Images(images) => {
                            info!(
                                "[generation] 提交尝试成功: taskId={}, attemptId={}, 返回图片结果 {} 个",
                                task.id,
                                attempt_id,
                                images.len()
                            );
                        }
                        GenerationSubmission::RemoteVideoTask {
                            task_id: remote_task_id,
                        } => {
                            info!(
                                "[generation] 提交尝试成功: taskId={}, attemptId={}, 返回远程视频任务 {remote_task_id}",
                                task.id, attempt_id
                            );
                        }
                    }
                    return Ok(Some(SuccessfulSubmission {
                        attempt_id,
                        call_id: response.call_id.clone(),
                        submission,
                        tokens: parse_token_usage(&response),
                    }));
                }
                Err(error) => {
                    let record = error.runtime_record();
                    let retryable = is_retryable_generation_error(&error);
                    warn!(
                        "[generation] 提交尝试失败: taskId={}, attemptId={}, 第 {} 次尝试, 可自动重试={retryable}, 错误: {record}",
                        task.id,
                        attempt_id,
                        retry_index + 1
                    );
                    if !retryable || retry_index == MAX_AUTOMATIC_RETRIES {
                        let exhausted = retry_index == MAX_AUTOMATIC_RETRIES && retryable;
                        let conclusion = if matches!(error, BackendError::Transport(_)) {
                            GenerationTaskStatus::Unknown
                        } else {
                            GenerationTaskStatus::Failed
                        };
                        self.commit_fact(
                            &task.id,
                            GenerationLifecycleFact::SubmissionTerminated {
                                attempt_id,
                                conclusion,
                                error: record,
                                retries_exhausted: exhausted,
                            },
                        )?;
                        if exhausted {
                            self.emit_retry_exhausted_notice(&task.id, &error);
                        }
                        return Ok(None);
                    }
                    let delay = retry_delay_ms(retry_index + 1);
                    self.commit_fact(
                        &task.id,
                        GenerationLifecycleFact::SubmissionRetryScheduled {
                            attempt_id,
                            retry_index: retry_index + 1,
                            delay_ms: delay,
                            error: record,
                        },
                    )?;
                    self.emit_retry_notice(&task.id, retry_index + 1, delay, Some(&error), false);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    backoff_ms = Some(delay);
                }
            }
        }
        Err(BackendError::protocol(
            "submission retry loop exited without a result",
            json!({ "taskId": task.id }),
        ))
    }

    async fn poll_video(&self, task_id: &str) -> BackendResult<()> {
        self.poll_video_with_leases(task_id, Vec::new()).await
    }

    async fn poll_video_with_leases(
        &self,
        task_id: &str,
        staging_leases: Vec<super::staging::StagingLease>,
    ) -> BackendResult<()> {
        let poll_interval = video_poll_interval(
            self.storage
                .get_task_execution(task_id)?
                .remote_model_id_snapshot
                .as_deref(),
        );
        loop {
            let mut successful_observation = None;
            let mut backoff_ms = None;
            for retry_index in 0..=MAX_AUTOMATIC_RETRIES {
                let attempt_id = Uuid::new_v4().to_string();
                self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::BeginObservation {
                        attempt_id: attempt_id.clone(),
                        backoff_ms,
                    },
                )?;
                let task = self.storage.get_task_execution(task_id)?;
                match self.providers.observe(&task, &attempt_id).await {
                    Ok((value, response)) => {
                        successful_observation = Some(SuccessfulObservation {
                            attempt_id,
                            call_id: response.call_id.clone(),
                            observation: value,
                            tokens: parse_token_usage(&response),
                        });
                        break;
                    }
                    Err(error) => {
                        let record = error.runtime_record();
                        warn!(
                            "[generation] 视频状态查询尝试失败: taskId={}, attemptId={}, 第 {} 次观察尝试, 可自动重试={}, 错误: {record}",
                            task_id,
                            attempt_id,
                            retry_index + 1,
                            is_retryable_generation_error(&error)
                        );
                        if !is_retryable_generation_error(&error) {
                            error!(
                                "[generation] 视频状态查询遇到不可重试错误，任务转入终态: taskId={task_id}"
                            );
                            let conclusion = if matches!(error, BackendError::Transport(_)) {
                                GenerationTaskStatus::Unknown
                            } else {
                                GenerationTaskStatus::Failed
                            };
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationTerminated {
                                    attempt_id,
                                    conclusion,
                                    error: record,
                                },
                            )?;
                            return Ok(());
                        }
                        if retry_index == MAX_AUTOMATIC_RETRIES {
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationDegraded {
                                    attempt_id,
                                    error: record,
                                },
                            )?;
                            error!(
                                "[generation] 视频状态查询重试耗尽，标记查询健康状态为 degraded 并停止自动轮询（用户可手动重新查询）: taskId={task_id}"
                            );
                            self.emit_retry_exhausted_notice(task_id, &error);
                            return Ok(());
                        }
                        let delay = retry_delay_ms(retry_index + 1);
                        warn!(
                            "[generation] 视频状态查询失败，进入查询重试: taskId={task_id}, 第 {}/{MAX_AUTOMATIC_RETRIES} 次查询重试, 退避 {delay}ms（只重试查询，不会重新提交生成）",
                            retry_index + 1
                        );
                        self.commit_fact(
                            task_id,
                            GenerationLifecycleFact::ObservationRetryScheduled {
                                attempt_id,
                                retry_index: retry_index + 1,
                                delay_ms: delay,
                                error: record,
                            },
                        )?;
                        self.emit_retry_notice(task_id, retry_index + 1, delay, Some(&error), true);
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        backoff_ms = Some(delay);
                    }
                }
            }

            let successful_observation = successful_observation.ok_or_else(|| {
                BackendError::protocol(
                    "video observation loop produced no observation",
                    json!({ "taskId": task_id }),
                )
            })?;
            let SuccessfulObservation {
                attempt_id,
                call_id,
                observation,
                tokens,
            } = successful_observation;
            match observation.remote_status.to_ascii_uppercase().as_str() {
                "NOT_START" | "SUBMITTED" | "QUEUED" | "PENDING" => {
                    info!(
                        "[generation] 视频任务远端排队中: taskId={}, 远端状态={}, 进度={:?}",
                        task_id, observation.remote_status, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Queued {
                                progress: observation.progress,
                            },
                        },
                    )?;
                }
                "IN_PROGRESS" | "PROCESSING" | "RUNNING" => {
                    info!(
                        "[generation] 视频任务远端生成中: taskId={}, 远端状态={}, 进度={:?}",
                        task_id, observation.remote_status, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Running {
                                progress: observation.progress,
                            },
                        },
                    )?;
                }
                "SUCCESS" | "SUCCEEDED" | "COMPLETED" => {
                    let task = self.storage.get_task_execution(task_id)?;
                    let remote_task_id = task.remote_task_id.as_deref().ok_or_else(|| {
                        BackendError::protocol(
                            "successful video task has no remote task id",
                            json!({ "taskId": task_id }),
                        )
                    })?;
                    let event_service = self.clone();
                    let result = match observation.video_url.as_deref() {
                        Some(video_url) => {
                            info!(
                                "[generation] 视频生成成功，开始保存结果: taskId={}, remoteTaskId={}, videoUrl={}",
                                task_id,
                                remote_task_id,
                                super::provider::redact_url_string(video_url)
                            );
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationApplied {
                                    attempt_id,
                                    call_id,
                                    tokens,
                                    observation: GenerationRemoteObservation::Succeeded {
                                        result: self.local_results.pending_video_result(
                                            task_id,
                                            remote_task_id,
                                            video_url,
                                        ),
                                    },
                                },
                            )?;
                            self.local_results
                                .save_video(
                                    task_id,
                                    remote_task_id,
                                    video_url,
                                    move |record, preview_src| {
                                        event_service.emit_result_ready(record, preview_src);
                                    },
                                )
                                .await?
                        }
                        None => {
                            info!(
                                "[generation] 视频生成成功但观察响应缺失 result_url，尝试通过 content 接口获取视频字节: taskId={}, remoteTaskId={}",
                                task_id,
                                remote_task_id
                            );
                            let bytes = self
                                .providers
                                .fetch_video_content(&task, &attempt_id)
                                .await?;
                            info!(
                                "[generation] content 接口下载完成: taskId={}, remoteTaskId={}, 字节 {}",
                                task_id,
                                remote_task_id,
                                bytes.len()
                            );
                            self.commit_fact(
                                task_id,
                                GenerationLifecycleFact::ObservationApplied {
                                    attempt_id,
                                    call_id,
                                    tokens,
                                    observation: GenerationRemoteObservation::Succeeded {
                                        result: self.local_results.pending_video_content_result(
                                            task_id,
                                            remote_task_id,
                                        ),
                                    },
                                },
                            )?;
                            self.local_results
                                .save_video_bytes(
                                    task_id,
                                    remote_task_id,
                                    bytes,
                                    move |record, preview_src| {
                                        event_service.emit_result_ready(record, preview_src);
                                    },
                                )
                                .await?
                        }
                    };
                    let error_suffix = result
                        .error
                        .as_ref()
                        .map(|error| format!("，错误: {error}"))
                        .unwrap_or_default();
                    info!(
                        "[generation] 视频结果处理完成: taskId={}, remoteTaskId={}, 保存状态={}, 最终路径={:?}, 大小={} 字节{error_suffix}",
                        task_id,
                        remote_task_id,
                        result.save_status.as_str(),
                        result.final_path,
                        result
                            .byte_size
                            .map(|size| size.to_string())
                            .unwrap_or_default()
                    );
                    self.emit(
                        "generation:result-saved",
                        &json!({ "taskId": task_id, "result": result }),
                    );
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                "FAILURE" | "FAILED" => {
                    let failure = json!({
                        "kind": "remote_generation_failure",
                        "message": "remote video task reported FAILURE",
                        "remote": observation.failure
                    });
                    error!(
                        "[generation] 远端视频任务报告失败: taskId={}, 进度={:?}, 详情: {failure}",
                        task_id, observation.progress
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Failed {
                                progress: observation.progress,
                                error: failure,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                "UNKNOWN" => {
                    warn!("[generation] 远端视频任务状态未知，任务转入 unknown: taskId={task_id}");
                    let unknown = json!({
                        "kind": "remote_generation_unknown",
                        "message": "remote video task reported UNKNOWN",
                        "remoteStatus": observation.remote_status,
                    });
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Unknown {
                                progress: observation.progress,
                                error: unknown,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
                other => {
                    let error = json!({
                        "kind": "unknown_remote_status",
                        "message": format!("unknown remote video status: {other}"),
                        "remoteStatus": other
                    });
                    warn!(
                        "[generation] 远端视频任务返回未知状态，任务转入 unknown: taskId={}, 远端状态={other}",
                        task_id
                    );
                    self.commit_fact(
                        task_id,
                        GenerationLifecycleFact::ObservationApplied {
                            attempt_id,
                            call_id,
                            tokens,
                            observation: GenerationRemoteObservation::Unknown {
                                progress: observation.progress,
                                error,
                            },
                        },
                    )?;
                    self.cleanup_staging_leases(task_id, &staging_leases).await;
                    return Ok(());
                }
            }
            tokio::time::sleep(poll_interval).await;
        }
    }

    async fn cleanup_staging_leases(
        &self,
        task_id: &str,
        staging_leases: &[super::staging::StagingLease],
    ) {
        for lease in staging_leases {
            if let Err(error) = self.staging.cleanup_lease(lease).await {
                let _ = self.commit_fact(
                    task_id,
                    GenerationLifecycleFact::OperationalEvent {
                        event_type: GenerationOperationalEvent::StagingCleanupFailed,
                        payload: error.runtime_record(),
                    },
                );
            }
        }
    }

    fn emit_retry_notice(
        &self,
        task_id: &str,
        retry_index: u32,
        delay_ms: u64,
        error: Option<&BackendError>,
        query_only: bool,
    ) {
        let payload = json!({
            "taskId": task_id,
            "retry": retry_index,
            "maxRetries": MAX_AUTOMATIC_RETRIES,
            "delayMs": delay_ms,
            "queryOnly": query_only,
            "reason": error.map(BackendError::runtime_record),
            "risk": "请求可能已被供应商接收，自动重试可能造成重复生成或重复计费"
        });
        self.emit("generation:retry", &payload);
        let _ = self
            .app
            .notification()
            .builder()
            .title("生成任务自动重试")
            .body(format!(
                "任务 {task_id} 将进行第 {retry_index}/{MAX_AUTOMATIC_RETRIES} 次重试"
            ))
            .show();
    }

    fn emit_retry_exhausted_notice(&self, task_id: &str, error: &BackendError) {
        let payload = error.payload();
        error!(
            "[generation] 自动重试已耗尽，不再安排下一次重试: taskId={}, 错误类型={}, 详情={}",
            task_id, payload.kind, payload.message
        );
        let payload = json!({
            "taskId": task_id,
            "maxRetries": MAX_AUTOMATIC_RETRIES,
            "reason": error.runtime_record()
        });
        self.emit("generation:retry-exhausted", &payload);
        let _ = self
            .app
            .notification()
            .builder()
            .title("生成任务自动重试已耗尽")
            .body(format!("任务 {task_id} 已停止自动重试"))
            .show();
    }

    fn commit_fact(&self, task_id: &str, fact: GenerationLifecycleFact) -> BackendResult<()> {
        let receipt = self.lifecycle.commit(task_id, fact)?;
        if let Some(persisted) = receipt.transition.as_ref() {
            self.emit_persisted_transition(persisted);
        }
        Ok(())
    }

    fn emit_persisted_transition(&self, persisted: &PersistedTaskTransition) {
        let Some(event) = persisted.event.as_ref() else {
            return;
        };
        match event {
            PersistedTaskTransitionEvent::StateChanged {
                status,
                progress,
                error,
                ..
            } => {
                info!(
                    "[generation] 任务状态更新: taskId={}, status={}, progress={:?}, 携带错误={}",
                    persisted.task_id,
                    status.as_str(),
                    progress,
                    error.is_some()
                );
                self.emit(
                    "generation:state-changed",
                    &json!({
                        "taskId": persisted.task_id,
                        "status": status,
                        "progress": progress,
                        "error": error,
                    }),
                );
            }
            PersistedTaskTransitionEvent::QueryHealthChanged { health, .. } => {
                info!(
                    "[generation] 视频查询健康状态更新: taskId={}, queryHealth={}",
                    persisted.task_id,
                    health.as_str()
                );
            }
        }
    }

    fn finish_with_execution_error(&self, task_id: &str, error: BackendError) -> BackendResult<()> {
        let status = if matches!(error, BackendError::Transport(_)) {
            GenerationTaskStatus::Unknown
        } else {
            GenerationTaskStatus::Failed
        };
        let record = error.runtime_record();
        error!(
            "[generation] 任务后台执行异常终止: taskId={task_id}, 最终状态={}, 错误: {record}",
            status.as_str()
        );
        self.commit_fact(
            task_id,
            GenerationLifecycleFact::ExecutionTerminated {
                conclusion: status,
                error: record,
            },
        )
    }

    fn emit(&self, event: &str, payload: &Value) {
        if let Err(error) = self.app.emit(event, payload) {
            tauri_plugin_log::log::error!("failed to emit {event}: {error}");
        }
    }

    fn emit_result_ready(&self, result: &GenerationResultRecord, preview_src: Option<String>) {
        self.emit(
            "generation:result-ready",
            &json!({
                "taskId": result.task_id,
                "result": result,
                "previewSrc": preview_src
            }),
        );
    }
}

fn validate_start_command(command: &StartGenerationCommand) -> BackendResult<()> {
    let mut missing = Vec::new();
    if command.canvas_id.trim().is_empty() {
        missing.push("canvasId");
    }
    if command.source_node_id.trim().is_empty() {
        missing.push("sourceNodeId");
    }
    if command.provider_connection_id.trim().is_empty() {
        missing.push("providerConnectionId");
    }
    if command.model_definition_id.trim().is_empty() {
        missing.push("modelDefinitionId");
    }
    if command.generation_count != 1 {
        return Err(BackendError::validation(
            "generation count is fixed to 1 for the current API contracts",
            json!({ "generationCount": command.generation_count, "supported": 1 }),
        ));
    }
    if !missing.is_empty() {
        return Err(BackendError::validation(
            "generation command is missing required identities",
            json!({ "missing": missing }),
        ));
    }
    Ok(())
}

fn retry_delay_ms(retry_index: u32) -> u64 {
    let nominal = 2_000_u64 * 2_u64.pow(retry_index.saturating_sub(1));
    nominal + rand::rng().random_range(0..=(nominal / 5))
}

fn is_retryable_generation_error(error: &BackendError) -> bool {
    match error {
        BackendError::Transport(_) => true,
        BackendError::Protocol { details, .. } => {
            details
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || details
                    .get("httpStatus")
                    .and_then(Value::as_u64)
                    .is_some_and(|status| (500..600).contains(&status))
        }
        _ => false,
    }
}

fn video_poll_interval(model_id: Option<&str>) -> std::time::Duration {
    if model_id.is_some_and(|model_id| {
        let identity = model_id.to_ascii_lowercase();
        identity.contains("wan3.0-video") || identity.contains("wan3-0-video")
    }) {
        WAN_VIDEO_POLL_INTERVAL
    } else {
        DEFAULT_VIDEO_POLL_INTERVAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_uses_two_four_eight_second_nominal_windows() {
        for (index, nominal) in [(1, 2_000), (2, 4_000), (3, 8_000)] {
            let delay = retry_delay_ms(index);
            assert!(delay >= nominal);
            assert!(delay <= nominal + nominal / 5);
        }
    }

    #[test]
    fn only_transport_and_five_hundred_series_are_retryable() {
        assert!(is_retryable_generation_error(&BackendError::protocol(
            "server error",
            json!({ "httpStatus": 503 })
        )));
        assert!(!is_retryable_generation_error(&BackendError::protocol(
            "rate limited",
            json!({ "httpStatus": 429 })
        )));
        assert!(!is_retryable_generation_error(&BackendError::protocol(
            "parse error",
            json!({})
        )));
    }

    #[test]
    fn wan_video_tasks_use_the_documented_polling_cadence() {
        assert_eq!(
            video_poll_interval(Some("wan3.0-video-prime")),
            std::time::Duration::from_secs(15)
        );
        assert_eq!(
            video_poll_interval(Some("doubao-seedance-2-5-260628")),
            std::time::Duration::from_secs(5)
        );
    }
}
