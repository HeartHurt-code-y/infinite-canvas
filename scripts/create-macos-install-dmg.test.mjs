import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMacInstallDmg } from "./create-macos-install-dmg.mjs";
import { inventoryMacApp, verifyMacDmgInstallHelpers } from "./verify-macos-edition.mjs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test("a Mac installation DMG cannot be silently generated on another platform", async () => {
  await assert.rejects(
    createMacInstallDmg({ filename: "app.dmg", appPath: "app.app", platform: "win32" }),
    /must be created on macOS/,
  );
});

test(
  "rebuilding a DMG preserves signed app bytes and embeds same-source executable helpers",
  {
    skip:
      process.platform === "win32"
        ? "Native Unix executable modes and Applications symlink"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ic-dmg-install-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const appPath = path.join(root, "bundle/无限画布.app");
    await mkdir(path.join(appPath, "Contents/MacOS"), { recursive: true });
    await writeFile(
      path.join(appPath, "Contents/MacOS/infinite-canvas"),
      "signed immutable fixture",
    );
    await mkdir(path.join(root, "scripts"));
    for (const name of ["install-macos.command", "install-macos.sh"])
      await cp(path.join(sourceRoot, "scripts", name), path.join(root, "scripts", name));
    const filename = path.join(root, "bundle/application.dmg");
    await writeFile(filename, "original Tauri DMG");
    const expected = await inventoryMacApp(appPath);
    const calls = [];
    const options = {
      filename,
      appPath,
      root,
      platform: "darwin",
      execute: async (command, args) => {
        calls.push([command, args]);
        if (command.endsWith("ditto")) await cp(args[0], args[1], { recursive: true });
        if (command.endsWith("hdiutil") && args[0] === "create") {
          const contents = args[args.indexOf("-srcfolder") + 1];
          assert.equal(await verifyMacDmgInstallHelpers(contents, root), true);
          assert.deepEqual(await inventoryMacApp(path.join(contents, "无限画布.app")), expected);
          await writeFile(args.at(-1), "new self-contained DMG");
        }
      },
    };
    await createMacInstallDmg(options);
    assert.equal(await readFile(filename, "utf8"), "new self-contained DMG");
    assert.deepEqual(await inventoryMacApp(appPath), expected);
    assert.equal(calls.filter(([command]) => command.endsWith("codesign")).length, 2);
    await assert.rejects(
      createMacInstallDmg({
        ...options,
        execute: async (command, args) => {
          if (command.endsWith("ditto")) await cp(args[0], args[1], { recursive: true });
          if (command.endsWith("hdiutil")) throw new Error("failed new DMG build");
        },
      }),
      /failed new DMG build/,
    );
    assert.equal(
      await readFile(filename, "utf8"),
      "new self-contained DMG",
      "a failed replacement preserves the last verified image",
    );
  },
);
