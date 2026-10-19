import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { FZY_ADAPTER_ID, FZY_VIDEO_PROFILE } from "../../lib/providerAdapters";
import { VideoNodeSettings } from "./PromptNodeViews";
import type { ConnectedAssetInput, VideoNodeConfig } from "./workspaceModel";
import "../../App.css";
import "../../styles/studio.css";

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "fzy",
      displayName: "饭众烟 AI（图片与视频）",
      adapterId: FZY_ADAPTER_ID,
      baseUrl: "https://example.test",
      apiKeyRef: "unused",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "video",
        remoteModelId: "doubao-seedance-2.5",
        displayName: "视频模型",
        operations: ["video_generation"],
        operationSchema: {
          video_generation: {
            requestProfileId: FZY_VIDEO_PROFILE,
            resultType: "video",
            parameters: {
              duration: { type: "integer", label: "时长", default: 5 },
              ratio: { type: "string", label: "画幅", default: "16:9", enum: ["16:9", "9:16"] },
              resolution: { type: "string", label: "分辨率（由模型档位决定）", optional: true },
              generate_audio: { type: "boolean", label: "生成音频", optional: true },
            },
          },
        },
      },
    ],
  },
];
const inputs: readonly ConnectedAssetInput[] = ["首图", "尾图"].map((name) => ({
  key: name,
  name,
  kind: "image",
  edgeId: name,
  sourceLabel: "素材",
  previewUrl: null,
}));

function Harness({ width }: { readonly width: number }) {
  const [config, setConfig] = useState<VideoNodeConfig>({
    modelSelection: { providerId: "fzy", modelDefinitionId: "video" },
    parameterValues: {},
    generationCount: 1,
    catalogResolved: true,
  });
  return (
    <div className="react-flow__node" style={{ position: "relative", width, margin: 12 }}>
      <article
        className="canvas-gen-node canvas-gen-node--video"
        data-testid="fzy-video-settings"
        style={{ width: "100%" }}
      >
        <VideoNodeSettings
          config={config}
          providerCatalog={catalog}
          hasMediaInputs
          mediaInputs={inputs}
          onChange={setConfig}
        />
      </article>
    </div>
  );
}

describe("饭众烟视频参数在真实浏览器中的交互与布局", () => {
  it.each([1200, 390])(
    "视口 %s 下音频可恢复自动，首尾帧错误可定位且不横向溢出",
    async (viewport) => {
      await page.viewport(viewport, 1100);
      await render(<Harness width={Math.min(520, viewport - 24)} />);
      const audio = page.getByRole("combobox", { name: "生成音频", exact: true });
      await expect.element(audio).toHaveValue("");
      await audio.selectOptions("false");
      await expect.element(audio).toHaveValue("false");
      await audio.selectOptions("");
      const first = page.getByRole("combobox", { name: "首图 的素材角色" });
      await first.selectOptions("first_frame");
      const alert = page.getByRole("alert");
      await expect.element(alert).toBeVisible();
      const message = alert.element().textContent;
      expect(message).toContain("首尾帧需要成对使用");
      await expect.element(first).toHaveAttribute("aria-describedby", alert.element().id);
      const card = page.getByTestId("fzy-video-settings").element();
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
      const bounds = card.getBoundingClientRect();
      for (const child of card.querySelectorAll<HTMLElement>(
        "select, input, .error-alert, .canvas-gen-node__media-roles",
      )) {
        const childBounds = child.getBoundingClientRect();
        expect(childBounds.right).toBeLessThanOrEqual(bounds.right + 1);
        expect(childBounds.left).toBeGreaterThanOrEqual(bounds.left - 1);
      }
      await page.screenshot({
        element: card,
        path: `../../../.screenshots/fzy-video-${viewport}.png`,
      });
      await page.getByRole("combobox", { name: "尾图 的素材角色" }).selectOptions("last_frame");
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    },
  );
});
