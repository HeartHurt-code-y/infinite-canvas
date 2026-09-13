// 诊断脚本：读取画布文档中的 assetNodes，报告每个本地素材节点 previewUrl 的签名有效期。
// 用法: node tools/probe_local_asset_urls.cjs <sqlite 路径>
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const now = Date.now();

function expiryOf(url) {
  const date = (url.match(/X-Tos-Date=(\d{8})T(\d{6})Z/) || []).slice(1);
  const expires = (url.match(/X-Tos-Expires=(\d+)/) || [])[1];
  if (date.length !== 2 || !expires) return null;
  const iso = `${date[0].slice(0, 4)}-${date[0].slice(4, 6)}-${date[0].slice(6, 8)}T${date[1].slice(0, 2)}:${date[1].slice(2, 4)}:${date[1].slice(4, 6)}Z`;
  const issued = new Date(iso);
  return { issued, expiry: new Date(issued.getTime() + Number(expires) * 1000), expires };
}

const docs = db.prepare("SELECT id, title, document_json, updated_at FROM canvas_documents").all();
console.log(`canvas documents: ${docs.length}`);
for (const doc of docs) {
  const payload = JSON.parse(doc.document_json);
  const nodes = payload.assetNodes ?? [];
  console.log(
    `\n== ${doc.title ?? doc.id} (saved ${new Date(doc.updated_at).toISOString()}) assetNodes=${nodes.length}`,
  );
  for (const node of nodes) {
    const url = node.previewUrl ?? null;
    const info = url ? expiryOf(url) : null;
    const host = url ? (url.match(/^https?:\/\/([^/]+)/) || [])[1] : "-";
    const state =
      info == null
        ? url
          ? "no-tos-signature"
          : "null-url"
        : info.expiry.getTime() < now
          ? "EXPIRED"
          : "live";
    console.log(
      `  [${state}] source=${node.source ?? "?"} kind=${node.kind ?? "?"} name=${node.name ?? "?"}`,
    );
    console.log(
      `      assetId=${node.assetId ?? "?"} host=${host}` +
        (info
          ? ` issued=${info.issued.toISOString()} expiry=${info.expiry.toISOString()} (${info.expires}s)`
          : ""),
    );
  }
}
console.log("\nnow:", new Date(now).toISOString());
db.close();
