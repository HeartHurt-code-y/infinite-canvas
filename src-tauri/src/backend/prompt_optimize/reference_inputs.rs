//! Read connected materials through the same stable identities as generation inputs.

use tokio::io::AsyncReadExt as _;

use super::*;

#[derive(Debug)]
pub(super) struct ReferenceBytes {
    bytes: Vec<u8>,
    local_path: Option<PathBuf>,
}

fn validate_byte_size(display_name: &str, byte_size: u64, limit: Option<u64>) -> BackendResult<()> {
    if byte_size == 0 {
        return Err(BackendError::validation(
            "reference material must be non-empty",
            json!({ "displayName": display_name, "byteSize": byte_size }),
        ));
    }
    if limit.is_some_and(|maximum| byte_size > maximum) {
        return Err(BackendError::validation(
            "reference material exceeds the configured byte limit",
            json!({ "displayName": display_name, "byteSize": byte_size, "maximum": limit }),
        ));
    }
    Ok(())
}

async fn read_local_bytes(
    path: &Path,
    display_name: &str,
    byte_limit: Option<u64>,
) -> BackendResult<ReferenceBytes> {
    if !path.is_absolute() {
        return Err(BackendError::validation(
            "reference material requires an absolute local path",
            json!({ "displayName": display_name, "localPath": path }),
        ));
    }
    let mut file = tokio::fs::File::open(path).await.map_err(|error| {
        BackendError::validation(
            "reference material is no longer available at its saved path",
            json!({ "displayName": display_name, "localPath": path, "error": error.to_string() }),
        )
    })?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(BackendError::validation(
            "reference material must be a regular file",
            json!({ "displayName": display_name, "localPath": path }),
        ));
    }
    validate_byte_size(display_name, metadata.len(), byte_limit)?;
    let mut bytes = Vec::new();
    if let Some(limit) = byte_limit {
        // Keep optional bounds for callers that explicitly request them, including a growing file.
        file.take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .await?;
    } else {
        file.read_to_end(&mut bytes).await?;
    }
    validate_byte_size(display_name, bytes.len() as u64, byte_limit)?;
    Ok(ReferenceBytes {
        bytes,
        local_path: Some(path.to_path_buf()),
    })
}

pub(super) async fn resolve_target_bytes(
    deps: &PromptVisionDeps<'_>,
    task: &TaskExecutionRecord,
    attempt_id: &str,
    target: &MediaReferenceTarget,
    display_name: &str,
    byte_limit: Option<u64>,
) -> BackendResult<ReferenceBytes> {
    let media_type = target.media_type();
    let bytes = match target {
        MediaReferenceTarget::Asset {
            provider_connection_id,
            asset_id,
            ..
        } => {
            let resolved = deps
                .assets
                .resolve(ResolveAsset {
                    identity: CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.clone(),
                        asset_id: asset_id.clone(),
                    },
                    expected_media_type: media_type,
                    delivery: AssetDelivery::Bytes,
                    trace: AssetReadTrace { task, attempt_id },
                })
                .await?;
            match resolved.access {
                ResolvedAssetAccess::Bytes(bytes) => bytes,
                ResolvedAssetAccess::RemoteReference(_) => {
                    return Err(BackendError::protocol(
                        "reference asset resolution did not return bytes",
                        json!({ "displayName": display_name, "assetId": asset_id }),
                    ));
                }
            }
        }
        MediaReferenceTarget::LocalAsset { staging_job_id, .. } => {
            let lease = deps.staging.local_asset_lease(staging_job_id, media_type)?;
            download_reference_bytes(deps.providers, &lease.get_url, display_name, byte_limit)
                .await?
        }
        MediaReferenceTarget::LocalBase64Asset { asset_id, .. } => {
            let (record, bytes) = deps.local_base64_assets.read_bytes(asset_id, media_type)?;
            validate_byte_size(display_name, record.byte_size, byte_limit)?;
            bytes
        }
        MediaReferenceTarget::LocalResult {
            generation_task_id,
            result_index,
            ..
        } => {
            let record = deps
                .local_results
                .verify_local_result(generation_task_id, *result_index)
                .await?;
            if record.media_type != media_type || record.save_status != SaveStatus::Succeeded {
                return Err(BackendError::validation(
                    "reference local result is not available with the declared media type",
                    json!({
                        "displayName": display_name,
                        "saveStatus": record.save_status,
                        "expectedMediaType": media_type,
                        "actualMediaType": record.media_type,
                    }),
                ));
            }
            let path = record.final_path.as_deref().ok_or_else(|| {
                BackendError::protocol(
                    "saved reference local result has no path",
                    json!({ "displayName": display_name }),
                )
            })?;
            return read_local_bytes(Path::new(path), display_name, byte_limit).await;
        }
        MediaReferenceTarget::LocalFile { path, .. } => {
            return read_local_bytes(Path::new(path.trim()), display_name, byte_limit).await;
        }
        MediaReferenceTarget::Url { url, .. } => {
            download_reference_bytes(deps.providers, url, display_name, byte_limit).await?
        }
    };
    validate_byte_size(display_name, bytes.len() as u64, byte_limit)?;
    Ok(ReferenceBytes {
        bytes,
        local_path: None,
    })
}

pub(super) async fn resolve_vision_target(
    deps: &PromptVisionDeps<'_>,
    task: &TaskExecutionRecord,
    attempt_id: &str,
    target: &MediaReferenceTarget,
    display_name: &str,
) -> BackendResult<VisionImagePayload> {
    if target.media_type() != MediaType::Image {
        return Err(BackendError::validation(
            "vision understanding only accepts image assets",
            json!({ "displayName": display_name, "mediaType": target.media_type() }),
        ));
    }
    let material = resolve_target_bytes(deps, task, attempt_id, target, display_name, None).await?;
    vision_image_payload(display_name, material.bytes)
}

fn reference_kind(media_type: MediaType) -> BackendResult<PromptMultimodalKind> {
    match media_type {
        MediaType::Image => Ok(PromptMultimodalKind::Image),
        MediaType::Audio => Ok(PromptMultimodalKind::Audio),
        MediaType::Video => Ok(PromptMultimodalKind::Video),
        MediaType::Text => Err(BackendError::validation(
            "connected reference materials only support images, audio and video",
            json!({ "mediaType": media_type }),
        )),
    }
}

fn reference_payload(
    input: &PromptReferenceInput,
    material: ReferenceBytes,
) -> BackendResult<MultimodalPayload> {
    let display_name = input.display_name.trim();
    let kind = reference_kind(input.target.media_type())?;
    validate_byte_size(display_name, material.bytes.len() as u64, None)?;
    let detected_mime = infer::get(&material.bytes)
        .map(|kind| kind.mime_type())
        .ok_or_else(|| {
            BackendError::validation(
                "reference material type could not be identified from its file signature",
                json!({ "displayName": display_name }),
            )
        })?;
    // Infer media from the original bytes, never from a thumbnail or the display name.
    let mime = match (kind, detected_mime) {
        (PromptMultimodalKind::Image, mime) if VISION_IMAGE_MIME_TYPES.contains(&mime) => mime,
        (PromptMultimodalKind::Audio, "audio/mpeg" | "audio/aac" | "audio/ogg") => detected_mime,
        (PromptMultimodalKind::Audio, "audio/wav" | "audio/x-wav") => "audio/wav",
        (
            PromptMultimodalKind::Audio,
            "audio/mp4" | "audio/m4a" | "video/mp4" | "application/mp4",
        ) => "audio/mp4",
        (PromptMultimodalKind::Audio, "application/ogg") => "audio/ogg",
        (PromptMultimodalKind::Audio, "audio/flac" | "audio/x-flac") => "audio/flac",
        (
            PromptMultimodalKind::Video,
            "video/mp4" | "video/webm" | "video/quicktime" | "video/x-matroska",
        ) => detected_mime,
        _ => {
            return Err(BackendError::validation(
                "reference material file signature does not match its media type or supported formats",
                json!({ "displayName": display_name, "mediaType": input.target.media_type(), "detectedMimeType": detected_mime }),
            ));
        }
    };
    if let Some(path) = material.local_path {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let expected = expected_multimodal_mime(kind, &extension);
        if expected.is_none_or(|expected| !binary_signature_matches(expected, detected_mime)) {
            return Err(BackendError::validation(
                "reference material extension does not match its media type and file signature",
                json!({ "displayName": display_name, "extension": extension, "detectedMimeType": detected_mime }),
            ));
        }
    }
    Ok(MultimodalPayload {
        display_name: display_name.to_string(),
        kind,
        mime_type: mime.to_string(),
        base64: Some(BASE64_STANDARD.encode(material.bytes)),
        text: None,
    })
}

pub(super) async fn append_reference_inputs(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    attempt_id: &str,
    inputs: &[PromptReferenceInput],
    payloads: &mut Vec<MultimodalPayload>,
) -> BackendResult<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let task = deps.storage.get_task_execution(task_id)?;
    for input in inputs {
        let display_name = input.display_name.trim();
        if display_name.is_empty() {
            return Err(BackendError::validation(
                "reference material requires a display name",
                json!({ "mediaType": input.target.media_type() }),
            ));
        }
        reference_kind(input.target.media_type())?;
        let material =
            resolve_target_bytes(deps, &task, attempt_id, &input.target, display_name, None)
                .await?;
        payloads.push(reference_payload(input, material)?);
    }
    Ok(())
}
