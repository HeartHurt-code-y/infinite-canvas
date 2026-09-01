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
        AssetListCommand, CloudAssetIdentity, CloudAssetRecord, CloudAssetStatus, MediaType,
        RawProviderResponse,
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

    fn credential_ref(&self, provider_connection_id: String) -> BackendResult<String>;
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

    fn credential_ref(&self, provider_connection_id: String) -> BackendResult<String> {
        self.providers
            .resolved_asset_library_credential_ref(&provider_connection_id)
    }
}

#[derive(Debug, Clone)]
pub struct ImportStagedAsset {
    pub provider_connection_id: String,
    pub public_url: String,
    pub media_type: MediaType,
    pub display_name: Option<String>,
}

pub struct AssetReadTrace<'a> {
    pub task: &'a TaskExecutionRecord,
    pub attempt_id: &'a str,
}

#[derive(Debug, Clone)]
pub enum AssetDelivery {
    Bytes,
    RemoteReadable { destination_credential_ref: String },
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
    upload_groups: Arc<Mutex<HashMap<String, i64>>>,
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
            upload_groups: Arc::new(Mutex::new(HashMap::new())),
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

    /// Import an already staged public object and wait until the remote 素材 becomes readable.
    /// Group discovery, single-flight creation, batch polling and terminal-state mapping stay local.
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
        let group_id = self
            .resolve_upload_group(&request.provider_connection_id)
            .await?;
        let display_name = request
            .display_name
            .as_deref()
            .map(|value| value.chars().take(64).collect::<String>());
        let mut body = json!({
            "urls": [request.public_url],
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
        let batch_id = payload
            .pointer("/data/batch_id")
            .or_else(|| payload.get("batch_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "asset import did not return a batch id",
                    json!({ "rawResponse": response.body }),
                )
            })?
            .to_string();
        self.wait_for_import(
            &request.provider_connection_id,
            &request.public_url,
            &batch_id,
        )
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
                destination_credential_ref,
            } => {
                let source_credential_ref = self
                    .port
                    .credential_ref(identity.provider_connection_id.clone())?;
                let same_credential_scope = source_credential_ref == destination_credential_ref;
                let reference = if same_credential_scope {
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
        if let Some(group_id) = self
            .upload_groups
            .lock()
            .await
            .get(provider_connection_id)
            .copied()
        {
            return Ok(group_id);
        }
        let gate = {
            let mut gates = self.upload_group_gates.lock().await;
            Arc::clone(
                gates
                    .entry(provider_connection_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = gate.lock().await;
        if let Some(group_id) = self
            .upload_groups
            .lock()
            .await
            .get(provider_connection_id)
            .copied()
        {
            return Ok(group_id);
        }
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
        self.upload_groups
            .lock()
            .await
            .insert(provider_connection_id.to_string(), group_id);
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
        public_url: &str,
        batch_id: &str,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut consecutive_failures = 0;
        loop {
            if started.elapsed() >= self.poll_policy.timeout {
                return Err(BackendError::protocol(
                    "asset import did not become ready before the local wait deadline",
                    json!({ "batchId": batch_id, "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            if !self.poll_policy.interval.is_zero() {
                tokio::time::sleep(self.poll_policy.interval).await;
            }
            let response = match self
                .port
                .send(RemoteAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    method: Method::POST,
                    path: "/v1/assets/batch/get",
                    body: Some(json!({ "batch_id": batch_id })),
                })
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= self.poll_policy.failure_limit {
                        return Err(error);
                    }
                    continue;
                }
            };
            if let Err(error) = require_success("observe asset import", &response) {
                consecutive_failures += 1;
                if consecutive_failures >= self.poll_policy.failure_limit {
                    return Err(error);
                }
                continue;
            }
            let payload: Value = serde_json::from_str(&response.body)?;
            let items = payload
                .get("data")
                .map(asset_array)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| asset_array(&payload));
            let item = items
                .iter()
                .copied()
                .find(|item| {
                    item.as_object()
                        .and_then(|record| string_field(record, &["source_url", "sourceUrl"]))
                        == Some(public_url)
                })
                .or_else(|| items.first().copied())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "asset batch lookup did not include the imported item",
                        json!({ "batchId": batch_id, "rawResponse": response.body }),
                    )
                })?;
            consecutive_failures = 0;
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN");
            match status.trim().to_ascii_lowercase().as_str() {
                "active" | "ready" => {
                    let asset_id = item
                        .as_object()
                        .and_then(|record| string_field(record, &["id", "asset_id", "assetId"]))
                        .map(str::trim)
                        .filter(|value| !value.is_empty() && *value != batch_id)
                        .ok_or_else(|| {
                            BackendError::protocol(
                                "ready asset import did not return a stable asset id",
                                json!({ "batchId": batch_id, "rawResponse": response.body }),
                            )
                        })?;
                    return Ok(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id: asset_id.to_string(),
                    });
                }
                "failed" | "deleted" => {
                    return Err(BackendError::protocol(
                        format!("asset import reached terminal status {status}"),
                        json!({
                            "batchId": batch_id,
                            "itemError": item.get("error"),
                            "rawResponse": response.body
                        }),
                    ));
                }
                _ => {}
            }
        }
    }
}

fn require_success(operation: &str, response: &RawProviderResponse) -> BackendResult<()> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    Err(BackendError::protocol(
        format!("{operation} returned HTTP {}", response.status),
        json!({
            "httpStatus": response.status,
            "headers": response.headers,
            "rawResponse": response.body
        }),
    ))
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
        credential_refs: StdMutex<StdHashMap<String, String>>,
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

        fn credential_ref(&self, provider_connection_id: String) -> BackendResult<String> {
            Ok(self
                .credential_refs
                .lock()
                .expect("credential lock")
                .get(&provider_connection_id)
                .cloned()
                .unwrap_or_else(|| format!("provider:{provider_connection_id}:api-key")))
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
    async fn import_staged_owns_group_creation_submission_and_polling() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(200, json!({ "data": [] })),
            response(200, json!({ "success": true })),
            response(
                200,
                json!({ "data": [{ "id": 12, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(200, json!({ "data": { "batch_id": "batch-1" } })),
            response(
                200,
                json!({ "data": { "items": [{ "source_url": "https://tos.example.com/a.png", "status": "Processing" }] } }),
            ),
            response(
                200,
                json!({ "data": { "items": [{ "id": "asset-1", "source_url": "https://tos.example.com/a.png", "status": "Active" }] } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let identity = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/a.png".into(),
                media_type: MediaType::Image,
                display_name: Some("参考图".into()),
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
                "/v1/assets/batch/get",
                "/v1/assets/batch/get",
            ]
        );
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
        adapter
            .credential_refs
            .lock()
            .expect("credential lock")
            .insert("provider-1".into(), "asset-library-token:provider-1".into());
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let task = task();
        let request = |destination_credential_ref: &str| ResolveAsset {
            identity: CloudAssetIdentity {
                provider_connection_id: "provider-1".into(),
                asset_id: "asset-1".into(),
            },
            expected_media_type: MediaType::Video,
            delivery: AssetDelivery::RemoteReadable {
                destination_credential_ref: destination_credential_ref.into(),
            },
            trace: AssetReadTrace {
                task: &task,
                attempt_id: "attempt-1",
            },
        };

        let cross_scope = library
            .resolve(request("provider:provider-1:api-key"))
            .await
            .expect("cross-scope resolve");
        let same_scope = library
            .resolve(request("asset-library-token:provider-1"))
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
