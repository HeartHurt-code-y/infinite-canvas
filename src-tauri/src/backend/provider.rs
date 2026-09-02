use std::{collections::HashSet, sync::Arc};

use reqwest::{Method, multipart};
use serde_json::{Map, Value, json};
use tauri_plugin_log::log::{error, info};
use url::Url;
use uuid::Uuid;

use super::{
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    model_schema::{
        infer_catalog_schema, operations_from_schema, provider_scoped_model_definition_id,
    },
    storage::{
        GenerationLifecycleFact, GenerationTaskLifecycle, Storage, TaskExecutionRecord, now_ms,
    },
    types::{
        ConnectivityTestResult, GenerationOperation, MediaType, RawProviderResponse,
        RemoteModelOption, TokenUsage,
    },
};

pub const MOYU_ADAPTER_ID: &str = "moyu_v1";
/// 历史全局素材库令牌引用；仅用于兼容旧版本凭据。
///
/// 新版本优先使用 `asset-library-token:{provider_connection_id}`，避免不同
/// Base URL 共用凭据。未配置供应商专用令牌时才回退到本引用。
pub const ASSET_LIBRARY_CREDENTIAL_REF: &str = "asset-library-token";

pub fn asset_library_credential_ref(provider_connection_id: &str) -> String {
    format!("{ASSET_LIBRARY_CREDENTIAL_REF}:{provider_connection_id}")
}

#[derive(Clone)]
pub struct ProviderRuntime {
    storage: Arc<Storage>,
    lifecycle: GenerationTaskLifecycle,
    credentials: CredentialStore,
    client: reqwest::Client,
}

#[derive(Clone)]
pub struct ResolvedProviderContext {
    pub provider_connection_id: String,
    pub adapter_id: String,
    pub base_url: String,
    pub api_key_ref: String,
    api_key: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub media_type: MediaType,
    pub type_position: u32,
    pub role: String,
    pub display_name: String,
    pub stable_identity: Value,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub file_name: String,
    pub bytes: Option<Vec<u8>>,
    pub remote_reference: Option<String>,
    pub prompt_segment_index: Option<usize>,
}

impl ResolvedMedia {
    pub fn archive(&self) -> Value {
        json!({
            "mediaType": self.media_type,
            "typePosition": self.type_position,
            "role": self.role,
            "displayName": self.display_name,
            "stableIdentity": self.stable_identity,
            "mimeType": self.mime_type,
            "byteSize": self.byte_size,
            "sha256": self.sha256,
            "fileName": self.file_name,
            "promptSegmentIndex": self.prompt_segment_index,
            "remoteReference": self.remote_reference.as_ref().map(|value| redact_url_string(value)),
        })
    }
}

#[derive(Debug, Clone)]
pub enum CompiledContentItem {
    Text(String),
    Media {
        media_type: MediaType,
        type_position: u32,
    },
}

#[derive(Debug, Clone)]
pub struct ResolvedGeneration {
    pub rendered_prompt: String,
    pub content: Vec<CompiledContentItem>,
    pub images: Vec<ResolvedMedia>,
    pub videos: Vec<ResolvedMedia>,
    pub audios: Vec<ResolvedMedia>,
    pub parameters: Value,
    pub operation_schema: Value,
}

impl ResolvedGeneration {
    pub fn media(&self, media_type: MediaType, position: u32) -> Option<&ResolvedMedia> {
        let values = match media_type {
            MediaType::Image => &self.images,
            MediaType::Video => &self.videos,
            MediaType::Audio => &self.audios,
        };
        values.iter().find(|item| item.type_position == position)
    }

    pub fn archive(&self) -> Value {
        json!({
            "renderedPrompt": self.rendered_prompt,
            "content": self.content.iter().map(|item| match item {
                CompiledContentItem::Text(text) => json!({ "kind": "text", "text": text }),
                CompiledContentItem::Media { media_type, type_position } => json!({
                    "kind": "media",
                    "mediaType": media_type,
                    "typePosition": type_position
                }),
            }).collect::<Vec<_>>(),
            "images": self.images.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "videos": self.videos.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "audios": self.audios.iter().map(ResolvedMedia::archive).collect::<Vec<_>>(),
            "parameters": self.parameters,
            "operationSchema": self.operation_schema,
        })
    }
}

#[derive(Debug, Clone)]
pub enum ImageSource {
    Url(String),
    Base64(String),
}

#[derive(Debug, Clone)]
pub enum GenerationSubmission {
    Images(Vec<ImageSource>),
    RemoteVideoTask { task_id: String },
}

#[derive(Debug, Clone)]
pub struct GenerationObservation {
    pub remote_status: String,
    pub progress: Option<f64>,
    pub video_url: Option<String>,
    pub failure: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct CapturedHttpResponse {
    pub call_id: String,
    pub status: u16,
    pub headers: Value,
    pub body: String,
}

struct CapturedJsonRequest<'a> {
    phase: &'a str,
    method: Method,
    path: &'a str,
    body: &'a Value,
}

impl CapturedHttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn is_retryable(&self) -> bool {
        (500..600).contains(&self.status)
    }
}

impl ProviderRuntime {
    pub fn new(
        storage: Arc<Storage>,
        lifecycle: GenerationTaskLifecycle,
        credentials: CredentialStore,
    ) -> BackendResult<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("InfiniteCanvas/0.1")
            .build()?;
        Ok(Self {
            storage,
            lifecycle,
            credentials,
            client,
        })
    }

    /// 按模型定义 ID 回读其远程模型 ID（仅读本机定义表，不发网络请求）。
    /// 提示词优化的模型定义可能不是规范作用域格式，需要在定义表中兜底查找。
    pub fn model_definition_remote_id(&self, model_definition_id: &str) -> Option<String> {
        self.storage
            .list_model_definitions()
            .ok()?
            .into_iter()
            .find(|definition| definition.id == model_definition_id)
            .and_then(|definition| definition.remote_model_id)
    }

    pub fn resolve_current(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<ResolvedProviderContext> {
        let provider = self
            .storage
            .get_provider_connection(provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider_connection_id }),
            ));
        }
        self.resolve(
            provider.id,
            provider.adapter_id,
            provider.base_url,
            provider.api_key_ref,
        )
    }

    pub fn resolve_frozen(
        &self,
        task: &TaskExecutionRecord,
    ) -> BackendResult<ResolvedProviderContext> {
        self.resolve(
            task.provider_connection_id.clone(),
            task.adapter_id_snapshot.clone(),
            task.base_url_snapshot.clone(),
            task.api_key_ref_snapshot.clone(),
        )
    }

    /// 按模型的令牌分组解析凭据上下文：`token_group = None` 使用供应商主 API Key
    /// （等价 `resolve_current`），`Some(name)` 使用该分组自己的密钥。
    pub fn resolve_token_group(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<ResolvedProviderContext> {
        let provider = self
            .storage
            .get_provider_connection(provider_connection_id)?;
        if !provider.enabled {
            return Err(BackendError::validation(
                "provider connection is disabled",
                json!({ "providerConnectionId": provider_connection_id }),
            ));
        }
        let api_key_ref = self
            .storage
            .resolve_binding_credential_ref(provider_connection_id, token_group)?;
        self.resolve(
            provider.id,
            provider.adapter_id,
            provider.base_url,
            api_key_ref,
        )
    }

    fn resolve(
        &self,
        provider_connection_id: String,
        adapter_id: String,
        base_url: String,
        api_key_ref: String,
    ) -> BackendResult<ResolvedProviderContext> {
        if adapter_id != MOYU_ADAPTER_ID {
            return Err(BackendError::validation(
                "unsupported provider adapter",
                json!({ "adapterId": adapter_id, "supported": [MOYU_ADAPTER_ID] }),
            ));
        }
        validate_base_url(&base_url)?;
        let api_key = self.credentials.get(&api_key_ref)?;
        Ok(ResolvedProviderContext {
            provider_connection_id,
            adapter_id,
            base_url,
            api_key_ref,
            api_key,
        })
    }

    pub(super) fn resolve_asset_library(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<ResolvedProviderContext> {
        let mut context = self.resolve_current(provider_connection_id)?;
        let scoped_credential_ref = asset_library_credential_ref(provider_connection_id);
        for credential_ref in [scoped_credential_ref.as_str(), ASSET_LIBRARY_CREDENTIAL_REF] {
            if self.credentials.status(credential_ref)?.configured {
                context.api_key_ref = credential_ref.to_string();
                context.api_key = self.credentials.get(credential_ref)?;
                break;
            }
        }
        Ok(context)
    }

    pub async fn submit(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        resolved: &ResolvedGeneration,
    ) -> BackendResult<(GenerationSubmission, CapturedHttpResponse)> {
        let context = self.resolve_frozen(task)?;
        match task.operation {
            GenerationOperation::TextToImage => {
                let body = build_text_to_image_body(task, resolved)?;
                let path = request_path(&resolved.operation_schema, "/v1/images/generations")?;
                let response = self
                    .captured_json(
                        task,
                        attempt_id,
                        &context,
                        CapturedJsonRequest {
                            phase: "submit",
                            method: Method::POST,
                            path: &path,
                            body: &body,
                        },
                    )
                    .await?;
                let submission = parse_image_submission(&response, false)?;
                Ok((submission, response))
            }
            GenerationOperation::ImageToImage => {
                let path = request_path(&resolved.operation_schema, "/v1/images/edits")?;
                let response = self
                    .captured_image_edit(task, attempt_id, &context, resolved, &path)
                    .await?;
                let submission = parse_image_submission(&response, true)?;
                Ok((submission, response))
            }
            GenerationOperation::VideoGeneration => {
                let body = build_video_body(task, resolved)?;
                let path = request_path(&resolved.operation_schema, "/v1/video/generations")?;
                let response = self
                    .captured_json(
                        task,
                        attempt_id,
                        &context,
                        CapturedJsonRequest {
                            phase: "submit",
                            method: Method::POST,
                            path: &path,
                            body: &body,
                        },
                    )
                    .await?;
                let task_id = parse_video_task_id(&response)?;
                Ok((GenerationSubmission::RemoteVideoTask { task_id }, response))
            }
            // 文本模型不通过生成任务管线提交：提示词优化等功能按各自流程直接调用
            // 文本接口适配层，不会构造 TextGeneration 的生成任务。此分支防御性拦截
            // 意外流入的任务，避免走到图片/视频的请求构造导致格式不匹配。
            GenerationOperation::TextGeneration => Err(BackendError::validation(
                "text generation is not a canvas generation task; it is invoked directly by text-model features",
                json!({ "operation": task.operation.as_str(), "taskId": task.id }),
            )),
        }
    }

    pub async fn observe(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
    ) -> BackendResult<(GenerationObservation, CapturedHttpResponse)> {
        let remote_task_id = task.remote_task_id.as_deref().ok_or_else(|| {
            BackendError::validation(
                "video task has no remote task id",
                json!({ "taskId": task.id }),
            )
        })?;
        let context = self.resolve_frozen(task)?;
        let path = format!("/v1/video/generations/{remote_task_id}");
        let empty_body = Value::Null;
        let response = self
            .captured_json(
                task,
                attempt_id,
                &context,
                CapturedJsonRequest {
                    phase: "observe",
                    method: Method::GET,
                    path: &path,
                    body: &empty_body,
                },
            )
            .await?;
        let observation = parse_video_observation(&response)?;
        Ok((observation, response))
    }

    async fn captured_json(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        request: CapturedJsonRequest<'_>,
    ) -> BackendResult<CapturedHttpResponse> {
        let CapturedJsonRequest {
            phase,
            method,
            path,
            body,
        } = request;
        let url = endpoint(&context.base_url, path)?;
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": method.as_str(),
            "url": sanitize_url(&url),
            "headers": {
                "authorization": "已排除敏感凭据",
                "content-type": "application/json"
            },
            "bodyType": "json",
            "body": redact_request_value(body),
        });
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: phase.to_string(),
                request: archive,
            },
        )?;

        let sanitized_url = sanitize_url(&url);
        let mut request = self
            .client
            .request(method.clone(), url)
            .bearer_auth(&context.api_key);
        if method != Method::GET && !body.is_null() {
            request = request.json(body);
        }
        info!(
            "[provider] 发起供应商请求: taskId={}, phase={phase}, callId={}, {} {}",
            task.id,
            call_id,
            method.as_str(),
            sanitized_url
        );
        let started_at = std::time::Instant::now();
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("{} / phase={} / taskId={}", method.as_str(), phase, task.id),
                request,
            )
            .await?;
        info!(
            "[provider] 收到供应商响应: taskId={}, phase={phase}, callId={}, HTTP {}, 耗时 {}ms, 响应体 {} 字符",
            task.id,
            call_id,
            response.status,
            started_at.elapsed().as_millis(),
            response.body.len()
        );
        Ok(response)
    }

    /// 文本模型专用的可追溯 JSON 调用。与媒体生成共用 provider_calls，
    /// 因而会冻结实际 URL、协议头、完整请求体、完整原始响应和网络层错误。
    pub async fn captured_text_json(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        path: &str,
        body: &Value,
        extra_headers: &[(&str, &str)],
    ) -> BackendResult<CapturedHttpResponse> {
        let context = self.resolve_frozen(task)?;
        let url = endpoint(&context.base_url, path)?;
        let mut archived_headers = serde_json::Map::from_iter([
            (
                "authorization".to_string(),
                Value::String("已排除敏感凭据".to_string()),
            ),
            (
                "content-type".to_string(),
                Value::String("application/json".to_string()),
            ),
        ]);
        for (name, value) in extra_headers {
            archived_headers.insert((*name).to_string(), Value::String((*value).to_string()));
        }
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": "POST",
            "url": sanitize_url(&url),
            "headers": archived_headers,
            "bodyType": "json",
            "body": redact_request_value(body),
        });
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: "text_generation".to_string(),
                request: archive,
            },
        )?;

        let sanitized_url = sanitize_url(&url);
        let mut request = self
            .client
            .post(url)
            .bearer_auth(&context.api_key)
            .json(body);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        info!(
            "[provider] 发起文本模型请求: taskId={}, callId={}, POST {}",
            task.id, call_id, sanitized_url
        );
        let started_at = std::time::Instant::now();
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("POST / phase=text_generation / taskId={}", task.id),
                request,
            )
            .await?;
        info!(
            "[provider] 收到文本模型响应: taskId={}, callId={}, HTTP {}, 耗时 {}ms, 响应体 {} 字符",
            task.id,
            call_id,
            response.status,
            started_at.elapsed().as_millis(),
            response.body.len()
        );
        Ok(response)
    }

    async fn captured_image_edit(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        context: &ResolvedProviderContext,
        resolved: &ResolvedGeneration,
        path: &str,
    ) -> BackendResult<CapturedHttpResponse> {
        if resolved.images.is_empty() {
            return Err(BackendError::validation(
                "image-to-image requires at least one resolved image",
                json!({ "taskId": task.id }),
            ));
        }
        let remote_model_id = task
            .remote_model_id_snapshot
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::validation(
                    "image-to-image requires a remote model id",
                    json!({ "taskId": task.id, "modelDefinitionId": task.model_definition_id }),
                )
            })?;
        ensure_request_encoding(&resolved.operation_schema, "multipart")?;
        let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
        let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
        let image_field = request_field(&resolved.operation_schema, "imageField", "image[]")?;
        let mapped_parameters = mapped_parameters(resolved, "multipart")?;
        if mapped_parameters
            .iter()
            .any(|parameter| parameter.container != "multipart")
        {
            return Err(BackendError::validation(
                "multipart image parameters must use the multipart request container",
                json!({ "operationSchema": resolved.operation_schema }),
            ));
        }
        let mut archived_fields = vec![
            json!({ "name": model_field, "value": remote_model_id }),
            json!({ "name": prompt_field, "value": resolved.rendered_prompt }),
        ];
        archived_fields.extend(
            mapped_parameters
                .iter()
                .map(|parameter| json!({ "name": parameter.field, "value": parameter.value })),
        );
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let archive = json!({
            "providerConnectionId": context.provider_connection_id,
            "adapterId": context.adapter_id,
            "credentialReference": context.api_key_ref,
            "method": "POST",
            "url": sanitize_url(&url),
            "headers": {
                "authorization": "已排除敏感凭据",
                "content-type": "multipart/form-data; boundary=运行时生成，未持久化"
            },
            "bodyType": "multipart",
            "fields": archived_fields,
            "files": resolved.images.iter().map(|image| json!({
                "name": image_field,
                "mediaType": image.media_type,
                "typePosition": image.type_position,
                "fileName": image.file_name,
                "mimeType": image.mime_type,
                "byteSize": image.byte_size,
                "sha256": image.sha256,
                "stableIdentity": image.stable_identity,
            })).collect::<Vec<_>>()
        });
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(
            &task.id,
            GenerationLifecycleFact::ProviderCallPrepared {
                call_id: call_id.clone(),
                attempt_id: attempt_id.to_string(),
                phase: "submit".to_string(),
                request: archive,
            },
        )?;

        let mut form = multipart::Form::new()
            .text(model_field.clone(), remote_model_id.to_string())
            .text(prompt_field, resolved.rendered_prompt.clone());
        for parameter in mapped_parameters {
            form = form.text(parameter.field, multipart_value(&parameter.value));
        }
        for image in &resolved.images {
            let bytes = image.bytes.clone().ok_or_else(|| {
                BackendError::validation(
                    "resolved image has no bytes for multipart upload",
                    image.archive(),
                )
            })?;
            let part = multipart::Part::bytes(bytes)
                .file_name(image.file_name.clone())
                .mime_str(&image.mime_type)
                .map_err(BackendError::Transport)?;
            form = form.part(image_field.clone(), part);
        }
        let request = self
            .client
            .post(url)
            .bearer_auth(&context.api_key)
            .multipart(form);
        info!(
            "[provider] 发起供应商请求: taskId={}, phase=submit, callId={}, POST {} (multipart, 图片 {} 个)",
            task.id,
            call_id,
            sanitized_url,
            resolved.images.len()
        );
        let started_at = std::time::Instant::now();
        let response = self
            .send_captured(
                &task.id,
                &call_id,
                &format!("POST / phase=submit / taskId={}", task.id),
                request,
            )
            .await?;
        info!(
            "[provider] 收到供应商响应: taskId={}, phase=submit, callId={}, HTTP {}, 耗时 {}ms, 响应体 {} 字符",
            task.id,
            call_id,
            response.status,
            started_at.elapsed().as_millis(),
            response.body.len()
        );
        Ok(response)
    }

    async fn send_captured(
        &self,
        task_id: &str,
        call_id: &str,
        label: &str,
        request: reqwest::RequestBuilder,
    ) -> BackendResult<CapturedHttpResponse> {
        let sent_at = now_ms();
        self.lifecycle.commit(
            task_id,
            GenerationLifecycleFact::ProviderCallSent {
                call_id: call_id.to_string(),
                sent_at,
            },
        )?;
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let backend_error = BackendError::Transport(error);
                error!(
                    "[provider] 请求发送失败（网络层）: label={label}, 错误: {}",
                    backend_error.payload().message
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                let backend_error = BackendError::Transport(error);
                error!(
                    "[provider] 读取响应体失败（网络层）: label={label}, HTTP {status}, 错误: {}",
                    backend_error.payload().message
                );
                self.lifecycle.commit(
                    task_id,
                    GenerationLifecycleFact::ProviderCallFailed {
                        call_id: call_id.to_string(),
                        sent_at,
                        error: backend_error.runtime_record(),
                    },
                )?;
                return Err(backend_error);
            }
        };
        let body = String::from_utf8_lossy(&bytes).into_owned();
        self.lifecycle.commit(
            task_id,
            GenerationLifecycleFact::ProviderCallResponded {
                call_id: call_id.to_string(),
                sent_at,
                status,
                headers: headers.clone(),
                raw_response: body.clone(),
            },
        )?;
        Ok(CapturedHttpResponse {
            call_id: call_id.to_string(),
            status,
            headers,
            body,
        })
    }

    pub async fn raw_json_request(
        &self,
        provider_connection_id: &str,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> BackendResult<RawProviderResponse> {
        self.raw_json_request_with_headers(provider_connection_id, method, path, query, body, &[])
            .await
    }

    /// 与 `raw_json_request` 相同，但可指定模型令牌分组：
    /// `token_group = Some(name)` 时使用该分组的密钥发起请求（不同分组能访问的
    /// 模型目录不同，拉取模型与连通性测试需要按分组令牌进行）。
    pub async fn raw_json_request_with_token_group(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_token_group(provider_connection_id, token_group)?;
        self.send_raw_json_request(&context, method, path, query, body, &[])
            .await
    }

    /// 素材库专用直连请求。基础地址取自当前素材库供应商连接，Bearer 凭据
    /// 优先使用该连接专用的素材库令牌，再兼容旧版全局令牌。
    pub(super) async fn raw_asset_json_request(
        &self,
        provider_connection_id: &str,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        self.send_raw_json_request(&context, method, path, query, body, &[])
            .await
    }

    /// 素材库专用 multipart 直传请求（海外平台素材上传：`POST /v1/assets/upload`）。
    ///
    /// 海外平台（如 konjac.ai）的素材导入不使用 JSON `url` 方式（旧端点 `/v1/assets/async`
    /// 返回 404 Invalid URL），而是直接 multipart 上传文件字节。本方法复用素材库直连
    /// 通道（供应商连接 + Bearer 素材库令牌），构造 `file` 文件 part 与文本字段 part。
    pub(super) async fn raw_asset_multipart_request(
        &self,
        provider_connection_id: &str,
        path: &str,
        fields: &[(String, String)],
        file_field: &str,
        file_name: &str,
        mime_type: &str,
        file_bytes: Vec<u8>,
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let mut form = multipart::Form::new();
        for (name, value) in fields {
            form = form.text(name.clone(), value.clone());
        }
        let part = multipart::Part::bytes(file_bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(BackendError::Transport)?;
        form = form.part(file_field.to_string(), part);
        let request = self
            .client
            .post(url)
            .bearer_auth(&context.api_key)
            .multipart(form);
        info!(
            "[provider] 发起直连请求: providerConnectionId={}, credentialReference={}, POST {} (multipart)",
            context.provider_connection_id, context.api_key_ref, sanitized_url
        );
        let started_at = std::time::Instant::now();
        let response = request.send().await?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, POST {sanitized_url} (multipart), HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    /// 与 `raw_json_request` 相同，但支持附加自定义请求头。
    /// 文本模型适配层需要它传递协议特定头（如 Anthropic 的 `anthropic-version`）。
    #[allow(clippy::too_many_arguments)]
    pub async fn raw_json_request_with_headers(
        &self,
        provider_connection_id: &str,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        extra_headers: &[(&str, &str)],
    ) -> BackendResult<RawProviderResponse> {
        let context = self.resolve_current(provider_connection_id)?;
        self.send_raw_json_request(&context, method, path, query, body, extra_headers)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_raw_json_request(
        &self,
        context: &ResolvedProviderContext,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        extra_headers: &[(&str, &str)],
    ) -> BackendResult<RawProviderResponse> {
        let url = endpoint(&context.base_url, path)?;
        let sanitized_url = sanitize_url(&url);
        let method_str = method.as_str().to_string();
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&context.api_key);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        info!(
            "[provider] 发起直连请求: providerConnectionId={}, credentialReference={}, {method_str} {sanitized_url}",
            context.provider_connection_id, context.api_key_ref
        );
        let started_at = std::time::Instant::now();
        let response = request.send().await?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        info!(
            "[provider] 收到直连响应: providerConnectionId={}, credentialReference={}, {method_str} {sanitized_url}, HTTP {status}, 耗时 {}ms, 响应体 {} 字符",
            context.provider_connection_id,
            context.api_key_ref,
            started_at.elapsed().as_millis(),
            body.len()
        );
        Ok(RawProviderResponse {
            status,
            headers,
            body,
        })
    }

    /// 连通性测试：向供应商 `/v1/models` 发起一次真实的鉴权请求。
    ///
    /// 失败（网络不可达、凭据错误、非 2xx）转换为 `ok=false` 的结果而不是错误，
    /// 保存动作本身已经成功，前端需要把两种结果分开提示。
    ///
    /// `token_group` 非空时用该分组的令牌测试（客户曾反馈 as 分组令牌拉取失败，
    /// 单独测试分组连通性可直接定位密钥/权限问题）。
    pub async fn test_connection(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<ConnectivityTestResult> {
        let started_at = std::time::Instant::now();
        let elapsed_ms = || started_at.elapsed().as_millis() as u64;
        match self
            .raw_json_request_with_token_group(
                provider_connection_id,
                token_group,
                Method::GET,
                "/v1/models",
                &[],
                None,
            )
            .await
        {
            Ok(response) => {
                let ok = (200..300).contains(&response.status);
                Ok(ConnectivityTestResult {
                    ok,
                    http_status: Some(response.status),
                    elapsed_ms: elapsed_ms(),
                    reason: (!ok).then(|| "http-error".to_string()),
                    detail: (!ok).then(|| truncate_connectivity_detail(&response.body)),
                })
            }
            Err(error) => Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: elapsed_ms(),
                reason: Some(connectivity_error_reason(&error).to_string()),
                detail: Some(truncate_connectivity_detail(&error.to_string())),
            }),
        }
    }

    pub async fn list_models(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<Vec<RemoteModelOption>> {
        let response = self
            .raw_json_request_with_token_group(
                provider_connection_id,
                token_group,
                Method::GET,
                "/v1/models",
                &[],
                None,
            )
            .await?;
        let mut models = parse_model_catalog(&response)?;
        let definitions = self.storage.list_model_definitions()?;
        let bindings = self.storage.list_bindings(Some(provider_connection_id))?;

        for model in &mut models {
            let scoped_definition_id =
                provider_scoped_model_definition_id(provider_connection_id, &model.id);
            let binding = bindings
                .iter()
                .find(|binding| binding.model_definition_id == scoped_definition_id)
                .or_else(|| {
                    bindings.iter().find(|binding| {
                        binding.enabled
                            && binding.remote_model_id.as_deref() == Some(model.id.as_str())
                    })
                })
                .or_else(|| {
                    bindings.iter().find(|binding| {
                        binding.remote_model_id.as_deref() == Some(model.id.as_str())
                    })
                });
            let definition = binding
                .and_then(|binding| {
                    definitions
                        .iter()
                        .find(|definition| definition.id == binding.model_definition_id)
                })
                .or_else(|| {
                    definitions.iter().find(|definition| {
                        !definition.id.starts_with("remote::")
                            && (definition.remote_model_id.as_deref() == Some(model.id.as_str())
                                || definition.id == model.id)
                    })
                });
            model.model_definition_id = scoped_definition_id;
            if let Some(definition) = definition {
                model.operation_schema = definition.operations.clone();
                model.suggested_operations = operations_from_schema(&definition.operations);
            }
            model.has_configured_binding = binding.is_some();
            model.configured_operations = binding
                .filter(|binding| binding.enabled)
                .map(|binding| binding.enabled_operations.clone())
                .unwrap_or_default();
            // 令牌分组：优先取已保存绑定上的分组（回显用户配置），
            // 否则标记本次拉取所用的分组，方便前端预选同一个分组令牌。
            model.token_group = binding
                .and_then(|binding| binding.token_group.clone())
                .or_else(|| token_group.map(ToOwned::to_owned));
        }

        Ok(models)
    }

    pub(super) async fn captured_asset_get(
        &self,
        task: &TaskExecutionRecord,
        attempt_id: &str,
        provider_connection_id: &str,
        asset_id: &str,
    ) -> BackendResult<(CapturedHttpResponse, Value)> {
        let context = self.resolve_asset_library(provider_connection_id)?;
        let body = json!({ "id": asset_id });
        let response = self
            .captured_json(
                task,
                attempt_id,
                &context,
                CapturedJsonRequest {
                    phase: "resolve_asset",
                    method: Method::POST,
                    path: "/v1/assets/get",
                    body: &body,
                },
            )
            .await?;
        require_success(&response)?;
        let value = serde_json::from_str(&response.body)?;
        Ok((response, value))
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

#[derive(Debug, Clone)]
struct MappedParameter {
    container: String,
    field: String,
    value: Value,
}

fn request_path(operation_schema: &Value, fallback: &str) -> BackendResult<String> {
    let path = operation_schema
        .pointer("/request/path")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('?')
        || path.contains('#')
        || path.len() > 512
    {
        return Err(BackendError::validation(
            "model request path must be a relative absolute-path without query or fragment",
            json!({ "path": path }),
        ));
    }
    Ok(path.to_string())
}

fn ensure_request_encoding(operation_schema: &Value, expected: &str) -> BackendResult<()> {
    let encoding = operation_schema
        .pointer("/request/encoding")
        .and_then(Value::as_str)
        .unwrap_or(expected);
    if encoding != expected {
        return Err(BackendError::validation(
            "model request encoding is not supported by this operation profile",
            json!({ "encoding": encoding, "expected": expected }),
        ));
    }
    Ok(())
}

fn request_field(operation_schema: &Value, setting: &str, fallback: &str) -> BackendResult<String> {
    let pointer = format!("/request/{setting}");
    let field = operation_schema
        .pointer(&pointer)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !valid_request_field_name(field) {
        return Err(BackendError::validation(
            "model request field name is invalid",
            json!({ "setting": setting, "field": field }),
        ));
    }
    Ok(field.to_string())
}

fn valid_request_field_name(field: &str) -> bool {
    !field.is_empty()
        && field.len() <= 128
        && field.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '[' | ']')
        })
}

fn mapped_parameters(
    resolved: &ResolvedGeneration,
    fallback_container: &str,
) -> BackendResult<Vec<MappedParameter>> {
    let values = resolved.parameters.as_object().ok_or_else(|| {
        BackendError::validation(
            "normalized generation parameters must be a JSON object",
            json!({ "parameters": resolved.parameters }),
        )
    })?;
    let definitions = resolved
        .operation_schema
        .get("parameters")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let operation_container = resolved
        .operation_schema
        .pointer("/request/parameterContainer")
        .and_then(Value::as_str)
        .unwrap_or(fallback_container);
    let has_media =
        !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty();

    let mut mapped = Vec::new();
    for (key, value) in values {
        let definition = definitions
            .get(key)
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BackendError::validation(
                    "normalized parameter is absent from the frozen model schema",
                    json!({ "parameter": key }),
                )
            })?;
        if has_media
            && value.as_bool() == Some(true)
            && definition
                .get("requiresNoMedia")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(BackendError::validation(
                "model parameter requires a generation request without media inputs",
                json!({ "parameter": key }),
            ));
        }
        let field = definition
            .get("requestField")
            .and_then(Value::as_str)
            .unwrap_or(key)
            .trim();
        if !valid_request_field_name(field) {
            return Err(BackendError::validation(
                "model parameter request field name is invalid",
                json!({ "parameter": key, "requestField": field }),
            ));
        }
        let container = definition
            .get("requestLocation")
            .and_then(Value::as_str)
            .unwrap_or(operation_container)
            .to_string();
        let value = match definition.get("transform").and_then(Value::as_str) {
            Some("web_search_tool") if value.as_bool() == Some(true) => {
                json!([{ "type": "web_search" }])
            }
            Some("web_search_tool") => continue,
            Some(transform) => {
                return Err(BackendError::validation(
                    "model parameter uses an unsupported request transform",
                    json!({ "parameter": key, "transform": transform }),
                ));
            }
            None => value.clone(),
        };
        mapped.push(MappedParameter {
            container,
            field: field.to_string(),
            value,
        });
    }
    Ok(mapped)
}

fn insert_mapped_parameters(
    body: &mut Map<String, Value>,
    metadata_field: &str,
    parameters: Vec<MappedParameter>,
) -> BackendResult<()> {
    for parameter in parameters {
        let target = match parameter.container.as_str() {
            "root" => &mut *body,
            "metadata" => {
                let metadata = body
                    .entry(metadata_field.to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                metadata.as_object_mut().ok_or_else(|| {
                    BackendError::validation(
                        "request metadata field collides with a non-object value",
                        json!({ "metadataField": metadata_field }),
                    )
                })?
            }
            other => {
                return Err(BackendError::validation(
                    "model parameter request container is unsupported",
                    json!({ "container": other, "parameter": parameter.field }),
                ));
            }
        };
        if target.contains_key(&parameter.field) {
            return Err(BackendError::validation(
                "model parameter request field collides with another request field",
                json!({ "field": parameter.field, "container": parameter.container }),
            ));
        }
        target.insert(parameter.field, parameter.value);
    }
    Ok(())
}

fn multipart_value(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn build_text_to_image_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    if !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation(
            "text-to-image cannot encode media references",
            resolved.archive(),
        ));
    }
    if resolved.rendered_prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "text-to-image prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;
    let mut body = Map::new();
    if let Some(model) = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
    {
        body.insert(model_field, Value::String(model.to_string()));
    }
    body.insert(
        prompt_field,
        Value::String(resolved.rendered_prompt.clone()),
    );
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

fn build_video_body(
    task: &TaskExecutionRecord,
    resolved: &ResolvedGeneration,
) -> BackendResult<Value> {
    let model = task
        .remote_model_id_snapshot
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            BackendError::validation(
                "video generation requires a remote model id",
                json!({ "taskId": task.id, "modelDefinitionId": task.model_definition_id }),
            )
        })?;
    let has_media =
        !resolved.images.is_empty() || !resolved.videos.is_empty() || !resolved.audios.is_empty();
    let accepts_media_only_prompt = has_media
        && resolved
            .operation_schema
            .pointer("/request/promptMode")
            .and_then(Value::as_str)
            == Some("prompt_or_media");
    if resolved.rendered_prompt.trim().is_empty() && !accepts_media_only_prompt {
        return Err(BackendError::validation(
            "video prompt must not be empty",
            json!({ "taskId": task.id }),
        ));
    }
    ensure_request_encoding(&resolved.operation_schema, "json")?;
    match resolved
        .operation_schema
        .pointer("/request/mediaEncoding")
        .and_then(Value::as_str)
    {
        Some("wan_media_array") => return build_wan_video_body(model, resolved),
        Some(unsupported) => {
            return Err(BackendError::validation(
                "video request uses an unsupported media encoding",
                json!({ "mediaEncoding": unsupported }),
            ));
        }
        None => {}
    }
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let content_field = request_field(&resolved.operation_schema, "contentField", "content")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;
    let content_container =
        request_field(&resolved.operation_schema, "contentContainer", "metadata")?;

    let mut content = Vec::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) if !text.is_empty() => {
                content.push(json!({ "type": "text", "text": text }));
            }
            CompiledContentItem::Text(_) => {}
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => {
                let media = resolved.media(*media_type, *type_position).ok_or_else(|| {
                    BackendError::protocol(
                        "compiled media position is missing",
                        json!({ "mediaType": media_type, "typePosition": type_position }),
                    )
                })?;
                let reference = media.remote_reference.as_ref().ok_or_else(|| {
                    BackendError::validation(
                        "video media input has no remote-readable reference",
                        media.archive(),
                    )
                })?;
                content.push(video_media_content(media, reference));
            }
        }
    }
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
        .filter(|media| media.prompt_segment_index.is_none())
    {
        let reference = media.remote_reference.as_ref().ok_or_else(|| {
            BackendError::validation(
                "video media input has no remote-readable reference",
                media.archive(),
            )
        })?;
        content.push(video_media_content(media, reference));
    }

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    // prompt 字段仅保留简短占位符，真正生效的提示词文本由 `content` 中的 text 项承载。
    body.insert(prompt_field, Value::String(VIDEO_PROMPT_PLACEHOLDER.to_string()));
    match content_container.as_str() {
        "root" => {
            body.insert(content_field, Value::Array(content));
        }
        "metadata" => {
            let mut metadata = Map::new();
            metadata.insert(content_field, Value::Array(content));
            body.insert(metadata_field.clone(), Value::Object(metadata));
        }
        other => {
            return Err(BackendError::validation(
                "video content container is unsupported",
                json!({ "contentContainer": other }),
            ));
        }
    }
    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "metadata")?,
    )?;
    Ok(Value::Object(body))
}

/// 通用视频 body 的 prompt 占位符：prompt 字段仅保留简短占位，真正生效的
/// 提示词文本由 `metadata.content` 中的 text 项承载，媒体引用由 image_url 等项承载。
const VIDEO_PROMPT_PLACEHOLDER: &str = "...";

fn build_wan_video_body(model: &str, resolved: &ResolvedGeneration) -> BackendResult<Value> {
    validate_wan_media(resolved)?;
    let model_field = request_field(&resolved.operation_schema, "modelField", "model")?;
    let prompt_field = request_field(&resolved.operation_schema, "promptField", "prompt")?;
    let media_field = request_field(&resolved.operation_schema, "mediaField", "media")?;
    let metadata_field = request_field(&resolved.operation_schema, "metadataField", "metadata")?;

    let mut body = Map::new();
    body.insert(model_field, Value::String(model.to_string()));
    let prompt = wan_prompt(resolved);
    if !prompt.trim().is_empty() {
        body.insert(prompt_field, Value::String(prompt));
    }

    let media = resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
        .map(|item| {
            let reference = item.remote_reference.as_ref().ok_or_else(|| {
                BackendError::validation(
                    "video media input has no remote-readable reference",
                    item.archive(),
                )
            })?;
            Ok(json!({ "type": item.role, "url": reference }))
        })
        .collect::<BackendResult<Vec<_>>>()?;
    if !media.is_empty() {
        body.insert(media_field, Value::Array(media));
    }

    insert_mapped_parameters(
        &mut body,
        &metadata_field,
        mapped_parameters(resolved, "root")?,
    )?;
    Ok(Value::Object(body))
}

fn wan_prompt(resolved: &ResolvedGeneration) -> String {
    let mut prompt = String::new();
    for item in &resolved.content {
        match item {
            CompiledContentItem::Text(text) => prompt.push_str(text),
            CompiledContentItem::Media {
                media_type,
                type_position,
            } => {
                let label = match media_type {
                    MediaType::Image => "图",
                    MediaType::Video => "视频",
                    MediaType::Audio => "音频",
                };
                prompt.push_str(&format!("{label}{type_position}"));
            }
        }
    }
    prompt
}

fn validate_wan_media(resolved: &ResolvedGeneration) -> BackendResult<()> {
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    const ALLOWED_IMAGE_MIME_TYPES: [&str; 5] = [
        "image/jpeg",
        "image/png",
        "image/bmp",
        "image/x-ms-bmp",
        "image/webp",
    ];

    let mut first_frames = 0_usize;
    let mut last_frames = 0_usize;
    let mut reference_images = 0_usize;
    let mut reference_videos = 0_usize;
    let mut reference_audios = 0_usize;
    for media in resolved
        .images
        .iter()
        .chain(&resolved.videos)
        .chain(&resolved.audios)
    {
        match (media.role.as_str(), media.media_type) {
            ("first_frame", MediaType::Image) => first_frames += 1,
            ("last_frame", MediaType::Image) => last_frames += 1,
            ("reference_image", MediaType::Image) => reference_images += 1,
            ("reference_video", MediaType::Video) => reference_videos += 1,
            ("reference_audio", MediaType::Audio) => reference_audios += 1,
            _ => {
                return Err(BackendError::validation(
                    "Wan 3.0 media role is incompatible with the resolved media type",
                    json!({
                        "role": media.role,
                        "mediaType": media.media_type,
                        "displayName": media.display_name
                    }),
                ));
            }
        }
        if media.media_type == MediaType::Image {
            if !ALLOWED_IMAGE_MIME_TYPES.contains(&media.mime_type.as_str()) {
                return Err(BackendError::validation(
                    "Wan 3.0 image input uses an unsupported format",
                    json!({ "mimeType": media.mime_type, "displayName": media.display_name }),
                ));
            }
            if media.byte_size > MAX_IMAGE_BYTES {
                return Err(BackendError::validation(
                    "Wan 3.0 image input exceeds the 20 MB limit",
                    json!({
                        "byteSize": media.byte_size,
                        "maximumByteSize": MAX_IMAGE_BYTES,
                        "displayName": media.display_name
                    }),
                ));
            }
        }
    }

    if first_frames > 1
        || last_frames > 1
        || reference_images > 10
        || reference_videos > 5
        || reference_audios > 5
    {
        return Err(BackendError::validation(
            "Wan 3.0 media input exceeds a documented count limit",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    let has_frame_inputs = first_frames > 0 || last_frames > 0;
    let has_reference_inputs = reference_images > 0 || reference_videos > 0 || reference_audios > 0;
    if has_frame_inputs && has_reference_inputs {
        return Err(BackendError::validation(
            "Wan 3.0 frame inputs and reference inputs cannot be mixed",
            json!({
                "firstFrames": first_frames,
                "lastFrames": last_frames,
                "referenceImages": reference_images,
                "referenceVideos": reference_videos,
                "referenceAudios": reference_audios
            }),
        ));
    }
    Ok(())
}

fn video_media_content(media: &ResolvedMedia, reference: &str) -> Value {
    match media.media_type {
        MediaType::Image => json!({
            "type": "image_url",
            "image_url": { "url": reference },
            "role": media.role,
        }),
        MediaType::Video => json!({
            "type": "video_url",
            "video_url": { "url": reference },
            "role": media.role,
        }),
        MediaType::Audio => json!({
            "type": "audio_url",
            "audio_url": { "url": reference },
            "role": media.role,
        }),
    }
}

fn parse_image_submission(
    response: &CapturedHttpResponse,
    require_base64: bool,
) -> BackendResult<GenerationSubmission> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let mut sources = Vec::new();
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        for item in items {
            let url = item.get("url").and_then(Value::as_str);
            let base64 = item.get("b64_json").and_then(Value::as_str);
            if require_base64 {
                if let Some(base64) = base64.filter(|value| !value.is_empty()) {
                    sources.push(ImageSource::Base64(base64.to_string()));
                }
            } else if let Some(url) = url.filter(|value| !value.is_empty()) {
                sources.push(ImageSource::Url(url.to_string()));
            } else if let Some(base64) = base64.filter(|value| !value.is_empty()) {
                sources.push(ImageSource::Base64(base64.to_string()));
            }
        }
    }
    if !require_base64 {
        if let Some(urls) = value.pointer("/data/image_urls").and_then(Value::as_array) {
            sources.extend(
                urls.iter()
                    .filter_map(Value::as_str)
                    .filter(|url| !url.is_empty())
                    .map(|url| ImageSource::Url(url.to_string())),
            );
        }
    }
    if sources.is_empty() {
        return Err(BackendError::protocol(
            "image response did not contain a valid result",
            json!({ "httpStatus": response.status, "rawResponse": response.body }),
        ));
    }
    Ok(GenerationSubmission::Images(sources))
}

fn parse_video_task_id(response: &CapturedHttpResponse) -> BackendResult<String> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    value
        .get("task_id")
        .or_else(|| value.get("id"))
        .or_else(|| value.pointer("/data/task_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            BackendError::protocol(
                "video submission did not return task_id",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })
}

fn parse_video_observation(
    response: &CapturedHttpResponse,
) -> BackendResult<GenerationObservation> {
    require_success(response)?;
    let value: Value = serde_json::from_str(&response.body)?;
    let remote_status = value
        .pointer("/data/status")
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            BackendError::protocol(
                "video observation did not return status",
                json!({ "httpStatus": response.status, "rawResponse": response.body }),
            )
        })?
        .to_string();
    let progress = value
        .pointer("/data/progress")
        .or_else(|| value.get("progress"))
        .and_then(parse_progress);
    let video_url = value
        .pointer("/data/result_url")
        .or_else(|| value.pointer("/data/data/data/content/video_url"))
        .or_else(|| value.pointer("/data/data/content/video_url"))
        .or_else(|| value.pointer("/data/content/video_url"))
        .or_else(|| value.pointer("/content/video_url"))
        .or_else(|| value.pointer("/data/metadata/url"))
        .or_else(|| value.pointer("/metadata/url"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let fail_reason = value.pointer("/data/fail_reason").cloned();
    let upstream_error = value.pointer("/data/data/error").cloned();
    let remote_failed = matches!(
        remote_status.to_ascii_uppercase().as_str(),
        "FAILURE" | "FAILED"
    );
    let failure = if remote_failed
        && (fail_reason.as_ref().is_some_and(|value| !value.is_null())
            || upstream_error
                .as_ref()
                .is_some_and(|value| !value.is_null()))
    {
        Some(json!({
            "failReason": fail_reason,
            "upstreamError": upstream_error
        }))
    } else {
        None
    };
    Ok(GenerationObservation {
        remote_status,
        progress,
        video_url,
        failure,
    })
}

fn parse_progress(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .map(str::trim)
            .and_then(|value| value.strip_suffix('%').unwrap_or(value).trim().parse().ok())
    })
}

/// 从供应商响应中提取 token 用量（usage 对象）。图片同步响应在顶层或
/// `data.usage`，视频轮询响应在 `data.data.usage`；三种位置按序探测。
/// usage 内至少要有一个已知的 token 字段才视为有效，避免把空对象当作用量。
pub fn parse_token_usage(response: &CapturedHttpResponse) -> Option<TokenUsage> {
    if !response.is_success() {
        return None;
    }
    let value: Value = serde_json::from_str(&response.body).ok()?;
    let usage = value
        .pointer("/data/data/usage")
        .or_else(|| value.pointer("/data/usage"))
        .or_else(|| value.get("usage"))
        .or_else(|| value.get("usageMetadata"))?;
    let usage = usage.as_object()?;
    let read_tokens = |keys: &[&str]| -> Option<u64> {
        keys.iter().find_map(|key| {
            usage.get(*key).and_then(|field| {
                field
                    .as_u64()
                    .or_else(|| field.as_i64().map(|v| v.max(0) as u64))
            })
        })
    };
    let prompt_tokens = read_tokens(&["prompt_tokens", "input_tokens", "promptTokenCount"]);
    let completion_tokens =
        read_tokens(&["completion_tokens", "output_tokens", "candidatesTokenCount"]);
    let total_tokens = read_tokens(&["total_tokens", "totalTokenCount"]).or_else(|| {
        prompt_tokens
            .zip(completion_tokens)
            .map(|(prompt, output)| prompt + output)
    });
    let tokens = TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    };
    (tokens.prompt_tokens.is_some()
        || tokens.completion_tokens.is_some()
        || tokens.total_tokens.is_some())
    .then_some(tokens)
}

fn require_success(response: &CapturedHttpResponse) -> BackendResult<()> {
    if response.is_success() {
        Ok(())
    } else {
        Err(BackendError::protocol(
            format!("provider returned HTTP {}", response.status),
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
                "retryable": response.is_retryable(),
            }),
        ))
    }
}

fn parse_model_catalog(response: &RawProviderResponse) -> BackendResult<Vec<RemoteModelOption>> {
    if !(200..300).contains(&response.status) {
        return Err(BackendError::protocol(
            format!(
                "provider returned HTTP {} while listing models",
                response.status
            ),
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
            }),
        ));
    }

    let value: Value = serde_json::from_str(&response.body).map_err(|error| {
        BackendError::protocol(
            "model list response is not valid JSON",
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
                "jsonError": error.to_string(),
            }),
        )
    })?;
    let items = match &value {
        Value::Array(items) => Some(items),
        Value::Object(_) => value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.get("models").and_then(Value::as_array))
            .or_else(|| value.pointer("/data/models").and_then(Value::as_array)),
        _ => None,
    }
    .ok_or_else(|| {
        BackendError::protocol(
            "model list response did not contain an array",
            json!({
                "httpStatus": response.status,
                "headers": response.headers,
                "rawResponse": response.body,
            }),
        )
    })?;

    let mut seen = HashSet::new();
    let models = items
        .iter()
        .filter_map(|item| {
            let (id, display_name, owned_by) = match item {
                Value::String(id) => (id.as_str(), id.as_str(), None),
                Value::Object(_) => {
                    let id = item
                        .get("id")
                        .or_else(|| item.get("model_id"))
                        .or_else(|| item.get("model"))
                        .and_then(Value::as_str)?;
                    let display_name = item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or(id);
                    let owned_by = item
                        .get("owned_by")
                        .or_else(|| item.get("provider"))
                        .and_then(Value::as_str);
                    (id, display_name, owned_by)
                }
                _ => return None,
            };
            let id = id.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let operation_schema = infer_catalog_schema(item, id, display_name);
            let suggested_operations = operations_from_schema(&operation_schema);
            Some(RemoteModelOption {
                id: id.to_string(),
                model_definition_id: String::new(),
                display_name: display_name.to_string(),
                owned_by: owned_by.map(ToOwned::to_owned),
                has_configured_binding: false,
                configured_operations: Vec::new(),
                suggested_operations,
                operation_schema,
                token_group: None,
            })
        })
        .collect();
    Ok(models)
}

pub fn endpoint(base_url: &str, path: &str) -> BackendResult<Url> {
    let mut url = Url::parse(base_url)?;
    let base_segments = url
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let requested_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let overlap = (1..=base_segments.len().min(requested_segments.len()))
        .rev()
        .find(|count| base_segments[base_segments.len() - count..] == requested_segments[..*count])
        .unwrap_or(0);
    let joined_segments = base_segments
        .iter()
        .copied()
        .chain(requested_segments[overlap..].iter().copied())
        .collect::<Vec<_>>();
    url.set_path(&format!("/{}", joined_segments.join("/")));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn validate_base_url(base_url: &str) -> BackendResult<()> {
    let url = Url::parse(base_url)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(BackendError::validation(
            "base URL must be an absolute HTTP or HTTPS URL",
            json!({ "baseUrl": base_url }),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BackendError::validation(
            "base URL must not contain credentials, query parameters, or a fragment",
            json!({ "baseUrl": base_url }),
        ));
    }
    Ok(())
}

pub fn sanitize_url(url: &Url) -> String {
    let mut sanitized = url.clone();
    let _ = sanitized.set_username("");
    let _ = sanitized.set_password(None);
    if sanitized
        .query_pairs()
        .any(|(key, _)| sensitive_query_key(&key))
    {
        sanitized.set_query(None);
    }
    sanitized.to_string()
}

pub(crate) fn redact_url_string(value: &str) -> String {
    Url::parse(value)
        .map(|url| sanitize_url(&url))
        .unwrap_or_else(|_| value.to_string())
}

fn sensitive_query_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("signature")
        || key.contains("credential")
        || key.contains("security-token")
        || key.contains("accesskey")
        || key.contains("api_key")
        || key == "token"
        || key.starts_with("x-tos-")
        || key.starts_with("x-amz-")
}

pub(crate) fn redact_request_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(redact_request_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if lower.contains("api_key") || lower == "authorization" || lower == "cookie" {
                        (key.clone(), Value::String("已排除敏感凭据".into()))
                    } else {
                        (key.clone(), redact_request_value(value))
                    }
                })
                .collect(),
        ),
        Value::String(value) => Value::String(redact_url_string(value)),
        other => other.clone(),
    }
}

/// 连通性测试失败详情的截断长度：保留足够定位问题的前缀，避免错误横幅被长响应体撑爆。
const CONNECTIVITY_DETAIL_MAX_CHARS: usize = 400;

pub(crate) fn truncate_connectivity_detail(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= CONNECTIVITY_DETAIL_MAX_CHARS {
        return trimmed.to_string();
    }
    let truncated: String = trimmed
        .chars()
        .take(CONNECTIVITY_DETAIL_MAX_CHARS)
        .collect();
    format!("{truncated}…")
}

/// 把底层错误映射为机器可读的连通性失败类别，供前端生成本地化提示。
fn connectivity_error_reason(error: &BackendError) -> &'static str {
    match error {
        BackendError::Transport(_) => "network-error",
        BackendError::NotFound(_) | BackendError::Validation { .. } => "not-configured",
        BackendError::Credential(_) => "credential-error",
        _ => "error",
    }
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> Value {
    let mut values = Map::new();
    for (name, value) in headers {
        let rendered = value
            .to_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|_| format!("{:?}", value.as_bytes()));
        values
            .entry(name.as_str().to_string())
            .and_modify(|current| {
                if let Value::Array(items) = current {
                    items.push(Value::String(rendered.clone()));
                } else {
                    let previous = current.take();
                    *current = Value::Array(vec![previous, Value::String(rendered.clone())]);
                }
            })
            .or_insert(Value::String(rendered));
    }
    Value::Object(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(operation: GenerationOperation) -> TaskExecutionRecord {
        TaskExecutionRecord {
            id: "task-1".into(),
            operation,
            status: super::super::types::GenerationTaskStatus::Created,
            provider_connection_id: "company".into(),
            provider_display_name_snapshot: "Company".into(),
            adapter_id_snapshot: MOYU_ADAPTER_ID.into(),
            base_url_snapshot: "https://example.com/v1".into(),
            api_key_ref_snapshot: "provider:company:api-key".into(),
            model_definition_id: "company-model".into(),
            remote_model_id_snapshot: Some("company-model-v2".into()),
            remote_task_id: None,
            logical_request: json!({}),
            resolved_request: None,
        }
    }

    fn resolved(operation_schema: Value, parameters: Value) -> ResolvedGeneration {
        ResolvedGeneration {
            rendered_prompt: "A train arrives".into(),
            content: vec![CompiledContentItem::Text("A train arrives".into())],
            images: Vec::new(),
            videos: Vec::new(),
            audios: Vec::new(),
            parameters,
            operation_schema,
        }
    }

    fn resolved_media(
        media_type: MediaType,
        type_position: u32,
        role: &str,
        url: &str,
        prompt_segment_index: Option<usize>,
    ) -> ResolvedMedia {
        ResolvedMedia {
            media_type,
            type_position,
            role: role.into(),
            display_name: format!("asset-{type_position}"),
            stable_identity: json!({ "id": type_position }),
            mime_type: match media_type {
                MediaType::Image => "image/png",
                MediaType::Video => "video/mp4",
                MediaType::Audio => "audio/mpeg",
            }
            .into(),
            byte_size: 1024,
            sha256: "abc".into(),
            file_name: format!("asset-{type_position}"),
            bytes: None,
            remote_reference: Some(url.into()),
            prompt_segment_index,
        }
    }

    #[test]
    fn endpoint_handles_trailing_slashes() {
        assert_eq!(
            endpoint("https://example.com/", "/v1/images/generations")
                .expect("url")
                .as_str(),
            "https://example.com/v1/images/generations"
        );
    }

    #[test]
    fn asset_library_credentials_are_scoped_to_the_provider_connection() {
        assert_eq!(
            asset_library_credential_ref("provider-overseas"),
            "asset-library-token:provider-overseas"
        );
    }

    #[test]
    fn endpoint_does_not_duplicate_a_version_prefix() {
        assert_eq!(
            endpoint("https://example.com/openai/v1", "/v1/models")
                .expect("url")
                .as_str(),
            "https://example.com/openai/v1/models"
        );
        assert_eq!(
            endpoint("https://example.com/company", "/v1/models")
                .expect("url")
                .as_str(),
            "https://example.com/company/v1/models"
        );
    }

    #[test]
    fn model_parser_accepts_openai_and_company_shapes() {
        let openai = RawProviderResponse {
            status: 200,
            headers: json!({}),
            body: json!({
                "data": [
                    { "id": "image-1", "owned_by": "company" },
                    { "id": "video-1", "name": "视频模型一" }
                ]
            })
            .to_string(),
        };
        let models = parse_model_catalog(&openai).expect("OpenAI model list");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "image-1");
        assert_eq!(models[0].owned_by.as_deref(), Some("company"));
        assert_eq!(models[1].display_name, "视频模型一");

        let company = RawProviderResponse {
            status: 200,
            headers: json!({}),
            body: json!({ "data": { "models": ["model-a", { "model_id": "model-b" }] } })
                .to_string(),
        };
        let models = parse_model_catalog(&company).expect("company model list");
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["model-a", "model-b"]
        );
    }

    #[test]
    fn model_parser_preserves_the_raw_non_success_response() {
        let response = RawProviderResponse {
            status: 502,
            headers: json!({ "x-request-id": "req-1" }),
            body: r#"{"error":{"message":"upstream failed"}}"#.into(),
        };
        let error = parse_model_catalog(&response).expect_err("protocol error");
        let payload = error.payload();
        assert_eq!(payload.details["httpStatus"], 502);
        assert_eq!(payload.details["rawResponse"], response.body);
        assert_eq!(payload.details["headers"]["x-request-id"], "req-1");
    }

    #[test]
    fn text_image_builder_uses_frozen_request_field_aliases() {
        let generation = resolved(
            json!({
                "request": {
                    "encoding": "json",
                    "modelField": "model_id",
                    "promptField": "input"
                },
                "parameters": {
                    "aspect": {
                        "type": "string",
                        "requestField": "size"
                    }
                }
            }),
            json!({ "aspect": "1024x1536" }),
        );
        let body = build_text_to_image_body(&task(GenerationOperation::TextToImage), &generation)
            .expect("text image body");
        assert_eq!(body["model_id"], "company-model-v2");
        assert_eq!(body["input"], "A train arrives");
        assert_eq!(body["size"], "1024x1536");
        assert!(body.get("aspect").is_none());
    }

    #[test]
    fn video_builder_maps_declared_parameters_and_transforms_web_search() {
        let generation = resolved(
            json!({
                "request": {
                    "encoding": "json",
                    "parameterContainer": "metadata"
                },
                "parameters": {
                    "frames": {
                        "type": "integer",
                        "requestField": "frame_count"
                    },
                    "web_search": {
                        "type": "boolean",
                        "requestField": "tools",
                        "transform": "web_search_tool",
                        "requiresNoMedia": true
                    }
                }
            }),
            json!({ "frames": 48, "web_search": true }),
        );
        let body = build_video_body(&task(GenerationOperation::VideoGeneration), &generation)
            .expect("video body");
        assert_eq!(body["metadata"]["frame_count"], 48);
        assert_eq!(body["metadata"]["tools"], json!([{ "type": "web_search" }]));
        assert_eq!(body["metadata"]["content"][0]["type"], "text");
    }

    #[test]
    fn dreamina_seedance_builder_uses_top_level_prompt_and_metadata_fields() {
        let schema = super::super::model_schema::default_model_schema(
            "dreamina-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
        );
        let generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "9:16",
                "resolution": "720p",
                "duration": 12,
                "generate_audio": true,
                "web_search": true,
                "output_format": "mov",
                "priority": 7
            }),
        );
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("dreamina-seedance-2.5".into());

        let body = build_video_body(&video_task, &generation).expect("Dreamina video body");
        assert_eq!(body["model"], "dreamina-seedance-2.5");
        // prompt 字段仅保留简短占位符，生效文本在 metadata.content 的 text 项中。
        assert_eq!(body["prompt"], "...");
        assert_eq!(body["metadata"]["content"][0]["type"], "text");
        assert_eq!(body["metadata"]["content"][0]["text"], "A train arrives");
        assert_eq!(body["metadata"]["ratio"], "9:16");
        assert_eq!(body["metadata"]["resolution"], "720p");
        assert_eq!(body["metadata"]["duration"], 12);
        assert_eq!(body["metadata"]["generate_audio"], true);
        assert_eq!(body["metadata"]["output_format"], "mov");
        assert_eq!(body["metadata"]["priority"], 7);
        assert_eq!(body["metadata"]["tools"], json!([{ "type": "web_search" }]));
        assert!(body.get("omni_reference_task_type").is_none());
    }

    #[test]
    fn dreamina_seedance_builder_renders_reference_media_as_short_labels_in_prompt() {
        let schema = super::super::model_schema::default_model_schema(
            "dreamina-seedance-2.5",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "ratio": "adaptive",
                "resolution": "720p",
                "duration": 30,
                "generate_audio": true,
                "output_format": "mp4",
                "priority": 0
            }),
        );
        // 模拟画布拼接：两张参考图 + 文本「疯狂做爱」。
        generation.rendered_prompt =
            "[图片1：微信图片_xxx.jpg]和[图片2：微信图片_yyy.jpg]疯狂做爱".into();
        generation.content = vec![
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text("和".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 2,
            },
            CompiledContentItem::Text("疯狂做爱".into()),
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "asset://asset-20260902214334-t5rnj",
            Some(1),
        ));
        generation.images.push(resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "asset://asset-20260902214333-l5lpp",
            Some(2),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("dreamina-seedance-2.5".into());

        let body = build_video_body(&video_task, &generation).expect("Dreamina media body");

        // prompt 字段仅保留简短占位符，真正生效的提示词按顺序落在 metadata.content 的 text 项中。
        assert_eq!(body["prompt"], "...");
        assert_eq!(body["metadata"]["content"][0]["type"], "image_url");
        assert_eq!(body["metadata"]["content"][1]["type"], "text");
        assert_eq!(body["metadata"]["content"][1]["text"], "和");
        assert_eq!(body["metadata"]["content"][2]["type"], "image_url");
        assert_eq!(body["metadata"]["content"][3]["type"], "text");
        assert_eq!(body["metadata"]["content"][3]["text"], "疯狂做爱");
        assert_eq!(
            body["metadata"]["content"][0]["image_url"]["url"],
            "asset://asset-20260902214334-t5rnj"
        );
        assert_eq!(
            body["metadata"]["content"][2]["image_url"]["url"],
            "asset://asset-20260902214333-l5lpp"
        );
    }

    #[test]
    fn wan_video_builder_uses_root_parameters_and_role_url_media_items() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video-prime",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "1080P",
                "ratio": "adaptive",
                "duration": 5,
                "seed": 42,
                "watermark": false
            }),
        );
        generation.rendered_prompt = "舞者[图片1：模特]跟随[音频1：音乐]".into();
        generation.content = vec![
            CompiledContentItem::Text("舞者".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Image,
                type_position: 1,
            },
            CompiledContentItem::Text("跟随".into()),
            CompiledContentItem::Media {
                media_type: MediaType::Audio,
                type_position: 1,
            },
        ];
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "reference_image",
            "https://cdn.example.com/model.png",
            Some(1),
        ));
        generation.audios.push(resolved_media(
            MediaType::Audio,
            1,
            "reference_audio",
            "https://cdn.example.com/music.mp3",
            Some(3),
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video-prime".into());

        let body = build_video_body(&video_task, &generation).expect("Wan video body");
        assert_eq!(body["model"], "wan3.0-video-prime");
        assert_eq!(body["prompt"], "舞者图1跟随音频1");
        assert_eq!(body["resolution"], "1080P");
        assert_eq!(body["duration"], 5);
        assert_eq!(body["seed"], 42);
        assert_eq!(
            body["media"],
            json!([
                {
                    "type": "reference_image",
                    "url": "https://cdn.example.com/model.png"
                },
                {
                    "type": "reference_audio",
                    "url": "https://cdn.example.com/music.mp3"
                }
            ])
        );
        assert!(body.get("metadata").is_none());
    }

    #[test]
    fn wan_video_builder_accepts_media_without_a_prompt() {
        let schema = super::super::model_schema::default_model_schema(
            "wan3.0-video",
            &[GenerationOperation::VideoGeneration],
        );
        let mut generation = resolved(
            schema["video_generation"].clone(),
            json!({
                "resolution": "720P",
                "ratio": "9:16",
                "duration": -1,
                "watermark": false
            }),
        );
        generation.rendered_prompt.clear();
        generation.content.clear();
        generation.images.push(resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://cdn.example.com/first.webp",
            None,
        ));
        let mut video_task = task(GenerationOperation::VideoGeneration);
        video_task.remote_model_id_snapshot = Some("wan3.0-video".into());

        let body = build_video_body(&video_task, &generation).expect("media-only Wan body");
        assert!(body.get("prompt").is_none());
        assert_eq!(
            body["media"],
            json!([{
                "type": "first_frame",
                "url": "https://cdn.example.com/first.webp"
            }])
        );
    }

    #[test]
    fn request_path_rejects_cross_origin_and_query_like_values() {
        assert!(
            request_path(
                &json!({ "request": { "path": "https://evil.test/x" } }),
                "/v1/x"
            )
            .is_err()
        );
        assert!(
            request_path(&json!({ "request": { "path": "/v1/x?secret=1" } }), "/v1/x").is_err()
        );
        assert_eq!(
            request_path(
                &json!({ "request": { "path": "/custom/generate" } }),
                "/v1/x"
            )
            .unwrap(),
            "/custom/generate"
        );
    }

    #[test]
    fn signed_query_is_removed_from_archived_requests() {
        let value = json!({
            "url": "https://user:password@tos.example/file.png?X-Tos-Signature=secret&x=1",
            "prompt": "keep me"
        });
        let redacted = redact_request_value(&value);
        assert_eq!(redacted["url"], "https://tos.example/file.png");
        assert_eq!(redacted["prompt"], "keep me");
    }

    #[test]
    fn token_usage_accepts_openai_anthropic_and_gemini_shapes() {
        let usage_for = |body: Value| {
            parse_token_usage(&CapturedHttpResponse {
                call_id: "test-call".into(),
                status: 200,
                headers: json!({}),
                body: body.to_string(),
            })
            .expect("token usage")
        };

        let openai = usage_for(json!({
            "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 }
        }));
        assert_eq!(openai.prompt_tokens, Some(11));
        assert_eq!(openai.completion_tokens, Some(7));
        assert_eq!(openai.total_tokens, Some(18));

        let anthropic = usage_for(json!({
            "usage": { "input_tokens": 13, "output_tokens": 5 }
        }));
        assert_eq!(anthropic.prompt_tokens, Some(13));
        assert_eq!(anthropic.completion_tokens, Some(5));
        assert_eq!(anthropic.total_tokens, Some(18));

        let gemini = usage_for(json!({
            "usageMetadata": {
                "promptTokenCount": 17,
                "candidatesTokenCount": 3,
                "totalTokenCount": 20
            }
        }));
        assert_eq!(gemini.prompt_tokens, Some(17));
        assert_eq!(gemini.completion_tokens, Some(3));
        assert_eq!(gemini.total_tokens, Some(20));
    }

    #[test]
    fn image_parser_accepts_url_or_base64_and_prefers_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": [
                    { "url": "https://example.com/a.png", "b64_json": "ignored" },
                    { "b64_json": "kept" }
                ]
            })
            .to_string(),
        };
        let GenerationSubmission::Images(images) =
            parse_image_submission(&response, false).expect("images")
        else {
            panic!("expected images");
        };
        assert!(matches!(images[0], ImageSource::Url(_)));
        assert!(matches!(images[1], ImageSource::Base64(_)));
    }

    #[test]
    fn video_submission_accepts_wan_top_level_id() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({ "id": "wan-task-1", "status": "queued" }).to_string(),
        };
        assert_eq!(parse_video_task_id(&response).unwrap(), "wan-task-1");
    }

    #[test]
    fn video_observation_accepts_percent_progress_and_metadata_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "completed",
                    "progress": "30%",
                    "metadata": { "url": "https://cdn.example.com/video.mp4" }
                }
            })
            .to_string(),
        };
        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "completed");
        assert_eq!(observation.progress, Some(30.0));
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
    }

    #[test]
    fn video_observation_accepts_wan_result_url() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "code": "success",
                "data": {
                    "status": "SUCCESS",
                    "progress": "100%",
                    "result_url": "https://cdn.example.com/wan.mp4",
                    "fail_reason": ""
                }
            })
            .to_string(),
        };
        let observation = parse_video_observation(&response).expect("Wan observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(observation.progress, Some(100.0));
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/wan.mp4")
        );
        assert_eq!(observation.failure, None);
    }

    #[test]
    fn successful_video_observation_ignores_misplaced_url_in_fail_reason() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "SUCCESS",
                    "fail_reason": "https://cdn.example.com/video.mp4",
                    "data": {
                        "data": {
                            "content": {
                                "video_url": "https://cdn.example.com/video.mp4"
                            }
                        }
                    }
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(observation.remote_status, "SUCCESS");
        assert_eq!(
            observation.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
        assert_eq!(observation.failure, None);
    }

    #[test]
    fn failed_video_observation_preserves_fail_reason() {
        let response = CapturedHttpResponse {
            call_id: "test-call".into(),
            status: 200,
            headers: json!({}),
            body: json!({
                "data": {
                    "status": "FAILED",
                    "fail_reason": "content policy rejection"
                }
            })
            .to_string(),
        };

        let observation = parse_video_observation(&response).expect("video observation");
        assert_eq!(
            observation.failure,
            Some(json!({
                "failReason": "content policy rejection",
                "upstreamError": null
            }))
        );
    }
}
