use std::{
    io::{Read as _, Write as _},
    net::TcpListener,
    time::{Duration, Instant},
};

use super::tests::{resolved, resolved_media, task};
use super::*;
use crate::backend::{
    provider_adapter::MOYU_ADAPTER_ID, storage::NewTask, types::UpsertProviderConnectionCommand,
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
