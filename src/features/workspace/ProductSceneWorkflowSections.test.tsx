import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { node } from "../../test/videoWorkflowFixtures";
import { mediaClient } from "../../lib/backend";
import * as backend from "../../lib/backend";
import { productSceneImageClient } from "../../lib/productSceneImages";
import {
  ProductSceneConfiguration,
  ProductSceneDeliverables,
} from "./ProductSceneWorkflowSections";
import {
  createProductSceneCheckpoint,
  createProductSceneOptions,
  createJewelrySceneOptions,
  JEWELRY_REVIEW_CHECKS,
  generateProductScenePlan,
  type ProductSceneWorkflowOptions,
  type ProductSceneRow,
} from "./productSceneWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import type { ProductSceneInspection } from "./productSceneQuality";
import { initializeWorkflowVersions, recordWorkflowVersion } from "./workflowVersionHistory";
import { isSupportedConnection } from "../canvas/canvasStore";

vi.mock("../../lib/productSceneImages", () => ({
  productSceneImageClient: { prepare: vi.fn(), prepareLogo: vi.fn(), export: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

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

function jewelryOptions(): ProductSceneWorkflowOptions {
  const base = createJewelrySceneOptions();
  return {
    ...base,
    totalCount: 1,
    jewelry: {
      ...base.jewelry!,
      skuId: "SKU-01",
      specimenId: "实物-01",
      criticalFeatures: "爱心主珠朝外，棉絮位于右侧珠内",
    },
    views: [
      {
        ...options().views[0]!,
        width: 300,
        height: 200,
        protection: { rect: { x: 0, y: 0, width: 1, height: 1 }, feather: 0.025, use: "product" },
      },
    ],
  };
}

function jewelryCheckpoint(configured = jewelryOptions()): KnowledgeVideoWorkflowCheckpoint {
  return {
    ...checkpoint(),
    productScene: {
      ...createProductSceneCheckpoint(),
      approvedThrough: 1,
      rows: generateProductScenePlan(configured).map((row) => ({
        ...row,
        status: "needs_review",
        outputPath: "C:/out/jewelry.png",
        foregroundHash: configured.views[0]!.contentHash,
        protection: {
          region: configured.views[0]!.protection!.rect,
          feather: 0.025,
          sourceWidth: 300,
          sourceHeight: 200,
          corePixelCount: 60000,
          verified: true,
          outputHash: "c".repeat(64),
        },
      })),
    },
  };
}

describe("ProductSceneWorkflowSections", () => {
  it("prepares a complete jewelry photograph without background removal and requires source approval", async () => {
    vi.spyOn(backend, "pickPromptMultimodalFiles").mockResolvedValue([
      {
        localPath: "C:/photo/wearing.png",
        displayName: "真实佩戴.png",
        kind: "image",
        mimeType: "image/png",
        byteSize: 32000,
      },
    ]);
    const prepare = vi.spyOn(productSceneImageClient, "prepare").mockResolvedValue({
      path: "C:/prepared/wearing.png",
      contentHash: "d".repeat(64),
      width: 2000,
      height: 1600,
    });
    const change = vi.fn<(next: ProductSceneWorkflowOptions) => void>();
    render(
      <ProductSceneConfiguration
        options={createJewelrySceneOptions()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加完整实拍 / 佩戴原片" }));
    await waitFor(() => expect(change).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledWith({
      sourcePath: "C:/photo/wearing.png",
      preservePhoto: true,
    });
    expect(change.mock.calls[0]![0].views).toEqual([
      expect.objectContaining({
        preparedPath: "C:/prepared/wearing.png",
        approved: false,
        protection: { rect: { x: 0, y: 0, width: 1, height: 1 }, feather: 0.025, use: "product" },
      }),
    ]);
    expect(screen.queryByRole("combobox", { name: "场景倾向" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "上传透明 PNG Logo 原样贴回" }),
    ).not.toBeInTheDocument();
  });

  it("keeps protection edits as a cancellable draft and revokes source approval only on changed application", () => {
    const change = vi.fn();
    render(
      <ProductSceneConfiguration
        options={jewelryOptions()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑 机身原图 保护范围" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "机身原图 保护宽度百分比" }), {
      target: { value: "80" },
    });
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "编辑 机身原图 保护范围" }));
    expect(screen.getByRole("spinbutton", { name: "机身原图 保护宽度百分比" })).toHaveValue(100);
    fireEvent.change(screen.getByRole("spinbutton", { name: "机身原图 保护宽度百分比" }), {
      target: { value: "80" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "机身原图 原片用途" }), {
      target: { value: "wearing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用保护范围" }));
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        views: [
          expect.objectContaining({
            approved: false,
            protection: {
              rect: { x: 0, y: 0, width: 0.8, height: 1 },
              feather: 0.025,
              use: "wearing",
            },
          }),
        ],
      }),
    );
  });

  it("clears prepared views across jewelry mode boundaries so old cutouts cannot become photographs", () => {
    const change = vi.fn<(next: ProductSceneWorkflowOptions) => void>();
    const { rerender } = render(
      <ProductSceneConfiguration
        options={options()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "产品场景生成方式" }), {
      target: { value: "protected" },
    });
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generationMode: "protected",
        views: [],
      }),
    );
    expect(change.mock.calls.at(-1)![0].jewelry?.specimenId).toBe("");
    rerender(
      <ProductSceneConfiguration
        options={jewelryOptions()}
        disabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "产品场景生成方式" }), {
      target: { value: "reference" },
    });
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ generationMode: "reference", views: [] }),
    );
  });

  it("allows unreviewed jewelry acceptance and keeps optional review evidence in one export", async () => {
    let finishExport!: (value: { count: number; directory: string }) => void;
    const exportMock = vi.spyOn(productSceneImageClient, "export").mockReturnValue(
      new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    const initial = jewelryCheckpoint();
    const change = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState(initial);
      return (
        <ProductSceneDeliverables
          options={jewelryOptions()}
          checkpoint={current}
          disabled={false}
          onChange={(next) => {
            change(next);
            setCurrent(next);
          }}
          onContinue={vi.fn()}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "一键选用全部成图（1 张）" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "选择第 1 张" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看第 1 张实拍母版对照" })).toBeEnabled();
    for (const { label } of JEWELRY_REVIEW_CHECKS.slice(0, 5)) {
      fireEvent.change(screen.getByRole("combobox", { name: `第 1 张 ${label}` }), {
        target: { value: "pass" },
      });
    }
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
    fireEvent.change(
      screen.getByRole("combobox", { name: `第 1 张 ${JEWELRY_REVIEW_CHECKS[5].label}` }),
      { target: { value: "pass" } },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "第 1 张珠宝复核备注" }), {
      target: { value: "对照实物-01，天然棉絮一致" },
    });
    const reviewed = change.mock.calls.at(-1)![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(reviewed.productScene!.approvedThrough).toBe(1);
    expect(reviewed.productScene!.rows[0]!.jewelryReview).toEqual({
      outputPath: "C:/out/jewelry.png",
      checks: {
        connections: "pass",
        shape: "pass",
        details: "pass",
        texture: "pass",
        scale: "pass",
        style: "pass",
      },
      notes: "对照实物-01，天然棉絮一致",
    });
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "一键选用全部成图（1 张）" }));
    const exportButton = screen.getByRole("button", { name: "导出已选用 1 张" });
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);
    expect(exportMock).toHaveBeenCalledOnce();
    const manifest = JSON.parse(exportMock.mock.calls[0]![0].manifest) as {
      jewelry: unknown;
      views: unknown;
      rows: ProductSceneRow[];
    };
    expect(manifest.jewelry).toEqual(jewelryOptions().jewelry);
    expect(manifest.views).toEqual(jewelryOptions().views);
    expect(manifest.rows[0]!.jewelryReview!.notes).toContain("实物-01");
    finishExport({ directory: "C:/delivery", count: 1 });
    await screen.findByText("已导出 1 张选用图片：C:/delivery");
  });

  it("resets displayed checks and notes when a different output replaces the reviewed file", () => {
    const base = jewelryCheckpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row) => ({
          ...row,
          outputPath: "C:/out/replaced.png",
          jewelryReview: {
            outputPath: "C:/out/old.png",
            checks: {
              connections: "pass",
              shape: "pass",
              details: "pass",
              texture: "pass",
              scale: "pass",
              style: "pass",
            },
            notes: "旧输出备注",
          },
        })),
      },
    };
    const change = vi.fn<(next: KnowledgeVideoWorkflowCheckpoint) => void>();
    render(
      <ProductSceneDeliverables
        options={jewelryOptions()}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "第 1 张珠宝复核备注" })).toHaveValue("");
    fireEvent.change(
      screen.getByRole("combobox", { name: `第 1 张 ${JEWELRY_REVIEW_CHECKS[0].label}` }),
      { target: { value: "pass" } },
    );
    expect(change.mock.calls[0]![0].productScene!.rows[0]!.jewelryReview).toMatchObject({
      outputPath: "C:/out/replaced.png",
      checks: { connections: "pass", shape: "uncertain" },
      notes: "",
    });
  });

  it.each(["unreviewed", "old_review"] as const)(
    "exports %s jewelry without selection despite changed source identity and stale protection",
    async (reviewState) => {
      const base = jewelryCheckpoint();
      const row = base.productScene!.rows[0]!;
      const current: ProductSceneRow = {
        ...row,
        foregroundHash: "b".repeat(64),
        protection: { ...row.protection!, verified: false },
        ...(reviewState === "old_review"
          ? {
              jewelryReview: {
                outputPath: "C:/out/old.png",
                checks: {
                  connections: "fail" as const,
                  shape: "uncertain" as const,
                  details: "uncertain" as const,
                  texture: "uncertain" as const,
                  scale: "uncertain" as const,
                  style: "uncertain" as const,
                },
                notes: "旧审核未通过",
              },
            }
          : {}),
      };
      const initial = { ...base, productScene: { ...base.productScene!, rows: [current] } };
      const exportMock = vi.spyOn(productSceneImageClient, "export").mockResolvedValue({
        directory: "C:/delivery",
        count: 1,
      });
      const change = vi.fn();
      render(
        <ProductSceneDeliverables
          options={jewelryOptions()}
          checkpoint={initial}
          disabled={false}
          onChange={change}
          onContinue={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "选用第 1 张" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "导出全部成图 1 张" }));
      await screen.findByText("已导出 1 张成图：C:/delivery");
      expect(change).not.toHaveBeenCalled();
      const command = exportMock.mock.calls[0]![0];
      expect(command.paths).toEqual([current.outputPath]);
      const manifest = JSON.parse(command.manifest) as {
        exportScope: string;
        rows: (ProductSceneRow & { reviewWarnings: string[] })[];
      };
      expect(manifest.exportScope).toBe("all_outputs");
      expect(manifest.rows[0]!.status).toBe("needs_review");
      expect(manifest.rows[0]!.jewelryReview).toEqual(current.jewelryReview);
      expect(manifest.rows[0]!.reviewWarnings.length).toBeGreaterThan(0);
    },
  );

  it("preserves selected jewelry and completed state when optional review is changed to fail", () => {
    const base = jewelryCheckpoint();
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      phase: "done",
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row) => ({ ...row, status: "accepted" })),
      },
    };
    const change = vi.fn();
    render(
      <ProductSceneDeliverables
        options={jewelryOptions()}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: `第 1 张 ${JEWELRY_REVIEW_CHECKS[0].label}` }),
      { target: { value: "fail" } },
    );
    const updated = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(updated.phase).toBe("done");
    expect(updated.productScene!.rows[0]!.status).toBe("accepted");
    expect(updated.productScene!.rows[0]!.jewelryReview!.checks.connections).toBe("fail");
    expect(screen.getByRole("button", { name: "导出已选用 1 张" })).toBeEnabled();
  });
  it("uses a small cached thumbnail for desktop review cards and loads the original only in preview", async () => {
    const originalPath = "C:/outputs/full-scene.png";
    const thumbnailPath = "C:/cache/full-scene-thumb.jpg";
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
      convertFileSrc: (path: string) => `asset://localhost/${path}`,
    };
    let finish!: (value: { path: string; width: number; height: number }) => void;
    const request = new Promise<{ path: string; width: number; height: number }>((resolve) => {
      finish = resolve;
    });
    const createThumbnail = vi.spyOn(mediaClient, "createThumbnail").mockReturnValue(request);
    const base = checkpoint();
    const initial = {
      ...base,
      productScene: {
        ...base.productScene!,
        rows: base.productScene!.rows.map((row, index) =>
          index ? row : { ...row, status: "needs_review" as const, outputPath: originalPath },
        ),
      },
    };
    render(
      <ProductSceneDeliverables
        options={options()}
        checkpoint={initial}
        disabled={false}
        onChange={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    const card = screen.getByRole("button", { name: "放大第 1 张" });
    await waitFor(() => expect(createThumbnail).toHaveBeenCalledWith(originalPath, 512));
    expect(card.querySelector("img")).toBeNull();
    expect(card).toHaveTextContent("正在加载预览");

    finish({ path: thumbnailPath, width: 384, height: 512 });
    await waitFor(() =>
      expect(card.querySelector("img")).toHaveAttribute(
        "src",
        `asset://localhost/${thumbnailPath}`,
      ),
    );
    fireEvent.click(card);
    expect(
      screen.getByRole("dialog", { name: "产品场景图预览" }).querySelector("img"),
    ).toHaveAttribute("src", `asset://localhost/${originalPath}`);
  });

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

  it("allows one-click full approval regardless of pending reviews and exports only accepted images", async () => {
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
    const change = vi.fn();
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
          onChange={(next) => {
            change(next);
            setState(next);
          }}
          onContinue={proceed}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "一键审批剩余 2 张并生成" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出已选用 0 张" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "选用第 1 张" }));
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
    fireEvent.click(screen.getByRole("button", { name: "一键审批剩余 2 张并生成" }));
    expect(proceed).toHaveBeenCalledOnce();
    const approved = change.mock.calls.at(-1)![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(approved.productScene!.approvedThrough).toBe(3);
    expect(approved.productScene!.batchReviewPending).toBe(false);
  });

  it("accepts the whole approved plan across pages with one checkpoint update", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "一键选用全部合格图（14 张）" }));
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

  it("excludes blocked quality rows from one-click full acceptance", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "一键选用全部合格图（3 张）" }));
    expect(change).toHaveBeenCalledOnce();
    const next = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.productScene!.rows.map((row) => row.status)).toEqual([
      "accepted",
      "needs_review",
      "accepted",
      "accepted",
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

  it("retries protected local composition with its paid background while preserving other review rows", () => {
    const configured = { ...jewelryOptions(), totalCount: 2 };
    const base = jewelryCheckpoint(configured);
    const rows = base.productScene!.rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            status: "error" as const,
            taskId: "paid-background-1",
            backgroundPath: "C:/out/background.png",
            outputPath: null,
            error: "本地保存临时失败",
          }
        : row,
    );
    const initial: KnowledgeVideoWorkflowCheckpoint = {
      ...base,
      productScene: { ...base.productScene!, approvedThrough: 2, batchReviewPending: true, rows },
    };
    const change = vi.fn();
    const proceed = vi.fn();
    render(
      <ProductSceneDeliverables
        options={configured}
        checkpoint={initial}
        disabled={false}
        onChange={change}
        onContinue={proceed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试第 1 张本地合成（沿用背景）" }));
    const updated = change.mock.calls[0]![0] as KnowledgeVideoWorkflowCheckpoint;
    expect(updated.productScene!.rows[0]).toMatchObject({
      status: "queued",
      taskId: "paid-background-1",
      backgroundPath: "C:/out/background.png",
      outputPath: null,
      error: null,
    });
    expect(updated.productScene!.rows[0]!.recipe).toEqual(rows[0]!.recipe);
    expect(updated.productScene!.rows[1]).toEqual(rows[1]);
    expect(updated.productScene!.batchReviewPending).toBe(false);
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
