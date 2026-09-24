import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

test("updater verification accepts a matching Minisign signature and rejects changed bytes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "updater-signature-"));
  try {
    const file = path.join(root, "setup.exe");
    const signatureFile = `${file}.sig`;
    writeFileSync(file, "installer bytes");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const id = Buffer.from("0102030405060708", "hex");
    const publicRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const encodedKey = Buffer.from(
      `untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), id, publicRaw]).toString("base64")}\n`,
    ).toString("base64");
    const digest = createHash("blake2b512").update(readFileSync(file)).digest();
    const signature = sign(null, digest, privateKey);
    const comment = "test comment";
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const minisign = `untrusted comment: test signature\n${Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    writeFileSync(signatureFile, Buffer.from(minisign).toString("base64"));
    await assert.doesNotReject(() => verifyUpdaterSignature(file, signatureFile, encodedKey));
    writeFileSync(file, "changed bytes");
    await assert.rejects(
      () => verifyUpdaterSignature(file, signatureFile, encodedKey),
      /签名验证失败/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
