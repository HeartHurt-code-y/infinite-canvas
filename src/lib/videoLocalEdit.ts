import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import {
  frontendLog,
  isDesktopRuntime,
  toMediaSrc,
  type ExplicitMediaTarget,
  type MediaReferenceTarget,
} from "./backend";
import type { PromptContentDocumentV1 } from "./promptContent";

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

interface LocalEditReference {
  readonly key: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
}

/** Stable references keep the selected video unambiguous even when other inputs are reordered. */
export function appendVideoLocalEditPrompt(
  previous: PromptContentDocumentV1 | undefined,
  source: LocalEditReference,
  frame: LocalEditReference,
  edit: {
    readonly timeSeconds: number;
    readonly operation: "remove" | "replace";
    readonly instruction: string;
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
  return {
    schema: "prompt-content",
    version: 1,
    items: [
      ...(previous?.items ?? []),
      { kind: "text", text: `${previous?.items.length ? "\n\n" : ""}视频编辑：以` },
      reference(source),
      { kind: "text", text: `为待编辑原视频。` },
      reference(frame),
      {
        kind: "text",
        text: `是该视频 ${edit.timeSeconds.toFixed(3)} 秒处的区域标注帧，彩色线条仅用于定位编辑对象。生效范围：${edit.timeRange ? `仅原视频第 ${edit.timeRange.startSeconds.toFixed(3)}–${edit.timeRange.endSeconds.toFixed(3)} 秒，其余时段保持不变` : "全片保持修改一致"}。请在原视频中跟随标记区域内的指定对象完成${edit.operation === "remove" ? "局部消除并自然补全背景" : "局部替换与编辑"}：${edit.instruction.trim()}。保持区域外画面、主体动作、运镜、原视频时长和宽高比一致，不要把标记线或标注帧作为成片内容。`,
      },
    ],
  };
}
