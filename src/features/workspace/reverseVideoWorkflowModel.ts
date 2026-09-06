import type {
  ReverseVideoDelivery,
  ReverseVideoEvidence,
  ReverseVideoLearning,
} from "../../lib/reverseVideo";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

export interface ReverseVideoWorkflowOptions {
  readonly sourceUrl: string;
  readonly localVideoPath: string;
  readonly localVideoName: string;
}

export interface ReverseVideoBeat {
  readonly start: number;
  readonly end: number;
  readonly action: string;
  readonly camera: string;
  readonly audio: string;
  readonly evidence: string;
}

export const REVERSE_VIDEO_DIMENSIONS = {
  subject: "主体",
  styling: "造型与道具",
  scene: "场景",
  lighting: "光线",
  color: "色调",
  camera: "运镜",
  composition: "景别与构图",
  emotion: "情绪氛围",
  contentType: "内容类型",
  hook: "开头钩子",
} as const;

export interface ReverseVideoAnalysis {
  readonly schemaVersion: "reverse-video-analysis.v1";
  readonly title: string;
  readonly summary: string;
  readonly dimensions: Readonly<Record<keyof typeof REVERSE_VIDEO_DIMENSIONS, string>>;
  readonly globalSettings: string;
  readonly scenes: string;
  readonly timeline: readonly ReverseVideoBeat[];
  readonly ending: {
    readonly beats: readonly ReverseVideoBeat[];
    readonly finalFrame: string;
    readonly evidence: string;
  };
  readonly replicationPrompt: string;
  readonly viralDiagnosis: Readonly<
    Record<"hook" | "emotion" | "memory" | "replicable" | "replace", string>
  >;
  readonly remixes: readonly {
    readonly route: "skin" | "viewpoint" | "narrative";
    readonly title: string;
    readonly retained: string;
    readonly replaced: string;
    readonly prompt: string;
    readonly expectedEffect: string;
    readonly risk: string;
  }[];
  readonly priority: string;
  readonly pitfalls: readonly string[];
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
}

export interface ReverseVideoReview {
  readonly result: "PASS" | "REVISE" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairInstructions?: string;
  readonly question?: string;
  readonly recommendation?: string;
}

export interface ReverseVideoWorkflowCheckpoint {
  readonly inputSignature?: string;
  readonly step: "download" | "sampling" | "analysis" | "review" | "archive" | "done";
  readonly downloadJobId: string | null;
  readonly videoPath: string | null;
  readonly evidence: ReverseVideoEvidence | null;
  readonly analysis: ReverseVideoAnalysis | null;
  readonly review: ReverseVideoReview | null;
  readonly repairCount: number;
  readonly history: readonly {
    readonly analysis: ReverseVideoAnalysis;
    readonly review: ReverseVideoReview | null;
  }[];
  readonly learning: ReverseVideoLearning | null;
  readonly delivery: ReverseVideoDelivery | null;
  readonly confirmedDecisions?: readonly string[];
}

export function createReverseVideoOptions(): ReverseVideoWorkflowOptions {
  return { sourceUrl: "", localVideoPath: "", localVideoName: "" };
}

export function createReverseVideoCheckpoint(): ReverseVideoWorkflowCheckpoint {
  return {
    step: "download",
    downloadJobId: null,
    videoPath: null,
    evidence: null,
    analysis: null,
    review: null,
    repairCount: 0,
    history: [],
    learning: null,
    delivery: null,
  };
}

/** Accept a platform share message, but never silently choose between several links. */
export function reverseVideoSourceUrl(value: string): string | null {
  const matches = value.match(/https?:\/\/[^\s<>"'，。；！）】]+/gi) ?? [];
  if (matches.length !== 1) return null;
  try {
    const result = new URL(matches[0].replace(/[),.;!?]+$/, ""));
    return result.username || result.password ? null : result.href;
  } catch {
    return null;
  }
}

export function reverseVideoInputReady(
  _brief: string,
  options: ReverseVideoWorkflowOptions,
): boolean {
  const hasLocal = Boolean(options.localVideoPath.trim());
  const hasUrl = Boolean(options.sourceUrl.trim());
  return hasLocal !== hasUrl && (hasLocal || reverseVideoSourceUrl(options.sourceUrl) !== null);
}

export const REVERSE_VIDEO_CONTINUITY =
  "全程保持同一人物面容、发型、服装、道具形状、手持关系和场景方位，不新增人物、道具、文字、标识或水印，人体结构自然，动作连续无跳变。";

const routeNames = { skin: "换皮", viewpoint: "换视角", narrative: "换叙事" } as const;

function beatMarkdown(beat: ReverseVideoBeat): string {
  return `- **${beat.start.toFixed(1)}—${beat.end.toFixed(1)} 秒**：${beat.action}\n  摄影机：${beat.camera}\n  声音（待听觉确认 / 生成建议）：${beat.audio}\n  画面证据：${beat.evidence}`;
}

export function reverseVideoDeliveryMarkdown(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  const state = checkpoint.reverseVideo;
  if (!state) return "";
  const analysis = state.analysis;
  if (!analysis)
    return state.videoPath
      ? `# 已保存原视频\n\n${state.videoPath}\n\n待视觉确认：尚未完成实际画面分析，当前没有可交付的反推结论。\n`
      : "";
  const diagnosisNames = {
    hook: "前 3 秒钩子",
    emotion: "核心情绪",
    memory: "记忆点",
    replicable: "可复用部分",
    replace: "必须替换部分",
  } as const;
  return (
    [
      `# ${analysis.title}`,
      "依据已抽取的真实视频联系表分析。联系表不含音轨，声音项均为待听觉确认或生成建议，不能视为原片声音事实；爆点诊断是内容判断，不代表已验证的播放量或商业效果。",
      state.evidence
        ? `源片：${state.evidence.duration.toFixed(1)} 秒 · ${state.evidence.width}×${state.evidence.height}\n\n全片采样 ${state.evidence.overviewFrameCount} 帧，结尾加密 ${state.evidence.tailFrameCount} 帧。`
        : "",
      `## 一、视频结构摘要\n\n${analysis.summary}`,
      `## 二、全片设定\n\n${analysis.globalSettings}`,
      Object.entries(REVERSE_VIDEO_DIMENSIONS)
        .map(
          ([key, title]) =>
            `- **${title}**：${analysis.dimensions[key as keyof typeof REVERSE_VIDEO_DIMENSIONS]}`,
        )
        .join("\n"),
      `## 三、分场设定\n\n${analysis.scenes}`,
      `## 四、分镜生成稿\n\n${analysis.timeline.map(beatMarkdown).join("\n\n")}`,
      `### 结尾五秒逐动作核对\n\n${analysis.ending.beats.map(beatMarkdown).join("\n\n")}\n\n最终定格：${analysis.ending.finalFrame}\n\n结尾证据：${analysis.ending.evidence}`,
      `### 完整可粘贴提示词\n\n${analysis.replicationPrompt}\n\n${REVERSE_VIDEO_CONTINUITY}`,
      `## 爆点诊断\n\n${Object.entries(diagnosisNames)
        .map(
          ([key, title]) =>
            `- **${title}**：${analysis.viralDiagnosis[key as keyof typeof diagnosisNames]}`,
        )
        .join("\n")}`,
      `## 三条二创路线\n\n${analysis.remixes.map((route) => `### ${routeNames[route.route]} · ${route.title}\n\n保留：${route.retained}\n\n替换：${route.replaced}\n\n完整提示词：\n${route.prompt}\n\n预期效果：${route.expectedEffect}\n\n风险与规避：${route.risk}`).join("\n\n")}`,
      `### 推荐优先级\n\n${analysis.priority}`,
      `### 避坑提醒\n\n${analysis.pitfalls.map((entry) => `- ${entry}`).join("\n")}`,
      `### 可复用关键词\n\n${analysis.keywords.join("、")}`,
      state.review ? `## 独立视觉复核\n\n${state.review.result} · ${state.review.report}` : "",
      state.confirmedDecisions?.length
        ? `## 已确认决定\n\n${state.confirmedDecisions.join("\n\n")}`
        : "",
      state.history.length
        ? `## 修订记录\n\n${state.history.map((entry, index) => `${index + 1}. ${entry.review?.report ?? "已保存上一版分析"}`).join("\n")}`
        : "",
      state.learning
        ? `## 案例经验参考\n\n本次读取 ${state.learning.caseCount} 个已归档案例的统计，只作低权重参考，当前画面证据优先。\n\n${state.learning.summary}`
        : "",
      state.delivery
        ? `## 交付文件\n\n原视频：${state.delivery.videoPath}\n\nMarkdown：${state.delivery.markdownPath}\n\n纯文本：${state.delivery.textPath}\n\n案例：${state.delivery.casePath}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

export function reverseVideoPromptText(analysis: ReverseVideoAnalysis): string {
  return (
    [
      analysis.title,
      "一、视频结构摘要",
      analysis.summary,
      "二、全片设定",
      analysis.globalSettings,
      "三、分场设定",
      analysis.scenes,
      "四、分镜生成稿",
      ...analysis.timeline.map(
        (beat) =>
          `${beat.start.toFixed(1)}—${beat.end.toFixed(1)}秒：${beat.action}\n摄影机：${beat.camera}\n声音（待听觉确认 / 生成建议）：${beat.audio}`,
      ),
      "结尾五秒逐动作核对",
      ...analysis.ending.beats.map(
        (beat) =>
          `${beat.start.toFixed(1)}—${beat.end.toFixed(1)}秒：${beat.action}\n摄影机：${beat.camera}\n声音（待听觉确认 / 生成建议）：${beat.audio}`,
      ),
      `最终定格：${analysis.ending.finalFrame}`,
      "完整可粘贴提示词",
      analysis.replicationPrompt,
      REVERSE_VIDEO_CONTINUITY,
      ...analysis.remixes.map(
        (route) => `二创·${routeNames[route.route]}：${route.title}\n${route.prompt}`,
      ),
    ].join("\n\n") + "\n"
  );
}
