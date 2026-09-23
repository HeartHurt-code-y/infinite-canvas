import { stableJsonSignature } from "../../lib/workflowSignatures";
import {
  productSceneQualityEnabled,
  productSceneQualityOptionsValid,
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

export type ProductSceneAngle = "front45" | "rear30" | "eye" | "top45" | "top90";
export type ProductSceneGenerationMode = "reference" | "composite";
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
}
export interface ProductSceneWorkflowOptions {
  /** Missing on legacy plans means composite, so saved paid tasks never change operation. */
  readonly generationMode?: ProductSceneGenerationMode;
  readonly productName: string;
  readonly totalCount: number;
  readonly batchSize: number;
  readonly sceneBias: "mixed" | "geek" | "office" | "unboxing";
  readonly aspectRatio: "3:4" | "9:16";
  readonly depthStrength: number;
  /** Product width as a fraction of the frame width; older saved options use 0.48. */
  readonly productScale?: number;
  readonly seed: number;
  readonly views: readonly ProductSceneView[];
  readonly quality?: ProductSceneQualityOptions;
}
export interface ProductSceneRecipe {
  readonly generationMode?: ProductSceneGenerationMode;
  readonly targetCamera?: ProductSceneTargetCamera;
  readonly depthStrength?: number;
  readonly reserveLogoArea?: boolean;
  readonly aspectRatio: "3:4" | "9:16";
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
}

export function createProductSceneOptions(): ProductSceneWorkflowOptions {
  return {
    generationMode: "reference",
    productName: "魔芋 Ai 网关",
    totalCount: 500,
    batchSize: 10,
    sceneBias: "mixed",
    aspectRatio: "3:4",
    depthStrength: 0.2,
    productScale: 0.48,
    seed: 20260923,
    views: [],
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
export function productSceneInputSignature(config: KnowledgeVideoWorkflowConfig): string {
  return stableJsonSignature({
    options: config.productScene,
    model: config.models.image,
    parameters: config.imageParameterValues,
    ...(config.productScene && productSceneQualityEnabled(config.productScene)
      ? { inspectionModel: config.models.text }
      : {}),
  });
}
export function productSceneInputReady(options: ProductSceneWorkflowOptions): boolean {
  return (
    Boolean(options.productName.trim()) &&
    productSceneQualityOptionsValid(options) &&
    ["reference", "composite"].includes(productSceneGenerationMode(options)) &&
    Number.isInteger(options.totalCount) &&
    options.totalCount >= 1 &&
    options.totalCount <= 500 &&
    Number.isInteger(options.batchSize) &&
    options.batchSize >= 1 &&
    options.batchSize <= 50 &&
    ["mixed", "geek", "office", "unboxing"].includes(options.sceneBias) &&
    ["3:4", "9:16"].includes(options.aspectRatio) &&
    Number.isFinite(options.depthStrength) &&
    options.depthStrength >= 0 &&
    options.depthStrength <= 1 &&
    Number.isFinite(options.productScale ?? 0.48) &&
    (options.productScale ?? 0.48) >= 0.3 &&
    (options.productScale ?? 0.48) <= 0.65 &&
    Number.isSafeInteger(options.seed) &&
    options.views.length > 0 &&
    new Set(options.views.map((view) => view.id)).size === options.views.length &&
    new Set(options.views.map((view) => view.contentHash.toLowerCase())).size ===
      options.views.length &&
    options.views.every((view) =>
      Boolean(
        view.id &&
        view.label.trim() &&
        view.sourcePath.trim() &&
        view.preparedPath.trim() &&
        /^[a-f0-9]{64}$/i.test(view.contentHash) &&
        view.approved &&
        ["front45", "rear30", "eye", "top45", "top90"].includes(view.angle),
      ),
    )
  );
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

function backgroundPrompt(recipe: Omit<ProductSceneRecipe, "prompt">): string {
  const description = SCENES.find((scene) => scene.id === recipe.scene)!.description;
  if (recipe.generationMode === "reference" && recipe.targetCamera) {
    const camera = recipe.targetCamera;
    const depth = recipe.depthStrength ?? 0.2;
    return [
      `Create one ordinary smartphone-style photograph of the EXACT SAME physical hardware product shown in every supplied reference image, placed naturally in ${description.replaceAll("empty foreground", "product placement area").replaceAll("clear placement area", "product placement area")}. Portrait ${recipe.aspectRatio} framing. This is an AI product scene illustration, not a claimed customer testimonial.`,
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
    `An ordinary smartphone photograph of ${description}. Portrait ${recipe.aspectRatio} framing.`,
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
  const next = random(options.seed);
  const scenes = shuffle(
    SCENES.filter((scene) => options.sceneBias === "mixed" || scene.group === options.sceneBias),
    next,
  );
  const views = shuffle(options.views, next);
  const mode = productSceneGenerationMode(options);
  const targets =
    mode === "reference"
      ? shuffle(
          [
            ...TARGET_CAMERAS,
            ...(views.some((view) => view.angle === "rear30") ? REAR_TARGET_CAMERAS : []),
          ],
          next,
        )
      : [];
  const combinations = MATERIALS.flatMap((material) =>
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
  const choices = shuffle(
    MATERIALS.flatMap((material) =>
      PROPS.flatMap((props) =>
        LIGHTS.map((lighting) => ({ ...row.recipe, material, props, lighting })),
      ),
    ),
    next,
  );
  const replacement = choices.find(
    (candidate) => !used.has(productSceneRecipeSignature(candidate)),
  );
  if (!replacement) throw new Error("此视角和场景的未使用组合已用完，请创建新的计划或增加视角。");
  const recipe = { ...replacement, prompt: backgroundPrompt(replacement) };
  return {
    ...state,
    batchReviewPending: false,
    rows: state.rows.map((entry) => {
      if (entry.id !== rowId) return entry;
      const { quality, ...base } = entry;
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
          },
        ],
      };
    }),
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
      "AI 产品场景示意图；不作为真实买家实拍或用户评价。参考图生成模式可推演新机位，需要人工核对硬件结构与文字，不承诺像素或结构完全一致；原图合成模式保留已有拍摄角度。",
      `计划 ${state.rows.length} 张；已生成 ${state.rows.filter((row) => row.outputPath).length} 张；人工选用 ${accepted.length} 张。生成完成不代表验收通过。`,
      ...state.rows.map(
        (row) =>
          `## ${row.index}. ${row.recipe.label}\n\n状态：${row.status}\n\n模式：${row.recipe.generationMode === "reference" ? "参考图生成新机位" : "原图本地合成"}\n\n参考素材：${row.recipe.viewId}\n\n目标机位：${row.recipe.targetCamera?.label ?? row.recipe.camera}\n\n背景：${row.recipe.material} / ${row.recipe.props} / ${row.recipe.lighting}\n\n远端任务：${row.taskId ?? "未提交"}\n\n文件：${row.outputPath ?? "未生成"}\n\n检查提示：${row.reviewNotes.join("；") || "请逐张核对主体、接触阴影、比例、透视与背景逻辑"}${row.error ? `\n\n错误：${row.error}` : ""}`,
      ),
    ].join("\n\n") + "\n"
  );
}
