import * as v from "valibot";
import type {
  AnimationPlan,
  AnimationRenderJob,
  RemotionWorkflowOptions,
} from "../features/workspace/remotionWorkflowModel";
import { invokeDesktop, invokeDesktopVoid } from "./ipc";

export interface RemotionRendererClient {
  preflight(): Promise<{ readonly ready: boolean; readonly message: string }>;
  start(command: {
    readonly plan: AnimationPlan;
    readonly format: RemotionWorkflowOptions["format"];
  }): Promise<AnimationRenderJob>;
  get(jobId: string): Promise<AnimationRenderJob>;
  cancel(jobId: string): Promise<void>;
}

const remotionRendererPreflightSchema = v.object({
  ready: v.boolean(),
  message: v.string(),
});

const remotionRenderJobSchema = v.object({
  id: v.string(),
  status: v.picklist(["running", "succeeded", "failed", "cancelled"]),
  progress: v.number(),
  message: v.string(),
  error: v.optional(v.nullable(v.string())),
  gifPath: v.optional(v.nullable(v.string())),
  videoPath: v.optional(v.nullable(v.string())),
  previewPath: v.optional(v.nullable(v.string())),
  projectPath: v.optional(v.nullable(v.string())),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const remotionRendererClient: RemotionRendererClient = {
  preflight: () => invokeDesktop("remotion_renderer_preflight", remotionRendererPreflightSchema),
  start: (command) => invokeDesktop("start_remotion_render", remotionRenderJobSchema, { command }),
  get: (jobId) => invokeDesktop("get_remotion_render", remotionRenderJobSchema, { jobId }),
  cancel: (jobId) => invokeDesktopVoid("cancel_remotion_render", { jobId }),
};
