import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import {
  isDesktopRuntime,
  toMediaSrc,
  type ExplicitMediaTarget,
  type MediaReferenceTarget,
} from "./backend";
import type { ModelParameterCapability, ModelParameterValue } from "./modelCapabilities";
import {
  createPromptContentEditorSession,
  decodePromptContentDocument,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptContentItem,
  type PromptGenerationPreparation,
} from "./promptContent";
import { decodeMediaReferenceTarget } from "./promptReferenceTarget";
import type { WhiteModelBinding } from "./whiteModelControl";
import {
  solveShot,
  type WhiteModelObject,
  type WhiteModelScenePlan,
  type WhiteModelVector,
} from "./whiteModelScene";
import {
  DEFAULT_PERSON_HEIGHT,
  type WhiteModelCharacterBinding,
  type WhiteModelStudioDraft,
} from "./whiteModelStudio";

export const PANORAMA_ASPECT_MIN = 1.7;
export const PANORAMA_INSTRUCTION =
  "生成一张无人物的 equirectangular 360° 全景环境图，左右边缘无缝衔接，电影级光影与空间纵深，空镜场景，不要出现人物、文字、水印、界面元素。";
export const BLOCKING_FINISH_INSTRUCTION =
  "严格按照站位图中假人的站位和朝向来站位，完美融入场景，人物画风保持一致，禁止出现站位图的编号和假人";
export const BLOCKING_DUMMY_COLOR = "#d0d0d0";

const BLOCKING_MARKS: readonly WhiteModelVector[] = [
  [-1.7, 1.15, 0],
  [0.12, -0.4, 0],
  [1.85, 0.9, 0],
];

const PANORAMA_SIZE_KEYS = ["size", "ratio", "aspect_ratio"] as const;
const PANORAMA_SIZE_PREFERENCE = ["21:9", "2:1", "2848x1600", "1792x1024", "1536x1024", "16:9"];

const savedStillSchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export interface WhiteModelStudioMediaInput {
  readonly key: string;
  readonly name: string;
  readonly kind: "image";
  readonly target: ExplicitMediaTarget;
  readonly src: string | null;
}

export type { WhiteModelCharacterBinding };

export interface WhiteModelDummyAssignment {
  readonly dummyNumber: number;
  readonly character: WhiteModelBinding;
}

export interface WhiteModelBlockingCapture {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly name: string;
  readonly environment: WhiteModelBinding | null;
  readonly assignments: readonly WhiteModelDummyAssignment[];
}

export interface WhiteModelBlockingPromptResult {
  readonly issue: string | null;
  readonly document: PromptContentDocumentV1;
  readonly preview: string;
}

const emptyDocument = (): PromptContentDocumentV1 => ({
  schema: "prompt-content",
  version: 1,
  items: [],
});

export function isPanoramaAspect(width: number, height: number): boolean {
  return height > 0 && width / height >= PANORAMA_ASPECT_MIN;
}

export function documentHasPanoramaInstruction(document: PromptContentDocumentV1 | undefined): boolean {
  if (!document) return false;
  const text = document.items
    .map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
  return /equirectangular|全景环境图|360\s*°?\s*全景/iu.test(text);
}

export function appendPanoramaInstruction(
  document: PromptContentDocumentV1 | undefined,
): PromptContentDocumentV1 {
  const previous = document ?? emptyDocument();
  if (documentHasPanoramaInstruction(previous)) return previous;
  const items: PromptContentItem[] = [...previous.items];
  const needsBreak = items.some((item) => item.kind === "text" && item.text.trim());
  if (needsBreak) items.push({ kind: "text", text: "\n\n" });
  items.push({ kind: "text", text: PANORAMA_INSTRUCTION });
  return { schema: "prompt-content", version: 1, items };
}

export function preferredPanoramaParameters(
  capabilities: readonly ModelParameterCapability[],
): Readonly<Record<string, ModelParameterValue>> {
  const patch: Record<string, ModelParameterValue> = {};
  for (const key of PANORAMA_SIZE_KEYS) {
    const capability = capabilities.find((entry) => entry.key === key);
    if (!capability) continue;
    const match = PANORAMA_SIZE_PREFERENCE.find((value) =>
      capability.options.some((option) => String(option.value) === value),
    );
    if (!match) continue;
    const option = capability.options.find((entry) => String(entry.value) === match);
    if (option) patch[key] = option.value;
  }
  return patch;
}

export function preparePanoramaGeneration(
  previousDocument: PromptContentDocumentV1 | undefined,
  connections: readonly PromptContentConnection[],
  allowMediaOnly: boolean,
): { readonly issue: string | null; readonly preparation: PromptGenerationPreparation | null } {
  const previous = previousDocument ?? emptyDocument();
  if (!decodePromptContentDocument(previous)) {
    return { issue: "原提示内容格式无效，请检查提示词后重试。", preparation: null };
  }
  const session = createPromptContentEditorSession();
  session.restore(appendPanoramaInstruction(previous));
  try {
    return {
      issue: null,
      preparation: session.prepareGeneration({ connections, allowMediaOnly }),
    };
  } finally {
    session.attach(null);
  }
}

/** 人形按方案数组顺序编号，道具不占号；导出站位图和提示词共用这一份编号。 */
export function dummyNumbers(objects: readonly WhiteModelObject[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  let next = 1;
  for (const object of objects) {
    if (object.shape !== "person") continue;
    numbers.set(object.id, next);
    next += 1;
  }
  return numbers;
}

export function createWhiteModelBlockingObject(index: number): WhiteModelObject {
  const lane = BLOCKING_MARKS[index] ?? [
    ((index % 3) - 1) * 1.7,
    Math.floor(index / 3) * 1.2 - 0.2,
    0,
  ];
  return {
    id: crypto.randomUUID(),
    name: `${index + 1}号假人`,
    shape: "person",
    color: BLOCKING_DUMMY_COLOR,
    size: DEFAULT_PERSON_HEIGHT,
    facing: "manual",
    keyframes: [{ time: 0, position: lane, yaw: 0 }],
    motion: { kind: "pose", pose: "stand" },
  };
}

export function createWhiteModelBlockingPlan(): WhiteModelScenePlan {
  const objects = [0, 1, 2].map((index) => createWhiteModelBlockingObject(index));
  const subject = objects[1]!;
  const origin = subject.keyframes[0]!.position;
  const shot = solveShot(
    { position: origin, yaw: 0, height: subject.size, isPerson: true },
    { size: "full", angle: "eye", direction: "front" },
    35,
    16 / 9,
  );
  return {
    version: 2,
    durationSeconds: 4,
    fps: 24,
    width: 1280,
    height: 720,
    camera: {
      lens: 35,
      interpolation: "smooth",
      keyframes: [{ time: 0, ...shot }],
      follow: null,
    },
    objects,
  };
}

export function createWhiteModelBlockingDraft(): WhiteModelStudioDraft {
  return {
    executablePath: "",
    sourceBlendPath: "",
    mode: "create",
    plan: createWhiteModelBlockingPlan(),
    jobId: null,
    environment: null,
    characterBindings: [],
  };
}

export function pruneWhiteModelCharacterBindings(
  bindings: readonly WhiteModelCharacterBinding[] | undefined,
  objects: readonly WhiteModelObject[],
): WhiteModelCharacterBinding[] {
  const ids = new Set(
    objects.filter((object) => object.shape === "person").map((object) => object.id),
  );
  return (bindings ?? []).filter((binding) => ids.has(binding.actorId));
}

export function upsertCharacterBinding(
  bindings: readonly WhiteModelCharacterBinding[] | undefined,
  actorId: string,
  reference: WhiteModelBinding | null,
): WhiteModelCharacterBinding[] {
  const current = bindings ?? [];
  const next = current.filter((binding) => binding.actorId !== actorId);
  return reference ? [...next, { actorId, reference }] : next;
}

export function whiteModelBlockingSignature(draft: WhiteModelStudioDraft): string {
  return JSON.stringify({
    plan: draft.plan,
    environment: draft.environment ?? null,
    characterBindings: pruneWhiteModelCharacterBindings(draft.characterBindings, draft.plan.objects),
  });
}

export function studioImageInputsFromMedia(
  media: readonly {
    readonly key: string;
    readonly name: string;
    readonly kind: string;
    readonly target: ExplicitMediaTarget;
    readonly src?: string | null;
  }[],
): WhiteModelStudioMediaInput[] {
  return media.flatMap((input) => {
    if (input.kind !== "image" || input.target.kind === "url") return [];
    const src =
      input.src ?? (input.target.kind === "local_file" ? toMediaSrc(input.target.path) : null);
    return [
      {
        key: input.key,
        name: input.name,
        kind: "image" as const,
        target: input.target,
        src,
      },
    ];
  });
}

export function nextEnvironmentBinding(
  current: WhiteModelBinding | null,
  inputs: readonly WhiteModelStudioMediaInput[],
): WhiteModelBinding | null {
  if (!inputs.length) return null;
  const index = current ? inputs.findIndex((input) => input.key === current.key) : -1;
  const next = inputs[(index + 1) % inputs.length]!;
  return { key: next.key, name: next.name, target: next.target };
}

export function environmentPreviewSrc(
  binding: WhiteModelBinding | null,
  inputs: readonly WhiteModelStudioMediaInput[],
): string | null {
  if (!binding) return null;
  const matched = inputs.find((input) => input.key === binding.key);
  if (matched?.src) return matched.src;
  return binding.target.kind === "local_file" ? toMediaSrc(binding.target.path) : null;
}

export function blockingStillName(jobHint?: string): string {
  const hint = jobHint?.slice(0, 8);
  const stamp = hint ? hint : Date.now().toString(36);
  return `站位图 · ${stamp}.png`;
}

function previewOf(items: readonly PromptContentItem[]): string {
  return items
    .map((item) =>
      item.kind === "text"
        ? item.text
        : item.kind === "media_reference"
          ? `@${item.displayNameSnapshot}`
          : "",
    )
    .join("");
}

function mediaTarget(binding: WhiteModelBinding): MediaReferenceTarget | null {
  return decodeMediaReferenceTarget(binding.target, binding.key);
}

export function buildBlockingPromptDocument(
  still: WhiteModelBinding,
  environment: WhiteModelBinding | null,
  assignments: readonly WhiteModelDummyAssignment[],
): WhiteModelBlockingPromptResult {
  const stillTarget = mediaTarget(still);
  if (!stillTarget || stillTarget.mediaType !== "image") {
    return { issue: "站位图身份无效，请重新导出。", document: emptyDocument(), preview: "" };
  }
  const envTarget = environment ? mediaTarget(environment) : null;
  if (environment && (!envTarget || envTarget.mediaType !== "image")) {
    return {
      issue: "场景图身份无效，请重新选择全景图或场景图。",
      document: emptyDocument(),
      preview: "",
    };
  }
  const resolvedAssignments: {
    readonly dummyNumber: number;
    readonly binding: WhiteModelBinding;
    readonly target: MediaReferenceTarget;
  }[] = [];
  for (const assignment of [...assignments].sort((left, right) => left.dummyNumber - right.dummyNumber)) {
    const target = mediaTarget(assignment.character);
    if (!target || target.mediaType !== "image") {
      return {
        issue: `${assignment.dummyNumber}号假人的角色参考图无效，请重新选择。`,
        document: emptyDocument(),
        preview: "",
      };
    }
    resolvedAssignments.push({
      dummyNumber: assignment.dummyNumber,
      binding: assignment.character,
      target,
    });
  }

  const items: PromptContentItem[] = [];
  const text = (value: string) => {
    if (value) items.push({ kind: "text", text: value });
  };
  const reference = (binding: WhiteModelBinding, target: MediaReferenceTarget, field: string) => {
    items.push({
      kind: "media_reference",
      mentionId: `white-model-blocking:${field}`,
      canvasNodeKey: binding.key,
      target,
      displayNameSnapshot: binding.name,
    });
  };

  if (environment && envTarget) {
    reference(environment, envTarget, "environment");
    text(" 是场景图，");
  }
  reference(still, stillTarget, "still");
  text(" 为人物站位图");
  if (resolvedAssignments.length) text("，\n");
  else text("。\n");
  resolvedAssignments.forEach((assignment, index) => {
    reference(assignment.binding, assignment.target, `dummy:${assignment.dummyNumber}`);
    text(` 站在${assignment.dummyNumber}号假人位`);
    text(index === resolvedAssignments.length - 1 ? "，" : "，\n");
  });
  text(BLOCKING_FINISH_INSTRUCTION);
  return {
    issue: null,
    document: { schema: "prompt-content", version: 1, items },
    preview: previewOf(items),
  };
}

export function blockingAssignmentsFromDraft(
  draft: WhiteModelStudioDraft,
): WhiteModelDummyAssignment[] {
  const numbers = dummyNumbers(draft.plan.objects);
  const byActor = new Map(
    (draft.characterBindings ?? []).map((binding) => [binding.actorId, binding.reference]),
  );
  const assignments: WhiteModelDummyAssignment[] = [];
  for (const object of draft.plan.objects) {
    const dummyNumber = numbers.get(object.id);
    const reference = byActor.get(object.id);
    if (dummyNumber == null || !reference) continue;
    assignments.push({ dummyNumber, character: reference });
  }
  return assignments;
}

export async function saveWhiteModelStill(imageDataUrl: string) {
  if (!isDesktopRuntime()) throw new Error("导出站位图需要在桌面应用中运行。");
  return v.parse(savedStillSchema, await invoke("save_white_model_still", { imageDataUrl }));
}
