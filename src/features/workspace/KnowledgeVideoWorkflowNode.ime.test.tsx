import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ProviderCatalogEntry } from "../../lib/backend";
import { defaultModelOperationSchema } from "../../lib/modelCapabilities";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { createAiFilmWorkflowOptions } from "./aiFilmWorkflowModel";
import { createComicDramaOptions } from "./comicDramaWorkflowModel";
import { createCommerceOptions } from "./commerceWorkflowModel";
import { createRemotionOptions } from "./remotionWorkflowModel";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowConfig,
  type NodeModelSelections,
} from "./workspaceModel";

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "project-provider",
      displayName: "项目供应商",
      adapterId: "moyu_v1",
      baseUrl: "https://project.example/v1",
      apiKeyRef: "project-key",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "project-text",
        remoteModelId: "project-text",
        displayName: "项目文本模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("project-text", ["text_generation"]),
      },
      {
        definitionId: "project-image",
        remoteModelId: "project-image",
        displayName: "项目图片模型",
        operations: ["text_to_image"],
        operationSchema: defaultModelOperationSchema("project-image", ["text_to_image"]),
      },
      {
        definitionId: "project-video",
        remoteModelId: "project-video",
        displayName: "项目视频模型",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("project-video", ["video_generation"]),
      },
    ],
  },
];

const selections: NodeModelSelections = {
  prompt: { providerId: "project-provider", modelDefinitionId: "project-text" },
  image: { providerId: "project-provider", modelDefinitionId: "project-image" },
  video: { providerId: "project-provider", modelDefinitionId: "project-video" },
};

function renderWorkflowBrief(
  initialBrief = "",
  options: {
    readonly config?: Partial<KnowledgeVideoWorkflowConfig>;
    readonly name?: string;
    readonly sectionTitle?: string;
  } = {},
) {
  const publishedConfigs: KnowledgeVideoWorkflowConfig[] = [];

  function Harness({ revision }: { readonly revision: number }) {
    const [config, setConfig] = useState(() => ({
      ...createKnowledgeVideoWorkflowConfig(selections, true),
      brief: initialBrief,
      ...options.config,
    }));
    return (
      <KnowledgeVideoWorkflowNode
        node={{
          key: "knowledge-workflow-ime",
          kind: "knowledge_video_workflow",
          x: 100 + revision,
          y: 120,
          config,
        }}
        providerCatalog={catalog}
        onChange={(nextConfig) => {
          publishedConfigs.push(nextConfig);
          setConfig(nextConfig);
        }}
        onExecute={vi.fn()}
        onContinue={vi.fn()}
        onCancel={vi.fn()}
        onRemove={vi.fn()}
        onRevealResult={vi.fn()}
      />
    );
  }

  const { rerender } = render(<Harness revision={0} />);
  if (options.sectionTitle) fireEvent.click(screen.getByText(options.sectionTitle));
  const brief = screen.getByRole<HTMLTextAreaElement | HTMLInputElement>("textbox", {
    name: options.name ?? "知识视频制作要求",
  });
  return {
    brief,
    publishedConfigs,
    rerenderParent: () => rerender(<Harness revision={1} />),
  };
}

describe("KnowledgeVideoWorkflowNode IME input", () => {
  it.each<{
    name: string;
    config: Partial<KnowledgeVideoWorkflowConfig>;
    sectionTitle?: string;
    committedValue: (config: KnowledgeVideoWorkflowConfig) => string | undefined;
  }>([
    {
      name: "影视制作要求",
      config: { film: createAiFilmWorkflowOptions() },
      committedValue: (config) => config.brief,
    },
    {
      name: "动画制作要求",
      config: { remotion: createRemotionOptions() },
      committedValue: (config) => config.brief,
    },
    {
      name: "带货商品名称",
      config: { commerce: createCommerceOptions() },
      sectionTitle: "商品资料与制作设置",
      committedValue: (config) => config.commerce?.productName,
    },
    {
      name: "第 1 集剧本",
      config: { comicDrama: createComicDramaOptions() },
      sectionTitle: "分集剧本与制作设置",
      committedValue: (config) => config.comicDrama?.episodes[0]?.script,
    },
  ])("commits IME text once through the $name workflow field", async (options) => {
    const { brief, publishedConfigs, rerenderParent } = renderWorkflowBrief("", options);
    brief.focus();
    fireEvent.compositionStart(brief);
    for (const value of ["r", "ri", "ri'ben"]) {
      fireEvent.input(brief, {
        target: { value },
        inputType: "insertCompositionText",
        isComposing: true,
      });
    }
    rerenderParent();
    expect(brief).toHaveValue("ri'ben");
    expect(publishedConfigs).toHaveLength(0);

    fireEvent.compositionEnd(brief, { data: "日本", target: { value: "日本" } });
    fireEvent.input(brief, {
      target: { value: "日本" },
      inputType: "insertText",
      isComposing: false,
    });
    await waitFor(() => expect(brief).toHaveValue("日本"));
    expect(publishedConfigs.map(options.committedValue)).toEqual(["日本"]);
  });

  it("publishes the committed Chinese text once, without any intermediate pinyin", async () => {
    const { brief, publishedConfigs } = renderWorkflowBrief();
    brief.focus();
    fireEvent.compositionStart(brief);
    for (const value of ["s", "si", "si'h", "si'hu", "si'huan", "si'huan's", "si'huan'su"]) {
      fireEvent.input(brief, {
        target: { value },
        inputType: "insertCompositionText",
        isComposing: true,
      });
    }

    expect(brief).toHaveValue("si'huan'su");
    expect(publishedConfigs).toHaveLength(0);

    fireEvent.compositionEnd(brief, { data: "四环素", target: { value: "四环素" } });
    fireEvent.input(brief, {
      target: { value: "四环素" },
      inputType: "insertText",
      isComposing: false,
    });

    await waitFor(() => expect(brief).toHaveValue("四环素"));
    expect(publishedConfigs.map((config) => config.brief)).toEqual(["四环素"]);
  });

  it("keeps an active composition and its selection when the canvas rerenders the node", async () => {
    const { brief, publishedConfigs, rerenderParent } = renderWorkflowBrief("介绍的用途");
    brief.focus();
    brief.setSelectionRange(2, 2);
    fireEvent.compositionStart(brief);
    fireEvent.input(brief, {
      target: { value: "介绍si'huan'su的用途", selectionStart: 12, selectionEnd: 12 },
      inputType: "insertCompositionText",
      isComposing: true,
    });

    rerenderParent();

    expect(screen.getByRole("textbox", { name: "知识视频制作要求" })).toBe(brief);
    expect(brief).toHaveFocus();
    expect(brief).toHaveValue("介绍si'huan'su的用途");
    expect(brief.selectionStart).toBe(12);
    expect(brief.selectionEnd).toBe(12);
    expect(publishedConfigs).toHaveLength(0);

    fireEvent.compositionEnd(brief, {
      data: "四环素",
      target: { value: "介绍四环素的用途", selectionStart: 5, selectionEnd: 5 },
    });
    await waitFor(() => expect(brief).toHaveValue("介绍四环素的用途"));
    expect(brief.selectionStart).toBe(5);
    expect(brief.selectionEnd).toBe(5);
    expect(publishedConfigs.map((config) => config.brief)).toEqual(["介绍四环素的用途"]);
  });

  it("deletes backward and forward from the middle without moving the caret to the end", () => {
    const { brief, publishedConfigs, rerenderParent } = renderWorkflowBrief("制作日本知识视频");
    brief.focus();
    brief.setSelectionRange(6, 6);

    for (const [value, caret, inputType] of [
      ["制作日本知视频", 5, "deleteContentBackward"],
      ["制作日本视频", 4, "deleteContentBackward"],
      ["制作日本频", 4, "deleteContentForward"],
    ] as const) {
      fireEvent.input(brief, {
        target: { value, selectionStart: caret, selectionEnd: caret },
        inputType,
      });
      rerenderParent();
      expect(screen.getByRole("textbox", { name: "知识视频制作要求" })).toBe(brief);
      expect(brief).toHaveValue(value);
      expect(brief.selectionStart).toBe(caret);
      expect(brief.selectionEnd).toBe(caret);
    }

    expect(publishedConfigs.map((config) => config.brief)).toEqual([
      "制作日本知视频",
      "制作日本视频",
      "制作日本频",
    ]);
  });
});
