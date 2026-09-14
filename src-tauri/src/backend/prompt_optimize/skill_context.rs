//! Offline progressive disclosure for complete, locally bundled skill documents.
//!
//! A document is the smallest delivery unit. Core contracts are never summarized or
//! truncated; routing uncertainty deliberately costs tokens instead of losing rules.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::{OptimizeVideoPromptCommand, PromptOptimizationMode as Mode};

pub(super) struct LoadedSkillContext {
    pub system_prompt: String,
    pub evidence: Value,
}

const VERSION: &str = "skill-context.v1";
const DOCUMENT_MARKER: &str = "---\n# 技能文档：";
const LOADING_CONTRACT: &str = "# 技能按需提供合同\n\n本轮保留核心技能与适用资料的完整正文；本合同优先于来源中‘每轮注入全部文档’或‘必须另行读取文件’的旧加载说明，不改变创作方法、用户已确认要求或输出格式。只有下方实际标为技能文档的正文才已提供；未附资料、索引链接与文件名不代表已读取，当前调用没有文件读取或执行工具，不得声称加载或执行未提供的内容。按所附完整方法回答，保留必要检查与完整交付；加载过程不进入面向用户的创作正文。\n\n";

struct Document<'a> {
    path: &'a str,
    /// Includes the original document marker and all original body bytes.
    raw: &'a str,
    body: &'a str,
}

struct Bundle<'a> {
    prefix: &'a str,
    documents: Vec<Document<'a>>,
    suffix: &'a str,
}

fn parse_bundle(full: &str) -> Option<Bundle<'_>> {
    let starts: Vec<_> = full
        .match_indices(DOCUMENT_MARKER)
        .filter(|(offset, _)| *offset == 0 || full.as_bytes()[offset - 1] == b'\n')
        .map(|(offset, _)| offset)
        .collect();
    let first = *starts.first()?;
    let mut documents = Vec::with_capacity(starts.len());
    let mut suffix = "";
    for (index, start) in starts.iter().copied().enumerate() {
        let mut end = starts.get(index + 1).copied().unwrap_or(full.len());
        if index + 1 == starts.len() {
            // Application reminders are outside the last source document. Keeping
            // these exact bytes prevents optional-document omission losing a contract.
            let tail = &full[start..];
            if let Some(offset) = ["\n\n---\n# 交付提醒", "\n\n---\n继续遵守"]
                .iter()
                .filter_map(|marker| tail.find(marker))
                .min()
            {
                end = start + offset;
                suffix = &full[end..];
            }
        }
        let raw = &full[start..end];
        let rest = raw.strip_prefix(DOCUMENT_MARKER)?;
        let (path, body) = rest.split_once('\n')?;
        let path = path.trim();
        if path.is_empty() || documents.iter().any(|doc: &Document<'_>| doc.path == path) {
            return None;
        }
        documents.push(Document { path, raw, body });
    }
    Some(Bundle {
        prefix: &full[..first],
        documents,
        suffix,
    })
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn is_core(mode: Mode, path: &str) -> bool {
    let name = file_name(path).to_ascii_lowercase();
    if name == "skill.md" {
        return true;
    }
    let names: &[&str] = match mode {
        Mode::Seedance20 => &[
            "api-doc-rules.md",
            "engineering-prompt-methodology.md",
            "prompt-guide.md",
            "seedance-2-troubleshooting-guide.md",
        ],
        Mode::Seedance25 => &[
            "01-core-formula.md",
            "02-assets-routing.md",
            "07-checklist-and-limits.md",
            "10-pe-discipline.md",
        ],
        Mode::Wan30 => &["02-formula-families.md"],
        Mode::MiniMaxH3 => &[
            "01-six-sections.md",
            "02-timeline-and-camera.md",
            "03-negative-and-pitfalls.md",
            "06-output-template.md",
            "08-real-world-lessons.md",
        ],
        Mode::FightPromptMaster => &[
            "choreography-core.md",
            "camera-guide.md",
            "fight-structures.md",
        ],
        Mode::Screenplay => &[
            "methodology.md",
            "style-rules.md",
            "workflow.md",
            "format-specification.md",
            "quality-gates.md",
            "timing-and-cutting.md",
        ],
        Mode::Storyboard => &["04-motion-prompt.md", "12-film-review.md"],
        Mode::MultiGridStoryboard => &[
            "grid-image-generation-template.md",
            "image-to-video-prompt-template.md",
        ],
        _ => &[],
    };
    names.contains(&name.as_str())
}

fn is_utility(path: &str) -> bool {
    let path = path.replace('\\', "/").to_lowercase();
    let name = file_name(&path);
    path.split('/')
        .any(|part| matches!(part, "scripts" | "tools" | "tests"))
        || name.starts_with("readme")
        || ["changelog", "evolution-log", "更新日志", "变更日志"]
            .iter()
            .any(|term| name.contains(term))
}

/// Current instructions, then the latest editable draft, then user decisions.
/// Assistant prose is intentionally not a retrieval query: old generated examples
/// may mention every genre/model and should not win over a user's latest change.
fn is_current_draft(entry: &super::PromptOptimizationContextEntry) -> bool {
    !is_assistant_role(&entry.role)
        && (entry.role.contains("当前")
            || entry.role.contains("可编辑")
            || entry.role.eq_ignore_ascii_case("current_output")
            || entry.content.trim_start().starts_with("当前可编辑输出：")
            || entry.content.trim_start().starts_with("当前可编辑输出:"))
}

fn is_assistant_role(role: &str) -> bool {
    role.eq_ignore_ascii_case("assistant") || role.contains("助手")
}

fn is_user_role(role: &str) -> bool {
    !is_assistant_role(role)
        && (role.eq_ignore_ascii_case("user")
            || role.contains("用户")
            || role.trim().ends_with("· 你")
            || role.trim().ends_with("· 决定"))
}

fn intent_layers(command: &OptimizeVideoPromptCommand) -> Vec<String> {
    let mut result = vec![command.user_prompt.to_lowercase()];
    if let Some(entry) = command
        .context_history
        .iter()
        .rev()
        .find(|entry| is_current_draft(entry))
    {
        result.push(entry.content.to_lowercase());
    }
    result.extend(
        command
            .context_history
            .iter()
            .rev()
            .filter(|entry| is_user_role(&entry.role) && !is_current_draft(entry))
            .map(|entry| entry.content.to_lowercase()),
    );
    result.extend(
        command
            .context_history
            .iter()
            .rev()
            .filter(|entry| {
                entry.role.starts_with("已连接的上游") && !is_assistant_role(&entry.role)
            })
            .map(|entry| entry.content.to_lowercase()),
    );
    result.retain(|text| !text.trim().is_empty());
    result
}

fn word_boundary(character: Option<char>) -> bool {
    character.is_none_or(|value| !value.is_ascii_alphanumeric())
}

fn positive_match(text: &str, term: &str) -> bool {
    text.match_indices(term).any(|(offset, _)| {
        let before = &text[..offset];
        let after = &text[offset + term.len()..];
        let boundary = !term.is_ascii()
            || (word_boundary(before.chars().next_back()) && word_boundary(after.chars().next())
                // SD2 and Seedance 2 must not also match a stated 2.5 engine.
                && !(term.ends_with(|value: char| value.is_ascii_digit())
                    && after.starts_with('.')
                    && after.chars().nth(1).is_some_and(|value| value.is_ascii_digit())));
        boundary && !negative_prefix(before)
    })
}

fn negative_prefix(before: &str) -> bool {
    let before = before.trim_end();
    [
        "不要",
        "不需要",
        "不用",
        "排除",
        "不做",
        "不含",
        "不再",
        "不要使用",
        "不使用",
        "不采用",
        "不选择",
        "不是",
        "不再用",
        "别用",
        "别使用",
        "without",
        "no",
        "not",
    ]
    .iter()
    .any(|negative| {
        before
            .strip_suffix(negative)
            .is_some_and(|prefix| !negative.is_ascii() || word_boundary(prefix.chars().next_back()))
    })
}

fn has(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| positive_match(text, term))
}

#[derive(Clone, Copy)]
struct Route {
    terms: &'static [&'static str],
    documents: &'static [&'static str],
}

const FIGHT_TERMS: &[&str] = &[
    "打斗",
    "战斗",
    "动作戏",
    "武打",
    "对决",
    "连招",
    "格斗",
    "搏斗",
    "追逐",
    "群战",
    "武侠",
    "变身",
    "一打多",
    "连击",
    "动作节点",
    "transformation",
    "transform",
    "combo",
    "fight",
    "combat",
    "battle",
    "chase",
    "martial",
    "kung fu",
];
const TIMING_TERMS: &[&str] = &[
    "计时",
    "算秒",
    "时间戳",
    "逐秒",
    "台词",
    "对白",
    "分镜",
    "剧本",
    "长视频",
    "秒",
    "分钟",
    "seconds",
    "minutes",
    "timeline",
    "timestamp",
    "timing",
    "dialogue",
    "script",
    "storyboard",
];
const EXAMPLE_TERMS: &[&str] = &[
    "案例",
    "示例",
    "举例",
    "范例",
    "example",
    "examples",
    "case study",
    "模板",
    "template",
];

fn routes(mode: Mode) -> &'static [Route] {
    match mode {
        Mode::Seedance20 => &[
            Route {
                terms: EXAMPLE_TERMS,
                documents: &["business-guide-examples.md", "typical-effect-cases.md"],
            },
            Route {
                terms: &[
                    "广告",
                    "电商",
                    "商品",
                    "产品",
                    "宣传",
                    "advertising",
                    "commercial",
                    "product",
                ],
                documents: &["business-guide-examples.md"],
            },
            Route {
                terms: &[
                    "失败",
                    "修复",
                    "错误",
                    "失真",
                    "字幕",
                    "畸形",
                    "漂移",
                    "验收",
                    "检查",
                    "质检",
                    "自检",
                    "quality control",
                    "acceptance",
                    "review",
                    "不同步",
                    "bug",
                    "fix",
                    "failure",
                    "distorted",
                ],
                documents: &["typical-effect-cases.md"],
            },
        ],
        Mode::Seedance25 => &[
            Route {
                terms: TIMING_TERMS,
                documents: &[
                    "03-long-video-timing.md",
                    "09-timed-script-prompter.md",
                    "06-camera-and-emotion.md",
                ],
            },
            Route {
                terms: &[
                    "延长",
                    "续接",
                    "续拍",
                    "扩展",
                    "替换",
                    "删除",
                    "移除",
                    "首尾帧",
                    "首帧",
                    "尾帧",
                    "编辑视频",
                    "视频编辑",
                    "原视频",
                    "绿幕",
                    "extend",
                    "extension",
                    "replace",
                    "remove",
                    "keyframe",
                    "first frame",
                    "last frame",
                    "video edit",
                ],
                documents: &["04-edit-extend-keyframe.md", "11-api-compat.md"],
            },
            Route {
                terms: FIGHT_TERMS,
                documents: &[
                    "12-fight-combat.md",
                    "13-fight-clusters.md",
                    "09-timed-script-prompter.md",
                    "06-camera-and-emotion.md",
                ],
            },
            Route {
                terms: &[
                    "白模",
                    "宫格",
                    "转场",
                    "一键成片",
                    "长镜头",
                    "分屏",
                    "多屏",
                    "transition",
                    "multi screen",
                    "split screen",
                    "one take",
                ],
                documents: &["05-advanced-playbook.md", "assets/templates.md"],
            },
            Route {
                terms: &[
                    "镜头",
                    "运镜",
                    "光影",
                    "情绪",
                    "表情",
                    "camera",
                    "lighting",
                    "emotion",
                    "performance",
                ],
                documents: &["06-camera-and-emotion.md"],
            },
            Route {
                terms: &[
                    "api",
                    "endpoint",
                    "参数",
                    "分辨率",
                    "模型名",
                    "错误码",
                    "兼容",
                    "resolution",
                    "duration",
                ],
                documents: &["11-api-compat.md"],
            },
            Route {
                terms: EXAMPLE_TERMS,
                documents: &["08-official-examples.md", "assets/templates.md"],
            },
        ],
        Mode::Wan30 => &[
            Route {
                terms: &[
                    "api",
                    "参数",
                    "分辨率",
                    "兼容",
                    "首尾帧",
                    "上限",
                    "限制",
                    "endpoint",
                    "resolution",
                ],
                documents: &["01-official-api.md"],
            },
            Route {
                terms: &[
                    "广告",
                    "商品",
                    "产品",
                    "电商",
                    "tvc",
                    "commercial",
                    "product",
                    "模板",
                    "场景",
                    "example",
                    "template",
                ],
                documents: &["03-scene-templates.md", "assets/templates.md"],
            },
            Route {
                terms: &[
                    "运镜",
                    "镜头",
                    "光影",
                    "词典",
                    "风格",
                    "camera",
                    "lighting",
                    "style",
                    "dictionary",
                ],
                documents: &["assets/dictionary.md"],
            },
        ],
        Mode::MiniMaxH3 => &[
            Route {
                terms: EXAMPLE_TERMS,
                documents: &["04-complete-examples.md"],
            },
            Route {
                terms: &[
                    "官方",
                    "区别",
                    "对比",
                    "兼容",
                    "比较",
                    "official",
                    "compare",
                    "difference",
                ],
                documents: &["05-vs-official.md"],
            },
            Route {
                terms: &[
                    "跨技能",
                    "融合",
                    "合并",
                    "seedance",
                    "sd2",
                    "迁移",
                    "转换",
                    "merge",
                    "convert",
                    "migration",
                ],
                documents: &["07-cross-skill-merge.md"],
            },
        ],
        Mode::FightPromptMaster => &[
            Route {
                terms: &[
                    "失败",
                    "问题",
                    "诊断",
                    "排错",
                    "修复",
                    "重做",
                    "穿模",
                    "接触",
                    "漂移",
                    "验收",
                    "检查",
                    "质检",
                    "自检",
                    "quality control",
                    "acceptance",
                    "review",
                    "failure",
                    "diagnose",
                    "fix",
                    "troubleshoot",
                ],
                documents: &["failure-diagnostics.md"],
            },
            Route {
                terms: &[
                    "高密度",
                    "最高密度",
                    "一打多",
                    "成龙",
                    "极速",
                    "最高强度",
                    "high density",
                    "jackie chan",
                ],
                documents: &["director-template-A.md", "director-template-B.md"],
            },
            Route {
                terms: EXAMPLE_TERMS,
                documents: &["case-library.md"],
            },
        ],
        Mode::MultiGridStoryboard => &[Route {
            terms: &[
                "风格",
                "推荐",
                "建议",
                "国漫",
                "动画",
                "写实",
                "水彩",
                "赛博",
                "style",
                "stylized",
                "watercolor",
                "anime",
                "recommend",
            ],
            documents: &["style-suggestion-library.md"],
        }],
        Mode::StoryboardPrompt => &[
            Route {
                terms: &[
                    "真实产品",
                    "产品",
                    "商品",
                    "电商",
                    "包装",
                    "卖点",
                    "product",
                    "ecommerce",
                    "e-commerce",
                    "packaging",
                ],
                documents: &["故事板提示词（广告）.md"],
            },
            Route {
                terms: &[
                    "广告",
                    "商业",
                    "提案",
                    "advertisement",
                    "advertising",
                    "commercial",
                    "tvc",
                ],
                documents: &["广告故事板.md"],
            },
            Route {
                terms: &["品牌", "brand"],
                documents: &["品牌宣传故事版.md"],
            },
            Route {
                terms: &["短剧", "剧本转", "电影级", "mini drama", "screenplay"],
                documents: &["故事板提示词（短剧V2版20260525）.md"],
            },
            Route {
                terms: &[
                    "高清",
                    "制作板",
                    "车辆",
                    "汽车",
                    "路线",
                    "production board",
                    "car",
                    "vehicle",
                ],
                documents: &["高清电影制作板.md"],
            },
            Route {
                terms: &[
                    "电影",
                    "景别",
                    "同一角色",
                    "film",
                    "cinematic",
                    "camera angle",
                ],
                documents: &["电影分镜故事板.md"],
            },
            Route {
                terms: &["动画", "卡通", "儿童", "animation", "animated", "cartoon"],
                documents: &["动画故事板.md"],
            },
            Route {
                terms: &["漫画", "条漫", "漫页", "comic", "manga"],
                documents: &["漫画分镜页.md"],
            },
            Route {
                terms: &["游戏", "game", "gaming", "cg"],
                documents: &["游戏剧情故事板.md"],
            },
            Route {
                terms: &[
                    "修仙",
                    "国漫",
                    "科幻",
                    "玄幻",
                    "仙侠",
                    "xianxia",
                    "cultivation",
                ],
                documents: &["修仙国漫影视视觉开发板.md"],
            },
            Route {
                terms: &[
                    "教程",
                    "教学",
                    "操作说明",
                    "步骤",
                    "tutorial",
                    "instruction",
                    "how to",
                ],
                documents: &["教程类分镜图.md"],
            },
            Route {
                terms: &[
                    "体育",
                    "训练",
                    "篮球",
                    "健身",
                    "运动教学",
                    "sports",
                    "training",
                    "workout",
                ],
                documents: &["体育训练故事板.md"],
            },
            Route {
                terms: &[
                    "短视频",
                    "社交媒体",
                    "抖音",
                    "小红书",
                    "tiktok",
                    "social media",
                    "short video",
                ],
                documents: &["社交媒体短视频分镜.md"],
            },
            Route {
                terms: &["mv", "音乐", "歌曲", "舞台", "music", "song", "concert"],
                documents: &["MV 音乐视频故事版.md"],
            },
        ],
        Mode::Screenplay => &[
            Route {
                terms: &[
                    "短剧",
                    "单集",
                    "微电影",
                    "短片",
                    "short film",
                    "short drama",
                    "episode",
                ],
                documents: &[
                    "short-format-guide.md",
                    "beat-sheet-template.md",
                    "episode-script-template.md",
                    "vertical-scene-dialogue.md",
                    "hook-payment-card.md",
                ],
            },
            Route {
                terms: &[
                    "长剧",
                    "长篇",
                    "连续剧",
                    "连载",
                    "系列",
                    "多集",
                    "60集",
                    "80集",
                    "100集",
                    "集大纲",
                    "series",
                    "season",
                    "serial",
                ],
                documents: &[
                    "long-series-guide.md",
                    "episode-outline-template.md",
                    "hook-payment-card.md",
                ],
            },
            Route {
                terms: &["人物", "角色", "人设", "小传", "character", "protagonist"],
                documents: &[
                    "character-engineering.md",
                    "character-card-template.json",
                    "characters.template.md",
                ],
            },
            Route {
                terms: &["梗概", "概念", "故事简介", "synopsis", "logline"],
                documents: &["synopsis.template.md", "hook-payment-card.md"],
            },
            Route {
                terms: &["大纲", "分集", "细纲", "treatment", "outline", "beat sheet"],
                documents: &[
                    "treatment.template.md",
                    "episode-outline-template.md",
                    "beat-sheet-template.md",
                    "hook-payment-card.md",
                ],
            },
            Route {
                terms: &[
                    "世界观",
                    "时代",
                    "背景设定",
                    "worldbuilding",
                    "world building",
                ],
                documents: &["worldbuilding.template.md"],
            },
            Route {
                terms: &[
                    "剧本",
                    "正文",
                    "对白",
                    "台词",
                    "场景",
                    "script",
                    "screenplay",
                    "dialogue",
                    "scene",
                ],
                documents: &[
                    "episode-script-template.md",
                    "vertical-scene-dialogue.md",
                    "hook-payment-card.md",
                ],
            },
            Route {
                terms: FIGHT_TERMS,
                documents: &["vfx-fight-scene.md", "vertical-scene-dialogue.md"],
            },
            Route {
                terms: &[
                    "平台",
                    "付费",
                    "市场",
                    "行业",
                    "商业",
                    "变现",
                    "platform",
                    "market",
                    "monetization",
                ],
                documents: &[
                    "platform-differences.md",
                    "industry-data.md",
                    "hook-payment-card.md",
                ],
            },
        ],
        Mode::Storyboard => &[
            Route {
                terms: &["拆解", "拆剧本", "分析剧本", "场次", "breakdown", "routing"],
                documents: &["01-input-routing.md", "02-script-breakdown.md"],
            },
            Route {
                terms: &[
                    "资产",
                    "设定",
                    "角色",
                    "人物",
                    "场景",
                    "道具",
                    "asset",
                    "character",
                    "prop",
                ],
                documents: &["03-asset-design.md", "09-craft-performance.md"],
            },
            Route {
                terms: TIMING_TERMS,
                documents: &[
                    "04-motion-prompt.md",
                    "09-craft-performance.md",
                    "17-seedance25-timed.md",
                ],
            },
            Route {
                terms: &[
                    "故事板",
                    "九宫格",
                    "复杂场",
                    "复杂镜头",
                    "双输出",
                    "storyboard",
                    "grid",
                ],
                documents: &["05-storyboard.md", "16-craft-blocking.md"],
            },
            Route {
                terms: &["运镜", "镜头", "摄影", "机位", "camera", "cinematography"],
                documents: &["08-craft-camera.md", "16-craft-blocking.md"],
            },
            Route {
                terms: &[
                    "表演",
                    "表情",
                    "情绪",
                    "演技",
                    "acting",
                    "performance",
                    "emotion",
                ],
                documents: &["09-craft-performance.md"],
            },
            Route {
                terms: &["灯光", "光影", "光线", "布光", "lighting", "light"],
                documents: &["10-craft-lighting.md"],
            },
            Route {
                terms: &[
                    "声音",
                    "音效",
                    "配乐",
                    "音频",
                    "旁白",
                    "sound",
                    "audio",
                    "music",
                    "voiceover",
                ],
                documents: &["11-craft-sound.md"],
            },
            Route {
                terms: &[
                    "站位", "调度", "走位", "空间", "blocking", "staging", "spatial",
                ],
                documents: &["16-craft-blocking.md"],
            },
            Route {
                terms: &[
                    "批量",
                    "渲染",
                    "成片",
                    "合成",
                    "batch",
                    "render",
                    "compositing",
                ],
                documents: &["06-batch-render.md", "07-video-render.md"],
            },
            Route {
                terms: &["复盘", "进化", "总结经验", "retrospective", "evolution"],
                documents: &["13-evolution.md"],
            },
            Route {
                terms: &["自驱", "自选目标", "goal creator"],
                documents: &["14-goal-creator.md"],
            },
            Route {
                terms: EXAMPLE_TERMS,
                documents: &["15-craft-library.md"],
            },
        ],
        _ => &[],
    }
}

fn select_names(bundle: &Bundle<'_>, selected: &mut BTreeSet<usize>, names: &[&str]) {
    for (index, document) in bundle.documents.iter().enumerate() {
        if names.iter().any(|name| {
            document.path.eq_ignore_ascii_case(name)
                || file_name(document.path).eq_ignore_ascii_case(name)
        }) {
            selected.insert(index);
        }
    }
}

fn route_names(mode: Mode, text: &str) -> BTreeSet<&'static str> {
    let text = routing_scope(text);
    let mut names: BTreeSet<_> = routes(mode)
        .iter()
        .filter(|route| has(text, route.terms))
        .flat_map(|route| route.documents.iter().copied())
        .collect();
    if mode == Mode::Screenplay && has_series_length(text) {
        names.extend([
            "long-series-guide.md",
            "episode-outline-template.md",
            "hook-payment-card.md",
        ]);
    }
    names
}

fn has_series_length(text: &str) -> bool {
    text.char_indices().any(|(index, character)| {
        if !character.is_ascii_digit()
            || text[..index].ends_with('第')
            || text[..index]
                .chars()
                .next_back()
                .is_some_and(|value| value.is_ascii_digit())
        {
            return false;
        }
        let suffix = &text[index..];
        let digits: String = suffix
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .collect();
        digits.parse::<u16>().is_ok_and(|count| count >= 10)
            && suffix[digits.len()..].trim_start().starts_with('集')
    })
}

fn replaces_task(text: &str) -> bool {
    has(
        text,
        &[
            "重新开始",
            "换个主题",
            "全新任务",
            "改为制作",
            "改做",
            "不再继续",
            "new task",
            "start over",
            "different topic",
        ],
    )
}

fn explicit_document(text: &str, path: &str) -> bool {
    let path = path.replace('\\', "/").replace("%20", " ").to_lowercase();
    let normalized = text.replace('\\', "/").replace("%20", " ");
    positive_match(&normalized, &path) || positive_match(&normalized, file_name(&path))
}

fn query_terms(text: &str) -> BTreeSet<String> {
    let mut terms = BTreeSet::new();
    for part in text.split(|value: char| !value.is_alphanumeric()) {
        if part.is_ascii() {
            if part.len() >= 3
                && ![
                    "the", "and", "with", "this", "that", "for", "please", "make", "from", "only",
                ]
                .contains(&part)
            {
                terms.insert(part.to_string());
            }
        } else {
            let chars: Vec<_> = part.chars().collect();
            for window in chars.windows(2) {
                let term: String = window.iter().collect();
                if ![
                    "生成", "提示", "示词", "优化", "一个", "一下", "帮我", "改成", "继续", "要求",
                    "需要", "内容",
                ]
                .contains(&term.as_str())
                {
                    terms.insert(term);
                }
            }
        }
    }
    terms
}

/// Retrieve using discriminative filename/heading terms, not occurrences in long
/// example bodies. All references tied at a meaningful score remain eligible.
fn lexical_matches(bundle: &Bundle<'_>, mode: Mode, text: &str) -> BTreeSet<usize> {
    let query = query_terms(routing_scope(text));
    let candidates: Vec<_> = bundle
        .documents
        .iter()
        .enumerate()
        .filter(|(_, doc)| {
            !is_core(mode, doc.path)
                && !is_utility(doc.path)
                && !file_name(doc.path).starts_with("engine-")
        })
        .map(|(index, doc)| {
            let mut metadata = doc.path.to_lowercase();
            for heading in doc
                .body
                .lines()
                .filter(|line| line.trim_start().starts_with('#'))
            {
                metadata.push('\n');
                metadata.push_str(&heading.to_lowercase());
            }
            (index, query_terms(&metadata))
        })
        .collect();
    let mut frequencies = BTreeMap::<&str, usize>::new();
    for (_, terms) in &candidates {
        for term in terms.intersection(&query) {
            *frequencies.entry(term).or_default() += 1;
        }
    }
    let mut scores = Vec::new();
    for (index, terms) in &candidates {
        let matches: Vec<_> = terms
            .intersection(&query)
            .filter(|term| {
                frequencies.get(term.as_str()).copied().unwrap_or(0) * 2 <= candidates.len().max(2)
            })
            .collect();
        if matches.len() < 2 {
            continue;
        }
        let score: usize = matches
            .iter()
            .map(|term| {
                candidates.len().max(1) / frequencies.get(term.as_str()).copied().unwrap_or(1)
            })
            .sum();
        scores.push((*index, score));
    }
    let max = scores.iter().map(|(_, score)| *score).max().unwrap_or(0);
    scores
        .into_iter()
        .filter(|(_, score)| *score >= 4 && score * 3 >= max * 2)
        .map(|(index, _)| index)
        .collect()
}

fn precise_revision(text: &str) -> bool {
    // A question can still request a complete creation. Only an explicitly narrow
    // scope permits dropping the default industrial craft dependencies.
    has(
        text,
        &[
            "只改",
            "只调整",
            "仅修改",
            "仅调整",
            "只诊断",
            "只分析",
            "只解释",
            "仅解释",
            "only change",
            "only adjust",
            "only explain",
        ],
    )
}

/// In a narrowly scoped revision, unchanged fields are preservation constraints,
/// not requests to load all of their production methods. Only the retrieval query
/// is scoped; the complete instruction and editable draft still reach the model.
fn routing_scope(text: &str) -> &str {
    if !precise_revision(text) {
        return text;
    }
    [
        "保持",
        "保留",
        "不要修改",
        "不要改变",
        "不改变",
        " keep ",
        " preserve ",
    ]
    .iter()
    .filter_map(|marker| text.find(marker))
    .filter(|offset| *offset > 0)
    .min()
    .map_or(text, |end| &text[..end])
}

fn storyboard_appearance_followup(text: &str) -> bool {
    has(
        text,
        &[
            "风格",
            "高清",
            "画质",
            "光影",
            "阴影",
            "国漫",
            "写实",
            "水彩",
            "清晰",
            "配色",
            "style",
            "resolution",
            "color",
            "watercolor",
        ],
    ) && !has(
        text,
        &[
            "广告",
            "商品",
            "产品",
            "故事板",
            "制作板",
            "开发板",
            "漫画页",
            "教程",
            "训练",
            "游戏剧情",
            "mv",
            "改为制作",
            "改做",
            "product",
            "commercial",
            "storyboard",
            "tutorial",
        ],
    )
}

fn ordinary_creation(mode: Mode, text: &str) -> bool {
    matches!(
        mode,
        Mode::Seedance20 | Mode::Seedance25 | Mode::Wan30 | Mode::MiniMaxH3
    ) && has(
        text,
        &[
            "写", "生成", "创作", "优化", "润色", "改写", "修改", "拍摄", "write", "generate",
            "create", "optimize", "refine", "rewrite",
        ],
    ) && !has(
        text,
        &[
            "怎么",
            "如何",
            "为什么",
            "什么是",
            "查询",
            "解释",
            "what",
            "why",
            "how",
            "explain",
        ],
    )
}

fn evidence(
    full: &str,
    selected: &str,
    strategy: &str,
    document_count: usize,
    paths: Vec<&str>,
) -> Value {
    json!({
        "version": VERSION,
        "strategy": strategy,
        "originalBytes": full.len(),
        "selectedBytes": selected.len(),
        "originalDocuments": document_count,
        "selectedDocuments": paths,
    })
}

pub(super) fn select_skill_context(
    command: &OptimizeVideoPromptCommand,
    full_prompt: &str,
) -> LoadedSkillContext {
    let Some(bundle) = parse_bundle(full_prompt) else {
        return LoadedSkillContext {
            system_prompt: full_prompt.to_string(),
            evidence: evidence(full_prompt, full_prompt, "passthrough", 0, vec![]),
        };
    };
    let pass = |strategy| LoadedSkillContext {
        system_prompt: full_prompt.to_string(),
        evidence: evidence(
            full_prompt,
            full_prompt,
            strategy,
            bundle.documents.len(),
            bundle
                .documents
                .iter()
                .map(|document| document.path)
                .collect(),
        ),
    };
    // These modes already select a stage or have their own structured retrieval
    // (GPT Image style cases). Do not stack a second lossy selector on top.
    let supported = matches!(
        command.mode,
        Mode::Seedance20
            | Mode::Seedance25
            | Mode::Wan30
            | Mode::MiniMaxH3
            | Mode::FightPromptMaster
            | Mode::MultiGridStoryboard
            | Mode::StoryboardPrompt
            | Mode::Screenplay
            | Mode::Storyboard
    );
    if !supported
        || bundle.documents.len() <= 2
        || (full_prompt.len() < 32_000 && !bundle.documents.iter().any(|doc| is_utility(doc.path)))
    {
        return pass("passthrough");
    }

    let layers = intent_layers(command);
    let mut selected: BTreeSet<_> = bundle
        .documents
        .iter()
        .enumerate()
        .filter(|(_, doc)| is_core(command.mode, doc.path))
        .map(|(index, _)| index)
        .collect();
    if selected.is_empty() {
        return pass("conservative_fallback");
    }
    let mut routed = false;
    // Explicit filenames always mean the whole document, even for source code or
    // an otherwise optional historical note. Do not re-add stale assistant names.
    {
        // Drafts and upstream documents are data, even when they quote a request
        // for source code or the entire package. Only this turn can opt into that.
        let latest = command.user_prompt.to_lowercase();
        for (index, document) in bundle.documents.iter().enumerate() {
            if explicit_document(&latest, document.path) {
                selected.insert(index);
                routed = true;
            }
        }
        if has(
            &latest,
            &[
                "完整技能包",
                "全部技能文档",
                "所有技能文档",
                "full skill package",
                "all skill documents",
            ],
        ) {
            return pass("explicit_full_package");
        }
    }

    // A storyboard image has one current purpose. Other modes can need several
    // independent dimensions, but only the most recent informative layer defines
    // the main route. The editable draft supplements narrow follow-up changes.
    for text in &layers {
        let names = route_names(command.mode, text);
        if !names.is_empty() {
            select_names(
                &bundle,
                &mut selected,
                &names.into_iter().collect::<Vec<_>>(),
            );
            routed = true;
            break;
        }
    }
    if command.mode == Mode::StoryboardPrompt
        && layers
            .first()
            .is_some_and(|text| storyboard_appearance_followup(text))
    {
        // Style/quality is not a new product purpose: retain the latest existing
        // layout template while adding the requested visual treatment if useful.
        for prior in layers.iter().skip(1) {
            let names = route_names(command.mode, prior);
            if !names.is_empty() {
                select_names(
                    &bundle,
                    &mut selected,
                    &names.into_iter().collect::<Vec<_>>(),
                );
                routed = true;
                break;
            }
        }
    }
    if command.mode != Mode::StoryboardPrompt
        && !layers.first().is_some_and(|text| replaces_task(text))
        && !(command.mode == Mode::Storyboard
            && layers.first().is_some_and(|text| precise_revision(text)))
    {
        // Ordinary refinements (not just the words "only change") retain the
        // draft's workflow dimensions such as combat, editing and exact timing.
        if let Some(draft) = command
            .context_history
            .iter()
            .rev()
            .find(|entry| is_current_draft(entry))
        {
            let names = route_names(command.mode, &draft.content.to_lowercase());
            select_names(
                &bundle,
                &mut selected,
                &names.into_iter().collect::<Vec<_>>(),
            );
        }
        if command.mode == Mode::Screenplay {
            // Serial format is a durable user decision, independently of a later
            // episode/dialogue request. A current explicit standalone choice ends it.
            let single = layers.first().is_some_and(|text| {
                has(
                    text,
                    &[
                        "独立短片",
                        "独立单集",
                        "单集完结",
                        "单篇",
                        "standalone",
                        "one-off",
                    ],
                )
            });
            if !single
                && layers.iter().any(|text| {
                    has_series_length(text)
                        || has(
                            text,
                            &[
                                "长篇",
                                "连载",
                                "连续剧",
                                "多集",
                                "series",
                                "season",
                                "serial",
                            ],
                        )
                })
            {
                select_names(
                    &bundle,
                    &mut selected,
                    &[
                        "long-series-guide.md",
                        "episode-outline-template.md",
                        "hook-payment-card.md",
                    ],
                );
                routed = true;
            }
        }
    }
    if !routed {
        for text in &layers {
            let matches = lexical_matches(&bundle, command.mode, text);
            if !matches.is_empty() {
                selected.extend(matches);
                routed = true;
                break;
            }
        }
    }
    let default_core = !routed
        && layers
            .first()
            .is_some_and(|text| ordinary_creation(command.mode, text));
    if default_core {
        // These profiles retain the complete formula, reference mapping, output
        // contract and quality checks. No special case is a normal creation path,
        // not a reason to re-send every example in the package.
        routed = true;
    }

    if command.mode == Mode::FightPromptMaster {
        // Resolve a target video engine independently of prose and the text model.
        // First explicit choice wins; an unspecified choice uses SKILL's SD2.5.
        let engines = [
            (&["h3", "minimax", "海螺"][..], "engine-h3.md"),
            (
                &[
                    "sd2.0",
                    "sd 2.0",
                    "seedance2.0",
                    "seedance 2.0",
                    "seedance 2",
                    "sd2",
                ][..],
                "engine-seedance2.md",
            ),
            (
                &[
                    "sd2.5",
                    "sd 2.5",
                    "seedance2.5",
                    "seedance 2.5",
                    "seedance25",
                ][..],
                "engine-seedance25.md",
            ),
        ];
        let mut blocked = BTreeSet::new();
        let mut names = Vec::new();
        for text in &layers {
            for (terms, name) in &engines {
                if !has(text, terms)
                    && terms.iter().any(|term| {
                        text.match_indices(term)
                            .any(|(offset, _)| negative_prefix(&text[..offset]))
                    })
                {
                    blocked.insert(*name);
                }
            }
            names = engines
                .iter()
                .filter(|(terms, name)| !blocked.contains(name) && has(text, terms))
                .map(|(_, name)| *name)
                .collect();
            if !names.is_empty() {
                break;
            }
        }
        if names.is_empty() {
            if !blocked.contains("engine-seedance25.md") {
                names.push("engine-seedance25.md");
            } else {
                // No permitted default: include remaining formats for the skill's
                // normal choice-card clarification; never resurrect a refused model.
                names.extend(
                    engines
                        .iter()
                        .filter(|(_, name)| !blocked.contains(name))
                        .map(|(_, name)| *name),
                );
            }
        }
        select_names(&bundle, &mut selected, &names);
        // The full core + selected engine is the complete normal fight pipeline.
        routed = true;
    }
    if command.mode == Mode::MultiGridStoryboard {
        // The fixed Step 6 dual-output templates are required. The expanded style
        // library adds no format or timing rules and is optional after style choice.
        routed = true;
    }
    if command.mode == Mode::Storyboard
        && !layers.first().is_some_and(|text| precise_revision(text))
    {
        // Complete industrial shot scripts inherently require all these craft
        // dimensions, even when the brief never names lighting/sound/performance.
        select_names(
            &bundle,
            &mut selected,
            &[
                "01-input-routing.md",
                "02-script-breakdown.md",
                "03-asset-design.md",
                "04-motion-prompt.md",
                "05-storyboard.md",
                "08-craft-camera.md",
                "09-craft-performance.md",
                "10-craft-lighting.md",
                "11-craft-sound.md",
                "16-craft-blocking.md",
                "17-seedance25-timed.md",
            ],
        );
        routed = true;
    }

    // A document/image-only request may conceal the route. No speculative genre
    // default: keep all creative references when textual evidence is insufficient.
    let attachment_only = command.user_prompt.trim().is_empty()
        && layers.is_empty()
        && (!command.vision_images.is_empty()
            || !command.multimodal_inputs.is_empty()
            || !command.reference_inputs.is_empty());
    let strategy = if !routed || attachment_only {
        for (index, document) in bundle.documents.iter().enumerate() {
            if !is_utility(document.path) {
                selected.insert(index);
            }
        }
        "conservative_fallback"
    } else if default_core {
        "default_core"
    } else {
        "progressive"
    };
    if selected.len() == bundle.documents.len() {
        return pass(strategy);
    }
    let mut system_prompt = String::with_capacity(full_prompt.len());
    system_prompt.push_str(LOADING_CONTRACT);
    system_prompt.push_str(bundle.prefix);
    let mut paths = Vec::with_capacity(selected.len());
    for index in selected {
        let document = &bundle.documents[index];
        paths.push(document.path);
        if !system_prompt.ends_with('\n') {
            system_prompt.push_str("\n\n");
        }
        system_prompt.push_str(document.raw);
    }
    system_prompt.push_str(bundle.suffix);
    LoadedSkillContext {
        evidence: evidence(
            full_prompt,
            &system_prompt,
            strategy,
            bundle.documents.len(),
            paths,
        ),
        system_prompt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::prompt_optimize::{PromptOptimizationContextEntry, PromptTask};

    fn command(mode: Mode, prompt: &str) -> OptimizeVideoPromptCommand {
        OptimizeVideoPromptCommand {
            workflow_run_id: None,
            canvas_id: None,
            source_node_id: None,
            provider_connection_id: "provider".into(),
            model_definition_id: "text-model".into(),
            mode,
            task: PromptTask::Generate,
            user_prompt: prompt.into(),
            context_history: vec![],
            vision_images: vec![],
            multimodal_inputs: vec![],
            reference_inputs: vec![],
        }
    }

    fn bundle(documents: &[(&str, &str)]) -> String {
        let mut full = "ORIGINAL APPLICATION CONTRACT\n\n".to_string();
        for (path, body) in documents {
            full.push_str(&format!("{DOCUMENT_MARKER}{path}\n\n{body}\n\n"));
        }
        full.push_str("---\n# 交付提醒\n\nORIGINAL DELIVERY RULE");
        full
    }

    fn paths(result: &LoadedSkillContext) -> Vec<&str> {
        result.evidence["selectedDocuments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect()
    }

    #[test]
    fn exact_documents_keep_complete_body_and_surrounding_contracts() {
        let large_core = "核心合同严禁截断\n".repeat(2000);
        let body = "逐字保留🦀全文及所有案例\n".repeat(2000);
        let full = bundle(&[
            ("SKILL.md", &large_core),
            ("references/故事板提示词（广告）.md", &body),
            ("references/修仙国漫影视视觉开发板.md", "不相关资料"),
        ]);
        let result = select_skill_context(
            &command(
                Mode::StoryboardPrompt,
                "使用 references/故事板提示词（广告）.md 全文方法写产品广告",
            ),
            &full,
        );
        assert!(result.system_prompt.contains(&large_core));
        assert!(result.system_prompt.contains(&body));
        assert!(
            result
                .system_prompt
                .contains("ORIGINAL APPLICATION CONTRACT")
        );
        assert!(result.system_prompt.ends_with("ORIGINAL DELIVERY RULE"));
        assert!(!result.system_prompt.contains("不相关资料"));
        assert_eq!(result.evidence["originalBytes"], full.len());
        assert_eq!(result.evidence["selectedBytes"], result.system_prompt.len());
    }

    #[test]
    fn edited_draft_carries_followup_but_current_new_genre_wins() {
        let core = "core".repeat(9000);
        let full = bundle(&[
            ("SKILL.md", &core),
            ("references/漫画分镜页.md", "COMIC"),
            ("references/故事板提示词（广告）.md", "PRODUCT"),
        ]);
        let mut input = command(Mode::StoryboardPrompt, "阴影再柔和些");
        input.context_history = vec![
            PromptOptimizationContextEntry {
                role: "user".into(),
                content: "产品海报".into(),
            },
            PromptOptimizationContextEntry {
                role: "assistant".into(),
                content: "产品广告".repeat(1000),
            },
            PromptOptimizationContextEntry {
                role: "当前可编辑输出".into(),
                content: "漫画分镜页".into(),
            },
        ];
        assert_eq!(
            paths(&select_skill_context(&input, &full)),
            vec!["SKILL.md", "references/漫画分镜页.md"]
        );
        input.user_prompt = "改成真实产品广告".into();
        assert_eq!(
            paths(&select_skill_context(&input, &full)),
            vec!["SKILL.md", "references/故事板提示词（广告）.md"]
        );
    }

    #[test]
    fn routing_selects_all_fight_dependencies_and_keeps_core_over_any_budget() {
        let full = super::super::load_skill_system_prompt(Mode::Seedance25).unwrap();
        let result = select_skill_context(
            &command(Mode::Seedance25, "两位武者展开武打对决，用时间戳锁定连招"),
            &full,
        );
        for required in [
            "SKILL.md",
            "references/01-core-formula.md",
            "references/02-assets-routing.md",
            "references/07-checklist-and-limits.md",
            "references/10-pe-discipline.md",
            "references/12-fight-combat.md",
            "references/13-fight-clusters.md",
            "references/09-timed-script-prompter.md",
        ] {
            assert!(paths(&result).contains(&required), "{required}");
        }
        assert!(!paths(&result).contains(&"references/08-official-examples.md"));
    }

    #[test]
    fn model_selection_follows_latest_user_instead_of_old_assistant() {
        let full = super::super::load_skill_system_prompt(Mode::FightPromptMaster).unwrap();
        let mut input = command(Mode::FightPromptMaster, "改用 H3，15 秒标准版");
        input.context_history.push(PromptOptimizationContextEntry {
            role: "assistant".into(),
            content: "Seedance 2.0 和 Seedance 2.5".repeat(500),
        });
        let result = select_skill_context(&input, &full);
        assert!(paths(&result).contains(&"references/engine-h3.md"));
        assert!(!paths(&result).contains(&"references/engine-seedance2.md"));
        assert!(!paths(&result).contains(&"references/engine-seedance25.md"));
        assert!(!paths(&result).contains(&"references/evolution-log.md"));
    }

    #[test]
    fn uncertain_requests_fall_back_without_executable_or_historical_sources() {
        let full = super::super::load_skill_system_prompt(Mode::Screenplay).unwrap();
        let result = select_skill_context(&command(Mode::Screenplay, ""), &full);
        assert_eq!(result.evidence["strategy"], "conservative_fallback");
        assert!(paths(&result).contains(&"screenwriter-zh/methodology.md"));
        assert!(paths(&result).contains(&"screenplay-master/references/vfx-fight-scene.md"));
        assert!(!paths(&result).iter().any(|path| is_utility(path)));
        let requested = select_skill_context(
            &command(
                Mode::Screenplay,
                "解释 scripts/validate-script.py 的校验逻辑",
            ),
            &full,
        );
        assert!(paths(&requested).contains(&"screenplay-master/scripts/validate-script.py"));
    }

    #[test]
    fn english_boundaries_and_cjk_lexical_retrieval_are_supported() {
        assert!(positive_match("an animated music video", "music"));
        assert!(!positive_match("programming homework", "ram"));
        assert!(!positive_match("不要广告，制作漫画", "广告"));
        assert!(positive_match("piano poster", "poster"));
        assert!(!positive_match(
            "Seedance 2.5".to_lowercase().as_str(),
            "seedance 2"
        ));
        let core = "core".repeat(9000);
        let full = bundle(&[
            ("SKILL.md", &core),
            ("references/topic-a.md", "# 量子纠缠与光子实验"),
            ("references/topic-b.md", "# 陶瓷制作与窑炉温度"),
        ]);
        let result = select_skill_context(
            &command(Mode::StoryboardPrompt, "描述量子纠缠和光子实验"),
            &full,
        );
        assert_eq!(paths(&result), vec!["SKILL.md", "references/topic-a.md"]);
    }

    #[test]
    fn small_or_stage_scoped_skill_is_byte_identical() {
        for mode in [
            Mode::RealisticCharacter,
            Mode::GptImage2Style,
            Mode::AiFilmCharacters,
            Mode::KnowledgeVideoDirector,
        ] {
            let full = super::super::load_skill_system_prompt(mode).unwrap();
            assert_eq!(
                select_skill_context(&command(mode, "继续"), &full).system_prompt,
                full
            );
        }
    }

    #[test]
    fn malformed_document_container_preserves_input() {
        let full = "HEADER\n---\n# 技能文档：\n\nbroken";
        assert_eq!(
            select_skill_context(&command(Mode::Seedance25, "继续"), full).system_prompt,
            full
        );
    }

    #[test]
    fn storyboard_cosmetic_followup_keeps_existing_product_layout() {
        let full = super::super::load_skill_system_prompt(Mode::StoryboardPrompt).unwrap();
        for prompt in ["改成国漫风格", "再高清一点"] {
            let mut input = command(Mode::StoryboardPrompt, prompt);
            input.context_history.push(PromptOptimizationContextEntry {
                role: "当前输出提示词".into(),
                content: "真实产品广告，四栏九宫格，外观保持原图".into(),
            });
            assert!(
                paths(&select_skill_context(&input, &full))
                    .contains(&"references/故事板提示词（广告）.md")
            );
        }
    }

    #[test]
    fn rejected_engine_cannot_return_from_previous_history() {
        let full = super::super::load_skill_system_prompt(Mode::FightPromptMaster).unwrap();
        let mut input = command(Mode::FightPromptMaster, "不要使用 H3，换默认模型");
        input.context_history.push(PromptOptimizationContextEntry {
            role: "第 1 条 · 决定".into(),
            content: "之前已确认 H3".into(),
        });
        let result = select_skill_context(&input, &full);
        assert!(!paths(&result).contains(&"references/engine-h3.md"));
        assert!(paths(&result).contains(&"references/engine-seedance25.md"));
    }

    #[test]
    fn explicit_source_workflows_survive_generic_camera_and_quality_requests() {
        let seedance = super::super::load_skill_system_prompt(Mode::Seedance25).unwrap();
        for request in ["生成一分钟的旅行视频", "create a 45 seconds travel video"] {
            let timed = select_skill_context(&command(Mode::Seedance25, request), &seedance);
            assert!(paths(&timed).contains(&"references/03-long-video-timing.md"));
            assert!(paths(&timed).contains(&"references/09-timed-script-prompter.md"));
        }
        let result = select_skill_context(
            &command(
                Mode::Seedance25,
                "镜头跟拍角色变身后的一打多，保持连击动作连续",
            ),
            &seedance,
        );
        for file in [
            "references/06-camera-and-emotion.md",
            "references/12-fight-combat.md",
            "references/13-fight-clusters.md",
        ] {
            assert!(paths(&result).contains(&file), "{file}");
        }
        let fight = super::super::load_skill_system_prompt(Mode::FightPromptMaster).unwrap();
        assert!(
            paths(&select_skill_context(
                &command(Mode::FightPromptMaster, "给我这段视频的验收标准"),
                &fight
            ))
            .contains(&"references/failure-diagnostics.md")
        );
    }

    #[test]
    fn ordinary_creation_uses_complete_core_without_all_examples() {
        for mode in [Mode::Seedance20, Mode::MiniMaxH3] {
            let full = super::super::load_skill_system_prompt(mode).unwrap();
            let result = select_skill_context(&command(mode, "优化女孩雨夜转身的提示词"), &full);
            assert_eq!(result.evidence["strategy"], "default_core");
            assert!(
                !paths(&result)
                    .iter()
                    .any(|path| path.contains("examples") || path.contains("effect-cases"))
            );
        }
    }

    #[test]
    fn multigrid_keeps_both_delivery_templates_but_expands_style_on_request() {
        let full = super::super::load_skill_system_prompt(Mode::MultiGridStoryboard).unwrap();
        let result = select_skill_context(
            &command(Mode::MultiGridStoryboard, "只调整第二格台词"),
            &full,
        );
        assert!(paths(&result).contains(&"references/grid-image-generation-template.md"));
        assert!(paths(&result).contains(&"references/image-to-video-prompt-template.md"));
        assert!(!paths(&result).contains(&"references/style-suggestion-library.md"));
        let styled = select_skill_context(
            &command(Mode::MultiGridStoryboard, "推荐适合剧情的风格"),
            &full,
        );
        assert!(paths(&styled).contains(&"references/style-suggestion-library.md"));
    }

    #[test]
    fn representative_context_sizes_report_actual_utf8_bytes() {
        for (mode, prompt) in [
            (Mode::StoryboardPrompt, "根据真实产品资料制作商品广告故事板"),
            (Mode::StoryboardPrompt, "做一张修仙国漫影视视觉开发板"),
            (Mode::Seedance25, "为产品广告优化镜头光影与情绪"),
            (Mode::Seedance25, "两位武者对决，打斗连招时间戳清楚"),
            (Mode::MiniMaxH3, "优化当前人物动作和六段式提示词"),
            (Mode::FightPromptMaster, "H3，15秒，标准版，双人攻防"),
            (Mode::Screenplay, "写一份主角人物小传和角色卡"),
            (Mode::Screenplay, ""),
            (Mode::Storyboard, "把这份剧本转成完整工业级分镜"),
            (Mode::Storyboard, "只调整第2段灯光，保持其他内容"),
            (Mode::MultiGridStoryboard, "生成15秒六宫格分镜"),
            (Mode::Wan30, "优化人物走进车站的提示词"),
            (Mode::Seedance20, "优化人物走进车站的提示词"),
        ] {
            let result = super::super::load_skill_context(&command(mode, prompt)).unwrap();
            println!(
                "{} | {} | {} -> {} bytes | {} documents | {}",
                mode.as_str(),
                prompt,
                result.evidence["originalBytes"],
                result.system_prompt.len(),
                paths(&result).len(),
                result.evidence["strategy"]
            );
            assert_eq!(result.evidence["selectedBytes"], result.system_prompt.len());
        }
    }
}
