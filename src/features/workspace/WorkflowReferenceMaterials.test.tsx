import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PickedPromptMaterial } from "../../lib/backend";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { createAiFilmWorkflowOptions } from "./aiFilmWorkflowModel";
import { createComicDramaOptions } from "./comicDramaWorkflowModel";
import { createCommerceOptions } from "./commerceWorkflowModel";
import { createRemotionOptions } from "./remotionWorkflowModel";
import { createReverseVideoOptions } from "./reverseVideoWorkflowModel";
import type { KnowledgeVideoWorkflowConfig, KnowledgeVideoWorkflowPhase } from "./workspaceModel";
import { createXhsCoverOptions } from "./xhsCoverWorkflowModel";

const material: PickedPromptMaterial = {
  localPath: "C:\\references\\scene.png",
  displayName: "场景参考.png",
  kind: "image",
  mimeType: "image/png",
  byteSize: 1024 * 1024,
};

function nodeProps(overrides: Partial<KnowledgeVideoWorkflowConfig> = {}) {
  const source = node();
  return {
    node: { ...source, config: { ...source.config, ...overrides } },
    providerCatalog: catalog,
    onChange: vi.fn(),
    onExecute: vi.fn(),
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onRevealResult: vi.fn(),
    onPickMaterials: vi.fn(async () => {}),
    onRemoveMaterial: vi.fn(),
  };
}

const templates: readonly [string, Partial<KnowledgeVideoWorkflowConfig>][] = [
  ["知识视频工作流", {}],
  ["AI影视工作流", { film: createAiFilmWorkflowOptions() }],
  ["漫剧自动工作流", { comicDrama: createComicDramaOptions() }],
  ["剧情带货工作流", { commerce: createCommerceOptions() }],
  ["动画逻辑图工作流", { remotion: createRemotionOptions() }],
  ["小红书封面工作流", { xhsCover: createXhsCoverOptions() }],
  ["短视频反推工作流", { reverseVideo: createReverseVideoOptions() }],
];

describe("workflow reference materials", () => {
  it("counts connected sources toward capacity and permits reusing a connected local file", () => {
    const materials = Array.from({ length: 7 }, (_, index) => ({
      ...material,
      localPath: `C:\\references\\${index}.png`,
    }));
    const props = nodeProps({ materials });
    const input = {
      edgeId: "frame->workflow",
      displayName: "抽帧图片",
      target: {
        kind: "local_file" as const,
        path: "C:\\frames\\one.png",
        mediaType: "image" as const,
      },
    };
    const { rerender } = render(
      <KnowledgeVideoWorkflowNode {...props} connectedInputs={[input]} />,
    );
    expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeEnabled();
    expect(screen.getByText(/全部参考资料 8 \/ 8 项/)).toBeVisible();
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        connectedInputs={[
          input,
          {
            ...input,
            edgeId: "second->workflow",
            target: { ...input.target, path: "C:\\frames\\two.png" },
          },
        ]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("参考资料合计超过 8 项或 14 MB");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  });

  it.each(templates)("shows shared multimodal references in %s", (title, options) => {
    render(<KnowledgeVideoWorkflowNode {...nodeProps(options)} />);
    expect(screen.getByText(title)).toBeInTheDocument();
    const references = screen.getByRole("region", { name: "工作流参考素材" });
    expect(
      within(references).getByRole("button", { name: "添加工作流多模态参考素材" }),
    ).toBeEnabled();
    expect(
      within(references).getByText(/图片、音频、视频、PDF、TXT \/ Markdown、JSON/),
    ).toBeVisible();
    expect(within(references).getByText(/用于文本模型理解、规划与检查/)).toBeVisible();
  });

  it("shows image previews, media types and file sizes, and removes by local path", () => {
    const materials: readonly PickedPromptMaterial[] = [
      material,
      { ...material, kind: "audio", localPath: "C:\\voice.wav", displayName: "讲解.wav" },
      { ...material, kind: "video", localPath: "C:\\motion.mp4", displayName: "动作.mp4" },
      { ...material, kind: "document", localPath: "C:\\notes.json", displayName: "资料.json" },
    ];
    const props = nodeProps({ materials });
    render(<KnowledgeVideoWorkflowNode {...props} />);
    const references = screen.getByRole("region", { name: "工作流参考素材" });
    expect(within(references).getByRole("img", { name: material.displayName })).toHaveAttribute(
      "src",
      material.localPath,
    );
    for (const kind of ["图片", "音频", "视频", "文档"]) {
      expect(within(references).getByText(`${kind} · 1.0 MB`)).toBeVisible();
    }
    expect(within(references).getByText(/全部参考资料 4 \/ 8 项 · 4.0 MB \/ 14 MB/)).toBeVisible();
    fireEvent.click(
      within(references).getByRole("button", { name: "移除工作流参考素材：资料.json" }),
    );
    expect(props.onRemoveMaterial).toHaveBeenCalledWith(props.node.key, "C:\\notes.json");
  });

  it("includes dedicated files once in shared quota and allows reusing them when capacity is full", async () => {
    const productFiles = Array.from({ length: 8 }, (_, index) => ({
      ...material,
      localPath: `C:\\products\\${index}.png`,
    }));
    const props = nodeProps({
      materials: [productFiles[0]!],
      commerce: { ...createCommerceOptions(), materials: productFiles },
    });
    render(<KnowledgeVideoWorkflowNode {...props} />);
    const references = screen.getByRole("region", { name: "工作流参考素材" });
    expect(within(references).getByText(/全部参考资料 8 \/ 8 项 · 8.0 MB \/ 14 MB/)).toBeVisible();
    expect(
      within(references).getByRole("button", { name: "添加工作流多模态参考素材" }),
    ).toBeEnabled();
    expect(within(references).getByText(/可选择已有专用资料作为参考/)).toBeVisible();
    fireEvent.click(within(references).getByRole("button", { name: "添加工作流多模态参考素材" }));
    expect(props.onPickMaterials).toHaveBeenCalledWith(props.node.key);
    await waitFor(() =>
      expect(
        within(references).getByRole("button", { name: "添加工作流多模态参考素材" }),
      ).toBeEnabled(),
    );
    expect(
      within(references).getByRole("button", {
        name: `移除工作流参考素材：${material.displayName}`,
      }),
    ).toBeEnabled();
  });

  it("disables adding when all capacity is occupied by general references", () => {
    const materials = Array.from({ length: 8 }, (_, index) => ({
      ...material,
      localPath: `C:\\references\\${index}.png`,
    }));
    render(<KnowledgeVideoWorkflowNode {...nodeProps({ materials })} />);
    expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeDisabled();
    expect(screen.queryByText(/可选择已有专用资料作为参考/)).not.toBeInTheDocument();
  });

  it("allows reusing dedicated files at the byte limit and compares roles by normalized path", () => {
    const largeProduct = {
      ...material,
      localPath: "C:\\products\\cup.png",
      byteSize: 14 * 1024 * 1024,
    };
    const props = nodeProps({
      commerce: { ...createCommerceOptions(), materials: [largeProduct] },
    });
    const { rerender } = render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeEnabled();
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...props.node,
          config: {
            ...props.node.config,
            materials: [{ ...largeProduct, localPath: "c:/PRODUCTS/cup.png" }],
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeDisabled();
    expect(screen.queryByText(/可选择已有专用资料作为参考/)).not.toBeInTheDocument();
  });

  it("reports combined size overflow and blocks execution until references are removed", () => {
    render(
      <KnowledgeVideoWorkflowNode
        {...nodeProps({ materials: [{ ...material, byteSize: 15 * 1024 * 1024 }] })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("参考资料合计超过 8 项或 14 MB");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `移除工作流参考素材：${material.displayName}` }),
    ).toBeEnabled();
  });

  it.each<KnowledgeVideoWorkflowPhase>(["planning", "awaiting_approval"])(
    "locks references during %s",
    (phase) => {
      const props = nodeProps({
        materials: [material],
        checkpoint: { ...node().config.checkpoint, phase },
      });
      render(<KnowledgeVideoWorkflowNode {...props} />);
      expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: `移除工作流参考素材：${material.displayName}` }),
      ).toBeDisabled();
    },
  );

  it("keeps the node locked until file selection finishes and renders picker errors", async () => {
    let rejectPick: (reason: Error) => void = () => {};
    const pendingPick = new Promise<void>((_, reject) => {
      rejectPick = reject;
    });
    const props = nodeProps({ materials: [material] });
    props.onPickMaterials.mockImplementation(() => pendingPick);
    render(<KnowledgeVideoWorkflowNode {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "添加工作流多模态参考素材" }));
    expect(props.onPickMaterials).toHaveBeenCalledWith(props.node.key);
    expect(screen.getByText("正在选择素材…")).toBeVisible();
    expect(screen.getByRole("region", { name: "工作流参考素材" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByLabelText("知识视频制作要求")).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    expect(props.onExecute).not.toHaveBeenCalled();
    rejectPick(new Error("文件已移动，请重新选择"));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件已移动，请重新选择");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
    expect(screen.getByRole("img", { name: material.displayName })).toBeVisible();
  });

  it.each<KnowledgeVideoWorkflowPhase>(["paused", "failed", "done"])(
    "blocks resume or restart during file selection in %s",
    async (phase) => {
      let finishPick: () => void = () => {};
      const pendingPick = new Promise<void>((resolve) => {
        finishPick = resolve;
      });
      const props = nodeProps({ checkpoint: { ...node().config.checkpoint, phase } });
      props.onPickMaterials.mockImplementation(() => pendingPick);
      render(<KnowledgeVideoWorkflowNode {...props} />);
      const action =
        phase === "paused" ? "继续制作" : phase === "failed" ? "重试当前步骤" : "重新制作";
      fireEvent.click(screen.getByRole("button", { name: "添加工作流多模态参考素材" }));
      expect(screen.getByRole("button", { name: action })).toBeDisabled();
      finishPick();
      await waitFor(() => expect(screen.getByRole("button", { name: action })).toBeEnabled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each(["knowledge", "film"])(
    "offers a fresh run when references change in a paused %s workflow",
    (template) => {
      const props = nodeProps({
        ...(template === "film" ? { film: createAiFilmWorkflowOptions() } : {}),
        materials: [material],
        checkpoint: { ...node().config.checkpoint, phase: "paused" },
      });
      render(<KnowledgeVideoWorkflowNode {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "按当前资料重新制作" }));
      expect(props.onExecute).toHaveBeenCalledWith(props.node.key);
      expect(props.onContinue).not.toHaveBeenCalled();
    },
  );

  it("locks shared references and execution while dedicated product files are being selected", async () => {
    let finishPick: () => void = () => {};
    const pendingPick = new Promise<void>((resolve) => {
      finishPick = resolve;
    });
    const props = nodeProps({
      commerce: { ...createCommerceOptions(), productName: "咖啡杯", materials: [material] },
    });
    render(
      <KnowledgeVideoWorkflowNode {...props} onPickCommerceMaterials={vi.fn(() => pendingPick)} />,
    );
    fireEvent.click(screen.getByText("商品资料与制作设置"));
    fireEvent.click(screen.getByRole("button", { name: "添加商品资料" }));
    expect(screen.getByRole("button", { name: "添加工作流多模态参考素材" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    finishPick();
    await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  });
});
