import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function parseMinisignPublicKey(encoded) {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("updater 公钥格式无效");
  }
  const record = Buffer.from(lines[1], "base64");
  if (record.length !== 42 || record.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("updater 公钥格式无效");
  }
  return {
    id: record.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, record.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

function parseMinisignSignature(encoded) {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error("updater 签名格式无效");
  }
  const record = Buffer.from(lines[1], "base64");
  const globalSignature = Buffer.from(lines[3], "base64");
  if (
    record.length !== 74 ||
    record.subarray(0, 2).toString("ascii") !== "ED" ||
    globalSignature.length !== 64
  ) {
    throw new Error("updater 签名格式无效");
  }
  return {
    id: record.subarray(2, 10),
    signature: record.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
  };
}

export async function verifyUpdaterSignature(filePath, signaturePath, encodedPublicKey) {
  const publicKey = parseMinisignPublicKey(encodedPublicKey);
  const signature = parseMinisignSignature(await readFile(signaturePath, "utf8"));
  if (!publicKey.id.equals(signature.id)) throw new Error("updater 签名公钥 ID 不匹配");
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (!verify(null, hash.digest(), publicKey.key, signature.signature)) {
    throw new Error("updater 安装包签名验证失败");
  }
  const globalPayload = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment)]);
  if (!verify(null, globalPayload, publicKey.key, signature.globalSignature)) {
    throw new Error("updater 签名备注验证失败");
  }
}
