/*
 * 设计令牌完整性检查。
 *
 * 目的：此前 tokens.css 与组件样式长期脱节 —— 12 个被引用的令牌从未定义，
 * 浏览器静默回退，阴影、三级文字色与强描边全部失效，且没有任何机制会发现。
 * 本脚本把这类问题变成可被 CI 拦下的错误。
 *
 * 检查项：
 *   1. 组件样式引用了但 tokens.css 未定义的 --令牌（排除局部作用域内自行定义的）
 *   2. 形如 `var(--x)` 单独占一行、漏掉属性名的残缺声明
 *   3. 括号不配平的文件
 *
 * 用法：node scripts/check-design-tokens.mjs
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

const TOKENS_FILE = join(ROOT, "tokens.css");
const tokenSource = readFileSync(TOKENS_FILE, "utf8");

/** tokens.css 中声明的令牌名。 */
const declared = new Set([...tokenSource.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]));

/*
 * 运行时注入的令牌：由 TSX 内联 style 或 canvas 绘制逻辑按实例写入，
 * 因此不可能出现在 tokens.css 里。这里显式登记，避免误报。
 */
const RUNTIME_INJECTED = new Set(["--annotation-color", "--bar"]);

const files = walk(join(ROOT, "src"));
const errors = [];
let checkedRefs = 0;

/**
 * 判断某一行是否属于上一条声明的续行。
 *
 * 做法：向上寻找最近的一条「形如 `属性: 值`」的声明行。
 *   - 该声明行以 `;` 结束 → 说明本行前面没有未闭合的声明，本行是孤儿 → 真问题
 *   - 该声明行不以 `;` 结束 → 本行是它的续行（多行 padding / 阴影 / grid 轨道）→ 正常
 * 注释行、`{`/`}`、`@media` 等结构行会被跳过。
 */
function isContinuation(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("/*") || t.startsWith("*") || t.startsWith("}")) continue;
    if (t === "{" || t.endsWith("{")) return false; // 到达块开头
    if (!/^[a-zA-Z-]+\s*:/.test(t)) continue; // 值行，继续向上找声明行
    return !t.endsWith(";");
  }
  return false;
}

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const css = readFileSync(file, "utf8");

  if (!rel.endsWith("tokens.css")) {
    /* 1. 未定义令牌 */
    for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      const name = match[1];
      checkedRefs += 1;
      if (declared.has(name) || RUNTIME_INJECTED.has(name)) continue;
      // 组件文件内允许自定义局部令牌（如 sonner 的变量）。
      if (new RegExp(`^\\s*${name}\\s*:`, "m").test(css)) continue;
      const line = css.slice(0, match.index).split("\n").length;
      errors.push(`${rel}:${line}  未定义令牌 ${name}`);
    }
  }

  /* 2. 残缺声明：声明块内某行只有一个令牌值、没有属性名（本轮重构真实发生过）。 */
  const srcLines = css.split("\n");
  srcLines.forEach((text, i) => {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    if (!/^var\(--[a-zA-Z0-9-)]+\)\s*;?$/.test(trimmed)) return;
    if (isContinuation(srcLines, i)) return;
    errors.push(`${rel}:${i + 1}  残缺声明（缺少属性名）: ${trimmed}`);
  });

  /* 3. 括号配平 */
  const opens = (css.match(/\{/g) ?? []).length;
  const closes = (css.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    errors.push(`${rel}  花括号不配平：{ ${opens} 个，} ${closes} 个`);
  }
}

console.log(
  `检查 ${files.length} 个 CSS 文件，${checkedRefs} 处令牌引用，${declared.size} 个已声明令牌。`,
);
if (errors.length > 0) {
  console.error(`\n发现 ${errors.length} 个问题：\n` + errors.map((e) => `  ${e}`).join("\n"));
  process.exit(1);
}
console.log("令牌完整性检查通过。");
