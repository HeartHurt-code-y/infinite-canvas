// Explicit editions use separate Cargo/bundle directories; the legacy full build stays intact.
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentPlatform,
  assertComponentRoot,
  COMPONENT_REPO_ROOT,
  COMPONENT_PLATFORM,
  componentBytesSha256,
  componentFileSha256,
  RUNTIME_COMPONENTS,
} from "./runtime-component-catalog.mjs";
import { buildLatestManifest } from "./write-latest-json.mjs";
import { tosUpdatesPublicBaseUrl, tosUpdatesObjectKey } from "./tos-updates-config.mjs";
import {
  assertEditionSourcesUnchanged,
  collectEditionSourceFingerprint,
  createEditionBuildSource,
} from "./edition-source-fingerprint.mjs";

export function editionArtifactBasename(filename, edition) {
  if (/\.(exe|exe\.sig)$/i.test(filename))
    return filename.replace(/-setup(\.exe(?:\.sig)?)$/i, `-${edition}-setup$1`);
  return filename.replace(/(\.msi(?:\.sig)?)$/i, `-${edition}$1`);
}

export function editionBuildPlan(
  edition,
  passthrough = [],
  {
    root = COMPONENT_REPO_ROOT,
    platform = process.platform,
    arch = process.arch,
    environment = process.env,
  } = {},
) {
  if (edition !== "online" && edition !== "offline")
    throw new Error("Distribution edition must be online or offline");
  assertComponentPlatform(platform, arch, environment.TAURI_ENV_TARGET_TRIPLE);
  if (environment.CARGO_BUILD_TARGET)
    assertComponentPlatform(platform, arch, environment.CARGO_BUILD_TARGET);
  if (
    passthrough.some(
      (argument) =>
        argument === "--config" ||
        argument === "-c" ||
        argument.startsWith("--config=") ||
        argument === "--target-dir",
    )
  )
    throw new Error(
      "Edition resources/output are fixed; arbitrary config or target-dir overrides are not supported",
    );
  passthrough = passthrough.map((argument) =>
    argument === "-t"
      ? "--target"
      : argument === "-b"
        ? "--bundles"
        : argument === "-d"
          ? "--debug"
          : argument,
  );
  const targetAt = passthrough.indexOf("--target");
  const target =
    targetAt < 0
      ? passthrough.find((argument) => argument.startsWith("--target="))?.slice(9)
      : passthrough[targetAt + 1];
  if (target) assertComponentPlatform(platform, arch, target);
  const targetDirectory = path.join(root, ".cache/tauri-editions", edition, "target");
  const generatedConfigPath = path.join(
    root,
    ".cache/tauri-editions",
    edition,
    "tauri-edition.generated.json",
  );
  return {
    edition,
    targetDirectory,
    generatedConfigPath,
    env: { ...environment, CARGO_TARGET_DIR: targetDirectory, IC_DISTRIBUTION_EDITION: edition },
    args: [
      path.join(root, "scripts/tauri-build.mjs"),
      "--config",
      generatedConfigPath,
      ...passthrough,
    ],
  };
}

export async function writeEditionOverrideConfig(plan, root = COMPONENT_REPO_ROOT) {
  const base = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const edition = JSON.parse(
    await readFile(path.join(root, `src-tauri/tauri.${plan.edition}.conf.json`), "utf8"),
  );
  const selected = edition.bundle?.resources;
  if (
    !selected ||
    typeof selected !== "object" ||
    Array.isArray(selected) ||
    Object.values(selected).some((value) => typeof value !== "string")
  )
    throw new Error("Edition resources must be an exact source-to-destination object map");
  const inherited = base.bundle?.resources;
  if (inherited !== undefined && (!inherited || typeof inherited !== "object"))
    throw new Error("Base resources must be an object map or an array");
  // Tauri combines override files before patching its base config. Keep the
  // deletions and selected map together in one RFC 7396 merge patch so the
  // original large resources cannot survive that final base merge.
  const tombstones =
    inherited && !Array.isArray(inherited)
      ? Object.fromEntries(Object.keys(inherited).map((key) => [key, null]))
      : {};
  const generated = {
    ...edition,
    bundle: { ...edition.bundle, resources: { ...tombstones, ...selected } },
  };
  await mkdir(path.dirname(plan.generatedConfigPath), { recursive: true });
  await assertComponentRoot(path.dirname(plan.generatedConfigPath), root);
  try {
    const info = await lstat(plan.generatedConfigPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Generated edition config must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${plan.generatedConfigPath}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(generated, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, plan.generatedConfigPath);
  return generated;
}

export async function writeEditionTargetMarker(
  plan,
  applicationVersion,
  root = COMPONENT_REPO_ROOT,
) {
  await mkdir(plan.targetDirectory, { recursive: true });
  await assertComponentRoot(plan.targetDirectory, root);
  const markerPath = path.join(plan.targetDirectory, "distribution.json");
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Distribution marker must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    markerPath,
    JSON.stringify(
      { schemaVersion: 1, applicationVersion, edition: plan.edition, platform: "windows-x86_64" },
      null,
      2,
    ) + "\n",
  );
}

export async function archiveEditionBundles(
  plan,
  { applicationVersion, root = COMPONENT_REPO_ROOT, sourceSnapshot } = {},
) {
  const output = path.join(
    root,
    ".cache/tauri-editions",
    plan.edition,
    "artifacts",
    applicationVersion,
  );
  const artifacts = [];
  async function visit(directory, prefix = "") {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names.sort()) {
      const from = path.join(directory, name);
      const info = await lstat(from);
      if (info.isSymbolicLink())
        throw new Error(`Edition artifacts must be regular files: ${from}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) await visit(from, relative);
      else if (info.isFile()) {
        const stagedRelative = prefix
          ? `${prefix}/${editionArtifactBasename(name, plan.edition)}`
          : editionArtifactBasename(name, plan.edition);
        const to = path.join(output, stagedRelative);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
        artifacts.push({
          path: stagedRelative,
          size: info.size,
          sha256: await componentFileSha256(to),
        });
      }
    }
  }
  const profile = plan.args.includes("--debug") ? "debug" : "release";
  const targetAt = plan.args.indexOf("--target");
  const target =
    targetAt < 0
      ? plan.args.find((argument) => argument.startsWith("--target="))?.slice(9)
      : plan.args[targetAt + 1];
  await visit(path.join(plan.targetDirectory, ...(target ? [target] : []), profile, "bundle"));
  if (artifacts.length) {
    const catalogPath = path.join(root, "src-tauri/resources/component-catalog.json");
    const catalogSha256 = await componentFileSha256(catalogPath);
    if (plan.edition === "offline")
      artifacts.push(
        ...(await stageOfflineComponents({ output, root, applicationVersion, catalogSha256 })),
      );
    await writeFile(
      path.join(output, "distribution.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          applicationVersion,
          edition: plan.edition,
          platform: "windows-x86_64",
          catalogSha256,
          artifacts,
        },
        null,
        2,
      ) + "\n",
    );
    if (plan.edition === "online")
      await writeOnlineEditionReleasePlan({
        output,
        root,
        applicationVersion,
        catalogSha256,
        artifacts,
      });
    if (sourceSnapshot) {
      if (
        sourceSnapshot.applicationVersion !== applicationVersion ||
        sourceSnapshot.edition !== plan.edition
      )
        throw new Error("Build source snapshot does not match the archived edition/version");
      const executablePath = path.join(
        plan.targetDirectory,
        ...(target ? [target] : []),
        profile,
        "infinite-canvas.exe",
      );
      const record = await createEditionBuildSource({
        snapshot: sourceSnapshot,
        executablePath,
        root,
      });
      const recordPath = path.join(output, "build-source.json");
      await assertComponentRoot(output, root);
      try {
        const info = await lstat(recordPath);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Build source record must be a regular file");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = `${recordPath}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      await rename(temporary, recordPath);
    }
    console.log(`[tauri:${plan.edition}] ${artifacts.length} edition artifacts → ${output}`);
  }
  return artifacts;
}

export async function stageOfflineComponents({
  output,
  root = COMPONENT_REPO_ROOT,
  applicationVersion,
  catalogSha256,
}) {
  const catalogPath = path.join(root, "src-tauri/resources/component-catalog.json");
  if ((await componentFileSha256(catalogPath)) !== catalogSha256)
    throw new Error("Offline suite catalog changed before staging");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.applicationVersion !== applicationVersion ||
    catalog.platform !== COMPONENT_PLATFORM
  )
    throw new Error("Offline suite catalog identity does not match this edition");
  await mkdir(path.join(output, "components"), { recursive: true });
  await assertComponentRoot(path.join(output, "components"), root);
  const components = [];
  const artifacts = [];
  for (const id of ["ai-media-runtime", "ai-media-quality-runtime"]) {
    const definition = RUNTIME_COMPONENTS.find((component) => component.id === id);
    const matches = catalog.components.filter((component) => component.id === id);
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].archive?.sha256))
      throw new Error(`Offline suite needs exactly one trusted archive: ${id}`);
    const component = matches[0];
    const source = path.join(
      root,
      ".cache/runtime-components/packages",
      `${component.archive.sha256}.zip`,
    );
    await assertComponentRoot(path.dirname(source), root);
    const sourceInfo = await lstat(source);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.isSymbolicLink() ||
      sourceInfo.size !== component.archive.size ||
      (await componentFileSha256(source)) !== component.archive.sha256
    )
      throw new Error(`Offline suite archive checksum mismatch: ${id}`);
    const nativePath = path.join(root, definition.sourcePath, definition.manifestPath);
    await assertComponentRoot(path.dirname(nativePath), root);
    if (!(await lstat(nativePath)).isFile() || (await lstat(nativePath)).isSymbolicLink())
      throw new Error(`Offline suite native manifest is not a regular file: ${id}`);
    const nativeBytes = await readFile(nativePath);
    if (componentBytesSha256(nativeBytes) !== component.manifestSha256)
      throw new Error(`Offline suite native manifest checksum mismatch: ${id}`);
    const relative = `components/${id}-${component.archive.sha256}.zip`;
    const destination = path.join(output, relative);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Offline suite ZIP destination must be a regular file");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await copyFile(source, destination);
    if ((await componentFileSha256(destination)) !== component.archive.sha256)
      throw new Error(`Offline suite staged archive checksum mismatch: ${id}`);
    artifacts.push({
      path: relative,
      size: component.archive.size,
      sha256: component.archive.sha256,
    });
    components.push({
      id,
      path: relative,
      size: component.archive.size,
      sha256: component.archive.sha256,
      manifestPath: component.manifestPath,
      manifestSha256: component.manifestSha256,
      nativeManifestBase64: nativeBytes.toString("base64"),
    });
  }
  const receiptPath = path.join(output, "offline-components.json");
  try {
    const info = await lstat(receiptPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Offline suite receipt must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        applicationVersion,
        edition: "offline",
        platform: COMPONENT_PLATFORM,
        catalogSha256,
        components,
      },
      null,
      2,
    ) + "\n",
  );
  return artifacts;
}

export async function writeOnlineEditionReleasePlan({
  output,
  root = COMPONENT_REPO_ROOT,
  applicationVersion,
  catalogSha256,
  artifacts,
}) {
  const installers = artifacts.filter((artifact) => /_x64-online-setup\.exe$/.test(artifact.path));
  if (installers.length > 1) throw new Error("Online edition output has multiple NSIS installers");
  const installer = installers[0];
  const signed =
    installer && artifacts.some((artifact) => artifact.path === `${installer.path}.sig`);
  const channel = "windows-x86_64-online";
  const baseUrl = `${tosUpdatesPublicBaseUrl()}/${channel}`;
  let feed = null;
  if (signed) {
    const signature = (await readFile(path.join(output, `${installer.path}.sig`), "utf8")).trim();
    if (!signature) throw new Error("Online updater signature is empty");
    const latest = buildLatestManifest({
      version: applicationVersion,
      notes: "轻量联网版：需要时可安装对应功能组件，也支持离线组件包。",
      pubDate: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          url: `${baseUrl}/${encodeURIComponent(path.basename(installer.path))}`,
          signature,
        },
      },
    });
    await writeFile(path.join(output, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
    feed = {
      localPath: path.join(output, "latest.json"),
      objectKey: tosUpdatesObjectKey(`${channel}/latest.json`),
      url: `${baseUrl}/latest.json`,
    };
  }
  const catalog = JSON.parse(
    await readFile(path.join(root, "src-tauri/resources/component-catalog.json"), "utf8"),
  );
  await writeFile(
    path.join(output, "publish-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        edition: "online",
        applicationVersion,
        platform: "windows-x86_64",
        channel,
        catalogSha256,
        feed,
        artifacts: artifacts.map((artifact) => ({
          ...artifact,
          localPath: path.join(output, artifact.path),
          objectKey: tosUpdatesObjectKey(`${channel}/${path.basename(artifact.path)}`),
          url: `${baseUrl}/${encodeURIComponent(path.basename(artifact.path))}`,
        })),
        componentArchives: catalog.components.map((component) => ({
          id: component.id,
          localPath: path.join(
            root,
            ".cache/runtime-components/packages",
            `${component.archive.sha256}.zip`,
          ),
          ...component.archive,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

export async function buildTauriEdition(edition, passthrough = [], options = {}) {
  const root = options.root ?? COMPONENT_REPO_ROOT;
  const plan = editionBuildPlan(edition, passthrough, options);
  const applicationVersion = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  await writeEditionOverrideConfig(plan, root);
  await writeEditionTargetMarker(plan, applicationVersion, root);
  const sourceBefore = await collectEditionSourceFingerprint({ root, edition });
  if (sourceBefore.applicationVersion !== applicationVersion)
    throw new Error("Application version changed before the edition build started");
  console.log(`[tauri:${edition}] isolated native/bundle output → ${plan.targetDirectory}`);
  const runBuild =
    options.runBuild ??
    (() =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, plan.args, {
          cwd: root,
          env: plan.env,
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (value) => resolve(value ?? 1));
      }));
  const code = await runBuild(plan);
  if (code !== 0) throw new Error(`Tauri ${edition} build failed (${code})`);
  const sourceAfter = await collectEditionSourceFingerprint({ root, edition });
  assertEditionSourcesUnchanged(sourceBefore, sourceAfter);
  if (!passthrough.includes("--no-bundle"))
    await archiveEditionBundles(plan, { applicationVersion, root, sourceSnapshot: sourceBefore });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTauriEdition(process.argv[2], process.argv.slice(3)).catch((error) => {
    console.error(`[tauri-edition] ${error.message}`);
    process.exitCode = 1;
  });
}
