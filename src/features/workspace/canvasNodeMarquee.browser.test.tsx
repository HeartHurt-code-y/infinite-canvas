import { ReactFlow, SelectionMode, useNodesState, type Node } from "@xyflow/react";
import { useRef, useState } from "react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CanvasMarqueeSelectionReader } from "./AssetGroupFrame";
import "@xyflow/react/dist/style.css";
import "../../App.css";
import "../../styles/studio.css";

const nodeTypes = {
  visual: () => (
    <div className="canvas-flow-node">
      <div className="canvas-asset-node" style={{ width: 120, height: 60 }}>
        Card
      </div>
    </div>
  ),
};

const initialNodes: Node[] = [
  { id: "one", type: "visual", position: { x: 110, y: 100 }, data: { label: "First" } },
  { id: "two", type: "visual", position: { x: 310, y: 210 }, data: { label: "Second" } },
];

function MarqueeHarness() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const nodeKeysRef = useRef<ReadonlySet<string>>(new Set(["one", "two"]));
  const readSelectionRef = useRef<() => readonly string[]>(() => []);
  return (
    <>
      <div style={{ width: 700, height: 450, position: "relative" }}>
        <div className="canvas-viewport is-selecting">
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            panOnDrag={[1]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            onSelectionEnd={() => setSelected(readSelectionRef.current())}
          >
            <CanvasMarqueeSelectionReader
              selectableKeysRef={nodeKeysRef}
              readSelectionRef={readSelectionRef}
            />
          </ReactFlow>
        </div>
      </div>
      <output data-testid="selected-keys">{selected.join(",")}</output>
    </>
  );
}

describe("canvas node marquee pointer gesture", () => {
  it("selects all real nodes inside a dragged rectangle", async () => {
    await render(<MarqueeHarness />);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
    await userEvent.dragAndDrop(pane, pane, {
      sourcePosition: { x: 40, y: 40 },
      targetPosition: { x: 560, y: 350 },
    });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='selected-keys']")?.textContent).toBe("one,two"),
    );
    const bounds = document.querySelector<HTMLElement>(".react-flow__nodesselection-rect")!;
    const picked = document.querySelector<HTMLElement>(
      ".react-flow__node.selected > .canvas-flow-node",
    )!;
    const card = picked.querySelector<HTMLElement>(".canvas-asset-node")!;
    const colorProbe = document.createElement("div");
    colorProbe.style.color = "var(--color-error)";
    document.body.append(colorProbe);
    expect(getComputedStyle(bounds).borderTopColor).toBe(getComputedStyle(colorProbe).color);
    expect(getComputedStyle(bounds).borderTopWidth).toBe("3px");
    colorProbe.style.color = "var(--color-success)";
    expect(getComputedStyle(picked).outlineColor).toBe(getComputedStyle(colorProbe).color);
    expect(getComputedStyle(picked).outlineWidth).toBe("4px");
    expect(getComputedStyle(card).outlineColor).toBe(getComputedStyle(colorProbe).color);
    expect(getComputedStyle(card).outlineWidth).toBe("3px");
    colorProbe.remove();
  });
});
