import { describe, expect, it } from "vitest";
import {
  defaultModelOperationSchema,
  generationParameters,
  modelAllowsMediaOnlyPrompt,
  modelParameterCapabilities,
} from "./modelCapabilities";

describe("model capabilities", () => {
  it("renders provider-declared parameters without hardcoded field names", () => {
    const schema = {
      video_generation: {
        parameters: {
          frames: {
            type: "integer",
            label: "帧数",
            default: 48,
            enum: [24, 48, 72],
            requestField: "frame_count",
          },
        },
      },
    };

    expect(modelParameterCapabilities(schema, "video_generation", "company-video")).toEqual([
      expect.objectContaining({
        key: "frames",
        label: "帧数",
        type: "integer",
        defaultValue: 48,
        options: [
          { value: 24, label: "24" },
          { value: 48, label: "48" },
          { value: 72, label: "72" },
        ],
      }),
    ]);
  });

  it("uses model-specific defaults and omits no-media parameters when media is present", () => {
    const schema = defaultModelOperationSchema("doubao-seedance-2-0-260128", ["video_generation"]);
    const capabilities = modelParameterCapabilities(
      schema,
      "video_generation",
      "doubao-seedance-2-0-260128",
    );

    expect(capabilities.map((capability) => capability.key)).toContain("web_search");
    expect(generationParameters(capabilities, { web_search: true }, false)).toMatchObject({
      web_search: true,
      resolution: "720p",
      duration: 5,
    });
    expect(generationParameters(capabilities, { web_search: true }, true)).not.toHaveProperty(
      "web_search",
    );
  });

  it("supports overseas Dreamina Seedance model ids and fields", () => {
    const seedance20 = modelParameterCapabilities(
      defaultModelOperationSchema("dreamina-seedance-2.0-fast", ["video_generation"]),
      "video_generation",
      "dreamina-seedance-2.0-fast",
    );
    expect(seedance20.map((capability) => capability.key)).toEqual([
      "ratio",
      "resolution",
      "duration",
      "generate_audio",
      "web_search",
    ]);
    expect(seedance20.find((capability) => capability.key === "resolution")?.options).toEqual([
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
    ]);

    const seedance25 = modelParameterCapabilities(
      defaultModelOperationSchema("dreamina-seedance-2.5", ["video_generation"]),
      "video_generation",
      "dreamina-seedance-2.5",
    );
    expect(seedance25.map((capability) => capability.key)).toEqual([
      "ratio",
      "resolution",
      "duration",
      "generate_audio",
      "web_search",
      "output_format",
      "priority",
    ]);
    expect(seedance25.find((capability) => capability.key === "duration")?.options).toHaveLength(
      28,
    );
    expect(seedance25.find((capability) => capability.key === "priority")).toMatchObject({
      defaultValue: 0,
      minimum: 0,
      maximum: 9,
    });
    expect(seedance25.some((capability) => capability.key === "omni_reference_task_type")).toBe(
      false,
    );

    const repaired = modelParameterCapabilities(
      { video_generation: { parameters: {} } },
      "video_generation",
      "dreamina-seedance-2.5",
    );
    expect(repaired.map((capability) => capability.key)).toContain("priority");
  });

  it("supports domestic Seedance 2.5 with 1080p and web search", () => {
    const seedance25 = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedance-2-5-260628", ["video_generation"]),
      "video_generation",
      "doubao-seedance-2-5-260628",
    );
    expect(seedance25.map((capability) => capability.key)).toEqual([
      "ratio",
      "resolution",
      "duration",
      "generate_audio",
      "web_search",
      "output_format",
      "omni_reference_task_type",
    ]);
    expect(seedance25.find((capability) => capability.key === "resolution")?.options).toEqual([
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
      { value: "1080p", label: "1080p" },
    ]);
    expect(seedance25.find((capability) => capability.key === "web_search")).toMatchObject({
      defaultValue: false,
      requiresNoMedia: true,
    });
    expect(seedance25.find((capability) => capability.key === "duration")?.options).toHaveLength(
      28,
    );
    expect(seedance25.some((capability) => capability.key === "omni_reference_task_type")).toBe(
      true,
    );
    expect(seedance25.some((capability) => capability.key === "priority")).toBe(false);
  });

  it("treats an explicitly empty parameter schema as authoritative", () => {
    const capabilities = modelParameterCapabilities(
      { video_generation: { parameters: {} } },
      "video_generation",
      "unknown-video",
    );
    expect(capabilities).toEqual([]);
  });

  it("uses the GPT image contract for gpt-image text-to-image models", () => {
    const gptImage = modelParameterCapabilities(
      defaultModelOperationSchema("gpt-image-2", ["text_to_image"]),
      "text_to_image",
      "gpt-image-2",
    );
    const quality = gptImage.find((capability) => capability.key === "quality");
    expect(quality?.defaultValue).toBe("auto");
    expect(quality?.options.map((option) => option.value)).toEqual([
      "auto",
      "high",
      "medium",
      "low",
    ]);
    const size = gptImage.find((capability) => capability.key === "size");
    expect(size?.options.map((option) => option.value)).toEqual([
      "auto",
      "1024x1024",
      "1536x1024",
      "1024x1536",
    ]);

    // 非 gpt-image 模型沿用通用文生图契约。
    const generic = modelParameterCapabilities(
      defaultModelOperationSchema("photon-1", ["text_to_image"]),
      "text_to_image",
      "photon-1",
    );
    const genericQuality = generic.find((capability) => capability.key === "quality");
    expect(genericQuality?.defaultValue).toBe("standard");
    expect(genericQuality?.options.map((option) => option.value)).toEqual(["hd", "standard"]);
  });

  it("uses the Wan 3.0 root-contract parameters and keeps seed optional", () => {
    for (const modelId of ["wan3.0-video", "wan3.0-video-prime"]) {
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);

      expect(modelAllowsMediaOnlyPrompt(schema, "video_generation")).toBe(true);
      expect(capabilities.map((capability) => capability.key)).toEqual([
        "resolution",
        "ratio",
        "duration",
        "seed",
        "watermark",
      ]);
      expect(capabilities.find((capability) => capability.key === "resolution")?.options).toEqual([
        { value: "480P", label: "480P" },
        { value: "720P", label: "720P" },
        { value: "1080P", label: "1080P" },
      ]);
      expect(
        capabilities.find((capability) => capability.key === "duration")?.options,
      ).toHaveLength(30);
      expect(capabilities.find((capability) => capability.key === "seed")).toMatchObject({
        defaultValue: "",
        optional: true,
        minimum: 0,
        maximum: 2_147_483_647,
      });

      expect(generationParameters(capabilities, {}, false)).toEqual({
        resolution: "1080P",
        ratio: "adaptive",
        duration: 5,
        watermark: false,
      });
      expect(generationParameters(capabilities, { seed: 42 }, false)).toMatchObject({ seed: 42 });
    }
  });
});
