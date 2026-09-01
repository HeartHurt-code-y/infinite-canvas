// 双语剧本 — .docx 生成器
//
// 每句对话 = 两行：
//   1. 主要语言（例如英文）。
//   2. 括号中灰色斜体译文（例如中文）。
//
// 动作、说明和场景标题 — 使用用户选择的语言（见辅助函数区块底部的常量）。
//
// 使用方法：
//   1. 将文件复制到工作文件夹。
//   2. 每句对话通过 ...dialB("英文行", "中文行") 编写。
//   3. NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules node build_bilingual.js

const fs = require("fs");
const docx = require("docx");
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, Header, PageNumber
} = docx;

const FONT = "Courier New";
const SIZE = 24;

// ============ 辅助函数 ============

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
    indent: { left: 3168 },
    keepNext: true,
    children: [new TextRun({ text: txt, font: FONT, size: SIZE })]
  });
}

function paren(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 2304, right: 2880 },
    keepNext: true,
    children: [new TextRun({ text: t.startsWith("(") ? t : `(${t})`, font: FONT, size: SIZE })]
  });
}

function dialMain(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 1440, right: 2160 },
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function dialTranslation(t) {
  return new Paragraph({
    spacing: { before: 0, after: 120, line: 240 },
    indent: { left: 1440, right: 2160 },
    children: [new TextRun({ text: `(${t})`, font: FONT, size: SIZE, italics: true, color: "666666" })]
  });
}

// 主要双语辅助函数：通过展开运算符展开：...dialB("...", "...")
function dialB(main, translation) {
  return [dialMain(main), dialTranslation(translation)];
}

function trans(t) {
  return new Paragraph({
    spacing: { before: 240, after: 240, line: 240 },
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: SIZE, bold: true })]
  });
}

function center(t, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 240, line: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: t, font: FONT, size: opts.size || SIZE, bold: !!opts.bold })]
  });
}

function blank() {
  return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new TextRun({ text: "", font: FONT, size: SIZE })] });
}

// ============ 你的场景 ============

const screenplay = [
  blank(), blank(),
  center("我的项目", { bold: true, size: 32 }),
  center("双语草稿（主语言 / 翻译）"),
  blank(),

  slug("外景. 地点 — 白天"),
  action("场景描述，使用主语言。只用动作动词。"),

  character("主角"),
  ...dialB(
    "主语言对话行。",
    "第二语言的译文。"
  ),

  character("其他角色"),
  paren("低声"),
  ...dialB(
    "另一行。",
    "另一句译文。"
  ),

  trans("切至："),

  // 添加你的场景。
];

// ============ 组装 ============

const doc = new Document({
  creator: "编剧",
  title: "双语剧本",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 2160 }
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
  const out = "./screenplay-bilingual.docx";
  fs.writeFileSync(out, buf);
  console.log(`已写入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
