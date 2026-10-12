import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { WorkflowFieldHelp } from "./WorkflowGuidance";

describe("workflow parameter descriptions", () => {
  it("keeps the label concise and preserves changing validation descriptions", async () => {
    function Field({ invalid, showHelp = true }: { invalid: boolean; showHelp?: boolean }) {
      return (
        <>
          <span id="validation">请填写产品名称</span>
          <label>
            产品名称
            <input aria-describedby={invalid ? "validation" : undefined} />
            {showHelp ? (
              <WorkflowFieldHelp>填写实物名称，例如便携咖啡杯。</WorkflowFieldHelp>
            ) : null}
          </label>
        </>
      );
    }
    const { rerender } = render(<Field invalid={false} />);
    const input = screen.getByRole("textbox", { name: "产品名称" });
    expect(input).toHaveAccessibleDescription("填写实物名称，例如便携咖啡杯。");
    rerender(<Field invalid />);
    await waitFor(() =>
      expect(input).toHaveAccessibleDescription(
        "请填写产品名称 填写实物名称，例如便携咖啡杯。",
      ),
    );
    rerender(<Field invalid={false} />);
    await waitFor(() =>
      expect(input).toHaveAccessibleDescription("填写实物名称，例如便携咖啡杯。"),
    );
    rerender(<Field invalid showHelp={false} />);
    await waitFor(() => expect(input).toHaveAccessibleDescription("请填写产品名称"));
    expect(input).toHaveAttribute("aria-describedby", "validation");
  });

  it("associates help with an external control and keeps repeated instances independent", () => {
    render(
      <>
        {["first", "second"].map((id) => (
          <div key={id}>
            <label htmlFor={id}>
              {id}
              <WorkflowFieldHelp>说明 {id}</WorkflowFieldHelp>
            </label>
            <input id={id} />
          </div>
        ))}
      </>,
    );
    const first = screen.getByRole("textbox", { name: "first" });
    const second = screen.getByRole("textbox", { name: "second" });
    expect(first).toHaveAccessibleDescription("说明 first");
    expect(second).toHaveAccessibleDescription("说明 second");
    expect(first.getAttribute("aria-describedby")).not.toBe(
      second.getAttribute("aria-describedby"),
    );
  });

  it("keeps material group guidance available without a label", () => {
    render(<WorkflowFieldHelp>人物照片请放到专用人物参考图。</WorkflowFieldHelp>);
    expect(screen.getByText("人物照片请放到专用人物参考图。")).not.toHaveAttribute("aria-hidden");
  });

  it("re-associates help when a child-owned validation rewrites the description", async () => {
    // 报错状态由子组件持有：子组件重渲染重写 aria-describedby 时，
    // 帮助所在的父组件不会重渲染，关联必须靠观察者自愈补回。
    function Control() {
      const [invalid, setInvalid] = useState(false);
      return (
        <input
          aria-describedby={invalid ? "validation" : undefined}
          onClick={() => setInvalid(true)}
        />
      );
    }
    render(
      <>
        <span id="validation">请填写产品名称</span>
        <label>
          产品名称
          <Control />
          <WorkflowFieldHelp>填写实物名称，例如便携咖啡杯。</WorkflowFieldHelp>
        </label>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "产品名称" });
    expect(input).toHaveAccessibleDescription("填写实物名称，例如便携咖啡杯。");
    fireEvent.click(input);
    await waitFor(() =>
      expect(input).toHaveAccessibleDescription(
        "请填写产品名称 填写实物名称，例如便携咖啡杯。",
      ),
    );
  });

  it("associates a control that mounts into the label after the help", async () => {
    function Field({ withControl }: { readonly withControl: boolean }) {
      return (
        <label>
          产品名称
          {withControl ? <input /> : null}
          <WorkflowFieldHelp>填写实物名称，例如便携咖啡杯。</WorkflowFieldHelp>
        </label>
      );
    }
    const { rerender } = render(<Field withControl={false} />);
    rerender(<Field withControl />);
    const input = screen.getByRole("textbox", { name: "产品名称" });
    await waitFor(() =>
      expect(input).toHaveAccessibleDescription("填写实物名称，例如便携咖啡杯。"),
    );
  });

  it("does not rewrite descriptions again when a rerender changes nothing", async () => {
    function Field() {
      return (
        <label>
          产品名称
          <input />
          <WorkflowFieldHelp>填写实物名称，例如便携咖啡杯。</WorkflowFieldHelp>
        </label>
      );
    }
    const { rerender } = render(<Field />);
    const input = screen.getByRole("textbox", { name: "产品名称" });
    const write = vi.spyOn(input, "setAttribute");
    rerender(<Field />);
    // 恰好让渡一个微任务：重渲染引起的观察者回调（若有）排在这拍之前，
    // 之后断言写入次数为零，锁住「值未变绝不重写」。
    await Promise.resolve();
    const describedWrites = write.mock.calls.filter(([name]) => name === "aria-describedby");
    expect(describedWrites).toHaveLength(0);
  });
});
