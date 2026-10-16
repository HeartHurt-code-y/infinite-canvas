import { describe, expect, it } from "vitest";
import type { CanvasNodeEntry } from "../../canvas/canvasStore";
import {
  describeCanvasNodeRef,
  remarkCanvasNodeRefs,
  splitCanvasNodeKeyText,
  type CanvasNodeKeyToken,
} from "./agentNodeKeyRefs";

/**
 * 节点代号识别的两个口径缺一不可：形状（workspaceModel 的 key 工厂模式）挡住
 * `asset-photo` 这类普通词，存在性（当前画布节点集合）挡住已删除的代号。
 * remark 插件还要保证链接/代码块里的候选不被误切。
 */

const entry = (type: string, data: Record<string, unknown>) =>
  ({ type, data }) as unknown as CanvasNodeEntry;

const known = (keys: readonly string[]) => (key: string) => keys.includes(key);

function collectRefNodes(node: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current == null || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record["type"] === "canvasNodeRef") found.push(record);
    if (Array.isArray(record["children"])) visit(record["children"]);
  };
  visit(node);
  return found;
}

describe("splitCanvasNodeKeyText", () => {
  it("命中当前画布的代号切成 nodeRef，前后文本原样保留", () => {
    const tokens = splitCanvasNodeKeyText(
      "已连接 gen-zwifggx4 用作风格参考",
      known(["gen-zwifggx4"]),
    );
    expect(tokens).toEqual([
      { kind: "text", value: "已连接 " },
      { kind: "nodeRef", key: "gen-zwifggx4" },
      { kind: "text", value: " 用作风格参考" },
    ]);
  });

  it("形状匹配但不在当前画布的候选保持纯文本", () => {
    const text = "节点 gen-zwifggx4 已被删除";
    expect(splitCanvasNodeKeyText(text, known([]))).toEqual([{ kind: "text", value: text }]);
  });

  it("普通词与文件名不误判：asset-photo、screenplay-draft 不是节点", () => {
    const tokens = splitCanvasNodeKeyText(
      "把 asset-photo.png 和 screenplay-draft 一起看",
      known([]),
    );
    expect(tokens.some((token) => token.kind === "nodeRef")).toBe(false);
    expect(
      tokens.map((token) => (token.kind === "text" ? token.value : "")).join(""),
    ).toBe("把 asset-photo.png 和 screenplay-draft 一起看");
  });

  it("边界贴紧整个 token：前后多一个字母数字或连字符都不算", () => {
    for (const text of [
      "xgen-ab12cd34",
      "gen-ab12cd34x",
      "gen-ab12cd34-extra",
      "my-gen-ab12cd34",
      "Gen-ab12cd34",
    ]) {
      expect(splitCanvasNodeKeyText(text, known(["gen-ab12cd34"]))).toEqual([
        { kind: "text", value: text },
      ]);
    }
    for (const text of ["（gen-ab12cd34）", "代号 gen-ab12cd34，", "**gen-ab12cd34**"]) {
      expect(splitCanvasNodeKeyText(text, known(["gen-ab12cd34"]))).toEqual([
        expect.objectContaining({ kind: "text" }),
        { kind: "nodeRef", key: "gen-ab12cd34" },
        expect.objectContaining({ kind: "text" }),
      ]);
    }
  });

  it("覆盖全部节点 key 前缀", () => {
    const keys = [
      "asset-a1b2c3d4",
      "gen-a1b2c3d4",
      "output-a1b2c3d4",
      "composer-a1b2c3d4",
      "downloader-a1b2c3d4",
      "frame-extractor-a1b2c3d4",
      "screenplay-a1b2c3d4",
      "storyboard-a1b2c3d4",
      "viral-remix-a1b2c3d4",
      "knowledge-video-a1b2c3d4",
    ];
    const tokens = splitCanvasNodeKeyText(keys.join("、"), known(keys));
    expect(tokens.filter((token): token is Extract<CanvasNodeKeyToken, { kind: "nodeRef" }> =>
      token.kind === "nodeRef",
    ).map((token) => token.key)).toEqual(keys);
  });

  it("计划内部引用（$步骤id、canvas-agent: 前缀）不误判", () => {
    const tokens = splitCanvasNodeKeyText("$step1 canvas-agent:canvas-x", known([]));
    expect(tokens.every((token) => token.kind === "text")).toBe(true);
  });
});

describe("describeCanvasNodeRef", () => {
  it("生成节点按 kind 区分图文视频，名称可读", () => {
    expect(
      describeCanvasNodeRef(
        entry("gen", { kind: "video", name: "特效镜头" }),
      ).label,
    ).toBe("视频生成「特效镜头」");
    expect(describeCanvasNodeRef(entry("gen", { kind: "image" })).label).toBe("图片生成节点");
    expect(describeCanvasNodeRef(entry("gen", { kind: "prompt" })).label).toBe("提示词节点");
  });

  it("无名称节点退回种类称谓", () => {
    expect(
      describeCanvasNodeRef(entry("videoDownloader", { config: { url: "" } })).label,
    ).toBe("视频下载节点");
    expect(describeCanvasNodeRef(entry("result", {})).label).toBe("结果节点");
  });

  it("合成节点读 outputName，输出节点优先用户改名", () => {
    expect(
      describeCanvasNodeRef(
        entry("videoComposer", { config: { outputName: "成片A", inputOrder: [] } }),
      ).label,
    ).toBe("视频合成「成片A」");
    expect(
      describeCanvasNodeRef(
        entry("output", { customName: "主图", name: "image_01.png" }),
      ).label,
    ).toBe("输出「主图」");
    expect(
      describeCanvasNodeRef(
        entry("output", { customName: "", name: "image_01.png" }),
      ).label,
    ).toBe("输出「image_01.png」");
  });
});

describe("remarkCanvasNodeRefs", () => {
  const plugin = remarkCanvasNodeRefs({ isKnownNodeKey: known(["gen-ab12cd34"]) });

  it("段落文本里的命中代号替换为 button 芯片节点", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "已连接 gen-ab12cd34 作为参考。" }],
        },
      ],
    };
    plugin(tree);
    const refs = collectRefNodes(tree);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: "canvasNodeRef",
      key: "gen-ab12cd34",
      data: {
        hName: "button",
        hProperties: {
          type: "button",
          className: ["canvas-node-chip"],
          "data-node-key": "gen-ab12cd34",
        },
      },
    });
  });

  it("链接的 URL 与锚文本整体跳过，不切芯片", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com/gen-ab12cd34",
              children: [{ type: "text", value: "查看 gen-ab12cd34" }],
            },
          ],
        },
      ],
    };
    plugin(tree);
    expect(collectRefNodes(tree)).toHaveLength(0);
  });

  it("行内代码整段是代号才升级；夹在更长代码或未知代号时保持原样", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "inlineCode", value: "gen-ab12cd34" },
            { type: "text", value: " 与 " },
            { type: "inlineCode", value: "run gen-ab12cd34 --force" },
            { type: "text", value: " 与 " },
            { type: "inlineCode", value: "gen-zzzz9999" },
          ],
        },
      ],
    };
    plugin(tree);
    const refs = collectRefNodes(tree);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ key: "gen-ab12cd34" });
  });

  it("块级代码与标题里的文本同样按规则处理，代码块永不切分", () => {
    const tree = {
      type: "root",
      children: [
        { type: "code", value: "gen-ab12cd34" },
        { type: "heading", depth: 2, children: [{ type: "text", value: "gen-ab12cd34 的进展" }] },
      ],
    };
    plugin(tree);
    const refs = collectRefNodes(tree);
    expect(refs).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ type: "code", value: "gen-ab12cd34" });
  });
});
