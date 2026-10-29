use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    model_schema::{
        RequestDialect, default_model_schema, operations_from_schema,
        provider_scoped_model_definition_id, refresh_gemini_image_parameter_defaults,
        refresh_legacy_image_parameter_defaults, schema_for_enabled_operations,
    },
    types::{
        CanvasDocumentRecord, CanvasDocumentSummary, GenerationAttemptRecord, GenerationOperation,
        GenerationProgressResult, GenerationResultRecord, GenerationTaskCursor,
        GenerationTaskDetail, GenerationTaskEvent, GenerationTaskListQuery, GenerationTaskPage,
        GenerationTaskProgress, GenerationTaskStatus, GenerationTaskSummary, MediaType,
        ModelDefinition, ProviderCallRecord, ProviderConnection, ProviderModelBinding,
        ProviderTokenGroup, QueryHealth, ReplaceProviderModelBindingsCommand,
        SaveCanvasDocumentCommand, SaveStatus, StagingAssetImportTarget, StagingCleanupCandidate,
        StagingJobRecord, StagingStatus, TextGenerationOutputRecord, TokenUsage, TosStagingConfig,
        UpsertProviderConnectionCommand, UpsertProviderTokenGroupCommand, WorkspaceUiPrefs,
    },
};

#[path = "storage/generation_lifecycle.rs"]
mod generation_lifecycle;

#[path = "storage/history_query.rs"]
mod history_query;

/// 已完成（`active` / `cleaned`）的产物入库上传参与重启恢复的时间窗口。
///
/// 绿色小点是要点亮「刚刚上传成功」的产物卡片，重启时重新翻出很久以前的成功上传没有意义；
/// 未到终态的上传不受该窗口限制（见 [`Storage::list_asset_import_outputs`]）。
const ASSET_IMPORT_OUTPUT_RECOVERY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[path = "storage/remote_video_tasks.rs"]
mod remote_video_tasks;

#[path = "storage/brand_models.rs"]
mod brand_models;

#[path = "storage/local_base64_assets.rs"]
mod local_base64_assets;

#[path = "storage/video_preparation.rs"]
mod video_preparation;

#[path = "storage/frame_extraction.rs"]
mod frame_extraction;

#[path = "storage/long_video.rs"]
mod long_video;

pub use generation_lifecycle::{
    GenerationLifecycleFact, GenerationOperationalEvent, GenerationRemoteObservation,
    GenerationTaskLifecycle, PersistedTaskTransition, PersistedTaskTransitionEvent,
};

const SCHEMA: &str = r#"
PRAGMA encoding = 'UTF-8';
PRAGMA application_id = 1229869902;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_base64_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at INTEGER NOT NULL,
  group_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_base64_assets_created
  ON local_base64_assets(created_at DESC, id DESC);

-- 本机素材分组（文件夹语义）。删除分组时把成员置回未分组，不删除素材正文，
-- 因此不加外键约束：旧库经 ALTER TABLE 补列无法携带外键，行为以代码事务为准。
CREATE TABLE IF NOT EXISTS local_base64_asset_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_base64_asset_groups_name
  ON local_base64_asset_groups(name);

-- One canonical body per exact byte sequence. This separate table also lets old
-- libraries acquire hashes lazily without changing or deleting existing IDs.
CREATE TABLE IF NOT EXISTS local_base64_content_hashes (
  asset_id TEXT PRIMARY KEY REFERENCES local_base64_assets(id),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE(media_type, byte_size, sha256)
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_definitions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  remote_model_id TEXT,
  operations_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_model_bindings (
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  model_definition_id TEXT NOT NULL REFERENCES model_definitions(id),
  enabled_operations_json TEXT NOT NULL,
  remote_model_id TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  token_group TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_connection_id, model_definition_id)
);

CREATE TABLE IF NOT EXISTS provider_token_groups (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  group_name TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider_connection_id, group_name)
);

CREATE TABLE IF NOT EXISTS generation_tasks (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  query_health TEXT NOT NULL DEFAULT 'healthy',
  provider_connection_id TEXT NOT NULL,
  provider_display_name_snapshot TEXT NOT NULL,
  adapter_id_snapshot TEXT NOT NULL,
  base_url_snapshot TEXT NOT NULL,
  api_key_ref_snapshot TEXT NOT NULL,
  model_definition_id TEXT NOT NULL,
  remote_model_id_snapshot TEXT,
  remote_task_id TEXT,
  progress REAL,
  tokens_json TEXT,
  logical_request_json TEXT NOT NULL,
  resolved_request_json TEXT,
  final_error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_generation_tasks_canvas_created
  ON generation_tasks(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_node_created
  ON generation_tasks(source_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_status
  ON generation_tasks(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_tasks_remote
  ON generation_tasks(provider_connection_id, remote_task_id)
  WHERE remote_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES generation_tasks(id),
  attempt_number INTEGER NOT NULL,
  phase TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  backoff_ms INTEGER,
  outcome TEXT,
  error_json TEXT,
  UNIQUE(task_id, phase, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_generation_attempts_task
  ON generation_attempts(task_id, started_at);

CREATE TABLE IF NOT EXISTS provider_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES generation_tasks(id),
  attempt_id TEXT NOT NULL REFERENCES generation_attempts(id),
  phase TEXT NOT NULL,
  request_json TEXT NOT NULL,
  sent_at INTEGER,
  -- dispatch_failed = 1：请求在**连接层**就失败了（DNS 解析失败、连接被拒、TLS 握手失败），
  -- 根本没有送达上游，不可能被供应商计费。
  -- 「sent_at 非空」只说明「本机在那一刻发起了这次请求」，不等于「供应商已经收到」：
  -- 请求是在 send() 之前写 sent_at 的，所以连接层失败也会留下 sent_at。
  -- 只有 dispatch_failed = 0 才算真正送达（可能计费），判定口径见下面两处守卫 SQL。
  -- 旧库按 DEFAULT 0 补齐：历史记录一律按「已送达」处理，不让旧草稿突然可重复提交。
  dispatch_failed INTEGER NOT NULL DEFAULT 0,
  response_received_at INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  response_headers_json TEXT,
  raw_response TEXT,
  runtime_error_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_calls_task
  ON provider_calls(task_id);

CREATE TABLE IF NOT EXISTS generation_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES generation_tasks(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_task_events_task
  ON generation_task_events(task_id, id);

CREATE TABLE IF NOT EXISTS generation_results (
  task_id TEXT NOT NULL REFERENCES generation_tasks(id),
  result_index INTEGER NOT NULL CHECK (result_index > 0),
  media_type TEXT NOT NULL,
  remote_task_id TEXT,
  source_json TEXT NOT NULL,
  save_status TEXT NOT NULL,
  final_path TEXT,
  relative_path TEXT,
  byte_size INTEGER,
  mime_type TEXT,
  sha256 TEXT,
  saved_at INTEGER,
  error_json TEXT,
  PRIMARY KEY(task_id, result_index)
);

CREATE TABLE IF NOT EXISTS canvas_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_result_names (
  task_id TEXT NOT NULL,
  result_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(task_id, result_index),
  FOREIGN KEY(task_id, result_index) REFERENCES generation_results(task_id, result_index)
);

CREATE INDEX IF NOT EXISTS idx_canvas_documents_updated
  ON canvas_documents(updated_at DESC, id);

CREATE TABLE IF NOT EXISTS application_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_jobs (
  id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL,
  purpose TEXT NOT NULL,
  media_type TEXT NOT NULL,
  object_key TEXT,
  status TEXT NOT NULL,
  bytes_total INTEGER,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  asset_id TEXT,
  import_target_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  adjustment TEXT,
  overseas_db_id INTEGER,
  overseas_submitted_at INTEGER,
  cleanup_retry_count INTEGER NOT NULL DEFAULT 0,
  cleanup_next_at INTEGER,
  cleanup_done_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_staging_jobs_status
  ON staging_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_staging_jobs_object_key
  ON staging_jobs(object_key);

-- Only completed user-library uploads enter this index; transient TOS staging
-- objects and failed uploads never claim a content hash.
CREATE TABLE IF NOT EXISTS staging_content_index (
  scope TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES staging_jobs(id),
  PRIMARY KEY(scope, media_type, byte_size, sha256)
);

CREATE TABLE IF NOT EXISTS staging_content_reuses (
  job_id TEXT PRIMARY KEY REFERENCES staging_jobs(id),
  canonical_job_id TEXT NOT NULL REFERENCES staging_jobs(id)
);

-- Keep the nonsecret bucket coordinates that produced each durable TOS object.
-- Reconfiguring the current bucket must not make an older material point at it.
CREATE TABLE IF NOT EXISTS staging_object_targets (
  job_id TEXT PRIMARY KEY REFERENCES staging_jobs(id),
  config_json TEXT NOT NULL
);
"#;

/// 首次打开应用时提供的连接模板。凭据由用户按实际环境补充；保持禁用状态，
/// 避免初始化后素材面板立即用空配置发起远程请求。模板预置常用供应商地址，
/// 用户填入 API Key 后即可启用。使用稳定 ID + INSERT OR IGNORE，
/// 这样既能为旧数据库补齐模板，也不会覆盖用户已经编辑过的连接信息。
/// 第四个元素为适配器 ID（魔芋 `moyu_v1` / 火山引擎方舟 `volcengine_ark_v1`）。
const DEFAULT_PROVIDER_CONNECTIONS: [(&str, &str, &str, &str); 9] = [
    (
        "provider-fzy-ai",
        "饭众烟 AI（图片与视频）",
        "https://fzy-ai.pages.dev",
        "fzy_ai_v1",
    ),
    (
        "provider-sd20",
        "SD2.0",
        "https://47.94.250.161/",
        "moyu_v1",
    ),
    (
        "provider-moyu-ai",
        "魔芋AI",
        "https://www.moyu.info/",
        "moyu_v1",
    ),
    (
        "provider-overseas",
        "海外平台",
        "https://www.konjac.ai/v1",
        "moyu_v1",
    ),
    (
        "provider-maigateway",
        "MAIGateway",
        "https://mai.anquan.info/v1",
        "moyu_v1",
    ),
    (
        "provider-volcengine-ark",
        "火山引擎",
        "https://ark.cn-beijing.volces.com/api/v3",
        "volcengine_ark_v1",
    ),
    (
        // Seedance 2.5 RD 网关（new-api 内核）：视频生成走 `POST /v1/video/generations`，
        // 请求体为顶层 `model`/`prompt`/`duration`/`ratio`/`resolution`/`generate_audio`
        // 与顶层媒体数组 `images`/`reference_videos`/`reference_audios`/`start_frame`/
        // `end_frame`；本地素材经免费的 `POST /v1/assets/uploads` 换取公网 URL 后提交。
        // 该网关没有素材库浏览接口，素材库仍使用本地素材与本地生成结果。
        //
        // 上游就是文档声明的明文 HTTP 直连 IP（无域名、无 TLS），
        // 与文档保持一致使用 `http://101.34.211.152/`。
        // 契约详见 `docs/integrations/rd-video-api.md`。
        "provider-rd-api",
        "RD API",
        "http://101.34.211.152/",
        "moyu_v1",
    ),
    (
        // Grsai 图片生成 API（gpt-image-2 系列，https://qmy27nhsd9.apifox.cn/452409160e0.md）：
        // 文生图与图生图共用 `POST /v1/api/generate`（`replyType: async` 换任务号，
        // `aspectRatio` 收比例或像素值），结果轮询 `GET /v1/api/result?id=`；
        // 参考图走顶层 `images` 数组（公网 URL 或 base64 data URI）。该平台没有模型
        // 目录接口，「拉取模型」返回文档列明的固定清单；没有素材库。
        // 契约详见 `docs/integrations/grsai-image-api.md`。
        "provider-grsai",
        "Grsai",
        "https://grsaiapi.com/",
        "grsai_v1",
    ),
    (
        // Atlas Cloud 模型生成 API：出图走 `POST /api/v1/model/generateImage`，
        // 出视频走 `POST /api/v1/model/generateVideo`，两者都用
        // `GET /api/v1/model/prediction/{id}` 轮询；平台回答套一层 `data` 信封。
        // 参考图走顶层数组（出图 `image_urls` / 出视频 `reference_images`，
        // 公网 URL 或 base64 data URI）。该平台没有公开的模型目录接口，
        // 「拉取模型」返回已登记的固定清单；没有素材库。
        // 契约详见 `docs/integrations/atlascloud-image-api.md` 与
        // `docs/integrations/atlascloud-vidu-video-api.md`。
        "provider-atlascloud",
        "Atlas Cloud",
        "https://api.atlascloud.ai",
        "atlascloud_v1",
    ),
];

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TaskExecutionRecord {
    pub id: String,
    pub operation: GenerationOperation,
    pub status: GenerationTaskStatus,
    pub provider_connection_id: String,
    pub provider_display_name_snapshot: String,
    pub adapter_id_snapshot: String,
    pub base_url_snapshot: String,
    pub api_key_ref_snapshot: String,
    pub model_definition_id: String,
    pub remote_model_id_snapshot: Option<String>,
    pub remote_task_id: Option<String>,
    pub logical_request: Value,
    pub resolved_request: Option<Value>,
}

pub struct NewTask<'a> {
    pub id: &'a str,
    pub canvas_id: &'a str,
    pub source_node_id: &'a str,
    pub operation: GenerationOperation,
    pub provider: &'a ProviderConnection,
    /// 任务实际使用的密钥引用：模型绑定了令牌分组时是该分组的凭据，
    /// 否则为供应商主 API Key（即 provider.api_key_ref）。
    pub api_key_ref: &'a str,
    pub model_definition_id: &'a str,
    pub remote_model_id: Option<&'a str>,
    pub logical_request: &'a Value,
}

pub struct Storage {
    connection: Mutex<Connection>,
}

impl Storage {
    pub fn open(path: &Path) -> BackendResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(path)?;
        connection.pragma_update(None, "encoding", "UTF-8")?;
        let database_encoding: String =
            connection.query_row("PRAGMA encoding", [], |row| row.get(0))?;
        if !database_encoding.eq_ignore_ascii_case("UTF-8") {
            return Err(BackendError::Conflict(format!(
                "database encoding must be UTF-8, but SQLite reported {database_encoding}"
            )));
        }
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(SCHEMA)?;
        connection.execute_batch(brand_models::SCHEMA)?;
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            params![now_ms()],
        )?;
        migrate_generation_tasks_tokens(&connection)?;
        migrate_provider_token_groups(&connection)?;
        migrate_staging_jobs_adjustment(&connection)?;
        migrate_staging_jobs_overseas_db_id(&connection)?;
        migrate_staging_jobs_overseas_submitted_at(&connection)?;
        migrate_staging_jobs_cleanup_retry(&connection)?;
        migrate_remove_panqu_provider_connections(&connection)?;
        migrate_local_base64_asset_groups(&connection)?;
        migrate_provider_calls_dispatch_failed(&connection)?;

        let storage = Self {
            connection: Mutex::new(connection),
        };
        storage.seed_model_definitions()?;
        storage.seed_default_provider_connections()?;
        storage.migrate_legacy_model_bindings()?;
        storage.repair_malformed_model_definitions()?;
        storage.backfill_legacy_local_asset_targets()?;
        Ok(storage)
    }

    /// Older local-asset rows did not retain the bucket they were uploaded to.
    /// Bind them once to the configuration present at upgrade time. The
    /// migration marker prevents a later bucket switch from reassigning them.
    fn backfill_legacy_local_asset_targets(&self) -> BackendResult<()> {
        let config = self.get_tos_config()?;
        let config_json = config.as_ref().map(serde_json::to_string).transpose()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let already_migrated: i64 = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 2)",
            [],
            |row| row.get(0),
        )?;
        if already_migrated == 0 {
            if let (Some(config), Some(config_json)) = (config.as_ref(), config_json) {
                let scope = format!("{}:{}:{}", config.bucket, config.region, config.endpoint);
                let scope_hash = hex::encode(Sha256::digest(scope.as_bytes()));
                let old_rows: Vec<(String, String)> = {
                    let mut statement = transaction.prepare(
                        "SELECT jobs.id, jobs.object_key FROM staging_jobs jobs
                         LEFT JOIN staging_object_targets targets ON targets.job_id = jobs.id
                         WHERE jobs.purpose = 'local_asset' AND jobs.import_target_json IS NULL
                           AND jobs.status = 'staged' AND jobs.object_key IS NOT NULL
                           AND targets.job_id IS NULL",
                    )?;
                    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                    rows.collect::<Result<_, _>>()?
                };
                for (job_id, object_key) in old_rows {
                    // Application-generated keys encode their original bucket.
                    // Keep a provably different bucket unassigned instead of
                    // falsely relabeling it after a settings change.
                    if app_object_scope_hash(&object_key)
                        .is_some_and(|hash| hash != &scope_hash[..16])
                    {
                        continue;
                    }
                    transaction.execute(
                        "INSERT INTO staging_object_targets (job_id, config_json) VALUES (?1, ?2)",
                        params![job_id, config_json],
                    )?;
                }
            }
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?1)",
                params![now_ms()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn lock(&self) -> BackendResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|error| {
            BackendError::Conflict(format!("database mutex was poisoned: {error}"))
        })
    }

    fn seed_model_definitions(&self) -> BackendResult<()> {
        let models = [
            (
                "moyu-text-to-image-default",
                "Moyu 默认图片模型",
                None,
                default_model_schema(
                    "moyu-text-to-image-default",
                    &[GenerationOperation::TextToImage],
                ),
            ),
            (
                "gpt-image-2",
                "GPT Image 2 图生图",
                Some("gpt-image-2"),
                default_model_schema("gpt-image-2", &[GenerationOperation::ImageToImage]),
            ),
            (
                "doubao-seedance-2-0-260128",
                "Seedance 2.0",
                Some("doubao-seedance-2-0-260128"),
                default_model_schema(
                    "doubao-seedance-2-0-260128",
                    &[GenerationOperation::VideoGeneration],
                ),
            ),
            (
                "doubao-seedance-2-0-fast-260128",
                "Seedance 2.0 Fast",
                Some("doubao-seedance-2-0-fast-260128"),
                default_model_schema(
                    "doubao-seedance-2-0-fast-260128",
                    &[GenerationOperation::VideoGeneration],
                ),
            ),
            (
                "doubao-seedance-2-0-mini-260615",
                "Seedance 2.0 Mini",
                Some("doubao-seedance-2-0-mini-260615"),
                default_model_schema(
                    "doubao-seedance-2-0-mini-260615",
                    &[GenerationOperation::VideoGeneration],
                ),
            ),
            (
                "doubao-seedance-2-5-260628",
                "Seedance 2.5",
                Some("doubao-seedance-2-5-260628"),
                default_model_schema(
                    "doubao-seedance-2-5-260628",
                    &[GenerationOperation::VideoGeneration],
                ),
            ),
        ];

        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        for (id, display_name, remote_model_id, operations) in models {
            transaction.execute(
                "INSERT INTO model_definitions
                 (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   display_name = excluded.display_name,
                   remote_model_id = excluded.remote_model_id,
                   operations_json = excluded.operations_json,
                   updated_at = excluded.updated_at",
                params![
                    id,
                    display_name,
                    remote_model_id,
                    serde_json::to_string(&operations)?,
                    timestamp
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn seed_default_provider_connections(&self) -> BackendResult<()> {
        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        for (id, display_name, base_url, adapter_id) in DEFAULT_PROVIDER_CONNECTIONS {
            transaction.execute(
                "INSERT OR IGNORE INTO provider_connections
                 (id, display_name, adapter_id, base_url, api_key_ref, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?4, ?3, ?5, 0, ?6, ?6)",
                params![
                    id,
                    display_name,
                    base_url,
                    adapter_id,
                    format!("provider:{id}:api-key"),
                    timestamp
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// 把历史版本遗留的裸模型 ID 绑定一次性迁移为规范作用域 ID
    /// （`remote::{provider_connection_id}::{remote_model_id}`）。
    ///
    /// 早期版本允许把远程模型 ID 直接当作模型定义 ID 保存，前端恢复已保存模型时会把
    /// 这种裸 ID 原样回传给 `replace_provider_model_bindings`，触发后端
    /// 「selected model definition must be scoped to its provider connection」校验失败。
    /// 迁移只重写 provider_model_bindings 指向的模型定义 ID，并同步创建/更新对应作用域
    /// definition（保留旧 definition 行以避免破坏生成任务快照等历史引用）。
    fn migrate_legacy_model_bindings(&self) -> BackendResult<()> {
        let bindings = self.list_bindings(None)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let timestamp = now_ms();
        for binding in bindings {
            let Some(remote_model_id) = binding.remote_model_id.as_deref() else {
                continue;
            };
            let expected_id = provider_scoped_model_definition_id(
                &binding.provider_connection_id,
                remote_model_id,
            );
            if binding.model_definition_id == expected_id {
                continue;
            }
            let old_definition: Option<(String, String)> = transaction
                .query_row(
                    "SELECT display_name, operations_json FROM model_definitions WHERE id = ?1",
                    params![binding.model_definition_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (display_name, operations_json) =
                old_definition.unwrap_or_else(|| (remote_model_id.to_string(), "{}".to_string()));
            transaction.execute(
                "INSERT INTO model_definitions
                 (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   display_name = excluded.display_name,
                   remote_model_id = excluded.remote_model_id,
                   operations_json = excluded.operations_json,
                   updated_at = excluded.updated_at",
                params![
                    expected_id,
                    display_name,
                    remote_model_id,
                    operations_json,
                    timestamp,
                ],
            )?;
            transaction.execute(
                "UPDATE provider_model_bindings
                 SET model_definition_id = ?1, updated_at = ?2
                 WHERE provider_connection_id = ?3 AND model_definition_id = ?4",
                params![
                    expected_id,
                    timestamp,
                    binding.provider_connection_id,
                    binding.model_definition_id,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// 模型定义使用的请求方言：由引用它的供应商连接的适配器决定。
    ///
    /// 没有任何绑定（预置定义）或同时被不同方言的连接引用时，映射里没有这一项，
    /// 调用方按规范（OpenAI 兼容）方言处理。魔芋之类的聚合网关仍是 `moyu_v1`
    /// 适配器，方言为 OpenAI 兼容；只有方舟连接会得到原生方言。
    fn model_definition_dialects(&self) -> BackendResult<BTreeMap<String, RequestDialect>> {
        let adapters = self
            .list_provider_connections()?
            .into_iter()
            .map(|provider| (provider.id, provider.adapter_id))
            .collect::<BTreeMap<_, _>>();
        let mut dialects: BTreeMap<String, RequestDialect> = BTreeMap::new();
        let mut conflicting: BTreeMap<String, bool> = BTreeMap::new();
        for binding in self.list_bindings(None)? {
            let Some(adapter_id) = adapters.get(&binding.provider_connection_id) else {
                continue;
            };
            let dialect = RequestDialect::for_adapter(adapter_id);
            match dialects.get(&binding.model_definition_id) {
                Some(existing) if *existing != dialect => {
                    conflicting.insert(binding.model_definition_id.clone(), true);
                }
                Some(_) => {}
                None => {
                    dialects.insert(binding.model_definition_id.clone(), dialect);
                }
            }
        }
        for (definition_id, _) in conflicting {
            dialects.remove(&definition_id);
        }
        Ok(dialects)
    }

    /// 修复历史版本遗留的畸形操作 Schema。
    ///
    /// 早期版本曾把操作条目写成只含 `resultType`、缺失 `parameters` /
    /// `requestProfileId` / `request` 的形状（例如
    /// `{ video_generation: { resultType: "video" } }`）。`validate_schema_for_operations`
    /// 要求每个操作条目都带合法的 `parameters` 对象，否则保存会抛出
    /// 「model operation parameters must be a JSON object」。本迁移用规范 Schema 兜底补齐
    /// 缺失字段，保证已落库的定义可直接通过校验，也避免前端回读后再次原样回传畸形数据。
    ///
    /// 同时把历史版本持久化的 gpt-image 文生图旧默认参数（dall-e 契约的
    /// `standard`/`hd` 质量与 dall-e 尺寸）刷新为当前默认值——供应商对 gpt-image
    /// 系列会以 HTTP 400 拒绝旧值。
    ///
    /// 同时清理历史遗留的非法作用域 ID（形如 `remote::{model}` 而非
    /// `remote::{provider}::{model}`）——这些行没有任何绑定引用，且 ID 不合法，会污染定义列表。
    fn repair_malformed_model_definitions(&self) -> BackendResult<()> {
        let definitions = self.list_model_definitions()?;
        let dialects = self.model_definition_dialects()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let timestamp = now_ms();
        for definition in definitions {
            let operations = operations_from_schema(&definition.operations);
            if operations.is_empty() {
                continue;
            }
            let identity = definition
                .remote_model_id
                .clone()
                .unwrap_or_else(|| definition.id.clone());
            // 绑定到某个连接的模型按该连接的方言落定端点；其余定义（预置定义、
            // 已无绑定的孤儿）没有连接上下文，按规范方言处理。
            let dialect = dialects
                .get(&definition.id)
                .copied()
                .unwrap_or(RequestDialect::OpenAiCompatible);
            let mut repaired = schema_for_enabled_operations(
                &definition.operations,
                &identity,
                &operations,
                dialect,
            );
            refresh_legacy_image_parameter_defaults(&mut repaired, &identity);
            refresh_gemini_image_parameter_defaults(&mut repaired, &identity);
            if repaired != definition.operations {
                transaction.execute(
                    "UPDATE model_definitions SET operations_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![serde_json::to_string(&repaired)?, timestamp, definition.id],
                )?;
            }
        }
        transaction.execute(
            "DELETE FROM model_definitions
             WHERE id LIKE 'remote::%' AND id NOT LIKE 'remote::%::%'
               AND id NOT IN (SELECT model_definition_id FROM provider_model_bindings)",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_provider_connection(
        &self,
        command: &UpsertProviderConnectionCommand,
    ) -> BackendResult<ProviderConnection> {
        let timestamp = now_ms();
        let api_key_ref = format!("provider:{}:api-key", command.id);
        self.lock()?.execute(
            "INSERT INTO provider_connections
             (id, display_name, adapter_id, base_url, api_key_ref, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET
               display_name = excluded.display_name,
               adapter_id = excluded.adapter_id,
               base_url = excluded.base_url,
               enabled = excluded.enabled,
               updated_at = excluded.updated_at",
            params![
                command.id,
                command.display_name,
                command.adapter_id,
                command.base_url,
                api_key_ref,
                command.enabled,
                timestamp
            ],
        )?;
        self.get_provider_connection(&command.id)
    }

    pub fn get_provider_connection(&self, id: &str) -> BackendResult<ProviderConnection> {
        self.lock()?
            .query_row(
                "SELECT id, display_name, adapter_id, base_url, api_key_ref, enabled,
                        created_at, updated_at
                 FROM provider_connections WHERE id = ?1",
                params![id],
                provider_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("provider connection {id}")))
    }

    pub fn list_provider_connections(&self) -> BackendResult<Vec<ProviderConnection>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, display_name, adapter_id, base_url, api_key_ref, enabled,
                    created_at, updated_at
             FROM provider_connections ORDER BY display_name COLLATE NOCASE, id",
        )?;
        let rows = statement.query_map([], provider_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_model_definitions(&self) -> BackendResult<Vec<ModelDefinition>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, display_name, remote_model_id, operations_json, created_at, updated_at
             FROM model_definitions ORDER BY display_name COLLATE NOCASE, id",
        )?;
        let rows = statement.query_map([], |row| {
            let operations: String = row.get(3)?;
            Ok(ModelDefinition {
                id: row.get(0)?,
                display_name: row.get(1)?,
                remote_model_id: row.get(2)?,
                operations: parse_json_column(operations)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_binding(
        &self,
        provider_connection_id: &str,
        model_definition_id: &str,
    ) -> BackendResult<ProviderModelBinding> {
        self.lock()?
            .query_row(
                "SELECT provider_connection_id, model_definition_id, enabled_operations_json,
                        remote_model_id, enabled, token_group, created_at, updated_at
                 FROM provider_model_bindings
                 WHERE provider_connection_id = ?1 AND model_definition_id = ?2",
                params![provider_connection_id, model_definition_id],
                binding_from_row,
            )
            .optional()?
            .ok_or_else(|| {
                BackendError::NotFound(format!(
                    "provider/model binding {provider_connection_id}/{model_definition_id}"
                ))
            })
    }

    pub fn list_bindings(
        &self,
        provider_connection_id: Option<&str>,
    ) -> BackendResult<Vec<ProviderModelBinding>> {
        let connection = self.lock()?;
        let sql = if provider_connection_id.is_some() {
            "SELECT provider_connection_id, model_definition_id, enabled_operations_json,
                    remote_model_id, enabled, token_group, created_at, updated_at
             FROM provider_model_bindings WHERE provider_connection_id = ?1
             ORDER BY model_definition_id"
        } else {
            "SELECT provider_connection_id, model_definition_id, enabled_operations_json,
                    remote_model_id, enabled, token_group, created_at, updated_at
             FROM provider_model_bindings ORDER BY provider_connection_id, model_definition_id"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = if let Some(id) = provider_connection_id {
            statement.query_map(params![id], binding_from_row)?
        } else {
            statement.query_map([], binding_from_row)?
        };
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn replace_provider_model_bindings(
        &self,
        command: &ReplaceProviderModelBindingsCommand,
    ) -> BackendResult<Vec<ProviderModelBinding>> {
        // 端点属于供应商连接：保存模型时按本连接的适配器把请求契约落到对应方言上。
        let dialect = RequestDialect::for_adapter(
            &self
                .get_provider_connection(&command.provider_connection_id)?
                .adapter_id,
        );

        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE provider_model_bindings
             SET enabled = 0, updated_at = ?2
             WHERE provider_connection_id = ?1",
            params![command.provider_connection_id, timestamp],
        )?;

        for selection in &command.selections {
            let operation_schema = if selection.enabled {
                schema_for_enabled_operations(
                    &selection.operation_schema,
                    &selection.remote_model_id,
                    &selection.enabled_operations,
                    dialect,
                )
            } else {
                selection.operation_schema.clone()
            };
            transaction.execute(
                "INSERT INTO model_definitions
                 (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   display_name = excluded.display_name,
                   remote_model_id = excluded.remote_model_id,
                   operations_json = excluded.operations_json,
                   updated_at = excluded.updated_at",
                params![
                    selection.model_definition_id,
                    selection.display_name,
                    selection.remote_model_id,
                    serde_json::to_string(&operation_schema)?,
                    timestamp,
                ],
            )?;

            let mut operations = selection
                .enabled_operations
                .iter()
                // 契约里不存在的操作不能留在绑定上：方言按模型家族删掉了某个操作
                // （例如 Atlas Cloud 的编辑成员没有文生图形态）时，绑定若仍声称
                // 支持它，任务开始只会报一句「模型定义未声明该操作」。这里以最终
                // 契约为准，把这类操作一起去掉。
                .filter(|operation| operation_schema.get(operation.as_str()).is_some())
                .map(|operation| operation.as_str())
                .collect::<Vec<_>>();
            operations.sort_unstable();
            operations.dedup();
            let enabled = selection.enabled && !operations.is_empty();
            transaction.execute(
                "INSERT INTO provider_model_bindings
                 (provider_connection_id, model_definition_id, enabled_operations_json,
                  remote_model_id, enabled, token_group, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(provider_connection_id, model_definition_id) DO UPDATE SET
                   enabled_operations_json = excluded.enabled_operations_json,
                   remote_model_id = excluded.remote_model_id,
                   enabled = excluded.enabled,
                   token_group = excluded.token_group,
                   updated_at = excluded.updated_at",
                params![
                    command.provider_connection_id,
                    selection.model_definition_id,
                    serde_json::to_string(&operations)?,
                    selection.remote_model_id,
                    enabled,
                    selection.token_group,
                    timestamp,
                ],
            )?;
        }
        transaction.commit()?;
        drop(connection);

        self.list_bindings(Some(&command.provider_connection_id))
    }

    /// 供应商连接下的令牌分组（同一供应商内按令牌区分模型的凭据作用域）。
    pub fn list_provider_token_groups(
        &self,
        provider_connection_id: &str,
    ) -> BackendResult<Vec<ProviderTokenGroup>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, provider_connection_id, group_name, credential_ref, enabled,
                    created_at, updated_at
             FROM provider_token_groups WHERE provider_connection_id = ?1
             ORDER BY group_name COLLATE NOCASE",
        )?;
        let rows = statement.query_map(
            params![provider_connection_id],
            provider_token_group_from_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_provider_token_group(
        &self,
        provider_connection_id: &str,
        group_name: &str,
    ) -> BackendResult<Option<ProviderTokenGroup>> {
        self.lock()?
            .query_row(
                "SELECT id, provider_connection_id, group_name, credential_ref, enabled,
                        created_at, updated_at
                 FROM provider_token_groups
                 WHERE provider_connection_id = ?1 AND group_name = ?2",
                params![provider_connection_id, group_name],
                provider_token_group_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// 新增或更新令牌分组。以 `(provider_connection_id, group_name)` 为键：
    /// 已存在则更新 enabled 并保留原凭据引用；不存在则生成稳定 id 与凭据引用。
    /// 分组密钥本身不落库，由命令层在返回后用 `set_credential` 写入凭据管理器。
    pub fn upsert_provider_token_group(
        &self,
        command: &UpsertProviderTokenGroupCommand,
    ) -> BackendResult<ProviderTokenGroup> {
        let group_name = command.group_name.trim();
        if group_name.is_empty() {
            return Err(BackendError::Validation {
                message: "token group name cannot be empty".into(),
                details: json!({ "field": "group_name" }),
            });
        }
        if group_name.len() > 64 {
            return Err(BackendError::Validation {
                message: "token group name must be at most 64 characters".into(),
                details: json!({ "field": "group_name" }),
            });
        }
        self.get_provider_connection(&command.provider_connection_id)?;

        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let existing: Option<ProviderTokenGroup> = transaction
            .query_row(
                "SELECT id, provider_connection_id, group_name, credential_ref, enabled,
                        created_at, updated_at
                 FROM provider_token_groups
                 WHERE provider_connection_id = ?1 AND group_name = ?2",
                params![command.provider_connection_id, group_name],
                provider_token_group_from_row,
            )
            .optional()?;
        let group = if let Some(existing) = existing {
            transaction.execute(
                "UPDATE provider_token_groups
                 SET enabled = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![command.enabled, timestamp, existing.id],
            )?;
            ProviderTokenGroup {
                id: existing.id,
                provider_connection_id: existing.provider_connection_id,
                group_name: existing.group_name,
                credential_ref: existing.credential_ref,
                enabled: command.enabled,
                created_at: existing.created_at,
                updated_at: timestamp,
            }
        } else {
            let id = format!("token-group-{}", Uuid::new_v4());
            let credential_ref =
                format!("provider:{}:token:{}", command.provider_connection_id, id);
            transaction.execute(
                "INSERT INTO provider_token_groups
                 (id, provider_connection_id, group_name, credential_ref, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    id,
                    command.provider_connection_id,
                    group_name,
                    credential_ref,
                    command.enabled,
                    timestamp,
                ],
            )?;
            ProviderTokenGroup {
                id,
                provider_connection_id: command.provider_connection_id.clone(),
                group_name: group_name.to_string(),
                credential_ref,
                enabled: command.enabled,
                created_at: timestamp,
                updated_at: timestamp,
            }
        };
        transaction.commit()?;
        Ok(group)
    }

    /// 删除令牌分组，返回被删行的凭据引用（供命令层 best-effort 清理密钥）。
    pub fn delete_provider_token_group(
        &self,
        provider_connection_id: &str,
        group_name: &str,
    ) -> BackendResult<Option<String>> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let credential_ref: Option<String> = transaction
            .query_row(
                "SELECT credential_ref FROM provider_token_groups
                 WHERE provider_connection_id = ?1 AND group_name = ?2",
                params![provider_connection_id, group_name],
                |row| row.get(0),
            )
            .optional()?;
        if credential_ref.is_some() {
            transaction.execute(
                "DELETE FROM provider_token_groups
                 WHERE provider_connection_id = ?1 AND group_name = ?2",
                params![provider_connection_id, group_name],
            )?;
            // 被删除分组的模型绑定回到供应商默认令牌（主 API Key）。
            transaction.execute(
                "UPDATE provider_model_bindings
                 SET token_group = NULL, updated_at = ?1
                 WHERE provider_connection_id = ?2 AND token_group = ?3",
                params![now_ms(), provider_connection_id, group_name],
            )?;
        }
        transaction.commit()?;
        Ok(credential_ref)
    }

    /// 解析模型调用应使用的密钥引用：
    /// `token_group = None` 返回供应商主 API Key；`Some(name)` 返回对应分组凭据引用。
    /// 分组不存在时报错，避免任务静默退回主密钥造成与用户配置不符的调用。
    pub fn resolve_binding_credential_ref(
        &self,
        provider_connection_id: &str,
        token_group: Option<&str>,
    ) -> BackendResult<String> {
        let Some(token_group) = token_group else {
            let provider = self.get_provider_connection(provider_connection_id)?;
            return Ok(provider.api_key_ref);
        };
        let group = self.get_provider_token_group(provider_connection_id, token_group)?;
        group.map(|group| group.credential_ref).ok_or_else(|| {
            BackendError::Conflict(format!(
                "token group {token_group:?} is not configured for provider {provider_connection_id}"
            ))
        })
    }

    fn insert_task(&self, task: NewTask<'_>) -> BackendResult<()> {
        let timestamp = now_ms();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        if let Some(source_task_id) = task
            .logical_request
            .get("seedanceDraftSourceTaskId")
            .and_then(Value::as_str)
        {
            let existing: Option<String> = transaction
                .query_row(
                    /*
                     * 阻断条件分两种「已发出请求」：
                     *   - 未取消的**在途**任务 → 一律阻断；
                     *   - 意外中断（interrupted）且已发出 → 阻断（自动流程不该再发一次）；
                     *   - **用户主动取消**且已发出 → 也阻断。
                     *
                     * 最后一条是本轮补的：取消只停**本机**的轮询与落盘，供应商侧的
                     * 任务仍在跑、仍会计费（应用自己的取消提示就写着「供应商侧可能仍计费」）。
                     * 若把已取消的一律放行，用户再点一次「提升为正片」就会**再提交一次**
                     * → 双倍扣费，而且第一个任务的产物再也回不来（取消后不再轮询）。
                     *
                     * 反过来，「取消但从未发出」的（发送前就取消）不阻断 —— 那没有任何
                     * 计费顾虑，重发是安全且必要的（否则用户陷入死路）。
                     *
                     * 「已发出」的判据是「sent_at 非空 **且** dispatch_failed = 0」：
                     * sent_at 是在 request.send() **之前**就写库的，所以 DNS 解析失败、
                     * 连接被拒这类**根本没送达上游**的请求同样带着 sent_at。只看 sent_at
                     * 会把「先失败、后被取消」的窄窗口任务误判成「供应商侧还在跑并计费」，
                     * 于是用户被永久挡死：提示「该草稿已有正片任务 X，请查询原任务」，
                     * 而那个任务既失败又被取消，永远不会有结果。
                     * dispatch_failed 只在**连接层**失败时置 1；「已送达上游但响应体读取
                     * 失败 / 返回 4xx / 返回 5xx」不算未发出（那些请求可能已经计费，
                     * 必须继续阻断）。
                     */
                    "SELECT id FROM generation_tasks
                 WHERE json_extract(logical_request_json, '$.seedanceDraftSourceTaskId') = ?1
                   AND status != 'failed'
                   AND (
                        status != 'cancelled'
                        OR remote_task_id IS NOT NULL
                        OR EXISTS (
                            SELECT 1 FROM provider_calls c WHERE c.task_id = generation_tasks.id
                              AND c.sent_at IS NOT NULL AND COALESCE(c.dispatch_failed, 0) = 0
                        )
                   )
                   AND (status != 'interrupted' OR remote_task_id IS NOT NULL OR EXISTS (
                       SELECT 1 FROM provider_calls c WHERE c.task_id = generation_tasks.id
                         AND c.sent_at IS NOT NULL AND COALESCE(c.dispatch_failed, 0) = 0
                   )) LIMIT 1",
                    params![source_task_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(task_id) = existing {
                return Err(BackendError::Conflict(format!(
                    "该草稿已有正片任务 {task_id}，请查询原任务，避免重复付费"
                )));
            }
        }
        transaction.execute(
            "INSERT INTO generation_tasks
             (id, canvas_id, source_node_id, operation, status, query_health,
              provider_connection_id, provider_display_name_snapshot, adapter_id_snapshot,
              base_url_snapshot, api_key_ref_snapshot, model_definition_id,
              remote_model_id_snapshot, logical_request_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'created', 'healthy', ?5, ?6, ?7, ?8, ?9,
                     ?10, ?11, ?12, ?13, ?13)",
            params![
                task.id,
                task.canvas_id,
                task.source_node_id,
                task.operation.as_str(),
                task.provider.id,
                task.provider.display_name,
                task.provider.adapter_id,
                task.provider.base_url,
                task.api_key_ref,
                task.model_definition_id,
                task.remote_model_id,
                serde_json::to_string(task.logical_request)?,
                timestamp
            ],
        )?;
        transaction.execute(
            "INSERT INTO generation_task_events(task_id, event_type, payload_json, created_at)
             VALUES (?1, 'created', ?2, ?3)",
            params![
                task.id,
                serde_json::to_string(&json!({ "status": "created" }))?,
                timestamp
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn seedance_draft_final_task_id(
        &self,
        source_task_id: &str,
    ) -> BackendResult<Option<String>> {
        /*
         * 「草稿对应的正片任务」——口径与上面的阻断条件**必须一致**：
         * 取消但已发出请求的正片仍然算「存在」（供应商侧还在跑并计费），
         * 否则会出现「查不到原任务、却也不阻断新提交」的组合 → 双倍扣费。
         *
         * 「已发出」同样按「sent_at 非空 且 dispatch_failed = 0」判定：连接层就失败、
         * 根本没送达上游的调用不算已发出（不可能计费），否则用户会被永久挡死。
         */
        Ok(self
            .lock()?
            .query_row(
                "SELECT id FROM generation_tasks
             WHERE json_extract(logical_request_json, '$.seedanceDraftSourceTaskId') = ?1
               AND status != 'failed'
               AND (
                    status != 'cancelled'
                    OR remote_task_id IS NOT NULL
                    OR EXISTS (
                        SELECT 1 FROM provider_calls c WHERE c.task_id = generation_tasks.id
                          AND c.sent_at IS NOT NULL AND COALESCE(c.dispatch_failed, 0) = 0
                    )
               )
               AND (status != 'interrupted' OR remote_task_id IS NOT NULL OR EXISTS (
                   SELECT 1 FROM provider_calls c WHERE c.task_id = generation_tasks.id
                     AND c.sent_at IS NOT NULL AND COALESCE(c.dispatch_failed, 0) = 0
               )) ORDER BY created_at DESC LIMIT 1",
                params![source_task_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn get_task_execution(&self, task_id: &str) -> BackendResult<TaskExecutionRecord> {
        self.lock()?
            .query_row(
                "SELECT id, operation, status, provider_connection_id,
                        provider_display_name_snapshot, adapter_id_snapshot, base_url_snapshot,
                        api_key_ref_snapshot, model_definition_id, remote_model_id_snapshot,
                        remote_task_id, logical_request_json, resolved_request_json
                 FROM generation_tasks WHERE id = ?1",
                params![task_id],
                |row| {
                    let operation: String = row.get(1)?;
                    let status: String = row.get(2)?;
                    let logical: String = row.get(11)?;
                    let resolved: Option<String> = row.get(12)?;
                    Ok(TaskExecutionRecord {
                        id: row.get(0)?,
                        operation: parse_operation(operation)?,
                        status: parse_task_status(status)?,
                        provider_connection_id: row.get(3)?,
                        provider_display_name_snapshot: row.get(4)?,
                        adapter_id_snapshot: row.get(5)?,
                        base_url_snapshot: row.get(6)?,
                        api_key_ref_snapshot: row.get(7)?,
                        model_definition_id: row.get(8)?,
                        remote_model_id_snapshot: row.get(9)?,
                        remote_task_id: row.get(10)?,
                        logical_request: parse_json_column(logical)?,
                        resolved_request: resolved.map(parse_json_column).transpose()?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("generation task {task_id}")))
    }

    pub fn get_result(
        &self,
        task_id: &str,
        result_index: u32,
    ) -> BackendResult<GenerationResultRecord> {
        self.lock()?
            .query_row(
                "SELECT task_id, result_index, media_type, remote_task_id, source_json,
                        save_status, final_path, relative_path, byte_size, mime_type, sha256,
                        saved_at, error_json,
                        (SELECT name FROM generation_result_names n WHERE n.task_id = generation_results.task_id AND n.result_index = generation_results.result_index)
                 FROM generation_results WHERE task_id = ?1 AND result_index = ?2",
                params![task_id, result_index],
                result_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("result {task_id}/{result_index}")))
    }

    fn mark_incomplete_results_interrupted(&self) -> BackendResult<Vec<GenerationResultRecord>> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let mut records = {
            let mut statement = transaction.prepare(
                "SELECT task_id, result_index, media_type, remote_task_id, source_json,
                        save_status, final_path, relative_path, byte_size, mime_type, sha256,
                        saved_at, error_json,
                        (SELECT name FROM generation_result_names n WHERE n.task_id = generation_results.task_id AND n.result_index = generation_results.result_index)
                 FROM generation_results
                 WHERE save_status IN ('pending', 'writing')
                 ORDER BY task_id, result_index",
            )?;
            statement
                .query_map([], result_from_row)?
                .collect::<Result<Vec<_>, _>>()?
        };
        for record in &mut records {
            let timestamp = now_ms();
            record.save_status = SaveStatus::Interrupted;
            record.error = Some(json!({
                "kind": "process_interrupted",
                "message": "application stopped while this local result was being saved"
            }));
            transaction.execute(
                "UPDATE generation_results
                 SET save_status = 'interrupted', error_json = ?3
                 WHERE task_id = ?1 AND result_index = ?2",
                params![
                    record.task_id,
                    record.result_index,
                    serde_json::to_string(&record.error)?
                ],
            )?;
            transaction.execute(
                "INSERT INTO generation_task_events(task_id, event_type, payload_json, created_at)
                 VALUES (?1, 'result_save_changed', ?2, ?3)",
                params![
                    record.task_id,
                    serde_json::to_string(&json!({
                        "resultIndex": record.result_index,
                        "saveStatus": record.save_status,
                        "error": record.error,
                    }))?,
                    timestamp,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(records)
    }

    pub fn last_successful_submit_response(&self, task_id: &str) -> BackendResult<String> {
        self.lock()?
            .query_row(
                "SELECT raw_response FROM provider_calls
                 WHERE task_id = ?1 AND phase = 'submit'
                   AND http_status BETWEEN 200 AND 299 AND raw_response IS NOT NULL
                 ORDER BY response_received_at DESC, rowid DESC LIMIT 1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                BackendError::NotFound(format!("successful submit response for task {task_id}"))
            })
    }

    pub fn save_canvas_document(
        &self,
        command: &SaveCanvasDocumentCommand,
    ) -> BackendResult<CanvasDocumentRecord> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT revision, created_at FROM canvas_documents WHERE id = ?1",
                params![command.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let current_revision = existing.map(|(revision, _)| revision).unwrap_or(0);
        if let Some(expected_revision) = command.expected_revision {
            let expected_revision = checked_sql_integer(expected_revision, "expectedRevision")?;
            if expected_revision != current_revision {
                /*
                 * 冲突文案必须是中文人话：这条会直接显示在画布的状态栏上，
                 * 英文 + 内部画布 id 对用户没有意义（画布 id 是机器内部标识）。
                 * 也要说清「怎么办」——多半是另一个实例同时改了同一张画布。
                 */
                return Err(BackendError::Conflict(format!(
                    "画布已在别处被修改（预期版本 {expected_revision}，当前版本 {current_revision}）。\
                     请关闭另一个正在打开这张画布的窗口后重试；若要保留本窗口的改动，\
                     请先复制画布内容再重新载入。"
                )));
            }
        }
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            BackendError::Conflict("画布版本号已超出上限，无法继续保存。".to_string())
        })?;
        let timestamp = now_ms();
        let created_at = existing
            .map(|(_, created_at)| created_at)
            .unwrap_or(timestamp);
        transaction.execute(
            "INSERT INTO canvas_documents
             (id, title, document_json, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               document_json = excluded.document_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![
                command.id,
                command.title,
                serde_json::to_string(&command.document)?,
                revision,
                created_at,
                timestamp
            ],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_canvas_document(&command.id)
    }

    pub fn get_canvas_document(&self, id: &str) -> BackendResult<CanvasDocumentRecord> {
        self.lock()?
            .query_row(
                "SELECT id, title, document_json, revision, created_at, updated_at
                 FROM canvas_documents WHERE id = ?1",
                params![id],
                canvas_document_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("canvas document {id}")))
    }

    pub fn list_canvas_documents(&self) -> BackendResult<Vec<CanvasDocumentSummary>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, title, revision, created_at, updated_at
             FROM canvas_documents ORDER BY updated_at DESC, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(CanvasDocumentSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                revision: nonnegative_integer(row, 2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_canvas_document(&self, id: &str) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        // 画布没了，在途生成任务不能继续向供应商轮询、继续把产物写进磁盘：
        // 同一个事务里把这些任务收敛成 cancelled 终态。
        // 已成功/已失败/已中断的历史任务保持原样，历史不能丢。
        cancel_canvas_generation_tasks(&transaction, id, now_ms())?;
        // 长视频主任务属于这个画布：画布删了还留着整份镜头清单（含提示词正文）就是纯粹的垃圾数据。
        transaction.execute(
            "DELETE FROM long_video_jobs WHERE canvas_id = ?1",
            params![id],
        )?;
        transaction.execute("DELETE FROM canvas_documents WHERE id = ?1", params![id])?;
        transaction.commit()?;
        Ok(())
    }

    /// 某个画布下仍在进行中的生成任务 ID。
    ///
    /// 画布删除时先用它置运行时取消位（让轮询尽快停下），
    /// 再由 [`Storage::delete_canvas_document`] 在同一个事务里落终态。
    pub fn list_nonterminal_task_ids_for_canvas(
        &self,
        canvas_id: &str,
    ) -> BackendResult<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id FROM generation_tasks
             WHERE canvas_id = ?1
               AND status IN ('created','submitting','retry_wait','queued','running')
             ORDER BY created_at",
        )?;
        let ids = statement
            .query_map(params![canvas_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn get_task_detail(&self, task_id: &str) -> BackendResult<GenerationTaskDetail> {
        let connection = self.lock()?;
        let summary = connection
            .query_row(
                &task_summary_sql("WHERE id = ?1"),
                params![task_id],
                task_summary_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("generation task {task_id}")))?;

        let (logical, resolved, final_error): (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT logical_request_json, resolved_request_json, final_error_json
                 FROM generation_tasks WHERE id = ?1",
                params![task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;

        let attempts = collect_rows(
            &connection,
            "SELECT id, task_id, attempt_number, phase, started_at, finished_at,
                    backoff_ms, outcome, error_json
             FROM generation_attempts WHERE task_id = ?1 ORDER BY started_at, attempt_number",
            task_id,
            attempt_from_row,
        )?;
        let calls = collect_rows(
            &connection,
            "SELECT id, task_id, attempt_id, phase, request_json, sent_at,
                    response_received_at, duration_ms, http_status, response_headers_json,
                    raw_response, runtime_error_json
             FROM provider_calls WHERE task_id = ?1 ORDER BY rowid",
            task_id,
            call_from_row,
        )?;
        let events = collect_rows(
            &connection,
            "SELECT id, task_id, event_type, payload_json, created_at
             FROM generation_task_events WHERE task_id = ?1 ORDER BY id",
            task_id,
            event_from_row,
        )?;
        let results = collect_rows(
            &connection,
            "SELECT task_id, result_index, media_type, remote_task_id, source_json,
                    save_status, final_path, relative_path, byte_size, mime_type, sha256,
                    saved_at, error_json,
                    (SELECT name FROM generation_result_names n WHERE n.task_id = generation_results.task_id AND n.result_index = generation_results.result_index)
             FROM generation_results WHERE task_id = ?1 ORDER BY result_index",
            task_id,
            result_from_row,
        )?;
        let text_output = events
            .iter()
            .rev()
            .find(|event| event.event_type == "text_output")
            .map(|event| {
                serde_json::from_value::<TextGenerationOutputRecord>(event.payload.clone())
            })
            .transpose()?;

        Ok(GenerationTaskDetail {
            summary,
            logical_request: parse_json_column(logical)?,
            resolved_request: resolved.map(parse_json_column).transpose()?,
            attempts,
            calls,
            events,
            results,
            text_output,
            final_error: final_error.map(parse_json_column).transpose()?,
        })
    }

    pub fn get_task_progress(&self, task_id: &str) -> BackendResult<GenerationTaskProgress> {
        let connection = self.lock()?;
        let summary = connection
            .query_row(
                &task_summary_sql("WHERE id = ?1"),
                params![task_id],
                task_summary_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("generation task {task_id}")))?;
        let final_error: Option<String> = connection.query_row(
            "SELECT final_error_json FROM generation_tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )?;
        let results = collect_rows(
            &connection,
            "SELECT task_id, result_index, media_type, save_status, final_path, error_json
             FROM generation_results WHERE task_id = ?1 ORDER BY result_index",
            task_id,
            progress_result_from_row,
        )?;
        Ok(GenerationTaskProgress {
            summary,
            results,
            final_error: final_error.map(parse_json_column).transpose()?,
        })
    }

    pub fn list_tasks(&self, query: &GenerationTaskListQuery) -> BackendResult<GenerationTaskPage> {
        validate_history_date_range(query.created_from, query.created_to)?;
        let limit = query.limit.clamp(1, 200) as i64;
        let sql = history_query::tasks(query, limit + 1)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(&sql.sql)?;
        let mut items = statement
            .query_map(params_from_iter(sql.parameters), task_summary_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > limit as usize {
            items.pop();
            items.last().map(|item| GenerationTaskCursor {
                created_at: item.created_at,
                id: item.id.clone(),
            })
        } else {
            None
        };
        Ok(GenerationTaskPage { items, next_cursor })
    }

    /// Naming metadata is independent of the result lifecycle and its immutable media path.
    pub fn rename_generation_result(
        &self,
        task_id: &str,
        result_index: u32,
        name: &str,
    ) -> BackendResult<()> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
            return Err(BackendError::validation(
                "产物文件名须为 1–128 个字符",
                json!({}),
            ));
        }
        let record = self.get_result(task_id, result_index)?;
        if record.final_path.is_none() || record.save_status != SaveStatus::Succeeded {
            return Err(BackendError::Conflict("请等待产物保存成功后再命名".into()));
        }
        self.lock()?.execute(
            "INSERT INTO generation_result_names(task_id, result_index, name) VALUES (?1, ?2, ?3)
             ON CONFLICT(task_id, result_index) DO UPDATE SET name = excluded.name",
            params![task_id, result_index, name],
        )?;
        Ok(())
    }

    pub fn list_nonterminal_tasks(&self) -> BackendResult<Vec<TaskExecutionRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id FROM generation_tasks
             WHERE status IN ('created','submitting','retry_wait','queued','running')
             ORDER BY created_at",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        ids.iter().map(|id| self.get_task_execution(id)).collect()
    }

    pub fn save_tos_config(&self, config: &TosStagingConfig) -> BackendResult<()> {
        self.lock()?.execute(
            "INSERT INTO application_settings(key, value_json, updated_at)
             VALUES ('tos_staging', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![serde_json::to_string(config)?, now_ms()],
        )?;
        Ok(())
    }

    pub fn get_tos_config(&self) -> BackendResult<Option<TosStagingConfig>> {
        let value = self
            .lock()?
            .query_row(
                "SELECT value_json FROM application_settings WHERE key = 'tos_staging'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value {
            Some(value) => match parse_stored_tos_config(&value) {
                Some(config) => {
                    if serde_json::from_str::<TosStagingConfig>(&value).is_err()
                        && !config.bucket.trim().is_empty()
                    {
                        // 把还能认出桶名的旧行改写成现行字段，避免下次启动再走恢复分支。
                        if let Err(error) = self.save_tos_config(&config) {
                            tauri_plugin_log::log::warn!(
                                "[staging] 已恢复旧版 TOS 配置但未能回写: {error}"
                            );
                        }
                    }
                    Ok(Some(config))
                }
                None => {
                    tauri_plugin_log::log::warn!("[staging] 无法解析 TOS 配置，按未配置处理");
                    Ok(None)
                }
            },
            None => Ok(None),
        }
    }

    const WORKSPACE_UI_SETTING_KEY: &'static str = "workspace_ui";

    pub fn save_workspace_ui_prefs(&self, prefs: &WorkspaceUiPrefs) -> BackendResult<()> {
        let mut merged = self.get_workspace_ui_prefs()?;
        /*
         * 合并语义：字段为 None 表示「不改这一项」。
         *
         * 前端把要清空的偏好显式发成 null，而 null 在 Rust 侧就是 None，
         * 于是「清空已选供应商」这条路走不通（要新增显式清空通道才能支持）。
         * 这里保持既有语义不变，只把新增的两个字段一并接上——它们与另外两项
         * 的行为必须一致，否则创作台「记住上次创作类型/模型」会静默失效。
         */
        if prefs.active_asset_provider_id.is_some() {
            merged.active_asset_provider_id = prefs.active_asset_provider_id.clone();
        }
        if prefs.asset_library_source.is_some() {
            merged.asset_library_source = prefs.asset_library_source.clone();
        }
        if prefs.creation_mode.is_some() {
            merged.creation_mode = prefs.creation_mode.clone();
        }
        if prefs.creation_model_definition_id.is_some() {
            merged.creation_model_definition_id = prefs.creation_model_definition_id.clone();
        }
        self.lock()?.execute(
            "INSERT INTO application_settings(key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![
                Self::WORKSPACE_UI_SETTING_KEY,
                serde_json::to_string(&merged)?,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn get_workspace_ui_prefs(&self) -> BackendResult<WorkspaceUiPrefs> {
        let value = self
            .lock()?
            .query_row(
                "SELECT value_json FROM application_settings WHERE key = ?1",
                params![Self::WORKSPACE_UI_SETTING_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value {
            Some(value) => Ok(serde_json::from_str(&value).unwrap_or_default()),
            None => Ok(WorkspaceUiPrefs::default()),
        }
    }

    pub fn insert_staging_job(&self, job: &StagingJobRecord) -> BackendResult<()> {
        let bytes_total = job
            .bytes_total
            .map(|value| checked_sql_integer(value, "bytesTotal"))
            .transpose()?;
        let bytes_uploaded = checked_sql_integer(job.bytes_uploaded, "bytesUploaded")?;
        let overseas_db_id = job
            .overseas_db_id
            .map(|value| checked_sql_integer(value, "overseasDbId"))
            .transpose()?;
        self.lock()?.execute(
            "INSERT INTO staging_jobs
             (id, local_path, purpose, media_type, object_key, status, bytes_total,
              bytes_uploaded, asset_id, import_target_json, error_json, created_at, updated_at,
              adjustment, overseas_db_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                job.id,
                job.local_path,
                job.purpose,
                job.media_type.as_str(),
                job.object_key,
                job.status.as_str(),
                bytes_total,
                bytes_uploaded,
                job.asset_id,
                job.import_target
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                job.error.as_ref().map(serde_json::to_string).transpose()?,
                job.created_at,
                job.updated_at,
                job.adjustment,
                overseas_db_id
            ],
        )?;
        Ok(())
    }

    pub fn remember_staging_object_target(
        &self,
        job_id: &str,
        config: &TosStagingConfig,
    ) -> BackendResult<()> {
        self.lock()?.execute(
            "INSERT OR REPLACE INTO staging_object_targets (job_id, config_json) VALUES (?1, ?2)",
            params![job_id, serde_json::to_string(config)?],
        )?;
        Ok(())
    }

    pub fn get_staging_object_target(
        &self,
        job_id: &str,
    ) -> BackendResult<Option<TosStagingConfig>> {
        let raw: Option<String> = self
            .lock()?
            .query_row(
                "SELECT config_json FROM staging_object_targets WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn find_staging_content(
        &self,
        scope: &str,
        media_type: MediaType,
        byte_size: u64,
        sha256: &str,
    ) -> BackendResult<Option<StagingJobRecord>> {
        let byte_size = checked_sql_integer(byte_size, "byteSize")?;
        let job_id: Option<String> = self
            .lock()?
            .query_row(
                "SELECT job_id FROM staging_content_index
             WHERE scope = ?1 AND media_type = ?2 AND byte_size = ?3 AND sha256 = ?4",
                params![scope, media_type.as_str(), byte_size, sha256],
                |row| row.get(0),
            )
            .optional()?;
        job_id.map(|id| self.get_staging_job(&id)).transpose()
    }

    pub fn list_unindexed_completed_staging_jobs(
        &self,
        media_type: MediaType,
    ) -> BackendResult<Vec<StagingJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs
             WHERE media_type = ?1
               AND ((purpose = 'local_asset' AND import_target_json IS NULL AND status = 'staged')
                 OR (purpose = 'asset_import' AND import_target_json IS NOT NULL
                     AND asset_id IS NOT NULL AND status IN ('active', 'cleaned')))
               AND id NOT IN (SELECT job_id FROM staging_content_index)
               AND id NOT IN (SELECT job_id FROM staging_content_reuses)
             ORDER BY created_at, id",
        )?;
        statement
            .query_map(params![media_type.as_str()], staging_job_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn remember_staging_content(
        &self,
        scope: &str,
        media_type: MediaType,
        byte_size: u64,
        sha256: &str,
        job_id: &str,
    ) -> BackendResult<()> {
        let byte_size = checked_sql_integer(byte_size, "byteSize")?;
        self.lock()?.execute(
            "INSERT OR IGNORE INTO staging_content_index
             (scope, media_type, byte_size, sha256, job_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![scope, media_type.as_str(), byte_size, sha256, job_id],
        )?;
        Ok(())
    }

    pub fn forget_staging_content(
        &self,
        scope: &str,
        media_type: MediaType,
        byte_size: u64,
        sha256: &str,
    ) -> BackendResult<()> {
        let byte_size = checked_sql_integer(byte_size, "byteSize")?;
        self.lock()?.execute(
            "DELETE FROM staging_content_index
             WHERE scope = ?1 AND media_type = ?2 AND byte_size = ?3 AND sha256 = ?4",
            params![scope, media_type.as_str(), byte_size, sha256],
        )?;
        Ok(())
    }

    /// Finish a duplicate request without adding a second library entry.
    pub fn complete_reused_staging_job(
        &self,
        job: &StagingJobRecord,
        canonical_job_id: &str,
    ) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE staging_jobs SET object_key = ?2, status = ?3, bytes_total = ?4,
                    bytes_uploaded = ?5, asset_id = ?6, error_json = NULL, updated_at = ?7
             WHERE id = ?1",
            params![
                job.id,
                job.object_key,
                job.status.as_str(),
                job.bytes_total
                    .map(|value| checked_sql_integer(value, "bytesTotal"))
                    .transpose()?,
                checked_sql_integer(job.bytes_uploaded, "bytesUploaded")?,
                job.asset_id,
                job.updated_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO staging_content_reuses (job_id, canonical_job_id) VALUES (?1, ?2)",
            params![job.id, canonical_job_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn staging_reused_from(&self, job_id: &str) -> BackendResult<Option<String>> {
        self.lock()?
            .query_row(
                "SELECT canonical_job_id FROM staging_content_reuses WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn has_active_material_transfer_source(&self, local_path: &str) -> BackendResult<bool> {
        let exists: i64 = self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM staging_jobs
             WHERE local_path = ?1 AND purpose = 'asset_import'
               AND status NOT IN ('failed', 'interrupted')
               AND id NOT IN (SELECT job_id FROM staging_content_reuses))",
            params![local_path],
            |row| row.get(0),
        )?;
        Ok(exists != 0)
    }

    pub fn update_staging_job(&self, job: &StagingJobRecord) -> BackendResult<()> {
        let bytes_total = job
            .bytes_total
            .map(|value| checked_sql_integer(value, "bytesTotal"))
            .transpose()?;
        let bytes_uploaded = checked_sql_integer(job.bytes_uploaded, "bytesUploaded")?;
        self.lock()?.execute(
            "UPDATE staging_jobs SET object_key = ?2, status = ?3, bytes_total = ?4,
                    bytes_uploaded = ?5, asset_id = ?6, error_json = ?7, updated_at = ?8,
                    adjustment = ?9
             WHERE id = ?1",
            params![
                job.id,
                job.object_key,
                job.status.as_str(),
                bytes_total,
                bytes_uploaded,
                job.asset_id,
                job.error.as_ref().map(serde_json::to_string).transpose()?,
                job.updated_at,
                job.adjustment
            ],
        )?;
        Ok(())
    }

    /// 素材上传已被海外网关接受后立即落库，早于任何状态轮询。
    /// 此 ID 是续查键，不是可供画布使用的 asset_id。
    pub fn set_staging_overseas_db_id(&self, id: &str, db_id: u64) -> BackendResult<()> {
        let db_id = checked_sql_integer(db_id, "overseasDbId")?;
        let changed = self.lock()?.execute(
            "UPDATE staging_jobs SET overseas_db_id = ?2,
                    overseas_submitted_at = COALESCE(overseas_submitted_at, ?3), updated_at = ?3
             WHERE id = ?1 AND (overseas_db_id IS NULL OR overseas_db_id = ?2)",
            params![id, db_id, now_ms()],
        )?;
        if changed == 0 {
            return Err(BackendError::Conflict(format!(
                "staging job {id} already has a different overseas db id"
            )));
        }
        Ok(())
    }

    pub fn get_staging_overseas_submitted_at(&self, id: &str) -> BackendResult<Option<i64>> {
        self.lock()?
            .query_row(
                "SELECT overseas_submitted_at FROM staging_jobs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("staging job {id}")))
    }

    pub fn update_staging_progress(&self, id: &str, bytes_uploaded: u64) -> BackendResult<()> {
        let bytes_uploaded = checked_sql_integer(bytes_uploaded, "bytesUploaded")?;
        self.lock()?.execute(
            "UPDATE staging_jobs SET bytes_uploaded = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, bytes_uploaded, now_ms()],
        )?;
        Ok(())
    }

    /// 素材库导入阶段的字节进度：同时写入已处理字节与总工作量（海外路径为
    /// 2 × 文件大小，下载 + 上传各算一遍）。国内路径不调用此方法。
    pub fn update_staging_import_progress(
        &self,
        id: &str,
        done_bytes: u64,
        total_bytes: u64,
    ) -> BackendResult<()> {
        let done_bytes = checked_sql_integer(done_bytes, "bytesUploaded")?;
        let total_bytes = checked_sql_integer(total_bytes, "bytesTotal")?;
        self.lock()?.execute(
            "UPDATE staging_jobs SET bytes_uploaded = ?2, bytes_total = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, done_bytes, total_bytes, now_ms()],
        )?;
        Ok(())
    }

    pub fn get_staging_job(&self, id: &str) -> BackendResult<StagingJobRecord> {
        self.lock()?
            .query_row(
                "SELECT id, local_path, purpose, media_type, object_key, status,
                        bytes_total, bytes_uploaded, asset_id, import_target_json,
                        error_json, created_at, updated_at, adjustment, overseas_db_id
                 FROM staging_jobs WHERE id = ?1",
                params![id],
                staging_job_from_row,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("staging job {id}")))
    }

    /// 返回已完成的本地素材上传。素材正文只在对象存储中，本表仅充当本地目录索引。
    pub fn list_local_asset_jobs(&self) -> BackendResult<Vec<StagingJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs
             WHERE purpose = 'local_asset'
               AND import_target_json IS NULL
               AND status = 'staged'
               AND object_key IS NOT NULL
               AND id NOT IN (SELECT job_id FROM staging_content_reuses)
             ORDER BY created_at DESC, id",
        )?;
        let rows = statement.query_map([], staging_job_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 按对象键查找本地素材（拉取存储桶素材时按对象键去重）。

    /// 整桶同步去重：任何应用创建的暂存任务都拥有该对象键时，不能再把对象
    /// 当成用户自行放入桶的新素材。包括入库中转、生成输入与尚在上传的 TOS-only 任务。

    pub fn list_staging_jobs_by_object_key(
        &self,
        object_key: &str,
    ) -> BackendResult<Vec<StagingJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs WHERE object_key = ?1",
        )?;
        statement
            .query_map(params![object_key], staging_job_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// 按对象键查找素材导入任务（预览兜底用）。
    ///
    /// 素材入库把导入时的暂存租约地址交给上游，上游把它当预览地址原样回放；租约过期、
    /// 暂存对象清理之后这个地址就取不到字节了。此时按对象键回到导入任务，用其
    /// `local_path`（导入的原始文件）重建预览，是同一份内容的唯一可靠副本。
    ///
    /// 只认 `purpose = 'asset_import'`：拉取存储桶建立的 `local_asset` 任务只存文件名，
    /// 不是真实路径，拿它当本地文件会读到错误位置。
    pub fn find_asset_import_job_by_object_key(
        &self,
        object_key: &str,
    ) -> BackendResult<Option<StagingJobRecord>> {
        if object_key.trim().is_empty() {
            return Ok(None);
        }
        self.lock()?
            .query_row(
                "SELECT id, local_path, purpose, media_type, object_key, status,
                        bytes_total, bytes_uploaded, asset_id, import_target_json,
                        error_json, created_at, updated_at, adjustment, overseas_db_id
                 FROM staging_jobs
                 WHERE purpose = 'asset_import'
                   AND object_key = ?1
                   AND id NOT IN (SELECT job_id FROM staging_content_reuses)
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![object_key],
                staging_job_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// 按云端素材身份找回导入任务：上游预览地址不可用时，用导入时的原始文件重建预览。
    ///
    /// 只认 `purpose = 'asset_import'`。`local_asset` 索引行经常只存文件名，不能当成本地路径。
    pub fn find_asset_import_job_by_asset_id(
        &self,
        asset_id: &str,
    ) -> BackendResult<Option<StagingJobRecord>> {
        let asset_id = asset_id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or(asset_id.trim())
            .trim();
        if asset_id.is_empty() {
            return Ok(None);
        }
        self.lock()?
            .query_row(
                "SELECT id, local_path, purpose, media_type, object_key, status,
                        bytes_total, bytes_uploaded, asset_id, import_target_json,
                        error_json, created_at, updated_at, adjustment, overseas_db_id
                 FROM staging_jobs
                 WHERE purpose = 'asset_import'
                   AND asset_id = ?1
                   AND id NOT IN (SELECT job_id FROM staging_content_reuses)
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![asset_id],
                staging_job_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn find_asset_import_job_by_provider_asset_id(
        &self,
        provider_connection_id: &str,
        asset_id: &str,
    ) -> BackendResult<Option<StagingJobRecord>> {
        let asset_id = asset_id
            .trim()
            .strip_prefix("asset://")
            .unwrap_or(asset_id.trim());
        if asset_id.is_empty() {
            return Ok(None);
        }
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs
             WHERE purpose = 'asset_import' AND asset_id = ?1
               AND id NOT IN (SELECT job_id FROM staging_content_reuses)
             ORDER BY created_at DESC",
        )?;
        let jobs = statement
            .query_map(params![asset_id], staging_job_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(jobs.into_iter().find(|job| {
            job.import_target
                .as_ref()
                .is_some_and(|target| target.provider_connection_id == provider_connection_id)
        }))
    }

    pub fn list_recoverable_staging_jobs(&self) -> BackendResult<Vec<StagingJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs
             WHERE status IN ('validating','authorizing','uploading','staged','importing','cleaning','interrupted')
                OR (overseas_db_id IS NOT NULL AND asset_id IS NULL AND status != 'failed')
             ORDER BY created_at",
        )?;
        let rows = statement.query_map([], staging_job_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 列出待回收的暂存对象行（启动回收器用）。
    ///
    /// 只回收**中转用途**的暂存对象：
    /// - `generation_input`：交给供应商请求用的一次性中转对象；
    /// - `asset_import`：喂给云端素材库导入的一次性中转对象。
    ///
    /// `local_asset` 是用户自己对象存储桶里的长期素材（对象存储素材库），
    /// 它就躺在同一个桶里但**不是垃圾**——删掉等于删用户的数据，因此不在回收范围。
    ///
    /// 回收条件：状态已经是死路（`interrupted` / `in_use` / `failed`）、对象键还在、
    /// 对象尚未确认删除、还没到重试上限、且退避时间已到。
    pub fn list_staging_cleanup_candidates(
        &self,
        max_retry_count: u32,
        limit: u32,
    ) -> BackendResult<Vec<StagingCleanupCandidate>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, purpose, object_key, status, cleanup_retry_count
             FROM staging_jobs
             WHERE status IN ('interrupted','in_use','failed')
               AND purpose IN ('generation_input','asset_import')
               AND object_key IS NOT NULL
               AND cleanup_done_at IS NULL
               AND cleanup_retry_count < ?1
               AND (cleanup_next_at IS NULL OR cleanup_next_at <= ?2)
             ORDER BY created_at
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![i64::from(max_retry_count), now_ms(), i64::from(limit)],
            staging_cleanup_candidate_from_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 记录一次回收失败：累计尝试次数并安排下一次重试时间。
    ///
    /// `next_at` 传 `None` 表示进入终态（不再重试），调用方负责记终态日志。
    pub fn record_staging_cleanup_failure(
        &self,
        id: &str,
        retry_count: u32,
        next_at: Option<i64>,
    ) -> BackendResult<()> {
        self.lock()?.execute(
            "UPDATE staging_jobs SET cleanup_retry_count = ?2, cleanup_next_at = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, i64::from(retry_count), next_at, now_ms()],
        )?;
        Ok(())
    }

    /// 对象已确认删除（或本来就不在桶里）：标记该行回收完成，不再进入回收队列。
    ///
    /// **保留** `object_key`：云端素材的预览兜底要靠对象键找回导入时的原始文件
    /// （见 `resolve_staging_local_source`），把键清掉等于连兜底一起弄丢。
    /// 「是否已回收」由 `cleanup_done_at` 表达，因此回收依然是幂等的——
    /// 已清理的行不会被再捞出来，也不会重复发 DELETE。
    pub fn mark_staging_object_deleted(&self, id: &str) -> BackendResult<()> {
        self.lock()?.execute(
            "UPDATE staging_jobs SET cleanup_done_at = ?2, cleanup_retry_count = 0,
                    cleanup_next_at = NULL, updated_at = ?3
             WHERE id = ?1",
            params![id, now_ms(), now_ms()],
        )?;
        Ok(())
    }

    /// 重新上传了对象：清掉回收记账，让新对象重新受回收管辖。
    ///
    /// 对象键是每次上传新生成的（`build_object_key` 用新 UUID），旧对象的回收结论
    /// 不能套到新对象上。
    pub fn reset_staging_cleanup_state(&self, id: &str) -> BackendResult<()> {
        self.lock()?.execute(
            "UPDATE staging_jobs SET cleanup_done_at = NULL, cleanup_retry_count = 0,
                    cleanup_next_at = NULL
             WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// 产物上传到云端素材库的入库记录，供应用重启后重建「jobId → 产物节点」映射与在途上传行。
    ///
    /// 只返回仍需要前端处置的行，按 `created_at` 升序（同一产物的多次上传由前端取最后一次）：
    /// - 未到终态：后台可能仍在推进（例如进程重启后对象已落到对象存储、只差素材库导入），
    ///   前端要继续轮询；这些行不设时间窗口，否则长时间停在 `staged` 的任务会被漏掉；
    /// - `active` / `cleaned`：入库已完成，用于点亮产物卡片的绿色小点；已完成的上传只认
    ///   最近 [`ASSET_IMPORT_OUTPUT_RECOVERY_WINDOW_MS`]，避免把很久以前的成功上传重新刷出来。
    ///
    /// `failed` / `interrupted` 与更早完成的记录不再返回：没有绿色小点要点亮，用户也已见过结果。
    pub fn list_asset_import_outputs(&self) -> BackendResult<Vec<StagingJobRecord>> {
        let completed_since = now_ms() - ASSET_IMPORT_OUTPUT_RECOVERY_WINDOW_MS;
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at, adjustment, overseas_db_id
             FROM staging_jobs
             WHERE purpose = 'asset_import'
               AND import_target_json IS NOT NULL
               AND (
                 status IN ('validating','authorizing','uploading','staged','importing','cleaning')
                 OR (overseas_db_id IS NOT NULL AND asset_id IS NULL AND status != 'failed')
                 OR (status = 'failed' AND overseas_db_id IS NOT NULL
                     AND json_extract(error_json, '$.kind') = 'asset_import_timeout')
                 OR (status IN ('active','cleaned') AND created_at >= ?1)
               )
             ORDER BY created_at",
        )?;
        let rows = statement.query_map(params![completed_since], staging_job_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// 把某个画布下所有非终态生成任务收敛成 `cancelled` 终态。
///
/// 画布被删除后，这些任务如果继续跑，就会变成没人认领的"幽灵任务"：
/// 继续向供应商轮询、继续消耗额度、继续把产物写进磁盘。
/// 终态任务（已成功/已失败/已中断/已取消）保持原样，历史不能丢。
///
/// 必须与删除画布行放在同一个 transaction 里：要么两者都生效，要么都不生效。
fn cancel_canvas_generation_tasks(
    transaction: &Transaction<'_>,
    canvas_id: &str,
    timestamp: i64,
) -> BackendResult<usize> {
    let tasks = {
        let mut statement = transaction.prepare(
            "SELECT id, status, query_health, progress FROM generation_tasks
             WHERE canvas_id = ?1
               AND status IN ('created','submitting','retry_wait','queued','running')
             ORDER BY created_at",
        )?;
        let rows = statement.query_map(params![canvas_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<f64>>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if tasks.is_empty() {
        return Ok(0);
    }
    let reason = json!({
        "kind": "generation_cancelled",
        "message": "画布已删除，任务随之取消，不再继续查询供应商或保存产物。",
    });
    let reason_json = serde_json::to_string(&reason)?;
    let mut cancelled = 0;
    for (task_id, from_status, from_query_health, progress) in tasks {
        // 再带一次状态条件：任务可能刚好在读取之后跑完了，终态历史不能被改写。
        let updated = transaction.execute(
            "UPDATE generation_tasks
             SET status = 'cancelled', final_error_json = ?2, updated_at = ?3, completed_at = ?3
             WHERE id = ?1
               AND status IN ('created','submitting','retry_wait','queued','running')",
            params![task_id, reason_json, timestamp],
        )?;
        if updated != 1 {
            continue;
        }
        transaction.execute(
            "INSERT INTO generation_task_events(task_id, event_type, payload_json, created_at)
             VALUES (?1, 'state_changed', ?2, ?3)",
            params![
                task_id,
                serde_json::to_string(&json!({
                    "fromStatus": from_status,
                    "status": "cancelled",
                    "fromQueryHealth": from_query_health,
                    "queryHealth": from_query_health,
                    "progress": progress,
                    "error": reason.clone(),
                }))?,
                timestamp
            ],
        )?;
        cancelled += 1;
    }
    Ok(cancelled)
}

const DEFAULT_TOS_REGION: &str = "cn-beijing";
const DEFAULT_TOS_ENDPOINT: &str = "tos-cn-beijing.volces.com";
const DEFAULT_TOS_OBJECT_PREFIX: &str = "staging";

fn json_text(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 读取历史 TOS 行：现行 camelCase、升级前 snake_case、以及 Broker 时代缺桶名的 JSON。
/// 有桶名就尽量保住启用态；没有桶名也返回一份禁用配置，设置页至少还能打开而不是空白。
fn app_object_scope_hash(object_key: &str) -> Option<&str> {
    let segments: Vec<&str> = object_key.split('/').collect();
    segments.windows(5).find_map(|parts| {
        let [hash, year, month, day, file] = parts else {
            return None;
        };
        let (stem, _) = file.rsplit_once('.')?;
        (hash.len() == 16
            && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            && year.len() == 4
            && year.bytes().all(|byte| byte.is_ascii_digit())
            && month.len() == 2
            && month.bytes().all(|byte| byte.is_ascii_digit())
            && day.len() == 2
            && day.bytes().all(|byte| byte.is_ascii_digit())
            && Uuid::parse_str(stem).is_ok())
        .then_some(*hash)
    })
}

fn parse_stored_tos_config(raw: &str) -> Option<TosStagingConfig> {
    if let Ok(config) = serde_json::from_str::<TosStagingConfig>(raw) {
        return Some(sanitize_tos_config(config));
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    Some(sanitize_tos_config(recover_tos_config_from_value(&value)?))
}

fn credential_ref_is_present(credential_ref: Option<&str>) -> bool {
    credential_ref
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

/// 旧行缺字段或 enabled 与桶名/凭据不一致时，补默认值并避免「空桶却显示已启用」。
fn sanitize_tos_config(mut config: TosStagingConfig) -> TosStagingConfig {
    if config.region.trim().is_empty() {
        config.region = DEFAULT_TOS_REGION.to_string();
    }
    if config.endpoint.trim().is_empty() {
        config.endpoint = DEFAULT_TOS_ENDPOINT.to_string();
    }
    if config.object_prefix.trim().is_empty() {
        config.object_prefix = DEFAULT_TOS_OBJECT_PREFIX.to_string();
    }
    if config.bucket.trim().is_empty()
        || !credential_ref_is_present(config.credential_ref.as_deref())
    {
        config.enabled = false;
    }
    config
}

fn recover_tos_config_from_value(value: &Value) -> Option<TosStagingConfig> {
    if !value.is_object() {
        return None;
    }
    let bucket = json_text(value, &["bucket"]).unwrap_or_default();
    let credential_ref = json_text(value, &["credentialRef", "credential_ref"]);
    Some(TosStagingConfig {
        region: json_text(value, &["region"]).unwrap_or_else(|| DEFAULT_TOS_REGION.to_string()),
        endpoint: json_text(value, &["endpoint"])
            .unwrap_or_else(|| DEFAULT_TOS_ENDPOINT.to_string()),
        bucket,
        credential_ref,
        object_prefix: json_text(value, &["objectPrefix", "object_prefix"])
            .unwrap_or_else(|| DEFAULT_TOS_OBJECT_PREFIX.to_string()),
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// 旧版本数据库的 generation_tasks 表没有 tokens_json 列（tokens 用量功能之前创建的库）。
/// CREATE TABLE IF NOT EXISTS 不会为已存在的表补列，这里在启动时检测并 ALTER TABLE 补齐。
fn migrate_generation_tasks_tokens(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(generation_tasks)")?;
    let has_tokens_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| result.map(|name| name == "tokens_json").unwrap_or(false));
    drop(statement);
    if !has_tokens_column {
        connection.execute(
            "ALTER TABLE generation_tasks ADD COLUMN tokens_json TEXT",
            [],
        )?;
    }
    Ok(())
}

/// 为旧数据库补齐令牌分组支持：
/// 1. `provider_model_bindings` 缺 `token_group` 列时 ALTER 补齐（NULL = 供应商默认令牌）；
/// 2. `provider_token_groups` 表由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 保证存在，无需额外处理。
fn migrate_provider_token_groups(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(provider_model_bindings)")?;
    let has_token_group_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| result.map(|name| name == "token_group").unwrap_or(false));
    drop(statement);
    if !has_token_group_column {
        connection.execute(
            "ALTER TABLE provider_model_bindings ADD COLUMN token_group TEXT",
            [],
        )?;
    }
    Ok(())
}

/// 为旧数据库补齐本地素材分组支持：
/// 1. `local_base64_assets` 缺 `group_id` 列时 ALTER 补齐（NULL = 未分组）；
/// 2. `local_base64_asset_groups` 表与分组名唯一索引由 SCHEMA 的 IF NOT EXISTS 保证，
///    但 `group_id` 过滤索引必须等旧库补完列后才能建，放在这里统一执行。
fn migrate_local_base64_asset_groups(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(local_base64_assets)")?;
    let has_group_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| result.map(|name| name == "group_id").unwrap_or(false));
    drop(statement);
    if !has_group_column {
        connection.execute(
            "ALTER TABLE local_base64_assets ADD COLUMN group_id TEXT",
            [],
        )?;
    }
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_local_base64_assets_group
         ON local_base64_assets(group_id)",
        [],
    )?;
    Ok(())
}

/// 为旧数据库补齐「请求未送达上游」标记列：`provider_calls.dispatch_failed`。
///
/// 旧库没有这一列，CREATE TABLE IF NOT EXISTS 也不会给已存在的表补列，因此启动时
/// 检测并 ALTER TABLE 补齐。补出来的值一律是 0（= 已送达），这样历史记录的行为
/// 与加列之前完全一致：旧草稿不会被突然变成「可重复提交」，也不会凭空多出一次
/// 可能计费的供应商调用。
fn migrate_provider_calls_dispatch_failed(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(provider_calls)")?;
    let has_dispatch_failed_column =
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .any(|result| {
                result
                    .map(|name| name == "dispatch_failed")
                    .unwrap_or(false)
            });
    drop(statement);
    if !has_dispatch_failed_column {
        connection.execute(
            "ALTER TABLE provider_calls
             ADD COLUMN dispatch_failed INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

/// 为旧数据库补齐暂存对象回收的记账列。
///
/// - `cleanup_retry_count`：删除失败次数，达到上限后该行进入终态（不再重试），
///   否则每次启动都会重试同一行，永远清不掉也永远不放手；
/// - `cleanup_next_at`：下一次允许重试的时间戳（毫秒），用来做退避；
/// - `cleanup_done_at`：对象已确认删除的时间戳；非空表示这一行不再需要回收。
fn migrate_staging_jobs_cleanup_retry(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(staging_jobs)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if !columns.iter().any(|name| name == "cleanup_retry_count") {
        connection.execute(
            "ALTER TABLE staging_jobs ADD COLUMN cleanup_retry_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !columns.iter().any(|name| name == "cleanup_next_at") {
        connection.execute(
            "ALTER TABLE staging_jobs ADD COLUMN cleanup_next_at INTEGER",
            [],
        )?;
    }
    if !columns.iter().any(|name| name == "cleanup_done_at") {
        connection.execute(
            "ALTER TABLE staging_jobs ADD COLUMN cleanup_done_at INTEGER",
            [],
        )?;
    }
    Ok(())
}

/// 为旧数据库补齐上传调整说明列：`adjustment` 记录上传前对素材做过的自动调整
/// （目前只有「图片尺寸归一化」），旧库缺列时按 NULL（未做过调整）补齐。
fn migrate_staging_jobs_adjustment(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(staging_jobs)")?;
    let has_adjustment_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| result.map(|name| name == "adjustment").unwrap_or(false));
    drop(statement);
    if !has_adjustment_column {
        connection.execute("ALTER TABLE staging_jobs ADD COLUMN adjustment TEXT", [])?;
    }
    Ok(())
}

fn migrate_staging_jobs_overseas_db_id(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(staging_jobs)")?;
    let has_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| result.map(|name| name == "overseas_db_id").unwrap_or(false));
    drop(statement);
    if !has_column {
        connection.execute(
            "ALTER TABLE staging_jobs ADD COLUMN overseas_db_id INTEGER",
            [],
        )?;
    }
    // 暂存对象清理不等于云端素材已生成；重启时仍须按原 db_id 续查。
    connection.execute(
        "UPDATE staging_jobs SET status = 'importing'
         WHERE overseas_db_id IS NOT NULL AND asset_id IS NULL
           AND status IN ('cleaning', 'cleaned')",
        [],
    )?;
    Ok(())
}

fn migrate_staging_jobs_overseas_submitted_at(connection: &Connection) -> BackendResult<()> {
    let mut statement = connection.prepare("PRAGMA table_info(staging_jobs)")?;
    let has_column = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|result| {
            result
                .map(|name| name == "overseas_submitted_at")
                .unwrap_or(false)
        });
    drop(statement);
    if !has_column {
        connection.execute(
            "ALTER TABLE staging_jobs ADD COLUMN overseas_submitted_at INTEGER",
            [],
        )?;
    }
    connection.execute(
        "UPDATE staging_jobs SET overseas_submitted_at = updated_at
         WHERE overseas_db_id IS NOT NULL AND overseas_submitted_at IS NULL",
        [],
    )?;
    Ok(())
}

/// 盘趣聚合网关已从预置连接中移除：把仍指向盘趣上游的连接连同它的模型绑定与
/// 令牌分组一并清掉，避免残留一条指向已不再支持网关的僵尸连接。
///
/// 判定按上游主机（`panqu.com` 与其直连 IP `115.191.2.88`）而不是连接 ID：
/// 用户克隆出来的盘趣连接同样要清；而把预置 ID 改接到自己代理上的连接已经
/// 不是盘趣上游，保留它不会破坏用户的现有编辑。`model_definitions` 按项目惯例
/// 保留，避免破坏生成任务快照等历史引用。幂等：无命中时为空操作。
fn migrate_remove_panqu_provider_connections(connection: &Connection) -> BackendResult<()> {
    const PANQU_HOST_PREDICATE: &str = "base_url LIKE '%panqu.com%' \
         OR base_url LIKE '%115.191.2.88%'";
    connection.execute(
        &format!(
            "DELETE FROM provider_model_bindings
              WHERE provider_connection_id IN (SELECT id FROM provider_connections WHERE {PANQU_HOST_PREDICATE})"
        ),
        [],
    )?;
    connection.execute(
        &format!(
            "DELETE FROM provider_token_groups
              WHERE provider_connection_id IN (SELECT id FROM provider_connections WHERE {PANQU_HOST_PREDICATE})"
        ),
        [],
    )?;
    connection.execute(
        &format!("DELETE FROM provider_connections WHERE {PANQU_HOST_PREDICATE}"),
        [],
    )?;
    Ok(())
}

fn provider_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderConnection> {
    Ok(ProviderConnection {
        id: row.get(0)?,
        display_name: row.get(1)?,
        adapter_id: row.get(2)?,
        base_url: row.get(3)?,
        api_key_ref: row.get(4)?,
        enabled: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn provider_token_group_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderTokenGroup> {
    Ok(ProviderTokenGroup {
        id: row.get(0)?,
        provider_connection_id: row.get(1)?,
        group_name: row.get(2)?,
        credential_ref: row.get(3)?,
        enabled: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn binding_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderModelBinding> {
    let operations_json: String = row.get(2)?;
    let operations = serde_json::from_str::<Vec<String>>(&operations_json)
        .map_err(json_sql_error)?
        .into_iter()
        .map(|operation| GenerationOperation::try_from(operation.as_str()).map_err(text_sql_error))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ProviderModelBinding {
        provider_connection_id: row.get(0)?,
        model_definition_id: row.get(1)?,
        enabled_operations: operations,
        remote_model_id: row.get(3)?,
        enabled: row.get(4)?,
        token_group: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn validate_history_date_range(from: Option<i64>, to: Option<i64>) -> BackendResult<()> {
    if from.is_some_and(|value| value < 0) || to.is_some_and(|value| value < 0) {
        return Err(BackendError::validation(
            "历史查询时间不能早于 1970 年",
            Value::Null,
        ));
    }
    if matches!((from, to), (Some(start), Some(end)) if start > end) {
        return Err(BackendError::validation(
            "开始时间不能晚于结束时间",
            Value::Null,
        ));
    }
    Ok(())
}

fn task_summary_sql(where_clause: &str) -> String {
    format!(
        "SELECT id, canvas_id, source_node_id, operation, status, query_health,
                provider_connection_id, provider_display_name_snapshot, model_definition_id,
                remote_model_id_snapshot, remote_task_id, progress, tokens_json,
                created_at, updated_at, completed_at,
                json_extract(logical_request_json, '$.outputName') FROM generation_tasks {where_clause}"
    )
}

fn task_summary_from_row(row: &Row<'_>) -> rusqlite::Result<GenerationTaskSummary> {
    let operation: String = row.get(3)?;
    let status: String = row.get(4)?;
    let health: String = row.get(5)?;
    let tokens: Option<String> = row.get(12)?;
    let tokens = tokens
        .map(|json| serde_json::from_str::<TokenUsage>(&json))
        .transpose()
        .map_err(json_sql_error)?;
    Ok(GenerationTaskSummary {
        output_name: row.get(16)?,
        id: row.get(0)?,
        canvas_id: row.get(1)?,
        source_node_id: row.get(2)?,
        operation: parse_operation(operation)?,
        status: parse_task_status(status)?,
        query_health: parse_query_health(health)?,
        provider_connection_id: row.get(6)?,
        provider_display_name_snapshot: row.get(7)?,
        model_definition_id: row.get(8)?,
        remote_model_id_snapshot: row.get(9)?,
        remote_task_id: row.get(10)?,
        progress: row.get(11)?,
        tokens,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        completed_at: row.get(15)?,
    })
}

fn attempt_from_row(row: &Row<'_>) -> rusqlite::Result<GenerationAttemptRecord> {
    let error: Option<String> = row.get(8)?;
    Ok(GenerationAttemptRecord {
        id: row.get(0)?,
        task_id: row.get(1)?,
        attempt_number: row.get(2)?,
        phase: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        backoff_ms: optional_nonnegative_integer(row, 6)?,
        outcome: row.get(7)?,
        error: error.map(parse_json_column).transpose()?,
    })
}

fn call_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderCallRecord> {
    let request: String = row.get(4)?;
    let response_headers: Option<String> = row.get(9)?;
    let runtime_error: Option<String> = row.get(11)?;
    Ok(ProviderCallRecord {
        id: row.get(0)?,
        task_id: row.get(1)?,
        attempt_id: row.get(2)?,
        phase: row.get(3)?,
        request: parse_json_column(request)?,
        sent_at: row.get(5)?,
        response_received_at: row.get(6)?,
        duration_ms: row.get(7)?,
        http_status: row.get(8)?,
        response_headers: response_headers.map(parse_json_column).transpose()?,
        raw_response: row.get(10)?,
        runtime_error: runtime_error.map(parse_json_column).transpose()?,
    })
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<GenerationTaskEvent> {
    let payload: String = row.get(3)?;
    Ok(GenerationTaskEvent {
        id: row.get(0)?,
        task_id: row.get(1)?,
        event_type: row.get(2)?,
        payload: parse_json_column(payload)?,
        created_at: row.get(4)?,
    })
}

fn result_from_row(row: &Row<'_>) -> rusqlite::Result<GenerationResultRecord> {
    let media_type: String = row.get(2)?;
    let source: String = row.get(4)?;
    let save_status: String = row.get(5)?;
    let error: Option<String> = row.get(12)?;
    Ok(GenerationResultRecord {
        display_name: row.get(13)?,
        task_id: row.get(0)?,
        result_index: row.get(1)?,
        media_type: parse_media_type(media_type)?,
        remote_task_id: row.get(3)?,
        source: parse_json_column(source)?,
        save_status: parse_save_status(save_status)?,
        final_path: row.get(6)?,
        relative_path: row.get(7)?,
        byte_size: optional_nonnegative_integer(row, 8)?,
        mime_type: row.get(9)?,
        sha256: row.get(10)?,
        saved_at: row.get(11)?,
        error: error.map(parse_json_column).transpose()?,
    })
}

fn progress_result_from_row(row: &Row<'_>) -> rusqlite::Result<GenerationProgressResult> {
    let media_type: String = row.get(2)?;
    let save_status: String = row.get(3)?;
    let error: Option<String> = row.get(5)?;
    Ok(GenerationProgressResult {
        task_id: row.get(0)?,
        result_index: row.get(1)?,
        media_type: parse_media_type(media_type)?,
        save_status: parse_save_status(save_status)?,
        final_path: row.get(4)?,
        error: error.map(parse_json_column).transpose()?,
    })
}

fn staging_job_from_row(row: &Row<'_>) -> rusqlite::Result<StagingJobRecord> {
    let media_type: String = row.get(3)?;
    let status: String = row.get(5)?;
    let import_target: Option<String> = row.get(9)?;
    let error: Option<String> = row.get(10)?;
    Ok(StagingJobRecord {
        id: row.get(0)?,
        local_path: row.get(1)?,
        purpose: row.get(2)?,
        media_type: parse_media_type(media_type)?,
        object_key: row.get(4)?,
        status: parse_staging_status(status)?,
        bytes_total: optional_nonnegative_integer(row, 6)?,
        bytes_uploaded: nonnegative_integer(row, 7)?,
        asset_id: row.get(8)?,
        import_target: import_target
            .map(|value| {
                serde_json::from_str::<StagingAssetImportTarget>(&value).map_err(json_sql_error)
            })
            .transpose()?,
        error: error.map(parse_json_column).transpose()?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        adjustment: row.get(13)?,
        overseas_db_id: optional_nonnegative_integer(row, 14)?,
    })
}

/// 回收候选行的行映射：只取回收需要的列，避开 `staging_job_from_row` 的全量列。
fn staging_cleanup_candidate_from_row(row: &Row<'_>) -> rusqlite::Result<StagingCleanupCandidate> {
    let status: String = row.get(3)?;
    Ok(StagingCleanupCandidate {
        id: row.get(0)?,
        purpose: row.get(1)?,
        object_key: row.get(2)?,
        status: parse_staging_status(status)?,
        cleanup_retry_count: u32::try_from(nonnegative_integer(row, 4)?).unwrap_or(u32::MAX),
    })
}

fn canvas_document_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasDocumentRecord> {
    let document: String = row.get(2)?;
    Ok(CanvasDocumentRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        document: parse_json_column(document)?,
        revision: nonnegative_integer(row, 3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn collect_rows<T>(
    connection: &Connection,
    sql: &str,
    task_id: &str,
    mapper: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> BackendResult<Vec<T>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params![task_id], mapper)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn parse_json_column(value: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(json_sql_error)
}

fn parse_operation(value: String) -> rusqlite::Result<GenerationOperation> {
    GenerationOperation::try_from(value.as_str()).map_err(text_sql_error)
}

fn parse_task_status(value: String) -> rusqlite::Result<GenerationTaskStatus> {
    GenerationTaskStatus::try_from(value.as_str()).map_err(text_sql_error)
}

fn parse_query_health(value: String) -> rusqlite::Result<QueryHealth> {
    match value.as_str() {
        "healthy" => Ok(QueryHealth::Healthy),
        "retry_wait" => Ok(QueryHealth::RetryWait),
        "degraded" => Ok(QueryHealth::Degraded),
        _ => Err(text_sql_error(format!("unknown query health: {value}"))),
    }
}

fn parse_media_type(value: String) -> rusqlite::Result<MediaType> {
    match value.as_str() {
        "image" => Ok(MediaType::Image),
        "video" => Ok(MediaType::Video),
        "audio" => Ok(MediaType::Audio),
        /*
         * "text" 必须认：生成结果表里存着文本产物（Context-IR 等，保存为 .txt），
         * 写入侧 `generation_lifecycle.rs` 用 `result.media_type.as_str()` 落库。
         * 这里若不认，读取任务详情 / 结果列表时整条 SQL 映射失败 → 用户看到
         * 「unknown media type: text」，该任务的所有结果都读不出来。
         *
         * 注意别与「素材库 / 暂存只收三媒体」混淆：那条约束在素材侧的
         * `parse_media_type`（asset_library.rs）里，两者是不同的函数。
         */
        "text" => Ok(MediaType::Text),
        _ => Err(text_sql_error(format!("unknown media type: {value}"))),
    }
}

fn parse_save_status(value: String) -> rusqlite::Result<SaveStatus> {
    match value.as_str() {
        "pending" => Ok(SaveStatus::Pending),
        "writing" => Ok(SaveStatus::Writing),
        "succeeded" => Ok(SaveStatus::Succeeded),
        "failed" => Ok(SaveStatus::Failed),
        "interrupted" => Ok(SaveStatus::Interrupted),
        "local_missing" => Ok(SaveStatus::LocalMissing),
        "conflict" => Ok(SaveStatus::Conflict),
        _ => Err(text_sql_error(format!("unknown save status: {value}"))),
    }
}

fn parse_staging_status(value: String) -> rusqlite::Result<StagingStatus> {
    match value.as_str() {
        "validating" => Ok(StagingStatus::Validating),
        "authorizing" => Ok(StagingStatus::Authorizing),
        "uploading" => Ok(StagingStatus::Uploading),
        "staged" => Ok(StagingStatus::Staged),
        "importing" => Ok(StagingStatus::Importing),
        "active" => Ok(StagingStatus::Active),
        "in_use" => Ok(StagingStatus::InUse),
        "failed" => Ok(StagingStatus::Failed),
        "interrupted" => Ok(StagingStatus::Interrupted),
        "cleaning" => Ok(StagingStatus::Cleaning),
        "cleaned" => Ok(StagingStatus::Cleaned),
        _ => Err(text_sql_error(format!("unknown staging status: {value}"))),
    }
}

fn json_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn checked_sql_integer(value: u64, field: &str) -> BackendResult<i64> {
    i64::try_from(value).map_err(|_| {
        BackendError::validation(
            "numeric value exceeds SQLite integer capacity",
            json!({ "field": field, "value": value, "maximum": i64::MAX }),
        )
    })
}

fn optional_nonnegative_integer(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| convert_nonnegative_integer(value, index))
        .transpose()
}

fn nonnegative_integer(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    convert_nonnegative_integer(row.get(index)?, index)
}

fn convert_nonnegative_integer(value: i64, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn text_sql_error(error: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
    )
}
