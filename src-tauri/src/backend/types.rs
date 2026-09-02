use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationOperation {
    TextToImage,
    ImageToImage,
    VideoGeneration,
    TextGeneration,
}

impl GenerationOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextToImage => "text_to_image",
            Self::ImageToImage => "image_to_image",
            Self::VideoGeneration => "video_generation",
            Self::TextGeneration => "text_generation",
        }
    }
}

impl TryFrom<&str> for GenerationOperation {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "text_to_image" => Ok(Self::TextToImage),
            "image_to_image" => Ok(Self::ImageToImage),
            "video_generation" => Ok(Self::VideoGeneration),
            "text_generation" => Ok(Self::TextGeneration),
            _ => Err(format!("unknown generation operation: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationTaskStatus {
    Created,
    Submitting,
    RetryWait,
    Queued,
    Running,
    Succeeded,
    Failed,
    Unknown,
    Interrupted,
}

impl GenerationTaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Submitting => "submitting",
            Self::RetryWait => "retry_wait",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Unknown | Self::Interrupted
        )
    }
}

impl TryFrom<&str> for GenerationTaskStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "created" => Ok(Self::Created),
            "submitting" => Ok(Self::Submitting),
            "retry_wait" => Ok(Self::RetryWait),
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "unknown" => Ok(Self::Unknown),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("unknown task status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryHealth {
    Healthy,
    RetryWait,
    Degraded,
}

impl QueryHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::RetryWait => "retry_wait",
            Self::Degraded => "degraded",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveStatus {
    Pending,
    Writing,
    Succeeded,
    Failed,
    Interrupted,
    LocalMissing,
    Conflict,
}

impl SaveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Writing => "writing",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::LocalMissing => "local_missing",
            Self::Conflict => "conflict",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    Image,
    Video,
    Audio,
}

impl MediaType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }

    pub fn position_label(self) -> &'static str {
        match self {
            Self::Image => "图片",
            Self::Video => "视频",
            Self::Audio => "音频",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PromptSegment {
    Text {
        text: String,
    },
    MediaReference {
        mention_id: String,
        target: MediaReferenceTarget,
        display_name_snapshot: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MediaReferenceTarget {
    Asset {
        provider_connection_id: String,
        asset_id: String,
        media_type: MediaType,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canvas_node_key: Option<String>,
    },
    LocalAsset {
        staging_job_id: String,
        media_type: MediaType,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canvas_node_key: Option<String>,
    },
    LocalResult {
        generation_task_id: String,
        result_index: u32,
        media_type: MediaType,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canvas_node_key: Option<String>,
    },
}

impl MediaReferenceTarget {
    pub fn media_type(&self) -> MediaType {
        match self {
            Self::Asset { media_type, .. }
            | Self::LocalAsset { media_type, .. }
            | Self::LocalResult { media_type, .. } => *media_type,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitMediaInput {
    pub target: MediaReferenceTarget,
    pub role: String,
    pub display_name_snapshot: String,
}

fn default_generation_count() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGenerationCommand {
    pub canvas_id: String,
    pub source_node_id: String,
    pub operation: GenerationOperation,
    pub provider_connection_id: String,
    pub model_definition_id: String,
    pub prompt: Vec<PromptSegment>,
    #[serde(default)]
    pub explicit_media: Vec<ExplicitMediaInput>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_operation_schema_snapshot: Option<Value>,
    #[serde(default = "default_generation_count")]
    pub generation_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnection {
    pub id: String,
    pub display_name: String,
    pub adapter_id: String,
    pub base_url: String,
    pub api_key_ref: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderConnectionCommand {
    pub id: String,
    pub display_name: String,
    pub adapter_id: String,
    pub base_url: String,
    pub enabled: bool,
}

/// 供应商连接下的令牌分组：同一供应商接口可能签发多组分组令牌，
/// 不同分组能拉取/调用的模型不同（如 as 分组可调 sd、默认分组可调 image）。
/// 每个模型绑定记录使用哪个分组令牌；分组密钥保存在 Windows 凭据管理器。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTokenGroup {
    pub id: String,
    pub provider_connection_id: String,
    pub group_name: String,
    pub credential_ref: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderTokenGroupCommand {
    pub provider_connection_id: String,
    pub group_name: String,
    pub enabled: bool,
    /// 非空时由命令层写入该分组的密钥（Windows 凭据管理器）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProviderTokenGroupCommand {
    pub provider_connection_id: String,
    pub group_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialCommand {
    pub credential_ref: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub credential_ref: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefinition {
    pub id: String,
    pub display_name: String,
    pub remote_model_id: Option<String>,
    pub operations: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelBinding {
    pub provider_connection_id: String,
    pub model_definition_id: String,
    pub enabled_operations: Vec<GenerationOperation>,
    pub remote_model_id: Option<String>,
    pub enabled: bool,
    /// 调用该模型使用的令牌分组；None = 使用供应商主 API Key（默认令牌）。
    #[serde(default)]
    pub token_group: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelOption {
    pub id: String,
    pub model_definition_id: String,
    pub display_name: String,
    pub owned_by: Option<String>,
    pub has_configured_binding: bool,
    pub configured_operations: Vec<GenerationOperation>,
    pub suggested_operations: Vec<GenerationOperation>,
    pub operation_schema: Value,
    /// 该模型应使用的令牌分组；None = 供应商默认令牌。
    #[serde(default)]
    pub token_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSelection {
    pub model_definition_id: String,
    pub display_name: String,
    pub remote_model_id: String,
    pub enabled: bool,
    pub enabled_operations: Vec<GenerationOperation>,
    #[serde(default)]
    pub operation_schema: Value,
    /// 调用该模型使用的令牌分组；None = 供应商默认令牌。
    #[serde(default)]
    pub token_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceProviderModelBindingsCommand {
    pub provider_connection_id: String,
    pub selections: Vec<ProviderModelSelection>,
}

/// 供应商接口响应中的 token 用量（usage 字段）。图片同步响应和视频轮询响应
/// 都可能携带；轮询到达时覆盖更新，最终保留任务终态时的最后一份用量。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskSummary {
    pub id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub operation: GenerationOperation,
    pub status: GenerationTaskStatus,
    pub query_health: QueryHealth,
    pub provider_connection_id: String,
    pub provider_display_name_snapshot: String,
    pub model_definition_id: String,
    pub remote_model_id_snapshot: Option<String>,
    pub remote_task_id: Option<String>,
    pub progress: Option<f64>,
    pub tokens: Option<TokenUsage>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationAttemptRecord {
    pub id: String,
    pub task_id: String,
    pub attempt_number: u32,
    pub phase: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub backoff_ms: Option<u64>,
    pub outcome: Option<String>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCallRecord {
    pub id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub phase: String,
    pub request: Value,
    pub sent_at: Option<i64>,
    pub response_received_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub http_status: Option<u16>,
    pub response_headers: Option<Value>,
    pub raw_response: Option<String>,
    pub runtime_error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskEvent {
    pub id: i64,
    pub task_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: i64,
}

/// 文本模型任务的最终产物。`optimized_prompt` 是应用实际采用的提取结果，
/// `raw_model_output` 是从供应商响应中抽出的、未经业务清洗的完整模型文本。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGenerationOutputRecord {
    pub optimized_prompt: String,
    pub raw_model_output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationResultRecord {
    pub task_id: String,
    pub result_index: u32,
    pub media_type: MediaType,
    pub remote_task_id: Option<String>,
    pub source: Value,
    pub save_status: SaveStatus,
    pub final_path: Option<String>,
    pub relative_path: Option<String>,
    pub byte_size: Option<u64>,
    pub mime_type: Option<String>,
    pub sha256: Option<String>,
    pub saved_at: Option<i64>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskDetail {
    pub summary: GenerationTaskSummary,
    pub logical_request: Value,
    pub resolved_request: Option<Value>,
    pub attempts: Vec<GenerationAttemptRecord>,
    pub calls: Vec<ProviderCallRecord>,
    pub events: Vec<GenerationTaskEvent>,
    pub results: Vec<GenerationResultRecord>,
    pub text_output: Option<TextGenerationOutputRecord>,
    pub final_error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskListQuery {
    pub canvas_id: Option<String>,
    pub source_node_id: Option<String>,
    pub statuses: Option<Vec<GenerationTaskStatus>>,
    pub cursor_created_before: Option<i64>,
    #[serde(default = "default_page_size")]
    pub limit: u32,
}

fn default_page_size() -> u32 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskPage {
    pub items: Vec<GenerationTaskSummary>,
    pub next_cursor_created_before: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub recovered_video_tasks: u32,
    pub interrupted_image_tasks: u32,
    pub resumed_local_saves: u32,
    pub failed_to_recover: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTaskListCommand {
    pub provider_connection_id: String,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    #[serde(default = "default_page_number")]
    pub page: u32,
    #[serde(default = "default_remote_page_size")]
    pub page_size: u32,
    pub status: Option<String>,
}

fn default_page_number() -> u32 {
    1
}

fn default_remote_page_size() -> u32 {
    100
}

/// 网络爆款视频下载节点的启动命令：url 支持直接粘贴分享口令整段文本，
/// 后端会提取其中的第一个 http(s) 链接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoDownloadCommand {
    pub url: String,
}

/// 视频合成的单路输入：本地文件绝对路径或 http(s) 远程地址，
/// 两者 ffmpeg 都能直接读取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCompositionInputParams {
    pub key: String,
    pub name: String,
    pub source: String,
}

/// 视频合成节点的启动命令。输出文件名由后端按下载产物同一规则清洗并去重。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoCompositionCommand {
    pub inputs: Vec<VideoCompositionInputParams>,
    pub output_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCanvasDocumentCommand {
    pub id: String,
    pub title: String,
    pub document: Value,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocumentRecord {
    pub id: String,
    pub title: String,
    pub document: Value,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocumentSummary {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProviderResponse {
    pub status: u16,
    pub headers: Value,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudAssetStatus {
    Processing,
    Ready,
    Failed,
    Deleted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAssetIdentity {
    pub provider_connection_id: String,
    pub asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAssetRecord {
    pub provider_connection_id: String,
    pub id: String,
    pub name: String,
    pub kind: MediaType,
    pub status: CloudAssetStatus,
    pub raw_status: String,
    pub preview_url: Option<String>,
    pub asset_url: Option<String>,
    pub cover_url: Option<String>,
    pub group_id: Option<i64>,
}

/// 连通性测试的统一结果。`ok` 表示请求到达服务端并通过鉴权；
/// 任何失败（网络、凭据、非 2xx）都转换为 `ok=false` 的结果而不是错误，
/// 让前端能以「配置已保存，但连通失败」的方式提示用户。
/// `reason` 是机器可读的失败类别（network-error / auth-rejected /
/// bucket-not-found / http-error / not-configured / credential-error / error），
/// 供前端生成本地化文案。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityTestResult {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetListCommand {
    pub provider_connection_id: String,
    pub page_number: Option<u32>,
    pub page_size: Option<u32>,
    pub name: Option<String>,
    pub group_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRealPersonAuthLinkCommand {
    pub provider_connection_id: String,
    pub artist_name: String,
    pub artist_desc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealPersonAuthLink {
    pub h5_url: String,
    pub tip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealPersonGroup {
    /// Platform group ID. This integer, rather than `remote_group_id`, is used for uploads.
    pub id: i64,
    /// Upstream `group-xxx` identifier, retained only for display and diagnostics.
    pub remote_group_id: String,
    pub artist_name: String,
    pub artist_desc: Option<String>,
    /// Display-only authorization timestamp. Some upstream responses omit it briefly after auth.
    pub authorized_at: Option<String>,
    pub asset_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealPersonProviderCommand {
    pub provider_connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRealPersonAssetCommand {
    pub provider_connection_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAssetCommand {
    pub provider_connection_id: String,
    /// 云端素材 ID（`asset-…`，不带 `asset://` 前缀）。
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRealPersonGroupCommand {
    pub provider_connection_id: String,
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TosStagingConfig {
    /// TOS 地域，例如 `cn-beijing`。
    pub region: String,
    /// TOS Endpoint 主机，例如 `tos-cn-beijing.volces.com`。
    pub endpoint: String,
    /// 暂存桶名。
    pub bucket: String,
    /// AK/SK 在系统凭据管理器中的引用名。
    pub credential_ref: Option<String>,
    pub object_prefix: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStagingCommand {
    pub local_path: String,
    pub purpose: String,
    pub media_type: MediaType,
    pub import: Option<StagingAssetImportTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingAssetImportTarget {
    pub provider_connection_id: String,
    pub name: Option<String>,
    /// A positive real-person platform group ID. `None` keeps the ordinary asset flow.
    #[serde(default)]
    pub group_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagingStatus {
    Validating,
    Authorizing,
    Uploading,
    Staged,
    Importing,
    Active,
    InUse,
    Failed,
    Interrupted,
    Cleaning,
    Cleaned,
}

impl StagingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Validating => "validating",
            Self::Authorizing => "authorizing",
            Self::Uploading => "uploading",
            Self::Staged => "staged",
            Self::Importing => "importing",
            Self::Active => "active",
            Self::InUse => "in_use",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Cleaning => "cleaning",
            Self::Cleaned => "cleaned",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingJobRecord {
    pub id: String,
    pub local_path: String,
    pub purpose: String,
    pub media_type: MediaType,
    pub object_key: Option<String>,
    pub status: StagingStatus,
    pub bytes_total: Option<u64>,
    pub bytes_uploaded: u64,
    pub asset_id: Option<String>,
    pub import_target: Option<StagingAssetImportTarget>,
    pub error: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 本地素材库条目。目录索引保存在本机 SQLite，媒体正文只保存在对象存储。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAssetRecord {
    /// 复用完成上传的 staging job id 作为稳定素材身份。
    pub id: String,
    pub name: String,
    pub media_type: MediaType,
    pub object_key: String,
    /// 每次查询时重新签发，避免把短期签名持久化到数据库。
    pub preview_url: String,
    pub byte_size: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendErrorPayload {
    pub kind: String,
    pub message: String,
    pub details: Value,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn structured_mentions_use_frontend_camel_case_fields() {
        let segment = PromptSegment::MediaReference {
            mention_id: "mention-1".into(),
            target: MediaReferenceTarget::Asset {
                provider_connection_id: "company".into(),
                asset_id: "asset-1".into(),
                media_type: MediaType::Image,
                canvas_node_key: Some("asset-node-7".into()),
            },
            display_name_snapshot: "角色正面".into(),
        };
        assert_eq!(
            serde_json::to_value(segment).expect("serialize"),
            json!({
                "kind": "media_reference",
                "mentionId": "mention-1",
                "target": {
                    "kind": "asset",
                    "providerConnectionId": "company",
                    "assetId": "asset-1",
                    "mediaType": "image",
                    "canvasNodeKey": "asset-node-7"
                },
                "displayNameSnapshot": "角色正面"
            })
        );
    }

    #[test]
    fn local_asset_references_use_staging_job_identity() {
        let target = MediaReferenceTarget::LocalAsset {
            staging_job_id: "upload-1".into(),
            media_type: MediaType::Video,
            canvas_node_key: Some("asset-node-local".into()),
        };
        assert_eq!(
            serde_json::to_value(target).expect("serialize"),
            json!({
                "kind": "local_asset",
                "stagingJobId": "upload-1",
                "mediaType": "video",
                "canvasNodeKey": "asset-node-local"
            })
        );
    }

    #[test]
    fn full_generation_command_deserializes_precise_asset_and_local_result_targets() {
        let command: StartGenerationCommand = serde_json::from_value(json!({
            "canvasId": "canvas-1",
            "sourceNodeId": "video-node-1",
            "operation": "video_generation",
            "providerConnectionId": "company",
            "modelDefinitionId": "video-model",
            "prompt": [
                {
                    "kind": "text",
                    "text": "让 "
                },
                {
                    "kind": "media_reference",
                    "mentionId": "mention-asset",
                    "target": {
                        "kind": "asset",
                        "providerConnectionId": "company",
                        "assetId": "asset-1",
                        "mediaType": "image",
                        "canvasNodeKey": "asset-node-7"
                    },
                    "displayNameSnapshot": "角色正面"
                },
                {
                    "kind": "media_reference",
                    "mentionId": "mention-result",
                    "target": {
                        "kind": "local_result",
                        "generationTaskId": "task-previous",
                        "resultIndex": 2,
                        "mediaType": "video",
                        "canvasNodeKey": "output-node-4"
                    },
                    "displayNameSnapshot": "上一段视频"
                }
            ],
            "explicitMedia": [{
                "target": {
                    "kind": "asset",
                    "providerConnectionId": "company",
                    "assetId": "asset-legacy",
                    "mediaType": "image"
                },
                "role": "reference_image",
                "displayNameSnapshot": "旧版素材"
            }],
            "parameters": { "duration": 5 },
            "generationCount": 1
        }))
        .expect("deserialize full command");

        assert_eq!(command.canvas_id, "canvas-1");
        assert_eq!(command.operation, GenerationOperation::VideoGeneration);
        assert_eq!(command.prompt.len(), 3);
        assert!(matches!(
            &command.prompt[1],
            PromptSegment::MediaReference {
                target: MediaReferenceTarget::Asset {
                    provider_connection_id,
                    asset_id,
                    media_type: MediaType::Image,
                    canvas_node_key: Some(canvas_node_key),
                },
                ..
            } if provider_connection_id == "company"
                && asset_id == "asset-1"
                && canvas_node_key == "asset-node-7"
        ));
        assert!(matches!(
            &command.prompt[2],
            PromptSegment::MediaReference {
                target: MediaReferenceTarget::LocalResult {
                    generation_task_id,
                    result_index: 2,
                    media_type: MediaType::Video,
                    canvas_node_key: Some(canvas_node_key),
                },
                ..
            } if generation_task_id == "task-previous" && canvas_node_key == "output-node-4"
        ));
        assert!(matches!(
            &command.explicit_media[0].target,
            MediaReferenceTarget::Asset {
                canvas_node_key: None,
                ..
            }
        ));
    }
}
