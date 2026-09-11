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

#[cfg(test)]
mod tests {
    use super::*;

    fn local_reference(path: &Path, media_type: MediaType) -> PromptReferenceInput {
        PromptReferenceInput {
            target: MediaReferenceTarget::LocalFile {
                path: path.to_string_lossy().into_owned(),
                media_type,
                canvas_node_key: Some("material-node".to_string()),
            },
            display_name: "连线素材".to_string(),
        }
    }

    #[tokio::test]
    async fn connected_images_audio_and_video_send_original_bytes_and_redact_archives() {
        let directory = tempfile::tempdir().unwrap();
        let cases: [(&str, MediaType, &str, &[u8]); 3] = [
            (
                "reference.png",
                MediaType::Image,
                "image/png",
                b"\x89PNG\r\n\x1a\n",
            ),
            (
                "reference.wav",
                MediaType::Audio,
                "audio/wav",
                b"RIFF\x00\x00\x00\x00WAVE",
            ),
            (
                "reference.mp4",
                MediaType::Video,
                "video/mp4",
                b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42",
            ),
        ];
        let mut payloads: Vec<MultimodalPayload> = Vec::new();
        for (filename, media_type, mime_type, signature) in cases {
            let path = directory.path().join(filename);
            let mut original_bytes = signature.to_vec();
            original_bytes.extend_from_slice(&[42; 600]);
            tokio::fs::write(&path, &original_bytes).await.unwrap();
            let material = read_local_bytes(&path, filename, None).await.unwrap();
            let payload = reference_payload(&local_reference(&path, media_type), material).unwrap();
            assert_eq!(payload.mime_type, mime_type);
            assert_eq!(
                BASE64_STANDARD
                    .decode(payload.base64.as_ref().unwrap())
                    .unwrap(),
                original_bytes
            );
            payloads.push(payload);
        }
        let plan = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini",
            "SYSTEM",
            &[],
            "USER",
            &[],
            &payloads,
        )
        .unwrap();
        let body = &plan.body;
        let archived = redacted_request_value(body);
        for (index, payload) in payloads.iter().enumerate() {
            assert_eq!(
                body["contents"][0]["parts"][index]["inline_data"]["mime_type"],
                payload.mime_type
            );
            assert_eq!(
                body["contents"][0]["parts"][index]["inline_data"]["data"],
                *payload.base64.as_ref().unwrap()
            );
            assert!(
                archived["contents"][0]["parts"][index]["inline_data"]["data"]
                    .as_str()
                    .unwrap()
                    .starts_with("<base64 omitted:")
            );
        }
        assert!(
            build_text_model_request("openai_chat_v1", "model", "S", &[], "U", &[], &payloads)
                .unwrap_err()
                .to_string()
                .contains("OpenAI-compatible")
        );
        assert!(
            build_text_model_request(
                "anthropic_messages_v1",
                "model",
                "S",
                &[],
                "U",
                &[],
                &payloads
            )
            .unwrap_err()
            .to_string()
            .contains("Claude")
        );
    }

    #[tokio::test]
    async fn connected_materials_reject_missing_empty_relative_and_mislabeled_files() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.png");
        assert!(
            read_local_bytes(&missing, "missing", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("no longer available")
        );
        let empty = directory.path().join("empty.png");
        tokio::fs::write(&empty, []).await.unwrap();
        assert!(
            read_local_bytes(&empty, "empty", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("non-empty")
        );
        assert!(
            read_local_bytes(Path::new("relative.png"), "relative", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("absolute local path")
        );
        assert!(
            read_local_bytes(directory.path(), "directory", None)
                .await
                .is_err()
        );
        let thumbnail = b"\x89PNG\r\n\x1a\n rest-of-png-bytes".to_vec();
        let input = local_reference(&directory.path().join("video.mp4"), MediaType::Video);
        assert!(
            reference_payload(
                &input,
                ReferenceBytes {
                    bytes: thumbnail.clone(),
                    local_path: None
                }
            )
            .unwrap_err()
            .to_string()
            .contains("file signature")
        );
        let path = directory.path().join("image.jpg");
        assert!(
            reference_payload(
                &local_reference(&path, MediaType::Image),
                ReferenceBytes {
                    bytes: thumbnail,
                    local_path: Some(path)
                }
            )
            .unwrap_err()
            .to_string()
            .contains("extension")
        );
        assert!(reference_kind(MediaType::Text).is_err());
    }

    #[tokio::test]
    async fn connected_materials_above_previous_file_and_total_limits_keep_all_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(14 * 1024 * 1024 + 1, 42);
        tokio::fs::write(&path, &bytes).await.unwrap();
        let material = read_local_bytes(&path, "large", None).await.unwrap();
        assert_eq!(material.bytes, bytes);
        let payload =
            reference_payload(&local_reference(&path, MediaType::Image), material).unwrap();
        assert_eq!(
            BASE64_STANDARD
                .decode(payload.base64.as_ref().unwrap())
                .unwrap(),
            bytes
        );
        // Optional bounds remain available for explicit bounded uses of the shared reader.
        assert!(
            read_local_bytes(&path, "bounded", Some(1024))
                .await
                .unwrap_err()
                .to_string()
                .contains("configured byte limit")
        );
        let local_document = MultimodalPayload {
            display_name: "本地文档".to_string(),
            kind: PromptMultimodalKind::Document,
            mime_type: "text/plain".to_string(),
            base64: None,
            text: Some("reference document".to_string()),
        };
        let plan = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini",
            "SYSTEM",
            &[],
            "USER",
            &[],
            &[payload.clone(), local_document],
        )
        .unwrap();
        let body = &plan.body;
        assert_eq!(
            body["contents"][0]["parts"][0]["inline_data"]["data"],
            *payload.base64.as_ref().unwrap()
        );
        assert!(
            body["contents"][0]["parts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|part| part["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("reference document")))
        );
        let archived = redacted_request_value(body);
        assert!(
            archived["contents"][0]["parts"][0]["inline_data"]["data"]
                .as_str()
                .unwrap()
                .starts_with("<base64 omitted:")
        );
    }
}
