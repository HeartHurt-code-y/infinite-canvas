import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasState, type CanvasNodeEntry } from "../canvas/canvasStore";
import { canvasInputEdgeOrder, createCanvasInputResolver, canvasNodeIndex } from "./canvasInputs";
import { AssetFlow } from "./AssetLibraryViews";
import { GenerationInputChips } from "./MediaNodeViews";
import { clearMediaByteCache } from "./mediaByteCache";
import type {
  AssetEdgeData,
  AssetItem,
  AssetNodeData,
  GenNodeData,
  ImageNodeConfig,
} from "./workspaceModel";

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
const videoGenerator = (key: string): GenNodeData => ({
  key,
  kind: "video",
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

/** 读取生成节点参考素材清单上渲染的编号与素材名（空位行不算素材行）。 */
function chipRows(container: HTMLElement): { order: string; name: string }[] {
  const list = container.querySelector<HTMLElement>(".node-media-inputs");
  expect(list).not.toBeNull();
  return Array.from(list!.querySelectorAll("li"))
    .filter((item) => !item.classList.contains("is-empty-slot"))
    .map((item) => ({
      order: item.querySelector(".node-media-chip__order")?.textContent ?? "",
      name: item.querySelector(".node-media-chip__name")?.textContent ?? "",
    }));
}

/** 参考素材清单的每一行：空位行单独标记，便于断言「空出来的位置没有被别人占用」。 */
function referenceRows(container: HTMLElement): { order: string; label: string }[] {
  const list = container.querySelector<HTMLElement>(".node-media-inputs");
  expect(list).not.toBeNull();
  return Array.from(list!.querySelectorAll("li")).map((item) => ({
    order: item.querySelector(".node-media-chip__order")?.textContent ?? "",
    label: item.classList.contains("is-empty-slot")
      ? "空位"
      : (item.querySelector(".node-media-chip__name")?.textContent ?? ""),
  }));
}

describe("生成节点参考素材的传入顺序编号", () => {
  it("编号连续对应渲染顺序，不因槽位表残留空位而跳号或重号", () => {
    // 真实画布上出现过的形态：素材 A 占槽位 0，槽位 1 残留着已删除/已解绑的 key，
    // 素材 C 占槽位 2，再后来连入的 D 没有槽位。编号按清单里实际存在的素材连续排，
    // 没有槽位账本的场景（提示词节点转发、工作流节点）与旧行为一致，不跳号也不重号。
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

  it("移除中间一项后原位置留成空位，其余素材的编号与所在位置都不上移", () => {
    // 用户报告：清单里第 1、2、3 张参考图，点掉第 2 张的叉号后原来的第 3 张被顶上来，
    // 换图时对不上位置。新行为：空槽保留为空位行，第 3 张仍在原来的行、仍显示 3。
    const chip = (key: string, name: string) => ({
      key,
      name,
      kind: "image" as const,
      edgeId: `${key}->gen`,
      sourceLabel: "素材" as const,
      previewUrl: null,
    });
    // 槽位账本 [A, null, C]：第 2 位刚被解绑，B 的位置空着。
    render(
      <GenerationInputChips
        inputs={[chip("asset-a", "A"), chip("asset-c", "C")]}
        positions={
          new Map([
            ["asset-a", 0],
            ["asset-c", 2],
          ])
        }
        onUnlink={vi.fn()}
      />,
    );
    expect(referenceRows(document.body)).toEqual([
      { order: "1", label: "A" },
      { order: "—", label: "空位" },
      { order: "2", label: "C" },
    ]);
    // 空位不承载素材，因此没有解绑按钮；它只表达「这个位置空着」。
    expect(
      screen.queryByRole("button", { name: "解除连线：空位 · 新连线填回此处" }),
    ).not.toBeInTheDocument();
  });

  it("新素材回填空位后拿回原来的编号，原清单顺序保持不变", () => {
    const chip = (key: string, name: string) => ({
      key,
      name,
      kind: "image" as const,
      edgeId: `${key}->gen`,
      sourceLabel: "素材" as const,
      previewUrl: null,
    });
    // 槽位账本 [A, B, C] → 移除 B → 新素材 B2 填回槽位 1。
    render(
      <GenerationInputChips
        inputs={[chip("asset-a", "A"), chip("asset-b2", "B2"), chip("asset-c", "C")]}
        positions={
          new Map([
            ["asset-a", 0],
            ["asset-b2", 1],
            ["asset-c", 2],
          ])
        }
        onUnlink={vi.fn()}
      />,
    );

    expect(referenceRows(document.body)).toEqual([
      { order: "1", label: "A" },
      { order: "2", label: "B2" },
      { order: "3", label: "C" },
    ]);
  });

  it("末尾与首位的空槽不渲染空位行，单条连线解绑后清单为空", () => {
    render(<GenerationInputChips inputs={[]} positions={new Map()} onUnlink={vi.fn()} />);
    expect(document.querySelector(".node-media-inputs")).toBeNull();

    const only = {
      key: "asset-a",
      name: "A",
      kind: "image" as const,
      edgeId: "asset-a->gen",
      sourceLabel: "素材" as const,
      previewUrl: null,
    };
    // 只剩一条连线：解绑后槽位表可能还留着旧槽位，但清单里只有一行素材，不留空行。
    render(
      <GenerationInputChips
        inputs={[only]}
        positions={new Map([["asset-a", 0]])}
        onUnlink={vi.fn()}
      />,
    );
    expect(referenceRows(document.body)).toEqual([{ order: "1", label: "A" }]);
  });

  it("没有槽位记录的素材接在末尾空槽之后，编号仍与提交顺序一致", () => {
    const chip = (key: string, name: string, edgeId: string) => ({
      key,
      name,
      kind: "image" as const,
      edgeId,
      sourceLabel: "素材" as const,
      previewUrl: null,
    });
    // 槽位账本 [A, null, C]：C 的槽位空着，而最后一条连线 D 没有槽位记录。
    // D 是提交顺序里的第 3 个（编号 3），不能塞进 C 前面的空槽里冒充第 2 个。
    render(
      <GenerationInputChips
        inputs={[
          chip("asset-a", "A", "a->gen"),
          chip("asset-c", "C", "c->gen"),
          chip("asset-d", "D", "d->gen"),
        ]}
        positions={
          new Map([
            ["asset-a", 0],
            ["asset-c", 2],
          ])
        }
        onUnlink={vi.fn()}
      />,
    );

    expect(referenceRows(document.body)).toEqual([
      { order: "1", label: "A" },
      { order: "—", label: "空位" },
      { order: "2", label: "C" },
      { order: "3", label: "D" },
    ]);
  });
});

describe("参考素材清单的缩略图字节复用", () => {
  afterEach(() => {
    clearMediaByteCache();
    vi.unstubAllGlobals();
  });

  it("同一份素材在素材库卡片里下载过一次后，参考清单直接复用本地字节", async () => {
    // 用户真实形态：素材库缩略图能显示，参考清单上的同一份素材却只剩类型图标 ——
    // 因为清单把供应商签名地址直接交给 `<img>`，既不复用已下载的字节，失败后也不再重试。
    const fetched: string[] = [];
    const objectUrl = "blob:shared-asset";
    vi.stubGlobal("fetch", (input: string) => {
      fetched.push(input);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        blob: () => Promise.resolve({ size: 8 }),
      } as unknown as Response);
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const signedUrl = "https://cdn.example.com/shot.png?X-Tos-Signature=stale";
    const asset: AssetItem = {
      id: "asset-shot",
      kind: "image",
      name: "ScreenShot_2026-09-07_192951_026.png",
      meta: "已就绪",
      visual: "portrait",
      previewUrl: signedUrl,
      source: "cloud",
      providerConnectionId: "moyu-prod",
    };
    render(
      <>
        <AssetFlow assets={[asset]} onPreview={() => undefined} onDropToCanvas={vi.fn()} />
        <GenerationInputChips
          inputs={[
            {
              key: "asset-node-1",
              name: asset.name,
              kind: "image",
              edgeId: "asset-node-1->gen",
              sourceLabel: "素材",
              previewUrl: signedUrl,
              target: {
                kind: "asset",
                providerConnectionId: "moyu-prod",
                assetId: "asset-shot",
                canvasNodeKey: "asset-node-1",
                mediaType: "image",
              },
            },
          ]}
          onUnlink={vi.fn()}
        />
      </>,
    );

    // 素材库卡片按素材身份下载一次字节；参考清单复用同一笔账，不再重复请求。
    await waitFor(() => expect(fetched).toHaveLength(1));
    const chipThumb = await waitFor(() => {
      const image = document.querySelector<HTMLImageElement>(".auto-size-thumb img");
      expect(image).not.toBeNull();
      return image!;
    });
    expect(chipThumb).toHaveAttribute("src", objectUrl);
    expect(fetched).toHaveLength(1);
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

    // 新素材填最小空槽：D 落在空出来的第 2 位，清单上的位置编号与提交顺序同步回到 A、D、C。
    canvas.commands.insertSubgraph([{ type: "asset", data: imageNode("asset-d") }], []);
    canvas.commands.connect("asset-d", "gen");
    const afterFill = canvas.getSnapshot();
    expect(afterFill.nodeByKey.gen.get("gen")).toMatchObject({
      config: { inputSlots: ["asset-a", "asset-d", "asset-c"] },
    });
    const afterFillResolved = createCanvasInputResolver(
      afterFill.nodeByKey,
      afterFill.graph.edges,
    )("gen");
    expect(afterFillResolved.media.map((input) => input.key)).toEqual([
      "asset-a",
      "asset-d",
      "asset-c",
    ]);
    // 成员与槽位绑定：D 占住第 2 位，A 与 C 的位置没有变化。
    expect(afterFillResolved.mediaPosition.get("asset-a")).toBe(0);
    expect(afterFillResolved.mediaPosition.get("asset-d")).toBe(1);
    expect(afterFillResolved.mediaPosition.get("asset-c")).toBe(2);
  });

  it("只有纯文本来源连入时不占媒体槽位，参考清单不会凭空多出一行空位", () => {
    // 用户真实形态：提示词节点先连到视频生成节点（只送文本，不送媒体），
    // 随后连入第一张图。旧实现把这条纯文本连线也记成槽位 0，第二张图落在槽位 1，
    // 于是清单在第 1 行显示一行空位、图片从第 2 行开始，与真实素材数量对不上。
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        { type: "gen", data: imageGenerator("video-gen") },
        {
          type: "gen",
          data: {
            key: "prompt",
            kind: "prompt",
            x: 0,
            y: 0,
            config: {
              modelSelection: model,
              mode: "seedance_2_0",
              task: "generate",
              sourcePrompt: "",
              generatedPrompt: "",
              catalogResolved: true,
            },
          },
        },
        { type: "asset", data: imageNode("asset-a") },
      ],
      [],
    );
    canvas.commands.connect("prompt", "video-gen");
    // 纯文本连线不建槽位表：第一次连入素材时它落在第 1 位。
    expect(canvas.getSnapshot().nodeByKey.gen.get("video-gen")?.config).not.toHaveProperty(
      "inputSlots",
    );

    canvas.commands.connect("asset-a", "video-gen");
    const connected = canvas.getSnapshot();
    expect(connected.nodeByKey.gen.get("video-gen")).toMatchObject({
      config: { inputSlots: ["asset-a"] },
    });
    const resolved = createCanvasInputResolver(
      connected.nodeByKey,
      connected.graph.edges,
    )("video-gen");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-a"]);
    expect(resolved.mediaPosition.get("asset-a")).toBe(0);
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
    const edges = [edge("asset-a", "gen"), edge("asset-c", "gen"), edge("asset-d", "gen")];
    // 悬挂 key 既不在素材里也不在连线里，排序必须忽略它：A 保持第 1，其余按原始顺序接在后面。
    expect(
      createCanvasInputResolver(
        canvasNodeIndex(entries),
        edges,
      )("gen").media.map((input) => input.key),
    ).toEqual(["asset-a", "asset-c", "asset-d"]);
  });

  it("悬挂槽位不把无槽位素材挤到前面，提交顺序与画布清单一致", () => {
    // 旧文档形态：槽位表是 [A, 已删除节点的 key, B]，连线却是 A、B、C 三条，
    // C 当时没写进槽位。解析器丢弃悬挂 key，再按连线先后把 C 接到 B 后面：A→1、B→2、C→3。
    const entries: CanvasNodeEntry[] = [
      {
        type: "gen",
        data: imageGeneratorWithSlots("gen", ["asset-a", "asset-deleted", "asset-b"]),
      },
      { type: "asset", data: imageNode("asset-a") },
      { type: "asset", data: imageNode("asset-b") },
      { type: "asset", data: imageNode("asset-c") },
    ];
    const edges = [edge("asset-a", "gen"), edge("asset-b", "gen"), edge("asset-c", "gen")];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), edges)("gen");
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
    const edges = [edge("asset-a", "gen"), edge("asset-b", "gen"), edge("asset-c", "gen")];
    expect(
      createCanvasInputResolver(
        canvasNodeIndex(entries),
        edges,
      )("gen").media.map((input) => input.key),
    ).toEqual(["asset-a", "asset-b", "asset-c"]);
  });

  it("拖线到空白创建视频节点后，再连第二张图时仍保持先连的为顺序 1", () => {
    // 用户路径：从图 1 拖到空白处选「视频生成」——走 insertSubgraph 建节点并带上第一条连线；
    // 再把图 2 连到这个节点——走 connect。旧实现只在 connect 里写槽位，第一条线从未入账，
    // 图 2 占了槽位 0，清单和图上序号都把原来的图 1 挤成 2。
    const canvas = createCanvasState();
    canvas.commands.insertSubgraph(
      [
        { type: "gen", data: videoGenerator("video") },
        { type: "asset", data: imageNode("asset-first") },
        { type: "asset", data: imageNode("asset-second") },
      ],
      [edge("asset-first", "video")],
    );
    expect(canvas.getSnapshot().nodeByKey.gen.get("video")).toMatchObject({
      config: { inputSlots: ["asset-first"] },
    });

    expect(canvas.commands.connect("asset-second", "video")).toMatchObject({ status: "connected" });
    const snapshot = canvas.getSnapshot();
    expect(snapshot.nodeByKey.gen.get("video")).toMatchObject({
      config: { inputSlots: ["asset-first", "asset-second"] },
    });
    const resolved = createCanvasInputResolver(snapshot.nodeByKey, snapshot.graph.edges)("video");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-first", "asset-second"]);
    expect(
      canvasInputEdgeOrder(
        resolved,
        snapshot.graph.edges.map((item) => item.id),
      ),
    ).toEqual(["asset-first->video", "asset-second->video"]);
  });

  it("旧文档里先连的图没进槽位表时，解析顺序仍按连线先后而不是把后写入账的挤到前面", () => {
    // 已保存画布的形态：拖线建节点留下的第一条线不在槽位表里，后来 connect 的图占了槽位 0。
    // 解析层必须把缺账的连线按原连线顺序插回去，不能再把图 1 显示成 2。
    const entries: CanvasNodeEntry[] = [
      { type: "gen", data: imageGeneratorWithSlots("video", ["asset-second"]) },
      { type: "asset", data: imageNode("asset-first") },
      { type: "asset", data: imageNode("asset-second") },
    ];
    const edges = [edge("asset-first", "video"), edge("asset-second", "video")];
    const resolved = createCanvasInputResolver(canvasNodeIndex(entries), edges)("video");
    expect(resolved.media.map((input) => input.key)).toEqual(["asset-first", "asset-second"]);
    expect(resolved.mediaPosition.get("asset-first")).toBe(0);
    expect(resolved.mediaPosition.get("asset-second")).toBe(1);
    expect(
      canvasInputEdgeOrder(
        resolved,
        edges.map((item) => item.id),
      ),
    ).toEqual(["asset-first->video", "asset-second->video"]);
  });
});
