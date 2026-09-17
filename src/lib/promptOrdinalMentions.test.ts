import { describe, expect, it } from "vitest";
import type { PromptContentDocumentV1 } from "./promptContent";
import {
  bindableOrdinalMentions,
  ordinalValue,
  referenceTokenFor,
  resolveOrdinalMentions,
  scanOrdinalMentions,
} from "./promptOrdinalMentions";
import type { PromptReferenceCandidate } from "./promptReferences";

function candidate(
  canvasNodeKey: string,
  name: string,
  extra: Partial<PromptReferenceCandidate> = {},
): PromptReferenceCandidate {
  return {
    canvasNodeKey,
    assetId: `asset-${canvasNodeKey}`,
    providerConnectionId: "provider-1",
    kind: "image",
    name,
    ...extra,
  };
}

function document(text: string): PromptContentDocumentV1 {
  return { schema: "prompt-content", version: 1, items: [{ kind: "text", text }] };
}

/** 三张图 + 一段视频，顺序即提交顺序（清单行号、请求体「图片N」都按它编号）。 */
const WEIXIN_IMAGES = [
  candidate("img-1", "微信图片_2026091712222_746_208.png"),
  candidate("img-2", "微信图片_20260916145306_654_208.png"),
  candidate("img-3", "微信图片_20260917115902_737_208.png"),
  candidate("clip-1", "微信视频2026-09-08_194710_526.mp4", { kind: "video" }),
];

function aliases(result: ReturnType<typeof resolveOrdinalMentions>): readonly (string | undefined)[] {
  return result.document.items.flatMap((item) =>
    item.kind === "media_reference" ? [item.aliasSnapshot] : [],
  );
}

describe("position words in prompt text", () => {
  it("binds 图N / 参考图N / 第N张图 to the same connection order the UI numbers", () => {
    const result = resolveOrdinalMentions(
      document("图1先入画，参考图2做转场，第3张图收尾"),
      WEIXIN_IMAGES,
    );
    expect(result.converted).toBe(3);
    expect(aliases(result)).toEqual(["图1", "图2", "图3"]);
    expect(
      result.document.items.flatMap((item) =>
        item.kind === "media_reference" ? [item.canvasNodeKey] : [],
      ),
    ).toEqual(["img-1", "img-2", "img-3"]);
    expect(result.document.items[0]).toEqual(
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "img-1" }),
    );
    expect(result.unbound).toEqual([]);
  });

  it("keeps Chinese numerals working and only counts each media kind separately", () => {
    const result = resolveOrdinalMentions(document("第二张图接视频1"), WEIXIN_IMAGES);
    expect(aliases(result)).toEqual(["图2", "视频1"]);
  });

  it("never binds a random file name's own numbering as a position word", () => {
    // 素材名里的「图片_20260917…」没有任何序号词，正文抄了整段文件名也不该被切碎。
    const scan = scanOrdinalMentions("微信图片_2026091712222_746_208.png 换成夜景", WEIXIN_IMAGES);
    expect(scan.matched).toEqual([]);
    expect(scan.unbound).toEqual([]);
    const result = resolveOrdinalMentions(
      document("用 图片20260917 的质感"),
      WEIXIN_IMAGES,
    );
    expect(result.converted).toBe(0);
    expect(result.document).toEqual(document("用 图片20260917 的质感"));
  });

  it("reports a rank word with no matching asset instead of silently leaving it", () => {
    const result = resolveOrdinalMentions(document("图1开场，图9收尾"), WEIXIN_IMAGES);
    expect(result.converted).toBe(1);
    expect(result.unbound).toEqual([
      { text: "图9", reason: "out-of-range", candidateCount: 3 },
    ]);
    // 「图9」原样留在正文里，只回报它为什么没绑定。
    expect(result.document.items.at(-1)).toEqual({ kind: "text", text: "开场，图9收尾" });
  });

  it("leaves relative wording untouched and says why it could not bind", () => {
    const relative = resolveOrdinalMentions(document("以第一张为准"), WEIXIN_IMAGES);
    expect(relative.converted).toBe(0);
    expect(relative.unbound).toEqual([
      { text: "第一张", reason: "relative", candidateCount: 4 },
    ]);
    // 带关键词的相对写法有确定的指代：第一张图 = 图1。
    const anchored = resolveOrdinalMentions(document("以第一张图为准"), WEIXIN_IMAGES);
    expect(aliases(anchored)).toEqual(["图1"]);
    expect(anchored.unbound).toEqual([]);
  });

  it("treats 最后一张 / 最后一段 as the last connected asset of that kind", () => {
    const result = resolveOrdinalMentions(document("最后一张图收尾"), WEIXIN_IMAGES);
    expect(aliases(result)).toEqual(["图3"]);
    // 「段」是视频的量词：同类里只有一段视频，最后一段就是它。
    const lastVideo = resolveOrdinalMentions(document("最后一段视频"), WEIXIN_IMAGES);
    expect(aliases(lastVideo)).toEqual(["视频1"]);
    // 没有具体媒体关键词时（「最后一个镜头」）不猜，只提示。
    const vague = resolveOrdinalMentions(document("最后一个镜头拉远"), WEIXIN_IMAGES);
    expect(vague.converted).toBe(0);
    expect(vague.unbound).toEqual([
      { text: "最后一个", reason: "relative", candidateCount: 4 },
    ]);
  });

  it("keeps ordinary prose and unrelated numbering as plain text", () => {
    const text = "机器人从雨夜中缓慢走来，经过第 2 个路口，手里拿着1张照片";
    expect(bindableOrdinalMentions(text, WEIXIN_IMAGES)).toEqual([]);
  });

  it("exposes the reference name the user should type for each connected asset", () => {
    expect(WEIXIN_IMAGES.map((_, index) => referenceTokenFor(WEIXIN_IMAGES, index))).toEqual([
      "图1",
      "图2",
      "图3",
      "视频1",
    ]);
  });

  it("reads Arabic and Chinese ordinals through one entry point", () => {
    expect(ordinalValue("3")).toBe(3);
    expect(ordinalValue("三")).toBe(3);
    expect(ordinalValue("十二")).toBe(12);
    expect(ordinalValue("二十")).toBe(20);
    expect(ordinalValue("甲乙")).toBeNull();
    expect(ordinalValue("0")).toBeNull();
  });

  it("leaves the document untouched when nothing is connected", () => {
    const source = document("图1 与 图2");
    const result = resolveOrdinalMentions(source, []);
    expect(result.document).toBe(source);
    expect(result.converted).toBe(0);
  });

  it("only recognises position words when the user asks for a rescan", async () => {
    // 输入期间（explicit 模式）静默把「图1」换成引用会打断书写，因此只有 names 模式才扫。
    const { createPromptContentEditorSession } = await import("./promptContent");
    const session = createPromptContentEditorSession(WEIXIN_IMAGES);
    session.replaceText("图1先入画");
    expect(session.autoResolve({ mode: "explicit" }).converted).toBe(0);
    expect(session.read().referenceCount).toBe(0);
    const manual = session.autoResolve({ mode: "names" });
    expect(manual.converted).toBe(1);
    expect(session.read().referenceCount).toBe(1);
    expect(session.snapshot().items).toEqual([
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "img-1" }),
      { kind: "text", text: "先入画" },
    ]);
  });
});
