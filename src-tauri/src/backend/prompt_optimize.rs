//! 提示词生成、优化与审计：将 Seedance 2.0 / 2.5、万相 3.0、MiniMax H3 与人物真实感图片
//! 提示词工程技能整体注入为文本大模型的系统提示词，调用供应商的 OpenAI 兼容
//! `/v1/chat/completions` 接口完成文本处理。
//!
//! 八种模式：
//! - Seedance 2.0：注入 `byted-ark-seedance-pe` 技能（输出含问题分析 + 代码围栏提示词，需提取围栏内容）。
//! - Seedance 2.5：注入 `seedance-2.5-prompt` 技能（按输出合同默认只输出提示词正文）。
//! - 万相 3.0：注入 `wan3-prompt-skill` 技能（输出合同为一个 text 围栏内的四段式提示词正文）。
//! - MiniMax H3：注入 `minimax-h3-prompt` 技能（输出为官方三字段英文提示词，部分模式带固定首行）。
//! - 人物真实感图片：注入 `realistic-character-prompt` 技能（输出真实感人物图片提示词，可能附设计逻辑说明）。
//! - 剧本创作：注入随应用编译的 `screenplay-master` + `screenwriter-zh` 双技能全文，
//!   支持完整多轮上下文、剧本审计与 Markdown 正文输出。
//! - 工业级分镜：注入随应用编译的 `viral-video-prompt-engine` V4.6 独立完整版，
//!   支持剧本转分镜、多轮上下文、分镜审计与 Markdown 正文输出。
//! - 爆款视频复刻：注入 `douyin-reverse-prompt` V1.1 的纯复刻适配版；视频由前端
//!   密集抽帧并合成带时间码联系表，后端只负责视觉分析，不包含任何下载能力。
//!
//! 多轮上下文：只要本轮携带了历史上下文（提示词节点的多轮对话、历次结果、审计输入与
//! 用户决定），就追加到系统提示词，使生成、优化与审计每一轮都沿用之前的完整对话。
//! 细节优化（detail_review）：用户提示词固定为「严格审查当前提示词是否符合技能规范的最优版本」。
//!
//! 视觉理解：连入提示词节点的图片素材会先取回字节（云端素材经素材库接口、本地素材经
//! 对象存储重签地址），再以 Base64 Data URL 图片内容块注入用户消息，供视觉模型看图
//! 生成或优化提示词。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter as _};
use tauri_plugin_log::log::{info, warn};
use uuid::Uuid;

use super::{
    ProviderRuntime,
    asset_library::{
        AssetDelivery, AssetLibrary, AssetReadTrace, ResolveAsset, ResolvedAssetAccess,
    },
    error::{BackendError, BackendResult},
    local_results::LocalResultService,
    model_schema::{provider_scoped_model_definition_id, text_request_profile},
    provider::{CapturedHttpResponse, parse_token_usage},
    staging::StagingService,
    storage::{
        GenerationLifecycleFact, GenerationTaskLifecycle, NewTask, PersistedTaskTransitionEvent,
        Storage, TaskExecutionRecord,
    },
    types::{
        CloudAssetIdentity, GenerationOperation, GenerationTaskStatus, MediaReferenceTarget,
        MediaType, SaveStatus,
    },
};

/// Seedance 2.0 提示词优化技能目录（byted-ark-seedance-pe）。
pub const SEEDANCE_20_SKILL_DIR: &str =
    r"C:\Users\bp180\Desktop\byted-ark-seedance-pe(4)\byted-ark-seedance-pe";
/// Seedance 2.5 提示词生成与优化技能目录（seedance-2.5-prompt）。
pub const SEEDANCE_25_SKILL_DIR: &str = r"C:\Users\bp180\Desktop\seedance-2.5-prompt";
/// 万相 3.0 提示词生成与优化技能目录（wan3-prompt-skill，含嵌套技能根目录）。
pub const WAN30_SKILL_DIR: &str = r"C:\Users\bp180\Desktop\wan3-prompt-skill\wan3-prompt-skill";
/// MiniMax H3 提示词生成与优化技能目录（minimax-h3-prompt）。
pub const MINIMAX_H3_SKILL_DIR: &str =
    r"C:\Users\bp180\Desktop\创作提示词skill\创作提示词skill\minimax-h3-prompt";
/// 人物真实感图片提示词生成技能目录（realistic-character-prompt）。
pub const REALISTIC_CHARACTER_SKILL_DIR: &str =
    r"C:\Users\bp180\Desktop\realistic-character-prompt";

const DETAIL_REVIEW_USER_PROMPT: &str = "严格审查当前提示词是否符合技能规范的最优版本";
const AUDIT_USER_PROMPT: &str = "严格审查这个Phase 是否已经是最优版本";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptOptimizationMode {
    // 前端契约使用带下划线的模式名（"seedance_2_0" / "wan_3_0" / "minimax_h3" 等）；旧别名兜底。
    #[serde(rename = "seedance_2_0", alias = "seedance20")]
    Seedance20,
    #[serde(rename = "seedance_2_5", alias = "seedance25")]
    Seedance25,
    #[serde(rename = "wan_3_0", alias = "wan30")]
    Wan30,
    #[serde(rename = "minimax_h3", alias = "minimaxh3")]
    MiniMaxH3,
    #[serde(rename = "realistic_character", alias = "realisticcharacter")]
    RealisticCharacter,
    #[serde(rename = "screenplay", alias = "screenwriter")]
    Screenplay,
    #[serde(rename = "storyboard", alias = "shot_script")]
    Storyboard,
    #[serde(rename = "viral_remix", alias = "video_remix")]
    ViralRemix,
}

/// 提示词节点的执行意图。视频节点的旧调用不携带该字段，默认按优化处理，
/// 这样可以在不破坏已有画布与调用方的前提下复用同一条文本模型 API 通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PromptTask {
    Generate,
    #[default]
    Optimize,
    Audit,
}

impl PromptOptimizationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seedance20 => "seedance_2_0",
            Self::Seedance25 => "seedance_2_5",
            Self::Wan30 => "wan_3_0",
            Self::MiniMaxH3 => "minimax_h3",
            Self::RealisticCharacter => "realistic_character",
            Self::Screenplay => "screenplay",
            Self::Storyboard => "storyboard",
            Self::ViralRemix => "viral_remix",
        }
    }

    fn skill_dir(self) -> &'static str {
        match self {
            Self::Seedance20 => SEEDANCE_20_SKILL_DIR,
            Self::Seedance25 => SEEDANCE_25_SKILL_DIR,
            Self::Wan30 => WAN30_SKILL_DIR,
            Self::MiniMaxH3 => MINIMAX_H3_SKILL_DIR,
            Self::RealisticCharacter => REALISTIC_CHARACTER_SKILL_DIR,
            // 剧本双技能使用 include_str! 编译进应用，不依赖用户电脑上的外部路径。
            Self::Screenplay => "builtin://screenplay-dual-skill",
            // 工业级分镜技能同样随应用编译，原始分享包无需留在桌面。
            Self::Storyboard => "builtin://viral-video-prompt-engine-v4.6",
            // 复刻技能是从 douyin-reverse-prompt V1.1 裁剪出的纯视觉分析版本。
            Self::ViralRemix => "builtin://douyin-reverse-prompt-v1.1-remix-only",
        }
    }
}

/// 细节优化或提示词审计时注入系统提示词的单条历史上下文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOptimizationContextEntry {
    pub role: String,
    pub content: String,
}

/// 供视觉理解的图片：普通提示词节点使用媒体引用；爆款视频复刻节点传入浏览器从
/// 本地视频生成的带时间码联系表 Data URL。两种来源互斥，后端统一校验图片签名。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVisionImage {
    #[serde(default)]
    pub target: Option<MediaReferenceTarget>,
    #[serde(default)]
    pub data_url: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptMultimodalKind {
    Image,
    Audio,
    Video,
    Document,
}

/// 剧本节点直接选择的本地参考素材。路径只在桌面端后端读取；每次请求都会重新
/// 校验扩展名、声明 MIME、文件签名与体积，避免把大文件编码进画布存档。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMultimodalInput {
    pub local_path: String,
    pub display_name: String,
    pub kind: PromptMultimodalKind,
    pub mime_type: String,
}

/// 解析视觉素材所需的后端服务（与生成任务共享同一套素材读取链路）。
pub struct PromptVisionDeps<'a> {
    pub app: &'a AppHandle,
    pub storage: &'a Storage,
    pub lifecycle: &'a GenerationTaskLifecycle,
    pub providers: &'a ProviderRuntime,
    pub assets: &'a AssetLibrary,
    pub staging: &'a StagingService,
    pub local_results: &'a LocalResultService,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeVideoPromptCommand {
    /// 任务历史归属；旧调用方省略时使用稳定兼容标识，仍会记录本次文本调用。
    #[serde(default)]
    pub canvas_id: Option<String>,
    #[serde(default)]
    pub source_node_id: Option<String>,
    pub provider_connection_id: String,
    pub model_definition_id: String,
    pub mode: PromptOptimizationMode,
    /// 提示词节点可选择“生成”“优化”或“审计”；省略时兼容旧版视频节点，按优化处理。
    #[serde(default)]
    pub task: PromptTask,
    /// 当前提示词输入框中的纯文本（@引用已内联为 @显示名）。
    pub user_prompt: String,
    /// 细节优化/审计时注入的全部历史上下文；普通生成或优化为空。
    #[serde(default)]
    pub context_history: Vec<PromptOptimizationContextEntry>,
    /// true = 细节优化或审计，要求把历史上下文并入系统提示词。
    #[serde(default)]
    pub detail_review: bool,
    /// 连入提示词节点的图片素材（按连线顺序）；省略时按纯文本调用，兼容旧调用方。
    #[serde(default)]
    pub vision_images: Vec<PromptVisionImage>,
    /// 剧本节点直接选择的本地图片、音频、视频或文档素材。
    #[serde(default)]
    pub multimodal_inputs: Vec<PromptMultimodalInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizedPromptResult {
    /// 仅包含优化后的提示词正文（已剥离问题分析 / 优化说明 / 围栏等无关部分）。
    pub optimized_prompt: String,
    /// 文本模型原始输出，便于排查提取是否正确。
    pub raw_model_output: String,
}

/// 递归收集技能目录下的全部 Markdown 文件：SKILL.md 在最前，其余按相对路径排序。
fn collect_skill_markdown_files(root: &Path) -> BackendResult<Vec<PathBuf>> {
    let skill_file = root.join("SKILL.md");
    if !skill_file.is_file() {
        return Err(BackendError::NotFound(format!(
            "skill directory is missing SKILL.md: {}",
            root.display()
        )));
    }
    let mut files = vec![skill_file];

    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut children: Vec<_> = entries.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
                out.push(path);
            }
        }
    }

    let mut rest = Vec::new();
    walk(root, &mut rest);
    files.extend(
        rest.into_iter()
            .filter(|path| path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md")),
    );
    Ok(files)
}

/// 把整个技能（全部 Markdown 文档）拼装为系统提示词，每份文档带文件路径标题。
pub fn load_skill_system_prompt(mode: PromptOptimizationMode) -> BackendResult<String> {
    if mode == PromptOptimizationMode::Screenplay {
        return Ok(load_builtin_screenplay_system_prompt());
    }
    if mode == PromptOptimizationMode::Storyboard {
        return Ok(load_builtin_storyboard_system_prompt());
    }
    if mode == PromptOptimizationMode::ViralRemix {
        return Ok(load_builtin_viral_remix_system_prompt());
    }
    let root = Path::new(mode.skill_dir());
    let files = collect_skill_markdown_files(root)?;
    let mut sections = Vec::with_capacity(files.len() + 1);
    sections.push(format!(
        "以下是完整的提示词工程技能（目录 {}），你必须严格按照技能中的规范执行任务。",
        root.display()
    ));
    let mut total_bytes = 0usize;
    for file in &files {
        let content = std::fs::read_to_string(file)?;
        total_bytes += content.len();
        let relative = file
            .strip_prefix(root)
            .map(|value| value.display().to_string())
            .unwrap_or_else(|_| file.display().to_string());
        sections.push(format!("---\n# 技能文档：{relative}\n\n{content}"));
    }
    info!(
        "[generation] 提示词优化技能加载完成: mode={}, 文件数={}, 总字节数={}",
        mode.as_str(),
        files.len(),
        total_bytes
    );
    Ok(sections.join("\n\n"))
}

/// 分享包中的文本资源在编译期嵌入二进制。这样开发目录被移动、应用被打包，或原始 zip
/// 不再位于桌面时，每一轮剧本对话仍能完整注入同一份双技能上下文。
fn load_builtin_screenplay_system_prompt() -> String {
    const DOCUMENTS: &[(&str, &str)] = &[
        (
            "screenplay-master/SKILL.md",
            include_str!("../../skills/screenplay/screenplay-master/SKILL.md"),
        ),
        (
            "screenplay-master/assets/beat-sheet-template.md",
            include_str!("../../skills/screenplay/screenplay-master/assets/beat-sheet-template.md"),
        ),
        (
            "screenplay-master/assets/character-card-template.json",
            include_str!(
                "../../skills/screenplay/screenplay-master/assets/character-card-template.json"
            ),
        ),
        (
            "screenplay-master/assets/episode-outline-template.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/assets/episode-outline-template.md"
            ),
        ),
        (
            "screenplay-master/assets/episode-script-template.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/assets/episode-script-template.md"
            ),
        ),
        (
            "screenplay-master/references/character-engineering.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/character-engineering.md"
            ),
        ),
        (
            "screenplay-master/references/format-specification.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/format-specification.md"
            ),
        ),
        (
            "screenplay-master/references/hook-payment-card.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/hook-payment-card.md"
            ),
        ),
        (
            "screenplay-master/references/industry-data.md",
            include_str!("../../skills/screenplay/screenplay-master/references/industry-data.md"),
        ),
        (
            "screenplay-master/references/long-series-guide.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/long-series-guide.md"
            ),
        ),
        (
            "screenplay-master/references/platform-differences.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/platform-differences.md"
            ),
        ),
        (
            "screenplay-master/references/quality-gates.md",
            include_str!("../../skills/screenplay/screenplay-master/references/quality-gates.md"),
        ),
        (
            "screenplay-master/references/short-format-guide.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/short-format-guide.md"
            ),
        ),
        (
            "screenplay-master/references/vertical-scene-dialogue.md",
            include_str!(
                "../../skills/screenplay/screenplay-master/references/vertical-scene-dialogue.md"
            ),
        ),
        (
            "screenplay-master/references/vfx-fight-scene.md",
            include_str!("../../skills/screenplay/screenplay-master/references/vfx-fight-scene.md"),
        ),
        (
            "screenplay-master/scripts/validate-script.py",
            include_str!("../../skills/screenplay/screenplay-master/scripts/validate-script.py"),
        ),
        (
            "screenwriter-zh/SKILL.md",
            include_str!("../../skills/screenplay/screenwriter-zh/SKILL.md"),
        ),
        (
            "screenwriter-zh/README.md",
            include_str!("../../skills/screenplay/screenwriter-zh/README.md"),
        ),
        (
            "screenwriter-zh/methodology.md",
            include_str!("../../skills/screenplay/screenwriter-zh/methodology.md"),
        ),
        (
            "screenwriter-zh/style-rules.md",
            include_str!("../../skills/screenplay/screenwriter-zh/style-rules.md"),
        ),
        (
            "screenwriter-zh/timing-and-cutting.md",
            include_str!("../../skills/screenplay/screenwriter-zh/timing-and-cutting.md"),
        ),
        (
            "screenwriter-zh/workflow.md",
            include_str!("../../skills/screenplay/screenwriter-zh/workflow.md"),
        ),
        (
            "screenwriter-zh/templates/characters.template.md",
            include_str!(
                "../../skills/screenplay/screenwriter-zh/templates/characters.template.md"
            ),
        ),
        (
            "screenwriter-zh/templates/synopsis.template.md",
            include_str!("../../skills/screenplay/screenwriter-zh/templates/synopsis.template.md"),
        ),
        (
            "screenwriter-zh/templates/treatment.template.md",
            include_str!("../../skills/screenplay/screenwriter-zh/templates/treatment.template.md"),
        ),
        (
            "screenwriter-zh/templates/worldbuilding.template.md",
            include_str!(
                "../../skills/screenplay/screenwriter-zh/templates/worldbuilding.template.md"
            ),
        ),
        (
            "screenwriter-zh/tools/build_bilingual.js",
            include_str!("../../skills/screenplay/screenwriter-zh/tools/build_bilingual.js"),
        ),
        (
            "screenwriter-zh/tools/build_screenplay.js",
            include_str!("../../skills/screenplay/screenwriter-zh/tools/build_screenplay.js"),
        ),
        (
            "screenwriter-zh/tools/build_treatment.js",
            include_str!("../../skills/screenplay/screenwriter-zh/tools/build_treatment.js"),
        ),
    ];
    let mut sections = Vec::with_capacity(DOCUMENTS.len() + 1);
    sections.push(
        "你是画布中的「剧本创作与优化」节点。以下是内置的 screenplay-master 与 screenwriter-zh 双技能完整文本。每一轮都必须重新依据全部技能与随后提供的完整对话历史工作。根据用户项目自动选择短剧或长片/电视剧方法；规则冲突时，以用户当前明确要求为最高优先级，并保持精准修改。所有可交付剧本使用结构清晰、可直接导出的 Markdown；不要声称调用了当前请求中不可用的本地脚本。"
            .to_string(),
    );
    let mut total_bytes = 0usize;
    for (path, content) in DOCUMENTS {
        total_bytes += content.len();
        sections.push(format!("---\n# 技能文档：{path}\n\n{content}"));
    }
    info!(
        "[generation] 内置剧本双技能加载完成: 文件数={}, 总字节数={}",
        DOCUMENTS.len(),
        total_bytes
    );
    sections.join("\n\n")
}

/// V4.6 分享包提供的 standalone 文档已经把 SKILL.md 与全部 16 份 references 合并为
/// 单一真相源。直接在编译期嵌入该文件，既避免运行时依赖桌面 zip，也避免重复注入
/// standalone 与拆分文档造成上下文翻倍。
fn load_builtin_storyboard_system_prompt() -> String {
    const SKILL: &str = include_str!(
        "../../skills/storyboard/viral-video-prompt-engine/viral-video-prompt-engine-standalone.md"
    );
    let header = "你是画布中的「剧本转工业级分镜脚本」节点。以下是内置的 viral-video-prompt-engine V4.6 完整独立版（SKILL.md + 全部 16 份 references）。每一轮都必须重新依据完整技能、随后提供的全部对话/审计历史，以及当前 Markdown 分镜脚本工作。\n\n本节点运行合同高于技能包中依赖外部 Agent、文件夹或 TXT 文件的操作说明：用户提供的是待转化或待迭代的剧本，应直接聚焦阶段03工业级视频分镜；需要补充资产、画幅、平台或时长时，可以在对话中明确询问，但不得声称已经创建子 Agent、文件夹或本地 TXT 文件。所有可交付内容必须是一份结构完整、可直接导出的 Markdown 分镜脚本文档；保留技能要求的场景调度宪法、逐镜时间码、焦段/景别、运镜构图、表演调度、环境光与声音、Seedance 2.5 双版提示词和质量门禁。点击审计时，本应用会发起专用审计请求：必须对照技能标准逐项检查并修订，直接返回完整修订后的 Markdown 分镜脚本文档（不得只给意见或省略未修改镜头），并在文档末尾附上有证据的审计记录。";
    info!(
        "[generation] 内置工业级分镜技能加载完成: 版本=V4.6, 文档=standalone, 总字节数={}",
        SKILL.len()
    );
    format!("{header}\n\n---\n# 技能文档：viral-video-prompt-engine-standalone.md\n\n{SKILL}")
}

/// `douyin-reverse-prompt` V1.1 的复刻专用适配版。只嵌入视觉反推、详细逐秒模板、
/// 爆点/二创方法与已学习模式；原包中的下载说明、下载脚本与案例写盘逻辑不会编译进应用。
fn load_builtin_viral_remix_system_prompt() -> String {
    const DOCUMENTS: &[(&str, &str)] = &[
        (
            "douyin-reverse-prompt-remix/SKILL.md",
            include_str!("../../skills/viral-remix/douyin-reverse-prompt-remix/SKILL.md"),
        ),
        (
            "douyin-reverse-prompt-remix/references/02-reverse-prompt-framework.md",
            include_str!(
                "../../skills/viral-remix/douyin-reverse-prompt-remix/references/02-reverse-prompt-framework.md"
            ),
        ),
        (
            "douyin-reverse-prompt-remix/references/03-viral-remix-playbook.md",
            include_str!(
                "../../skills/viral-remix/douyin-reverse-prompt-remix/references/03-viral-remix-playbook.md"
            ),
        ),
        (
            "douyin-reverse-prompt-remix/references/05-detailed-reverse-template.md",
            include_str!(
                "../../skills/viral-remix/douyin-reverse-prompt-remix/references/05-detailed-reverse-template.md"
            ),
        ),
        (
            "douyin-reverse-prompt-remix/references/learned-patterns.md",
            include_str!(
                "../../skills/viral-remix/douyin-reverse-prompt-remix/references/learned-patterns.md"
            ),
        ),
    ];
    let header = "你是画布中的「爆款视频复刻」节点。以下是从 douyin-reverse-prompt V1.1 裁剪并内置的纯复刻技能。应用已经把用户连接的视频按技能规则密集抽帧，并把全部帧整理成带精确时间码的联系表图片；你必须逐格观察所有联系表，尤其单独标注为「结尾加密」的最后 5 秒，再完成视觉反推。\n\n运行边界高于原技能：本节点绝不下载视频、不解析网络链接、不调用 yt-dlp、不生成或声称生成本地案例文件，也不要求用户重新提供链接。不得把联系表中的时间码标签、播放器控件或下载节点 UI 当作原视频画面。输出必须是一份可直接编辑和导出的完整 Markdown 复刻方案，包含：视频结构摘要、十维视觉分析、全片四锚点、按动作节拍划分的逐镜生成稿（每段含摄影机与声音状态，结尾含精确动作与固定连续性约束）、爆点诊断、三条至少替换两个维度的二创路线及各自可直接粘贴的提示词、版权/同质化风险。若用户给出额外复刻方向，以用户要求为准；若没有额外要求，自动给出最忠实的结构复刻与三条安全二创路线。";
    let mut sections = Vec::with_capacity(DOCUMENTS.len() + 1);
    sections.push(header.to_string());
    let mut total_bytes = 0usize;
    for (path, content) in DOCUMENTS {
        total_bytes += content.len();
        sections.push(format!("---\n# 技能文档：{path}\n\n{content}"));
    }
    info!(
        "[generation] 内置爆款视频复刻技能加载完成: 版本=V1.1-remix-only, 文件数={}, 总字节数={}",
        DOCUMENTS.len(),
        total_bytes
    );
    sections.join("\n\n")
}

/// 从模型定义 ID 解析远程模型 ID：优先按规范作用域前缀剥离，失败时回退查定义表。
fn resolve_remote_model_id(
    runtime: &ProviderRuntime,
    provider_connection_id: &str,
    model_definition_id: &str,
) -> BackendResult<String> {
    let prefix = format!("remote::{provider_connection_id}::");
    if let Some(remote) = model_definition_id.strip_prefix(&prefix) {
        if !remote.is_empty() {
            return Ok(remote.to_string());
        }
    }
    if let Some(remote) = runtime.model_definition_remote_id(model_definition_id) {
        return Ok(remote);
    }
    Err(BackendError::validation(
        "prompt optimization model definition could not be resolved to a remote model id",
        json!({
            "providerConnectionId": provider_connection_id,
            "modelDefinitionId": model_definition_id,
            "expectedScopedFormat": provider_scoped_model_definition_id(provider_connection_id, "<remoteModelId>"),
        }),
    ))
}

/// 去掉包裹整个内容的 Markdown 代码围栏（2.5 技能要求裸正文，模型偶发仍加围栏）。
fn strip_outer_code_fence(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(without_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // 跳过语言行（```text / ```markdown 等）。
    let body_start = match without_open.find('\n') {
        Some(index) => index + 1,
        None => return trimmed,
    };
    let body_end = without_open.rfind("```").unwrap_or(without_open.len());
    if body_end < body_start {
        return trimmed;
    }
    without_open[body_start..body_end].trim()
}

/// 剥离 2.5 技能输出合同允许追加的单行提示（补充建议 / 素材提示 / 参数提示 / 补充说明）。
fn strip_trailing_advice_lines(content: &str) -> String {
    let mut lines: Vec<&str> = content.lines().collect();
    while let Some(last) = lines.last() {
        let trimmed = last.trim();
        if trimmed.is_empty() {
            lines.pop();
            continue;
        }
        let is_advice = ["补充建议：", "素材提示：", "参数提示：", "补充说明："]
            .iter()
            .any(|prefix| trimmed.starts_with(prefix));
        if is_advice {
            lines.pop();
            continue;
        }
        break;
    }
    lines.join("\n").trim().to_string()
}

/// 从 2.0 技能的多段输出（问题分析 / 优化后的标准提示词 / 优化说明 / 依据参考文档）
/// 中提取「优化后的标准提示词」代码围栏内的正文。
fn extract_fenced_prompt_section(content: &str) -> Option<String> {
    let heading_index = content.find("优化后的标准提示词")?;
    let after_heading = &content[heading_index..];
    let fence_start = after_heading.find("```")?;
    let body_start = fence_start + 3;
    // 跳过围栏语言行。
    let body_start = body_start + after_heading[body_start..].find('\n')? + 1;
    let body_end = after_heading[body_start..].find("```")? + body_start;
    let extracted = after_heading[body_start..body_end].trim();
    (!extracted.is_empty()).then(|| extracted.to_string())
}

/// 万相 3.0 输出合同的唯一一级段落是【主体】；模型偶发在围栏外加前言时，从【主体】起截取。
fn trim_wan30_preamble(content: &str) -> &str {
    match content.find("【主体】") {
        Some(index) => content[index..].trim_start(),
        None => content,
    }
}

/// MiniMax H3 输出正文从固定首行（I2VA/FL2VA/L2VA）或三核心字段（T2VA）开始；
/// 模型偶发在正文外加前言时，从最早的正文锚点起截取，保留固定首行。
fn trim_minimax_h3_preamble(content: &str) -> &str {
    const BODY_ANCHORS: [&str; 3] = [
        "For the target video",
        "How the reference pictures align",
        "integrated_multimodal_description",
    ];
    let mut start: Option<usize> = None;
    for anchor in BODY_ANCHORS {
        if let Some(index) = content.find(anchor) {
            start = Some(match start {
                Some(existing) => existing.min(index),
                None => index,
            });
        }
    }
    match start {
        Some(index) => content[index..].trim_start(),
        None => content,
    }
}

/// 人物真实感图片技能允许在提示词正文后附一句设计逻辑说明；
/// 这类说明与分隔线不属于提示词本体，交付前剥离（与 2.5 的尾注剥离同一策略）。
fn strip_realistic_character_explanation(content: &str) -> String {
    const EXPLANATION_PREFIXES: [&str; 3] = ["设计逻辑", "说明：", "说明:"];
    let mut lines: Vec<&str> = content.lines().collect();
    while let Some(last) = lines.last() {
        let trimmed = last.trim();
        if trimmed.is_empty() || trimmed == "---" {
            lines.pop();
            continue;
        }
        let is_explanation = EXPLANATION_PREFIXES
            .iter()
            .any(|prefix| trimmed.starts_with(prefix));
        if is_explanation && lines.len() > 1 {
            lines.pop();
            continue;
        }
        break;
    }
    lines.join("\n").trim().to_string()
}

/// 移除模型输出中内嵌的思考 / 思维链内容，只保留正式输出文本。
///
/// 带思考的推理模型（如 DeepSeek 风格）或聚合网关常把思维链混进返回文本：
/// - DeepSeek 风格的 `...` 与 `...` 独占整行分隔的思考块；
/// - `[think] … [/think]` 标签包裹的思考块（大小写不敏感）。
///
/// 反复替换直到稳定；两套规则都要求思考块有明确的闭合标记（`...` 必须成对、
/// `[/think]` 必须闭合），避免误伤剧本对白中的省略号或正文里的普通方括号文本。
fn strip_thinking_blocks(text: &str) -> String {
    static DOT_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?ms)^[ \t]*\.\.\.[ \t]*\r?\n.*?\r?\n[ \t]*\.\.\.[ \t]*(?:\r?\n|$)")
            .expect("valid dot-delimited think block regex")
    });
    static TAG_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?is)\[think\].*?\[/think\]").expect("valid [think] tag regex")
    });
    let mut result = text.to_string();
    loop {
        let before = result.len();
        result = DOT_BLOCK.replace_all(&result, "").into_owned();
        result = TAG_BLOCK.replace_all(&result, "").into_owned();
        if result.len() == before {
            break;
        }
    }
    result
}

/// 按模式从模型原始输出中提取纯提示词正文，丢弃问题分析、优化说明等无关部分。
pub fn extract_optimized_prompt(mode: PromptOptimizationMode, raw_output: &str) -> String {
    // 推理模型常在正文前内嵌思维链：先剥离 think/思考块，避免思考内容进入对话、稿件或下游提示词。
    let content = strip_thinking_blocks(raw_output.trim());
    if content.is_empty() {
        return String::new();
    }
    match mode {
        PromptOptimizationMode::Seedance20 => {
            if let Some(fenced) = extract_fenced_prompt_section(&content) {
                return fenced;
            }
            warn!("[generation] 提示词优化输出未找到「优化后的标准提示词」围栏，回退整体围栏剥离");
            strip_outer_code_fence(&content).to_string()
        }
        PromptOptimizationMode::Seedance25 => {
            strip_trailing_advice_lines(strip_outer_code_fence(&content))
        }
        PromptOptimizationMode::Wan30 => trim_wan30_preamble(strip_outer_code_fence(&content))
            .trim_end()
            .to_string(),
        PromptOptimizationMode::MiniMaxH3 => {
            trim_minimax_h3_preamble(strip_outer_code_fence(&content))
                .trim_end()
                .to_string()
        }
        PromptOptimizationMode::RealisticCharacter => {
            strip_realistic_character_explanation(strip_outer_code_fence(&content))
        }
        PromptOptimizationMode::Screenplay
        | PromptOptimizationMode::Storyboard
        | PromptOptimizationMode::ViralRemix => strip_outer_code_fence(&content).to_string(),
    }
}

/// 组装 (系统提示词, 用户提示词) 二元组：系统提示词注入完整技能（含审计时的全部历史上下文），
/// 用户提示词由生成 / 优化 / 审计三种任务决定。各 API 风格的适配器再把它转换为各自的请求体。
fn build_system_and_user_prompts(
    command: &OptimizeVideoPromptCommand,
    skill_system_prompt: &str,
) -> (String, String) {
    let mut system = skill_system_prompt.to_string();
    // 只要本轮携带了历史上下文（多轮对话、历次结果、用户决定），就全部注入系统提示词；
    // 不再限制在 detail_review / 文档技能模式，使提示词节点的生成与优化轮次同样能沿用前文。
    if !command.context_history.is_empty() {
        let context = command
            .context_history
            .iter()
            .map(|entry| format!("### {}\n{}", entry.role, entry.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        system.push_str(&format!(
            "\n\n---\n\n# 之前的完整上下文（含全部对话、历次结果与用户决定，本轮必须全部纳入考虑）\n\n{context}"
        ));
    }
    let user = if command.mode == PromptOptimizationMode::ViralRemix
        && command.task == PromptTask::Audit
    {
        "请严格审计完整上下文中的当前 Markdown 爆款视频复刻方案：逐项检查所有联系表是否都有证据覆盖、最后 5 秒动作是否精确、十维分析是否完整、分段是否遵循动作节拍、每段是否包含摄影机与声音、固定连续性约束是否保留、爆点判断是否有画面证据，以及三条二创路线是否各替换至少两个维度并规避版权风险。修复问题并直接输出完整修订版 Markdown，不要只给意见。"
            .to_string()
    } else if command.mode == PromptOptimizationMode::ViralRemix {
        format!(
            "请逐格读取随请求附带的全部视频联系表，完成爆款视频复刻分析。用户的补充方向如下（为空时按技能默认合同执行）：\n\n{}",
            command.user_prompt
        )
    } else if command.mode == PromptOptimizationMode::Storyboard
        && command.task == PromptTask::Audit
    {
        "请严格审计完整上下文中的当前 Markdown 工业级分镜脚本：逐项检查剧本覆盖、场景调度宪法、轴线与走位、时间码（每个 SD 段独立从 0 起算）、焦段与景别、运镜构图、可拍摄的表演动作、环境光连续性、声音设计、Seedance 2.5 多模态版/纯文字版，以及技能质量门禁。修复发现的问题，直接输出修订后的完整 Markdown 分镜脚本文档，不要只给意见或省略未修改镜头；在文档末尾追加“审计记录”，列出逐项判定依据、真实问题与本轮修订摘要。"
            .to_string()
    } else if command.mode == PromptOptimizationMode::Storyboard {
        format!("用户本轮剧本转工业级分镜请求：\n\n{}", command.user_prompt)
    } else if command.mode == PromptOptimizationMode::Screenplay
        && command.task == PromptTask::Audit
    {
        "请严格审计完整上下文中的当前 Markdown 剧本：检查结构因果、角色欲望与价值变化、可拍摄性、台词、节奏、钩子、时长及所选类型规范。直接输出修订后的完整 Markdown 剧本文档，不要只给意见或省略未修改段落。"
            .to_string()
    } else if command.mode == PromptOptimizationMode::Screenplay {
        format!("用户本轮剧本创作请求：\n\n{}", command.user_prompt)
    } else if command.task == PromptTask::Audit {
        AUDIT_USER_PROMPT.to_string()
    } else if command.detail_review {
        format!(
            "{DETAIL_REVIEW_USER_PROMPT}。当前提示词：\n\n{}",
            command.user_prompt
        )
    } else if command.task == PromptTask::Generate {
        format!(
            "请根据以下创意生成一份可直接用于视频或图片生成模型的完整提示词，并按技能规范只输出提示词正文：\n\n{}",
            command.user_prompt
        )
    } else {
        format!(
            "请优化以下视频或图片提示词，并按技能规范输出：\n\n{}",
            command.user_prompt
        )
    };
    (system, user)
}

/// 已解析为字节的视觉素材：各 API 档案按自己的内容块格式注入同一份 Base64 数据。
#[derive(Debug, Clone)]
pub struct VisionImagePayload {
    pub mime_type: String,
    pub base64: String,
}

impl VisionImagePayload {
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime_type, self.base64)
    }
}

#[derive(Debug, Clone)]
struct MultimodalPayload {
    display_name: String,
    kind: PromptMultimodalKind,
    mime_type: String,
    base64: Option<String>,
    text: Option<String>,
}

impl MultimodalPayload {
    fn data_url(&self) -> Option<String> {
        self.base64
            .as_ref()
            .map(|base64| format!("data:{};base64,{base64}", self.mime_type))
    }

    fn labeled_text(&self) -> Option<String> {
        self.text
            .as_ref()
            .map(|text| format!("# 参考文档：{}\n\n{text}", self.display_name))
    }
}

type StaticRequestHeader = (&'static str, &'static str);
type TextModelRequest = (String, Vec<StaticRequestHeader>, Value);

/// 按模型推断的请求档案构造对应的 HTTP 请求（路径、请求头、请求体）。
/// 三种档案对应 moyu 聚合平台代理的三类文本接口：
/// - openai_chat_v1（OpenAI / 豆包 / DeepSeek / Qwen 等）：/v1/chat/completions
/// - anthropic_messages_v1：/v1/messages（必需 anthropic-version 头与 max_tokens）
/// - gemini_generate_content_v1：/v1beta/models/{model}:generateContent
///   （系统提示词走 systemInstruction，流式由 URL 决定而非 body 字段，这里无需流式）。
///
/// 携带素材时，素材内容块排在用户文本之前（先读取素材、再执行需求）；
/// 无素材时保持原有纯文本请求体形状。各档案只构造其公开支持的内容块，不能
/// 原生读取的组合会在本地返回明确错误，而不是静默丢弃素材。
fn build_text_model_request(
    profile: &str,
    remote_model_id: &str,
    system_prompt: &str,
    user_prompt: &str,
    vision_images: &[VisionImagePayload],
    multimodal_inputs: &[MultimodalPayload],
) -> BackendResult<TextModelRequest> {
    let has_materials = !vision_images.is_empty() || !multimodal_inputs.is_empty();
    match profile {
        "anthropic_messages_v1" => {
            let user_content = if !has_materials {
                Value::String(user_prompt.to_string())
            } else {
                let mut content: Vec<Value> = vision_images
                    .iter()
                    .map(|image| {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image.mime_type,
                                "data": image.base64,
                            },
                        })
                    })
                    .collect();
                for material in multimodal_inputs {
                    if let Some(text) = material.labeled_text() {
                        content.push(json!({ "type": "text", "text": text }));
                        continue;
                    }
                    let data = material.base64.as_ref().ok_or_else(|| {
                        BackendError::validation(
                            "multimodal material is missing binary data",
                            json!({ "displayName": material.display_name }),
                        )
                    })?;
                    match material.kind {
                        PromptMultimodalKind::Image => content.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": material.mime_type,
                                "data": data,
                            },
                        })),
                        PromptMultimodalKind::Document
                            if material.mime_type == "application/pdf" =>
                        {
                            content.push(json!({
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": material.mime_type,
                                    "data": data,
                                },
                            }));
                        }
                        _ => {
                            return Err(BackendError::validation(
                                "the selected Claude interface only accepts images, PDF and text materials",
                                json!({
                                    "displayName": material.display_name,
                                    "kind": material.kind,
                                    "mimeType": material.mime_type,
                                    "suggestion": "Switch to a Gemini model for audio or video materials."
                                }),
                            ));
                        }
                    }
                }
                content.push(json!({ "type": "text", "text": user_prompt }));
                Value::Array(content)
            };
            Ok((
                "/v1/messages".to_string(),
                vec![("anthropic-version", "2023-06-01")],
                json!({
                    "model": remote_model_id,
                    "system": system_prompt,
                    "messages": [{ "role": "user", "content": user_content }],
                    "max_tokens": 8192,
                    "stream": false,
                }),
            ))
        }
        "gemini_generate_content_v1" => {
            let parts = if !has_materials {
                vec![json!({ "text": user_prompt })]
            } else {
                let mut parts: Vec<Value> = vision_images
                    .iter()
                    .map(|image| {
                        json!({
                            "inline_data": { "mime_type": image.mime_type, "data": image.base64 },
                        })
                    })
                    .collect();
                for material in multimodal_inputs {
                    if let Some(text) = material.labeled_text() {
                        parts.push(json!({ "text": text }));
                    } else {
                        let data = material.base64.as_ref().ok_or_else(|| {
                            BackendError::validation(
                                "multimodal material is missing binary data",
                                json!({ "displayName": material.display_name }),
                            )
                        })?;
                        parts.push(json!({
                            "inline_data": {
                                "mime_type": material.mime_type,
                                "data": data,
                            },
                        }));
                    }
                }
                parts.push(json!({ "text": user_prompt }));
                parts
            };
            Ok((
                format!("/v1beta/models/{remote_model_id}:generateContent"),
                Vec::new(),
                json!({
                    "systemInstruction": { "parts": [{ "text": system_prompt }] },
                    "contents": [{ "role": "user", "parts": parts }],
                }),
            ))
        }
        _ => {
            let user_content = if !has_materials {
                Value::String(user_prompt.to_string())
            } else {
                let mut content: Vec<Value> = vision_images
                    .iter()
                    .map(|image| {
                        json!({
                            "type": "image_url",
                            "image_url": { "url": image.data_url() },
                        })
                    })
                    .collect();
                for material in multimodal_inputs {
                    if let Some(text) = material.labeled_text() {
                        content.push(json!({ "type": "text", "text": text }));
                        continue;
                    }
                    match material.kind {
                        PromptMultimodalKind::Image => {
                            let data_url = material.data_url().ok_or_else(|| {
                                BackendError::validation(
                                    "multimodal image is missing binary data",
                                    json!({ "displayName": material.display_name }),
                                )
                            })?;
                            content.push(json!({
                                "type": "image_url",
                                "image_url": { "url": data_url },
                            }));
                        }
                        PromptMultimodalKind::Audio
                            if remote_model_id.to_ascii_lowercase().contains("audio")
                                && matches!(
                                    material.mime_type.as_str(),
                                    "audio/mpeg" | "audio/wav"
                                ) =>
                        {
                            let data = material.base64.as_ref().ok_or_else(|| {
                                BackendError::validation(
                                    "multimodal audio is missing binary data",
                                    json!({ "displayName": material.display_name }),
                                )
                            })?;
                            let format = if material.mime_type == "audio/mpeg" {
                                "mp3"
                            } else {
                                "wav"
                            };
                            content.push(json!({
                                "type": "input_audio",
                                "input_audio": { "data": data, "format": format },
                            }));
                        }
                        _ => {
                            return Err(BackendError::validation(
                                "the selected OpenAI-compatible interface only accepts images, MP3/WAV and text materials",
                                json!({
                                    "displayName": material.display_name,
                                    "kind": material.kind,
                                    "mimeType": material.mime_type,
                                    "suggestion": "Switch to a Gemini model for video, PDF or other audio formats."
                                }),
                            ));
                        }
                    }
                }
                content.push(json!({ "type": "text", "text": user_prompt }));
                Value::Array(content)
            };
            Ok((
                "/v1/chat/completions".to_string(),
                Vec::new(),
                json!({
                    "model": remote_model_id,
                    "messages": [
                        { "role": "system", "content": system_prompt },
                        { "role": "user", "content": user_content },
                    ],
                    "stream": false,
                }),
            ))
        }
    }
}

/// 任务时间线保留请求结构与短文本，但不把大体积 Base64 / 整份本地文档重复写入
/// SQLite。实际 HTTP 请求仍使用未修改的 `body`。
fn redacted_request_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(redacted_request_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let redacted = match (key.as_str(), value) {
                        ("data", Value::String(data)) if data.len() > 512 => {
                            Value::String(format!("<base64 omitted: {} characters>", data.len()))
                        }
                        ("url", Value::String(url)) if url.starts_with("data:") => {
                            Value::String(format!("<data URL omitted: {} characters>", url.len()))
                        }
                        (_, Value::String(text)) if text.len() > 20_000 => Value::String(format!(
                            "{}\n<content omitted: {} characters>",
                            text.chars().take(2_000).collect::<String>(),
                            text.len()
                        )),
                        _ => redacted_request_value(value),
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// 从任意主流文本接口的响应中提取生成的文本内容（自动兼容字段）。
/// 依次尝试：
/// - OpenAI chat/completions：choices[0].message.content
/// - Anthropic messages：content[] 中 type=text 块的 text 拼接
/// - Gemini generateContent：candidates[0].content.parts[] 的 text 拼接
/// - OpenAI responses：output[] 中 message.content[] 的 output_text 拼接
///
/// 聚合网关可能对响应做格式转换（例如统一吐 OpenAI 形状），因此解析不绑定请求档案，
/// 全格式探测，防止「格式不匹配」类怪异报错。
pub fn extract_text_model_output(payload: &Value) -> Option<String> {
    // OpenAI chat/completions
    if let Some(content) = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        && !content.trim().is_empty()
    {
        return Some(content.to_string());
    }
    // Anthropic messages：content 数组里的 text 块
    if let Some(blocks) = payload.get("content").and_then(Value::as_array)
        && blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    {
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    // Gemini generateContent：candidates[0].content.parts[].text
    if let Some(parts) = payload
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    // OpenAI responses：output[].content[].text（type=output_text）
    if let Some(outputs) = payload.get("output").and_then(Value::as_array) {
        let text = outputs
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|item| item.get("content").and_then(Value::as_array))
            .flatten()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

/// 视觉模型支持的图片格式（与 moyu 平台视觉接口约定一致）。
const VISION_IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_INLINE_VISION_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_VISION_IMAGES: usize = 16;

/// 校验素材确实是视觉接口支持的图片格式，并编码为 Base64 载荷。
fn vision_image_payload(display_name: &str, bytes: Vec<u8>) -> BackendResult<VisionImagePayload> {
    let detected = infer::get(&bytes).ok_or_else(|| {
        BackendError::validation(
            "vision reference media type could not be identified from file signature",
            json!({ "displayName": display_name, "byteSize": bytes.len() }),
        )
    })?;
    let mime_type = detected.mime_type();
    if !VISION_IMAGE_MIME_TYPES.contains(&mime_type) {
        return Err(BackendError::validation(
            "vision understanding only supports png, jpeg, webp and gif images",
            json!({ "displayName": display_name, "detectedMimeType": mime_type }),
        ));
    }
    Ok(VisionImagePayload {
        mime_type: mime_type.to_string(),
        base64: BASE64_STANDARD.encode(bytes),
    })
}

/// 解析前端在本地 WebView 中生成的联系表 Data URL。只接受受支持的 Base64 图片，
/// 并同时校验声明 MIME 与文件签名，避免任意 Data URL 混入文本模型请求。
fn inline_vision_image_payload(
    display_name: &str,
    data_url: &str,
) -> BackendResult<VisionImagePayload> {
    let (metadata, encoded) = data_url.split_once(',').ok_or_else(|| {
        BackendError::validation(
            "inline vision image must be a base64 data URL",
            json!({ "displayName": display_name }),
        )
    })?;
    let declared_mime = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| {
            BackendError::validation(
                "inline vision image must use data:<mime>;base64 encoding",
                json!({ "displayName": display_name }),
            )
        })?;
    if !VISION_IMAGE_MIME_TYPES.contains(&declared_mime) {
        return Err(BackendError::validation(
            "inline vision image uses an unsupported MIME type",
            json!({ "displayName": display_name, "declaredMimeType": declared_mime }),
        ));
    }
    let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| {
        BackendError::validation(
            "inline vision image has invalid base64 data",
            json!({ "displayName": display_name, "error": error.to_string() }),
        )
    })?;
    if bytes.len() > MAX_INLINE_VISION_IMAGE_BYTES {
        return Err(BackendError::validation(
            "inline vision image exceeds the 4 MiB limit",
            json!({ "displayName": display_name, "byteSize": bytes.len() }),
        ));
    }
    let payload = vision_image_payload(display_name, bytes)?;
    if payload.mime_type != declared_mime {
        return Err(BackendError::validation(
            "inline vision image MIME type does not match its file signature",
            json!({
                "displayName": display_name,
                "declaredMimeType": declared_mime,
                "detectedMimeType": payload.mime_type
            }),
        ));
    }
    Ok(payload)
}

/// 下载视觉素材字节（素材库读取地址 / 对象存储重签地址均为直链）。
async fn download_vision_bytes(
    providers: &ProviderRuntime,
    url: &str,
    display_name: &str,
) -> BackendResult<Vec<u8>> {
    let response = providers.client().get(url).send().await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = String::from_utf8_lossy(&response.bytes().await?).into_owned();
        return Err(BackendError::protocol(
            format!("vision reference download returned HTTP {status}"),
            json!({
                "displayName": display_name,
                "httpStatus": status,
                "rawResponse": raw.chars().take(2000).collect::<String>()
            }),
        ));
    }
    Ok(response.bytes().await?.to_vec())
}

/// 把一条连入提示词节点的图片素材解析为 Base64 视觉载荷。
/// 云端素材走素材库接口换取读取地址，本地素材按本地上传任务重签对象存储地址，
/// 本地生成结果直接读取已保存文件；三者都复用生成任务的同一套素材身份。
async fn resolve_vision_image(
    deps: &PromptVisionDeps<'_>,
    task: &TaskExecutionRecord,
    attempt_id: &str,
    image: &PromptVisionImage,
) -> BackendResult<VisionImagePayload> {
    let display_name = image.display_name.trim();
    if let Some(data_url) = image.data_url.as_deref() {
        if image.target.is_some() {
            return Err(BackendError::validation(
                "vision image must provide either target or dataUrl, not both",
                json!({ "displayName": display_name }),
            ));
        }
        return inline_vision_image_payload(display_name, data_url);
    }
    let target = image.target.as_ref().ok_or_else(|| {
        BackendError::validation(
            "vision image is missing target or dataUrl",
            json!({ "displayName": display_name }),
        )
    })?;
    let bytes = match target {
        MediaReferenceTarget::Asset {
            provider_connection_id,
            asset_id,
            media_type,
            ..
        } => {
            if *media_type != MediaType::Image {
                return Err(BackendError::validation(
                    "vision understanding only accepts image assets",
                    json!({ "displayName": display_name, "mediaType": media_type }),
                ));
            }
            let resolved = deps
                .assets
                .resolve(ResolveAsset {
                    identity: CloudAssetIdentity {
                        provider_connection_id: provider_connection_id.clone(),
                        asset_id: asset_id.clone(),
                    },
                    expected_media_type: MediaType::Image,
                    delivery: AssetDelivery::Bytes,
                    trace: AssetReadTrace { task, attempt_id },
                })
                .await?;
            match resolved.access {
                ResolvedAssetAccess::Bytes(bytes) => bytes,
                ResolvedAssetAccess::RemoteReference(_) => {
                    return Err(BackendError::protocol(
                        "vision asset resolution did not return bytes",
                        json!({ "displayName": display_name, "assetId": asset_id }),
                    ));
                }
            }
        }
        MediaReferenceTarget::LocalAsset {
            staging_job_id,
            media_type,
            ..
        } => {
            if *media_type != MediaType::Image {
                return Err(BackendError::validation(
                    "vision understanding only accepts image assets",
                    json!({ "displayName": display_name, "mediaType": media_type }),
                ));
            }
            let lease = deps
                .staging
                .local_asset_lease(staging_job_id, MediaType::Image)?;
            download_vision_bytes(deps.providers, &lease.get_url, display_name).await?
        }
        MediaReferenceTarget::LocalResult {
            generation_task_id,
            result_index,
            media_type,
            ..
        } => {
            if *media_type != MediaType::Image {
                return Err(BackendError::validation(
                    "vision understanding only accepts image assets",
                    json!({ "displayName": display_name, "mediaType": media_type }),
                ));
            }
            let record = deps
                .local_results
                .verify_local_result(generation_task_id, *result_index)
                .await?;
            if record.save_status != SaveStatus::Succeeded {
                return Err(BackendError::validation(
                    "vision reference local result is not available",
                    json!({ "displayName": display_name, "saveStatus": record.save_status }),
                ));
            }
            let path = record.final_path.as_deref().ok_or_else(|| {
                BackendError::protocol(
                    "saved vision reference local result has no path",
                    json!({ "displayName": display_name }),
                )
            })?;
            tokio::fs::read(path).await?
        }
        MediaReferenceTarget::LocalFile {
            path, media_type, ..
        } => {
            if *media_type != MediaType::Image {
                return Err(BackendError::validation(
                    "vision understanding only accepts image assets",
                    json!({ "displayName": display_name, "mediaType": media_type }),
                ));
            }
            tokio::fs::read(path).await?
        }
        MediaReferenceTarget::Url {
            url, media_type, ..
        } => {
            if *media_type != MediaType::Image {
                return Err(BackendError::validation(
                    "vision understanding only accepts image assets",
                    json!({ "displayName": display_name, "mediaType": media_type }),
                ));
            }
            download_vision_bytes(deps.providers, url, display_name).await?
        }
    };
    vision_image_payload(display_name, bytes)
}

/// 解析全部视觉素材；任一素材失败即整体失败，避免模型在缺图的情况下继续生成。
async fn resolve_vision_images(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    attempt_id: &str,
    images: &[PromptVisionImage],
) -> BackendResult<Vec<VisionImagePayload>> {
    if images.len() > MAX_VISION_IMAGES {
        return Err(BackendError::validation(
            "vision understanding accepts at most 16 images per request",
            json!({ "imageCount": images.len(), "maximum": MAX_VISION_IMAGES }),
        ));
    }
    let task = deps.storage.get_task_execution(task_id)?;
    let mut payloads = Vec::with_capacity(images.len());
    for image in images {
        payloads.push(resolve_vision_image(deps, &task, attempt_id, image).await?);
    }
    Ok(payloads)
}

const MAX_MULTIMODAL_INPUTS: usize = 8;
const MAX_MULTIMODAL_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MULTIMODAL_TOTAL_BYTES: u64 = 40 * 1024 * 1024;

fn expected_multimodal_mime(kind: PromptMultimodalKind, extension: &str) -> Option<&'static str> {
    match (kind, extension) {
        (PromptMultimodalKind::Image, "png") => Some("image/png"),
        (PromptMultimodalKind::Image, "jpg" | "jpeg") => Some("image/jpeg"),
        (PromptMultimodalKind::Image, "webp") => Some("image/webp"),
        (PromptMultimodalKind::Image, "gif") => Some("image/gif"),
        (PromptMultimodalKind::Audio, "mp3") => Some("audio/mpeg"),
        (PromptMultimodalKind::Audio, "wav") => Some("audio/wav"),
        (PromptMultimodalKind::Audio, "m4a") => Some("audio/mp4"),
        (PromptMultimodalKind::Audio, "aac") => Some("audio/aac"),
        (PromptMultimodalKind::Audio, "ogg") => Some("audio/ogg"),
        (PromptMultimodalKind::Audio, "flac") => Some("audio/flac"),
        (PromptMultimodalKind::Video, "mp4") => Some("video/mp4"),
        (PromptMultimodalKind::Video, "webm") => Some("video/webm"),
        (PromptMultimodalKind::Video, "mov") => Some("video/quicktime"),
        (PromptMultimodalKind::Video, "mkv") => Some("video/x-matroska"),
        (PromptMultimodalKind::Document, "pdf") => Some("application/pdf"),
        (PromptMultimodalKind::Document, "txt") => Some("text/plain"),
        (PromptMultimodalKind::Document, "md" | "markdown") => Some("text/markdown"),
        (PromptMultimodalKind::Document, "json") => Some("application/json"),
        _ => None,
    }
}

fn binary_signature_matches(expected: &str, detected: &str) -> bool {
    expected == detected
        || matches!(
            (expected, detected),
            ("audio/wav", "audio/x-wav")
                | ("audio/mp4", "video/mp4")
                | ("audio/mp4", "audio/m4a")
                | ("audio/mp4", "application/mp4")
                | ("audio/ogg", "application/ogg")
                | ("audio/flac", "audio/x-flac")
        )
}

async fn resolve_multimodal_inputs(
    inputs: &[PromptMultimodalInput],
) -> BackendResult<Vec<MultimodalPayload>> {
    if inputs.len() > MAX_MULTIMODAL_INPUTS {
        return Err(BackendError::validation(
            "a screenplay request accepts at most 8 multimodal materials",
            json!({ "materialCount": inputs.len(), "maximum": MAX_MULTIMODAL_INPUTS }),
        ));
    }
    let mut total_bytes = 0u64;
    let mut payloads = Vec::with_capacity(inputs.len());
    for input in inputs {
        let display_name = input.display_name.trim();
        let path = Path::new(input.local_path.trim());
        if display_name.is_empty() || !path.is_absolute() {
            return Err(BackendError::validation(
                "multimodal material requires a display name and absolute local path",
                json!({ "displayName": display_name, "localPath": input.local_path }),
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let expected_mime = expected_multimodal_mime(input.kind, &extension).ok_or_else(|| {
            BackendError::validation(
                "multimodal material extension does not match its declared kind",
                json!({
                    "displayName": display_name,
                    "kind": input.kind,
                    "extension": extension,
                }),
            )
        })?;
        if input.mime_type != expected_mime {
            return Err(BackendError::validation(
                "multimodal material MIME type does not match its extension",
                json!({
                    "displayName": display_name,
                    "declaredMimeType": input.mime_type,
                    "expectedMimeType": expected_mime,
                }),
            ));
        }
        let metadata = tokio::fs::metadata(path).await.map_err(|error| {
            BackendError::validation(
                "multimodal material is no longer available at its saved path",
                json!({
                    "displayName": display_name,
                    "localPath": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_MULTIMODAL_FILE_BYTES
        {
            return Err(BackendError::validation(
                "multimodal material must be a non-empty file no larger than 20 MiB",
                json!({ "displayName": display_name, "byteSize": metadata.len() }),
            ));
        }
        total_bytes += metadata.len();
        if total_bytes > MAX_MULTIMODAL_TOTAL_BYTES {
            return Err(BackendError::validation(
                "multimodal materials exceed the 40 MiB total limit",
                json!({ "displayName": display_name, "totalBytes": total_bytes }),
            ));
        }
        let bytes = tokio::fs::read(path).await?;
        if matches!(
            expected_mime,
            "text/plain" | "text/markdown" | "application/json"
        ) {
            let text = String::from_utf8(bytes).map_err(|error| {
                BackendError::validation(
                    "text material must use UTF-8 encoding",
                    json!({ "displayName": display_name, "error": error.to_string() }),
                )
            })?;
            payloads.push(MultimodalPayload {
                display_name: display_name.to_string(),
                kind: input.kind,
                mime_type: expected_mime.to_string(),
                base64: None,
                text: Some(text),
            });
            continue;
        }
        let detected_mime = infer::get(&bytes)
            .map(|kind| kind.mime_type())
            .ok_or_else(|| {
                BackendError::validation(
                    "multimodal material type could not be identified from its file signature",
                    json!({ "displayName": display_name, "byteSize": bytes.len() }),
                )
            })?;
        if !binary_signature_matches(expected_mime, detected_mime) {
            return Err(BackendError::validation(
                "multimodal material MIME type does not match its file signature",
                json!({
                    "displayName": display_name,
                    "expectedMimeType": expected_mime,
                    "detectedMimeType": detected_mime,
                }),
            ));
        }
        payloads.push(MultimodalPayload {
            display_name: display_name.to_string(),
            kind: input.kind,
            mime_type: expected_mime.to_string(),
            base64: Some(BASE64_STANDARD.encode(bytes)),
            text: None,
        });
    }
    Ok(payloads)
}

async fn execute_recorded_text_call(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    attempt_id: &str,
    command: &OptimizeVideoPromptCommand,
    remote_model_id: &str,
) -> BackendResult<(OptimizedPromptResult, CapturedHttpResponse)> {
    let skill_system_prompt = load_skill_system_prompt(command.mode)?;
    let vision_images =
        resolve_vision_images(deps, task_id, attempt_id, &command.vision_images).await?;
    let multimodal_inputs = resolve_multimodal_inputs(&command.multimodal_inputs).await?;
    let (system_prompt, user_prompt) = build_system_and_user_prompts(command, &skill_system_prompt);
    let user_prompt = if multimodal_inputs.is_empty() {
        user_prompt
    } else {
        let inventory = multimodal_inputs
            .iter()
            .enumerate()
            .map(|(index, material)| {
                format!(
                    "{}. {}（{}）",
                    index + 1,
                    material.display_name,
                    material.mime_type
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "以下本地参考素材已随请求附带，请逐项读取并用于本轮任务：\n{inventory}\n\n{user_prompt}"
        )
    };
    let profile = text_request_profile(remote_model_id);
    let (path, headers, body) = build_text_model_request(
        profile,
        remote_model_id,
        &system_prompt,
        &user_prompt,
        &vision_images,
        &multimodal_inputs,
    )?;
    commit_generation_transition(
        deps,
        task_id,
        GenerationLifecycleFact::ExecutionRequestResolved {
            resolved_request: json!({
                "profile": profile,
                "path": path,
                "headers": headers.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect::<Vec<_>>(),
                "body": redacted_request_value(&body),
            }),
        },
    )?;
    info!(
        "[generation] 提示词模型请求开始: taskId={}, task={:?}, mode={}, detailReview={}, profile={}, providerConnectionId={}, model={}, 系统提示词 {} 字符, 视觉素材 {} 张, 多模态素材 {} 项",
        task_id,
        command.task,
        command.mode.as_str(),
        command.detail_review,
        profile,
        command.provider_connection_id,
        remote_model_id,
        system_prompt.len(),
        vision_images.len(),
        multimodal_inputs.len(),
    );
    let response = deps
        .providers
        .captured_text_json(
            &deps.storage.get_task_execution(task_id)?,
            attempt_id,
            &path,
            &body,
            &headers,
        )
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(BackendError::protocol(
            "prompt model chat completion failed",
            json!({
                "httpStatus": response.status,
                "profile": profile,
                "path": path,
                "rawResponse": response.body.chars().take(2000).collect::<String>(),
            }),
        ));
    }
    let payload: Value = serde_json::from_str(&response.body)?;
    let raw_model_output = extract_text_model_output(&payload).unwrap_or_default();
    if raw_model_output.trim().is_empty() {
        return Err(BackendError::protocol(
            "prompt model returned an empty message",
            json!({
                "profile": profile,
                "path": path,
                "rawResponse": response.body.chars().take(2000).collect::<String>()
            }),
        ));
    }
    let optimized_prompt = extract_optimized_prompt(command.mode, &raw_model_output);
    Ok((
        OptimizedPromptResult {
            optimized_prompt,
            raw_model_output,
        },
        response,
    ))
}

fn emit_generation_event(deps: &PromptVisionDeps<'_>, event: &str, payload: &Value) {
    if let Err(error) = deps.app.emit(event, payload) {
        warn!("[generation] 文本任务事件发送失败: event={event}, 错误={error}");
    }
}

fn commit_generation_transition(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    fact: GenerationLifecycleFact,
) -> BackendResult<()> {
    let receipt = deps.lifecycle.commit(task_id, fact)?;
    if let Some(PersistedTaskTransitionEvent::StateChanged {
        status,
        progress,
        error,
        ..
    }) = receipt.transition.and_then(|persisted| persisted.event)
    {
        emit_generation_event(
            deps,
            "generation:state-changed",
            &json!({
                "taskId": task_id,
                "status": status,
                "progress": progress,
                "error": error,
            }),
        );
    }
    Ok(())
}

fn finish_recorded_text_failure(
    deps: &PromptVisionDeps<'_>,
    task_id: &str,
    attempt_id: &str,
    error: &BackendError,
) {
    let record = error.runtime_record();
    let status = if matches!(error, BackendError::Transport(_)) {
        GenerationTaskStatus::Unknown
    } else {
        GenerationTaskStatus::Failed
    };
    let _ = commit_generation_transition(
        deps,
        task_id,
        GenerationLifecycleFact::TextGenerationFailed {
            attempt_id: attempt_id.to_string(),
            conclusion: status,
            error: record,
        },
    );
}

/// 执行提示词优化，并把文本模型调用作为 `text_generation` 任务完整写入生成历史：
/// 冻结逻辑输入、解析后的真实请求、请求/响应、token 用量、原始模型文本和提取产物。
pub async fn optimize_video_prompt(
    deps: &PromptVisionDeps<'_>,
    command: OptimizeVideoPromptCommand,
) -> BackendResult<OptimizedPromptResult> {
    if command.user_prompt.trim().is_empty() {
        return Err(BackendError::validation(
            "prompt optimization requires a non-empty user prompt",
            json!({ "mode": command.mode.as_str() }),
        ));
    }
    let started_at = std::time::Instant::now();
    let provider = deps
        .storage
        .get_provider_connection(&command.provider_connection_id)?;
    if !provider.enabled {
        return Err(BackendError::validation(
            "provider connection is disabled",
            json!({ "providerConnectionId": provider.id }),
        ));
    }
    let binding = deps.storage.get_binding(
        &command.provider_connection_id,
        &command.model_definition_id,
    )?;
    if !binding.enabled
        || !binding
            .enabled_operations
            .contains(&GenerationOperation::TextGeneration)
    {
        return Err(BackendError::validation(
            "provider does not expose this text model operation",
            json!({
                "providerConnectionId": command.provider_connection_id,
                "modelDefinitionId": command.model_definition_id,
                "operation": GenerationOperation::TextGeneration,
            }),
        ));
    }
    let remote_model_id = binding
        .remote_model_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .map(Ok)
        .unwrap_or_else(|| {
            resolve_remote_model_id(
                deps.providers,
                &command.provider_connection_id,
                &command.model_definition_id,
            )
        })?;
    let logical_request = serde_json::to_value(&command)?;
    let task_id = Uuid::new_v4().to_string();
    let canvas_id = command
        .canvas_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("legacy-canvas");
    let source_node_id = command
        .source_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("legacy-prompt-optimizer");
    // 文本模型同样按绑定上的令牌分组解析密钥，与媒体生成任务保持一致；
    // 冻结到任务快照后，captured_text_json 通过 resolve_frozen 直接使用对应密钥。
    let task_api_key_ref = deps.storage.resolve_binding_credential_ref(
        &command.provider_connection_id,
        binding.token_group.as_deref(),
    )?;
    deps.providers
        .resolve_token_group(&provider.id, binding.token_group.as_deref())?;
    deps.lifecycle.create(NewTask {
        id: &task_id,
        canvas_id,
        source_node_id,
        operation: GenerationOperation::TextGeneration,
        provider: &provider,
        api_key_ref: &task_api_key_ref,
        model_definition_id: &command.model_definition_id,
        remote_model_id: Some(&remote_model_id),
        logical_request: &logical_request,
    })?;
    emit_generation_event(
        deps,
        "generation:created",
        &json!({ "taskId": task_id, "sourceNodeId": source_node_id }),
    );
    let attempt_id = Uuid::new_v4().to_string();
    commit_generation_transition(
        deps,
        &task_id,
        GenerationLifecycleFact::BeginTextGeneration {
            attempt_id: attempt_id.clone(),
        },
    )?;

    let execution =
        execute_recorded_text_call(deps, &task_id, &attempt_id, &command, &remote_model_id).await;
    let (result, response) = match execution {
        Ok(value) => value,
        Err(error) => {
            finish_recorded_text_failure(deps, &task_id, &attempt_id, &error);
            return Err(error);
        }
    };
    let completion = commit_generation_transition(
        deps,
        &task_id,
        GenerationLifecycleFact::TextGenerationSucceeded {
            attempt_id: attempt_id.clone(),
            call_id: response.call_id.clone(),
            tokens: parse_token_usage(&response),
            optimized_prompt: result.optimized_prompt.clone(),
            raw_model_output: result.raw_model_output.clone(),
        },
    );
    if let Err(error) = completion {
        finish_recorded_text_failure(deps, &task_id, &attempt_id, &error);
        return Err(error);
    }
    info!(
        "[generation] 提示词模型请求完成: taskId={}, task={:?}, mode={}, detailReview={}, 原始输出 {} 字符, 提取提示词 {} 字符, 耗时 {}ms",
        task_id,
        command.task,
        command.mode.as_str(),
        command.detail_review,
        result.raw_model_output.len(),
        result.optimized_prompt.len(),
        started_at.elapsed().as_millis(),
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_from_all_supported_api_response_shapes() {
        // OpenAI chat/completions
        let openai = json!({
            "choices": [{ "message": { "role": "assistant", "content": "你好！有什么可以帮助你的吗？" } }]
        });
        assert_eq!(
            extract_text_model_output(&openai).as_deref(),
            Some("你好！有什么可以帮助你的吗？")
        );
        // Anthropic messages（多个 text 块拼接）
        let anthropic = json!({
            "type": "message",
            "content": [
                { "type": "text", "text": "Hello! " },
                { "type": "text", "text": "How can I help?" },
                { "type": "tool_use", "id": "t1" },
            ]
        });
        assert_eq!(
            extract_text_model_output(&anthropic).as_deref(),
            Some("Hello! How can I help?")
        );
        // Gemini generateContent（parts 拼接）
        let gemini = json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{ "text": "Hi there! " }, { "text": "😊" }] },
                "finishReason": "STOP"
            }]
        });
        assert_eq!(
            extract_text_model_output(&gemini).as_deref(),
            Some("Hi there! 😊")
        );
        // OpenAI responses
        let responses = json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "你好！我是 AI 助手。" }]
            }]
        });
        assert_eq!(
            extract_text_model_output(&responses).as_deref(),
            Some("你好！我是 AI 助手。")
        );
        // 无法识别的形状
        assert_eq!(extract_text_model_output(&json!({ "foo": "bar" })), None);
    }

    #[test]
    fn builds_requests_matching_each_api_profile() {
        let (path, headers, body) = build_text_model_request(
            "openai_chat_v1",
            "doubao-seed-1-8-251228",
            "SYS",
            "USER",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(path, "/v1/chat/completions");
        assert!(headers.is_empty());
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["content"], "USER");

        let (path, headers, body) = build_text_model_request(
            "anthropic_messages_v1",
            "claude-sonnet-4-5-20250929",
            "SYS",
            "USER",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(path, "/v1/messages");
        assert!(headers.contains(&("anthropic-version", "2023-06-01")));
        // Anthropic：system 独立字段 + 必填 max_tokens
        assert_eq!(body["system"], "SYS");
        assert_eq!(body["messages"][0]["content"], "USER");
        assert!(body["max_tokens"].as_u64().is_some());

        let (path, headers, body) = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini-2.5-flash",
            "SYS",
            "USER",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(path, "/v1beta/models/gemini-2.5-flash:generateContent");
        assert!(headers.is_empty());
        // Gemini：systemInstruction + contents/parts，且不允许 stream 字段
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "SYS");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "USER");
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn vision_images_become_content_blocks_before_the_user_text() {
        let images = vec![
            VisionImagePayload {
                mime_type: "image/png".to_string(),
                base64: "AAAA".to_string(),
            },
            VisionImagePayload {
                mime_type: "image/jpeg".to_string(),
                base64: "BBBB".to_string(),
            },
        ];
        // OpenAI 兼容：image_url 内容块携带 Data URL，文本块排在图片之后。
        let (_, _, body) = build_text_model_request(
            "openai_chat_v1",
            "glm-5.3-flash",
            "SYS",
            "USER",
            &images,
            &[],
        )
        .unwrap();
        let content = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "image_url");
        assert_eq!(content[0]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(
            content[1]["image_url"]["url"],
            "data:image/jpeg;base64,BBBB"
        );
        assert_eq!(content[2]["type"], "text");
        assert_eq!(content[2]["text"], "USER");
        assert_eq!(body["messages"][0]["content"], "SYS");

        // Anthropic：base64 source 块。
        let (_, _, body) = build_text_model_request(
            "anthropic_messages_v1",
            "claude-sonnet-4-5",
            "SYS",
            "USER",
            &images,
            &[],
        )
        .unwrap();
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "AAAA");
        assert_eq!(content[2]["text"], "USER");

        // Gemini：inline_data 块。
        let (_, _, body) = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini-2.5-flash",
            "SYS",
            "USER",
            &images,
            &[],
        )
        .unwrap();
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["inline_data"]["mime_type"], "image/png");
        assert_eq!(parts[1]["inline_data"]["data"], "BBBB");
        assert_eq!(parts[2]["text"], "USER");
    }

    #[test]
    fn multimodal_materials_are_adapted_per_text_api_profile() {
        let video = MultimodalPayload {
            display_name: "走位参考.mp4".to_string(),
            kind: PromptMultimodalKind::Video,
            mime_type: "video/mp4".to_string(),
            base64: Some("VIDEO".to_string()),
            text: None,
        };
        let text_document = MultimodalPayload {
            display_name: "人物小传.md".to_string(),
            kind: PromptMultimodalKind::Document,
            mime_type: "text/markdown".to_string(),
            base64: None,
            text: Some("主角害怕失去控制。".to_string()),
        };
        let (_, _, body) = build_text_model_request(
            "gemini_generate_content_v1",
            "gemini-2.5-flash",
            "SYS",
            "USER",
            &[],
            &[video.clone(), text_document.clone()],
        )
        .unwrap();
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["inline_data"]["mime_type"], "video/mp4");
        assert!(parts[1]["text"].as_str().unwrap().contains("人物小传.md"));
        assert_eq!(parts[2]["text"], "USER");

        let claude_error = build_text_model_request(
            "anthropic_messages_v1",
            "claude-sonnet-4-5",
            "SYS",
            "USER",
            &[],
            &[video],
        )
        .unwrap_err();
        assert!(
            claude_error
                .to_string()
                .contains("only accepts images, PDF and text")
        );

        let audio = MultimodalPayload {
            display_name: "访谈.mp3".to_string(),
            kind: PromptMultimodalKind::Audio,
            mime_type: "audio/mpeg".to_string(),
            base64: Some("AUDIO".to_string()),
            text: None,
        };
        let (_, _, body) = build_text_model_request(
            "openai_chat_v1",
            "gpt-4o-audio-preview",
            "SYS",
            "USER",
            &[],
            &[audio, text_document],
        )
        .unwrap();
        let content = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "input_audio");
        assert_eq!(content[0]["input_audio"]["format"], "mp3");
        assert!(content[1]["text"].as_str().unwrap().contains("人物小传.md"));
        assert_eq!(content[2]["text"], "USER");
    }

    #[test]
    fn vision_payload_rejects_non_image_media() {
        let png = b"\x89PNG\r\n\x1a\n rest-of-png-bytes".to_vec();
        let payload = vision_image_payload("参考图", png).unwrap();
        assert_eq!(payload.mime_type, "image/png");
        assert!(!payload.base64.is_empty());

        let error = vision_image_payload("不是图片", b"plain text bytes".to_vec()).unwrap_err();
        assert!(error.to_string().contains("could not be identified"));
    }

    #[test]
    fn command_deserializes_legacy_payload_without_vision_images() {
        let command: OptimizeVideoPromptCommand = serde_json::from_value(json!({
            "providerConnectionId": "provider",
            "modelDefinitionId": "model",
            "mode": "seedance_2_5",
            "userPrompt": "创意",
        }))
        .unwrap();
        assert!(command.vision_images.is_empty());
        assert!(command.multimodal_inputs.is_empty());
        assert!(command.canvas_id.is_none());
        assert!(command.source_node_id.is_none());
        assert_eq!(command.task, PromptTask::Optimize);

        let command: OptimizeVideoPromptCommand = serde_json::from_value(json!({
            "providerConnectionId": "provider",
            "modelDefinitionId": "model",
            "mode": "seedance_2_5",
            "task": "generate",
            "userPrompt": "创意",
            "visionImages": [{
                "target": {
                    "kind": "local_asset",
                    "stagingJobId": "job-1",
                    "mediaType": "image"
                },
                "displayName": "参考图"
            }]
        }))
        .unwrap();
        assert_eq!(command.vision_images.len(), 1);
        assert_eq!(command.vision_images[0].display_name, "参考图");

        let command: OptimizeVideoPromptCommand = serde_json::from_value(json!({
            "providerConnectionId": "provider",
            "modelDefinitionId": "model",
            "mode": "screenplay",
            "task": "generate",
            "userPrompt": "根据素材创作",
            "multimodalInputs": [{
                "localPath": "C:\\\\project\\\\reference.mp4",
                "displayName": "reference.mp4",
                "kind": "video",
                "mimeType": "video/mp4"
            }]
        }))
        .unwrap();
        assert_eq!(command.multimodal_inputs.len(), 1);
        assert_eq!(
            command.multimodal_inputs[0].kind,
            PromptMultimodalKind::Video
        );
    }

    #[test]
    fn audit_uses_fixed_user_prompt_and_keeps_history_in_system_context() {
        let command = OptimizeVideoPromptCommand {
            canvas_id: Some("canvas-1".to_string()),
            source_node_id: Some("prompt-1".to_string()),
            provider_connection_id: "provider".to_string(),
            model_definition_id: "model".to_string(),
            mode: PromptOptimizationMode::Seedance25,
            task: PromptTask::Audit,
            user_prompt: "当前输出提示词".to_string(),
            context_history: vec![PromptOptimizationContextEntry {
                role: "第 1 轮审计输入".to_string(),
                content: "当前输出提示词".to_string(),
            }],
            detail_review: true,
            vision_images: Vec::new(),
            multimodal_inputs: Vec::new(),
        };
        let (system, user) = build_system_and_user_prompts(&command, "完整技能上下文");
        assert_eq!(user, "严格审查这个Phase 是否已经是最优版本");
        assert!(system.contains("完整技能上下文"));
        assert!(system.contains("第 1 轮审计输入"));
        assert!(system.contains("当前输出提示词"));
    }

    #[test]
    fn extracts_fenced_prompt_from_seedance20_output() {
        let raw = "##### 问题分析\n原始提示词过于简略。\n\n---\n##### 优化后的标准提示词\n```\n一只橘猫在公园玩球。\n\n4K 高清，细节丰富。\n```\n\n---\n##### 优化说明\n- 补充了细节。\n\n**【依据参考文档】**\n- `references/prompt-guide.md`";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Seedance20, raw);
        assert_eq!(extracted, "一只橘猫在公园玩球。\n\n4K 高清，细节丰富。");
    }

    #[test]
    fn strips_deepseek_style_dot_think_block() {
        let raw = "好的，我来分析这个剧本需求。\n...\n先确定类型：女频复仇短剧，核心是反转与情感张力。\n...\n\n# 《雨夜归人》\n\n第 1 场 雨夜，废弃站台，外景";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(
            stripped,
            "好的，我来分析这个剧本需求。\n\n# 《雨夜归人》\n\n第 1 场 雨夜，废弃站台，外景"
        );
    }

    #[test]
    fn strips_multiple_dot_think_blocks() {
        let raw = "...\n第一段思考。\n...\n\n正文。\n\n...\n第二段思考。\n...\n结尾。";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(stripped, "\n正文。\n\n结尾。");
    }

    #[test]
    fn strips_think_tag_blocks_case_insensitively() {
        let raw = "[THINK]这是内部推理。[/think]\n\n# 剧本正文";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(stripped, "\n\n# 剧本正文");
    }

    #[test]
    fn keeps_ellipsis_inside_dialogue() {
        let raw = "林岚：我…不知道该怎么办。\n\n（她沉默片刻，雨声渐大）";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(stripped, raw);
    }

    #[test]
    fn keeps_unclosed_think_tag_intact() {
        let raw = "说明：[think] 这只是一个普通引用文本";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(stripped, raw);
    }

    #[test]
    fn unpaired_dot_delimiter_is_kept() {
        let raw = "第一行。\n...\n正文没有闭合分隔行。";
        let stripped = strip_thinking_blocks(raw);
        assert_eq!(stripped, raw);
    }

    #[test]
    fn screenplay_mode_strips_think_before_outer_fence() {
        let raw = "...\n先构思大纲。\n...\n\n```markdown\n# 雨夜归人\n\n## 第一场\n```";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Screenplay, raw);
        assert_eq!(extracted, "# 雨夜归人\n\n## 第一场");
    }

    #[test]
    fn seedance25_output_strips_fence_and_advice_lines() {
        let raw = "```text\n【生成目标】\n一只橘猫玩球。\n```\n补充建议：建议补充运镜。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Seedance25, raw);
        assert_eq!(extracted, "【生成目标】\n一只橘猫玩球。");
    }

    #[test]
    fn seedance25_plain_body_is_kept_as_is() {
        let raw = "【生成目标】\n一只橘猫玩球。\n\n【保持一致】\n面部稳定不变形。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Seedance25, raw);
        assert_eq!(extracted, raw);
    }

    #[test]
    fn seedance20_falls_back_to_outer_fence_strip() {
        let raw = "```\n只有一段围栏的提示词。\n```";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Seedance20, raw);
        assert_eq!(extracted, "只有一段围栏的提示词。");
    }

    #[test]
    fn wan30_strips_text_fence_and_keeps_four_sections() {
        let raw = "```text\n【主体】@图片1 锁定人物五官，全片生效。\n【风格】柔光，侧光，浅景深。\n【时间线】\n镜头1[0-3秒]固定机位，@图片1 缓慢转身约 90 度。\n【限制】无字幕；轮廓与比例全程保持稳定。\n```";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Wan30, raw);
        assert_eq!(
            extracted,
            "【主体】@图片1 锁定人物五官，全片生效。\n【风格】柔光，侧光，浅景深。\n【时间线】\n镜头1[0-3秒]固定机位，@图片1 缓慢转身约 90 度。\n【限制】无字幕；轮廓与比例全程保持稳定。"
        );
    }

    #[test]
    fn wan30_cuts_preamble_before_first_section() {
        let raw = "以下是优化后的提示词：\n\n【主体】@图片1 锁定商品外形。\n【限制】无字幕。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Wan30, raw);
        assert_eq!(extracted, "【主体】@图片1 锁定商品外形。\n【限制】无字幕。");
    }

    #[test]
    fn wan30_plain_body_is_kept_as_is() {
        let raw = "【主体】一只橘猫在公园玩球。\n【限制】无字幕。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::Wan30, raw);
        assert_eq!(extracted, raw);
    }

    #[test]
    fn wan30_mode_serializes_with_frontend_contract_name() {
        assert_eq!(
            serde_json::to_value(PromptOptimizationMode::Wan30).unwrap(),
            json!("wan_3_0")
        );
        let mode: PromptOptimizationMode = serde_json::from_value(json!("wan_3_0")).unwrap();
        assert_eq!(mode, PromptOptimizationMode::Wan30);
        // 旧别名兜底。
        let alias: PromptOptimizationMode = serde_json::from_value(json!("wan30")).unwrap();
        assert_eq!(alias, PromptOptimizationMode::Wan30);
    }

    #[test]
    fn minimax_h3_strips_fence_and_keeps_fixed_first_line_with_fields() {
        let raw = "```text\nFor the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Cinematic, live-action, an establishing wide shot...\n\noverall_soundscape: Gentle wind and distant birdsong.\n\nnon_diegetic_music: Soft piano underscores the scene.\n```";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::MiniMaxH3, raw);
        assert!(extracted.starts_with("For the target video"));
        assert!(extracted.contains("integrated_multimodal_description:"));
        assert!(extracted.contains("overall_soundscape:"));
        assert!(extracted.ends_with("Soft piano underscores the scene."));
    }

    #[test]
    fn minimax_h3_cuts_preamble_before_earliest_anchor() {
        // I2VA 固定首行出现在三核心字段之前，截取必须保留首行。
        let with_first_line = "以下是优化后的提示词：\n\nFor the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] ...";
        let extracted =
            extract_optimized_prompt(PromptOptimizationMode::MiniMaxH3, with_first_line);
        assert!(extracted.starts_with("For the target video"));

        // T2VA 无固定首行，正文直接从 integrated_multimodal_description 开始。
        let t2va =
            "好的，这是提示词：\n\nintegrated_multimodal_description: [Shot 1] Live-action, ...";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::MiniMaxH3, t2va);
        assert!(extracted.starts_with("integrated_multimodal_description:"));
    }

    #[test]
    fn minimax_h3_plain_body_is_kept_as_is() {
        let raw = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Cinematic, live-action.";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::MiniMaxH3, raw);
        assert_eq!(extracted, raw);
    }

    #[test]
    fn minimax_h3_mode_serializes_with_frontend_contract_name() {
        assert_eq!(
            serde_json::to_value(PromptOptimizationMode::MiniMaxH3).unwrap(),
            json!("minimax_h3")
        );
        let mode: PromptOptimizationMode = serde_json::from_value(json!("minimax_h3")).unwrap();
        assert_eq!(mode, PromptOptimizationMode::MiniMaxH3);
        // 旧别名兜底。
        let alias: PromptOptimizationMode = serde_json::from_value(json!("minimaxh3")).unwrap();
        assert_eq!(alias, PromptOptimizationMode::MiniMaxH3);
    }

    #[test]
    fn minimax_h3_loads_full_skill_system_prompt() {
        let prompt = load_skill_system_prompt(PromptOptimizationMode::MiniMaxH3).unwrap();
        assert!(prompt.contains("minimax-h3-prompt"));
        // SKILL.md 在最前，references 与 assets 全部注入。
        assert!(prompt.contains("# MiniMax H3 视频提示词 Skill"));
        assert!(prompt.contains("技能文档：references"));
        assert!(prompt.contains("技能文档：assets"));
    }

    #[test]
    fn realistic_character_strips_fence_and_explanation() {
        let raw = "```text\n35岁的亚洲女性，额头毛孔细密，鼻翼毛孔略明显，眼下是细薄纹理，嘴唇有纵向唇纹。轻微肤色不匀，鼻翼泛红。\n```\n\n设计逻辑：用具体纹理与克制瑕疵替代「完美无瑕」，避免油腻磨皮感。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::RealisticCharacter, raw);
        assert_eq!(
            extracted,
            "35岁的亚洲女性，额头毛孔细密，鼻翼毛孔略明显，眼下是细薄纹理，嘴唇有纵向唇纹。轻微肤色不匀，鼻翼泛红。"
        );
    }

    #[test]
    fn realistic_character_plain_body_with_separator_is_kept() {
        let raw = "一位跑完马拉松的中年男性，额头与鼻尖挂着细汗，毛孔微张，颧骨有局部破碎高光。\n\n---\n\n说明：皮肤高光只写在骨骼凸点。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::RealisticCharacter, raw);
        assert_eq!(
            extracted,
            "一位跑完马拉松的中年男性，额头与鼻尖挂着细汗，毛孔微张，颧骨有局部破碎高光。"
        );
    }

    #[test]
    fn realistic_character_body_without_explanation_is_kept_as_is() {
        let raw = "窗光从左侧扫过，一位年轻女性的面部呈现自然半哑光质感，鼻梁有细碎高光。";
        let extracted = extract_optimized_prompt(PromptOptimizationMode::RealisticCharacter, raw);
        assert_eq!(extracted, raw);
    }

    #[test]
    fn realistic_character_mode_serializes_with_frontend_contract_name() {
        assert_eq!(
            serde_json::to_value(PromptOptimizationMode::RealisticCharacter).unwrap(),
            json!("realistic_character")
        );
        let mode: PromptOptimizationMode =
            serde_json::from_value(json!("realistic_character")).unwrap();
        assert_eq!(mode, PromptOptimizationMode::RealisticCharacter);
        // 旧别名兜底。
        let alias: PromptOptimizationMode =
            serde_json::from_value(json!("realisticcharacter")).unwrap();
        assert_eq!(alias, PromptOptimizationMode::RealisticCharacter);
    }

    #[test]
    fn realistic_character_loads_full_skill_system_prompt() {
        let prompt = load_skill_system_prompt(PromptOptimizationMode::RealisticCharacter).unwrap();
        assert!(prompt.contains("realistic-character-prompt"));
        assert!(prompt.contains("# 真实感AI人物提示词生成技能"));
        assert!(prompt.contains("技能文档：references"));
    }

    #[test]
    fn screenplay_loads_bundled_dual_skill_with_templates_and_tools() {
        let prompt = load_skill_system_prompt(PromptOptimizationMode::Screenplay).unwrap();
        assert!(prompt.contains("screenplay-master 与 screenwriter-zh 双技能完整文本"));
        assert!(prompt.contains("技能文档：screenplay-master/SKILL.md"));
        assert!(prompt.contains("技能文档：screenplay-master/assets/character-card-template.json"));
        assert!(prompt.contains("技能文档：screenplay-master/scripts/validate-script.py"));
        assert!(prompt.contains("技能文档：screenwriter-zh/methodology.md"));
        assert!(prompt.contains("技能文档：screenwriter-zh/tools/build_screenplay.js"));
    }

    #[test]
    fn screenplay_always_injects_history_and_has_a_markdown_audit_contract() {
        let mut command = OptimizeVideoPromptCommand {
            canvas_id: Some("canvas-1".to_string()),
            source_node_id: Some("screenplay-1".to_string()),
            provider_connection_id: "provider".to_string(),
            model_definition_id: "model".to_string(),
            mode: PromptOptimizationMode::Screenplay,
            task: PromptTask::Generate,
            user_prompt: "把结尾改成开放式".to_string(),
            context_history: vec![PromptOptimizationContextEntry {
                role: "编剧助手".to_string(),
                content: "# 当前剧本".to_string(),
            }],
            detail_review: false,
            vision_images: Vec::new(),
            multimodal_inputs: Vec::new(),
        };
        let (system, user) = build_system_and_user_prompts(&command, "双技能全文");
        assert!(system.contains("双技能全文"));
        assert!(system.contains("# 当前剧本"));
        assert_eq!(user, "用户本轮剧本创作请求：\n\n把结尾改成开放式");

        command.task = PromptTask::Audit;
        let (_, audit_user) = build_system_and_user_prompts(&command, "双技能全文");
        assert!(audit_user.contains("直接输出修订后的完整 Markdown 剧本文档"));
        assert_eq!(
            extract_optimized_prompt(
                PromptOptimizationMode::Screenplay,
                "```markdown\n# 修订稿\n\n正文\n```"
            ),
            "# 修订稿\n\n正文"
        );
    }

    #[test]
    fn storyboard_loads_bundled_v46_standalone_skill() {
        let prompt = load_skill_system_prompt(PromptOptimizationMode::Storyboard).unwrap();
        assert!(prompt.contains("viral-video-prompt-engine V4.6 完整独立版"));
        assert!(prompt.contains("viral-video-prompt-engine Standalone (V4.6)"));
        assert!(prompt.contains("=== REFERENCE: references/01-input-routing.md ==="));
        assert!(prompt.contains("=== REFERENCE: references/12-film-review.md ==="));
        assert!(prompt.contains("=== REFERENCE: references/16-craft-blocking.md ==="));
        assert!(prompt.contains("Seedance 2.5"));
    }

    #[test]
    fn storyboard_always_injects_history_and_has_a_markdown_audit_contract() {
        let mut command = OptimizeVideoPromptCommand {
            canvas_id: Some("canvas-1".to_string()),
            source_node_id: Some("storyboard-1".to_string()),
            provider_connection_id: "provider".to_string(),
            model_definition_id: "model".to_string(),
            mode: PromptOptimizationMode::Storyboard,
            task: PromptTask::Generate,
            user_prompt: "把这份剧本拆成 9:16 工业级分镜".to_string(),
            context_history: vec![PromptOptimizationContextEntry {
                role: "当前 Markdown 工业级分镜脚本".to_string(),
                content: "# SD01\n\n0-3s：雨夜街口".to_string(),
            }],
            detail_review: false,
            vision_images: Vec::new(),
            multimodal_inputs: Vec::new(),
        };
        let (system, user) = build_system_and_user_prompts(&command, "V4.6 完整技能");
        assert!(system.contains("V4.6 完整技能"));
        assert!(system.contains("0-3s：雨夜街口"));
        assert_eq!(
            user,
            "用户本轮剧本转工业级分镜请求：\n\n把这份剧本拆成 9:16 工业级分镜"
        );

        command.task = PromptTask::Audit;
        let (_, audit_user) = build_system_and_user_prompts(&command, "V4.6 完整技能");
        assert!(audit_user.contains("直接输出修订后的完整 Markdown 分镜脚本文档"));
        assert!(audit_user.contains("审计记录"));
        assert_eq!(
            extract_optimized_prompt(
                PromptOptimizationMode::Storyboard,
                "```markdown\n# 分镜修订稿\n\n正文\n```"
            ),
            "# 分镜修订稿\n\n正文"
        );
        assert_eq!(
            serde_json::to_value(PromptOptimizationMode::Storyboard).unwrap(),
            json!("storyboard")
        );
    }

    #[test]
    fn viral_remix_loads_only_the_bundled_replication_skill() {
        let prompt = load_skill_system_prompt(PromptOptimizationMode::ViralRemix).unwrap();
        assert!(prompt.contains("douyin-reverse-prompt V1.1"));
        assert!(prompt.contains("十维视觉分析"));
        assert!(prompt.contains("最后 5 秒"));
        assert!(prompt.contains("换皮、换视角、换叙事"));
        assert!(!prompt.contains("scripts/fetch_video.py"));
        assert!(!prompt.contains("references/01-download-methods.md"));
        assert_eq!(
            serde_json::to_value(PromptOptimizationMode::ViralRemix).unwrap(),
            json!("viral_remix")
        );
    }

    #[test]
    fn viral_remix_injects_history_and_uses_visual_replication_contract() {
        let mut command = OptimizeVideoPromptCommand {
            canvas_id: Some("canvas-1".to_string()),
            source_node_id: Some("viral-remix-1".to_string()),
            provider_connection_id: "provider".to_string(),
            model_definition_id: "model".to_string(),
            mode: PromptOptimizationMode::ViralRemix,
            task: PromptTask::Generate,
            user_prompt: "保留运镜，改成国风美妆".to_string(),
            context_history: vec![PromptOptimizationContextEntry {
                role: "当前 Markdown 复刻方案".to_string(),
                content: "# 初稿".to_string(),
            }],
            detail_review: false,
            vision_images: Vec::new(),
            multimodal_inputs: Vec::new(),
        };
        let (system, user) = build_system_and_user_prompts(&command, "纯复刻技能全文");
        assert!(system.contains("# 初稿"));
        assert!(user.contains("逐格读取"));
        assert!(user.contains("保留运镜，改成国风美妆"));

        command.task = PromptTask::Audit;
        let (_, audit_user) = build_system_and_user_prompts(&command, "纯复刻技能全文");
        assert!(audit_user.contains("最后 5 秒动作是否精确"));
        assert!(audit_user.contains("直接输出完整修订版 Markdown"));
    }

    #[test]
    fn inline_contact_sheet_data_url_is_signature_checked() {
        // 1x1 PNG.
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let payload = inline_vision_image_payload("联系表 1", data_url).unwrap();
        assert_eq!(payload.mime_type, "image/png");
        assert!(!payload.base64.is_empty());

        let mismatch = data_url.replacen("image/png", "image/jpeg", 1);
        assert!(inline_vision_image_payload("伪装联系表", &mismatch).is_err());
    }
}
