import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorAlert } from "./ErrorAlert";
import { ErrorCopyButton } from "./ErrorCopyButton";

const sonnerMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: sonnerMocks.error }),
}));

function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "clipboard");
});

describe("ErrorCopyButton 的一键复制", () => {
  it("点击后把完整报错写入剪贴板，并短暂反馈「已复制」", async () => {
    const { writeText } = stubClipboard();
    render(<ErrorCopyButton text="生成失败：HTTP 429，请求过快" />);
    fireEvent.click(screen.getByRole("button", { name: "复制完整报错" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("生成失败：HTTP 429，请求过快"));
    expect(screen.getByRole("button", { name: "报错已复制到剪贴板" })).toBeInTheDocument();
    expect(screen.getByText("已复制")).toBeInTheDocument();
    expect(screen.queryByText("复制报错")).not.toBeInTheDocument();
  });

  it("剪贴板写入失败时给出明确报错，不静默吞掉", async () => {
    const { writeText } = stubClipboard();
    writeText.mockRejectedValue(new Error("剪贴板被占用"));
    render(<ErrorCopyButton text="生成失败" />);
    fireEvent.click(screen.getByRole("button", { name: "复制完整报错" }));
    await waitFor(() =>
      expect(sonnerMocks.error).toHaveBeenCalledWith(
        "复制报错失败",
        expect.objectContaining({ description: "剪贴板被占用" }),
      ),
    );
    expect(screen.getByText("复制报错")).toBeInTheDocument();
  });
});

describe("ErrorAlert 自带的一键复制", () => {
  it("复制摘要加完整原始 payload，供用户整段贴给支持", async () => {
    const { writeText } = stubClipboard();
    const payload = {
      kind: "validation",
      message: "素材校验失败",
      details: { httpStatus: 400, requestId: "req-1" },
    };
    render(<ErrorAlert error={payload} />);
    fireEvent.click(screen.getByRole("button", { name: "复制完整报错" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("素材校验失败");
    expect(copied).toContain("httpStatus");
    // 复制按钮不能落在 role="alert" 里：展开/复制都不应触发重复朗读。
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.querySelector("button")).toBeNull();
  });
});
