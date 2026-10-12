import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime } from "./backend";

export type BrandModelReferenceRole =
  "front" | "profile" | "three_quarter" | "full_body" | "expression" | "detail";

export interface BrandModelReference {
  readonly id: string;
  readonly label: string;
  readonly role: BrandModelReferenceRole;
  readonly path: string;
  /** SHA-256 of the durable, EXIF-normalized PNG held by the native library. */
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}

export interface BrandModelVersion {
  readonly id: string;
  readonly version: number;
  readonly createdAt: number;
  readonly status: "draft" | "approved";
  readonly description: string;
  readonly invariants: string;
  readonly references: readonly BrandModelReference[];
  readonly signature: string;
}

export interface BrandModelProfile {
  readonly id: string;
  readonly brandName: string;
  readonly name: string;
  readonly archived: boolean;
  /** Latest approved identity. Saving a draft never changes this pointer. */
  readonly currentVersionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly versions: readonly BrandModelVersion[];
}

export interface BrandModelSelection {
  readonly profileId: string;
  readonly versionId: string;
  readonly signature: string;
  readonly name: string;
  readonly description: string;
  readonly invariants: string;
  readonly references: readonly BrandModelReference[];
}

export interface BrandModelReferenceInput {
  readonly sourcePath: string;
  readonly label: string;
  readonly role: BrandModelReferenceRole;
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}

export interface SaveBrandModelVersionInput {
  readonly profileId?: string;
  readonly expectedCurrentVersionId?: string | null;
  readonly brandName: string;
  readonly name: string;
  readonly description: string;
  readonly invariants: string;
  readonly references: readonly BrandModelReferenceInput[];
}

export interface BrandModelVersionInput {
  readonly profileId: string;
  readonly versionId: string;
  readonly expectedSignature: string;
}

export interface BrandModelVersionRequirement {
  readonly field: "brandName" | "name" | "description" | "invariants" | "references";
  readonly hint: string;
}

function localBrandModelPath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path) && !path.includes("\0");
}

/** Shared save readiness for the library UI and the submission boundary. */
export function brandModelVersionRequirements(
  input: SaveBrandModelVersionInput,
): readonly BrandModelVersionRequirement[] {
  const missing: BrandModelVersionRequirement[] = [];
  if (!input.brandName.trim()) missing.push({ field: "brandName", hint: "请填写模特所属品牌。" });
  if (!input.name.trim()) missing.push({ field: "name", hint: "请填写数字模特名称。" });
  if (!input.description.trim())
    missing.push({ field: "description", hint: "请描述模特的外观、年龄段和造型。" });
  if (!input.invariants.trim())
    missing.push({
      field: "invariants",
      hint: "请填写跨图片和视频应保持一致的脸型、五官和身材等身份特征。",
    });
  if (input.references.length === 0)
    missing.push({ field: "references", hint: "请至少添加一张清晰的模特参考图。" });
  else if (
    input.references.some(
      (reference) => !reference.label.trim() || !localBrandModelPath(reference.sourcePath),
    )
  )
    missing.push({
      field: "references",
      hint: "请给每张参考图填写用途名称，并选择已保存到本机的图片。",
    });
  return missing;
}

const text = v.pipe(v.string(), v.nonEmpty());
const integer = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const localPath = v.pipe(
  v.string(),
  v.check(localBrandModelPath, "请选择已保存到本机的模特参考图。"),
);
const role = v.picklist(["front", "profile", "three_quarter", "full_body", "expression", "detail"]);
const referenceSchema = v.strictObject({
  id: text,
  label: text,
  role,
  path: localPath,
  contentHash: hash,
  width: positiveInteger,
  height: positiveInteger,
  taskId: v.exactOptional(text),
  resultIndex: v.exactOptional(integer),
  sourceNodeId: v.exactOptional(text),
});
const versionSchema = v.strictObject({
  id: text,
  version: positiveInteger,
  createdAt: integer,
  status: v.picklist(["draft", "approved"]),
  description: text,
  invariants: text,
  references: v.pipe(v.array(referenceSchema), v.minLength(1)),
  signature: hash,
});
const profileSchema = v.strictObject({
  id: text,
  brandName: text,
  name: text,
  archived: v.boolean(),
  currentVersionId: v.nullable(text),
  createdAt: integer,
  updatedAt: integer,
  versions: v.pipe(v.array(versionSchema), v.minLength(1)),
});
const selectionSchema = v.strictObject({
  profileId: text,
  versionId: text,
  signature: hash,
  name: text,
  description: text,
  invariants: text,
  references: v.pipe(v.array(referenceSchema), v.minLength(1)),
});
const inputReferenceSchema = v.strictObject({
  sourcePath: localPath,
  label: text,
  role,
  taskId: v.exactOptional(text),
  resultIndex: v.exactOptional(integer),
  sourceNodeId: v.exactOptional(text),
});
const saveInputSchema = v.strictObject({
  profileId: v.exactOptional(text),
  expectedCurrentVersionId: v.exactOptional(v.nullable(text)),
  brandName: text,
  name: text,
  description: text,
  invariants: text,
  references: v.pipe(v.array(inputReferenceSchema), v.minLength(1)),
});
const versionInputSchema = v.strictObject({
  profileId: text,
  versionId: text,
  expectedSignature: hash,
});

function requireDesktop() {
  if (!isDesktopRuntime())
    throw new Error("请在桌面应用中打开品牌数字模特库，参考图会长期保存在本机。");
}

export function parseBrandModelSelection(value: unknown): BrandModelSelection {
  return v.parse(selectionSchema, value);
}

/** Create a detached identity snapshot. A newer approval never silently
 * changes a workflow already bound to this version. */
export function selectBrandModelVersion(
  profile: BrandModelProfile,
  version: BrandModelVersion,
): BrandModelSelection {
  if (profile.archived) throw new Error("该数字模特已归档，请恢复后再选用于新的制作。");
  const approved = profile.versions.find(
    (entry) =>
      entry.id === version.id &&
      entry.signature === version.signature &&
      entry.status === "approved",
  );
  if (!approved) throw new Error("该模特版本尚未批准，请先检查参考图并批准身份。");
  return parseBrandModelSelection({
    profileId: profile.id,
    versionId: approved.id,
    signature: approved.signature,
    name: profile.name,
    description: approved.description,
    invariants: approved.invariants,
    references: approved.references.map((reference) => ({ ...reference })),
  });
}

export async function listBrandModels(): Promise<readonly BrandModelProfile[]> {
  requireDesktop();
  return v.parse(v.array(profileSchema), await invoke("list_brand_models"));
}

export async function saveBrandModelVersion(
  input: SaveBrandModelVersionInput,
): Promise<BrandModelProfile> {
  requireDesktop();
  const missing = brandModelVersionRequirements(input);
  if (missing.length > 0) throw new Error(missing.map((entry) => entry.hint).join("\n"));
  const command = v.parse(saveInputSchema, input);
  const profile = v.parse(profileSchema, await invoke("save_brand_model_version", { command }));
  if (command.profileId && profile.id !== command.profileId)
    throw new Error("模特保存结果不匹配，请刷新模特库后重试。");
  return profile;
}

export async function approveBrandModelVersion(
  input: BrandModelVersionInput,
): Promise<BrandModelProfile> {
  requireDesktop();
  const command = v.parse(versionInputSchema, input);
  const profile = v.parse(profileSchema, await invoke("approve_brand_model_version", { command }));
  if (
    profile.id !== command.profileId ||
    !profile.versions.some(
      (entry) =>
        entry.id === command.versionId &&
        entry.signature === command.expectedSignature &&
        entry.status === "approved",
    )
  ) {
    throw new Error("模特身份批准结果不匹配，请刷新模特库后重试。");
  }
  return profile;
}

export async function validateBrandModelVersion(
  input: BrandModelVersionInput,
): Promise<BrandModelVersion> {
  requireDesktop();
  const command = v.parse(versionInputSchema, input);
  const version = v.parse(versionSchema, await invoke("validate_brand_model_version", { command }));
  if (
    version.status !== "approved" ||
    version.id !== command.versionId ||
    version.signature !== command.expectedSignature
  ) {
    throw new Error("模特身份检查结果不匹配，请重新选择并确认冻结版本。");
  }
  return version;
}

export async function archiveBrandModel(input: {
  readonly profileId: string;
  readonly archived: boolean;
}): Promise<BrandModelProfile> {
  requireDesktop();
  const command = v.parse(v.strictObject({ profileId: text, archived: v.boolean() }), input);
  const profile = v.parse(profileSchema, await invoke("archive_brand_model", { command }));
  if (profile.id !== command.profileId || profile.archived !== command.archived)
    throw new Error("模特归档状态不匹配，请刷新模特库后重试。");
  return profile;
}
