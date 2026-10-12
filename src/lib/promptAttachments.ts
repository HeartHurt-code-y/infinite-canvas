import type { PromptContentAttachmentItem } from "./promptContent";

/**
 * 提示词编辑器附件摄取的唯一实现：扩展名口径、媒体类型判定与
 * 「暂存 → 本地素材导入 → 临时文件清理」都在这里，视图层只负责接线与报错展示。
 *
 * 附件不挂在画布节点上：摄取成功即落入本地 Base64 素材库，
 * 提交生成请求时随显式媒体输入发出（见 promptContent 的 attachment 条目）。
 */

/** 附件当前支持的媒体扩展名；文档类待生成通道支持文档 target 后放开。 */
const PROMPT_ATTACHMENT_MEDIA_EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
  video: ["mp4", "mov", "webm", "mkv"],
  audio: ["mp3", "wav", "m4a", "flac", "ogg"],
} as const;

type PromptAttachmentMediaType = keyof typeof PROMPT_ATTACHMENT_MEDIA_EXTENSIONS;

/** 文件选择器的 accept 口径；与扩展名表同源，不会各自漂移。 */
export const PROMPT_ATTACHMENT_ACCEPT = Object.values(PROMPT_ATTACHMENT_MEDIA_EXTENSIONS)
  .flat()
  .map((extension) => `.${extension}`)
  .join(",");

/** 按文件名判定媒体类型；不支持的扩展名（含文档）返回 null，由调用方决定如何提示。 */
export function promptAttachmentMediaType(fileName: string): PromptAttachmentMediaType | null {
  const lower = fileName.toLowerCase();
  for (const [mediaType, extensions] of Object.entries(PROMPT_ATTACHMENT_MEDIA_EXTENSIONS)) {
    if (extensions.some((extension) => lower.endsWith(`.${extension}`))) {
      return mediaType as PromptAttachmentMediaType;
    }
  }
  return null;
}

export interface PromptAttachmentIngestReport {
  /** 摄取成功、可插入编辑器的附件。 */
  readonly attachments: readonly PromptContentAttachmentItem[];
  /** 扩展名不支持而被忽略的文件名。 */
  readonly skipped: readonly string[];
  /** 摄取失败的文件名；对应临时文件已清理，其余文件不受影响。 */
  readonly failed: readonly string[];
}

/** 摄取依赖的磁盘与素材库操作；测试注入假实现，不必触碰 Tauri。 */
export interface PromptAttachmentIngestDeps {
  /** 把文件字节写到可被素材导入读取的本机路径，返回该路径。 */
  readonly saveTempFile: (fileName: string, bytes: Uint8Array) => Promise<string>;
  /** 导入成本地 Base64 素材，返回素材记录。 */
  readonly importLocalAsset: (command: {
    readonly localPath: string;
    readonly name: string;
  }) => Promise<{ readonly id: string }>;
  /** 删除暂存文件；无论导入成败都会调用。 */
  readonly deleteFile: (path: string) => Promise<void>;
}

/**
 * 逐个文件摄取，单个文件失败不吞掉其余结果：成功的照常返回，
 * 失败的记入 failed 由界面给出补救指引。临时文件在导入尝试后必定清理。
 */
export async function ingestPromptAttachments(
  files: readonly File[],
  deps: PromptAttachmentIngestDeps,
): Promise<PromptAttachmentIngestReport> {
  const attachments: PromptContentAttachmentItem[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const mediaType = promptAttachmentMediaType(file.name);
    if (mediaType == null) {
      skipped.push(file.name);
      continue;
    }
    let tempPath: string | null = null;
    try {
      tempPath = await deps.saveTempFile(file.name, new Uint8Array(await file.arrayBuffer()));
      const record = await deps.importLocalAsset({ localPath: tempPath, name: file.name });
      attachments.push({
        kind: "attachment",
        attachmentId: globalThis.crypto.randomUUID(),
        target: { kind: "local_base64_asset", assetId: record.id, mediaType },
        name: file.name,
        mediaType,
      });
    } catch {
      failed.push(file.name);
    } finally {
      if (tempPath != null) await deps.deleteFile(tempPath).catch(() => {});
    }
  }
  return { attachments, skipped, failed };
}
