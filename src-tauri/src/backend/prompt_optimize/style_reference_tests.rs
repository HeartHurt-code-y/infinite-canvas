use super::*;

#[tokio::test]
async fn internal_style_examples_reach_all_text_interfaces_without_becoming_user_assets() {
    let command = OptimizeVideoPromptCommand {
        workflow_run_id: None,
        canvas_id: Some("test-canvas".into()),
        source_node_id: Some("test-node".into()),
        provider_connection_id: "configured-provider".into(),
        model_definition_id: "configured-model".into(),
        mode: PromptOptimizationMode::GptImage2Style,
        task: PromptTask::Generate,
        user_prompt:
            "@黄色恐龙 做成 8 个表情包，2 行 4 列，黄色身体、绿色眼睛、奶油肚皮、白底、无文字。"
                .into(),
        context_history: vec![PromptOptimizationContextEntry {
            role: "当前可编辑输出".into(),
            content: "手改事实：绿色眼睛，不能改为蓝色。".into(),
        }],
        vision_images: vec![PromptVisionImage {
            target: None,
            data_url: Some("data:image/png;base64,original-user-character-image".into()),
            display_name: "黄色恐龙".into(),
        }],
        multimodal_inputs: vec![],
        reference_inputs: vec![],
    };
    let original_command = serde_json::to_value(&command).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("skills/gpt-image-2-style-library");
    let mut materials = vec![MultimodalPayload {
        display_name: "用户指定文案".into(),
        kind: PromptMultimodalKind::Document,
        mime_type: "text/plain".into(),
        base64: None,
        text: Some("用户图中文字保持为空".into()),
    }];
    let evidence = append_gpt_image_style_references(&command, &root, &mut materials)
        .await
        .unwrap();
    assert_eq!(evidence["templateId"], "character-design-sheet");
    assert_eq!(evidence["imageCount"], 2);
    assert_eq!(materials.len(), 4);
    assert_eq!(materials[0].display_name, "用户指定文案");
    assert!(
        materials[1]
            .text
            .as_ref()
            .unwrap()
            .contains("Facial expression set")
    );
    assert!(
        materials[1]
            .text
            .as_ref()
            .unwrap()
            .contains(gpt_image_style_library::REFERENCE_BOUNDARY)
    );
    assert_eq!(materials[2].kind, PromptMultimodalKind::Image);
    assert_eq!(materials[3].kind, PromptMultimodalKind::Image);
    assert_eq!(serde_json::to_value(&command).unwrap(), original_command);

    let prompts =
        build_system_and_user_prompts(&command, &load_skill_system_prompt(command.mode).unwrap());
    let user_image = VisionImagePayload {
        mime_type: "image/png".into(),
        base64: "original-user-character-image".into(),
    };
    for (profile, content_path, image_type) in [
        ("openai_chat_v1", "/messages/2/content", "image_url"),
        ("anthropic_messages_v1", "/messages/1/content", "image"),
        (
            "gemini_generate_content_v1",
            "/contents/1/parts",
            "inline_data",
        ),
    ] {
        let plan = build_text_model_request(
            profile,
            "configured-vision-model",
            &prompts.system,
            &prompts.history,
            &prompts.user,
            std::slice::from_ref(&user_image),
            &materials,
        )
        .unwrap();
        // The provider needs ordinary text + image inputs only. Local case
        // retrieval must never introduce a search/browser/file-tool contract.
        assert!(plan.body.get("tools").is_none(), "{profile}");
        assert!(plan.body.get("tool_choice").is_none(), "{profile}");
        assert!(plan.body.get("toolConfig").is_none(), "{profile}");
        let blocks = plan.body.pointer(content_path).unwrap().as_array().unwrap();
        let is_image = |value: &&Value| {
            if profile == "gemini_generate_content_v1" {
                value.get(image_type).is_some()
            } else {
                value.get("type").and_then(Value::as_str) == Some(image_type)
            }
        };
        assert_eq!(blocks.iter().filter(is_image).count(), 3, "{profile}");
        for block in blocks.iter().filter(is_image).skip(1) {
            match profile {
                "openai_chat_v1" => assert!(
                    block["image_url"]["url"]
                        .as_str()
                        .unwrap()
                        .starts_with("data:image/")
                ),
                "anthropic_messages_v1" => assert_eq!(block["source"]["type"], "base64"),
                _ => assert!(block["inline_data"]["data"].as_str().is_some()),
            }
        }
        assert!(
            blocks[0]
                .to_string()
                .contains("original-user-character-image")
        );
        assert!(blocks[1].to_string().contains("用户图中文字保持为空"));
        assert!(blocks[2].to_string().contains("内置模板参考正文"));
        assert!(blocks[2].to_string().contains("Facial expression set"));
        assert!(blocks[2].to_string().contains("不是用户的角色"));
        assert!(blocks.last().unwrap().to_string().contains("@黄色恐龙"));
        assert!(plan.body.to_string().contains("手改事实：绿色眼睛"));
        let archived = redacted_request_value(&plan.body).to_string();
        assert!(!archived.contains(materials[2].base64.as_ref().unwrap()));
    }
}
