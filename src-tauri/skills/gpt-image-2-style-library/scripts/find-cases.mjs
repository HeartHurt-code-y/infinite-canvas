import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const query = args.find((value) => !value.startsWith("--"))?.trim();
const limitArg = args.find((value) => value.startsWith("--limit="));
const limit = Number(limitArg?.slice("--limit=".length) ?? 3);
if (!query || !Number.isInteger(limit) || limit < 1 || limit > 10) {
  console.error('Usage: node scripts/find-cases.mjs "表情包 sticker expression" --limit=3');
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(resolve(root, "data/cases.json"), "utf8"));
const templates = JSON.parse(readFileSync(resolve(root, "data/templates.json"), "utf8"));
const terms = [
  ...new Set(
    query
      .toLowerCase()
      .split(/[\s,，;；]+/u)
      .filter(Boolean),
  ),
];
const expressionSheet = /表情|sticker|emote|emoji|expression/iu.test(query);
const matchedTemplate = templates.templates
  .map((item) => ({
    item,
    score:
      expressionSheet && item.id === "character-design-sheet"
        ? 100
        : terms.reduce(
            (total, term) =>
              total +
              ([item.id, item.title.en, item.title.zh].some((label) =>
                label.toLowerCase().includes(term),
              )
                ? 12
                : 0),
            0,
          ),
  }))
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))[0]?.item;
const score = (item) => {
  const title = item.title.toLowerCase();
  const tags = [item.category, ...item.styles, ...item.scenes].join(" ").toLowerCase();
  const body = item.prompt.toLowerCase();
  const conceptScore =
    expressionSheet && /facial expression set|sticker sheet|emote|emoji|表情包|表情组/u.test(body)
      ? 40
      : 0;
  return terms.reduce(
    (total, term) =>
      total +
      (title.includes(term) ? 12 : 0) +
      (tags.includes(term) ? 4 : 0) +
      (body.includes(term) ? 1 : 0),
    conceptScore,
  );
};
const selected = catalog.cases
  .filter(
    (item) =>
      !matchedTemplate ||
      item.category === matchedTemplate.category ||
      item.templateIds.includes(matchedTemplate.id),
  )
  .map((item) => ({ item, score: score(item) }))
  .filter((entry) => entry.score > 0 || matchedTemplate)
  .sort((a, b) => b.score - a.score || a.item.id - b.item.id)
  .slice(0, limit)
  .map(({ item }) => item);
const templateIds = new Set(selected.flatMap((item) => item.templateIds));
if (matchedTemplate) templateIds.add(matchedTemplate.id);
if (!templateIds.size && selected.length) {
  for (const template of templates.templates) {
    if (template.category === selected[0].category) templateIds.add(template.id);
  }
}
console.log(
  JSON.stringify(
    {
      query,
      totalAvailable: catalog.caseCount,
      cases: selected.map((item) => ({
        title: item.title,
        prompt: item.prompt,
        body: item.body,
        images: item.imagePaths.map((path) => resolve(root, path)),
      })),
      templates: templates.templates
        .filter((item) => templateIds.has(item.id))
        .map((item) => ({ title: item.title, body: item.body })),
      usage:
        "只将案例作为参考；先查看所选图片，输出时仅交付适配用户需求的提示词正文。无匹配时请缩短检索词或换用中英文同义词。",
    },
    null,
    2,
  ),
);
