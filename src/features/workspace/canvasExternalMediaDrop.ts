import { inferMediaKindFromName } from "../../lib/backend";

/** Tauri reports drag positions in physical pixels; DOM hit tests use CSS pixels. */
export function nativeDropClientPoint(
  position: { readonly x: number; readonly y: number },
  scaleFactor: number,
): { x: number; y: number } {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return { x: position.x / scale, y: position.y / scale };
}

/** Keep the OS-provided order and let the existing import path verify file contents. */
export function classifyExternalMediaPaths(paths: readonly string[]): {
  mediaPaths: string[];
  skippedCount: number;
} {
  const mediaPaths: string[] = [];
  let skippedCount = 0;
  for (const path of paths) {
    // Native Windows paths may contain "#" in a file name; the shared URL-aware
    // classifier treats it as a fragment delimiter unless escaped for classification.
    if (inferMediaKindFromName(path.replaceAll("#", "%23")) != null) mediaPaths.push(path);
    else skippedCount += 1;
  }
  return { mediaPaths, skippedCount };
}
