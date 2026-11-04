import catalog from "../../shared/video-camera-presets.json";
import type { CanvasVideoMode } from "./canvasVideoMode";
import { createPromptContentEditorSession, type PromptContentDocumentV1, type PromptContentEditorSession, type PromptContentItem, type PromptGenerationPreparation } from "./promptContent";

export interface VideoCameraPreviewAsset {
  readonly assetId: string;
  readonly url: string;
  readonly mediaType: "image" | "video";
}

export interface VideoCameraPreset {
  readonly id: string;
  readonly name: string;
  readonly tagLabel: string;
  readonly prompt: string;
  readonly image?: string;
  readonly preview?: VideoCameraPreviewAsset;
}

export const VIDEO_CAMERA_PRESETS: readonly VideoCameraPreset[] = catalog.items;
export const MAX_VIDEO_CAMERA_PRESETS = 6;
// LibTV 公开模块 779383：h=6、W=500、T=10，按 Unicode 字符计数。
export const VIDEO_CAMERA_NAME_LIMIT = 6;
export const VIDEO_CAMERA_PROMPT_LIMIT = 500;
export const MAX_CUSTOM_VIDEO_CAMERAS = 10;
export const VIDEO_CAMERA_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_CAMERA_PREVIEW_MAX_SECONDS = 10.05;
export const CAMERA_PRESET_MARK_PREFIX = "camera-preset:";
const STORAGE_KEY = "canvas:video-camera-presets:v1";
export const VIDEO_CAMERA_EFFECT_CONFLICT = "运镜与特效不能同时使用，请先移除其中一项。";

export function hasVideoCameraPreset(document: PromptContentDocumentV1 | undefined): boolean {
  return document?.items.some(item => item.kind === "mark_reference" && item.markId.startsWith(CAMERA_PRESET_MARK_PREFIX)) ?? false;
}

/** LibTV 469850 / 请求编译模块：首尾帧、视频编辑中的运镜只保留，不提交。 */
export function videoCameraPresetsMuted(mode: CanvasVideoMode | undefined): boolean {
  return mode === "first_last_frame" || mode === "edit";
}

export function videoPromptForMode(document: PromptContentDocumentV1, mode: CanvasVideoMode | undefined): PromptContentDocumentV1 {
  if (!videoCameraPresetsMuted(mode) || !document.items.some(item => item.kind === "mark_reference" && item.markId.startsWith(CAMERA_PRESET_MARK_PREFIX))) return document;
  return { ...document, items: document.items.flatMap((item): PromptContentItem[] => {
    if (item.kind !== "mark_reference" || !item.markId.startsWith(CAMERA_PRESET_MARK_PREFIX)) return [item];
    // 保留块尾分隔，不能让移除运镜后的两个段落粘在一起。
    return item.trailing ? [{ kind: "text", text: "\n" }] : [];
  }) };
}

export function prepareVideoPromptForMode(
  document: PromptContentDocumentV1 | undefined,
  mode: CanvasVideoMode | undefined,
  context: Parameters<PromptContentEditorSession["prepareGeneration"]>[0],
): PromptGenerationPreparation | null {
  if (!document) return null;
  const preparedDocument = videoPromptForMode(document, mode);
  if (preparedDocument === document) return null;
  const session = createPromptContentEditorSession();
  try {
    session.restore(preparedDocument);
    return session.prepareGeneration(context);
  } finally { session.attach(null); }
}

export interface VideoCameraLibrary {
  readonly version: 1;
  readonly custom: readonly VideoCameraPreset[];
  readonly favorites: readonly string[];
}

export function readVideoCameraLibrary(): VideoCameraLibrary {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value === "object" && "version" in value && value.version === 1 &&
      "custom" in value && Array.isArray(value.custom) && "favorites" in value && Array.isArray(value.favorites)) {
      return { version: 1, custom: value.custom.filter((item): item is VideoCameraPreset =>
        item && typeof item.id === "string" && typeof item.name === "string" && typeof item.tagLabel === "string" && typeof item.prompt === "string").map(item => {
          const preview = item.preview;
          if (preview && (typeof preview.assetId !== "string" || typeof preview.url !== "string" || !["image", "video"].includes(preview.mediaType))) {
            const { preview: _invalidPreview, ...preset } = item;
            return preset;
          }
          return item;
        }),
      favorites: value.favorites.filter((id): id is string => typeof id === "string") };
    }
  } catch { /* 旧偏好不可读时仍提供内置目录，画布中的引用快照不受影响。 */ }
  return { version: 1, custom: [], favorites: [] };
}

export function saveVideoCameraLibrary(value: VideoCameraLibrary): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function videoCameraPresetIssue(name: string, prompt: string): string | null {
  if (!name.trim()) return "请输入运镜名称。";
  if ([...name.trim()].length > VIDEO_CAMERA_NAME_LIMIT) return `运镜名称最多 ${VIDEO_CAMERA_NAME_LIMIT} 个字。`;
  if (!prompt.trim()) return "请输入运镜提示词。";
  if ([...prompt.trim()].length > VIDEO_CAMERA_PROMPT_LIMIT) return `运镜提示词最多 ${VIDEO_CAMERA_PROMPT_LIMIT} 个字。`;
  return null;
}
