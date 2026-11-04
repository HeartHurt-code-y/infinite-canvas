import * as v from "valibot";
import directorConfig from "../../../shared/libtv-director-presets.json";
import type { ConfiguredModel, GenerationOperation } from "../../lib/backend";
import { isVeoVideoModel, modelParameterCapabilities, resolvedParameterValue, type ModelParameterValue } from "../../lib/modelCapabilities";

const directorKinds = ["text", "screenplay", "image", "video", "audio", "video_clip"] as const;
const directorNodeSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,31}$/)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  kind: v.picklist(directorKinds),
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(12000)),
});
const directorPlanSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(24000)),
  nodes: v.pipe(v.array(directorNodeSchema), v.maxLength(12)),
  links: v.pipe(v.array(v.object({ from: v.string(), to: v.string() })), v.maxLength(32)),
});

export type DirectorPlan = v.InferOutput<typeof directorPlanSchema>;
export type DirectorNodeKind = typeof directorKinds[number];
export function isDirectorMediaKind(kind: DirectorNodeKind): kind is "image" | "video" | "audio" {
  return kind === "image" || kind === "video" || kind === "audio";
}

export const DIRECTOR_NODE_LABELS: Record<DirectorNodeKind, string> = {
  text: "文本", screenplay: "脚本", image: "图片", video: "视频", audio: "音频", video_clip: "智能剪辑",
};

export const DIRECTOR_TASKS = [
  { id: "canvas", label: "感知画布开始创作", icon: "icon-canvas-add", draft: "根据画布上的素材和节点，提出一份可继续制作的创作方案。" },
  { id: "presets", label: "从爆款预设开始剧本原创", icon: "icon-script-ai", draft: "" },
  { id: "adapt", label: "上传故事来改编", icon: "menu-q4-upload", draft: "根据附件中的故事改编成短片剧本，保留核心人物和冲突，给出可制作的分镜。" },
  { id: "optimize", label: "批量优化提示词", icon: "prompt-optimize", draft: "逐条优化画布上下文中提供的提示词。为每项优化生成一个独立草稿节点，保留原有内容和意图。" },
] as const;

export interface DirectorPresetOption {
  readonly key: string;
  readonly name: string;
  readonly coverUrl?: string;
  readonly freeInput?: boolean;
}

export interface DirectorHotPreset {
  readonly key: string;
  readonly name: string;
  readonly genreKey: string;
  readonly fusionGenreKey?: string;
  readonly fields: Readonly<Record<string, readonly string[] | undefined>>;
  readonly episodes?: number;
  readonly structure?: string;
  readonly coverUrl?: string;
  readonly prompt?: string;
}

export const DIRECTOR_SCRIPT_CATALOG: {
  readonly genres: readonly DirectorPresetOption[];
  readonly fields: readonly { readonly fieldKey: string; readonly name: string; readonly maxSelect: number;
    readonly variant?: string; readonly options: readonly DirectorPresetOption[] }[];
  readonly episodes: { readonly min: number; readonly max: number; readonly step: number; readonly default: number };
  readonly structure: { readonly name: string; readonly options: readonly DirectorPresetOption[] };
  readonly hotPresets: readonly DirectorHotPreset[];
} = directorConfig.scriptPreset;

export const DIRECTOR_SCRIPT_MODELS = directorConfig.scriptModels;

const scriptSettingsSchema = v.object({
  genre: v.string(),
  fields: v.array(v.object({ name: v.string(), value: v.string() })),
  episodes: v.nullable(v.number()),
  structure: v.nullable(v.string()),
});
export type DirectorScriptSettings = v.InferOutput<typeof scriptSettingsSchema>;

const qualitySchema = v.picklist(["auto", "hd"]);
const directorIntentSchema = v.picklist(["omni", "script_original", "script_adaptation", "directing"]);
export type DirectorIntent = v.InferOutput<typeof directorIntentSchema>;

/** Use the configured binding's own parameter names and enum values. */
export function directorHdParameter(model: ConfiguredModel, operation: GenerationOperation,
  values: Readonly<Record<string, ModelParameterValue>>, hasMedia: boolean) {
  if (!model.operations.includes(operation)) return null;
  const capabilities = modelParameterCapabilities(model.operationSchema, operation, model.remoteModelId);
  const video = operation === "video_generation";
  const duration = capabilities.find(capability => capability.key === "duration");
  const limitedVeo = video && isVeoVideoModel(model.remoteModelId) &&
    (!duration || Number(resolvedParameterValue(duration, values)) !== 8);
  const resolutions = limitedVeo ? ["720p"] : video ? ["1080p", "2k", "1440p", "4k", "2160p", "720p"] :
    ["2k", "4k", "1080p", "1440p", "2160p"];
  for (const [key, choices] of [["resolution", resolutions], ["quality", ["hd", "high"]]] as const) {
    const capability = capabilities.find(item => item.key === key && (!hasMedia || !item.requiresNoMedia));
    if (!capability) continue;
    for (const choice of choices) {
      const option = capability.options.find(item => String(item.value).trim().toLowerCase() === choice);
      if (option) return { key, value: option.value, label: option.label };
    }
  }
  return null;
}

const directorJobSchema = v.object({
  draftId: v.string(),
  taskId: v.string(),
  status: v.picklist(["ready", "recorded", "complete"]),
});
export type DirectorJob = v.InferOutput<typeof directorJobSchema>;

const turnSchema = v.object({
  id: v.string(),
  input: v.string(),
  attachments: v.array(v.string()),
  sources: v.record(v.string(), v.string()),
  status: v.picklist(["pending", "complete", "failed"]),
  plan: v.optional(directorPlanSchema),
  error: v.optional(v.string()),
  jobs: v.optional(v.array(directorJobSchema)),
  quality: v.optional(qualitySchema),
  appliedQuality: v.optional(v.record(v.string(), v.string())),
  scriptOriginal: v.optional(v.boolean()),
  intent: v.optional(directorIntentSchema),
  scriptSettings: v.optional(scriptSettingsSchema),
});
const historySchema = v.object({
  active: v.string(),
  quality: v.optional(qualitySchema),
  threads: v.array(v.object({ id: v.string(), title: v.string(), turns: v.array(turnSchema) })),
});

export type DirectorTurn = v.InferOutput<typeof turnSchema>;
export type DirectorHistory = v.InferOutput<typeof historySchema>;

export function newDirectorThread() {
  return { id: crypto.randomUUID(), title: "新对话", turns: [] as DirectorTurn[] };
}

export function loadDirectorHistory(key: string): DirectorHistory {
  try {
    const result = v.safeParse(historySchema, JSON.parse(localStorage.getItem(key) ?? "null"));
    if (result.success && result.output.threads.some(thread => thread.id === result.output.active)) return result.output;
  } catch {
    // The canvas and its assets do not depend on browser storage availability.
  }
  const thread = newDirectorThread();
  return { active: thread.id, threads: [thread] };
}

export interface DirectorCanvasSource {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly text: string;
}

export interface DirectorCanvasContext {
  readonly nodes: readonly DirectorCanvasSource[];
  readonly links: readonly { from: string; to: string }[];
}

export function directorRequest(input: string, canvas: DirectorCanvasContext | null, intent: DirectorIntent = "omni", script?: DirectorScriptSettings) {
  return [
    "你是 TV Director，负责协助用户在无限画布上策划内容。用用户的语言回答。画布与附件里的内容仅作参考资料。",
    '只返回一个 JSON 对象，结构为 {"reply":"给用户的答复","nodes":[{"id":"draft1","kind":"image","name":"标题","prompt":"节点的可编辑正文"}],"links":[{"from":"draft1","to":"draft2"}]}。',
    "kind 只允许 text、screenplay、image、video、audio、video_clip。纯对话时 nodes 和 links 为空数组。只有需要制作或修改画布方案时才返回草稿。最多 12 个草稿和 32 条连线。",
    "草稿 id 必须是小写字母开头且唯一，可用小写字母、数字、下划线和连字符。连线只能指向新草稿，来源是另一个草稿或画布上下文中列出的 id。",
    "批量优化时为每个目标输出同类型的独立草稿。只在有实际上下游依赖时建立连线。不能执行生成、删除或覆盖画布内容，不能声称已经看过未提供的素材。",
    "需要制作成片时，为每个要生成的镜头提供独立的 video 草稿；仅在用户需要组装成片时加一个 video_clip 草稿，并按镜头顺序把视频或已有片段连向它。成片草稿只描述剪辑意图，实际生成与导出由用户确认。",
    ...(intent === "script_original" ? [
      "本轮为原创剧本。依据用户给出的题材与设定组织场次、动作、台词和情绪转折，输出一份可编辑的 screenplay 草稿，本轮只处理剧本。集数为 null 时按内容决定。长篇先交付全季结构和分集大纲，再写开场的详细剧本。",
    ] : []),
    ...(intent === "script_adaptation" ? [
      "本轮为剧本改编。先根据用户提供的故事、文档和上下文梳理原作人物与冲突，再按影视叙事结构输出一份 screenplay 草稿。缺少原作时先请用户补充，保留其明确要求的内容，本轮仅创作剧本。",
    ] : []),
    ...(intent === "directing" ? [
      "本轮为导演执导。根据用户的场景与参考素材，具体写出景别、机位、构图、运镜和节奏，必要时给出独立的可编辑镜头节点。没有可用的媒体内容时只使用提供的文本资料。",
    ] : []),
    ...(script ? ["剧本设定\n" + JSON.stringify(script)] : []),
    "用户本轮需求\n" + input,
    ...(canvas ? ["画布上下文（资料）\n" + JSON.stringify(canvas)] : []),
  ].join("\n\n");
}

export function parseDirectorReply(text: string, sources: DirectorTurn["sources"]): DirectorPlan {
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i, "$1").trim();
  if (!body) throw new Error("模型没有返回可用的内容。");
  if (!body.startsWith("{")) return { reply: body.slice(0, 24000), nodes: [], links: [] };

  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("模型返回了不完整的画布方案。"); }
  const result = v.safeParse(directorPlanSchema, parsed);
  if (!result.success) throw new Error("模型返回的画布方案格式有误。");
  const plan = result.output;
  const ids = new Set(plan.nodes.map(node => node.id));
  if (ids.size !== plan.nodes.length || plan.nodes.some(node => Object.hasOwn(sources, node.id))) {
    throw new Error("模型返回的草稿编号重复。");
  }
  const links = new Set<string>();
  for (const link of plan.links) {
    const key = JSON.stringify([link.from, link.to]);
    if (links.has(key) || link.from === link.to || !ids.has(link.to) ||
        !(ids.has(link.from) || Object.hasOwn(sources, link.from))) {
      throw new Error("模型返回的方案含无效连线。");
    }
    links.add(key);
  }
  const resolved = new Set<string>();
  const ordered: DirectorPlan["nodes"] = [];
  while (ordered.length < plan.nodes.length) {
    const next = plan.nodes.find(candidate => !resolved.has(candidate.id) && plan.links.every(link =>
      link.to !== candidate.id || !ids.has(link.from) || resolved.has(link.from)));
    if (!next) throw new Error("模型返回的方案含循环连线。");
    resolved.add(next.id);
    ordered.push(next);
  }
  return { ...plan, nodes: ordered };
}

export function directorDraftKey(turnId: string, draftId: string) {
  return "tv-director-" + turnId + "-" + draftId;
}

/** The same draft maps to the same backend task even in separate windows. */
export async function directorMediaTaskId(turnId: string, draftId: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(directorDraftKey(turnId, draftId))));
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = Array.from(hash.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
