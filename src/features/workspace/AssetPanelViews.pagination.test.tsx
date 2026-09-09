import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssetPagination } from "./AssetPanelViews";

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

  it("云端素材：上游无总数，不设上限直接跳转", () => {
    const { onLocalPageChange, onCloudPageChange } = renderPagination({ source: "cloud" });
    jumpTo("8");
    expect(onCloudPageChange).toHaveBeenCalledWith(8);
    expect(onLocalPageChange).not.toHaveBeenCalled();
  });
});
