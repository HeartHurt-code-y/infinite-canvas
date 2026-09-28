import {
  validateCinematicDialogueReady,
  type CinematicDialogueGuard,
} from "./cinematicDialogueValidator";

export type CinematicDialogueResponse =
  | {
      readonly status: "needs_input";
      readonly displayText: string;
      readonly downstreamPrompt: null;
    }
  | {
      readonly status: "ready";
      readonly displayText: string;
      readonly downstreamPrompt: string;
    };

function modelJson(raw: string): unknown {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("对白技能没有返回内容，请重试生成。");
  }

  const trimmed = raw.trim();
  // Only unwrap one complete JSON fence. Prose, multiple fences and partial fences
  // must not be mistaken for a valid structured response.
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("对白技能返回的 JSON 无效或不完整，请重试生成。");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("对白技能返回格式错误：顶层必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`对白技能返回格式错误：${key} 必须是非空文本。`);
  }
  return text.trim();
}

function optionalText(value: Record<string, unknown>, key: string): string | null {
  const text = value[key];
  if (text === undefined || text === null || text === "") return null;
  if (typeof text !== "string") {
    throw new Error(`对白技能返回格式错误：${key} 必须是文本。`);
  }
  return text.trim() || null;
}

function fencedText(content: string): string {
  let length = 3;
  for (const match of content.matchAll(/`+/g)) {
    length = Math.max(length, match[0].length + 1);
  }
  const fence = "`".repeat(length);
  return `${fence}text\n${content}\n${fence}`;
}

/**
 * Decode the dialogue skill's complete JSON response before any caller changes
 * the node. Only the ready response's videoPrompt may flow to downstream nodes.
 */
export function parseCinematicDialogueResponse(
  raw: string,
  guard: CinematicDialogueGuard,
): CinematicDialogueResponse {
  const value = record(modelJson(raw));
  if (value["status"] === "needs_input") {
    return {
      status: "needs_input",
      displayText: requiredText(value, "message"),
      downstreamPrompt: null,
    };
  }
  if (value["status"] !== "ready") {
    throw new Error("对白技能返回格式错误：status 必须是 needs_input 或 ready。");
  }

  const videoPrompt = requiredText(value, "videoPrompt");
  const target = requiredText(value, "target");
  const turnPlan = requiredText(value, "turnPlan");
  const budget = requiredText(value, "budget");
  const reviewChecklist = requiredText(value, "reviewChecklist");
  const adaptationNotes = optionalText(value, "adaptationNotes");
  const alternatePrompt = optionalText(value, "alternatePrompt");
  const validation = validateCinematicDialogueReady({
    videoPrompt,
    alternatePrompt,
    guard,
    timing: value["timing"],
  });

  const sections = [
    "## 视频提示词",
    fencedText(videoPrompt),
    "## 视频目标",
    target,
    "## 话轮安排",
    turnPlan,
    "## 台词预算",
    budget,
    "## 项目校验",
    validation.report,
    "## 生成后验收",
    reviewChecklist,
  ];
  if (adaptationNotes) {
    sections.push("## 台词改编", adaptationNotes);
  }
  if (alternatePrompt) {
    sections.push("## 备选提示词", fencedText(alternatePrompt));
  }

  return {
    status: "ready",
    displayText: sections.join("\n\n"),
    downstreamPrompt: videoPrompt,
  };
}
