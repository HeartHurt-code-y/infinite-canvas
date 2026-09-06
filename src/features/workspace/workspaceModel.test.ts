import { describe, expect, it } from "vitest";
import { textResultFromSource } from "./workspaceModel";

describe("textResultFromSource", () => {
  it("extracts Context-IR 扩写正文 from source { kind: 'text', text }", () => {
    expect(textResultFromSource({ kind: "text", text: "  扩写后的完整提示词  " })).toBe(
      "扩写后的完整提示词",
    );
  });

  it("returns null for media sources or empty text", () => {
    expect(textResultFromSource({ kind: "url", url: "https://x" })).toBeNull();
    expect(textResultFromSource({ kind: "text", text: "   " })).toBeNull();
    expect(textResultFromSource(null)).toBeNull();
    expect(textResultFromSource(undefined)).toBeNull();
    expect(textResultFromSource("plain string")).toBeNull();
  });
});
