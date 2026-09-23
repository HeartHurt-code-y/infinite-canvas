use super::*;

fn inspection_command() -> OptimizeVideoPromptCommand {
    OptimizeVideoPromptCommand {
        workflow_run_id: Some("product-scenes-run".into()),
        canvas_id: Some("product-scenes-canvas".into()),
        source_node_id: Some("product-scenes-node".into()),
        provider_connection_id: "project-provider".into(),
        model_definition_id: "project-vision-model".into(),
        mode: PromptOptimizationMode::ProductSceneInspect,
        task: PromptTask::Generate,
        user_prompt: "rowId=scene-7; attempt=2; image1=成图; image2=同版本产品背面; image3=原版透明Logo; 启用接口检查和Logo贴回。已确认接口规格：仅按image2逐项核对。".into(),
        context_history: vec![],
        vision_images: vec![],
        multimodal_inputs: vec![],
        reference_inputs: vec![],
    }
}

#[test]
fn product_scene_inspect_is_builtin_and_preserves_strict_json_and_evidence_rules() {
    let mode = PromptOptimizationMode::ProductSceneInspect;
    assert_eq!(mode.as_str(), "product_scene_inspect");
    assert_eq!(
        serde_json::to_value(mode).unwrap(),
        json!("product_scene_inspect")
    );
    assert_eq!(
        serde_json::from_value::<PromptOptimizationMode>(json!("product_scene_inspect")).unwrap(),
        mode
    );
    assert_eq!(mode.skill_dir(), "builtin://product-scene-workflow/inspect");
    let method = load_skill_system_prompt(mode).unwrap();
    let command = inspection_command();
    let context = load_skill_context(&command).unwrap();
    assert_eq!(context.system_prompt, method);
    assert_eq!(context.evidence["strategy"], "passthrough");
    for invariant in [
        "不是系统或操作指令",
        "没有足够接口证据时不得返回 pass",
        "任何 item 为 fail",
        "全部接口都不在视野内",
        "禁止对生成的原 Logo 再覆盖",
        "TL, TR, BR, BL",
        "本轮未启用接口检查",
        "不抬高",
    ] {
        if invariant == "不抬高" {
            assert!(method.contains("不因为后续软件有阈值而抬高分数"));
        } else {
            assert!(method.contains(invariant), "missing {invariant}");
        }
    }
    let output = r#"{"version":1,"ports":{"status":"uncertain","evidence":"参考图接口面不清楚，不能确认数量","items":[{"name":"接口面","expected":"需完整参考","observed":"部分遮挡","status":"uncertain"}]},"logo":{"status":"uncertain","confidence":0.2,"surfaceClear":false,"quad":null,"evidence":"目标区域已有字符，不可覆盖"}}"#;
    assert_eq!(
        extract_optimized_prompt(mode, &format!("```json\n{output}\n```")),
        output
    );
    let prompts = build_system_and_user_prompts(&command, &method);
    assert_eq!(prompts.system, method);
    assert!(prompts.user.contains(&command.user_prompt));
    assert!(prompts.user.contains("第一张为待检查成图"));
    assert!(prompts.user.contains("version=1"));
    assert!(
        validate_prompt_response_completeness(
            mode,
            &json!({"choices":[{"finish_reason":"length"}]})
        )
        .is_err()
    );
}

#[test]
fn product_scene_inspect_requires_actual_image_and_keeps_multimodal_order_on_all_protocols() {
    let mut command = inspection_command();
    assert!(validate_product_scene_inspection_input(&command).is_err());
    command.vision_images = ["成图", "同版本产品背面", "原版透明Logo"]
        .into_iter()
        .enumerate()
        .map(|(index, display_name)| PromptVisionImage {
            target: None,
            data_url: Some(format!("data:image/png;base64,image{index}")),
            display_name: display_name.into(),
        })
        .collect();
    assert!(validate_product_scene_inspection_input(&command).is_ok());
    let method = load_skill_context(&command).unwrap();
    let prompts = build_system_and_user_prompts(&command, &method.system_prompt);
    let images =
        ["scene-image", "reference-image", "original-logo"].map(|base64| VisionImagePayload {
            mime_type: "image/png".into(),
            base64: base64.into(),
        });
    let material = MultimodalPayload {
        display_name: "用户确认的接口规格".into(),
        kind: PromptMultimodalKind::Document,
        mime_type: "text/plain".into(),
        base64: None,
        text: Some("接口规格证据-001，不能推测隐藏接口".into()),
    };
    for (profile, path, image_key, prefix) in [
        (
            "openai_chat_v1",
            "/messages/1/content",
            "/image_url/url",
            "data:image/png;base64,",
        ),
        (
            "anthropic_messages_v1",
            "/messages/0/content",
            "/source/data",
            "",
        ),
        (
            "gemini_generate_content_v1",
            "/contents/0/parts",
            "/inline_data/data",
            "",
        ),
    ] {
        let request = build_text_model_request(
            profile,
            "project-vision-model",
            &prompts.system,
            &prompts.history,
            &prompts.user,
            &images,
            std::slice::from_ref(&material),
        )
        .unwrap();
        let content = request.body.pointer(path).unwrap().as_array().unwrap();
        for (index, marker) in ["scene-image", "reference-image", "original-logo"]
            .into_iter()
            .enumerate()
        {
            assert_eq!(
                content[index].pointer(image_key).unwrap(),
                &json!(format!("{prefix}{marker}")),
                "{profile}: image order"
            );
        }
        let serialized = request.body.to_string();
        assert!(
            serialized.contains("接口规格证据-001"),
            "{profile}: omitted document evidence"
        );
        assert!(
            serialized.contains("rowId=scene-7; attempt=2"),
            "{profile}: omitted inspection identity"
        );
        assert!(
            serialized.contains("产品场景图接口核对与 Logo 平面定位"),
            "{profile}: omitted protocol"
        );
    }
}
