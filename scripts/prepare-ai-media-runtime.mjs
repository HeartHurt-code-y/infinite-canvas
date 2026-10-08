// Optional, explicit preparation of an offline Python + models component.
// Inference never invokes global Python, pip, torch.hub or a model download API.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { AI_MEDIA_PRUNING_POLICY, pruneAiMediaRuntime } from "./ai-media-runtime-prune.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const applicationVersion = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;
// Public artifact hosts can reject an anonymous HTTP-client agent. Identify the
// actual build tool while retaining the pinned byte length and checksum checks.
const downloadHeaders = {
  "User-Agent": `infinite-canvas-build/${applicationVersion}`,
  Accept: "application/octet-stream",
};
export const RUNTIME_VERSION = "ai-media-onnx-v1";
export const QUALITY_RUNTIME_VERSION = "ai-media-v1";
export const DEPTH_COMMIT = "4f5ae23172ba60fd7bc11ef671cca678842c7072";
export const PYTHON_RELEASE = "20250918";
export const PYTHON_VERSION = "3.11.13";
export const PYTHON_DISTRIBUTIONS = {
  "win32/x64": {
    triple: "x86_64-pc-windows-msvc",
    sha256: "a3a2f8ac71045d7bcf80366a7ec2cc5a1ba08112182a59e5df08a10242b8460a",
    bytes: 25993781,
  },
  "darwin/arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "49c706ef644aeb33feb108d2392c52cca47078b6d9dcb3edb33178a49b097870",
    bytes: 18950619,
  },
  "darwin/x64": {
    triple: "x86_64-apple-darwin",
    sha256: "b171133e97ca1fdc882eff9ed179afbccfb98d12115689f5011798839a9ee59a",
    bytes: 18860280,
  },
  "linux/x64": {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "511ceceeff184ad742a35583755f5070c0274cc0f0bb5c9218abd939240a2146",
    bytes: 30161165,
  },
  "linux/arm64": {
    triple: "aarch64-unknown-linux-gnu",
    sha256: "fc5611d684356e9c560f53c6b1525318a9b0f49a3a1bc8cef11eb3b41c19d786",
    bytes: 30643979,
  },
};

export const MODELS = [
  {
    id: "video-depth-anything-small",
    license: "Apache-2.0",
    path: "models/video_depth_anything_vits.pth",
    source: "https://huggingface.co/depth-anything/Video-Depth-Anything-Small",
    url: "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/256875362cff76724b920335dfb4b29dd611f66e/video_depth_anything_vits.pth",
    sha256: "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609",
    bytes: 116440756,
  },
  {
    id: "htdemucs",
    license: "MIT",
    path: "models/demucs/955717e8-8726e21a.th",
    source: "https://github.com/facebookresearch/demucs",
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th",
    sha256: "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
    bytes: 84141911,
  },
];

// Fully pinned runtime dependencies, including dependencies of dependencies. The
// installer uses --no-deps; pip cannot silently resolve newer transitive packages.
export const DEPENDENCIES = {
  easydict: "1.13",
  colorama: "0.4.6",
  numpy: "1.26.4",
  "opencv-python-headless": "4.10.0.84",
  demucs: "4.0.1",
  "dora-search": "0.1.12",
  einops: "0.8.1",
  julius: "0.2.7",
  lameenc: "1.8.1",
  openunmix: "1.3.0",
  PyYAML: "6.0.2",
  tqdm: "4.67.1",
  omegaconf: "2.3.0",
  "hydra-core": "1.3.2",
  "antlr4-python3-runtime": "4.9.3",
  retrying: "1.4.1",
  six: "1.17.0",
  submitit: "1.5.3",
  treetable: "0.2.6",
  cloudpickle: "3.1.1",
  soundfile: "0.13.1",
  cffi: "1.17.1",
  pycparser: "2.22",
  filelock: "3.18.0",
  "typing-extensions": "4.13.2",
  networkx: "3.4.2",
  sympy: "1.14.0",
  mpmath: "1.3.0",
  Jinja2: "3.1.6",
  MarkupSafe: "3.0.2",
  fsspec: "2025.3.0",
  pillow: "11.2.1",
  packaging: "25.0",
  setuptools: "78.1.0",
  wheel: "0.45.1",
};

export function safeRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadVerified(url, target, pin) {
  const valid = async () => {
    if (!existsSync(target)) return false;
    if ((await stat(target)).size !== pin.bytes) return false;
    const digest = await sha256(target);
    return pin.sha256 ? digest === pin.sha256 : digest.startsWith(pin.sha256Prefix);
  };
  if (await valid()) return;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    const response = await fetch(url, { headers: downloadHeaders });
    if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    const digest = await sha256(temporary);
    if (
      (await stat(temporary)).size !== pin.bytes ||
      (pin.sha256 ? digest !== pin.sha256 : !digest.startsWith(pin.sha256Prefix))
    )
      throw new Error(`下载校验失败: ${url}`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function execute(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} 退出码 ${code}`)),
    );
  });
}

async function capture(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(error || `退出码 ${code}`)),
    );
  });
}

export async function fileInventory(directory) {
  const inventory = [];
  async function walk(relative) {
    const current = path.join(directory, relative);
    for (const name of (await readdir(current)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (child === "runtime-manifest.json" || child === "files-manifest.json") continue;
      if (!safeRelative(child)) throw new Error(`运行包路径无效: ${child}`);
      const filename = path.join(directory, child);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error(`运行包不能包含符号链接: ${child}`);
      if (info.isDirectory()) await walk(child);
      else if (info.isFile())
        inventory.push({
          type: "file",
          path: child,
          sha256: await sha256(filename),
          bytes: info.size,
        });
      else throw new Error(`运行包不能包含特殊文件: ${child}`);
    }
  }
  await walk("");
  return inventory;
}

export async function buildInputs(runtimeProfile, profile) {
  const filenames =
    runtimeProfile === "lite"
      ? [
          "worker.py",
          "worker_onnx.py",
          "audio_onnx.py",
          "export_depth_onnx.py",
          "export_audio_onnx.py",
        ]
      : ["worker.py"];
  const sources = [
    {
      path: "scripts/prepare-ai-media-runtime.mjs",
      sha256: await sha256(fileURLToPath(import.meta.url)),
    },
    {
      path: "scripts/ai-media-runtime-prune.mjs",
      sha256: await sha256(path.join(root, "scripts/ai-media-runtime-prune.mjs")),
    },
  ];
  for (const filename of filenames) {
    const relative = `scripts/ai-media/${filename}`;
    sources.push({ path: relative, sha256: await sha256(path.join(root, relative)) });
  }
  const inputs = {
    platform: process.platform,
    arch: process.arch,
    runtimeProfile,
    profile,
    pruningPolicy: AI_MEDIA_PRUNING_POLICY,
    sources,
  };
  return { ...inputs, sha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex") };
}

export async function reusePrepared(directory, inputs) {
  try {
    const manifestPath = path.join(directory, "runtime-manifest.json");
    const inventoryPath = path.join(directory, "files-manifest.json");
    if (!(await lstat(manifestPath)).isFile() || !(await lstat(inventoryPath)).isFile())
      return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.buildInputs?.sha256 !== inputs.sha256 ||
      manifest.platform !== inputs.platform ||
      manifest.arch !== inputs.arch ||
      manifest.runtimeProfile !== inputs.runtimeProfile ||
      manifest.profile !== inputs.profile ||
      manifest.pruning?.policyVersion !== AI_MEDIA_PRUNING_POLICY ||
      manifest.inventory?.path !== "files-manifest.json" ||
      manifest.inventory.sha256 !== (await sha256(inventoryPath))
    )
      return null;
    const recorded = JSON.parse(await readFile(inventoryPath, "utf8"));
    if (!Array.isArray(recorded) || manifest.inventory.count !== recorded.length) return null;
    // Compare every file, including the executable, all imports, weights and
    // licenses. Extra unrecorded files also invalidate reuse; no Python runs.
    const actual = await fileInventory(directory);
    if (
      actual.length !== recorded.length ||
      actual.some((entry, index) => {
        const saved = recorded[index];
        return (
          saved?.type !== "file" ||
          saved.path !== entry.path ||
          saved.sha256 !== entry.sha256 ||
          saved.bytes !== entry.bytes
        );
      })
    )
      return null;
    return manifest;
  } catch (error) {
    if (error.code !== "ENOENT")
      console.log(`[ai-media:prepare] 已有组件需重新准备: ${error.message}`);
    return null;
  }
}

async function flattenInternalLinks(directory) {
  const resolvedRoot = await realpath(directory);
  async function walk(current) {
    for (const name of await readdir(current)) {
      const child = path.join(current, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        const resolved = await realpath(child);
        const relative = path.relative(resolvedRoot, resolved);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          !(await stat(resolved)).isFile()
        )
          throw new Error(`Python 归档符号链接越界: ${child}`);
        const temporary = `${child}.${randomUUID()}.regular`;
        await copyFile(resolved, temporary);
        await rm(child);
        await rename(temporary, child);
      } else if (info.isDirectory()) await walk(child);
    }
  }
  await walk(directory);
}

export async function prepareDepthCode(destination) {
  const base = `https://raw.githubusercontent.com/DepthAnything/Video-Depth-Anything/${DEPTH_COMMIT}`;
  const response = await fetch(
    `https://api.github.com/repos/DepthAnything/Video-Depth-Anything/git/trees/${DEPTH_COMMIT}?recursive=1`,
  );
  if (!response.ok) throw new Error(`无法获取固定版本深度源码: ${response.status}`);
  const tree = await response.json();
  const entries = tree.tree.filter(
    (entry) =>
      entry.type === "blob" &&
      (entry.path.startsWith("video_depth_anything/") ||
        entry.path === "utils/util.py" ||
        entry.path === "LICENSE"),
  );
  for (const entry of entries) {
    if (!safeRelative(entry.path)) throw new Error("上游源码路径越界");
    const response = await fetch(`${base}/${entry.path}`);
    if (!response.ok) throw new Error(`固定版本源码下载失败: ${entry.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const gitHash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== entry.size || gitHash !== entry.sha)
      throw new Error(`深度源码 Git 内容校验失败: ${entry.path}`);
    const filename = path.join(destination, entry.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
  }
  await copyFile(
    path.join(destination, "LICENSE"),
    path.join(destination, "..", "..", "licenses", "video-depth-anything-Apache-2.0.txt"),
  );
}

export function torchVersions(platform, arch, profile) {
  if (profile === "cuda") {
    if (platform !== "win32" || arch !== "x64")
      throw new Error("当前锁定的 CUDA 运行包仅支持 Windows x64");
    return {
      torch: "2.8.0",
      torchvision: "0.23.0",
      torchaudio: "2.8.0",
      index: "https://download.pytorch.org/whl/cu128",
    };
  }
  if (platform === "darwin" && arch === "x64")
    return {
      torch: "2.2.2",
      torchvision: "0.17.2",
      torchaudio: "2.2.2",
      index: "https://pypi.org/simple",
    };
  return {
    torch: "2.7.1",
    torchvision: "0.22.1",
    torchaudio: "2.7.1",
    index:
      platform === "darwin" ? "https://pypi.org/simple" : "https://download.pytorch.org/whl/cpu",
  };
}

export async function prepareQuality({
  profile = "cpu",
  destination = path.join(root, "src-tauri", "resources", "ai-media-quality-runtime"),
} = {}) {
  if (!["cpu", "cuda"].includes(profile)) throw new Error("profile 必须为 cpu 或 cuda");
  const distribution = PYTHON_DISTRIBUTIONS[`${process.platform}/${process.arch}`];
  if (!distribution) throw new Error(`未支持的平台 ${process.platform}/${process.arch}`);
  const target = path.resolve(destination);
  const workspace = path.resolve(root, "src-tauri", "resources");
  if (path.dirname(target) !== workspace || path.basename(target) !== "ai-media-quality-runtime")
    throw new Error("增强运行包输出必须为 src-tauri/resources/ai-media-quality-runtime");
  const inputs = await buildInputs("quality", profile);
  const existing = await reusePrepared(target, inputs);
  if (existing) {
    console.log(`[ai-media:prepare] 增强组件源码与完整文件校验通过，复用 ${target}`);
    return existing;
  }
  const staging = path.join(workspace, `.ai-media-runtime-${randomUUID()}`);
  const cache = path.join(root, ".cache", "ai-media");
  await mkdir(staging, { recursive: true });
  await mkdir(path.join(staging, "licenses"));
  let published = false;
  try {
    const filename = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${distribution.triple}-install_only_stripped.tar.gz`;
    const archive = path.join(cache, filename);
    console.log(`[ai-media:prepare] 下载独立 Python ${PYTHON_VERSION} (${profile})`);
    await downloadVerified(
      `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(filename)}`,
      archive,
      distribution,
    );
    const files = (await capture("tar", ["-tzf", archive])).split(/\r?\n/).filter(Boolean);
    if (
      files.some((entry) => !safeRelative(entry.replace(/\/$/, "")) || !entry.startsWith("python/"))
    )
      throw new Error("Python 归档包含不安全路径");
    await execute("tar", ["-xzf", archive, "-C", staging]);
    await flattenInternalLinks(staging);
    const pythonPath = process.platform === "win32" ? "python/python.exe" : "python/bin/python3.11";
    const python = path.join(staging, pythonPath);
    const dependencies = { ...DEPENDENCIES };
    if (process.platform === "darwin" && process.arch === "x64") dependencies.sympy = "1.12.1";
    // Each package version is exact, and pip verifies PyPI's advertised artifact hashes.
    await execute(python, [
      "-I",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      "setuptools==78.1.0",
      "wheel==0.45.1",
    ]);
    const torch = torchVersions(process.platform, process.arch, profile);
    await execute(python, [
      "-I",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      "--index-url",
      torch.index,
      `torch==${torch.torch}`,
      `torchvision==${torch.torchvision}`,
      `torchaudio==${torch.torchaudio}`,
    ]);
    await execute(python, [
      "-I",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      "--no-build-isolation",
      ...Object.entries(dependencies).map(([name, version]) => `${name}==${version}`),
    ]);
    await execute(python, ["-I", "-m", "pip", "check"]);
    await execute(python, [
      "-I",
      "-c",
      "import torch, torchvision, torchaudio, demucs, soundfile, cv2; print('verified ML imports', torch.__version__)",
    ]);
    const frozen = await capture(python, ["-I", "-m", "pip", "freeze", "--all"]);
    await writeFile(path.join(staging, "requirements-lock.txt"), frozen);
    await mkdir(path.join(staging, "worker"));
    await copyFile(
      path.join(root, "scripts", "ai-media", "worker.py"),
      path.join(staging, "worker", "worker.py"),
    );
    await prepareDepthCode(path.join(staging, "code", "video-depth-anything"));
    for (const model of MODELS) {
      const downloaded = path.join(cache, path.basename(model.path));
      console.log(`[ai-media:prepare] 校验并准备 ${model.id}`);
      await downloadVerified(model.url, downloaded, model);
      const destination = path.join(staging, model.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(downloaded, destination);
    }
    await writeFile(
      path.join(staging, "models", "demucs", "htdemucs.yaml"),
      "models: ['955717e8']\n",
    );
    await execute(python, [
      "-I",
      "-B",
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); from video_depth_anything.video_depth import VideoDepthAnything; from demucs.htdemucs import HTDemucs; import torch; model=VideoDepthAnything(encoder='vits',features=64,out_channels=[48,96,192,384]); model.load_state_dict(torch.load(sys.argv[2],map_location='cpu',weights_only=True)); print('verified temporal model import and weights')",
      path.join(staging, "code", "video-depth-anything"),
      path.join(staging, MODELS[0].path),
    ]);
    const licenses = await capture(python, [
      "-I",
      "-c",
      'import importlib.metadata as m,json; print(json.dumps([{"name":d.metadata.get("Name"),"version":d.version,"license":d.metadata.get("License"),"licenseFiles":[str(f) for f in (d.files or []) if any(k in str(f).upper() for k in [\'LICENSE\',\'COPYING\',\'NOTICE\'])]} for d in m.distributions()]))',
    ]);
    await writeFile(
      path.join(staging, "licenses", "dependencies.json"),
      JSON.stringify(JSON.parse(licenses), null, 2),
    );
    const pruning = await pruneAiMediaRuntime(staging);
    // Verify imports again after pruning; all checks above ran against the full
    // preparation tree, whereas the manifest must describe the shipped tree.
    await execute(python, [
      "-I",
      "-B",
      "-c",
      "import torch, torchvision, torchaudio, demucs, soundfile, cv2; print('verified pruned ML imports', torch.__version__)",
    ]);
    const inventory = await fileInventory(staging);
    const inventoryFile = path.join(staging, "files-manifest.json");
    await writeFile(inventoryFile, JSON.stringify(inventory, null, 2));
    const manifest = {
      schemaVersion: 1,
      component: "ai-media-quality-runtime",
      runtimeVersion: QUALITY_RUNTIME_VERSION,
      runtimeProfile: "quality",
      platform: process.platform,
      arch: process.arch,
      profile,
      pythonVersion: PYTHON_VERSION,
      pythonPath,
      workerPath: "worker/worker.py",
      codeRoot: "code/video-depth-anything",
      modelRoot: "models",
      inventory: {
        path: "files-manifest.json",
        sha256: await sha256(inventoryFile),
        count: inventory.length,
      },
      models: await Promise.all(
        MODELS.map(async (model) => ({
          id: model.id,
          license: model.license,
          path: model.path,
          source: model.source,
          sha256: await sha256(path.join(staging, model.path)),
        })),
      ),
      dependencies: {
        ...dependencies,
        torch: torch.torch,
        torchvision: torch.torchvision,
        torchaudio: torch.torchaudio,
      },
      sources: {
        videoDepthCommit: DEPTH_COMMIT,
        demucsVersion: "4.0.1",
        pythonBuildStandaloneRelease: PYTHON_RELEASE,
      },
      buildInputs: inputs,
      pruning,
    };
    await writeFile(path.join(staging, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
    if (existsSync(target)) {
      // Both paths were explicitly verified to be direct children of the workspace.
      const backup = path.join(workspace, `.ai-media-runtime-previous-${randomUUID()}`);
      await rename(target, backup);
      try {
        await rename(staging, target);
      } catch (error) {
        await rename(backup, target);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } else await rename(staging, target);
    published = true;
    console.log(
      `[ai-media:prepare] ${QUALITY_RUNTIME_VERSION} / ${profile} 已完成，${inventory.length} 个文件 → ${target}`,
    );
    return manifest;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

export const LITE_DEPENDENCIES = {
  numpy: "1.26.4",
  "opencv-python-headless": "4.10.0.84",
  soundfile: "0.13.1",
  cffi: "1.17.1",
  pycparser: "2.22",
  onnxruntime: "1.22.0",
  coloredlogs: "15.0.1",
  humanfriendly: "10.0",
  flatbuffers: "25.2.10",
  packaging: "25.0",
  protobuf: "5.29.4",
  sympy: "1.14.0",
  mpmath: "1.3.0",
};

export const OPEN_UNMIX_CHECKPOINT = {
  id: "open-unmix-hq",
  license: "MIT",
  path: "models/open_unmix_vocals.onnx",
  url: "https://zenodo.org/records/3370489/files/vocals-b62c91ce.pth",
  sha256: "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
  bytes: 35637796,
  source: "https://zenodo.org/records/3370489",
  licenseSource: "https://zenodo.org/api/records/3370489",
};

async function standalonePython(destination) {
  const distribution = PYTHON_DISTRIBUTIONS[`${process.platform}/${process.arch}`];
  if (!distribution) throw new Error(`未支持的平台 ${process.platform}/${process.arch}`);
  const filename = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${distribution.triple}-install_only_stripped.tar.gz`;
  const archive = path.join(root, ".cache", "ai-media", filename);
  await downloadVerified(
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(filename)}`,
    archive,
    distribution,
  );
  const files = (await capture("tar", ["-tzf", archive])).split(/\r?\n/).filter(Boolean);
  if (
    files.some((entry) => !safeRelative(entry.replace(/\/$/, "")) || !entry.startsWith("python/"))
  )
    throw new Error("Python 归档路径越界");
  await mkdir(destination, { recursive: true });
  await execute("tar", ["-xzf", archive, "-C", destination]);
  await flattenInternalLinks(destination);
  return path.join(
    destination,
    process.platform === "win32" ? "python/python.exe" : "python/bin/python3.11",
  );
}

export async function prepareBuildRuntime() {
  const destination = path.join(root, ".cache", "ai-media", "export-runtime");
  const python = path.join(
    destination,
    process.platform === "win32" ? "python/python.exe" : "python/bin/python3.11",
  );
  if (!existsSync(python)) await standalonePython(destination);
  const torch = torchVersions(process.platform, process.arch, "cpu");
  await execute(python, [
    "-I",
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--index-url",
    torch.index,
    `torch==${torch.torch}`,
    `torchvision==${torch.torchvision}`,
    `torchaudio==${torch.torchaudio}`,
  ]);
  await execute(python, [
    "-I",
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "numpy==1.26.4",
    "opencv-python-headless==4.10.0.84",
    "onnx==1.17.0",
    "onnxruntime==1.22.0",
    "einops==0.8.1",
    "tqdm==4.67.1",
    "openunmix==1.3.0",
    "easydict==1.13",
  ]);
  return python;
}

export async function prepareLite({ acceleration = "cpu" } = {}) {
  if (!["cpu", "directml"].includes(acceleration))
    throw new Error("轻量加速模式必须为 cpu 或 directml");
  if (acceleration === "directml" && (process.platform !== "win32" || process.arch !== "x64"))
    throw new Error("DirectML 运行包仅支持 Windows x64");
  const workspace = path.resolve(root, "src-tauri", "resources");
  const target = path.join(workspace, "ai-media-runtime");
  const inputs = await buildInputs("lite", acceleration);
  const existing = await reusePrepared(target, inputs);
  if (existing) {
    console.log(`[ai-media:prepare] 轻量组件源码与完整文件校验通过，复用 ${target}`);
    return existing;
  }
  const staging = path.join(workspace, `.ai-media-lite-${randomUUID()}`);
  const cache = path.join(root, ".cache", "ai-media");
  await mkdir(path.join(staging, "licenses"), { recursive: true });
  let published = false;
  try {
    const python = await standalonePython(staging);
    const dependencies = { ...LITE_DEPENDENCIES };
    if (process.platform === "win32") dependencies.pyreadline3 = "3.5.4";
    if (acceleration === "directml") {
      delete dependencies.onnxruntime;
      dependencies["onnxruntime-directml"] = "1.22.0";
    }
    await execute(python, [
      "-I",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      ...Object.entries(dependencies).map(([name, version]) => `${name}==${version}`),
    ]);
    await execute(python, ["-I", "-m", "pip", "check"]);
    await execute(python, [
      "-I",
      "-c",
      "import importlib.util, onnxruntime, numpy, cv2, soundfile; assert importlib.util.find_spec('torch') is None; print('lite providers',onnxruntime.get_available_providers())",
    ]);
    const buildPython = await prepareBuildRuntime();
    const buildRoot = path.join(cache, "export-runtime");
    await mkdir(path.join(buildRoot, "licenses"), { recursive: true });
    const depthCode = path.join(buildRoot, "code", "video-depth-anything");
    await prepareDepthCode(depthCode);
    const depthCheckpoint = path.join(cache, "video_depth_anything_vits.pth");
    await downloadVerified(MODELS[0].url, depthCheckpoint, MODELS[0]);
    const audioCheckpoint = path.join(cache, "vocals-b62c91ce.pth");
    await downloadVerified(OPEN_UNMIX_CHECKPOINT.url, audioCheckpoint, OPEN_UNMIX_CHECKPOINT);
    const modelDir = path.join(staging, "models");
    await mkdir(modelDir);
    await execute(buildPython, [
      "-I",
      path.join(root, "scripts", "ai-media", "export_depth_onnx.py"),
      "--checkpoint",
      depthCheckpoint,
      "--code-root",
      depthCode,
      "--output",
      path.join(modelDir, "video_depth_anything_vits.onnx"),
    ]);
    await execute(buildPython, [
      "-I",
      path.join(root, "scripts", "ai-media", "export_audio_onnx.py"),
      "--checkpoint",
      audioCheckpoint,
      "--output",
      path.join(modelDir, "open_unmix_vocals.onnx"),
    ]);
    await mkdir(path.join(staging, "worker"));
    for (const [source, destination] of [
      ["worker_onnx.py", "worker.py"],
      ["worker.py", "worker_core.py"],
      ["audio_onnx.py", "audio_onnx.py"],
    ]) {
      await copyFile(
        path.join(root, "scripts", "ai-media", source),
        path.join(staging, "worker", destination),
      );
    }
    const transformPath = path.join(
      staging,
      "code",
      "video_depth_anything",
      "util",
      "transform.py",
    );
    await mkdir(path.dirname(transformPath), { recursive: true });
    await copyFile(
      path.join(depthCode, "video_depth_anything", "util", "transform.py"),
      transformPath,
    );
    await copyFile(
      path.join(buildRoot, "licenses", "video-depth-anything-Apache-2.0.txt"),
      path.join(staging, "licenses", "video-depth-anything-Apache-2.0.txt"),
    );
    const licenseResponse = await fetch(
      "https://raw.githubusercontent.com/sigsep/open-unmix-pytorch/fb672c9584997c2b05e148eeaa65b4c23ed4693b/LICENSE",
    );
    if (!licenseResponse.ok) throw new Error("无法获取 Open-Unmix 的固定许可证");
    await writeFile(
      path.join(staging, "licenses", "open-unmix-MIT.txt"),
      await licenseResponse.text(),
    );
    await writeFile(
      path.join(staging, "requirements-lock.txt"),
      await capture(python, ["-I", "-m", "pip", "freeze", "--all"]),
    );
    const models = [
      {
        id: "video-depth-anything-small",
        license: "Apache-2.0",
        path: "models/video_depth_anything_vits.onnx",
        source: MODELS[0].source,
        checkpointSha256: MODELS[0].sha256,
      },
      {
        id: "open-unmix-hq",
        license: "MIT",
        path: "models/open_unmix_vocals.onnx",
        source: OPEN_UNMIX_CHECKPOINT.source,
        checkpointSha256: OPEN_UNMIX_CHECKPOINT.sha256,
        licenseSource: OPEN_UNMIX_CHECKPOINT.licenseSource,
      },
    ];
    for (const model of models) model.sha256 = await sha256(path.join(staging, model.path));
    await writeFile(path.join(staging, "licenses", "models.json"), JSON.stringify(models, null, 2));
    const pruning = await pruneAiMediaRuntime(staging);
    await execute(python, [
      "-I",
      "-B",
      "-c",
      "import importlib.util, onnxruntime, numpy, cv2, soundfile; assert importlib.util.find_spec('torch') is None; print('verified pruned lite providers',onnxruntime.get_available_providers())",
    ]);
    const inventory = await fileInventory(staging);
    const inventoryFile = path.join(staging, "files-manifest.json");
    await writeFile(inventoryFile, JSON.stringify(inventory, null, 2));
    const manifest = {
      schemaVersion: 1,
      component: "ai-media-runtime",
      runtimeVersion: RUNTIME_VERSION,
      runtimeProfile: "lite",
      platform: process.platform,
      arch: process.arch,
      profile: acceleration,
      pythonVersion: PYTHON_VERSION,
      pythonPath: process.platform === "win32" ? "python/python.exe" : "python/bin/python3.11",
      workerPath: "worker/worker.py",
      codeRoot: "code",
      modelRoot: "models",
      inventory: {
        path: "files-manifest.json",
        sha256: await sha256(inventoryFile),
        count: inventory.length,
      },
      models,
      dependencies,
      sources: {
        videoDepthCommit: DEPTH_COMMIT,
        openUnmixWeightsRecord: "3370489",
        pythonBuildStandaloneRelease: PYTHON_RELEASE,
      },
      buildInputs: inputs,
      pruning,
    };
    await writeFile(path.join(staging, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
    if (existsSync(target)) {
      const backup = path.join(workspace, `.ai-media-lite-previous-${randomUUID()}`);
      await rename(target, backup);
      try {
        await rename(staging, target);
      } catch (error) {
        await rename(backup, target);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } else await rename(staging, target);
    published = true;
    console.log(
      `[ai-media:prepare] ${RUNTIME_VERSION} / ${acceleration} 已完成，${inventory.length} 个文件 → ${target}`,
    );
    return manifest;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

export async function prepare({ profile = "lite" } = {}) {
  if (profile === "lite" || profile === "lite-directml")
    return prepareLite({ acceleration: profile === "lite-directml" ? "directml" : "cpu" });
  if (profile === "quality" || profile === "quality-cuda")
    return prepareQuality({ profile: profile === "quality-cuda" ? "cuda" : "cpu" });
  throw new Error("profile 必须为 lite、lite-directml、quality 或 quality-cuda");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileIndex = process.argv.indexOf("--profile");
  prepare({ profile: profileIndex >= 0 ? process.argv[profileIndex + 1] : "lite" }).catch(
    (error) => {
      console.error(`[ai-media:prepare] ${error.message}`);
      process.exitCode = 1;
    },
  );
}
