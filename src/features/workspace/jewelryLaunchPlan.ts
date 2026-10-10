import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { ProductSceneView, ProductSceneWorkflowOptions } from "./productSceneWorkflowModel";
import type { BrandDesignDocument } from "./brandDesignModel";

export interface JewelryLaunchOptions {
  readonly factsText?: string;
  readonly draft?: JewelryLaunchDraft;
  /** Local editable design; never authorizes a model request. */
  readonly design?: BrandDesignDocument;
}

export type JewelryLaunchFactStatus = "input" | "merchant_provided" | "strategy" | "unknown";
export interface JewelryLaunchVariable {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly status: JewelryLaunchFactStatus;
  readonly source: string;
}

export type JewelryLaunchSlotId =
  "M01" | "M02" | "M03" | "M04" | "M05" | "D01" | "D02" | "D03" | "D04" | "D05";
export interface JewelryLaunchSource {
  readonly viewId: string;
  readonly label: string;
  readonly sourcePath: string;
  readonly preparedPath: string;
  readonly contentHash: string;
  readonly photoRole?: "full" | "detail" | "wearing";
}
export interface JewelryLaunchSlot {
  readonly id: JewelryLaunchSlotId;
  readonly title: string;
  readonly purpose: string;
  readonly source?: JewelryLaunchSource;
  readonly sourceStatus: "tagged" | "unclassified" | "missing";
  readonly sourceNotes: readonly string[];
  readonly copy: { readonly title: string; readonly body: string };
  readonly method: "source_layout" | "source_clean_white" | "missing_source";
  readonly prompt: string;
  /** Optional background-only template, never permission to submit a model request. */
  readonly backgroundPrompt?: string;
}
export interface JewelryLaunchDraft {
  readonly schemaVersion: 1;
  readonly ruleVersion: string;
  readonly revision: number;
  readonly inputSignature: string;
  readonly productName: string;
  readonly variables: readonly JewelryLaunchVariable[];
  readonly positioning: string;
  readonly audience: string;
  readonly sellingPoints: readonly string[];
  readonly slots: readonly JewelryLaunchSlot[];
  readonly styleRules: readonly string[];
  readonly qualityChecks: readonly string[];
  readonly merchantConfirmations: readonly string[];
  readonly notes: readonly string[];
}

const RULE_VERSION = "Jewelry Brand OS · System + Brand Core 2.6 / 本地十图策划 v1";
const UNKNOWN = "需商家确认";
const FACT_FIELDS = [
  { key: "material", label: "主体材质", aliases: ["材质", "主体材质", "主材质", "商品材质"] },
  {
    key: "metalMaterial",
    label: "配件材质",
    aliases: ["配件材质", "金属材质", "金属配件材质"],
  },
  { key: "size", label: "商品尺寸", aliases: ["尺寸", "商品尺寸"] },
  { key: "beadSize", label: "珠径", aliases: ["珠径", "珠子尺寸"] },
  { key: "length", label: "长度", aliases: ["长度", "链长", "手围"] },
  { key: "weight", label: "重量", aliases: ["重量", "克重"] },
  { key: "color", label: "颜色", aliases: ["颜色", "配色"] },
  { key: "specification", label: "销售规格", aliases: ["规格", "销售规格"] },
  { key: "craft", label: "工艺", aliases: ["工艺", "制作工艺"] },
  { key: "naturalness", label: "天然属性", aliases: ["天然属性", "是否天然"] },
  { key: "treatment", label: "处理情况", aliases: ["处理情况", "处理方式"] },
  { key: "quantity", label: "数量", aliases: ["数量", "珠子数量"] },
  { key: "salesUnit", label: "销售单位", aliases: ["销售单位", "售卖单位"] },
] as const;
type FactKey = (typeof FACT_FIELDS)[number]["key"];
interface ParsedFact {
  readonly value: string | null;
  readonly source: string;
  readonly conflicting: boolean;
}
interface ParsedFacts {
  readonly facts: ReadonlyMap<FactKey, ParsedFact>;
  readonly ignoredLines: number;
}

function unknownValue(value: string): boolean {
  return (
    !value ||
    /^(?:需商家确认|待确认|待补充|未提供|未核实|未知|不详|暂无|tbd|n\/?a|[-—]+)$/i.test(value) ||
    /(?:需|待|请)(?:商家)?确认|未知|不详|未提供|待补充|未核实|不确定|可能|疑似|估计|推测|仅供参考/.test(
      value,
    )
  );
}

/** Only explicit field/value lines become facts; prose and document instructions stay out. */
function parseFacts(text: string): ParsedFacts {
  const entries = new Map<FactKey, { values: Set<string>; lines: number[]; unknown: boolean }>();
  let ignoredLines = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const tableCells = line.trim().startsWith("|")
      ? line
          .trim()
          .slice(1)
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim())
      : [];
    const match =
      tableCells.length === 2
        ? [line, tableCells[0], tableCells[1]]
        : /^\s*(?:[-*]\s*)?([^:：]{1,20})[:：]\s*(.*?)\s*$/.exec(line);
    const field = match
      ? FACT_FIELDS.find(({ aliases }) => aliases.some((alias) => alias === match[1]?.trim()))
      : undefined;
    if (!field || !match) {
      ignoredLines += 1;
      return;
    }
    const entry = entries.get(field.key) ?? {
      values: new Set<string>(),
      lines: [],
      unknown: false,
    };
    const value = match[2]?.trim() ?? "";
    entry.lines.push(index + 1);
    if (unknownValue(value)) entry.unknown = true;
    else entry.values.add(value);
    entries.set(field.key, entry);
  });
  const facts = new Map<FactKey, ParsedFact>();
  for (const [key, entry] of entries) {
    const conflicting = entry.values.size > 1 || (entry.unknown && entry.values.size > 0);
    facts.set(key, {
      value: conflicting ? null : ([...entry.values][0] ?? null),
      source: `商家资料，第${entry.lines.join("、")}行；未独立核验`,
      conflicting,
    });
  }
  return { facts, ignoredLines };
}

/** Planning ignores optional review status and its own saved draft. Source identity stays exact. */
export function jewelryLaunchInputSignature(options: ProductSceneWorkflowOptions): string {
  const logo = options.quality?.logo;
  return stableJsonSignature({
    ruleVersion: RULE_VERSION,
    productName: options.productName,
    aspectRatio: options.aspectRatio,
    productScale: options.productScale ?? 0.48,
    jewelry: options.jewelry
      ? {
          skuId: options.jewelry.skuId,
          specimenId: options.jewelry.specimenId,
          criticalFeatures: options.jewelry.criticalFeatures,
          seriesStyle: options.jewelry.seriesStyle,
          factsText: options.jewelry.launch?.factsText ?? "",
        }
      : null,
    views: options.views.map((view) => ({
      id: view.id,
      label: view.label,
      sourcePath: view.sourcePath,
      preparedPath: view.preparedPath,
      contentHash: view.contentHash,
      photoRole: view.photoRole ?? null,
      width: view.width ?? null,
      height: view.height ?? null,
      protection: view.protection ?? null,
    })),
    logo: logo
      ? { path: logo.path, contentHash: logo.contentHash, width: logo.width, height: logo.height }
      : null,
  });
}

function sourceRole(view: ProductSceneView): ProductSceneView["photoRole"] {
  return view.photoRole ?? (view.protection?.use === "wearing" ? "wearing" : undefined);
}

function sourceRecord(view: ProductSceneView): JewelryLaunchSource {
  const photoRole = sourceRole(view);
  return {
    viewId: view.id,
    label: view.label,
    sourcePath: view.sourcePath,
    preparedPath: view.preparedPath,
    contentHash: view.contentHash,
    ...(photoRole ? { photoRole } : {}),
  };
}

type SourceNeed = "full" | "white_full" | "detail" | "wearing_or_structure";
function assignSource(
  views: readonly ProductSceneView[],
  need: SourceNeed,
  index: number,
): Pick<JewelryLaunchSlot, "source" | "sourceStatus" | "sourceNotes"> {
  const eligibleViews =
    need === "white_full" ? views.filter((view) => view.protection?.use !== "wearing") : views;
  const full = eligibleViews.filter((view) => sourceRole(view) === "full");
  const detail = eligibleViews.filter((view) => sourceRole(view) === "detail");
  const wearing = eligibleViews.filter((view) => sourceRole(view) === "wearing");
  const unclassified = eligibleViews.filter((view) => !sourceRole(view));
  const preferred =
    need === "full" || need === "white_full"
      ? full
      : need === "detail"
        ? detail.length
          ? detail
          : full
        : wearing.length
          ? wearing
          : full.length
            ? full
            : detail;
  const candidates = preferred.length ? preferred : unclassified;
  if (!candidates.length) {
    return {
      sourceStatus: "missing",
      sourceNotes: [
        need === "full" || need === "white_full"
          ? "缺适合全貌图位的原片；已标注细节或佩戴的照片不会被当作全貌，保留缺图草案。"
          : "暂无适合此图位的原片，保留缺图草案，不生成未见结构。",
      ],
    };
  }
  const view = candidates[index % candidates.length];
  if (!view) {
    return {
      sourceStatus: "missing",
      sourceNotes: [
        need === "full" || need === "white_full"
          ? "缺适合全貌图位的原片；已标注细节或佩戴的照片不会被当作全貌，保留缺图草案。"
          : "暂无适合此图位的原片，保留缺图草案，不生成未见结构。",
      ],
    };
  }
  const sourceNotes = ["只依据来源用途标签分配；本地策划未读取或视觉分析照片内容。"];
  const role = sourceRole(view);
  if (!role) sourceNotes.push("照片用途未标注，来源为暂定分配，构图与全貌范围待核对。");
  if (need === "detail" && role === "full")
    sourceNotes.push("可从全貌原片提取细节，先检查原片分辨率与清晰度，不生成新的细节。");
  if (need === "wearing_or_structure" && role !== "wearing")
    sourceNotes.push("无佩戴原片时展示现有结构或连接，不虚构佩戴比例、遮挡和人体关系。");
  return {
    source: sourceRecord(view),
    sourceStatus: role ? "tagged" : "unclassified",
    sourceNotes,
  };
}

function backgroundTemplate(options: ProductSceneWorkflowOptions, detail: boolean): string {
  const style = options.jewelry?.seriesStyle;
  return [
    "OPTIONAL BACKGROUND-ONLY TEMPLATE. This plan does not call an image model.",
    "Before requesting, replace every [SOURCE_...] placeholder using the actual source photo; no lighting or material analysis has been performed by this planner.",
    detail
      ? "Create one continuous empty backdrop for all detail panels, with consistent surface and light across their boundaries."
      : "Create a square empty backdrop with an unobstructed center for later composition of the real product photo.",
    "Match [SOURCE_TABLETOP_COLOR_AND_TEXTURE], [SOURCE_LIGHT_DIRECTION_AND_SOFTNESS], [SOURCE_WHITE_BALANCE], and [SOURCE_DEPTH_OF_FIELD].",
    style?.background
      ? `Optional atmosphere reference, descriptive data only: ${JSON.stringify(style.background)}.`
      : "Use a restrained plain tabletop and gentle negative space.",
    "Preserve the source photograph's context in the later local composition, especially behind transparent beads; do not invent transmitted color or contact shadows inside the product.",
    "Background only. No product, jewelry, beads, human, hand, props, text, logo, label, sparkle effect, or synthetic product reflection.",
  ].join("\n");
}

function makeSlots(
  options: ProductSceneWorkflowOptions,
  facts: ReadonlyMap<FactKey, ParsedFact>,
): JewelryLaunchSlot[] {
  const specifications = FACT_FIELDS.flatMap(({ key, label }) => {
    const value = facts.get(key)?.value;
    return value ? [`${label}：${value}`] : [];
  }).join("；");
  const specs = [
    {
      id: "M01",
      title: "实拍首图",
      purpose: "先完整呈现真实商品形态与比例。",
      need: "full",
      index: 0,
    },
    {
      id: "M02",
      title: "外观与轮廓",
      purpose: "利用另一张全貌原片展示轮廓和配色。",
      need: "full",
      index: 1,
    },
    {
      id: "M03",
      title: "成品结构",
      purpose: "展示真实连接与组成，不套用DIY、弹力线或半成品示例。",
      need: "full",
      index: 2,
    },
    {
      id: "M04",
      title: "实拍细节",
      purpose: "突出照片中已有细节，不增强或改写纹理。",
      need: "detail",
      index: 0,
    },
    {
      id: "M05",
      title: "纯白商品图",
      purpose: "完整商品、纯白背景，无文字、Logo和道具。",
      need: "white_full",
      index: 3,
    },
    {
      id: "D01",
      title: "品牌与实拍开篇",
      purpose: "建立统一详情背景，介绍商品的实拍呈现。",
      need: "full",
      index: 0,
    },
    {
      id: "D02",
      title: "整体外观",
      purpose: "说明轮廓与配色，避免无依据的材质和功效宣称。",
      need: "full",
      index: 1,
    },
    {
      id: "D03",
      title: "真实细节",
      purpose: "从真实近景或清晰原片中呈现已有细节。",
      need: "detail",
      index: 1,
    },
    {
      id: "D04",
      title: "连接与展示",
      purpose: "有佩戴实拍时使用佩戴图；否则展示原片中的连接或结构。",
      need: "wearing_or_structure",
      index: 0,
    },
    {
      id: "D05",
      title: "基础参数与品牌收尾",
      purpose: "仅展示商家提供的基础参数，衔接统一详情背景。",
      need: "full",
      index: 3,
    },
  ] satisfies readonly {
    id: JewelryLaunchSlotId;
    title: string;
    purpose: string;
    need: SourceNeed;
    index: number;
  }[];
  return specs.map((slot) => {
    const assignment = assignSource(options.views, slot.need, slot.index);
    const main = slot.id.startsWith("M");
    const white = slot.id === "M05";
    const wearing = slot.id === "D04" && assignment.source?.photoRole === "wearing";
    const copy = main
      ? { title: "", body: "" }
      : slot.id === "D05"
        ? {
            title: specifications ? "商品信息" : "实拍留存",
            body: specifications || "以真实商品照片呈现已有形态与细节。",
          }
        : slot.id === "D04"
          ? {
              title: wearing ? "佩戴实拍" : "连接与结构",
              body: wearing ? "展示这张实拍中的佩戴关系。" : "以现有原片呈现，连接与细节保持原貌。",
            }
          : {
              title: slot.id === "D01" ? "实拍呈现" : slot.id === "D02" ? "整体外观" : "细节实拍",
              body:
                slot.id === "D03"
                  ? "近距离看见纹理与配件细节。"
                  : slot.id === "D02"
                    ? "细看轮廓与配色，感受整体搭配。"
                    : "从整体到细节，看见真实模样。",
            };
    const method = !assignment.source
      ? "missing_source"
      : white
        ? "source_clean_white"
        : "source_layout";
    const prompt = !assignment.source
      ? "暂无适合该图位的原片。保留方案，不调用图片模型，不重建未见商品；后续可选用合适原片。"
      : white
        ? "无需调用图片模型。使用绑定的全貌原片，先校正方向，再等比构图并清理外围为纯白；保留透明区域、结构、比例和原有接触阴影。若无法可靠分离背景，保留实拍草案并提示纯白条件尚未满足，不声称已经合格。无文字、Logo或道具。"
        : `无需调用图片模型。只对绑定的真实原片进行本地排版与等比缩放，必要时裁切已有内容；商品保护范围内保留结构、比例、纹理、反光与连接。${main ? "1:1主图，无中文标题、副标题或标签；真实Logo单独按原比例叠加，缺Logo时保留无Logo草案。" : "详情延续同一背景与留白；中文独立排版，不写入图片模型。"}`;
    return {
      id: slot.id,
      title: slot.title,
      purpose: slot.purpose,
      ...assignment,
      copy,
      method,
      prompt,
      ...(!white && assignment.source
        ? { backgroundPrompt: backgroundTemplate(options, !main) }
        : {}),
    };
  });
}

/** Produce the full plan locally, including incomplete drafts; never submit media generation. */
export function generateJewelryLaunchDraft(
  options: ProductSceneWorkflowOptions,
): JewelryLaunchDraft {
  const parsed = parseFacts(options.jewelry?.launch?.factsText ?? "");
  const variables: JewelryLaunchVariable[] = [
    {
      key: "productName",
      label: "输入商品名称",
      value: options.productName.trim() || "未命名商品",
      status: "input",
      source: "当前工作流输入；名称不作为材质或天然属性的证据",
    },
    {
      key: "skuId",
      label: "SKU",
      value: options.jewelry?.skuId.trim() ? options.jewelry.skuId.trim() : UNKNOWN,
      status: options.jewelry?.skuId.trim() ? "input" : "unknown",
      source: "当前商品记录；空值不阻塞策划",
    },
    {
      key: "specimenId",
      label: "实物编号",
      value: options.jewelry?.specimenId.trim() ? options.jewelry.specimenId.trim() : UNKNOWN,
      status: options.jewelry?.specimenId.trim() ? "input" : "unknown",
      source: "当前实物记录；空值不阻塞策划",
    },
    {
      key: "sources",
      label: "原片数量",
      value: `${options.views.length}张`,
      status: "input",
      source: "当前工作流的原片列表；未视觉分析照片",
    },
    ...FACT_FIELDS.map(({ key, label }): JewelryLaunchVariable => {
      const fact = parsed.facts.get(key);
      return {
        key,
        label,
        value: fact?.value ?? (fact?.conflicting ? `${UNKNOWN}（提供资料存在冲突）` : UNKNOWN),
        status: fact?.value ? "merchant_provided" : "unknown",
        source: fact?.source ?? "商家未提供；不根据名称、文件名或外观推断",
      };
    }),
    {
      key: "displayStrategy",
      label: "展示方式",
      value: "优先成品实拍全貌、细节和连接；有佩戴原片时再加入佩戴展示",
      status: "strategy",
      source: "当前珠宝上新模板的制作策略，不代表视觉分析结论",
    },
  ];
  const merchantConfirmations: string[] = [];
  if (!parsed.facts.get("material")?.value)
    merchantConfirmations.push(
      "材质：仅在需要材质宣称时补充；可直接提供已有商品链接、参数截图或商品卡，当前文案不宣称材质。",
    );
  if (!["size", "beadSize", "length"].some((key) => parsed.facts.get(key as FactKey)?.value))
    merchantConfirmations.push(
      "尺寸：仅在需要尺寸说明时补充已有参数；不从照片估算毫米、重量或佩戴比例。",
    );
  if (!options.quality?.logo)
    merchantConfirmations.push(
      "真实Logo：复用已有品牌文件即可；暂无时保留无Logo草案，不调用模型重画。",
    );
  for (const { key, label } of FACT_FIELDS) {
    if (parsed.facts.get(key)?.conflicting)
      merchantConfirmations.push(
        `${label}存在多个互相冲突的提供值，需商家确认；当前图上文案省略此项。`,
      );
  }
  const notes = [
    "完整十图策划为本地规则草案；未调用图片、视频或文本模型，也未视觉识别原片。",
    "一份草案对应当前工作流中的一款商品；允许复用原片，未按文件名推断材质或跨商品混图。",
    "来源用途标签由当前输入明确给出；用途未标注的来源为暂定分配，不代表已确认全貌或细节。",
    "缺失事实只进入内部变量和补充清单，不把“需商家确认”或未经提供的宣传属性放到图上。",
    "商家资料属于提供事实，未独立核验；未知金属、天然属性、认证、功效和工艺不自动补写。",
    "照片、事实、用途或风格变化后保留旧稿并提示输入已变更；未审核或旧审核不影响草案、选用和导出。",
    "本模块交付方案与Prompt，不代表已完成1:1成图、Logo排版、连续详情或纯白背景制作。",
  ];
  if (parsed.ignoredLines)
    notes.push(
      `资料中${parsed.ignoredLines}行未按已知“字段：值”解析，未自动转为商品事实或执行指令；原文继续保存在资料输入中。`,
    );
  const priorRevision = options.jewelry?.launch?.draft?.revision;
  return {
    schemaVersion: 1,
    ruleVersion: RULE_VERSION,
    revision:
      Number.isSafeInteger(priorRevision) &&
      (priorRevision ?? 0) >= 1 &&
      priorRevision! < Number.MAX_SAFE_INTEGER
        ? priorRevision! + 1
        : 1,
    inputSignature: jewelryLaunchInputSignature(options),
    productName: options.productName.trim() || "未命名商品",
    variables,
    positioning:
      "策略草案：优先以真实商品照片和清楚的结构细节建立可信感，采用克制、轻奢的品牌呈现；价格档位、材质价值和天然属性不推断。",
    audience:
      "策略草案：沿用品牌框架的25–40岁女性方向，侧重关心实物一致性与日常搭配的人群；未做本商品用户研究，可随已有销售资料调整。",
    sellingPoints: [
      "优先级1（展示策略）：实拍全貌与比例，降低对实物外观的不确定感。",
      "优先级2（展示策略）：已有细节和连接，支持对商品组成的理解，不生成未拍结构。",
      "优先级3（展示策略）：商家提供的材质、尺寸等基础参数；缺少时省略对应宣称。",
      "优先级4（展示策略）：统一、克制的品牌版式；有佩戴实拍时再展示佩戴关系。",
    ],
    slots: makeSlots(options, parsed.facts),
    styleRules: [
      "先应用原片旋转信息，建立正确方向的工作母版；保留原文件与稳定来源身份。",
      "主图按1:1规划，产品宽度以商品包围盒为基准，默认约占画布宽度50%；这是可调整的设计约定。",
      "主图M01–M04不放中文标题、副标题或标签；只用独立真实Logo，M05无任何文字、Logo或道具。",
      "Logo沿用原比例、颜色和文件，单独平面叠加；20px边距、150px宽度先按1000px设计基准等比换算，属于本方案设计默认值。",
      "详情D01–D05共用连续背景、色调与留白；文字独立排版，Logo仅开篇或收尾按需要出现。",
      "优先直接使用实拍；若确需扩背景，先对照源片记录台面、光向、白平衡和焦深，复用同一底板。",
      "金色品牌配色只用于背景或版式，不改银色或其他真实配件的颜色；不添加虚假高光、纹理、磨皮或颗粒。",
      "主体、透明区域内的环境关系与接触阴影保留，不将一张平面照片扩展为未见机位或真实动态折射。",
      "同一原片可跨图位复用，不为满足十张数量生成新的商品角度；细节原片不冒充完整全貌。",
      "尺寸仅使用商家提供的值；“约”只出现一次，不补猜测单位或数值。",
    ],
    qualityChecks: [
      "核对原片方向、等比缩放、真实结构、连接、珠序和照片中可见纹理；策划模块未进行像素验证。",
      "核对各图位来源ID、原始路径、工作母版路径与内容签名；改动保留提示，仍可选用或导出。",
      "核对用途未标注的暂定来源是否适合图位，细节来源不得当作全貌。",
      "核对M01–M04无中文、M05无文字与Logo；Logo使用真实文件并保持原比例。",
      "核对纯白条件、透明区域和接触阴影；不把浅色背景草案描述为已通过纯白检查。",
      "核对详情连续背景、文字可读性和接缝；商家未提供或冲突的参数不进入图上文案。",
      "核对自然感：光线、反射、焦深、台面和保护区域边界；不自动声称模型已准确匹配原片。",
      "所有检查用于记录与提示，未审核、旧审核和被改动的源片或成图不做拦截。",
    ],
    merchantConfirmations,
    notes,
  };
}

const STATUS_LABELS: Readonly<Record<JewelryLaunchFactStatus, string>> = {
  input: "当前输入",
  merchant_provided: "商家提供，未独立核验",
  strategy: "策略草案",
  unknown: "缺失或存在冲突",
};
const METHOD_LABELS: Readonly<Record<JewelryLaunchSlot["method"], string>> = {
  source_layout: "原片直接排版",
  source_clean_white: "原片外围纯白清理（结果待核对）",
  missing_source: "缺图草案",
};

/** Escape user-controlled text as data, including table delimiters and raw HTML. */
function markdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/([`*_{}[\]()#+.!|~])/g, "\\$1");
}

function promptBlock(prompt: string): string {
  const runs = prompt.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${prompt}\n${fence}`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownText).join(" | ")} |`),
  ].join("\n");
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${markdownText(item)}`).join("\n");
}

/** Export all ten requested parts plus the internal provenance and advisory follow-up list. */
export function jewelryLaunchMarkdown(draft: JewelryLaunchDraft): string {
  const planRows = (prefix: "M" | "D") =>
    draft.slots
      .filter((slot) => slot.id.startsWith(prefix))
      .map((slot) => [
        slot.id,
        slot.title,
        slot.purpose,
        slot.source?.label ?? "暂无适合原片",
        slot.sourceStatus === "tagged"
          ? "按用途标签分配"
          : slot.sourceStatus === "unclassified"
            ? "用途未标注，暂定分配"
            : "缺图草案",
        METHOD_LABELS[slot.method],
      ]);
  const sources = draft.slots.flatMap((slot) =>
    slot.source
      ? [
          [
            slot.id,
            slot.source.viewId,
            slot.source.sourcePath,
            slot.source.preparedPath,
            slot.source.contentHash,
          ],
        ]
      : [],
  );
  return [
    `# ${markdownText(draft.productName)} · 十图策划草案`,
    `版本：${draft.revision}；规则：${markdownText(draft.ruleVersion)}。本地规则策划，尚未生成图片。`,
    "## 1. 产品变量表（内部事实记录）",
    table(
      ["变量", "值", "状态", "来源"],
      draft.variables.map((variable) => [
        variable.label,
        variable.value,
        STATUS_LABELS[variable.status],
        variable.source,
      ]),
    ),
    "## 2. 产品定位",
    markdownText(draft.positioning),
    "## 3. 目标用户",
    markdownText(draft.audience),
    "## 4. 卖点排序",
    bullets(draft.sellingPoints),
    "## 5. 五张淘宝主图规划",
    table(["图位", "用途", "规划", "来源", "分配状态", "制作方式"], planRows("M")),
    "## 6. 五张淘宝详情页规划",
    table(["图位", "用途", "规划", "来源", "分配状态", "制作方式"], planRows("D")),
    "## 7. 每张图的中文文案",
    table(
      ["图位", "图上标题", "图上正文"],
      draft.slots.map((slot) => [slot.id, slot.copy.title || "无", slot.copy.body || "无"]),
    ),
    "## 8. 每张图的制作指令与 GPT Image Prompt",
    "优先原片直接排版。下方空背景Prompt为可选模板，需先按原片填入占位项；导出不触发模型调用。",
    ...draft.slots.flatMap((slot) => [
      `### ${slot.id} · ${markdownText(slot.title)}`,
      `制作方式：${METHOD_LABELS[slot.method]}。`,
      promptBlock(slot.prompt),
      ...(slot.backgroundPrompt ? ["可选空背景模板：", promptBlock(slot.backgroundPrompt)] : []),
      bullets(slot.sourceNotes),
    ]),
    "## 9. 统一风格规则",
    bullets(draft.styleRules),
    "## 10. 质检清单（记录与提示，不拦截）",
    bullets(draft.qualityChecks),
    "## 内部需商家确认项（不放到图上）",
    draft.merchantConfirmations.length
      ? bullets(draft.merchantConfirmations)
      : "暂无本方案需要额外补充的项目；商家提供事实仍未独立核验。",
    "## 原片来源记录",
    sources.length
      ? table(["图位", "原片ID", "原始路径", "工作母版路径", "内容签名"], sources)
      : "暂无原片，保留完整缺图草案。",
    "## 制作备注",
    bullets(draft.notes),
  ].join("\n\n");
}
