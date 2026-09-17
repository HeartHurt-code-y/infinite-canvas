import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { flushCanvasMediaVisibility, useNodeInView } from "./mediaPreview";

function mockRect(
  element: Element,
  box: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      return {
        x: box.left,
        y: box.top,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width,
        height,
        toJSON: () => ({}),
      };
    },
  });
}

function Probe({
  testId,
  eager = false,
  heavy = false,
}: {
  readonly testId: string;
  readonly eager?: boolean;
  readonly heavy?: boolean;
}) {
  const { containerRef, inView } = useNodeInView<HTMLDivElement>({ eager, heavy });
  return <div data-testid={testId} ref={containerRef} data-in-view={String(inView)} />;
}

function mountPane(): HTMLDivElement {
  const pane = document.createElement("div");
  pane.className = "canvas-viewport";
  document.body.append(pane);
  mockRect(pane, { left: 0, top: 0, right: 800, bottom: 600 });
  return pane;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".canvas-viewport").forEach((node) => node.remove());
});

describe("画布媒体可见性（WebKit 不用 IntersectionObserver）", () => {
  it("视口内的节点保持挂载，远离视口的节点在宽限期后卸载", async () => {
    mountPane();
    const view = render(
      <>
        <Probe testId="near" />
        <Probe testId="far" />
      </>,
    );
    mockRect(view.getByTestId("near"), { left: 120, top: 80, right: 280, bottom: 220 });
    mockRect(view.getByTestId("far"), { left: 4000, top: 4000, right: 4120, bottom: 4120 });
    act(() => {
      flushCanvasMediaVisibility();
    });

    await waitFor(() => expect(view.getByTestId("near")).toHaveAttribute("data-in-view", "true"));
    await waitFor(() => expect(view.getByTestId("far")).toHaveAttribute("data-in-view", "false"));
  });

  it("eager 浮层即使远离画布视口也保持可见", () => {
    mountPane();
    const view = render(<Probe testId="menu" eager />);
    mockRect(view.getByTestId("menu"), { left: 8000, top: 8000, right: 8100, bottom: 8100 });
    act(() => {
      flushCanvasMediaVisibility();
    });
    expect(view.getByTestId("menu")).toHaveAttribute("data-in-view", "true");
  });

  it("同时只让最靠近视口中心的 8 路视频保持挂载", async () => {
    mountPane();
    const view = render(
      <>
        {Array.from({ length: 9 }, (_, index) => (
          <Probe key={index} testId={`n${index}`} heavy />
        ))}
      </>,
    );
    for (let index = 0; index < 8; index += 1) {
      const x = 360 + index;
      mockRect(view.getByTestId(`n${index}`), { left: x, top: 280, right: x + 12, bottom: 300 });
    }
    mockRect(view.getByTestId("n8"), { left: 8, top: 8, right: 24, bottom: 24 });
    act(() => {
      flushCanvasMediaVisibility();
    });
    await waitFor(() => {
      const live = Array.from({ length: 9 }, (_, index) => view.getByTestId(`n${index}`)).filter(
        (node) => node.getAttribute("data-in-view") === "true",
      );
      expect(live).toHaveLength(8);
    });
    expect(view.getByTestId("n8")).toHaveAttribute("data-in-view", "false");
  });
});
