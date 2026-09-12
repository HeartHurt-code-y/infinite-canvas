import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCanvasState, type CanvasNodeEntry } from "../canvas/canvasStore";
import { createCanvasInputResolver } from "./canvasInputs";
import { GenerationInputChips } from "./MediaNodeViews";
import type { AssetEdgeData, AssetNodeData, GenNodeData, ImageNodeConfig } from "./workspaceModel";

const model = { providerId: "provider", modelDefinitionId: "model" };
const imageNode = (key: string): AssetNodeData => ({
  key,
  assetId: `library-${key}`,
  providerConnectionId: "provider",
  kind: "image",
  name: key,
  previewUrl: null,
  videoUrl: null,
  x: 0,
  y: 0,
});
const imageGenerator = (key: string): GenNodeData => ({
  key,
  kind: "image",
  x: 0,
  y: 0,
  config: {
    modelSelection: model,
    generationCount: 1,
    parameterValues: {},
    catalogResolved: true,
  },
});
/** 带槽位账本的图片生成节点；槽位表按文档原样写入，用于复现残留/重复槽位。 */
const imageGeneratorWithSlots = (
  key: string,
  inputSlots: readonly (string | null)[],
): GenNodeData => {
  const config: ImageNodeConfig = {
    modelSelection: model,
    generationCount: 1,
    parameterValues: {},
    catalogResolved: true,
    inputSlots,
  };
  return { key, kind: "image", x: 0, y: 0, config };
};
const edge = (fromKey: string, toKey: string): AssetEdgeData => ({
  id: `${fromKey}->${toKey}`,
  fromKey,
  toKey,
});

/** 读取生成节点参考素材清单上渲染的编号与素材名。 */
function chipRows(container: HTMLElement): { order: string; name: string }[] {
  const list = container.querySelector<HTMLElement>(".node-media-inputs");
  expect(list).not.toBeNull();
  return Array.from(list!.querySelectorAll("li")).map((item) => ({
    order: item.querySelector(".node-media-chip__order")?.textContent ?? "",
    name: item.querySelector(".node-media-chip__name")?.textContent ?? "",
  }));
}

describe("生成节点参考素材的传入顺序编号", () => {
  it("编号连续对应渲染顺序，不因槽位表残留空位而跳号或重号", () => {
    // 真实画布上出现过的形态：素材 A 占槽位 0，槽位 1 残留着已删除/已解绑的 key，
    // 素材 C 占槽位 2，再后来连入的 D 没有槽位，只能按原位附在清单末尾。
    // 旧实现拿槽位下标（A=1、C=3）和数组下标（D=3）当编号，结果渲染成 1、1、3。
    const inputs = [
      {
        key: "asset-a",
        name: "A",
        kind: "image" as const,
        edgeId: "a->gen",
        sourceLabel: "素材" as const,
        previewUrl: null,
      },
      {
        key: "asset-c",
        name: "C",
        kind: "image" as const,
        edgeId: "c->gen",
        sourceLabel: "素材" as const,
        previewUrl: null,
      },
      {
        key: "asset-d",
        name: "D",
        kind: "image" as const,
        edgeId: "d->gen",
        sourceLabel: "素材" as const,
        previewUrl: null,
      },
    ];
    render(<GenerationInputChips inputs={inputs} onUnlink={vi.fn()} />);

    expect(chipRows(document.body)).toEqual([
      { order: "1", name: "A" },
      { order: "2", name: "C" },
      { order: "3", name: "D" },
    ]);
    // 无障碍标签与可见编号保持一致，方便 @ 引用时对号入座。
    expect(screen.getByLabelText("参考素材传入顺序 2")).toHaveTextContent("2");
  });

  it("直连素材与随提示词继承的素材混排时仍按位置连续编号", () => {
    const inputs = [
      {
        key: "asset-a",
        name: "A",
        kind: "image" as const,
        edgeId: "a->gen",
        sourceLabel: "素材" as const,
        previewUrl: null,
      },
      {
        key: "asset-inherited",
        name: "继承图",
        kind: "image" as const,
        promptNodeKey: "prompt-1",
        previewUrl: null,
      },
      {
        key: "asset-c",
        name: "C",
        kind: "image" as const,
        edgeId: "c->gen",
        sourceLabel: "产物" as const,
        previewUrl: null,
      },
    ];
    render(<GenerationInputChips inputs={inputs} onUnlink={vi.fn()} />);

    expect(chipRows(document.body)).toEqual([
      { order: "1", name: "A" },
      { order: "2", name: "继承图" },
      { order: "3", name: "C" },
    ]);
  });
});

describe("inputSlots 槽位账本", () => {
  it("删除素材节点后把它的槽位清成空槽，其余素材顺序与连线保持不变", () => {
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        { type: "gen", data: imageGenerator("gen") },
        { type: "asset", data: imageNode("asset-a") },
        { type: "asset", data: imageNode("asset-b") },
        { type: "asset", data: imageNode("asset-c") },
      ],
      [],
    );
    // 连线走 store 的 connect 动作，槽位按连线顺序分配（画布上的正常路径）。
    for (const key of ["asset-a", "asset-b", "asset-c"]) {
      expect(canvas.commands.connect(key, "gen")).toMatchObject({ status: "connected" });
    }
    const connected = canvas.getSnapshot();
    expect(connected.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", "asset-b", "asset-c"] },
    });

    canvas.commands.removeNode("asset-b");

    const afterRemove = canvas.getSnapshot();
    // 槽位保留位置不压缩：中间留空槽，避免后续素材整体前移改变既有顺序。
    expect(afterRemove.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", null, "asset-c"] },
    });
    expect(afterRemove.graph.edges.map((item) => item.id)).toEqual([
      "asset-a->gen",
      "asset-c->gen",
    ]);

    // 新素材填最小空槽：画布上看到的清单顺序与实际提交顺序都是 A、D、C。
    canvas.commands.insertSubgraph([{ type: "asset", data: imageNode("asset-d") }], []);
    canvas.commands.connect("asset-d", "gen");
    const afterFill = canvas.getSnapshot();
    expect(afterFill.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", "asset-d", "asset-c"] },
    });
    expect(
      createCanvasInputResolver(
        afterFill.nodeByKey,
        afterFill.graph.edges,
      )("gen").media.map((input) => input.key),
    ).toEqual(["asset-a", "asset-d", "asset-c"]);
  });

  it("槽位表残留指向已不存在节点的 key 时，不占用排序位置把真实素材挤到后面", () => {
    const entries: CanvasNodeEntry[] = [
      {
        type: "gen",
        data: imageGeneratorWithSlots("gen", ["asset-a", "asset-deleted", "asset-c"]),
      },
      { type: "asset", data: imageNode("asset-a") },
      { type: "asset", data: imageNode("asset-c") },
      { type: "asset", data: imageNode("asset-d") },
    ];
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(entries, [
      edge("asset-a", "gen"),
      edge("asset-c", "gen"),
      edge("asset-d", "gen"),
    ]);
    const snapshot = canvas.getSnapshot();
    // 悬挂 key 既不在素材里也不在连线里，排序必须忽略它：A 保持第 1，其余按原始顺序接在后面。
    expect(
      createCanvasInputResolver(
        snapshot.nodeByKey,
        snapshot.graph.edges,
      )("gen").media.map((input) => input.key),
    ).toEqual(["asset-a", "asset-c", "asset-d"]);
  });

  it("悬挂槽位不把无槽位素材挤到前面，提交顺序与画布清单一致", () => {
    // 用户真实文档的形态：槽位表是 [A, 已删除节点的 key, B]，连线却是 A、B、C 三条，
    // C 因为走的是另一条建线入口（拖线建节点等）没有进槽位表。
    // 旧解析器保留悬挂 key 的位置：A→1、B→3，无槽位的 C 也是 3，
    // 于是 C 与 B 争夺同一排序位，实际提交顺序不再是清单上的 A、B、C。
    // 新解析器丢弃悬挂 key 后按现有素材压缩序号：A→1、B→2，C 无槽位仍排在最后。
    const entries: CanvasNodeEntry[] = [
      {
        type: "gen",
        data: imageGeneratorWithSlots("gen", ["asset-a", "asset-deleted", "asset-b"]),
      },
      { type: "asset", data: imageNode("asset-a") },
      { type: "asset", data: imageNode("asset-b") },
      { type: "asset", data: imageNode("asset-c") },
    ];
    const canvas = createCanvasState();
    // 连线按 A、B、C 写入，C 没有槽位：模拟"槽位表与连线不同步"的旧文档。
    canvas.commands.insertSubgraph(entries, [
      edge("asset-a", "gen"),
      edge("asset-b", "gen"),
      edge("asset-c", "gen"),
    ]);
    const snapshot = canvas.getSnapshot();
    // insertSubgraph 不写槽位，槽位表保持文档里带进来的残留形态。
    expect(snapshot.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", "asset-deleted", "asset-b"] },
    });
    const resolved = createCanvasInputResolver(snapshot.nodeByKey, snapshot.graph.edges)("gen");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-a", "asset-b", "asset-c"]);
    expect(resolved.media.map((input) => input.edgeId)).toEqual([
      "asset-a->gen",
      "asset-b->gen",
      "asset-c->gen",
    ]);
  });

  it("同一素材 key 重复占槽时以首个槽位为准，仍然连续排在最前", () => {
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: imageGeneratorWithSlots("gen", ["asset-a", "asset-b", "asset-a"]) },
      { type: "asset", data: imageNode("asset-a") },
      { type: "asset", data: imageNode("asset-b") },
      { type: "asset", data: imageNode("asset-c") },
    ];
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(entries, [
      edge("asset-a", "gen"),
      edge("asset-b", "gen"),
      edge("asset-c", "gen"),
    ]);
    const snapshot = canvas.getSnapshot();
    expect(
      createCanvasInputResolver(
        snapshot.nodeByKey,
        snapshot.graph.edges,
      )("gen").media.map((input) => input.key),
    ).toEqual(["asset-a", "asset-b", "asset-c"]);
  });
});
