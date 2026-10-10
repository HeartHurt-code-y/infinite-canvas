import { stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  ReelbenchShot as NativeReelbenchShot,
  ReelbenchShotDraft as NativeReelbenchShotDraft,
  ReelbenchValidation as NativeReelbenchValidation,
} from "../../lib/reelbenchBackend";
import {
  requirementsMet,
  type WorkflowRequirement,
  type WorkflowRequirements,
} from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";

export const REELBENCH_SIZES = [
  "none",
  "extreme-wide",
  "wide",
  "medium-wide",
  "medium",
  "medium-close",
  "close",
  "extreme-close",
] as const;
export const REELBENCH_CATEGORIES = [
  "establishing",
  "subject",
  "dialogue",
  "reaction",
  "insert",
  "pov",
  "empty",
  "product",
  "text-card",
  "transition",
  "archive",
] as const;
export const REELBENCH_CAMERAS = [
  "static",
  "push-in",
  "pull-out",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "truck-left",
  "truck-right",
  "pedestal-up",
  "pedestal-down",
  "tracking",
  "arc",
  "whip-pan",
  "handheld",
  "shake",
  "rack-focus",
  "micro-push",
  "roll",
  "drone",
] as const;
export const REELBENCH_TRANSITIONS = [
  "cut",
  "dissolve",
  "fade-in",
  "fade-out",
  "whip",
  "match-cut",
  "wipe",
  "morph",
] as const;
export const REELBENCH_RHYTHMS = [
  "hook",
  "setup",
  "build",
  "beat",
  "turn",
  "payoff",
  "breath",
  "close",
] as const;

export type ReelbenchSize = (typeof REELBENCH_SIZES)[number];
export type ReelbenchCategory = (typeof REELBENCH_CATEGORIES)[number];
export type ReelbenchCamera = (typeof REELBENCH_CAMERAS)[number];
export type ReelbenchTransition = (typeof REELBENCH_TRANSITIONS)[number];
export type ReelbenchRhythm = (typeof REELBENCH_RHYTHMS)[number];

export interface ReelbenchWorkflowOptions {
  readonly sourceUrl: string;
  readonly localVideoPath: string;
  readonly localVideoName: string;
  /** Changes the emphasis of the shot descriptions, not measured boundaries. */
  readonly purpose: "remake" | "editing" | "inventory";
  readonly language: "zh" | "en";
  readonly sceneThreshold: number;
  readonly minShotSeconds: number;
  readonly includeSyncVideo: boolean;
  readonly syncScale: number;
}

export interface ReelbenchShotAnnotation {
  readonly id: string;
  readonly size: ReelbenchSize;
  readonly category: ReelbenchCategory;
  readonly camera: ReelbenchCamera;
  readonly frame: string;
  readonly transitionIn: ReelbenchTransition;
  readonly subjects: readonly string[];
  readonly onscreenText: string;
  readonly audio: string;
  readonly rhythm?: ReelbenchRhythm;
  readonly rhythmNote?: string;
  readonly note: string;
}

export type ReelbenchShot = NativeReelbenchShot;
export type ReelbenchShotDraft = NativeReelbenchShotDraft;
export type ReelbenchValidation = NativeReelbenchValidation;

export interface ReelbenchWorkflowCheckpoint {
  /** Increments only for user-authored shot and cut changes, not model progress. */
  readonly manualRevision: number;
  readonly inputSignature: string | null;
  readonly step:
    "source" | "seed" | "annotate" | "validate" | "review" | "report" | "sync" | "done";
  readonly downloadJobId: string | null;
  readonly videoPath: string | null;
  readonly draft: ReelbenchShotDraft | null;
  readonly validation: ReelbenchValidation | null;
  readonly validatedDraftSignature: string | null;
  /** One authored-history baseline after a complete shot table has been assembled. */
  readonly completedDraftSignature: string | null;
  /** One atomic approval of the complete, validated shot table. */
  readonly approvedDraftSignature: string | null;
  readonly pendingRecut: {
    readonly splitCuts: readonly number[];
    readonly mergeCuts: readonly number[];
  } | null;
  readonly reportJsonPath: string | null;
  readonly reportMarkdownPath: string | null;
  readonly reportHtmlPath: string | null;
  readonly syncVideoPath: string | null;
}

export function createReelbenchOptions(): ReelbenchWorkflowOptions {
  return {
    sourceUrl: "",
    localVideoPath: "",
    localVideoName: "",
    purpose: "remake",
    language: "zh",
    sceneThreshold: 0.3,
    minShotSeconds: 0.25,
    includeSyncVideo: false,
    syncScale: 1,
  };
}

export function createReelbenchCheckpoint(): ReelbenchWorkflowCheckpoint {
  return {
    manualRevision: 0,
    inputSignature: null,
    step: "source",
    downloadJobId: null,
    videoPath: null,
    draft: null,
    validation: null,
    validatedDraftSignature: null,
    completedDraftSignature: null,
    approvedDraftSignature: null,
    pendingRecut: null,
    reportJsonPath: null,
    reportMarkdownPath: null,
    reportHtmlPath: null,
    syncVideoPath: null,
  };
}

export function reelbenchSourceUrl(value: string): string | null {
  const matches = value.match(/https?:\/\/[^\s<>"'，。；！）】]+/gi) ?? [];
  if (matches.length !== 1) return null;
  try {
    const url = new URL(matches[0].replace(/[),.;!?]+$/, ""));
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

/**
 * 拉片工作流尚缺的必填项。
 *
 * 只有**一条真实原片**是真正的必填：文本模型分析的是本机抽出的画面，主题文字
 * 无法代替原片。切点、时长、倍率都有推荐默认值，正常状态下不会出现在清单里；
 * 只有被手动改成越界值（或在数字输入框里清空成 NaN）时才列出——此时输入确实
 * 做不出结果，而且必须说清是哪一项，否则用户只能看到按钮变灰。
 */
export function reelbenchRequirements(options: ReelbenchWorkflowOptions): WorkflowRequirements {
  const requirements: WorkflowRequirement[] = [];
  const hasLocal = Boolean(options.localVideoPath.trim());
  const hasUrl = Boolean(options.sourceUrl.trim());
  if (!hasLocal && !hasUrl)
    requirements.push({
      field: "原片视频",
      hint: "粘贴一条视频分享链接，或选择一个本地视频文件；文字描述不能代替原片。",
    });
  else if (hasLocal && hasUrl)
    requirements.push({
      field: "原片来源",
      hint: "本地视频与分享链接只能选一种：移除本地视频，或清空分享链接。",
    });
  else if (!hasLocal && reelbenchSourceUrl(options.sourceUrl) === null)
    requirements.push({
      field: "视频分享链接",
      hint: "需要一条完整且唯一的 http(s) 分享链接，或改用本地视频。",
    });
  if (
    !Number.isFinite(options.sceneThreshold) ||
    options.sceneThreshold < 0.05 ||
    options.sceneThreshold > 0.9
  )
    requirements.push({ field: "切点敏感度", hint: "填写 0.05～0.9 之间的数值，推荐 0.3。" });
  if (
    !Number.isFinite(options.minShotSeconds) ||
    options.minShotSeconds < 0.1 ||
    options.minShotSeconds > 5
  )
    requirements.push({ field: "最短镜头（秒）", hint: "填写 0.1～5 之间的数值，推荐 0.25。" });
  if (!Number.isFinite(options.syncScale) || options.syncScale < 1 || options.syncScale > 3)
    requirements.push({ field: "同步视频画面倍率", hint: "选择 1×、2× 或 3×，默认 1×。" });
  return requirements;
}

/** 界面拦截与缺口清单同源：`需求清单为空` 即 `可以开始`。 */
export function reelbenchInputReady(_brief: string, options: ReelbenchWorkflowOptions): boolean {
  return requirementsMet(reelbenchRequirements(options));
}

export function reelbenchInputSignature(config: KnowledgeVideoWorkflowConfig): string {
  return stableJsonSignature({
    options: config.reelbench,
    brief: config.brief,
    textModel: config.models.text,
  });
}

export function reelbenchDraftSignature(draft: ReelbenchShotDraft): string {
  return stableJsonSignature({
    runId: draft.runId,
    sourceIdentity: draft.sourceIdentity,
    meta: draft.meta,
    sceneThreshold: draft.sceneThreshold,
    minShotSeconds: draft.minShotSeconds,
    seedCuts: draft.seedCuts,
    manualCuts: draft.manualCuts,
    cast: draft.cast,
    shots: draft.shots.map((shot) =>
      Object.fromEntries(
        Object.entries(shot).filter(([key]) => key !== "frameAPath" && key !== "frameBPath"),
      ),
    ),
  });
}

export function reelbenchShotIsAnnotated(shot: ReelbenchShot): boolean {
  return Boolean(shot.size && shot.category && shot.camera && shot.frame?.trim());
}

/** Keep the native subjects gate satisfiable as each annotation batch is saved. */
export function reelbenchRegisterSubjects(draft: ReelbenchShotDraft): ReelbenchShotDraft {
  const known = new Set(draft.cast.map((member) => member.id));
  const added: ReelbenchShotDraft["cast"] = [];
  for (const shot of draft.shots) {
    for (const subject of shot.subjects) {
      if (known.has(subject)) continue;
      known.add(subject);
      added.push({ id: subject, name: subject, note: "" });
    }
  }
  return added.length ? { ...draft, cast: [...draft.cast, ...added] } : draft;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("镜头标注必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value))
    throw new Error(`${label} 不在允许的词表内。`);
  return value;
}

function line(value: unknown, label: string, required = false): string {
  if (typeof value !== "string" || value.length > 4000 || (required && !value.trim()))
    throw new Error(`${label} 必须是有效文字。`);
  if (/https?:\/\/|www\.|\b(?:reelbench|eternityspring)\b/i.test(value))
    throw new Error(`${label} 包含第三方跳转或来源标记，请只保留画面事实。`);
  return value.trim();
}

/** Model may describe a shot, but can never replace machine-measured IDs or boundaries. */
export function parseReelbenchAnnotationBatch(
  raw: string,
  expectedIds: readonly string[],
): readonly ReelbenchShotAnnotation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("镜头标注不是有效 JSON。");
  }
  const document = record(parsed);
  if (document["schemaVersion"] != null && document["schemaVersion"] !== "shot-analysis.v1")
    throw new Error("镜头标注协议版本无效。");
  const rows = document["shots"];
  if (!Array.isArray(rows) || rows.length !== expectedIds.length)
    throw new Error("镜头标注数量与实际联系表不一致。");
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const result = rows.map((entry): ReelbenchShotAnnotation => {
    const value = record(entry);
    const id = line(value["id"], "镜头 ID", true);
    if (!expected.has(id) || seen.has(id)) throw new Error("镜头标注包含遗漏、重复或无关 ID。");
    seen.add(id);
    const subjects = value["subjects"] ?? [];
    if (
      !Array.isArray(subjects) ||
      subjects.length > 20 ||
      subjects.some((item) => typeof item !== "string")
    )
      throw new Error(`${id} 的出场主体格式无效。`);
    const rhythm =
      value["rhythm"] == null || value["rhythm"] === ""
        ? undefined
        : oneOf(value["rhythm"], REELBENCH_RHYTHMS, `${id} 节奏`);
    return {
      id,
      size: oneOf(value["size"], REELBENCH_SIZES, `${id} 景别`),
      category: oneOf(value["category"], REELBENCH_CATEGORIES, `${id} 类别`),
      camera: oneOf(value["camera"], REELBENCH_CAMERAS, `${id} 运镜`),
      frame: line(value["frame"], `${id} 画面`, true),
      transitionIn: oneOf(value["transitionIn"] ?? "cut", REELBENCH_TRANSITIONS, `${id} 转场`),
      subjects: subjects.map((item) => line(item, `${id} 主体`, true)),
      onscreenText: line(value["onscreenText"] ?? "", `${id} 画面文字`),
      audio: line(value["audio"] ?? "", `${id} 台词`),
      ...(rhythm ? { rhythm, rhythmNote: line(value["rhythmNote"], `${id} 节奏理由`, true) } : {}),
      note: line(value["note"] ?? "", `${id} 备注`),
    };
  });
  return expectedIds.map((id) => result.find((item) => item.id === id)!);
}
