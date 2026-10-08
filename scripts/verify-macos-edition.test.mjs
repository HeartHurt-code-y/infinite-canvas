import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { componentBytesSha256 } from "./runtime-component-catalog.mjs";
import {
  assertMacAppInventories,
  inventoryMacUpdateArchive,
  verifyMacDmgApplication,
  verifyMacNativeApp,
} from "./verify-macos-edition.mjs";

const APP = "无限画布.app";
function header(name, { type = "0", body = Buffer.alloc(0), mode = 0o644 } = {}) {
  const result = Buffer.alloc(512);
  result.write(name, 0, 100, "utf8");
  result.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
  result.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  result.fill(32, 148, 156);
  result.write(type, 156, "ascii");
  result.write("ustar\0", 257, "ascii");
  const checksum = [...result].reduce((sum, byte) => sum + byte, 0);
  result.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return Buffer.concat([result, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function archive(entries, trailing = Buffer.alloc(1024)) {
  return gzipSync(Buffer.concat([...entries, trailing]));
}
function pax(key, value) {
  const record = `${key}=${value}\n`;
  let size = Buffer.byteLength(record) + 2;
  while (Buffer.byteLength(`${size} ${record}`) !== size)
    size = Buffer.byteLength(`${size} ${record}`);
  return Buffer.from(`${size} ${record}`);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-mac-tar-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "application.app.tar.gz");
  return { filename, write: (bytes) => writeFile(filename, bytes) };
}

test("updater inventory validates a unicode app, file content and native executable permissions without extraction", async (t) => {
  const f = await fixture(t);
  const body = Buffer.from("native executable fixture");
  await f.write(
    archive([
      header(`${APP}/`, { type: "5", mode: 0o755 }),
      header(`${APP}/Contents/MacOS/infinite-canvas`, { body, mode: 0o755 }),
    ]),
  );
  const files = await inventoryMacUpdateArchive(f.filename, APP);
  assert.deepEqual(files, [
    {
      path: "Contents/MacOS/infinite-canvas",
      size: body.length,
      sha256: componentBytesSha256(body),
      mode: 0o755,
    },
  ]);
  assertMacAppInventories(files, structuredClone(files), "Updater");
  assert.throws(
    () => assertMacAppInventories([{ ...files[0], mode: 0o644 }], files, "Updater"),
    /permissions differ/,
  );
  assert.throws(
    () => assertMacAppInventories([{ ...files[0], sha256: "a".repeat(64) }], files, "DMG"),
    /application bytes/,
  );
});

test("PAX paths and GNU long filenames remain bound to exactly the named app", async (t) => {
  const f = await fixture(t);
  const longPath = `${APP}/Contents/Resources/skills/${"segment/".repeat(15)}SKILL.md`;
  for (const metadata of [
    header("pax", { type: "x", body: pax("path", longPath) }),
    header("././@LongLink", { type: "L", body: Buffer.from(longPath + "\0") }),
  ]) {
    await f.write(
      archive([metadata, header("placeholder", { body: Buffer.from("documentation") })]),
    );
    assert.equal(
      (await inventoryMacUpdateArchive(f.filename, APP))[0].path,
      longPath.slice(APP.length + 1),
    );
  }
});

test("updater tar rejects traversal, foreign apps, links, devices, duplicate paths and checksum corruption", async (t) => {
  const f = await fixture(t);
  const normal = header(`${APP}/Contents/Info.plist`, { body: Buffer.from("plist") });
  const corrupt = Buffer.from(normal);
  corrupt[10] ^= 1;
  for (const [entries, error] of [
    [[header("../escaped", { body: Buffer.from("x") })], /Unsafe or foreign/],
    [[header(`${APP}/../escaped`, { body: Buffer.from("x") })], /Unsafe or foreign/],
    [[header("Other.app/Contents/Info.plist")], /Unsafe or foreign/],
    [[header(`${APP}/link`, { type: "2" })], /only regular files/],
    [[header(`${APP}/hardlink`, { type: "1" })], /only regular files/],
    [[header(`${APP}/device`, { type: "3" })], /only regular files/],
    [[normal, normal], /Duplicate/],
    [[normal, header(`${APP}/Contents/INFO.plist`)], /Duplicate/],
    [[corrupt], /checksum mismatch/],
    [
      [header("pax", { type: "x", body: pax("linkpath", "../../outside") }), normal],
      /Linked or sparse/,
    ],
  ]) {
    await f.write(archive(entries));
    await assert.rejects(inventoryMacUpdateArchive(f.filename, APP), error);
  }
});

test("truncated gzip/tar, nonzero trailing payload and dangling metadata are rejected", async (t) => {
  const f = await fixture(t);
  const normal = header(`${APP}/Contents/Info.plist`, { body: Buffer.from("plist") });
  for (const bytes of [
    archive([normal], Buffer.alloc(512)),
    archive([normal], Buffer.concat([Buffer.alloc(1024), Buffer.from("extra payload")])),
    archive([header("pax", { type: "x", body: pax("path", `${APP}/Contents/Info.plist`) })]),
    archive([normal]).subarray(0, -8),
  ]) {
    await f.write(bytes);
    await assert.rejects(inventoryMacUpdateArchive(f.filename, APP));
  }
});

test(
  "native signature/DMG checks cannot silently pass on another operating system",
  { skip: process.platform === "darwin" },
  async () => {
    await assert.rejects(verifyMacNativeApp("application.app", {}), /must run on macOS/);
    await assert.rejects(verifyMacDmgApplication("application.dmg", APP, []), /must run on macOS/);
  },
);
