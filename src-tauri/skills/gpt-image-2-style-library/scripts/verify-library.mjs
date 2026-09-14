import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBody, COMMIT, sha256 } from "./sync-library.mjs";

const rootIndex = process.argv.indexOf("--root");
const root =
  rootIndex >= 0
    ? path.resolve(process.argv[rootIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const manifest = await json("data/manifest.json");
const catalog = await json("data/cases.json");
const templates = await json("data/templates.json");
const comparisons = await json("data/comparisons.json");
const source = await json("source/cases.json");
assert.equal(manifest.sourceCommit, COMMIT);
assert.equal(manifest.missingImages.length, 0);
assert.equal(catalog.cases.length, source.totalCases);
assert.equal(catalog.caseCount, source.cases.length);
assert.equal(new Set(catalog.cases.map((entry) => entry.id)).size, source.totalCases);
const originals = new Map(source.cases.map((entry) => [entry.id, entry]));
// Editorial cleaning must not eat nested fences or intended visible source text.
const nestedPrompt =
  '````markdown\n来源：这行文字应出现在画面中\n```json\n{"label":"品牌名称"}\n```\n````';
assert.equal(cleanBody("**来源：** outside attribution\n\n" + nestedPrompt), nestedPrompt);
let referencedImageCount = 0;
for (const entry of catalog.cases) {
  assert.equal(entry.prompt, originals.get(entry.id).prompt, `Full prompt altered: ${entry.id}`);
  assert.ok(entry.body.trim(), `No gallery body: ${entry.id}`);
  assert.ok(entry.imagePaths.length > 0, `No actual case image: ${entry.id}`);
  assert.ok(
    !/^\s*(?:<a name="case-|###\s*例\s*\d+|\*\*来源)/m.test(entry.body),
    `Gallery metadata leaked: ${entry.id}`,
  );
  for (const relativePath of entry.imagePaths) {
    assert.match(relativePath, /^assets\/images\/[\w./-]+$/);
    const record = manifest.files.find((file) => file.path === relativePath);
    assert.ok(record, `Unverified case image: ${entry.id} ${relativePath}`);
    referencedImageCount += 1;
  }
}
for (const template of templates.templates) {
  assert.ok(template.body.length > 100, `Template body missing: ${template.id}`);
  for (const id of template.exampleCases)
    assert.ok(originals.has(id), `Unknown example: ${template.id} ${id}`);
}
assert.equal(comparisons.comparisons.filter((entry) => entry.kind === "recreation").length, 4);
assert.equal(
  comparisons.comparisons.filter((entry) => entry.kind === "illustration-demo").length,
  1,
);
for (const entry of comparisons.comparisons) {
  assert.ok(entry.prompt.trim(), `Missing comparison prompt: ${entry.id}`);
  if (entry.sourceCaseId) assert.equal(entry.prompt, originals.get(entry.sourceCaseId).prompt);
  for (const relativePath of entry.imagePaths)
    assert.ok(
      manifest.files.some((file) => file.path === relativePath),
      `Missing comparison image: ${relativePath}`,
    );
}
const sums = (await readFile(path.join(root, "SHA256SUMS"), "utf8")).trim().split("\n");
let totalBytes = 0;
for (const line of sums) {
  const [, expected, relativePath] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
  assert.ok(relativePath, `Malformed checksum entry: ${line}`);
  const bytes = await readFile(path.join(root, relativePath));
  assert.equal(sha256(bytes), expected, `Checksum mismatch: ${relativePath}`);
  if (relativePath.startsWith("assets/images/")) {
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const isWebp =
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    assert.ok(isPng || isJpeg || isWebp, `Invalid image signature: ${relativePath}`);
  }
  totalBytes += bytes.length;
}
assert.equal(
  manifest.files.filter((file) => file.path.startsWith("assets/")).length,
  manifest.imageCount,
);
console.log(
  JSON.stringify(
    {
      verified: true,
      commit: COMMIT,
      cases: catalog.cases.length,
      templates: templates.templates.length,
      imageFiles: manifest.imageCount,
      imageReferences: referencedImageCount,
      imageBytes: manifest.imageBytes,
      checksumFiles: sums.length,
      totalBytes,
      sourceIdGaps: manifest.sourceIdGaps,
      supplementalImages: manifest.supplementalImages,
    },
    null,
    2,
  ),
);
