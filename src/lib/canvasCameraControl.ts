import * as v from "valibot";
import rawCatalog from "../../shared/canvas-camera-control.json";

const itemSchema = v.object({
  key: v.string(), name: v.string(), image: v.optional(v.string()),
  value: v.optional(v.number()), sourceKey: v.string(), prompt: v.string(),
});
const keysSchema = v.object({ camera: v.string(), lens: v.string(), focal: v.string(), aperture: v.string() });
const catalog = v.parse(v.object({
  version: v.number(), catalogOrigin: v.string(), instructionOrigin: v.string(), defaults: keysSchema,
  instructionAssembly: v.string(), sourceConfigId: v.string(), sourceConfigSha256: v.string(),
  camera: v.array(itemSchema), lens: v.array(itemSchema), focal: v.array(itemSchema), aperture: v.array(itemSchema),
}), rawCatalog);
const controlSchema = v.object({
  // 选择结构和 key 没变；原文片段的来源版本由后端任务快照另行冻结。
  version: v.number(), enabled: v.boolean(), camera: v.string(), lens: v.string(), focal: v.string(), aperture: v.string(),
});

export type CanvasCameraControl = v.InferOutput<typeof controlSchema>;
export type CanvasCameraItem = v.InferOutput<typeof itemSchema>;
export const CAMERA_CONTROL_CATEGORIES = [
  { key: "camera", label: "相机", unit: "" },
  { key: "lens", label: "镜头", unit: "" },
  { key: "focal", label: "焦距", unit: "mm" },
  { key: "aperture", label: "光圈", unit: "" },
] as const;
export type CanvasCameraCategory = (typeof CAMERA_CONTROL_CATEGORIES)[number]["key"];
// 原站内宽 640px；本地计入两侧各 1px 的边框。
export const CAMERA_CONTROL_PANEL_WIDTH = 642;
const PREFERENCES_KEY = "infinite-canvas:image-camera-control:v1";

export function cameraControlItems(category: CanvasCameraCategory): readonly CanvasCameraItem[] {
  return catalog[category];
}

export function defaultCanvasCameraControl(): CanvasCameraControl {
  return { version: catalog.version, enabled: false, ...catalog.defaults };
}

export function cameraControlIssue(value: unknown): string | null {
  if (value == null) return null;
  const parsed = v.safeParse(controlSchema, value);
  if (!parsed.success) return "摄像机配置不完整，请重新选择摄影参数。";
  if (parsed.output.version !== catalog.version) return "摄像机目录版本已变化，请重新确认摄影参数。";
  for (const category of CAMERA_CONTROL_CATEGORIES) {
    if (!catalog[category.key].some(item => item.key === parsed.output[category.key])) {
      return `${category.label}选项已失效，请重新选择。`;
    }
  }
  return null;
}

/** 只为编辑器恢复有效显示；无效存档由界面明确提示，需用户重新选择后才提交。 */
export function editableCanvasCameraControl(value: CanvasCameraControl | undefined): CanvasCameraControl {
  const fallback = defaultCanvasCameraControl();
  if (!value) return fallback;
  const parsed = v.safeParse(controlSchema, value);
  if (!parsed.success) return { ...fallback, enabled: value.enabled === true };
  return {
    ...fallback,
    enabled: parsed.output.enabled,
    ...Object.fromEntries(CAMERA_CONTROL_CATEGORIES.map(category => [
      category.key,
      catalog[category.key].some(item => item.key === parsed.output[category.key]) ? parsed.output[category.key] : fallback[category.key],
    ])),
  };
}

export function readCanvasCameraPreferences(): CanvasCameraControl {
  const fallback = defaultCanvasCameraControl();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return fallback;
    const parsed = v.safeParse(controlSchema, JSON.parse(raw));
    return parsed.success && cameraControlIssue(parsed.output) == null ? parsed.output : fallback;
  } catch { return fallback; }
}

export function saveCanvasCameraPreferences(value: CanvasCameraControl): void {
  if (typeof window === "undefined" || cameraControlIssue(value)) return;
  try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch {
    // 新节点的偏好缓存是可选项；当前节点仍由画布存档独立保存。
  }
}

export function canvasCameraSummary(value: CanvasCameraControl | undefined): string {
  if (!value) return "摄像机";
  return CAMERA_CONTROL_CATEGORIES.map(category => {
    const name = catalog[category.key].find(item => item.key === value[category.key])?.name ?? "未选择";
    return category.key === "focal" ? `${name} mm` : name;
  }).join(" · ");
}

export function cameraControlImageUrl(item: CanvasCameraItem): string | undefined {
  return item.image ? `${import.meta.env.BASE_URL}camera-control/${item.image}` : undefined;
}

export function cameraControlLocked(config: { readonly panoramaEnabled?: boolean; readonly imagePreset?: { readonly scene: string } | undefined }): boolean {
  return config.panoramaEnabled === true || config.imagePreset?.scene === "720_panoramic";
}
