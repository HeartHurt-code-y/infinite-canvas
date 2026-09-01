// 好莱坞格式剧本 — .docx 生成器
//
// 使用方法：
//   1. 将此文件复制到你的工作文件夹，重命名（例如 build_my_scene.js）。
//   2. 在 `screenplay` 数组内通过辅助函数（slug/action/character/dial 等）编写你的场景。
//   3. 运行：NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules node build_my_scene.js
//   4. 在同一文件夹中得到 screenplay.docx。
//
// 好莱坞格式：
//   页面 8.5" x 11"（US Letter）
//   页边距：上 1"、下 1"、左 1.5"、右 1"
//   Courier New 12pt（等宽 → 混合对话/动作时 1页 ≈ 1分钟画面）
//   场景标题：全大写加粗，左对齐
//   动作：左对齐，现在时
//   角色提示：缩进 2.2"（3168 DXA）
//   括号说明：缩进 1.6"（2304 DXA）
//   对话：缩进左1" + 右1.5"（1440 / 2160 DXA）
//   转场：右对齐，全大写

const fs = require("fs");
const docx = require("docx");
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, Header, PageNumber, PageBreak
} = docx;

const FONT = "Courier New";
const SIZE = 24; // 12pt 以 half-points 计

// ============ 辅助函数 ============

// 启用场景自动编号。如果段落不从 1 开始，设置起始编号。
const ENABLE_SCENE_NUMBERS = true;
const START_SCENE_NUMBER = 1;
let _sceneNum = START_SCENE_NUMBER - 1;

function slug(t) {
  let text = t.toUpperCase();
  if (ENABLE_SCENE_NUMBERS) {
    _sceneNum++;
    text = `${_sceneNum}  ${text}`;
  }
  return new Paragraph({
    spacing: { before: 360, after: 240, line: 240 },
    keepNext: true,
    children: [new TextRun({ text, font: FONT, size: SIZE, bold: true })]
  });
}

function action(t) {
  return new Paragraph({
    spacing: { before: 0, after: 240, line: 240 },
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function character(name, ext) {
  const txt = ext ? `${name.toUpperCase()} (${ext})` : name.toUpperCase();
  return new Paragraph({
    spacing: { before: 240, after: 0, line: 240 },
    indent: { left: 3168 }, // 2.2"
    keepNext: true,
    children: [new TextRun({ text: txt, font: FONT, size: SIZE })]
  });
}

function paren(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 2304, right: 2880 }, // 左1.6"，右约2.0"
    keepNext: true,
    children: [new TextRun({ text: t.startsWith("(") ? t : `(${t})`, font: FONT, size: SIZE })]
  });
}

function dial(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 1440, right: 2160 }, // 左1"，右1.5"
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function trans(t) {
  return new Paragraph({
    spacing: { before: 240, after: 240, line: 240 },
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: SIZE, bold: true })]
  });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }
function blank() { return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new TextRun({ text: "", font: FONT, size: SIZE })] }); }

function center(t, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 240, line: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: t, font: FONT, size: opts.size || SIZE, bold: !!opts.bold })]
  });
}

// ============ 你的场景 ============

const screenplay = [
  blank(), blank(),
  center("我的项目", { bold: true, size: 32 }),
  center("场景段落 — 暂定标题"),
  blank(),

  // 场景示例 — 替换为你自己的。
  slug("外景. 地点 — 时段"),
  action("画面中所见内容的描述。只用动作动词。"),
  action("第二个动作，如果需要。"),

  character("主角"),
  dial("主角的台词。"),

  character("第二角色"),
  paren("低声"),
  dial("第二角色的台词。"),

  trans("切至："),

  // 在下方添加你的场景。
];

// ============ 组装 ============

const doc = new Document({
  creator: "编剧",
  title: "剧本",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 }, // 8.5" x 11"
        margin: { top: 1440, right: 1440, bottom: 1440, left: 2160 } // 左1.5"，其余1"
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT, "."], font: FONT, size: 22 })]
        })]
      })
    },
    children: screenplay
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./screenplay.docx";
  fs.writeFileSync(out, buf);
  console.log(`已写入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
