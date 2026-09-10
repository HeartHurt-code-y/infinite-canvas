use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt as _;
use reqwest::Method;
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use tauri_plugin_log::log::warn;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;
use url::Url;

use super::{
    error::{BackendError, BackendResult},
    provider::{ARK_ADAPTER_ID, ProviderRuntime},
    storage::TaskExecutionRecord,
    types::{
        AssetGroupRecord, AssetListCommand, CloudAssetIdentity, CloudAssetRecord, CloudAssetStatus,
        CreateAssetGroupCommand, CreateRealPersonAuthLinkCommand, DeleteAssetCommand,
        DeleteAssetGroupCommand, DeleteRealPersonAssetCommand, DeleteRealPersonGroupCommand,
        ListAssetGroupsCommand, MediaType, RawProviderResponse, RealPersonAuthLink,
        RealPersonGroup, RealPersonProviderCommand, RefreshAssetCoverCommand,
        RefreshAssetMediaCommand, RenameAssetCommand, UpdateAssetGroupCommand,
    },
};

const UPLOAD_GROUP_NAME: &str = "无限画布上传";
/// 火山引擎方舟素材组的类型：桌面端上传/管理的素材统一落在 AIGC（虚拟人像）组。
/// Ark ListAssets / ListAssetGroups / CreateAssetGroup 均要求或使用该字段。
const ARK_GROUP_TYPE: &str = "AIGC";
const IMPORT_POLL_FAILURE_LIMIT: u32 = 5;
const IMPORT_POLL_INTERVAL: Duration = Duration::from_secs(5);
const IMPORT_POLL_TIMEOUT: Duration = Duration::from_secs(300);
/// 类型过滤扫描的上游页数上限（每页 100 条）。到达上限仍未集齐目标页时按已有结果返回，
/// 避免类型分布极端或翻深页时无界地请求上游。
const KIND_SCAN_PAGE_CAP: u64 = 50;

/// 素材提交类请求（`/v1/assets/async`、`/v1/assets/upload`）对上游瞬时网关故障
/// （HTTP 502/503/504，如审核服务暂不可用）的最大额外重试次数。这类响应可安全重试：
/// 提交失败时素材尚未在上游创建。HTTP 500 属业务拒绝（如 FaceMismatch），不重试。
const SUBMIT_MAX_RETRIES: u32 = 3;

/// 素材提交重试的指数退避基准延迟（毫秒）：第 n 次重试前等待 `BASE_MS * 2^(n-1)`。
const SUBMIT_RETRY_BASE_DELAY_MS: u64 = 1000;

type PortFuture<T> = Pin<Box<dyn Future<Output = BackendResult<T>> + Send>>;

/// 云端素材库的接口方言：同一套素材域操作在不同上游有不同的请求契约。
///
/// - `Moyu`：OpenAI 兼容路径风格（`/v1/assets/list` 等 + Bearer 令牌）；
/// - `VolcengineArk`：火山引擎方舟 OpenAPI（`?Action=ListAssets&Version=…` + V4 签名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetDialect {
    Moyu,
    VolcengineArk,
}

/// 火山引擎 Ark OpenAPI 请求（Action + JSON body），由 ProviderAssetAdapter 签名转发。
#[derive(Debug, Clone)]
struct ArkAssetRequest {
    provider_connection_id: String,
    action: &'static str,
    body: Value,
}

#[derive(Debug, Clone)]
struct RemoteAssetRequest {
    provider_connection_id: String,
    method: Method,
    path: &'static str,
    body: Option<Value>,
}

/// multipart 文件上传请求（海外平台素材上传 `POST /v1/assets/upload`）。
/// 文件以磁盘路径 + 大小传递：生产端用流式 part 直传，避免整个文件驻留内存。
#[derive(Debug, Clone)]
struct MultipartAssetRequest {
    provider_connection_id: String,
    path: &'static str,
    /// multipart 文本字段，例如 `kind=image`、`group_id=16`、`name=...`。
    fields: Vec<(String, String)>,
    /// 文件 part 字段名（`file`）。
    file_field: String,
    file_name: String,
    mime_type: String,
    file_path: PathBuf,
    /// 文件字节数（流式 part 的 content-length）。
    file_size: u64,
}

trait AssetPort: Send + Sync {
    fn send(&self, request: RemoteAssetRequest) -> PortFuture<RawProviderResponse>;

    fn send_multipart(&self, request: MultipartAssetRequest) -> PortFuture<RawProviderResponse>;

    /// 发送一次火山引擎 Ark OpenAPI 请求（已由实现方完成 V4 签名）。
    fn send_ark(&self, request: ArkAssetRequest) -> PortFuture<RawProviderResponse>;

    /// 解析素材库连接使用的接口方言（依据供应商连接的 adapter_id）。
    fn dialect(&self, provider_connection_id: &str) -> BackendResult<AssetDialect>;

    /// 素材库网关判定：给定 provider_connection_id 对应的 base_url 是否为海外平台。
    /// 海外平台（如 konjac.ai）素材上传必须走 `POST /v1/assets/upload` multipart 直传。
    fn is_overseas_gateway(&self, provider_connection_id: &str) -> BackendResult<bool>;

    fn get_recorded(
        &self,
        task: TaskExecutionRecord,
        attempt_id: String,
        identity: CloudAssetIdentity,
    ) -> PortFuture<RawProviderResponse>;

    fn download(&self, url: String) -> PortFuture<Vec<u8>>;

    /// 流式下载远端素材到指定文件（覆盖写），返回写入的总字节数。
    /// `on_progress(done_bytes, total_bytes)`，`total` 未知（无 Content-Length）时为 0。
    /// 用于海外素材导入：下载落盘后以流式 multipart 直传，文件全程不整段驻留内存。
    fn download_to_file(
        &self,
        url: String,
        destination: PathBuf,
        on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
    ) -> PortFuture<u64>;
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

    fn send_multipart(&self, request: MultipartAssetRequest) -> PortFuture<RawProviderResponse> {
        let providers = self.providers.clone();
        Box::pin(async move {
            providers
                .raw_asset_multipart_request(
                    &request.provider_connection_id,
                    request.path,
                    &request.fields,
                    &request.file_field,
                    &request.file_name,
                    &request.mime_type,
                    &request.file_path,
                    request.file_size,
                )
                .await
        })
    }

    fn send_ark(&self, request: ArkAssetRequest) -> PortFuture<RawProviderResponse> {
        let providers = self.providers.clone();
        Box::pin(async move {
            providers
                .raw_ark_action_request(
                    &request.provider_connection_id,
                    request.action,
                    &request.body,
                )
                .await
        })
    }

    fn dialect(&self, provider_connection_id: &str) -> BackendResult<AssetDialect> {
        let context = self
            .providers
            .resolve_asset_library(provider_connection_id)?;
        Ok(match context.adapter_id.as_str() {
            ARK_ADAPTER_ID => AssetDialect::VolcengineArk,
            _ => AssetDialect::Moyu,
        })
    }

    fn is_overseas_gateway(&self, provider_connection_id: &str) -> BackendResult<bool> {
        let context = self
            .providers
            .resolve_asset_library(provider_connection_id)?;
        Ok(is_overseas_asset_base_url(&context.base_url))
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
            // 代理 fake-ip 环境下用备用 DNS 拿真实 IP 直连，避免下载 TOS 暂存对象时连接失败。
            let client = super::staging::fake_ip_aware_client(&url, client).await;
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

    fn download_to_file(
        &self,
        url: String,
        destination: PathBuf,
        on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
    ) -> PortFuture<u64> {
        let client = self.providers.client().clone();
        Box::pin(async move {
            // 代理 fake-ip 环境下用备用 DNS 拿真实 IP 直连，避免下载 TOS 暂存对象时连接失败。
            let client = super::staging::fake_ip_aware_client(&url, client).await;
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
            let total = response.content_length().unwrap_or(0);
            // 分块流式写盘：内存中任意时刻只有单个网络 chunk，不再累积整文件。
            let mut stream = response.bytes_stream();
            let mut file = tokio::fs::File::create(&destination).await?;
            let mut done: u64 = 0;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk).await?;
                done = done.saturating_add(chunk.len() as u64);
                if let Some(on_progress) = on_progress.as_ref() {
                    on_progress(done, total);
                }
            }
            file.flush().await?;
            Ok(done)
        })
    }
}

#[derive(Debug, Clone)]
pub struct ImportStagedAsset {
    pub provider_connection_id: String,
    pub public_url: String,
    pub media_type: MediaType,
    pub display_name: Option<String>,
    /// 目标云端素材库分组 ID（字符串形态）。魔芋方言解析为正整数平台分组；
    /// 火山方言直接作为 `GroupId` 使用。`None` 时按方言各自发现/创建上传分组。
    pub group_id: Option<String>,
}

/// 导入临时文件守卫：作用域结束（含错误路径）时删除落盘文件。
struct TempMediaFile {
    path: PathBuf,
}

impl TempMediaFile {
    fn create() -> Self {
        let path = std::env::temp_dir().join(format!(
            "infinite-canvas-asset-import-{}.bin",
            uuid::Uuid::new_v4()
        ));
        Self { path }
    }
}

impl Drop for TempMediaFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
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
    ///
    /// 未指定 `kind` 时单次转发上游分页（`page_number`/`page_size` 透传）。
    /// 指定 `kind` 时上游不支持类型参数，改为逐页扫描（每页 100 条）并按类型过滤，
    /// 跳过 `(page_number-1)*page_size` 条命中后收集一页；扫描在命中数集齐、
    /// 上游翻完或到达 [`KIND_SCAN_PAGE_CAP`] 时提前结束。
    pub async fn browse(&self, query: AssetListCommand) -> BackendResult<Vec<CloudAssetRecord>> {
        if self.dialect(&query.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self.ark_browse(query).await;
        }
        let page_number = query.page_number.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(100).clamp(1, 100);
        let Some(kind) = query.kind else {
            return self
                .browse_upstream_page(&query, u64::from(page_number), u64::from(page_size))
                .await;
        };
        let skip = (page_number as u64 - 1) * page_size as u64;
        let want = page_size as u64;
        let mut matched: Vec<CloudAssetRecord> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for upstream_page in 1..=KIND_SCAN_PAGE_CAP {
            let records = self
                .browse_upstream_page(&query, upstream_page, 100)
                .await?;
            let exhausted = records.len() < 100;
            matched.extend(
                records
                    .into_iter()
                    .filter(|record| record.kind == kind)
                    .filter(|record| seen.insert(record.id.clone())),
            );
            if exhausted || matched.len() as u64 >= skip + want {
                break;
            }
        }
        Ok(matched
            .into_iter()
            .skip(usize::try_from(skip).unwrap_or(usize::MAX))
            .take(usize::try_from(want).unwrap_or(usize::MAX))
            .collect())
    }

    /// 解析素材库连接的接口方言。
    fn dialect(&self, provider_connection_id: &str) -> BackendResult<AssetDialect> {
        self.port.dialect(provider_connection_id)
    }

    /// 真人素材 H5 授权契约仅存在于魔芋方言；火山引擎连接调用时返回明确错误。
    fn require_moyu_dialect(
        &self,
        provider_connection_id: &str,
        operation: &str,
    ) -> BackendResult<()> {
        match self.port.dialect(provider_connection_id)? {
            AssetDialect::Moyu => Ok(()),
            AssetDialect::VolcengineArk => Err(BackendError::validation(
                "火山引擎素材库不支持真人素材 H5 授权流程",
                json!({ "operation": operation, "providerConnectionId": provider_connection_id }),
            )),
        }
    }

    /// 发起一次上游 `/v1/assets/list` 分页请求并解析为规范素材记录（跨响应去重）。
    async fn browse_upstream_page(
        &self,
        query: &AssetListCommand,
        page_number: u64,
        page_size: u64,
    ) -> BackendResult<Vec<CloudAssetRecord>> {
        let provider_connection_id = query.provider_connection_id.clone();
        let mut body = Map::new();
        body.insert("page_number".into(), json!(page_number));
        body.insert("page_size".into(), json!(page_size));
        if let Some(value) = query
            .name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            body.insert("name".into(), value.into());
        }
        // 魔芋契约的 group_id 为数值：字符串分组 ID 仅在可解析为整数时透传
        // （火山形态的组 ID 在魔芋方言下天然查不到，行为等同未命中）。
        if let Some(value) = query
            .group_id
            .as_deref()
            .and_then(|group| group.trim().parse::<i64>().ok())
        {
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
        self.require_moyu_dialect(provider_connection_id, "create real-person auth link")?;
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
        self.require_moyu_dialect(provider_connection_id, "list real-person groups")?;
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
        self.require_moyu_dialect(provider_connection_id, "delete real-person asset")?;
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
        self.require_moyu_dialect(provider_connection_id, "delete real-person group")?;
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

    /// Permanently remove one ordinary cloud asset from both the platform and upstream service.
    ///
    /// 对应上游契约 `POST /v1/assets/delete`，body `{"id":"asset-…"}`，返回被删除的素材 ID。
    /// 接受 `asset://` 前缀以便前端直接传引用；未知/无权访问的素材由上游以 4xx/5xx 报错透传。
    pub async fn delete_asset(&self, command: DeleteAssetCommand) -> BackendResult<String> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        if self.dialect(provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_delete_asset(provider_connection_id, command.id)
                .await;
        }
        let id = command
            .id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| command.id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset deletion requires an asset id without the asset:// prefix",
                json!({ "id": command.id }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/delete",
                body: Some(json!({ "id": id })),
            })
            .await?;
        // 删除是幂等操作：素材已被删除或本就不存在时，上游返回 HTTP 404
        // 「素材不存在或已删除」，此时删除目标已达成，按成功处理。
        if response.status == 404 {
            return Ok(id.to_string());
        }
        require_success("delete asset", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        // 上游成功响应可能只回 `{"code":"success","success":true}` 而不回显被删素材 id，
        // 此时以请求的 id 作为被删除素材 id 返回（删除即针对该 id）。
        let returned_id = payload
            .pointer("/data/id")
            .or_else(|| payload.get("id"))
            .and_then(asset_id_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| id.to_string());
        Ok(returned_id)
    }

    /// List cloud 素材库 groups scoped to the selected provider token.
    /// Upstream already returns `name` without the `user-{uid}-token-{tid}-` prefix,
    /// so the UI displays that field directly and never shows the prefixed full name.
    pub async fn list_asset_groups(
        &self,
        command: ListAssetGroupsCommand,
    ) -> BackendResult<Vec<AssetGroupRecord>> {
        require_asset_library_connection(&command.provider_connection_id)?;
        if self.dialect(&command.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_list_asset_groups(&command.provider_connection_id)
                .await;
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: command.provider_connection_id,
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
        Ok(groups.into_iter().filter_map(parse_asset_group).collect())
    }

    /// Create a cloud 素材库 group with a user-defined display name.
    pub async fn create_asset_group(
        &self,
        command: CreateAssetGroupCommand,
    ) -> BackendResult<AssetGroupRecord> {
        require_asset_library_connection(&command.provider_connection_id)?;
        if self.dialect(&command.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_create_asset_group(&command.provider_connection_id, &command.name)
                .await;
        }
        let name = command.name.trim();
        if name.is_empty() {
            return Err(BackendError::validation(
                "asset group name must not be empty",
                json!({ "field": "name" }),
            ));
        }
        if name.chars().count() > 64 {
            return Err(BackendError::validation(
                "asset group name must not exceed 64 characters",
                json!({ "field": "name", "maxLength": 64 }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: command.provider_connection_id,
                method: Method::POST,
                path: "/v1/assets/groups",
                body: Some(json!({ "name": name })),
            })
            .await?;
        require_success("create asset group", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let data = payload.get("data").unwrap_or(&payload);
        // 上游创建接口通常回完整记录；部分环境只回 `group_name`，此时用请求名兜底，
        // 生成临时负数 id（真实 id 均为正数），后台 list 刷新后同步真实 id。
        if let Some(record) = parse_asset_group(data) {
            return Ok(record);
        }
        let group_name = data
            .get("group_name")
            .or_else(|| data.get("groupName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "asset group creation did not return a group record",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        let temp_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| -(d.as_millis() as i64))
            .unwrap_or(-1);
        Ok(AssetGroupRecord {
            // 临时负数 ID 的字符串形态（魔芋真实 id 均为正数），后台 list 刷新后同步真实 id。
            id: temp_id.to_string(),
            name: name.to_string(),
            group_name: group_name.to_string(),
            is_default: false,
            asset_count: 0,
        })
    }

    /// Rename a cloud 素材 in place (`POST /v1/assets/update`). Returns the asset id.
    pub async fn rename_asset(&self, command: RenameAssetCommand) -> BackendResult<String> {
        require_asset_library_connection(&command.provider_connection_id)?;
        if self.dialect(&command.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_rename_asset(&command.provider_connection_id, &command.id, &command.name)
                .await;
        }
        let id = command
            .id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| command.id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset rename requires an asset id without the asset:// prefix",
                json!({ "id": command.id }),
            ));
        }
        let name = command.name.trim();
        if name.is_empty() {
            return Err(BackendError::validation(
                "asset name must not be empty",
                json!({ "field": "name" }),
            ));
        }
        if name.chars().count() > 64 {
            return Err(BackendError::validation(
                "asset name must not exceed 64 characters",
                json!({ "field": "name", "maxLength": 64 }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: command.provider_connection_id,
                method: Method::POST,
                path: "/v1/assets/update",
                body: Some(json!({ "id": id, "name": name })),
            })
            .await?;
        require_success("rename asset", &response)?;
        Ok(id.to_string())
    }

    /// 更新云端素材库分组信息（火山引擎 `UpdateAssetGroup`：名称与描述）。
    /// 返回被更新的分组 ID。魔芋方言未提供对应端点，返回明确错误。
    pub async fn update_asset_group(
        &self,
        command: UpdateAssetGroupCommand,
    ) -> BackendResult<String> {
        require_asset_library_connection(&command.provider_connection_id)?;
        if self.dialect(&command.provider_connection_id)? != AssetDialect::VolcengineArk {
            return Err(BackendError::validation(
                "当前素材库供应商不支持更新素材分组信息",
                json!({
                    "providerConnectionId": command.provider_connection_id,
                    "supported": ["volcengine_ark_v1"],
                }),
            ));
        }
        let id = command.id.trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset group update requires a group id",
                json!({ "field": "id" }),
            ));
        }
        let name = command
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let description = command
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if name.is_none() && description.is_none() {
            return Err(BackendError::validation(
                "asset group update requires a new name or description",
                json!({ "field": "name" }),
            ));
        }
        if let Some(name) = name {
            if name.chars().count() > 64 {
                return Err(BackendError::validation(
                    "asset group name must not exceed 64 characters",
                    json!({ "field": "name", "maxLength": 64 }),
                ));
            }
        }
        if let Some(description) = description {
            if description.chars().count() > 300 {
                return Err(BackendError::validation(
                    "asset group description must not exceed 300 characters",
                    json!({ "field": "description", "maxLength": 300 }),
                ));
            }
        }
        let mut body = Map::new();
        body.insert("Id".into(), json!(id));
        if let Some(name) = name {
            body.insert("Name".into(), json!(name));
        }
        if let Some(description) = description {
            body.insert("Description".into(), json!(description));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: command.provider_connection_id,
                action: "UpdateAssetGroup",
                body: Value::Object(body),
            })
            .await?;
        require_success("update asset group", &response)?;
        Ok(id.to_string())
    }

    /// 删除云端素材库分组及组内全部素材（不可逆），返回被删除的分组 ID。
    /// 魔芋方言走 `POST /v1/assets/groups/delete`，火山引擎方舟方言走 `DeleteAssetGroup`。
    pub async fn delete_asset_group(
        &self,
        command: DeleteAssetGroupCommand,
    ) -> BackendResult<String> {
        require_asset_library_connection(&command.provider_connection_id)?;
        if self.dialect(&command.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_delete_asset_group(&command.provider_connection_id, &command.id)
                .await;
        }
        // 魔芋方言：`POST /v1/assets/groups/delete`，请求体为 `{"id": <group id>}`。
        let id = command.id.trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset group deletion requires a group id",
                json!({ "field": "id" }),
            ));
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: command.provider_connection_id,
                method: Method::POST,
                path: "/v1/assets/groups/delete",
                body: Some(json!({ "id": id })),
            })
            .await?;
        // 删除为幂等操作：分组已不存在（HTTP 404）时按成功处理。
        if response.status == 404 {
            return Ok(id.to_string());
        }
        require_success("delete asset group", &response)?;
        Ok(id.to_string())
    }

    // ===================== 火山引擎方舟（Ark）方言实现 =====================
    //
    // Ark 素材 OpenAPI 为 Action 风格（ListAssets / GetAsset / CreateAsset /
    // UpdateAsset / DeleteAsset / ListAssetGroups / GetAssetGroup /
    // CreateAssetGroup / UpdateAssetGroup / DeleteAssetGroup），请求体为
    // PascalCase 字段的 JSON，鉴权由 [`AssetPort::send_ark`] 完成 V4 签名。

    /// 火山方言素材列表：`ListAssets`（页码分页）。
    ///
    /// `Filter.GroupType` 为必选参数，桌面端素材统一落在 `AIGC` 组；`kind`
    /// 过滤上游不支持（`Filter` 只有 GroupIds/Name/Statuses），沿用魔芋方言的
    /// 逐页扫描 + 本地过滤策略（每页 100 条，最多 [`KIND_SCAN_PAGE_CAP`] 页）。
    async fn ark_browse(&self, query: AssetListCommand) -> BackendResult<Vec<CloudAssetRecord>> {
        let page_number = query.page_number.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(100).clamp(1, 100);
        let Some(kind) = query.kind else {
            let records = self
                .ark_browse_page(&query, u64::from(page_number), u64::from(page_size))
                .await?;
            return Ok(records);
        };
        let skip = (page_number as u64 - 1) * page_size as u64;
        let want = page_size as u64;
        let mut matched: Vec<CloudAssetRecord> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for upstream_page in 1..=KIND_SCAN_PAGE_CAP {
            let records = self.ark_browse_page(&query, upstream_page, 100).await?;
            let exhausted = records.len() < 100;
            matched.extend(
                records
                    .into_iter()
                    .filter(|record| record.kind == kind)
                    .filter(|record| seen.insert(record.id.clone())),
            );
            if exhausted || matched.len() as u64 >= skip + want {
                break;
            }
        }
        Ok(matched
            .into_iter()
            .skip(usize::try_from(skip).unwrap_or(usize::MAX))
            .take(usize::try_from(want).unwrap_or(usize::MAX))
            .collect())
    }

    /// 发起一次 `ListAssets` 页码分页请求并解析为规范素材记录。
    async fn ark_browse_page(
        &self,
        query: &AssetListCommand,
        page_number: u64,
        page_size: u64,
    ) -> BackendResult<Vec<CloudAssetRecord>> {
        let mut filter = Map::new();
        filter.insert("GroupType".into(), json!(ARK_GROUP_TYPE));
        if let Some(group_id) = query
            .group_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            filter.insert("GroupIds".into(), json!([group_id]));
        }
        if let Some(name) = query
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            filter.insert("Name".into(), json!(name));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: query.provider_connection_id.clone(),
                action: "ListAssets",
                body: json!({
                    "Filter": Value::Object(filter),
                    "PageNumber": page_number,
                    "PageSize": page_size,
                }),
            })
            .await?;
        require_success("ark browse assets", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let items = payload
            .get("Items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let provider_connection_id = query.provider_connection_id.clone();
        Ok(items
            .iter()
            .filter_map(|entry| parse_ark_asset_entry(&provider_connection_id, entry))
            .collect())
    }

    /// 火山方言素材删除：`DeleteAsset`（幂等，404 视为已删除）。
    async fn ark_delete_asset(
        &self,
        provider_connection_id: &str,
        id: String,
    ) -> BackendResult<String> {
        let id = id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset deletion requires an asset id without the asset:// prefix",
                json!({ "id": id }),
            ));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                action: "DeleteAsset",
                body: json!({ "Id": id }),
            })
            .await?;
        // 幂等：素材不存在（HTTP 404）时删除目标已达成，按成功处理。
        if response.status == 404 {
            return Ok(id.to_string());
        }
        require_success("ark delete asset", &response)?;
        Ok(id.to_string())
    }

    /// 火山方言分组列表：`ListAssetGroups` 页码分页翻完全部页。
    async fn ark_list_asset_groups(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<Vec<AssetGroupRecord>> {
        let mut groups: Vec<AssetGroupRecord> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for page in 1..=KIND_SCAN_PAGE_CAP {
            let response = self
                .port
                .send_ark(ArkAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    action: "ListAssetGroups",
                    body: json!({
                        "Filter": { "GroupType": ARK_GROUP_TYPE },
                        "PageNumber": page,
                        "PageSize": 100,
                    }),
                })
                .await?;
            require_success("ark list asset groups", &response)?;
            let payload: Value = serde_json::from_str(&response.body)?;
            let items = payload
                .get("Items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let page_len = items.len();
            for item in &items {
                if let Some(record) = parse_ark_asset_group(item) {
                    if seen.insert(record.id.clone()) {
                        groups.push(record);
                    }
                }
            }
            if page_len < 100 {
                break;
            }
        }
        Ok(groups)
    }

    /// 火山方言分组创建：`CreateAssetGroup`（GroupType=AIGC），响应回 `Id`。
    async fn ark_create_asset_group(
        &self,
        provider_connection_id: &str,
        name: &str,
    ) -> BackendResult<AssetGroupRecord> {
        let name = name.trim();
        if name.is_empty() {
            return Err(BackendError::validation(
                "asset group name must not be empty",
                json!({ "field": "name" }),
            ));
        }
        if name.chars().count() > 64 {
            return Err(BackendError::validation(
                "asset group name must not exceed 64 characters",
                json!({ "field": "name", "maxLength": 64 }),
            ));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                action: "CreateAssetGroup",
                body: json!({ "Name": name, "GroupType": ARK_GROUP_TYPE }),
            })
            .await?;
        require_success("ark create asset group", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let id = payload
            .get("Id")
            .and_then(asset_id_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "ark asset group creation did not return a group id",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        Ok(AssetGroupRecord {
            id,
            name: name.to_string(),
            group_name: name.to_string(),
            is_default: false,
            asset_count: 0,
        })
    }

    /// 火山方言分组删除：`DeleteAssetGroup`（请求体 PascalCase 的 `Id`），不可逆。
    async fn ark_delete_asset_group(
        &self,
        provider_connection_id: &str,
        id: &str,
    ) -> BackendResult<String> {
        let id = id.trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset group deletion requires a group id",
                json!({ "field": "id" }),
            ));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                action: "DeleteAssetGroup",
                body: json!({ "Id": id }),
            })
            .await?;
        // 删除为幂等操作：分组已不存在（HTTP 404）时按成功处理。
        if response.status == 404 {
            return Ok(id.to_string());
        }
        require_success("delete asset group", &response)?;
        Ok(id.to_string())
    }

    /// 火山方言素材改名：`UpdateAsset`（当前仅支持更新 Name），响应回 `Id`。
    async fn ark_rename_asset(
        &self,
        provider_connection_id: &str,
        id: &str,
        name: &str,
    ) -> BackendResult<String> {
        let id = id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset rename requires an asset id without the asset:// prefix",
                json!({ "id": id }),
            ));
        }
        let name = name.trim();
        if name.is_empty() {
            return Err(BackendError::validation(
                "asset name must not be empty",
                json!({ "field": "name" }),
            ));
        }
        if name.chars().count() > 64 {
            return Err(BackendError::validation(
                "asset name must not exceed 64 characters",
                json!({ "field": "name", "maxLength": 64 }),
            ));
        }
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                action: "UpdateAsset",
                body: json!({ "Id": id, "Name": name }),
            })
            .await?;
        require_success("ark rename asset", &response)?;
        Ok(id.to_string())
    }

    /// 火山方言素材读取：`GetAsset`，用于预览/播放地址续签（URL 有效期 12 小时）。
    /// 记录结构与 `refresh_asset_record` 的校验保持一致（身份、就绪状态、类型）。
    async fn ark_refresh_asset_record(
        &self,
        identity: CloudAssetIdentity,
        expected_media_type: MediaType,
    ) -> BackendResult<CloudAssetRecord> {
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: identity.provider_connection_id.clone(),
                action: "GetAsset",
                body: json!({ "Id": identity.asset_id }),
            })
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(BackendError::protocol(
                format!(
                    "云素材读取失败（HTTP {}），请检查对应供应商的素材库连接。",
                    response.status
                ),
                json!({ "httpStatus": response.status }),
            ));
        }
        let payload: Value = serde_json::from_str(&response.body)?;
        let asset = parse_ark_asset_entry(&identity.provider_connection_id, &payload)
            .ok_or_else(|| BackendError::protocol("云素材没有返回可读取的记录。", json!({})))?;
        if asset.id != identity.asset_id {
            return Err(BackendError::validation(
                "云素材返回的身份与所选素材不一致，请重新选择素材。",
                json!({}),
            ));
        }
        if asset.status != CloudAssetStatus::Ready {
            return Err(BackendError::validation(
                "云素材尚未就绪或不可读取。",
                json!({ "status": asset.raw_status }),
            ));
        }
        if asset.kind != expected_media_type {
            return Err(BackendError::validation(
                "云素材的实际类型与引用不一致。",
                json!({}),
            ));
        }
        Ok(asset)
    }

    /// 火山方言素材导入：`CreateAsset`（URL 直传，异步预处理）+ `GetAsset` 轮询。
    ///
    /// Ark 不支持 multipart/JSON 字节直传，只接受公共可访问 URL；暂存对象 URL
    /// （TOS 预签名）满足该条件。分组为字符串 `GroupId`；未指定时发现/创建
    /// 「无限画布上传」AIGC 组。
    async fn ark_import_staged(
        &self,
        request: ImportStagedAsset,
    ) -> BackendResult<CloudAssetIdentity> {
        if !matches!(
            request.media_type,
            MediaType::Image | MediaType::Video | MediaType::Audio
        ) {
            return Err(BackendError::validation(
                "火山引擎素材库仅支持图片、视频与音频素材",
                json!({ "mediaType": media_type_name(request.media_type) }),
            ));
        }
        let group_id = match request.group_id.as_deref().map(str::trim) {
            Some(group_id) if !group_id.is_empty() => group_id.to_string(),
            _ => {
                self.ark_resolve_upload_group(&request.provider_connection_id)
                    .await?
            }
        };
        let display_name = request
            .display_name
            .as_deref()
            .map(|value| value.chars().take(64).collect::<String>());
        let mut body = Map::new();
        body.insert("GroupId".into(), json!(group_id));
        body.insert("URL".into(), json!(request.public_url));
        body.insert(
            "AssetType".into(),
            json!(media_type_name(request.media_type)),
        );
        if let Some(name) = display_name.as_deref() {
            body.insert("Name".into(), json!(name));
        }
        let port = Arc::clone(&self.port);
        let provider_connection_id = request.provider_connection_id.clone();
        // 提交为异步接口，瞬时网关故障（502/503/504）时素材尚未在上游创建，可安全重试。
        let response = send_submit_with_retry("ark submit asset import", || {
            let port = Arc::clone(&port);
            let provider_connection_id = provider_connection_id.clone();
            let body = Value::Object(body.clone());
            async move {
                port.send_ark(ArkAssetRequest {
                    provider_connection_id,
                    action: "CreateAsset",
                    body,
                })
                .await
            }
        })
        .await?;
        require_success("ark submit asset import", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let asset_id = payload
            .get("Id")
            .and_then(asset_id_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                BackendError::protocol(
                    "ark asset import did not return an asset id",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        self.ark_wait_for_import(&request.provider_connection_id, &asset_id)
            .await
    }

    /// 火山方言导入轮询：`GetAsset` 直到 Active/Failed（Failed 时携带 Error.Code/Message）。
    async fn ark_wait_for_import(
        &self,
        provider_connection_id: &str,
        asset_id: &str,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut consecutive_failures = 0;
        loop {
            if started.elapsed() >= self.poll_policy.timeout {
                return Err(BackendError::protocol(
                    "ark asset import did not become ready before the local wait deadline",
                    json!({ "assetId": asset_id, "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            let response = match self
                .port
                .send_ark(ArkAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    action: "GetAsset",
                    body: json!({ "Id": asset_id }),
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
            if let Err(error) = require_success("observe ark asset import", &response) {
                consecutive_failures += 1;
                if consecutive_failures >= self.poll_policy.failure_limit {
                    return Err(error);
                }
                self.wait_before_next_import_poll().await;
                continue;
            }
            let payload: Value = serde_json::from_str(&response.body)?;
            consecutive_failures = 0;
            let record = parse_ark_asset_entry(provider_connection_id, &payload);
            let Some(asset) = record else {
                return Err(BackendError::protocol(
                    "ark asset lookup did not return a readable record",
                    json!({ "assetId": asset_id, "rawResponse": response.body }),
                ));
            };
            match asset.status {
                CloudAssetStatus::Ready => {
                    return Ok(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id: asset_id.to_string(),
                    });
                }
                CloudAssetStatus::Failed | CloudAssetStatus::Deleted => {
                    // GetAsset 对失败素材仍返回 HTTP 200，失败原因在 Error.Code/Message。
                    let error_detail = payload
                        .pointer("/Error/Code")
                        .and_then(Value::as_str)
                        .map(|code| {
                            let message = payload
                                .pointer("/Error/Message")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            format!("{code}: {message}")
                        })
                        .unwrap_or_else(|| asset.raw_status.clone());
                    return Err(BackendError::protocol(
                        format!("火山引擎素材导入失败：{error_detail}"),
                        json!({ "assetId": asset_id, "rawResponse": response.body }),
                    ));
                }
                CloudAssetStatus::Processing | CloudAssetStatus::Unknown => {
                    self.wait_before_next_import_poll().await;
                }
            }
        }
    }

    /// 火山方言上传分组发现/创建：按名称精确匹配「无限画布上传」，缺失时创建。
    /// 与魔芋方言的 `resolve_upload_group` 语义一致，但 ID 为字符串形态。
    async fn ark_resolve_upload_group(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<String> {
        let gate = {
            let mut gates = self.upload_group_gates.lock().await;
            Arc::clone(
                gates
                    .entry(provider_connection_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = gate.lock().await;
        let groups = self.ark_list_asset_groups(provider_connection_id).await?;
        if let Some(group) = groups.iter().find(|group| group.name == UPLOAD_GROUP_NAME) {
            return Ok(group.id.clone());
        }
        let created = self
            .ark_create_asset_group(provider_connection_id, UPLOAD_GROUP_NAME)
            .await?;
        Ok(created.id)
    }

    // ===================== 火山引擎方舟（Ark）方言实现结束 =====================

    /// Import an already staged public object and wait until the remote 素材 becomes readable.
    /// Group discovery, single-flight creation, single-asset polling and terminal-state mapping stay local.
    /// 无进度回调版本：生产路径使用 [`import_staged_with_progress`]，本方法保留给测试与
    /// 无进度需求的调用方。
    #[allow(dead_code)]
    pub async fn import_staged(
        &self,
        request: ImportStagedAsset,
    ) -> BackendResult<CloudAssetIdentity> {
        self.import_staged_with_progress(request, None).await
    }

    /// 与 [`import_staged`] 相同，但接受字节进度回调 `(done, total)`。
    /// 海外路径（下载 + multipart 直传）在导入期间上报进度；国内路径
    /// （`/v1/assets/async` 平台侧拉取）无字节进度，不触发回调。
    pub async fn import_staged_with_progress(
        &self,
        request: ImportStagedAsset,
        progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
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
        // 火山引擎方舟素材库：CreateAsset（URL 直传）+ GetAsset 轮询，分组 ID 为字符串形态。
        if self.dialect(&request.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self.ark_import_staged(request).await;
        }
        // 海外平台（konjac.ai）素材上传必须走 `POST /v1/assets/upload` multipart 直传：
        // 其网关未实现 JSON 方式（`/v1/assets/async` 返回 404 Invalid URL），且 `/v1/assets/upload`
        // 需要文件字节而非远端 URL。此处从暂存 URL 下载字节后 multipart 直传，并按 `db_id`
        // 轮询素材列表直到 Active 取回真实素材 ID。
        if self
            .port
            .is_overseas_gateway(&request.provider_connection_id)?
        {
            return self.import_staged_overseas(request, progress).await;
        }
        let group_id = match request.group_id.as_deref().map(str::trim) {
            Some(group_id) if !group_id.is_empty() => group_id
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    BackendError::validation(
                        "real-person asset import requires a positive platform group id",
                        json!({ "groupId": group_id }),
                    )
                })?,
            _ => {
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
        if let Some(name) = display_name.as_deref() {
            body["name"] = name.into();
        }
        // 使用素材服务异步导入专用端点 `/v1/assets/async`：提交后**立即返回真实素材 ID**
        // （`asset-…`，初始状态 `Pending`），可直接作为 `/v1/assets/get` 的 `id` 轮询。
        // 这规避了旧端点返回数值占位 ID（`db_id`/`id`）无法查询的问题，也无需再按名称
        // 在素材列表里猜测真实素材（按名称匹配存在同名歧义，可能误认同名旧素材）。
        // 提交阶段对上游瞬时 5xx（如审核服务暂不可用）做指数退避重试；404 属网关未实现
        // 对应端点（不重试），在闭包内逐级回退到 SD2.0 风格端点。
        let port = Arc::clone(&self.port);
        let provider_connection_id = request.provider_connection_id.clone();
        let response = send_submit_with_retry("submit asset import", || {
            let port = Arc::clone(&port);
            let provider_connection_id = provider_connection_id.clone();
            let body = body.clone();
            async move {
                let first = port
                    .send(RemoteAssetRequest {
                        provider_connection_id: provider_connection_id.clone(),
                        method: Method::POST,
                        path: "/v1/assets/async",
                        body: Some(body.clone()),
                    })
                    .await?;
                // 兼容未实现 `/v1/assets/async` 的网关（如 SD2.0 等自建供应商）：
                // 返回 404 Invalid URL 时尝试 SD2.0 风格端点 `/v1/assets`（同样是 JSON 方式，参数相同）。
                if first.status == 404 {
                    port.send(RemoteAssetRequest {
                        provider_connection_id,
                        method: Method::POST,
                        path: "/v1/assets",
                        body: Some(body),
                    })
                    .await
                } else {
                    Ok(first)
                }
            }
        })
        .await?;
        // 若两个 JSON 端点都返回 404，回退到海外平台 multipart 直传路径（`/v1/assets/upload`），
        // 无需硬编码域名即可适配任意不支持 JSON 方式的供应商。
        if response.status == 404 {
            return self.import_staged_overseas(request, progress).await;
        }
        require_success("submit asset import", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let raw_id = payload
            .pointer("/data/id")
            .or_else(|| payload.get("id"))
            .ok_or_else(|| {
                BackendError::protocol(
                    "asset import did not return an asset id",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        let asset_id = asset_id_string(raw_id).ok_or_else(|| {
            BackendError::protocol(
                "asset import did not return an asset id",
                json!({ "rawResponse": response.body }),
            )
        })?;
        // `/v1/assets/async` 契约要求返回可查询的真实字符串 ID。若网关仍返回数值占位 ID，
        // 说明该网关未实现此端点，直接报错而非按名称匹配旧素材（避免误认 + 误删源对象）。
        if raw_id.is_number() {
            return Err(BackendError::protocol(
                "asset async endpoint returned a numeric placeholder id; the gateway does not implement /v1/assets/async",
                json!({ "rawResponse": response.body }),
            ));
        }
        self.wait_for_import(&request.provider_connection_id, raw_id, &asset_id)
            .await
    }

    /// 海外平台素材导入：从暂存 URL 下载字节后 multipart 直传 `POST /v1/assets/upload`，
    /// 再按 `db_id` 轮询 `/v1/assets/list` 直到 Active 取回真实素材 ID。
    /// 有进度回调时上报 `(done, total)`：总工作量 = 2 × 文件大小（下载 + 上传各算一遍），
    /// 下载阶段按流式字节推进（0 → 50%），multipart 直传完成后跳至 100%。
    async fn import_staged_overseas(
        &self,
        request: ImportStagedAsset,
        progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
    ) -> BackendResult<CloudAssetIdentity> {
        let group_id = match request.group_id.as_deref().map(str::trim) {
            Some(group_id) if !group_id.is_empty() => group_id
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    BackendError::validation(
                        "real-person asset import requires a positive platform group id",
                        json!({ "groupId": group_id }),
                    )
                })?,
            _ => {
                self.resolve_upload_group(&request.provider_connection_id)
                    .await?
            }
        };
        let display_name = request
            .display_name
            .as_deref()
            .map(|value| value.chars().take(64).collect::<String>());
        // 从暂存 URL 流式下载文件到临时文件（分块写盘，不整段驻留内存），再以
        // 流式 multipart 直传。有回调时按下载字节推进（total = Content-Length）。
        let temp_file = TempMediaFile::create();
        let total = self
            .port
            .download_to_file(
                request.public_url.clone(),
                temp_file.path.clone(),
                progress.as_ref().map(Arc::clone),
            )
            .await?;
        let total_work = total.saturating_mul(2);
        if let Some(on_progress) = progress.as_ref() {
            // 下载完成（50%），multipart 直传期间保持该值，直传成功后跳 100%。
            on_progress(total, total_work);
        }
        let file_name = display_name.clone().unwrap_or_else(|| "upload".to_string());
        // multipart 直传提交对上游瞬时 5xx（如审核服务暂不可用）做指数退避重试；
        // 404 属网关未实现该端点（不重试），直接报错。每次重试重建请求（重新流式读取文件）。
        let port = Arc::clone(&self.port);
        let response = send_submit_with_retry("submit asset upload", || {
            let port = Arc::clone(&port);
            let mut fields = vec![
                (
                    "kind".to_string(),
                    media_type_kind(request.media_type).to_string(),
                ),
                ("group_id".to_string(), group_id.to_string()),
            ];
            if let Some(name) = display_name.as_deref() {
                fields.push(("name".to_string(), name.to_string()));
            }
            port.send_multipart(MultipartAssetRequest {
                provider_connection_id: request.provider_connection_id.clone(),
                path: "/v1/assets/upload",
                fields,
                file_field: "file".to_string(),
                file_name: file_name.clone(),
                mime_type: media_type_mime(request.media_type).to_string(),
                file_path: temp_file.path.clone(),
                file_size: total,
            })
        })
        .await?;
        // 若 `/v1/assets/upload` 也返回 404，说明该供应商网关未实现任何已知素材上传端点
        // （国内 `/v1/assets/async`、SD2.0 风格 `/v1/assets`、海外 `/v1/assets/upload` 均返回 404），
        // 给出明确诊断。
        if response.status == 404 {
            return Err(BackendError::protocol(
                "该供应商网关未实现任何已知素材上传端点（/v1/assets/async、/v1/assets 和 /v1/assets/upload 均返回 404），请确认供应商是否支持素材上传功能或联系供应商获取正确的 API 路径",
                json!({
                    "triedEndpoints": ["/v1/assets/async", "/v1/assets", "/v1/assets/upload"],
                    "providerConnectionId": request.provider_connection_id,
                    "rawResponse": response.body,
                }),
            ));
        }
        require_success("submit asset upload", &response)?;
        if let Some(on_progress) = progress.as_ref() {
            on_progress(total_work, total_work);
        }
        let payload: Value = serde_json::from_str(&response.body)?;
        // `/v1/assets/upload` 返回数值占位 ID（`db_id`，如 975），用于后续按 db_id 精确匹配。
        let placeholder_db_id = payload
            .pointer("/data/db_id")
            .or_else(|| payload.pointer("/data/id"))
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                BackendError::protocol(
                    "asset upload did not return a placeholder db id",
                    json!({ "rawResponse": response.body }),
                )
            })?;
        self.wait_for_overseas_import(
            &request.provider_connection_id,
            placeholder_db_id,
            display_name.as_deref(),
        )
        .await
    }

    /// 海外平台素材导入轮询：`POST /v1/assets/list` 按 `db_id` 精确匹配，直到 Active 取回真实素材 ID。
    async fn wait_for_overseas_import(
        &self,
        provider_connection_id: &str,
        placeholder_db_id: u64,
        display_name: Option<&str>,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut consecutive_failures = 0;
        loop {
            if started.elapsed() >= self.poll_policy.timeout {
                return Err(BackendError::protocol(
                    "asset upload did not become ready before the local wait deadline",
                    json!({ "dbId": placeholder_db_id, "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            let mut body = Map::new();
            body.insert("page_number".to_string(), json!(1));
            body.insert("page_size".to_string(), json!(100));
            if let Some(name) = display_name {
                body.insert("name".to_string(), json!(name));
            }
            let response = match self
                .port
                .send(RemoteAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    method: Method::POST,
                    path: "/v1/assets/list",
                    body: Some(Value::Object(body)),
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
            if let Err(error) = require_success("observe asset upload", &response) {
                consecutive_failures += 1;
                if consecutive_failures >= self.poll_policy.failure_limit {
                    return Err(error);
                }
                self.wait_before_next_import_poll().await;
                continue;
            }
            let payload: Value = serde_json::from_str(&response.body)?;
            let candidates = payload
                .get("data")
                .map(asset_array)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| asset_array(&payload));
            let matched = candidates.into_iter().find(|entry| {
                entry
                    .get("db_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_u64)
                    == Some(placeholder_db_id)
            });
            consecutive_failures = 0;
            let Some(entry) = matched else {
                self.wait_before_next_import_poll().await;
                continue;
            };
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "asset upload lookup did not return a status",
                        json!({ "dbId": placeholder_db_id, "rawResponse": response.body }),
                    )
                })?;
            match status.trim().to_ascii_lowercase().as_str() {
                "active" | "ready" => {
                    let asset_id = entry.get("id").and_then(asset_id_string).ok_or_else(|| {
                        BackendError::protocol(
                            "asset upload became active but returned no asset id",
                            json!({ "dbId": placeholder_db_id, "rawResponse": response.body }),
                        )
                    })?;
                    return Ok(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id,
                    });
                }
                "failed" | "deleted" => {
                    return Err(BackendError::protocol(
                        format!("asset upload reached terminal status {status}"),
                        json!({
                            "dbId": placeholder_db_id,
                            "itemError": entry.get("error"),
                            "rawResponse": response.body
                        }),
                    ));
                }
                _ => self.wait_before_next_import_poll().await,
            }
        }
    }

    /// Refresh the authenticated asset record for a local preview, without a generation task.
    /// 返回重新读取的素材记录，供调用方取不同字段（视频正文地址、关键帧封面地址等）。
    async fn refresh_asset_record(
        &self,
        identity: CloudAssetIdentity,
        expected_media_type: MediaType,
    ) -> BackendResult<CloudAssetRecord> {
        // 火山方言走 Ark OpenAPI 的 GetAsset（Action 风格 + V4 签名）。
        if self.dialect(&identity.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_refresh_asset_record(identity, expected_media_type)
                .await;
        }
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: identity.provider_connection_id.clone(),
                method: Method::POST,
                path: "/v1/assets/get",
                body: Some(json!({ "id": identity.asset_id })),
            })
            .await
            .map_err(|error| match error {
                BackendError::Transport(error) => BackendError::Transport(error.without_url()),
                other => other,
            })?;
        // Preview failures must not expose signed media addresses or arbitrary upstream bodies.
        if !(200..300).contains(&response.status) {
            return Err(BackendError::protocol(
                format!(
                    "云素材读取失败（HTTP {}），请检查对应供应商的素材库连接。",
                    response.status
                ),
                json!({ "httpStatus": response.status }),
            ));
        }
        let payload: Value = serde_json::from_str(&response.body)?;
        let asset = parse_asset_entry(
            &identity.provider_connection_id,
            payload.get("data").unwrap_or(&payload),
            Some(&identity.asset_id),
        )
        .ok_or_else(|| BackendError::protocol("云素材没有返回可读取的记录。", json!({})))?;
        if asset.id != identity.asset_id {
            return Err(BackendError::validation(
                "云素材返回的身份与所选视频不一致，请重新选择素材。",
                json!({}),
            ));
        }
        if asset.status != CloudAssetStatus::Ready {
            return Err(BackendError::validation(
                "云素材尚未就绪或不可读取。",
                json!({}),
            ));
        }
        if asset.kind != expected_media_type {
            return Err(BackendError::validation(
                "云素材的实际类型与引用不一致。",
                json!({}),
            ));
        }
        Ok(asset)
    }

    /// Refresh the authenticated asset record for a local preview, without a generation task.
    pub async fn preview_content_url(
        &self,
        identity: CloudAssetIdentity,
        expected_media_type: MediaType,
    ) -> BackendResult<String> {
        let asset = self
            .refresh_asset_record(identity, expected_media_type)
            .await?;
        asset
            .preview_url
            .ok_or_else(|| BackendError::validation("云素材没有可下载的视频正文地址。", json!({})))
    }

    /// 按素材身份重新向供应商读取关键帧封面地址，自动续签已过期的签名封面。
    ///
    /// 对应上游契约 `POST /v1/assets/get`，body `{"id":"asset-…"}`，返回新封面 URL。
    /// 接受 `asset://` 前缀以便前端直接传引用；素材未就绪、类型不符或没有封面时返回校验错误。
    pub async fn refresh_asset_cover(
        &self,
        command: RefreshAssetCoverCommand,
    ) -> BackendResult<String> {
        require_provider_connection_id(&command.provider_connection_id)?;
        let id = command
            .id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| command.id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset cover refresh requires an asset id without the asset:// prefix",
                json!({ "id": command.id }),
            ));
        }
        let asset = self
            .refresh_asset_record(
                CloudAssetIdentity {
                    provider_connection_id: command.provider_connection_id,
                    asset_id: id.to_string(),
                },
                MediaType::Video,
            )
            .await?;
        asset
            .cover_url
            .ok_or_else(|| BackendError::validation("云素材没有可下载的封面地址。", json!({})))
    }

    /// 画布素材节点预览续签：重新读取云端素材记录，返回最新的签名预览地址。
    /// 图片节点用它加载预览，视频节点把它同时当作播放地址（与列表映射语义一致）。
    pub async fn refresh_asset_media(
        &self,
        command: RefreshAssetMediaCommand,
    ) -> BackendResult<String> {
        require_provider_connection_id(&command.provider_connection_id)?;
        let id = command
            .id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| command.id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset media refresh requires an asset id without the asset:// prefix",
                json!({ "id": command.id }),
            ));
        }
        let asset = self
            .refresh_asset_record(
                CloudAssetIdentity {
                    provider_connection_id: command.provider_connection_id,
                    asset_id: id.to_string(),
                },
                command.media_type,
            )
            .await?;
        asset
            .preview_url
            .ok_or_else(|| BackendError::validation("云素材没有可用的预览地址。", json!({})))
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
        raw_id: &Value,
        poll_id: &str,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut consecutive_failures = 0;
        loop {
            if started.elapsed() >= self.poll_policy.timeout {
                return Err(BackendError::protocol(
                    "asset import did not become ready before the local wait deadline",
                    json!({ "assetId": poll_id, "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            let response = match self
                .port
                .send(RemoteAssetRequest {
                    provider_connection_id: provider_connection_id.to_string(),
                    method: Method::POST,
                    path: "/v1/assets/get",
                    // 沿用创建响应返回的原始 ID 类型：数值 ID 发数值，字符串 ID 发字符串，
                    // 避免新网关对 `id` 字段做严格 JSON 类型匹配时查不到素材（HTTP 404）。
                    body: Some(json!({ "id": raw_id })),
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
            // 异步契约下轮询用的可能是任务/占位 ID，素材完成时真实素材 ID 会写回 `id` 字段
            // （可能与轮询 ID 不同），因此不要求二者相等；Active 时优先采用返回的真实 ID。
            let returned_asset_id = item.get("id").and_then(asset_id_string);
            consecutive_failures = 0;
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    BackendError::protocol(
                        "asset lookup did not return a status",
                        json!({ "assetId": poll_id, "rawResponse": response.body }),
                    )
                })?;
            match status.trim().to_ascii_lowercase().as_str() {
                "active" | "ready" => {
                    return Ok(CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id: returned_asset_id.unwrap_or_else(|| poll_id.to_string()),
                    });
                }
                "failed" | "deleted" => {
                    return Err(BackendError::protocol(
                        format!("asset import reached terminal status {status}"),
                        json!({
                            "assetId": poll_id,
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

/// 兼容字符串与数值形态的素材 ID。
///
/// 摸鱼素材服务的真实上游在创建/查询素材时以**数值**返回素材 `id`
/// （如 `{"code":"success","data":{"db_id":962,"id":962,"status":"Processing"}}`），
/// 而既有测试与部分文档契约使用字符串 ID（如 `"asset-1"`）。若只按字符串解析，
/// 数值 ID 会被误判为「没有返回素材 ID」并抛出协议错误
/// `asset import did not return an asset id`，因此两种形态都必须接受。
fn asset_id_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|id| id.to_string()))
}

/// 判断素材提交响应状态码是否属于可安全重试的瞬时网关故障。
///
/// 仅 502/503/504（网关无法连通上游服务，如审核服务暂不可用）可重试。
/// HTTP 500 不重试：该上游网关会用 500 承载**永久性业务拒绝**（如
/// `FaceMismatch` 上传素材与授权人脸不一致），重试无意义且徒增等待。
fn is_transient_submit_status(status: u16) -> bool {
    matches!(status, 502..=504)
}

/// 素材提交类请求的瞬时 5xx 指数退避重试。
///
/// 上游网关的审核服务偶发不可用时会返回 502/503/504 并提示"请稍后重试"，此时素材尚未
/// 在上游创建，可安全重发（见 [`is_transient_submit_status`]）。最多重试
/// `SUBMIT_MAX_RETRIES` 次，每次重试前等待 `SUBMIT_RETRY_BASE_DELAY_MS * 2^(attempt)`
/// 毫秒；`send` 每次重试都会重新调用（重建请求体）。其余 4xx/5xx 与传输错误不重试，
/// 直接返回。
async fn send_submit_with_retry<F, Fut>(
    operation: &str,
    send: F,
) -> BackendResult<RawProviderResponse>
where
    F: Fn() -> Fut,
    Fut: Future<Output = BackendResult<RawProviderResponse>>,
{
    let mut attempt: u32 = 0;
    loop {
        let response = send().await?;
        if !is_transient_submit_status(response.status) || attempt >= SUBMIT_MAX_RETRIES {
            return Ok(response);
        }
        let delay_ms = SUBMIT_RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
        warn!(
            "[assets] {operation} 收到上游 {} 响应（瞬时失败），{delay_ms}ms 后重试 ({}/{})",
            response.status,
            attempt + 1,
            SUBMIT_MAX_RETRIES
        );
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        attempt += 1;
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
            "rawResponse": response.body,
            "retryable": is_transient_submit_status(response.status),
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

fn require_asset_library_connection(value: &str) -> BackendResult<()> {
    if value.trim().is_empty() {
        return Err(BackendError::validation(
            "asset library operation requires a provider connection",
            json!({ "field": "providerConnectionId" }),
        ));
    }
    Ok(())
}

fn parse_asset_group(raw: &Value) -> Option<AssetGroupRecord> {
    let record = raw.as_object()?;
    // 魔芋数值 ID 与火山字符串 ID（asset-group-…）统一按字符串承载；
    // 魔芋负数临时 ID 兜底场景由创建路径另行处理。
    let id = record
        .get("id")
        .and_then(asset_id_string)
        .filter(|id| !id.is_empty() && !id.starts_with('-'))?;
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let group_name = record
        .get("group_name")
        .or_else(|| record.get("groupName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    Some(AssetGroupRecord {
        id,
        name: name.to_string(),
        group_name: group_name.to_string(),
        is_default: record
            .get("is_default")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        asset_count: record
            .get("asset_count")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    })
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
        MediaType::Text => "文本素材",
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
        // 魔节数值分组 ID（兼容数值与字符串两种 JSON 形态）与火山字符串分组 ID 统一为字符串。
        group_id: record
            .get("group_id")
            .or_else(|| record.get("GroupId"))
            .and_then(asset_id_string),
    })
}

fn string_field<'a>(record: &'a Map<String, Value>, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| record.get(*field).and_then(Value::as_str))
}

/// 解析火山引擎方舟（PascalCase）素材记录为规范 [`CloudAssetRecord`]。
///
/// Ark 契约：`Id`/`Name`/`AssetType`（Image|Video|Audio）/`Status`（Active|
/// Processing|Failed）/`URL`（12 小时有效的公共地址）/`GroupId`。失败原因在
/// `Error.Code`/`Error.Message`，由调用方按需读取；视频素材无独立关键帧封面，
/// 前端卡片回退到本地抽帧。
fn parse_ark_asset_entry(provider_connection_id: &str, raw: &Value) -> Option<CloudAssetRecord> {
    let record = raw.as_object()?;
    let id = record
        .get("Id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let raw_name = record
        .get("Name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let preview_url = record
        .get("URL")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(ToOwned::to_owned);
    // AssetType 为 PascalCase（Image/Video/Audio），parse_media_type 内部做小写归一。
    let kind = record
        .get("AssetType")
        .and_then(Value::as_str)
        .and_then(parse_media_type)
        .or_else(|| infer_media_type_from_name(raw_name))
        .or_else(|| preview_url.as_deref().and_then(infer_media_type_from_name))
        .unwrap_or(MediaType::Image);
    let raw_status = record
        .get("Status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let status = normalize_asset_status(&raw_status);
    let group_id = record
        .get("GroupId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let fallback_name = match kind {
        MediaType::Image => "图片素材",
        MediaType::Video => "视频素材",
        MediaType::Audio => "音频素材",
        MediaType::Text => "文本素材",
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
        asset_url: None,
        cover_url: None,
        group_id,
    })
}

/// 解析火山引擎方舟（PascalCase）素材组记录为规范 [`AssetGroupRecord`]。
fn parse_ark_asset_group(raw: &Value) -> Option<AssetGroupRecord> {
    let record = raw.as_object()?;
    let id = record
        .get("Id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let name = record
        .get("Name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(AssetGroupRecord {
        id: id.to_string(),
        name: name.to_string(),
        group_name: name.to_string(),
        is_default: false,
        asset_count: 0,
    })
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
        MediaType::Text => "Text",
    }
}

/// 海外平台素材上传的 `kind` 字段取值（小写，如 `image` / `video` / `audio`）。
fn media_type_kind(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "image",
        MediaType::Video => "video",
        MediaType::Audio => "audio",
        MediaType::Text => "text",
    }
}

/// 海外平台 multipart 上传使用的 MIME 类型。
fn media_type_mime(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "image/jpeg",
        MediaType::Video => "video/mp4",
        MediaType::Audio => "audio/mpeg",
        MediaType::Text => "text/plain",
    }
}

/// 判定素材库网关是否为海外平台。海外平台（如 konjac.ai）素材上传必须走
/// `POST /v1/assets/upload` multipart 直传，国内平台走 JSON `POST /v1/assets/async`。
fn is_overseas_asset_base_url(base_url: &str) -> bool {
    Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "konjac.ai" || host.ends_with(".konjac.ai"))
}

fn media_type_wildcard(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "image/*",
        MediaType::Video => "video/*",
        MediaType::Audio => "audio/*",
        MediaType::Text => "text/*",
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
            MediaType::Text => "txt".to_string(),
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
        MediaType::Text => mime.starts_with("text/"),
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
        multipart_requests: StdMutex<Vec<(MultipartAssetRequest, Vec<u8>)>>,
        ark_requests: StdMutex<Vec<ArkAssetRequest>>,
        downloads: StdMutex<StdHashMap<String, Vec<u8>>>,
        /// 是否为海外平台网关（默认 false，即国内 JSON 契约）。
        overseas: StdMutex<bool>,
        /// 是否为火山引擎方舟方言（默认 false，即魔芋方言）。
        ark: StdMutex<bool>,
    }

    impl InMemoryAssetAdapter {
        fn with_responses(responses: impl IntoIterator<Item = RawProviderResponse>) -> Self {
            Self {
                responses: StdMutex::new(responses.into_iter().collect()),
                ..Self::default()
            }
        }

        fn with_overseas(self, overseas: bool) -> Self {
            *self.overseas.lock().expect("overseas lock") = overseas;
            self
        }

        fn with_ark(self, ark: bool) -> Self {
            *self.ark.lock().expect("ark lock") = ark;
            self
        }

        fn ark_request_actions(&self) -> Vec<&'static str> {
            self.ark_requests
                .lock()
                .expect("ark request lock")
                .iter()
                .map(|request| request.action)
                .collect()
        }

        fn request_paths(&self) -> Vec<&'static str> {
            self.requests
                .lock()
                .expect("request lock")
                .iter()
                .map(|request| request.path)
                .collect()
        }

        fn multipart_request_paths(&self) -> Vec<&'static str> {
            self.multipart_requests
                .lock()
                .expect("multipart lock")
                .iter()
                .map(|(request, _)| request.path)
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

        fn send_multipart(
            &self,
            request: MultipartAssetRequest,
        ) -> PortFuture<RawProviderResponse> {
            // 发送时读取文件内容并随请求一起记录，供测试在临时文件被守卫删除后断言。
            let file_body = std::fs::read(&request.file_path).unwrap_or_default();
            self.multipart_requests
                .lock()
                .expect("multipart lock")
                .push((request, file_body));
            let response = self.take_response();
            Box::pin(async move { response })
        }

        fn send_ark(&self, request: ArkAssetRequest) -> PortFuture<RawProviderResponse> {
            self.ark_requests
                .lock()
                .expect("ark request lock")
                .push(request);
            let response = self.take_response();
            Box::pin(async move { response })
        }

        fn dialect(&self, _provider_connection_id: &str) -> BackendResult<AssetDialect> {
            Ok(if *self.ark.lock().expect("ark lock") {
                AssetDialect::VolcengineArk
            } else {
                AssetDialect::Moyu
            })
        }

        fn is_overseas_gateway(&self, _provider_connection_id: &str) -> BackendResult<bool> {
            Ok(*self.overseas.lock().expect("overseas lock"))
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

        fn download_to_file(
            &self,
            url: String,
            destination: PathBuf,
            on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
        ) -> PortFuture<u64> {
            let result = self
                .downloads
                .lock()
                .expect("download lock")
                .get(&url)
                .cloned()
                .ok_or_else(|| BackendError::NotFound(format!("missing download: {url}")));
            Box::pin(async move {
                let bytes = result?;
                std::fs::write(&destination, &bytes)?;
                if let Some(on_progress) = on_progress.as_ref() {
                    on_progress(bytes.len() as u64, bytes.len() as u64);
                }
                Ok(bytes.len() as u64)
            })
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

    #[tokio::test]
    async fn video_preview_refreshes_provider_scoped_content_url_not_cover_or_asset_uri() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "data": { "id": "video-1", "name": "clip.mp4", "status": "ready", "type": "video",
                    "url": "https://cdn.example/clip.mp4?signature=fresh",
                    "cover_url": "https://cdn.example/cover.jpg", "asset_url": "asset://video-1" }
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let url = library
            .preview_content_url(
                CloudAssetIdentity {
                    provider_connection_id: "provider-original".into(),
                    asset_id: "video-1".into(),
                },
                MediaType::Video,
            )
            .await
            .unwrap();
        assert_eq!(url, "https://cdn.example/clip.mp4?signature=fresh");
        let requests = adapter.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].provider_connection_id, "provider-original");
        assert_eq!(requests[0].path, "/v1/assets/get");
        assert_eq!(requests[0].body, Some(json!({ "id": "video-1" })));
    }

    #[tokio::test]
    async fn video_preview_rejects_unready_wrong_type_and_cover_only_records_without_disclosing_urls()
     {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "data": { "id": "video-1", "status": "processing", "type": "video", "url": "https://cdn.example/clip?token=secret" } }),
            ),
            response(
                200,
                json!({ "data": { "id": "video-1", "status": "ready", "type": "image", "url": "https://cdn.example/image?token=secret" } }),
            ),
            response(
                200,
                json!({ "data": { "id": "video-1", "status": "ready", "type": "video", "cover_url": "https://cdn.example/cover?token=secret", "asset_url": "asset://video-1" } }),
            ),
            response(
                403,
                json!({ "message": "https://cdn.example/private?token=secret" }),
            ),
            response(
                200,
                json!({ "data": { "id": "different-video", "status": "ready", "type": "video", "url": "https://cdn.example/wrong?token=secret" } }),
            ),
        ]));
        let library = test_library(adapter, immediate_poll());
        for _ in 0..5 {
            let error = library
                .preview_content_url(
                    CloudAssetIdentity {
                        provider_connection_id: "provider".into(),
                        asset_id: "video-1".into(),
                    },
                    MediaType::Video,
                )
                .await
                .unwrap_err();
            assert!(
                !serde_json::to_string(&error.payload())
                    .unwrap()
                    .contains("secret")
            );
        }
    }

    #[tokio::test]
    async fn video_cover_refresh_returns_fresh_cover_url_and_strips_asset_uri() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "data": { "id": "video-1", "name": "clip.mp4", "status": "ready", "type": "video",
                    "url": "https://cdn.example/clip.mp4?signature=fresh",
                    "cover_url": "https://cdn.example/cover.jpg?signature=fresh",
                    "asset_url": "asset://video-1" }
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let cover = library
            .refresh_asset_cover(RefreshAssetCoverCommand {
                provider_connection_id: "provider-original".into(),
                id: "asset://video-1".into(),
            })
            .await
            .unwrap();
        assert_eq!(cover, "https://cdn.example/cover.jpg?signature=fresh");
        let requests = adapter.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].provider_connection_id, "provider-original");
        assert_eq!(requests[0].path, "/v1/assets/get");
        assert_eq!(requests[0].body, Some(json!({ "id": "video-1" })));
    }

    #[tokio::test]
    async fn video_cover_refresh_rejects_coverless_wrong_type_and_blank_ids() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "data": { "id": "video-1", "status": "ready", "type": "video", "url": "https://cdn.example/clip?token=secret" } }),
            ),
            response(
                200,
                json!({ "data": { "id": "video-1", "status": "ready", "type": "image", "cover_url": "https://cdn.example/cover?token=secret" } }),
            ),
        ]));
        let library = test_library(adapter, immediate_poll());
        let coverless = library
            .refresh_asset_cover(RefreshAssetCoverCommand {
                provider_connection_id: "provider".into(),
                id: "video-1".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(coverless, BackendError::Validation { .. }));
        let wrong_type = library
            .refresh_asset_cover(RefreshAssetCoverCommand {
                provider_connection_id: "provider".into(),
                id: "video-1".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(wrong_type, BackendError::Validation { .. }));
        let blank = library
            .refresh_asset_cover(RefreshAssetCoverCommand {
                provider_connection_id: "provider".into(),
                id: "   ".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(blank, BackendError::Validation { .. }));
    }

    #[tokio::test]
    async fn asset_media_refresh_returns_fresh_preview_url_and_validates_type() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({
                    "data": { "id": "image-1", "name": "pic.jpg", "status": "ready", "type": "image",
                        "url": "https://cdn.example/pic.jpg?signature=fresh" }
                }),
            ),
            response(
                200,
                json!({
                    "data": { "id": "image-1", "name": "pic.jpg", "status": "ready", "type": "video",
                        "url": "https://cdn.example/clip.mp4?signature=secret" }
                }),
            ),
            response(
                200,
                json!({ "data": { "id": "image-1", "status": "ready", "type": "image" } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());
        let fresh = library
            .refresh_asset_media(RefreshAssetMediaCommand {
                provider_connection_id: "provider-original".into(),
                id: "asset://image-1".into(),
                media_type: MediaType::Image,
            })
            .await
            .unwrap();
        assert_eq!(fresh, "https://cdn.example/pic.jpg?signature=fresh");
        {
            let requests = adapter.requests.lock().unwrap();
            assert_eq!(requests[0].path, "/v1/assets/get");
            assert_eq!(requests[0].body, Some(json!({ "id": "image-1" })));
        }
        // 上游类型与期望不符时报错，不把错误素材的地址喂给节点。
        let wrong_type = library
            .refresh_asset_media(RefreshAssetMediaCommand {
                provider_connection_id: "provider".into(),
                id: "image-1".into(),
                media_type: MediaType::Image,
            })
            .await
            .unwrap_err();
        assert!(matches!(wrong_type, BackendError::Validation { .. }));
        // 无预览地址时返回校验错误（前端保持置灰，不回写）。
        let previewless = library
            .refresh_asset_media(RefreshAssetMediaCommand {
                provider_connection_id: "provider".into(),
                id: "image-1".into(),
                media_type: MediaType::Image,
            })
            .await
            .unwrap_err();
        assert!(matches!(previewless, BackendError::Validation { .. }));
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
                kind: None,
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

    /// 火山引擎方舟方言：浏览走 `ListAssets` 动作（`send_ark` 端口），
    /// 并按 PascalCase（Id/Name/AssetType/URL）解析条目。
    #[tokio::test]
    async fn ark_dialect_browse_uses_ark_actions_and_parses_pascal_case_entries() {
        let adapter = Arc::new(
            InMemoryAssetAdapter::with_responses([response(
                200,
                json!({
                    "Items": [
                        {
                            "Id": "asset-ark-1",
                            "Name": "封面.png",
                            "AssetType": "Image",
                            "Status": "Active",
                            "URL": "https://cdn.ark.example/cover.png"
                        },
                        {
                            "Id": "asset-ark-2",
                            "Name": "clip.mp4",
                            "AssetType": "Video",
                            "Status": "Processing"
                        }
                    ]
                }),
            )])
            .with_ark(true),
        );
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let assets = library
            .browse(AssetListCommand {
                provider_connection_id: "provider-ark".into(),
                page_number: None,
                page_size: Some(100),
                name: None,
                group_id: None,
                kind: None,
            })
            .await
            .expect("ark browse");

        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].id, "asset-ark-1");
        assert_eq!(assets[0].name, "封面.png");
        assert_eq!(assets[0].kind, MediaType::Image);
        assert_eq!(assets[0].status, CloudAssetStatus::Ready);
        assert_eq!(
            assets[0].preview_url.as_deref(),
            Some("https://cdn.ark.example/cover.png")
        );
        assert_eq!(assets[1].id, "asset-ark-2");
        assert_eq!(assets[1].kind, MediaType::Video);
        assert_eq!(assets[1].status, CloudAssetStatus::Processing);
        assert_eq!(adapter.ark_request_actions(), ["ListAssets"]);
    }

    /// 构造上游素材列表条目：`asset_type` 为 Video 的视频素材。
    fn video_entries(prefix: &str, range: std::ops::Range<usize>) -> Vec<Value> {
        range
            .map(|index| {
                json!({
                    "id": format!("{prefix}-{index}"),
                    "name": format!("{prefix}-{index}.mp4"),
                    "asset_type": "Video",
                    "status": "Active"
                })
            })
            .collect()
    }

    #[tokio::test]
    async fn browse_kind_filter_stops_scanning_once_page_is_full() {
        // 上游第 1 页：2 个视频命中 + 98 个图片干扰项；请求第 1 页 2 条应只扫描 1 次。
        let mut entries = video_entries("vid", 0..2);
        entries.extend(image_filler_entries(0..98));
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "data": { "items": entries } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let assets = library
            .browse(AssetListCommand {
                provider_connection_id: "provider-1".into(),
                page_number: Some(1),
                page_size: Some(2),
                name: None,
                group_id: None,
                kind: Some(MediaType::Video),
            })
            .await
            .expect("browse");

        assert_eq!(
            assets
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["vid-0", "vid-1"]
        );
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].body.as_ref().unwrap()["page_number"], 1);
        assert_eq!(requests[0].body.as_ref().unwrap()["page_size"], 100);
    }

    #[tokio::test]
    async fn browse_kind_filter_scans_upstream_pages_until_page_is_satisfied() {
        // 上游第 1 页满 100 条（3 视频 + 97 图片，命中不足第 2 页所需 4 条），继续扫描；
        // 第 2 页 3 视频 + 1 图片后结束：请求第 2 页 2 条应跳过前 2 个命中，返回 vid-2/vid-3。
        let mut entries = video_entries("vid", 0..3);
        entries.extend(image_filler_entries(0..97));
        let mut tail = video_entries("vid", 3..6);
        tail.push(json!({
            "id": "img-1",
            "name": "img-1.png",
            "asset_type": "Image",
            "status": "Active"
        }));
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(200, json!({ "data": { "items": entries } })),
            response(200, json!({ "data": { "items": tail } })),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let assets = library
            .browse(AssetListCommand {
                provider_connection_id: "provider-1".into(),
                page_number: Some(2),
                page_size: Some(2),
                name: None,
                group_id: None,
                kind: Some(MediaType::Video),
            })
            .await
            .expect("browse");

        assert_eq!(
            assets
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["vid-2", "vid-3"]
        );
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].body.as_ref().unwrap()["page_number"], 1);
        assert_eq!(requests[1].body.as_ref().unwrap()["page_number"], 2);
    }

    /// 与 [`video_entries`] 同形但 `asset_type` 为 Image 的干扰条目。
    fn image_filler_entries(range: std::ops::Range<usize>) -> Vec<Value> {
        range
            .map(|index| {
                json!({
                    "id": format!("img-filler-{index}"),
                    "name": format!("img-filler-{index}.png"),
                    "asset_type": "Image",
                    "status": "Active"
                })
            })
            .collect()
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
    async fn delete_asset_follows_the_documented_delete_contract() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "code": "success", "data": { "id": "asset-1" } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset(DeleteAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-1".into(),
            })
            .await
            .expect("delete asset");

        assert_eq!(deleted_id, "asset-1");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/delete");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(requests[0].body, Some(json!({ "id": "asset-1" })));
    }

    #[tokio::test]
    async fn delete_asset_strips_the_asset_scheme_prefix_before_calling_upstream() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "code": "success", "data": { "id": "asset-2" } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset(DeleteAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset://asset-2".into(),
            })
            .await
            .expect("delete asset with scheme prefix");

        assert_eq!(deleted_id, "asset-2");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests[0].path, "/v1/assets/delete");
        assert_eq!(requests[0].body, Some(json!({ "id": "asset-2" })));
    }

    #[tokio::test]
    async fn delete_asset_treats_a_gone_asset_404_as_idempotent_success() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            404,
            json!({ "error": { "message": "素材不存在或已删除" } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset(DeleteAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-ghost".into(),
            })
            .await
            .expect("a 404 gone-asset delete should be idempotent success");

        assert_eq!(deleted_id, "asset-ghost");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/delete");
        assert_eq!(requests[0].body, Some(json!({ "id": "asset-ghost" })));
    }

    #[tokio::test]
    async fn delete_asset_accepts_a_success_response_without_an_echoed_asset_id() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "code": "success", "success": true }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset(DeleteAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-962".into(),
            })
            .await
            .expect("delete asset without echoed id");

        assert_eq!(deleted_id, "asset-962");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/delete");
        assert_eq!(requests[0].body, Some(json!({ "id": "asset-962" })));
    }

    #[tokio::test]
    async fn delete_asset_rejects_an_empty_or_whitespace_id() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([]));
        let library = test_library(adapter, immediate_poll());

        let error = library
            .delete_asset(DeleteAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "  ".into(),
            })
            .await
            .expect_err("empty id must be rejected before any request");

        assert!(error.to_string().contains("asset id"));
    }

    #[tokio::test]
    async fn delete_asset_group_posts_the_group_id_to_the_documented_endpoint() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "code": "success" }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset_group(DeleteAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                id: "8".into(),
            })
            .await
            .expect("delete asset group via moyu dialect");

        assert_eq!(deleted_id, "8");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/groups/delete");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(requests[0].body, Some(json!({ "id": "8" })));
    }

    #[tokio::test]
    async fn delete_asset_group_treats_a_gone_group_404_as_idempotent_success() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            404,
            json!({ "error": { "message": "素材库分组不存在或已删除" } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let deleted_id = library
            .delete_asset_group(DeleteAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                id: "99".into(),
            })
            .await
            .expect("a 404 gone-group delete should be idempotent success");

        assert_eq!(deleted_id, "99");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/groups/delete");
        assert_eq!(requests[0].body, Some(json!({ "id": "99" })));
    }

    #[tokio::test]
    async fn delete_asset_group_rejects_an_empty_or_whitespace_id() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([]));
        let library = test_library(adapter, immediate_poll());

        let error = library
            .delete_asset_group(DeleteAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                id: "  ".into(),
            })
            .await
            .expect_err("empty group id must be rejected before any request");

        assert!(error.to_string().contains("group id"));
    }

    #[tokio::test]
    async fn list_asset_groups_returns_display_names_without_the_token_prefix() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "code": "success",
                "data": [
                    {
                        "id": 7,
                        "name": "广告图",
                        "group_name": "user-u1-token-t9-广告图",
                        "is_default": false,
                        "asset_count": 4
                    },
                    {
                        "id": 12,
                        "name": "无限画布上传",
                        "group_name": "user-u1-token-t9-无限画布上传",
                        "is_default": true,
                        "asset_count": 1
                    }
                ]
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let groups = library
            .list_asset_groups(ListAssetGroupsCommand {
                provider_connection_id: "provider-1".into(),
            })
            .await
            .expect("list asset groups");

        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].id, "7");
        assert_eq!(groups[0].name, "广告图");
        assert_eq!(groups[0].group_name, "user-u1-token-t9-广告图");
        assert!(!groups[0].is_default);
        assert_eq!(groups[0].asset_count, 4);
        assert_eq!(groups[1].name, "无限画布上传");
        assert!(groups[1].is_default);

        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/groups");
        assert_eq!(requests[0].method, Method::GET);
        assert_eq!(requests[0].body, None);
    }

    #[tokio::test]
    async fn create_asset_group_posts_the_user_defined_name_and_returns_the_record() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "code": "success",
                "data": {
                    "id": 21,
                    "name": "客户物料",
                    "group_name": "user-u1-token-t9-客户物料",
                    "is_default": false,
                    "asset_count": 0
                }
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let group = library
            .create_asset_group(CreateAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                name: " 客户物料 ".into(),
            })
            .await
            .expect("create asset group");

        assert_eq!(group.id, "21");
        assert_eq!(group.name, "客户物料");
        assert_eq!(group.group_name, "user-u1-token-t9-客户物料");

        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/groups");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(requests[0].body, Some(json!({ "name": "客户物料" })));
    }

    #[tokio::test]
    async fn create_asset_group_falls_back_to_temp_record_when_upstream_returns_only_group_name() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({
                "code": "success",
                "data": {
                    "group_name": "user-23-token-32456-1"
                }
            }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let group = library
            .create_asset_group(CreateAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                name: "客户物料".into(),
            })
            .await
            .expect("create asset group with partial response");

        // 临时 id 为负数（真实 id 均为正数），name 用请求名，group_name 用上游返回值。
        assert!(group.id.starts_with('-'));
        assert_eq!(group.name, "客户物料");
        assert_eq!(group.group_name, "user-23-token-32456-1");
        assert!(!group.is_default);
        assert_eq!(group.asset_count, 0);

        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/groups");
        assert_eq!(requests[0].method, Method::POST);
    }

    #[tokio::test]
    async fn create_asset_group_rejects_empty_or_oversized_names() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([]));
        let library = test_library(adapter, immediate_poll());

        let empty_error = library
            .create_asset_group(CreateAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                name: "   ".into(),
            })
            .await
            .expect_err("empty group name must be rejected before any request");
        assert!(
            empty_error
                .to_string()
                .contains("group name must not be empty")
        );

        let oversized_error = library
            .create_asset_group(CreateAssetGroupCommand {
                provider_connection_id: "provider-1".into(),
                name: "很".repeat(65),
            })
            .await
            .expect_err("oversized group name must be rejected before any request");
        assert!(oversized_error.to_string().contains("64 characters"));
    }

    #[tokio::test]
    async fn rename_asset_posts_id_and_name_to_the_update_endpoint() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([response(
            200,
            json!({ "code": "success", "data": { "id": "asset-1", "name": "新名称" } }),
        )]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let renamed_id = library
            .rename_asset(RenameAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset://asset-1".into(),
                name: " 新名称 ".into(),
            })
            .await
            .expect("rename asset");

        assert_eq!(renamed_id, "asset-1");
        let requests = adapter.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/assets/update");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(
            requests[0].body,
            Some(json!({ "id": "asset-1", "name": "新名称" }))
        );
    }

    #[tokio::test]
    async fn rename_asset_rejects_empty_ids_or_names() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([]));
        let library = test_library(adapter, immediate_poll());

        let empty_id_error = library
            .rename_asset(RenameAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "  ".into(),
                name: "新名称".into(),
            })
            .await
            .expect_err("empty asset id must be rejected before any request");
        assert!(empty_id_error.to_string().contains("asset id"));

        let empty_name_error = library
            .rename_asset(RenameAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-1".into(),
                name: "  ".into(),
            })
            .await
            .expect_err("empty asset name must be rejected before any request");
        assert!(
            empty_name_error
                .to_string()
                .contains("asset name must not be empty")
        );

        let oversized_name_error = library
            .rename_asset(RenameAssetCommand {
                provider_connection_id: "provider-1".into(),
                id: "asset-1".into(),
                name: "长".repeat(65),
            })
            .await
            .expect_err("oversized asset name must be rejected before any request");
        assert!(oversized_name_error.to_string().contains("64 characters"));
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
                group_id: Some("128".into()),
            })
            .await
            .expect("import real-person asset");

        assert_eq!(identity.asset_id, "asset-real-1");
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets/async", "/v1/assets/get"]
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
                group_id: Some("128".into()),
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
                "/v1/assets/async",
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

    /// 回归测试：若网关未实现 `/v1/assets/async` 而仍返回数值占位 `id`
    /// （`{"code":"success","data":{"db_id":962,"id":962,"status":"Processing"}}`），
    /// 必须**直接报错**，不得退回按名称轮询 `/v1/assets/list` —— 名称匹配存在同名歧义，
    /// 会误认同名旧素材、并在新素材就绪前删除其 TOS 源对象，导致新素材永久卡在 Processing。
    #[tokio::test]
    async fn import_staged_rejects_numeric_placeholder_ids_from_the_async_endpoint() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "data": [{ "id": 12, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(
                200,
                json!({
                    "code": "success",
                    "data": { "db_id": 962, "id": 962, "status": "Processing" },
                    "success": true
                }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let error = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/a.png".into(),
                media_type: MediaType::Image,
                display_name: Some("参考图".into()),
                group_id: None,
            })
            .await
            .expect_err("numeric placeholder id from the async endpoint must fail loudly");

        assert!(error.to_string().contains("/v1/assets/async"));
        // 不再发起任何 /v1/assets/list 匹配请求。
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets/groups", "/v1/assets/async"]
        );
    }

    /// 回归测试：异步契约下，轮询用的可能是任务/占位 ID，素材完成时真实素材 ID 会写回
    /// `id` 字段（与轮询 ID 不同）。此前 `wait_for_import` 要求「返回 ID == 轮询 ID」，
    /// 会误报 `asset lookup returned a different asset id`；现在应接受返回的真实 ID
    /// 作为最终素材身份，而不是报错。
    #[tokio::test]
    async fn import_staged_adopts_the_real_asset_id_returned_on_active() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            response(
                200,
                json!({ "data": [{ "id": 12, "name": UPLOAD_GROUP_NAME }] }),
            ),
            response(
                200,
                json!({
                    "code": "success",
                    "data": { "id": "task-20260902000000-abcde", "status": "Processing" },
                    "success": true
                }),
            ),
            response(
                200,
                json!({
                    "code": "success",
                    "data": { "id": "task-20260902000000-abcde", "status": "Processing" },
                    "success": true
                }),
            ),
            response(
                200,
                json!({
                    "code": "success",
                    "data": {
                        "id": "asset-20260902000001-xyz",
                        "asset_type": "Image",
                        "status": "Active"
                    },
                    "success": true
                }),
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
            .expect("import adopts the real asset id on active");

        // 最终身份采用 Active 响应里返回的真实素材 ID，而不是轮询用的任务 ID。
        assert_eq!(identity.asset_id, "asset-20260902000001-xyz");
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
                "/v1/assets/async",
                "/v1/assets/get",
                "/v1/assets/groups",
                "/v1/assets/async",
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
                kind: None,
            })
            .await
            .expect_err("HTTP 401 should fail");

        assert!(error.to_string().contains("HTTP 401"));
    }

    #[tokio::test]
    async fn import_staged_overseas_uploads_via_multipart_and_polls_the_list_by_db_id() {
        let adapter = Arc::new(
            InMemoryAssetAdapter::with_responses([
                // 1) find_upload_group: 列出分组
                response(
                    200,
                    json!({ "data": [{ "id": 16, "name": UPLOAD_GROUP_NAME }] }),
                ),
                // 2) multipart 直传 /v1/assets/upload 返回数值占位 db_id
                response(
                    200,
                    json!({ "code": "success", "data": { "db_id": 975, "id": 975, "status": "Processing" }, "success": true }),
                ),
                // 3) 第一次轮询 list：仍 Processing
                response(
                    200,
                    json!({ "data": { "items": [
                        { "id": "task-975", "db_id": 975, "asset_type": "image", "status": "Processing" }
                    ] } }),
                ),
                // 4) 第二次轮询 list：Active，取回真实 asset id
                response(
                    200,
                    json!({ "data": { "items": [
                        { "id": "asset-20260902-7hbb2", "db_id": 975, "asset_type": "image", "status": "Active" }
                    ] } }),
                ),
            ])
            .with_overseas(true),
        );
        adapter
            .downloads
            .lock()
            .expect("download lock")
            .insert("https://tos.example.com/a.png".into(), vec![1, 2, 3, 4]);
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
            .expect("overseas import");

        assert_eq!(identity.asset_id, "asset-20260902-7hbb2");
        // JSON 通道：分组发现 + 轮询 /v1/assets/list（两次），不走 /v1/assets/async。
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets/groups", "/v1/assets/list", "/v1/assets/list"]
        );
        // multipart 通道只走一次 /v1/assets/upload。
        assert_eq!(adapter.multipart_request_paths(), vec!["/v1/assets/upload"]);
        let uploads = adapter.multipart_requests.lock().expect("multipart lock");
        assert_eq!(uploads[0].0.path, "/v1/assets/upload");
        assert_eq!(uploads[0].0.file_field, "file");
        assert_eq!(uploads[0].0.file_name, "参考图");
        assert_eq!(uploads[0].0.mime_type, "image/jpeg");
        assert_eq!(uploads[0].0.file_size, 4);
        assert_eq!(uploads[0].1, vec![1, 2, 3, 4]);
        assert!(
            uploads[0]
                .0
                .fields
                .contains(&("kind".to_string(), "image".to_string()))
        );
        assert!(
            uploads[0]
                .0
                .fields
                .contains(&("group_id".to_string(), "16".to_string()))
        );
        assert!(
            uploads[0]
                .0
                .fields
                .contains(&("name".to_string(), "参考图".to_string()))
        );
    }

    /// 回归测试：海外 multipart 提交返回瞬时 5xx（如素材审核服务暂时不可用的 HTTP 502）
    /// 时应指数退避重试，而不是直接判失败——上游错误信息本身即提示"请稍后重试"。
    #[tokio::test(start_paused = true)]
    async fn import_staged_overseas_retries_transient_5xx_submit_responses() {
        let adapter = Arc::new(
            InMemoryAssetAdapter::with_responses([
                // 1) find_upload_group: 列出分组
                response(
                    200,
                    json!({ "data": [{ "id": 16, "name": UPLOAD_GROUP_NAME }] }),
                ),
                // 2) 前两次 multipart 直传返回 502（上游审核服务暂不可用）
                response(
                    502,
                    json!({ "error": { "message": "素材审核服务暂时不可用，请稍后重试" } }),
                ),
                response(
                    502,
                    json!({ "error": { "message": "素材审核服务暂时不可用，请稍后重试" } }),
                ),
                // 3) 第三次提交成功，返回数值占位 db_id
                response(
                    200,
                    json!({ "code": "success", "data": { "db_id": 975, "id": 975, "status": "Processing" }, "success": true }),
                ),
                // 4) 轮询 list：Active，取回真实 asset id
                response(
                    200,
                    json!({ "data": { "items": [
                        { "id": "asset-20260909-retry", "db_id": 975, "asset_type": "image", "status": "Active" }
                    ] } }),
                ),
            ])
            .with_overseas(true),
        );
        adapter
            .downloads
            .lock()
            .expect("download lock")
            .insert("https://tos.example.com/a.png".into(), vec![1, 2, 3, 4]);
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
            .expect("overseas import after transient 5xx retries");

        assert_eq!(identity.asset_id, "asset-20260909-retry");
        // multipart 通道共尝试 3 次 /v1/assets/upload（两次 502 + 一次成功）。
        assert_eq!(
            adapter.multipart_request_paths(),
            vec![
                "/v1/assets/upload",
                "/v1/assets/upload",
                "/v1/assets/upload"
            ]
        );
    }

    /// 回归测试：国内 JSON 提交 `/v1/assets/async` 返回瞬时 5xx 时应指数退避重试。
    #[tokio::test(start_paused = true)]
    async fn import_staged_retries_transient_5xx_async_submit_responses() {
        let adapter = Arc::new(InMemoryAssetAdapter::with_responses([
            // 第 1 次 async 提交返回 502（上游审核服务暂不可用）
            response(
                502,
                json!({ "error": { "message": "素材审核服务暂时不可用，请稍后重试" } }),
            ),
            // 第 2 次提交成功，返回真实素材 ID
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-retry-1", "asset_url": "asset://asset-retry-1" } }),
            ),
            // 轮询 get：Active
            response(
                200,
                json!({ "code": "success", "data": { "id": "asset-retry-1", "asset_type": "Image", "status": "Active" } }),
            ),
        ]));
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let identity = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/a.png".into(),
                media_type: MediaType::Image,
                display_name: Some("参考图".into()),
                group_id: Some("12".into()),
            })
            .await
            .expect("import after transient 5xx retry");

        assert_eq!(identity.asset_id, "asset-retry-1");
        // `/v1/assets/async` 共尝试 2 次（一次 502 + 一次成功），随后轮询一次 get。
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets/async", "/v1/assets/async", "/v1/assets/get"]
        );
    }

    #[tokio::test]
    async fn import_staged_overseas_matches_by_db_id_even_when_processing_has_no_real_id() {
        let adapter = Arc::new(
            InMemoryAssetAdapter::with_responses([
                response(200, json!({ "data": [{ "id": 16, "name": UPLOAD_GROUP_NAME }] })),
                response(
                    200,
                    json!({ "code": "success", "data": { "db_id": 976, "id": 976, "status": "Processing" }, "success": true }),
                ),
                // 第一条 db_id=975 是旧素材（同名歧义），必须按 db_id 精确匹配到 976。
                response(
                    200,
                    json!({ "data": { "items": [
                        { "id": "asset-old-975", "db_id": 975, "asset_type": "image", "status": "Active" },
                        { "id": "task-976", "db_id": 976, "asset_type": "image", "status": "Processing" }
                    ] } }),
                ),
                response(
                    200,
                    json!({ "data": { "items": [
                        { "id": "asset-old-975", "db_id": 975, "asset_type": "image", "status": "Active" },
                        { "id": "asset-976-new", "db_id": 976, "asset_type": "image", "status": "Active" }
                    ] } }),
                ),
            ])
            .with_overseas(true),
        );
        adapter
            .downloads
            .lock()
            .expect("download lock")
            .insert("https://tos.example.com/b.png".into(), vec![9, 9, 9]);
        let library = test_library(Arc::clone(&adapter), immediate_poll());

        let identity = library
            .import_staged(ImportStagedAsset {
                provider_connection_id: "provider-1".into(),
                public_url: "https://tos.example.com/b.png".into(),
                media_type: MediaType::Image,
                display_name: Some("同名素材".into()),
                group_id: None,
            })
            .await
            .expect("overseas import picks the record with matching db_id");

        assert_eq!(identity.asset_id, "asset-976-new");
        // JSON 通道：分组发现 + 轮询 list（两次）；multipart 通道：仅一次 upload。
        assert_eq!(
            adapter.request_paths(),
            vec!["/v1/assets/groups", "/v1/assets/list", "/v1/assets/list"]
        );
        assert_eq!(adapter.multipart_request_paths(), vec!["/v1/assets/upload"]);
    }
}
