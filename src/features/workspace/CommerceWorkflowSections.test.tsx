import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PickedPromptMaterial } from "../../lib/backend";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { CommerceConfiguration, CommerceDeliverables } from "./CommerceWorkflowSections";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import {
  createCommerceCheckpoint,
  createCommerceOptions,
  type CommerceArtifact,
} from "./commerceWorkflowModel";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";

const productImage: PickedPromptMaterial = {
  localPath: "C:\\products\\cup.png",
  displayName: "商品实物.png",
  kind: "image",
  mimeType: "image/png",
  byteSize: 100_000,
};

function nodeProps(config: KnowledgeVideoWorkflowConfig) {
  return {
    node: { ...node(), config },
    providerCatalog: catalog,
    onChange: vi.fn(),
    onExecute: vi.fn(),
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onRevealResult: vi.fn(),
  };
}

describe("commerce workflow node", () => {
  it("requires a real product image for video and routes the existing material picker", async () => {
    const onPick = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
    function Harness() {
      const [config, setConfig] = useState<KnowledgeVideoWorkflowConfig>({
        ...node().config,
        brief: "",
        commerce: { ...createCommerceOptions(), productName: "咖啡杯" },
      });
      return (
        <KnowledgeVideoWorkflowNode
          {...nodeProps(config)}
          onChange={setConfig}
          onPickCommerceMaterials={async (key) => {
            await onPick(key);
            setConfig((current) => ({
              ...current,
              commerce: { ...current.commerce!, materials: [productImage] },
            }));
          }}
          onRemoveCommerceMaterial={(_, localPath) =>
            setConfig((current) => ({
              ...current,
              commerce: {
                ...current.commerce!,
                materials: current.commerce!.materials.filter(
                  (material) => material.localPath !== localPath,
                ),
              },
            }))
          }
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("剧情带货工作流")).toBeInTheDocument();
    expect(screen.getByText("商品资料与制作设置").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByLabelText("知识视频制作要求")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByText("商品资料与制作设置"));
    expect(screen.getByLabelText("带货制作模式")).toHaveValue("quick");
    expect(screen.getByLabelText("带货剧情类型")).toHaveValue("智能推荐");
    fireEvent.click(screen.getByRole("button", { name: "添加商品资料" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled());
    expect(onPick).toHaveBeenCalledWith(node().key);
    expect(screen.getByRole("img", { name: "商品实物.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除商品资料 商品实物.png" }));
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
  });

  it("starts document production with text facts and only the project text model", () => {
    function Harness() {
      const source = node();
      const [config, setConfig] = useState<KnowledgeVideoWorkflowConfig>({
        ...source.config,
        brief: "",
        commerce: { ...createCommerceOptions(), deliverable: "documents" },
        models: {
          ...source.config.models,
          image: { providerId: "", modelDefinitionId: "" },
          video: { providerId: "", modelDefinitionId: "" },
        },
      });
      return <KnowledgeVideoWorkflowNode {...nodeProps(config)} onChange={setConfig} />;
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByText("商品资料与制作设置"));
    fireEvent.change(screen.getByLabelText("带货商品事实与卖点"), {
      target: { value: "咖啡杯，陶瓷材质，容量 350 毫升" },
    });
    fireEvent.change(screen.getByLabelText("带货制作模式"), { target: { value: "full" } });
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
    expect(screen.getByLabelText("带货制作模式")).toHaveValue("full");
  });

  it("locks production settings at a decision and provides a fresh restart after failure", () => {
    const config: KnowledgeVideoWorkflowConfig = {
      ...node().config,
      commerce: { ...createCommerceOptions(), productName: "咖啡杯", materials: [productImage] },
      checkpoint: { ...node().config.checkpoint, phase: "awaiting_approval" },
    };
    const props = nodeProps(config);
    const { rerender } = render(
      <KnowledgeVideoWorkflowNode {...props} onPickCommerceMaterials={vi.fn(async () => {})} />,
    );
    fireEvent.click(screen.getByText("商品资料与制作设置"));
    expect(screen.getByLabelText("带货商品名称")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加商品资料" })).toBeDisabled();
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...props.node,
          config: { ...config, checkpoint: { ...config.checkpoint, phase: "failed" } },
        }}
      />,
    );
    expect(screen.getByLabelText("带货商品名称")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "按当前资料重新制作" }));
    expect(props.onExecute).toHaveBeenCalledWith(props.node.key);
  });

  it("reports picker failure without discarding existing metadata", async () => {
    render(
      <CommerceConfiguration
        options={{ ...createCommerceOptions(), materials: [productImage] }}
        brief=""
        disabled={false}
        onChange={vi.fn()}
        onBriefChange={vi.fn()}
        onPickMaterials={() => Promise.reject(new Error("仅支持商品图片或文档，已跳过音频文件。"))}
      />,
    );
    fireEvent.click(screen.getByText("商品资料与制作设置"));
    fireEvent.click(screen.getByRole("button", { name: "添加商品资料" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("已跳过音频文件"));
    expect(screen.getByRole("img", { name: "商品实物.png" })).toBeInTheDocument();
  });

  it("renders documents, facts, checks and historical drafts within the node", () => {
    const artifact: CommerceArtifact = {
      stage: "quick",
      content: "# 通勤救场\n\n保留商品原包装。",
      inputSummary: "商品实拍图与用户规格",
      version: 2,
      createdAt: 2,
      assets: [],
      shots: [],
      facts: [
        { id: "f01", claim: "容量 350 毫升", basis: "packaging", sourceUrls: [] },
        { id: "f02", claim: "限时优惠", basis: "unverified", sourceUrls: [] },
      ],
    };
    const checkpoint = {
      ...node().config.checkpoint,
      commerce: {
        ...createCommerceCheckpoint(),
        stages: {
          quick: {
            artifact,
            review: {
              result: "REVISE" as const,
              report: "删除未核实的价格优惠。",
              repairInstructions: "保留容量卖点",
            },
            repairCount: 1,
            history: [{ ...artifact, version: 1, createdAt: 1, content: "旧版剧情" }],
          },
        },
        sources: [
          {
            url: "https://product.example/cup",
            title: "",
            text: "",
            status: "failed" as const,
            error: "页面未提供可读文本",
          },
        ],
        sharedAssets: [
          {
            id: "product-original",
            kind: "prop" as const,
            name: "商品原图",
            prompt: "保持包装",
            path: productImage.localPath,
          },
        ],
      },
    };
    const onExport = vi.fn();
    render(<CommerceDeliverables checkpoint={checkpoint} onExport={onExport} />);
    fireEvent.click(screen.getByText("15 秒四镜头剧情 · v2 · 待修订"));
    expect(screen.getByRole("heading", { name: "通勤救场" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("商品事实与依据"));
    expect(screen.getByText("商品包装")).toBeInTheDocument();
    expect(screen.getByText("待核实")).toBeInTheDocument();
    fireEvent.click(screen.getByText("制作检查 · 待修订"));
    expect(screen.getByText("删除未核实的价格优惠。")).toBeInTheDocument();
    fireEvent.click(screen.getByText("历史版本（1）"));
    fireEvent.click(screen.getByText("v1"));
    expect(screen.getByText("旧版剧情")).toBeInTheDocument();
    fireEvent.click(screen.getByText("资料来源读取记录"));
    expect(screen.getByText("读取失败：页面未提供可读文本")).toBeInTheDocument();
    fireEvent.click(screen.getByText("商品、角色与场景资产"));
    expect(screen.getByRole("img", { name: "商品原图" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出带货制作文档" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
