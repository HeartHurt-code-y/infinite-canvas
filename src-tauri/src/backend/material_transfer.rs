//! Copy an existing material by its stable identity, never by a persisted
//! preview URL. Cloud imports retain their source bytes for preview recovery.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use serde_json::json;
use uuid::Uuid;

use super::{
    asset_library::AssetLibrary,
    error::{BackendError, BackendResult},
    local_base64_assets::LocalBase64Library,
    staging::StagingService,
    storage::Storage,
    types::{
        CloudAssetIdentity, ExistingMaterialSourceKind, ImportLocalBase64AssetCommand,
        MaterialLibraryDestination, MediaType, SaveExistingAssetCommand, SaveExistingAssetResult,
        StagingAssetImportTarget, StartStagingCommand,
    },
};

struct TransferSourceFile {
    directory: PathBuf,
    path: PathBuf,
    keep: bool,
}

impl TransferSourceFile {
    fn new(root: &Path, name: &str, media_type: MediaType) -> BackendResult<Self> {
        fs::create_dir_all(root)?;
        let directory = root.join(Uuid::new_v4().to_string());
        fs::create_dir(&directory)?;
        let safe_name = safe_material_name(name, media_type);
        let path = directory.join(safe_name);
        Ok(Self {
            directory,
            path,
            keep: false,
        })
    }

    fn retain(&mut self) {
        self.keep = true;
    }
}

impl Drop for TransferSourceFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn safe_material_name(name: &str, media_type: MediaType) -> String {
    let fallback_extension = match media_type {
        MediaType::Image => "png",
        MediaType::Video => "mp4",
        MediaType::Audio => "mp3",
        MediaType::Text => "bin",
    };
    let raw = Path::new(name.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let safe: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .take(120)
        .collect();
    let safe = safe.trim_matches([' ', '.']);
    if safe.is_empty() {
        return format!("material.{fallback_extension}");
    }
    if Path::new(safe).extension().is_none() {
        format!("{safe}.{fallback_extension}")
    } else {
        safe.to_string()
    }
}

fn checked_id(id: &str) -> BackendResult<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(BackendError::validation(
            "material id is required",
            json!({}),
        ));
    }
    Ok(id)
}

pub async fn save_existing_asset(
    assets: &AssetLibrary,
    staging: &StagingService,
    local: &LocalBase64Library,
    storage: &Arc<Storage>,
    root: &Path,
    command: SaveExistingAssetCommand,
) -> BackendResult<SaveExistingAssetResult> {
    let source_id = checked_id(&command.source.asset_id)?.to_string();
    let media_type = command.source.media_type;
    if media_type == MediaType::Text {
        return Err(BackendError::validation(
            "material transfer supports image, video and audio only",
            json!({}),
        ));
    }
    let destination = command.destination;
    let target_provider_connection_id = if destination == MaterialLibraryDestination::Cloud {
        Some(
            command
                .target_provider_connection_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    BackendError::validation(
                        "cloud material destination requires a provider connection",
                        json!({}),
                    )
                })?
                .to_string(),
        )
    } else {
        None
    };
    let requested_name = command
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let mut source_url: Option<String> = None;
    let mut local_source_id: Option<String> = None;
    let mut cloud_local_fallback: Option<PathBuf> = None;
    let mut cloud_local_fallback_name: Option<String> = None;
    let source_name = match command.source.kind {
        ExistingMaterialSourceKind::LocalBase64 => {
            let record = local.get(&source_id, media_type)?;
            if destination == MaterialLibraryDestination::Local {
                return Ok(SaveExistingAssetResult {
                    destination,
                    asset_id: record.id,
                    reused: true,
                });
            }
            local_source_id = Some(record.id);
            record.name
        }
        ExistingMaterialSourceKind::ObjectStorage => {
            let lease = staging.local_asset_lease(&source_id, media_type)?;
            if destination == MaterialLibraryDestination::ObjectStorage
                && staging.local_asset_is_in_current_bucket(&source_id).await?
            {
                return Ok(SaveExistingAssetResult {
                    destination,
                    asset_id: storage
                        .staging_reused_from(&source_id)?
                        .unwrap_or(source_id),
                    reused: true,
                });
            }
            source_url = Some(lease.get_url);
            let job = storage.get_staging_job(&source_id)?;
            Path::new(&job.local_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("material")
                .to_string()
        }
        ExistingMaterialSourceKind::Cloud => {
            let provider_connection_id = command
                .source
                .provider_connection_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    BackendError::validation(
                        "cloud material source requires a provider connection",
                        json!({}),
                    )
                })?;
            let normalized_id = source_id.strip_prefix("asset://").unwrap_or(&source_id);
            if let Some(job) = storage
                .find_asset_import_job_by_provider_asset_id(provider_connection_id, normalized_id)?
            {
                let path = PathBuf::from(&job.local_path);
                if job.media_type == media_type && safe_imported_source(&path, root, job.created_at)
                {
                    cloud_local_fallback_name = job
                        .import_target
                        .as_ref()
                        .and_then(|target| target.name.clone())
                        .or_else(|| {
                            path.file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                        });
                    cloud_local_fallback = Some(path);
                }
            }
            let record = assets
                .material_transfer_record(
                    CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.to_string(),
                        asset_id: normalized_id.to_string(),
                    },
                    media_type,
                )
                .await;
            match record {
                Ok(record) => {
                    let desired_group = command
                        .group_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|group| !group.is_empty());
                    if destination == MaterialLibraryDestination::Cloud
                        && target_provider_connection_id.as_deref() == Some(provider_connection_id)
                        && (desired_group.is_none() || desired_group == record.group_id.as_deref())
                    {
                        return Ok(SaveExistingAssetResult {
                            destination,
                            asset_id: record.id,
                            reused: true,
                        });
                    }
                    source_url = record.preview_url;
                    if source_url.is_none() && cloud_local_fallback.is_none() {
                        return Err(BackendError::validation(
                            "cloud material has no downloadable body",
                            json!({ "assetId": normalized_id }),
                        ));
                    }
                    record.name
                }
                Err(error) if cloud_local_fallback.is_some() => {
                    let _ = error;
                    cloud_local_fallback_name.unwrap_or_else(|| "material".into())
                }
                Err(error) => return Err(error),
            }
        }
    };
    let display_name = requested_name.unwrap_or(&source_name).to_string();
    let mut file = TransferSourceFile::new(root, &display_name, media_type)?;
    if let Some(source_id) = local_source_id {
        let local = local.clone();
        let decoded = tauri::async_runtime::spawn_blocking(move || {
            local.decoded_path(&source_id, media_type)
        })
        .await
        .map_err(|error| {
            BackendError::Conflict(format!("material decode worker failed: {error}"))
        })??;
        let copy_result = tokio::fs::copy(&decoded, &file.path).await;
        let _ = fs::remove_file(&decoded);
        copy_result?;
    } else if cloud_local_fallback
        .as_ref()
        .is_some_and(|path| path.parent().and_then(Path::parent) == Some(root))
    {
        tokio::fs::copy(
            cloud_local_fallback.as_ref().expect("checked above"),
            &file.path,
        )
        .await?;
    } else if let Some(url) = source_url {
        match assets
            .download_material_to_file(url, file.path.clone())
            .await
        {
            Ok(downloaded) if downloaded > 0 => {}
            Ok(_) => {
                return Err(BackendError::validation(
                    "material source is empty",
                    json!({}),
                ));
            }
            Err(error) => {
                if let Some(path) = cloud_local_fallback.as_ref() {
                    tokio::fs::copy(path, &file.path).await?;
                } else {
                    return Err(error);
                }
            }
        }
    } else if let Some(path) = cloud_local_fallback.as_ref() {
        tokio::fs::copy(path, &file.path).await?;
    }
    let path = file.path.to_string_lossy().into_owned();
    if destination == MaterialLibraryDestination::Local {
        let local = local.clone();
        let (record, reused) = tauri::async_runtime::spawn_blocking(move || {
            local.import_with_status(ImportLocalBase64AssetCommand {
                local_path: path,
                name: Some(display_name),
            })
        })
        .await
        .map_err(|error| {
            BackendError::Conflict(format!("local material import worker failed: {error}"))
        })??;
        return Ok(SaveExistingAssetResult {
            destination,
            asset_id: record.id,
            reused,
        });
    }
    let job = staging.create_job(StartStagingCommand {
        local_path: path,
        purpose: if destination == MaterialLibraryDestination::Cloud {
            "asset_import"
        } else {
            "local_asset"
        }
        .into(),
        media_type,
        import: target_provider_connection_id.map(|provider_connection_id| {
            StagingAssetImportTarget {
                provider_connection_id,
                name: Some(display_name),
                group_id: command.group_id.clone(),
            }
        }),
    })?;
    let completed = staging.run_job(&job.id).await?;
    let canonical = storage.staging_reused_from(&job.id)?;
    let asset_id = match destination {
        MaterialLibraryDestination::Cloud => completed.asset_id.ok_or_else(|| {
            BackendError::protocol(
                "cloud material upload finished without asset id",
                json!({ "jobId": job.id }),
            )
        })?,
        MaterialLibraryDestination::ObjectStorage => canonical.clone().unwrap_or(job.id),
        MaterialLibraryDestination::Local => unreachable!(),
    };
    if destination == MaterialLibraryDestination::Cloud && canonical.is_none() {
        // Staging's source-fallback logic uses this indexed durable body when a
        // provider replays an expired TOS lease as its preview URL.
        file.retain();
    }
    Ok(SaveExistingAssetResult {
        destination,
        asset_id,
        reused: canonical.is_some(),
    })
}

fn safe_imported_source(path: &Path, root: &Path, created_at: i64) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    if path.parent().and_then(Path::parent) == Some(root) {
        return true;
    }
    let uploaded_at = UNIX_EPOCH + Duration::from_millis(created_at.max(0) as u64);
    metadata
        .modified()
        .is_ok_and(|modified| modified <= uploaded_at)
}

/// Remove only generated files with no surviving cloud-import job. Each
/// directory is UUID-named and contains one known media file.
pub fn cleanup_orphan_sources(root: &Path, storage: &Storage) -> BackendResult<()> {
    fs::create_dir_all(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
        {
            continue;
        }
        let directory = entry.path();
        for child in fs::read_dir(&directory)? {
            let child = child?;
            if !child.file_type()?.is_file() {
                continue;
            }
            let path = child.path();
            if !storage.has_active_material_transfer_source(&path.to_string_lossy())? {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(directory);
    }
    Ok(())
}

pub fn remove_imported_source(
    root: &Path,
    storage: &Storage,
    provider_connection_id: &str,
    asset_id: &str,
) -> BackendResult<()> {
    let Some(job) =
        storage.find_asset_import_job_by_provider_asset_id(provider_connection_id, asset_id)?
    else {
        return Ok(());
    };
    let path = Path::new(&job.local_path);
    let Some(directory) = path.parent() else {
        return Ok(());
    };
    if directory.parent() != Some(root) {
        return Ok(());
    }
    if let Some(name) = directory.file_name().and_then(|value| value.to_str()) {
        if Uuid::parse_str(name).is_ok() {
            let _ = fs::remove_file(path);
            let _ = fs::remove_dir(directory);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::types::{StagingJobRecord, StagingStatus};

    #[test]
    fn transfer_file_names_stay_inside_the_owned_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = TransferSourceFile::new(root.path(), "../unsafe\\photo?.png", MediaType::Image)
            .unwrap();
        assert_eq!(file.path.parent(), Some(file.directory.as_path()));
        assert!(
            file.path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(".png")
        );
        assert!(
            !file
                .path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains('?')
        );
    }

    #[test]
    fn transfer_command_keeps_stable_source_identity_and_separate_target() {
        let command: SaveExistingAssetCommand = serde_json::from_value(json!({
            "source": {
                "kind": "cloud",
                "assetId": "asset-123",
                "providerConnectionId": "source-provider",
                "mediaType": "image"
            },
            "destination": "object_storage",
            "targetProviderConnectionId": null,
            "groupId": null,
            "name": "saved.png"
        }))
        .unwrap();
        assert_eq!(command.source.kind, ExistingMaterialSourceKind::Cloud);
        assert_eq!(command.source.asset_id, "asset-123");
        assert_eq!(
            command.source.provider_connection_id.as_deref(),
            Some("source-provider")
        );
        assert_eq!(
            command.destination,
            MaterialLibraryDestination::ObjectStorage
        );
        assert_eq!(
            serde_json::to_value(SaveExistingAssetResult {
                destination: MaterialLibraryDestination::Local,
                asset_id: "local-b64-123".into(),
                reused: true,
            })
            .unwrap(),
            json!({ "destination": "local", "assetId": "local-b64-123", "reused": true })
        );
    }

    #[test]
    fn startup_cleanup_keeps_indexed_cloud_backup_and_removes_orphan() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("transfer");
        let storage = Storage::open(&root.path().join("data.sqlite3")).unwrap();
        let mut retained = TransferSourceFile::new(&managed, "kept.png", MediaType::Image).unwrap();
        let mut other_provider =
            TransferSourceFile::new(&managed, "other.png", MediaType::Image).unwrap();
        let mut orphan = TransferSourceFile::new(&managed, "orphan.png", MediaType::Image).unwrap();
        fs::write(&retained.path, b"kept").unwrap();
        fs::write(&other_provider.path, b"other").unwrap();
        fs::write(&orphan.path, b"orphan").unwrap();
        storage
            .insert_staging_job(&StagingJobRecord {
                id: "cloud-job".into(),
                local_path: retained.path.to_string_lossy().into_owned(),
                purpose: "asset_import".into(),
                media_type: MediaType::Image,
                object_key: None,
                status: StagingStatus::Active,
                bytes_total: Some(4),
                bytes_uploaded: 4,
                asset_id: Some("asset-kept".into()),
                import_target: Some(StagingAssetImportTarget {
                    provider_connection_id: "provider".into(),
                    name: None,
                    group_id: None,
                }),
                adjustment: None,
                error: None,
                created_at: 0,
                updated_at: 0,
            })
            .unwrap();
        storage
            .insert_staging_job(&StagingJobRecord {
                id: "other-provider-job".into(),
                local_path: other_provider.path.to_string_lossy().into_owned(),
                purpose: "asset_import".into(),
                media_type: MediaType::Image,
                object_key: None,
                status: StagingStatus::Active,
                bytes_total: Some(5),
                bytes_uploaded: 5,
                asset_id: Some("asset-kept".into()),
                import_target: Some(StagingAssetImportTarget {
                    provider_connection_id: "other-provider".into(),
                    name: None,
                    group_id: None,
                }),
                adjustment: None,
                error: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        retained.retain();
        other_provider.retain();
        orphan.retain();
        cleanup_orphan_sources(&managed, &storage).unwrap();
        assert!(retained.path.exists());
        assert!(other_provider.path.exists());
        assert!(!orphan.path.exists());
        remove_imported_source(&managed, &storage, "provider", "asset-kept").unwrap();
        assert!(!retained.path.exists());
        assert!(other_provider.path.exists());
    }
}
