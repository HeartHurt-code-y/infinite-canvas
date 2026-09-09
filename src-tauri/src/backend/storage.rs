use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    model_schema::{
        default_model_schema, operations_from_schema, provider_scoped_model_definition_id,
        refresh_gemini_image_parameter_defaults, refresh_legacy_image_parameter_defaults,
        schema_for_enabled_operations,
    },
    types::{
        CanvasDocumentRecord, CanvasDocumentSummary, GenerationAttemptRecord, GenerationOperation,
        GenerationResultRecord, GenerationTaskDetail, GenerationTaskEvent, GenerationTaskListQuery,
        GenerationTaskPage, GenerationTaskStatus, GenerationTaskSummary, MediaType,
        ModelDefinition, ProviderCallRecord, ProviderConnection, ProviderModelBinding,
        ProviderTokenGroup, QueryHealth, ReplaceProviderModelBindingsCommand,
        SaveCanvasDocumentCommand, SaveStatus, StagingAssetImportTarget, StagingJobRecord,
        StagingStatus, TextGenerationOutputRecord, TokenUsage, TosStagingConfig,
        UpsertProviderConnectionCommand, UpsertProviderTokenGroupCommand,
    },
};

#[path = "storage/generation_lifecycle.rs"]
mod generation_lifecycle;

#[path = "storage/workflow_history.rs"]
pub mod workflow_history;

#[path = "storage/reverse_video_cases.rs"]
mod reverse_video_cases;

#[path = "storage/remote_video_tasks.rs"]
mod remote_video_tasks;

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
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staging_jobs_status
  ON staging_jobs(status, created_at);
"#;

/// 首次打开应用时提供的连接模板。凭据由用户按实际环境补充；保持禁用状态，
/// 避免初始化后素材面板立即用空配置发起远程请求。模板预置常用供应商地址，
/// 用户填入 API Key 后即可启用。使用稳定 ID + INSERT OR IGNORE，
/// 这样既能为旧数据库补齐模板，也不会覆盖用户已经编辑过的连接信息。
/// 第四个元素为适配器 ID（魔芋 `moyu_v1` / 火山引擎方舟 `volcengine_ark_v1`）。
const DEFAULT_PROVIDER_CONNECTIONS: [(&str, &str, &str, &str); 5] = [
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
        connection.execute_batch(workflow_history::SCHEMA)?;
        connection.execute_batch(reverse_video_cases::SCHEMA)?;
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            params![now_ms()],
        )?;
        migrate_generation_tasks_tokens(&connection)?;
        migrate_provider_token_groups(&connection)?;

        let storage = Self {
            connection: Mutex::new(connection),
        };
        storage.seed_model_definitions()?;
        storage.seed_default_provider_connections()?;
        storage.migrate_legacy_model_bindings()?;
        storage.repair_malformed_model_definitions()?;
        Ok(storage)
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
            let mut repaired =
                schema_for_enabled_operations(&definition.operations, &identity, &operations);
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
        self.get_provider_connection(&command.provider_connection_id)?;

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
                .map(|operation| operation.as_str())
                .collect::<Vec<_>>();
            operations.sort_unstable();
            operations.dedup();
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
                    selection.enabled,
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
        workflow_history::associate_task(&transaction, &task)?;
        transaction.commit()?;
        Ok(())
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
                        saved_at, error_json
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
                        saved_at, error_json
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
                return Err(BackendError::Conflict(format!(
                    "canvas {} changed since revision {}; current revision is {}",
                    command.id, expected_revision, current_revision
                )));
            }
        }
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            BackendError::Conflict(format!("canvas {} revision overflow", command.id))
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
        // Task history, workflow checkpoints, and generated files outlive their canvas.
        self.lock()?
            .execute("DELETE FROM canvas_documents WHERE id = ?1", params![id])?;
        Ok(())
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
                    saved_at, error_json
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

    pub fn list_tasks(&self, query: &GenerationTaskListQuery) -> BackendResult<GenerationTaskPage> {
        validate_history_date_range(query.created_from, query.created_to)?;
        let connection = self.lock()?;
        let limit = query.limit.clamp(1, 200) as i64;
        let statuses = query
            .statuses
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let mut statement = connection.prepare(&format!(
            "{} ORDER BY created_at DESC, id LIMIT ?7",
            task_summary_sql(
                "WHERE (?1 IS NULL OR canvas_id = ?1)
                AND (?2 IS NULL OR source_node_id = ?2)
                AND (?3 IS NULL OR status IN (SELECT value FROM json_each(?3)))
                AND (?4 IS NULL OR created_at < ?4)
                AND (?5 IS NULL OR created_at >= ?5)
                AND (?6 IS NULL OR created_at <= ?6)"
            )
        ))?;
        let mut items = statement
            .query_map(
                params![
                    query.canvas_id,
                    query.source_node_id,
                    statuses,
                    query.cursor_created_before,
                    query.created_from,
                    query.created_to,
                    limit + 1
                ],
                task_summary_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor_created_before = if items.len() > limit as usize {
            items.pop();
            items.last().map(|item| item.created_at)
        } else {
            None
        };
        Ok(GenerationTaskPage {
            items,
            next_cursor_created_before,
        })
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
            Some(value) => match serde_json::from_str::<TosStagingConfig>(&value) {
                Ok(config) => Ok(Some(config)),
                Err(error) => {
                    // 历史版本（Broker 中转）保存的配置无法映射到直连 TOS 的字段，
                    // 视为未配置：用户需要在设置中重新填写桶名与 AK/SK。
                    tauri_plugin_log::log::warn!(
                        "[staging] 已忽略无法解析的旧版 TOS 配置: {error}"
                    );
                    Ok(None)
                }
            },
            None => Ok(None),
        }
    }

    pub fn insert_staging_job(&self, job: &StagingJobRecord) -> BackendResult<()> {
        let bytes_total = job
            .bytes_total
            .map(|value| checked_sql_integer(value, "bytesTotal"))
            .transpose()?;
        let bytes_uploaded = checked_sql_integer(job.bytes_uploaded, "bytesUploaded")?;
        self.lock()?.execute(
            "INSERT INTO staging_jobs
             (id, local_path, purpose, media_type, object_key, status, bytes_total,
              bytes_uploaded, asset_id, import_target_json, error_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                job.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn update_staging_job(&self, job: &StagingJobRecord) -> BackendResult<()> {
        let bytes_total = job
            .bytes_total
            .map(|value| checked_sql_integer(value, "bytesTotal"))
            .transpose()?;
        let bytes_uploaded = checked_sql_integer(job.bytes_uploaded, "bytesUploaded")?;
        self.lock()?.execute(
            "UPDATE staging_jobs SET object_key = ?2, status = ?3, bytes_total = ?4,
                    bytes_uploaded = ?5, asset_id = ?6, error_json = ?7, updated_at = ?8
             WHERE id = ?1",
            params![
                job.id,
                job.object_key,
                job.status.as_str(),
                bytes_total,
                bytes_uploaded,
                job.asset_id,
                job.error.as_ref().map(serde_json::to_string).transpose()?,
                job.updated_at
            ],
        )?;
        Ok(())
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
                        error_json, created_at, updated_at
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
                    error_json, created_at, updated_at
             FROM staging_jobs
             WHERE purpose = 'local_asset'
               AND import_target_json IS NULL
               AND status = 'staged'
               AND object_key IS NOT NULL
             ORDER BY created_at DESC, id",
        )?;
        let rows = statement.query_map([], staging_job_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 按对象键查找本地素材（拉取存储桶素材时按对象键去重）。
    pub fn find_local_asset_job_by_object_key(
        &self,
        object_key: &str,
    ) -> BackendResult<Option<StagingJobRecord>> {
        self.lock()?
            .query_row(
                "SELECT id, local_path, purpose, media_type, object_key, status,
                        bytes_total, bytes_uploaded, asset_id, import_target_json,
                        error_json, created_at, updated_at
                 FROM staging_jobs
                 WHERE purpose = 'local_asset'
                   AND import_target_json IS NULL
                   AND status = 'staged'
                   AND object_key = ?1
                 LIMIT 1",
                params![object_key],
                staging_job_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_recoverable_staging_jobs(&self) -> BackendResult<Vec<StagingJobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, local_path, purpose, media_type, object_key, status,
                    bytes_total, bytes_uploaded, asset_id, import_target_json,
                    error_json, created_at, updated_at
             FROM staging_jobs
             WHERE status IN ('validating','authorizing','uploading','staged','importing','cleaning')
             ORDER BY created_at",
        )?;
        let rows = statement.query_map([], staging_job_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
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
                created_at, updated_at, completed_at FROM generation_tasks {where_clause}"
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::*;
    use crate::backend::types::ProviderModelSelection;

    #[test]
    fn history_date_range_filters_before_pagination_and_validates_bounds() {
        let directory = TempDir::new().unwrap();
        let storage = Storage::open(&directory.path().join("backend.sqlite")).unwrap();
        let provider = storage.get_provider_connection("provider-sd20").unwrap();
        // The previous bounded scan skipped old matches once enough newer records existed.
        for index in 0..45 {
            let id = format!("history-date-{index}");
            storage
                .insert_task(NewTask {
                    id: &id,
                    canvas_id: "date-canvas",
                    source_node_id: "date-node",
                    operation: GenerationOperation::TextToImage,
                    provider: &provider,
                    api_key_ref: &provider.api_key_ref,
                    model_definition_id: "gpt-image-2",
                    remote_model_id: Some("gpt-image-2"),
                    logical_request: &json!({}),
                })
                .unwrap();
            storage
                .lock()
                .unwrap()
                .execute(
                    "UPDATE generation_tasks SET created_at = ?1 WHERE id = ?2",
                    params![index * 1000, id],
                )
                .unwrap();
        }
        let query: GenerationTaskListQuery = serde_json::from_value(json!({
            "canvasId": "date-canvas", "sourceNodeId": "date-node", "statuses": ["created"],
            "createdFrom": 1000, "createdTo": 3000, "limit": 2
        }))
        .unwrap();
        let first = storage.list_tasks(&query).unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.created_at)
                .collect::<Vec<_>>(),
            vec![3000, 2000]
        );
        assert_eq!(first.next_cursor_created_before, Some(2000));
        let second = storage
            .list_tasks(&GenerationTaskListQuery {
                cursor_created_before: first.next_cursor_created_before,
                ..query.clone()
            })
            .unwrap();
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| item.created_at)
                .collect::<Vec<_>>(),
            vec![1000]
        );
        assert_eq!(second.next_cursor_created_before, None);
        for (from, to) in [(Some(3001), Some(3000)), (Some(-1), None), (None, Some(-1))] {
            assert!(
                storage
                    .list_tasks(&GenerationTaskListQuery {
                        created_from: from,
                        created_to: to,
                        ..query.clone()
                    })
                    .is_err()
            );
        }
    }

    #[test]
    fn local_asset_listing_only_returns_completed_object_storage_uploads() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        let make_job =
            |id: &str,
             purpose: &str,
             status: StagingStatus,
             import_target: Option<StagingAssetImportTarget>| StagingJobRecord {
                id: id.into(),
                local_path: format!("C:/media/{id}.png"),
                purpose: purpose.into(),
                media_type: MediaType::Image,
                object_key: Some(format!("assets/{id}.png")),
                status,
                bytes_total: Some(128),
                bytes_uploaded: 128,
                asset_id: None,
                import_target,
                error: None,
                created_at: 1,
                updated_at: 1,
            };
        storage
            .insert_staging_job(&make_job(
                "local-ready",
                "local_asset",
                StagingStatus::Staged,
                None,
            ))
            .expect("insert local asset");
        storage
            .insert_staging_job(&make_job(
                "cloud-ready",
                "asset_import",
                StagingStatus::Active,
                Some(StagingAssetImportTarget {
                    provider_connection_id: "company".into(),
                    name: None,
                    group_id: None,
                }),
            ))
            .expect("insert cloud asset");
        storage
            .insert_staging_job(&make_job(
                "local-uploading",
                "local_asset",
                StagingStatus::Uploading,
                None,
            ))
            .expect("insert unfinished local asset");

        let jobs = storage.list_local_asset_jobs().expect("list local assets");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "local-ready");
    }

    #[test]
    fn migration_creates_a_file_database_and_seeds_models() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        let storage = Storage::open(&path).expect("open database");

        assert!(path.exists());
        let models = storage.list_model_definitions().expect("list models");
        assert!(models.iter().any(|model| model.id == "gpt-image-2"));
        assert!(
            models
                .iter()
                .any(|model| model.id == "doubao-seedance-2-5-260628")
        );
        let providers = storage
            .list_provider_connections()
            .expect("list default providers");
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.display_name.as_str())
                .collect::<Vec<_>>(),
            vec!["MAIGateway", "SD2.0", "海外平台", "火山引擎", "魔芋AI"]
        );
        assert!(providers.iter().all(|provider| !provider.enabled));
        let encoding: String = storage
            .lock()
            .expect("database lock")
            .query_row("PRAGMA encoding", [], |row| row.get(0))
            .expect("read encoding");
        assert_eq!(encoding, "UTF-8");
    }

    #[test]
    fn text_generation_output_roundtrips_through_task_detail() {
        let directory = TempDir::new().expect("temp dir");
        let storage =
            Arc::new(Storage::open(&directory.path().join("backend.sqlite")).expect("open db"));
        let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
        let provider = storage
            .get_provider_connection("provider-sd20")
            .expect("default provider");
        let model = storage
            .list_model_definitions()
            .expect("models")
            .into_iter()
            .next()
            .expect("seeded model");
        lifecycle
            .create(NewTask {
                id: "text-task-1",
                canvas_id: "canvas-1",
                source_node_id: "prompt-1",
                operation: GenerationOperation::TextGeneration,
                provider: &provider,
                api_key_ref: &provider.api_key_ref,
                model_definition_id: &model.id,
                remote_model_id: model.remote_model_id.as_deref(),
                logical_request: &json!({ "userPrompt": "原始创意" }),
            })
            .expect("insert task");
        lifecycle
            .commit(
                "text-task-1",
                GenerationLifecycleFact::BeginTextGeneration {
                    attempt_id: "text-attempt-1".into(),
                },
            )
            .expect("begin text generation");
        lifecycle
            .commit(
                "text-task-1",
                GenerationLifecycleFact::ProviderCallPrepared {
                    call_id: "text-call-1".into(),
                    attempt_id: "text-attempt-1".into(),
                    phase: "text_generation".into(),
                    request: json!({ "method": "POST" }),
                },
            )
            .expect("prepare text call");
        lifecycle
            .commit(
                "text-task-1",
                GenerationLifecycleFact::ProviderCallSent {
                    call_id: "text-call-1".into(),
                    sent_at: 1,
                },
            )
            .expect("send text call");
        lifecycle
            .commit(
                "text-task-1",
                GenerationLifecycleFact::ProviderCallResponded {
                    call_id: "text-call-1".into(),
                    sent_at: 1,
                    status: 200,
                    headers: json!({}),
                    raw_response: "{}".into(),
                },
            )
            .expect("finish text call");
        lifecycle
            .commit(
                "text-task-1",
                GenerationLifecycleFact::TextGenerationSucceeded {
                    attempt_id: "text-attempt-1".into(),
                    call_id: "text-call-1".into(),
                    tokens: None,
                    optimized_prompt: "节点实际采用文本".into(),
                    raw_model_output: "模型完整原始文本".into(),
                },
            )
            .expect("finish text generation");

        let detail = storage.get_task_detail("text-task-1").expect("task detail");
        let output = detail.text_output.expect("text output");
        assert_eq!(output.optimized_prompt, "节点实际采用文本");
        assert_eq!(output.raw_model_output, "模型完整原始文本");
    }

    #[test]
    fn provider_updates_keep_a_stable_credential_reference() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        let mut command = UpsertProviderConnectionCommand {
            id: "company-prod".into(),
            display_name: "公司生产环境".into(),
            adapter_id: "moyu_v1".into(),
            base_url: "https://www.moyu.info".into(),
            enabled: true,
        };
        let original = storage
            .upsert_provider_connection(&command)
            .expect("insert provider");
        command.display_name = "已改名".into();
        command.base_url = "https://example.invalid/".into();
        let updated = storage
            .upsert_provider_connection(&command)
            .expect("update provider");

        assert_eq!(original.api_key_ref, updated.api_key_ref);
        assert_eq!(updated.display_name, "已改名");
    }

    #[test]
    fn replacing_discovered_models_disables_removed_bindings() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: "company-prod".into(),
                display_name: "公司生产环境".into(),
                adapter_id: "moyu_v1".into(),
                base_url: "https://example.com/v1".into(),
                enabled: true,
            })
            .expect("insert provider");

        let bindings = storage
            .replace_provider_model_bindings(&ReplaceProviderModelBindingsCommand {
                provider_connection_id: "company-prod".into(),
                selections: vec![ProviderModelSelection {
                    model_definition_id: "remote::company-prod::company-video-1".into(),
                    display_name: "公司视频模型".into(),
                    remote_model_id: "company-video-1".into(),
                    enabled: true,
                    enabled_operations: vec![GenerationOperation::VideoGeneration],
                    token_group: None,
                    operation_schema: json!({
                        "video_generation": {
                            "parameters": {
                                "frames": {
                                    "type": "integer",
                                    "default": 48,
                                    "requestField": "frame_count"
                                }
                            }
                        }
                    }),
                }],
            })
            .expect("save selection");
        assert_eq!(bindings.len(), 1);
        assert!(bindings[0].enabled);
        assert_eq!(
            bindings[0].enabled_operations,
            [GenerationOperation::VideoGeneration]
        );
        let saved_model = storage
            .list_model_definitions()
            .expect("list models")
            .into_iter()
            .find(|model| model.id == "remote::company-prod::company-video-1")
            .expect("saved discovered model");
        assert_eq!(
            saved_model.operations["video_generation"]["parameters"]["frames"]["requestField"],
            "frame_count"
        );

        let bindings = storage
            .replace_provider_model_bindings(&ReplaceProviderModelBindingsCommand {
                provider_connection_id: "company-prod".into(),
                selections: Vec::new(),
            })
            .expect("clear selections");
        assert_eq!(bindings.len(), 1);
        assert!(!bindings[0].enabled);

        let bindings = storage
            .replace_provider_model_bindings(&ReplaceProviderModelBindingsCommand {
                provider_connection_id: "company-prod".into(),
                selections: vec![ProviderModelSelection {
                    model_definition_id: "remote::company-prod::declined-image".into(),
                    display_name: "不启用的推荐图片模型".into(),
                    remote_model_id: "declined-image".into(),
                    enabled: false,
                    enabled_operations: Vec::new(),
                    token_group: None,
                    operation_schema: default_model_schema(
                        "declined-image",
                        &[GenerationOperation::TextToImage],
                    ),
                }],
            })
            .expect("remember disabled selection");
        let disabled = bindings
            .iter()
            .find(|binding| binding.model_definition_id.ends_with("declined-image"))
            .expect("disabled binding");
        assert!(!disabled.enabled);
        assert!(disabled.enabled_operations.is_empty());
    }

    #[test]
    fn provider_scoped_models_keep_same_remote_id_independent() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        for provider_id in ["provider-image", "provider-video"] {
            storage
                .upsert_provider_connection(&UpsertProviderConnectionCommand {
                    id: provider_id.into(),
                    display_name: provider_id.into(),
                    adapter_id: "moyu_v1".into(),
                    base_url: format!("https://{provider_id}.example/v1"),
                    enabled: true,
                })
                .expect("insert provider");
        }

        let cases = [
            (
                "provider-image",
                "remote::provider-image::shared-model",
                GenerationOperation::TextToImage,
            ),
            (
                "provider-video",
                "remote::provider-video::shared-model",
                GenerationOperation::VideoGeneration,
            ),
        ];
        for (provider_id, definition_id, operation) in cases {
            storage
                .replace_provider_model_bindings(&ReplaceProviderModelBindingsCommand {
                    provider_connection_id: provider_id.into(),
                    selections: vec![ProviderModelSelection {
                        model_definition_id: definition_id.into(),
                        display_name: "Shared model".into(),
                        remote_model_id: "shared-model".into(),
                        enabled: true,
                        enabled_operations: vec![operation],
                        token_group: None,
                        operation_schema: default_model_schema("shared-model", &[operation]),
                    }],
                })
                .expect("save provider model");
        }

        let definitions = storage.list_model_definitions().expect("list definitions");
        let image = definitions
            .iter()
            .find(|model| model.id == "remote::provider-image::shared-model")
            .expect("image definition");
        let video = definitions
            .iter()
            .find(|model| model.id == "remote::provider-video::shared-model")
            .expect("video definition");
        assert!(image.operations.get("text_to_image").is_some());
        assert!(image.operations.get("video_generation").is_none());
        assert!(video.operations.get("video_generation").is_some());
        assert!(video.operations.get("text_to_image").is_none());
    }

    #[test]
    fn legacy_bare_model_bindings_are_migrated_to_provider_scoped_ids() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: "company-prod".into(),
                display_name: "公司生产环境".into(),
                adapter_id: "moyu_v1".into(),
                base_url: "https://example.com/v1".into(),
                enabled: true,
            })
            .expect("insert provider");

        // 模拟历史版本写入的裸模型 ID 绑定（旧版允许把远程模型 ID 直接当模型定义 ID 保存）
        let timestamp = now_ms();
        {
            let connection = storage.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('company-video-1', '公司视频模型', 'company-video-1', '{}', ?1, ?1)",
                    params![timestamp],
                )
                .expect("insert legacy definition");
            connection
                .execute(
                    "INSERT INTO provider_model_bindings
                     (provider_connection_id, model_definition_id, enabled_operations_json,
                      remote_model_id, enabled, created_at, updated_at)
                     VALUES ('company-prod', 'company-video-1', '[\"video_generation\"]',
                             'company-video-1', 1, ?1, ?1)",
                    params![timestamp],
                )
                .expect("insert legacy binding");
        }

        storage.migrate_legacy_model_bindings().expect("migrate");

        let bindings = storage
            .list_bindings(Some("company-prod"))
            .expect("list bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            bindings[0].model_definition_id,
            "remote::company-prod::company-video-1"
        );
        assert_eq!(
            bindings[0].remote_model_id.as_deref(),
            Some("company-video-1")
        );
        assert!(bindings[0].enabled);
        assert_eq!(
            bindings[0].enabled_operations,
            [GenerationOperation::VideoGeneration]
        );

        // 作用域 definition 已创建，旧裸 ID definition 保留（避免破坏生成任务快照引用）
        let definitions = storage.list_model_definitions().expect("list definitions");
        let scoped = definitions
            .iter()
            .find(|model| model.id == "remote::company-prod::company-video-1")
            .expect("scoped definition created");
        assert_eq!(scoped.display_name, "公司视频模型");
        assert!(
            definitions
                .iter()
                .any(|model| model.id == "company-video-1")
        );
    }

    #[test]
    fn malformed_operation_schema_is_repaired_on_open() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        // 先建库（触发 seed/migrate/repair 链路）
        let storage = Storage::open(&path).expect("open db");
        let timestamp = now_ms();
        {
            let connection = storage.lock().expect("database lock");
            // 历史版本写入的畸形操作 Schema：只有 resultType，缺 parameters/request
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('remote::company-prod::doubao-seedance-2.5', 'Seedance 2.5',
                             'doubao-seedance-2.5',
                             '{\"image_to_image\":{\"resultType\":\"image\"},\"text_to_image\":{\"resultType\":\"image\"},\"video_generation\":{\"resultType\":\"video\"}}',
                             ?1, ?1)",
                    params![timestamp],
                )
                .expect("insert malformed definition");
            // 非法作用域 ID（缺 provider 段）的孤儿行
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('remote::doubao-seedance-2.5', 'Seedance 2.5', 'doubao-seedance-2.5',
                             '{}', ?1, ?1)",
                    params![timestamp],
                )
                .expect("insert orphan definition");
        }

        // 重新打开，触发 repair_malformed_model_definitions
        drop(storage);
        let storage = Storage::open(&path).expect("reopen db");

        let definitions = storage.list_model_definitions().expect("list definitions");
        let malformed = definitions
            .iter()
            .find(|model| model.id == "remote::company-prod::doubao-seedance-2.5")
            .expect("malformed definition repaired");
        assert!(
            malformed.operations["image_to_image"]["parameters"].is_object(),
            "image_to_image parameters must be repaired"
        );
        assert!(
            malformed.operations["video_generation"]["parameters"].is_object(),
            "video_generation parameters must be repaired"
        );
        assert_eq!(
            malformed.operations["video_generation"]["resultType"],
            "video"
        );

        // 非法作用域 ID 的孤儿行应被清理
        assert!(
            !definitions
                .iter()
                .any(|model| model.id == "remote::doubao-seedance-2.5"),
            "orphan malformed scoped id must be deleted"
        );
    }

    #[test]
    fn legacy_gpt_image_parameter_defaults_are_migrated_on_open() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        let storage = Storage::open(&path).expect("open db");
        let timestamp = now_ms();
        // 历史版本持久化的 gpt-image 文生图参数：dall-e 契约（standard/hd）。
        let legacy_parameters = r#"{"size":{"type":"string","label":"尺寸","default":"1024x1024","enum":["256x256","512x512","1024x1024","1536x1024","1024x1536","1792x1024","1024x1792"]},"quality":{"type":"string","label":"质量","default":"standard","enum":["hd","standard"]}}"#;
        {
            let connection = storage.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('remote::company-prod::gpt-image-2', 'GPT Image 2', 'gpt-image-2',
                             ?2, ?1, ?1)",
                    params![
                        timestamp,
                        format!(r#"{{"text_to_image":{{"resultType":"image","parameters":{legacy_parameters}}}}}"#)
                    ],
                )
                .expect("insert legacy gpt-image definition");
        }

        drop(storage);
        let storage = Storage::open(&path).expect("reopen db");

        let definitions = storage.list_model_definitions().expect("list definitions");
        let definition = definitions
            .iter()
            .find(|model| model.id == "remote::company-prod::gpt-image-2")
            .expect("legacy gpt-image definition");
        let parameters = &definition.operations["text_to_image"]["parameters"];
        assert_eq!(parameters["quality"]["default"], "auto");
        assert_eq!(
            parameters["quality"]["enum"],
            json!(["auto", "high", "medium", "low"])
        );
        assert_eq!(parameters["size"]["default"], "auto");
        assert_eq!(
            parameters["size"]["enum"],
            json!(["auto", "1024x1024", "1536x1024", "1024x1536"])
        );
    }

    #[test]
    fn stale_wan_video_definition_is_migrated_on_open() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        let storage = Storage::open(&path).expect("open db");
        let timestamp = now_ms();
        {
            let connection = storage.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('remote::company-prod::wan3.0-video', 'wan3.0-video', 'wan3.0-video',
                             ?2, ?1, ?1)",
                    params![
                        timestamp,
                        json!({
                            "video_generation": {
                                "resultType": "video",
                                "requestProfileId": "moyu_video_metadata_v1",
                                "profileVersion": 1,
                                "request": {
                                    "path": "/v1/video/generations",
                                    "encoding": "json",
                                    "parameterContainer": "metadata"
                                },
                                "parameters": {}
                            }
                        })
                        .to_string()
                    ],
                )
                .expect("insert stale Wan definition");
        }

        drop(storage);
        let storage = Storage::open(&path).expect("reopen db");
        let definition = storage
            .list_model_definitions()
            .expect("list definitions")
            .into_iter()
            .find(|model| model.id == "remote::company-prod::wan3.0-video")
            .expect("migrated Wan definition");
        let operation = &definition.operations["video_generation"];
        assert_eq!(operation["requestProfileId"], "moyu_wan3_video_v1");
        assert_eq!(operation["request"]["parameterContainer"], "root");
        assert_eq!(operation["request"]["mediaEncoding"], "wan_media_array");
        assert_eq!(operation["parameters"]["resolution"]["default"], "1080P");
        assert_eq!(operation["parameters"]["watermark"]["default"], false);
    }

    #[test]
    fn stale_domestic_seedance_25_definition_is_migrated_on_open() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        let storage = Storage::open(&path).expect("open db");
        let timestamp = now_ms();
        {
            let connection = storage.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO model_definitions
                     (id, display_name, remote_model_id, operations_json, created_at, updated_at)
                     VALUES ('remote::company-prod::doubao-seedance-2-5-260628', 'Seedance 2.5', 'doubao-seedance-2-5-260628',
                             ?2, ?1, ?1)",
                    params![
                        timestamp,
                        json!({
                            "video_generation": {
                                "resultType": "video",
                                "requestProfileId": "moyu_video_metadata_v1",
                                "profileVersion": 1,
                                "request": {
                                    "path": "/v1/video/generations",
                                    "encoding": "json",
                                    "parameterContainer": "metadata"
                                },
                                "parameters": {
                                    "ratio": { "type": "string", "label": "画幅", "default": "adaptive", "enum": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] },
                                    "resolution": { "type": "string", "label": "分辨率", "default": "720p", "enum": ["720p", "480p"] },
                                    "duration": { "type": "integer", "label": "时长", "default": -1, "enum": [-1] },
                                    "generate_audio": { "type": "boolean", "label": "生成音频", "default": true },
                                    "output_format": { "type": "string", "label": "输出格式", "default": "mp4", "enum": ["mp4", "mov"] },
                                    "omni_reference_task_type": { "type": "string", "label": "任务类型", "default": "auto", "enum": ["auto", "reference", "edit", "extend"] }
                                }
                            }
                        })
                        .to_string()
                    ],
                )
                .expect("insert stale Seedance 2.5 definition");
        }

        drop(storage);
        let storage = Storage::open(&path).expect("reopen db");
        let definition = storage
            .list_model_definitions()
            .expect("list definitions")
            .into_iter()
            .find(|model| model.id == "remote::company-prod::doubao-seedance-2-5-260628")
            .expect("migrated Seedance 2.5 definition");
        let parameters = &definition.operations["video_generation"]["parameters"];
        assert_eq!(
            parameters["resolution"]["enum"],
            json!(["720p", "480p", "1080p"])
        );
        assert_eq!(parameters["web_search"]["transform"], "web_search_tool");
    }

    #[test]
    fn canvas_save_uses_optimistic_revisions() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        let first = storage
            .save_canvas_document(&SaveCanvasDocumentCommand {
                id: "canvas-1".into(),
                title: "故事板 🎬".into(),
                document: json!({
                    "nodes": [{ "id": "prompt-1", "text": "中文与四字节字符：𠮷 😀" }],
                    "edges": []
                }),
                expected_revision: Some(0),
            })
            .expect("first save");
        assert_eq!(first.revision, 1);
        assert_eq!(first.title, "故事板 🎬");
        assert_eq!(
            first
                .document
                .pointer("/nodes/0/text")
                .and_then(Value::as_str),
            Some("中文与四字节字符：𠮷 😀")
        );

        let second = storage
            .save_canvas_document(&SaveCanvasDocumentCommand {
                id: "canvas-1".into(),
                title: "故事板".into(),
                document: json!({ "nodes": [{ "id": "prompt-1" }], "edges": [] }),
                expected_revision: Some(1),
            })
            .expect("second save");
        assert_eq!(second.revision, 2);
        assert_eq!(storage.list_canvas_documents().expect("list").len(), 1);

        let stale = storage.save_canvas_document(&SaveCanvasDocumentCommand {
            id: "canvas-1".into(),
            title: "过期写入".into(),
            document: json!({}),
            expected_revision: Some(1),
        });
        assert!(matches!(stale, Err(BackendError::Conflict(_))));
    }

    #[test]
    fn canvas_delete_preserves_other_canvases_histories_and_files_after_reopen() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        let media_path = directory.path().join("generated.png");
        std::fs::write(&media_path, b"saved media").expect("write media");
        let storage = Storage::open(&path).expect("open db");
        // A quoted ID also checks that deletion binds its target as a SQL parameter.
        let deleted_id = "canvas-1'; DELETE FROM generation_tasks; --";
        for id in [deleted_id, "canvas-2"] {
            storage
                .save_canvas_document(&SaveCanvasDocumentCommand {
                    id: id.into(),
                    title: id.into(),
                    document: json!({ "nodes": [{ "path": media_path }] }),
                    expected_revision: None,
                })
                .expect("save canvas");
        }
        let workflow = storage
            .save_workflow_history(
                serde_json::from_value(json!({
                    "record": {
                        "id": "run-1", "canvasId": deleted_id, "sourceNodeId": "node-1",
                        "workflowKind": "knowledge", "title": "知识视频", "status": "planning",
                        "progress": 10, "message": "制作中", "nodeSnapshot": {
                            "key": "node-1", "kind": "knowledge_video_workflow",
                            "config": { "checkpoint": { "phase": "planning", "imagePath": media_path } }
                        },
                        "models": [], "attemptCount": 1, "revision": 0, "createdAt": 0, "updatedAt": 0
                    },
                    "event": { "phase": "planning", "progress": 10, "message": "制作中" }
                }))
                .expect("workflow command"),
            )
            .expect("save workflow history");
        let provider = storage.get_provider_connection("provider-sd20").unwrap();
        storage
            .insert_task(NewTask {
                id: "task-1",
                canvas_id: deleted_id,
                source_node_id: "node-1",
                operation: GenerationOperation::TextToImage,
                provider: &provider,
                api_key_ref: &provider.api_key_ref,
                model_definition_id: "gpt-image-2",
                remote_model_id: Some("gpt-image-2"),
                logical_request: &json!({}),
            })
            .expect("save generation history");

        storage.delete_canvas_document(deleted_id).expect("delete");
        storage
            .delete_canvas_document(deleted_id)
            .expect("delete missing");
        drop(storage);
        let reopened = Storage::open(&path).expect("reopen db");
        assert!(matches!(
            reopened.get_canvas_document(deleted_id),
            Err(BackendError::NotFound(_))
        ));
        let canvases = reopened.list_canvas_documents().expect("list");
        assert_eq!(canvases.len(), 1);
        assert_eq!(canvases[0].id, "canvas-2");
        assert_eq!(
            reopened
                .get_task_execution("task-1")
                .expect("task history")
                .id,
            "task-1"
        );
        let history = reopened
            .get_workflow_history("run-1")
            .expect("workflow history");
        assert_eq!(history.record.node_snapshot, workflow.node_snapshot);
        assert_eq!(history.events.len(), 1);
        assert_eq!(
            std::fs::read(&media_path).expect("read media"),
            b"saved media"
        );
    }

    #[test]
    fn canvas_delete_failure_keeps_the_saved_document() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        let document = json!({ "nodes": [{ "id": "prompt-1", "text": "保留原稿" }] });
        storage
            .save_canvas_document(&SaveCanvasDocumentCommand {
                id: "canvas-1".into(),
                title: "故事板".into(),
                document: document.clone(),
                expected_revision: None,
            })
            .expect("save canvas");
        storage
            .lock()
            .expect("connection")
            .execute_batch(
                "CREATE TRIGGER prevent_canvas_delete BEFORE DELETE ON canvas_documents
                 BEGIN SELECT RAISE(FAIL, 'delete blocked'); END;",
            )
            .expect("block deletion");

        assert!(storage.delete_canvas_document("canvas-1").is_err());
        let retained = storage
            .get_canvas_document("canvas-1")
            .expect("retained canvas");
        assert_eq!(retained.document, document);
        assert_eq!(retained.revision, 1);
        assert_eq!(storage.list_canvas_documents().expect("list").len(), 1);
    }

    #[test]
    fn provider_token_groups_crud_and_credential_ref_resolution() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: "company-prod".into(),
                display_name: "公司生产环境".into(),
                adapter_id: "moyu_v1".into(),
                base_url: "https://example.com/v1".into(),
                enabled: true,
            })
            .expect("insert provider");

        // 默认令牌 = 供应商主 API Key，无论是否配置分组都返回主引用。
        let provider = storage
            .get_provider_connection("company-prod")
            .expect("provider");
        assert_eq!(
            storage
                .resolve_binding_credential_ref("company-prod", None)
                .expect("default token"),
            provider.api_key_ref
        );
        // 分组不存在时报错，而不是静默回退主令牌。
        assert!(matches!(
            storage.resolve_binding_credential_ref("company-prod", Some("as分组")),
            Err(BackendError::Conflict(_))
        ));

        let group = storage
            .upsert_provider_token_group(&UpsertProviderTokenGroupCommand {
                provider_connection_id: "company-prod".into(),
                group_name: "as分组".into(),
                enabled: true,
                secret: None,
            })
            .expect("insert token group");
        assert_eq!(group.group_name, "as分组");
        assert!(
            group
                .credential_ref
                .starts_with("provider:company-prod:token:")
        );

        // 同组再次 upsert 保留原凭据引用（幂等）。
        let again = storage
            .upsert_provider_token_group(&UpsertProviderTokenGroupCommand {
                provider_connection_id: "company-prod".into(),
                group_name: "as分组".into(),
                enabled: false,
                secret: None,
            })
            .expect("upsert same group");
        assert_eq!(again.credential_ref, group.credential_ref);
        assert!(!again.enabled);

        let groups = storage
            .list_provider_token_groups("company-prod")
            .expect("list groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(
            storage
                .get_provider_token_group("company-prod", "as分组")
                .expect("get group")
                .expect("group exists")
                .id,
            group.id
        );

        // 解析绑定凭据引用：Some 分组名命中该分组的 credential_ref。
        assert_eq!(
            storage
                .resolve_binding_credential_ref("company-prod", Some("as分组"))
                .expect("resolve as group"),
            group.credential_ref
        );

        // 空名 / 超长名被校验拒绝。
        assert!(matches!(
            storage.upsert_provider_token_group(&UpsertProviderTokenGroupCommand {
                provider_connection_id: "company-prod".into(),
                group_name: "  ".into(),
                enabled: true,
                secret: None,
            }),
            Err(BackendError::Validation { .. })
        ));

        // 删除分组返回其凭据引用，之后解析报错。
        assert_eq!(
            storage
                .delete_provider_token_group("company-prod", "as分组")
                .expect("delete group")
                .expect("had credential ref"),
            group.credential_ref
        );
        assert!(
            storage
                .list_provider_token_groups("company-prod")
                .expect("list after delete")
                .is_empty()
        );
        assert!(matches!(
            storage.resolve_binding_credential_ref("company-prod", Some("as分组")),
            Err(BackendError::Conflict(_))
        ));
    }

    #[test]
    fn model_binding_persists_token_group_and_delete_resets_it_to_default() {
        let directory = TempDir::new().expect("temp dir");
        let storage = Storage::open(&directory.path().join("backend.sqlite")).expect("open db");
        storage
            .upsert_provider_connection(&UpsertProviderConnectionCommand {
                id: "company-prod".into(),
                display_name: "公司生产环境".into(),
                adapter_id: "moyu_v1".into(),
                base_url: "https://example.com/v1".into(),
                enabled: true,
            })
            .expect("insert provider");
        storage
            .upsert_provider_token_group(&UpsertProviderTokenGroupCommand {
                provider_connection_id: "company-prod".into(),
                group_name: "as分组".into(),
                enabled: true,
                secret: None,
            })
            .expect("insert token group");

        storage
            .replace_provider_model_bindings(&ReplaceProviderModelBindingsCommand {
                provider_connection_id: "company-prod".into(),
                selections: vec![
                    ProviderModelSelection {
                        model_definition_id: "remote::company-prod::company-sd".into(),
                        display_name: "公司 SD".into(),
                        remote_model_id: "company-sd".into(),
                        enabled: true,
                        enabled_operations: vec![GenerationOperation::TextToImage],
                        token_group: Some("as分组".into()),
                        operation_schema: default_model_schema(
                            "company-sd",
                            &[GenerationOperation::TextToImage],
                        ),
                    },
                    ProviderModelSelection {
                        model_definition_id: "remote::company-prod::company-image".into(),
                        display_name: "公司图片".into(),
                        remote_model_id: "company-image".into(),
                        enabled: true,
                        enabled_operations: vec![GenerationOperation::TextToImage],
                        token_group: None,
                        operation_schema: default_model_schema(
                            "company-image",
                            &[GenerationOperation::TextToImage],
                        ),
                    },
                ],
            })
            .expect("save selections with token groups");

        let sd = storage
            .get_binding("company-prod", "remote::company-prod::company-sd")
            .expect("sd binding");
        assert_eq!(sd.token_group.as_deref(), Some("as分组"));
        let image = storage
            .get_binding("company-prod", "remote::company-prod::company-image")
            .expect("image binding");
        assert_eq!(image.token_group, None);

        // 删除分组后，引用该分组的绑定回退到默认令牌。
        storage
            .delete_provider_token_group("company-prod", "as分组")
            .expect("delete group");
        let sd = storage
            .get_binding("company-prod", "remote::company-prod::company-sd")
            .expect("sd binding after delete");
        assert_eq!(sd.token_group, None);
    }

    #[test]
    fn migration_adds_token_group_column_to_existing_databases() {
        let directory = TempDir::new().expect("temp dir");
        let path = directory.path().join("backend.sqlite");
        // 模拟历史版本：provider_model_bindings 已有除 token_group 外的全部列。
        let connection = rusqlite::Connection::open(&path).expect("open raw db");
        connection
            .execute(
                "CREATE TABLE provider_model_bindings (
                   provider_connection_id TEXT NOT NULL,
                   model_definition_id TEXT NOT NULL,
                   enabled_operations_json TEXT NOT NULL,
                   remote_model_id TEXT,
                   enabled INTEGER NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY (provider_connection_id, model_definition_id)
                 )",
                [],
            )
            .expect("create legacy table");
        connection
            .execute(
                "INSERT INTO provider_model_bindings
                 (provider_connection_id, model_definition_id, enabled_operations_json,
                  remote_model_id, enabled, created_at, updated_at)
                 VALUES ('company-prod', 'remote::company-prod::company-sd',
                         '[\"text_to_image\"]', 'company-sd', 1, 1, 1)",
                [],
            )
            .expect("insert legacy row");

        let columns = |connection: &rusqlite::Connection| {
            let mut statement = connection
                .prepare("PRAGMA table_info(provider_model_bindings)")
                .expect("pragma");
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("columns")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect columns")
        };
        assert!(
            !columns(&connection).contains(&"token_group".to_string()),
            "legacy table must not have token_group yet"
        );

        migrate_provider_token_groups(&connection).expect("migration adds token_group");
        assert!(
            columns(&connection).contains(&"token_group".to_string()),
            "token_group column must be added by migration"
        );
        // 幂等：再次执行不报错。
        migrate_provider_token_groups(&connection).expect("migration is idempotent");
    }
}
