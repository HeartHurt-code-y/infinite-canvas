// 一次性：对照应用真实 list（kind 扫描 page_size=100）的信封结构。
// 不打印令牌、完整 URL、查询串。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LOCAL = process.env.LOCALAPPDATA ?? "";
const dbPath = path.join(LOCAL, "com.infinitecanvas.desktop", "infinite-canvas.sqlite3");
const token = process.env.ASSET_LIBRARY_TOKEN ?? "";
if (!token) {
  console.log(JSON.stringify({ skipped: "no-token" }));
  process.exit(0);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const providers = db
  .prepare("SELECT id, display_name, base_url, enabled FROM provider_connections")
  .all();
db.close();
const provider =
  providers.find((row) => String(row.id).includes("e943eb7e")) ??
  providers.find((row) => Number(row.enabled) === 1);
if (!provider) {
  console.log(JSON.stringify({ skipped: "no-provider" }));
  process.exit(0);
}

function assetEndpoint(baseUrl, requestPath) {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const baseSegs = base.pathname.split("/").filter(Boolean);
  const reqSegs = requestPath.split("/").filter(Boolean);
  let overlap = 0;
  for (let count = Math.min(baseSegs.length, reqSegs.length); count >= 1; count -= 1) {
    if (baseSegs.slice(-count).join("/") === reqSegs.slice(0, count).join("/")) {
      overlap = count;
      break;
    }
  }
  base.pathname = `/${[...baseSegs, ...reqSegs.slice(overlap)].join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function classify(value) {
  if (value == null) return "null";
  if (typeof value !== "string") return `type:${typeof value}`;
  const trimmed = value.trim();
  if (/^https:\/\//i.test(trimmed)) return "https";
  if (/^http:\/\//i.test(trimmed)) return "http";
  if (/^asset:\/\//i.test(trimmed)) return "asset-uri";
  return "other";
}

function rustHttpUrl(item) {
  for (const field of ["url", "preview_url", "previewUrl"]) {
    const value = item?.[field];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return field;
    }
  }
  return null;
}

function anyHttpField(value, prefix = "") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return prefix || "(root)";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = anyHttpField(value[index], `${prefix}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const found = anyHttpField(child, prefix ? `${prefix}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

function rustAssetArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["list", "items", "assets", "data", "records"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function summarizeArray(name, items) {
  if (!Array.isArray(items)) return { name, present: false };
  const first = items[0] && typeof items[0] === "object" ? items[0] : null;
  let withRustUrl = 0;
  let withAnyHttp = 0;
  for (const item of items) {
    if (rustHttpUrl(item)) withRustUrl += 1;
    if (anyHttpField(item)) withAnyHttp += 1;
  }
  return {
    name,
    present: true,
    count: items.length,
    firstKeys: first ? Object.keys(first) : [],
    firstFieldKinds: first
      ? Object.fromEntries(Object.entries(first).map(([key, value]) => [key, classify(value)]))
      : {},
    rustUrlField: first ? rustHttpUrl(first) : null,
    anyHttpField: first ? anyHttpField(first) : null,
    withRustUrl,
    withAnyHttp,
  };
}

const listUrl = assetEndpoint(String(provider.base_url), "/v1/assets/list");
const response = await fetch(listUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({ page_number: 1, page_size: 40, kind: "image" }),
  signal: AbortSignal.timeout(30000),
});
const text = await response.text();
let json = null;
try {
  json = JSON.parse(text);
} catch {
  json = null;
}

const data = json?.data;
const rustFromData = rustAssetArray(data);
const rustFromPayload = rustAssetArray(json);
const rustMerged = rustFromData.length > 0 ? rustFromData : rustFromPayload;

async function fetchPreviewStat(url) {
  const started = Date.now();
  try {
    const preview = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const buf = await preview.arrayBuffer();
    const type = preview.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(buf);
    let tosCode = null;
    if (type.includes("json") && buf.byteLength > 0 && buf.byteLength < 2000) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        tosCode = parsed.Code ?? parsed.code ?? parsed.Error?.Code ?? parsed.error ?? null;
      } catch {
        tosCode = null;
      }
    }
    return {
      http: preview.status,
      contentType: type.split(";")[0] ?? "",
      bytes: buf.byteLength,
      looksImage: type.startsWith("image/") || (buf.byteLength > 8 && bytes[0] === 0xff && bytes[1] === 0xd8),
      tosCode,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { http: null, error: error instanceof Error ? error.name : "error", ms: Date.now() - started };
  }
}

function httpField(item, field) {
  const value = item?.[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
  const parsed = new URL(trimmed);
  const queryKeys = [...parsed.searchParams.keys()];
  const expires = parsed.searchParams.get("X-Tos-Expires") ?? parsed.searchParams.get("x-tos-expires");
  const date = parsed.searchParams.get("X-Tos-Date") ?? parsed.searchParams.get("x-tos-date");
  return {
    field,
    host: parsed.host,
    path: parsed.pathname,
    url: trimmed,
    urlChars: trimmed.length,
    queryKeys,
    tosExpires: expires,
    tosDate: date,
  };
}

const sampleItems = rustMerged.slice(0, 8).filter((item) => item && typeof item === "object");
const previewSamples = [];
for (const item of sampleItems) {
  const rustField = rustHttpUrl(item);
  const rust = rustField ? httpField(item, rustField) : null;
  const preview = httpField(item, "preview_url") ?? httpField(item, "previewUrl");
  const source = httpField(item, "source_url") ?? httpField(item, "sourceUrl");
  const rustFetch = rust ? await fetchPreviewStat(rust.url) : null;
  const previewFetch =
    preview && rust && preview.path === rust.path && preview.host === rust.host && preview.url === rust.url
      ? rustFetch
      : preview
        ? await fetchPreviewStat(preview.url)
        : null;
  const sourceFetch =
    source && rust && source.url === rust.url
      ? rustFetch
      : source
        ? await fetchPreviewStat(source.url)
        : null;
  previewSamples.push({
    rustField,
    rustHost: rust?.host ?? null,
    previewHost: preview?.host ?? null,
    sourceHost: source?.host ?? null,
    rustUrlChars: rust?.urlChars ?? null,
    rustQueryKeys: rust?.queryKeys ?? [],
    tosDate: rust?.tosDate ?? null,
    tosExpires: rust?.tosExpires ?? null,
    rustSameAsPreview: Boolean(rust && preview && rust.url === preview.url),
    sourceSameAsPreview: Boolean(source && preview && source.url === preview.url),
    rustFetch,
    previewFetch,
    sourceFetch,
  });
}

const firstId = sampleItems[0]?.id ?? sampleItems[0]?.db_id ?? null;
let getProbe = null;
if (firstId != null && firstId !== "") {
  const getUrl = assetEndpoint(String(provider.base_url), "/v1/assets/get");
  const getResponse = await fetch(getUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ id: firstId }),
    signal: AbortSignal.timeout(20000),
  });
  const getText = await getResponse.text();
  let getJson = null;
  try {
    getJson = JSON.parse(getText);
  } catch {
    getJson = null;
  }
  const getRecord = getJson?.data && typeof getJson.data === "object" ? getJson.data : getJson;
  const getPreview = getRecord ? httpField(getRecord, "preview_url") ?? httpField(getRecord, "url") : null;
  getProbe = {
    http: getResponse.status,
    bodyChars: getText.length,
    recordKeys: getRecord && typeof getRecord === "object" ? Object.keys(getRecord) : [],
    previewHost: getPreview?.host ?? null,
    previewFetch: getPreview ? await fetchPreviewStat(getPreview.url) : null,
  };
}

const report = {
  listHttp: response.status,
  listBodyChars: text.length,
  topKeys: json && typeof json === "object" ? Object.keys(json) : [],
  dataType: Array.isArray(data) ? "array" : data && typeof data === "object" ? "object" : typeof data,
  dataKeys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [],
  arrays: {
    dataList: summarizeArray("data.list", data?.list),
    dataItems: summarizeArray("data.items", data?.items),
    dataAssets: summarizeArray("data.assets", data?.assets),
    dataRecords: summarizeArray("data.records", data?.records),
    dataData: summarizeArray("data.data", data?.data),
    topList: summarizeArray("list", json?.list),
    topItems: summarizeArray("items", json?.items),
  },
  rustAssetArrayPicks: rustFromData.length > 0 ? "data" : rustFromPayload.length > 0 ? "payload" : "none",
  rustPickedCount: rustMerged.length,
  rustPickedWithUrl: rustMerged.filter((item) => rustHttpUrl(item)).length,
  rustPickedFirstKeys: rustMerged[0] && typeof rustMerged[0] === "object" ? Object.keys(rustMerged[0]) : [],
  previewSamples,
  getProbe,
};

console.log(JSON.stringify(report, null, 2));
