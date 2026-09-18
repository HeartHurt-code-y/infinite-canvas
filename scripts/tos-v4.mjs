// 火山引擎 TOS 签名版本 4（TOS4-HMAC-SHA256）。
// 预签名算法对齐官方文档《URL 中包含签名》：https://www.volcengine.com/docs/6349/129226
import { createHash, createHmac } from "node:crypto";

export function uriEncode(value, encodeSlash) {
  let encoded = "";
  for (const byte of Buffer.from(String(value), "utf8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e ||
      (byte === 0x2f && !encodeSlash)
    ) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

export function formatTosDate(now) {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

export function formatTosDateTime(now) {
  return now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function deriveSigningKey(secretKey, date, region) {
  const kDate = hmacSha256(secretKey, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "tos");
  return hmacSha256(kService, "request");
}

/**
 * @param {Record<string, string>} headers
 */
function normalizeHeaderMap(headers) {
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = String(value).trim();
  }
  return normalized;
}

/**
 * @param {{
 *   method: string,
 *   host: string,
 *   objectKey: string,
 *   region: string,
 *   accessKey: string,
 *   secretKey: string,
 *   expiresSecs: number,
 *   now: Date,
 *   extraQuery?: Array<[string, string]>,
 *   extraHeaders?: Record<string, string>,
 * }} params
 */
export function presignUrl(params) {
  const date = formatTosDate(params.now);
  const requestDate = formatTosDateTime(params.now);
  const credentialScope = `${date}/${params.region}/tos/request`;
  const credential = `${params.accessKey}/${credentialScope}`;
  const canonicalUri = `/${uriEncode(params.objectKey, false)}`;
  const extraHeaders = normalizeHeaderMap(params.extraHeaders ?? {});
  extraHeaders.host = params.host;
  const signedHeaderNames = Object.keys(extraHeaders).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${extraHeaders[name]}\n`)
    .join("");

  /** @type {Array<[string, string]>} */
  const queryPairs = [
    ["X-Tos-Algorithm", "TOS4-HMAC-SHA256"],
    ["X-Tos-Credential", credential],
    ["X-Tos-Date", requestDate],
    ["X-Tos-Expires", String(params.expiresSecs)],
    ["X-Tos-SignedHeaders", signedHeaders],
    ...(params.extraQuery ?? []),
  ];
  queryPairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const canonicalQuery = queryPairs
    .map(([key, value]) => `${uriEncode(key, true)}=${uriEncode(value, true)}`)
    .join("&");
  const canonicalRequest = `${params.method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `TOS4-HMAC-SHA256\n${requestDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(
    deriveSigningKey(params.secretKey, date, params.region),
    stringToSign,
  ).toString("hex");
  return {
    url: `https://${params.host}${canonicalUri}?${canonicalQuery}&X-Tos-Signature=${signature}`,
    signedHeaders: extraHeaders,
  };
}

/**
 * 控制台复制的 SK 有时被包成 Base64。两个候选都试，不把密钥写进日志。
 * @param {string} raw
 * @returns {string[]}
 */
export function candidateSecretKeys(raw) {
  const trimmed = raw.trim();
  const keys = [trimmed];
  if (trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded !== "" && decoded !== trimmed && decoded.length >= 16 && decoded.length <= 80) {
      keys.push(decoded);
    }
  }
  return keys;
}
