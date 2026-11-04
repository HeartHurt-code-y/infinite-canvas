// Keep the signed application untouched and put the first-install entry in the DMG itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, copyFile, lstat, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { assertComponentRoot, COMPONENT_REPO_ROOT } from "./runtime-resources.mjs";
import { assertMacAppInventories, inventoryMacApp } from "./verify-macos-edition.mjs";

const executeFile = promisify(execFile);
export const MAC_INSTALL_HELPERS = ["install-macos.command", "install-macos.sh"];
async function run(command, args) {
  return executeFile(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
}

export async function createMacInstallDmg({
  filename,
  appPath,
  root = COMPONENT_REPO_ROOT,
  platform = process.platform,
  execute = run,
}) {
  if (platform !== "darwin") throw new Error("Installation DMG must be created on macOS");
  const appName = path.basename(appPath);
  if (!appName.endsWith(".app")) throw new Error("Installation DMG needs a signed application");
  await assertComponentRoot(path.dirname(filename), root);
  await assertComponentRoot(appPath, root);
  const originalDmg = await lstat(filename);
  if (!originalDmg.isFile() || originalDmg.isSymbolicLink())
    throw new Error("Installation DMG output must replace a regular Tauri DMG");
  const expected = await inventoryMacApp(appPath);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const temporary = await mkdtemp(path.join(path.dirname(filename), "embedded-install-"));
  try {
    const contents = path.join(temporary, "contents");
    const copiedApp = path.join(contents, appName);
    await execute("/usr/bin/ditto", [appPath, copiedApp]);
    assertMacAppInventories(await inventoryMacApp(copiedApp), expected, "Installation DMG staging");
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", copiedApp]);
    for (const name of MAC_INSTALL_HELPERS) {
      const source = path.join(root, "scripts", name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Installation helper must be a regular project file: ${name}`);
      const bytes = await readFile(source);
      if (bytes.includes(13) || bytes.subarray(0, 2).toString() !== "#!")
        throw new Error(`Installation helper must be an LF-only shell script: ${name}`);
      await copyFile(source, path.join(contents, name));
      await chmod(path.join(contents, name), 0o755);
    }
    await symlink("/Applications", path.join(contents, "Applications"));
    const stagedDmg = path.join(temporary, "installable.dmg");
    const createArguments = [
      "create",
      "-volname",
      appName.slice(0, -4),
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-srcfolder",
      contents,
      stagedDmg,
    ];
    // DiskImages can briefly retain a device after Tauri creates its first DMG.
    // Retry only the reported busy condition; keep other failures actionable.
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await execute("/usr/bin/hdiutil", createArguments);
        break;
      } catch (error) {
        const diagnostic = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
        if (attempt === maxAttempts || !/resource busy/i.test(diagnostic)) throw error;
        console.warn(`[macos-dmg] DiskImages is busy; retrying creation (${attempt + 1}/${maxAttempts}).`);
        // This file is inside our private staging directory, never the original DMG.
        await rm(stagedDmg, { force: true });
        await delay(attempt * 2000);
      }
    }
    await execute("/usr/bin/hdiutil", ["verify", stagedDmg]);
    await rename(stagedDmg, filename);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
