use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::{Datelike as _, Utc};
use futures_util::TryStreamExt as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri_plugin_log::log::{error, info, warn};
use tokio::io::AsyncReadExt as _;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::{
    asset_library::{AssetLibrary, ImportStagedAsset},
    composer::VideoCompositionService,
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    local_results::{format_bytes_per_sec, safe_file_stem},
    provider::{redact_request_value, redact_url_string, truncate_connectivity_detail},
    storage::{Storage, now_ms},
    tos_sign::{PresignParams, TosCredentials, presign_url},
    types::{
        ConnectivityTestResult, LocalAssetRecord, MediaType, StagingJobRecord, StagingStatus,
        StartStagingCommand, TosStagingConfig,
    },
};

/// 上传进度日志的节流间隔：每累计上传 1MB 记录一次，避免大文件刷屏；到达末尾必记录。
const PROGRESS_LOG_INTERVAL_BYTES: u64 = 1024 * 1024;

/// 预签名 PUT URL 有效期：15 分钟（上传窗口）。
const PUT_URL_EXPIRY_SECS: i64 = 900;

/// 预签名 GET / DELETE URL 有效期：1 小时，需覆盖素材导入轮询（最长 300 秒）与安全重试窗口。
const LEASE_URL_EXPIRY_SECS: i64 = 3600;

/// 连通性测试探针对象的预签名 URL 有效期：只需覆盖一次立即发出的请求。
const PROBE_URL_EXPIRY_SECS: i64 = 60;

/// 摸鱼素材服务（POST /v1/assets 上游）支持的图片扩展名白名单。
/// avif 等不在列表内的格式必须先转码为 webp 再导入，否则上游会以
/// `[InvalidParameter] unsupported asset URL format` 或 `DownloadFailed` 拒绝。
const SUPPORTED_IMPORT_IMAGE_EXTENSIONS: &[&str] =
    &["jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif", "heic"];

/// Windows 下隐藏 ffmpeg 子进程的控制台窗口，避免转码时弹出黑框。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 专用于 TOS 预签名请求的 HTTP 客户端。
///
/// 关键约束：**禁止自动跟随重定向**（`redirect::Policy::none()`）。
///
/// 预签名 URL 的签名绑定到请求 Host（CanonicalRequest 中 `host` 头域参与签名）。
/// 火山引擎 TOS 在「桶域名或预签名的 URL 访问限制变更」后，常对预签名请求返回
/// `301/307` 重定向到规范化 Host。若 reqwest 自动跟随，会把同一套签名查询串
/// 重放到不同 Host 上，TOS 用新 Host 重算签名即报 `SignatureDoesNotMatch`
/// （AK 合法仍被原样回显）。因此预签名请求必须原样发往签名时的 Host，
/// 3xx 由调用方显式判定为配置/域名问题，而非静默跟随导致签名失效。
fn build_presign_http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("InfiniteCanvas/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

#[derive(Clone)]
pub struct StagingService {
    storage: Arc<Storage>,
    credentials: CredentialStore,
    assets: AssetLibrary,
    /// 共享 FFmpeg 引擎：素材导入遇到不支持格式（如 avif）时用于本地转码。
    composer: VideoCompositionService,
    client: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct StagingLease {
    pub job_id: String,
    pub get_url: String,
    pub delete_url: Option<String>,
}

impl StagingService {
    pub fn new(
        storage: Arc<Storage>,
        credentials: CredentialStore,
        assets: AssetLibrary,
        composer: VideoCompositionService,
    ) -> BackendResult<Self> {
        let client = build_presign_http_client().map_err(|error| {
            BackendError::validation(
                "failed to build TOS presign HTTP client",
                json!({ "source": error.to_string() }),
            )
        })?;
        Ok(Self {
            storage,
            credentials,
            assets,
            composer,
            client,
        })
    }

    pub fn configure(&self, config: &TosStagingConfig) -> BackendResult<()> {
        validate_tos_config(config)?;
        self.storage.save_tos_config(config)
    }

    /// 连通性测试：对 `{objectPrefix}/.connectivity-probe` 探针对象发起一次预签名 GET。
    ///
    /// 判定依据（TOS 先验签再检查对象存在性）：
    /// - 2xx 或 404 + `NoSuchKey`：签名与 AK/SK 有效且桶存在，视为通过；
    /// - 404 + `NoSuchBucket`：桶不存在；
    /// - 401/403：凭据或签名被拒绝；
    /// - 其余：服务端异常状态。
    ///
    /// 网络层失败（DNS、超时）转换为 `ok=false` 的结果而不是错误，
    /// 保存动作本身已经成功，前端需要把两种结果分开提示。
    pub async fn test_connectivity(&self) -> BackendResult<ConnectivityTestResult> {
        let config = self
            .storage
            .get_tos_config()?
            .ok_or_else(|| BackendError::validation("TOS staging is not configured", json!({})))?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({}),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;

        let host = format!("{}.{}", config.bucket, config.endpoint);
        let probe_key = format!(
            "{}/.connectivity-probe",
            config.object_prefix.trim_matches('/')
        );
        let probe_url = presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key: &probe_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: PROBE_URL_EXPIRY_SECS,
            now: Utc::now(),
        })?;
        info!(
            "[staging] 开始连通性测试: bucket={}, region={}, endpoint={}, objectKey={}",
            config.bucket, config.region, config.endpoint, probe_key
        );
        let started_at = std::time::Instant::now();
        let response = self.client.get(&probe_url).send().await;
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = String::from_utf8_lossy(&response.bytes().await?).into_owned();
                let verdict = classify_probe_response(status, &body);
                info!(
                    "[staging] 连通性测试完成: HTTP {status}, verdict={}, 耗时 {}ms",
                    verdict.reason_name().unwrap_or("ok"),
                    started_at.elapsed().as_millis()
                );
                Ok(ConnectivityTestResult {
                    ok: verdict.is_ok(),
                    http_status: Some(status),
                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                    reason: verdict.reason_name().map(str::to_string),
                    detail: (!verdict.is_ok()).then(|| {
                        let code = extract_error_code(&body)
                            .map(|code| format!("code={code}, "))
                            .unwrap_or_default();
                        truncate_connectivity_detail(&format!("{code}{}", body.trim()))
                    }),
                })
            }
            Err(error) => Ok(ConnectivityTestResult {
                ok: false,
                http_status: None,
                elapsed_ms: started_at.elapsed().as_millis() as u64,
                reason: Some("network-error".to_string()),
                detail: Some(super::provider::truncate_connectivity_detail(
                    &error.to_string(),
                )),
            }),
        }
    }

    pub fn create_job(&self, command: StartStagingCommand) -> BackendResult<StagingJobRecord> {
        let timestamp = now_ms();
        let job = StagingJobRecord {
            id: Uuid::new_v4().to_string(),
            local_path: command.local_path,
            purpose: command.purpose,
            media_type: command.media_type,
            object_key: None,
            status: StagingStatus::Validating,
            bytes_total: None,
            bytes_uploaded: 0,
            asset_id: None,
            import_target: command.import,
            error: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.storage.insert_staging_job(&job)?;
        Ok(job)
    }

    /// 列出本机索引中的素材，并为每个对象生成新的只读预签名 URL。
    /// 此路径不访问供应商素材库，也不要求存在供应商连接。
    pub fn list_local_assets(&self) -> BackendResult<Vec<LocalAssetRecord>> {
        self.storage
            .list_local_asset_jobs()?
            .into_iter()
            .map(|job| {
                let object_key = job.object_key.as_deref().ok_or_else(|| {
                    BackendError::protocol(
                        "local asset upload has no object key",
                        json!({ "stagingJobId": job.id }),
                    )
                })?;
                let lease = self.presign_existing_object(&job.id, object_key)?;
                let name = Path::new(&job.local_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&job.local_path)
                    .to_string();
                Ok(LocalAssetRecord {
                    id: job.id,
                    name,
                    media_type: job.media_type,
                    object_key: object_key.to_string(),
                    preview_url: lease.get_url,
                    byte_size: job.bytes_total.unwrap_or(job.bytes_uploaded),
                    created_at: job.created_at,
                })
            })
            .collect()
    }

    /// 为一个本地素材签发新的读取地址。对象是素材正文，不返回给任务清理流程。
    pub fn local_asset_lease(
        &self,
        staging_job_id: &str,
        expected_media_type: MediaType,
    ) -> BackendResult<StagingLease> {
        let job = self.storage.get_staging_job(staging_job_id)?;
        if job.purpose != "local_asset" || job.import_target.is_some() {
            return Err(BackendError::validation(
                "staging job is not a local library asset",
                json!({ "stagingJobId": staging_job_id, "purpose": job.purpose }),
            ));
        }
        if !matches!(job.status, StagingStatus::Staged) {
            return Err(BackendError::validation(
                "local library asset is not ready",
                json!({ "stagingJobId": staging_job_id, "status": job.status.as_str() }),
            ));
        }
        if job.media_type != expected_media_type {
            return Err(BackendError::validation(
                "local library asset media type does not match the reference",
                json!({
                    "stagingJobId": staging_job_id,
                    "expected": expected_media_type,
                    "actual": job.media_type
                }),
            ));
        }
        let object_key = job.object_key.as_deref().ok_or_else(|| {
            BackendError::protocol(
                "local library asset has no object key",
                json!({ "stagingJobId": staging_job_id }),
            )
        })?;
        self.presign_existing_object(staging_job_id, object_key)
    }

    pub async fn run_job(&self, job_id: &str) -> BackendResult<StagingJobRecord> {
        let mut job = self.storage.get_staging_job(job_id)?;
        match self.run_job_inner(&mut job).await {
            Ok(()) => Ok(job),
            Err(error) => {
                job.status = StagingStatus::Failed;
                job.error = Some(error.runtime_record());
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                Err(error)
            }
        }
    }

    pub async fn stage_for_remote_input(
        &self,
        local_path: &str,
        media_type: MediaType,
    ) -> BackendResult<StagingLease> {
        let job = self.create_job(StartStagingCommand {
            local_path: local_path.to_string(),
            purpose: "generation_input".into(),
            media_type,
            import: None,
        })?;
        let mut persisted = self.storage.get_staging_job(&job.id)?;
        let lease = match self.upload(&mut persisted).await {
            Ok(lease) => lease,
            Err(error) => {
                persisted.status = StagingStatus::Failed;
                persisted.error = Some(error.runtime_record());
                persisted.updated_at = now_ms();
                self.storage.update_staging_job(&persisted)?;
                return Err(error);
            }
        };
        persisted.status = StagingStatus::InUse;
        persisted.updated_at = now_ms();
        self.storage.update_staging_job(&persisted)?;
        Ok(lease)
    }

    pub async fn cleanup_lease(&self, lease: &StagingLease) -> BackendResult<()> {
        let mut job = self.storage.get_staging_job(&lease.job_id)?;
        job.status = StagingStatus::Cleaning;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        if let Some(delete_url) = &lease.delete_url {
            let response = self.client.delete(delete_url).send().await?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
                let error = BackendError::protocol(
                    format!("TOS cleanup returned HTTP {status}"),
                    redact_request_value(&json!({ "httpStatus": status, "rawResponse": raw })),
                );
                job.error = Some(error.runtime_record());
                job.updated_at = now_ms();
                self.storage.update_staging_job(&job)?;
                return Err(error);
            }
        }
        job.status = StagingStatus::Cleaned;
        job.updated_at = now_ms();
        self.storage.update_staging_job(&job)?;
        Ok(())
    }

    async fn run_job_inner(&self, job: &mut StagingJobRecord) -> BackendResult<()> {
        let lease = self.upload(job).await?;
        let Some(import_target) = job.import_target.clone() else {
            job.status = StagingStatus::Staged;
            job.updated_at = now_ms();
            self.storage.update_staging_job(job)?;
            return Ok(());
        };

        let imported = self
            .assets
            .import_staged(ImportStagedAsset {
                provider_connection_id: import_target.provider_connection_id.clone(),
                public_url: lease.get_url.clone(),
                media_type: job.media_type,
                display_name: import_target.name.clone(),
                group_id: import_target.group_id,
            })
            .await;
        let identity = match imported {
            Ok(identity) => identity,
            Err(error) => {
                // 导入失败时尽力清理 TOS 暂存对象，避免残留；清理失败不影响原始错误返回。
                if let Err(cleanup_error) = self.cleanup_lease(&lease).await {
                    let record = cleanup_error.runtime_record();
                    warn!(
                        "[staging] 导入失败后清理暂存对象未成功（已忽略）: jobId={}, 错误: {record}",
                        job.id
                    );
                }
                return Err(error);
            }
        };

        job.asset_id = Some(identity.asset_id);
        job.status = StagingStatus::Active;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        if let Err(cleanup_error) = self.cleanup_lease(&lease).await {
            let record = cleanup_error.runtime_record();
            warn!(
                "[staging] 暂存对象清理失败（不影响导入结果）: jobId={}, 错误: {record}",
                job.id
            );
        }
        Ok(())
    }

    async fn upload(&self, job: &mut StagingJobRecord) -> BackendResult<StagingLease> {
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({ "jobId": job.id }),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;

        let local_path = Path::new(&job.local_path);
        let source_metadata = tokio::fs::metadata(local_path).await?;
        if !source_metadata.is_file() {
            return Err(BackendError::validation(
                "staging input must be a readable file",
                json!({ "localPath": job.local_path }),
            ));
        }
        let (mut mime_type, mut extension) = detect_local_media(local_path, job.media_type).await?;
        // avif 等摸鱼素材库不支持的图片扩展名 → 先用共享 FFmpeg 引擎转码为 webp，
        // 再对转码产物做预签名上传与素材导入；转码临时文件随本函数退出自动清理。
        let mut upload_path = local_path.to_path_buf();
        let _converted_guard = if job.media_type == MediaType::Image
            && !SUPPORTED_IMPORT_IMAGE_EXTENSIONS.contains(&extension.as_str())
        {
            let (temp_path, transcode_ext, transcode_mime) =
                transcode_local_media(&self.composer, &job.id, local_path, &extension).await?;
            mime_type = transcode_mime;
            extension = transcode_ext;
            upload_path = temp_path;
            Some(TempFileGuard(Some(upload_path.clone())))
        } else {
            None
        };
        let metadata = tokio::fs::metadata(&upload_path).await?;
        job.bytes_total = Some(metadata.len());
        job.status = StagingStatus::Authorizing;
        job.object_key = Some(build_object_key(&config, &extension));
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;

        let object_key = job.object_key.clone().unwrap_or_default();
        let host = format!("{}.{}", config.bucket, config.endpoint);
        let presign_started = std::time::Instant::now();
        info!(
            "[staging] 本地生成 TOS 预签名地址: jobId={}, objectKey={}, 大小 {} 字节, mime={}, bucket={}, region={}, endpoint={}",
            job.id,
            object_key,
            metadata.len(),
            mime_type,
            config.bucket,
            config.region,
            config.endpoint
        );
        let now = Utc::now();
        let put_url = presign_url(&PresignParams {
            method: "PUT",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: PUT_URL_EXPIRY_SECS,
            now,
        })?;
        let get_url = presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        let delete_url = presign_url(&PresignParams {
            method: "DELETE",
            host: &host,
            object_key: &object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        info!(
            "[staging] 预签名地址生成完成: jobId={}, objectKey={}, putUrl={}, getUrl={}, deleteUrl={}, 耗时 {}ms",
            job.id,
            object_key,
            redact_url_string(&put_url),
            redact_url_string(&get_url),
            redact_url_string(&delete_url),
            presign_started.elapsed().as_millis()
        );

        job.status = StagingStatus::Uploading;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        info!(
            "[staging] 开始上传到对象存储: jobId={}, objectKey={}, 大小 {} 字节",
            job.id,
            object_key,
            metadata.len()
        );
        let file = tokio::fs::File::open(&upload_path).await?;
        let upload_started = std::time::Instant::now();
        let uploaded = Arc::new(AtomicU64::new(0));
        let last_logged_bytes = Arc::new(AtomicU64::new(0));
        let progress_counter = Arc::clone(&uploaded);
        let log_counter = Arc::clone(&last_logged_bytes);
        let storage = Arc::clone(&self.storage);
        let job_id = job.id.clone();
        let total_bytes = metadata.len();
        let stream = ReaderStream::new(file).inspect_ok(move |chunk| {
            let chunk_len = chunk.len() as u64;
            let total = progress_counter.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
            let _ = storage.update_staging_progress(&job_id, total);
            // 节流记录进度：每累计 1MB 或到达末尾记录一次，用于排查上传卡住。
            let last = log_counter.load(Ordering::Relaxed);
            let reached_end = total >= total_bytes;
            if (total >= last + PROGRESS_LOG_INTERVAL_BYTES || reached_end)
                && log_counter
                    .compare_exchange(last, total, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                let elapsed = upload_started.elapsed();
                let percent = total
                    .saturating_mul(100)
                    .checked_div(total_bytes)
                    .unwrap_or(100);
                info!(
                    "[staging] 上传进度更新: jobId={}, {}/{} 字节（{}%）, 已耗时 {}ms, 平均速度 {}/s",
                    job_id,
                    total,
                    total_bytes,
                    percent,
                    elapsed.as_millis(),
                    format_bytes_per_sec(total as usize, elapsed)
                );
            }
        });
        let upload = self
            .client
            .put(&put_url)
            .header(reqwest::header::CONTENT_TYPE, &mime_type)
            .header(reqwest::header::CONTENT_LENGTH, metadata.len())
            .body(reqwest::Body::wrap_stream(stream));
        let response = upload.send().await?;
        info!(
            "[staging] 对象存储上传请求完成: jobId={}, HTTP {}, 耗时 {}ms",
            job.id,
            response.status().as_u16(),
            upload_started.elapsed().as_millis()
        );
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
            error!(
                "[staging] 对象存储上传失败: jobId={}, HTTP {status}, 耗时 {}ms, 响应体见错误详情",
                job.id,
                upload_started.elapsed().as_millis()
            );
            return Err(BackendError::protocol(
                format!("TOS upload returned HTTP {status}"),
                redact_request_value(&json!({
                    "httpStatus": status,
                    "rawResponse": raw
                })),
            ));
        }
        job.bytes_uploaded = metadata.len();
        job.status = StagingStatus::Staged;
        job.updated_at = now_ms();
        self.storage.update_staging_job(job)?;
        info!(
            "[staging] 上传全部完成: jobId={}, 共 {} 字节, 总耗时 {}ms, 平均速度 {}/s",
            job.id,
            metadata.len(),
            upload_started.elapsed().as_millis(),
            format_bytes_per_sec(metadata.len() as usize, upload_started.elapsed())
        );
        Ok(StagingLease {
            job_id: job.id.clone(),
            get_url,
            delete_url: Some(delete_url),
        })
    }

    fn presign_existing_object(
        &self,
        job_id: &str,
        object_key: &str,
    ) -> BackendResult<StagingLease> {
        let config = self.storage.get_tos_config()?.ok_or_else(|| {
            BackendError::validation(
                "TOS staging is not configured",
                json!({ "required": ["bucket", "region", "endpoint", "objectPrefix"] }),
            )
        })?;
        if !config.enabled {
            return Err(BackendError::validation(
                "TOS staging is disabled",
                json!({ "jobId": job_id }),
            ));
        }
        let credential_ref = config.credential_ref.as_deref().ok_or_else(|| {
            BackendError::validation(
                "TOS staging credentials are not configured",
                json!({ "required": ["accessKey", "secretKey"] }),
            )
        })?;
        let credentials = TosCredentials::parse(&self.credentials.get(credential_ref)?)?;
        let host = format!("{}.{}", config.bucket, config.endpoint);
        let now = Utc::now();
        let get_url = presign_url(&PresignParams {
            method: "GET",
            host: &host,
            object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        let delete_url = presign_url(&PresignParams {
            method: "DELETE",
            host: &host,
            object_key,
            region: &config.region,
            credentials: &credentials,
            expires_secs: LEASE_URL_EXPIRY_SECS,
            now,
        })?;
        Ok(StagingLease {
            job_id: job_id.to_string(),
            get_url,
            delete_url: Some(delete_url),
        })
    }
}

async fn detect_local_media(path: &Path, expected: MediaType) -> BackendResult<(String, String)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0_u8; 16 * 1024];
    let read = file.read(&mut buffer).await?;
    let detected = infer::get(&buffer[..read]).ok_or_else(|| {
        BackendError::validation(
            "local media type could not be identified from file signature",
            json!({ "localPath": path.to_string_lossy(), "expectedMediaType": expected }),
        )
    })?;
    let mime = detected.mime_type().to_string();
    let valid = match expected {
        MediaType::Image => mime.starts_with("image/"),
        MediaType::Video => mime.starts_with("video/"),
        MediaType::Audio => mime.starts_with("audio/"),
    };
    if !valid {
        return Err(BackendError::validation(
            "local media type does not match the requested staging type",
            json!({
                "localPath": path.to_string_lossy(),
                "expectedMediaType": expected,
                "detectedMimeType": mime
            }),
        ));
    }
    Ok((mime, detected.extension().to_ascii_lowercase()))
}

/// 转码临时文件的自动清理守卫：作用域结束时删除临时文件，成功与失败路径一致。
struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 将摸鱼素材库不支持的图片格式（如 avif）转码为 webp。
///
/// 复用 `VideoCompositionService` 管理的 FFmpeg 引擎（首次使用自动下载官方独立构建），
/// 避免为转码单独下载二进制。输出写入系统临时目录，由调用方负责清理。
/// 返回 `(输出路径, 扩展名, MIME)`。
async fn transcode_local_media(
    composer: &VideoCompositionService,
    job_id: &str,
    source: &Path,
    source_ext: &str,
) -> BackendResult<(PathBuf, String, String)> {
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let output = std::env::temp_dir().join(format!(
        "infinite-canvas-staging-{}-{}.webp",
        job_id,
        Uuid::new_v4()
    ));
    info!(
        "[staging] 导入素材转码: jobId={}, sourceExt={}, 目标格式=webp, 输出={}",
        job_id,
        source_ext,
        output.display()
    );
    let started = std::time::Instant::now();
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-c:v")
        .arg("libwebp")
        .arg("-quality")
        .arg("90")
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    // 转码加超时保护：ffmpeg 意外挂起（损坏文件、杀软占用等）时不能把导入
    // 任务永久卡在「准备中」，到点后杀掉子进程并按失败处理。
    const TRANSCODE_TIMEOUT_SECS: u64 = 120;
    let mut child = command.spawn()?;
    let mut stderr_reader = tokio::io::BufReader::new(child.stderr.take().ok_or_else(|| {
        BackendError::protocol(
            "ffmpeg media transcode failed",
            json!({ "jobId": job_id, "reason": "stderr pipe unavailable" }),
        )
    })?);
    let stderr_task = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt as _;
        let mut buf = String::new();
        let _ = stderr_reader.read_to_string(&mut buf).await;
        buf
    });
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(TRANSCODE_TIMEOUT_SECS),
        child.wait(),
    )
    .await
    {
        Ok(status) => status.inspect_err(|_error| {
            let _ = std::fs::remove_file(&output);
        })?,
        Err(_elapsed) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&output);
            let stderr = stderr_task.await.unwrap_or_default();
            return Err(BackendError::protocol(
                "ffmpeg media transcode timed out",
                json!({
                    "jobId": job_id,
                    "sourceExt": source_ext,
                    "timeoutSecs": TRANSCODE_TIMEOUT_SECS,
                    "stderr": stderr.trim(),
                }),
            ));
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(BackendError::protocol(
            "ffmpeg media transcode failed",
            json!({
                "jobId": job_id,
                "sourceExt": source_ext,
                "exitCode": status.code(),
                "stderr": stderr.trim(),
            }),
        ));
    }
    info!(
        "[staging] 导入素材转码完成: jobId={}, 输出={}, 耗时 {}ms",
        job_id,
        output.display(),
        started.elapsed().as_millis()
    );
    Ok((output, "webp".to_string(), "image/webp".to_string()))
}

fn build_object_key(config: &TosStagingConfig, extension: &str) -> String {
    // 作用域哈希仅区分桶/地域/Endpoint 组合，不包含任何凭据信息。
    let scope = format!("{}:{}:{}", config.bucket, config.region, config.endpoint);
    let scope_hash = hex::encode(Sha256::digest(scope.as_bytes()));
    let now = Utc::now();
    format!(
        "{}/{}/{:04}/{:02}/{:02}/{}.{}",
        config.object_prefix.trim_matches('/'),
        &scope_hash[..16],
        now.year(),
        now.month(),
        now.day(),
        safe_file_stem(&Uuid::new_v4().to_string()),
        extension
    )
}

/// 直连 TOS 的配置校验：启用时桶名、地域、Endpoint、对象前缀与凭据引用必须齐备。
fn validate_tos_config(config: &TosStagingConfig) -> BackendResult<()> {
    if !config.enabled {
        return Ok(());
    }
    for (field, value) in [
        ("bucket", &config.bucket),
        ("region", &config.region),
        ("endpoint", &config.endpoint),
        ("objectPrefix", &config.object_prefix),
    ] {
        if value.trim().is_empty() {
            return Err(BackendError::validation(
                "TOS staging requires a non-empty bucket, region, endpoint and object prefix",
                json!({ "field": field, "provided": value }),
            ));
        }
    }
    if config
        .credential_ref
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err(BackendError::validation(
            "TOS staging requires saved AK/SK credentials before enabling",
            json!({ "required": ["accessKey", "secretKey"] }),
        ));
    }
    // 预签名 URL 只走 HTTPS，Endpoint 必须是纯主机名（不带 scheme 和路径）。
    if url::Url::parse(&format!("https://{}/", config.endpoint)).is_err()
        || config.endpoint.contains('/')
    {
        return Err(BackendError::validation(
            "TOS endpoint must be a bare HTTPS host such as tos-cn-beijing.volces.com",
            json!({ "endpoint": config.endpoint }),
        ));
    }
    Ok(())
}

/// 连通性测试探针响应的判定结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeVerdict {
    /// 签名与凭据有效且桶可访问（2xx，或 404 + NoSuchKey）。
    Ok,
    /// 404 且非 NoSuchKey：桶不存在。
    BucketMissing,
    /// 401/403：凭据或签名被拒绝。
    AuthRejected,
    /// 3xx：预签名请求被重定向。TOS 预签名 URL 绑定 Host，重定向会改变 Host
    /// 并破坏签名，因此连通性测试不跟随重定向，将其归因为 Endpoint/地域/桶名问题。
    Redirected,
    /// 其余非 2xx 状态。
    HttpError,
}

impl ProbeVerdict {
    fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }

    /// 机器可读的失败类别；通过时返回 None。
    fn reason_name(self) -> Option<&'static str> {
        match self {
            Self::Ok => None,
            Self::BucketMissing => Some("bucket-not-found"),
            Self::AuthRejected => Some("auth-rejected"),
            Self::Redirected => Some("redirected"),
            Self::HttpError => Some("http-error"),
        }
    }
}

/// 按官方行为判定探针响应：TOS 先验证签名再检查对象存在性，
/// 因此 404 + NoSuchKey 恰好证明 AK/SK、签名与桶都有效。
fn classify_probe_response(status: u16, body: &str) -> ProbeVerdict {
    if (200..300).contains(&status) {
        return ProbeVerdict::Ok;
    }
    match status {
        // 预签名请求不跟随重定向；3xx 直接归因为域名/Endpoint 问题。
        301 | 302 | 303 | 307 | 308 => ProbeVerdict::Redirected,
        404 if extract_error_code(body).as_deref() == Some("NoSuchKey") => ProbeVerdict::Ok,
        404 => ProbeVerdict::BucketMissing,
        401 | 403 => ProbeVerdict::AuthRejected,
        _ => ProbeVerdict::HttpError,
    }
}

/// 从 TOS 错误响应中提取 `Code` 值，例如 `NoSuchKey`、`NoSuchBucket`、`SignatureDoesNotMatch`。
///
/// 火山引擎 TOS 在不同场景下可能返回 **不同形态**的错误体：
/// - XML：`<Error><Code>NoSuchKey</Code>...</Error>`（REST 常规形态）
/// - JSON：`{"Code":"NoSuchKey","Key":"...","Message":"..."}`（部分错误响应为 JSON）
///
/// 两类形态都必须解析。若只认 XML，遇到 JSON 错误体时会漏读 `Code`，把本应判为
/// 「连通/凭据有效」的 `NoSuchKey` 误判成「桶不存在」，导致连通性测试误报失败。
fn extract_error_code(body: &str) -> Option<String> {
    // JSON 形态：{"Code":"NoSuchKey", ...}。容忍空白与键顺序。
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(code) = value.get("Code").and_then(Value::as_str) {
            return Some(code.trim().to_string());
        }
    }
    // XML 形态：<Code>NoSuchKey</Code>。
    let start = body.find("<Code>")? + "<Code>".len();
    let end = start + body[start..].find("</Code>")?;
    Some(body[start..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> TosStagingConfig {
        TosStagingConfig {
            region: "cn-beijing".into(),
            endpoint: "tos-cn-beijing.volces.com".into(),
            bucket: "example-staging-bucket".into(),
            credential_ref: Some("tos-ak-sk".into()),
            object_prefix: "staging".into(),
            enabled: true,
        }
    }

    #[test]
    fn object_key_has_no_original_file_name_or_secret() {
        let config = sample_config();
        let key = build_object_key(&config, "png");
        assert!(key.starts_with("staging/"));
        assert!(key.ends_with(".png"));
        assert!(!key.contains("tos-ak-sk"));
        assert!(!key.contains("example-staging-bucket"));
    }

    #[test]
    fn configure_requires_complete_direct_tos_fields() {
        // 缺少桶名时拒绝启用。
        let mut config = sample_config();
        config.bucket = " ".into();
        assert!(validate_tos_config(&config).is_err());
        // 缺少凭据引用时拒绝启用。
        let mut config = sample_config();
        config.credential_ref = None;
        assert!(validate_tos_config(&config).is_err());
        // Endpoint 带路径分隔符时拒绝。
        let mut config = sample_config();
        config.endpoint = "tos.example.com/presign".into();
        assert!(validate_tos_config(&config).is_err());
        // 未启用时跳过校验。
        let mut config = sample_config();
        config.enabled = false;
        config.bucket.clear();
        assert!(validate_tos_config(&config).is_ok());
        // 完整直连配置通过校验。
        let config = sample_config();
        assert!(validate_tos_config(&config).is_ok());
    }

    #[test]
    fn probe_verdict_classifies_tos_responses() {
        let nosuch_key =
            r#"<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>...</Message></Error>"#;
        let nosuch_bucket = r#"<Error><Code>NoSuchBucket</Code></Error>"#;
        let bad_signature = r#"<Error><Code>SignatureDoesNotMatch</Code></Error>"#;

        // 2xx 与 404 + NoSuchKey 都代表签名/凭据有效且桶可访问。
        assert_eq!(classify_probe_response(200, ""), ProbeVerdict::Ok);
        assert_eq!(classify_probe_response(204, ""), ProbeVerdict::Ok);
        assert_eq!(classify_probe_response(404, nosuch_key), ProbeVerdict::Ok);
        // 404 + JSON 形态 NoSuchKey 与 XML 形态等价：TOS 部分错误响应为 JSON，
        // 必须同样判为连通（此前只认 XML，导致误报「桶不存在」）。
        let nosuch_key_json = r#"{"Code":"NoSuchKey","Key":"staging/.connectivity-probe","Message":"The specified key does not exist.","EC":"0017-00000003"}"#;
        assert_eq!(
            classify_probe_response(404, nosuch_key_json),
            ProbeVerdict::Ok
        );
        // 404 的其他错误码视为桶不存在。
        assert_eq!(
            classify_probe_response(404, nosuch_bucket),
            ProbeVerdict::BucketMissing
        );
        // 401/403 代表凭据或签名被拒绝。
        assert_eq!(
            classify_probe_response(403, bad_signature),
            ProbeVerdict::AuthRejected
        );
        assert_eq!(classify_probe_response(401, ""), ProbeVerdict::AuthRejected);
        // 3xx 预签名重定向归因为域名/Endpoint 问题（不再静默跟随导致签名失效）。
        assert_eq!(classify_probe_response(301, ""), ProbeVerdict::Redirected);
        assert_eq!(classify_probe_response(302, ""), ProbeVerdict::Redirected);
        assert_eq!(
            classify_probe_response(307, bad_signature),
            ProbeVerdict::Redirected
        );
        assert_eq!(classify_probe_response(308, ""), ProbeVerdict::Redirected);
        // 其余非重定向状态归为服务端错误。
        assert_eq!(classify_probe_response(500, ""), ProbeVerdict::HttpError);
    }

    #[test]
    fn extract_error_code_handles_xml_shapes() {
        assert_eq!(
            extract_error_code(r#"<Error><Code>NoSuchKey</Code></Error>"#).as_deref(),
            Some("NoSuchKey")
        );
        // 带空白与属性前缀的形态。
        assert_eq!(
            extract_error_code(r#"<Error> <Code> SignatureDoesNotMatch </Code> </Error>"#)
                .as_deref(),
            Some("SignatureDoesNotMatch")
        );
        // 非 XML 或缺失 Code 时返回 None。
        assert_eq!(extract_error_code("plain text"), None);
        assert_eq!(
            extract_error_code("<Error><Message>x</Message></Error>"),
            None
        );
        // JSON 形态（火山引擎部分错误响应为 JSON，而非 XML）。
        assert_eq!(
            extract_error_code(
                r#"{"Code":"NoSuchKey","Key":"staging/.connectivity-probe","Message":"The specified key does not exist."}"#
            )
            .as_deref(),
            Some("NoSuchKey")
        );
        assert_eq!(
            extract_error_code(r#"{ "Code" : "NoSuchBucket" }"#).as_deref(),
            Some("NoSuchBucket")
        );
    }

    /// 回归测试：TOS 预签名客户端不得自动跟随重定向。
    ///
    /// 复现根因——此前 `StagingService` 复用 `ProviderRuntime` 的共享客户端，其默认
    /// `redirect::Policy::limited(10)` 会跟随重定向。TOS 对预签名请求返回 307 到规范
    /// 化 Host 时，reqwest 把同一套签名查询串重放到不同 Host，TOS 用新 Host 重算签名
    /// 即报 `SignatureDoesNotMatch`（AK 合法仍被回显）。专用客户端必须用 `Policy::none()`。
    ///
    /// 本测试启动一个会 307 到「捕获服务器」的本地服务，断言专用客户端直接拿到 307
    /// 且捕获服务器从未被访问。
    #[tokio::test]
    async fn presign_client_does_not_follow_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::Duration;

        // 捕获服务器：一旦被访问即置位，证明发生了重定向跟随。
        let captured = Arc::new(AtomicBool::new(false));
        let captured_clone = Arc::clone(&captured);
        let capture = TcpListener::bind("127.0.0.1:0").unwrap();
        let capture_addr = capture.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = capture.accept() {
                captured_clone.store(true, Ordering::SeqCst);
                let _ = stream.read(&mut [0u8; 1024]);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });

        // 重定向服务器：对任何请求返回 307 指向捕获服务器。
        let redirect = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_addr = redirect.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = redirect.accept() {
                let _ = stream.read(&mut [0u8; 1024]);
                let body = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{capture_addr}/\r\n\
                     Content-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        let client = build_presign_http_client().unwrap();
        let resp = client
            .get(format!(
                "http://{redirect_addr}/object?X-Tos-Signature=abc123"
            ))
            .send()
            .await
            .expect("request to local redirect server should succeed");

        // 关键断言：客户端未跟随重定向，原样返回 307。
        assert_eq!(
            resp.status().as_u16(),
            307,
            "presign client must not follow redirects; expected 307"
        );
        // 给捕获服务器留出时间，确认其从未被访问。
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            !captured.load(Ordering::SeqCst),
            "presign client must not follow the 307 to the capture server"
        );
    }
}
