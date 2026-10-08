// Native macOS checks remain local and accept the project's ad-hoc signing baseline.
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { componentFileSha256, componentPathIsValid } from "./runtime-component-catalog.mjs";

const executeFile = promisify(execFile);
const TAR_BUDGET = 2 * 1024 ** 3;
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
async function run(command, args) {
  return executeFile(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
}
export async function inventoryMacApp(directory, prefix = "") {
  const directoryInfo = await lstat(directory);
  requireValue(
    directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(),
    "macOS app directory must be materialized without links",
  );
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    requireValue(componentPathIsValid(relative), `Unsafe macOS bundle path: ${relative}`);
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    requireValue(!info.isSymbolicLink(), `macOS bundle cannot contain links: ${relative}`);
    if (info.isDirectory()) files.push(...(await inventoryMacApp(filename, relative)));
    else {
      requireValue(info.isFile(), `macOS bundle contains a special file: ${relative}`);
      files.push({
        path: relative,
        size: info.size,
        sha256: await componentFileSha256(filename),
        mode: info.mode & 0o777,
      });
    }
  }
  return files;
}
function canonicalInventory(files) {
  return JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, "en")));
}
export function assertMacAppInventories(actual, expected, label) {
  requireValue(
    canonicalInventory(actual) === canonicalInventory(expected),
    `${label} application bytes or permissions differ from the verified app`,
  );
}
function tarString(bytes) {
  return bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString("utf8");
}
function tarNumber(bytes) {
  const text = tarString(bytes).trim();
  requireValue(/^[0-7]+$/.test(text), "Invalid tar numeric header");
  const value = Number.parseInt(text, 8);
  requireValue(Number.isSafeInteger(value) && value >= 0, "Invalid tar numeric value");
  return value;
}
function paxFields(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    requireValue(space > offset, "Malformed PAX record");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    requireValue(/^[1-9]\d*$/.test(lengthText), "Malformed PAX record length");
    const length = Number(lengthText);
    requireValue(
      Number.isSafeInteger(length) &&
        offset + length <= bytes.length &&
        bytes[offset + length - 1] === 10,
      "PAX record exceeds metadata bounds",
    );
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    requireValue(equals > 0, "Malformed PAX key/value");
    const key = record.slice(0, equals);
    requireValue(!Object.hasOwn(fields, key), "Duplicate PAX key");
    fields[key] = record.slice(equals + 1);
    offset += length;
  }
  requireValue(
    !fields.linkpath && !Object.keys(fields).some((key) => /sparse/i.test(key)),
    "Linked or sparse tar metadata is forbidden",
  );
  return fields;
}

/** Read the updater tar without extraction, so traversal/link entries can never touch disk. */
export async function inventoryMacUpdateArchive(filename, appName) {
  requireValue(componentPathIsValid(appName) && appName.endsWith(".app"), "Invalid macOS app name");
  const input = createReadStream(filename);
  const gunzip = createGunzip();
  input.on("error", (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  const iterator = gunzip[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let total = 0;
  async function take(length) {
    while (buffer.length < length) {
      const next = await iterator.next();
      if (next.done) break;
      total += next.value.length;
      requireValue(total <= TAR_BUDGET, "macOS updater exceeds unpacked verification budget");
      buffer = Buffer.concat([buffer, next.value]);
    }
    requireValue(buffer.length >= length, "Truncated macOS updater tar");
    const result = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return result;
  }
  const files = [];
  const seen = new Set();
  const folded = new Set();
  let metadata = {};
  let longName = null;
  let zeroBlocks = 0;
  try {
    while (true) {
      const header = await take(512);
      if (header.every((byte) => byte === 0)) {
        zeroBlocks++;
        if (zeroBlocks === 2) break;
        continue;
      }
      requireValue(zeroBlocks === 0, "Tar data follows an incomplete end marker");
      const checksum = tarNumber(header.subarray(148, 156));
      const actualChecksum = [...header].reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      requireValue(checksum === actualChecksum, "macOS updater tar header checksum mismatch");
      const type = String.fromCharCode(header[156]);
      const headerSize = tarNumber(header.subarray(124, 136));
      if (["x", "g", "L"].includes(type)) {
        requireValue(
          type !== "g" && headerSize <= 64 * 1024,
          "Unsupported or excessive tar metadata",
        );
        const bytes = await take(headerSize);
        if (type === "L") longName = tarString(bytes);
        else metadata = paxFields(bytes);
        await take((512 - (headerSize % 512)) % 512);
        continue;
      }
      requireValue(
        ["\0", "0", "5"].includes(type),
        "macOS updater must contain only regular files and directories",
      );
      const size = metadata.size === undefined ? headerSize : Number(metadata.size);
      requireValue(
        Number.isSafeInteger(size) &&
          size >= 0 &&
          size <= TAR_BUDGET &&
          (metadata.size === undefined || /^\d+$/.test(metadata.size)),
        "Invalid PAX file size",
      );
      const prefix = tarString(header.subarray(345, 500));
      const headerName = tarString(header.subarray(0, 100));
      let name = metadata.path ?? longName ?? (prefix ? `${prefix}/${headerName}` : headerName);
      metadata = {};
      longName = null;
      name = name.replace(/^\.\//, "").replace(/\/$/, "");
      requireValue(
        componentPathIsValid(name) && (name === appName || name.startsWith(`${appName}/`)),
        `Unsafe or foreign macOS updater path: ${name}`,
      );
      requireValue(
        !seen.has(name) && !folded.has(name.toLowerCase()) && seen.size < 100_000,
        "Duplicate or excessive macOS updater entries",
      );
      seen.add(name);
      folded.add(name.toLowerCase());
      if (type === "5") requireValue(size === 0, "Tar directory contains payload data");
      else {
        requireValue(name !== appName, "Updater app root is not a directory");
        const digest = createHash("sha256");
        let remaining = size;
        while (remaining) {
          const count = Math.min(remaining, 64 * 1024);
          digest.update(await take(count));
          remaining -= count;
        }
        files.push({
          path: name.slice(appName.length + 1),
          size,
          sha256: digest.digest("hex"),
          mode: tarNumber(header.subarray(100, 108)) & 0o777,
        });
      }
      await take((512 - (size % 512)) % 512);
    }
    requireValue(
      !longName && Object.keys(metadata).length === 0 && files.length > 0,
      "Dangling metadata or empty updater app",
    );
    requireValue(
      buffer.every((byte) => byte === 0),
      "Unexpected data after tar end marker",
    );
    for await (const bytes of { [Symbol.asyncIterator]: () => iterator }) {
      total += bytes.length;
      requireValue(
        total <= TAR_BUDGET && bytes.every((byte) => byte === 0),
        "Unexpected or excessive trailing tar data",
      );
    }
    return files;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

export async function verifyMacNativeApp(
  appPath,
  { applicationVersion, platform, identifier, expectedResources },
) {
  requireValue(
    process.platform === "darwin",
    "Native macOS release verification must run on macOS",
  );
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const signature = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const signatureInfo = `${signature.stdout}\n${signature.stderr}`;
  requireValue(
    /^Signature=adhoc$/m.test(signatureInfo) || /^Authority=.+$/m.test(signatureInfo),
    "macOS application has no valid signing identity",
  );
  const plist = path.join(appPath, "Contents/Info.plist");
  const readPlist = async (key) =>
    (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim();
  requireValue(
    (await readPlist("CFBundleShortVersionString")) === applicationVersion &&
      (await readPlist("CFBundleVersion")) === applicationVersion &&
      (await readPlist("CFBundleIdentifier")) === identifier &&
      (await readPlist("CFBundleExecutable")) === "infinite-canvas",
    "macOS app version/identifier/executable does not match this release",
  );
  const executablePath = path.join(appPath, "Contents/MacOS/infinite-canvas");
  const arch = platform === "darwin-aarch64" ? "arm64" : "x86_64";
  requireValue(
    (await run("/usr/bin/lipo", ["-archs", executablePath])).stdout
      .trim()
      .split(/\s+/)
      .includes(arch),
    "macOS app architecture does not match its independent channel",
  );
  const inventory = await inventoryMacApp(appPath);
  const resourcePrefix = "Contents/Resources/";
  const resources = inventory
    .filter((entry) => entry.path.startsWith(resourcePrefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(resourcePrefix.length) }));
  requireValue(
    resources.length === expectedResources.length &&
      resources.every((entry) =>
        expectedResources.some(
          (expected) =>
            expected.path === entry.path &&
            expected.sha256 === entry.sha256 &&
            expected.size === entry.size &&
            (expected.mode === undefined || expected.mode === entry.mode),
        ),
      ),
    "macOS app resources include missing, changed or unexpected component payloads",
  );
  const nativeResources = resources.filter((entry) => entry.mode & 0o111);
  requireValue(
    nativeResources.some((entry) => entry.path === "ffmpeg/ffmpeg"),
    "macOS online app is missing its executable FFmpeg binary",
  );
  for (const entry of nativeResources) {
    const handle = await open(path.join(appPath, resourcePrefix, entry.path), "r");
    const bytes = Buffer.alloc(4);
    try {
      await handle.read(bytes, 0, 4, 0);
    } finally {
      await handle.close();
    }
    const isMachO = [
      "cffaedfe",
      "cefaedfe",
      "cafebabe",
      "bebafeca",
      "feedface",
      "feedfacf",
    ].includes(bytes.toString("hex"));
    requireValue(
      !["ffmpeg/ffmpeg", "ffmpeg/ffprobe"].includes(entry.path) || isMachO,
      `macOS bundled FFmpeg is not Mach-O: ${entry.path}`,
    );
    if (isMachO) {
      const filename = path.join(appPath, resourcePrefix, entry.path);
      requireValue(
        (await run("/usr/bin/lipo", ["-archs", filename])).stdout
          .trim()
          .split(/\s+/)
          .includes(arch),
        `macOS bundled executable architecture mismatch: ${entry.path}`,
      );
      await run("/usr/bin/codesign", ["--verify", "--strict", filename]);
    }
  }
  return {
    executablePath,
    inventory,
    bundleResourceCount: resources.length,
    codeSignatureVerified: true,
    signingIdentity: /^Signature=adhoc$/m.test(signatureInfo) ? "ad-hoc" : "certificate",
    architectureVerified: true,
  };
}

export async function verifyMacDmgApplication(filename, appName, expectedInventory) {
  requireValue(process.platform === "darwin", "Native macOS DMG verification must run on macOS");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ic-mac-edition-"));
  const mount = path.join(temporary, "mounted");
  let attached = false;
  try {
    await run("/usr/bin/hdiutil", ["verify", filename]);
    await run("/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mount,
      filename,
    ]);
    attached = true;
    const applications = (await readdir(mount)).filter((entry) => entry.endsWith(".app"));
    requireValue(
      applications.length === 1 && applications[0] === appName,
      "DMG must contain exactly the expected application",
    );
    const appPath = path.join(mount, appName);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    assertMacAppInventories(await inventoryMacApp(appPath), expectedInventory, "DMG");
    return { dmgVerified: true, applicationBytesVerified: true, codeSignatureVerified: true };
  } finally {
    if (attached) await run("/usr/bin/hdiutil", ["detach", mount]);
    await rm(temporary, { recursive: true, force: true });
  }
}
