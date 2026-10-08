import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComponentPlatform,
  buildRuntimeComponentCatalog,
  COMPONENT_CATALOG_RESOURCE,
  COMPONENT_REPO_ROOT,
  componentBytesSha256,
  componentFileSha256,
  componentPlatform,
  describeRuntimeComponent,
  RUNTIME_COMPONENTS,
  runtimeComponentArchiveUrl,
  validateMacRuntimeComponent,
} from "./runtime-component-catalog.mjs";

const ZIP_HELPER = fileURLToPath(new URL("./runtime-component-zip.py", import.meta.url));
export const COMPONENT_ZIP_RECIPE = "native-files-symlinks-deflate6-1980-v2";

export function componentArchiveCacheKey(component, helperSha256) {
  return componentBytesSha256(
    JSON.stringify({ recipe: COMPONENT_ZIP_RECIPE, helperSha256, files: component.files }),
  );
}

export function resolveComponentPython(
  root = COMPONENT_REPO_ROOT,
  environment = process.env,
  platform = process.platform,
) {
  const candidates = [
    environment.IC_COMPONENT_PYTHON,
    ...(platform === "darwin"
      ? [
          path.join(root, "src-tauri/resources/ai-media-runtime/python/bin/python3.11"),
          path.join(
            root,
            "src-tauri/resources/blender/runtime/Blender.app/Contents/Resources/4.5/python/bin/python3.11",
          ),
        ]
      : [
          path.join(root, "src-tauri/resources/ai-media-runtime/python/python.exe"),
          path.join(root, "src-tauri/resources/blender/runtime/4.5/python/bin/python.exe"),
        ]),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable)
    throw new Error(
      "Component ZIP packaging needs the prepared local Python runtime, or IC_COMPONENT_PYTHON pointing to Python >=3.11; no download is performed.",
    );
  return executable;
}

function invokeZipHelper(python, specPath, archivePath, verify, runner) {
  const args = ["-I", "-B", ZIP_HELPER, specPath, archivePath, ...(verify ? ["--verify"] : [])];
  if (runner) return runner(python, args);
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      stdio: "inherit",
      env: { ...process.env, PYTHONNOUSERSITE: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Component ZIP ${verify ? "verification" : "packaging"} failed (${code})`),
          ),
    );
  });
}

export async function packageRuntimeComponent(
  component,
  {
    sourceRoot,
    packageDirectory,
    python,
    applicationVersion,
    platform = process.platform,
    arch = process.arch,
    runner,
    progress = console.log,
  } = {},
) {
  const identity = assertComponentPlatform(platform, arch);
  await mkdir(packageDirectory, { recursive: true });
  if ((await lstat(packageDirectory)).isSymbolicLink())
    throw new Error("Component package cache must not be a junction");
  const key = componentArchiveCacheKey(component, await componentFileSha256(ZIP_HELPER));
  const cachePath = path.join(packageDirectory, `${component.id}-${key}.json`);
  const specPath = path.join(packageDirectory, `.spec-${randomUUID()}.json`);
  const temporary = path.join(packageDirectory, `.archive-${randomUUID()}.zip`);
  await writeFile(
    specPath,
    JSON.stringify({ root: sourceRoot, files: component.files, platform: identity }),
  );
  try {
    let cached;
    try {
      const metadata = JSON.parse(await readFile(cachePath, "utf8"));
      if (
        metadata.cacheKey !== key ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size <= 0
      )
        throw new Error("Invalid cached archive identity");
      const archivePath = path.join(packageDirectory, `${metadata.sha256}.zip`);
      const info = await lstat(archivePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== metadata.size ||
        (await componentFileSha256(archivePath)) !== metadata.sha256
      )
        throw new Error("Cached ZIP hash mismatch");
      // Cache metadata is not a trust boundary: prove exact entries and every decompressed hash.
      await invokeZipHelper(python, specPath, archivePath, true, runner);
      cached = metadata;
    } catch (error) {
      if (error?.code !== "ENOENT")
        progress(
          `[components:pack] ${component.id}: cached archive unavailable (${error.message}); rebuilding`,
        );
    }
    if (!cached) {
      progress(
        `[components:pack] ${component.id}: compressing ${component.files.length} files, ${(component.files.reduce((sum, entry) => sum + entry.size, 0) / 1024 / 1024).toFixed(1)} MiB`,
      );
      await invokeZipHelper(python, specPath, temporary, false, runner);
      await invokeZipHelper(python, specPath, temporary, true, runner);
      const sha256 = await componentFileSha256(temporary);
      const size = (await lstat(temporary)).size;
      const archivePath = path.join(packageDirectory, `${sha256}.zip`);
      if (existsSync(archivePath)) {
        if (
          (await lstat(archivePath)).isSymbolicLink() ||
          (await componentFileSha256(archivePath)) !== sha256
        )
          throw new Error(`Corrupted immutable ZIP: ${archivePath}`);
        await rm(temporary);
      } else await rename(temporary, archivePath);
      cached = { cacheKey: key, size, sha256 };
      const stagedMetadata = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(stagedMetadata, JSON.stringify(cached, null, 2) + "\n");
      await rename(stagedMetadata, cachePath);
    } else progress(`[components:pack] ${component.id}: reused verified ${cached.sha256}.zip`);
    return {
      ...component,
      archive: {
        format: "zip",
        url: runtimeComponentArchiveUrl(component.id, cached.sha256, {
          applicationVersion,
          platform: identity,
        }),
        size: cached.size,
        sha256: cached.sha256,
      },
    };
  } finally {
    await rm(specPath, { force: true });
    await rm(temporary, { force: true });
  }
}

export async function packageRuntimeComponents({
  root = COMPONENT_REPO_ROOT,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  progress = console.log,
} = {}) {
  assertComponentPlatform(platform, arch, environment.TAURI_ENV_TARGET_TRIPLE);
  if (environment.CARGO_BUILD_TARGET)
    assertComponentPlatform(platform, arch, environment.CARGO_BUILD_TARGET);
  const identity = componentPlatform(platform, arch);
  const applicationVersion = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  const python = resolveComponentPython(root, environment, platform);
  const packageDirectory = path.join(root, ".cache/runtime-components/packages");
  const components = [];
  for (const definition of RUNTIME_COMPONENTS) {
    progress(`[components:pack] ${definition.id}: validating complete prepared tree`);
    const component = await describeRuntimeComponent(definition, { root, platform, arch });
    if (platform === "darwin" && process.platform === "darwin")
      await validateMacRuntimeComponent(definition, { root, arch });
    components.push(
      await packageRuntimeComponent(component, {
        sourceRoot: path.join(root, definition.sourcePath),
        packageDirectory,
        python,
        applicationVersion,
        platform,
        arch,
        progress,
      }),
    );
  }
  const catalog = buildRuntimeComponentCatalog({
    applicationVersion,
    components,
    platform: identity,
  });
  const catalogPath = path.join(root, COMPONENT_CATALOG_RESOURCE);
  const bytes = JSON.stringify(catalog, null, 2) + "\n";
  await mkdir(path.dirname(catalogPath), { recursive: true });
  if (!existsSync(catalogPath) || (await readFile(catalogPath, "utf8")) !== bytes) {
    if (existsSync(catalogPath) && (await lstat(catalogPath)).isSymbolicLink())
      throw new Error("Catalog must not be a symlink");
    const stage = `${catalogPath}.${randomUUID()}.tmp`;
    await writeFile(stage, bytes);
    await rename(stage, catalogPath);
  }
  progress(
    `[components:pack] deterministic catalog ${componentBytesSha256(bytes)} → ${catalogPath}`,
  );
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRuntimeComponents().catch((error) => {
    console.error(`[components:pack] ${error.message}`);
    process.exitCode = 1;
  });
}
