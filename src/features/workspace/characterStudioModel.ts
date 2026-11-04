import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import type { AssetItem } from "./workspaceModel";
import { assetNodeReferenceTarget } from "./workspaceModel";
import { localBase64AssetClient, type MediaReferenceTarget } from "../../lib/backend";
import type { BrandModelReferenceRole, BrandModelVersion } from "../../lib/brandModels";
import { prepareCanvasMediaSource } from "../../lib/videoLocalEdit";

export const CHARACTER_BRAND = "画布角色库";
export const CHARACTER_REFERENCE_LIMIT = 8;

export const CHARACTER_FIELDS = {
  gender: { label: "性别", options: ["女", "男", "中性"] },
  age: { label: "年龄段", options: ["儿童", "少年", "青年", "中年", "老年"] },
  region: { label: "文化区域", options: ["东亚", "南亚", "欧洲", "中东", "非洲", "美洲", "其他"] },
  era: { label: "时代", options: ["现代", "近代", "古代", "未来"] },
  face: { label: "脸型", options: ["鹅蛋脸", "圆脸", "方脸", "长脸", "心形脸"] },
  eyes: { label: "眼睛", options: ["杏眼", "圆眼", "细长眼", "深邃眼"] },
  nose: { label: "鼻形", options: ["直鼻", "小翘鼻", "宽鼻", "鹰钩鼻"] },
  lips: { label: "唇形", options: ["薄唇", "丰唇", "明显唇峰"] },
  features: { label: "辨识特征", options: [] },
  body: { label: "体态", options: [] },
  hair: { label: "发型", options: ["短发", "长直发", "长卷发", "马尾", "盘发"] },
  hairColor: { label: "发色", options: ["自然黑", "深棕", "栗棕", "浅金", "银灰"] },
  makeup: { label: "妆容", options: ["素颜", "自然淡妆", "复古红唇", "舞台妆"] },
  lipColor: { label: "唇色", options: ["自然", "裸粉", "豆沙", "珊瑚", "正红", "梅子"] },
  outfit: { label: "服饰类别", options: ["现代", "正装", "国潮", "民族", "古装", "民国", "仙侠", "科幻", "童装", "特效"] },
  styling: { label: "服装、妆发和造型", options: [] },
  voice: { label: "音色描述", options: [] },
} as const;

export type CharacterField = keyof typeof CHARACTER_FIELDS;
export type CharacterLook = Partial<Record<CharacterField, string>>;

export const CHARACTER_ADJUSTMENTS = {
  complexion: "肤色亮度",
  eyeSize: "眼睛大小",
  noseWidth: "鼻翼宽度",
  lipWidth: "嘴唇宽度",
  faceWidth: "脸部宽度",
  bodyWidth: "体态宽度",
} as const;
export type CharacterAdjustment = keyof typeof CHARACTER_ADJUSTMENTS;
export interface CharacterVisual {
  readonly adjustments: Partial<Record<CharacterAdjustment, number>>;
  readonly face?: { readonly x: number; readonly y: number; readonly radius: number };
  readonly marks: readonly { readonly kind: CharacterMark; readonly x: number; readonly y: number }[];
}
export const CHARACTER_MARKS = {
  mole: "痣", scar: "疤痕", freckles: "雀斑",
} as const;
export type CharacterMark = keyof typeof CHARACTER_MARKS;
export const EMPTY_CHARACTER_VISUAL: CharacterVisual = { adjustments: {}, marks: [] };

export const CHARACTER_REF_ROLES: readonly { value: BrandModelReferenceRole; label: string }[] = [
  { value: "front", label: "正面人像" },
  { value: "profile", label: "侧面" },
  { value: "three_quarter", label: "三视图 / 多角度" },
  { value: "full_body", label: "全身" },
  { value: "expression", label: "表情" },
  { value: "detail", label: "细节" },
];

export const CHARACTER_IMAGE_DRAFTS = [
  { id: "portrait", label: "人像", role: "front", instruction: "一张正面头像，半身近景，眼睛平视镜头，干净的纯色背景。" },
  { id: "full_body", label: "全身", role: "full_body", instruction: "完整全身站立造型，从头到脚清晰可见，服装细节完整，背景干净。" },
  { id: "expression", label: "表情", role: "expression", instruction: "同一角色的表情设定图，清晰展示自然、微笑、严肃、惊讶四种表情，保持五官与造型一致。" },
  { id: "turnaround", label: "三视图", role: "three_quarter", instruction: "角色三视图设定图，横向并排展示正面、侧面、背面，统一比例、站姿、服装和背景。" },
] as const;

export interface CharacterMediaSource {
  readonly label: string;
  readonly src?: string | null | undefined;
  readonly path?: string;
  readonly target?: MediaReferenceTarget;
}

export interface CharacterImageDraft {
  readonly id: string;
  readonly role: BrandModelReferenceRole;
  readonly source: CharacterMediaSource;
}

export interface CharacterVersionInfo {
  readonly description: string;
  readonly lookName: string;
  readonly look: CharacterLook;
  readonly voiceAssetId: string | null;
  readonly visual: CharacterVisual;
}

const LOOK_MARKER = "\n\n[canvas-character-studio/v1]\n";

export function characterVersionInfo(description: string): CharacterVersionInfo {
  const marker = description.lastIndexOf(LOOK_MARKER);
  const legacy = { description, lookName: "", look: {}, voiceAssetId: null, visual: EMPTY_CHARACTER_VISUAL };
  if (marker < 0) return legacy;
  try {
    const raw = JSON.parse(description.slice(marker + LOOK_MARKER.length)) as Record<string, unknown>;
    const look: CharacterLook = {};
    const fields = raw["look"];
    if (fields && typeof fields === "object") {
      const values = fields as Record<string, unknown>;
      for (const field of Object.keys(CHARACTER_FIELDS) as CharacterField[]) {
        const value = values[field];
        if (typeof value === "string" && value.trim()) look[field] = value;
      }
    }
    return {
      description: description.slice(0, marker),
      look,
      lookName: typeof raw["lookName"] === "string" ? raw["lookName"] : "",
      voiceAssetId: typeof raw["voiceAssetId"] === "string" ? raw["voiceAssetId"] : null,
      visual: decodeCharacterVisual(raw["visual"]),
    };
  } catch {
    return legacy;
  }
}

export function encodeCharacterVersion(info: CharacterVersionInfo): string {
  return info.description.trim() + LOOK_MARKER + JSON.stringify({
    lookName: info.lookName,
    look: info.look,
    voiceAssetId: info.voiceAssetId,
    visual: info.visual,
  });
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function decodeCharacterVisual(value: unknown): CharacterVisual {
  if (!value || typeof value !== "object") return EMPTY_CHARACTER_VISUAL;
  const raw = value as Record<string, unknown>;
  const settings = raw["adjustments"] as Partial<Record<CharacterAdjustment, unknown>> | undefined;
  const adjustments: CharacterVisual["adjustments"] = {};
  for (const key of Object.keys(CHARACTER_ADJUSTMENTS) as CharacterAdjustment[]) {
    const amount = settings?.[key];
    if (inRange(amount, -100, 100)) adjustments[key] = amount;
  }
  const face = raw["face"] as Partial<NonNullable<CharacterVisual["face"]>> | undefined;
  const marks: CharacterVisual["marks"][number][] = [];
  if (Array.isArray(raw["marks"])) for (const mark of raw["marks"].slice(0, 12)) {
    if (mark && Object.hasOwn(CHARACTER_MARKS, mark.kind) && inRange(mark.x, 0, 1) && inRange(mark.y, 0, 1)) {
      marks.push({ kind: mark.kind, x: mark.x, y: mark.y });
    }
  }
  return {
    adjustments, marks,
    ...(face && inRange(face.x, 0, 1) && inRange(face.y, 0, 1) && inRange(face.radius, 0.035, 0.48)
      ? { face: { x: face.x, y: face.y, radius: face.radius } } : {}),
  };
}

export function characterPrompt(name: string, info: Pick<CharacterVersionInfo, "look" | "description" | "visual">, invariants: string) {
  const details = (Object.keys(CHARACTER_FIELDS) as CharacterField[]).flatMap((field) => {
    const value = info.look[field]?.trim();
    return value ? [CHARACTER_FIELDS[field].label + "：" + value] : [];
  });
  const adjustments = (Object.keys(CHARACTER_ADJUSTMENTS) as CharacterAdjustment[]).flatMap(key => {
    const amount = info.visual.adjustments[key] ?? 0;
    return amount ? [`${CHARACTER_ADJUSTMENTS[key]}${amount > 0 ? "增加" : "减少"} ${Math.abs(amount)}%`] : [];
  });
  const marks = [...new Set(info.visual.marks.map(mark => CHARACTER_MARKS[mark.kind]))];
  return [`角色「${name}」`, info.description.trim(), ...details,
    adjustments.length ? "造型微调：" + adjustments.join("，") : "",
    marks.length ? "保留角色标记：" + marks.join("、") : "",
    invariants.trim() ? "保持一致的身份特征：" + invariants.trim() : ""]
    .filter(Boolean).join("\n");
}

export function characterReferenceVersion(versions: readonly BrandModelVersion[], current: string | null) {
  return versions.find((version) => version.id === current) ?? versions[0];
}

export function characterSourceFromAsset(asset: AssetItem): CharacterMediaSource {
  return {
    label: asset.name,
    src: asset.videoUrl ?? asset.previewUrl,
    target: assetNodeReferenceTarget({
      key: asset.id, assetId: asset.id, providerConnectionId: asset.providerConnectionId ?? "",
      kind: asset.kind, name: asset.name, previewUrl: asset.previewUrl ?? null,
      videoUrl: asset.videoUrl ?? null, x: 0, y: 0,
      ...(asset.source ? { source: asset.source } : {}),
    }),
  };
}

const LOCAL_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/bmp": "bmp", "image/tiff": "tiff", "image/avif": "avif",
  "image/heic": "heic", "image/heif": "heif",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a",
  "audio/flac": "flac", "audio/ogg": "ogg", "audio/aac": "aac",
};

async function prepareCharacterSource(target: MediaReferenceTarget) {
  try {
    return await prepareCanvasMediaSource(target);
  } catch (error) {
    // Only the installed development runtime's missing command can use this compatibility path.
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Command prepare_canvas_media_source not found" || target.kind !== "local_base64_asset" ||
        (target.mediaType !== "image" && target.mediaType !== "audio")) throw error;
    const src = await localBase64AssetClient.refreshMedia({ assetId: target.assetId, mediaType: target.mediaType });
    const response = await fetch(src);
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
    const extension = LOCAL_MEDIA_EXTENSIONS[mime];
    if (response.status !== 200 || !extension || !mime.startsWith(target.mediaType + "/")) {
      throw new Error("当前开发版无法读取这份素材的完整原件。请从本机文件选择原件。");
    }
    const directory = await join(await appDataDir(), "character-studio-inputs");
    await mkdir(directory, { recursive: true });
    const path = await join(directory, crypto.randomUUID() + "." + extension);
    const release = () => remove(path);
    try {
      await writeFile(path, new Uint8Array(await response.arrayBuffer()));
      return { path, src, release };
    } catch (failure) {
      await release().catch(() => {});
      throw failure;
    }
  }
}

/** Hold materialized library files until the native importer finishes copying them. */
export async function withCharacterSourcePaths<T>(
  sources: readonly CharacterMediaSource[],
  action: (paths: readonly string[]) => Promise<T>,
): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  try {
    const paths: string[] = [];
    for (const source of sources) {
      if (source.path) paths.push(source.path);
      else if (source.target) {
        const prepared = await prepareCharacterSource(source.target);
        releases.push(prepared.release);
        paths.push(prepared.path);
      } else throw new Error("角色素材已失效，请重新选择。");
    }
    return await action(paths);
  } finally {
    await Promise.allSettled(releases.map((release) => release()));
  }
}
