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
  body: JSON.stringify({ page_number: 1, page_size: 100 }),
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
};

console.log(JSON.stringify(report, null, 2));
