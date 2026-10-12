import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { BrandVideoWorkflowSections } from "./BrandVideoWorkflowSections";
import {
  brandVideoInputSignature,
  createBrandVideoCheckpoint,
  createBrandVideoOptions,
  type BrandVideoWorkflowOptions,
} from "./brandVideoWorkflowModel";
import type { BrandModelProfile } from "../../lib/brandModels";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "../../App.css";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const reference = {
  id: "front",
  label: "品牌人物成图和参考照片".repeat(8),
  role: "front" as const,
  path: "C:/library/front.png",
  contentHash: "a".repeat(64),
  width: 100,
  height: 120,
};
const version = {
  id: "v1",
  version: 1,
  createdAt: 1,
  status: "approved" as const,
  description: "成年女性，冷静气质",
  invariants: "棕色眼睛与深色短发",
  references: [reference],
  signature: "b".repeat(64),
};
const profile: BrandModelProfile = {
  id: "profile",
  brandName: "杉间",
  name: "白露",
  archived: false,
  currentVersionId: version.id,
  createdAt: 1,
  updatedAt: 1,
  versions: [version],
};

function Harness() {
  const initial = {
    ...createBrandVideoOptions(),
    brandName: "杉间",
    seriesTitle: "珍珠与光的品牌新品系列".repeat(8),
    productImages: [
      {
        localPath: "C:/product/pearl.png",
        displayName: "客户提供的珍珠商品原图文件名".repeat(8),
        kind: "image" as const,
        mimeType: "image/png",
        byteSize: 1234,
      },
    ],
  };
  const [options, setOptions] = useState<BrandVideoWorkflowOptions>(initial);
  const checkpoint: KnowledgeVideoWorkflowCheckpoint = {
    version: 1,
    runId: null,
    phase: "idle",
    planRevision: 1,
    approvedPlanRevision: null,
    manifest: "",
    script: "",
    storyboard: "",
    shots: [],
    shotRuns: {},
    decision: null,
    lastActivePhase: null,
    coverImagePath: null,
    activeCompositionJobId: null,
    finalPath: null,
    error: null,
    updatedAt: null,
    brandVideo: {
      ...createBrandVideoCheckpoint(),
      version: 1,
      inputSignature: brandVideoInputSignature(initial),
      concept: {
        title: "PearlLight".repeat(20),
        idea: "光与珍珠",
        visualDirection: "杂志留白",
        soundDirection: "轻微水声",
        copy: "光的形状",
      },
      sourceImages: [
        {
          id: "product",
          label: "已冻结商品原图".repeat(10),
          role: "product",
          path: "C:/product/pearl.png",
          contentHash: "c".repeat(64),
          width: 1,
          height: 1,
        },
      ],
    },
  };
  return (
    <div data-testid="brand-video-node" style={{ width: 375 }}>
      <BrandVideoWorkflowSections
        options={options}
        checkpoint={checkpoint}
        disabled={false}
        onChange={setOptions}
      />
    </div>
  );
}

describe("brand video node browser geometry", () => {
  it("keeps loaded identity photos, version controls and the creative plan within 375px and 720px nodes", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn((command: string) =>
        command === "list_brand_models"
          ? Promise.resolve([profile])
          : Promise.reject(new Error(`Unexpected command ${command}`)),
      ),
      convertFileSrc: () => png,
    });
    await render(<Harness />);
    const library = page.getByLabelText("品牌数字模特库").element() as HTMLDetailsElement;
    library.open = true;
    library.dispatchEvent(new Event("toggle"));
    await expect.element(page.getByRole("button", { name: "新建模特" })).toBeEnabled();
    await page.getByRole("combobox", { name: "模特档案" }).selectOptions(profile.id);
    await expect
      .element(page.getByRole("img", { name: `${reference.label} 人物参考` }))
      .toBeVisible();
    const image = page
      .getByRole("img", { name: `${reference.label} 人物参考` })
      .element() as HTMLImageElement;
    await image.decode();
    expect(image.naturalWidth).toBe(1);
    const container = page.getByTestId("brand-video-node").element() as HTMLElement;
    for (const width of [375, 720]) {
      container.style.width = `${width}px`;
      const rect = container.getBoundingClientRect();
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
      for (const control of container.querySelectorAll<HTMLElement>(
        "input,select,textarea,button,summary,strong,p,img,dd",
      )) {
        const controlRect = control.getBoundingClientRect();
        expect(controlRect.left).toBeGreaterThanOrEqual(rect.left - 1);
        expect(controlRect.right).toBeLessThanOrEqual(rect.right + 1);
      }
    }
  });
});
