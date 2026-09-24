import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function verifyNsisRemotionResourceTable(script, inventory) {
  const files = [...script.matchAll(/File \/a "\/oname=remotion-runtime\\([^"]+)"/g)].map((match) =>
    match[1].replaceAll("\\", "/"),
  );
  const actual = new Set(files);
  const expected = new Set([
    ...inventory.map((entry) => entry.path),
    "files-manifest.json",
    "runtime-manifest.json",
  ]);
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length || extra.length || actual.size !== files.length) {
    throw new Error(
      `NSIS Remotion 文件表与完整逻辑清单不符：缺 ${missing.length}、多 ${extra.length}、重复 ${files.length - actual.size}；样例 ${missing.slice(0, 3).join(", ")}`,
    );
  }
  return actual.size;
}

export function verifyGeneratedNsisRemotionResources(root = ROOT) {
  const script = readFileSync(
    path.join(root, "src-tauri", "target", "release", "nsis", "x64", "installer.nsi"),
    "utf8",
  );
  const inventory = JSON.parse(
    readFileSync(
      path.join(root, "src-tauri", "resources", "remotion-runtime", "files-manifest.json"),
      "utf8",
    ),
  );
  return verifyNsisRemotionResourceTable(script, inventory);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const count = verifyGeneratedNsisRemotionResources();
    console.log(`[nsis-resources] Remotion ${count} 个文件与完整清单一致`);
  } catch (error) {
    console.error(`[nsis-resources] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
