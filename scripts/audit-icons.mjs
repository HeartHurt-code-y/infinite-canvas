/*
 * 图标审查：测量真实渲染的图标尺寸、字重、颜色与对比度。
 * 只读，不修改任何东西。
 * 用法：node scripts/audit-icons.mjs   （需要先跑 pnpm dev）
 */
import { chromium } from "playwright-core";

const BASE_URL = process.env.AUDIT_URL ?? "http://localhost:1420/";
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

/* 建立一个节点，让节点内图标也进入统计 */
for (const label of ["拖拽创建图片生成节点", "拖拽创建视频生成节点"]) {
  const b = page.locator(`[aria-label^="${label}"]`).first();
  if ((await b.count()) > 0) {
    await b.click();
    await page.waitForTimeout(600);
  }
}
await page.waitForTimeout(800);

const report = await page.evaluate(() => {
  /* 只统计图标级 svg：排除 React Flow 的网格背景层（它也是 <svg>，尺寸为整块画布） */
  const svgs = [...document.querySelectorAll("svg")].filter(
    (el) => !el.classList.contains("react-flow__background"),
  );
  const rows = [];
  for (const svg of svgs) {
    const cs = getComputedStyle(svg);
    const r = svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.width > 120) continue;
    /* 取最近的可见文字/背景容器，用于估算对比度 */
    let host = svg.parentElement;
    let hostBg = "rgba(0, 0, 0, 0)";
    for (let i = 0; i < 6 && host; i += 1) {
      const hb = getComputedStyle(host).backgroundColor;
      if (hb && hb !== "rgba(0, 0, 0, 0)" && hb !== "transparent") {
        hostBg = hb;
        break;
      }
      host = host.parentElement;
    }
    rows.push({
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      color: cs.color,
      strokeW: cs.strokeWidth,
      fill: cs.fill,
      hostBg,
      label: (svg.parentElement?.getAttribute("aria-label") ?? "").slice(0, 24),
    });
  }
  /* 尺寸分布 */
  const bySize = {};
  for (const r of rows) {
    const k = `${r.w}x${r.h}`;
    bySize[k] = (bySize[k] ?? 0) + 1;
  }
  /* 颜色分布 */
  const byColor = {};
  for (const r of rows) byColor[r.color] = (byColor[r.color] ?? 0) + 1;

  return { total: rows.length, bySize, byColor, sample: rows.slice(0, 40) };
});

console.log(`可见图标总数: ${report.total}\n`);
console.log("=== 渲染尺寸分布 ===");
for (const [k, v] of Object.entries(report.bySize).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}x  ${k}`);
}
console.log("\n=== 渲染颜色分布（前 14）===");
for (const [k, v] of Object.entries(report.byColor)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14)) {
  console.log(`  ${String(v).padStart(3)}x  ${k}`);
}

await browser.close();
