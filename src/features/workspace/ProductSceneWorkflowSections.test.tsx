import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { node } from "../../test/videoWorkflowFixtures";
import { productSceneImageClient } from "../../lib/productSceneImages";
import {
  ProductSceneConfiguration,
  ProductSceneDeliverables,
} from "./ProductSceneWorkflowSections";
import {
  createProductSceneCheckpoint,
  createProductSceneOptions,
  generateProductScenePlan,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import type { ProductSceneInspection } from "./productSceneQuality";
import { initializeWorkflowVersions, recordWorkflowVersion } from "./workflowVersionHistory";
import { isSupportedConnection } from "../canvas/canvasStore";

vi.mock("../../lib/productSceneImages", () => ({
  productSceneImageClient: { prepare: vi.fn(), prepareLogo: vi.fn(), export: vi.fn() },
}));

function options() {
  return {
    ...createProductSceneOptions(),
    totalCount: 3,
    batchSize: 1,
    views: [
      {
        id: "front",
        label: "机身原图",
        sourcePath: "C:/product/front.png",
        preparedPath: "C:/product/prepared.png",
        contentHash: "a".repeat(64),
        angle: "front45" as const,
        approved: true,
      },
    ],
  };
}
function checkpoint(): KnowledgeVideoWorkflowCheckpoint {
  return {
    ...node().config.checkpoint,
    phase: "awaiting_approval",
    productScene: {
      ...createProductSceneCheckpoint(),
      rows: generateProductScenePlan(options()),
      approvedThrough: 1,
      batchReviewPending: true,
    },
  };
}

describe("ProductSceneWorkflowSections", () => {
  it("blocks uncertain port results and rechecks the same paid image without resetting its identity", () => {
    const inspection: ProductSceneInspection = {
      version: 1,
      ports: { status: "uncertain", evidence: "接口过暗，数量无法确认", items: [] },
      logo: {
        status: "not_visible",
        confidence: 1,
        surfaceClear: false,
        quad: null,
        evidence: "当前角度没有展示标志面",
      },
    };
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row, index) =>
          index
            ? row
            : {
                ...row,
                status: "needs_review",
                taskId: "paid-base",
                outputPath: "C:/base.png",
                quality: {
                  status: "blocked",
                  basePath: "C:/base.png",
                  outputPath: null,
                  inspection,
                  attempt: 0,
                  error: "接口检查不确定",
                },
              },
        ),
      },
    };
    const change = vi.fn();
    const proceed = vi.fn();
    render(
      <ProductSceneDeliverables
        options={{ ...options(), quality: { inspectPorts: true, portSpecification: "1 个 HDMI" } }}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={proceed}
      />,
    );
    expect(screen.getByText("接口：无法确定")).toBeVisible();
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出已选用 0 张" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新检查第 1 张" }));
    const next = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.productScene!.rows[0]).toMatchObject({
      taskId: "paid-base",
      outputPath: "C:/base.png",
      attempts: [],
      quality: { status: "pending", basePath: "C:/base.png", attempt: 1 },
    });
    expect(proceed).toHaveBeenCalledOnce();
  });
  it("labels invisible interfaces as unverified while allowing manual review after a completed check", () => {
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row, index) =>
          index
            ? row
            : {
                ...row,
                status: "needs_review",
                outputPath: "C:/base.png",
                quality: {
                  status: "passed",
                  basePath: "C:/base.png",
                  outputPath: "C:/base.png",
                  attempt: 0,
                  error: null,
                  inspection: {
                    version: 1,
                    ports: { status: "not_visible", evidence: "仅见顶盖", items: [] },
                    logo: {
                      status: "not_visible",
                      confidence: 1,
                      surfaceClear: false,
                      quad: null,
                      evidence: "没有标志面",
                    },
                  },
                },
              },
        ),
      },
    };
    render(
      <ProductSceneDeliverables
        options={{ ...options(), quality: { inspectPorts: true, portSpecification: "" } }}
        checkpoint={initial}
        disabled={false}
        onChange={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText("接口：不可见 · 未验证")).toBeVisible();
    expect(screen.getByText("该机位未展示接口，不能据此判断全部接口正确。")).toBeVisible();
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出已选用 0 张" })).toBeDisabled();
  });
  it("requires explicit approval for a prepared source Logo and limits upload to AI camera mode", () => {
    const change = vi.fn();
    const configured = {
      ...options(),
      quality: {
        inspectPorts: false,
        portSpecification: "",
        logo: {
          path: "C:/logo.png",
          contentHash: "b".repeat(64),
          width: 400,
          height: 100,
          approved: false,
        },
      },
    };
    const { rerender } = render(
      <ProductSceneConfiguration
        options={configured}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "待贴回的源 Logo" })).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "确认此 Logo 内容与透明边缘正确" }));
    const changed = change.mock.calls[0]![0] as ProductSceneWorkflowOptions;
    expect(changed.quality?.logo?.approved).toBe(true);
    rerender(
      <ProductSceneConfiguration
        options={{ ...configured, generationMode: "composite" }}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "上传透明 PNG Logo 原样贴回" })).toBeDisabled();
  });
  it("labels reference angles separately and changes mode explicitly", () => {
    const change = vi.fn();
    render(
      <ProductSceneConfiguration
        options={options()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    expect(screen.getByText("参考图原始角度（与目标机位独立）")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "产品场景生成方式" }), {
      target: { value: "composite" },
    });
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ generationMode: "composite" }));
  });
  it("rejects generic input links that bypass product preparation and confirmation", () => {
    const target = node();
    expect(
      isSupportedConnection(
        { type: "result", data: { key: "source", x: 0, y: 0 } },
        {
          type: "knowledgeVideoWorkflow",
          data: { ...target, config: { ...target.config, productScene: options() } },
        },
      ),
    ).toBe(false);
    expect(
      isSupportedConnection(
        { type: "result", data: { key: "source", x: 0, y: 0 } },
        { type: "knowledgeVideoWorkflow", data: target },
      ),
    ).toBe(true);
  });
  it("opens the product original outside transformed nodes and closes with Escape", () => {
    render(
      <div style={{ transform: "scale(.5)" }}>
        <ProductSceneConfiguration
          options={options()}
          disabled={false}
          onChange={vi.fn()}
          onBusyChange={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "放大产品原图 机身原图" }));
    const dialog = screen.getByRole("dialog", { name: "产品场景图预览" });
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "产品场景图预览" })).not.toBeInTheDocument();
  });
  it("requires a new explicit product confirmation when its angle changes", () => {
    const change = vi.fn();
    render(
      <ProductSceneConfiguration
        options={options()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "机身原图 原图角度" }), {
      target: { value: "eye" },
    });
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        views: [expect.objectContaining({ angle: "eye", approved: false })],
      }),
    );
  });

  it("blocks the next batch until every produced image is reviewed and exports only accepted images", async () => {
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row, index) =>
          index === 0
            ? { ...row, status: "needs_review", outputPath: "C:/out/1.png", taskId: "paid-1" }
            : row,
        ),
      },
    };
    const proceed = vi.fn();
    const exportMock = vi
      .spyOn(productSceneImageClient, "export")
      .mockResolvedValue({ directory: "C:/delivery", count: 1 });
    function Harness() {
      const [state, setState] = useState(initial);
      return (
        <ProductSceneDeliverables
          options={options()}
          checkpoint={state}
          disabled={false}
          onChange={setState}
          onContinue={proceed}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "确认生成下一批 1 张" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出已选用 0 张" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "选用第 1 张" }));
    expect(screen.getByRole("button", { name: "确认生成下一批 1 张" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "导出已选用 1 张" }));
    await waitFor(() => expect(exportMock).toHaveBeenCalledOnce());
    const command = exportMock.mock.calls[0]![0];
    expect(command.paths).toEqual(["C:/out/1.png"]);
    const manifest = JSON.parse(command.manifest) as { generationMode: string; provenance: string };
    expect(manifest.generationMode).toBe("reference");
    expect(manifest.provenance).toContain("不同机位");
    expect((JSON.parse(command.manifest) as { rows: unknown }).rows).toEqual([
      expect.objectContaining({ taskId: "paid-1", status: "accepted" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "确认生成下一批 1 张" }));
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("accepts the whole approved batch across pages with one checkpoint update", () => {
    const batchOptions = { ...options(), totalCount: 14, batchSize: 14 };
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: generateProductScenePlan(batchOptions).map((row) => ({
          ...row,
          status: "needs_review" as const,
          outputPath: `C:/out/${row.index}.png`,
        })),
        approvedThrough: 14,
      },
    };
    const change = vi.fn();
    render(
      <ProductSceneDeliverables
        options={batchOptions}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText("1 / 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "选用本批全部合格图（14 张）" }));
    expect(change).toHaveBeenCalledOnce();
    const next = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.phase).toBe("done");
    expect(next.productScene!.rows).toHaveLength(14);
    expect(next.productScene!.rows.every((row) => row.status === "accepted")).toBe(true);
    expect(next.productScene!.rows[13]!.outputPath).toBe("C:/out/14.png");
  });

  it("keeps page selection within the visible page and leaves later pages for review", () => {
    const batchOptions = { ...options(), totalCount: 14, batchSize: 14 };
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: generateProductScenePlan(batchOptions).map((row) => ({
          ...row,
          status: "needs_review" as const,
          outputPath: `C:/out/${row.index}.png`,
        })),
        approvedThrough: 14,
      },
    };
    const change = vi.fn();
    render(
      <ProductSceneDeliverables
        options={batchOptions}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择本页合格图（12 张）" }));
    expect(screen.getByRole("checkbox", { name: "选择第 1 张" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "选用所选 12 张" }));
    expect(change).toHaveBeenCalledOnce();
    const next = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.phase).toBe("awaiting_approval");
    expect(next.productScene!.rows.slice(0, 12).every((row) => row.status === "accepted")).toBe(
      true,
    );
    expect(next.productScene!.rows.slice(12).every((row) => row.status === "needs_review")).toBe(
      true,
    );
  });

  it("clears selected row IDs when the run, input, or approved batch changes", () => {
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      runId: "run-one",
      productScene: {
        ...base.productScene!,
        inputSignature: "input-one",
        rows: base.productScene!.rows.map((row, index) =>
          index < 2
            ? { ...row, status: "needs_review", outputPath: `C:/out/${row.index}.png` }
            : row,
        ),
      },
    };
    const renderReview = (value: KnowledgeVideoWorkflowCheckpoint) => (
      <ProductSceneDeliverables
        options={options()}
        checkpoint={value}
        disabled={false}
        onChange={vi.fn()}
        onContinue={vi.fn()}
      />
    );
    const { rerender } = render(renderReview(initial));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 1 张" }));
    expect(screen.getByRole("button", { name: "选用所选 1 张" })).toBeEnabled();

    const anotherRun = { ...initial, runId: "run-two" };
    rerender(renderReview(anotherRun));
    expect(screen.getByRole("checkbox", { name: "选择第 1 张" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 1 张" }));

    const anotherInput = {
      ...anotherRun,
      productScene: { ...anotherRun.productScene!, inputSignature: "input-two" },
    };
    rerender(renderReview(anotherInput));
    expect(screen.getByRole("checkbox", { name: "选择第 1 张" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 1 张" }));

    const nextBatch = {
      ...anotherInput,
      productScene: { ...anotherInput.productScene, approvedThrough: 2 },
    };
    rerender(renderReview(nextBatch));
    expect(screen.getByRole("checkbox", { name: "选择第 2 张" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择第 2 张" }));
    rerender(renderReview(anotherInput));
    expect(screen.getByRole("checkbox", { name: "选择第 1 张" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "选用所选 0 张" })).toBeDisabled();
  });

  it("excludes blocked quality and unapproved future rows from batch acceptance", () => {
    const batchOptions = {
      ...options(),
      totalCount: 4,
      batchSize: 2,
      quality: { inspectPorts: true, portSpecification: "" },
    };
    const inspection: ProductSceneInspection = {
      version: 1,
      ports: { status: "not_visible", evidence: "当前机位不展示接口", items: [] },
      logo: {
        status: "not_visible",
        confidence: 1,
        surfaceClear: false,
        quad: null,
        evidence: "当前机位不展示标志面",
      },
    };
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: generateProductScenePlan(batchOptions).map((row) => ({
          ...row,
          status: "needs_review" as const,
          outputPath: `C:/out/${row.index}.png`,
          quality: {
            status: row.index === 2 ? ("blocked" as const) : ("passed" as const),
            basePath: `C:/out/${row.index}.png`,
            outputPath: `C:/out/${row.index}.png`,
            inspection,
            attempt: 0,
            error: null,
          },
        })),
        approvedThrough: 2,
      },
    };
    const change = vi.fn();
    render(
      <ProductSceneDeliverables
        options={batchOptions}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/另有 1 张尚不符合选用条件/)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "选择第 2 张" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选用本批全部合格图（1 张）" }));
    expect(change).toHaveBeenCalledOnce();
    const next = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.productScene!.rows.map((row) => row.status)).toEqual([
      "accepted",
      "needs_review",
      "needs_review",
      "needs_review",
    ]);
    expect(next.phase).toBe("awaiting_approval");
  });

  it("retains paid task and image identity when a reviewed image is explicitly redone", () => {
    const base = checkpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row, index) =>
          index === 0
            ? { ...row, status: "rejected", taskId: "paid-1", outputPath: "C:/out/1.png" }
            : row,
        ),
      },
    };
    const change = vi.fn();
    const proceed = vi.fn();
    render(
      <ProductSceneDeliverables
        options={options()}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={proceed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重做第 1 张" }));
    const updated = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(updated.productScene!.rows[0]).toMatchObject({
      status: "queued",
      taskId: null,
      outputPath: null,
      attempts: [{ taskId: "paid-1", outputPath: "C:/out/1.png" }],
    });
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("updates batch progress within its version without creating hundreds of authored copies", () => {
    const original = initializeWorkflowVersions({
      ...node().config,
      productScene: options(),
      checkpoint: checkpoint(),
    });
    const next = recordWorkflowVersion(original, {
      ...original,
      checkpoint: {
        ...original.checkpoint,
        productScene: {
          ...original.checkpoint.productScene!,
          approvedThrough: 2,
          rows: original.checkpoint.productScene!.rows.map((row, index) =>
            index === 0
              ? { ...row, status: "accepted", taskId: "paid-1", outputPath: "C:/out/1.png" }
              : row,
          ),
        },
      },
    });
    expect(next.versionHistory!.versions).toHaveLength(original.versionHistory!.versions.length);
    expect(next.checkpoint.productScene!.rows[0]!.taskId).toBe("paid-1");
  });
});
