import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CanvasDocumentSkillNode } from "./DocumentNodeViews";
import {
  createScreenplayNodeConfig,
  type DocumentSkillNodeData,
  type ScreenplayNodeConfig,
} from "./workspaceModel";

describe("CanvasDocumentSkillNode composer", () => {
  function renderControlledComposer() {
    const publishedConfigs: ScreenplayNodeConfig[] = [];

    function Harness() {
      const [config, setConfig] = useState(() =>
        createScreenplayNodeConfig({ providerId: "", modelDefinitionId: "" }, false),
      );
      const node: DocumentSkillNodeData = {
        key: "screenplay-ime-test",
        kind: "screenplay",
        x: 0,
        y: 0,
        config,
      };

      return (
        <CanvasDocumentSkillNode
          node={node}
          selected
          dragging={false}
          running={false}
          error={null}
          providerCatalog={[]}
          audit={undefined}
          sourceInput={null}
          onSelect={vi.fn()}
          onNodeDragStart={vi.fn()}
          onRemove={vi.fn()}
          onUnlink={vi.fn()}
          onSizeChange={vi.fn()}
          onChange={(nextConfig) => {
            publishedConfigs.push(nextConfig);
            setConfig(nextConfig);
          }}
          onSend={vi.fn()}
          onAudit={vi.fn()}
          onApplyAudit={vi.fn()}
          onDiscardAudit={vi.fn()}
          onExport={vi.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<Harness />);
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "剧本对话消息",
    });

    return { composer, publishedConfigs };
  }

  it("does not publish IME preedit text", async () => {
    const { composer, publishedConfigs } = renderControlledComposer();

    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "r" } });
    fireEvent.change(composer, { target: { value: "ri" } });
    fireEvent.change(composer, { target: { value: "riben" } });

    expect(composer).toHaveValue("riben");
    expect(publishedConfigs).toHaveLength(0);

    fireEvent.compositionEnd(composer, { data: "日本", target: { value: "日本" } });
    await waitFor(() => expect(composer).toHaveValue("日本"));
    fireEvent.change(composer, { target: { value: "日本" } });
    expect(publishedConfigs.map((config) => config.composer)).toEqual(["日本"]);
  });

  it("keeps the caret after deleting in the middle", async () => {
    const { composer } = renderControlledComposer();
    const originalComposer = composer;

    fireEvent.change(composer, {
      target: { value: "rriri'bri'beri'ben日本", selectionStart: 21, selectionEnd: 21 },
    });
    expect(screen.getByRole("textbox", { name: "剧本对话消息" })).toBe(originalComposer);
    expect(composer.defaultValue).toBe("");
    composer.focus();
    composer.setSelectionRange(6, 6);
    fireEvent.change(composer, {
      target: { value: "rriribri'beri'ben日本", selectionStart: 5, selectionEnd: 5 },
    });

    await waitFor(() => expect(composer).toHaveValue("rriribri'beri'ben日本"));
    expect(composer.selectionStart).toBe(5);
    expect(composer.selectionEnd).toBe(5);
  });
});
