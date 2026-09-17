import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import type { WhiteModelBinding } from "./whiteModelControl";
import {
  bakeWhiteModelScene,
  isWhiteModelScenePlanV1,
  migrateWhiteModelScenePlan,
  solveShot,
  type WhiteModelBake,
  type WhiteModelObject,
  type WhiteModelScenePlan,
} from "./whiteModelScene";

export type {
  WhiteModelBake,
  WhiteModelCamera,
  WhiteModelCameraKeyframe,
  WhiteModelMotion,
  WhiteModelMotionClip,
  WhiteModelObject,
  WhiteModelPathKeyframe,
  WhiteModelScenePlan,
  WhiteModelVector,
} from "./whiteModelScene";

export interface WhiteModelCharacterBinding {
  readonly actorId: string;
  readonly reference: WhiteModelBinding | null;
}

export interface WhiteModelStudioDraft {
  executablePath: string;
  sourceBlendPath: string;
  mode: "create" | "blend";
  plan: WhiteModelScenePlan;
  jobId: string | null;
  jobInputSignature?: string;
  /** 全景/场景底图，只影响导演台预览与站位图，不参与 Blender 成片签名。 */
  environment?: WhiteModelBinding | null;
  /** 假人 → 角色参考图；导出多参考提示词时按当前假人编号展开。 */
  characterBindings?: readonly WhiteModelCharacterBinding[];
  blockingImagePath?: string | null;
  blockingImageSignature?: string;
}
export interface BlenderRenderRequest {
  executablePath: string | null;
  sourceBlendPath: string | null;
  plan: WhiteModelScenePlan;
  /** 由方案逐帧烘焙得到；导入 .blend 工程时为 null。 */
  bake: WhiteModelBake | null;
}

const engineSchema = v.object({
  available: v.boolean(),
  executablePath: v.nullable(v.string()),
  version: v.nullable(v.string()),
  message: v.string(),
});
const jobSchema = v.object({
  jobId: v.string(),
  status: v.picklist(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  message: v.string(),
  error: v.nullable(v.string()),
  videoPath: v.nullable(v.string()),
  previewPath: v.nullable(v.string()),
  projectPath: v.nullable(v.string()),
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1)),
  durationSeconds: v.pipe(v.number(), v.finite(), v.minValue(0)),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type BlenderEngineStatus = v.InferOutput<typeof engineSchema>;
export type BlenderRenderJob = v.InferOutput<typeof jobSchema>;

export const WHITE_MODEL_ACTOR_COLORS = ["#dc6868", "#698bce", "#d4ae59", "#73ad8e"] as const;
/** 默认人形身高（米）。 */
export const DEFAULT_PERSON_HEIGHT = 1.75;

export function createWhiteModelObject(
  index: number,
  durationSeconds: number,
  shape: WhiteModelObject["shape"] = "person",
): WhiteModelObject {
  const lane = index * 1.2;
  return {
    id: crypto.randomUUID(),
    name: shape === "person" ? `角色 ${index + 1}` : `道具 ${index + 1}`,
    shape,
    color: WHITE_MODEL_ACTOR_COLORS[index % WHITE_MODEL_ACTOR_COLORS.length]!,
    size: shape === "person" ? DEFAULT_PERSON_HEIGHT : 1,
    facing: "path",
    keyframes: [
      { time: 0, position: [-2, lane, 0], yaw: 90 },
      { time: durationSeconds, position: [2, lane, 0], yaw: 90 },
    ],
    motion: { kind: "auto" },
  };
}

export function createWhiteModelScenePlan(): WhiteModelScenePlan {
  const durationSeconds = 8;
  const actor = createWhiteModelObject(0, durationSeconds);
  const shot = solveShot(
    { position: [0, 0, 0], yaw: 90, height: actor.size, isPerson: true },
    { size: "full", angle: "eye", direction: "front_left" },
    35,
    16 / 9,
  );
  return {
    version: 2,
    durationSeconds,
    fps: 24,
    width: 960,
    height: 540,
    camera: {
      lens: 35,
      interpolation: "smooth",
      keyframes: [{ time: 0, ...shot }],
      follow: { actorId: actor.id, mode: "aim" },
    },
    objects: [actor],
  };
}

export function createWhiteModelStudioDraft(): WhiteModelStudioDraft {
  return {
    executablePath: "",
    sourceBlendPath: "",
    mode: "create",
    plan: createWhiteModelScenePlan(),
    jobId: null,
  };
}

/**
 * 读取画布里持久化的草稿：旧版 v1 方案自动迁移到 v2。迁移是确定性的，
 * 若旧签名与旧方案匹配，则同步换算成新签名，已渲染成片继续可用。
 */
export function normalizeWhiteModelStudioDraft(draft: WhiteModelStudioDraft): WhiteModelStudioDraft {
  const plan: unknown = draft.plan;
  if (!isWhiteModelScenePlanV1(plan)) return draft;
  const legacyRequest = {
    executablePath: draft.executablePath.trim() || null,
    sourceBlendPath: draft.mode === "blend" ? draft.sourceBlendPath.trim() : null,
    plan,
  };
  const matched =
    draft.jobInputSignature != null && draft.jobInputSignature === JSON.stringify(legacyRequest);
  const migrated: WhiteModelStudioDraft = { ...draft, plan: migrateWhiteModelScenePlan(plan) };
  return matched
    ? { ...migrated, jobInputSignature: whiteModelRenderSignature(migrated) }
    : migrated;
}

/** 提交给渲染端的完整请求：方案 + 逐帧烘焙。 */
export function whiteModelRenderRequest(draft: WhiteModelStudioDraft): BlenderRenderRequest {
  const importing = draft.mode === "blend";
  return {
    executablePath: draft.executablePath.trim() || null,
    sourceBlendPath: importing ? draft.sourceBlendPath.trim() : null,
    plan: draft.plan,
    bake: importing ? null : bakeWhiteModelScene(draft.plan),
  };
}

/** 判断「设置是否改过」的签名只看语义方案，烘焙数据由方案确定性推出，不参与比较。 */
export function whiteModelRenderSignature(draft: WhiteModelStudioDraft): string {
  return JSON.stringify({
    executablePath: draft.executablePath.trim() || null,
    sourceBlendPath: draft.mode === "blend" ? draft.sourceBlendPath.trim() : null,
    plan: draft.plan,
  });
}

export async function getBlenderEngine(
  executablePath?: string | null,
): Promise<BlenderEngineStatus> {
  const path = (executablePath ?? "").trim();
  return v.parse(
    engineSchema,
    await invoke("get_blender_engine", { executablePath: path || null }),
  );
}
export async function startBlenderRender(request: BlenderRenderRequest): Promise<BlenderRenderJob> {
  return v.parse(jobSchema, await invoke("start_blender_render", { request }));
}
export async function getBlenderRender(jobId: string): Promise<BlenderRenderJob> {
  return v.parse(jobSchema, await invoke("get_blender_render", { jobId }));
}
export async function cancelBlenderRender(jobId: string): Promise<BlenderRenderJob> {
  return v.parse(jobSchema, await invoke("cancel_blender_render", { jobId }));
}
export async function openBlenderProject(
  executablePath: string | null,
  projectPath: string,
): Promise<void> {
  const path = (executablePath ?? "").trim();
  await invoke("open_blender_project", {
    executablePath: path || null,
    projectPath,
  });
}
