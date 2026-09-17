import { describe, expect, it } from "vitest";
import type { MediaReferenceTarget } from "./backend";
import type { ModelParameterCapability } from "./modelCapabilities";
import type { PromptContentDocumentV1 } from "./promptContent";
import type { WhiteModelBinding } from "./whiteModelControl";
import {
  BLOCKING_FINISH_INSTRUCTION,
  PANORAMA_INSTRUCTION,
  appendPanoramaInstruction,
  blockingAssignmentsFromDraft,
  buildBlockingPromptDocument,
  createWhiteModelBlockingDraft,
  createWhiteModelBlockingObject,
  dummyNumbers,
  isPanoramaAspect,
  nextEnvironmentBinding,
  preferredPanoramaParameters,
  pruneWhiteModelCharacterBindings,
  studioImageInputsFromMedia,
  upsertCharacterBinding,
  whiteModelBlockingSignature,
} from "./whiteModelBlocking";
import { whiteModelPlanIssue } from "./whiteModelScene";
import { createWhiteModelStudioDraft, whiteModelRenderSignature } from "./whiteModelStudio";

function imageBinding(key: string, name = key): WhiteModelBinding {
  const target: MediaReferenceTarget = {
    kind: "local_file",
    path: `C:/${key}.png`,
    canvasNodeKey: key,
    mediaType: "image",
  };
  return { key, name, target };
}

function capability(
  key: string,
  options: string[],
): ModelParameterCapability {
  return {
    key,
    label: key,
    type: "string",
    defaultValue: options[0]!,
    options: options.map((value) => ({ value, label: value })),
    optional: false,
    requiresNoMedia: false,
    order: 0,
  };
}

describe("全景图提示与画幅", () => {
  it("宽画幅视为全景，并挑模型能接受的最宽尺寸", () => {
    expect(isPanoramaAspect(4096, 2048)).toBe(true);
    expect(isPanoramaAspect(1920, 1080)).toBe(true);
    expect(isPanoramaAspect(1024, 1024)).toBe(false);
    expect(
      preferredPanoramaParameters([
        capability("size", ["2K", "2048x2048", "2848x1600"]),
        capability("quality", ["standard", "hd"]),
      ]),
    ).toEqual({ size: "2848x1600" });
    expect(
      preferredPanoramaParameters([capability("aspect_ratio", ["1:1", "16:9", "21:9"])]),
    ).toEqual({ aspect_ratio: "21:9" });
  });

  it("提交时追加全景技术说明且不重复", () => {
    const first = appendPanoramaInstruction({
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "东方仙侠宗门广场" }],
    });
    expect(first.items).toEqual([
      { kind: "text", text: "东方仙侠宗门广场" },
      { kind: "text", text: "\n\n" },
      { kind: "text", text: PANORAMA_INSTRUCTION },
    ]);
    expect(appendPanoramaInstruction(first)).toBe(first);
  });
});

describe("假人编号与站位提示词", () => {
  it("只给人形编号，道具不占号", () => {
    const draft = createWhiteModelBlockingDraft();
    const prop = {
      ...createWhiteModelBlockingObject(3),
      shape: "box" as const,
      name: "道具",
    };
    const numbers = dummyNumbers([...draft.plan.objects, prop]);
    expect([...numbers.values()]).toEqual([1, 2, 3]);
    expect(numbers.get(prop.id)).toBeUndefined();
    expect(whiteModelPlanIssue(draft.plan)).toBeNull();
  });

  it("按假人编号写出场景图、站位图和角色对应关系", () => {
    const still = imageBinding("still", "站位图");
    const scene = imageBinding("scene", "宗门全景");
    const actor = imageBinding("hero", "男主");
    const extra = imageBinding("heroine", "女主");
    const resolved = buildBlockingPromptDocument(still, scene, [
      { dummyNumber: 2, character: extra },
      { dummyNumber: 1, character: actor },
    ]);
    expect(resolved.issue).toBeNull();
    expect(resolved.preview).toContain("@宗门全景 是场景图，@站位图 为人物站位图");
    expect(resolved.preview).toContain("@男主 站在1号假人位");
    expect(resolved.preview).toContain("@女主 站在2号假人位");
    expect(resolved.preview).toContain(BLOCKING_FINISH_INSTRUCTION);
    const mentions = resolved.document.items.filter((item) => item.kind === "media_reference");
    expect(mentions.map((item) => item.canvasNodeKey)).toEqual(["scene", "still", "hero", "heroine"]);
  });

  it("角色绑定跟随假人身份，删除后丢弃失效项", () => {
    const draft = createWhiteModelBlockingDraft();
    const first = draft.plan.objects[0]!;
    const second = draft.plan.objects[1]!;
    const bound = upsertCharacterBinding(undefined, first.id, imageBinding("hero"));
    const extra = upsertCharacterBinding(bound, second.id, imageBinding("heroine"));
    expect(blockingAssignmentsFromDraft({ ...draft, characterBindings: extra })).toEqual([
      { dummyNumber: 1, character: imageBinding("hero") },
      { dummyNumber: 2, character: imageBinding("heroine") },
    ]);
    const remaining = pruneWhiteModelCharacterBindings(
      extra,
      draft.plan.objects.filter((object) => object.id !== first.id),
    );
    expect(remaining).toEqual([{ actorId: second.id, reference: imageBinding("heroine") }]);
  });

  it("站位签名不进入 Blender 成片签名", () => {
    const video = createWhiteModelStudioDraft();
    const blocking = createWhiteModelBlockingDraft();
    blocking.environment = imageBinding("scene");
    expect(whiteModelRenderSignature(video)).toBe(
      whiteModelRenderSignature({ ...video, environment: imageBinding("scene") }),
    );
    expect(whiteModelBlockingSignature(blocking)).toContain("scene");
  });

  it("替换场景在已连接图片间轮换", () => {
    const scene = imageBinding("scene", "全景");
    const extra = imageBinding("hero", "男主");
    const inputs = studioImageInputsFromMedia([
      { ...scene, kind: "image", src: "asset://scene" },
      { ...extra, kind: "image", src: "asset://hero" },
    ]);
    expect(nextEnvironmentBinding(null, inputs)?.key).toBe("scene");
    expect(nextEnvironmentBinding(scene, inputs)?.key).toBe("hero");
    expect(nextEnvironmentBinding(extra, inputs)?.key).toBe("scene");
  });
});

describe("全景提示文档形状", () => {
  it("空文档也可以只提交全景说明", () => {
    const empty: PromptContentDocumentV1 = { schema: "prompt-content", version: 1, items: [] };
    const next = appendPanoramaInstruction(empty);
    expect(next.items).toEqual([{ kind: "text", text: PANORAMA_INSTRUCTION }]);
  });
});
