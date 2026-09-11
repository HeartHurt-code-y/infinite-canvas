import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import {
  frontendLog,
  isDesktopRuntime,
  toMediaSrc,
  tosStagingClient,
  type ExplicitMediaTarget,
  type MediaReferenceTarget,
  type StagingStatus,
} from "./backend";
import type { PromptContentDocumentV1, PromptContentItem } from "./promptContent";

const savedFrameSchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const preparedSourceSchema = v.object({
  previewId: v.pipe(v.string(), v.nonEmpty()),
  path: v.pipe(v.string(), v.nonEmpty()),
});

export interface PreparedVideoEditSource {
  readonly src: string;
  readonly release: () => Promise<void>;
}

/** Read original media on the desktop, independently of preview URL expiry and browser CORS. */
export async function prepareVideoEditSource(
  target: ExplicitMediaTarget | undefined,
  fallbackSrc: string,
): Promise<PreparedVideoEditSource> {
  if (!isDesktopRuntime()) {
    if (!fallbackSrc) throw new Error("此视频需要在桌面应用中读取。");
    return { src: fallbackSrc, release: async () => {} };
  }
  const resolvedTarget =
    target ??
    (/^https?:\/\//i.test(fallbackSrc)
      ? { kind: "url" as const, url: fallbackSrc, mediaType: "video" as const }
      : undefined);
  if (!resolvedTarget) {
    if (!fallbackSrc) throw new Error("缺少待编辑视频来源，请重新连接视频。");
    return { src: fallbackSrc, release: async () => {} };
  }
  const prepared = v.parse(
    preparedSourceSchema,
    await invoke("prepare_video_edit_source", { target: resolvedTarget }),
  );
  let released = false;
  return {
    src: toMediaSrc(prepared.path),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await invoke("release_video_edit_source", { previewId: prepared.previewId });
      } catch {
        frontendLog("warn", "视频编辑临时预览清理失败，将在后续启动时回收。");
      }
    },
  };
}

export async function saveVideoEditFrame(imageDataUrl: string) {
  if (!isDesktopRuntime()) throw new Error("保存视频标注帧需要在桌面应用中运行。");
  return v.parse(savedFrameSchema, await invoke("save_video_edit_frame", { imageDataUrl }));
}

/**
 * 标注帧入库后拿到的云端素材身份。它必须与画布里从素材库拖入的素材同构，
 * 否则提交时只会拿到对象存储的匿名 URL，真人隐私预检会直接拒绝。
 */
export interface VideoEditFrameAsset {
  readonly providerConnectionId: string;
  readonly assetId: string;
}

export interface UploadVideoEditFrameOptions {
  readonly path: string;
  readonly name: string;
  readonly providerConnectionId: string;
  /** 真人平台分组 ID；普通素材传 null，由服务端发现/创建默认上传分组。 */
  readonly groupId?: number | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly onProgress?: ((label: string) => void) | undefined;
}

const UPLOAD_STAGE_LABELS: Partial<Record<StagingStatus, string>> = {
  validating: "正在校验标注帧…",
  authorizing: "正在获取上传授权…",
  uploading: "正在上传标注帧到对象存储…",
  staged: "对象存储上传完成，准备入库…",
  importing: "正在导入云端素材库…",
  active: "素材库导入完成",
};

const FAILED_STAGES: readonly StagingStatus[] = ["failed", "interrupted"];

/**
 * 把标注帧上传到云端素材库并阻塞等待平台审核通过（Pending → Ready）。
 *
 * 只有素材进入素材库、以 `asset://` 资产身份提交，真人素材才具备可用来源；
 * 直接提交对象存储的匿名预签名 URL 会被平台的输入素材隐私预检拒绝。
 * 上传或审核失败时抛错，由调用方决定是否回退为本地文件。
 */
export async function uploadVideoEditFrameToLibrary(
  options: UploadVideoEditFrameOptions,
): Promise<VideoEditFrameAsset> {
  const {
    path,
    name,
    providerConnectionId,
    groupId = null,
    timeoutMs = 120_000,
    pollIntervalMs = 1_000,
    onProgress,
  } = options;
  if (!isDesktopRuntime()) throw new Error("上传标注帧到素材库需要在桌面应用中运行。");
  onProgress?.("正在提交标注帧上传…");
  const jobId = await tosStagingClient.startUpload({
    localPath: path,
    purpose: "asset_import",
    mediaType: "image",
    import: { providerConnectionId, name, groupId },
  });
  const deadline = Date.now() + timeoutMs;
  let lastStatus: StagingStatus | null = null;
  for (;;) {
    const job = await tosStagingClient.getJob(jobId);
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      const label = UPLOAD_STAGE_LABELS[job.status];
      if (label) onProgress?.(label);
    }
    if (job.status === "active") {
      if (!job.assetId) {
        throw new Error("标注帧已进入素材库但未返回素材 ID，请稍后在素材面板确认后重试。");
      }
      return { providerConnectionId, assetId: job.assetId };
    }
    if (FAILED_STAGES.includes(job.status)) {
      throw new Error(`标注帧上传素材库失败：${describeStagingError(job.error, job.status)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("标注帧上传素材库超时，请稍后在素材面板确认后重试。");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}

export interface ResolveVideoEditFrameOptions {
  readonly path: string;
  readonly name: string;
  readonly canvasNodeKey: string;
  /** 素材库连接 ID；为 null（未配置供应商）时直接退化为本地文件。 */
  readonly providerConnectionId: string | null;
  readonly groupId?: number | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly onProgress?: ((label: string) => void) | undefined;
}

export interface ResolvedVideoEditFrame {
  readonly target: MediaReferenceTarget;
  readonly uploadedToLibrary: boolean;
}

/**
 * 决定标注帧以什么身份进入生成请求。
 *
 * 素材库连接可用时先入库，用 `asset://` 资产身份提交；入库失败（未配置对象存储、
 * 平台审核未通过、超时）时退化为本地文件，由调用方给出可见提示——本地文件只会
 * 拿到对象存储的匿名 URL，真人素材会被平台预检拒绝，因此这不是无声降级。
 */
export async function resolveVideoEditFrameTarget(
  options: ResolveVideoEditFrameOptions,
): Promise<ResolvedVideoEditFrame> {
  const {
    path,
    name,
    canvasNodeKey,
    providerConnectionId,
    groupId = null,
    timeoutMs,
    pollIntervalMs,
    onProgress,
  } = options;
  if (providerConnectionId) {
    try {
      const asset = await uploadVideoEditFrameToLibrary({
        path,
        name,
        providerConnectionId,
        groupId,
        timeoutMs,
        pollIntervalMs,
        onProgress,
      });
      return {
        target: {
          kind: "asset",
          providerConnectionId: asset.providerConnectionId,
          assetId: asset.assetId,
          canvasNodeKey,
          mediaType: "image",
        },
        uploadedToLibrary: true,
      };
    } catch (error) {
      frontendLog(
        "warn",
        `标注帧上传素材库失败，回退为本地文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    target: { kind: "local_file", path, canvasNodeKey, mediaType: "image" },
    uploadedToLibrary: false,
  };
}

function describeStagingError(error: unknown, status: StagingStatus): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error === "object" && error != null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return status;
}

interface LocalEditReference {
  readonly key: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
}

function appendText(items: PromptContentItem[], text: string): void {
  if (!text) return;
  const previous = items.at(-1);
  if (previous?.kind === "text") {
    items[items.length - 1] = { kind: "text", text: previous.text + text };
  } else {
    items.push({ kind: "text", text });
  }
}

/**
 * 编辑要求本身是引用文档：正文与 @ 引用按用户书写顺序并入提示词。
 * 只裁掉整体首尾空白，让「…完成局部消除…：{要求}。保持区域外画面…」句读自然；
 * 裁掉的边界项不再产生空文本项。
 */
function appendInstruction(items: PromptContentItem[], instruction: PromptContentDocumentV1): void {
  const incoming = [...instruction.items];
  const first = incoming[0];
  if (first?.kind === "text") {
    const text = first.text.replace(/^\s+/u, "");
    if (text) incoming[0] = { kind: "text", text };
    else incoming.shift();
  }
  const last = incoming.at(-1);
  if (last?.kind === "text") {
    const text = last.text.replace(/\s+$/u, "");
    if (text) incoming[incoming.length - 1] = { kind: "text", text };
    else incoming.pop();
  }
  for (const item of incoming) {
    if (item.kind === "text") appendText(items, item.text);
    else items.push(item);
  }
}

/** Stable references keep the selected video unambiguous even when other inputs are reordered. */
export function appendVideoLocalEditPrompt(
  previous: PromptContentDocumentV1 | undefined,
  source: LocalEditReference,
  frame: LocalEditReference,
  edit: {
    readonly timeSeconds: number;
    readonly operation: "remove" | "replace";
    /** 编辑要求的引用文档，与画布提示词同构，可含 @ 素材引用。 */
    readonly instructionDocument: PromptContentDocumentV1;
    readonly timeRange?: { readonly startSeconds: number; readonly endSeconds: number } | null;
  },
): PromptContentDocumentV1 {
  const reference = (input: LocalEditReference) => ({
    kind: "media_reference" as const,
    mentionId: crypto.randomUUID(),
    canvasNodeKey: input.key,
    target: input.target,
    displayNameSnapshot: input.name,
  });
  const items: PromptContentItem[] = [
    ...(previous?.items ?? []),
    { kind: "text", text: `${previous?.items.length ? "\n\n" : ""}视频编辑：以` },
    reference(source),
    { kind: "text", text: `为待编辑原视频。` },
    reference(frame),
    {
      kind: "text",
      text: `是该视频 ${edit.timeSeconds.toFixed(3)} 秒处的区域标注帧，彩色线条仅用于定位编辑对象。生效范围：${edit.timeRange ? `仅原视频第 ${edit.timeRange.startSeconds.toFixed(3)}–${edit.timeRange.endSeconds.toFixed(3)} 秒，其余时段保持不变` : "全片保持修改一致"}。请在原视频中跟随标记区域内的指定对象完成${edit.operation === "remove" ? "局部消除并自然补全背景" : "局部替换与编辑"}：`,
    },
  ];
  appendInstruction(items, edit.instructionDocument);
  appendText(
    items,
    "。保持区域外画面、主体动作、运镜、原视频时长和宽高比一致，不要把标记线或标注帧作为成片内容。",
  );
  return { schema: "prompt-content", version: 1, items };
}
