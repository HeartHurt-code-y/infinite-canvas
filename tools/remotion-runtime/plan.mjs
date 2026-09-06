export const TEMPLATE_IDS = [
  "cycle-flowchart",
  "morandi-grid",
  "cute-flowchart",
  "compare-flowchart",
  "skills-flowchart",
  "terminal-flowchart",
  "person-card",
  "timeline",
  "code-showcase",
  "pie-chart",
  "custom",
];

function fail(message) {
  throw new Error(`动画方案无效：${message}`);
}
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${field} 必须为 ${min}–${max} 的整数`);
  return value;
}
function string(value, max, field, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()) || [...value].length > max)
    fail(`${field} 必须为 1–${max} 字文本`);
  return value;
}
function color(value, field) {
  if (typeof value !== "string" || !/^#[a-f\d]{6}$/i.test(value))
    fail(`${field} 必须为六位十六进制颜色`);
  return value;
}
function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} 必须为对象`);
}
function keys(value, allowed, field) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${field} 含有不支持的字段`);
}

// Reconstruct an allowlisted data object. Model output is never interpreted as code or CSS.
export function validatePlan(raw) {
  record(raw, "方案");
  keys(
    raw,
    [
      "schemaVersion",
      "template",
      "title",
      "subtitle",
      "width",
      "height",
      "fps",
      "durationInFrames",
      "background",
      "palette",
      "elements",
      "connections",
      "staggerFrames",
      "holdFrames",
      "springDamping",
    ],
    "方案",
  );
  if (raw.schemaVersion !== "animation-plan.v1") fail("不支持的 schemaVersion");
  if (!TEMPLATE_IDS.includes(raw.template)) fail("不支持的模板");
  const width = integer(raw.width, 320, 1920, "width");
  const height = integer(raw.height, 320, 1920, "height");
  if (width % 2 || height % 2) fail("画面宽高必须为偶数");
  if (raw.fps !== 30) fail("fps 必须为 30");
  const durationInFrames = integer(raw.durationInFrames, 90, 900, "durationInFrames");
  const holdFrames = integer(raw.holdFrames, 60, durationInFrames - 30, "holdFrames");
  const staggerFrames = integer(raw.staggerFrames, 1, 60, "staggerFrames");
  const springDamping = integer(raw.springDamping, 8, 200, "springDamping");
  if (!Array.isArray(raw.palette) || raw.palette.length < 1 || raw.palette.length > 8)
    fail("palette 需要 1–8 种颜色");
  if (!Array.isArray(raw.elements) || raw.elements.length < 1 || raw.elements.length > 12)
    fail("elements 需要 1–12 个元素");
  if ((raw.elements.length - 1) * staggerFrames + 30 > durationInFrames - holdFrames)
    fail("入场时间过长，必须为最后静止画面保留至少 60 帧");
  const ids = new Set();
  const elements = raw.elements.map((item, index) => {
    record(item, `elements[${index}]`);
    keys(item, ["id", "label", "detail", "value", "group", "x", "y", "width", "height"], "元素");
    const id = string(item.id, 48, "元素 id");
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) fail("元素 id 仅允许英文字母、数字、下划线与连字符");
    if (ids.has(id)) fail("元素 id 不能重复");
    ids.add(id);
    const result = { id, label: string(item.label, 40, "元素 label") };
    for (const [key, max] of [
      ["detail", 240],
      ["group", 40],
    ]) {
      const value = string(item[key], max, `元素 ${key}`, true);
      if (value !== undefined) result[key] = value;
    }
    if (item.value !== undefined) {
      if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0)
        fail("数值必须为非负有限数字");
      result.value = item.value;
    }
    const coordinates = ["x", "y", "width", "height"];
    if (raw.template === "custom" || coordinates.some((key) => item[key] !== undefined)) {
      for (const key of coordinates) {
        const value = item[key];
        if (typeof value !== "number" || !Number.isFinite(value))
          fail("自定义元素需要完整的 x/y/width/height 像素坐标");
        result[key] = value;
      }
      if (
        item.x < 0 ||
        item.y < 0 ||
        item.width < 40 ||
        item.height < 40 ||
        item.x + item.width > width ||
        item.y + item.height > height
      )
        fail("自定义元素必须位于画布内且大小至少为 40×40");
    }
    return result;
  });
  if (
    raw.template === "pie-chart" &&
    (elements.some((item) => item.value === undefined) ||
      !Number.isFinite(elements.reduce((sum, item) => sum + item.value, 0)) ||
      elements.reduce((sum, item) => sum + item.value, 0) <= 0)
  )
    fail("饼图每项都需要真实非负数值，合计必须为大于 0 的有限数字");
  if (!Array.isArray(raw.connections) || raw.connections.length > 24)
    fail("connections 必须为不超过 24 条连线的数组");
  const edgeIds = new Set();
  const connections = raw.connections.map((item) => {
    record(item, "连线");
    keys(item, ["from", "to", "label"], "连线");
    if (!ids.has(item.from) || !ids.has(item.to) || item.from === item.to)
      fail("连线必须引用两个不同的已存在元素");
    const key = JSON.stringify([item.from, item.to]);
    if (edgeIds.has(key)) fail("连线不能重复");
    edgeIds.add(key);
    const result = { from: item.from, to: item.to };
    const label = string(item.label, 40, "连线 label", true);
    if (label !== undefined) result.label = label;
    return result;
  });
  return {
    schemaVersion: "animation-plan.v1",
    template: raw.template,
    title: string(raw.title, 60, "title"),
    ...(raw.subtitle === undefined
      ? {}
      : { subtitle: string(raw.subtitle, 160, "subtitle", true) }),
    width,
    height,
    fps: 30,
    durationInFrames,
    background: color(raw.background, "background"),
    palette: raw.palette.map((item) => color(item, "palette")),
    elements,
    connections,
    staggerFrames,
    holdFrames,
    springDamping,
  };
}

export const EXAMPLE_PLAN = {
  schemaVersion: "animation-plan.v1",
  template: "cycle-flowchart",
  title: "从想法到交付",
  subtitle: "清晰表达每一步，让知识流动起来",
  width: 800,
  height: 600,
  fps: 30,
  durationInFrames: 180,
  background: "#f4f6f4",
  palette: ["#386b60", "#977957", "#536b94", "#8d6077"],
  elements: [
    { id: "idea", label: "整理想法", detail: "聚焦目标与读者" },
    { id: "structure", label: "构建结构", detail: "串联关键关系" },
    { id: "create", label: "生成动画", detail: "让信息逐步呈现" },
    { id: "deliver", label: "完成交付", detail: "导出动图与视频" },
  ],
  connections: [
    { from: "idea", to: "structure" },
    { from: "structure", to: "create" },
    { from: "create", to: "deliver" },
    { from: "deliver", to: "idea" },
  ],
  staggerFrames: 15,
  holdFrames: 60,
  springDamping: 18,
};
