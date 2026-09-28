import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssetPagination, AssetPanel, AssetPanelHeader } from "./AssetPanelViews";
import { AssetUploadRow } from "./AssetLibraryViews";
import type { AssetUploadEntry } from "./workspaceModel";
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
        cloudCollection="library"
        onSourceChange={noop}
        onCloudCollectionChange={noop}
        providerId={null}
        availableProviders={[]}
        onProviderChange={noop}
        onOpenRealPersonDialog={noop}
        assetsLoading={false}
        libraryError={false}
        assetsError={null}
        onRetryLocal={noop}
        onRetryCloud={noop}
        onRetryObjectStorage={noop}
        pullingBucket={false}
        onPullBucket={noop}
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
    expect(screen.queryByRole("button", { name: "上传到对象存储" })).not.toBeInTheDocument();
  });
});

describe("AssetPanel 云端上传入口", () => {
  it("标题栏只保留一个上传按钮，名称跟随当前目录", () => {
    const onImport = vi.fn();
    const { rerender } = render(
      <AssetPanelHeader uploadActionLabel="上传本地素材到云端素材库" onImport={onImport} />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "上传本地素材到云端素材库" }));
    rerender(<AssetPanelHeader uploadActionLabel="上传到对象存储" onImport={onImport} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "上传到对象存储" }));
    rerender(<AssetPanelHeader uploadActionLabel="上传到本地素材库" onImport={onImport} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "上传到本地素材库" }));
    expect(onImport).toHaveBeenCalledTimes(3);
  });

  it("仅上传对象存储在 staged 时显示单阶段完成且可移除", () => {
    const onDismiss = vi.fn();
    const entry: AssetUploadEntry = {
      jobId: "tos-only-upload-1",
      name: "only-tos.png",
      kind: "image",
      assetId: null,
      status: "staged",
      bytesUploaded: 1024,
      bytesTotal: 1024,
      error: null,
      lastAdvancedAt: Date.now(),
      stalled: false,
      destination: "object_storage",
      adjustment: null,
    };
    render(
      <ul>
        <AssetUploadRow entry={entry} onDismiss={onDismiss} />
      </ul>,
    );

    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-state", "staged");
    expect(row).toHaveTextContent("对象存储上传");
    expect(row).toHaveTextContent("已完成");
    expect(row).not.toHaveTextContent("上传素材库");
    fireEvent.click(screen.getByRole("button", { name: "移除上传记录：only-tos.png" }));
    expect(onDismiss).toHaveBeenCalledOnce();
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
