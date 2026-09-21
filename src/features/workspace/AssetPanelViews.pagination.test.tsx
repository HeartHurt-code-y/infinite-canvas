import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssetPagination, AssetPanel } from "./AssetPanelViews";
import type * as Backend from "../../lib/backend";

vi.mock("../../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof Backend>();
  return { ...actual, isDesktopRuntime: () => true };
});

function renderPagination(overrides: Partial<Parameters<typeof AssetPagination>[0]> = {}) {
  const onLocalPageChange = vi.fn();
  const onCloudPageChange = vi.fn();
  render(
    <AssetPagination
      source="local"
      localPage={2}
      localTotalPages={5}
      localTotal={188}
      cloudPage={1}
      cloudTotalPages={null}
      cloudTotal={null}
      cloudHasMore
      onLocalPageChange={onLocalPageChange}
      onCloudPageChange={onCloudPageChange}
      {...overrides}
    />,
  );
  return { onLocalPageChange, onCloudPageChange };
}

function jumpTo(page: string) {
  const input = screen.getByLabelText("跳转到指定页码");
  fireEvent.change(input, { target: { value: page } });
  fireEvent.click(screen.getByLabelText("跳转到输入的页码"));
}

describe("AssetPanel 分页页脚结构", () => {
  it("分页停在素材网格外面，避免滚进底部说明下面被截断", () => {
    const noop = () => undefined;
    render(
      <AssetPanel
        mobileOpen={false}
        onCloseMobilePanel={noop}
        uploadActionLabel="上传"
        onImportLocalAssets={noop}
        isOffline={false}
        source="local"
        onSourceChange={noop}
        pullingBucket={false}
        onPullBucket={noop}
        providerId={null}
        availableProviders={[]}
        onProviderChange={noop}
        onOpenRealPersonDialog={noop}
        assetsLoading={false}
        libraryError={false}
        assetsError={null}
        onRetryLocal={noop}
        onRetryCloud={noop}
        uploads={[]}
        onDismissUpload={noop}
        groups={[]}
        groupsLoading={false}
        groupsError={null}
        selectedGroupId={null}
        onGroupChange={noop}
        onRefreshGroups={noop}
        onCreateGroup={noop}
        onDeleteGroup={noop}
        kind="image"
        getKindCount={() => 40}
        onKindChange={noop}
        search=""
        onSearchChange={noop}
        searchPending={false}
        resultSummary="第 1 / 2 页"
        uploadGroupName={null}
        visibleAssets={[]}
        onPreviewAsset={noop}
        onDropAssetToCanvas={noop}
        localPage={1}
        localTotalPages={2}
        localTotal={40}
        cloudPage={1}
        cloudTotalPages={null}
        cloudTotal={null}
        cloudHasMore={false}
        onLocalPageChange={noop}
        onCloudPageChange={noop}
      />,
    );

    const panel = screen.getByRole("complementary", { name: "素材库" });
    const grid = panel.querySelector(".asset-grid");
    const pagination = panel.querySelector(".asset-pagination");
    expect(grid).not.toBeNull();
    expect(pagination).not.toBeNull();
    expect(grid?.contains(pagination)).toBe(false);
    expect(pagination?.nextElementSibling).toHaveClass("asset-panel__hint");
  });
});

describe("AssetPagination 指定页码跳转", () => {
  it("本地素材：输入页码回车后跳到对应页并清空输入框", () => {
    const { onLocalPageChange, onCloudPageChange } = renderPagination();
    const input = screen.getByLabelText("跳转到指定页码");
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLocalPageChange).toHaveBeenCalledWith(4);
    expect(onCloudPageChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(null);
  });

  it("本地素材：页码钳制到 1..=总页数，超范围跳到边界页", () => {
    const { onLocalPageChange } = renderPagination();
    jumpTo("99");
    expect(onLocalPageChange).toHaveBeenLastCalledWith(5);
    jumpTo("0");
    expect(onLocalPageChange).toHaveBeenLastCalledWith(1);
  });

  it("本地素材：非数字与同页跳转不触发翻页", () => {
    const { onLocalPageChange } = renderPagination();
    jumpTo("abc");
    jumpTo("2");
    expect(onLocalPageChange).not.toHaveBeenCalled();
  });

  it("云端素材：有类型总数时显示总页数，跳转钳制到上限", () => {
    const { onCloudPageChange } = renderPagination({
      source: "cloud",
      cloudPage: 1,
      cloudTotalPages: 2,
      cloudTotal: 44,
      cloudHasMore: true,
    });
    expect(screen.getByText("第 1 / 2 页 · 共 44 个")).toBeInTheDocument();
    jumpTo("99");
    expect(onCloudPageChange).toHaveBeenLastCalledWith(2);
  });

  it("云端素材：搜索无过滤总数时只显示当前页，不设跳转上限", () => {
    const { onLocalPageChange, onCloudPageChange } = renderPagination({ source: "cloud" });
    expect(screen.getByText("第 1 页")).toBeInTheDocument();
    jumpTo("8");
    expect(onCloudPageChange).toHaveBeenCalledWith(8);
    expect(onLocalPageChange).not.toHaveBeenCalled();
  });
});
