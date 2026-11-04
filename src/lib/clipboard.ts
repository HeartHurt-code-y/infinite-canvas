import { isDesktopRuntime } from "./ipc";
import { copyTextToDesktopClipboard } from "../features/workspace/desktopActions";
import { toMediaProxyUrl } from "./mediaProxy";

/*
 * 报错一键复制的剪贴板入口：ErrorCopyButton 与错误 toast 都走这里。
 *
 * 桌面端走 Tauri 系统剪贴板插件（可跨应用粘贴）；浏览器预览与组件测试
 * 退回 Web Clipboard API。两套都不可用时报错交给调用方决定如何呈现。
 */

/** 把一段文本写进系统剪贴板；桌面端与浏览器预览都能用。 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (isDesktopRuntime()) {
    await copyTextToDesktopClipboard(text);
  } else if (navigator.clipboard != null) {
    await navigator.clipboard.writeText(text);
  } else {
    throw new Error("当前环境不支持剪贴板写入。");
  }
}

/** Write image pixels, not the file path or preview URL, to the system clipboard. */
export async function copyImageToClipboard(source: {
  readonly localPath: string | null;
  readonly src: string | null;
}): Promise<void> {
  if (isDesktopRuntime() && source.localPath) {
    const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeImage(source.localPath);
    return;
  }
  if (!source.src) throw new Error("当前节点还没有可复制的图片。");
  if (!isDesktopRuntime() && (!navigator.clipboard?.write || typeof ClipboardItem === "undefined"))
    throw new Error("当前环境不支持图片复制。");
  const src = source.src;
  const png = (async () => {
    const response = await fetch(toMediaProxyUrl(src) ?? src);
    if (!response.ok) throw new Error(`读取图片失败（${response.status}）。`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法读取图片像素。");
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("图片转换失败。")), "image/png",
      ));
    } finally {
      bitmap.close();
    }
  })();
  if (isDesktopRuntime()) {
    const [{ writeImage }, blob] = await Promise.all([import("@tauri-apps/plugin-clipboard-manager"), png]);
    await writeImage(new Uint8Array(await blob.arrayBuffer()));
  } else {
    // Pass the promise immediately so browsers retain the user's click gesture.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }
}

/** 把一段报错文本写进系统剪贴板；桌面端与浏览器预览都能用。 */
export async function copyErrorTextToClipboard(text: string): Promise<void> {
  await copyTextToClipboard(text);
}

/** 摘要之外还有原始报错时一并复制：求助时完整 payload 才有用。 */
export function errorCopyText(summary: string, details?: string | null): string {
  return details ? `${summary}\n\n${details}` : summary;
}
