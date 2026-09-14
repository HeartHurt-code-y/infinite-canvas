/*
 * 图标审查：测量真实渲染的图标尺寸、字重、颜色与对比度。
 * 只读，不修改任何东西。
 *
 * 用法：
 *   node scripts/audit-icons.mjs                （需要先跑 pnpm dev）
 *   node scripts/audit-icons.mjs --self-check   （先自检检测器，再跑审查）
 *   AUDIT_URL=http://localhost:1420/ node scripts/audit-icons.mjs
 *
 * 退出码：发现「图标对比度不足」时为 1，可直接接进 CI。
 *
 * 为什么要有对比度这一项：`.canvas-asset-node__upload` 曾经写成
 * `color: var(--color-text); background: var(--color-ink)`，而 tokens.css 里
 * `--color-ink` 就是 `--color-text`，于是上传箭头被自己的底色吃掉，按钮在
 * 深色卡片上退化成一颗纯白圆点 —— 尺寸、图标数量一切正常，只有肉眼能发现。
 * 静态侧由 scripts/check-design-tokens.mjs 的第 4 项兜底，这里负责运行时兜底。
 */
import { chromium } from "playwright-core";

const BASE_URL = process.env.AUDIT_URL ?? "http://localhost:1420/";
const SELF_CHECK = process.argv.includes("--self-check");
/** 低于此对比度视为「图标看不见」：不是不够清晰，而是和底色几乎同值。 */
const INVISIBLE_BELOW = 1.5;
/** 低于此对比度提示但不判失败（深色界面上的次级图标常年在 2~3 之间）。 */
const WARN_BELOW = 2.2;

/*
 * 在页面里跑的检测逻辑：定位每个图标、求它实际显示的颜色与真正的底色，
 * 算 WCAG 对比度。整块作为字符串注入，避免打包成浏览器代码。
 */
const DETECT_SOURCE = `
(() => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((v) => parseFloat(v));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  /* 图标背后到底是什么颜色：沿祖先链把半透明层压到不透明层上。 */
  const effectiveBackground = (el) => {
    let layer = null;
    let node = el;
    let overMedia = false;
    while (node && node !== document.documentElement.parentElement) {
      if (node !== el && (node.tagName === "IMG" || node.tagName === "VIDEO")) overMedia = true;
      const cs = getComputedStyle(node);
      for (const pseudo of [null, "::after", "::before"]) {
        const background = parse(pseudo === null ? cs.backgroundColor : getComputedStyle(node, pseudo).backgroundColor);
        if (background !== null && background.a > 0.02) {
          layer = layer === null ? background : over(layer, background);
        }
      }
      if (layer !== null && layer.a >= 0.999) break;
      node = node.parentElement;
    }
    const fallback = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 0, g: 0, b: 0, a: 1 };
    return { color: layer === null || layer.a < 0.999 ? over(layer ?? { r: 0, g: 0, b: 0, a: 0 }, fallback) : layer, overMedia };
  };

  const hostLabel = (el) => {
    const withLabel = el.closest("[aria-label]");
    return withLabel ? withLabel.getAttribute("aria-label").slice(0, 40) : (el.parentElement?.className ?? "");
  };
  const describe = (el) => {
    const own = typeof el.className === "string" && el.className !== "" ? "." + el.className.split(/\\s+/)[0] : el.tagName.toLowerCase();
    const host = el.closest("button, [class]");
    return (host && typeof host.className === "string" && host.className !== ""
      ? "." + host.className.split(/\\s+/)[0]
      : own);
  };

  const rows = [];
  const icons = [...document.querySelectorAll("svg, img")].filter(
    (el) => !el.classList.contains("react-flow__background"),
  );
  for (const el of icons) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.width > 120) continue;
    const cs = getComputedStyle(el);
    /* 图标自身可能被显式半透明化 */
    const ownAlpha = parseFloat(cs.opacity);
    const parentAlpha = parseFloat(getComputedStyle(el.parentElement ?? el).opacity);
    const revealOpacity = Math.min(Number.isNaN(ownAlpha) ? 1 : ownAlpha, Number.isNaN(parentAlpha) ? 1 : parentAlpha);
    const foreground = parse(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const { color: background, overMedia } = effectiveBackground(el);
    const rendered = revealOpacity < 1 ? over({ ...foreground, a: revealOpacity }, background) : foreground;
    rows.push({
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
      color: cs.color,
      background: "rgb(" + [background.r, background.g, background.b].map((v) => Math.round(v)).join(", ") + ")",
      contrast: Math.round(contrast(rendered, background) * 100) / 100,
      hostOpacity: revealOpacity,
      overMedia,
      selector: describe(el),
      label: hostLabel(el),
      fixture: el.getAttribute("data-fixture"),
      inNode: el.closest(".react-flow__node") !== null,
    });
  }
  return rows;
})()
`;

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

/* 建立一个节点，让节点内图标也进入统计（菜单项文案来自 CANVAS_QUICK_ADD_CHOICES） */
await page.getByRole("button", { name: "添加节点" }).first().click();
await page.waitForTimeout(400);
for (const label of ["图片生成", "视频生成"]) {
  const item = page.getByRole("menuitem", { name: label }).first();
  if ((await item.count()) > 0) {
    await item.click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "添加节点" }).first().click();
    await page.waitForTimeout(300);
  }
}
await page.keyboard.press("Escape");
await page.waitForTimeout(800);

/* 画布节点是历史 bug 的现场：先确认真有节点被建出来，避免审查空转。 */
const canvasState = await page.evaluate(() => ({
  flowNodes: document.querySelectorAll(".react-flow__node").length,
  nodeChrome: document.querySelectorAll(".canvas-asset-node, .canvas-gen-node, .canvas-result-node")
    .length,
  bodyText: document.body.innerText.slice(0, 80).replace(/\s+/g, " "),
}));
console.log(
  `画布节点: ${canvasState.flowNodes} 个（含 ${canvasState.nodeChrome} 个节点外壳）` +
    (canvasState.flowNodes === 0
      ? ` —— 警告：节点未建出，节点内图标未进入统计（页面首屏：${canvasState.bodyText}）`
      : ""),
);

/*
 * 节点内的按钮（移除、上传、拖出连线…）默认 opacity: 0，只在悬停时显形。
 * 历史 bug 恰好就长在这类控件上（上传按钮），所以审查必须先让它们显形，
 * 否则最该检查的一批图标永远不进统计。
 */
await page.addStyleTag({
  content: `
    .canvas-asset-node__remove, .canvas-asset-node__upload, .canvas-asset-node__port,
    .canvas-result-node__remove, .canvas-result-node__reveal,
    .canvas-gen-node__remove, .node-media-chip__unlink, .canvas-flow-handle {
      opacity: 1 !important;
      transition: none !important;
    }
    .react-flow__handle { opacity: 1 !important; }
  `,
});
await page.waitForTimeout(300);

/* ── 检测器自检：注入已知好/坏图标，确认检测器真的能分辨 ─────────────── */
async function selfCheck() {
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "icon-audit-fixture";
    fixture.style.cssText = "position:fixed;left:-9999px;top:0;";
    fixture.innerHTML = `
      <div id="fixture-bad" style="background:#f4f4f4;width:40px;height:40px;">
        <svg data-fixture="bad" width="16" height="16" viewBox="0 0 16 16" style="display:block;color:#f4f4f4"><rect width="16" height="16" fill="currentColor"></rect></svg>
      </div>
      <div id="fixture-good" style="background:#f4f4f4;width:40px;height:40px;">
        <svg data-fixture="good" width="16" height="16" viewBox="0 0 16 16" style="display:block;color:#242424"><rect width="16" height="16" fill="currentColor"></rect></svg>
      </div>`;
    document.body.appendChild(fixture);
  });
  const rows = await page.evaluate(DETECT_SOURCE);
  const bad = rows.find((r) => r.fixture === "bad");
  const good = rows.find((r) => r.fixture === "good");
  const pass =
    bad !== undefined && good !== undefined && bad.contrast < INVISIBLE_BELOW && good.contrast > 8;
  console.log(
    `自检：坏图标对比度 ${bad ? bad.contrast : "未检出"}（应 < ${INVISIBLE_BELOW}），` +
      `好图标对比度 ${good ? good.contrast : "未检出"}（应 > 8）→ ${pass ? "通过" : "不通过"}`,
  );
  await page.evaluate(() => document.getElementById("icon-audit-fixture")?.remove());
  return pass;
}

let selfCheckPassed = true;
if (SELF_CHECK) {
  selfCheckPassed = await selfCheck();
}

const rows = await page.evaluate(DETECT_SOURCE);

/* ── 尺寸与颜色分布（保持原有的观察维度） ───────────────────────────── */
const bySize = {};
const byColor = {};
for (const row of rows) {
  const sizeKey = `${row.w}x${row.h}`;
  bySize[sizeKey] = (bySize[sizeKey] ?? 0) + 1;
  byColor[row.color] = (byColor[row.color] ?? 0) + 1;
}

console.log(`可见图标总数: ${rows.length}\n`);
console.log("=== 渲染尺寸分布 ===");
for (const [key, value] of Object.entries(bySize).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(value).padStart(3)}x  ${key}`);
}
console.log("\n=== 渲染颜色分布（前 14）===");
for (const [key, value] of Object.entries(byColor)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14)) {
  console.log(`  ${String(value).padStart(3)}x  ${key}`);
}

/* ── 对比度检查 ─────────────────────────────────────────────────────── */
const measurable = rows.filter((row) => !row.overMedia);
const invisible = measurable.filter((row) => row.contrast < INVISIBLE_BELOW);
const faint = measurable.filter(
  (row) => row.contrast >= INVISIBLE_BELOW && row.contrast < WARN_BELOW,
);

console.log(
  `\n=== 图标对比度（可判定 ${measurable.length} / ${rows.length}，跳过压在媒体上的）===`,
);
const inNode = measurable.filter((row) => row.inNode);
console.log(
  `  其中画布节点内 ${inNode.length} 个（历史 bug 的现场；产物卡片要等生成任务才有，由静态检查兜底）`,
);
console.log(`  最低 5 个：`);
for (const row of [...measurable].sort((a, b) => a.contrast - b.contrast).slice(0, 5)) {
  console.log(
    `    ${String(row.contrast).padStart(5)}:1  ${row.selector}  ${row.color} on ${row.background}` +
      (row.hostOpacity < 1 ? `  （悬停才显形 opacity ${row.hostOpacity}）` : "") +
      `  ${row.label}`,
  );
}
if (faint.length > 0) {
  console.log(`  偏弱（${WARN_BELOW} 以下，不判失败）: ${faint.length} 个`);
}

await browser.close();

let failed = !selfCheckPassed;
if (invisible.length > 0) {
  failed = true;
  console.error(`\n发现 ${invisible.length} 个图标与底色几乎同色（会被自己的底色吃掉）：`);
  for (const row of invisible) {
    console.error(
      `  ${row.selector}  ${row.color} on ${row.background}  对比度 ${row.contrast}:1` +
        (row.hostOpacity < 1 ? `  （悬停才显形）` : "") +
        `  ${row.label}`,
    );
  }
  console.error("修法：让图标色与底色取自不同令牌，例如 background 用 --color-chrome-2。");
} else if (!failed) {
  console.log("\n图标对比度检查通过。");
}
process.exit(failed ? 1 : 0);
