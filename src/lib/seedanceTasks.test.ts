import { describe, expect, it } from "vitest";
import { defaultModelOperationSchema, modelParameterCapabilities } from "./modelCapabilities";
import { resolveSeedanceTask, seedanceTaskOptions, selectSeedanceTask } from "./seedanceTasks";

const DOMESTIC = "doubao-seedance-2-5-260628";
const OVERSEAS = "dreamina-seedance-2.5";
const RD = "rd-seedance-2.5-720p";
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

describe("Seedance requests defer remote acceptance to the service", () => {
  it.each([DOMESTIC, OVERSEAS, RD])(
    "preserves restored edit intent and explicit parameters on %s",
    (modelId) => {
      const state = resolveSeedanceTask(
        modelId,
        capabilities(modelId),
        {
          seedanceTaskMode: "edit",
          parameterValues: { ratio: "21:9", duration: 45, priority: 4 },
        },
        [video, imageA],
      );
      expect(state.mode).toBe("edit");
      expect(state.issue).toBeNull();
      expect(state.parameters).toMatchObject({ ratio: "21:9", duration: 45, priority: 4 });
      expect(state.mediaRoles).toEqual({
        "video-a": "reference_video",
        "image-a": "reference_image",
      });
      expect(state.lockedParameters).toEqual([]);
      expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
    },
  );

  it.each(["first_frame", "first_last_frame", "edit", "extend", "reference"] as const)(
    "does not veto missing or mixed media for %s",
    (mode) => {
      for (const inputs of [[], [imageA, imageB, video]]) {
        const state = resolveSeedanceTask(
          DOMESTIC,
          capabilities(),
          {
            seedanceTaskMode: mode,
            parameterValues: {},
          },
          inputs,
        );
        expect(state.issue).toBeNull();
        expect(Object.keys(state.mediaRoles)).toHaveLength(inputs.length);
      }
    },
  );

  it("preserves first/last identities and every additional reference rather than truncating", () => {
    const state = resolveSeedanceTask(
      RD,
      capabilities(RD),
      {
        seedanceTaskMode: "first_last_frame",
        parameterValues: { ratio: "4:3", duration: 20 },
        mediaRoles: { "image-a": "last_frame", "image-b": "first_frame" },
      },
      [imageA, imageB, video],
    );
    expect(state.issue).toBeNull();
    expect(state.mediaRoles).toEqual({
      "image-a": "last_frame",
      "image-b": "first_frame",
      "video-a": "reference_video",
    });
    expect(state.parameters).toMatchObject({ ratio: "4:3", duration: 20 });
    expect(state.parameters).not.toHaveProperty("omni_reference_task_type");
  });

  it("uses an explicit task even if the cached remote enum and duration ranges lag behind", () => {
    const caps = capabilities("doubao-seedance-2-5-legacy").map((capability) =>
      capability.key === "omni_reference_task_type"
        ? { ...capability, options: [{ value: "auto", label: "自动" }] }
        : capability.key === "duration"
          ? { ...capability, minimum: 4, maximum: 15, options: [{ value: 5, label: "5 秒" }] }
          : capability,
    );
    const state = resolveSeedanceTask(
      DOMESTIC,
      caps,
      {
        seedanceTaskMode: "extend",
        parameterValues: { duration: 45 },
      },
      Array.from({ length: 11 }, (_, index) => ({ ...video, key: `video-${index}` })),
    );
    expect(state.issue).toBeNull();
    expect(state.parameters).toMatchObject({ duration: 45, omni_reference_task_type: "extend" });
    expect(state.parameterCapabilities).toBe(caps);
    expect(Object.keys(state.mediaRoles)).toHaveLength(11);
  });

  it("restores task intent from the older parameter and omits only dialect task fields", () => {
    expect(
      resolveSeedanceTask(
        RD,
        capabilities(RD),
        {
          parameterValues: { omni_reference_task_type: "edit", duration: 12 },
        },
        [video],
      ),
    ).toMatchObject({ mode: "edit", parameters: { duration: 12 } });
    expect(
      resolveSeedanceTask(DOMESTIC, capabilities(), { parameterValues: {} }, []).parameters,
    ).not.toHaveProperty("omni_reference_task_type");
  });

  it("offers all RD task intents and never injects adaptive/smart defaults for RD", () => {
    expect(seedanceTaskOptions(RD).map((option) => option.value)).toEqual([
      "auto",
      "reference",
      "first_frame",
      "first_last_frame",
      "edit",
      "extend",
    ]);
    for (const mode of ["auto", "edit", "extend", "first_frame"] as const) {
      const selected = selectSeedanceTask(
        RD,
        capabilities(RD),
        {
          parameterValues: { ratio: "16:9", duration: 8 },
        },
        [video],
        mode,
      );
      expect(selected.parameterValues).toMatchObject({ ratio: "16:9", duration: 8 });
      expect(selected.seedanceTaskMode).toBe(mode);
    }
  });

  it("does not apply Seedance task mapping to another model", () => {
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
});
