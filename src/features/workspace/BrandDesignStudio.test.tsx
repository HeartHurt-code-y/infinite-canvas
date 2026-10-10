import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { exportBrandDesignBundle, readBrandDesignImage } from "../../lib/brandDesignClient";
import { BrandDesignStudio, type BrandDesignCandidate } from "./BrandDesignStudio";
import {
  brandDesignInputSignature,
  createBrandDesignDocument,
  type BrandDesignDocument,
} from "./brandDesignModel";
import { renderBrandDesignBundle, renderBrandDesignPage } from "./brandDesignRenderer";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import { createJewelrySceneOptions } from "./productSceneWorkflowModel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn() }));
vi.mock("../../lib/brandDesignClient", () => ({
  readBrandDesignImage: vi.fn(),
  exportBrandDesignBundle: vi.fn(),
}));
vi.mock("./brandDesignRenderer", () => ({
  renderBrandDesignPage: vi.fn(),
  renderBrandDesignBundle: vi.fn(),
}));

const draft = generateJewelryLaunchDraft(createJewelrySceneOptions());
const candidate: BrandDesignCandidate = {
  path: "C:/outputs/earrings-final.png",
  label: "耳饰杂志成图",
  contentHash: "a".repeat(64),
  kind: "generated",
  taskId: "provider-task-stable",
  resultIndex: 2,
  sourceNodeId: "product-scene-node",
};
const png = "data:image/png;base64,aW1hZ2U=";
const pageResult = {
  pageId: "HOME" as const,
  width: 614,
  height: 346,
  pngDataUrl: png,
  svg: "<svg />",
  sources: [],
  notes: [],
};
const bundle = {
  files: [{ name: "HOME.png", base64: "aW1hZ2U=" }],
  manifest: {
    schemaVersion: 1 as const,
    inputSignature: "render-signature",
    sourceDraftSignature: draft.inputSignature,
    generatedAt: "2026-10-09T00:00:00.000Z",
    pages: [],
    sources: [],
    notes: [],
  },
  notes: [],
};

function Harness({
  initial = createBrandDesignDocument(draft),
  changed = vi.fn<(document: BrandDesignDocument) => void>(),
  busyChanged = vi.fn<(busy: boolean) => void>(),
  disabled = false,
}: {
  readonly initial?: BrandDesignDocument;
  readonly changed?: (document: BrandDesignDocument) => void;
  readonly busyChanged?: (busy: boolean) => void;
  readonly disabled?: boolean;
}) {
  const [design, setDesign] = useState(initial);
  return (
    <BrandDesignStudio
      draft={draft}
      design={design}
      candidates={[candidate]}
      disabled={disabled}
      onChange={(next) => {
        changed(next);
        setDesign(next);
      }}
      onBusyChange={busyChanged}
    />
  );
}

function expandStudio() {
  screen.getByLabelText<HTMLDetailsElement>("品牌图文设计").open = true;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(renderBrandDesignPage).mockResolvedValue(pageResult);
  vi.mocked(renderBrandDesignBundle).mockResolvedValue(bundle);
  vi.mocked(exportBrandDesignBundle).mockResolvedValue(null);
});

describe("brand design editor", () => {
  it("uses the saved AI file with its stable identity and preserves it through layout edits", () => {
    const changed = vi.fn<(document: BrandDesignDocument) => void>();
    render(<Harness changed={changed} />);
    expandStudio();
    fireEvent.change(screen.getByRole("combobox", { name: "编辑图位" }), {
      target: { value: "M01" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "图位图片" }), {
      target: { value: candidate.path },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "图片放置" }), {
      target: { value: "cover" },
    });
    const saved = changed.mock.calls.at(-1)![0];
    expect(saved.slots.find((slot) => slot.id === "M01")).toMatchObject({
      source: candidate,
      fit: "cover",
    });
    expect(saved.inputSignature).toBe(brandDesignInputSignature(saved));
    expect(saved).not.toHaveProperty("imageDataUrl");
    expect(readBrandDesignImage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "图位图片" }), {
      target: { value: "" },
    });
    expect(changed.mock.calls.at(-1)![0].slots[0]).not.toHaveProperty("source");
  });

  it("reopens a design as editable data, recomputes its signature and retains AI provenance", async () => {
    const base = createBrandDesignDocument(draft);
    const imported = {
      ...base,
      brandName: "杉间",
      inputSignature: "stale-file-signature",
      slots: base.slots.map((slot, index) => (index === 0 ? { ...slot, source: candidate } : slot)),
    };
    vi.mocked(open).mockResolvedValue("C:/design/design.json");
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(imported));
    const changed = vi.fn<(document: BrandDesignDocument) => void>();
    render(<Harness changed={changed} />);
    expandStudio();
    fireEvent.click(screen.getByRole("button", { name: "打开设计工程" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("设计工程已打开"));
    expect(readTextFile).toHaveBeenCalledWith("C:/design/design.json");
    const reopened = changed.mock.calls[0]![0];
    expect(reopened.inputSignature).toBe(brandDesignInputSignature(reopened));
    expect(reopened.inputSignature).not.toBe(imported.inputSignature);
    expect(screen.getByRole("textbox", { name: "品牌名称" })).toHaveValue("杉间");
    fireEvent.change(screen.getByRole("textbox", { name: "品牌名称" }), {
      target: { value: "杉间新作" },
    });
    const edited = changed.mock.calls.at(-1)![0];
    expect(edited.revision).toBe(reopened.revision + 1);
    expect(edited.slots[0]?.source).toEqual(candidate);
    expect(edited.brandName).toBe("杉间新作");
  });

  it("keeps the white product slot free of crop and copy editing controls", () => {
    render(<Harness />);
    expandStudio();
    fireEvent.change(screen.getByRole("combobox", { name: "编辑图位" }), {
      target: { value: "M05" },
    });
    expect(screen.getByRole("combobox", { name: "图位图片" })).toBeEnabled();
    expect(screen.queryByRole("combobox", { name: "图片放置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "图上标题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "图上正文" })).not.toBeInTheDocument();
    expect(screen.getByText(/原照片背景仍保留/)).toBeInTheDocument();
  });

  it("deduplicates pending previews and marks them stale after an edit", async () => {
    let finish!: (value: typeof pageResult) => void;
    vi.mocked(renderBrandDesignPage).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const busyChanged = vi.fn<(busy: boolean) => void>();
    render(<Harness busyChanged={busyChanged} />);
    expandStudio();
    const button = screen.getByRole("button", { name: "更新设计预览" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(renderBrandDesignPage).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "品牌名称" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出品牌设计成图" })).toBeDisabled();
    await act(async () => {
      finish(pageResult);
      await Promise.resolve();
    });
    expect(screen.getByRole("img", { name: "HOME 品牌设计预览" })).toHaveAttribute("src", png);
    expect(busyChanged.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
    fireEvent.change(screen.getByRole("textbox", { name: "品牌名称" }), {
      target: { value: "新品牌" },
    });
    expect(screen.getByText(/当前显示上次预览/)).toBeInTheDocument();
  });

  it("leaves export available while settings are locked and cancelled export makes no success claim", async () => {
    const busyChanged = vi.fn<(busy: boolean) => void>();
    render(<Harness disabled busyChanged={busyChanged} />);
    expandStudio();
    expect(screen.getByRole("button", { name: "更新设计预览" })).toBeDisabled();
    const exportButton = screen.getByRole("button", { name: "导出品牌设计成图" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await waitFor(() => expect(exportBrandDesignBundle).toHaveBeenCalledOnce());
    expect(exportBrandDesignBundle).toHaveBeenCalledWith(
      bundle.files,
      JSON.stringify(bundle.manifest),
    );
    await waitFor(() => expect(exportButton).toBeEnabled());
    expect(busyChanged.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("handles cancelled and invalid project imports without replacing the current design", async () => {
    const changed = vi.fn<(document: BrandDesignDocument) => void>();
    render(<Harness changed={changed} />);
    expandStudio();
    const button = screen.getByRole("button", { name: "打开设计工程" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(readTextFile).not.toHaveBeenCalled();
    vi.mocked(open).mockResolvedValue("C:/design/bad.json");
    vi.mocked(readTextFile).mockResolvedValue('{"schemaVersion": 99}');
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });
});
