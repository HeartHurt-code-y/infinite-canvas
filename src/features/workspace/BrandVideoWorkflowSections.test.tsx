import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickPromptMultimodalFiles, type PickedPromptMaterial } from "../../lib/backend";
import { BrandVideoWorkflowSections } from "./BrandVideoWorkflowSections";
import {
  brandVideoInputSignature,
  createBrandVideoCheckpoint,
  createBrandVideoOptions,
  type BrandVideoWorkflowOptions,
} from "./brandVideoWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

vi.mock("./BrandModelLibrary", () => ({ BrandModelLibrary: () => <span>模特库入口</span> }));
vi.mock("../../lib/backend", async (original) => ({
  ...(await original<object>()),
  pickPromptMultimodalFiles: vi.fn(),
}));

const product: PickedPromptMaterial = {
  localPath: "C:/product/ring.png",
  displayName: "实物戒指.png",
  kind: "image",
  mimeType: "image/png",
  byteSize: 1234,
};
const checkpoint: KnowledgeVideoWorkflowCheckpoint = {
  version: 1,
  runId: null,
  phase: "idle",
  planRevision: 0,
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
};

function Harness({
  initial = createBrandVideoOptions(),
  saved = checkpoint,
  changed = vi.fn<(options: BrandVideoWorkflowOptions) => void>(),
}: {
  readonly initial?: BrandVideoWorkflowOptions;
  readonly saved?: KnowledgeVideoWorkflowCheckpoint;
  readonly changed?: (options: BrandVideoWorkflowOptions) => void;
}) {
  const [options, setOptions] = useState(initial);
  return (
    <BrandVideoWorkflowSections
      options={options}
      checkpoint={saved}
      disabled={false}
      onChange={(next) => {
        setOptions(next);
        changed(next);
      }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pickPromptMultimodalFiles).mockResolvedValue([product]);
});

describe("brand video settings", () => {
  it("uses recommended defaults and the model's shared requirement list", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "品牌视频视觉风格" })).toHaveValue("editorial");
    expect(screen.getByRole("spinbutton", { name: "品牌视频总时长" })).toHaveValue(20);
    expect(screen.getByRole("combobox", { name: "品牌视频画幅" })).toHaveValue("9:16");
    expect(screen.getByText(/还差 1 项必填内容/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "品牌视频创意要求" }), {
      target: { value: "珠光在水面上浮动的新品意象" },
    });
    expect(screen.queryByText(/还差 1 项必填内容/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "品牌视频商品事实" }), {
      target: { value: "纯银戒指" },
    });
    expect(screen.getByText("真实商品图")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "品牌视频交付方式" }), {
      target: { value: "documents" },
    });
    expect(screen.queryByText("真实商品图")).not.toBeInTheDocument();
  });

  it("adds actual product images only, deduplicates local paths and exposes removal", async () => {
    const changed = vi.fn<(options: BrandVideoWorkflowOptions) => void>();
    render(
      <Harness initial={{ ...createBrandVideoOptions(), brandName: "杉间" }} changed={changed} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加商品原图" }));
    await screen.findByRole("img", { name: "实物戒指.png 商品原图" });
    expect(pickPromptMultimodalFiles).toHaveBeenCalledWith({
      title: "添加品牌视频商品原图",
      kinds: ["image"],
    });
    fireEvent.click(screen.getByRole("button", { name: "添加商品原图" }));
    await waitFor(() => expect(pickPromptMultimodalFiles).toHaveBeenCalledTimes(2));
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "移除品牌商品图：实物戒指.png" }));
    expect(changed.mock.calls.at(-1)?.[0].productImages).toEqual([]);
  });

  it("shows a saved concept as stale after editing instead of pretending the frozen plan changed", () => {
    const initial = { ...createBrandVideoOptions(), brandName: "杉间" };
    const saved: KnowledgeVideoWorkflowCheckpoint = {
      ...checkpoint,
      brandVideo: {
        ...createBrandVideoCheckpoint(),
        version: 1,
        inputSignature: brandVideoInputSignature(initial),
        concept: {
          title: "珠光生息",
          idea: "一束光穿过珍珠",
          visualDirection: "冷白留白",
          soundDirection: "轻微水声",
          copy: "光的形状",
        },
      },
    };
    render(<Harness initial={initial} saved={saved} />);
    expect(screen.getByText("珠光生息")).toBeVisible();
    expect(screen.queryByText(/制作设置已改变/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "品牌视频视觉风格" }), {
      target: { value: "retro" },
    });
    expect(screen.getByText(/制作设置已改变/)).toBeVisible();
    expect(screen.getByText("冷白留白")).toBeVisible();
  });

  it("associates a native import error with the triggering control and a useful next action", async () => {
    vi.mocked(pickPromptMultimodalFiles).mockRejectedValue({
      message: "图片读取失败",
      kind: "io",
      details: null,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "添加商品原图" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("图片读取失败");
    expect(alert).toHaveTextContent("重新选择可读取的 PNG、JPG 或 WebP");
    expect(screen.getByRole("button", { name: "添加商品原图" })).toHaveAttribute(
      "aria-describedby",
      alert.id,
    );
  });
});
