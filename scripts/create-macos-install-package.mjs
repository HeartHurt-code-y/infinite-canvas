// A native PKG installs the signed application and runs its embedded quarantine helper.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertComponentRoot, COMPONENT_REPO_ROOT } from "./runtime-component-catalog.mjs";
import {
  assertMacAppInventories,
  inventoryMacApp,
  verifyMacInstallerPackage,
} from "./verify-macos-edition.mjs";

const executeFile = promisify(execFile);
async function run(command, args) {
  return executeFile(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
}

export async function createMacInstallPackage({
  filename,
  appPath,
  applicationVersion,
  identifier,
  root = COMPONENT_REPO_ROOT,
  platform = process.platform,
  execute = run,
}) {
  if (platform !== "darwin") throw new Error("Installation PKG must be created on macOS");
  const appName = path.basename(appPath);
  if (appName !== "无限画布.app")
    throw new Error("Installation PKG application does not match its embedded postinstall");
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(applicationVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(identifier)
  )
    throw new Error("Installation PKG needs a valid version and application identifier");
  if (!filename.endsWith(".pkg"))
    throw new Error("Installation PKG output needs the .pkg extension");
  await assertComponentRoot(path.dirname(path.dirname(filename)), root);
  try {
    await mkdir(path.dirname(filename));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertComponentRoot(path.dirname(filename), root);
  await assertComponentRoot(appPath, root);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Installation PKG output must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const expected = await inventoryMacApp(appPath);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const temporary = await mkdtemp(path.join(path.dirname(filename), "embedded-package-"));
  try {
    const payload = path.join(temporary, "payload");
    const copiedApp = path.join(payload, "Applications", appName);
    await execute("/usr/bin/ditto", [appPath, copiedApp]);
    assertMacAppInventories(await inventoryMacApp(copiedApp), expected, "Installation PKG staging");
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", copiedApp]);
    const scripts = path.join(temporary, "scripts");
    await mkdir(scripts);
    for (const [sourceName, destination] of [
      ["install-macos.sh", "install-macos.sh"],
      ["install-macos-postinstall.sh", "postinstall"],
    ]) {
      const source = path.join(root, "scripts", sourceName);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`PKG helper must be a regular source file: ${sourceName}`);
      const bytes = await readFile(source);
      if (bytes.includes(13) || bytes.subarray(0, 2).toString() !== "#!")
        throw new Error(`PKG helper must be an LF-only shell script: ${sourceName}`);
      await copyFile(source, path.join(scripts, destination));
      await chmod(path.join(scripts, destination), 0o755);
    }
    // Existing installations must be replaced at /Applications, never relocated to another app copy.
    const componentPlist = path.join(temporary, "components.plist");
    await writeFile(
      componentPlist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>BundleIsRelocatable</key><false/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleIsVersionChecked</key><false/>
<key>BundleOverwriteAction</key><string>upgrade</string>
<key>RootRelativeBundlePath</key><string>Applications/无限画布.app</string>
</dict></array></plist>
`,
    );
    const staged = path.join(temporary, "installable.pkg");
    await execute("/usr/bin/pkgbuild", [
      "--root",
      payload,
      "--scripts",
      scripts,
      "--component-plist",
      componentPlist,
      "--identifier",
      `${identifier}.online-installer`,
      "--version",
      applicationVersion,
      "--install-location",
      "/",
      "--ownership",
      "recommended",
      staged,
    ]);
    await verifyMacInstallerPackage(staged, appName, expected, {
      applicationVersion,
      identifier,
      sourceRoot: root,
      platform,
      execute,
    });
    await rename(staged, filename);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
