import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FFMPEG_GPL3_TEXT_SHA256 =
  "0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b";
const COPYING = fileURLToPath(new URL("./licenses/GPL-3.0-or-later.txt", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inspectWindowsFfmpegLicense(output) {
  const version = /^ffmpeg version (\S+)/m.exec(output)?.[1];
  const configuration = /^\s*configuration: (.*)$/m.exec(output)?.[1];
  if (
    !version ||
    !configuration ||
    !/(?:^| )--enable-gpl(?: |$)/.test(configuration) ||
    !/(?:^| )--enable-version3(?: |$)/.test(configuration) ||
    !/GNU General Public License/.test(output) ||
    !/either version 3 of the License/.test(output)
  )
    throw new Error(
      "Windows FFmpeg license was not positively identified as GPL-3.0-or-later; refusing to invent a license/source notice",
    );
  return { version, configuration, spdx: "GPL-3.0-or-later" };
}

function writeStable(filename, bytes) {
  if (existsSync(filename) && lstatSync(filename).isSymbolicLink())
    throw new Error(`License path must not be a symlink: ${filename}`);
  if (existsSync(filename) && readFileSync(filename).equals(Buffer.from(bytes))) return;
  const temporary = `${filename}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, filename);
}

export function ensureWindowsFfmpegLicense(
  directory,
  manifest,
  { output, copyingPath = COPYING } = {},
) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("FFmpeg resource directory must be materialized");
  const binary = path.join(directory, "ffmpeg.exe");
  if (
    !lstatSync(binary).isFile() ||
    lstatSync(binary).isSymbolicLink() ||
    digest(readFileSync(binary)) !== manifest.ffmpegSha256
  )
    throw new Error("FFmpeg executable checksum mismatch before license inspection");
  if (output === undefined) {
    const result = spawnSync(binary, ["-L"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(`FFmpeg license inspection failed (${result.status})`);
    output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  }
  const identity = inspectWindowsFfmpegLicense(output);
  if (identity.version !== manifest.version)
    throw new Error("FFmpeg license version differs from prepared manifest");
  const copying = readFileSync(copyingPath);
  if (digest(copying) !== FFMPEG_GPL3_TEXT_SHA256)
    throw new Error("Trusted local GPL text checksum mismatch");
  // The binary does not expose an exact source commit. A generic upstream tag is
  // a reference, not a claim that a complete corresponding-source pack is bundled.
  const releaseVersion = /^(\d+\.\d+(?:\.\d+)?)(?:-|$)/.exec(identity.version)?.[1];
  const reference = releaseVersion ? `n${releaseVersion}` : "not determined";
  const source = [
    "FFmpeg binary and source provenance",
    `Binary version (verified with -L): ${identity.version}`,
    `Original binary distributor URL: ${manifest.source}`,
    "Original distributor/build information: https://www.gyan.dev/ffmpeg/builds/",
    "Upstream source repository: https://git.ffmpeg.org/ffmpeg.git",
    "Upstream project: https://ffmpeg.org/",
    `Release tag reference derived from binary version (not resolved to a commit): ${reference}`,
    "Exact FFmpeg source commit: not recorded by the original prepared manifest/binary version output.",
    "Local corresponding-source archive: none. This component does not include the complete corresponding source of FFmpeg or its statically linked dependencies.",
    "This notice does not make a source-delivery offer or assert that generic upstream source is the exact corresponding source for this distributor build.",
    `Build configuration reported by this binary: ${identity.configuration}`,
    "License text: COPYING.GPLv3 (GNU GPL version 3 or later).",
    "Original binary license notice and build banner: LICENSE-NOTICE.txt.",
    "",
  ].join("\n");
  writeStable(path.join(directory, "COPYING.GPLv3"), copying);
  writeStable(
    path.join(directory, "LICENSE-NOTICE.txt"),
    output.replaceAll("\r\n", "\n").trim() + "\n",
  );
  writeStable(path.join(directory, "SOURCE.txt"), source);
  return {
    ...manifest,
    license: {
      spdx: identity.spdx,
      path: "COPYING.GPLv3",
      sha256: FFMPEG_GPL3_TEXT_SHA256,
      noticePath: "LICENSE-NOTICE.txt",
      sourcePath: "SOURCE.txt",
      correspondingSourceBundled: false,
    },
  };
}
