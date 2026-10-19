import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ExternalToast } from "sonner";

const sonnerMocks = vi.hoisted(() => ({
  error: vi.fn<(message: ReactNode, options?: ExternalToast) => number>(() => 1),
  success: vi.fn<(message: ReactNode, options?: ExternalToast) => number>(() => 2),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => 0),
    {
      error: sonnerMocks.error,
      success: sonnerMocks.success,
    },
  ),
}));

import { toast } from "./toast";

/** sonner 的 action 是 `Action | ReactNode` 联合；这里只取我们要断言的形状。 */
function copyActionOf(options: ExternalToast | undefined): CopyAction | undefined {
  const action = options?.action;
  return action != null && typeof action === "object" && "onClick" in action
    ? (action as CopyAction)
    : undefined;
}

interface CopyAction {
  label: ReactNode;
  onClick: (event: { stopPropagation(): void }) => void;
}

function stubbedWriteText() {
  return (navigator as unknown as { clipboard: { writeText: (text: string) => Promise<void> } })
    .clipboard.writeText;
}

const noopEvent = { stopPropagation() {} };

describe("toast 包装器的复制报错动作", () => {
  beforeEach(() => {
    sonnerMocks.error.mockClear();
    sonnerMocks.success.mockClear();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  });

  it("错误 toast 自带「复制报错」动作，点击复制 message 与 description", async () => {
    toast.error("生成失败", { description: "HTTP 429：请求过快" });
    expect(sonnerMocks.error).toHaveBeenCalledTimes(1);
    const action = copyActionOf(sonnerMocks.error.mock.calls[0]![1]);
    expect(action?.label).toBe("复制报错");
    action!.onClick(noopEvent);
    await vi.waitFor(() =>
      expect(stubbedWriteText()).toHaveBeenCalledWith("生成失败\nHTTP 429：请求过快"),
    );
    await vi.waitFor(() => expect(sonnerMocks.success).toHaveBeenCalledTimes(1));
  });

  it("只有 message 时复制 message 本身", async () => {
    toast.error("凭据已失效");
    copyActionOf(sonnerMocks.error.mock.calls[0]![1])!.onClick(noopEvent);
    await vi.waitFor(() => expect(stubbedWriteText()).toHaveBeenCalledWith("凭据已失效"));
  });

  it("调用方自带 action 时不覆盖", () => {
    const action = { label: "重试", onClick: () => {} };
    toast.error("生成失败", { action });
    const injected = copyActionOf(sonnerMocks.error.mock.calls[0]![1]);
    expect(injected?.label).toBe("重试");
  });

  it("description 是渲染函数等富内容时不进剪贴板", async () => {
    toast.error("失败", { description: () => "富内容" });
    copyActionOf(sonnerMocks.error.mock.calls[0]![1])!.onClick(noopEvent);
    await vi.waitFor(() => expect(stubbedWriteText()).toHaveBeenCalledWith("失败"));
  });

  it("success 等其他方法原样透传", () => {
    toast.success("已保存");
    expect(sonnerMocks.success).toHaveBeenCalledWith("已保存");
  });
});
