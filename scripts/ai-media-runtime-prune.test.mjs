import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aiMediaDevelopmentArtifact,
  planAiMediaRuntimePruning,
  pruneAiMediaRuntime,
  AI_MEDIA_PRUNING_POLICY,
} from "./ai-media-runtime-prune.mjs";

test("only known development archives and headers are removed", () => {
  for (const file of [
    "python/libs/python311.lib",
    "python/Include/Python.h",
    "python/Lib/site-packages/torch/lib/dnnl.lib",
    "python/lib/python3.11/site-packages/torch/lib/libtorch.a",
    "python/Lib/site-packages/torch/include/ATen/core/Tensor.h",
    "python/Lib/site-packages/numpy/core/include/numpy/arrayobject.h",
  ])
    assert.equal(aiMediaDevelopmentArtifact(file), true, file);
  for (const file of [
    "python/Lib/site-packages/torch/lib/torch_cpu.dll",
    "python/Lib/site-packages/torch/lib/libtorch.dylib",
    "python/Lib/site-packages/torch/lib/libtorch.so",
    "python/Lib/site-packages/torch/_C.pyd",
    "python/Lib/site-packages/torch/include/LICENSE.h",
    "python/Lib/site-packages/torch/include/torch/copying.hpp",
    "python/Lib/site-packages/torch/tests/test_model.py",
    "python/Lib/site-packages/numpy/core/tests/data/example.npy",
    "python/Lib/site-packages/cffi/header.h",
    "code/model.h",
    "models/test.lib",
    "licenses/source.h",
    "python/include/../../models/weight.h",
    "python\\libs\\python311.lib",
  ])
    assert.equal(aiMediaDevelopmentArtifact(file), false, file);
});

test("planning is read-only and pruning preserves runtime sources, DLLs and licences", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-pruning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = {
    "python/Lib/site-packages/torch/lib/dnnl.lib": "development-library",
    "python/Lib/site-packages/torch/include/Tensor.h": "header",
    "python/Lib/site-packages/torch/lib/torch_cpu.dll": "runtime-library",
    "python/Lib/site-packages/torch/include/LICENSE.h": "licence",
    "python/Lib/site-packages/torch/tests/test_tensor.py": "test-source",
    "worker/worker.py": "inference-source",
    "models/temporal.onnx": "weights",
  };
  for (const [relative, value] of Object.entries(fixtures)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), value);
  }
  const planned = await planAiMediaRuntimePruning(root);
  assert.equal(planned.removedFiles, 2);
  assert.equal(planned.removedBytes, 25);
  assert.equal(await readFile(path.join(root, planned.files[0].path), "utf8"), "header");
  const result = await pruneAiMediaRuntime(root);
  assert.deepEqual(result, {
    policyVersion: AI_MEDIA_PRUNING_POLICY,
    removedFiles: 2,
    removedBytes: 25,
  });
  for (const [relative, value] of Object.entries(fixtures)) {
    if (aiMediaDevelopmentArtifact(relative))
      await assert.rejects(readFile(path.join(root, relative)), { code: "ENOENT" });
    else assert.equal(await readFile(path.join(root, relative), "utf8"), value);
  }
  assert.equal((await pruneAiMediaRuntime(root)).removedFiles, 0);
});

test("a directory link rejects the entire plan before any files are removed", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ai-media-pruning-link-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, "component");
  const outside = path.join(workspace, "outside");
  await mkdir(path.join(root, "python/libs"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "python/libs/python311.lib"), "development");
  await writeFile(path.join(outside, "keep.lib"), "outside");
  await symlink(
    outside,
    path.join(root, "z-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(pruneAiMediaRuntime(root), /不能跟随链接/);
  assert.equal(await readFile(path.join(root, "python/libs/python311.lib"), "utf8"), "development");
  assert.equal(await readFile(path.join(outside, "keep.lib"), "utf8"), "outside");
});
