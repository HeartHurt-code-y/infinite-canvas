import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as BackendModule from "../../lib/backend";
import { saveMarkdownDocumentToDesktop } from "./desktopActions";
import { ProductSceneJewelryLaunch } from "./ProductSceneJewelryLaunch";
import { ProductSceneConfiguration } from "./ProductSceneWorkflowSections";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import {
  createJewelrySceneOptions,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";

vi.mock("./desktopActions", () => ({ saveMarkdownDocumentToDesktop: vi.fn() }));
vi.mock("../../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof BackendModule>()),
  isDesktopRuntime: () => true,
}));
afterEach(() => vi.restoreAllMocks());

function Harness({
  initial = createJewelrySceneOptions(),
}: {
  readonly initial?: ProductSceneWorkflowOptions;
}) {
  const [options, setOptions] = useState(initial);
  return <ProductSceneJewelryLaunch options={options} disabled={false} onChange={setOptions} />;
}

describe("jewelry launch draft UI", () => {
  it("keeps local planning available when the paid image settings await approval", () => {
    const change = vi.fn<(options: ProductSceneWorkflowOptions) => void>();
    render(
      <ProductSceneConfiguration
        options={createJewelrySceneOptions()}
        disabled
        planningDisabled={false}
        onChange={change}
        onBusyChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "产品名称" })).toBeDisabled();
    const planButton = screen.getByRole("button", { name: "生成淘宝十图方案" });
    expect(planButton).toBeEnabled();
    fireEvent.click(planButton);
    expect(change).toHaveBeenCalledOnce();
    const updated = change.mock.calls[0]?.[0];
    expect(updated?.jewelry?.launch?.draft?.slots).toHaveLength(10);
    expect(updated?.generationMode).toBe("protected");
  });
  it("creates and saves ten slots before filling identity, facts or source approvals", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "生成淘宝十图方案" }));
    expect(screen.getByRole("button", { name: "更新淘宝十图方案" })).toBeEnabled();
    expect(
      screen
        .getByLabelText("淘宝五张主图与五张详情规划")
        .querySelectorAll("details.jewelry-launch__slot"),
    ).toHaveLength(10);
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("keeps stale drafts exportable and only adds a factual stale notice", async () => {
    vi.mocked(saveMarkdownDocumentToDesktop).mockResolvedValue("C:/draft.md");
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "生成淘宝十图方案" }));
    fireEvent.change(screen.getByRole("textbox", { name: "现有商品资料（可选）" }), {
      target: { value: "材质：水晶" },
    });
    expect(screen.getByText(/资料或原图设置已改变/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出十图方案" }));
    await waitFor(() => expect(saveMarkdownDocumentToDesktop).toHaveBeenCalledOnce());
    expect(vi.mocked(saveMarkdownDocumentToDesktop).mock.calls[0]?.[0]).toContain("当前资料已改变");
    expect(screen.getByRole("status")).toHaveTextContent("已导出");
    fireEvent.click(screen.getByRole("button", { name: "更新淘宝十图方案" }));
    expect(screen.queryByText(/资料或原图设置已改变/)).not.toBeInTheDocument();
  });

  it("allows document export while generation settings are locked and handles cancelled saves", async () => {
    vi.mocked(saveMarkdownDocumentToDesktop).mockResolvedValue(null);
    const options = createJewelrySceneOptions();
    const draft = generateJewelryLaunchDraft(options);
    render(
      <ProductSceneJewelryLaunch
        options={{ ...options, jewelry: { ...options.jewelry!, launch: { draft } } }}
        disabled
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "更新淘宝十图方案" })).toBeDisabled();
    const exportButton = screen.getByRole("button", { name: "导出十图方案" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await waitFor(() => expect(saveMarkdownDocumentToDesktop).toHaveBeenCalledOnce());
    await waitFor(() => expect(exportButton).toBeEnabled());
    expect(screen.queryByText("淘宝十图方案已导出。")).not.toBeInTheDocument();
  });
});
