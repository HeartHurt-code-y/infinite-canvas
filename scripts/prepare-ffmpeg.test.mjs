import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { componentFileSha256 } from "./runtime-component-catalog.mjs";
import {
  ensureWindowsFfmpegLicense,
  FFMPEG_GPL3_TEXT_SHA256,
  inspectWindowsFfmpegLicense,
} from "./ffmpeg-runtime-license.mjs";

const output =
  "ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright (c) the FFmpeg developers\nconfiguration: --enable-gpl --enable-version3 --enable-static\nGNU General Public License; either version 3 of the License, or any later version.\n";

test("FFmpeg license selection comes from actual GPL/version3 binary output", () => {
  assert.equal(inspectWindowsFfmpegLicense(output).spdx, "GPL-3.0-or-later");
  assert.throws(
    () => inspectWindowsFfmpegLicense(output.replace("--enable-gpl", "--enable-nonfree")),
    /positively identified/,
  );
  assert.throws(
    () => inspectWindowsFfmpegLicense(output.replace("either version 3", "either version 2")),
    /positively identified/,
  );
});

test("local GPL notice preserves executable bytes, is stable and states missing corresponding-source proof", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-ffmpeg-license-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "ffmpeg");
  await mkdir(directory);
  const binary = path.join(directory, "ffmpeg.exe");
  await writeFile(binary, "unchanged native executable");
  const manifest = {
    schemaVersion: 1,
    version: "9.0.1-essentials_build-www.gyan.dev",
    source: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    ffmpegSha256: await componentFileSha256(binary),
  };
  const licensed = ensureWindowsFfmpegLicense(directory, manifest, { output });
  assert.equal(await componentFileSha256(binary), manifest.ffmpegSha256);
  assert.equal(
    await componentFileSha256(path.join(directory, "COPYING.GPLv3")),
    FFMPEG_GPL3_TEXT_SHA256,
  );
  assert.equal(licensed.license.correspondingSourceBundled, false);
  assert.match(
    await readFile(path.join(directory, "SOURCE.txt"), "utf8"),
    /Exact FFmpeg source commit: not recorded/,
  );
  assert.deepEqual(ensureWindowsFfmpegLicense(directory, licensed, { output }), licensed);
  await writeFile(binary, "tampered");
  assert.throws(
    () => ensureWindowsFfmpegLicense(directory, licensed, { output }),
    /checksum mismatch/,
  );
});

test("trusted standard license text must match its original local archive SHA", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-ffmpeg-copying-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "ffmpeg.exe");
  const copyingPath = path.join(root, "fake-license.txt");
  await writeFile(binary, "native");
  await writeFile(copyingPath, "invented license");
  const manifest = {
    version: "9.0.1-essentials_build-www.gyan.dev",
    ffmpegSha256: await componentFileSha256(binary),
    source: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  };
  assert.throws(
    () => ensureWindowsFfmpegLicense(root, manifest, { output, copyingPath }),
    /GPL text checksum mismatch/,
  );
});
