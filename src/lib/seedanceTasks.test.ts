import { describe, expect, it } from "vitest";
import {
  defaultModelOperationSchema,
  modelParameterCapabilities,
  type ModelParameterCapability,
} from "./modelCapabilities";
import { resolveSeedanceTask, selectSeedanceTask, type SeedanceTaskMode } from "./seedanceTasks";

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
