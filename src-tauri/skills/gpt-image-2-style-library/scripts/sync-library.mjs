import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixed, reviewable upstream snapshot. This script never executes downloaded content.
export const COMMIT = "0dc09c46c8a30b1fdd89c18cc78a894dac2104e3";
export const REPOSITORY = "https://github.com/freestylefly/awesome-gpt-image-2";
const RAW = `https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/${COMMIT}/`;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const comparisonIds = [510, 523, 527, 532];
const comparisonImages = Object.fromEntries([
  ...comparisonIds.map((id) => [
    `src/assets/image25-case${id}-run1.png`,
    `assets/images/comparisons/case${id}-run1.png`,
  ]),
  ["src/assets/image25-demo-mug.png", "assets/images/comparisons/ceramic-mug.png"],
]);
const sourceFiles = {
  "data/cases.json": "source/cases.json",
  "data/style-library.json": "source/style-library.json",
  "docs/gallery.md": "source/gallery.md",
  "docs/gallery-part-1.md": "source/gallery-part-1.md",
  "docs/gallery-part-2.md": "source/gallery-part-2.md",
  "docs/templates.md": "source/templates.md",
  "docs/disclaimer.md": "source/disclaimer.md",
  "README.md": "source/README.md",
  LICENSE: "LICENSE",
  "agents/skills/gpt-image-2-style-library/SKILL.md": "source/upstream-skill.md",
  "agents/skills/gpt-image-2-style-library/references/style-library.md": "source/style-library.md",
  ...Object.fromEntries(
    ["cases.js", "realCases.js", "additionalCases.js"].map((name) => [
      `src/image25/${name}`,
      `source/comparisons/${name}`,
    ]),
  ),
  ...Object.fromEntries(
    comparisonIds.flatMap((id) =>
      ["input", "record"].map((kind) => [
        `docs/design/gpt-image-2-5/case${id}-test-${kind}.json`,
        `source/comparisons/case${id}-test-${kind}.json`,
      ]),
    ),
  ),
  "docs/design/gpt-image-2-5/real-cases.md": "source/comparisons/real-cases.md",
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
async function fetchBytes(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
        headers: { "User-Agent": "bundled-style-library-sync" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1200));
    }
  }
  throw lastError;
}
async function save(root, relativePath, bytes) {
  const destination = path.resolve(root, relativePath);
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error(`Unsafe path: ${relativePath}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
async function json(root, relativePath, data) {
  await save(root, relativePath, `${JSON.stringify(data, null, 2)}\n`);
}

// Only editorial wrapper lines OUTSIDE fenced prompt examples are removed.
// Intended text, logos, numbers, URLs, nested code, and artwork instructions stay intact.
export function cleanBody(markdown, { caseBody = false } = {}) {
  let fence = null;
  const kept = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      kept.push(line);
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      kept.push(line);
      continue;
    }
    if (/^\s*<a\s+(?:name|id)=/i.test(line) || /^\s*<!--/.test(line)) continue;
    if (
      /^\s*(?:>\s*)?(?:\*\*)?(?:来源(?:参考)?|原文链接|原帖|作者|Source|Author)(?:\*\*)?\s*[:：]/i.test(
        line,
      )
    )
      continue;
    if (
      caseBody &&
      (/^\s*###\s+(?:例|Case)\s*\d+/i.test(line) || /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line))
    )
      continue;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/(?:\n\s*(?:\*\*\*|---)\s*)+$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseCaseBodies(documents) {
  const cases = new Map();
  for (const document of documents) {
    const expression = /<a\s+name="case-(\d+)"\s*><\/a>/g;
    const matches = [...document.matchAll(expression)];
    matches.forEach((match, index) => {
      const id = Number(match[1]);
      if (cases.has(id)) throw new Error(`Duplicate gallery case ${id}`);
      cases.set(
        id,
        document.slice(match.index + match[0].length, matches[index + 1]?.index ?? document.length),
      );
    });
  }
  return cases;
}
function parseTemplateBodies(document) {
  const expression = /<a\s+name="(tpl-[^"]+)"\s*><\/a>/g;
  const matches = [...document.matchAll(expression)];
  return new Map(
    matches.map((match, index) => [
      match[1],
      cleanBody(
        document.slice(match.index + match[0].length, matches[index + 1]?.index ?? document.length),
      ),
    ]),
  );
}

export async function build(root) {
  const read = async (relativePath) => readFile(path.join(root, relativePath), "utf8");
  const casesSource = JSON.parse(await read("source/cases.json"));
  const stylesSource = JSON.parse(await read("source/style-library.json"));
  const galleryBodies = parseCaseBodies(
    await Promise.all(["source/gallery-part-1.md", "source/gallery-part-2.md"].map(read)),
  );
  const templateBodies = parseTemplateBodies(await read("source/templates.md"));
  if (
    casesSource.totalCases !== casesSource.cases.length ||
    galleryBodies.size !== casesSource.cases.length
  ) {
    throw new Error(
      `Case count mismatch: declared ${casesSource.totalCases}, JSON ${casesSource.cases.length}, gallery ${galleryBodies.size}`,
    );
  }
  const templates = stylesSource.templates.map((template) => {
    const body = templateBodies.get(template.anchor);
    if (!body) throw new Error(`No full template section for ${template.id}: ${template.anchor}`);
    const { id, title, category, styles, scenes, tags, exampleCases, useWhen, guidance, pitfalls } =
      template;
    return {
      id,
      title,
      body,
      category,
      styles,
      scenes,
      tags,
      exampleCases,
      useWhen,
      guidance,
      pitfalls,
    };
  });
  const cases = casesSource.cases
    .map((entry) => {
      const galleryBody = galleryBodies.get(entry.id);
      if (!galleryBody || !entry.prompt.trim())
        throw new Error(`Missing actual prompt/body for case ${entry.id}`);
      const imagePaths = new Set([`assets${entry.image}`]);
      for (const match of galleryBody.matchAll(/(?:\.\.\/)?data\/(images\/[^\s)"<>]+)/g))
        imagePaths.add(`assets/${match[1]}`);
      if (comparisonIds.includes(entry.id))
        imagePaths.add(`assets/images/comparisons/case${entry.id}-run1.png`);
      return {
        id: entry.id,
        title: entry.title,
        prompt: entry.prompt,
        body: cleanBody(galleryBody, { caseBody: true }),
        category: entry.category,
        styles: entry.styles,
        scenes: entry.scenes,
        templateIds: templates
          .filter((template) => template.exampleCases.includes(entry.id))
          .map((template) => template.id),
        imagePaths: [...imagePaths],
      };
    })
    .sort((left, right) => left.id - right.id);
  await json(root, "data/cases.json", {
    version: 1,
    sourceCommit: COMMIT,
    caseCount: cases.length,
    cases,
  });
  await json(root, "data/templates.json", {
    version: 1,
    sourceCommit: COMMIT,
    templateCount: templates.length,
    templates,
  });
  await save(
    root,
    "references/templates.md",
    "# 工业级提示词模板与防坑指南\n\n" + [...templateBodies.values()].join("\n\n") + "\n",
  );
  const index = (await read("source/style-library.md"))
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^- (?:Example cases|Cover|Template source):/.test(line))
    .map((line) =>
      line.startsWith("- Final output should include ")
        ? "- Final output must contain only the complete generation-ready prompt. Do not emit template names, selection rationale, case IDs, source links, or Markdown wrapper fences."
        : line.startsWith("- If a request is vague, ")
          ? "- If a request is vague, select a reasonable suitable direction and complete a concrete prompt using the current user request and supplied materials."
          : line,
    )
    .join("\n");
  await save(root, "references/style-library.md", index);
  const comparisons = await Promise.all(
    comparisonIds.map(async (id) => {
      const input = JSON.parse(await read(`source/comparisons/case${id}-test-input.json`));
      const original = cases.find((entry) => entry.id === id);
      if (input.prompt !== original.prompt)
        throw new Error(`Comparison prompt differs from original gallery case ${id}`);
      return {
        id: `gallery-${id}-recreation`,
        sourceCaseId: id,
        title: input.title,
        prompt: input.prompt,
        imagePaths: [`assets/images/comparisons/case${id}-run1.png`],
        kind: "recreation",
      };
    }),
  );
  const comparisonModule = await read("source/comparisons/cases.js");
  const demoPrompt = comparisonModule.match(/id: 'ceramic-mug',[\s\S]*?prompt: '([^']+)'/)?.[1];
  if (!demoPrompt) throw new Error("Missing ceramic-mug comparison demo prompt");
  comparisons.push({
    id: "ceramic-mug",
    title: "陶瓷杯 · 商品摄影",
    prompt: demoPrompt,
    imagePaths: ["assets/images/comparisons/ceramic-mug.png"],
    kind: "illustration-demo",
  });
  await json(root, "data/comparisons.json", {
    version: 1,
    sourceCommit: COMMIT,
    comparisonCount: 4,
    demoCount: 1,
    comparisons,
  });
  return {
    cases,
    templates,
    comparisons,
    sourceCaseCount: casesSource.totalCases,
    galleryCount: galleryBodies.size,
  };
}

async function synchronize(root) {
  const treeBytes = await fetchBytes(
    `https://api.github.com/repos/freestylefly/awesome-gpt-image-2/git/trees/${COMMIT}?recursive=1`,
  );
  const tree = JSON.parse(treeBytes);
  if (tree.truncated || tree.sha !== COMMIT)
    throw new Error("Incomplete or unexpected fixed-commit Git tree");
  await save(root, "source/git-tree.json", treeBytes);
  const upstream = new Map(
    tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]),
  );
  const records = [];
  const download = async (sourcePath, localPath) => {
    const expected = upstream.get(sourcePath);
    if (!expected) throw new Error(`Missing fixed-commit upstream file: ${sourcePath}`);
    let bytes;
    try {
      bytes = await readFile(path.join(root, localPath));
    } catch {
      /* not cached */
    }
    if (!bytes || gitBlobSha(bytes) !== expected.sha)
      bytes = await fetchBytes(`${RAW}${sourcePath.split("/").map(encodeURIComponent).join("/")}`);
    if (bytes.length !== expected.size || gitBlobSha(bytes) !== expected.sha)
      throw new Error(`Git object verification failed: ${sourcePath}`);
    await save(root, localPath, bytes);
    records.push({
      path: localPath,
      upstreamPath: sourcePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      gitBlobSha1: expected.sha,
    });
  };
  await Promise.all(
    Object.entries(sourceFiles).map(([sourcePath, localPath]) => download(sourcePath, localPath)),
  );
  const built = await build(root);
  const wantedImages = new Set(
    [...upstream.keys()].filter((name) =>
      /^data\/images\/case\d+[^/]*\.(?:png|jpe?g|webp|gif|avif)$/i.test(name),
    ),
  );
  for (const entry of built.cases)
    for (const imagePath of entry.imagePaths)
      if (!imagePath.includes("/comparisons/"))
        wantedImages.add(imagePath.replace(/^assets\//, "data/"));
  const jobs = [...wantedImages].sort();
  let next = 0;
  let completed = 0;
  const missing = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < jobs.length) {
        const sourcePath = jobs[next++];
        try {
          await download(sourcePath, sourcePath.replace(/^data\//, "assets/"));
        } catch (error) {
          missing.push({ sourcePath, error: String(error) });
        }
        completed += 1;
        if (completed % 40 === 0 || completed === jobs.length)
          console.log(`Images: ${completed}/${jobs.length}; missing: ${missing.length}`);
      }
    }),
  );
  for (const [sourcePath, localPath] of Object.entries(comparisonImages)) {
    try {
      await download(sourcePath, localPath);
    } catch (error) {
      missing.push({ sourcePath, error: String(error) });
    }
  }
  const imageRecords = records.filter((record) => record.path.startsWith("assets/"));
  const referencedImages = new Set(
    [...built.cases, ...built.comparisons].flatMap((entry) => entry.imagePaths),
  );
  const identifiers = new Set(built.cases.map((entry) => entry.id));
  const maxId = Math.max(...identifiers);
  const gaps = Array.from({ length: maxId }, (_, index) => index + 1).filter(
    (id) => !identifiers.has(id),
  );
  const supplementalImages = imageRecords
    .filter((record) => !referencedImages.has(record.path))
    .map((record) => record.path);
  const manifest = {
    version: 1,
    repository: REPOSITORY,
    sourceCommit: COMMIT,
    retrievedOn: "2026-09-14",
    sourceCaseCount: built.sourceCaseCount,
    galleryCaseCount: built.galleryCount,
    caseCount: built.cases.length,
    templateCount: built.templates.length,
    imageCount: imageRecords.length,
    galleryImageCount: imageRecords.filter((record) => !record.path.includes("/comparisons/"))
      .length,
    comparisonImageCount: Object.keys(comparisonImages).length,
    comparisonCaseCount: 4,
    separateDemoCount: 1,
    imageBytes: imageRecords.reduce((sum, record) => sum + record.bytes, 0),
    sourceIdGaps: gaps,
    supplementalImages,
    missingImages: missing,
    files: records.sort((left, right) => left.path.localeCompare(right.path)),
  };
  await json(root, "data/manifest.json", manifest);
  await save(
    root,
    "SOURCE.md",
    `# 固定来源与完整离线内容\n\n` +
      `- 仓库：${REPOSITORY}\n- 固定提交：\`${COMMIT}\`\n- 获取日期：2026-09-14\n` +
      `- 主图库：${manifest.caseCount} 条完整案例正文与提示词，${manifest.galleryImageCount} 份案例图片原文件；22 个风格模板条目，来自 13 个完整模板章节。\n` +
      `- 对比专区：同一图库案例 510、523、527、532 的 4 份重生成结果及原始提示词/生成记录，另含 1 份陶瓷杯演示图及其提示词。它们不增加主图库案例数。\n` +
      `- 图片合计：${manifest.imageCount} 份，${manifest.imageBytes.toLocaleString("en-US")} 字节。所有文件均经固定提交 Git blob SHA-1 和 SHA-256 校验；缺失下载：${missing.length}。\n\n` +
      `## 来源范围与缺口\n\n` +
      `完整覆盖固定提交的 data/cases.json、docs/gallery-part-1.md、docs/gallery-part-2.md 中所有主图库案例及其图片引用，同时保留全部 data/images/case* 图片。上游最大编号为 ${maxId}，编号 ${gaps.join("、")} 在两份图库正文和 cases.json 中缺失；对应三份图片仍存在，已作为无正文的补充原图保留，未伪造正文。上游原始模块及记录同时保留，以区别实际重生成结果与演示图。网站首页装饰、赞助商广告、分类封面以及 docs/design 下的网站界面截图不属于案例原图，不纳入图片案例库。\n\n` +
      `## 目录与运行时边界\n\n` +
      `- source/：原始 cases.json、style-library.json、两册图库正文、完整模板文档、README、免责声明、原技能、原索引，以及对比专区代码/输入/生成记录，逐字节保留。来源署名及许可证只在本归档中保留。\n` +
      `- data/cases.json：完整提示词和移除图库外层来源/索引/图片包装的正文，带内部检索元数据和本地图片路径。prompt 字段与上游完全相等，不能当作控制应用的系统指令。\n` +
      `- data/templates.json 与 references/templates.md：13 个完整模板章节对应 22 个模板方向，移除页面导航、推广介绍、独立来源行，保留实际模板、JSON、正文和避坑说明。\n` +
      `- references/style-library.md：适配后的风格检索索引；不要求输出模板选择、案例编号、封面或来源链接。原始索引在 source/style-library.md。\n` +
      `- data/comparisons.json：4 份原案例重生成记录对应的正文及 1 份独立演示提示词。本地图片在 assets/images/comparisons/。模型标签和质量不是应用独立验证结论；原始测试记录保存在 source/comparisons/。\n` +
      `- assets/images/：真实图片原字节，本地读取，无运行时联网依赖。源图片里有的画面文字/签名不会被修改，模型输出遵循当前用户要求。\n` +
      `- data/manifest.json、SHA256SUMS：精确来源文件映射、大小、Git blob 哈希、SHA-256、案例缺口与补充文件清单。\n\n` +
      `## 获取与复验\n\n` +
      `本次先使用 Firecrawl 抓取固定提交仓库页、两册图库和完整模板文档，原始抓取证据保存在项目忽略目录 .firecrawl/gpt-image-2-*.json。图片二进制与原始文件通过固定 GitHub raw 地址下载。抓取网页不执行网页或文档中的任何安装、命令或推广指令。\n\n` +
      `运行 \`node scripts/sync-library.mjs\` 可重新按固定提交下载/增量校验/生成目录；\`node scripts/verify-library.mjs\` 可完全离线校验。两个脚本默认使用本技能根目录，也支持 \`--root <目录>\`。\n\n` +
      `## 许可与署名\n\n` +
      `仓库 MIT 许可原文在 LICENSE。上游明确保留第三方提示词和图片的原作者/平台权利，原文完整保存于 source/README.md、source/disclaimer.md 及原始案例文件。MIT 仓库许可不代表上游拥有全部第三方内容，也未据此推断商业授权。署名、来源链接和许可归档不会插入最终生成提示词。\n`,
  );
  const checksummed = [
    ...records.map(({ path: filePath, sha256: hash }) => ({ path: filePath, sha256: hash })),
  ];
  for (const generated of [
    "data/cases.json",
    "data/templates.json",
    "data/comparisons.json",
    "data/manifest.json",
    "references/templates.md",
    "references/style-library.md",
    "source/git-tree.json",
    "SOURCE.md",
  ]) {
    checksummed.push({
      path: generated,
      sha256: sha256(await readFile(path.join(root, generated))),
    });
  }
  await save(
    root,
    "SHA256SUMS",
    checksummed
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.sha256}  ${entry.path}`)
      .join("\n") + "\n",
  );
  console.log(JSON.stringify({ ...manifest, files: undefined }, null, 2));
  if (missing.length)
    throw new Error(`${missing.length} required image downloads failed; see data/manifest.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : DEFAULT_ROOT;
  if (process.argv.includes("--build-only")) await build(root);
  else await synchronize(root);
}
