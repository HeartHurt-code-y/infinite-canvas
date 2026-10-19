import * as v from "valibot";

export const DIAGNOSTIC_CATEGORIES = [
  "apiKeys",
  "prompts",
  "rawResponse",
  "canvas",
  "assets",
] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export const DIAGNOSTIC_CHUNK_BYTES = 256 * 1024;
export const DIAGNOSTIC_MAX_BYTES = 64 * 1024 * 1024;
const categoriesSchema = v.pipe(
  v.array(v.picklist(DIAGNOSTIC_CATEGORIES)),
  v.minLength(1),
  v.maxLength(5),
  v.check((items) => new Set(items).size === items.length),
);
export const diagnosticConsentSchema = v.strictObject({
  consentedAt: v.pipe(v.string(), v.isoTimestamp()),
  consentConfirmed: v.literal(true),
  categories: categoriesSchema,
});
export const automaticDiagnosticCollectionSchema = v.strictObject({
  collectionPolicy: v.literal("automatic-complete-v1"),
  capturedAt: v.pipe(v.string(), v.isoTimestamp()),
  categories: v.pipe(categoriesSchema, v.length(DIAGNOSTIC_CATEGORIES.length)),
});
export const diagnosticCollectionSchema = v.union([
  diagnosticConsentSchema,
  automaticDiagnosticCollectionSchema,
]);
const grantTransport = {
  schemaVersion: v.literal(1),
  tokenHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  byteLength: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(DIAGNOSTIC_MAX_BYTES)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
};
export const diagnosticGrantSchema = v.union([
  v.strictObject({ ...diagnosticConsentSchema.entries, ...grantTransport }),
  v.strictObject({ ...automaticDiagnosticCollectionSchema.entries, ...grantTransport }),
]);
export type DiagnosticConsent = v.InferOutput<typeof diagnosticConsentSchema>;
export type DiagnosticCollection = v.InferOutput<typeof diagnosticCollectionSchema>;
export function automaticDiagnosticCollection(
  capturedAt: string,
): v.InferOutput<typeof automaticDiagnosticCollectionSchema> {
  return {
    collectionPolicy: "automatic-complete-v1",
    capturedAt,
    categories: [...DIAGNOSTIC_CATEGORIES],
  };
}
export type DiagnosticGrant = v.InferOutput<typeof diagnosticGrantSchema>;
export interface DiagnosticOccurrence {
  readonly error: unknown;
  readonly operation?: string;
  readonly args?: Record<string, unknown>;
  readonly taskId?: string;
  readonly canvasId?: string;
}
export interface PreparedDiagnostics {
  reportId: string;
  diagnostics: DiagnosticGrant;
  preview: string;
  unavailable?: readonly string[];
}
export interface DiagnosticPayload {
  schemaVersion: 1;
  collection: DiagnosticCollection;
  capturedAt: string;
  apiKeys?: { providerConnectionId: string; credentialRef: string; key: string }[];
  prompts?: unknown;
  rawResponse?: unknown;
  canvas?: unknown;
  assets?: {
    name: string;
    mimeType: string;
    byteLength: number;
    dataBase64?: string;
    url?: string;
  }[];
  unavailable: string[];
}
type StoredDiagnostic = {
  reportId: string;
  diagnostics: DiagnosticGrant;
  key: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  expiresAt: number;
};
export interface DiagnosticJobStore {
  put(value: StoredDiagnostic): Promise<void>;
  get(reportId: string): Promise<StoredDiagnostic | undefined>;
  delete(reportId: string): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("此设备无法安全暂存完整诊断，请只发送基础报错。"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("infinite-canvas:diagnostic-attachments:v1", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("jobs", { keyPath: "reportId" });
      store.createIndex("expiry", "expiresAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("暂存完整诊断失败，请检查设备空间后重试。"));
    request.onblocked = () =>
      reject(new Error("诊断存储正在被其他窗口使用，请关闭其他窗口后重试。"));
  });
}
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("jobs", mode);
    let output: T;
    transaction.oncomplete = () => {
      db.close();
      resolve(output);
    };
    transaction.onerror = () => {
      db.close();
      reject(new Error("无法保存或读取完整诊断，请检查设备空间。"));
    };
    transaction.onabort = transaction.onerror;
    work(transaction.objectStore("jobs"), (value) => {
      output = value;
    });
  });
}
export const diagnosticJobStore: DiagnosticJobStore = {
  put: (value) =>
    withStore<void>("readwrite", (store, done) => {
      const expired = store.index("expiry").openKeyCursor(IDBKeyRange.upperBound(Date.now()));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      const request = store.put(value);
      request.onsuccess = () => done(undefined);
    }),
  get: (reportId) =>
    withStore<StoredDiagnostic | undefined>("readonly", (store, done) => {
      const request = store.get(reportId);
      request.onsuccess = () => done(request.result as StoredDiagnostic | undefined);
    }),
  delete: (reportId) =>
    withStore<void>("readwrite", (store, done) => {
      const request = store.delete(reportId);
      request.onsuccess = () => done(undefined);
    }),
};
export class DiagnosticAttachmentError extends Error {
  readonly status = 410;
}
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  return btoa(parts.join(""));
}
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
export async function persistDiagnosticPayload(
  payload: DiagnosticPayload,
  store = diagnosticJobStore,
): Promise<PreparedDiagnostics> {
  const collection = v.parse(diagnosticCollectionSchema, payload.collection);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.byteLength > DIAGNOSTIC_MAX_BYTES)
    throw new Error(
      "完整诊断超过 64 MiB。请减少诊断素材，或关闭素材选项后重新准备。创作素材本身不受此诊断上传上限影响。",
    );
  const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "a")
    .replaceAll("/", "b")
    .replaceAll("=", "");
  // A fixed 64-character random capability, kept inside the encrypted local envelope.
  const uploadToken = await sha256(new TextEncoder().encode(token));
  const reportId = crypto.randomUUID();
  const diagnostics: DiagnosticGrant = {
    schemaVersion: 1,
    ...collection,
    tokenHash: await sha256(new TextEncoder().encode(uploadToken)),
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  };
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope = new TextEncoder().encode(`${uploadToken}\n${new TextDecoder().decode(bytes)}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, envelope);
  await store.put({
    reportId,
    diagnostics,
    key,
    iv: iv.buffer,
    ciphertext,
    expiresAt: Date.now() + 7 * 86_400_000,
  });
  const preview = {
    ...payload,
    apiKeys: payload.apiKeys?.map((item) => ({
      ...item,
      key:
        item.key.length > 8
          ? `${item.key.slice(0, 4)}…${item.key.slice(-4)}（发送时包含完整值）`
          : "••••（发送时包含完整值）",
    })),
    assets: payload.assets?.map(({ dataBase64: _data, ...metadata }) => ({
      ...metadata,
      content: _data ? "已包含完整文件字节" : "素材地址引用",
    })),
  };
  const text = JSON.stringify(preview, null, 2);
  return {
    reportId,
    diagnostics,
    unavailable: [...payload.unavailable],
    preview:
      text.length > 32_000
        ? `${text.slice(0, 32_000)}\n（预览正文较长，后续内容已折叠；实际上传保留完整内容。）`
        : text,
  };
}
export async function loadDiagnosticPayload(
  reportId: string,
  store = diagnosticJobStore,
): Promise<{ token: string; bytes: Uint8Array<ArrayBuffer>; diagnostics: DiagnosticGrant }> {
  const value = await store.get(reportId);
  if (!value || value.expiresAt <= Date.now())
    throw new DiagnosticAttachmentError("本机完整诊断已过期或被清除，请重新准备一份反馈。");
  try {
    const envelope = new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv }, value.key, value.ciphertext),
    );
    const newline = envelope.indexOf("\n");
    const token = envelope.slice(0, newline);
    const bytes = new TextEncoder().encode(envelope.slice(newline + 1));
    if (
      newline !== 64 ||
      bytes.byteLength !== value.diagnostics.byteLength ||
      (await sha256(bytes)) !== value.diagnostics.sha256 ||
      (await sha256(new TextEncoder().encode(token))) !== value.diagnostics.tokenHash
    )
      throw new Error("corrupt diagnostics");
    return { token, bytes, diagnostics: value.diagnostics };
  } catch {
    throw new DiagnosticAttachmentError("本机诊断资料校验失败，请重新准备一份反馈。");
  }
}
