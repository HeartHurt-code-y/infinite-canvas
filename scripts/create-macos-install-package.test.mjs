import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMacInstallPackage } from "./create-macos-install-package.mjs";
import { inventoryMacApp, verifyMacInstallerPackage } from "./verify-macos-edition.mjs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, "bundle/macos/无限画布.app");
  await mkdir(path.join(appPath, "Contents/MacOS"), { recursive: true });
  await writeFile(path.join(appPath, "Contents/MacOS/infinite-canvas"), "unchanged signed fixture");
  await mkdir(path.join(root, "scripts"));
  for (const name of ["install-macos.sh", "install-macos-postinstall.sh"])
    await cp(path.join(sourceRoot, "scripts", name), path.join(root, "scripts", name));
  const options = {
    filename: path.join(root, "bundle/pkg/application.pkg"),
    appPath,
    applicationVersion: "0.2.3",
    identifier: "com.infinitecanvas.desktop",
    root,
    platform: "darwin",
  };
  return { root, appPath, options };
}

test("native PKG preparation confines output, preserves signed payload and embeds the installation scripts", async (t) => {
  const f = await fixture(t);
  const before = await inventoryMacApp(f.appPath);
  const calls = [];
  await assert.rejects(
    createMacInstallPackage({
      ...f.options,
      execute: async (command, args) => {
        calls.push([command, args]);
        if (command.endsWith("ditto")) {
          await cp(args[0], args[1], { recursive: true });
        } else if (command.endsWith("codesign")) {
          assert.deepEqual(args.slice(0, 3), ["--verify", "--deep", "--strict"]);
        } else if (command.endsWith("pkgbuild")) {
          const value = (name) => args[args.indexOf(name) + 1];
          assert.equal(value("--identifier"), "com.infinitecanvas.desktop.online-installer");
          assert.equal(value("--version"), "0.2.3");
          assert.equal(value("--install-location"), "/");
          assert.ok(!args.includes("--sign"));
          assert.match(
            await readFile(value("--component-plist"), "utf8"),
            /BundleIsRelocatable<\/key><false\/>/,
          );
          for (const [name, source] of [
            ["postinstall", "install-macos-postinstall.sh"],
            ["install-macos.sh", "install-macos.sh"],
          ])
            assert.deepEqual(
              await readFile(path.join(value("--scripts"), name)),
              await readFile(path.join(f.root, "scripts", source)),
            );
          throw new Error("fixture stops before native package verification");
        } else assert.fail(`unexpected command ${command}`);
      },
    }),
    /fixture stops before native package verification/,
  );
  assert.deepEqual(await inventoryMacApp(f.appPath), before);
  assert.equal(calls.filter(([command]) => command.endsWith("codesign")).length, 2);
  await assert.rejects(readFile(f.options.filename), /ENOENT/);
});

test("PKG creation refuses other operating systems, unsupported app names and output outside the repository", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createMacInstallPackage({ ...f.options, platform: "win32" }),
    /must be created on macOS/,
  );
  await assert.rejects(
    createMacInstallPackage({ ...f.options, appPath: path.join(f.root, "Other.app") }),
    /does not match/,
  );
  await assert.rejects(
    createMacInstallPackage({
      ...f.options,
      filename: path.join(f.root, "../outside-output/test.pkg"),
    }),
    /outside workspace/,
  );
});

test(
  "expanded PKG verifies identity, exact signed payload and source scripts",
  { skip: process.platform === "win32" ? "Unix executable modes require a native host" : false },
  async (t) => {
    const f = await fixture(t);
    const packageFile = path.join(f.root, "fixture.pkg");
    await writeFile(packageFile, "flat package fixture");
    let mutation = "";
    const execute = async (command, args) => {
      if (command.endsWith("pkgutil")) {
        const expanded = args.at(-1);
        await mkdir(path.join(expanded, "Scripts"), { recursive: true });
        await cp(f.appPath, path.join(expanded, "Payload/Applications/无限画布.app"), {
          recursive: true,
        });
        await writeFile(
          path.join(expanded, "PackageInfo"),
          `<pkg-info identifier="com.infinitecanvas.desktop.online-installer" version="${mutation === "version" ? "0.2.2" : "0.2.3"}" install-location="/"><scripts><postinstall file="./postinstall"/></scripts></pkg-info>`,
        );
        const { chmod } = await import("node:fs/promises");
        for (const [name, source] of [
          ["postinstall", "install-macos-postinstall.sh"],
          ["install-macos.sh", "install-macos.sh"],
        ]) {
          const destination = path.join(expanded, "Scripts", name);
          await cp(path.join(f.root, "scripts", source), destination);
          await chmod(destination, 0o755);
        }
        if (mutation === "postinstall")
          await writeFile(path.join(expanded, "Scripts/postinstall"), "changed script");
        if (mutation === "payload")
          await writeFile(
            path.join(expanded, "Payload/Applications/无限画布.app/Contents/MacOS/infinite-canvas"),
            "tampered payload",
          );
      } else assert.ok(command.endsWith("codesign"));
    };
    const options = { ...f.options, sourceRoot: f.root, execute };
    const expected = await inventoryMacApp(f.appPath);
    assert.deepEqual(
      await verifyMacInstallerPackage(packageFile, "无限画布.app", expected, options),
      {
        pkgVerified: true,
        applicationBytesVerified: true,
        codeSignatureVerified: true,
        postinstallVerified: true,
        packageIdentifier: "com.infinitecanvas.desktop.online-installer",
        packageVersion: "0.2.3",
      },
    );
    for (const [value, error] of [
      ["version", /identity\/version/],
      ["postinstall", /script differs/],
      ["payload", /PKG payload/],
    ]) {
      mutation = value;
      await assert.rejects(
        verifyMacInstallerPackage(packageFile, "无限画布.app", expected, options),
        error,
      );
    }
  },
);
