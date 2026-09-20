import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { node, catalog } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { ComicDramaConfiguration, ComicDramaDeliverables } from "./ComicDramaWorkflowSections";
import {
  comicDramaDeliveryMarkdown,
  comicDramaDeliveryBundle,
  createComicDramaCheckpoint,
  createComicDramaOptions,
  type ComicDramaWorkflowOptions,
} from "./comicDramaWorkflowModel";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";

describe("comic drama node", () => {
  it("requires all episode scripts but only a text model for document delivery", () => {
    const source = node();
    function Harness() {
      const [config, setConfig] = useState<KnowledgeVideoWorkflowConfig>({
        ...source.config,
        brief: "",
        comicDrama: { ...createComicDramaOptions(), deliverable: "documents" },
        models: {
          ...source.config.models,
          image: { providerId: "", modelDefinitionId: "" },
          video: { providerId: "", modelDefinitionId: "" },
        },
      });
      return (
        <KnowledgeVideoWorkflowNode
          node={{ ...source, config }}
          providerCatalog={catalog}
          onChange={setConfig}
          onExecute={vi.fn()}
          onContinue={vi.fn()}
          onCancel={vi.fn()}
          onRemove={vi.fn()}
          onRevealResult={vi.fn()}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByText("分集剧本与制作设置"));
    fireEvent.change(screen.getByLabelText("第 1 集剧本"), {
      target: { value: "女儿推门进店，父亲抬头微笑。" },
    });
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "添加一集" }));
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除第 2 集" }));
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
  });

  it("imports sorted episode files and preserves existing episodes", async () => {
    function Harness() {
      const [options, setOptions] = useState<ComicDramaWorkflowOptions>({
        ...createComicDramaOptions(),
        episodes: [{ id: "existing", title: "序章", script: "序章正文" }],
      });
      return (
        <ComicDramaConfiguration
          options={options}
          brief=""
          disabled={false}
          onChange={setOptions}
          onBriefChange={vi.fn()}
        />
      );
    }
    const file = (name: string, script: string) => {
      const result = new File([script], name, { type: "text/plain" });
      Object.defineProperty(result, "text", { value: () => Promise.resolve(script) });
      return result;
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("分集剧本与制作设置"));
    fireEvent.change(screen.getByLabelText("导入漫剧分集剧本"), {
      target: { files: [file("ep02.md", "第二集"), file("ep01.txt", "\uFEFF第一集")] },
    });
    await waitFor(() => expect(screen.getByLabelText("第 3 集剧本")).toHaveValue("第二集"));
    expect(screen.getByLabelText("第 1 集剧本")).toHaveValue("序章正文");
    expect(screen.getByLabelText("第 2 集剧本")).toHaveValue("第一集");
    expect(screen.getByLabelText("第 2 集集名")).toHaveValue("ep01");
  });

  it("shows per-episode checks and exports shared assets before image generation", () => {
    const source = node();
    const checkpoint = {
      ...source.config.checkpoint,
      comicDrama: {
        ...createComicDramaCheckpoint(),
        sharedAssets: [
          { id: "father", kind: "character" as const, name: "父亲", prompt: "蓝布衣修表匠" },
        ],
        episodes: [
          {
            id: "ep01",
            title: "第一集",
            script: "剧本",
            stages: {
              director: {
                artifact: {
                  content: "# P01 导演讲戏",
                  inputSummary: "本集剧本",
                  version: 1,
                  createdAt: 1,
                  assets: [],
                  shots: [],
                },
                businessReview: { result: "PASS" as const, report: "剧情点完整" },
                contentReview: {
                  result: "REVISE" as const,
                  report: "表达存在歧义",
                  repairInstructions: "明确动作对象",
                },
                passed: false,
                repairCount: 0,
                history: [],
              },
            },
          },
        ],
      },
    };
    const onExport = vi.fn();
    render(<ComicDramaDeliverables checkpoint={checkpoint} onExport={onExport} />);
    fireEvent.click(screen.getByText("第一集"));
    fireEvent.click(screen.getByText("导演分镜 · v1 · 待检查或修订"));
    expect(screen.getByText("业务检查 · 通过")).toBeInTheDocument();
    expect(screen.getByText("内容检查 · 待修订")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出漫剧制作文档" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    const markdown = comicDramaDeliveryMarkdown(checkpoint);
    expect(markdown).toContain("蓝布衣修表匠");
    expect(markdown).toContain("待修订");
    expect(markdown).toContain("表达存在歧义");
    const bundle = comicDramaDeliveryBundle({
      ...checkpoint,
      comicDrama: {
        ...checkpoint.comicDrama,
        episodes: checkpoint.comicDrama.episodes.map((episode) => ({
          ...episode,
          title: '<script>alert("x")</script>',
        })),
      },
    });
    expect(bundle).toHaveLength(4);
    expect(bundle.map((file) => file.fileName)).toEqual([
      "01-分镜与制作文档.md",
      "02-审核记录.html",
      "03-成片报告.md",
      "04-全链总览.html",
    ]);
    expect(bundle[1]?.content).toContain("&lt;script&gt;");
    expect(bundle[1]?.content).not.toContain('<script>alert("x")</script>');
    expect(bundle[3]?.content).toContain("未批准");
    expect(bundle[2]?.content).toContain("非媒体实测");
  });
});
