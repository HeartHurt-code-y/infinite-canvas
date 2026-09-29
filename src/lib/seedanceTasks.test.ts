import { describe, expect, it } from "vitest";
import {
  defaultModelOperationSchema,
  modelParameterCapabilities,
  type ModelParameterCapability,
} from "./modelCapabilities";
import {
  resolveSeedanceTask,
  seedanceTaskOptions,
  selectSeedanceTask,
  type SeedanceTaskMode,
} from "./seedanceTasks";

const DOMESTIC = "doubao-seedance-2-5-260628";
const OVERSEAS = "dreamina-seedance-2.5";
const imageA = { key: "image-a", kind: "image" as const };
const imageB = { key: "image-b", kind: "image" as const };
const video = { key: "video-a", kind: "video" as const };
function capabilities(modelId = DOMESTIC) {
  return modelParameterCapabilities(
    defaultModelOperationSchema(modelId, ["video_generation"]),
    "video_generation",
    modelId,
  );
}

function customDuration(patch: Partial<ModelParameterCapability>) {
  return capabilities().map((capability) =>
    capability.key === "duration" ? { ...capability, ...patch } : capability,
  );
}

describe("Seedance task parameter and media contract", () => {
  it.each([DOMESTIC, OVERSEAS])(
    "normalizes restored edit parameters for %s without widening its schema",
    (modelId) => {
      const state = resolveSeedanceTask(
        modelId,
        capabilities(modelId),
        {
          seedanceTaskMode: "edit",
          parameterValues: { ratio: "16:9", duration: 12, priority: 4 },
          mediaRoles: { "image-a": "first_frame" },
        },
        [video, imageA],
      );
      expect(state.issue).toBeNull();
      expect(state.parameters).toMatchObject({ ratio: "adaptive", duration: -1 });
      expect(state.mediaRoles).toEqual({
        "video-a": "reference_video",
        "image-a": "reference_image",
      });
      expect(state.lockedParameters).toEqual(["ratio", "duration"]);
      if (modelId === DOMESTIC) {
        expect(state.parameters).toHaveProperty("omni_reference_task_type", "edit");
        expect(state.parameters).not.toHaveProperty("priority");
      } else {
        expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
        expect(state.parameters).toHaveProperty("priority", 4);
        expect(state.parameters["resolution"]).toBe("720p");
      }
    },
  );

  it("assigns and preserves first/last frame identities without an omni task field", () => {
    const state = resolveSeedanceTask(
      DOMESTIC,
      capabilities(),
      {
        seedanceTaskMode: "first_last_frame",
        parameterValues: { ratio: "9:16", duration: 8 },
        mediaRoles: { "image-a": "last_frame", "image-b": "first_frame" },
      },
      [imageA, imageB],
    );
    expect(state.issue).toBeNull();
    expect(state.parameters).toMatchObject({ ratio: "adaptive", duration: 8 });
    expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
    expect(state.mediaRoles).toEqual({ "image-a": "last_frame", "image-b": "first_frame" });
  });

  it.each([
    ["first_frame", []],
    ["first_frame", [imageA, imageB]],
    ["first_last_frame", [imageA]],
    ["first_last_frame", [imageA, imageB, video]],
    ["edit", [imageA]],
    ["extend", []],
    ["reference", []],
  ] as const)("blocks missing or mixed media for %s", (mode, inputs) => {
    const state = resolveSeedanceTask(
      DOMESTIC,
      capabilities(),
      { seedanceTaskMode: mode, parameterValues: {} },
      inputs,
    );
    expect(state.issue).not.toBeNull();
    expect(Object.keys(state.mediaRoles)).toHaveLength(inputs.length);
  });

  it("keeps extension duration adjustable, then resets defaults and frame roles on task change", () => {
    const initial = {
      seedanceTaskMode: "first_frame" as SeedanceTaskMode,
      parameterValues: { ratio: "1:1", duration: 10 },
      mediaRoles: { "image-a": "first_frame" },
    };
    const extended = selectSeedanceTask(
      DOMESTIC,
      capabilities(),
      initial,
      [video, imageA],
      "extend",
    );
    const state = resolveSeedanceTask(DOMESTIC, capabilities(), extended, [video, imageA]);
    expect(state.parameters).toMatchObject({
      ratio: "adaptive",
      duration: 10,
      omni_reference_task_type: "extend",
    });
    expect(state.lockedParameters).toEqual(["ratio"]);
    expect(state.mediaRoles[imageA.key]).toBe("reference_image");
    expect(
      selectSeedanceTask(DOMESTIC, capabilities(), extended, [video], "auto").parameterValues,
    ).toMatchObject({ ratio: "adaptive", duration: -1 });
  });

  it("restores the previous task parameter and does not emit a task field for text only", () => {
    expect(
      resolveSeedanceTask(
        DOMESTIC,
        capabilities(),
        { parameterValues: { omni_reference_task_type: "edit" } },
        [video],
      ).mode,
    ).toBe("edit");
    expect(
      resolveSeedanceTask(DOMESTIC, capabilities(), { parameterValues: {} }, []).parameters,
    ).not.toHaveProperty("omni_reference_task_type");
  });

  it("does not apply Seedance restrictions to other models", () => {
    const modelId = "wan3.0-video";
    const state = resolveSeedanceTask(
      modelId,
      capabilities(modelId),
      {
        seedanceTaskMode: "edit",
        parameterValues: { ratio: "16:9", duration: 5 },
        mediaRoles: { "image-a": "first_frame" },
      },
      [imageA],
    );
    expect(state.enabled).toBe(false);
    expect(state.issue).toBeNull();
    expect(state.mediaRoles[imageA.key]).toBe("first_frame");
    expect(state.parameters).toMatchObject({ ratio: "16:9", duration: 5 });
  });

  it.each(["first_frame", "first_last_frame", "extend"] as const)(
    "intersects custom duration options for %s on restoration and submission",
    (mode) => {
      const caps = customDuration({
        options: [-1, 2, 3, 5, 45].map((value) => ({ value, label: String(value) })),
        defaultValue: 45,
      });
      const state = resolveSeedanceTask(
        DOMESTIC,
        caps,
        { seedanceTaskMode: mode, parameterValues: { duration: 2 } },
        mode === "extend" ? [video] : mode === "first_frame" ? [imageA] : [imageA, imageB],
      );
      expect(state.issue).toBeNull();
      expect(
        state.parameterCapabilities
          .find((capability) => capability.key === "duration")
          ?.options.map((option) => option.value),
      ).toEqual([-1, 5]);
      expect(state.parameterValues["duration"]).toBe(-1);
      expect(state.parameters["duration"]).toBe(-1);
    },
  );

  it("selects an opened duration without inventing smart duration and respects numeric bounds", () => {
    const caps = customDuration({
      options: [2, 3, 6, 12, 45].map((value) => ({ value, label: String(value) })),
      defaultValue: 45,
    });
    const selected = selectSeedanceTask(
      DOMESTIC,
      caps,
      { parameterValues: { duration: -1 } },
      [video],
      "extend",
    );
    expect(selected.parameterValues["duration"]).toBe(6);
    expect(resolveSeedanceTask(DOMESTIC, caps, selected, [video]).parameters["duration"]).toBe(6);
    const bounded = resolveSeedanceTask(
      DOMESTIC,
      customDuration({ type: "number", options: [], minimum: 6, maximum: 9, defaultValue: 6.5 }),
      { seedanceTaskMode: "extend", parameterValues: { duration: 45 } },
      [video],
    );
    expect(
      bounded.parameterCapabilities
        .find((capability) => capability.key === "duration")
        ?.options.map((option) => option.value),
    ).toEqual([6, 7, 8, 9]);
    expect(bounded.parameters["duration"]).toBe(6);
  });

  it("blocks empty intersections and respects the edit smart-duration schema including bounds", () => {
    const caps = customDuration({
      options: [2, 3, 45].map((value) => ({ value, label: String(value) })),
      defaultValue: 45,
    });
    const blocked = resolveSeedanceTask(
      DOMESTIC,
      caps,
      { seedanceTaskMode: "extend", parameterValues: { duration: 45 } },
      [video],
    );
    expect(blocked.issue).toContain("可用时长");
    expect(blocked.parameters).not.toHaveProperty("duration");
    expect(blocked.lockedParameters).toContain("duration");
    const edit = resolveSeedanceTask(
      DOMESTIC,
      customDuration({ minimum: 4, defaultValue: 5 }),
      { seedanceTaskMode: "edit", parameterValues: {} },
      [video],
    );
    expect(edit.issue).toContain("未开放智能时长");
    expect(edit.parameters).not.toHaveProperty("duration");
  });

  it("rejects a restricted remote task enum instead of silently submitting auto", () => {
    const caps = capabilities().map((capability) =>
      capability.key === "omni_reference_task_type"
        ? {
            ...capability,
            options: ["auto", "reference"].map((value) => ({ value, label: value })),
            defaultValue: "auto",
          }
        : capability,
    );
    const state = resolveSeedanceTask(
      DOMESTIC,
      caps,
      { seedanceTaskMode: "edit", parameterValues: {} },
      [video],
    );
    expect(state.issue).toContain("任务字段未开放所选任务类型");
    expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
  });
});

describe("RD gateway task contract", () => {
  const RD = "rd-seedance-2.5-720p";

  it("only offers auto and first-last-frame task options for RD models", () => {
    const options = seedanceTaskOptions(RD).map((option) => option.value);
    expect(options).toEqual(["auto", "first_last_frame"]);
    // 魔芋 Seedance 2.5 保留全部六档任务。
    expect(seedanceTaskOptions(DOMESTIC)).toHaveLength(6);
  });

  it("keeps explicit duration/ratio in auto mode instead of forcing adaptive/smart defaults", () => {
    const state = resolveSeedanceTask(
      RD,
      capabilities(RD),
      { seedanceTaskMode: "auto", parameterValues: { ratio: "21:9", duration: 12 } },
      [imageA, video, imageB],
    );
    expect(state.enabled).toBe(true);
    expect(state.mode).toBe("auto");
    expect(state.issue).toBeNull();
    // 全部素材自动设为参考角色。
    expect(state.mediaRoles).toEqual({
      "image-a": "reference_image",
      "video-a": "reference_video",
      "image-b": "reference_image",
    });
    // RD 没有自适应画幅与智能时长：用户所选值原样提交。
    expect(state.parameters["ratio"]).toBe("21:9");
    expect(state.parameters["duration"]).toBe(12);
    expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
    // 未选择时长时回退到档案默认值 5（RD 的 duration 是必填字段）。
    const defaulted = resolveSeedanceTask(RD, capabilities(RD), { parameterValues: {} }, []);
    expect(defaulted.parameters["duration"]).toBe(5);
    expect(defaulted.parameters["ratio"]).toBe("16:9");
  });

  it("requires a paired first/last frame and never locks ratio or duration", () => {
    const frameInputs = [
      { key: "image-a", kind: "image" as const },
      { key: "image-b", kind: "image" as const },
    ];
    const state = resolveSeedanceTask(
      RD,
      capabilities(RD),
      { seedanceTaskMode: "first_last_frame", parameterValues: { ratio: "4:3", duration: 20 } },
      frameInputs,
    );
    expect(state.mode).toBe("first_last_frame");
    expect(state.issue).toBeNull();
    expect(state.mediaRoles).toEqual({ "image-a": "first_frame", "image-b": "last_frame" });
    expect(state.parameters["ratio"]).toBe("4:3");
    expect(state.parameters["duration"]).toBe(20);

    // 混入视频素材：首尾帧不能与参考素材混用。
    const mixed = resolveSeedanceTask(
      RD,
      capabilities(RD),
      { seedanceTaskMode: "first_last_frame", parameterValues: {} },
      [imageA, video, imageB],
    );
    expect(mixed.issue).toContain("2 张图片");

    // 旧存档里的 edit 模式回退到 auto，而不是带着魔芋任务语义提交。
    const restored = resolveSeedanceTask(
      RD,
      capabilities(RD),
      { seedanceTaskMode: "edit", parameterValues: { ratio: "adaptive", duration: -1 } },
      [imageA, imageB],
    );
    expect(restored.mode).toBe("auto");
  });

  it("does not inject adaptive/smart defaults when selecting auto on RD models", () => {
    const next = selectSeedanceTask(
      RD,
      capabilities(RD),
      { parameterValues: { ratio: "16:9", duration: 8 } },
      [],
      "auto",
    );
    expect(next.parameterValues["ratio"]).toBe("16:9");
    expect(next.parameterValues["duration"]).toBe(8);
  });
});
