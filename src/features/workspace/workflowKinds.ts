/*
 * 工作流类型（workflow kind）一等注册表。
 *
 * 为什么需要这一层
 * ----------------
 * 「有哪 11 类工作流」此前散落成多份平行映射：节点内的 isXxx 布尔级联与
 * workflowKind 三元链、历史执行层的 workflowKindForNode / TITLES /
 * defaultRunnerFactory / modelSnapshots 角色三元、插入入口的 kind→模板 /
 * kind→标题 / toast 文案三元、仓库里 11 张手写卡片、
 * lib/workflowHistory 的联合类型与 valibot picklist。每新增一个工作流要在
 * 十来个文件里逐处登记，且三套判定级联的优先顺序互不一致，只靠「一个配置
 * 只会带一个工作流字段」这一未成文约定才没有出错。
 *
 * 本模块把「一个工作流类型」的全部元数据收进一条注册，并只在此处声明一次
 * 判定优先级（= 注册顺序 = 仓库卡片顺序）。新增工作流 = 新增 model/runner/
 * 模板三件套 + 在 WORKFLOW_KINDS 里加一条注册，其余分发点自动跟随。
 *
 * 维护规则
 * --------
 * - 注册顺序是判定优先级，也是仓库卡片顺序；调整顺序前先读
 *   `detect` 的注释。
 * - `knowledge` 是缺省类型：没有任何专属字段命中的配置都落到它
 *   （见 `detectKnowledge`）。
 * - 各 `*Title` 是四套并存的产品文案（节点标题 / 历史名 / 插入 toast），
 *   刻意不合并；统一文案属于产品决策，不属于本模块。
 * - id 必须与 Rust 侧 `WorkflowKind`（src-tauri storage/workflow_history.rs）
 *   的 as_str 一一对应，workflowKinds.test.ts 与 Rust 测试两侧锁死。
 */
import type { IconName } from "../../components/Icon";
import type { KnowledgeVideoWorkflowCheckpoint, KnowledgeVideoWorkflowConfig } from "./workspaceModel";
import type { WorkflowRequirements } from "./workflowFieldRequirements";
import type {
  KnowledgeVideoWorkflowRunner,
  RecordedClients,
} from "./workflowRunnerContract";
import type {
  CreateKnowledgeVideoDirectorWorkflowOptions,
  WorkflowTemplateSubgraph,
} from "./workflowTemplates";
import { aiFilmDeliveryMarkdown } from "./aiFilmWorkflowModel";
import { comicDramaDeliveryMarkdown } from "./comicDramaWorkflowModel";
import { musicVideoDeliveryMarkdown } from "./musicVideoWorkflowModel";
import { commerceDeliveryMarkdown } from "./commerceWorkflowModel";
import { brandVideoDeliveryMarkdown } from "./brandVideoWorkflowModel";
import { remotionDeliveryMarkdown } from "./remotionWorkflowModel";
import { xhsCoverDeliveryMarkdown } from "./xhsCoverWorkflowModel";
import { productSceneQualityEnabled, productSceneRequirements, createProductSceneOptions } from "./productSceneWorkflowModel";
import { reelbenchRequirements, createReelbenchOptions } from "./reelbenchWorkflowModel";
import { reverseVideoRequirements, createReverseVideoOptions } from "./reverseVideoWorkflowModel";
import { musicVideoRequirements, createMusicVideoOptions } from "./musicVideoWorkflowModel";
import { comicDramaRequirements, createComicDramaOptions } from "./comicDramaWorkflowModel";
import { commerceRequirements, createCommerceOptions } from "./commerceWorkflowModel";
import { brandVideoRequirements, createBrandVideoOptions } from "./brandVideoWorkflowModel";
import { remotionRequirements } from "./remotionWorkflowModel";
import { xhsCoverRequirements, createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import { createProductSceneWorkflowRunner } from "./productSceneWorkflowRunner";
import { createReelbenchWorkflowRunner } from "./reelbenchWorkflowRunner";
import { createReverseVideoWorkflowRunner } from "./reverseVideoWorkflowRunner";
import { createMusicVideoWorkflowRunner } from "./musicVideoWorkflowRunner";
import { createComicDramaWorkflowRunner } from "./comicDramaWorkflowRunner";
import { createCommerceWorkflowRunner } from "./commerceWorkflowRunner";
import { createBrandVideoWorkflowRunner } from "./brandVideoWorkflowRunner";
import { createAiFilmWorkflowRunner } from "./aiFilmWorkflowRunner";
import { createRemotionWorkflowRunner } from "./remotionWorkflowRunner";
import { createXhsCoverWorkflowRunner } from "./xhsCoverWorkflowRunner";
import { createKnowledgeVideoWorkflowRunner } from "./knowledgeVideoWorkflowRunner";

export type WorkflowKind =
  | "knowledge"
  | "film"
  | "comicDrama"
  | "musicVideo"
  | "brandVideo"
  | "commerce"
  | "remotion"
  | "xhsCover"
  | "productScene"
  | "reverseVideo"
  | "reelbench";

/** 历史记录里按角色快照的模型槽位。 */
export type WorkflowModelRole = "text" | "image" | "video";

/** 插入模板工厂；经动态 import 保持工作流模板代码的分块加载。 */
export type WorkflowTemplateFactory = (
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
) => WorkflowTemplateSubgraph;

/** 工作流仓库卡片的展示数据；文案逐字保留自原手写卡片。 */
export interface WorkflowRepositoryCard {
  readonly icon: IconName;
  readonly title: string;
  readonly description: string;
  /** 卡片下方的四段能力标签。 */
  readonly stages: readonly string[];
  /** 知识视频卡片的既有版式：能力标签前渲染两位序号。 */
  readonly numberedStages?: boolean;
  readonly insertLabel: string;
  readonly insertAriaLabel?: string;
}

export interface WorkflowKindDefinition {
  readonly id: WorkflowKind;
  /**
   * 判定：该配置是否属于本类型。按 WORKFLOW_KINDS 注册顺序逐条尝试，
   * 首个命中即成立。缺省类型 knowledge 的判定由 `detectKnowledge` 表达。
   */
  readonly detect: (config: KnowledgeVideoWorkflowConfig) => boolean;
  /** 节点卡片标题栏的模板名。 */
  readonly nodeTitle: string;
  /** 历史记录列表里的工作流名。 */
  readonly historyTitle: string;
  /** 从仓库插入成功后的 toast 标题（正文是「…工作流已放入画布」）。 */
  readonly insertTitle: string;
  readonly insertToastDescription: string;
  /** 尚缺必填项；各工作流模型的 `*Requirements()` 是唯一来源。 */
  readonly requirements: (config: KnowledgeVideoWorkflowConfig) => WorkflowRequirements;
  /** 历史记录的模型角色快照范围。 */
  readonly historyRoles: (config: KnowledgeVideoWorkflowConfig) => readonly WorkflowModelRole[];
  readonly createRunner: (clients: RecordedClients) => KnowledgeVideoWorkflowRunner;
  readonly loadTemplate: () => Promise<WorkflowTemplateFactory>;
  readonly repository: WorkflowRepositoryCard;
  /** 「导出制作文档」的正文构建器；不支持文档交付的类型缺省。 */
  readonly deliveryMarkdown?: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => string;
}

/** 知识视频是缺省类型：其余 10 个类型的专属字段一个都没有的配置都属于它。 */
const detectKnowledge = (config: KnowledgeVideoWorkflowConfig): boolean =>
  WORKFLOW_KINDS.every((entry) => entry.id === "knowledge" || !entry.detect(config));

const KNOWLEDGE_VIDEO_STAGES: readonly string[] = ["智能策划", "自动生成", "质量检查", "成片交付"];

/**
 * 全部工作流类型的注册表。
 * 注册顺序 = 判定优先级 = 仓库卡片顺序（逐字保留原卡片排列）。
 */
export const WORKFLOW_KINDS: readonly WorkflowKindDefinition[] = [
  {
    id: "productScene",
    detect: (config) => config.productScene != null,
    nodeTitle: "产品场景图工作流",
    historyTitle: "产品场景图",
    insertTitle: "产品场景图",
    insertToastDescription:
      "添加同一版本的产品参考图，使用 AI 多机位分批制作 3:4 或 9:16 场景图，并逐张审核。",
    // 字段缺失（kind 未命中时被误调）按全新模板的缺口清单回答。
    requirements: (config) =>
      productSceneRequirements(config.productScene ?? createProductSceneOptions()),
    historyRoles: (config) =>
      config.productScene && productSceneQualityEnabled(config.productScene)
        ? (["text", "image"] as const)
        : (["image"] as const),
    createRunner: (clients) => createProductSceneWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createProductSceneWorkflow),
    repository: {
      icon: "stack-simple",
      title: "产品场景图工作流",
      description:
        "上传同一产品参考图，以 AI 多机位组合拍摄角度与场景；也可选择原图保真合成。分批制作、逐张审核后导出。",
      stages: ["产品确认", "分批制作", "逐张审核", "图片导出"],
      insertLabel: "添加产品场景图",
      insertAriaLabel: "添加产品场景图工作流节点",
    },
  },
  {
    id: "reelbench",
    detect: (config) => config.reelbench != null,
    nodeTitle: "视频拉片与分镜合成",
    historyTitle: "视频拉片与分镜合成",
    insertTitle: "视频拉片与分镜合成",
    insertToastDescription:
      "选择本地视频，确认计划后测量切点、标注镜头，批量审核并导出报告和同步分镜视频。",
    requirements: (config) =>
      reelbenchRequirements(config.reelbench ?? createReelbenchOptions()),
    historyRoles: () => ["text"] as const,
    createRunner: (clients) => createReelbenchWorkflowRunner({ promptClient: clients.promptClient }),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createReelbenchWorkflow),
    repository: {
      icon: "film-slate",
      title: "视频拉片与分镜合成",
      description:
        "读取本地视频，测量逐镜切点与运动，结合项目视觉模型标注镜头；审核后导出镜头报告与同步分镜视频。",
      stages: ["本地切镜", "逐镜标注", "批量审核", "报告与视频"],
      insertLabel: "添加拉片工作流",
      insertAriaLabel: "添加视频拉片与分镜合成工作流节点",
    },
  },
  {
    id: "musicVideo",
    detect: (config) => config.musicVideo != null,
    nodeTitle: "音乐 MV 工作流 V1.0.6",
    historyTitle: "音乐 MV",
    insertTitle: "音乐 MV",
    insertToastDescription: "选择原曲，逐阶段确认歌词、风格与分镜，审核首镜和片段后合成 MV。",
    requirements: (config) =>
      musicVideoRequirements(config.musicVideo ?? createMusicVideoOptions()),
    historyRoles: (config) =>
      config.musicVideo?.deliverable === "documents"
        ? (["text"] as const)
        : (["text", "image", "video"] as const),
    createRunner: (clients) => createMusicVideoWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createMusicVideoWorkflow),
    repository: {
      icon: "film-slate",
      title: "音乐 MV 工作流 V1.0.6",
      description:
        "以原曲为时间轴，确认歌词、风格、人物和分镜，首镜试产通过后生成全片，按音乐窗口合成并保留制作版本。",
      stages: ["歌曲与歌词", "风格与分镜", "首镜与片段审核", "原曲合成交付"],
      insertLabel: "添加 MV 工作流",
      insertAriaLabel: "添加音乐 MV 工作流节点",
    },
    deliveryMarkdown: musicVideoDeliveryMarkdown,
  },
  {
    id: "reverseVideo",
    detect: (config) => config.reverseVideo != null,
    nodeTitle: "短视频反推工作流",
    historyTitle: "短视频反推",
    insertTitle: "短视频反推",
    insertToastDescription: "粘贴视频链接或选择本地视频，自动下载、拆解并交付提示词与二创方案。",
    requirements: (config) =>
      reverseVideoRequirements(config.brief, config.reverseVideo ?? createReverseVideoOptions()),
    historyRoles: () => ["text"] as const,
    createRunner: (clients) =>
      createReverseVideoWorkflowRunner({ promptClient: clients.promptClient }),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createReverseVideoWorkflow),
    repository: {
      icon: "film-slate",
      title: "短视频反推工作流",
      description:
        "粘贴分享链接或选择本地视频，由项目下载器获取原片，自动抽帧、反推提示词与二创路线，校验后保存案例和交付文档。",
      stages: ["下载与抽帧", "反推与二创", "检查与入库", "文档交付"],
      insertLabel: "添加反推工作流",
      insertAriaLabel: "添加短视频反推工作流节点",
    },
  },
  {
    id: "xhsCover",
    detect: (config) => config.xhsCover != null,
    nodeTitle: "小红书封面工作流",
    historyTitle: "小红书封面",
    insertTitle: "小红书封面",
    insertToastDescription: "添加人物参考图和选题，使用项目模型自动制作 3:4 封面。",
    requirements: (config) =>
      xhsCoverRequirements(config.brief, config.xhsCover ?? createXhsCoverOptions()),
    historyRoles: (config) =>
      config.xhsCover?.deliverable === "prompt"
        ? (["text"] as const)
        : (["text", "image"] as const),
    createRunner: (clients) => createXhsCoverWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createXhsCoverWorkflow),
    repository: {
      icon: "stack-simple",
      title: "小红书封面工作流",
      description:
        "填写选题即可开始；想沿用真人形象时再添加人物参考图。自动提炼标题、匹配八种风格、生成与检查封面，交付 3:4 竖版图片及提示词。",
      stages: ["标题与风格", "参考图生成", "自动检查", "封面交付"],
      insertLabel: "添加封面工作流",
      insertAriaLabel: "添加小红书封面工作流节点",
    },
    deliveryMarkdown: xhsCoverDeliveryMarkdown,
  },
  {
    id: "knowledge",
    detect: detectKnowledge,
    nodeTitle: "知识视频工作流",
    historyTitle: "知识视频",
    insertTitle: "知识教学视频",
    insertToastDescription: "填写制作要求并点击开始，其余步骤由节点自动完成。",
    requirements: (config) =>
      config.brief.trim()
        ? []
        : [
            {
              field: "制作要求",
              hint: "用一句话说明要做什么；画幅、时长等细节可以留给工作流自动决定。",
            },
          ],
    historyRoles: () => ["text", "image", "video"] as const,
    createRunner: (clients) => createKnowledgeVideoWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createKnowledgeVideoDirectorWorkflow),
    repository: {
      icon: "film-slate",
      title: "知识教学视频导演 V2.4",
      description:
        "画布只增加一个节点。使用项目内已配置的模型，确认计划后按依赖执行，检查片段后合成交付。",
      stages: KNOWLEDGE_VIDEO_STAGES,
      numberedStages: true,
      insertLabel: "添加工作流节点",
    },
  },
  {
    id: "film",
    detect: (config) => config.film != null,
    nodeTitle: "AI影视工作流",
    historyTitle: "影视制作",
    insertTitle: "AI影视",
    insertToastDescription: "填写制作要求并点击开始，其余步骤由节点自动完成。",
    requirements: (config) =>
      config.brief.trim()
        ? []
        : [
            {
              field: "制作要求",
              hint: "用一句话说明要做什么；画幅、时长等细节可以留给工作流自动决定。",
            },
          ],
    historyRoles: () => ["text", "image", "video"] as const,
    createRunner: (clients) => createAiFilmWorkflowRunner(clients),
    loadTemplate: () => import("./workflowTemplates").then((module) => module.createAiFilmWorkflow),
    repository: {
      icon: "film-slate",
      title: "AI影视工作流 V1.3",
      description:
        "从故事概念到角色、剧本、资产、表演与视频，八个阶段自动衔接。支持已有资料接力和指定阶段修订。",
      stages: ["故事与剧本", "角色与场景", "表演与镜头", "成片交付"],
      insertLabel: "添加影视工作流",
      insertAriaLabel: "添加AI影视工作流节点",
    },
    // 与原导出闸门同语义：没有已完成的影视产物就不产文档正文。
    deliveryMarkdown: (checkpoint) =>
      checkpoint.film?.artifacts.length ? aiFilmDeliveryMarkdown(checkpoint) : "",
  },
  {
    id: "comicDrama",
    detect: (config) => config.comicDrama != null,
    nodeTitle: "动漫短剧工作流 V2.3",
    historyTitle: "漫剧制作",
    insertTitle: "漫剧自动",
    insertToastDescription: "在节点中添加各集剧本，点击开始后自动完成导演、服化道与分镜。",
    requirements: (config) =>
      comicDramaRequirements(config.comicDrama ?? createComicDramaOptions()),
    historyRoles: () => ["text", "image", "video"] as const,
    createRunner: (clients) => createComicDramaWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createComicDramaWorkflow),
    repository: {
      icon: "film-slate",
      title: "动漫短剧工作流 V2.3",
      description:
        "剧本共创、风格锁定、服化道、导演分镜与执行提示词逐阶段确认。检查资产、首镜与全部片段后合成，交付制作四件套。",
      stages: ["剧本与风格", "资产与分镜", "首镜与批量审核", "成片与四件套"],
      insertLabel: "添加漫剧工作流",
      insertAriaLabel: "添加漫剧自动工作流节点",
    },
    deliveryMarkdown: comicDramaDeliveryMarkdown,
  },
  {
    id: "commerce",
    detect: (config) => config.commerce != null,
    nodeTitle: "剧情带货工作流",
    historyTitle: "带货创作",
    insertTitle: "剧情带货",
    insertToastDescription: "添加产品原图与资料，配置项目模型后自动制作剧情带货视频。",
    requirements: (config) => commerceRequirements(config.commerce ?? createCommerceOptions()),
    historyRoles: () => ["text", "image", "video"] as const,
    createRunner: (clients) => createCommerceWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createCommerceWorkflow),
    repository: {
      icon: "film-slate",
      title: "剧情带货工作流",
      description:
        "添加商品资料与实物图，快速生成 15 秒四镜头剧情，或完成五阶段制作。自动检查商品事实与包装一致性，交付文档和成片。",
      stages: ["商品研究", "剧情与剧本", "分镜与资产", "成片交付"],
      insertLabel: "添加带货工作流",
      insertAriaLabel: "添加剧情带货工作流节点",
    },
    deliveryMarkdown: commerceDeliveryMarkdown,
  },
  {
    id: "brandVideo",
    detect: (config) => config.brandVideo != null,
    nodeTitle: "品牌视觉短片工作流",
    historyTitle: "品牌视频",
    insertTitle: "品牌视觉短片",
    insertToastDescription: "填写系列或节日创意，选择已定稿模特及商品参考，审核首镜后制作品牌短片。",
    requirements: (config) =>
      brandVideoRequirements(config.brandVideo ?? createBrandVideoOptions()),
    historyRoles: (config) =>
      config.brandVideo?.deliverable === "documents"
        ? (["text"] as const)
        : (["text", "video"] as const),
    createRunner: (clients) => createBrandVideoWorkflowRunner(clients),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createBrandVideoWorkflow),
    repository: {
      icon: "film-slate",
      title: "品牌视觉短片工作流",
      description:
        "围绕新品、系列或节日制作品牌短片，复用已定稿数字模特与商品原图。先审核概念与分镜，再看首镜试产，选用片段后合成。",
      stages: ["品牌概念", "分镜与身份参考", "首镜试产", "审核与成片"],
      insertLabel: "添加品牌视频工作流",
      insertAriaLabel: "添加品牌视觉短片工作流节点",
    },
    deliveryMarkdown: brandVideoDeliveryMarkdown,
  },
  {
    id: "remotion",
    detect: (config) => config.remotion != null,
    nodeTitle: "动画逻辑图工作流",
    historyTitle: "动画制作",
    insertTitle: "动画逻辑图",
    insertToastDescription: "描述动画或粘贴 ASCII 草图，选择项目文本模型后自动渲染。",
    requirements: (config) => remotionRequirements(config.brief),
    historyRoles: () => ["text"] as const,
    createRunner: (clients) => createRemotionWorkflowRunner({ promptClient: clients.promptClient }),
    loadTemplate: () =>
      import("./workflowTemplates").then((module) => module.createRemotionWorkflow),
    repository: {
      icon: "film-slate",
      title: "动画逻辑图工作流",
      description:
        "输入描述或 ASCII 草图，自动匹配流程、卡片、时间线与数据图模板。在本机渲染 GIF 或 MP4，并交付可编辑工程。",
      stages: ["理解内容", "匹配与检查", "本地渲染", "动画交付"],
      insertLabel: "添加动画工作流",
      insertAriaLabel: "添加动画逻辑图工作流节点",
    },
    deliveryMarkdown: remotionDeliveryMarkdown,
  },
];

/** 全部类型 id，顺序同注册表；valibot picklist 与 Rust parity 测试共同消费。 */
export const WORKFLOW_KIND_IDS: readonly WorkflowKind[] = WORKFLOW_KINDS.map((entry) => entry.id);

const WORKFLOW_KIND_DEFINITIONS = Object.fromEntries(
  WORKFLOW_KINDS.map((entry) => [entry.id, entry]),
) as Record<WorkflowKind, WorkflowKindDefinition>;

/**
 * 配置 → 工作流类型的唯一判定入口。
 * 按注册顺序首个 `detect` 命中即成立；全部未命中落到缺省的 knowledge。
 */
export function workflowKindOf(config: KnowledgeVideoWorkflowConfig): WorkflowKind {
  return WORKFLOW_KINDS.find((entry) => entry.detect(config))?.id ?? "knowledge";
}

/** 工作流类型 → 注册条目。联合类型已穷尽，恒有返回。 */
export function workflowKindDefinitionOf(kind: WorkflowKind): WorkflowKindDefinition {
  return WORKFLOW_KIND_DEFINITIONS[kind];
}
