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
 *   4. 同一条声明块里 color 与 background 解析到同一个值 —— 图标/文字被自己的
 *      底色吃掉，渲染出来是一颗纯色圆点（本轮 `.canvas-asset-node__upload` 真实发生过）
 *
 * 用法：
 *   node scripts/check-design-tokens.mjs              常规检查
 *   node scripts/check-design-tokens.mjs --self-test  先验证第 4 项真的能分辨好坏样式
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
 * 令牌解析表：把 --color-ink 这类「别名」还原到底层字面量，用来判断
 * color 与 background 是不是同一个颜色。
 *
 * tokens.css 里有多个作用域会重复声明同名令牌（:root 一套，light 工具区的
 * .workspace-header / .asset-panel 又覆盖一套）。判定必须按作用域分开做，
 * 否则 --color-text 会被当成「含义不明」而整条规则弃权 —— 而弃权等于放行，
 * 正是这一点让第一版规则对真实 bug 完全静默。
 *
 * 写法：对每个作用域 + 令牌得到一组候选值。
 *   - 全局唯一值 → 可以直接判定
 *   - 只有 :root 有值 → 继承链上就是这个值，可以判定
 *   - 多个作用域且值不同 → 对每个作用域各判一次，报最具体的那个
 */
const rootValues = new Map(); // :root 里的令牌字面值
const scopedValues = new Map(); // 选择器 -> Map(令牌 -> 字面值)

for (const block of tokenSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = block[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (selector === "") continue;
  const target = new Map();
  for (const decl of block[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    target.set(decl[1], decl[2].trim());
  }
  if (target.size === 0) continue;
  if (selector === ":root") {
    for (const [name, value] of target) rootValues.set(name, value);
  } else {
    scopedValues.set(selector.replace(/\s+/g, " "), target);
  }
}

const RESOLVED_MARKER = "resolve-token:";
const UNRESOLVABLE = "unresolvable";

/** 交互态伪类：这些规则里的同色对是刻意的（如透明底按钮的 hover 变色）。 */
const STATE_PSEUDO = /:(?:hover|focus|focus-visible|focus-within|active|disabled|checked|target)\b/;

/**
 * 同一份样式表里，是否有某个交互态变体为同一个选择器改写了底色。
 * 命中时说明静止态的同色对已被更具体的选择器覆盖，不再当作问题。
 */
function hasStateBackground(cssText, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `${escaped}\\s*:[^{},]*(?:hover|focus|active)[^{},]*\\{[^{}]*background(?:-color)?\\s*:`,
  ).test(cssText);
}

/** 解析单个字面值：别名跟随、颜色字面量归一化，其余（color-mix/渐变）视为无法判定。 */
const literalCache = new Map();
function resolveLiteral(value, lookup, depth = 0) {
  const key = `${depth}::${lookup.id}::${value}`;
  if (literalCache.has(key)) return literalCache.get(key);
  const finish = (result) => {
    literalCache.set(key, result);
    return result;
  };
  if (depth > 8) return finish(UNRESOLVABLE);
  const alias = value.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
  if (alias) {
    const next = lookup.get(alias[1]);
    return finish(next === undefined ? UNRESOLVABLE : resolveLiteral(next, lookup, depth + 1));
  }
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(normalized)) return finish(normalized);
  if (/^(rgb|rgba|hsl|hsla|oklch|oklab)\([^()]*\)$/.test(normalized)) return finish(normalized);
  return finish(UNRESOLVABLE);
}

/** 作用域查找表：全局令牌取 :root，局部令牌先在作用域内找，再回落到 :root。 */
function lookupForScope(selector) {
  const local = scopedValues.get(selector);
  const lookup = {
    id: selector,
    get(name) {
      if (local !== undefined && local.has(name)) return local.get(name);
      return rootValues.get(name);
    },
  };
  return lookup;
}

const GLOBAL_SCOPE = ":root";
const globalLookup = lookupForScope(GLOBAL_SCOPE);
/** 局部作用域只有在真的改写了某个令牌时才需要单独判定。 */
const localScopes = [...scopedValues.keys()].filter((selector) =>
  [...scopedValues.get(selector).keys()].some((name) => rootValues.has(name)),
);

/** 取属性值里的颜色：单一 var() 令牌或单一字面量；无法判定时返回 null。 */
function colorOfValue(value, lookup) {
  const text = value.trim();
  const token = text.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
  if (token) {
    const declaredValue = lookup.get(token[1]);
    if (declaredValue === undefined) return null;
    const resolved = resolveLiteral(declaredValue, lookup);
    return resolved === UNRESOLVABLE ? null : `token${RESOLVED_MARKER}${resolved}`;
  }
  const literal = resolveLiteral(text, lookup);
  return literal === UNRESOLVABLE ? null : `literal:${literal}`;
}

/** 声明块内 color 与 background(-color) 是否指向同一个颜色。 */
function findInvisibleColorPairs(cssText) {
  const hits = [];
  /*
   * 逐对花括号取声明块。不能用「选择器 { 声明 }」一条正则：
   * 声明值里本身带小括号（var(--radius-round)、color-mix()），
   * 靠字符类无法可靠配对 —— 这类写法让第一版规则对真实 bug 完全静默。
   *
   * 也不能只在 depth 0 取块：@media 里的节点样式（响应式放大点击区域等）
   * 会整片漏检。这里对每一层都取块，用父块是否含 `{` 来排除容器块本身。
   */
  const open = [];
  for (let i = 0; i < cssText.length; i += 1) {
    const ch = cssText[i];
    if (ch === "{") {
      open.push(i);
      continue;
    }
    if (ch !== "}" || open.length === 0) continue;
    const start = open.pop();
    const body = cssText.slice(start + 1, i);
    if (body.includes("{")) continue; // 容器块（如 @media），规则在下一层单独检查

    const selector = cssText
      .slice(
        Math.max(cssText.lastIndexOf("{", start - 1), cssText.lastIndexOf("}", start - 1)) + 1,
        start,
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    if (selector.startsWith("@")) continue;

    const declarations = new Map();
    const declarationOffsets = new Map();
    /*
     * 逐行解析声明，而不是整块扫正则。
     *
     * 两个真实踩过的坑：
     *   1. 注释里会写令牌名（「用 --color-ink 会和文字色同值」）。整块扫描时
     *      `--color-ink` 里的 `color` 会被当成属性，它的「值」一直吃到行尾的
     *      分号，于是真正的 color 声明被顶掉，整条规则静默失效。
     *   2. 关键词必须紧跟 `:`。`--color-ink` / `--color-text` 里虽然含
     *      `color`，但后面是 `-` 而不是冒号，逐行匹配天然不会误判。
     * 行内出现多个同名声明时，最后一条生效（与 CSS 层叠一致）。
     *
     * 先把分号就地换成换行，让单行写法 `.a { color: …; background: … }` 也能拆开；
     * 这是等长替换，行号与偏移都不受影响。
     */
    const lines = body.replace(/;/g, "\n").split("\n");
    let lineStart = 0; // 每行在 body 里的起始下标，用于把行内位置换算回绝对偏移
    for (const rawLine of lines) {
      const code = rawLine.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
      const trimmed = code.trim();
      const separator = trimmed.indexOf(":");
      if (trimmed !== "" && separator > 0) {
        const property = trimmed.slice(0, separator).trim();
        // 行尾分号属于语法而不是值：`var(--x);` 会让令牌解析失败
        const value = trimmed
          .slice(separator + 1)
          .trim()
          .replace(/;$/, "")
          .trim();
        if (
          value !== "" &&
          (property === "color" || property === "background" || property === "background-color")
        ) {
          declarations.set(property, value);
          declarationOffsets.set(property, lineStart + code.indexOf(":"));
        }
      }
      lineStart += rawLine.length + 1;
    }
    const color = declarations.get("color");
    const backgroundKey = declarations.has("background") ? "background" : "background-color";
    const background = declarations.get(backgroundKey);
    if (color === undefined || background === undefined) continue;
    /*
     * hover / focus / active 变体在别处改写底色的不算问题：
     * .canvas-add-node-trigger 静止态底色与文字同值，但 :hover 规则用更高
     * 优先级换成深色底，用户看到的是深色底 + 浅色字。
     */
    if (selector !== "" && !STATE_PSEUDO.test(selector) && hasStateBackground(cssText, selector)) {
      continue;
    }

    const key = (v) => v.replace("token" + RESOLVED_MARKER, "").replace(/^literal:/, "");
    /* 默认作用域判一次；若某局部作用域改写了这些令牌，则在该作用域下再判一次。 */
    for (const scope of [GLOBAL_SCOPE, ...localScopes]) {
      const lookup = scope === GLOBAL_SCOPE ? globalLookup : lookupForScope(scope);
      const foreground = colorOfValue(color, lookup);
      const behind = colorOfValue(background, lookup);
      if (foreground === null || behind === null) continue;
      // 令牌与字面量之间的同值（如 --color-ink 与 #f4f4f4）同样要报。
      if (key(foreground) !== key(behind)) continue;
      hits.push({
        property: `color: ${color.trim()} / background: ${background.trim()}`,
        scope,
        // 直接报告 background 声明所在行：这一行才是要改的地方
        line: cssText.slice(0, start + 1 + declarationOffsets.get(backgroundKey)).split("\n")
          .length,
      });
      break; // 同一处声明只报一次
    }
  }
  return hits;
}

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

  /* 4. 前景与底色解析到同一个值：图标或文字会被自己的底色吃掉 */
  for (const hit of findInvisibleColorPairs(css)) {
    errors.push(
      `${rel}:${hit.line}  color 与 background 解析为同一颜色（元素会看不见）：${hit.property}` +
        (hit.scope === GLOBAL_SCOPE ? "" : `（作用域 ${hit.scope}）`),
    );
  }
}

console.log(
  `检查 ${files.length} 个 CSS 文件，${checkedRefs} 处令牌引用，${declared.size} 个已声明令牌。`,
);
if (errors.length > 0) {
  console.error(`\n发现 ${errors.length} 个问题：\n` + errors.map((e) => `  ${e}`).join("\n"));
  process.exit(1);
}

/*
 * 第 4 项是「静默通过」风险最高的一条：它一旦退化成永远不报，检查照样绿灯。
 * 这里用一组内联夹具证明它确实能分辨好坏样式，跑完删除临时文件。
 */
if (process.argv.includes("--self-test")) {
  const CASES = [
    {
      name: "顶层同色",
      expect: 1,
      css: `.a { color: var(--color-text); background: var(--color-ink); }`,
    },
    {
      name: "@media 内的同色",
      expect: 1,
      css: `@media (max-width: 900px) {\n  .a { color: var(--color-text); background: var(--color-ink); }\n}`,
    },
    {
      name: "注释里提到令牌名",
      expect: 1,
      css: `.a {\n  color: var(--color-text);\n  /* 不要用 --color-ink 当底色 */\n  background: var(--color-ink);\n}`,
    },
    {
      name: "有悬停变体改写底色（豁免）",
      expect: 0,
      css: `.a { color: var(--color-text); background: var(--color-ink); }\n.a:hover { background: var(--color-chrome-2); }`,
    },
    {
      name: "取不同令牌",
      expect: 0,
      css: `.a { color: var(--color-text); background: var(--color-chrome-2); }`,
    },
    { name: "透明底", expect: 0, css: `.a { color: var(--color-text); background: transparent; }` },
  ];
  let failed = 0;
  for (const testCase of CASES) {
    const hits = findInvisibleColorPairs(testCase.css);
    const reported = hits.length > 0 ? 1 : 0;
    const ok = reported === testCase.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${testCase.name}（命中 ${hits.length}）`);
  }
  if (failed > 0) {
    console.error(`\n自检不通过：${failed} 项不符合预期 —— 第 4 项检查已不可信。`);
    process.exit(1);
  }
  console.log("第 4 项检查自检通过。");
}
console.log("令牌完整性检查通过。");
