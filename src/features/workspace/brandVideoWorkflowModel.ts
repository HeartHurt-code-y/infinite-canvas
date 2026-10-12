import type { PickedPromptMaterial } from "../../lib/backend";
import type { BrandModelSelection } from "../../lib/brandModels";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import type { WorkflowRequirement, WorkflowRequirements } from "./workflowFieldRequirements";

export interface BrandVideoWorkflowOptions {
  readonly brandName: string;
  readonly seriesTitle: string;
  readonly brief: string;
  readonly productFacts: string;
  readonly productImages: readonly PickedPromptMaterial[];
  readonly style: "editorial" | "retro" | "quiet";
  readonly occasion: string;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  readonly deliverable: "video" | "documents";
  readonly model?: BrandModelSelection;
}

export interface BrandVideoSourceImage {
  readonly id: string;
  readonly label: string;
  readonly role: "product" | "model";
  readonly path: string;
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}

export interface BrandVideoConcept {
  readonly title: string;
  readonly idea: string;
  readonly visualDirection: string;
  readonly soundDirection: string;
  readonly copy: string;
}

export interface BrandVideoWorkflowCheckpoint {
  readonly inputSignature: string | null;
  readonly concept: BrandVideoConcept | null;
  readonly sourceImages: readonly BrandVideoSourceImage[];
  readonly shotSubjects: Readonly<Record<string, "product" | "model" | "imagery">>;
  readonly model?: BrandModelSelection;
  readonly planningComplete: boolean;
  readonly version: number;
  readonly createdAt: number | null;
  readonly durationNote: string;
}

export function createBrandVideoOptions(): BrandVideoWorkflowOptions {
  return {
    brandName: "",
    seriesTitle: "",
    brief: "",
    productFacts: "",
    productImages: [],
    style: "editorial",
    occasion: "新品系列",
    durationSeconds: 20,
    aspectRatio: "9:16",
    deliverable: "video",
  };
}

export function createBrandVideoCheckpoint(): BrandVideoWorkflowCheckpoint {
  return {
    inputSignature: null,
    concept: null,
    sourceImages: [],
    shotSubjects: {},
    planningComplete: false,
    version: 0,
    createdAt: null,
    durationNote: "",
  };
}

export function brandVideoReferencePathKey(path: string): string {
  const trimmed = path.trim();
  return /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(trimmed)
    ? trimmed.replaceAll("/", "\\").toLowerCase()
    : trimmed;
}

/** The same missing-input list powers UI readiness and the runner's validation. */
export function brandVideoRequirements(options: BrandVideoWorkflowOptions): WorkflowRequirements {
  const missing: WorkflowRequirement[] = [];
  if (!options.brandName.trim() && !options.brief.trim())
    missing.push({
      field: "品牌或视频主题",
      hint: "填写品牌名称或视频创意要求，说明这次要表达的主题。",
    });
  if (
    options.deliverable === "video" &&
    options.productFacts.trim() &&
    !options.productImages.length
  )
    missing.push({
      field: "真实商品图",
      hint: "商品视频需要至少一张实物参考图；请添加本款商品的原图，或切换到文档交付。",
    });
  if (
    options.productImages.some(
      (image) => image.kind !== "image" || !image.localPath.trim() || image.byteSize <= 0,
    )
  )
    missing.push({
      field: "商品参考",
      hint: "商品参考中有无效文件；请移除并重新选择可读取的图片。",
    });
  const allPaths = [
    ...options.productImages.map((image) => image.localPath),
    ...(options.model?.references.map((image) => image.path) ?? []),
  ].map(brandVideoReferencePathKey);
  if (new Set(allPaths).size !== allPaths.length)
    missing.push({
      field: "参考图用途",
      hint: "同一个文件被重复引用，或同时作为商品和模特参考。请保留一个用途，并为另一个用途选择独立的商品原图或模特身份图。",
    });
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0)
    missing.push({ field: "目标时长", hint: "视频总时长必须为正数；可恢复推荐的 20 秒。" });
  if (
    !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(options.aspectRatio) ||
    options.aspectRatio.split(":").some((n) => Number(n) <= 0)
  )
    missing.push({ field: "画幅", hint: "填写有效画幅，例如 9:16 或 16:9。" });
  if (
    !["editorial", "retro", "quiet"].includes(options.style) ||
    !["video", "documents"].includes(options.deliverable)
  )
    missing.push({ field: "制作设置", hint: "品牌风格或交付方式无效；请重新选择。" });
  return missing;
}

export function brandVideoInputReady(options: BrandVideoWorkflowOptions): boolean {
  return brandVideoRequirements(options).length === 0;
}

export function brandVideoInputSignature(options: BrandVideoWorkflowOptions): string {
  // Switching to documents may stop paid production without losing an already frozen plan.
  return stableJsonSignature({ ...options, deliverable: undefined });
}

export function brandVideoDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const brand = checkpoint.brandVideo;
  if (!brand) return "";
  const parts = [
    `# ${brand.concept?.title ?? "品牌视频制作文档"}`,
    `方案版本：v${brand.version} · 分镜版本：${checkpoint.planRevision}\n运行身份：${checkpoint.runId ?? "未开始"}\n输入签名：${brand.inputSignature ?? "未冻结"}\n${brand.durationNote}`,
  ];
  if (brand.concept)
    parts.push(
      `## 创意与视觉方向\n\n${brand.concept.idea}\n\n${brand.concept.visualDirection}\n\n声音方向：${brand.concept.soundDirection}\n\n品牌文案：${brand.concept.copy}`,
    );
  if (brand.model)
    parts.push(
      `## 定稿数字模特\n\n${brand.model.name}\n档案：${brand.model.profileId}\n版本：${brand.model.versionId}\n签名：${brand.model.signature}\n${brand.model.description}\n固定身份：${brand.model.invariants}`,
    );
  parts.push(
    `## 实际参考资产\n\n${brand.sourceImages.map((source) => `- ${source.id} · ${source.label} · ${source.role}\n  路径：${source.path}\n  SHA-256：${source.contentHash}\n  任务：${source.taskId ?? "本地原图"}${source.resultIndex == null ? "" : ` / 结果 ${source.resultIndex}`}`).join("\n") || "纯意象片，没有固定商品或人物参考。"}`,
  );
  parts.push(
    `## 可执行分镜\n\n${checkpoint.shots
      .map((shot) => {
        const run = checkpoint.shotRuns[shot.id];
        return `### ${shot.sequence}. ${shot.title} · ${shot.durationSeconds} 秒\n\n${shot.visual}\n\n${shot.videoPrompt}\n\n参考：${(shot.referenceAssetIds ?? []).join("、") || "无"}\n验收：${shot.acceptance}\n视频任务：${run?.videoTaskId ?? "未提交"}\n片段：${run?.clipPath ?? "未生成"}\n质检：${run?.qcReport ?? "待生成后检查"}`;
      })
      .join("\n\n")}`,
  );
  if (checkpoint.finalPath) parts.push(`## 成片\n\n${checkpoint.finalPath}`);
  parts.push(
    "## 交付复核\n\n模型检查只记录可见证据。商品细节、跨镜人物身份、材质、佩戴动作与声音需对照原图和片段人工复核；首镜、片段采用和最终成片分别确认。声音方向是制作要求，是否真实输出由当前视频模型和已保存片段决定。",
  );
  return `${parts.join("\n\n---\n\n")}\n`;
}
