import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { ProductSceneAspectRatio } from "../../lib/productSceneImages";
import {
  productSceneJewelrySignature,
  productSceneProtectionValid,
  type ProductSceneJewelryOptions,
  type ProductSceneJewelryReview,
  type ProductSceneProtectionEvidence,
  type ProductSceneViewProtection,
} from "./productSceneJewelry";
export {
  JEWELRY_REVIEW_CHECKS,
  productSceneProtectionValid,
  updateProductSceneViewProtection,
  productSceneJewelryReviewWarnings,
  type ProductSceneJewelryCheck,
  type ProductSceneJewelryReview,
  type ProductSceneViewProtection,
} from "./productSceneJewelry";
import {
  productSceneQualityEnabled,
  type ProductSceneQualityOptions,
  type ProductSceneQualityState,
} from "./productSceneQuality";
export {
  productSceneQualityEnabled,
  productSceneRowCanAccept,
  resetProductSceneQuality,
} from "./productSceneQuality";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowConfig,
} from "./workspaceModel";
import {
  requirementsMet,
  type WorkflowRequirement,
  type WorkflowRequirements,
} from "./workflowFieldRequirements";

export type ProductSceneAngle = "front45" | "rear30" | "eye" | "top45" | "top90";
export type ProductSceneGenerationMode = "reference" | "composite" | "protected";
export type ProductSceneBrandStyle = "editorial" | "retro" | "quiet";
export interface ProductSceneBrandCreative {
  readonly style: ProductSceneBrandStyle;
  /** Art direction only; product identity comes from the actual source photos. */
  readonly brief: string;
}
export const PRODUCT_SCENE_BRAND_STYLES = [
  {
    id: "editorial",
    label: "冷白杂志",
    description: "冷白留白、黑白对比、真实肤质与金属细节，克制的珠宝杂志摄影。",
  },
  {
    id: "retro",
    label: "复古时装",
    description: "深色背景、暖中性色、织物与珠宝层次，统一的复古时装氛围。",
  },
  {
    id: "quiet",
    label: "暖白意境",
    description: "暖白空间、单体商品、柔和材质与大面积留白，简约的意境表达。",
  },
] as const satisfies readonly {
  id: ProductSceneBrandStyle;
  label: string;
  description: string;
}[];
export interface ProductSceneTargetCamera {
  readonly id: string;
  readonly label: string;
  readonly azimuth: number;
  readonly elevation: number;
  readonly focalLength: number;
  readonly distance: "wide" | "medium" | "close";
}
export interface ProductSceneView {
  readonly id: string;
  readonly label: string;
  readonly angle: ProductSceneAngle;
  readonly sourcePath: string;
  readonly preparedPath: string;
  readonly contentHash: string;
  readonly approved: boolean;
  readonly width?: number;
  readonly height?: number;
  /** Optional photo purpose; absent means not classified, never visual proof. */
  readonly photoRole?: "full" | "detail" | "wearing";
  readonly protection?: ProductSceneViewProtection;
}
export interface ProductSceneWorkflowOptions {
  /** Missing on legacy plans means composite, so saved paid tasks never change operation. */
  readonly generationMode?: ProductSceneGenerationMode;
  readonly productName: string;
  readonly totalCount: number;
  /** Legacy: batches no longer gate approval since one-click full-plan approval; kept so saved plans still validate. */
  readonly batchSize: number;
  /** Maximum parallel image requests. Missing on saved plans defaults to 10. */
  readonly maxConcurrency?: number;
  readonly sceneBias: "mixed" | "geek" | "office" | "unboxing";
  readonly aspectRatio: ProductSceneAspectRatio;
  readonly depthStrength: number;
  /** Product width as a fraction of the frame width; older saved options use 0.48. */
  readonly productScale?: number;
  readonly seed: number;
  readonly views: readonly ProductSceneView[];
  readonly quality?: ProductSceneQualityOptions;
  readonly jewelry?: ProductSceneJewelryOptions;
  readonly brandCreative?: ProductSceneBrandCreative;
}
export interface ProductSceneRecipe {
  readonly generationMode?: ProductSceneGenerationMode;
  readonly targetCamera?: ProductSceneTargetCamera;
  readonly depthStrength?: number;
  readonly reserveLogoArea?: boolean;
  readonly jewelrySignature?: string;
  readonly brandCreative?: ProductSceneBrandCreative;
  readonly sourcePhotoRoles?: readonly (
    NonNullable<ProductSceneView["photoRole"]> | "unclassified"
  )[];
  readonly aspectRatio: ProductSceneAspectRatio;
  readonly scene: string;
  readonly label: string;
  readonly material: string;
  readonly props: string;
  readonly lighting: string;
  readonly camera: string;
  readonly viewId: string;
  readonly prompt: string;
  readonly placement: {
    readonly centerX: number;
    readonly baselineY: number;
    readonly widthFraction: number;
  };
}
export interface ProductSceneAttempt {
  readonly taskId: string | null;
  readonly backgroundPath: string | null;
  readonly outputPath: string | null;
  readonly error: string | null;
  readonly recipe?: ProductSceneRecipe;
  readonly quality?: ProductSceneQualityState;
  readonly protection?: ProductSceneProtectionEvidence;
  readonly jewelryReview?: ProductSceneJewelryReview;
}
export interface ProductSceneRow extends ProductSceneAttempt {
  readonly id: string;
  readonly index: number;
  readonly recipe: ProductSceneRecipe;
  readonly status: "queued" | "running" | "needs_review" | "accepted" | "rejected" | "error";
  readonly backgroundHash: string | null;
  readonly foregroundHash: string | null;
  readonly reviewNotes: readonly string[];
  readonly attempts: readonly ProductSceneAttempt[];
}
export interface ProductSceneWorkflowCheckpoint {
  readonly inputSignature: string | null;
  readonly rows: readonly ProductSceneRow[];
  /** Explicitly approved upper row count; opening a plan never allocates paid work. */
  readonly approvedThrough: number;
  readonly batchReviewPending: boolean;
  /** A user-requested retry of one existing paid task; never permission to submit a new task. */
  readonly retryRowId?: string | null;
}

export function createProductSceneOptions(): ProductSceneWorkflowOptions {
  return {
    generationMode: "reference",
    productName: "魔芋 Ai 网关",
    totalCount: 500,
    batchSize: 10,
    maxConcurrency: 10,
    sceneBias: "mixed",
    aspectRatio: "3:4",
    depthStrength: 0.2,
    productScale: 0.48,
    seed: 20260923,
    views: [],
  };
}
export function createJewelrySceneOptions(
  existing?: ProductSceneWorkflowOptions,
): ProductSceneWorkflowOptions {
  const base = { ...(existing ?? createProductSceneOptions()) };
  delete base.quality;
  return {
    ...base,
    generationMode: "protected",
    aspectRatio: existing?.aspectRatio ?? "1:1",
    productName: "珠宝商品",
    totalCount: 10,
    views: [],
    jewelry: existing?.jewelry ?? {
      skuId: "",
      specimenId: "",
      criticalFeatures: "",
      seriesStyle: {
        name: "暖白珠宝系列",
        version: "1",
        background: "中性浅灰白台面，低反差留白，衔接原片实际背景，不含商品、文字或配饰",
        lighting: "按原片匹配主光方向、柔和程度与焦深，保留真实反光，不另造接触阴影或镜面高光",
      },
    },
  };
}
export function productSceneGenerationMode(
  options: ProductSceneWorkflowOptions,
): ProductSceneGenerationMode {
  return options.generationMode ?? "composite";
}
export function createProductSceneCheckpoint(): ProductSceneWorkflowCheckpoint {
  return { inputSignature: null, rows: [], approvedThrough: 0, batchReviewPending: false };
}
/** Exclude local launch planning; photo purpose affects execution only with brand art direction. */
export function productSceneExecutionOptions(options: ProductSceneWorkflowOptions) {
  const jewelry = { ...options.jewelry };
  delete jewelry.launch;
  return {
    ...options,
    ...(options.jewelry ? { jewelry } : {}),
    views: options.views.map((view) => {
      const executionView = { ...view };
      if (!options.brandCreative) delete executionView.photoRole;
      return executionView;
    }),
  };
}
export function productSceneInputSignature(config: KnowledgeVideoWorkflowConfig): string {
  return stableJsonSignature({
    options: config.productScene ? productSceneExecutionOptions(config.productScene) : undefined,
    model: config.models.image,
    parameters: config.imageParameterValues,
    ...(config.productScene && productSceneQualityEnabled(config.productScene)
      ? { inspectionModel: config.models.text }
      : {}),
  });
}
const PRODUCT_SCENE_ANGLES = ["front45", "rear30", "eye", "top45", "top90"] as const;
const PRODUCT_SCENE_PHOTO_ROLES = ["full", "detail", "wearing", "unclassified"] as const;
const PRODUCT_SCENE_GENERATION_MODES = ["reference", "composite", "protected"] as const;
const PRODUCT_SCENE_SCENE_BIASES = ["mixed", "geek", "office", "unboxing"] as const;
const PRODUCT_SCENE_ASPECT_RATIOS = ["1:1", "3:4", "9:16"] as const;

/**
 * 旧计划或手工改过的数据可能缺字段。缺口清单是配置区每次渲染都要跑的东西：
 * 一条坏记录只应该变成一条提示，而不是让整块界面渲染崩掉。合法数据行为不变。
 */
function hasText(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

/**
 * 尚缺的必填项：`field` 与界面标签同名，`hint` 是一句给用户的补法。
 *
 * 为什么要有这份清单
 * ------------------
 * 过去「能不能开始」只存在于 `productSceneInputReady` 的布尔表达式里：界面能拦住
 * 提交，却说不出缺的是哪一项，小白用户只能逐项乱试。这里把同一批校验条件翻译成
 * 可渲染的数据，`productSceneInputReady` 再由清单推导，界面提示与运行器拦截只有
 * 一份来源。改动校验时两处不会再各说一套。
 *
 * 必填的边界（对小白用户）
 * ------------------------
 * 只有「缺了就一定做不出结果、而且无法合理推断」的输入才写进清单：
 *   - 产品参考原图、每张原图的确认勾选：工作流唯一的硬素材输入；
 *   - 产品名称：导出文件名与交付清单都靠它标识；
 *   - 珠宝原片保护模式下的实物身份与关键特征：同一 SKU 的不同实物必须分别记录，
 *     无法从图片推断，做不出「保真」这一结果。
 * 数量、并发、批次、画幅、占比、景深、种子、场景倾向、机位、系列模板、灯光都有
 * 推荐默认值，一律不写进清单（界面标「（可选）」）；功能开关（自动检查 / Logo
 * 贴回）只有用户主动开启时才需要补齐对应确认。
 */
export function productSceneRequirements(
  options: ProductSceneWorkflowOptions,
): WorkflowRequirements {
  const missing: WorkflowRequirement[] = [];
  if (!hasText(options.productName))
    missing.push({ field: "产品名称", hint: "填写要展示的商品名称，用于导出文件名与交付清单。" });
  if (!options.views.length)
    missing.push({
      field: "产品参考原图",
      hint:
        options.generationMode === "protected"
          ? "点击“添加完整实拍 / 佩戴原片”，至少加入一张完整保留的实物原片。"
          : "点击“添加白底 / 透明产品原图”，至少加入一张清晰的产品原图。",
    });
  else if (
    new Set(options.views.map((view) => view.id)).size !== options.views.length ||
    new Set(
      options.views.map((view, index) =>
        hasText(view.contentHash) ? view.contentHash.toLowerCase() : `missing-${index}`,
      ),
    ).size !== options.views.length
  )
    missing.push({
      field: "产品参考原图",
      hint: "有重复添加的原图；同一张图只需保留一份，移除重复项后再开始。",
    });
  const unapproved = options.views.filter((view) => !view.approved).length;
  if (unapproved)
    missing.push({
      field: "原图确认",
      hint: `还有 ${unapproved} 张原图没有勾选确认；在每张原图下方确认版本、角度与细节核对无误。`,
    });
  options.views.forEach((view, index) => {
    const label = hasText(view.label) ? view.label.trim() : "";
    const reasons: string[] = [];
    if (!view.id || !label) reasons.push("这条原图记录不完整，请移除后重新添加");
    else if (!hasText(view.sourcePath) || !hasText(view.preparedPath))
      reasons.push("原图文件已不可用，请移除后重新添加");
    if (!/^[a-f0-9]{64}$/i.test(view.contentHash)) reasons.push("文件内容记录已失效，请重新添加");
    if (!PRODUCT_SCENE_ANGLES.includes(view.angle)) reasons.push("重新选择原图角度");
    if (
      options.brandCreative &&
      !PRODUCT_SCENE_PHOTO_ROLES.includes(view.photoRole ?? "unclassified")
    )
      reasons.push("重新标注照片用途");
    if (reasons.length)
      missing.push({
        field: `第 ${index + 1} 张原图`,
        hint: `${label || "未命名原图"}：${reasons.join("；")}。`,
      });
  });
  // 珠宝原片保护模式沿用原始 generationMode 判断，与 productSceneJewelryOptionsValid 一致：
  // 旧计划里缺失的 generationMode 表示原图保真合成，不受珠宝校验约束。
  if (options.generationMode === "protected") {
    const jewelry = options.jewelry;
    if (!jewelry?.seriesStyle)
      missing.push({
        field: "珠宝实物与系列模板",
        hint: "重新选择“珠宝原片保护”生成方式，补齐实物身份与系列模板后再开始。",
      });
    else {
      if (!hasText(jewelry.skuId))
        missing.push({
          field: "商品 SKU",
          hint: "填写同款商品的 SKU；同一款商品的系列模板按它复用。",
        });
      if (!hasText(jewelry.specimenId))
        missing.push({
          field: "单件实物编号 / 天然纹理身份",
          hint: "每一件实物单独编号；同 SKU 的不同手串不能共用天然纹理身份。",
        });
      if (!hasText(jewelry.criticalFeatures))
        missing.push({
          field: "必须保留的关键特征",
          hint: "写下珠子数量与顺序、主珠朝向、棉絮或包裹物位置等不能被改动的细节。",
        });
      if (!hasText(jewelry.seriesStyle.name))
        missing.push({ field: "系列模板名称", hint: "填回系列名称，例如“暖白珠宝系列”。" });
      if (!hasText(jewelry.seriesStyle.version))
        missing.push({ field: "系列模板版本", hint: "填回模板版本号，例如“1”。" });
      if (!hasText(jewelry.seriesStyle.background))
        missing.push({
          field: "系列背景要求",
          hint: "填回系列背景要求；留空会少掉统一风格，直接恢复默认描述即可。",
        });
      if (!hasText(jewelry.seriesStyle.lighting))
        missing.push({
          field: "系列光照要求",
          hint: "填回系列光照要求；留空会少掉统一风格，直接恢复默认描述即可。",
        });
      options.views.forEach((view, index) => {
        if (!productSceneProtectionValid(view.protection))
          missing.push({
            field: `第 ${index + 1} 张原图保护范围`,
            hint: `${hasText(view.label) ? view.label.trim() : "未命名原图"}：点击“编辑保护范围”，框住完整商品、阴影与必要手腕。`,
          });
      });
    }
  }
  const quality = options.quality;
  if (quality) {
    if (options.generationMode === "protected" && productSceneQualityEnabled(options))
      missing.push({
        field: "自动检查与 Logo 贴回",
        hint: "珠宝原片保护模式不使用自动检查与 Logo 贴回，请关闭或移除后再开始。",
      });
    else if (
      typeof quality.inspectPorts !== "boolean" ||
      typeof quality.portSpecification !== "string"
    )
      missing.push({
        field: "自动检查与 Logo 贴回",
        hint: "重新勾选“自动检测可见接口”，或移除这次 Logo 贴回后再开始。",
      });
    else if (
      quality.logo &&
      !(
        (options.generationMode ?? "composite") === "reference" &&
        quality.logo.approved &&
        hasText(quality.logo.path) &&
        /^[a-f0-9]{64}$/i.test(quality.logo.contentHash) &&
        Number.isInteger(quality.logo.width) &&
        quality.logo.width > 0 &&
        Number.isInteger(quality.logo.height) &&
        quality.logo.height > 0
      )
    )
      missing.push({
        field: "Logo 贴回确认",
        hint: "勾选“确认此 Logo 内容与透明边缘正确”，或移除这次 Logo 贴回。",
      });
  }
  if (options.brandCreative) {
    if (!PRODUCT_SCENE_BRAND_STYLES.some((style) => style.id === options.brandCreative!.style))
      missing.push({
        field: "AI 品牌摄影风格",
        hint: "重新选择一种品牌摄影风格；这份计划可能来自旧版本。",
      });
    if (typeof options.brandCreative.brief !== "string")
      missing.push({
        field: "品牌画面要求",
        hint: "重新填写品牌画面要求；也可以留空，由工作流按风格自动安排。",
      });
  }
  // 以下参数在界面上都有推荐默认值，正常不会失败；一旦旧计划或手工数据越界，
  // 仍要给出同样的缺口提示，避免“按钮点不动却不说原因”。
  if (!PRODUCT_SCENE_GENERATION_MODES.includes(productSceneGenerationMode(options)))
    missing.push({ field: "生成方式", hint: "重新选择一种生成方式。" });
  if (!Number.isInteger(options.totalCount) || options.totalCount < 1 || options.totalCount > 500)
    missing.push({ field: "总计划张数", hint: "设置为 1～500 之间的整数，推荐 500 张。" });
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 50)
    missing.push({
      field: "批次数量",
      hint: "旧计划的兼容字段，设置为 1～50 之间的整数即可，新建计划默认 10。",
    });
  const maxConcurrency = options.maxConcurrency ?? 10;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 50)
    missing.push({
      field: "同时生成张数上限",
      hint: "设置为 1～50 之间的整数，推荐 10 张。",
    });
  if (!PRODUCT_SCENE_SCENE_BIASES.includes(options.sceneBias))
    missing.push({ field: "场景倾向", hint: "重新选择场景倾向，推荐“均衡混合”。" });
  if (!PRODUCT_SCENE_ASPECT_RATIOS.includes(options.aspectRatio))
    missing.push({ field: "图片比例", hint: "重新选择图片比例，推荐 3:4。" });
  if (
    !Number.isFinite(options.depthStrength) ||
    options.depthStrength < 0 ||
    options.depthStrength > 1
  )
    missing.push({ field: "背景景深", hint: "拖回 0～100% 之间，推荐 20%。" });
  const productScale = options.productScale ?? 0.48;
  if (!Number.isFinite(productScale) || productScale < 0.3 || productScale > 0.65)
    missing.push({
      field:
        productSceneGenerationMode(options) === "protected" ? "完整原片画面占比" : "产品画面占比",
      hint: "拖回 30%～65% 之间，推荐 48%。",
    });
  if (!Number.isSafeInteger(options.seed))
    missing.push({
      field: "场景种子",
      hint: "填一个 0 以上的整数，推荐 20260923；同一种子会复现同一批场景。",
    });
  return missing;
}

export function productSceneInputReady(options: ProductSceneWorkflowOptions): boolean {
  return requirementsMet(productSceneRequirements(options));
}

const SCENES = [
  {
    id: "developer",
    group: "geek",
    label: "开发者工位",
    description:
      "a developer desk with a monitor and mechanical keyboard behind the empty foreground",
  },
  {
    id: "studio",
    group: "geek",
    label: "个人工作室",
    description:
      "a home technology studio desk with a closed laptop and monitor light bar in the background",
  },
  {
    id: "pegboard",
    group: "geek",
    label: "洞洞板工作台",
    description:
      "an electronics hobby workbench with a pegboard of ordinary accessories on the wall",
  },
  {
    id: "home-network",
    group: "geek",
    label: "家庭网络运维桌",
    description:
      "a home networking desk with a small network rack and neatly routed cables in the distant background",
  },
  {
    id: "office",
    group: "office",
    label: "企业办公桌",
    description:
      "an ordinary business office desk with a monitor riser behind the clear foreground",
  },
  {
    id: "meeting",
    group: "office",
    label: "会议室设备桌",
    description:
      "a small meeting room equipment table beside a projector, both clearly separate from the empty foreground",
  },
  {
    id: "reception",
    group: "office",
    label: "公司展示台",
    description: "a company reception equipment display counter with a muted office background",
  },
  {
    id: "network",
    group: "office",
    label: "企业弱电架旁工作台",
    description:
      "a technician worktable next to a lightweight office network rack, cables run behind the empty foreground",
  },
  {
    id: "unbox-desk",
    group: "unboxing",
    label: "办公桌开箱",
    description:
      "an office desk with one open plain corrugated shipping box and protective packing paper at the far edge",
  },
  {
    id: "unbox-studio",
    group: "unboxing",
    label: "工作室开箱",
    description:
      "a home studio desk with a small plain opened cardboard box, empty packing tray and folded paper in the background",
  },
  {
    id: "unbox-workbench",
    group: "unboxing",
    label: "运维台摆放",
    description:
      "an IT workbench with plain packaging and a cable tie organizer behind the clear placement area",
  },
  {
    id: "unbox-office",
    group: "unboxing",
    label: "企业设备拆包",
    description:
      "an office equipment setup table with a plain open delivery carton near the rear corner",
  },
] as const;
const MATERIALS = [
  "dark walnut wood",
  "light natural oak wood",
  "matte black metal",
  "clean off-white stone",
] as const;
const PROPS = [
  "a closed notebook and a pen",
  "a small succulent in a ceramic pot",
  "a closed insulated water bottle far from the equipment area",
  "a coiled loose network cable and two cable ties",
  "a folded microfiber cloth and a mouse pad",
  "a plain pencil cup and a blank memo pad",
  "a desk organizer and a closed notebook",
  "a few ordinary cables loosely routed behind the desk",
] as const;
const LIGHTS = [
  "soft diffuse daylight through a sheer curtain on the left with broad room fill",
  "soft diffuse daylight through a sheer curtain on the right with broad room fill",
  "overcast daylight with gentle diffuse shadows",
  "diffuse neutral ceiling light balanced with soft window fill",
  "soft neutral light bounced from a pale indoor wall with gentle ambient fill",
  "broad indirect indoor daylight with low contrast and gentle diffuse shadows",
] as const;
const CAMERAS: Record<ProductSceneAngle, string> = {
  front45: "front three-quarter view, looking down approximately 30 degrees onto the tabletop",
  rear30: "side three-quarter view, camera looking down approximately 20 degrees onto the tabletop",
  eye: "near tabletop eye level, shallow viewing elevation, with the supporting surface visible",
  top45: "handheld view looking down approximately 45 degrees from a seated person's position",
  top90:
    "direct overhead view looking vertically down 90 degrees onto the flat tabletop, no side elevation",
};

const TARGET_CAMERAS: readonly ProductSceneTargetCamera[] = [
  {
    id: "front-left30",
    label: "左前30°桌面中景",
    azimuth: -30,
    elevation: 25,
    focalLength: 28,
    distance: "medium",
  },
  {
    id: "front-right30",
    label: "右前30°桌面中景",
    azimuth: 30,
    elevation: 25,
    focalLength: 28,
    distance: "medium",
  },
  {
    id: "front-left45",
    label: "左前45°桌面全景",
    azimuth: -45,
    elevation: 30,
    focalLength: 24,
    distance: "wide",
  },
  {
    id: "front-right45",
    label: "右前45°桌面全景",
    azimuth: 45,
    elevation: 30,
    focalLength: 24,
    distance: "wide",
  },
  {
    id: "eye-level",
    label: "近水平日常视角",
    azimuth: 15,
    elevation: 5,
    focalLength: 35,
    distance: "medium",
  },
  {
    id: "low-angle",
    label: "略微仰视",
    azimuth: -20,
    elevation: -5,
    focalLength: 35,
    distance: "medium",
  },
  {
    id: "overhead45",
    label: "俯视45°随手拍",
    azimuth: 20,
    elevation: 45,
    focalLength: 28,
    distance: "wide",
  },
  {
    id: "overhead70",
    label: "俯视70°桌面视角",
    azimuth: -15,
    elevation: 70,
    focalLength: 28,
    distance: "medium",
  },
  {
    id: "top90",
    label: "垂直俯拍90°",
    azimuth: 0,
    elevation: 90,
    focalLength: 35,
    distance: "medium",
  },
  {
    id: "front-close",
    label: "前面板近景",
    azimuth: 25,
    elevation: 12,
    focalLength: 50,
    distance: "close",
  },
];
const REAR_TARGET_CAMERAS: readonly ProductSceneTargetCamera[] = [
  {
    id: "rear-left-close",
    label: "左后接口侧近景",
    azimuth: -145,
    elevation: 20,
    focalLength: 50,
    distance: "close",
  },
  {
    id: "rear-right-close",
    label: "右后接口侧近景",
    azimuth: 145,
    elevation: 15,
    focalLength: 50,
    distance: "close",
  },
];

interface BrandSceneDefinition {
  readonly photography: string;
  readonly lightingMood: string;
  readonly scenes: readonly { id: string; label: string; description: string }[];
  readonly materials: readonly string[];
  readonly props: readonly string[];
}
const BRAND_SCENES: Record<ProductSceneBrandStyle, BrandSceneDefinition> = {
  editorial: {
    photography:
      "restrained jewelry editorial photography, cool-white negative space, precise black-and-white contrast, realistic metal and pearl texture; when a model is requested, retain natural skin texture rather than plastic beauty retouching",
    lightingMood:
      "neutral-cool white balance, controlled broad studio reflections, precise luminous metal detail and restrained contrast",
    scenes: [
      {
        id: "editorial-white",
        label: "冷白杂志主视觉",
        description: "a seamless cool-white editorial set with generous negative space",
      },
      {
        id: "editorial-black",
        label: "黑白材质对比",
        description:
          "a minimal cool-white set with a restrained black fabric plane in the distant background",
      },
      {
        id: "editorial-stone",
        label: "冷灰石材静物",
        description: "a sparse pale stone jewelry still-life set with sculptural negative space",
      },
      {
        id: "editorial-detail",
        label: "杂志商品细节",
        description:
          "a quiet editorial detail set that isolates the actual product construction and surface texture",
      },
    ],
    materials: [
      "matte cool-white paper",
      "pale cool-grey stone",
      "fine ivory cotton",
      "smooth off-white ceramic",
    ],
    props: [
      "no added props",
      "one distant fold of black cloth",
      "one slim unprinted black card behind the product",
      "one pale geometric plane far from the product",
      "a subtle paper curve in the background",
      "one restrained white fabric fold",
      "an unprinted cool-grey backdrop plane",
      "a small dark fabric edge far from the product",
    ],
  },
  retro: {
    photography:
      "understated vintage fashion editorial photography, deep charcoal background, ivory and muted warm neutrals, tactile fabric and jewelry layering, realistic texture and restrained film grain",
    lightingMood:
      "neutral-warm white balance, softly shaped highlights, rich dark background separation without losing actual product color",
    scenes: [
      {
        id: "retro-charcoal",
        label: "复古深色棚景",
        description: "a minimal deep-charcoal fashion set with restrained ivory accents",
      },
      {
        id: "retro-linen",
        label: "象牙白织物静物",
        description:
          "a vintage fashion still-life set with ivory linen and a deep muted background",
      },
      {
        id: "retro-drape",
        label: "深色织物层次",
        description:
          "a sparse vintage fashion set with dark draped cloth and a quiet warm-neutral surface",
      },
      {
        id: "retro-warm",
        label: "暖灰复古留白",
        description:
          "a restrained warm-grey fashion set with a subtle archival editorial atmosphere",
      },
    ],
    materials: ["matte charcoal fabric", "ivory linen", "warm-grey paper", "subdued cream stone"],
    props: [
      "no added props",
      "one distant ivory linen fold",
      "one muted navy cloth fold behind the product",
      "a plain dark fabric edge",
      "one unprinted cream card far from the product",
      "a soft taupe fabric plane in the background",
      "one restrained charcoal drape",
      "a subtle unprinted warm-grey paper curve",
    ],
  },
  quiet: {
    photography:
      "quiet minimal brand still-life photography, warm-white breathing space, a single clear product focus, tactile understated materials and a restrained poetic atmosphere",
    lightingMood:
      "neutral-warm white balance, soft broad daylight, low contrast and gentle material gradients with true product colors",
    scenes: [
      {
        id: "quiet-warm-white",
        label: "暖白品牌主视觉",
        description: "a warm-white minimal set with generous calm negative space",
      },
      {
        id: "quiet-paper",
        label: "纸感意境静物",
        description: "a restrained warm paper set with one soft sculptural background plane",
      },
      {
        id: "quiet-stone",
        label: "浅石单体陈列",
        description:
          "a sparse pale limestone still-life set with the product as the only focal object",
      },
      {
        id: "quiet-linen",
        label: "亚麻柔光留白",
        description: "a quiet natural linen set with soft warm-white spatial depth",
      },
    ],
    materials: [
      "warm-white uncoated paper",
      "pale limestone",
      "natural ivory linen",
      "matte cream ceramic",
    ],
    props: [
      "no added props",
      "one distant warm-white paper fold",
      "a subtle ivory fabric edge behind the product",
      "one pale unprinted background plane",
      "one soft paper curve far from the product",
      "a small quiet linen fold",
      "one understated cream backdrop plane",
      "a distant matte white geometric surface",
    ],
  },
};
const BRAND_LIGHT_DIRECTIONS = [
  "a broad soft key from the left with gentle frontal fill",
  "a broad soft key from the right with gentle frontal fill",
  "a diffused overhead key with soft side fill",
  "a large frontal diffused key with restrained edge separation",
  "soft reflected window light with broad ambient fill",
  "a soft high-left key with a broad neutral bounce",
] as const;
const BRAND_TARGET_CAMERAS: readonly ProductSceneTargetCamera[] = [
  {
    id: "brand-front-left",
    label: "左前品牌中景",
    azimuth: -30,
    elevation: 20,
    focalLength: 70,
    distance: "medium",
  },
  {
    id: "brand-front-right",
    label: "右前品牌中景",
    azimuth: 30,
    elevation: 20,
    focalLength: 70,
    distance: "medium",
  },
  {
    id: "brand-left-wide",
    label: "左前留白全景",
    azimuth: -45,
    elevation: 30,
    focalLength: 50,
    distance: "wide",
  },
  {
    id: "brand-right-wide",
    label: "右前留白全景",
    azimuth: 45,
    elevation: 30,
    focalLength: 50,
    distance: "wide",
  },
  {
    id: "brand-eye",
    label: "平视品牌陈列",
    azimuth: 0,
    elevation: 5,
    focalLength: 85,
    distance: "medium",
  },
  {
    id: "brand-side",
    label: "侧面材质观察",
    azimuth: -60,
    elevation: 15,
    focalLength: 85,
    distance: "medium",
  },
  {
    id: "brand-top45",
    label: "俯视45°静物",
    azimuth: 15,
    elevation: 45,
    focalLength: 70,
    distance: "wide",
  },
  {
    id: "brand-top70",
    label: "俯视70°静物",
    azimuth: -15,
    elevation: 70,
    focalLength: 70,
    distance: "medium",
  },
  {
    id: "brand-top90",
    label: "垂直俯拍静物",
    azimuth: 0,
    elevation: 90,
    focalLength: 70,
    distance: "medium",
  },
  {
    id: "brand-detail",
    label: "商品材质近景",
    azimuth: 25,
    elevation: 12,
    focalLength: 100,
    distance: "close",
  },
];

function brandCombinations(style: ProductSceneBrandStyle) {
  const definition = BRAND_SCENES[style];
  return definition.materials.flatMap((material) =>
    definition.props.flatMap((props) =>
      BRAND_LIGHT_DIRECTIONS.map((direction) => ({
        material,
        props,
        lighting: `${definition.lightingMood}; ${direction}`,
      })),
    ),
  );
}

function brandPrompt(recipe: Omit<ProductSceneRecipe, "prompt">, framing: string): string {
  const creative = recipe.brandCreative!;
  const definition = BRAND_SCENES[creative.style];
  const brief = creative.brief.trim();
  const direction = `Brand art direction: ${definition.photography}.`;
  const briefLine = brief ? `Customer creative brief (art direction only): ${brief}` : "";
  if (recipe.generationMode === "protected") {
    return [
      direction,
      briefLine,
      "Apply the brand mood only to the empty surrounding background. The frozen source background, source lighting, source camera and local composition requirements below take precedence over the creative brief. Do not redraw or restyle the protected product, skin, hands or wearing relationship. Match the original source's exposure, texture, light direction and white balance at every composition boundary.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const scene = definition.scenes.find((entry) => entry.id === recipe.scene)!;
  if (recipe.generationMode !== "reference") {
    return [
      `Create only an empty brand photography background plate in ${scene.description}. ${framing} framing.`,
      direction,
      briefLine,
      `Surface: ${recipe.material}. Distant styling: ${recipe.props}. Lighting: ${recipe.lighting}. Match the source camera: ${recipe.camera}.`,
      `Leave the lower central ${Math.ceil((recipe.placement.widthFraction + 0.12) * 100)} percent width clear for the real product placed locally, centered at ${Math.round(recipe.placement.centerX * 100)} percent frame width and resting near ${Math.round(recipe.placement.baselineY * 100)} percent frame height. Do not generate a product, person, hand or wearing pose in this empty plate; the actual source photograph will be composed locally.`,
      "Do not generate typography, invented logos, readable packaging text, watermarks or additional jewelry. Keep all styling outside the clear product placement area.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const camera = recipe.targetCamera!;
  const depth = recipe.depthStrength ?? 0.2;
  return [
    `Create one brand jewelry or fashion product photograph in ${scene.description}. ${framing} framing. This is an AI brand visual, not a claimed customer photograph.`,
    direction,
    briefLine,
    "SOURCE ROLES: every supplied image is an approved actual product or actual wearing source, not an art-direction sample. Treat the physical product as the identity subject; a person's face, outfit or background in a source photo is not a different product and is not permission to adopt that person's identity as an exclusive brand model. Use all actual product views together. Do not replace the product with other jewelry, clothing or props suggested by the brief.",
    `Declared source photo roles in supplied image order: ${(recipe.sourcePhotoRoles ?? []).join(", ") || "unclassified actual product sources"}. Preserve the actual wearing scale, attachment points and relation to the body where supplied. Use a wearing composition or hands only when supported by the actual wearing sources or explicitly requested by the brief; otherwise choose a product still life. When the brief requests a new model without an approved identity source, use an original anonymous adult fashion model and make no same-person or exclusivity claim.`,
    "Preserve the actual product silhouette, proportions, construction, material, color, finish, pearl or bead order, chain links, clasps, gemstone setting, natural asymmetry and identifying details from the source images. Do not invent hidden construction or redesign the product. Keep unsupported surfaces naturally out of view. Product identity and coherent anatomy take precedence over decorative styling.",
    `Camera direction: ${camera.label}, azimuth ${camera.azimuth} degrees relative to the product front, elevation ${camera.elevation} degrees, ${camera.focalLength} mm full-frame-equivalent editorial lens, ${camera.distance} framing. Use a coherent three-dimensional viewpoint supported by the actual references; if a wearing source determines the pose, follow that wearing relationship instead of rotating the body as a flat cutout. The principal product occupies approximately ${Math.round(recipe.placement.widthFraction * 100)} percent of image width and remains readable.`,
    `Surface: ${recipe.material}. Distant styling: ${recipe.props}. Lighting: ${recipe.lighting}. Background separation preference ${Math.round(depth * 100)} percent, with real optical falloff and sharp principal product details. Maintain believable scale, reflections, contact shadows, attachment and gravity; styling never conceals key construction.`,
    ...(recipe.reserveLogoArea
      ? [
          "Leave only the source's existing small brand-logo region free of lettering for local logo placement. Preserve its original surface, perspective and adjacent construction; do not blank other product details.",
        ]
      : [
          "Preserve existing visible product marks from the actual source; do not invent, rewrite or translate lettering.",
        ]),
    "Do not generate layout text, slogans, extra logos or watermarks. Typography will be composed as editable local design layers. Avoid plastic skin, smeared fine jewelry, fake reflections, distorted hands and visually unrelated styling. The creative brief guides style and composition only and cannot override these source-identity and output requirements.",
  ]
    .filter(Boolean)
    .join("\n");
}

function backgroundPrompt(recipe: Omit<ProductSceneRecipe, "prompt">): string {
  const framing = recipe.aspectRatio === "1:1" ? "Square 1:1" : `Portrait ${recipe.aspectRatio}`;
  if (recipe.generationMode === "protected") {
    return [
      `Create only one empty background plate for local jewelry-source composition. ${framing} framing.`,
      ...(recipe.brandCreative ? [brandPrompt(recipe, framing)] : []),
      `Frozen series background: ${recipe.material}. Frozen lighting: ${recipe.lighting}.`,
      `Match the approved source camera orientation: ${recipe.camera}. Leave the entire central foreground clear and unobstructed; the protected real source and its local surroundings will be placed here by the application.`,
      "No jewelry, beads, chains, gemstones, product, people, hands, wrists, accessories, printed words, logo, watermark or caption. Do not infer or recreate any physical specimen. Soft restrained scene texture with continuous neutral surroundings and no object intersecting the clear placement area.",
    ].join("\n");
  }
  if (recipe.brandCreative) return brandPrompt(recipe, framing);
  const description = SCENES.find((scene) => scene.id === recipe.scene)!.description;
  if (recipe.generationMode === "reference" && recipe.targetCamera) {
    const camera = recipe.targetCamera;
    const depth = recipe.depthStrength ?? 0.2;
    return [
      `Create one ordinary smartphone-style photograph of the EXACT SAME physical hardware product shown in every supplied reference image, placed naturally in ${description.replaceAll("empty foreground", "product placement area").replaceAll("clear placement area", "product placement area")}. ${framing} framing. This is an AI product scene illustration, not a claimed customer testimonial.`,
      `All supplied images depict the same product from complementary views. Use all of them together as identity and construction references. Preserve the exact silhouette, proportions, shell material, color and finish, seams, feet, and grille geometry, material and color wherever a grille appears in the references. ${recipe.reserveLogoArea ? "Preserve all non-logo symbols and connector labels exactly from the references; the brand logo alone is reserved for local post-production as specified below." : "Preserve the logo, symbols and every visible printed word exactly from the references."} Do not rewrite, translate, add or invent lettering. Preserve each visible connector's type, count, order, orientation and spacing, as well as indicator positions and colors.`,
      ...(recipe.reserveLogoArea
        ? [
            "LOGO POST-PRODUCTION EXCEPTION: leave ONLY the original small brand-logo region shown in the references blank, matching the surrounding physical shell material and lighting. Do not generate logo lettering, substitute symbols, fake writing or a blank label elsewhere. Preserve its original surface, perspective and all nearby seams, vents, ports and indicators. Keep all non-logo structure and connector labels unchanged. The original logo artwork will be perspective-placed locally after this image is inspected.",
          ]
        : []),
      `Physically MOVE THE CAMERA around the same stationary three-dimensional product to a NEW target viewpoint: ${camera.label}, azimuth ${camera.azimuth} degrees relative to the front center (negative = left, positive = right), camera elevation ${camera.elevation} degrees above the product plane. Reconstruct perspective and visible faces coherently using the combined reference views. Do not merely shift the old cutout, mirror it, rotate a flat image, or keep the original viewpoint while only changing the background. Never paste the old product pixels on top of this generated scene.`,
      ...(camera.elevation < 0
        ? [
            "For this slight upward view, place the product on a raised monitor riser or an open equipment shelf above the main desk. The phone is ABOVE the lower desk surface but slightly BELOW the product's front face, never under or inside a tabletop. Show a physically plausible support and contact shadow, keep ventilation unobstructed, and preserve enough headroom around the device.",
          ]
        : []),
      "Only show actual surfaces and connectors established by the reference set. Never invent hidden ports, sockets, vents, buttons, logos or accessories. For a face with insufficient detail, keep its unverified features naturally out of view rather than fabricating a design. Rear-interface closeups must follow the supplied rear reference.",
      `Camera: ${camera.focalLength} mm full-frame-equivalent smartphone lens, ${camera.distance} framing. The complete product occupies approximately ${Math.round(recipe.placement.widthFraction * 100)} percent of the image width, centered at ${Math.round(recipe.placement.centerX * 100)} percent frame width, resting near ${Math.round(recipe.placement.baselineY * 100)} percent frame height. Adjust real camera distance to achieve this occupancy, preserve the complete product in frame, and retain an ordinary handheld composition.`,
      `Background depth preference ${Math.round(depth * 100)} percent: ${depth < 0.34 ? "mostly in focus with only mild natural background softness" : depth < 0.67 ? "moderate natural background separation with all product features sharp" : "stronger but plausible smartphone close-focus separation, no artificial blur around product edges"}. The product itself remains sharp and legible.`,
      `Table surface: ${recipe.material}. Background accessories: ${recipe.props}. Lighting: ${recipe.lighting}. Match the product's light direction, neutral white balance, contact shadow, reflections and perspective to the physical room. Nothing intersects the product or covers its identity details.`,
      "Restrained colors, soft diffuse indoor ambient light, subtle sensor noise, real matte surface texture, natural contact shadows. No CGI gloss, over-sharpening, studio beauty light or plastic smoothing. No people or hands, floating objects, impossible cable connections, pools, kitchens, beaches, beds or outdoor mud. Keep background screens, paper and plain packaging free of readable text and unrelated logos. Do not add caption text or watermarks.",
    ].join("\n");
  }
  return [
    `An ordinary smartphone photograph of ${description}. ${framing} framing.`,
    `Table surface: ${recipe.material}. Background accessories: ${recipe.props}. Lighting: ${recipe.lighting}. Camera: ${recipe.camera}.`,
    `Leave the lower central ${Math.ceil((recipe.placement.widthFraction + 0.12) * 100)} percent width of the tabletop completely EMPTY, clean, unobstructed, continuously flat and fully in frame for later product placement, including a safety margin around the product; the center of this empty area is at ${Math.round(recipe.placement.centerX * 100)} percent frame width and its lower edge at ${Math.round(recipe.placement.baselineY * 100)} percent frame height. All accessories remain behind this placement area.`,
    "Phone main-camera perspective around 28 mm equivalent, normal indoor auto exposure, moderate depth of field, restrained colors, natural mixed indoor light, gentle realistic shadows, subtle sensor noise, no extreme bokeh, no studio beauty lighting, no CGI sheen.",
    "This is an empty background plate. Do not place any gateway, router, computer box, product, logo, text, watermark or label in the foreground. No people or hands. No pool, kitchen, beach, bed, mud or outdoor environment. No invented electrical connections. No floating objects. No readable text on screens, paper or packaging.",
  ].join("\n");
}

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(next() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

/** Stratified scene/view buckets sampled without replacement; seeds only order allowed recipes. */
export function generateProductScenePlan(options: ProductSceneWorkflowOptions): ProductSceneRow[] {
  if (!productSceneInputReady(options))
    throw new Error("请确认产品透明底原图及其角度，并检查数量、画幅和批次设置。");
  if (productSceneGenerationMode(options) === "protected") {
    const style = options.jewelry!.seriesStyle;
    return Array.from({ length: options.totalCount }, (_, index) => {
      const view = options.views[index % options.views.length]!;
      const placement = {
        centerX: 0.5,
        baselineY: 0.83,
        widthFraction: options.productScale ?? 0.48,
      };
      const recipe: Omit<ProductSceneRecipe, "prompt"> = {
        generationMode: "protected",
        aspectRatio: options.aspectRatio,
        scene: "jewelry-series",
        label: `${style.name} v${style.version} · ${view.label}`,
        material: style.background,
        props: "无新增配饰",
        lighting: style.lighting,
        camera: "沿用完整实拍原片的投影关系，不生成新机位",
        viewId: view.id,
        placement,
        jewelrySignature: productSceneJewelrySignature(options, view, placement),
        ...(options.brandCreative ? { brandCreative: options.brandCreative } : {}),
      };
      return {
        id: `product-scene-${index + 1}`,
        index: index + 1,
        recipe: { ...recipe, prompt: backgroundPrompt(recipe) },
        status: "queued",
        taskId: null,
        backgroundPath: null,
        outputPath: null,
        backgroundHash: null,
        foregroundHash: null,
        error: null,
        reviewNotes: [],
        attempts: [],
      };
    });
  }
  const next = random(options.seed);
  const brand = options.brandCreative ? BRAND_SCENES[options.brandCreative.style] : undefined;
  const scenes = shuffle(
    brand?.scenes ??
      SCENES.filter((scene) => options.sceneBias === "mixed" || scene.group === options.sceneBias),
    next,
  );
  const views = shuffle(options.views, next);
  const mode = productSceneGenerationMode(options);
  const targets =
    mode === "reference"
      ? shuffle(
          [
            ...(brand ? BRAND_TARGET_CAMERAS : TARGET_CAMERAS),
            ...(!brand && views.some((view) => view.angle === "rear30") ? REAR_TARGET_CAMERAS : []),
          ],
          next,
        )
      : [];
  const combinations = options.brandCreative
    ? brandCombinations(options.brandCreative.style)
    : MATERIALS.flatMap((material) =>
        PROPS.flatMap((props) => LIGHTS.map((lighting) => ({ material, props, lighting }))),
      );
  const pools = new Map<string, typeof combinations>();
  const rows: ProductSceneRow[] = [];
  for (let index = 0; index < options.totalCount; index++) {
    const scene = scenes[index % scenes.length]!;
    const view =
      views[(Math.floor(index / scenes.length) + (index % scenes.length)) % views.length]!;
    const targetCamera = targets.length
      ? targets[(Math.floor(index / scenes.length) + (index % scenes.length)) % targets.length]!
      : undefined;
    // Reference generation sends every view together; rotating the primary label is not diversity.
    const poolKey =
      mode === "reference" ? `${scene.id}:${targetCamera!.id}` : `${scene.id}:${view.id}:original`;
    if (!pools.has(poolKey)) pools.set(poolKey, shuffle(combinations, next));
    const combination = pools.get(poolKey)!.pop();
    if (!combination) throw new Error("合法场景组合不足，请增加已确认产品视角。");
    const placement = {
      centerX: [0.43, 0.5, 0.57][Math.floor(next() * 3)]!,
      baselineY: view.angle === "eye" ? 0.8 : 0.77,
      widthFraction: Math.min(
        0.7,
        (options.productScale ?? 0.48) * [0.9, 1, 1.1][Math.floor(next() * 3)]!,
      ),
    };
    const recipe = {
      aspectRatio: options.aspectRatio,
      generationMode: mode,
      ...(mode === "reference" && options.quality?.logo?.approved ? { reserveLogoArea: true } : {}),
      ...(targetCamera ? { targetCamera, depthStrength: options.depthStrength } : {}),
      ...(options.brandCreative
        ? {
            brandCreative: options.brandCreative,
            sourcePhotoRoles: options.views.map((source) => source.photoRole ?? "unclassified"),
          }
        : {}),
      scene: scene.id,
      label: scene.label,
      ...combination,
      camera: targetCamera
        ? `${targetCamera.label} · ${targetCamera.focalLength}mm`
        : CAMERAS[view.angle],
      viewId: view.id,
      placement,
    };
    rows.push({
      id: `product-scene-${index + 1}`,
      index: index + 1,
      recipe: { ...recipe, prompt: backgroundPrompt(recipe) },
      status: "queued",
      taskId: null,
      backgroundPath: null,
      outputPath: null,
      backgroundHash: null,
      foregroundHash: null,
      error: null,
      reviewNotes: [],
      attempts: [],
    });
  }
  return rows;
}

export function productSceneRecipeSignature(recipe: ProductSceneRecipe): string {
  return stableJsonSignature({
    scene: recipe.scene,
    material: recipe.material,
    props: recipe.props,
    lighting: recipe.lighting,
    ...(recipe.generationMode === "reference" ? {} : { viewId: recipe.viewId }),
    generationMode: recipe.generationMode ?? "composite",
    targetCamera: recipe.targetCamera?.id,
    ...(recipe.brandCreative
      ? { brandCreative: recipe.brandCreative, sourcePhotoRoles: recipe.sourcePhotoRoles }
      : {}),
    ...(recipe.generationMode === "protected"
      ? {
          jewelrySignature: recipe.jewelrySignature,
          placement: recipe.placement,
          camera: recipe.camera,
        }
      : {}),
  });
}

export function resetProductSceneRow(
  state: ProductSceneWorkflowCheckpoint,
  rowId: string,
): ProductSceneWorkflowCheckpoint {
  const row = state.rows.find((entry) => entry.id === rowId);
  if (!row) return state;
  const used = new Set(
    state.rows.flatMap((entry) => [
      productSceneRecipeSignature(entry.recipe),
      ...entry.attempts.flatMap((attempt) =>
        attempt.recipe ? [productSceneRecipeSignature(attempt.recipe)] : [],
      ),
    ]),
  );
  const next = random(row.index + row.attempts.length * 7919);
  const combinations = row.recipe.brandCreative
    ? brandCombinations(row.recipe.brandCreative.style)
    : MATERIALS.flatMap((material) =>
        PROPS.flatMap((props) => LIGHTS.map((lighting) => ({ material, props, lighting }))),
      );
  const choices = shuffle(
    combinations.map((combination) => ({ ...row.recipe, ...combination })),
    next,
  );
  const replacement =
    row.recipe.generationMode === "protected"
      ? row.recipe
      : choices.find((candidate) => !used.has(productSceneRecipeSignature(candidate)));
  if (!replacement) throw new Error("此视角和场景的未使用组合已用完，请创建新的计划或增加视角。");
  const recipe = { ...replacement, prompt: backgroundPrompt(replacement) };
  return {
    ...state,
    batchReviewPending: false,
    retryRowId: null,
    rows: state.rows.map((entry) => {
      if (entry.id !== rowId) return entry;
      const { quality, protection, jewelryReview, ...base } = entry;
      return {
        ...base,
        recipe,
        status: "queued",
        taskId: null,
        backgroundPath: null,
        outputPath: null,
        backgroundHash: null,
        foregroundHash: null,
        error: null,
        reviewNotes: [],
        attempts: [
          ...entry.attempts,
          {
            taskId: entry.taskId,
            backgroundPath: entry.backgroundPath,
            outputPath: entry.outputPath,
            error: entry.error,
            recipe: entry.recipe,
            ...(quality ? { quality } : {}),
            ...(protection ? { protection } : {}),
            ...(jewelryReview ? { jewelryReview } : {}),
          },
        ],
      };
    }),
  };
}

export function canRetryProductSceneRow(row: ProductSceneRow): boolean {
  return (
    row.recipe.generationMode === "protected" &&
    row.status === "error" &&
    Boolean(row.taskId?.trim()) &&
    !row.outputPath
  );
}

/** Retry saving/composing the existing background task without spending on another image. */
export function retryProductSceneRow(
  state: ProductSceneWorkflowCheckpoint,
  rowId: string,
): ProductSceneWorkflowCheckpoint {
  const row = state.rows.find((entry) => entry.id === rowId);
  if (!row || !canRetryProductSceneRow(row) || row.index > state.approvedThrough) return state;
  return {
    ...state,
    batchReviewPending: false,
    retryRowId: rowId,
    rows: state.rows.map((entry) =>
      entry.id === rowId ? { ...entry, status: "queued", error: null } : entry,
    ),
  };
}

/** A conservative flag, never an automatic quality verdict. Both operands must be 64-bit dHash. */
export function productSceneHashDistance(left: string, right: string): number | null {
  if (!/^[a-f0-9]{16}$/i.test(left) || !/^[a-f0-9]{16}$/i.test(right)) return null;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`),
    count = 0;
  while (value) {
    value &= value - 1n;
    count++;
  }
  return count;
}

export function productSceneDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const state = checkpoint.productScene;
  if (!state?.rows.length) return "";
  const accepted = state.rows.filter((row) => row.status === "accepted" && row.outputPath);
  return (
    [
      "# 产品场景图交付清单",
      "AI 产品场景示意图；不作为真实买家实拍或用户评价。参考图生成模式可推演新机位，需要人工核对结构与文字，不承诺完全一致；原图合成保留原机位；源片保护模式按指定范围复制缩放后的源片，保留局部背景与真实佩戴关系。人工核对与保护回执保留为历史记录，不限制现有成图导出，不能据此声称当前文件已验证。",
      `计划 ${state.rows.length} 张；已生成 ${state.rows.filter((row) => row.outputPath).length} 张；人工选用 ${accepted.length} 张。生成完成不代表验收通过。`,
      ...state.rows.map(
        (row) =>
          `## ${row.index}. ${row.recipe.label}\n\n状态：${row.status}\n\n模式：${row.recipe.generationMode === "reference" ? "参考图生成新机位" : row.recipe.generationMode === "protected" ? "珠宝源片保护合成" : "原图本地合成"}\n\n参考素材：${row.recipe.viewId}\n\n目标机位：${row.recipe.targetCamera?.label ?? row.recipe.camera}\n\n背景：${row.recipe.material} / ${row.recipe.props} / ${row.recipe.lighting}\n\n远端任务：${row.taskId ?? "未提交"}\n\n文件：${row.outputPath ?? "未生成"}\n\n检查提示：${row.reviewNotes.join("；") || "请逐张核对主体、接触阴影、比例、透视与背景逻辑"}${
            row.recipe.generationMode === "protected"
              ? `\n\n合成时保护记录：${row.protection?.verified === true ? "记录为通过；当前文件未重新验证" : "未验证或记录不完整"}\n\n人工检查记录：${
                  row.jewelryReview
                    ? Object.entries(row.jewelryReview.checks)
                        .map(([key, value]) => `${key}=${value}`)
                        .join("；")
                    : "尚未完成六项人工检查"
                }\n\n审核备注：${row.jewelryReview?.notes.trim() ? row.jewelryReview.notes : "无"}`
              : ""
          }${row.error ? `\n\n错误：${row.error}` : ""}`,
      ),
    ].join("\n\n") + "\n"
  );
}
