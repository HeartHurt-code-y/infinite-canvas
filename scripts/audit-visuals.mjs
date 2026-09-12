/*
 * 视觉审查脚本：打开本地 dev server，抓取关键界面截图，并打印关键元素的计算样式。
 *
 * 为什么需要它
 * ------------
 * 本项目的样式改动（层级、对比度、间距、字距、响应式断点）无法靠读 CSS 判断，
 * 只能看渲染结果。这里把「打开应用 → 建立真实节点 → 打开对话框 → 收窄到移动宽度」
 * 固化成一条可重复执行的命令；计算样式表用来确认令牌真的生效，而不是被别的规则覆盖。
 *
 * 前置条件
 * --------
 *   1. 另开一个终端跑 `pnpm dev`（默认连 http://localhost:1420）
 *   2. 需要 playwright-core 与本机已安装的 Chromium（脚本使用 channel: "chromium"）
 *
 * 用法
 * ----
 *   node scripts/audit-visuals.mjs <标签>          # 例如 before / after
 *   pnpm audit:visuals <标签>
 *   截图输出到 .screenshots/<标签>-*.png（已加入 .gitignore，不进入仓库）
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const LABEL = process.argv[2] ?? "shot";
const OUT = ".screenshots";
const BASE_URL = process.env.AUDIT_URL ?? "http://localhost:1420/";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});

/* 控制台错误会被汇总打印：样式改动不应该引入任何新增报错。 */
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

async function shot(name) {
  const file = `${OUT}/${LABEL}-${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  saved ${file}`);
}

/** 按 aria-label 前缀点击第一个匹配元素；找不到时报告而不是静默跳过。 */
async function clickByLabel(prefix) {
  const target = page.locator(`[aria-label^="${prefix}"]`).first();
  if ((await target.count()) === 0) {
    console.log(`  ! 未找到 aria-label 以「${prefix}」开头的元素`);
    return false;
  }
  await target.click();
  return true;
}

console.log(`打开 ${BASE_URL} …`);
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

/* 1. 空画布：顶栏、节点仓库、素材库、空状态、缩放控件、底部工作流仓库 */
await shot("01-empty-canvas");

/* 建立真实节点：单击节点仓库模板会在画布中心创建实例 */
const templates = [
  "拖拽创建图片生成节点",
  "拖拽创建视频生成节点",
  "拖拽创建提示词生成与优化节点",
  "拖拽创建视频拼接与合成节点",
];
for (const label of templates) {
  if (await clickByLabel(label)) await page.waitForTimeout(600);
}
await page.waitForTimeout(1000);

/* 2. 已建节点的画布 */
await shot("02-populated-canvas");

/* 3. 默认缩放，看清节点卡片细节 */
await page.keyboard.press("0");
await page.waitForTimeout(500);
await shot("03-canvas-default-zoom");

/* 3b. 单个节点与仓库卡片放大，用于检查卡片内部做工 */
for (const [selector, name] of [
  [".canvas-gen-node", "04-node-card"],
  [".repository-card", "05-repository-card"],
]) {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) {
    console.log(`  ! 未找到 ${selector}`);
    continue;
  }
  const file = `${OUT}/${LABEL}-${name}.png`;
  await el.screenshot({ path: file }).catch((e) => console.log(`  ! ${selector}: ${e.message}`));
  console.log(`  saved ${file}`);
}

/* 4. 全局设置：表单字段、按钮、错误详情 */
if (await clickByLabel("打开全局设置")) {
  await page.waitForTimeout(900);
  await shot("06-settings-dialog");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

/* 5. 历史记录：分页、范围切换、筛选、空态 */
if (await clickByLabel("打开历史记录")) {
  await page.waitForTimeout(1000);
  await shot("07-history-dialog");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

/* 6. 窄屏：确认重构没有破坏响应式与横向溢出 */
for (const width of [768, 414, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) console.log(`  ! ${width}px 出现横向溢出 ${overflow}px`);
  await shot(`08-narrow-${width}`);
}
await page.setViewportSize({ width: 1600, height: 1000 });

/*
 * 7. 计算样式核对：确认关键令牌真的作用到了渲染结果上。
 * 只读取需要的叶子属性，不序列化任何运行时对象。
 */
const computed = await page.evaluate(() => {
  const pick = (selector, props) => {
    const el = document.querySelector(selector);
    if (el === null) return { selector, missing: true };
    const cs = getComputedStyle(el);
    const out = { selector };
    for (const p of props) out[p] = cs.getPropertyValue(p);
    const r = el.getBoundingClientRect();
    out.box = `${Math.round(r.width)}x${Math.round(r.height)}`;
    return out;
  };
  return {
    surfaces: [
      pick(".workspace-header", ["background-color", "border-bottom-color"]),
      pick(".asset-panel", ["background-color"]),
      pick(".canvas-gen-node", ["background-color", "border-radius"]),
      pick(".zoom-control", ["background-color", "border-color"]),
    ],
    type: [
      pick(".canvas-empty-hint strong", ["font-family", "font-size", "letter-spacing"]),
      pick(".canvas-empty-hint span", ["font-size", "line-height"]),
      pick(".asset-empty strong", ["font-family", "font-size", "letter-spacing"]),
    ],
    colour: [
      pick(".repository-card__icon", ["color", "background-color"]),
      pick(".canvas-gen-node__start", ["color", "background-color"]),
    ],
  };
});
console.log("\n计算样式核对：");
console.log(JSON.stringify(computed, null, 2));

if (consoleErrors.length > 0) {
  console.log(`\n控制台错误 ${consoleErrors.length} 条:`);
  for (const e of consoleErrors.slice(0, 20)) console.log(`  - ${e}`);
} else {
  console.log("\n控制台无错误。");
}

await browser.close();
