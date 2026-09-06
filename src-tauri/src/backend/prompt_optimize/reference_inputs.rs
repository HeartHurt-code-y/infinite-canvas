//! Read connected materials through the same stable identities as generation inputs.

use tokio::io::AsyncReadExt as _;

use super::*;

#[derive(Debug)]
pub(super) struct ReferenceBytes {
    bytes: Vec<u8>,
    local_path: Option<PathBuf>,
}

fn validate_byte_size(display_name: &str, byte_size: u64, limit: u64) -> BackendResult<()> {
    if byte_size == 0 || byte_size > limit {
        return Err(BackendError::validation(
            "reference material must be non-empty and no larger than 14 MiB",
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
    let bytes = if let Some(limit) = byte_limit {
        if !path.is_absolute() {
            return Err(BackendError::validation(
                "reference material requires an absolute local path",
                json!({ "displayName": display_name, "localPath": path }),
            ));
        }
        let file = tokio::fs::File::open(path).await.map_err(|error| {
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
        validate_byte_size(display_name, metadata.len(), limit)?;
        // A file may grow after metadata is read; never buffer more than the limit plus one byte.
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes).await?;
        validate_byte_size(display_name, bytes.len() as u64, limit)?;
        bytes
    } else {
        tokio::fs::read(path).await?
    };
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
    if let Some(limit) = byte_limit {
        validate_byte_size(display_name, bytes.len() as u64, limit)?;
    }
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
    validate_byte_size(
        display_name,
        material.bytes.len() as u64,
        MAX_MULTIMODAL_FILE_BYTES,
    )?;
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

pub(super) fn validate_material_count(count: usize) -> BackendResult<()> {
    if count > MAX_MULTIMODAL_INPUTS {
        return Err(BackendError::validation(
            "a request accepts at most 8 local and connected multimodal materials",
            json!({ "materialCount": count, "maximum": MAX_MULTIMODAL_INPUTS }),
        ));
    }
    Ok(())
}

pub(super) fn validate_material_bytes(payloads: &[MultimodalPayload]) -> BackendResult<()> {
    let total_bytes = payloads
        .iter()
        .map(|payload| {
            payload.text.as_ref().map_or_else(
                || {
                    payload.base64.as_ref().map_or(0, |encoded| {
                        // Base64 padding accounts for the original bytes without decoding a second copy.
                        encoded.len() / 4 * 3
                            - encoded
                                .bytes()
                                .rev()
                                .take_while(|byte| *byte == b'=')
                                .count()
                    })
                },
                String::len,
            ) as u64
        })
        .sum::<u64>();
    if total_bytes > MAX_MULTIMODAL_TOTAL_BYTES {
        return Err(BackendError::validation(
            "local and connected multimodal materials exceed the 14 MiB total limit",
            json!({ "totalBytes": total_bytes, "maximum": MAX_MULTIMODAL_TOTAL_BYTES }),
        ));
    }
    Ok(())
}

pub(super) async fn append_reference_inputs(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    attempt_id: &str,
    inputs: &[PromptReferenceInput],
    payloads: &mut Vec<MultimodalPayload>,
) -> BackendResult<()> {
    validate_material_count(payloads.len() + inputs.len())?;
    validate_material_bytes(payloads)?;
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
        let material = resolve_target_bytes(
            deps,
            &task,
            attempt_id,
            &input.target,
            display_name,
            Some(MAX_MULTIMODAL_FILE_BYTES),
        )
        .await?;
        payloads.push(reference_payload(input, material)?);
        validate_material_bytes(payloads)?;
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
        let mut payloads = Vec::new();
        for (filename, media_type, mime_type, signature) in cases {
            let path = directory.path().join(filename);
            let mut original_bytes = signature.to_vec();
            original_bytes.extend_from_slice(&[42; 600]);
            tokio::fs::write(&path, &original_bytes).await.unwrap();
            let material = read_local_bytes(&path, filename, Some(MAX_MULTIMODAL_FILE_BYTES))
                .await
                .unwrap();
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
        let (_, _, body) = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini",
            "SYSTEM",
            "USER",
            &[],
            &payloads,
        )
        .unwrap();
        let archived = redacted_request_value(&body);
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
            build_text_model_request("openai_chat_v1", "model", "S", "U", &[], &payloads)
                .unwrap_err()
                .to_string()
                .contains("OpenAI-compatible")
        );
        assert!(
            build_text_model_request("anthropic_messages_v1", "model", "S", "U", &[], &payloads)
                .unwrap_err()
                .to_string()
                .contains("Claude")
        );
    }

    #[tokio::test]
    async fn connected_materials_reject_missing_oversized_and_mislabeled_files() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.png");
        assert!(
            read_local_bytes(&missing, "missing", Some(MAX_MULTIMODAL_FILE_BYTES))
                .await
                .unwrap_err()
                .to_string()
                .contains("no longer available")
        );
        let oversized = directory.path().join("oversized.mp4");
        let file = tokio::fs::File::create(&oversized).await.unwrap();
        file.set_len(MAX_MULTIMODAL_FILE_BYTES + 1).await.unwrap();
        assert!(
            read_local_bytes(&oversized, "oversized", Some(MAX_MULTIMODAL_FILE_BYTES))
                .await
                .unwrap_err()
                .to_string()
                .contains("14 MiB")
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

    #[test]
    fn local_and_connected_materials_share_count_and_raw_byte_limits() {
        assert!(validate_material_count(8).is_ok());
        assert!(
            validate_material_count(9)
                .unwrap_err()
                .to_string()
                .contains("at most 8")
        );
        let local_document = MultimodalPayload {
            display_name: "本地文档".to_string(),
            kind: PromptMultimodalKind::Document,
            mime_type: "text/plain".to_string(),
            base64: None,
            text: Some("A".repeat(MAX_MULTIMODAL_TOTAL_BYTES as usize - 1)),
        };
        let mut connected_image = MultimodalPayload {
            display_name: "连线图片".to_string(),
            kind: PromptMultimodalKind::Image,
            mime_type: "image/png".to_string(),
            base64: Some(BASE64_STANDARD.encode([1])),
            text: None,
        };
        assert!(
            validate_material_bytes(&[local_document.clone(), connected_image.clone()]).is_ok()
        );
        connected_image.base64 = Some(BASE64_STANDARD.encode([1, 2]));
        assert!(
            validate_material_bytes(&[local_document, connected_image])
                .unwrap_err()
                .to_string()
                .contains("14 MiB total")
        );
    }
}
