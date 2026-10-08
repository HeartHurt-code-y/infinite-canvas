import type { ExplicitMediaTarget, MediaReferenceTarget } from "./backend";
import { isSeedance25VideoModel } from "./modelCapabilities";
import {
  createPromptContentEditorSession,
  decodePromptContentDocument,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptContentItem,
  type PromptGenerationPreparation,
} from "./promptContent";
import { decodeMediaReferenceTarget, sameMediaReferenceTarget } from "./promptReferenceTarget";
import type { SeedanceTaskMode } from "./seedanceTasks";

export type WhiteModelControlDimension =
  "camera" | "blocking" | "motion" | "composition" | "lighting" | "timing" | "audio";

export const WHITE_MODEL_CONTROL_DIMENSIONS: readonly {
  readonly value: WhiteModelControlDimension;
  readonly label: string;
}[] = [
  { value: "camera", label: "运镜" },
  { value: "blocking", label: "角色站位" },
  { value: "motion", label: "动作与运动轨迹" },
  { value: "composition", label: "空间构图与前后景遮挡" },
  { value: "lighting", label: "光影变化" },
  { value: "timing", label: "画面节奏与镜头切接" },
  { value: "audio", label: "音乐音效" },
];

/** The selected canvas instance and its frozen source identity, never a display-name lookup. */
export interface WhiteModelBinding {
  readonly key: string;
  readonly name: string;
  readonly target: ExplicitMediaTarget;
}

export interface WhiteModelMapping {
  readonly id: string;
  readonly modelPart: string;
  readonly description: string;
  readonly reference: WhiteModelBinding | null;
}

export interface WhiteModelControlConfig {
  readonly enabled: boolean;
  readonly granularity: "coarse" | "fine";
  readonly source: WhiteModelBinding | null;
  readonly mappings: readonly WhiteModelMapping[];
  readonly controls: readonly WhiteModelControlDimension[];
  readonly timeline: string;
  readonly scene: string;
  readonly sceneReference: WhiteModelBinding | null;
  readonly finish: string;
}

export interface WhiteModelControlResolution {
  readonly issue: string | null;
  readonly document: PromptContentDocumentV1;
  readonly preview: string;
}

export interface WhiteModelGenerationResult {
  readonly issue: string | null;
  readonly preparation: PromptGenerationPreparation | null;
}

export function createWhiteModelControlConfig(): WhiteModelControlConfig {
  return {
    enabled: false,
    granularity: "coarse",
    source: null,
    mappings: [],
    controls: ["camera", "blocking", "motion", "composition", "timing"],
    timeline: "",
    scene: "",
    sceneReference: null,
    finish: "",
  };
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

/** Plain description fields cannot persist a mention's identity across canvas input reordering. */
function hasUnboundReferenceText(value: string): boolean {
  // NFKC also covers the full-width at-sign. An adjacent ASCII mailbox/path character is
  // ordinary text; Chinese prose such as “参考@图片1” is a mention boundary in the editor.
  return /(?:^|[^a-z0-9_%+@/\\-])@(?=[^\s@])/iu.test(value.normalize("NFKC"));
}

function resolveBinding(
  binding: WhiteModelBinding | null,
  inputs: readonly PromptContentConnection[],
  kind: "image" | "video",
  label: string,
):
  | { readonly issue: string; readonly binding?: never }
  | { readonly issue: null; readonly binding: ResolvedBinding } {
  if (!binding) return { issue: `请选择${label}。` };
  const target = decodeMediaReferenceTarget(binding.target, binding.key);
  if (!target || target.mediaType !== kind) {
    return { issue: `${label}的素材身份无效，请重新选择。` };
  }
  const current = inputs.find((input) => input.key === binding.key);
  if (!current)
    return { issue: `${label}「${binding.name}」已断开连接，请重新连接或明确选择其它素材。` };
  if (current.kind !== kind || !sameMediaReferenceTarget(target, current.target)) {
    return { issue: `${label}「${binding.name}」的来源已变化，请重新选择确认。` };
  }
  return { issue: null, binding: { key: binding.key, name: current.name, target } };
}

/** Build the manual's prompt formulas using only the controls and rendering details the user chose. */
export function resolveWhiteModelControl(
  config: WhiteModelControlConfig,
  inputs: readonly PromptContentConnection[],
  modelId: string,
  taskMode: SeedanceTaskMode,
): WhiteModelControlResolution {
  const failure = (issue: string | null): WhiteModelControlResolution => ({
    issue,
    document: emptyDocument(),
    preview: "",
  });
  if (!config.enabled) return failure(null);
  if (!isSeedance25VideoModel(modelId))
    return failure("专业级白模控制需要选择 Seedance 2.5 视频模型。");
  if (taskMode !== "auto" && taskMode !== "reference") {
    return failure("专业级白模控制需要使用全参考 / 自动判断或参考生视频任务，请先切换任务类型。");
  }
  if (config.granularity !== "coarse" && config.granularity !== "fine") {
    return failure("白模颗粒度无效，请重新选择粗颗粒度或细颗粒度。");
  }
  if (
    config.controls.some(
      (value) => !WHITE_MODEL_CONTROL_DIMENSIONS.some((entry) => entry.value === value),
    )
  ) {
    return failure("白模参考维度无效，请重新选择。");
  }
  const source = resolveBinding(config.source, inputs, "video", "白模参考视频");
  if (source.issue) return failure(source.issue);
  const descriptions = [
    config.timeline,
    config.scene,
    config.finish,
    ...config.mappings.flatMap((mapping) => [mapping.modelPart, mapping.description]),
  ];
  if (descriptions.some(hasUnboundReferenceText)) {
    return failure(
      "白模文字描述中的素材引用请使用角色／道具或场景参考图选择器；需要自由插入 @ 引用时，请写在上方提示词输入框中。",
    );
  }

  const identifiers = new Set<string>();
  const selectors = new Set<string>();
  const mappings: {
    readonly modelPart: string;
    readonly description: string;
    readonly id: string;
    readonly reference: ResolvedBinding | null;
  }[] = [];
  for (const mapping of config.mappings) {
    if (!mapping.id.trim() || identifiers.has(mapping.id))
      return failure("白模对应关系的标识重复或无效，请删除重复项后重试。");
    identifiers.add(mapping.id);
    const modelPart = mapping.modelPart.trim();
    if (!modelPart) return failure("请说明每项对应关系的白模颜色、形状或其它可辨识特征。");
    const selector = modelPart.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
    if (selectors.has(selector))
      return failure(`白模「${modelPart}」存在重复对应关系，请合并为一项以免替换对象不明确。`);
    selectors.add(selector);
    const description = mapping.description.trim();
    if (!description && !mapping.reference)
      return failure(`请为白模「${modelPart}」填写角色、道具或材质描述，或选择参考图片。`);
    const reference = mapping.reference
      ? resolveBinding(mapping.reference, inputs, "image", `白模「${modelPart}」的参考图片`)
      : null;
    if (reference?.issue) return failure(reference.issue);
    mappings.push({
      id: mapping.id,
      modelPart,
      description,
      reference: reference?.binding ?? null,
    });
  }
  const sceneReference = config.sceneReference
    ? resolveBinding(config.sceneReference, inputs, "image", "场景参考图片")
    : null;
  if (sceneReference?.issue) return failure(sceneReference.issue);
  if (
    !config.timeline.trim() &&
    !config.scene.trim() &&
    !config.finish.trim() &&
    !mappings.length &&
    !sceneReference
  ) {
    return failure(
      "请填写剧情或分段渲染、场景、整体要求中的至少一项，或添加白模对应关系、场景参考图片。",
    );
  }

  const items: PromptContentItem[] = [];
  const text = (value: string) => {
    if (value) items.push({ kind: "text", text: value });
  };
  const reference = (binding: ResolvedBinding, field: string) => {
    items.push({
      kind: "media_reference",
      mentionId: `white-model:${field}`,
      canvasNodeKey: binding.key,
      target: binding.target,
      displayNameSnapshot: binding.name,
    });
  };
  const controls = [...new Set(config.controls)]
    .map((value) => WHITE_MODEL_CONTROL_DIMENSIONS.find((entry) => entry.value === value)!.label)
    .join("、");
  if (config.granularity === "coarse") {
    text("【参考声明】参考");
    reference(source.binding!, "source");
    text(
      controls
        ? `的${controls}，以白模动画作为动态骨架生成成片。`
        : "的白模动画作为动态骨架生成成片。",
    );
  } else {
    text("【渲染指令】将");
    reference(source.binding!, "source");
    text(`的白模动画渲染成最终成片。${controls ? `参考该白模动画的${controls}。` : ""}`);
  }
  if (mappings.length)
    text(config.granularity === "coarse" ? "\n【对应关系映射】" : "\n【模型渲染要求】");
  for (const mapping of mappings) {
    text(
      `\n将白模视频中的「${mapping.modelPart}」${config.granularity === "coarse" ? "替换" : "渲染"}为`,
    );
    if (mapping.reference) {
      reference(mapping.reference, `mapping:${encodeURIComponent(mapping.id)}:reference`);
      text(mapping.description ? `中的${mapping.description}` : "中的形象");
    } else text(mapping.description);
    text("。");
  }
  if (config.timeline.trim())
    text(
      `\n【${config.granularity === "coarse" ? "剧情详述" : "分段渲染描述"}】${config.timeline.trim()}`,
    );
  if (config.scene.trim() || sceneReference) {
    text("\n【场景处理】");
    if (sceneReference?.binding) {
      text("背景场景参考");
      reference(sceneReference.binding, "scene-reference");
      text(config.scene.trim() ? `：${config.scene.trim()}` : "。");
    } else text(config.scene.trim());
  }
  if (config.finish.trim()) text(`\n【整体收束】${config.finish.trim()}`);
  return {
    issue: null,
    document: { schema: "prompt-content", version: 1, items },
    preview: items
      .map((item) =>
        item.kind === "text"
          ? item.text
          : item.kind === "media_reference"
            ? `@${item.displayNameSnapshot}`
            : "",
      )
      .join(""),
  };
}

/** Compile a transient request document; the user's editable canonical prompt is never overwritten. */
export function prepareWhiteModelGeneration(
  config: WhiteModelControlConfig,
  inputs: readonly PromptContentConnection[],
  modelId: string,
  taskMode: SeedanceTaskMode,
  previousDocument: PromptContentDocumentV1 | undefined,
): WhiteModelGenerationResult {
  const resolved = resolveWhiteModelControl(config, inputs, modelId, taskMode);
  if (resolved.issue) return { issue: resolved.issue, preparation: null };
  const previous = previousDocument ?? emptyDocument();
  if (!decodePromptContentDocument(previous))
    return { issue: "原提示内容格式无效，请检查提示词后重试。", preparation: null };
  const usedMentionIds = new Set(
    previous.items.flatMap((item) => ("mentionId" in item ? [item.mentionId] : [])),
  );
  const generatedItems = resolved.document.items.map((item) => {
    if (item.kind !== "media_reference") return item;
    let mentionId = item.mentionId;
    while (usedMentionIds.has(mentionId)) mentionId += ":generated";
    usedMentionIds.add(mentionId);
    return { ...item, mentionId };
  });
  const merged: PromptContentDocumentV1 = {
    schema: "prompt-content",
    version: 1,
    items: [
      ...previous.items,
      ...(previous.items.length && generatedItems.length
        ? [{ kind: "text" as const, text: "\n\n" }]
        : []),
      ...generatedItems,
    ],
  };
  const session = createPromptContentEditorSession();
  session.restore(merged);
  try {
    return {
      issue: null,
      preparation: session.prepareGeneration({ connections: inputs, allowMediaOnly: false }),
    };
  } finally {
    session.attach(null);
  }
}
