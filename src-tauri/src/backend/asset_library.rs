use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{StreamExt as _, future::join_all};
use reqwest::Method;
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use tauri_plugin_log::log::warn;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;
use url::Url;

use super::{
    error::{BackendError, BackendResult},
    media_proxy,
    provider::ProviderRuntime,
    provider_adapter::ARK_ADAPTER_ID,
    storage::TaskExecutionRecord,
    types::{
        AssetGroupRecord, AssetKindCountCommand, AssetListCommand, AssetStatusObservation,
        CloudAssetIdentity, CloudAssetKindTotals, CloudAssetRecord, CloudAssetStatus,
        CreateAssetGroupCommand, CreateRealPersonAuthLinkCommand, DeleteAssetCommand,
        DeleteAssetGroupCommand, DeleteRealPersonAssetCommand, DeleteRealPersonGroupCommand,
        ListAssetGroupsCommand, MediaType, ObserveAssetStatusCommand, RawProviderResponse,
        RealPersonAuthLink, RealPersonGroup, RealPersonProviderCommand, RefreshAssetCoverCommand,
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
const OVERSEAS_IMPORT_POLL_TIMEOUT: Duration = Duration::from_secs(1200);
const OVERSEAS_PLACEHOLDER_POLL_INTERVAL_CAP: Duration = Duration::from_secs(30);
/// 类型过滤扫描的上游页数上限（每页 100 条）。到达上限仍未集齐目标页时按已有结果返回，
/// 避免类型分布极端或翻深页时无界地请求上游；类型计数扫描复用同一上限。
const KIND_SCAN_PAGE_CAP: u64 = 50;
/// 单页最多续签多少条过期预览地址。
///
/// 续签是「一条素材一次上游往返」，整页 100 条地址全过期时逐条串行会把浏览卡住。
/// 这里给出单页上限，超出的部分留给下一次浏览，或由媒体代理回落到本机副本兜底。
const PREVIEW_RENEWAL_MAX_PER_PAGE: usize = 12;
/// 预览地址续签的并发度：比串行快，又不至于把上游连接一次占满。
const PREVIEW_RENEWAL_CONCURRENCY: usize = 4;
/// 海外列表兜底按 `db_id` 扫描的页数上限（每页 100 条）。超出范围时保持待确认，
/// 不按名称猜测素材身份，也不重复上传。
const OVERSEAS_LIST_SCAN_PAGE_CAP: u64 = 20;

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
    /// 指定 `kind` 时按国际版契约把小写 `image`/`video`/`audio` 写入 `/v1/assets/list`；
    /// 若上游忽略该参数（旧网关仍返回混杂类型），再逐页扫描（每页 100 条）并本地过滤，
    /// 跳过 `(page_number-1)*page_size` 条命中后收集一页；扫描在命中数集齐、
    /// 上游翻完或到达 [`KIND_SCAN_PAGE_CAP`] 时提前结束。
    pub async fn browse(&self, query: AssetListCommand) -> BackendResult<Vec<CloudAssetRecord>> {
        let mut page = if self.dialect(&query.provider_connection_id)? == AssetDialect::VolcengineArk {
            self.ark_browse(query).await?
        } else {
            let page_number = query.page_number.unwrap_or(1).max(1);
            let page_size = query.page_size.unwrap_or(100).clamp(1, 100);
            match query.kind {
                None => {
                    self.browse_upstream_page(&query, u64::from(page_number), u64::from(page_size))
                        .await?
                }
                Some(kind) => {
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
                    matched
                        .into_iter()
                        .skip(usize::try_from(skip).unwrap_or(usize::MAX))
                        .take(usize::try_from(want).unwrap_or(usize::MAX))
                        .collect()
                }
            }
        };
        // 上游列表常回放过期的预签名地址（供应商的列表接口不重新签名）：在返回这一页
        // 之前把过期地址续签掉，让卡片当场能预览，而不是只记一条告警等用户点开才失败。
        self.renew_expired_preview_urls(&mut page).await;
        Ok(page)
    }

    /// 给这一页里已过期的预览地址续签。
    ///
    /// 上游的列表接口不重新签名，页面拿到的往往还是上一轮签发、如今已过期的地址：
    /// 过期地址在媒体代理里要么 403、要么退回到本机副本，用户看到的仍是「预览不可用」。
    /// 这里按素材身份重新向供应商读取一次记录（`/v1/assets/get`，火山方言走 Ark
    /// `GetAsset`），拿到新签名后写回这一页；`refresh_asset_record` 内部还会把新地址
    /// 登记到媒体代理的预览登记表并预热缓存，因此画布节点也立刻用上新签名。
    ///
    /// 幂等且不会递归：每条素材在一次调用里最多续签一次（没有重试循环），续签走的是
    /// 「按 id 读一条记录」，不会再回头调用列表接口；已经有效的地址不会被重复续签。
    async fn renew_expired_preview_urls(&self, assets: &mut [CloudAssetRecord]) {
        let now = SystemTime::now();
        let expired = count_expired_preview_urls(assets, now);
        if expired == 0 {
            return;
        }
        let mut targets: Vec<(usize, CloudAssetIdentity, MediaType)> = Vec::new();
        for (index, asset) in assets.iter().enumerate() {
            let Some(preview_url) = asset.preview_url.as_deref() else {
                continue;
            };
            let Ok(url) = Url::parse(preview_url) else {
                continue;
            };
            if !media_proxy::signed_url_expired(&url, now) {
                continue;
            }
            targets.push((
                index,
                CloudAssetIdentity {
                    provider_connection_id: asset.provider_connection_id.clone(),
                    asset_id: asset.id.clone(),
                },
                asset.kind,
            ));
            if targets.len() >= PREVIEW_RENEWAL_MAX_PER_PAGE {
                break;
            }
        }
        if targets.is_empty() {
            return;
        }
        warn!(
            "[assets] 本页 {} / {} 条云素材预览地址已过期，正在续签",
            targets.len(),
            expired
        );
        let mut renewed: Vec<(usize, Option<String>, Option<String>)> = Vec::new();
        let mut failed = 0_usize;
        for chunk in targets.chunks(PREVIEW_RENEWAL_CONCURRENCY) {
            let futures = chunk.iter().map(|(index, identity, kind)| async move {
                let result = self.refresh_asset_record(identity.clone(), *kind).await;
                (*index, result)
            });
            for (index, result) in join_all(futures).await {
                match result {
                    Ok(record) => renewed.push((index, record.preview_url, record.cover_url)),
                    Err(_) => failed += 1,
                }
            }
        }
        for (index, preview_url, cover_url) in renewed {
            if let Some(preview_url) = preview_url {
                assets[index].preview_url = Some(preview_url);
            }
            if let Some(cover_url) = cover_url {
                assets[index].cover_url = Some(cover_url);
            }
        }
        if failed > 0 {
            warn!(
                "[assets] {} 条云素材预览地址续签失败，保留原地址（媒体代理会回落到本机副本）",
                failed
            );
        }
    }

    /// 按类型统计云端素材数量（图片/视频/音频），驱动素材面板类型 Tab 角标。
    ///
    /// 上游 `/v1/assets/list` 与火山引擎 `ListAssets` 都不返回类型计数，唯一口径是
    /// 翻完扫描范围内的全部页后本地累加；调用方只在素材面板打开时调用一次，
    /// 之后按上传/删除增量维护，不随每次翻页或切换类型重复扫描。
    ///
    /// 扫描范围只由连接与分组决定（不叠加类型/名称过滤），否则角标会随当前 Tab 变化。
    /// 同名/重复记录按素材 ID 去重；到达 [`KIND_SCAN_PAGE_CAP`] 页上限时返回已累计结果。
    pub async fn count_assets_by_kind(
        &self,
        command: AssetKindCountCommand,
    ) -> BackendResult<CloudAssetKindTotals> {
        let query = AssetListCommand {
            provider_connection_id: command.provider_connection_id,
            page_number: None,
            page_size: None,
            name: None,
            group_id: command.group_id,
            kind: None,
        };
        let ark = self.dialect(&query.provider_connection_id)? == AssetDialect::VolcengineArk;
        let mut totals = CloudAssetKindTotals::default();
        let mut seen: HashSet<String> = HashSet::new();
        for upstream_page in 1..=KIND_SCAN_PAGE_CAP {
            let records = if ark {
                self.ark_browse_page(&query, upstream_page, 100).await?
            } else {
                self.browse_upstream_page(&query, upstream_page, 100)
                    .await?
            };
            let exhausted = records.len() < 100;
            for record in records {
                if !seen.insert(record.id.clone()) {
                    continue;
                }
                match record.kind {
                    MediaType::Image => totals.image += 1,
                    MediaType::Video => totals.video += 1,
                    MediaType::Audio => totals.audio += 1,
                    // 文本等非媒体素材不占类型 Tab 的角标。
                    MediaType::Text => {}
                }
            }
            if exhausted {
                break;
            }
        }
        Ok(totals)
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
        if let Some(kind) = query.kind {
            body.insert("kind".into(), json!(media_type_kind(kind)));
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
        let assets = parse_asset_page(&provider_connection_id, &payload);
        remember_cloud_asset_previews(&assets);
        if !assets.is_empty() && assets.iter().all(|asset| asset.preview_url.is_none()) {
            warn!(
                "[assets] 本页 {} 条云素材都没有可预览的 http(s) 地址",
                assets.len()
            );
        }
        Ok(assets)
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
        warn!(
            "[assets] 即将按用户确认删除云端素材: providerConnectionId={}, assetId={}",
            provider_connection_id, id
        );
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
        let parsed: Vec<AssetGroupRecord> = groups
            .into_iter()
            .filter_map(|entry| {
                let parsed = parse_asset_group(entry);
                if parsed.is_none() {
                    warn!("[assets] 跳过无法解析的素材分组记录，未向云端发起删除");
                }
                parsed
            })
            .collect();
        Ok(parsed)
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
        // 仅用于本地立刻选中；真实 id 均为正数。禁止使用 -1/-2：上游约定
        // `id = -2` 会删除该令牌下全部历史分组。时钟异常时用 i64::MIN，仍会被删除路径拒绝。
        let temp_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| -(d.as_millis() as i64))
            .filter(|id| *id < -2)
            .unwrap_or(i64::MIN);
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
                    "supported": [ARK_ADAPTER_ID],
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
    ///
    /// 客户端**不会**自动删库：此接口只在用户两段式确认后由前端调用。上游魔芋约定
    /// `id = -2` 会删除该令牌下全部历史分组，因此任何非正数 ID（含临时负数、`-2`）
    /// 在发往上游之前一律拒绝。
    pub async fn delete_asset_group(
        &self,
        command: DeleteAssetGroupCommand,
    ) -> BackendResult<String> {
        require_asset_library_connection(&command.provider_connection_id)?;
        let id = require_deletable_asset_group_id(&command.id)?;
        warn!(
            "[assets] 即将按用户确认删除云端素材分组: providerConnectionId={}, groupId={}",
            command.provider_connection_id, id
        );
        if self.dialect(&command.provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .ark_delete_asset_group(&command.provider_connection_id, id)
                .await;
        }
        // 魔芋方言：`POST /v1/assets/groups/delete`，请求体为 `{"id": <group id>}`。
        // 上游 `DeleteAssetGroupRequest.id` 为 int 类型（`id > 0` 删除指定分组，
        // `id = -2` 删除所有历史分组），必须传数字而非字符串。
        let group_id: i64 = id.parse().map_err(|_| {
            BackendError::validation(
                "asset group id must be an integer",
                json!({ "field": "id", "value": id }),
            )
        })?;
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: command.provider_connection_id,
                method: Method::POST,
                path: "/v1/assets/groups/delete",
                body: Some(json!({ "id": group_id })),
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
        let assets = items
            .iter()
            .filter_map(|entry| parse_ark_asset_entry(&provider_connection_id, entry))
            .collect::<Vec<_>>();
        remember_cloud_asset_previews(&assets);
        Ok(assets)
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
        remember_cloud_asset_preview(&asset);
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
        self.import_staged_with_progress_and_submission(request, progress, None)
            .await
    }

    /// 海外直传得到 `db_id` 后立即通知调用方持久化查询键。回调失败时不得继续轮询，
    /// 否则本地重启后无法恢复这次已经提交的上传。
    pub async fn import_staged_with_progress_and_submission(
        &self,
        request: ImportStagedAsset,
        progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
        on_submitted: Option<Arc<dyn Fn(u64) -> BackendResult<()> + Send + Sync>>,
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
        // 轮询状态（首选 `/v1/assets/statuses`，未实现时兜底 `/v1/assets/list`）直到 Active。
        if self
            .port
            .is_overseas_gateway(&request.provider_connection_id)?
        {
            return self
                .import_staged_overseas(request, progress, on_submitted)
                .await;
        }
        let group_id = match request.group_id.as_deref().map(str::trim) {
            Some(group_id) if !group_id.is_empty() => group_id
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    BackendError::validation(
                        "该供应商的素材分组 ID 必须是正整数，当前分组不受支持",
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
            return self
                .import_staged_overseas(request, progress, on_submitted)
                .await;
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
    /// 再按 `db_id` 轮询状态直到 Active 取回真实素材 ID。
    /// 有进度回调时上报 `(done, total)`：总工作量 = 2 × 文件大小（下载 + 上传各算一遍），
    /// 下载阶段按流式字节推进（0 → 50%），multipart 直传完成后跳至 100%。
    async fn import_staged_overseas(
        &self,
        request: ImportStagedAsset,
        progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
        on_submitted: Option<Arc<dyn Fn(u64) -> BackendResult<()> + Send + Sync>>,
    ) -> BackendResult<CloudAssetIdentity> {
        let group_id = match request.group_id.as_deref().map(str::trim) {
            Some(group_id) if !group_id.is_empty() => group_id
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    BackendError::validation(
                        "该供应商的素材分组 ID 必须是正整数，当前分组不受支持",
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
        if let Some(on_submitted) = on_submitted {
            on_submitted(placeholder_db_id).map_err(|error| {
                BackendError::protocol(
                    "asset upload was submitted to the cloud, but the local query key could not be saved; do not reupload automatically",
                    json!({ "dbId": placeholder_db_id, "localError": error.to_string() }),
                )
            })?;
        }
        self.wait_for_overseas_import(
            &request.provider_connection_id,
            placeholder_db_id,
            display_name.as_deref(),
        )
        .await
    }

    /// 继续查询一条已提交的海外上传。调用方应使用上传时保存的供应商连接与 `db_id`，
    /// 不能重新提交文件或按名称认领另一条素材。
    pub async fn resume_overseas_import_by_db_id(
        &self,
        provider_connection_id: &str,
        db_id: u64,
        display_name: Option<&str>,
    ) -> BackendResult<CloudAssetIdentity> {
        let provider_connection_id = require_provider_connection_id(provider_connection_id)?;
        if db_id == 0 {
            return Err(BackendError::validation(
                "overseas asset resume requires a positive db id",
                json!({ "dbId": db_id, "providerConnectionId": provider_connection_id }),
            ));
        }
        self.wait_for_overseas_import(provider_connection_id, db_id, display_name)
            .await
    }

    /// 海外平台素材导入轮询：首选 `POST /v1/assets/statuses` 按 `db_ids` 查状态；
    /// 网关未实现该端点（404/405/501）或本次请求失败时，兜底 `POST /v1/assets/list`
    /// 按 `db_id` 精确匹配，直到 Active 取回真实素材 ID。
    async fn wait_for_overseas_import(
        &self,
        provider_connection_id: &str,
        placeholder_db_id: u64,
        display_name: Option<&str>,
    ) -> BackendResult<CloudAssetIdentity> {
        let started = tokio::time::Instant::now();
        let mut statuses_available = true;
        let mut fallback_confirmation: Option<String> = None;
        let mut placeholder_poll_interval = self.poll_policy.interval;
        loop {
            let timeout = if self.poll_policy.timeout == IMPORT_POLL_TIMEOUT {
                OVERSEAS_IMPORT_POLL_TIMEOUT
            } else {
                self.poll_policy.timeout
            };
            if started.elapsed() >= timeout {
                return Err(BackendError::protocol(
                    "asset upload did not become ready before the local wait deadline",
                    json!({ "dbId": placeholder_db_id, "terminalStatus": "TimedOut", "waitedMs": started.elapsed().as_millis() }),
                ));
            }
            let mut response = match self
                .fetch_overseas_upload_poll(
                    provider_connection_id,
                    placeholder_db_id,
                    display_name,
                    statuses_available,
                )
                .await
            {
                Ok(OverseasPollFetch::StatusesUnimplemented(list_response)) => {
                    statuses_available = false;
                    list_response
                }
                Ok(OverseasPollFetch::Observed(response)) => response,
                Err(_) => {
                    self.wait_before_next_import_poll().await;
                    continue;
                }
            };
            if require_success("observe asset upload", &response).is_err() {
                self.wait_before_next_import_poll().await;
                continue;
            }
            let Ok(mut payload) = serde_json::from_str::<Value>(&response.body) else {
                self.wait_before_next_import_poll().await;
                continue;
            };
            if find_overseas_upload_entry(&payload, placeholder_db_id).is_none() {
                if let Ok(list_response) = self
                    .fetch_overseas_list_match(
                        provider_connection_id,
                        placeholder_db_id,
                        display_name,
                    )
                    .await
                {
                    if (200..300).contains(&list_response.status) {
                        if let Ok(list_payload) = serde_json::from_str::<Value>(&list_response.body)
                        {
                            response = list_response;
                            payload = list_payload;
                        }
                    }
                }
            }
            let Some(entry) = find_overseas_upload_entry(&payload, placeholder_db_id) else {
                self.wait_before_next_import_poll().await;
                continue;
            };
            let Some(status) = entry
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                self.wait_before_next_import_poll().await;
                continue;
            };
            match status.trim().to_ascii_lowercase().as_str() {
                "active" | "ready" => {
                    let asset_id = entry
                        .as_object()
                        .and_then(|record| overseas_ready_asset_id(record, placeholder_db_id));
                    let asset_id = if asset_id.is_some() {
                        asset_id
                    } else {
                        // 部分网关会先把 db 行标成 Active，仍只回 task 占位符。
                        // 对照 list 和按任务号 get；两条读路径都没有真实 ID 时继续按 db_id 轮询。
                        self.resolve_overseas_task_placeholder(
                            provider_connection_id,
                            placeholder_db_id,
                            display_name,
                            entry,
                        )
                        .await?
                    };
                    if let Some(asset_id) = asset_id {
                        let confirmed_by_second_read =
                            fallback_confirmation.as_deref() == Some(asset_id.as_str());
                        let confirmation = if confirmed_by_second_read {
                            OverseasReadyConfirmation::Verified
                        } else {
                            self.confirm_overseas_ready_asset(
                                provider_connection_id,
                                placeholder_db_id,
                                &asset_id,
                            )
                            .await
                        };
                        if confirmation == OverseasReadyConfirmation::Verified {
                            return Ok(CloudAssetIdentity {
                                provider_connection_id: provider_connection_id.to_string(),
                                asset_id,
                            });
                        }
                        fallback_confirmation = (confirmation
                            == OverseasReadyConfirmation::Unavailable)
                            .then_some(asset_id);
                    } else {
                        fallback_confirmation = None;
                    }
                    if !placeholder_poll_interval.is_zero() {
                        tokio::time::sleep(placeholder_poll_interval).await;
                        placeholder_poll_interval = placeholder_poll_interval
                            .saturating_mul(2)
                            .min(OVERSEAS_PLACEHOLDER_POLL_INTERVAL_CAP);
                    }
                }
                "failed" | "deleted" => {
                    let reason = asset_failure_reason(entry);
                    return Err(BackendError::protocol(
                        format!("asset upload reached terminal status {status}"),
                        json!({
                            "dbId": placeholder_db_id,
                            "terminalStatus": status,
                            "itemError": reason,
                            "rawResponse": response.body
                        }),
                    ));
                }
                _ => self.wait_before_next_import_poll().await,
            }
        }
    }

    /// 机会性读已有查询接口；任何 404、网关错误或尚未回填的占位符都不能证明素材失败。
    /// `list` 必须按 `db_id` 匹配；`get` 只在原记录有 task ID 时按该 ID 查询。
    async fn resolve_overseas_task_placeholder(
        &self,
        provider_connection_id: &str,
        db_id: u64,
        display_name: Option<&str>,
        entry: &Value,
    ) -> BackendResult<Option<String>> {
        if let Ok(response) = self
            .fetch_overseas_list_match(provider_connection_id, db_id, display_name)
            .await
        {
            if (200..300).contains(&response.status) {
                if let Ok(payload) = serde_json::from_str::<Value>(&response.body) {
                    if let Some(list_entry) = find_overseas_upload_entry(&payload, db_id) {
                        if let Some(status) = overseas_terminal_status(list_entry) {
                            return Err(BackendError::protocol(
                                format!("asset upload reached terminal status {status}"),
                                json!({ "dbId": db_id, "terminalStatus": status, "itemError": asset_failure_reason(list_entry) }),
                            ));
                        }
                        if let Some(asset_id) = list_entry
                            .as_object()
                            .and_then(|record| overseas_ready_asset_id(record, db_id))
                            .filter(|_| overseas_entry_is_ready(list_entry))
                        {
                            return Ok(Some(asset_id));
                        }
                    }
                }
            }
        }
        let Some(task_id) = entry
            .as_object()
            .and_then(|record| review_task_id(record, None))
        else {
            return Ok(None);
        };
        let Ok(response) = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/get",
                body: Some(json!({ "id": task_id })),
            })
            .await
        else {
            return Ok(None);
        };
        if !(200..300).contains(&response.status) {
            return Ok(None);
        }
        let Ok(payload) = serde_json::from_str::<Value>(&response.body) else {
            return Ok(None);
        };
        let get_entry = payload.get("data").unwrap_or(&payload);
        if get_entry
            .get("db_id")
            .and_then(Value::as_u64)
            .is_some_and(|returned_db_id| returned_db_id != db_id)
        {
            return Ok(None);
        }
        if !overseas_entry_is_ready(get_entry) {
            return Ok(None);
        }
        let asset_id = get_entry
            .as_object()
            .and_then(|record| overseas_ready_asset_id(record, db_id));
        Ok(asset_id)
    }

    /// 单条查询是首选确认；海外网关若未实现 get，则下一次独立的 db_id 状态/列表查询
    /// 返回同一就绪身份时仍可确认。这里仅返回 get 的确认结果，调用方负责后者。
    async fn confirm_overseas_ready_asset(
        &self,
        provider_connection_id: &str,
        db_id: u64,
        asset_id: &str,
    ) -> OverseasReadyConfirmation {
        let Ok(response) = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/get",
                body: Some(json!({ "id": asset_id })),
            })
            .await
        else {
            return OverseasReadyConfirmation::Invalid;
        };
        if matches!(response.status, 404 | 405 | 501) {
            return OverseasReadyConfirmation::Unavailable;
        }
        if !(200..300).contains(&response.status) {
            return OverseasReadyConfirmation::Invalid;
        }
        let Ok(payload) = serde_json::from_str::<Value>(&response.body) else {
            return OverseasReadyConfirmation::Invalid;
        };
        let entry = payload.get("data").unwrap_or(&payload);
        let Some(record) = entry.as_object() else {
            return OverseasReadyConfirmation::Invalid;
        };
        let get_id = canonical_asset_id(record, None);
        let get_url_id = ["asset_url", "assetUrl"].into_iter().find_map(|key| {
            record
                .get(key)
                .and_then(Value::as_str)
                .and_then(asset_scheme_identity)
        });
        if !overseas_entry_is_ready(entry)
            || entry
                .get("db_id")
                .and_then(Value::as_u64)
                .is_some_and(|returned| returned != db_id)
            || get_id.as_deref() != Some(asset_id)
            || get_url_id
                .as_deref()
                .is_some_and(|url_id| url_id != asset_id)
        {
            return OverseasReadyConfirmation::Invalid;
        }
        if let Some(asset) = parse_asset_entry(provider_connection_id, entry, Some(asset_id)) {
            remember_cloud_asset_preview(&asset);
        }
        OverseasReadyConfirmation::Verified
    }

    /// 先打 statuses；未实现则关掉该通道并立刻改打 list；其余失败本轮再试一次 list。
    async fn fetch_overseas_upload_poll(
        &self,
        provider_connection_id: &str,
        placeholder_db_id: u64,
        display_name: Option<&str>,
        statuses_available: bool,
    ) -> BackendResult<OverseasPollFetch> {
        if statuses_available {
            match self
                .port
                .send(overseas_statuses_poll_request(
                    provider_connection_id,
                    placeholder_db_id,
                ))
                .await
            {
                Ok(response) if overseas_statuses_unimplemented(response.status) => {
                    warn!(
                        "[assets] 海外平台未实现 /v1/assets/statuses（HTTP {}），改用 /v1/assets/list 轮询",
                        response.status
                    );
                    let list = self
                        .fetch_overseas_list_match(
                            provider_connection_id,
                            placeholder_db_id,
                            display_name,
                        )
                        .await?;
                    return Ok(OverseasPollFetch::StatusesUnimplemented(list));
                }
                Ok(response) if should_fallback_overseas_statuses(response.status) => {
                    match self
                        .fetch_overseas_list_match(
                            provider_connection_id,
                            placeholder_db_id,
                            display_name,
                        )
                        .await
                    {
                        Ok(list) if (200..300).contains(&list.status) => {
                            return Ok(OverseasPollFetch::Observed(list));
                        }
                        _ => return Ok(OverseasPollFetch::Observed(response)),
                    }
                }
                Ok(response) => return Ok(OverseasPollFetch::Observed(response)),
                Err(error) => {
                    match self
                        .fetch_overseas_list_match(
                            provider_connection_id,
                            placeholder_db_id,
                            display_name,
                        )
                        .await
                    {
                        Ok(list) => return Ok(OverseasPollFetch::Observed(list)),
                        Err(_) => return Err(error),
                    }
                }
            }
        }
        self.fetch_overseas_list_match(provider_connection_id, placeholder_db_id, display_name)
            .await
            .map(OverseasPollFetch::Observed)
    }

    async fn fetch_overseas_list_match(
        &self,
        provider_connection_id: &str,
        db_id: u64,
        display_name: Option<&str>,
    ) -> BackendResult<RawProviderResponse> {
        for page in 1..=OVERSEAS_LIST_SCAN_PAGE_CAP {
            let response = self
                .port
                .send(overseas_list_poll_request_page(
                    provider_connection_id,
                    display_name,
                    page,
                ))
                .await?;
            if !(200..300).contains(&response.status) {
                return Ok(response);
            }
            let Ok(payload) = serde_json::from_str::<Value>(&response.body) else {
                return Ok(response);
            };
            if find_overseas_upload_entry(&payload, db_id).is_some() {
                return Ok(response);
            }
            let entries = payload
                .get("data")
                .map(asset_array)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| asset_array(&payload));
            if entries.len() < 100 || page == OVERSEAS_LIST_SCAN_PAGE_CAP {
                return Ok(response);
            }
        }
        unreachable!("overseas list scan always returns a response")
    }

    /// 复核一条已出现在素材库里的云端素材。
    ///
    /// 列表里的 `processing` 只说明当时还在处理。这里再读一次权威记录：
    /// 仍在处理就原样返回；状态或错误字段表明失败、或上游 404/410 表示没有这条素材，
    /// 调用方再删除并通知。传输失败和 5xx 返回错误，调用方不得据此删除。
    pub async fn observe_asset_status(
        &self,
        command: ObserveAssetStatusCommand,
    ) -> BackendResult<AssetStatusObservation> {
        let provider_connection_id =
            require_provider_connection_id(&command.provider_connection_id)?;
        let id = command
            .id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or_else(|| command.id.trim())
            .trim();
        if id.is_empty() {
            return Err(BackendError::validation(
                "asset status lookup requires an asset id",
                json!({ "id": command.id }),
            ));
        }
        if self.dialect(provider_connection_id)? == AssetDialect::VolcengineArk {
            return self
                .observe_ark_asset_status(provider_connection_id, id)
                .await;
        }
        self.observe_moyu_asset_status(provider_connection_id, id)
            .await
    }

    async fn observe_moyu_asset_status(
        &self,
        provider_connection_id: &str,
        id: &str,
    ) -> BackendResult<AssetStatusObservation> {
        let response = self
            .port
            .send(RemoteAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                method: Method::POST,
                path: "/v1/assets/get",
                body: Some(json!({ "id": asset_lookup_id(id) })),
            })
            .await
            .map_err(|error| match error {
                BackendError::Transport(error) => BackendError::Transport(error.without_url()),
                other => other,
            })?;
        if matches!(response.status, 404 | 410) {
            return Ok(missing_asset_observation(&response.body));
        }
        require_success("observe asset status", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let data = payload.get("data").unwrap_or(&payload);
        let asset = parse_asset_entry(provider_connection_id, data, Some(id))
            .ok_or_else(|| BackendError::protocol("云素材没有返回可读取的记录。", json!({})))?;
        let reason = asset_failure_reason(data).or_else(|| asset_failure_reason(&payload));
        Ok(observation_from_parts(asset, reason, false))
    }

    async fn observe_ark_asset_status(
        &self,
        provider_connection_id: &str,
        id: &str,
    ) -> BackendResult<AssetStatusObservation> {
        let response = self
            .port
            .send_ark(ArkAssetRequest {
                provider_connection_id: provider_connection_id.to_string(),
                action: "GetAsset",
                body: json!({ "Id": id }),
            })
            .await?;
        if matches!(response.status, 404 | 410) {
            return Ok(missing_asset_observation(&response.body));
        }
        require_success("observe ark asset status", &response)?;
        let payload: Value = serde_json::from_str(&response.body)?;
        let asset = parse_ark_asset_entry(provider_connection_id, &payload)
            .ok_or_else(|| BackendError::protocol("云素材没有返回可读取的记录。", json!({})))?;
        let reason = asset_failure_reason(&payload);
        Ok(observation_from_parts(asset, reason, false))
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
        let data = payload.get("data").unwrap_or(&payload);
        let asset = parse_asset_entry(
            &identity.provider_connection_id,
            data,
            Some(&identity.asset_id),
        )
        .ok_or_else(|| BackendError::protocol("云素材没有返回可读取的记录。", json!({})))?;
        // 审核完成后 `id` 可能仍是任务号，规范身份已换成 asset_id。用任务号来续签时，
        // 原始 `id` 对得上即可，不能把已经就绪的素材判成另一条。
        if asset.id != identity.asset_id
            && data.get("id").and_then(asset_id_string).as_deref()
                != Some(identity.asset_id.as_str())
        {
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
        remember_cloud_asset_preview(&asset);
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

    /// Read a stable cloud identity before copying its bytes into another
    /// user library. The signed URL remains inside the backend.
    pub(crate) async fn material_transfer_record(
        &self,
        identity: CloudAssetIdentity,
        expected_media_type: MediaType,
    ) -> BackendResult<CloudAssetRecord> {
        self.refresh_asset_record(identity, expected_media_type)
            .await
    }

    pub(crate) async fn download_material_to_file(
        &self,
        url: String,
        destination: PathBuf,
    ) -> BackendResult<u64> {
        self.port.download_to_file(url, destination, None).await
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
                    json!({
                        "assetId": poll_id,
                        "waitedMs": started.elapsed().as_millis(),
                        "terminalStatus": "TimedOut",
                    }),
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
            // 异步契约下轮询用的可能是审核任务 ID。完成后真实素材 ID 会写回 `id`，
            // 也可能留在 `id` 里的仍是 `task-…`，真正的素材 ID 在 `asset_id`。
            // 不要求返回 ID 与轮询 ID 相等；Active 时采用规范素材 ID。
            let returned_asset_id = item
                .as_object()
                .and_then(|record| canonical_asset_id(record, None));
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
                    // Some gateways mark the review task Active before filling in its
                    // material ID. A task-* lookup key is not a usable asset identity;
                    // keep polling the same task until the real ID arrives or the local
                    // wait deadline expires.
                    let ready_asset_id = returned_asset_id
                        .filter(|id| !is_review_task_id(id))
                        .or_else(|| (!is_review_task_id(poll_id)).then(|| poll_id.to_string()));
                    if let Some(asset_id) = ready_asset_id {
                        return Ok(CloudAssetIdentity {
                            provider_connection_id: provider_connection_id.to_string(),
                            asset_id,
                        });
                    }
                    self.wait_before_next_import_poll().await;
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

/// 素材审核任务 ID。处理过程中它会占着 `id`，完成后真正的素材 ID 在 `asset_id`。
pub(super) fn is_review_task_id(id: &str) -> bool {
    id.trim().len() > "task-".len()
        && id
            .trim()
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("task-"))
}

fn asset_scheme_identity(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let rest = trimmed
        .get(..8)
        .filter(|prefix| prefix.eq_ignore_ascii_case("asset://"))
        .map(|_| &trimmed["asset://".len()..])?;
    let id = rest.trim().trim_start_matches('/');
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// 海外 `/upload` 的 `db_id` 与 `task-…` 都只是查询键，不能作为生成素材身份。
/// 这条限制只用于海外上传完成判定；其他素材接口仍可使用数值真实 ID。
fn overseas_ready_asset_id(record: &Map<String, Value>, db_id: u64) -> Option<String> {
    let is_real = |id: &String| !is_review_task_id(id) && id != &db_id.to_string();
    let explicit = ["asset_id", "assetId", "AssetId"]
        .into_iter()
        .find_map(|key| record.get(key).and_then(asset_id_string));
    let primary = record.get("id").and_then(asset_id_string);
    let from_url = ["asset_url", "assetUrl"].into_iter().find_map(|key| {
        record
            .get(key)
            .and_then(Value::as_str)
            .and_then(asset_scheme_identity)
    });
    let chosen = explicit
        .as_ref()
        .filter(|id| is_real(id))
        .or_else(|| primary.as_ref().filter(|id| is_real(id)))
        .or_else(|| from_url.as_ref().filter(|id| is_real(id)))?;
    // 海外上传只有得到可用的 asset:// 引用，才能用于后续生成。
    if from_url.as_deref() != Some(chosen.as_str()) {
        return None;
    }
    // 当 asset_url 已给出 asset:// 身份时，它必须与真实 ID 一致；一个仍指向 task
    // 或另一个 asset 的引用表示记录尚未回填完成，不可放给生成请求。
    if from_url.as_ref().is_some_and(|url_id| url_id != chosen)
        || explicit
            .as_ref()
            .is_some_and(|id| is_real(id) && id != chosen)
        || primary
            .as_ref()
            .is_some_and(|id| is_real(id) && id != chosen)
    {
        return None;
    }
    Some(chosen.clone())
}

fn overseas_entry_is_ready(entry: &Value) -> bool {
    entry
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| {
            matches!(
                status.trim().to_ascii_lowercase().as_str(),
                "active" | "ready"
            )
        })
}

fn overseas_terminal_status(entry: &Value) -> Option<&str> {
    entry
        .get("status")
        .and_then(Value::as_str)
        .and_then(|status| {
            matches!(
                status.trim().to_ascii_lowercase().as_str(),
                "failed" | "deleted"
            )
            .then_some(status)
        })
}

/// 素材库要展示和继续使用的身份。
///
/// `id` 在审核完成前是任务号（`task-…`）。完成后若另有 `asset_id`（或 `asset://` 引用），
/// 用那个素材 ID；`id` 本身已经是素材 ID 时保持不动。还没有素材 ID 时才退回任务号。
fn canonical_asset_id(record: &Map<String, Value>, fallback_id: Option<&str>) -> Option<String> {
    let explicit = ["asset_id", "assetId", "AssetId"]
        .into_iter()
        .find_map(|key| record.get(key).and_then(asset_id_string))
        .filter(|id| !is_review_task_id(id));
    if explicit.is_some() {
        return explicit;
    }
    let primary = record.get("id").and_then(asset_id_string);
    if primary.as_ref().is_some_and(|id| !is_review_task_id(id)) {
        return primary;
    }
    let from_url = ["asset_url", "assetUrl"]
        .into_iter()
        .find_map(|key| {
            record
                .get(key)
                .and_then(Value::as_str)
                .and_then(asset_scheme_identity)
        })
        .filter(|id| !is_review_task_id(id));
    if from_url.is_some() {
        return from_url;
    }
    let fallback = fallback_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && !is_review_task_id(id))
        .map(str::to_string);
    if fallback.is_some() {
        return fallback;
    }
    primary.filter(|id| !id.is_empty()).or_else(|| {
        fallback_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    })
}

/// 审核任务号，只用于展示。不拿它充当素材 ID。
fn review_task_id(record: &Map<String, Value>, fallback_id: Option<&str>) -> Option<String> {
    let explicit = ["task_id", "taskId", "review_task_id", "reviewTaskId"]
        .into_iter()
        .find_map(|key| record.get(key).and_then(asset_id_string))
        .filter(|id| is_review_task_id(id));
    if explicit.is_some() {
        return explicit;
    }
    let from_id = record
        .get("id")
        .and_then(asset_id_string)
        .filter(|id| is_review_task_id(id));
    if from_id.is_some() {
        return from_id;
    }
    fallback_id
        .map(str::trim)
        .filter(|id| is_review_task_id(id))
        .map(str::to_string)
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

fn overseas_statuses_unimplemented(status: u16) -> bool {
    matches!(status, 404 | 405 | 501)
}

fn should_fallback_overseas_statuses(status: u16) -> bool {
    status >= 500
}

fn overseas_statuses_poll_request(
    provider_connection_id: &str,
    placeholder_db_id: u64,
) -> RemoteAssetRequest {
    RemoteAssetRequest {
        provider_connection_id: provider_connection_id.to_string(),
        method: Method::POST,
        path: "/v1/assets/statuses",
        body: Some(json!({ "db_ids": [placeholder_db_id] })),
    }
}

fn overseas_list_poll_request_page(
    provider_connection_id: &str,
    display_name: Option<&str>,
    page_number: u64,
) -> RemoteAssetRequest {
    let mut body = Map::new();
    body.insert("page_number".into(), json!(page_number));
    body.insert("page_size".into(), json!(100));
    if let Some(name) = display_name {
        body.insert("name".into(), json!(name));
    }
    RemoteAssetRequest {
        provider_connection_id: provider_connection_id.to_string(),
        method: Method::POST,
        path: "/v1/assets/list",
        body: Some(Value::Object(body)),
    }
}

fn find_overseas_upload_entry(payload: &Value, placeholder_db_id: u64) -> Option<&Value> {
    let candidates = payload
        .get("data")
        .map(asset_array)
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| asset_array(payload));
    candidates.into_iter().find(|entry| {
        entry
            .get("db_id")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_u64)
            == Some(placeholder_db_id)
    })
}

enum OverseasPollFetch {
    Observed(RawProviderResponse),
    StatusesUnimplemented(RawProviderResponse),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverseasReadyConfirmation {
    Verified,
    /// 此网关未实现单条查询；调用方需等待第二次独立 db_id 读数一致。
    Unavailable,
    Invalid,
}

fn require_success(operation: &str, response: &RawProviderResponse) -> BackendResult<()> {
    if (200..300).contains(&response.status) {
        return super::provider::reject_html_api_response(
            response.status,
            &response.headers,
            &response.body,
            "",
        );
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

/// 只允许删除已经落在上游的分组。魔芋约定 `id = -2` 会清空该令牌下全部历史分组，
/// 因此非正数（含创建中的临时负数 ID）一律在发请求之前拒绝。
fn require_deletable_asset_group_id(id: &str) -> BackendResult<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(BackendError::validation(
            "asset group deletion requires a group id",
            json!({ "field": "id" }),
        ));
    }
    if let Ok(group_id) = id.parse::<i64>() {
        if group_id <= 0 {
            return Err(BackendError::validation(
                "asset group deletion requires a positive group id; the upstream magic value -2 would delete every group and is rejected",
                json!({ "field": "id", "value": id }),
            ));
        }
    }
    Ok(id)
}

/// 从 `user-{uid}-token-{tid}-{展示名}` 里取出展示名；对不上前缀时原样返回。
fn strip_token_group_prefix(group_name: &str) -> &str {
    let Some(rest) = group_name.strip_prefix("user-") else {
        return group_name;
    };
    let Some(token_at) = rest.find("-token-") else {
        return group_name;
    };
    let after_token = &rest[token_at + "-token-".len()..];
    after_token
        .split_once('-')
        .map(|(_, display)| display)
        .filter(|display| !display.is_empty())
        .unwrap_or(group_name)
}

fn parse_asset_group(raw: &Value) -> Option<AssetGroupRecord> {
    let record = raw.as_object()?;
    // 魔芋数值 ID 与火山字符串 ID（asset-group-…）统一按字符串承载；
    // 魔芋负数临时 ID 兜底场景由创建路径另行处理，列表里丢弃以免误点删除。
    let id = ["id", "group_id", "groupId"]
        .into_iter()
        .find_map(|field| record.get(field).and_then(asset_id_string))
        .filter(|id| !id.is_empty() && !id.starts_with('-'))?;
    let group_name = ["group_name", "groupName"].into_iter().find_map(|field| {
        record
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    });
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| group_name.map(strip_token_group_prefix).map(str::to_string))?;
    let group_name = group_name.unwrap_or(name.as_str()).to_string();
    Some(AssetGroupRecord {
        id,
        name,
        group_name,
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

fn count_expired_preview_urls(assets: &[CloudAssetRecord], now: SystemTime) -> usize {
    assets
        .iter()
        .filter_map(|asset| asset.preview_url.as_deref())
        .filter_map(|raw| Url::parse(raw).ok())
        .filter(|url| media_proxy::signed_url_expired(url, now))
        .count()
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

fn remember_cloud_asset_preview(asset: &CloudAssetRecord) {
    media_proxy::remember_asset_preview_url(&asset.id, asset.preview_url.as_deref());
    media_proxy::schedule_warm_image_previews(preview_warm_urls(std::slice::from_ref(asset)));
}

fn remember_cloud_asset_previews(assets: &[CloudAssetRecord]) {
    for asset in assets {
        media_proxy::remember_asset_preview_url(&asset.id, asset.preview_url.as_deref());
    }
    media_proxy::schedule_warm_image_previews(preview_warm_urls(assets));
}

fn preview_warm_urls(assets: &[CloudAssetRecord]) -> Vec<String> {
    assets
        .iter()
        .filter_map(|asset| match asset.kind {
            MediaType::Image => asset.preview_url.clone(),
            MediaType::Video => asset.cover_url.clone(),
            _ => None,
        })
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
    let id = canonical_asset_id(record, fallback_id).filter(|value| !value.is_empty())?;
    let db_id = record
        .get("db_id")
        .or_else(|| record.get("dbId"))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        });
    let raw_name = string_field(record, &["name"]).unwrap_or_default();
    let preview_url = http_url_field(
        record,
        &[
            "url",
            "preview_url",
            "previewUrl",
            "URL",
            "file_url",
            "fileUrl",
            "download_url",
            "downloadUrl",
            "signed_url",
            "signedUrl",
            "source_url",
            "sourceUrl",
            "origin_url",
            "originUrl",
        ],
    );
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
    let mut status = apply_asset_failure(
        normalize_asset_status(&raw_status),
        asset_failure_reason(raw).is_some(),
    );
    if status == CloudAssetStatus::Ready
        && (is_review_task_id(&id)
            || db_id.is_some()
                && asset_url
                    .as_deref()
                    .and_then(asset_scheme_identity)
                    .as_deref()
                    != Some(id.as_str()))
    {
        // 上游可能先写 Active，再回填真实身份；这时生成端仍不能使用该记录。
        status = CloudAssetStatus::Processing;
    }
    let fallback_name = match kind {
        MediaType::Image => "图片素材",
        MediaType::Video => "视频素材",
        MediaType::Audio => "音频素材",
        MediaType::Text => "文本素材",
    };
    Some(CloudAssetRecord {
        provider_connection_id: provider_connection_id.to_string(),
        id,
        review_task_id: review_task_id(record, fallback_id),
        db_id,
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
    let status = apply_asset_failure(
        normalize_asset_status(&raw_status),
        asset_failure_reason(raw).is_some(),
    );
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
        review_task_id: is_review_task_id(id).then(|| id.to_string()),
        db_id: None,
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
        .find_map(|field| record.get(*field).and_then(http_url_from_value))
}

fn http_url_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            let lower = trimmed.to_ascii_lowercase();
            (lower.starts_with("http://") || lower.starts_with("https://"))
                .then(|| trimmed.to_string())
        }
        Value::Object(map) => ["url", "href", "preview", "origin", "download", "signed"]
            .into_iter()
            .find_map(|key| map.get(key).and_then(http_url_from_value)),
        _ => None,
    }
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
        "failed" | "failure" | "error" | "errored" | "rejected" | "reject" | "review_failed"
        | "review_rejected" | "audit_failed" | "invalid" | "timeout" | "timed_out" | "expired"
        | "cancelled" | "canceled" | "aborted" => CloudAssetStatus::Failed,
        "deleted" | "removed" => CloudAssetStatus::Deleted,
        _ => CloudAssetStatus::Unknown,
    }
}

/// 状态字符串还停在处理中，但记录里已经带了失败原因时，按失败处理。
/// 已就绪的素材即使残留旧错误字段，也不再降级。
fn apply_asset_failure(status: CloudAssetStatus, has_failure_reason: bool) -> CloudAssetStatus {
    if has_failure_reason && !matches!(status, CloudAssetStatus::Ready | CloudAssetStatus::Deleted)
    {
        CloudAssetStatus::Failed
    } else {
        status
    }
}

fn clip_reason(text: &str) -> String {
    text.chars().take(500).collect()
}

fn nonempty_text(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(clip_reason(text))
    }
}

fn error_value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(_) => nonempty_text(value),
        Value::Object(map) => {
            let code = map
                .get("Code")
                .or_else(|| map.get("code"))
                .and_then(nonempty_text);
            let message = map
                .get("Message")
                .or_else(|| map.get("message"))
                .or_else(|| map.get("msg"))
                .and_then(nonempty_text);
            match (code, message) {
                (Some(code), Some(message)) => Some(clip_reason(&format!("{code}: {message}"))),
                (Some(code), None) => Some(code),
                (None, Some(message)) => Some(message),
                (None, None) => None,
            }
        }
        _ => None,
    }
}

/// 从素材记录上读取云端已经给出的失败原因。没有这些字段就表示云端还没报错。
fn asset_failure_reason(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    const TEXT_KEYS: &[&str] = &[
        "review_error_msg",
        "reviewErrorMsg",
        "error_message",
        "errorMessage",
        "fail_reason",
        "failReason",
        "failure_reason",
        "failureReason",
    ];
    for key in TEXT_KEYS {
        if let Some(text) = record.get(*key).and_then(nonempty_text) {
            return Some(text);
        }
    }
    record
        .get("error")
        .or_else(|| record.get("Error"))
        .and_then(error_value_text)
}

fn asset_lookup_id(id: &str) -> Value {
    if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(number) = id.parse::<u64>() {
            return json!(number);
        }
    }
    json!(id)
}

fn missing_asset_observation(body: &str) -> AssetStatusObservation {
    let reason = serde_json::from_str::<Value>(body)
        .ok()
        .as_ref()
        .and_then(asset_failure_reason)
        .or_else(|| {
            serde_json::from_str::<Value>(body)
                .ok()
                .as_ref()
                .and_then(|payload| {
                    payload
                        .pointer("/error/message")
                        .or_else(|| payload.get("message"))
                        .and_then(nonempty_text)
                })
        })
        .unwrap_or_else(|| "云端没有返回该素材".to_string());
    AssetStatusObservation {
        status: CloudAssetStatus::Deleted,
        raw_status: "missing".to_string(),
        failure_reason: Some(reason),
        missing: true,
        preview_url: None,
        cover_url: None,
    }
}

fn observation_from_parts(
    asset: CloudAssetRecord,
    failure_reason: Option<String>,
    missing: bool,
) -> AssetStatusObservation {
    let status = apply_asset_failure(asset.status, failure_reason.is_some());
    let failure_reason = match status {
        CloudAssetStatus::Failed | CloudAssetStatus::Deleted => Some(
            failure_reason
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("云端状态：{}", asset.raw_status)),
        ),
        CloudAssetStatus::Processing | CloudAssetStatus::Ready | CloudAssetStatus::Unknown => None,
    };
    AssetStatusObservation {
        status,
        raw_status: asset.raw_status,
        failure_reason,
        missing,
        preview_url: asset.preview_url,
        cover_url: asset.cover_url,
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
