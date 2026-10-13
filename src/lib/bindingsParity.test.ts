import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as v from "valibot";
import {
  cloudAssetStatusSchema,
  generationOperationSchema,
  generationResultMediaTypeSchema,
  generationTaskStatusSchema,
  mediaTypeSchema,
  queryHealthSchema,
  saveStatusSchema,
  stagingStatusSchema,
  videoCompositionStatusSchema,
  videoComposerEngineStateSchema,
  videoCookieBrowserSchema,
  videoDownloadCredentialSourceSchema,
  videoDownloadQualityModeSchema,
  videoDownloadStatusSchema,
  videoDownloaderEngineStateSchema,
  videoFrameExtractionStatusSchema,
} from "./backendSchemas";

/**
 * 枚举契约对账：Rust 是唯一事实源（src-tauri 里的 enum，经 ts-rs 生成到
 * ./bindings/），valibot picklist 是它在值层面的镜像。这里逐字比对两者，
 * 任何一侧悄悄增删变体都会让测试失败——手抄时代这种漂移只能靠运行时撞见。
 *
 * 维护约定：
 * - 新增契约枚举：Rust enum 加 `#[derive(TS)]` + `#[ts(export)]`，跑 `pnpm codegen`，
 *   再把对应 picklist 加进下面的对账表。
 * - 标 relation = "subset" 的 picklist 是刻意收窄（如素材库不收 "text"），
 *   只要求 picklist ⊆ 绑定变体。
 */

function bindingVariants(name: string): string[] {
  const source = readFileSync(new URL(`./bindings/${name}.ts`, import.meta.url), "utf8");
  const body = /export type \w+ = ([^;]+);/s.exec(source)?.[1];
  if (!body) throw new Error(`bindings/${name}.ts 里没有找到导出的 union 类型`);
  return [...body.matchAll(/"([^"]+)"/g)].flatMap((match) =>
    match[1] !== undefined ? [match[1]] : [],
  );
}

function picklistOptions(schema: v.GenericSchema): readonly string[] {
  const options: unknown = (schema as { options?: unknown }).options;
  if (!Array.isArray(options)) throw new Error("对账表里混进了非 picklist 的 schema");
  return options.filter((option): option is string => typeof option === "string");
}

const EXACT = [
  ["generationOperationSchema", generationOperationSchema, "GenerationOperation"],
  ["generationTaskStatusSchema", generationTaskStatusSchema, "GenerationTaskStatus"],
  ["queryHealthSchema", queryHealthSchema, "QueryHealth"],
  ["saveStatusSchema", saveStatusSchema, "SaveStatus"],
  ["generationResultMediaTypeSchema", generationResultMediaTypeSchema, "MediaType"],
  ["cloudAssetStatusSchema", cloudAssetStatusSchema, "CloudAssetStatus"],
  ["stagingStatusSchema", stagingStatusSchema, "StagingStatus"],
  ["videoDownloadStatusSchema", videoDownloadStatusSchema, "VideoDownloadStatus"],
  [
    "videoDownloaderEngineStateSchema",
    videoDownloaderEngineStateSchema,
    "VideoDownloaderEngineState",
  ],
  ["videoDownloadQualityModeSchema", videoDownloadQualityModeSchema, "VideoDownloadQualityMode"],
  [
    "videoDownloadCredentialSourceSchema",
    videoDownloadCredentialSourceSchema,
    "VideoDownloadCredentialSource",
  ],
  ["videoCookieBrowserSchema", videoCookieBrowserSchema, "VideoCookieBrowser"],
  [
    "videoFrameExtractionStatusSchema",
    videoFrameExtractionStatusSchema,
    "VideoFrameExtractionStatus",
  ],
  ["videoCompositionStatusSchema", videoCompositionStatusSchema, "VideoCompositionStatus"],
  ["videoComposerEngineStateSchema", videoComposerEngineStateSchema, "VideoComposerEngineState"],
] as const;

const SUBSET = [
  // 素材库三媒体刻意排除 "text"（Context-IR 文本产物不是素材，也不会进素材库）。
  ["mediaTypeSchema", mediaTypeSchema, "MediaType"],
] as const;

describe("bindings 契约对账（Rust ↔ valibot picklist）", () => {
  it.each(EXACT)("%s 与 bindings/%s 逐字一致", (_name, schema, binding) => {
    expect(picklistOptions(schema)).toEqual(bindingVariants(binding));
  });

  it.each(SUBSET)("%s 是 bindings/%s 的子集", (_name, schema, binding) => {
    const variants = bindingVariants(binding);
    for (const option of picklistOptions(schema)) {
      expect(variants).toContain(option);
    }
  });
});
