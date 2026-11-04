import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { localBase64AssetClient } from "../../lib/backend";
import type { DirectorMediaCapture } from "./CanvasDirectorEditor";

export async function importDirectorMedia(media: readonly DirectorMediaCapture[], signal: AbortSignal) {
  const directory = await join(await appDataDir(), "canvas-derived-images");
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const capture of media) {
    signal.throwIfAborted();
    if (!capture.blob.size) throw new Error("导演台导出的文件为空。");
    const extension = capture.kind === "image" ? ".png" : ".webm";
    const path = await join(directory, crypto.randomUUID() + extension);
    try {
      await writeFile(path, new Uint8Array(await capture.blob.arrayBuffer()));
      signal.throwIfAborted();
      const record = await localBase64AssetClient.importAsset({ localPath: path, name: capture.name + extension });
      records.push({ capture, record });
    } finally {
      await remove(path).catch(() => {});
    }
  }
  return records;
}
