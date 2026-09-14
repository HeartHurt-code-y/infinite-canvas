use super::*;

const ALL_MODES: &[PromptOptimizationMode] = &[
    PromptOptimizationMode::Seedance20,
    PromptOptimizationMode::Seedance25,
    PromptOptimizationMode::Wan30,
    PromptOptimizationMode::MiniMaxH3,
    PromptOptimizationMode::FpvPath,
    PromptOptimizationMode::FightPromptMaster,
    PromptOptimizationMode::MultiGridStoryboard,
    PromptOptimizationMode::StoryboardPrompt,
    PromptOptimizationMode::GptImage2Style,
    PromptOptimizationMode::RealisticCharacter,
    PromptOptimizationMode::Screenplay,
    PromptOptimizationMode::Storyboard,
    PromptOptimizationMode::KnowledgeVideoDirector,
    PromptOptimizationMode::KnowledgeVideoQc,
    PromptOptimizationMode::AiFilmRouter,
    PromptOptimizationMode::AiFilmSynopsis,
    PromptOptimizationMode::AiFilmCharacters,
    PromptOptimizationMode::AiFilmWorldbuilding,
    PromptOptimizationMode::AiFilmTreatment,
    PromptOptimizationMode::AiFilmScreenplay,
    PromptOptimizationMode::AiFilmAssets,
    PromptOptimizationMode::AiFilmActing,
    PromptOptimizationMode::AiFilmPrompts,
    PromptOptimizationMode::AiFilmQc,
    PromptOptimizationMode::ComicDramaDirector,
    PromptOptimizationMode::ComicDramaArt,
    PromptOptimizationMode::ComicDramaStoryboard,
    PromptOptimizationMode::ComicDramaDirectorReview,
    PromptOptimizationMode::ComicDramaArtReview,
    PromptOptimizationMode::ComicDramaStoryboardReview,
    PromptOptimizationMode::ComicDramaContentReview,
    PromptOptimizationMode::CommerceResearch,
    PromptOptimizationMode::CommerceCreative,
    PromptOptimizationMode::CommerceScript,
    PromptOptimizationMode::CommerceStoryboard,
    PromptOptimizationMode::CommerceAssets,
    PromptOptimizationMode::CommerceQuick,
    PromptOptimizationMode::CommerceReview,
    PromptOptimizationMode::RemotionPlanner,
    PromptOptimizationMode::RemotionReview,
    PromptOptimizationMode::XhsCoverPlan,
    PromptOptimizationMode::XhsCoverQc,
    PromptOptimizationMode::ReverseVideoAnalysis,
    PromptOptimizationMode::ReverseVideoReview,
    PromptOptimizationMode::ViralRemix,
];

fn command(mode: PromptOptimizationMode, user_prompt: &str) -> OptimizeVideoPromptCommand {
    OptimizeVideoPromptCommand {
        workflow_run_id: None,
        canvas_id: Some("skill-context-canvas".into()),
        source_node_id: Some("skill-context-node".into()),
        provider_connection_id: "configured-provider".into(),
        model_definition_id: "configured-model".into(),
        mode,
        task: PromptTask::Generate,
        user_prompt: user_prompt.into(),
        context_history: vec![],
        vision_images: vec![],
        multimodal_inputs: vec![],
        reference_inputs: vec![],
    }
}

fn selected_paths(evidence: &Value) -> Vec<&str> {
    evidence["selectedDocuments"]
        .as_array()
        .expect("selection evidence must list the actual document paths")
        .iter()
        .map(|path| path.as_str().expect("document path"))
        .collect()
}

fn system_path(profile: &str) -> &'static str {
    match profile {
        "anthropic_messages_v1" => "/system",
        "gemini_generate_content_v1" => "/systemInstruction/parts/0/text",
        _ => "/messages/0/content",
    }
}

#[test]
fn selected_skill_bodies_reach_all_protocols_without_changing_conversation_or_media() {
    let mut command = command(
        PromptOptimizationMode::StoryboardPrompt,
        "为真实产品制作广告故事板。@白色杯子 保留四栏，只把最后一格改为露营收尾。",
    );
    command.task = PromptTask::Optimize;
    command.context_history = vec![
        PromptOptimizationContextEntry {
            role: "user".into(),
            content: "已确认事实-001：杯身白色，标题必须原样为「早起一杯」。".into(),
        },
        PromptOptimizationContextEntry {
            role: "assistant".into(),
            content: "历史完整稿-002：第一格厨房，第二格咖啡，第三格桌面，第四格办公。".into(),
        },
        PromptOptimizationContextEntry {
            role: "user".into(),
            content: "已确认决定-003：保持杯盖绿色，不要根据示例换成其他颜色。".into(),
        },
        PromptOptimizationContextEntry {
            role: "当前可编辑输出".into(),
            content: "当前手改稿-004：@白色杯子，杯盖墨绿色，第二格保留手写标签 A-27。".into(),
        },
    ];
    command.vision_images.push(PromptVisionImage {
        target: None,
        data_url: Some("data:image/png;base64,dXNlci1jdXA=".into()),
        display_name: "白色杯子".into(),
    });
    command.reference_inputs.push(PromptReferenceInput {
        target: MediaReferenceTarget::LocalResult {
            generation_task_id: "stable-user-cup-task".into(),
            result_index: 2,
            media_type: MediaType::Image,
            canvas_node_key: Some("stable-user-cup-instance".into()),
        },
        display_name: "白色杯子侧面".into(),
    });
    let original_command = serde_json::to_value(&command).unwrap();
    let original_skill = load_skill_system_prompt(command.mode).unwrap();
    let loaded = load_skill_context(&command).unwrap();
    let selected_template =
        include_str!("../../../skills/storyboard-prompt/references/故事板提示词（广告）.md");
    assert!(loaded.system_prompt.contains(selected_template.trim()));
    assert!(loaded.system_prompt.len() < original_skill.len());
    assert!(loaded.system_prompt.contains("# 交付提醒"));
    assert!(loaded.system_prompt.contains("完整图片提示词"));
    assert!(
        !selected_paths(&loaded.evidence)
            .iter()
            .any(|path| path.contains("修仙") || path.contains("MV 音乐"))
    );

    let selected = build_system_and_user_prompts(&command, &loaded.system_prompt);
    let original = build_system_and_user_prompts(&command, &original_skill);
    assert_eq!(selected.history, original.history);
    assert_eq!(selected.user, original.user);
    // Media resolution happens before request construction. These are the
    // same user payloads passed to both versions, with no skill tool protocol.
    let images = [VisionImagePayload {
        mime_type: "image/png".into(),
        base64: "dXNlci1jdXA=".into(),
    }];
    let materials = [MultimodalPayload {
        display_name: "用户已确认产品资料".into(),
        kind: PromptMultimodalKind::Document,
        mime_type: "text/plain".into(),
        base64: None,
        text: Some("素材事实-005：容量 350ml，禁止示例产品覆盖。".into()),
    }];
    for profile in [
        "openai_chat_v1",
        "anthropic_messages_v1",
        "gemini_generate_content_v1",
    ] {
        let build = |prompts: &PromptConversation| {
            build_text_model_request(
                profile,
                "configured-vision-model",
                &prompts.system,
                &prompts.history,
                &prompts.user,
                &images,
                &materials,
            )
            .unwrap()
        };
        let selected_request = build(&selected);
        let original_request = build(&original);
        let path = system_path(profile);
        let actual_system = selected_request
            .body
            .pointer(path)
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(actual_system, loaded.system_prompt, "{profile}");
        assert!(
            actual_system.contains(selected_template.trim()),
            "{profile}"
        );
        assert_eq!(
            actual_system.matches(selected_template.trim()).count(),
            1,
            "{profile}"
        );
        let mut normalized = selected_request.body.clone();
        *normalized.pointer_mut(path).unwrap() = Value::String(original.system.clone());
        assert_eq!(
            normalized, original_request.body,
            "{profile}: only skill context changes"
        );
        for forbidden in ["tools", "tool_choice", "toolConfig"] {
            assert!(
                selected_request.body.get(forbidden).is_none(),
                "{profile}: {forbidden}"
            );
        }
        let serialized = selected_request.body.to_string();
        for marker in [
            "已确认事实-001",
            "历史完整稿-002",
            "已确认决定-003",
            "当前手改稿-004",
            "素材事实-005",
            "dXNlci1jdXA=",
            "@白色杯子",
            "A-27",
        ] {
            assert!(serialized.contains(marker), "{profile}: missing {marker}");
        }
        assert_eq!(selected_request.path, original_request.path);
        assert_eq!(selected_request.query, original_request.query);
        assert_eq!(selected_request.headers, original_request.headers);
        let mut selected_fallback = selected_request.fallback.unwrap().body;
        *selected_fallback.pointer_mut(path).unwrap() = Value::String(original.system.clone());
        assert_eq!(
            selected_fallback,
            original_request.fallback.unwrap().body,
            "{profile}: fallback"
        );
    }
    assert_eq!(serde_json::to_value(&command).unwrap(), original_command);
}

#[test]
fn changing_subject_reselects_documents_and_preserves_the_original_request_when_revisited() {
    let ad_command = command(
        PromptOptimizationMode::StoryboardPrompt,
        "为真实产品制作广告故事板",
    );
    let ad = load_skill_context(&ad_command).unwrap();
    assert!(selected_paths(&ad.evidence).contains(&"references/故事板提示词（广告）.md"));

    let mut fantasy_command = command(
        PromptOptimizationMode::StoryboardPrompt,
        "本轮改为制作修仙国漫影视视觉开发板",
    );
    fantasy_command.context_history = vec![
        PromptOptimizationContextEntry {
            role: "第 1 条 · 你".into(),
            content: ad_command.user_prompt.clone(),
        },
        PromptOptimizationContextEntry {
            role: "第 2 条 · 提示词助手".into(),
            content: "上一轮广告故事板：四栏产品广告，品牌宣传，杯子商业广告。".into(),
        },
        PromptOptimizationContextEntry {
            role: "当前输出提示词".into(),
            content: "当前产品广告故事板：四栏产品广告，杯子商品，品牌宣传。".into(),
        },
    ];
    let fantasy = load_skill_context(&fantasy_command).unwrap();
    let fantasy_paths = selected_paths(&fantasy.evidence);
    assert!(fantasy_paths.contains(&"references/修仙国漫影视视觉开发板.md"));
    assert!(!fantasy_paths.contains(&"references/故事板提示词（广告）.md"));
    assert!(
        fantasy.system_prompt.contains(
            include_str!("../../../skills/storyboard-prompt/references/修仙国漫影视视觉开发板.md")
                .trim()
        )
    );
    assert_ne!(ad.system_prompt, fantasy.system_prompt);

    let ad_again = load_skill_context(&ad_command).unwrap();
    assert_eq!(ad_again.system_prompt, ad.system_prompt);
    assert_eq!(ad_again.evidence, ad.evidence);
}

#[test]
fn all_modes_keep_core_and_output_contracts_and_report_actual_byte_counts() {
    assert_eq!(ALL_MODES.len(), 45);
    for mode in ALL_MODES {
        let command = command(*mode, "继续处理当前请求，保留已确认决定和当前输出格式。");
        let before = serde_json::to_value(&command).unwrap();
        let baseline = load_skill_system_prompt(*mode).unwrap();
        let source = if *mode == PromptOptimizationMode::Storyboard {
            split_storyboard_bundle(&baseline)
        } else {
            baseline
        };
        let loaded = load_skill_context(&command).unwrap();
        assert!(!loaded.system_prompt.trim().is_empty(), "{mode:?}");
        assert_eq!(loaded.evidence["version"], "skill-context.v1", "{mode:?}");
        assert_eq!(loaded.evidence["originalBytes"], source.len(), "{mode:?}");
        assert_eq!(
            loaded.evidence["selectedBytes"],
            loaded.system_prompt.len(),
            "{mode:?}"
        );
        let paths = selected_paths(&loaded.evidence);
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(
            unique.len(),
            paths.len(),
            "{mode:?}: duplicate source documents"
        );
        // Every complete SKILL.md remains available. This checks real source
        // text, including its output rules, rather than a title-only catalog.
        for section in source.split("---\n# 技能文档：").skip(1) {
            let (path, body) = section.split_once('\n').unwrap();
            if path.trim().ends_with("SKILL.md") {
                let core = body.split("\n\n---\n# 交付提醒").next().unwrap().trim();
                assert!(
                    loaded.system_prompt.contains(core),
                    "{mode:?}: dropped core {path}"
                );
                assert_eq!(
                    loaded.system_prompt.matches(core).count(),
                    1,
                    "{mode:?}: repeated core {path}"
                );
            }
        }
        if source.matches("# 技能文档：").count() == 0 {
            // Existing single-stage contracts are already purpose-scoped.
            assert!(
                loaded.system_prompt.contains(&source),
                "{mode:?}: changed stage contract"
            );
        }
        if let Some((_, reminder)) = source.rsplit_once("\n\n---\n# 交付提醒") {
            assert!(
                loaded.system_prompt.contains(reminder.trim()),
                "{mode:?}: lost delivery reminder"
            );
        }
        let prompts = build_system_and_user_prompts(&command, &loaded.system_prompt);
        assert_eq!(prompts.system, loaded.system_prompt, "{mode:?}");
        assert!(
            prompts.history.is_empty(),
            "{mode:?}: skill catalog added fake history"
        );
        assert!(
            !prompts.system.contains(&command.user_prompt),
            "{mode:?}: duplicated user context"
        );
        assert!(prompts.user.contains(&command.user_prompt), "{mode:?}");
        assert_eq!(serde_json::to_value(&command).unwrap(), before, "{mode:?}");
    }
}

#[test]
fn industrial_storyboard_loads_selected_reference_bodies_from_the_standalone_source() {
    let command = command(
        PromptOptimizationMode::Storyboard,
        "把这段对白剧本转为工业级分镜，保留表演指导、场景调度宪法和 Seedance 2.5 双版提示词。",
    );
    let loaded = load_skill_context(&command).unwrap();
    let standalone = include_str!(
        "../../../skills/storyboard/viral-video-prompt-engine/viral-video-prompt-engine-standalone.md"
    );
    let source_references: Vec<_> = standalone.split("=== REFERENCE: ").skip(1).collect();
    assert_eq!(source_references.len(), 17);
    let paths = selected_paths(&loaded.evidence);
    assert!(paths.contains(&"SKILL.md"));
    let mut verified_reference_count = 0;
    for reference in source_references {
        let (path, body) = reference.split_once(" ===").unwrap();
        if paths.contains(&path) {
            assert!(
                loaded.system_prompt.contains(body.trim()),
                "selected standalone body changed: {path}"
            );
            verified_reference_count += 1;
        }
    }
    assert!(
        verified_reference_count > 0,
        "industrial storyboard needs its production references"
    );
    for contract in [
        "【宪法要点】",
        "【本段微调】",
        "【表演指导】",
        "Seedance 2.5 双版提示词",
        "质量门禁",
    ] {
        assert!(
            loaded.system_prompt.contains(contract),
            "lost industrial output contract: {contract}"
        );
    }
    assert!(loaded.system_prompt.len() < load_skill_system_prompt(command.mode).unwrap().len());
    assert!(!loaded.system_prompt.contains("=== REFERENCE:"));
}

#[test]
fn a_scoped_industrial_revision_does_not_reload_every_craft_mentioned_in_the_draft() {
    let mut request = command(
        PromptOptimizationMode::Storyboard,
        "只调整第2段灯光，保持人物、台词、机位和时长原样。",
    );
    request.context_history.push(PromptOptimizationContextEntry {
        role: "当前工业级分镜脚本".into(),
        content: "# 雨夜\n## 资产设定\n人物、场景、道具和参考索引\n## 逐段分镜\n场景调度宪法、表演指导、机位、声音与光影\n## SD02\n0-5s：人物林青回头，台词「回家吧」，35mm 固定机位。".into(),
    });
    let loaded = load_skill_context(&request).unwrap();
    let paths = selected_paths(&loaded.evidence);
    assert!(paths.contains(&"references/04-motion-prompt.md"));
    assert!(paths.contains(&"references/12-film-review.md"));
    assert!(paths.contains(&"references/10-craft-lighting.md"));
    let conversation = build_system_and_user_prompts(&request, &loaded.system_prompt);
    assert!(
        conversation.history[0]["content"]
            .as_str()
            .unwrap()
            .contains(&request.context_history[0].content)
    );
    // The draft's mere mention of an asset inventory must not re-open the entire
    // asset-design method during a local lighting change. Explicit current requests
    // still select their own complete reference bodies, and core output rules stay.
    assert!(!paths.contains(&"references/03-asset-design.md"));
    assert!(!paths.contains(&"references/11-craft-sound.md"));
    assert!(
        loaded.system_prompt.len() * 4
            < loaded.evidence["originalBytes"].as_u64().unwrap() as usize * 3
    );
}

#[test]
fn changed_standalone_reference_boundaries_keep_the_whole_source_as_core() {
    let baseline = load_skill_system_prompt(PromptOptimizationMode::Storyboard).unwrap();
    let boundary = "=== REFERENCE: references/08-craft-camera.md ===";
    assert!(baseline.contains(boundary));
    for replacement in [
        "新增来源规则-边界缺失：摄影机规则必须原样保留。",
        "=== REFERENCE: references/18-craft-camera.md ===\n新增来源规则-编号变化：摄影机规则必须原样保留。",
    ] {
        let changed = baseline.replacen(boundary, replacement, 1);
        let split = split_storyboard_bundle(&changed);
        assert_eq!(split.matches("# 技能文档：").count(), 1);
        assert_eq!(
            split,
            changed.replacen(
                "# 技能文档：viral-video-prompt-engine-standalone.md",
                "# 技能文档：SKILL.md",
                1,
            ),
            "an unrecognized source layout must not be partially split"
        );
        let command = command(PromptOptimizationMode::Storyboard, "把对白转为工业级分镜");
        let loaded = skill_context::select_skill_context(&command, &split);
        let (_, complete_core) = split.split_once("# 技能文档：SKILL.md").unwrap();
        assert!(loaded.system_prompt.contains(complete_core.trim()));
        assert!(loaded.system_prompt.contains(replacement));
        assert!(selected_paths(&loaded.evidence).contains(&"SKILL.md"));
    }
}

#[test]
fn actual_frontend_draft_roles_and_user_decisions_keep_the_selected_engine() {
    // WorkspaceApp sends these display labels verbatim through promptNodeClient.
    // Only recognizing synthetic `user` / `current_output` roles loses real edits.
    for role in [
        "当前输出提示词",
        "第 3 条 · 决定",
        "第 1 条 · 你",
        "已连接的上游文本 · 已确认打斗方案",
    ] {
        let mut command = command(
            PromptOptimizationMode::FightPromptMaster,
            "把镜头改成俯拍，并加强光影，保持已确认的模型。",
        );
        command.task = PromptTask::Optimize;
        command.context_history = vec![
            PromptOptimizationContextEntry {
                role: role.into(),
                content: "已确认使用 H3，双人打斗，保留已写好的动作和参考图顺序。".into(),
            },
            PromptOptimizationContextEntry {
                role: "第 4 条 · 提示词助手".into(),
                content: "历史示例里可能提及 Seedance 2.5，不代表用户选择。".into(),
            },
        ];
        let loaded = load_skill_context(&command).unwrap();
        let paths = selected_paths(&loaded.evidence);
        assert!(
            paths.iter().any(|path| path.ends_with("engine-h3.md")),
            "{role}"
        );
        assert!(
            !paths
                .iter()
                .any(|path| path.ends_with("engine-seedance25.md")),
            "{role}"
        );
        let prompts = build_system_and_user_prompts(&command, &loaded.system_prompt);
        let history = serde_json::to_string(&prompts.history).unwrap();
        assert!(history.contains("保留已写好的动作和参考图顺序"), "{role}");
    }
}

#[test]
fn continuing_a_real_screenplay_draft_retains_the_long_series_method() {
    let mut command = command(
        PromptOptimizationMode::Screenplay,
        "继续第12集剧本，增强对白张力。",
    );
    command.context_history = vec![
        PromptOptimizationContextEntry {
            role: "第 1 条 · 你".into(),
            content: "已确认这是80集长篇连续剧，全部角色和伏笔按已确认的分集大纲延续。".into(),
        },
        PromptOptimizationContextEntry {
            role: "当前剧本文档".into(),
            content: "# 80集长篇连续剧\n第11集剧本：女主发现钥匙，身份真相要留到第40集。".into(),
        },
    ];
    let before = serde_json::to_value(&command).unwrap();
    let loaded = load_skill_context(&command).unwrap();
    let paths = selected_paths(&loaded.evidence);
    for required in [
        "long-series-guide.md",
        "episode-outline-template.md",
        "episode-script-template.md",
    ] {
        assert!(
            paths.iter().any(|path| path.ends_with(required)),
            "missing {required}"
        );
    }
    let prompts = build_system_and_user_prompts(&command, &loaded.system_prompt);
    assert!(
        serde_json::to_string(&prompts.history)
            .unwrap()
            .contains("身份真相要留到第40集")
    );
    assert_eq!(serde_json::to_value(&command).unwrap(), before);
}

#[test]
fn fight_engine_versions_and_negated_choices_do_not_select_conflicting_instructions() {
    for (prompt, expected) in [
        ("使用 Seedance 2.5 生成打斗提示词", "engine-seedance25.md"),
        ("使用 sd2.5 生成打斗提示词", "engine-seedance25.md"),
        (
            "不要使用 H3，改用 Seedance 2.5 生成打斗提示词",
            "engine-seedance25.md",
        ),
        ("使用 Seedance 2.0 生成打斗提示词", "engine-seedance2.md"),
    ] {
        let command = command(PromptOptimizationMode::FightPromptMaster, prompt);
        let loaded = load_skill_context(&command).unwrap();
        let engines: Vec<_> = selected_paths(&loaded.evidence)
            .into_iter()
            .filter(|path| path.rsplit('/').next().unwrap().starts_with("engine-"))
            .collect();
        assert_eq!(engines.len(), 1, "{prompt}: {engines:?}");
        assert!(engines[0].ends_with(expected), "{prompt}: {engines:?}");
    }
}

#[test]
fn seedance_transformation_and_one_against_many_load_the_skill_declared_action_workflow() {
    let command = command(
        PromptOptimizationMode::Seedance25,
        "镜头跟拍，角色变身之后一打多，连击节奏清晰。",
    );
    let loaded = load_skill_context(&command).unwrap();
    let paths = selected_paths(&loaded.evidence);
    // These triggers are declared by SKILL.md itself, and must still work when
    // a second dimension such as camera movement already matched another route.
    for required in [
        "references/12-fight-combat.md",
        "references/13-fight-clusters.md",
        "references/06-camera-and-emotion.md",
    ] {
        assert!(paths.contains(&required), "missing {required}");
    }
    assert!(loaded.system_prompt.contains(
        include_str!("../../../skills/seedance-2.5-prompt/references/12-fight-combat.md").trim()
    ));
}
