import { page } from "vitest/browser";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { flushCanvasMediaVisibility, useNodeInView } from "./mediaPreview";

function Probe({
  testId,
  left,
  top,
}: {
  readonly testId: string;
  readonly left: number;
  readonly top: number;
}) {
  const { containerRef, inView } = useNodeInView<HTMLDivElement>();
  return (
    <div
      ref={containerRef}
      data-testid={testId}
      data-in-view={String(inView)}
      style={{ position: "absolute", left, top, width: 80, height: 80 }}
    />
  );
}

describe("画布媒体可见性（真实几何）", () => {
  it("视口内的节点保持挂载，远离视口的节点在宽限期后卸载", async () => {
    await render(
      <div
        className="canvas-viewport"
        style={{ position: "relative", width: 400, height: 300, overflow: "hidden" }}
      >
        <Probe testId="near" left={20} top={20} />
        <Probe testId="far" left={4000} top={4000} />
      </div>,
    );

    act(() => {
      flushCanvasMediaVisibility();
    });

    await expect.element(page.getByTestId("near")).toHaveAttribute("data-in-view", "true");
    await expect.element(page.getByTestId("far")).toHaveAttribute("data-in-view", "false");
  });
});
