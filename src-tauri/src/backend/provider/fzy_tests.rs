use std::{
    io::{Read as _, Write as _},
    net::TcpListener,
    time::{Duration, Instant},
};

use super::tests::{resolved, resolved_media, task};
use super::*;
use crate::backend::{
    model_schema::normalize_parameters, provider_adapter::MOYU_ADAPTER_ID, storage::NewTask,
    types::UpsertProviderConnectionCommand,
};

fn mock_server(responses: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut requests = Vec::new();
        for (status, response) in responses {
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "mock did not receive the expected request"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("mock accept: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let header_end = loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, length)| length.trim().parse::<usize>().unwrap());
            while bytes.len() - header_end < length {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let body = response.to_string();
            write!(stream, "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nx-request-id: fzy-test-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (base, server)
}

#[tokio::test]
async fn fzy_image_http_submission_and_reopened_task_query_keep_frozen_identity() {
    let (base_url, server) = mock_server(vec![
        (
            200,
            json!({"id":"fzy-remote-1", "model":"custom-image", "status":"queued", "imagePriceCny":"0.5"}),
        ),
        (
            200,
            json!({"id":"fzy-remote-1", "status":"success", "results":[{"url":"https://example.com/output.png"}], "chargedUsd":"0.074478"}),
        ),
    ]);
    let directory = tempfile::TempDir::new().unwrap();
    let path = directory.path().join("backend.sqlite");
    let credential_path = directory.path().join("credentials.json");
    let storage = Arc::new(Storage::open(&path).unwrap());
    let provider = storage
        .upsert_provider_connection(&UpsertProviderConnectionCommand {
            id: "fzy-test".into(),
            display_name: "FZY test".into(),
            adapter_id: FZY_ADAPTER_ID.into(),
            base_url: base_url.clone(),
            enabled: true,
        })
        .unwrap();
    let credentials = CredentialStore::file(credential_path.clone());
    credentials.set("fzy-frozen-key", "sk-frozen-test").unwrap();
    let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
    lifecycle
        .create(NewTask {
            id: "local-fzy-task",
            canvas_id: "canvas-1",
            source_node_id: "image-1",
            operation: GenerationOperation::ImageToImage,
            provider: &provider,
            api_key_ref: "fzy-frozen-key",
            model_definition_id: "custom-image-definition",
            remote_model_id: Some("custom-image"),
            logical_request: &json!({"prompt":"test"}),
        })
        .unwrap();
    for fact in [
        GenerationLifecycleFact::BeginResolution {
            attempt_id: "resolve-1".into(),
        },
        GenerationLifecycleFact::ResolutionSucceeded {
            attempt_id: "resolve-1".into(),
            resolved_request: json!({}),
        },
        GenerationLifecycleFact::BeginSubmission {
            attempt_id: "submit-1".into(),
            backoff_ms: None,
        },
    ] {
        lifecycle.commit("local-fzy-task", fact).unwrap();
    }
    let record = storage.get_task_execution("local-fzy-task").unwrap();
    let schema = schema_for_enabled_operations(
        &Value::Null,
        "custom-image",
        &[GenerationOperation::ImageToImage],
        RequestDialect::FzyAi,
    );
    let mut generation = resolved(
        schema["image_to_image"].clone(),
        json!({
            "aspect_ratio":"16:9", "resolution":"4k", "quality":"high", "background":"transparent",
            "mask":"https://example.com/mask.png", "n":1,
        }),
    );
    let mut local_image = resolved_media(MediaType::Image, 1, "reference_image", "", None);
    local_image.remote_reference = None;
    local_image.bytes = Some(vec![1, 2, 3]);
    generation.images = vec![
        local_image,
        resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "https://example.com/reference.png",
            None,
        ),
    ];
    let runtime =
        ProviderRuntime::new(Arc::clone(&storage), lifecycle.clone(), credentials).unwrap();
    let (submission, response) = runtime
        .submit(&record, "submit-1", &generation)
        .await
        .unwrap();
    let GenerationSubmission::RemoteImageTask {
        task_id: remote_task_id,
    } = submission
    else {
        panic!("expected remote image identity")
    };
    lifecycle
        .commit(
            &record.id,
            GenerationLifecycleFact::SubmissionRemoteAccepted {
                attempt_id: "submit-1".into(),
                call_id: response.call_id,
                tokens: None,
                remote_task_id,
            },
        )
        .unwrap();
    // 当前连接和模型定义可以改变；已提交的任务仍查询原地址，使用原凭据引用。
    storage
        .upsert_provider_connection(&UpsertProviderConnectionCommand {
            id: provider.id,
            display_name: "Changed connection".into(),
            adapter_id: MOYU_ADAPTER_ID.into(),
            base_url: "http://127.0.0.1:1".into(),
            enabled: true,
        })
        .unwrap();
    drop(runtime);
    drop(lifecycle);
    drop(storage);
    let storage = Arc::new(Storage::open(&path).unwrap());
    let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
    let restored = storage.get_task_execution("local-fzy-task").unwrap();
    assert_eq!(restored.remote_task_id.as_deref(), Some("fzy-remote-1"));
    assert_eq!(restored.base_url_snapshot, base_url);
    assert_eq!(restored.adapter_id_snapshot, FZY_ADAPTER_ID);
    lifecycle
        .commit(
            &restored.id,
            GenerationLifecycleFact::BeginObservation {
                attempt_id: "observe-1".into(),
                backoff_ms: None,
            },
        )
        .unwrap();
    let runtime = ProviderRuntime::new(
        Arc::clone(&storage),
        lifecycle,
        CredentialStore::file(credential_path),
    )
    .unwrap();
    let (observed, _) = runtime.observe(&restored, "observe-1").await.unwrap();
    assert_eq!(observed.remote_status, "success");
    assert!(
        matches!(observed.images.as_slice(), [ImageSource::Url { url, .. }] if url == "https://example.com/output.png")
    );
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /v1/images/generations HTTP/1.1"));
    assert!(requests[1].starts_with("GET /v1/images/tasks/fzy-remote-1 HTTP/1.1"));
    assert!(requests.iter().all(|request| {
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-frozen-test")
    }));
    let body: Value = serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["model"], "custom-image");
    assert_eq!(
        body["images"],
        json!([
            "data:image/png;base64,AQID",
            "https://example.com/reference.png"
        ])
    );
    assert_eq!(body["background"], "transparent");
    assert_eq!(body["mask"], "https://example.com/mask.png");
    assert_eq!(body["n"], 1);
    assert!(body.get("replyType").is_none());
}

#[test]
fn fzy_image_receipts_distinguish_rejection_from_unknown_paid_submission() {
    let mut record = task(GenerationOperation::TextToImage);
    record.adapter_id_snapshot = FZY_ADAPTER_ID.into();
    for (status, body, unknown) in [
        (200, "{}", true),
        (200, "invalid JSON", true),
        (
            502,
            r#"{"error":{"code":"image_submission_unknown","message":"receipt not confirmed"}}"#,
            true,
        ),
        (
            502,
            r#"{"error":{"code":"image_receipt_unconfirmed"}}"#,
            true,
        ),
        (
            503,
            r#"{"error":{"code":"exchange_rate_unavailable"}}"#,
            false,
        ),
        (
            400,
            r#"{"error":{"code":"unsupported_capability","message":"invalid aspect_ratio"}}"#,
            false,
        ),
    ] {
        let response = CapturedHttpResponse {
            call_id: "submit".into(),
            status,
            headers: json!({"x-request-id":"request-1"}),
            body: body.into(),
        };
        let error = parse_task_image_submission(&record, &response).unwrap_err();
        let details = &error.runtime_record()["details"];
        assert_eq!(details["ambiguousPaidSubmission"] == true, unknown);
        let source = if unknown {
            &details["source"]["details"]
        } else {
            details
        };
        assert_eq!(source["rawResponse"], body);
        assert_eq!(source["headers"]["x-request-id"], "request-1");
        if !unknown {
            assert_eq!(details["noChargeTerminal"], true);
        }
    }
}

#[tokio::test]
async fn fzy_image_rejection_does_not_strip_parameters_and_resubmit() {
    let (base_url, server) = mock_server(vec![(
        400,
        json!({
            "error":{"code":"unknown_parameter", "param":"mask", "message":"Unknown parameter: 'mask'."}
        }),
    )]);
    let directory = tempfile::TempDir::new().unwrap();
    let storage = Arc::new(Storage::open(&directory.path().join("backend.sqlite")).unwrap());
    let provider = storage
        .upsert_provider_connection(&UpsertProviderConnectionCommand {
            id: "fzy-rejected".into(),
            display_name: "FZY rejection".into(),
            adapter_id: FZY_ADAPTER_ID.into(),
            base_url,
            enabled: true,
        })
        .unwrap();
    let credentials = CredentialStore::file(directory.path().join("credentials.json"));
    credentials.set(&provider.api_key_ref, "sk-test").unwrap();
    let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
    lifecycle
        .create(NewTask {
            id: "fzy-rejected-task",
            canvas_id: "canvas",
            source_node_id: "image",
            operation: GenerationOperation::TextToImage,
            provider: &provider,
            api_key_ref: &provider.api_key_ref,
            model_definition_id: "image-model",
            remote_model_id: Some("gpt-image-2"),
            logical_request: &json!({}),
        })
        .unwrap();
    for fact in [
        GenerationLifecycleFact::BeginResolution {
            attempt_id: "resolve".into(),
        },
        GenerationLifecycleFact::ResolutionSucceeded {
            attempt_id: "resolve".into(),
            resolved_request: json!({}),
        },
        GenerationLifecycleFact::BeginSubmission {
            attempt_id: "submit".into(),
            backoff_ms: None,
        },
    ] {
        lifecycle.commit("fzy-rejected-task", fact).unwrap();
    }
    let record = storage.get_task_execution("fzy-rejected-task").unwrap();
    let schema = schema_for_enabled_operations(
        &Value::Null,
        "gpt-image-2",
        &[GenerationOperation::TextToImage],
        RequestDialect::FzyAi,
    );
    let generation = resolved(
        schema["text_to_image"].clone(),
        json!({"mask":"https://example.com/mask.png"}),
    );
    let runtime = ProviderRuntime::new(Arc::clone(&storage), lifecycle, credentials).unwrap();
    let error = runtime
        .submit(&record, "submit", &generation)
        .await
        .unwrap_err();
    assert_eq!(error.runtime_record()["details"]["noChargeTerminal"], true);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["mask"], "https://example.com/mask.png");
    assert!(body.get("images").is_none());
}

#[test]
fn fzy_image_failed_and_expired_observations_keep_complete_details() {
    for status in ["queued", "running", "failed", "expired"] {
        let response = CapturedHttpResponse {
            call_id:"observe".into(), status:200, headers:json!({"x-request-id":"request-2"}),
            body:json!({"id":"remote-2", "status":status, "errorCode":"channel_error", "errorDetail":"{\"reason\":\"full upstream detail\"}"}).to_string(),
        };
        let observation = parse_image_observation(&response).unwrap();
        assert_eq!(observation.remote_status, status);
        if matches!(status, "failed" | "expired") {
            let failure = observation.failure.unwrap();
            assert_eq!(failure["errorCode"], "channel_error");
            assert_eq!(
                failure["errorDetail"],
                "{\"reason\":\"full upstream detail\"}"
            );
            assert_eq!(failure["rawResponse"], response.body);
        } else {
            assert!(observation.failure.is_none());
        }
    }
}

#[test]
fn fzy_image_discovery_uses_the_connection_contract() {
    let response = RawProviderResponse {
        status: 200,
        headers: json!({}),
        body: json!({"object":"list", "data":[
            {"id":"gpt-image-2", "object":"model", "owned_by":"relay"},
            {"id":"gpt-image-2.5-sunburst", "object":"model", "owned_by":"relay"},
        ]})
        .to_string(),
    };
    let models = parse_model_catalog(&response, RequestDialect::FzyAi).unwrap();
    for model in models {
        assert_eq!(
            model.suggested_operations,
            vec![
                GenerationOperation::TextToImage,
                GenerationOperation::ImageToImage
            ]
        );
        assert_eq!(
            model.operation_schema["image_to_image"]["requestProfileId"],
            FZY_IMAGE_PROFILE
        );
    }
}

struct VideoFixture {
    directory: tempfile::TempDir,
    storage: Arc<Storage>,
    runtime: ProviderRuntime,
    task: TaskExecutionRecord,
}

fn video_fixture(base_url: &str) -> VideoFixture {
    let directory = tempfile::TempDir::new().unwrap();
    let storage = Arc::new(Storage::open(&directory.path().join("backend.sqlite")).unwrap());
    let provider = storage
        .upsert_provider_connection(&UpsertProviderConnectionCommand {
            id: "fzy-video".into(),
            display_name: "FZY video".into(),
            adapter_id: FZY_ADAPTER_ID.into(),
            base_url: base_url.into(),
            enabled: true,
        })
        .unwrap();
    let credentials = CredentialStore::file(directory.path().join("credentials.json"));
    credentials.set("fzy-video-key", "sk-frozen-video").unwrap();
    let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
    lifecycle
        .create(NewTask {
            id: "local-fzy-video",
            canvas_id: "canvas-1",
            source_node_id: "video-1",
            operation: GenerationOperation::VideoGeneration,
            provider: &provider,
            api_key_ref: "fzy-video-key",
            model_definition_id: "custom-video-definition",
            remote_model_id: Some("custom-video"),
            logical_request: &json!({"prompt":"test"}),
        })
        .unwrap();
    for fact in [
        GenerationLifecycleFact::BeginResolution {
            attempt_id: "resolve-video".into(),
        },
        GenerationLifecycleFact::ResolutionSucceeded {
            attempt_id: "resolve-video".into(),
            resolved_request: json!({}),
        },
        GenerationLifecycleFact::BeginSubmission {
            attempt_id: "submit-video".into(),
            backoff_ms: None,
        },
    ] {
        lifecycle.commit("local-fzy-video", fact).unwrap();
    }
    let task = storage.get_task_execution("local-fzy-video").unwrap();
    let runtime = ProviderRuntime::new(Arc::clone(&storage), lifecycle, credentials).unwrap();
    VideoFixture {
        directory,
        storage,
        runtime,
        task,
    }
}

fn video_generation() -> ResolvedGeneration {
    let schema = schema_for_enabled_operations(
        &Value::Null,
        "custom-video",
        &[GenerationOperation::VideoGeneration],
        RequestDialect::FzyAi,
    );
    resolved(
        schema["video_generation"].clone(),
        json!({
            "duration":10, "ratio":"9:16", "resolution":"720P", "generate_audio":false, "n":1,
        }),
    )
}

fn local_media(media_type: MediaType, position: u32, role: &str) -> ResolvedMedia {
    let mut input = resolved_media(media_type, position, role, "", None);
    input.bytes = Some(b"local reference bytes".to_vec());
    input.remote_reference = None;
    input
}

#[test]
fn fzy_video_dialect_overrides_native_families_and_catalog_names() {
    for model_id in [
        "PixVerse-V6",
        "doubao-seedance-2.5",
        "sp2.5-720p-30s-ch5",
        "rd-seedance-2.5-720p",
        "wan3.0-video",
        "custom-video",
    ] {
        let mut schema = schema_for_enabled_operations(
            &Value::Null,
            model_id,
            &[GenerationOperation::VideoGeneration],
            RequestDialect::FzyAi,
        );
        let operation = &schema["video_generation"];
        assert_eq!(
            operation["requestProfileId"],
            GatewayProfile::FzyVideo.profile_id()
        );
        assert_eq!(operation["request"]["path"], "/v1/video/generations");
        assert_eq!(operation["request"]["parameterContainer"], "root");
        assert_eq!(operation["parameters"]["duration"]["default"], 5);
        assert!(operation["parameters"].get("draft").is_none());
        assert_eq!(
            normalize_parameters(operation, &json!({})).unwrap(),
            json!({"duration":5,"ratio":"16:9"})
        );
        assert!(!apply_request_dialect(
            &mut schema,
            model_id,
            RequestDialect::FzyAi
        ));
        assert_eq!(
            GatewayProfile::for_frozen_snapshot(Some(model_id), FZY_ADAPTER_ID),
            Some(GatewayProfile::FzyVideo)
        );
    }
    let response = RawProviderResponse {
        status: 200,
        headers: json!({}),
        body: json!({"data":[
            {"id":"sp2.5-720p-30s-ch1","object":"model","owned_by":"relay"},
            {"id":"custom-video","operations":["video"]},
        ]})
        .to_string(),
    };
    let models = parse_model_catalog(&response, RequestDialect::FzyAi).unwrap();
    assert_eq!(models.len(), 2);
    for model in models {
        assert_eq!(
            model.suggested_operations,
            vec![GenerationOperation::VideoGeneration]
        );
        assert_eq!(
            model.operation_schema["video_generation"]["requestProfileId"],
            GatewayProfile::FzyVideo.profile_id()
        );
    }
    assert_eq!(
        GatewayProfile::FzyVideo
            .poll_cadence()
            .next_poll_wait(Duration::from_secs(600)),
        Some(Duration::from_secs(5))
    );
    assert!(GatewayProfile::FzyVideo.needs_local_bytes());
}

#[tokio::test]
async fn fzy_video_upload_submit_reopen_and_query_keep_the_frozen_identity() {
    let (base_url, server) = mock_server(vec![
        (200, json!({"url":"https://example.com/uploaded.png"})),
        (200, json!({"url":"https://example.com/uploaded.mp4"})),
        (200, json!({"url":"https://example.com/uploaded.mp3"})),
        (
            200,
            json!({"id":"fzy-video-remote","status":"queued","progress":0}),
        ),
        (
            200,
            json!({"id":"fzy-video-remote","status":"running","progress":45}),
        ),
        (
            200,
            json!({"id":"fzy-video-remote","status":"success","progress":100,
            "results":[{"url":"https://example.com/output.mp4"}],"chargedUsd":"0.50"}),
        ),
        (
            200,
            json!({"id":"fzy-video-remote","status":"success","progress":100,
            "results":[{"url":"https://example.com/output.mp4"}]}),
        ),
    ]);
    let VideoFixture {
        directory,
        storage,
        runtime,
        task,
    } = video_fixture(&base_url);
    let mut generation = video_generation();
    generation.images = vec![
        local_media(MediaType::Image, 1, "reference_image"),
        resolved_media(
            MediaType::Image,
            2,
            "reference_image",
            "https://example.com/public.png",
            None,
        ),
    ];
    generation.videos = vec![local_media(MediaType::Video, 1, "reference_video")];
    generation.audios = vec![local_media(MediaType::Audio, 1, "reference_audio")];
    let (submission, receipt) = runtime
        .submit(&task, "submit-video", &generation)
        .await
        .unwrap();
    let GenerationSubmission::RemoteVideoTask { task_id } = submission else {
        panic!("video task ID")
    };
    runtime
        .lifecycle
        .commit(
            &task.id,
            GenerationLifecycleFact::SubmissionRemoteAccepted {
                attempt_id: "submit-video".into(),
                call_id: receipt.call_id,
                tokens: None,
                remote_task_id: task_id,
            },
        )
        .unwrap();
    storage
        .upsert_provider_connection(&UpsertProviderConnectionCommand {
            id: "fzy-video".into(),
            display_name: "changed".into(),
            adapter_id: MOYU_ADAPTER_ID.into(),
            base_url: "http://127.0.0.1:1".into(),
            enabled: true,
        })
        .unwrap();
    drop(runtime);
    drop(storage);
    let storage = Arc::new(Storage::open(&directory.path().join("backend.sqlite")).unwrap());
    let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
    let restored = storage.get_task_execution(&task.id).unwrap();
    assert_eq!(restored.adapter_id_snapshot, FZY_ADAPTER_ID);
    assert_eq!(restored.base_url_snapshot, base_url);
    assert_eq!(restored.remote_task_id.as_deref(), Some("fzy-video-remote"));
    lifecycle
        .commit(
            &task.id,
            GenerationLifecycleFact::BeginObservation {
                attempt_id: "observe-video".into(),
                backoff_ms: None,
            },
        )
        .unwrap();
    let runtime = ProviderRuntime::new(
        Arc::clone(&storage),
        lifecycle,
        CredentialStore::file(directory.path().join("credentials.json")),
    )
    .unwrap();
    let (running, _) = runtime.observe(&restored, "observe-video").await.unwrap();
    assert_eq!(running.remote_status, "running");
    assert_eq!(running.progress, Some(45.0));
    let (done, _) = runtime.observe(&restored, "observe-video").await.unwrap();
    assert_eq!(
        done.video_url.as_deref(),
        Some("https://example.com/output.mp4")
    );
    assert_eq!(done.remote_status, "success");
    assert_eq!(
        runtime.refresh_sp25_video_url(&restored).await.unwrap(),
        "https://example.com/output.mp4"
    );
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 7);
    for request in &requests[..3] {
        assert!(request.starts_with("POST /v1/assets/uploads HTTP/1.1"));
        assert!(request.contains("name=\"file\""));
        assert!(request.contains("local reference bytes"));
    }
    assert!(requests[3].starts_with("POST /v1/video/generations HTTP/1.1"));
    for request in &requests[4..] {
        assert!(request.starts_with("GET /v1/video/generations/fzy-video-remote HTTP/1.1"));
    }
    assert!(requests.iter().all(|request| {
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-frozen-video")
    }));
    let body: Value = serde_json::from_str(requests[3].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body["images"],
        json!([
            "https://example.com/uploaded.png",
            "https://example.com/public.png"
        ])
    );
    assert_eq!(
        body["reference_videos"],
        json!(["https://example.com/uploaded.mp4"])
    );
    assert_eq!(
        body["reference_audios"],
        json!(["https://example.com/uploaded.mp3"])
    );
    assert_eq!(body["duration"], 10);
    assert_eq!(body["generate_audio"], false);
    assert!(body.get("metadata").is_none());
}

#[test]
fn fzy_video_receipts_guard_unknown_paid_submissions_and_preserve_rejections() {
    for (status, body, unknown) in [
        (200, "{}", true),
        (200, "invalid JSON", true),
        (200, r#"{"id":"  "}"#, true),
        (
            502,
            r#"{"error":{"code":"upstream_submit_failed","message":"receipt missing"}}"#,
            true,
        ),
        (400, r#"{"error":{"code":"upstream_submit_failed"}}"#, true),
        (
            503,
            r#"{"error":{"code":"exchange_rate_unavailable"}}"#,
            false,
        ),
        (400, r#"{"error":{"code":"duration_required"}}"#, false),
        (400, r#"{"error":{"code":"unsupported_capability"}}"#, false),
        (402, r#"{"error":{"code":"insufficient_balance"}}"#, false),
    ] {
        let response = CapturedHttpResponse {
            call_id: "receipt".into(),
            status,
            headers: json!({"x-request-id":"video-request"}),
            body: body.into(),
        };
        let error = fzy::parse_task_id(&response).unwrap_err().runtime_record();
        if unknown {
            assert_eq!(
                error["details"]["ambiguousPaidSubmission"], true,
                "{status}: {body}"
            );
            assert_eq!(error["details"]["source"]["details"]["rawResponse"], body);
        } else {
            assert_eq!(error["details"]["noChargeTerminal"], true);
        }
    }
    assert!(
        fzy::observe_path("remote/id?query#hash")
            .unwrap()
            .ends_with("remote%2Fid%3Fquery%23hash")
    );
}

#[tokio::test]
async fn fzy_video_rejection_never_strips_fields_and_resubmits() {
    let (base_url, server) = mock_server(vec![(
        400,
        json!({"error":{"code":"unknown_parameter","message":"unknown parameter: generate_audio"}}),
    )]);
    let fixture = video_fixture(&base_url);
    let error = fixture
        .runtime
        .submit(&fixture.task, "submit-video", &video_generation())
        .await
        .unwrap_err();
    assert_eq!(error.runtime_record()["details"]["noChargeTerminal"], true);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("\"generate_audio\":false"));
}

#[tokio::test]
async fn fzy_video_upload_failure_never_reaches_paid_submission() {
    let (base_url, server) = mock_server(vec![(
        503,
        json!({"error":{"code":"no_available_credentials","message":"upload unavailable"}}),
    )]);
    let fixture = video_fixture(&base_url);
    let mut generation = video_generation();
    generation.images = vec![local_media(MediaType::Image, 1, "reference_image")];
    let error = fixture
        .runtime
        .submit(&fixture.task, "submit-video", &generation)
        .await
        .unwrap_err();
    assert!(
        error.runtime_record()["details"]
            .get("ambiguousPaidSubmission")
            .is_none()
    );
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /v1/assets/uploads HTTP/1.1"));
}

#[test]
fn fzy_video_frame_encoding_preserves_roles_and_rejects_conflicts() {
    let mut generation = video_generation();
    generation.images = vec![
        resolved_media(
            MediaType::Image,
            1,
            "first_frame",
            "https://example.com/start.png",
            None,
        ),
        resolved_media(
            MediaType::Image,
            2,
            "last_frame",
            "https://example.com/end.png",
            None,
        ),
    ];
    let urls = vec![
        "https://example.com/start.png".into(),
        "https://example.com/end.png".into(),
    ];
    let body = fzy::build_video_body("custom-video", &generation, &urls).unwrap();
    assert_eq!(body["start_frame"], json!([urls[0]]));
    assert_eq!(body["end_frame"], json!([urls[1]]));
    assert!(body.get("images").is_none());
    generation.images[1].role = "reference_image".into();
    assert!(fzy::build_video_body("custom-video", &generation, &urls).is_err());
    generation.images[0].role = "reference_image".into();
    generation.parameters["model"] = json!("override-model");
    assert!(fzy::build_video_body("custom-video", &generation, &urls).is_err());
}

#[test]
fn fzy_video_failed_expired_and_incomplete_success_retain_protocol_details() {
    for status in ["queued", "running", "failed", "expired"] {
        let response = CapturedHttpResponse {
            call_id: "observed".into(),
            status: 200,
            headers: json!({"x-request-id":"query-video"}),
            body: json!({
                "id":"remote-video", "status":status, "progress":25,
                "errorCode":"MODEL_REJECTED", "errorDetail":"replace the reference video",
            })
            .to_string(),
        };
        let observation = fzy::parse_observation(&response, "remote-video").unwrap();
        assert_eq!(observation.remote_status, status);
        if matches!(status, "failed" | "expired") {
            let failure = observation.failure.unwrap();
            assert_eq!(failure["errorCode"], "MODEL_REJECTED");
            assert_eq!(failure["errorDetail"], "replace the reference video");
            assert_eq!(failure["rawResponse"], response.body);
        } else {
            assert!(observation.failure.is_none());
        }
    }
    let response = CapturedHttpResponse {
        call_id: "observed".into(),
        status: 200,
        headers: json!({}),
        body: json!({"id":"remote-video","status":"success","results":[]}).to_string(),
    };
    assert!(fzy::parse_observation(&response, "remote-video").is_err());
    assert!(fzy::parse_observation(&response, "another-task").is_err());
}
