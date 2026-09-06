import { describe, expect, it } from "vitest";
import { sameWorkflowSignature, stableJsonSignature } from "./workflowSignatures";

describe("persistent workflow signatures", () => {
  it("compares legacy JSON signatures after recursive object key reordering", () => {
    const legacy = JSON.stringify({
      title: "逐字标题",
      options: { style: "auto", portrait: { path: "C:\\photo.png", bytes: 1024 } },
      episodes: [{ id: "episode-1", script: "对白" }],
    });
    const roundTrip = JSON.parse(stableJsonSignature(JSON.parse(legacy) as unknown)) as unknown;
    expect(legacy).not.toBe(JSON.stringify(roundTrip));
    expect(sameWorkflowSignature(legacy, stableJsonSignature(roundTrip))).toBe(true);
  });
  it("still rejects real text changes, material changes and array reordering", () => {
    const original = stableJsonSignature({ title: "原标题", portraits: ["a.png", "b.png"] });
    expect(
      sameWorkflowSignature(
        original,
        stableJsonSignature({ title: "新标题", portraits: ["a.png", "b.png"] }),
      ),
    ).toBe(false);
    expect(
      sameWorkflowSignature(
        original,
        stableJsonSignature({ title: "原标题", portraits: ["a.png", "c.png"] }),
      ),
    ).toBe(false);
    expect(
      sameWorkflowSignature(
        original,
        stableJsonSignature({ title: "原标题", portraits: ["b.png", "a.png"] }),
      ),
    ).toBe(false);
  });
  it("retains JSON undefined omission and does not accept malformed legacy values", () => {
    expect(stableJsonSignature({ brief: "主题", omitted: undefined })).toBe('{"brief":"主题"}');
    expect(sameWorkflowSignature(undefined, "{}")).toBe(false);
    expect(sameWorkflowSignature("broken", "{}")).toBe(false);
    expect(() => stableJsonSignature(undefined)).toThrow("JSON");
  });
});
