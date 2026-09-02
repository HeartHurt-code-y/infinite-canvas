use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use reqwest::Method;
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::Mutex;

use super::{
    error::{BackendError, BackendResult},
    provider::ProviderRuntime,
    storage::TaskExecutionRecord,
    types::{
        AssetListCommand, CloudAssetIdentity, CloudAssetRecord, CloudAssetStatus,
        CreateRealPersonAuthLinkCommand, DeleteRealPersonAssetCommand,
        DeleteRealPersonGroupCommand, MediaType, RawProviderResponse, RealPersonAuthLink,
        RealPersonGroup, RealPersonProviderCommand,
    },
};

const UPLOAD_GROUP_NAME: &str = "无限画布上传";
const IMPORT_POLL_FAILURE_LIMIT: u32 = 5;
const IMPORT_POLL_INTERVAL: Duration = Duration::from_secs(5);
const IMPORT_POLL_TIMEOUT: Duration = Duration::from_secs(300);

type PortFuture<T> = Pin<Box<dyn Future<Output = BackendResult<T>> + Send>>;

#[derive(Debug, Clone)]
struct RemoteAssetRequest {
    provider_connection_id: String,
    method: Method,
    path: &'static str,
    body: Option<Value>,
}

trait AssetPort: Send + Sync {
    fn send(&self, request: RemoteAssetRequest) -> PortFuture<RawProviderResponse>;

    fn get_recorded(
        &self,
        task: TaskExecutionRecord,
        attempt_id: String,
        identity: CloudAssetIdentity,
    ) -> PortFuture<RawProviderResponse>;

    fn download(&self, url: String) -> PortFuture<Vec<u8>>;
}

#[derive(Clone)]
struct ProviderAssetAdapter {
    providers: ProviderRuntime,
}

impl AssetPort for ProviderAssetAdapter {
    fn send(&self, request: RemoteAssetRequest) -> PortFuture<RawProviderResponse> {
        let providers = self.providers.clone();
        Box::pin(async move {
            providers
                .raw_asset_json_request(
                    &request.provider_connection_id,
                    request.method,
                    request.path,
                    &[],
                    request.body.as_ref(),
                )
                .await
        })
    }

    fn get_recorded(
        &self,
        task: TaskExecutionRecord,
        attempt_id: String,
        identity: CloudAssetIdentity,
    ) -> PortFuture<RawProviderResponse> {
        let providers = self.providers.clone();
        Box::pin(async move {
            let (response, _) = providers
                .captured_asset_get(
                    &task,
                    &attempt_id,
                    &identity.provider_connection_id,
                    &identity.asset_id,
                )
                .await?;
            Ok(RawProviderResponse {
                status: response.status,
                headers: response.headers,
                body: response.body,
            })
        })
    }

    fn download(&self, url: String) -> PortFuture<Vec<u8>> {
        let client = self.providers.client().clone();
        Box::pin(async move {
            let response = client.get(&url).send().await?;
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
                return Err(BackendError::protocol(
                    format!("asset content download returned HTTP {status}"),
                    json!({
                        "httpStatus": status,
                        "rawResponse": body.chars().take(2000).collect::<String>()
                    }),
                ));
            }
            Ok(response.bytes().await?.to_vec())
        })
    }
}

#[derive(Debug, Clone)]
pub struct ImportStagedAsset {
    pub provider_connection_id: String,
    pub public_url: String,
    pub media_type: MediaType,
    pub display_name: Option<String>,
    pub group_id: Option<i64>,
}

pub struct AssetReadTrace<'a> {
    pub task: &'a TaskExecutionRecord,
    pub attempt_id: &'a str,
}

#[derive(Debug, Clone)]
pub enum AssetDelivery {
    Bytes,
    RemoteReadable {
        destination_provider_connection_id: String,
    },
}

pub struct ResolveAsset<'a> {
    pub identity: CloudAssetIdentity,
    pub expected_media_type: MediaType,
    pub delivery: AssetDelivery,
    pub trace: AssetReadTrace<'a>,
}

#[derive(Debug)]
pub enum ResolvedAssetAccess {
    Bytes(Vec<u8>),
    RemoteReference(String),
}

#[derive(Debug)]
pub struct ResolvedAsset {
    pub mime_type: String,
    pub byte_size: usize,
    pub sha256: String,
    pub file_extension: String,
    pub access: ResolvedAssetAccess,
}

#[derive(Debug, Clone, Copy)]
struct PollPolicy {
    interval: Duration,
    timeout: Duration,
    failure_limit: u32,
}

impl Default for PollPolicy {
    fn default() -> Self {
        Self {
            interval: IMPORT_POLL_INTERVAL,
            timeout: IMPORT_POLL_TIMEOUT,
            failure_limit: IMPORT_POLL_FAILURE_LIMIT,
        }
    }
}

#[derive(Clone)]
pub struct AssetLibrary {
    port: Arc<dyn AssetPort>,
    upload_group_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    poll_policy: PollPolicy,
}

impl AssetLibrary {
    pub fn new(providers: ProviderRuntime) -> Self {
        Self::with_port(
            Arc::new(ProviderAssetAdapter { providers }),
            PollPolicy::default(),
        )
    }

    fn with_port(port: Arc<dyn AssetPort>, poll_policy: PollPolicy) -> Self {
        Self {
            port,
            upload_group_gates: Arc::new(Mutex::new(HashMap::new())),
            poll_policy,
        }
    }

    /// Browse the remote 素材库 through canonical domain records.
    /// Remote envelope shapes, status spelling and duplicate rows remain behind this interface.
    pub async fn browse(&self, query: AssetListCommand) -> BackendResult<Vec<CloudAssetRecord>> {
        let provider_connection_id = query.provider_connection_id;
        let mut body = Map::new();
        body.insert(
            "page_number".into(),
            u64::from(query.page_number.unwrap_or(1)).into(),
        );
        body.insert(
            "page_size".into(),
            u64::from(query.page_size.unwrap_or(100).min(100)).into(),
        );
        if let Some(value) = query.name.filter(|value| !value.trim().is_empty()) {
            body.insert("name".into(), value.into());
        }
        if let Some(value) = query.group_id {
            body.insert("group_id".into(), value.into());
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.clone(),
                method: Method::POST,
                path: "/v1/assets/list",
                body: Some(Value::Object(body)),
            })
            .await?;
        require_success("browse assets", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        Ok(parse_asset_page(&provider_connection_id, &payload))
    }

    /// Create a single-use H5 face-authorization link for a real-person asset group.
    pub async fn create_real_person_auth_link(
        &self,
        command: CreateRealPersonAuthLinkCommand,
    ) -> BackendResult<RealPersonAuthLink> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        let artist_name = command.artist_name.trim();
        if artist_name.is_empty() {
            return Err(BackendError::validation(
                "artist_name must not be empty",
                json!({ "field": "artistName" }),
            ));
        }
        if artist_name.chars().count() > 32 {
            return Err(BackendError::validation(
                "artist_name must not exceed 32 characters",
                json!({ "field": "artistName", "maxLength": 32 }),
            ));
        }
        let artist_desc = command
            .artist_desc
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if artist_desc.is_some_and(|value| value.chars().count() > 300) {
            return Err(BackendError::validation(
                "artist_desc must not exceed 300 characters",
                json!({ "field": "artistDesc", "maxLength": 300 }),
            ));
        }
        let mut body = json!({ "artist_name": artist_name });
        if let Some(value) = artist_desc {
            body["artist_desc"] = value.into();
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/real-person/auth/link",
                body: Some(body),
            })
            .await?;
        require_success("create real-person auth link", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let data = payload.get("data").unwrap_or(&payload);
        let h5_url = data
            .get("h5_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
            .ok_or_else(|| {
                BackendError::protocol(
                    "real-person auth response did not return an H5 URL",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        Ok(RealPersonAuthLink {
            h5_url: h5_url.to_string(),
            tip: data
                .get("tip")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        })
    }

    /// List face-authorized real-person groups scoped to the selected provider token.
    pub async fn list_real_person_groups(
        &self,
        command: RealPersonProviderCommand,
    ) -> BackendResult<Vec<RealPersonGroup>> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::GET,
                path: "/v1/assets/real-person/groups",
                body: None,
            })
            .await?;
        require_success("list real-person groups", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let groups = payload
            .get("data")
            .map(asset_array)
            .filter(|groups| !groups.is_empty())
            .unwrap_or_else(|| asset_array(&payload));
        groups
            .into_iter()
            .map(parse_real_person_group)
            .collect::<BackendResult<Vec<_>>>()
    }

    /// Permanently remove one real-person asset from both the platform and upstream service.
    pub async fn delete_real_person_asset(
        &self,
        command: DeleteRealPersonAssetCommand,
    ) -> BackendResult<String> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        let id = command.id.trim();
        if id.is_empty() || id.starts_with("asset://") {
            return Err(BackendError::validation(
                "real-person asset deletion requires an asset id without the asset:// prefix",
                json!({ "id": command.id }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/real-person/assets/delete",
                body: Some(json!({ "id": id })),
            })
            .await?;
        require_success("delete real-person asset", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let returned_id = payload
            .pointer("/data/id")
            .or_else(|| payload.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "real-person asset deletion did not return an asset id",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        Ok(returned_id.to_string())
    }

    /// Permanently remove a real-person group and every asset contained in it.
    pub async fn delete_real_person_group(
        &self,
        command: DeleteRealPersonGroupCommand,
    ) -> BackendResult<()> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        if command.id <= 0 {
            return Err(BackendError::validation(
                "real-person group deletion requires a positive platform group id",
                json!({ "id": command.id }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/real-person/groups/delete",
                body: Some(json!({ "id": command.id })),
            })
            .await?;
        require_success("delete real-person group", &response)
    }

    /// Import an already staged public object and wait until the remote 素材 becomes readable.
    /// Group discovery, single-flight creation, single-asset polling and terminal-state mapping stay local.
    pub async fn import_staged(
        &self,
        request: ImportStagedAsset,
    ) -> BackendResult<CloudAssetIdentity> {
        if request.provider_connection_id.trim().is_empty()
            || !request.public_url.starts_with("http://")
                && !request.public_url.starts_with("https://")
        {
            return Err(BackendError::validation(
                "remote asset import requires a provider connection and public URL",
                json!({
                    "providerConnectionId": request.provider_connection_id,
                    "publicUrl": request.public_url
                }),
            ));
        }
        let group_id = match request.group_id {
            Some(group_id) if group_id > 0 => group_id,
            Some(group_id) => {
                return Err(BackendError::validation(
                    "real-person asset import requires a positive platform group id",
                    json!({ "groupId": group_id }),
                ));
            }
            None => {
                self.resolve_upload_group(&request.provider_connection_id)
                    .await?
            }
        };
        let display_name = request
            .display_name
            .as_deref()
            .map(|value| value.chars().take(64).collect::<String>());
        let mut body = json!({
            "url": request.public_url,
            "asset_type": media_type_name(request.media_type),
            "group_id": group_id,
        });
        if let Some(name) = display_name {
            body["name"] = name.into();
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: request.provider_connection_id.clone(),
                method: Method::POST,
                path: "/v1/assets",
                body: Some(body),
            })
            .await?;
        require_success("submit asset import", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let asset_id = payload
            .pointer("/data/id")
            .or_else(|| payload.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "asset import did not return an asset id",
                    json!({ "rawResponse": response.body }),
                )
            })?
            .to_string();
        self.wait_for_import(&request.provider_connection_id, &asset_id)
            .await
    }

    /// Resolve a cloud 素材 into the representation requested by a generation caller.
    /// The caller chooses intent; this implementation owns remote fields, status and content access.
    pub async fn resolve(&self, request: ResolveAsset<'_>) -> BackendResult<ResolvedAsset> {
        let response = self
            .port
            .get_recorded(
                request.trace.task.clone(),
                request.trace.attempt_id.to_string(),
                request.identity.clone(),
            )
            .await?;
        require_success("resolve asset", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let data = payload.get("data").unwrap_or(&payload);
        let asset = parse_asset_entry(
            &request.identity.provider_connection_id,
            data,
            Some(&request.identity.asset_id),
        )
        .ok_or_else(|| {
            BackendError::protocol(
                "asset lookup did not return a readable asset record",
                json!({
                    "identity": request.identity,
                    "rawResponse": payload
                }),
            )
        })?;
        if asset.status != CloudAssetStatus::Ready {
            return Err(BackendError::protocol(
                "asset is not ready and readable",
                json!({
                    "identity": request.identity,
                    "status": asset.raw_status,
                    "rawResponse": payload
                }),
            ));
        }
        if asset.kind != request.expected_media_type {
            return Err(BackendError::validation(
                "resolved asset type does not match its stable reference",
                json!({
                    "identity": request.identity,
                    "expectedMediaType": request.expected_media_type,
                    "actualMediaType": asset.kind
                }),
            ));
        }

        let identity = CloudAssetIdentity {
            provider_connection_id: asset.provider_connection_id.clone(),
            asset_id: asset.id.clone(),
        };
        let fallback_extension = asset_file_extension(&asset);
        match request.delivery {
            AssetDelivery::Bytes => {
                let url = asset.preview_url.as_deref().ok_or_else(|| {
                    BackendError::protocol(
                        "ready asset has no readable URL",
                        json!({
                            "identity": identity,
                            "readableUrlFields": ["url", "preview_url"],
                            "rawResponse": payload
                        }),
                    )
                })?;
                let bytes = self.port.download(url.to_string()).await?;
                let detected = infer::get(&bytes).ok_or_else(|| {
                    BackendError::protocol(
                        "asset media type could not be identified from file signature",
                        json!({ "identity": identity, "byteSize": bytes.len() }),
                    )
                })?;
                validate_detected_type(request.expected_media_type, detected.mime_type())?;
                let sha256 = hex::encode(Sha256::digest(&bytes));
                Ok(ResolvedAsset {
                    mime_type: detected.mime_type().to_string(),
                    byte_size: bytes.len(),
                    sha256,
                    file_extension: detected.extension().to_string(),
                    access: ResolvedAssetAccess::Bytes(bytes),
                })
            }
            AssetDelivery::RemoteReadable {
                destination_provider_connection_id,
            } => {
                let same_provider_scope =
                    identity.provider_connection_id == destination_provider_connection_id;
                let reference = if same_provider_scope {
                    asset.asset_url.clone().or(asset.preview_url.clone())
                } else {
                    asset.preview_url.clone()
                }
                .ok_or_else(|| {
                    BackendError::protocol(
                        "ready asset has no remote-readable reference",
                        json!({ "identity": identity, "rawResponse": payload }),
                    )
                })?;
                Ok(ResolvedAsset {
                    mime_type: media_type_wildcard(request.expected_media_type).to_string(),
                    byte_size: 0,
                    sha256: String::new(),
                    file_extension: fallback_extension,
                    access: ResolvedAssetAccess::RemoteReference(reference),
                })
            }
        }
    }

    async fn resolve_upload_group(&self, provider_connection_id: &str) -> BackendResult<i64> {
        let gate = {
            let mut gates = self.upload_group_gates.lock().await;
            Arc::clone(
                gates
                    .entry(provider_connection_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = gate.lock().await;
        let mut group_id = self.find_upload_group(provider_connection_id).await?;
        if group_id.is_none() {
            let response = self
                .port
                .send(RemoteAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    method: Method::POST,
                    path: "/v1/assets/groups",
                    body: Some(json!({ "name": UPLOAD_GROUP_NAME })),
                })
                .await?;
            require_success("create upload asset group", &response)?;
            group_id = self.find_upload_group(provider_connection_id).await?;
        }
        let group_id = group_id.ok_or_else(|| {
            BackendError::protocol(
                "upload asset group could not be resolved after creation",
                json!({
                    "providerConnectionId": provider_connection_id,
                    "groupName": UPLOAD_GROUP_NAME
                }),
            )
        })?;
        Ok(group_id)
    }

    async fn find_upload_group(&self, provider_connection_id: &str) -> BackendResult<Option<i64>> {
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::GET,
                path: "/v1/assets/groups",
                body: None,
            })
            .await?;
        require_success("list asset groups", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let groups = payload
            .get("data")
            .map(asset_array)
            .filter(|groups| !groups.is_empty())
            .unwrap_or_else(|| asset_array(&payload));
        Ok(groups.into_iter().find_map(|entry| {
            let id = entry.get("id").and_then(Value::as_i64)?;
            let name = entry.get("name").and_then(Value::as_str)?;
            (id > 0 && name == UPLOAD_GROUP_NAME).then_some(id)
        }))
    }

    async fn wait_for_import(
        &self,
        provider_connection_id: &str,
        asset_id: &str,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut consecutive_failures = 0;
        loop {
            if started.elapsed() >= self.poll_policy.timeout {
                return Err(BackendError::protocol(
                    "asset import did not become ready before the local wait deadline",
                    json!({ "assetId": asset_id, "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            let response = match self
                .port
                .send(RemoteAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    method: Method::POST,
                    path: "/v1/assets/get",
                    body: Some(json!({ "id": asset_id })),
                })
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= self.poll_policy.failure_limit {
                        return Err(error);
                    }
                    self.wait_before_next_import_poll().await;
                    continue;
                }
            };
            if let Err(error) = require_success("observe asset import", &response) {
                consecutive_failures += 1;
                if consecutive_failures >= self.poll_policy.failure_limit {
                    return Err(error);
                }
                self.wait_before_next_import_poll().await;
                continue;
            }
            let payload: Value = serde_json::from_str(&response.body)?;
            let item = payload.get("data").unwrap_or(&payload);
            let returned_asset_id = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "asset lookup did not return an asset id",
                        json!({ "assetId": asset_id, "rawResponse": response.body }),
                    )
                })?;
            if returned_asset_id != asset_id {
                return Err(BackendError::protocol(
                    "asset lookup returned a different asset id",
                    json!({
                        "assetId": asset_id,
                        "returnedAssetId": returned_asset_id,
                        "rawResponse": response.body
                    }),
                ));
            }
            consecutive_failures = 0;
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "asset lookup did not return a status",
                        json!({ "assetId": asset_id, "rawResponse": response.body }),
                    )
                })?;
            match status.trim().to_ascii_lowercase().as_str() {
                "active" | "ready" => {
                    return Ok(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id: asset_id.to_string(),
                    });
                }
                "failed" | "deleted" => {
                    return Err(BackendError::protocol(
                        format!("asset import reached terminal status {status}"),
                        json!({
                            "assetId": asset_id,
                            "itemError": item.get("error"),
                            "rawResponse": response.body
                        }),
                    ));
                }
                _ => self.wait_before_next_import_poll().await,
            }
        }
    }

    async fn wait_before_next_import_poll(&self) {
        if !self.poll_policy.interval.is_zero() {
            tokio::time::sleep(self.poll_policy.interval).await;
        }
    }
}

fn require_success(operation: &str, response: &RawProviderResponse) -> BackendResult<()> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    let upstream_message = serde_json::from_str::<Value>(&response.body)
        .ok()
        .and_then(|payload| {
            payload
                .pointer("/error/message")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(1000).collect::<String>())
        });
    let message = match upstream_message {
        Some(message) => format!("{operation} returned HTTP {}: {message}", response.status),
        None => format!("{operation} returned HTTP {}", response.status),
    };
    Err(BackendError::protocol(
        message,
        json!({
            "httpStatus": response.status,
            "headers": response.headers,
            "rawResponse": response.body
        }),
    ))
}

fn require_provider_connection_id(value: &str) -> BackendResult<&str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(BackendError::validation(
            "real-person asset operation requires a provider connection",
            json!({ "field": "providerConnectionId" }),
        ));
    }
    Ok(value)
}

fn parse_real_person_group(raw: &Value) -> BackendResult<RealPersonGroup> {
    let record = raw.as_object().ok_or_else(|| {
        BackendError::protocol(
            "real-person group entry must be an object",
            json!({ "entry": raw }),
        )
    })?;
    let required_string = |field: &str| {
        record
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                BackendError::protocol(
                    format!("real-person group did not return {field}"),
                    json!({ "entry": raw }),
                )
            })
    };
    let optional_string = |fields: &[&str]| {
        fields.iter().find_map(|field| {
            record
                .get(*field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
    };
    let id = record
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            BackendError::protocol(
                "real-person group did not return a positive platform id",
                json!({ "entry": raw }),
            )
        })?;
    Ok(RealPersonGroup {
        id,
        remote_group_id: required_string("group_id")?,
        artist_name: required_string("artist_name")?,
        artist_desc: record
            .get("artist_desc")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        authorized_at: optional_string(&[
            "authorized_at",
            "authorizedAt",
            "created_at",
            "createdAt",
        ]),
        asset_count: record
            .get("asset_count")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    })
}

fn parse_asset_page(provider_connection_id: &str, payload: &Value) -> Vec<CloudAssetRecord> {
    let mut candidates = Vec::new();
    if let Some(data) = payload.get("data") {
        candidates.extend(asset_array(data));
    }
    candidates.extend(asset_array(payload));
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|entry| parse_asset_entry(provider_connection_id, entry, None))
        .filter(|asset| seen.insert(asset.id.clone()))
        .collect()
}

fn asset_array(value: &Value) -> Vec<&Value> {
    if let Some(items) = value.as_array() {
        return items.iter().collect();
    }
    let Some(record) = value.as_object() else {
        return Vec::new();
    };
    ["list", "items", "assets", "data", "records"]
        .into_iter()
        .find_map(|key| record.get(key).and_then(Value::as_array))
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn parse_asset_entry(
    provider_connection_id: &str,
    raw: &Value,
    fallback_id: Option<&str>,
) -> Option<CloudAssetRecord> {
    let record = raw.as_object()?;
    let id = string_field(record, &["id"])
        .or(fallback_id)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let raw_name = string_field(record, &["name"]).unwrap_or_default();
    let preview_url = http_url_field(record, &["url", "preview_url", "previewUrl"]);
    let asset_url = string_field(record, &["asset_url", "assetUrl"])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let cover_url = http_url_field(
        record,
        &["cover_url", "coverUrl", "thumbnail_url", "thumbnailUrl"],
    );
    let kind = string_field(record, &["asset_type", "assetType", "type"])
        .and_then(parse_media_type)
        .or_else(|| infer_media_type_from_name(raw_name))
        .or_else(|| preview_url.as_deref().and_then(infer_media_type_from_name))
        .or_else(|| asset_url.as_deref().and_then(infer_media_type_from_name))
        .or_else(|| {
            string_field(record, &["mime_type", "media_type"]).and_then(parse_media_type_from_mime)
        })
        .unwrap_or(MediaType::Image);
    let raw_status = string_field(record, &["status"])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let status = normalize_asset_status(&raw_status);
    let fallback_name = match kind {
        MediaType::Image => "图片素材",
        MediaType::Video => "视频素材",
        MediaType::Audio => "音频素材",
    };
    Some(CloudAssetRecord {
        provider_connection_id: provider_connection_id.to_string(),
        id: id.to_string(),
        name: if raw_name.trim().is_empty() {
            fallback_name.to_string()
        } else {
            raw_name.to_string()
        },
        kind,
        status,
        raw_status,
        preview_url,
        asset_url,
        cover_url,
        group_id: record.get("group_id").and_then(Value::as_i64),
    })
}

fn string_field<'a>(record: &'a Map<String, Value>, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| record.get(*field).and_then(Value::as_str))
}

fn http_url_field(record: &Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .filter_map(|field| record.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(ToOwned::to_owned)
}

fn parse_media_type(value: &str) -> Option<MediaType> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image" => Some(MediaType::Image),
        "video" => Some(MediaType::Video),
        "audio" => Some(MediaType::Audio),
        _ => None,
    }
}

fn parse_media_type_from_mime(value: &str) -> Option<MediaType> {
    parse_media_type(value.split('/').next().unwrap_or_default())
}

fn infer_media_type_from_name(value: &str) -> Option<MediaType> {
    let path = value.split(['?', '#']).next().unwrap_or_default();
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" => Some(MediaType::Image),
        "mp4" | "mov" | "webm" | "avi" | "mkv" => Some(MediaType::Video),
        "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a" => Some(MediaType::Audio),
        _ => None,
    }
}

fn normalize_asset_status(value: &str) -> CloudAssetStatus {
    match value.trim().to_ascii_lowercase().as_str() {
        "active" | "ready" => CloudAssetStatus::Ready,
        "pending" | "processing" => CloudAssetStatus::Processing,
        "failed" => CloudAssetStatus::Failed,
        "deleted" => CloudAssetStatus::Deleted,
        _ => CloudAssetStatus::Unknown,
    }
}

fn media_type_name(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "Image",
        MediaType::Video => "Video",
        MediaType::Audio => "Audio",
    }
}

fn media_type_wildcard(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "image/*",
        MediaType::Video => "video/*",
        MediaType::Audio => "audio/*",
    }
}

fn asset_file_extension(asset: &CloudAssetRecord) -> String {
    [Some(asset.name.as_str()), asset.preview_url.as_deref()]
        .into_iter()
        .flatten()
        .find_map(path_extension)
        .unwrap_or_else(|| match asset.kind {
            MediaType::Image => "jpg".to_string(),
            MediaType::Video => "mp4".to_string(),
            MediaType::Audio => "mp3".to_string(),
        })
}

fn path_extension(value: &str) -> Option<String> {
    let path = value.split(['?', '#']).next().unwrap_or_default();
    let (_, extension) = path.rsplit_once('.')?;
    let extension = extension.trim().to_ascii_lowercase();
    (!extension.is_empty() && extension.len() <= 8).then_some(extension)
}

fn validate_detected_type(expected: MediaType, mime: &str) -> BackendResult<()> {
    let valid = match expected {
        MediaType::Image => mime.starts_with("image/"),
        MediaType::Video => mime.starts_with("video/"),
        MediaType::Audio => mime.starts_with("audio/"),
    };
    if valid {
        Ok(())
    } else {
        Err(BackendError::validation(
            "resolved media type does not match its stable reference",
            json!({ "expectedMediaType": expected, "detectedMimeType": mime }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap as StdHashMap, VecDeque},
        sync::{Arc, Mutex as StdMutex},
        time::Duration,
    };

    use super::*;
    use crate::backend::types::{GenerationOperation, GenerationTaskStatus};

    #[derive(Default)]
    struct InMemoryAssetAdapter {
        responses: StdMutex<VecDeque<RawProviderResponse>>,
        requests: StdMutex<Vec<RemoteAssetRequest>>,
        downloads: StdMutex<StdHashMap<String, Vec<u8>>>,
    }

    impl InMemoryAssetAdapter {
        fn with_responses(responses: impl IntoIterator<Item = RawProviderResponse>) -> Self {
            Self {
                responses: StdMutex::new(responses.into_iter().collect()),
                ..Self::default()
            }
        }

        fn request_paths(&self) -> Vec<&'static str> {
            self.requests
                .lock()
                .expect("request lock")
                .iter()
                .map(|request| request.path)
                .collect()
        }

        fn take_response(&self) -> BackendResult<RawProviderResponse> {
            self.responses
                .lock()
                .expect("response lock")
                .pop_front()
                .ok_or_else(|| BackendError::Conflict("missing in-memory response".into()))
        }
    }

    impl AssetPort for InMemoryAssetAdapter {
        fn send(&self, request: RemoteAssetRequest) -> PortFuture<RawProviderResponse> {
            self.requests.lock().expect("request lock").push(request);
            let response = self.take_response();
            Box::pin(async move { response })
        }

        fn get_recorded(
            &self,
            _task: TaskExecutionRecord,
            _attempt_id: String,
            identity: CloudAssetIdentity,
        ) -> PortFuture<RawProviderResponse> {
            self.requests
                .lock()
                .expect("request lock")
                .push(RemoteAssetRequest {
                    provider_connection_id: identity.provider_connection_id,
                    method: Method::POST,
                    path: "/v1/assets/get",
                    body: Some(json!({ "id": identity.asset_id })),
                });
            let response = self.take_response();
            Box::pin(async move { response })
        }

        fn download(&self, url: String) -> PortFuture<Vec<u8>> {
            let result = self
                .downloads
                .lock()
                .expect("download lock")
                .get(&url)
                .cloned()
                .ok_or_else(|| BackendError::NotFound(format!("missing download: {url}")));
            Box::pin(async move { result })
        }
    }

    fn response(status: u16, body: Value) -> RawProviderResponse {
        RawProviderResponse {
            status,
            headers: json!({}),
            body: body.to_string(),
        }
    }

    fn test_library(adapter: Arc<InMemoryAssetAdapter>, poll_policy: PollPolicy) -> AssetLibrary {
        let port: Arc<dyn AssetPort> = adapter;
        AssetLibrary::with_port(port, poll_policy)
    }

    fn immediate_poll() -> PollPolicy {
        PollPolicy {
            interval: Duration::ZERO,
            timeout: Duration::from_secs(1),
            failure_limit: 2,
        }
    }

    fn task() -> TaskExecutionRecord {
        TaskExecutionRecord {
            id: "task-1".into(),
            operation: GenerationOperation::ImageToImage,
            status: GenerationTaskStatus::Submitting,
            provider_connection_id: "provider-1".into(),
            provider_display_name_snapshot: "Provider".into(),
            adapter_id_snapshot: "moyu_v1".into(),
            base_url_snapshot: "https://api.example.com".into(),
            api_key_ref_snapshot: "provider-key".into(),
            model_definition_id: "model-1".into(),
            remote_model_id_snapshot: Some("remote-model".into()),
            remote_task_id: None,
            logical_request: json!({}),
            resolved_request: None,
        }
    }

    #[tokio::test]
    async fn browse_normalizes_remote_shapes_and_deduplicates_ids() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "data": { "items": [
                    {
                        "id": "asset-1",
                        "name": "封面",
                        "asset_type": "Image",
                        "status": "Active",
                        "url": "Asset://not-downloadable",
                        "preview_url": "https://cdn.example.com/cover.png"
                    },
                    { "id": "asset-1", "name": "重复行", "asset_type": "image" },
                    {
                        "id": "asset-2",
                        "name": "clip.mp4",
                        "status": "Processing",
                        "thumbnailUrl": "https://cdn.example.com/cover.jpg"
                    }
                ]}
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let assets = library
            .browse(AssetListCommand {
                provider_connection_id: "provider-1".into(),
                page_number: None,
                page_size: Some(500),
                name: None,
                group_id: None,
            })
            .await
            .expect("browse");

        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].provider_connection_id, "provider-1");
        assert_eq!(assets[0].status, CloudAssetStatus::Ready);
        assert_eq!(
            assets[0].preview_url.as_deref(),
            Some("https://cdn.example.com/cover.png")
        );
        assert_eq!(assets[1].kind, MediaType::Video);
        assert_eq!(assets[1].status, CloudAssetStatus::Processing);
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests[0].path, "/v1/assets/list");
        assert_eq!(requests[0].body.as_ref().unwrap()["page_size"], 100);
    }

    #[tokio::test]
    async fn real_person_operations_follow_the_documented_h5_contract() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({
                    "code": "success",
                    "data": {
                        "h5_url": "https://h5.example.com/auth?ticket=once",
                        "tip": "请在 120 秒内完成认证"
                    }
                }),
            ),
            response(
                200,
                json!({
                    "code": "success",
                    "data": { "items": [{
                        "id": 128,
                        "group_id": "group-remote-1",
                        "artist_name": "张三",
                        "artist_desc": "品牌代言人真人素材组",
                        "authorized_at": "2026-04-27T12:00:29+08:00",
                        "asset_count": 3
                    }] }
                }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1" } }),
            ),
            response(200, json!({ "code": "success" })),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let link = library
            .create_real_person_auth_link(CreateRealPersonAuthLinkCommand {
                provider_connection_id: "provider-1".into(),
                artist_name: " 张三 ".into(),
                artist_desc: Some(" 品牌代言人真人素材组 ".into()),
            })
            .await
            .expect("create auth link");
        assert_eq!(link.h5_url, "https://h5.example.com/auth?ticket=once");

        let groups = library
            .list_real_person_groups(RealPersonProviderCommand {
                provider_connection_id: "provider-1".into(),
            })
            .await
            .expect("list groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, 128);
        assert_eq!(groups[0].remote_group_id, "group-remote-1");
        assert_eq!(groups[0].artist_name, "张三");
        assert_eq!(groups[0].asset_count, 3);

        let deleted_id = library
            .delete_real_person_asset(DeleteRealPersonAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-1".into(),
            })
            .await
            .expect("delete asset");
        assert_eq!(deleted_id, "asset-1");

        library
            .delete_real_person_group(DeleteRealPersonGroupCommand {
                provider_connection_id: "provider-1".into(),
                id: 128,
            })
            .await
            .expect("delete group");

        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].path, "/v1/assets/real-person/auth/link");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(
            requests[0].body,
            Some(json!({
                "artist_name": "张三",
                "artist_desc": "品牌代言人真人素材组"
            }))
        );
        assert_eq!(requests[1].path, "/v1/assets/real-person/groups");
        assert_eq!(requests[1].method, Method::GET);
        assert_eq!(requests[1].body, None);
        assert_eq!(requests[2].body, Some(json!({ "id": "asset-1" })));
        assert_eq!(requests[3].body, Some(json!({ "id": 128 })));
    }

    #[tokio::test]
    async fn real_person_group_without_authorized_at_remains_visible() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "code": "success",
                "data": { "items": [{
                    "id": 129,
                    "group_id": "group-remote-without-authorized-at",
                    "artist_name": "李四",
                    "artist_desc": "认证成功的真人素材组",
                    "asset_count": 0
                }] }
            }),
        )]));
        let library = test_library(adapter, immediate_poll());

        let groups = library
            .list_real_person_groups(RealPersonProviderCommand {
                provider_connection_id: "provider-1".into(),
            })
            .await
            .expect("a valid authorized group must not be discarded when its timestamp is absent");

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, 129);
        assert_eq!(groups[0].artist_name, "李四");
        assert_eq!(groups[0].authorized_at, None);
    }

    #[tokio::test]
    async fn real_person_import_uses_the_explicit_platform_group_without_group_discovery() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-real-1", "asset_url": "asset://asset-real-1" } }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-real-1", "asset_type": "Image", "status": "Active" } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let identity = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/face.png".into(),
                media_type: MediaType::Image,
                display_name: Some("张三-正脸".into()),
                group_id: Some(128),
            })
            .await
            .expect("import real-person asset");

        assert_eq!(identity.asset_id, "asset-real-1");
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets", "/v1/assets/get"]
        );
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests[0].body.as_ref().unwrap()["group_id"], 128);
    }

    #[tokio::test]
    async fn real_person_import_surfaces_face_mismatch_from_the_upstream_error_envelope() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            500,
            json!({ "error": { "message": "FaceMismatch: 上传素材与授权认证人脸不一致" } }),
        )]));
        let library = test_library(adapter, immediate_poll());

        let error = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/not-the-artist.png".into(),
                media_type: MediaType::Image,
                display_name: Some("错误人脸".into()),
                group_id: Some(128),
            })
            .await
            .expect_err("face mismatch must fail");

        assert!(error.to_string().contains("FaceMismatch"));
        assert!(error.to_string().contains("上传素材与授权认证人脸不一致"));
    }

    #[tokio::test]
    async fn import_staged_follows_documented_single_asset_contract() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(200, json!({ "data": [] })),
            response(
                200,
                json!({ "code": "success", "data": { "group_name": "user-1-token-1-infinite-canvas" } }),
            ),
            response(
                200,
                json!({ "data": [{ "id": 12, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1", "asset_url": "asset://asset-1" } }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1", "asset_type": "Image", "status": "Processing" } }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1", "asset_type": "Image", "status": "Active" } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let identity = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/a.png".into(),
                media_type: MediaType::Image,
                display_name: Some("参考图".into()),
                group_id: None,
            })
            .await
            .expect("import");

        assert_eq!(identity.asset_id, "asset-1");
        assert_eq!(
            adapter.request_paths(),
            vec![
                "/v1/assets/groups",
                "/v1/assets/groups",
                "/v1/assets/groups",
                "/v1/assets",
                "/v1/assets/get",
                "/v1/assets/get",
            ]
        );
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests[0].method, Method::GET);
        assert_eq!(requests[1].method, Method::POST);
        assert_eq!(requests[2].method, Method::GET);
        assert_eq!(requests[3].method, Method::POST);
        assert_eq!(requests[4].method, Method::POST);
        assert_eq!(requests[5].method, Method::POST);
        assert_eq!(
            requests[3].body,
            Some(json!({
                "url": "https://tos.example.com/a.png",
                "asset_type": "Image",
                "name": "参考图",
                "group_id": 12,
            }))
        );
        assert_eq!(requests[4].body, Some(json!({ "id": "asset-1" })));
    }

    #[tokio::test]
    async fn import_staged_resolves_the_group_inside_each_current_token_scope() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "data": [{ "id": 12, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1", "asset_url": "asset://asset-1" } }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-1", "asset_type": "Image", "status": "Active" } }),
            ),
            response(
                200,
                json!({ "data": [{ "id": 24, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-2", "asset_url": "asset://asset-2" } }),
            ),
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-2", "asset_type": "Image", "status": "Active" } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        for (url, name) in [
            ("https://tos.example.com/a.png", "素材 A"),
            ("https://tos.example.com/b.png", "素材 B"),
        ] {
            library
                .import_staged(ImportStagedAsset {
                    provider_connection_id: "provider-1".into(),
                    public_url: url.into(),
                    media_type: MediaType::Image,
                    display_name: Some(name.into()),
                    group_id: None,
                })
                .await
                .expect("import in current token scope");
        }

        assert_eq!(
            adapter.request_paths(),
            vec![
                "/v1/assets/groups",
                "/v1/assets",
                "/v1/assets/get",
                "/v1/assets/groups",
                "/v1/assets",
                "/v1/assets/get",
            ]
        );
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests[1].body.as_ref().unwrap()["group_id"], 12);
        assert_eq!(requests[4].body.as_ref().unwrap()["group_id"], 24);
    }

    #[tokio::test]
    async fn resolve_returns_verified_bytes_through_the_recorded_adapter() {
        let url = "https://cdn.example.com/asset.png";
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "data": {
                    "id": "asset-1",
                    "name": "asset.png",
                    "asset_type": "image",
                    "status": "Active",
                    "preview_url": url
                }
            }),
        )]));
        adapter
            .downloads
            .lock()
            .expect("download lock")
            .insert(url.into(), vec![137, 80, 78, 71, 13, 10, 26, 10]);
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let task = task();

        let resolved = library
            .resolve(ResolveAsset {
                identity: CloudAssetIdentity {
                    provider_connection_id: "provider-1".into(),
                    asset_id: "asset-1".into(),
                },
                expected_media_type: MediaType::Image,
                delivery: AssetDelivery::Bytes,
                trace: AssetReadTrace {
                    task: &task,
                    attempt_id: "attempt-1",
                },
            })
            .await
            .expect("resolve");

        assert_eq!(resolved.mime_type, "image/png");
        assert_eq!(resolved.file_extension, "png");
        assert_eq!(resolved.byte_size, 8);
        assert!(matches!(resolved.access, ResolvedAssetAccess::Bytes(_)));
        assert_eq!(adapter.request_paths(), vec!["/v1/assets/get"]);
    }

    #[tokio::test]
    async fn resolve_only_reuses_asset_handles_inside_the_actual_credential_scope() {
        let asset_response = || {
            response(
                200,
                json!({
                    "data": {
                        "id": "asset-1",
                        "name": "clip.mp4",
                        "asset_type": "video",
                        "status": "Active",
                        "asset_url": "asset://asset-1",
                        "preview_url": "https://cdn.example.com/clip.mp4"
                    }
                }),
            )
        };
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            asset_response(),
            asset_response(),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let task = task();
        let request = |destination_provider_connection_id: &str| ResolveAsset {
            identity: CloudAssetIdentity {
                provider_connection_id: "provider-1".into(),
                asset_id: "asset-1".into(),
            },
            expected_media_type: MediaType::Video,
            delivery: AssetDelivery::RemoteReadable {
                destination_provider_connection_id: destination_provider_connection_id.into(),
            },
            trace: AssetReadTrace {
                task: &task,
                attempt_id: "attempt-1",
            },
        };

        let cross_scope = library
            .resolve(request("provider-2"))
            .await
            .expect("cross-scope resolve");
        let same_scope = library
            .resolve(request("provider-1"))
            .await
            .expect("same-scope resolve");

        assert!(matches!(
            cross_scope.access,
            ResolvedAssetAccess::RemoteReference(ref value)
                if value == "https://cdn.example.com/clip.mp4"
        ));
        assert!(matches!(
            same_scope.access,
            ResolvedAssetAccess::RemoteReference(ref value) if value == "asset://asset-1"
        ));
    }

    #[tokio::test]
    async fn browse_surfaces_non_success_responses_as_protocol_errors() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            401,
            json!({ "message": "unauthorized" }),
        )]));
        let library = test_library(adapter, immediate_poll());

        let error = library
            .browse(AssetListCommand {
                provider_connection_id: "provider-1".into(),
                page_number: None,
                page_size: None,
                name: None,
                group_id: None,
            })
            .await
            .expect_err("HTTP 401 should fail");

        assert!(error.to_string().contains("HTTP 401"));
    }
}
