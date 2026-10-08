import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

/** Feature requests open component management without submitting a generation job. */
export const RUNTIME_COMPONENTS_REQUEST_EVENT = "runtime-components-request";
export const RUNTIME_COMPONENTS_CHANGED_EVENT = "runtime-components-changed";

export type RuntimeComponentFeature =
  | "white-model-render"
  | "motion-capture"
  | "image-style-library"
  | "animation-render"
  | "browser-download"
  | "media-processing"
  | "ai-media-lite"
  | "ai-media-quality";

const componentIdSchema = v.picklist([
  "blender",
  "remotion-runtime",
  "ffmpeg",
  "pose-runtime",
  "gpt-image-2-style-library",
  "ai-media-runtime",
  "ai-media-quality-runtime",
]);
const featureIdSchema = v.picklist([
  "white-model-render",
  "motion-capture",
  "image-style-library",
  "animation-render",
  "browser-download",
  "media-processing",
  "ai-media-lite",
  "ai-media-quality",
]);
const bytes = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const text = v.pipe(v.string(), v.nonEmpty());
const componentSchema = v.object({
  id: componentIdSchema,
  title: text,
  description: v.string(),
  version: v.string(),
  state: v.picklist(["ready", "not_installed", "damaged"]),
  rootPath: v.nullable(text),
  installedBytes: bytes,
  downloadBytes: bytes,
  dependencies: v.array(componentIdSchema),
  error: v.nullable(v.string()),
});
const transferSchema = v.object({
  active: v.boolean(),
  componentId: v.nullable(componentIdSchema),
  phase: v.picklist([
    "idle",
    "downloading",
    "verifying",
    "extracting",
    "installing",
    "ready",
    "cancelled",
    "error",
  ]),
  completedBytes: bytes,
  totalBytes: bytes,
  reusedBytes: bytes,
  downloadedBytes: bytes,
  error: v.nullable(v.string()),
});
const managerSchema = v.pipe(
  v.object({
    edition: v.picklist(["online", "offline"]),
    catalogReady: v.boolean(),
    catalogError: v.nullable(v.string()),
    components: v.array(componentSchema),
    transfer: transferSchema,
  }),
  v.check(
    (value) => new Set(value.components.map((entry) => entry.id)).size === value.components.length,
    "组件身份重复。",
  ),
);
const featureSchema = v.object({
  id: featureIdSchema,
  title: text,
  ready: v.boolean(),
  missingComponents: v.array(componentIdSchema),
  error: v.nullable(v.string()),
});

export type RuntimeComponentId = v.InferOutput<typeof componentIdSchema>;
export type RuntimeComponentManagerStatus = v.InferOutput<typeof managerSchema>;
export type RuntimeFeatureStatus = v.InferOutput<typeof featureSchema>;
export type RuntimeComponentTransfer = v.InferOutput<typeof transferSchema>;

function requireDesktop(): void {
  if (!isDesktopRuntime()) throw new Error("组件安装需要在桌面应用中运行。");
}

async function invokeStrict<T>(
  command: string,
  schema: v.GenericSchema<unknown, T>,
  args?: Record<string, unknown>,
): Promise<T> {
  requireDesktop();
  return v.parse(schema, await invoke(command, args));
}

async function mutate(command: string, args?: Record<string, unknown>): Promise<void> {
  requireDesktop();
  await invoke(command, args);
}

export const runtimeComponentsClient = {
  status: (): Promise<RuntimeComponentManagerStatus> =>
    invokeStrict("get_runtime_component_manager_status", managerSchema),
  featureStatus: async (featureId: RuntimeComponentFeature): Promise<RuntimeFeatureStatus> => {
    const result = await invokeStrict("get_runtime_feature_status", featureSchema, {
      featureId: v.parse(featureIdSchema, featureId),
    });
    if (result.id !== featureId || (result.ready && result.missingComponents.length))
      throw new Error("功能组件状态与所请求功能不一致。");
    return result;
  },
  assetRoot: (componentId: RuntimeComponentId): Promise<string> =>
    invokeStrict("get_runtime_component_asset_root", text, {
      componentId: v.parse(componentIdSchema, componentId),
    }),
  install: (componentId: RuntimeComponentId, repair = false): Promise<void> =>
    mutate("install_runtime_component", {
      componentId: v.parse(componentIdSchema, componentId),
      repair,
    }),
  importArchive: (componentId: RuntimeComponentId, path: string): Promise<void> =>
    mutate("import_runtime_component_archive", {
      componentId: v.parse(componentIdSchema, componentId),
      path: v.parse(text, path),
    }),
  cancel: (): Promise<void> => mutate("cancel_runtime_component_install"),
};

export function isRuntimeComponentFeature(value: unknown): value is RuntimeComponentFeature {
  return v.is(featureIdSchema, value);
}

export function requestRuntimeComponents(feature?: RuntimeComponentFeature): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(RUNTIME_COMPONENTS_REQUEST_EVENT, { detail: { featureId: feature } }),
  );
}

export async function ensureRuntimeFeatureInstalled(
  featureId: RuntimeComponentFeature,
): Promise<boolean> {
  if (!isDesktopRuntime()) return true;
  try {
    if ((await runtimeComponentsClient.featureStatus(featureId)).ready) return true;
  } catch {
    // Component management explains missing catalogs and supports offline repair.
  }
  requestRuntimeComponents(featureId);
  return false;
}

export function publishRuntimeComponentsChanged(): void {
  window.dispatchEvent(new Event(RUNTIME_COMPONENTS_CHANGED_EVENT));
}

export function subscribeRuntimeComponentsChanged(listener: () => void): () => void {
  window.addEventListener(RUNTIME_COMPONENTS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_COMPONENTS_CHANGED_EVENT, listener);
}
