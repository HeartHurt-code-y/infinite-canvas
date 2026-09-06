import { invoke } from "@tauri-apps/api/core";
import type {
  AnimationPlan,
  AnimationRenderJob,
  RemotionWorkflowOptions,
} from "../features/workspace/remotionWorkflowModel";

export interface RemotionRendererClient {
  preflight(): Promise<{ readonly ready: boolean; readonly message: string }>;
  start(command: {
    readonly plan: AnimationPlan;
    readonly format: RemotionWorkflowOptions["format"];
  }): Promise<AnimationRenderJob>;
  get(jobId: string): Promise<AnimationRenderJob>;
  cancel(jobId: string): Promise<void>;
}
export const remotionRendererClient: RemotionRendererClient = {
  preflight: () => invoke("remotion_renderer_preflight"),
  start: (command) => invoke("start_remotion_render", { command }),
  get: (jobId) => invoke("get_remotion_render", { jobId }),
  cancel: (jobId) => invoke("cancel_remotion_render", { jobId }),
};
