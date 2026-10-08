import { readFileSync } from "node:fs";
import path from "node:path";
import { COMPONENT_REPO_ROOT, inventoryComponentFiles } from "./runtime-component-catalog.mjs";

export function verifyNsisEditionResourceTable(script, expected, edition) {
  const actual = [...script.matchAll(/File \/a "\/oname=([^"]+)"/g)].map((match) =>
    match[1].replaceAll("\\", "/"),
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    actualSet.size !== actual.length ||
    expectedSet.size !== expected.length ||
    actualSet.size !== expectedSet.size ||
    actual.some((entry) => !expectedSet.has(entry))
  )
    throw new Error(
      `${edition} NSIS resource table does not match its exact edition map (expected ${expectedSet.size}, actual ${actualSet.size})`,
    );
  return actual.length;
}

export async function verifyGeneratedNsisEditionResources({
  root = COMPONENT_REPO_ROOT,
  edition,
  targetDirectory,
  target,
  profile = "release",
}) {
  const config = JSON.parse(
    readFileSync(path.join(root, `src-tauri/tauri.${edition}.conf.json`), "utf8"),
  );
  const expected = [];
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    if (source.endsWith("/")) {
      for (const entry of await inventoryComponentFiles(path.join(root, "src-tauri", source), {
        workspaceRoot: root,
      }))
        expected.push(`${destination}${entry.path}`);
    } else expected.push(destination);
  }
  const script = readFileSync(
    path.join(targetDirectory, ...(target ? [target] : []), profile, "nsis/x64/installer.nsi"),
    "utf8",
  );
  return verifyNsisEditionResourceTable(script, expected, edition);
}
