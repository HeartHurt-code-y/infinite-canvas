import type { ExplicitMediaInput, PromptSegment } from "./backend";
import type { CanvasVideoMode } from "./canvasVideoMode";
import { videoPromptForMode } from "./videoCameraPresets";
import {
  createPromptContentEditorSession,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptGenerationPreparation,
} from "./promptContent";

export interface VideoStoryboardShot {
  readonly id: string;
  readonly duration: number;
  readonly document: PromptContentDocumentV1;
}

export interface VideoStoryboardConfig {
  readonly enabled: boolean;
  readonly shots: readonly VideoStoryboardShot[];
}

/** LibTV 的 multi_shot / multi_prompt 契约只用于有原生分镜协议的模型。 */
export function supportsVideoStoryboard(modelId: string): boolean {
  return /^kling-(?:(?:video-)?v3(?:\.0)?|3\.0)(?:-omni)?$/i.test(modelId);
}

export const emptyStoryboardDocument = (): PromptContentDocumentV1 => ({ schema: "prompt-content", version: 1, items: [] });

export function storyboardPromptText(document: PromptContentDocumentV1): string {
  const session = createPromptContentEditorSession();
  try {
    session.restore(document);
    return session.read().plainText;
  } finally { session.attach(null); }
}

export function storyboardPromptIssue(text: string): string | null {
  const length = [...text.trim()].length;
  if (length === 0) return "请填写镜头提示词。";
  if (length < 5) return "镜头提示词至少需要 5 个字。";
  if (length > 512) return "镜头提示词不能超过 512 字。";
  return null;
}

export function storyboardIssue(config: VideoStoryboardConfig, totalSeconds: number): string | null {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 3 || totalSeconds > 15) return "智能分镜的视频总时长需要为 3–15 秒的整数。";
  if (config.shots.length < 1 || config.shots.length > 6) return "智能分镜需要 1–6 个镜头。";
  if (config.shots.some(shot => !Number.isInteger(shot.duration) || shot.duration < 1)) return "每个镜头的时长必须是至少 1 秒的整数。";
  const sum = config.shots.reduce((total, shot) => total + shot.duration, 0);
  if (sum !== totalSeconds) return `分镜总时长为 ${sum} 秒，需要与视频时长 ${totalSeconds} 秒一致。`;
  return null;
}

export function prepareVideoStoryboard(config: VideoStoryboardConfig, modelId: string, totalSeconds: number, connections: readonly PromptContentConnection[], autoLink: boolean, mode?: CanvasVideoMode): {
  readonly issue: string | null;
  readonly preparation: PromptGenerationPreparation | null;
  readonly ranges: readonly { readonly start: number; readonly end: number; readonly duration: number }[];
} {
  const fail = (issue: string) => ({ issue, preparation: null, ranges: [] });
  if (!supportsVideoStoryboard(modelId)) return fail("当前模型不支持已启用的智能分镜，请切回可灵 3.0，或关闭智能分镜后生成。");
  const issue = storyboardIssue(config, totalSeconds);
  if (issue) return fail(issue);
  const segments: PromptSegment[] = [];
  const media = new Map<string, ExplicitMediaInput>();
  const mentioned = new Set<string>();
  const ranges: { start: number; end: number; duration: number }[] = [];
  const texts: string[] = [];
  for (const [index, shot] of config.shots.entries()) {
    const session = createPromptContentEditorSession();
    try {
      session.restore(videoPromptForMode(shot.document, mode));
      const prepared = session.prepareGeneration({ connections, allowMediaOnly: false, autoLink });
      if (!prepared.ok) return fail(`镜头 ${index + 1} 的提示词为空或含有未确认的素材引用，请检查该镜头后重试。`);
      const promptIssue = storyboardPromptIssue(prepared.frozen.plainText);
      if (promptIssue) return fail(`镜头 ${index + 1}：${promptIssue}`);
      const start = segments.length;
      segments.push(...prepared.frozen.segments);
      ranges.push({ start, end: segments.length, duration: shot.duration });
      texts.push(prepared.frozen.plainText);
      for (const input of prepared.frozen.explicitMedia) {
        const key = JSON.stringify(input.target);
        if (!media.has(key)) media.set(key, input);
      }
      for (const segment of prepared.frozen.segments) {
        if (segment.kind !== "media_reference") continue;
        const key = JSON.stringify(segment.target);
        if (!media.has(key)) media.set(key, { target: segment.target, displayNameSnapshot: segment.displayNameSnapshot, role: `reference_${segment.target.mediaType}` });
      }
      for (const key of prepared.frozen.mentionedCanvasNodeKeys) mentioned.add(key);
    } finally { session.attach(null); }
  }
  // 整个请求统一编号。同一素材跨镜头复用身份，附件仍走原有素材库解析链路。
  const counts: Record<string, number> = {};
  const positions = new Map<string, { typePosition: number; contentIndex: number }>();
  const explicitMedia = [...media].map(([key, input], index) => {
    const type = input.target.mediaType;
    counts[type] = (counts[type] ?? 0) + 1;
    const position = { typePosition: counts[type], contentIndex: index + 1 };
    positions.set(key, position);
    return { ...input, ...position };
  });
  return {
    issue: null, ranges,
    preparation: { ok: true, frozen: {
      segments: segments.map(segment => segment.kind === "media_reference" ? { ...segment, ...positions.get(JSON.stringify(segment.target))! } : segment),
      explicitMedia, mentionedCanvasNodeKeys: mentioned, plainText: texts.join("\n\n"),
    } },
  };
}
