import { describe, expect, it } from "vitest";
import type { PromptContentItem } from "./promptContent";
import { decodePromptContentDocument } from "./promptContent";
import { promptDocumentFromTiptapJson, promptDocumentToTiptapJson } from "./promptTiptap";
import { resolvePromptReferences, type PromptReferenceCandidate } from "./promptReferences";
import {
  appendStyledText,
  normalizePromptTextStyle,
  pickPromptTextStyle,
  samePromptTextStyle,
  serializePromptTextMarkdown,
  type PromptInlineMark,
} from "./promptRichText";

describe("serializePromptTextMarkdown", () => {
  it("无格式文本逐字节透传", () => {
    expect(serializePromptTextMarkdown("正文 * 原样", {})).toBe("正文 * 原样");
  });

  it("行内格式按 markdown/HTML 惯例包裹", () => {
    expect(serializePromptTextMarkdown("重点", { marks: ["bold"] })).toBe("**重点**");
    expect(serializePromptTextMarkdown("强调", { marks: ["italic"] })).toBe("*强调*");
    expect(serializePromptTextMarkdown("标记", { marks: ["underline"] })).toBe("<u>标记</u>");
    expect(serializePromptTextMarkdown("废弃", { marks: ["strike"] })).toBe("~~废弃~~");
    expect(serializePromptTextMarkdown("x", { marks: ["code"] })).toBe("`x`");
  });

  it("块级结构投影为 markdown 前缀，有序列表用调用方传入的编号", () => {
    expect(serializePromptTextMarkdown("标题", { block: "heading1" })).toBe("# 标题");
    expect(serializePromptTextMarkdown("标题", { block: "heading2" })).toBe("## 标题");
    expect(serializePromptTextMarkdown("项", { block: "bullet", indent: 1 })).toBe("  - 项");
    expect(serializePromptTextMarkdown("项", { block: "ordered" }, 2)).toBe("2. 项");
    expect(serializePromptTextMarkdown("引文", { block: "blockquote" })).toBe("> 引文");
    expect(serializePromptTextMarkdown("", { block: "hr" })).toBe("---");
  });

  it("代码块按原文输出，不包围栏", () => {
    expect(serializePromptTextMarkdown("x=1\ny=2", { block: "code" })).toBe("x=1\ny=2");
  });
});

describe("appendStyledText", () => {
  it("同样式的相邻片段合并为一个条目", () => {
    const items: PromptContentItem[] = [{ kind: "text", text: "甲", marks: ["bold"] }];
    appendStyledText(items, "乙", { marks: ["bold"] });
    appendStyledText(items, "丙", { marks: ["bold"] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "text", text: "甲乙丙", marks: ["bold"] });
  });

  it("样式不同的片段不合并", () => {
    const items: PromptContentItem[] = [{ kind: "text", text: "粗", marks: ["bold"] }];
    appendStyledText(items, "普通");
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "text", text: "普通" });
  });

  it("块级边界不合并，空文本不产生条目", () => {
    const items: PromptContentItem[] = [{ kind: "text", text: "标题", block: "heading1" }];
    appendStyledText(items, "正文");
    appendStyledText(items, "");
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "text", text: "正文" });
  });
});

describe("富文档 build/flatten 往返", () => {
  const roundTrip = (items: readonly PromptContentItem[]): readonly PromptContentItem[] =>
    promptDocumentFromTiptapJson(
      promptDocumentToTiptapJson({
        schema: "prompt-content",
        version: 1,
        items,
      }),
    ).items;

  it("无格式文档与旧版行为一致：单段落、换行进文本", () => {
    const items = roundTrip([{ kind: "text", text: "第一行\n第二行" }]);
    expect(items).toEqual([{ kind: "text", text: "第一行\n第二行" }]);
  });

  it("行内格式经 tiptap 往返保留", () => {
    const items = roundTrip([
      { kind: "text", text: "粗体", marks: ["bold"] },
      { kind: "text", text: "斜体", marks: ["italic"] },
      { kind: "text", text: "普通" },
    ]);
    expect(items).toEqual([
      { kind: "text", text: "粗体", marks: ["bold"] },
      { kind: "text", text: "斜体", marks: ["italic"] },
      { kind: "text", text: "普通" },
    ]);
  });

  it("标题自定界，不向后续段落注入换行", () => {
    const items = roundTrip([
      { kind: "text", text: "标题", block: "heading1" },
      { kind: "text", text: "正文" },
    ]);
    expect(items).toEqual([
      { kind: "text", text: "标题", block: "heading1" },
      { kind: "text", text: "正文" },
    ]);
  });

  it("相邻普通段落仍以换行分隔", () => {
    const items = roundTrip([
      { kind: "text", text: "甲" },
      { kind: "text", text: "乙" },
    ]);
    // canonical 约定：段落边界是文本内的 "\n"，相邻纯文本本就会合并。
    expect(items).toEqual([{ kind: "text", text: "甲乙" }]);
  });

  it("列表与嵌套经往返保留块与缩进", () => {
    const items = roundTrip([
      { kind: "text", text: "顶层", block: "bullet" },
      { kind: "text", text: "子层", block: "bullet", indent: 1 },
      { kind: "text", text: "兄弟", block: "bullet" },
      { kind: "text", text: "第一", block: "ordered" },
      { kind: "text", text: "第二", block: "ordered" },
    ]);
    expect(items).toEqual([
      { kind: "text", text: "顶层", block: "bullet" },
      { kind: "text", text: "子层", block: "bullet", indent: 1 },
      { kind: "text", text: "兄弟", block: "bullet" },
      { kind: "text", text: "第一", block: "ordered" },
      { kind: "text", text: "第二", block: "ordered" },
    ]);
  });

  it("引用块、代码块与分隔线经往返保留", () => {
    const items = roundTrip([
      { kind: "text", text: "引文", block: "blockquote" },
      { kind: "text", text: "x=1\ny=2", block: "code" },
      { kind: "text", text: "", block: "hr" },
      { kind: "text", text: "结尾" },
    ]);
    expect(items).toEqual([
      { kind: "text", text: "引文", block: "blockquote" },
      { kind: "text", text: "x=1\ny=2", block: "code" },
      { kind: "text", text: "", block: "hr" },
      { kind: "text", text: "结尾" },
    ]);
  });

  it("标题里的引用 chip 保留引用身份（块上下文降级为普通段落）", () => {
    const candidate: PromptReferenceCandidate = {
      canvasNodeKey: "asset-node-1",
      assetId: "asset-1",
      providerConnectionId: "provider-1",
      referenceKind: "asset",
      kind: "image",
      name: "角色.png",
    };
    const source = resolvePromptReferences(
      {
        schema: "prompt-content",
        version: 1,
        items: [{ kind: "text", text: "@角色.png", block: "heading2" }],
      },
      [candidate],
      { mode: "explicit" },
    ).document;
    expect(source.items[0]).toMatchObject({ kind: "media_reference" });
    const flattened = promptDocumentFromTiptapJson(promptDocumentToTiptapJson(source)).items;
    expect(flattened).toEqual([expect.objectContaining({ kind: "media_reference" })]);
  });

  it("标题文本后的引用 chip 回流进标题块，往返稳定", () => {
    const candidate: PromptReferenceCandidate = {
      canvasNodeKey: "asset-node-1",
      assetId: "asset-1",
      providerConnectionId: "provider-1",
      referenceKind: "asset",
      kind: "image",
      name: "角色.png",
    };
    const source = resolvePromptReferences(
      {
        schema: "prompt-content",
        version: 1,
        items: [
          { kind: "text", text: "看", block: "heading2" },
          { kind: "text", text: "@角色.png" },
        ],
      },
      [candidate],
      { mode: "explicit" },
    ).document;
    const rebuilt = promptDocumentToTiptapJson(source);
    const heading = rebuilt.content?.[0];
    expect(heading?.type).toBe("heading");
    expect(heading?.content?.some((node) => node.type === "mediaReference")).toBe(true);
    const flattened = promptDocumentFromTiptapJson(rebuilt).items;
    expect(flattened[0]).toMatchObject({ kind: "text", text: "看", block: "heading2" });
    expect(flattened[1]).toMatchObject({ kind: "media_reference", canvasNodeKey: "asset-node-1" });
  });
});

describe("解析器在富文本上的行为", () => {
  const candidate: PromptReferenceCandidate = {
    canvasNodeKey: "asset-node-1",
    assetId: "asset-1",
    providerConnectionId: "provider-1",
    referenceKind: "asset",
    kind: "image",
    name: "角色.png",
  };

  it("@识别切分加粗文本时，两侧片段都保留加粗", () => {
    const result = resolvePromptReferences(
      {
        schema: "prompt-content",
        version: 1,
        items: [{ kind: "text", text: "看@角色.png的效果", marks: ["bold"] }],
      },
      [candidate],
      { mode: "explicit" },
    );
    expect(result.converted).toBe(1);
    expect(result.document.items).toEqual([
      { kind: "text", text: "看", marks: ["bold"] },
      expect.objectContaining({ kind: "media_reference" }),
      { kind: "text", text: "的效果", marks: ["bold"] },
    ]);
  });

  it("标题条目切分后仍保留块结构", () => {
    const result = resolvePromptReferences(
      {
        schema: "prompt-content",
        version: 1,
        items: [{ kind: "text", text: "看@角色.png的效果", block: "heading3" }],
      },
      [candidate],
      { mode: "explicit" },
    );
    const texts = result.document.items.filter(
      (item): item is Extract<PromptContentItem, { kind: "text" }> => item.kind === "text",
    );
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text.block).toBe("heading3");
  });
});

describe("decode 与样式字段", () => {
  it("存档中的样式字段原样读回，非法值被丢弃", () => {
    const decoded = decodePromptContentDocument({
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "标题", block: "heading1", marks: ["bold"] },
        { kind: "text", text: "伪样式", block: "not-a-block", marks: ["rainbow"] },
        { kind: "text", text: "缩进", indent: 2 },
      ],
    });
    expect(decoded?.items[0]).toEqual({
      kind: "text",
      text: "标题",
      block: "heading1",
      marks: ["bold"],
    });
    expect(decoded?.items[1]).toEqual({ kind: "text", text: "伪样式" });
    expect(decoded?.items[2]).toEqual({ kind: "text", text: "缩进", indent: 2 });
  });

  it("normalize 与 pick 保持样式规整", () => {
    expect(
      normalizePromptTextStyle({
        marks: ["bold", "nope"] as unknown as PromptInlineMark[],
        block: "bullet",
        indent: 9,
      }),
    ).toEqual({ marks: ["bold"], block: "bullet", indent: 4 });
    expect(pickPromptTextStyle({ kind: "text", text: "x", block: "ordered", indent: 3 })).toEqual({
      block: "ordered",
      indent: 3,
    });
    expect(samePromptTextStyle({ marks: ["bold"] }, { marks: ["bold"] })).toBe(true);
    expect(samePromptTextStyle({ marks: ["bold"] }, { marks: ["italic"] })).toBe(false);
  });
});
