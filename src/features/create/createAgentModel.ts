/*
 * Agent 模式（`?type=agentic`）的数据模型。
 *
 * 逆向来源：即梦 `https://jimeng.jianying.com/ai-tool/generate?workspace=0&type=agentic`
 * （web_version=7.5.0 / da_version=3.3.30），2026-10-22 实测。
 * 证据分级：实测 = 当场观察到；静态 = 页面下发的配置接口返回；推断 = 由实测推导。
 *
 * 页面外壳（侧栏 / 顶栏 / 记录流 / 资产库抽屉）与普通创作页同构，已经由
 * `create/*` 覆盖；本文件只描述**Agent 模式独有的那一层**：
 *   - 创作类型下拉从 4 项扩到 7 项，多出的三项后端未实现 → 前端占位；
 *   - 「自动」按钮展开的是**生成偏好面板**，不是模型下拉；
 *   - 「技能」是一份带搜索的富列表（官方技能，带角标与说明）；
 *   - 「@」是一个主体选择器，空态可跳转「创建主体」；
 *   - 提示词里可以打 `/` 调技能、打 `@` 调主体；
 *   - 提示词上限 20000 字，参考素材有分类型数量上限。
 *
 * 本文件只放**数据与纯函数**，不碰 React。唯一的例外是读 tokens.css
 * 尺寸令牌的那个取值函数（`readCreateSizeTokenPx`）——它读的是样式表里的
 * 声明值，不改任何状态。
 */
import type { CreateModeId } from "./createModel";

/* ── 创作类型 ───────────────────────────────────────────────────────── */

/**
 * 标准浮坞的「创作类型」下拉里，「Agent 模式」这一项的取值。
 *
 * 它不是一个生成操作（没有对应的 backend operation），只是切浮坞形态，
 * 所以用一个不会与 CreateModeId 撞车的哨兵值。
 */
export const AGENT_MODE_ENTRY_VALUE = "__agent__";

/**
 * 创作类型（Agent 模式下的「创作类型」下拉）。
 *
 * 实测：即梦这一档共 7 项，顺序为
 *   Agent 模式 / 图片生成 / 视频生成 / 音乐生成 / 音频生成 / 数字人 / 动作模仿
 *
 * 取值与即梦的 option value 对齐（静态逆向：`js/async/6856.ecad50324b.js`
 * 的 mode 表：agentic / image / video / music / audio / digitalHuman /
 * actionCopy），这样以后接后端时不用再做一次映射。
 *
 * `implemented` 标记本项目后端是否已有对应能力。前端一律照做，
 * 未实现的那几项点了会给出明确说明，而不是静默失败。
 */
export type AgentCreationModeId =
  "agentic" | "image" | "video" | "music" | "audio" | "digitalHuman" | "actionCopy";

export interface AgentCreationModeDescriptor {
  readonly id: AgentCreationModeId;
  readonly label: string;
  /**
   * 图标键，对应 `createModeIcons.tsx` 的路径表。
   *
   * 七枚图标全部取自即梦下拉的实测 DOM（24 格实心路径），因此这一档
   * 与普通创作页共用同一套图标，只是多了 Agent / 音乐 / 数字人 / 动作模仿四枚。
   */
  readonly icon: string;
  /** 后端是否已实现。false = 前端占位，提交会拦下并说明。 */
  readonly implemented: boolean;
  /**
   * 未实现时给用户的一句话说明（实测即梦把这些类型也列出来，只是后端另有体系）。
   *
   * 这句话有两处出口，都必须出现：
   *   - 下拉里那一项的第二行（`agentModePendingNote`）：点之前就能读到；
   *   - 用户点了之后的那条提示（`agentModePendingNotice`）：讲清退路。
   * 所以它只写「退到哪里去提交」，不重复类型名与通用标记。
   */
  readonly hint?: string;
}

export const AGENT_CREATION_MODES: readonly AgentCreationModeDescriptor[] = [
  {
    id: "agentic",
    label: "Agent 模式",
    icon: "agentic",
    implemented: true,
  },
  {
    id: "image",
    label: "图片生成",
    icon: "image",
    implemented: true,
  },
  {
    id: "video",
    label: "视频生成",
    icon: "video",
    implemented: true,
  },
  {
    id: "music",
    label: "音乐生成",
    icon: "music",
    implemented: false,
    hint: "按「文本生成」提交占位。",
  },
  {
    id: "audio",
    label: "音频生成",
    icon: "speech",
    implemented: true,
  },
  {
    id: "digitalHuman",
    label: "数字人",
    icon: "digitalHuman",
    implemented: false,
    hint: "按「图片生成」提交占位。",
  },
  {
    id: "actionCopy",
    label: "动作模仿",
    icon: "motion",
    implemented: false,
    hint: "按「视频生成」提交占位。",
  },
];

const MODE_FALLBACK: AgentCreationModeDescriptor = {
  id: "agentic",
  label: "Agent 模式",
  icon: "agentic",
  implemented: true,
};

export function agentCreationModeById(id: AgentCreationModeId): AgentCreationModeDescriptor {
  return AGENT_CREATION_MODES.find((mode) => mode.id === id) ?? MODE_FALLBACK;
}

/**
 * 创作类型未接入后端时，下拉里那一项的第二行说明。
 *
 * AGENTS.md「Agent 模式约定」：后端没接入的创作类型不许藏起来，也不许让
 * 用户点了才发现报错。所以下拉里就把两件事一起写出来——通用标记「后端暂未
 * 接入」+ 这一项的具体原因（退到哪条能力上提交），点之前就能读到。
 *
 * 已接入的类型返回 null（那一项没有第二行）。
 */
export function agentModePendingNote(mode: AgentCreationModeId): string | null {
  const descriptor = agentCreationModeById(mode);
  if (descriptor.implemented || descriptor.hint == null) return null;
  return `${AGENT_COPY.modePendingBadge} · ${descriptor.hint}`;
}

/**
 * 下拉里那一项的**通用标记**（第二行只放这句）。
 *
 * 即梦的创作类型浮层宽度是**固定 200px**（源码 `autoAlignPopupWidth:false` +
 * `.lv-select-popup{width:200px}`），第二行放完整的「通用标记 + 具体原因」
 * 会被截断——说明被截断就等于没写。所以下拉里只放短标记，
 * 具体原因放到选项的 tooltip（即梦对不可用项就是这么处理的：
 * `extra.tooltipProps.content`）与点击后的提示里。
 */
export function agentModePendingBadge(mode: AgentCreationModeId): string | null {
  const descriptor = agentCreationModeById(mode);
  if (descriptor.implemented) return null;
  return AGENT_COPY.modePendingBadge;
}

/**
 * 创作类型未接入后端时，用户点了要弹的那句说明。
 *
 * 与 `agentModePendingNote` 的分工：下拉里给的是「这一项什么原因」，
 * 这里给的是「点了会发生什么」——`AGENT_COPY.modePending` 讲状态，
 * `hint` 讲退路。已接入的类型返回 null（不弹）。
 */
export function agentModePendingNotice(mode: AgentCreationModeId): string | null {
  const descriptor = agentCreationModeById(mode);
  if (descriptor.implemented || descriptor.hint == null) return null;
  return `${AGENT_COPY.modePending}${descriptor.hint}`;
}

/**
 * 创作类型 → 浮坞形态。
 *
 * 即梦用 URL 的 `?type=` 区分两种浮坞：`agentic` 是 Agent 浮坞（技能 / 主体 /
 * 生成偏好），其余走参数工具条。本项目沿用同一套语义，入口仍然只有
 * `studio` 与 `create` 两个——变的是浮坞，不是入口。
 */
export type CreateComposerVariant = "agentic" | "standard";

export function composerVariantFor(mode: AgentCreationModeId): CreateComposerVariant {
  return mode === "agentic" ? "agentic" : "standard";
}

/**
 * Agent 创作类型 → 普通创作台的模式。
 *
 * 音乐 / 数字人 / 动作模仿本项目后端没有对应能力，分别落到最接近的一条：
 * 音乐走文本生成、数字人走图片生成、动作模仿走视频生成。落上去时界面会
 * 明确标出「后端暂未接入」，不会让用户以为拿到了原样的结果。
 */
export function standardModeFor(creationMode: AgentCreationModeId): CreateModeId {
  switch (creationMode) {
    case "video":
    case "actionCopy":
      return "video";
    case "audio":
      return "speech";
    case "music":
      return "text";
    case "image":
    case "digitalHuman":
      return "image";
    case "agentic":
      // Agent 模式本身没有独立的生成操作，落到图片生成这条最通用的能力上。
      return "image";
    default:
      return "image";
  }
}

/** 普通创作台的模式 → Agent 创作类型（反向映射，供标准浮坞切回 Agent 模式）。 */
export function creationModeForStandard(mode: CreateModeId): AgentCreationModeId {
  switch (mode) {
    case "video":
      return "video";
    case "text":
      return "music";
    case "speech":
      return "audio";
    case "image":
      return "image";
    default:
      return "image";
  }
}

/**
 * URL 的 `?type=` → 创作类型。
 *
 * 即梦用 `?type=agentic` 区分 Agent 浮坞，本项目沿用同一套语义：
 * 入口仍然只有 `studio` 与 `create` 两个，变的是浮坞形态。
 */
export function creationModeFromLocation(
  location: Location | null | undefined,
): AgentCreationModeId {
  if (location == null) return "video";
  const params = new URLSearchParams(location.search);
  return creationModeFromTypeParam(params.get("type"));
}

/**
 * URL 上的 `?type=` 值 → 创作类型。
 *
 * 未知值回落到**视频生成**：即梦的创作页默认落在视频生成那一档，
 * 本项目原先也以视频生成为默认入口，Agent 模式要显式 `?type=agentic` 才进。
 */
export function creationModeFromTypeParam(value: string | null | undefined): AgentCreationModeId {
  switch ((value ?? "").toLowerCase()) {
    case "agentic":
      return "agentic";
    case "image":
      return "image";
    case "music":
      return "music";
    case "speech":
    case "audio":
      return "audio";
    case "digital-human":
    case "digital_human":
    case "digitalhuman":
      return "digitalHuman";
    case "motion":
    case "action-copy":
    case "actioncopy":
      return "actionCopy";
    case "video":
      return "video";
    default:
      return "video";
  }
}

/* ── 技能 ───────────────────────────────────────────────────────────── */

/**
 * 技能（Agent 模式「技能」下拉里的一项）。
 *
 * 实测来源：`POST /mweb/v1/creation_agent/v2/skill/list`
 * 返回 `data.official_skills[]`，每项字段：
 *   id / name / default_title / default_desc / introduction /
 *   market_tag_list[] / market_enabled / showcase_media[]
 *
 * 本项目后端暂未接入技能市场（`TODO(agent-skills)`：需要一个自己的
 * 技能目录接口），因此这里内置一份**占位目录**，让前端交互完整可用。
 */
export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  /** 一句话简介：下拉里显示在名称下方。 */
  readonly description: string;
  /** 分类标签，用于后续做筛选分组。 */
  readonly tags: readonly string[];
  /** 是否官方技能（官方带「官方」角标）。 */
  readonly official: boolean;
  /** 是否启用。停用的技能不进下拉。 */
  readonly enabled: boolean;
}

export const AGENT_SKILL_CATALOG: readonly AgentSkill[] = [
  {
    id: "web_agent_skill_video_reverse",
    name: "视频反解",
    description:
      "拆解参考视频的镜头语言、光影色调与声音节奏，一键生成可用于拉片复刻、元素替换和再创作的视频 Prompt。",
    tags: ["general_creation"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_seedance_shot_design",
    name: "创作分镜",
    description:
      "面向 Seedance 视频模型的专业级虚拟导演与提示词工程师，将模糊创意转化为电影级美学视频分镜 Prompt。",
    tags: ["general_creation"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_tvc_director",
    name: "全流程广告片导演",
    description:
      "输入广告需求或一份 Brief，即可从创意、脚本、分镜到镜头、配乐分阶段生成，串成一支结构完整的商业广告片。",
    tags: ["commercial_ads"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_story",
    name: "影视故事短片",
    description: "帮你自动生成故事大纲、分镜脚本并产出短片。",
    tags: ["film_short"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_ecommerce",
    name: "电商套图",
    description: "生成风格统一的商品全套视觉素材，适用于各大电商平台。",
    tags: ["ecommerce_updated"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_poster",
    name: "海报设计",
    description: "生成更有创意的海报内容，擅长营销场景和节日热点。",
    tags: ["graphic_design"],
    official: true,
    enabled: true,
  },
  {
    id: "web_agent_skill_brand",
    name: "Logo设计",
    description: "根据公司名称、业务与客群，生成品牌 Logo 与视觉方案。",
    tags: ["graphic_design"],
    official: true,
    enabled: true,
  },
];

/** 下拉里可见的技能：只留启用的。 */
export function enabledAgentSkills(
  skills: readonly AgentSkill[] = AGENT_SKILL_CATALOG,
): readonly AgentSkill[] {
  return skills.filter((skill) => skill.enabled);
}

/**
 * 技能搜索。
 *
 * 实测：即梦的技能下拉顶部有搜索框，命中名称或简介才会留下这一项。
 */
export function filterAgentSkills(
  skills: readonly AgentSkill[],
  query: string,
): readonly AgentSkill[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === "") return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(keyword) ||
      skill.description.toLowerCase().includes(keyword) ||
      skill.tags.some((tag) => tag.toLowerCase().includes(keyword)),
  );
}

/* ── 主体（@） ──────────────────────────────────────────────────────── */

/**
 * 主体（Agent 模式 `@` 能引用到的对象）。
 *
 * 实测来源：`POST /mweb/v1/dreamina_subject/get`
 * → `data.data_list[]`，每项：
 *   `{ subjectId, dataId, name, content: { mainImage, auxiliaryImages,
 *     videoInfo, audioInfo, selectedVoice } }`
 *
 * 静态逆向确认：引用 id = `"${subjectId}-${dataId}"`（`js/async/1167` 的
 * `function r(e){return"".concat(e.subjectId,"-").concat(e.dataId)}`），
 * 编辑器里的 chip 文本就是 `@<该 id>`；但**提交时**渲染成主体名
 * （`js/async/4004` 的 `_transformPromptContentsToText`：主体取
 * `subject.content.name`）。两种形态都要留着。
 */
export interface AgentSubject {
  readonly subjectId: string;
  readonly dataId: string;
  readonly name: string;
  /** 引用 id：`${subjectId}-${dataId}`。 */
  readonly referenceId: string;
  /** 缩略图地址；缺省时按姓名首字渲染占位块。 */
  readonly thumbnailUrl?: string;
  /** 主体类型：由 content.videoInfo / content.audioInfo 推导（image/video/audio）。 */
  readonly type: "image" | "video" | "audio";
}

/** 由主体原始字段拼出引用 id。 */
export function agentSubjectReferenceId(subjectId: string, dataId: string): string {
  return `${subjectId}-${dataId}`;
}

/* ── 生成偏好 ───────────────────────────────────────────────────────── */

/**
 * 生成偏好（点「自动」按钮展开的面板）。
 *
 * 实测：面板 486×303，浮层内容 padding 16px，三个分区：
 *   1. 生成偏好：右侧一个「自动」开关 + 图片／视频 单选；
 *   2. 选择比例：智能 + 8 个固定比例的单选卡；
 *   3. 其他设置：模型下拉（实测显示 "Seedream 5.0 Pro"）。
 */
export interface AgentPreferences {
  /** 自动：开了之后由后端自己决定产物类型与参数。 */
  readonly auto: boolean;
  /** 产物类型。 */
  readonly outputType: "image" | "video";
  /** 比例；`auto` = 智能比例。 */
  readonly aspectRatio: string;
  /** 指定模型；null = 跟随默认。 */
  readonly modelDefinitionId: string | null;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  auto: true,
  outputType: "image",
  aspectRatio: "auto",
  modelDefinitionId: null,
};

/* ── 提交载荷 ───────────────────────────────────────────────────────── */

/**
 * Agent 模式的提交载荷（前端侧的数据契约）。
 *
 * 静态逆向（`js/async/5258.d72d6ab459.js` @16626）确认：Agent 模式**不走**
 * 普通生图/生视频的 `/mweb/v1/aigc_draft/generate`，而是走对话式流端点
 * `/mweb/v1/creation_agent/v2/conversation`，载荷形状如下：
 *
 *   projectId / conversationId / submitId / messageId / files /
 *   referenceInfo / generateArgs / inferenceModelId / creationMode /
 *   creativeModelEnabled / searchEnabled / workspaceId / metricsExtra
 *
 * 本项目后端尚未接入这条流（`TODO(agent-runtime)`），所以这里先把载荷
 * **结构**定下来：前端把它组装好放进请求，接上后端时只差一个传输函数。
 */
export interface AgentSubmissionPayload {
  /** 会话 id：Agent 模式是多轮对话，一次提交属于某个会话。 */
  readonly conversationId: string;
  /** 提交 id 与消息 id 同值（实测为 UUID 串）。 */
  readonly submitId: string;
  readonly messageId: string;
  /** 参考素材（按即梦的 Nuro 文件形状）。 */
  readonly files: readonly AgentSubmissionFile[];
  /** 主体等引用信息。 */
  readonly referenceInfo: readonly AgentReferenceInfo[];
  /** 落到模型侧的生成参数。 */
  readonly generateArgs: Readonly<Record<string, unknown>>;
  /** 推理模型（Agent 自身的推理模型，与生成模型不是一回事）。 */
  readonly inferenceModelId: string | null;
  /** 当前创作类型：agentic / image / video / music / audio / digitalHuman / actionCopy。 */
  readonly creationMode: AgentCreationModeId;
  /** 是否启用创意模型（创作增强）。 */
  readonly creativeModelEnabled: boolean;
  /** 是否允许 Agent 联网检索。 */
  readonly searchEnabled: boolean;
  readonly workspaceId: string | null;
  /** 提示词正文（已把技能与主体合成为纯文本）。 */
  readonly prompt: string;
  /** 提示词的结构化内容（正文 / 主体 / 技能 / 引用……）。 */
  readonly promptContents: readonly AgentPromptContent[];
}

/** 提交载荷里的参考素材条目。 */
export interface AgentSubmissionFile {
  readonly id: string;
  readonly name: string;
  readonly mediaType: "image" | "video" | "audio";
  /** 素材在本机的路径或云端素材 id。 */
  readonly source: string;
}

/** 提交载荷里的引用信息条目（主体等）。 */
export interface AgentReferenceInfo {
  readonly type: "subject";
  readonly subjectId: string;
  readonly dataId: string;
  readonly name: string;
  readonly contentType: "image" | "video" | "audio";
}

/**
 * 提示词的结构化内容。
 *
 * 实测即梦的 `promptContents` 是一个联合类型数组：text / subject /
 * reference-resource / reference-frame / reference-text / skill /
 * create-skill-template-slot。本项目目前只需要前四种。
 */
export type AgentPromptContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "subject"; readonly id: string; readonly name: string }
  | {
      readonly type: "reference-resource";
      readonly resourceId: string;
      readonly mediaType: "image" | "video" | "audio";
    }
  | { readonly type: "skill"; readonly id: string; readonly displayName: string };

/* ── 限制与文案 ─────────────────────────────────────────────────────── */

/**
 * 参考素材限制。
 *
 * 实测来源：`POST /mweb/v1/creation_agent/v2/get_agent_config`
 * → `data.reference_resource_config`
 */
export const AGENT_REFERENCE_LIMITS = {
  maxResourceCount: 50,
  maxImageCount: 30,
  maxVideoCount: 10,
  maxAudioCount: 10,
  maxVideoFileSizeMb: 200,
  maxAudioFileSizeMb: 15,
  minVideoDuration: 1.8,
  maxVideoDuration: 30.2,
  minAudioDuration: 1.8,
  maxAudioDuration: 30.2,
} as const;

/** 提示词上限。实测：`data.prompt_max_length = 20000`。 */
export const AGENT_PROMPT_MAX_LENGTH = 20000;

/** Agent 模式的固定文案。 */
export const AGENT_COPY = {
  promptPlaceholderLead: "输入想法、剧本或上传参考，支持",
  promptPlaceholderSlash: "使用技能",
  promptPlaceholderAt: "添加主体",
  promptPlaceholderTail: "，和 Agent 一起创作",
  skillSearchPlaceholder: "搜索技能",
  skillLibraryLabel: "更多技能",
  skillEmpty: "没有匹配的技能",
  subjectTitle: "可能@的内容",
  subjectEmpty: "你还没有创建过主体",
  subjectCreate: "创建主体",
  preferencesTitle: "生成偏好",
  preferencesAuto: "自动",
  preferencesRatioTitle: "选择比例",
  preferencesOtherTitle: "其他设置",
  outputImage: "图片",
  outputVideo: "视频",
  voiceIdle: "语音输入",
  voiceUnavailable: "语音输入后端暂未接入。",
  agentPending: "Agent 编排后端暂未接入：本次按所选模型直接提交生成。",
  modePending: "该创作类型后端暂未接入。",
  /** 通用标记：下拉里那一项的第二行先给这句，再给具体原因。 */
  modePendingBadge: "后端暂未接入",
} as const;

/**
 * Agent 编排后端暂未接入时的说明。
 *
 * 本项目没有 Agent 对话流运行时（`TODO(agent-runtime)`）：Agent 模式
 * 提交时是按所选模型直接提交生成，不走即梦那套 Agent 编排。创作台在提交
 * 前用这句把真实情况讲清楚——不能让用户以为编排跑过了。
 *
 * 出口在创作台（`CreateSurface.tsx` 的 `agentSubmit`），本文件只提供文案。
 */
export const AGENT_PENDING_NOTICE = AGENT_COPY.agentPending;

/* ── 浮层尺寸令牌 ─────────────────────────────────────────────────── */

/**
 * 三块 Agent 浮层的宽度令牌（tokens.css）。
 *
 * 实测宽度：技能 365、主体 240、生成偏好 486。这三个数在 tokens.css 里
 * 各有一个令牌，代码里不再写死——令牌改了，浮层宽度跟着改。
 */
export const AGENT_POPUP_WIDTH_TOKENS = {
  skill: "--size-create-agentic-popup-skill",
  subject: "--size-create-agentic-popup-subject",
  preferences: "--size-create-agentic-popup-preferences",
} as const;

/**
 * 读 tokens.css 里的尺寸令牌，换算成 px。
 *
 * 为什么要在运行时读：浮层的宽度是**给浮层定位用的**（`useFloatingLayerAnchor`
 * 拿它算左边缘与右边界），所以必须是一个数字，不能只写在 CSS 里。
 * 令牌里存的是 rem，这里按根字号换算成 px。
 *
 * 读不到时（例如 jsdom 单测不加载样式表）退回调用方给的实测值，界面
 * 仍然是即梦那个宽度。
 */
export function readCreateSizeTokenPx(token: string, fallbackPx: number): number {
  if (typeof document === "undefined" || typeof window === "undefined") return fallbackPx;
  const root = document.documentElement;
  const raw = window.getComputedStyle(root).getPropertyValue(token).trim();
  if (raw === "") return fallbackPx;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallbackPx;
  if (raw.endsWith("px")) return value;
  if (!raw.endsWith("rem")) return fallbackPx;
  const rootFontSize = Number.parseFloat(window.getComputedStyle(root).fontSize);
  return value * (Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16);
}

/* ── 提示词合成 ─────────────────────────────────────────────────────── */

/**
 * 把 Agent 模式下用户分散给出的信息合成一条可提交的提示词。
 *
 * 三个来源：
 *   - 用户在编辑框里写的正文；
 *   - 选中的技能（附一句技能说明，让模型知道按什么套路来）；
 *   - 已插入的 `@主体` 引用。
 *
 * 即梦把这三样塞进一次 agent 请求里交给 Agent 编排；本项目没有 Agent 编排
 * 运行时（`TODO(agent-runtime)`），所以在客户端合成——这是唯一能保持
 * 「前端完整可用」的位置。
 */
export function composeAgentPrompt(input: {
  readonly prompt: string;
  readonly skill: AgentSkill | null;
  readonly subjects: readonly AgentSubject[];
}): string {
  const parts: string[] = [];
  const body = input.prompt.trim();
  if (body !== "") parts.push(body);
  if (input.skill != null) {
    parts.push(`【技能：${input.skill.name}】${input.skill.description}`);
  }
  if (input.subjects.length > 0) {
    parts.push(`【主体】${input.subjects.map((subject) => subject.name).join("、")}`);
  }
  return parts.join("\n");
}

/**
 * 提示词的结构化内容。
 *
 * 实测即梦的提交文本里，主体渲染成 `subject.content.name`，其余引用按
 * `id → 文本` 映射表取值（`js/async/4004`）。这里保持同样语义：
 * 主体给名字，技能给显示名，参考素材保留自己的类型。
 */
export function composeAgentPromptContents(input: {
  readonly prompt: string;
  readonly skill: AgentSkill | null;
  readonly subjects: readonly AgentSubject[];
  readonly references: readonly {
    readonly id: string;
    readonly mediaType: "image" | "video" | "audio";
  }[];
}): readonly AgentPromptContent[] {
  const contents: AgentPromptContent[] = [];
  const body = input.prompt.trim();
  if (body !== "") contents.push({ type: "text", text: body });
  if (input.skill != null) {
    contents.push({
      type: "skill",
      id: input.skill.id,
      displayName: input.skill.name,
    });
  }
  for (const subject of input.subjects) {
    contents.push({
      type: "subject",
      id: subject.referenceId,
      name: subject.name,
    });
  }
  for (const reference of input.references) {
    contents.push({
      type: "reference-resource",
      resourceId: reference.id,
      mediaType: reference.mediaType,
    });
  }
  return contents;
}

/** 提示词是否超长。 */
export function isPromptOverLimit(prompt: string): boolean {
  return prompt.length > AGENT_PROMPT_MAX_LENGTH;
}
