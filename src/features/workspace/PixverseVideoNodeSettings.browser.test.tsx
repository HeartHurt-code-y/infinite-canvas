import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { defaultModelOperationSchema } from "../../lib/modelCapabilities";
import { VideoNodeSettings } from "./PromptNodeViews";
import type { ConnectedAssetInput, VideoNodeConfig } from "./workspaceModel";
import "../../App.css";
import "../../styles/studio.css";

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "moyu",
      displayName: "魔芋",
      adapterId: "moyu_v1",
      baseUrl: "https://example.test",
      apiKeyRef: "unused",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "pixverse",
        remoteModelId: "PixVerse-V6",
        displayName: "PixVerse V6",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("PixVerse-V6", ["video_generation"]),
      },
    ],
  },
];
const inputs: readonly ConnectedAssetInput[] = ["人物", "房间", "动作", "周敏之教授.wav"].map(
  (name, index) => ({
    key: name,
    name,
    kind: index === 3 ? "audio" : "image",
    edgeId: name,
    sourceLabel: "素材",
    previewUrl: null,
  }),
);

function Harness({ width }: { readonly width: number }) {
  const [config, setConfig] = useState<VideoNodeConfig>({
    modelSelection: { providerId: "moyu", modelDefinitionId: "pixverse" },
    parameterValues: { action: "fusion", duration: 30, quality: "4k" },
    generationCount: 1,
    catalogResolved: true,
  });
  return (
    <div className="react-flow__node" style={{ position: "relative", width, margin: 12 }}>
      <article
        className="canvas-gen-node canvas-gen-node--video"
        data-testid="pixverse-settings"
        style={{ width: "100%" }}
      >
        <VideoNodeSettings
          config={config}
          providerCatalog={catalog}
          hasMediaInputs
          mediaInputs={inputs}
          onChange={setConfig}
        />
        <output hidden data-testid="saved-parameters">
          {JSON.stringify(config.parameterValues)}
        </output>
      </article>
    </div>
  );
}

describe("PixVerse 服务端裁决参数在真实浏览器中的交互", () => {
  it.each([1200, 390])("视口 %s 下保留三图加音频及新参数，不横向溢出", async (viewport) => {
    await page.viewport(viewport, 1100);
    await render(<Harness width={Math.min(520, viewport - 24)} />);
    await expect
      .element(page.getByRole("combobox", { name: "时长", exact: true }))
      .toHaveValue("30");
    await expect
      .element(page.getByRole("combobox", { name: "清晰度", exact: true }))
      .toHaveValue("4k");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await page.getByRole("combobox", { name: "能力模式", exact: true }).selectOptions("lip_sync");
    await page
      .getByRole("textbox", { name: "源视频任务 ID", exact: true })
      .fill("18446744073709551615");
    const saved: unknown = JSON.parse(page.getByTestId("saved-parameters").element().textContent);
    expect(saved).toMatchObject({
      action: "lip_sync",
      duration: 30,
      quality: "4k",
      source_video_id: "18446744073709551615",
    });
    const card = page.getByTestId("pixverse-settings").element();
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    const bounds = card.getBoundingClientRect();
    for (const child of card.querySelectorAll<HTMLElement>(
      "select, input, .canvas-gen-node__media-roles",
    )) {
      const childBounds = child.getBoundingClientRect();
      expect(childBounds.right).toBeLessThanOrEqual(bounds.right + 1);
      expect(childBounds.left).toBeGreaterThanOrEqual(bounds.left - 1);
    }
    await page.screenshot({
      element: card,
      path: `../../../.screenshots/pixverse-video-${viewport}.png`,
    });
  });
});
