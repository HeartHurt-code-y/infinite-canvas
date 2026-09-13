import { describe, expect, it } from "vitest";
import {
  createGreenScreenConfig,
  greenScreenPreparationSignature,
  prepareGreenScreenGeneration,
  resolveGreenScreen,
  type GreenScreenBinding,
  type GreenScreenConfig,
} from "./greenScreen";
import type { PromptContentConnection, PromptContentDocumentV1 } from "./promptContent";

const MODEL = "dreamina-seedance-2.5";

function input(key: string, kind: "video" | "image", name = key): PromptContentConnection {
  return {
    key,
    kind,
    name,
    target: {
      kind: "local_file",
      path: `C:/reference/${key}.${kind === "video" ? "mp4" : "png"}`,
      canvasNodeKey: key,
      mediaType: kind,
    },
    role: `reference_${kind}`,
  };
}

const source = input("source", "video", "原视频");
const actor = input("actor", "image", "主体图");
const foreground = input("foreground", "video", "绿幕人物");
const effect = input("effect", "video", "绿幕爆炸");
const scene = input("scene", "image", "教室");
const backgroundVideo = input("background-video", "video", "街景运镜");
const inputs = [source, actor, foreground, effect, scene, backgroundVideo];

function binding(connection: PromptContentConnection): GreenScreenBinding {
  return { key: connection.key, name: connection.name, target: connection.target };
}

function config(overrides: Partial<GreenScreenConfig> = {}): GreenScreenConfig {
  return {
    ...createGreenScreenConfig(),
    enabled: true,
    subject: "穿白色衬衫的讲师抬手讲解",
    ...overrides,
  };
}

function composite(overrides: Partial<GreenScreenConfig> = {}): GreenScreenConfig {
  return config({
    phase: "composite",
    foregrounds: [binding(foreground)],
    scene: "自然采光的现代教室",
    ...overrides,
  });
}

function documentWithReference(
  connection: PromptContentConnection,
  mentionId = "original-reference",
): PromptContentDocumentV1 {
  if (connection.target.kind === "url") throw new Error("Expected stable canvas media identity");
  return {
    schema: "prompt-content",
    version: 1,
    items: [
      { kind: "text", text: "用户原文与自由引用：" },
      {
        kind: "media_reference",
        mentionId,
        canvasNodeKey: connection.key,
        target: connection.target,
        displayNameSnapshot: connection.name,
      },
      { kind: "text", text: "。保留这个要求。" },
    ],
  };
}

describe("green-screen preparation and seamless composition", () => {
  it("starts with an optional two-stage workflow and preserved foreground speech", () => {
    expect(createGreenScreenConfig()).toMatchObject({
      enabled: false,
      phase: "prepare",
      preparationMode: "generate",
      audio: "preserve",
      source: null,
      subjectReference: null,
      foregrounds: [],
      preparationTasks: [],
    });
    expect(resolveGreenScreen(createGreenScreenConfig(), inputs, "other").issue).toBeNull();
    expect(resolveGreenScreen(config(), inputs, "seedance-2.0").issue).toContain("Seedance 2.5");
  });

  it("creates green-screen footage from text or an image, excluding downstream footage and scene", () => {
    const settings = config({
      subjectReference: binding(actor),
      source: binding(source),
      foregrounds: [binding(foreground)],
      background: binding(scene),
      scene: "不应进入制作的教室",
      integration: "不应进入制作的爆炸",
      audio: "mute",
    });
    const resolved = prepareGreenScreenGeneration(settings, inputs, MODEL);
    expect(resolved.issue).toBeNull();
    expect(resolved.taskMode).toBe("auto");
    expect(resolved.connections.map((entry) => entry.key)).toEqual([actor.key]);
    expect(resolved.preview).toContain("#00FF00");
    expect(resolved.preview).toContain("@主体图");
    expect(resolved.preview).not.toMatch(/教室|爆炸|原视频|静音/);
    expect(resolved.preparation?.ok).toBe(true);
    if (!resolved.preparation?.ok) throw new Error("Expected valid preparation");
    expect(resolved.preparation.frozen.plainText).toBe(resolved.preview);
    expect(
      resolved.preparation.frozen.explicitMedia.map((entry) => entry.target.canvasNodeKey),
    ).toEqual([actor.key]);
    expect(resolveGreenScreen(config({ subject: "" }), inputs, MODEL).issue).toContain("请描述");
    expect(
      resolveGreenScreen(config({ subject: "", subjectReference: binding(actor) }), inputs, MODEL)
        .issue,
    ).toBeNull();
  });

  it("converts a selected source video while preserving identity, movement and speech", () => {
    const result = prepareGreenScreenGeneration(
      config({
        preparationMode: "convert",
        source: binding(source),
        subjectReference: binding(actor),
      }),
      inputs,
      MODEL,
    );
    expect(result.issue).toBeNull();
    expect(result.taskMode).toBe("edit");
    expect(result.connections.map((entry) => entry.key)).toEqual([source.key]);
    expect(result.preview).toContain("仅将背景替换为纯色绿幕");
    expect(result.preview).toContain("原始表演、动作轨迹");
    expect(result.preview).toContain("人声与声音连续");
    expect(result.preview).not.toContain("@主体图");
    expect(
      resolveGreenScreen(config({ preparationMode: "convert" }), inputs, MODEL).issue,
    ).toContain("请选择待转绿幕");
    expect(
      resolveGreenScreen(
        config({ preparationMode: "convert", source: binding(actor) }),
        inputs,
        MODEL,
      ).issue,
    ).toContain("素材身份无效");
  });

  it("requires existing green-screen footage to move to composition instead of charging for a new take", () => {
    const existing = prepareGreenScreenGeneration(
      config({ preparationMode: "existing" }),
      inputs,
      MODEL,
    );
    expect(existing.issue).toContain("进入场景合成");
    expect(existing.preparation).toBeNull();
    expect(
      resolveGreenScreen(composite({ preparationMode: "existing" }), inputs, MODEL).taskMode,
    ).toBe("edit");
  });

  it("composites multiple green-screen roles against a moving background with stable references", () => {
    const settings = composite({
      foregrounds: [binding(foreground), binding(effect)],
      background: binding(backgroundVideo),
      source: binding(source),
      subjectReference: binding(actor),
      integration: "镜头推进时，第二段的爆炸出现在第一段人物身后，人物随后回头。",
    });
    const first = prepareGreenScreenGeneration(settings, inputs, MODEL);
    const second = prepareGreenScreenGeneration(settings, [...inputs].reverse(), MODEL);
    expect(first.issue).toBeNull();
    expect(first.taskMode).toBe("edit");
    expect(first.preview).toContain("绿幕前景 1：@绿幕人物");
    expect(first.preview).toContain("绿幕前景 2：@绿幕爆炸");
    expect(first.preview).toContain("背景场景参考@街景运镜");
    expect(first.preview).toContain(settings.integration);
    expect(first.preview).toContain("帧间稳定");
    expect(first.preview).not.toContain("@原视频");
    expect(first.preview).not.toContain("@主体图");
    expect(first.preparation?.ok).toBe(true);
    expect(second.preparation?.ok).toBe(true);
    if (!first.preparation?.ok || !second.preparation?.ok)
      throw new Error("Expected valid preparation");
    const references = (result: typeof first.preparation) =>
      result.frozen.segments.filter((entry) => entry.kind === "media_reference");
    expect(references(first.preparation).map((entry) => entry.target.canvasNodeKey)).toEqual([
      foreground.key,
      effect.key,
      backgroundVideo.key,
    ]);
    expect(references(first.preparation).map((entry) => entry.mentionId)).toEqual(
      references(second.preparation).map((entry) => entry.mentionId),
    );
    expect(references(second.preparation).map((entry) => entry.contentIndex)).toEqual([3, 2, 1]);
    expect(first.preparation.frozen.plainText).toBe(first.preview);
  });

  it("requires explicit foregrounds and a described or referenced background", () => {
    expect(resolveGreenScreen(composite({ foregrounds: [] }), inputs, MODEL).issue).toContain(
      "至少选择",
    );
    expect(resolveGreenScreen(composite({ scene: "" }), inputs, MODEL).issue).toContain("新场景");
    expect(
      resolveGreenScreen(composite({ scene: "", background: binding(scene) }), inputs, MODEL).issue,
    ).toBeNull();
    expect(
      resolveGreenScreen(composite({ foregrounds: [binding(actor)] }), inputs, MODEL).issue,
    ).toContain("素材身份无效");
  });

  it("rejects duplicate foreground roles and using one instance as both foreground and background", () => {
    expect(
      resolveGreenScreen(
        composite({ foregrounds: [binding(foreground), binding(foreground)] }),
        inputs,
        MODEL,
      ).issue,
    ).toContain("重复");
    expect(
      resolveGreenScreen(composite({ background: binding(foreground) }), inputs, MODEL).issue,
    ).toContain("不能同时");
  });

  it("never substitutes a disconnected binding with another instance having the same name and source", () => {
    const twin: PromptContentConnection = {
      ...foreground,
      key: "twin",
      target: { ...foreground.target, canvasNodeKey: "twin" },
    };
    const replacement = inputs.filter((entry) => entry.key !== foreground.key).concat(twin);
    expect(resolveGreenScreen(composite(), replacement, MODEL).issue).toContain("已断开连接");
    expect(
      resolveGreenScreen(composite({ foregrounds: [binding(twin)] }), replacement, MODEL).issue,
    ).toBeNull();
    expect(
      resolveGreenScreen(composite({ background: binding(scene) }), [foreground], MODEL).issue,
    ).toContain("背景参考素材「教室」已断开连接");
  });

  it("rejects changed media at the same key and malformed binding identity", () => {
    const changed: PromptContentConnection = {
      ...foreground,
      target: {
        kind: "local_file",
        path: "C:/changed.mp4",
        mediaType: "video",
        canvasNodeKey: foreground.key,
      },
    };
    expect(resolveGreenScreen(composite(), [changed], MODEL).issue).toContain("来源已变化");
    expect(
      resolveGreenScreen(
        composite({ foregrounds: [{ ...binding(foreground), key: "wrong-key" }] }),
        inputs,
        MODEL,
      ).issue,
    ).toContain("素材身份无效");
  });

  it("retains the original body and its explicit inputs while avoiding generated mention collisions", () => {
    const previous = documentWithReference(
      actor,
      `green-screen:composite:foreground:1:${foreground.key}`,
    );
    const snapshot = structuredClone(previous);
    const result = prepareGreenScreenGeneration(composite(), inputs, MODEL, previous);
    expect(previous).toEqual(snapshot);
    expect(result.document.items.slice(0, previous.items.length)).toEqual(previous.items);
    expect(result.preview).toContain("用户原文与自由引用：@主体图。保留这个要求。");
    expect(result.connections.map((entry) => entry.key)).toEqual([actor.key, foreground.key]);
    const ids = result.document.items.flatMap((item) =>
      "mentionId" in item ? [item.mentionId] : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`green-screen:composite:foreground:1:${foreground.key}:generated`);
    expect(result.preparation?.ok).toBe(true);
  });

  it("resolves newly typed explicit references before narrowing stage inputs, without adding bare-name media", () => {
    const previous: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "服装参考@主体图，教室可以稍后选择。" }],
    };
    const result = prepareGreenScreenGeneration(composite(), inputs, MODEL, previous);
    expect(previous.items).toEqual([{ kind: "text", text: "服装参考@主体图，教室可以稍后选择。" }]);
    expect(result.preparation?.ok).toBe(true);
    expect(result.connections.map((entry) => entry.key)).toEqual([actor.key, foreground.key]);
    expect(
      result.document.items.some(
        (item) => item.kind === "media_reference" && item.canvasNodeKey === actor.key,
      ),
    ).toBe(true);
    expect(result.preview).toContain("服装参考@主体图，教室可以稍后选择。");
  });

  it("keeps ambiguous original mentions pending even when the active stage selects only one candidate", () => {
    const twin: PromptContentConnection = {
      ...foreground,
      key: "twin",
      target: { ...foreground.target, canvasNodeKey: "twin" },
    };
    const result = prepareGreenScreenGeneration(composite(), [foreground, twin], MODEL, {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "参考@绿幕人物" }],
    });
    expect(result.connections.map((entry) => entry.key)).toEqual([foreground.key]);
    expect(result.preparation).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ kind: "pending_reference", candidateCount: 2 })],
    });
  });

  it("replaces stale frame roles with reference roles before freezing the stage request", () => {
    const result = prepareGreenScreenGeneration(
      composite({ background: binding(scene) }),
      inputs.map((entry) => ({
        ...entry,
        role: entry.key === scene.key ? "last_frame" : "first_frame",
      })),
      MODEL,
    );
    expect(result.preparation?.ok).toBe(true);
    if (!result.preparation?.ok) throw new Error("Expected valid preparation");
    expect(result.preparation.frozen.explicitMedia.map((entry) => entry.role)).toEqual([
      "reference_video",
      "reference_image",
    ]);
  });

  it("keeps disconnected or changed original references so canonical preparation rejects the request", () => {
    const previous = documentWithReference(actor);
    const disconnected = prepareGreenScreenGeneration(composite(), [foreground], MODEL, previous);
    expect(disconnected.issue).toBeNull();
    expect(disconnected.document.items.slice(0, previous.items.length)).toEqual(previous.items);
    expect(disconnected.preparation).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ kind: "disconnected_reference", canvasNodeKey: actor.key }),
      ],
    });
    const changedActor: PromptContentConnection = {
      ...actor,
      target: {
        kind: "local_file",
        path: "C:/other-actor.png",
        mediaType: "image",
        canvasNodeKey: actor.key,
      },
    };
    expect(
      prepareGreenScreenGeneration(composite(), [foreground, changedActor], MODEL, previous)
        .preparation,
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ kind: "reference_identity_changed" })],
    });
  });

  it("rejects unbound description mentions only in the active stage", () => {
    expect(resolveGreenScreen(config({ subject: "参考＠主体图" }), inputs, MODEL).issue).toContain(
      "选择器",
    );
    expect(
      resolveGreenScreen(composite({ integration: "使用@绿幕爆炸" }), inputs, MODEL).issue,
    ).toContain("选择器");
    expect(resolveGreenScreen(config({ scene: "参考@教室" }), inputs, MODEL).issue).toBeNull();
    expect(
      resolveGreenScreen(composite({ subject: "参考@主体图" }), inputs, MODEL).issue,
    ).toBeNull();
  });

  it.each([
    ["preserve", "保留绿幕前景视频中的原有人声"],
    ["mute", "输出静音成片"],
    ["scene", "按新场景生成匹配的环境声音"],
  ] as const)("compiles the explicit %s audio choice", (audio, expected) => {
    expect(resolveGreenScreen(composite({ audio }), inputs, MODEL).preview).toContain(expected);
  });

  it("invalidates prepared takes for actual preparation changes while keeping later composition edits separate", () => {
    const settings = config({ subjectReference: binding(actor) });
    const signature = greenScreenPreparationSignature(settings);
    expect(
      greenScreenPreparationSignature({
        ...settings,
        phase: "composite",
        foregrounds: [binding(foreground)],
        scene: "新的场景",
        background: binding(scene),
        integration: "新特效",
        audio: "mute",
        preparationTasks: [{ taskId: "task-1", signature: "saved" }],
        subjectReference: { ...binding(actor), name: "已重命名" },
      }),
    ).toBe(signature);
    expect(greenScreenPreparationSignature({ ...settings, subject: "新的动作" })).not.toBe(
      signature,
    );
    expect(
      greenScreenPreparationSignature({ ...settings, subjectReference: binding(scene) }),
    ).not.toBe(signature);
    const conversion = config({ preparationMode: "convert", source: binding(source) });
    expect(
      greenScreenPreparationSignature({ ...conversion, source: binding(foreground) }),
    ).not.toBe(greenScreenPreparationSignature(conversion));
  });
});
