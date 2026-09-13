import type { ExplicitMediaTarget, MediaReferenceTarget } from "./backend";
import { isSeedance25VideoModel } from "./modelCapabilities";
import {
  createPromptContentEditorSession,
  decodePromptContentDocument,
  formatMarkReferenceText,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptContentItem,
  type PromptGenerationPreparation,
} from "./promptContent";
import { decodeMediaReferenceTarget, sameMediaReferenceTarget } from "./promptReferenceTarget";
import type { SeedanceTaskMode } from "./seedanceTasks";

/** A selected canvas instance plus its frozen media identity, never a name-based lookup. */
export interface GreenScreenBinding {
  readonly key: string;
  readonly name: string;
  readonly target: ExplicitMediaTarget;
}

export interface GreenScreenConfig {
  readonly enabled: boolean;
  readonly phase: "prepare" | "composite";
  readonly preparationMode: "generate" | "convert" | "existing";
  readonly subject: string;
  readonly source: GreenScreenBinding | null;
  readonly subjectReference: GreenScreenBinding | null;
  readonly foregrounds: readonly GreenScreenBinding[];
  readonly background: GreenScreenBinding | null;
  readonly scene: string;
  readonly integration: string;
  readonly audio: "preserve" | "mute" | "scene";
  readonly preparationTasks: readonly { readonly taskId: string; readonly signature: string }[];
}

export interface GreenScreenResolution {
  readonly issue: string | null;
  readonly document: PromptContentDocumentV1;
  readonly preview: string;
  readonly connections: readonly PromptContentConnection[];
  readonly taskMode: SeedanceTaskMode;
}

export interface GreenScreenGenerationResult extends GreenScreenResolution {
  readonly preparation: PromptGenerationPreparation | null;
}

export function createGreenScreenConfig(): GreenScreenConfig {
  return {
    enabled: false,
    phase: "prepare",
    preparationMode: "generate",
    subject: "",
    source: null,
    subjectReference: null,
    foregrounds: [],
    background: null,
    scene: "",
    integration: "",
    audio: "preserve",
    preparationTasks: [],
  };
}

/** Composition edits and display-name changes must not invalidate an approved green-screen take. */
export function greenScreenPreparationSignature(config: GreenScreenConfig): string {
  const identity = (binding: GreenScreenBinding | null) =>
    binding
      ? { key: binding.key, target: decodeMediaReferenceTarget(binding.target, binding.key) }
      : null;
  return JSON.stringify({
    mode: config.preparationMode,
    subject: config.subject.trim(),
    source: config.preparationMode === "convert" ? identity(config.source) : null,
    subjectReference:
      config.preparationMode === "generate" ? identity(config.subjectReference) : null,
  });
}

const emptyDocument = (): PromptContentDocumentV1 => ({
  schema: "prompt-content",
  version: 1,
  items: [],
});

type ResolvedBinding = {
  readonly key: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
};

function resolveBinding(
  selected: GreenScreenBinding | null,
  inputs: readonly PromptContentConnection[],
  kinds: readonly ("image" | "video")[],
  label: string,
):
  | { readonly issue: string; readonly binding?: never }
  | { readonly issue: null; readonly binding: ResolvedBinding } {
  if (!selected) return { issue: `请选择${label}。` };
  const target = decodeMediaReferenceTarget(selected.target, selected.key);
  if (!target || !kinds.some((kind) => kind === target.mediaType))
    return { issue: `${label}的素材身份无效，请重新选择。` };
  const current = inputs.find((input) => input.key === selected.key);
  if (!current)
    return {
      issue: `${label}「${selected.name}」已断开连接，请重新连接或明确选择其它素材。`,
    };
  if (current.kind !== target.mediaType || !sameMediaReferenceTarget(target, current.target))
    return { issue: `${label}「${selected.name}」的来源已变化，请重新选择确认。` };
  return { issue: null, binding: { key: selected.key, name: current.name, target } };
}

function hasUnboundReferenceText(value: string): boolean {
  return /(?:^|[^a-z0-9_%+@/\\-])@(?=[^\s@])/iu.test(value.normalize("NFKC"));
}

function previewDocument(document: PromptContentDocumentV1): string {
  return document.items
    .map((item) => {
      switch (item.kind) {
        case "text":
          return item.text;
        case "media_reference":
          return `@${item.displayNameSnapshot}`;
        case "mark_reference":
          return formatMarkReferenceText(item.labelSnapshot, item.descriptionSnapshot);
        case "pending_reference":
          return item.displayText;
      }
    })
    .join("")
    .replaceAll("\u200b", "");
}

/** Compile a transient request: stage-specific media and instructions plus the user's current body. */
export function resolveGreenScreen(
  config: GreenScreenConfig,
  inputs: readonly PromptContentConnection[],
  modelId: string,
  previousDocument?: PromptContentDocumentV1,
): GreenScreenResolution {
  let previous = previousDocument ?? emptyDocument();
  const taskMode: SeedanceTaskMode =
    config.phase === "prepare" && config.preparationMode === "generate" ? "auto" : "edit";
  const failure = (issue: string | null): GreenScreenResolution => ({
    issue,
    document: previous,
    preview: previewDocument(previous),
    connections: [],
    taskMode,
  });
  if (!decodePromptContentDocument(previous))
    return {
      issue: "原提示内容格式无效，请检查提示词后重试。",
      document: emptyDocument(),
      preview: "",
      connections: [],
      taskMode,
    };
  if (!config.enabled) return { ...failure(null), connections: inputs };
  if (!isSeedance25VideoModel(modelId))
    return failure("无缝绿幕编辑需要选择 Seedance 2.5 视频模型。");
  if (config.phase !== "prepare" && config.phase !== "composite")
    return failure("绿幕工作流程阶段无效，请重新选择制作绿幕或场景合成。");
  if (!["generate", "convert", "existing"].includes(config.preparationMode))
    return failure("绿幕制作方式无效，请重新选择。");

  // Finish typed/pasted explicit @ references against the full current catalog before narrowing
  // the stage's media. The canonical resolver retains pending and disconnected reference atoms.
  const originalSession = createPromptContentEditorSession();
  originalSession.restore(previous);
  try {
    originalSession.prepareGeneration({ connections: inputs, allowMediaOnly: false });
    previous = originalSession.snapshot();
  } finally {
    originalSession.attach(null);
  }

  const descriptions =
    config.phase === "prepare" ? [config.subject] : [config.scene, config.integration];
  if (descriptions.some(hasUnboundReferenceText))
    return failure(
      "绿幕文字描述中的素材引用请使用素材选择器；需要自由插入 @ 引用时，请写在上方提示词输入框中。",
    );

  const items: PromptContentItem[] = [];
  const selectedKeys = new Set<string>();
  const mentionIds = new Set(
    previous.items.flatMap((item) => ("mentionId" in item ? [item.mentionId] : [])),
  );
  const text = (value: string) => items.push({ kind: "text", text: value });
  const reference = (binding: ResolvedBinding, role: string) => {
    let mentionId = `green-screen:${config.phase}:${role}:${encodeURIComponent(binding.key)}`;
    while (mentionIds.has(mentionId)) mentionId += ":generated";
    mentionIds.add(mentionId);
    selectedKeys.add(binding.key);
    items.push({
      kind: "media_reference",
      mentionId,
      canvasNodeKey: binding.key,
      target: binding.target,
      displayNameSnapshot: binding.name,
    });
  };

  if (config.phase === "prepare") {
    if (config.preparationMode === "existing")
      return failure("已有绿幕视频无需重新生成；请选择绿幕前景并进入场景合成。");
    text("【制作绿幕视频】");
    if (config.preparationMode === "convert") {
      const source = resolveBinding(config.source, inputs, ["video"], "待转绿幕的原视频");
      if (source.issue !== null) return failure(source.issue);
      text("将");
      reference(source.binding, "source");
      text(
        "中的主体保留下来，仅将背景替换为纯色绿幕。保持主体身份、服装、细节、原始表演、动作轨迹、镜头节奏和原视频中的人声与声音连续。",
      );
      if (config.subject.trim()) text(`需要保留的主体及动作要求：${config.subject.trim()}。`);
    } else {
      if (!config.subject.trim() && !config.subjectReference)
        return failure("请描述要制作的绿幕主体与动作，或选择主体参考图片。");
      text("生成一段可用于后续场景合成的绿幕主体视频。");
      if (config.subjectReference) {
        const subject = resolveBinding(config.subjectReference, inputs, ["image"], "主体参考图片");
        if (subject.issue !== null) return failure(subject.issue);
        text("主体形象参考");
        reference(subject.binding, "subject-reference");
        text("，保持身份、外观与服装一致。");
      }
      text(
        config.subject.trim()
          ? `主体与动作：${config.subject.trim()}。`
          : "主体完成自然、连贯的动作表演。",
      );
    }
    text(
      "\n【绿幕要求】背景为纯净、均匀照明、无纹理的绿色（#00FF00），保持全片一致。主体完整可见，动作自然连续，轮廓、头发与半透明细节清晰稳定，避免绿色溢色、残影和闪烁。主体与背景分离，不添加字幕、文字、标识或无关杂物。",
    );
  } else {
    if (!config.foregrounds.length) return failure("请至少选择一段绿幕前景视频。");
    const foregrounds: ResolvedBinding[] = [];
    for (const [index, selected] of config.foregrounds.entries()) {
      const foreground = resolveBinding(selected, inputs, ["video"], `绿幕前景 ${index + 1}`);
      if (foreground.issue !== null) return failure(foreground.issue);
      if (foregrounds.some((entry) => entry.key === foreground.binding.key))
        return failure(`绿幕前景「${foreground.binding.name}」重复，请移除重复项。`);
      foregrounds.push(foreground.binding);
    }
    const background = config.background
      ? resolveBinding(config.background, inputs, ["image", "video"], "背景参考素材")
      : null;
    if (background && background.issue !== null) return failure(background.issue);
    if (background?.binding && foregrounds.some((entry) => entry.key === background.binding.key))
      return failure("同一素材不能同时作为绿幕前景与背景，请重新选择背景参考。");
    if (!config.scene.trim() && !background)
      return failure("请描述要替换的新场景，或选择背景参考图片／视频。");
    if (!["preserve", "mute", "scene"].includes(config.audio))
      return failure("绿幕合成声音设置无效，请重新选择。");
    text("【无缝绿幕编辑】将以下绿幕视频中的主体自然融入新场景：");
    foregrounds.forEach((foreground, index) => {
      text(`\n绿幕前景 ${index + 1}：`);
      reference(foreground, `foreground:${index + 1}`);
      text("，提取其中的人物／物体与特效，去除绿色背景，保持各自身份和动作连续。");
    });
    text("\n【背景替换】");
    if (background?.binding) {
      text("背景场景参考");
      reference(background.binding, "background");
      text("，保持其场景结构与镜头运动关系。");
    }
    if (config.scene.trim()) text(`新场景：${config.scene.trim()}。`);
    if (config.integration.trim()) text(`\n【动作、时序与特效融合】${config.integration.trim()}`);
    text(
      "\n【融合要求】精细分离复杂轮廓、头发与半透明细节，清除绿边、绿色溢色和残影。根据新场景匹配环境光、光照方向、色温、接触阴影与反射；统一主体和背景的尺度、透视、站位与前后遮挡。镜头变化时保持相对透视、运动轨迹及动作的帧间稳定，避免闪烁、跳脱和生硬贴片感。",
    );
    text(
      `\n【声音处理】${
        config.audio === "preserve"
          ? "保留绿幕前景视频中的原有人声、对白及其时间同步，保留必要的动作声音；背景环境声自然融合，不覆盖人声。"
          : config.audio === "mute"
            ? "输出静音成片，不保留原音，也不添加人声、音乐或音效。"
            : "按新场景生成匹配的环境声音与动作音效，不沿用原视频音轨，不添加未要求的对白。"
      }`,
    );
  }

  // Preserve even disconnected or changed references: prepareGeneration must reject them.
  for (const item of previous.items)
    if (item.kind === "media_reference") selectedKeys.add(item.canvasNodeKey);
  const connections = inputs
    .filter((input) => selectedKeys.has(input.key))
    .map((input) => ({ ...input, role: `reference_${input.kind}` }));
  const document: PromptContentDocumentV1 = {
    schema: "prompt-content",
    version: 1,
    items: [
      ...previous.items,
      ...(previous.items.length ? [{ kind: "text" as const, text: "\n\n" }] : []),
      ...items,
    ],
  };
  return { issue: null, document, preview: previewDocument(document), connections, taskMode };
}

export function prepareGreenScreenGeneration(
  config: GreenScreenConfig,
  inputs: readonly PromptContentConnection[],
  modelId: string,
  previousDocument?: PromptContentDocumentV1,
): GreenScreenGenerationResult {
  const resolution = resolveGreenScreen(config, inputs, modelId, previousDocument);
  if (resolution.issue) return { ...resolution, preparation: null };
  const session = createPromptContentEditorSession();
  session.restore(resolution.document);
  try {
    return {
      ...resolution,
      preparation: session.prepareGeneration({
        connections: resolution.connections,
        allowMediaOnly: false,
      }),
    };
  } finally {
    session.attach(null);
  }
}
