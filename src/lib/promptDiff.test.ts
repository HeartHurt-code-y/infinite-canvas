import { describe, expect, it } from "vitest";
import { diffPromptRuns, tokenizePrompt } from "./promptDiff";

describe("promptDiff", () => {
  it("以中文单字、ASCII 连续串与独立标点分词", () => {
    expect(tokenizePrompt("雨夜 cinematic 4K！")).toEqual([
      "雨",
      "夜",
      " ",
      "cinematic",
      " ",
      "4K",
      "！",
    ]);
  });

  it("将删除与新增投影到对应文本侧", () => {
    const result = diffPromptRuns("夜晚的列车", "暴雨夜的复古列车");

    expect(result.originalRuns).toContainEqual({ type: "removed", text: "晚" });
    expect(result.optimizedRuns).toContainEqual({ type: "added", text: "暴雨" });
    expect(result.optimizedRuns).toContainEqual({ type: "added", text: "复古" });
  });

  it("完整保留原文、优化文及其空白", () => {
    const original = "wide shot\n  blue train";
    const optimized = "wide shot\n  red train\n4K";
    const result = diffPromptRuns(original, optimized);

    expect(result.originalRuns.map((run) => run.text).join("")).toBe(original);
    expect(result.optimizedRuns.map((run) => run.text).join("")).toBe(optimized);
  });

  it("处理空文本与无变更文本", () => {
    expect(diffPromptRuns("", "")).toEqual({ originalRuns: [], optimizedRuns: [] });
    expect(diffPromptRuns("", "新提示词").optimizedRuns).toEqual([
      { type: "added", text: "新提示词" },
    ]);
    expect(diffPromptRuns("保持不变", "保持不变")).toEqual({
      originalRuns: [{ type: "same", text: "保持不变" }],
      optimizedRuns: [{ type: "same", text: "保持不变" }],
    });
  });
});
