import { describe, expect, it } from "vitest";
import examples from "./__fixtures__/gptImage2Prompt.json";
import { cleanGptImage2Prompt } from "./gptImage2Prompt";

describe("GPT Image 2 generation prompt cleaning", () => {
  it.each(examples)("$name", ({ raw, expected }) => {
    expect(cleanGptImage2Prompt(raw)).toBe(expected);
    expect(cleanGptImage2Prompt(expected)).toBe(expected);
  });
});
