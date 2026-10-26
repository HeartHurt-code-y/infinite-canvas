//! User-owned local material library. The `.b64` files are the durable media body;
//! SQLite contains only searchable metadata. Neither import nor preview uses TOS.

use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tauri::{
    Manager as _, UriSchemeContext, UriSchemeResponder,
    http::{Request, Response, StatusCode},
};
use uuid::Uuid;

use super::{
    BackendState,
    error::{BackendError, BackendResult},
    protocol_reply::{self, LOCAL_BASE64_RESPONSE_POOL, ProtocolReplyGuard},
    storage::{Storage, now_ms},
    types::{
        ImportLocalBase64AssetCommand, LocalAssetListQuery, LocalBase64AssetGroupRecord,
        LocalBase64AssetPage, LocalBase64AssetRecord, MediaType,
    },
};

pub const LOCAL_BASE64_SCHEME: &str = "localbase64";
const MAX_PREVIEW_CHUNK: u64 = 8 * 1024 * 1024;
const MAX_FULL_PREVIEW: u64 = 128 * 1024 * 1024;
const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct LocalBase64Library {
    storage: Arc<Storage>,
    root: PathBuf,
    import_lock: Arc<Mutex<()>>,
}

impl LocalBase64Library {
    pub fn new(storage: Arc<Storage>, data_directory: &Path) -> BackendResult<Self> {
        let root = data_directory.join("local-base64-assets");
        fs::create_dir_all(&root)?;
        let library = Self {
            storage,
            root,
            import_lock: Arc::new(Mutex::new(())),
        };
        library.cleanup_stale_temporary_files();
        Ok(library)
    }

    fn path(&self, id: &str) -> BackendResult<PathBuf> {
        let uuid = id.strip_prefix("local-b64-").ok_or_else(|| {
            BackendError::validation("invalid local Base64 asset id", json!({ "assetId": id }))
        })?;
        Uuid::parse_str(uuid).map_err(|_| {
            BackendError::validation("invalid local Base64 asset id", json!({ "assetId": id }))
        })?;
        Ok(self.root.join(format!("{id}.b64")))
    }

    pub fn import(
        &self,
        command: ImportLocalBase64AssetCommand,
    ) -> BackendResult<LocalBase64AssetRecord> {
        self.import_with_status(command).map(|(record, _)| record)
    }

    pub fn import_with_status(
        &self,
        command: ImportLocalBase64AssetCommand,
    ) -> BackendResult<(LocalBase64AssetRecord, bool)> {
        let source_path = Path::new(command.local_path.trim());
        if !source_path.is_absolute() {
            return Err(BackendError::validation(
                "local material import requires an absolute file path",
                json!({ "localPath": command.local_path }),
            ));
        }
        let mut source = File::open(source_path)?;
        let metadata = source.metadata()?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(BackendError::validation(
                "local material must be a non-empty regular file",
                json!({ "localPath": command.local_path }),
            ));
        }
        let mut head = [0_u8; 8192];
        let head_len = source.read(&mut head)?;
        source.seek(SeekFrom::Start(0))?;
        let (media_type, mime_type) = detect_media(source_path, &head[..head_len])?;
        let name = command
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| {
                source_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .ok_or_else(|| {
                BackendError::validation("local material has no file name", json!({}))
            })?;
        let (sha256, hashed_size) = sha256_reader(&mut source)?;
        if hashed_size != metadata.len() {
            return Err(BackendError::Conflict(
                "local material changed while being imported; retry the import".into(),
            ));
        }
        source.seek(SeekFrom::Start(0))?;
        let _import_guard = self.import_lock.lock().map_err(|error| {
            BackendError::Conflict(format!("local material import lock was poisoned: {error}"))
        })?;
        if let Some(existing) = self.existing_by_content(media_type, metadata.len(), &sha256)? {
            return Ok((existing, true));
        }
        let id = format!("local-b64-{}", Uuid::new_v4());
        let destination = self.path(&id)?;
        let temporary = self.root.join(format!("{id}.tmp"));
        let record = LocalBase64AssetRecord {
            id,
            name,
            media_type,
            mime_type,
            preview_url: preview_url(&destination),
            byte_size: metadata.len(),
            created_at: now_ms(),
            group_id: command
                .group_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        };
        let write_result = (|| -> BackendResult<()> {
            let file = File::create(&temporary)?;
            let mut encoder = base64::write::EncoderWriter::new(file, &STANDARD);
            let mut verified_source = HashingReader::new(&mut source);
            let copied = std::io::copy(&mut verified_source, &mut encoder)?;
            let copied_sha256 = verified_source.finish();
            let mut file = encoder.finish()?;
            file.flush()?;
            file.sync_all()?;
            if copied != record.byte_size || copied_sha256 != sha256 {
                return Err(BackendError::Conflict(
                    "local material changed while being imported; retry the import".into(),
                ));
            }
            fs::rename(&temporary, &destination)?;
            self.storage.insert_local_base64_asset(&record, &sha256)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&destination);
        }
        write_result.map(|_| (record, false))
    }

    fn existing_by_content(
        &self,
        media_type: MediaType,
        byte_size: u64,
        sha256: &str,
    ) -> BackendResult<Option<LocalBase64AssetRecord>> {
        if let Some(mut existing) = self
            .storage
            .find_local_base64_asset_by_hash(media_type, byte_size, sha256)?
        {
            let path = self.path(&existing.id)?;
            if let Ok(file) = File::open(&path) {
                let mut decoded = base64::read::DecoderReader::new(file, &STANDARD);
                if let Ok((actual_sha256, actual_size)) = sha256_reader(&mut decoded) {
                    if actual_sha256 == sha256 && actual_size == existing.byte_size {
                        existing.preview_url = preview_url(&path);
                        return Ok(Some(existing));
                    }
                }
            }
            // The indexed body may have been removed or rewritten outside the
            // app. Never reuse an ID whose bytes differ from its hash.
            self.storage.forget_local_base64_asset_hash(&existing.id)?;
        }
        // Older libraries have no hash index. Only inspect same-kind, same-size
        // bodies, then remember their hashes so subsequent imports are cheap.
        for mut candidate in self
            .storage
            .list_unhashed_local_base64_assets(media_type, byte_size)?
        {
            let path = self.path(&candidate.id)?;
            let Ok(file) = File::open(&path) else {
                continue;
            };
            let mut decoded = base64::read::DecoderReader::new(file, &STANDARD);
            let Ok((candidate_hash, decoded_size)) = sha256_reader(&mut decoded) else {
                continue;
            };
            if decoded_size != candidate.byte_size {
                continue;
            }
            self.storage
                .remember_local_base64_asset_hash(&candidate, &candidate_hash)?;
            if candidate_hash == sha256 {
                candidate.preview_url = preview_url(&path);
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    pub fn list(&self, query: Option<LocalAssetListQuery>) -> BackendResult<LocalBase64AssetPage> {
        let (mut items, total, page, page_size, kind_totals) = self
            .storage
            .list_local_base64_asset_records(query.as_ref())?;
        for item in &mut items {
            item.preview_url = preview_url(&self.path(&item.id)?);
        }
        Ok(LocalBase64AssetPage {
            items,
            total,
            page,
            page_size,
            kind_totals,
        })
    }

    pub fn get(&self, id: &str, expected: MediaType) -> BackendResult<LocalBase64AssetRecord> {
        let mut record = self.storage.get_local_base64_asset(id)?;
        if record.media_type != expected {
            return Err(BackendError::validation(
                "local material media type does not match its reference",
                json!({ "assetId": id, "expected": expected, "actual": record.media_type }),
            ));
        }
        let path = self.path(id)?;
        if !path.is_file() {
            return Err(BackendError::NotFound(format!(
                "local Base64 asset body {id}"
            )));
        }
        record.preview_url = preview_url(&path);
        Ok(record)
    }

    pub fn refresh_media(&self, id: &str, expected: MediaType) -> BackendResult<String> {
        Ok(self.get(id, expected)?.preview_url)
    }

    pub fn read_bytes(
        &self,
        id: &str,
        expected: MediaType,
    ) -> BackendResult<(LocalBase64AssetRecord, Vec<u8>)> {
        let record = self.get(id, expected)?;
        let file = File::open(self.path(id)?)?;
        let mut reader = base64::read::DecoderReader::new(file, &STANDARD);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != record.byte_size {
            return Err(BackendError::protocol(
                "local Base64 material length no longer matches its index",
                json!({ "assetId": id, "expectedBytes": record.byte_size, "actualBytes": bytes.len() }),
            ));
        }
        Ok((record, bytes))
    }

    /// Materialize a local copy only for native tools that require a file path.
    pub fn decoded_path(&self, id: &str, expected: MediaType) -> BackendResult<PathBuf> {
        let record = self.get(id, expected)?;
        let extension = extension_for_mime(&record.mime_type);
        let cache_root = self.root.join("decoded-cache");
        fs::create_dir_all(&cache_root)?;
        let cache = cache_root.join(format!("{id}-{}.{}", Uuid::new_v4(), extension));
        let temporary = cache.with_extension(format!("{extension}.tmp"));
        let result = (|| -> BackendResult<()> {
            let file = File::open(self.path(id)?)?;
            let mut decoder = base64::read::DecoderReader::new(file, &STANDARD);
            let mut output = File::create(&temporary)?;
            let copied = std::io::copy(&mut decoder, &mut output)?;
            output.sync_all()?;
            if copied != record.byte_size {
                return Err(BackendError::protocol(
                    "local Base64 material length no longer matches its index",
                    json!({ "assetId": id, "expectedBytes": record.byte_size, "actualBytes": copied }),
                ));
            }
            fs::rename(&temporary, &cache)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map(|_| cache)
    }

    pub fn sha256_path(path: &Path) -> BackendResult<String> {
        Ok(sha256_reader(&mut File::open(path)?)?.0)
    }

    pub fn list_groups(&self) -> BackendResult<Vec<LocalBase64AssetGroupRecord>> {
        self.storage.list_local_base64_asset_groups()
    }

    pub fn create_group(&self, name: &str) -> BackendResult<LocalBase64AssetGroupRecord> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(BackendError::validation(
                "local asset group name must not be empty",
                json!({ "name": name }),
            ));
        }
        if trimmed.chars().count() > 64 {
            return Err(BackendError::validation(
                "local asset group name must be at most 64 characters",
                json!({ "name": name, "maxChars": 64 }),
            ));
        }
        if self
            .storage
            .find_local_base64_asset_group_by_name(trimmed)?
            .is_some()
        {
            return Err(BackendError::Conflict(format!(
                "local asset group named {trimmed:?} already exists"
            )));
        }
        let record = LocalBase64AssetGroupRecord {
            id: format!("local-group-{}", Uuid::new_v4()),
            name: trimmed.to_string(),
            asset_count: 0,
            created_at: now_ms(),
        };
        self.storage.insert_local_base64_asset_group(&record)?;
        Ok(record)
    }

    /// 删除分组本身；成员素材保留并回到未分组，正文与行都不受影响。
    pub fn delete_group(&self, id: &str) -> BackendResult<()> {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            return Err(BackendError::validation(
                "local asset group id must not be empty",
                json!({ "groupId": id }),
            ));
        }
        self.storage.delete_local_base64_asset_group(trimmed)
    }

    /// 批量移动素材到分组；`group_id` 为 None 时移出分组。返回实际命中的素材数。
    pub fn move_assets(&self, asset_ids: &[String], group_id: Option<&str>) -> BackendResult<u64> {
        let target = group_id.map(str::trim).filter(|value| !value.is_empty());
        if let Some(target) = target {
            // 先确认目标分组存在，避免静默把素材指向不存在的分组。
            self.storage.get_local_base64_asset_group(target)?;
        }
        let mut unique = Vec::with_capacity(asset_ids.len());
        for asset_id in asset_ids {
            let trimmed = asset_id.trim();
            if !trimmed.is_empty() && !unique.iter().any(|value| value == trimmed) {
                unique.push(trimmed.to_string());
            }
        }
        self.storage.move_local_base64_assets(&unique, target)
    }

    /// 删除本地素材：SQLite 行与哈希索引先在事务里移除，正文 `.b64` 与解码缓存
    /// 尽力删除；残留文件由启动时的孤儿清理回收（数据库是唯一事实来源）。
    pub fn delete_asset(&self, id: &str) -> BackendResult<()> {
        let _record = self.storage.get_local_base64_asset(id)?;
        let body = self.path(id)?;
        self.storage.delete_local_base64_asset(id)?;
        let _ = fs::remove_file(&body);
        if let Ok(entries) = fs::read_dir(self.root.join("decoded-cache")) {
            let prefix = format!("{id}-");
            for entry in entries.flatten() {
                let cached = entry.path();
                let matches = cached
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with(&prefix));
                if matches {
                    let _ = fs::remove_file(&cached);
                }
            }
        }
        Ok(())
    }

    fn cleanup_stale_temporary_files(&self) {
        let now = SystemTime::now();
        for directory in [&self.root, &self.root.join("decoded-cache")] {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if !name.starts_with("local-b64-") || !path.is_file() {
                    continue;
                }
                let stale = fs::metadata(&path)
                    .and_then(|value| value.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age >= STALE_TEMP_AGE);
                if !stale {
                    continue;
                }
                let orphan = if name.ends_with(".tmp") || directory.ends_with("decoded-cache") {
                    true
                } else if let Some(id) = name.strip_suffix(".b64") {
                    matches!(
                        self.storage.get_local_base64_asset(id),
                        Err(BackendError::NotFound(_))
                    )
                } else {
                    false
                };
                if orphan {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}

fn sha256_reader(reader: &mut impl Read) -> BackendResult<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    let mut size = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
}

impl<R: Read> HashingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
        }
    }

    fn finish(self) -> String {
        format!("{:x}", self.hasher.finalize())
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.hasher.update(&buf[..read]);
        Ok(read)
    }
}

fn preview_url(path: &Path) -> String {
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        format!("http://{LOCAL_BASE64_SCHEME}.localhost/{id}")
    }
    #[cfg(not(windows))]
    {
        format!("{LOCAL_BASE64_SCHEME}://localhost/{id}")
    }
}

pub(crate) fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        _ => "media",
    }
}

fn detect_media(path: &Path, head: &[u8]) -> BackendResult<(MediaType, String)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let fallback = match extension.as_str() {
        "jpg" | "jpeg" => Some((MediaType::Image, "image/jpeg")),
        "png" => Some((MediaType::Image, "image/png")),
        "webp" => Some((MediaType::Image, "image/webp")),
        "gif" => Some((MediaType::Image, "image/gif")),
        "bmp" => Some((MediaType::Image, "image/bmp")),
        "tif" | "tiff" => Some((MediaType::Image, "image/tiff")),
        "heic" => Some((MediaType::Image, "image/heic")),
        "heif" => Some((MediaType::Image, "image/heif")),
        "avif" => Some((MediaType::Image, "image/avif")),
        "mp4" | "m4v" => Some((MediaType::Video, "video/mp4")),
        "mov" => Some((MediaType::Video, "video/quicktime")),
        "webm" => Some((MediaType::Video, "video/webm")),
        "mkv" => Some((MediaType::Video, "video/x-matroska")),
        "avi" => Some((MediaType::Video, "video/x-msvideo")),
        "mp3" => Some((MediaType::Audio, "audio/mpeg")),
        "wav" => Some((MediaType::Audio, "audio/wav")),
        "m4a" => Some((MediaType::Audio, "audio/mp4")),
        "flac" => Some((MediaType::Audio, "audio/flac")),
        "ogg" | "opus" => Some((MediaType::Audio, "audio/ogg")),
        "aac" => Some((MediaType::Audio, "audio/aac")),
        _ => None,
    };
    let (kind, fallback_mime) = fallback.ok_or_else(|| {
        BackendError::validation(
            "local material must be an image, video, or audio file",
            json!({ "extension": extension }),
        )
    })?;
    if let Some(detected) = infer::get(head) {
        let actual = detected.mime_type();
        let matches = match kind {
            MediaType::Image => actual.starts_with("image/"),
            MediaType::Video => actual.starts_with("video/"),
            MediaType::Audio => actual.starts_with("audio/"),
            MediaType::Text => false,
        };
        if !matches {
            return Err(BackendError::validation(
                "local material content does not match its file type",
                json!({ "extension": extension, "detectedMimeType": actual }),
            ));
        }
        return Ok((kind, actual.to_string()));
    }
    Ok((kind, fallback_mime.to_string()))
}

fn preview_response(library: &LocalBase64Library, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let response = (|| -> BackendResult<Response<Vec<u8>>> {
        let id = request.uri().path().trim_start_matches('/');
        let record = library.storage.get_local_base64_asset(id)?;
        let path = library.path(id)?;
        let method = request.method().as_str();
        if method != "GET" && method != "HEAD" {
            return Ok(Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .body(Vec::new())
                .unwrap());
        }
        let (start, end, partial) = if let Some(raw) = request.headers().get("range") {
            let range = raw
                .to_str()
                .unwrap_or_default()
                .strip_prefix("bytes=")
                .and_then(|value| value.split_once('-'));
            let Some((from, to)) = range else {
                return Ok(Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .body(Vec::new())
                    .unwrap());
            };
            let (start, end) = if from.is_empty() {
                let tail = to
                    .parse::<u64>()
                    .map_err(|_| BackendError::validation("invalid media range", json!({})))?;
                if tail == 0 {
                    return Ok(Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .body(Vec::new())
                        .unwrap());
                }
                (
                    record
                        .byte_size
                        .saturating_sub(tail)
                        .max(record.byte_size.saturating_sub(MAX_PREVIEW_CHUNK)),
                    record.byte_size - 1,
                )
            } else {
                let start = from
                    .parse::<u64>()
                    .map_err(|_| BackendError::validation("invalid media range", json!({})))?;
                let end = if to.is_empty() {
                    record.byte_size - 1
                } else {
                    to.parse::<u64>()
                        .map_err(|_| BackendError::validation("invalid media range", json!({})))?
                };
                (start, end)
            };
            if start >= record.byte_size || end < start {
                return Ok(Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("content-range", format!("bytes */{}", record.byte_size))
                    .body(Vec::new())
                    .unwrap());
            }
            (
                start,
                end.min(record.byte_size - 1)
                    .min(start.saturating_add(MAX_PREVIEW_CHUNK - 1)),
                true,
            )
        } else {
            if record.byte_size > MAX_FULL_PREVIEW {
                // 部分 WebView 的视频首请求不带 Range。先返回有明确 Content-Range
                // 的首片，避免一次性解码几 GB 或直接拒绝；后续由媒体栈按 Range 续取。
                (0, MAX_PREVIEW_CHUNK.min(record.byte_size) - 1, true)
            } else {
                (0, record.byte_size - 1, false)
            }
        };
        let body = if method == "HEAD" {
            Vec::new()
        } else {
            decode_window(&path, start, end)?
        };
        let length = end - start + 1;
        let mut builder = Response::builder()
            .status(if partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            })
            .header("content-type", record.mime_type)
            .header("content-length", length.to_string())
            .header("accept-ranges", "bytes")
            .header("access-control-allow-origin", "*")
            .header("cache-control", "private, max-age=3600");
        if partial {
            builder = builder.header(
                "content-range",
                format!("bytes {start}-{end}/{}", record.byte_size),
            );
        }
        Ok(builder.body(body).unwrap())
    })();
    response.unwrap_or_else(|error| {
        let status = match error {
            BackendError::NotFound(_) => StatusCode::NOT_FOUND,
            BackendError::Validation { .. } => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Response::builder().status(status).body(Vec::new()).unwrap()
    })
}

fn decode_window(path: &Path, start: u64, end: u64) -> BackendResult<Vec<u8>> {
    let mut file = File::open(path)?;
    let first_triplet = start / 3;
    let last_triplet = end / 3;
    file.seek(SeekFrom::Start(first_triplet * 4))?;
    let encoded_count = (last_triplet - first_triplet + 1) * 4;
    let mut encoded = vec![0; encoded_count as usize];
    file.read_exact(&mut encoded)?;
    let decoded = STANDARD.decode(encoded).map_err(|error| {
        BackendError::protocol(
            "local Base64 material is corrupt",
            json!({ "error": error.to_string() }),
        )
    })?;
    let skip = (start - first_triplet * 3) as usize;
    let len = (end - start + 1) as usize;
    decoded
        .get(skip..skip + len)
        .map(|slice| slice.to_vec())
        .ok_or_else(|| {
            BackendError::protocol(
                "local Base64 material is truncated",
                json!({ "path": path }),
            )
        })
}

pub fn handle_local_base64_request<R: tauri::Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let library = context
        .app_handle()
        .try_state::<BackendState>()
        .map(|state| state.local_base64_assets.clone());
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        /*
         * 兜底守卫在任务一开始就接管 responder：响应计算期间任何 panic
         * （或提前 return）都会让 responder 随任务被 drop，WebKit 的自定义协议
         * 任务就永远等不到 didFinish —— 表现为图片/视频**永久转圈**，
         * macOS 上还会触发 "No response sent" NSException。
         * 守卫的 Drop 会 fire-and-forget 回一个 503，保证任务有终态。
         */
        let mut guard = ProtocolReplyGuard::new(&app, responder);
        // 许可池封顶「解码 + 主线程投递」的在途数量（本地解码是 CPU + 阻塞 IO）。
        let Some(_permit) = LOCAL_BASE64_RESPONSE_POOL.acquire().await else {
            if let Some(responder) = guard.take_responder() {
                protocol_reply::respond_unavailable(&app, responder, "local_base64_busy");
            }
            return;
        };
        /*
         * 解码是阻塞 IO（读文件 + Base64 解码），必须放 spawn_blocking。
         * 这里**await** 住 JoinHandle：tokio 会把闭包里的 panic 存进句柄，
         * 直接丢弃句柄等于把 panic 静默吞掉 —— responder 随之被 drop，
         * 预览永久转圈且日志无痕。await 后 panic 会变成 Err，
         * 由下面的分支回一个明确的 503。
         */
        let computed = tauri::async_runtime::spawn_blocking(move || {
            library
                .map(|library| preview_response(&library, request))
                .unwrap_or_else(|| {
                    Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Vec::new())
                        .unwrap_or_default()
                })
        })
        .await;
        let response = match computed {
            Ok(response) => response,
            Err(_) => {
                // 闭包 panic：回一个明确的 503，别让 WebKit 任务悬空。
                if let Some(responder) = guard.take_responder() {
                    protocol_reply::respond_unavailable(&app, responder, "local_base64_failed");
                }
                return;
            }
        };
        let Some(responder) = guard.take_responder() else {
            return;
        };
        protocol_reply::deliver_protocol_response(&app, responder, response).await;
    });
}
