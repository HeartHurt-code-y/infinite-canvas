import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

export type WhiteModelVector = [number, number, number];
export interface WhiteModelObject {
  id: string;
  name: string;
  shape: "box" | "sphere" | "cylinder" | "person";
  color: string;
  size: number;
  keyframes: { time: number; position: WhiteModelVector; yaw: number }[];
}
export interface WhiteModelScenePlan {
  version: 1;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  camera: {
    motion: "static" | "dolly" | "truck" | "orbit";
    start: WhiteModelVector;
    end: WhiteModelVector;
    target: WhiteModelVector;
    orbitDegrees: number;
    lens: number;
  };
  objects: WhiteModelObject[];
}
export interface WhiteModelStudioDraft {
  executablePath: string;
  sourceBlendPath: string;
  mode: "create" | "blend";
  plan: WhiteModelScenePlan;
  jobId: string | null;
  jobInputSignature?: string;
}
export interface BlenderRenderRequest {
  executablePath: string | null;
  sourceBlendPath: string | null;
  plan: WhiteModelScenePlan;
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

export function createWhiteModelObject(index: number, durationSeconds: number): WhiteModelObject {
  return {
    id: crypto.randomUUID(),
    name: `角色 ${index + 1}`,
    shape: "person",
    color: ["#dc6868", "#698bce", "#d4ae59", "#73ad8e"][index % 4]!,
    size: 1,
    keyframes: [
      { time: 0, position: [-2, index * 2, 0], yaw: 0 },
      { time: durationSeconds, position: [2, index * 2, 0], yaw: 0 },
    ],
  };
}
export function createWhiteModelScenePlan(): WhiteModelScenePlan {
  return {
    version: 1,
    durationSeconds: 8,
    fps: 24,
    width: 960,
    height: 540,
    camera: {
      motion: "dolly",
      start: [8, -12, 7],
      end: [6, -9, 5],
      target: [0, 0, 1],
      orbitDegrees: 90,
      lens: 50,
    },
    objects: [createWhiteModelObject(0, 8)],
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
export function whiteModelRenderRequest(draft: WhiteModelStudioDraft): BlenderRenderRequest {
  return {
    executablePath: draft.executablePath.trim() || null,
    sourceBlendPath: draft.mode === "blend" ? draft.sourceBlendPath.trim() : null,
    plan: draft.plan,
  };
}
export function whiteModelRenderSignature(draft: WhiteModelStudioDraft): string {
  return JSON.stringify(whiteModelRenderRequest(draft));
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
