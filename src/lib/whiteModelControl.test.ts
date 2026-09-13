import { describe, expect, it } from "vitest";
import type { MediaReferenceTarget } from "./backend";
import type { PromptContentConnection, PromptContentDocumentV1 } from "./promptContent";
import type { SeedanceTaskMode } from "./seedanceTasks";
import {
  createWhiteModelControlConfig,
  prepareWhiteModelGeneration,
  resolveWhiteModelControl,
  type WhiteModelBinding,
  type WhiteModelControlConfig,
} from "./whiteModelControl";

const MODEL = "dreamina-seedance-2.5";

function input(key: string, kind: "video" | "image", name = key): PromptContentConnection {
  return {
    key,
    name,
    kind,
    target: {
      kind: "local_file",
      path: `C:/reference/${key}.${kind === "video" ? "mp4" : "png"}`,
      canvasNodeKey: key,
      mediaType: kind,
    },
    role: `reference_${kind}`,
  };
}

function binding(connection: PromptContentConnection): WhiteModelBinding {
  return { key: connection.key, name: connection.name, target: connection.target };
}

const video = input("white-animation", "video", "白模动画");
const actor = input("actor", "image", "角色图");
const scene = input("scene", "image", "场景图");
const inputs = [video, actor, scene];

function config(overrides: Partial<WhiteModelControlConfig> = {}): WhiteModelControlConfig {
  return {
    ...createWhiteModelControlConfig(),
    enabled: true,
    source: binding(video),
    finish: "赛博朋克电影风格",
    ...overrides,
  };
}

describe("white-model reference control", () => {
  it("starts disabled with explicit source selection and no audio or lighting constraints", () => {
    const initial = createWhiteModelControlConfig();
    expect(initial).toEqual({
      enabled: false,
      granularity: "coarse",
      source: null,
      mappings: [],
      controls: ["camera", "blocking", "motion", "composition", "timing"],
      timeline: "",
      scene: "",
      sceneReference: null,
      finish: "",
    });
    expect(resolveWhiteModelControl(initial, [], "other", "edit")).toEqual({
      issue: null,
      document: { schema: "prompt-content", version: 1, items: [] },
      preview: "",
    });
  });

  it("follows the coarse formula with explicit model and scene image identities", () => {
    const resolved = resolveWhiteModelControl(
      config({
        controls: ["camera", "motion"],
        mappings: [
          { id: "main", modelPart: "红色圆柱", description: "机甲战士", reference: binding(actor) },
        ],
        timeline: "0–3 秒：机甲战士跑向镜头；3–5 秒：举起右臂。",
        scene: "夜晚废土城市",
        sceneReference: binding(scene),
        finish: "银色金属材质",
      }),
      inputs,
      MODEL,
      "reference",
    );
    expect(resolved.issue).toBeNull();
    expect(resolved.preview).toBe(
      "【参考声明】参考@白模动画的运镜、动作与运动轨迹，以白模动画作为动态骨架生成成片。\n【对应关系映射】\n将白模视频中的「红色圆柱」替换为@角色图中的机甲战士。\n【剧情详述】0–3 秒：机甲战士跑向镜头；3–5 秒：举起右臂。\n【场景处理】背景场景参考@场景图：夜晚废土城市\n【整体收束】银色金属材质",
    );
    expect(
      resolved.document.items
        .filter((item) => item.kind === "media_reference")
        .map((item) => item.canvasNodeKey),
    ).toEqual([video.key, actor.key, scene.key]);
    expect(resolved.preview).not.toMatch(/音乐|音效|不要|保持原视频时长/);
  });

  it("follows fine rendering sections without inventing transitions or audio instructions", () => {
    const resolved = resolveWhiteModelControl(
      config({
        granularity: "fine",
        controls: [],
        timeline: "0–2 秒：人物渲染为红色陶瓷材质。2 秒灯亮后切换为暖色灯光。",
        scene: "背景为水泥墙",
        finish: "人物渲染随场景变化",
      }),
      inputs,
      MODEL,
      "auto",
    );
    expect(resolved.issue).toBeNull();
    expect(resolved.preview).toBe(
      "【渲染指令】将@白模动画的白模动画渲染成最终成片。\n【分段渲染描述】0–2 秒：人物渲染为红色陶瓷材质。2 秒灯亮后切换为暖色灯光。\n【场景处理】背景为水泥墙\n【整体收束】人物渲染随场景变化",
    );
    expect(resolved.preview).not.toMatch(/音乐|音效|转场|不要|运镜/);
  });

  it("retains explicit controls and mappings as fine rendering requirements", () => {
    const resolved = resolveWhiteModelControl(
      config({
        granularity: "fine",
        controls: ["lighting", "audio"],
        mappings: [
          { id: "main", modelPart: "左侧人物", description: "陶瓷机甲", reference: binding(actor) },
        ],
      }),
      inputs,
      MODEL,
      "reference",
    );
    expect(resolved.preview).toContain("参考该白模动画的光影变化、音乐音效。");
    expect(resolved.preview).toContain(
      "【模型渲染要求】\n将白模视频中的「左侧人物」渲染为@角色图中的陶瓷机甲。",
    );
    expect(resolved.preview).not.toContain("【对应关系映射】");
  });

  it("uses stable instances through reordering, including identical names and identical file sources", () => {
    const twinVideo = {
      ...video,
      key: "video-twin",
      target: { ...video.target, canvasNodeKey: "video-twin" },
    };
    const twinActor = {
      ...actor,
      key: "actor-twin",
      target: { ...actor.target, canvasNodeKey: "actor-twin" },
    };
    const control = config({
      mappings: [
        { id: "main", modelPart: "红球", description: "主角", reference: binding(twinActor) },
      ],
    });
    const ordered = [actor, twinVideo, video, twinActor];
    const reordered = [twinActor, video, actor, twinVideo];
    const first = prepareWhiteModelGeneration(control, ordered, MODEL, "reference", undefined);
    const second = prepareWhiteModelGeneration(control, reordered, MODEL, "reference", undefined);
    expect(first.preparation?.ok).toBe(true);
    expect(second.preparation?.ok).toBe(true);
    if (!first.preparation?.ok || !second.preparation?.ok)
      throw new Error("Expected valid preparation");
    const references = (prepared: typeof first.preparation) =>
      prepared.frozen.segments.filter((segment) => segment.kind === "media_reference");
    expect(
      references(first.preparation).map((segment) => [
        segment.target.canvasNodeKey,
        segment.typePosition,
        segment.contentIndex,
      ]),
    ).toEqual([
      [video.key, 2, 3],
      [twinActor.key, 2, 4],
    ]);
    expect(
      references(second.preparation).map((segment) => [
        segment.target.canvasNodeKey,
        segment.typePosition,
        segment.contentIndex,
      ]),
    ).toEqual([
      [video.key, 1, 2],
      [twinActor.key, 1, 1],
    ]);
    expect(references(first.preparation).map((segment) => segment.mentionId)).toEqual(
      references(second.preparation).map((segment) => segment.mentionId),
    );
  });

  it("refreshes display names only when the selected identity is unchanged", () => {
    const current = inputs.map((entry) =>
      entry.key === video.key ? { ...entry, name: "新视频名称" } : entry,
    );
    const selected = config();
    const resolved = resolveWhiteModelControl(selected, current, MODEL, "reference");
    expect(resolved.issue).toBeNull();
    expect(resolved.preview).toContain("@新视频名称");
    expect(selected.source?.name).toBe("白模动画");
    expect(resolved.document.items.find((item) => item.kind === "media_reference")?.target).toEqual(
      video.target,
    );
  });

  it("never chooses the first connected video without an explicit binding", () => {
    expect(
      resolveWhiteModelControl(config({ source: null }), inputs, MODEL, "reference").issue,
    ).toContain("请选择白模参考视频");
  });

  it("rejects a disconnected source despite another same-name instance of the same media", () => {
    const replacement = {
      ...video,
      key: "replacement",
      target: { ...video.target, canvasNodeKey: "replacement" },
    };
    const resolved = resolveWhiteModelControl(config(), [replacement, actor], MODEL, "reference");
    expect(resolved.issue).toContain("已断开连接");
    expect(resolved.document.items).toEqual([]);
  });

  it("rejects changed source identity even at the same key and name", () => {
    const changed = {
      ...video,
      target: {
        kind: "local_file" as const,
        path: "C:/another.mp4",
        canvasNodeKey: video.key,
        mediaType: "video" as const,
      },
    };
    expect(
      resolveWhiteModelControl(config(), [changed, actor], MODEL, "reference").issue,
    ).toContain("来源已变化");
  });

  it("validates mapping and scene reference identities independently", () => {
    const mapped = config({
      mappings: [{ id: "main", modelPart: "红球", description: "主角", reference: binding(actor) }],
    });
    expect(resolveWhiteModelControl(mapped, [video, scene], MODEL, "auto").issue).toContain(
      "白模「红球」的参考图片「角色图」已断开连接",
    );
    const changedScene = {
      ...scene,
      target: { ...scene.target, kind: "local_file" as const, path: "C:/changed-scene.png" },
    };
    expect(
      resolveWhiteModelControl(
        config({ sceneReference: binding(scene) }),
        [video, actor, changedScene],
        MODEL,
        "auto",
      ).issue,
    ).toContain("场景参考图片「场景图」的来源已变化");
  });

  it("rejects URL references, invalid instance keys and wrong media types", () => {
    const url = {
      key: "url",
      name: "链接",
      kind: "video" as const,
      target: {
        kind: "url" as const,
        url: "https://example.com/video.mp4",
        mediaType: "video" as const,
      },
    };
    expect(
      resolveWhiteModelControl(config({ source: binding(url) }), [url], MODEL, "auto").issue,
    ).toContain("素材身份无效");
    expect(
      resolveWhiteModelControl(
        config({ source: { ...binding(video), key: "other-key" } }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toContain("素材身份无效");
    expect(
      resolveWhiteModelControl(config({ source: binding(actor) }), inputs, MODEL, "auto").issue,
    ).toContain("素材身份无效");
    expect(
      resolveWhiteModelControl(config({ sceneReference: binding(video) }), inputs, MODEL, "auto")
        .issue,
    ).toContain("素材身份无效");
  });

  it.each(["edit", "extend", "first_frame", "first_last_frame"] as const)(
    "rejects incompatible %s task without silently changing it",
    (mode: SeedanceTaskMode) => {
      expect(resolveWhiteModelControl(config(), inputs, MODEL, mode).issue).toContain(
        "请先切换任务类型",
      );
    },
  );

  it("rejects other models", () => {
    expect(resolveWhiteModelControl(config(), inputs, "seedance-2.0", "auto").issue).toContain(
      "Seedance 2.5",
    );
  });

  it("requires rendering details and accepts a scene reference as the rendering direction", () => {
    expect(
      resolveWhiteModelControl(config({ finish: " " }), inputs, MODEL, "auto").issue,
    ).toContain("请填写剧情或分段渲染");
    const sceneOnly = resolveWhiteModelControl(
      config({ finish: "", sceneReference: binding(scene) }),
      inputs,
      MODEL,
      "auto",
    );
    expect(sceneOnly.issue).toBeNull();
    expect(sceneOnly.preview).toContain("【场景处理】背景场景参考@场景图。");
    expect(
      resolveWhiteModelControl(
        config({
          finish: "",
          mappings: [{ id: "main", modelPart: "红球", description: "", reference: binding(actor) }],
        }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toBeNull();
    expect(
      resolveWhiteModelControl(
        config({
          finish: "",
          mappings: [{ id: "main", modelPart: "红球", description: "机甲战士", reference: null }],
        }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toBeNull();
  });

  it("rejects duplicate mapping IDs and equivalent selectors before compiling references", () => {
    const main = {
      id: "main",
      modelPart: " Red Cube ",
      description: "主角",
      reference: binding(actor),
    };
    expect(
      resolveWhiteModelControl(
        config({ mappings: [main, { ...main, modelPart: "Blue Cube" }] }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toContain("标识重复");
    expect(
      resolveWhiteModelControl(
        config({ mappings: [main, { ...main, id: "second", modelPart: "red　cube" }] }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toContain("重复对应关系");
  });

  it("rejects incomplete mapping rows instead of dropping them", () => {
    expect(
      resolveWhiteModelControl(
        config({ mappings: [{ id: "main", modelPart: "", description: "主角", reference: null }] }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toContain("可辨识特征");
    expect(
      resolveWhiteModelControl(
        config({
          mappings: [{ id: "main", modelPart: "红球", description: " ", reference: null }],
        }),
        inputs,
        MODEL,
        "auto",
      ).issue,
    ).toContain("填写角色");
  });

  it.each([
    { timeline: "@图片1 向前行走" },
    { timeline: "参考@图片1 的造型向前行走" },
    { scene: "场景：（＠场景图）" },
    { finish: "参考 @角色图 的材质" },
    { finish: "参考.@角色图" },
    {
      mappings: [{ id: "main", modelPart: "@图片1 的红球", description: "主角", reference: null }],
    },
    {
      mappings: [{ id: "main", modelPart: "红球", description: "使用 @角色图", reference: null }],
    },
  ] satisfies Partial<WhiteModelControlConfig>[])(
    "rejects unbound config mentions before any input order can reassign their identity: %j",
    (description) => {
      const expectedIssue =
        "白模文字描述中的素材引用请使用角色／道具或场景参考图选择器；需要自由插入 @ 引用时，请写在上方提示词输入框中。";
      for (const ordered of [inputs, [...inputs].reverse()]) {
        expect(
          prepareWhiteModelGeneration(config(description), ordered, MODEL, "auto", undefined),
        ).toEqual({ issue: expectedIssue, preparation: null });
      }
    },
  );

  it("accepts ordinary email addresses and literal at-sign text without treating them as references", () => {
    const resolved = resolveWhiteModelControl(
      config({
        timeline: "0–3 秒：角色举起写着 name@example.com 的信封。",
        scene: "招牌写着 contact+film@example.com。",
        finish: "标点 @ 单独写在纸上。保持 name-@example.com 的排版。",
      }),
      inputs,
      MODEL,
      "auto",
    );
    expect(resolved.issue).toBeNull();
    expect(resolved.preview).toContain("name@example.com");
    expect(resolved.preview).toContain("标点 @ 单独写在纸上");
  });
});

describe("white-model generation through the canonical prompt validator", () => {
  const original: PromptContentDocumentV1 = {
    schema: "prompt-content",
    version: 1,
    items: [
      { kind: "text", text: "保留用户自写的开场\n让" },
      {
        kind: "media_reference",
        mentionId: "original-actor",
        canvasNodeKey: actor.key,
        target: actor.target as MediaReferenceTarget,
        displayNameSnapshot: actor.name,
      },
      { kind: "text", text: "先回头，再向前走。" },
    ],
  };

  it("appends transient white-model instructions while preserving user text, references and all connected media", () => {
    const saved = structuredClone(original);
    const result = prepareWhiteModelGeneration(config(), inputs, MODEL, "auto", original);
    expect(result.issue).toBeNull();
    expect(result.preparation?.ok).toBe(true);
    if (!result.preparation?.ok) throw new Error("Expected preparation");
    expect(result.preparation.frozen.plainText).toContain(
      "保留用户自写的开场\n让@角色图先回头，再向前走。\n\n【参考声明】",
    );
    expect(
      result.preparation.frozen.segments.find(
        (segment) => segment.kind === "media_reference" && segment.mentionId === "original-actor",
      ),
    ).toMatchObject({ target: actor.target, displayNameSnapshot: actor.name });
    expect(result.preparation.frozen.explicitMedia.map((item) => [item.target, item.role])).toEqual(
      inputs.map((entry) => [entry.target, entry.role]),
    );
    expect(original).toEqual(saved);
  });

  it("allows an empty base prompt when white-model settings provide the rendering instructions", () => {
    const result = prepareWhiteModelGeneration(config(), inputs, MODEL, "auto", undefined);
    expect(result.issue).toBeNull();
    expect(result.preparation?.ok).toBe(true);
  });

  it("still resolves explicit mentions written in the main canonical prompt", () => {
    const result = prepareWhiteModelGeneration(config(), inputs, MODEL, "auto", {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "让 @角色图 先回头。" }],
    });
    expect(result.issue).toBeNull();
    expect(result.preparation?.ok).toBe(true);
    if (!result.preparation?.ok) throw new Error("Expected preparation");
    expect(
      result.preparation.frozen.segments
        .filter((segment) => segment.kind === "media_reference")
        .map((segment) => segment.target.canvasNodeKey),
    ).toEqual([actor.key, video.key]);
  });

  it("returns canonical disconnected-reference errors from the user's existing document", () => {
    const result = prepareWhiteModelGeneration(config(), [video], MODEL, "auto", original);
    expect(result.issue).toBeNull();
    expect(result.preparation).toEqual({
      ok: false,
      issues: [
        {
          kind: "disconnected_reference",
          mentionId: "original-actor",
          canvasNodeKey: actor.key,
          displayName: actor.name,
        },
      ],
    });
  });

  it("returns canonical changed-identity errors without replacing the user's existing reference", () => {
    const changedActor = {
      ...actor,
      target: { ...actor.target, kind: "local_file" as const, path: "C:/other-actor.png" },
    };
    const result = prepareWhiteModelGeneration(
      config(),
      [video, changedActor],
      MODEL,
      "auto",
      original,
    );
    expect(result.preparation).toMatchObject({
      ok: false,
      issues: [{ kind: "reference_identity_changed", mentionId: "original-actor" }],
    });
  });

  it("does not collide with original mention IDs or silently discard a malformed original document", () => {
    const collision: PromptContentDocumentV1 = {
      ...original,
      items: original.items.map((item) =>
        item.kind === "media_reference" ? { ...item, mentionId: "white-model:source" } : item,
      ),
    };
    const result = prepareWhiteModelGeneration(config(), inputs, MODEL, "auto", collision);
    expect(result.preparation?.ok).toBe(true);
    if (!result.preparation?.ok) throw new Error("Expected preparation");
    expect(
      result.preparation.frozen.segments
        .filter((item) => item.kind === "media_reference")
        .map((item) => item.mentionId),
    ).toEqual(["white-model:source", "white-model:source:generated"]);
    const invalid = { ...original, items: [...original.items, ...original.items] };
    expect(prepareWhiteModelGeneration(config(), inputs, MODEL, "auto", invalid)).toEqual({
      issue: "原提示内容格式无效，请检查提示词后重试。",
      preparation: null,
    });
  });
});
