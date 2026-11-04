// Downloads the exact public 136-entry extension-font snapshot. No account or token is used.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "src-tauri/resources/fonts/liblib-extended");
const source = JSON.parse(await fs.readFile(path.join(directory, "source.json"), "utf8"));
if (source.fonts.length !== 136) throw new Error("Expected the original 136 extension-font entries");
const progressPath = path.join(root, ".tmp/liblib-font-bundle-20261102/downloads.json");
await fs.mkdir(path.dirname(progressPath), { recursive: true });
await fs.mkdir(path.join(directory, "originals"), { recursive: true });
let previous = {};
try { previous = JSON.parse(await fs.readFile(progressPath, "utf8")); } catch { /* First preparation. */ }
const records = {};
const unique = [...new Map(source.fonts.map(font => [font.assetUrl, font])).values()];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const useCurl = process.argv.includes("--curl");
let next = 0, completed = 0, bytesTotal = 0;
const failures = [];
async function obtain(font) {
  const cached = previous[font.assetUrl];
  if (cached) {
    try {
      const bytes = await fs.readFile(path.join(directory, cached.file));
      if (digest(bytes) === cached.sha256) return cached;
    } catch { /* Recreate a missing local asset from its original public URL. */ }
  }
  const url = new URL(font.assetUrl);
  if (!['tv-res.newtake.cloud', 'libtv-res.liblib.art'].includes(url.hostname) || url.protocol !== 'https:') throw new Error("Unexpected font origin");
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let bytes;
      if (useCurl) {
        const temporary = path.join(path.dirname(progressPath), `${font.id}.download`);
        try {
          await run(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--location", "--connect-timeout", "10", "--max-time", "180", "--max-filesize", "67108864", "--silent", "--show-error", "--output", temporary, url.href], { windowsHide: true, maxBuffer: 8192 });
          bytes = await fs.readFile(temporary);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      } else {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("Invalid font size");
      const tag = bytes.toString("ascii", 0, 4);
      if (bytes.readUInt32BE(0) !== 0x00010000 && !["OTTO", "true", "ttcf", "wOFF", "wOF2"].includes(tag)) throw new Error("The response is not a font file");
      const sha256 = digest(bytes);
      const extension = path.extname(url.pathname).toLowerCase();
      const file = `originals/${sha256}${extension}`;
      await fs.writeFile(path.join(directory, file), bytes);
      return { sha256, file, bytes: bytes.length };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
async function worker() {
  while (next < unique.length) {
    const font = unique[next++];
    try { const result = await obtain(font); records[font.assetUrl] = result; bytesTotal += result.bytes; }
    catch (error) { failures.push({ family: font.familyName, url: font.assetUrl, error: String(error) }); }
    completed++;
    if (completed % 8 === 0 || completed === unique.length) {
      await fs.writeFile(progressPath, JSON.stringify({ ...previous, ...records }, null, 2));
      process.stdout.write(`${completed}/${unique.length} files; ${(bytesTotal / 1048576).toFixed(1)} MiB; failures=${failures.length}\n`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
await fs.writeFile(progressPath, JSON.stringify({ ...previous, ...records }, null, 2));
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
else {
  const catalog = { ...source, fonts: source.fonts.map(font => ({ ...font, ...records[font.assetUrl] })) };
  await fs.writeFile(path.join(directory, "downloaded.json"), JSON.stringify(catalog, null, 2));
  console.log(`Ready: ${catalog.fonts.length} entries, ${unique.length} original files, ${(bytesTotal/1048576).toFixed(1)} MiB`);
}
