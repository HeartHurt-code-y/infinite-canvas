// 分集大纲（treatment）— .docx 生成器
//
// 每场戏 = 标题 + 3-5句描述。
// 可选 — 审核标签：⚠ [因果关系] / [价值] / [圣经] / [节奏]
//
// 使用方法：
//   1. 将文件复制到工作文件夹。
//   2. 通过 scene("标题", "描述") 填充 `treatment` 数组。
//   3. NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules node build_treatment.js

const fs = require("fs");
const docx = require("docx");
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel, Header, PageNumber
} = docx;

const FONT = "Calibri";
const SIZE = 22; // 11pt

let _sceneNum = 0;

function act(title) {
  return new Paragraph({
    spacing: { before: 480, after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title.toUpperCase(), font: FONT, size: 32, bold: true })]
  });
}

function scene(title, body, audit) {
  _sceneNum++;
  const titlePara = new Paragraph({
    spacing: { before: 360, after: 60 },
    children: [
      new TextRun({ text: `场 ${_sceneNum}. `, font: FONT, size: SIZE, bold: true }),
      new TextRun({ text: title, font: FONT, size: SIZE, bold: true })
    ]
  });
  const bodyPara = new Paragraph({
    spacing: { before: 0, after: 120, line: 280 },
    children: [new TextRun({ text: body, font: FONT, size: SIZE })]
  });
  const out = [titlePara, bodyPara];
  if (audit) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 240, line: 280 },
      children: [new TextRun({ text: `⚠ ${audit}`, font: FONT, size: SIZE - 2, italics: true, color: "C00000" })]
    }));
  }
  return out;
}

// ============ 分集大纲 ============

const treatment = [
  new Paragraph({
    spacing: { after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "项目标题", font: FONT, size: 44, bold: true })]
  }),
  new Paragraph({
    spacing: { after: 480 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "分集大纲 v1", font: FONT, size: 24, italics: true })]
  }),

  act("第一幕"),

  ...scene(
    "地点 — 时间 — 状态",
    "3-5句：发生了什么，谁在场，什么价值入场，发生什么动作，什么价值出场。具体的动作动词，禁止情绪描述。"
  ),

  ...scene(
    "下一场戏",
    "如果结构有问题，这里可以有审核标签。",
    "[因果关系] 这场戏不跟随前一场 — 需要一座桥。"
  ),

  // 在下方添加你的场景。
  // 使用 act("第二幕")、act("第三幕") 作为分隔符。
];

// ============ 组装 ============

const doc = new Document({
  creator: "编剧",
  title: "分集大纲",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })]
        })]
      })
    },
    children: treatment
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./treatment.docx";
  fs.writeFileSync(out, buf);
  console.log(`已写入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
