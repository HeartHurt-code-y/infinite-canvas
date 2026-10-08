import { describe, expect, it } from "vitest";
import {
  defaultModelOperationSchema,
  generationParameters,
  isGeminiImageModel,
  isMinimaxH3VideoModel,
  isPixverseVideoModel,
  isRdVideoModel,
  isSeedreamImageModel,
  modelAllowsMediaOnlyPrompt,
  modelParameterCapabilities,
  modelSupportsBatchCount,
} from "./modelCapabilities";

describe("model capabilities", () => {
  it.each(["PixVerse-V6", "PixVerse-C1"])(
    "declares the documented PixVerse generation profile for %s",
    (modelId) => {
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      expect(schema["video_generation"]).toMatchObject({
        requestProfileId: "moyu_pixverse_video_v1",
        request: { mediaEncoding: "pixverse_image_inputs", promptMode: "prompt_or_media" },
      });
      expect(modelAllowsMediaOnlyPrompt(schema, "video_generation")).toBe(true);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);
      expect(capabilities.find((capability) => capability.key === "action")).toMatchObject({
        optional: true,
        defaultValue: "",
        options: [
          { value: "text", label: "文生视频" },
          { value: "img", label: "图生视频" },
          { value: "fusion", label: "多图融合" },
        ],
      });
      expect(capabilities.find((capability) => capability.key === "duration")?.options).toEqual(
        Array.from({ length: 15 }, (_, index) => ({ value: index + 1, label: `${index + 1} 秒` })),
      );
      expect(
        capabilities
          .find((capability) => capability.key === "aspect_ratio")
          ?.options.map((option) => option.value),
      ).toEqual(["16:9", "9:16", "4:3", "3:4", "1:1", "2:3", "3:2", "21:9"]);
      expect(
        capabilities
          .find((capability) => capability.key === "quality")
          ?.options.map((option) => option.value),
      ).toEqual(["360p", "540p", "720p", "1080p"]);
      expect(
        capabilities.some((capability) => capability.key === "generate_multi_clip_switch"),
      ).toBe(modelId === "PixVerse-V6");
      const defaults = generationParameters(capabilities, {}, true);
      expect(defaults).toMatchObject({
        quality: "540p",
        duration: 5,
        aspect_ratio: "16:9",
        generate_audio_switch: false,
      });
      expect(defaults).not.toHaveProperty("action");
      expect(defaults).not.toHaveProperty("seed");
      expect(defaults).not.toHaveProperty("template_id");
      expect(
        generationParameters(
          capabilities,
          { duration: 18, aspect_ratio: "2:1", quality: "4k", action: "modify", new_flag: true },
          true,
        ),
      ).toMatchObject({
        duration: 18,
        aspect_ratio: "2:1",
        quality: "4k",
        action: "modify",
        new_flag: true,
      });
    },
  );

  it("repairs legacy empty PixVerse capabilities while respecting nonempty server declarations", () => {
    for (const operation of [{ resultType: "video" }, { parameters: {} }]) {
      const capabilities = modelParameterCapabilities(
        { video_generation: operation },
        "video_generation",
        "PixVerse-C1",
      );
      expect(capabilities.find((capability) => capability.key === "duration")?.defaultValue).toBe(
        5,
      );
      expect(capabilities.find((capability) => capability.key === "quality")?.defaultValue).toBe(
        "540p",
      );
    }
    expect(
      modelParameterCapabilities(
        {
          video_generation: {
            parameters: { duration: { type: "integer", default: 20, enum: [20, 30] } },
          },
        },
        "video_generation",
        "PixVerse-V6",
      ),
    ).toEqual([
      expect.objectContaining({
        key: "duration",
        defaultValue: 20,
        options: [
          { value: 20, label: "20 秒" },
          { value: 30, label: "30 秒" },
        ],
      }),
    ]);
    expect(isPixverseVideoModel("pixverse-v6")).toBe(true);
    expect(isPixverseVideoModel("PixVerse-C1")).toBe(true);
    expect(isPixverseVideoModel("PixVerse-V5")).toBe(false);
    expect(isPixverseVideoModel("custom-PixVerse-V6")).toBe(false);
  });

  it("uses only the documented SP 2.5 per-task parameters", () => {
    for (const [modelId, first, last] of [
      ["sp2.5-720p-4-15s", 4, 15],
      ["sp2.5-720p-16-30s", 16, 30],
      ["sp2.5-720p-30s-ch1", 30, 30],
      ["sp2.5-720p-30s-ch2", 30, 30],
      ["sp2.5-720p-30s-ch3", 30, 30],
      ["sp2.5-720p-30s-ch4", 30, 30],
      ["sp2.5-720p-30s-ch5", 30, 30],
      ["sp2.5-720p-30s-ch6", 30, 30],
    ] as const) {
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);
      expect(capabilities.map((capability) => capability.key)).toEqual(
        first === last ? ["ratio"] : ["ratio", "duration"],
      );
      expect(capabilities[0]?.options.map((option) => option.value)).toEqual([
        "16:9",
        "9:16",
        "1:1",
        "4:3",
        "3:4",
        "21:9",
      ]);
      expect(generationParameters(capabilities, {}, false)).toEqual(
        first === last ? { ratio: "16:9" } : { ratio: "16:9", duration: first },
      );
      if (first !== last) {
        expect(capabilities[1]?.options.map((option) => option.value)).toEqual(
          Array.from({ length: last - first + 1 }, (_, index) => first + index),
        );
      }
    }
    // A live server declaration supplies controls even when local presets differ.
    expect(
      modelParameterCapabilities(
        {
          video_generation: {
            parameters: {
              duration: { type: "integer", default: 30 },
              generate_audio: { type: "boolean" },
            },
          },
        },
        "video_generation",
        "sp2.5-720p-30s-ch5",
      ).map((capability) => capability.key),
    ).toEqual(["duration", "generate_audio"]);
    expect(
      modelParameterCapabilities(
        { video_generation: { resultType: "video" } },
        "video_generation",
        "sp2.5-720p-30s-ch5",
      ).map((capability) => capability.key),
    ).toEqual(["ratio"]);
  });

  it("uses the RD gateway top-level contract instead of the Seedance 2.5 moyu contract", () => {
    // RD 网关的模型 ID 含 `seedance-2.5` 子串，但契约是顶层 duration/ratio/
    // resolution/generate_audio + 顶层媒体数组；必须先于魔芋 Seedance 2.5 判定。
    for (const [modelId, tier] of [
      ["rd-seedance-2.5-480p", "480P"],
      ["rd-seedance-2.5-720p", "720P"],
      ["rd-seedance-2.5-1080p", "1080P"],
    ] as const) {
      expect(isRdVideoModel(modelId)).toBe(true);
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const rdCapabilities = modelParameterCapabilities(schema, "video_generation", modelId);
      expect(rdCapabilities.map((capability) => capability.key)).toEqual([
        "duration",
        "ratio",
        "resolution",
        "generate_audio",
      ]);
      expect(
        rdCapabilities
          .find((capability) => capability.key === "duration")
          ?.options.map((o) => o.value),
      ).toEqual(Array.from({ length: 27 }, (_, index) => index + 4));
      expect(rdCapabilities.find((capability) => capability.key === "resolution")?.options).toEqual(
        [{ value: tier, label: tier }],
      );
      // 魔芋 Seedance 2.5 的任务类型、联网搜索与输出格式不在 RD 契约里。
      expect(
        rdCapabilities.some((capability) => capability.key === "omni_reference_task_type"),
      ).toBe(false);
      expect(rdCapabilities.some((capability) => capability.key === "web_search")).toBe(false);
      expect(rdCapabilities.some((capability) => capability.key === "output_format")).toBe(false);
    }
    // 相近名称不套用 RD 契约；魔芋 Seedance 2.5 仍走 metadata 契约。
    expect(isRdVideoModel("rd-seedance-2.5-720p-v9")).toBe(false);
    expect(isRdVideoModel("doubao-seedance-2-5-260628")).toBe(false);
  });

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

  it("uses model defaults while retaining explicit parameters with media", () => {
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
    expect(generationParameters(capabilities, { web_search: true }, true)).toHaveProperty(
      "web_search",
      true,
    );
  });

  it("preserves user parameters outside cached enums, bounds and keys without serializing non-finite numbers", () => {
    const modelId = "rd-seedance-2.5-720p";
    const capabilities = modelParameterCapabilities(
      defaultModelOperationSchema(modelId, ["video_generation"]),
      "video_generation",
      modelId,
    );
    expect(
      generationParameters(
        capabilities,
        {
          duration: 45,
          ratio: "adaptive",
          resolution: "2K",
          new_server_flag: true,
          invalid_nan: NaN,
          invalid_infinity: Infinity,
        },
        true,
      ),
    ).toMatchObject({ duration: 45, ratio: "adaptive", resolution: "2K", new_server_flag: true });
    expect(generationParameters(capabilities, { invalid_nan: NaN }, true)).not.toHaveProperty(
      "invalid_nan",
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
    // Seedance 2.0 系列同样支持 duration=-1（智能时长）。
    const seedance20Duration = seedance20.find((capability) => capability.key === "duration");
    expect(seedance20Duration?.options[0]).toEqual({ value: -1, label: "智能时长" });
    expect(seedance20Duration?.options).toHaveLength(13);
    expect(generationParameters(seedance20, { duration: -1 }, false)).toMatchObject({
      duration: -1,
    });

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

  it("offers direct 480p/720p generation and a draft for later 1080p promotion", () => {
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
      "draft",
    ]);
    expect(seedance25.find((capability) => capability.key === "resolution")?.options).toEqual([
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
    ]);
    expect(seedance25.find((capability) => capability.key === "duration")?.defaultValue).toBe(5);
    expect(seedance25.find((capability) => capability.key === "duration")?.options).toHaveLength(
      28,
    );
    expect(seedance25.some((capability) => capability.key === "omni_reference_task_type")).toBe(
      false,
    );
    expect(seedance25.some((capability) => capability.key === "priority")).toBe(false);
    expect(seedance25.find((capability) => capability.key === "draft")).toMatchObject({
      type: "boolean",
      defaultValue: false,
      optional: false,
    });
    const savedCatalog = modelParameterCapabilities(
      {
        video_generation: {
          requestProfileId: "moyu_seedance_25_draft_v1",
          parameters: {
            duration: { type: "integer", default: 20 },
            resolution: { type: "string", enum: ["1080p"], default: "1080p" },
          },
        },
      },
      "video_generation",
      "doubao-seedance-2-5-260628",
    );
    expect(savedCatalog.find((capability) => capability.key === "resolution")?.options).toEqual([
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
    ]);
    expect(savedCatalog.find((capability) => capability.key === "duration")?.defaultValue).toBe(5);
    expect(savedCatalog.find((capability) => capability.key === "draft")).toBeDefined();
    const ark = modelParameterCapabilities(
      {
        video_generation: {
          requestProfileId: "volcengine_ark_video_v1",
          parameters: {
            resolution: { type: "string", enum: ["720p", "480p", "1080p"], default: "1080p" },
            web_search: { type: "boolean", default: false },
          },
        },
      },
      "video_generation",
      "doubao-seedance-2-5-260628",
    );
    expect(ark.find((capability) => capability.key === "resolution")?.defaultValue).toBe("1080p");
    expect(ark.find((capability) => capability.key === "resolution")?.options).toContainEqual({
      value: "1080p",
      label: "1080p",
    });
    expect(ark.find((capability) => capability.key === "draft")).toBeUndefined();
    expect(ark.find((capability) => capability.key === "web_search")).toBeDefined();
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
    // GPT Image 契约：文生图声明生成数量 n（1~10，默认 1）。
    const count = gptImage.find((capability) => capability.key === "n");
    expect(count).toMatchObject({ type: "integer", defaultValue: 1, minimum: 1, maximum: 10 });
    // gpt-image 不接受返回格式：上游（moyu 网关对 gpt-image-2，真机实测）以
    // HTTP 400 unknown_parameter 拒绝该键，结果恒为内联 Base64。
    expect(gptImage.some((capability) => capability.key === "response_format")).toBe(false);

    const asyncImage = modelParameterCapabilities(
      defaultModelOperationSchema("gpt-image-2.5-sunburst", ["text_to_image"]),
      "text_to_image",
      "gpt-image-2.5-sunburst",
    );
    expect(asyncImage.map((capability) => capability.key)).toEqual(["aspect_ratio", "resolution"]);
    expect(asyncImage.find((capability) => capability.key === "aspect_ratio")?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "16:9" })]),
    );
    expect(asyncImage.find((capability) => capability.key === "resolution")?.defaultValue).toBe(
      "2k",
    );

    // 图生图（图片编辑 multipart 接口）同样声明 n/size/quality。
    const gptImageEdit = modelParameterCapabilities(
      defaultModelOperationSchema("gpt-image-2", ["image_to_image"]),
      "image_to_image",
      "gpt-image-2",
    );
    expect(gptImageEdit.map((capability) => capability.key)).toEqual(["size", "quality", "n"]);
    expect(gptImageEdit.find((capability) => capability.key === "n")).toMatchObject({
      type: "integer",
      defaultValue: 1,
      minimum: 1,
      maximum: 10,
    });

    // 非 gpt-image 模型沿用通用文生图契约。
    const generic = modelParameterCapabilities(
      defaultModelOperationSchema("photon-1", ["text_to_image"]),
      "text_to_image",
      "photon-1",
    );
    const genericQuality = generic.find((capability) => capability.key === "quality");
    expect(genericQuality?.defaultValue).toBe("standard");
    expect(genericQuality?.options.map((option) => option.value)).toEqual(["hd", "standard"]);
    expect(generic.find((capability) => capability.key === "n")).toBeUndefined();
    // 通用 dall-e 契约同样声明返回格式，默认内联 Base64。
    expect(generic.find((capability) => capability.key === "response_format")?.defaultValue).toBe(
      "b64_json",
    );
  });

  it("uses the Seedream 2K contract for text-to-image models", () => {
    expect(isSeedreamImageModel("doubao-seedream-4-5-251128")).toBe(true);
    expect(isSeedreamImageModel("doubao-seedance-2-5-260628")).toBe(false);

    const seedream45 = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-4-5-251128", ["text_to_image"]),
      "text_to_image",
      "doubao-seedream-4-5-251128",
    );
    const size = seedream45.find((capability) => capability.key === "size");
    expect(size?.defaultValue).toBe("2K");
    expect(size?.options.map((option) => option.value)).toEqual(["2K", "2048x2048", "2848x1600"]);
    expect(seedream45.find((capability) => capability.key === "quality")?.options).toEqual([
      { value: "standard", label: "标准" },
      { value: "hd", label: "高清 HD" },
    ]);
    expect(seedream45.find((capability) => capability.key === "watermark")).toMatchObject({
      type: "boolean",
      defaultValue: false,
    });
    // 文档参数表：返回格式默认内联 b64_json，可选 url（链接需要客户端再直连存储域名）。
    const responseFormat = seedream45.find((capability) => capability.key === "response_format");
    expect(responseFormat?.defaultValue).toBe("b64_json");
    expect(responseFormat?.options).toEqual([
      { value: "url", label: "图片链接" },
      { value: "b64_json", label: "Base64 数据" },
    ]);
    // 4.5 支持组图模式与组图数量（1~15）。
    const sequential = seedream45.find(
      (capability) => capability.key === "sequential_image_generation",
    );
    expect(sequential?.options).toEqual([
      { value: "disabled", label: "关闭" },
      { value: "auto", label: "自动" },
    ]);
    expect(seedream45.find((capability) => capability.key === "max_images")).toMatchObject({
      type: "integer",
      defaultValue: 4,
      minimum: 1,
      maximum: 15,
    });
    // 4.5 不支持提示词优化/联网搜索/输出格式。
    expect(seedream45.some((capability) => capability.key === "optimize_prompt_mode")).toBe(false);
    expect(seedream45.some((capability) => capability.key === "web_search")).toBe(false);
    expect(seedream45.some((capability) => capability.key === "output_format")).toBe(false);
    // 非 gpt-image/seedream 模型不受影响。
    expect(seedream45.some((capability) => capability.key === "n")).toBe(false);
  });

  it("uses the Seedream 5.0 pro contract with image-edit-only parameters", () => {
    const text = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-5-0-pro-260628", ["text_to_image"]),
      "text_to_image",
      "doubao-seedream-5-0-pro-260628",
    );
    expect(text.find((capability) => capability.key === "optimize_prompt_mode")?.options).toEqual([
      { value: "fast", label: "快速" },
      { value: "standard", label: "标准" },
    ]);
    expect(text.find((capability) => capability.key === "output_format")?.options).toEqual([
      { value: "jpg", label: "JPG" },
      { value: "png", label: "PNG" },
      { value: "webp", label: "WEBP" },
    ]);
    expect(text.find((capability) => capability.key === "output_format")?.defaultValue).toBe("jpg");
    expect(text.find((capability) => capability.key === "watermark")?.defaultValue).toBe(false);
    expect(text.find((capability) => capability.key === "response_format")?.defaultValue).toBe(
      "b64_json",
    );
    // 5.0 pro 不支持组图模式。
    expect(text.some((capability) => capability.key === "sequential_image_generation")).toBe(false);

    const edit = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-5-0-pro-260628", ["image_to_image"]),
      "image_to_image",
      "doubao-seedream-5-0-pro-260628",
    );
    expect(edit.find((capability) => capability.key === "background")?.options).toEqual([
      { value: "opaque", label: "实体背景" },
      { value: "transparent", label: "透明背景" },
    ]);
    expect(edit.find((capability) => capability.key === "layer_decomposition")).toMatchObject({
      type: "boolean",
      defaultValue: false,
    });
    // 透明背景/图层拆分只在图生图出现，文生图不出现。
    expect(text.some((capability) => capability.key === "background")).toBe(false);
    expect(text.some((capability) => capability.key === "layer_decomposition")).toBe(false);
  });

  it("uses the Seedream 5.0 lite contract with web search", () => {
    const capabilities = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-5-0-lite", ["text_to_image"]),
      "text_to_image",
      "doubao-seedream-5-0-lite",
    );
    expect(capabilities.map((capability) => capability.key)).toContain(
      "sequential_image_generation",
    );
    expect(capabilities.map((capability) => capability.key)).toContain("optimize_prompt_mode");
    expect(capabilities.map((capability) => capability.key)).toContain("web_search");
    expect(capabilities.find((capability) => capability.key === "web_search")).toMatchObject({
      requiresNoMedia: true,
    });
    // 组图数量仅在组图模式为 auto 时进入请求。
    expect(
      generationParameters(
        capabilities,
        { sequential_image_generation: "auto", max_images: 6 },
        false,
      ),
    ).toMatchObject({ sequential_image_generation: "auto", max_images: 6 });
    expect(
      generationParameters(
        capabilities,
        { sequential_image_generation: "disabled", max_images: 6 },
        false,
      ),
    ).toMatchObject({ sequential_image_generation: "disabled" });
  });

  it("uses the documented Seedream 5.0 contract for doubao-seedream-5-0-260128", () => {
    // moyu 文档（https://doc.moyu.info/9280685m0.md）推荐的标准 Seedream 5.0：
    // 基础参数 + 组图模式 + 输出格式（jpg/png/webp）；不声明提示词优化/联网搜索。
    const text = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-5-0-260128", ["text_to_image"]),
      "text_to_image",
      "doubao-seedream-5-0-260128",
    );
    expect(text.find((capability) => capability.key === "watermark")?.defaultValue).toBe(false);
    expect(text.find((capability) => capability.key === "response_format")?.options).toEqual([
      { value: "url", label: "图片链接" },
      { value: "b64_json", label: "Base64 数据" },
    ]);
    expect(
      text.find((capability) => capability.key === "sequential_image_generation")?.options,
    ).toEqual([
      { value: "disabled", label: "关闭" },
      { value: "auto", label: "自动" },
    ]);
    expect(text.find((capability) => capability.key === "output_format")).toMatchObject({
      type: "string",
      defaultValue: "jpg",
    });
    expect(text.find((capability) => capability.key === "output_format")?.options).toEqual([
      { value: "jpg", label: "JPG" },
      { value: "png", label: "PNG" },
      { value: "webp", label: "WEBP" },
    ]);
    expect(text.some((capability) => capability.key === "optimize_prompt_mode")).toBe(false);
    expect(text.some((capability) => capability.key === "web_search")).toBe(false);

    // 图生图同样不声明透明背景/图层拆分（那是 5.0 pro 的能力）。
    const edit = modelParameterCapabilities(
      defaultModelOperationSchema("doubao-seedream-5-0-260128", ["image_to_image"]),
      "image_to_image",
      "doubao-seedream-5-0-260128",
    );
    expect(edit.find((capability) => capability.key === "output_format")?.defaultValue).toBe("jpg");
    expect(edit.some((capability) => capability.key === "background")).toBe(false);
    expect(edit.some((capability) => capability.key === "layer_decomposition")).toBe(false);
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

  it("supports Veo models with top-level parameters and metadata options", () => {
    for (const modelId of ["veo-3", "veo-3-fast", "veo-3.1", "veo-3.1-fast"]) {
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);

      expect(capabilities.map((capability) => capability.key)).toEqual([
        "resolution",
        "aspect_ratio",
        "duration",
        "negativePrompt",
        "sampleCount",
        "enhancePrompt",
        "seed",
      ]);
      expect(capabilities.find((capability) => capability.key === "resolution")?.options).toEqual([
        { value: "720p", label: "720p" },
        { value: "1080p", label: "1080p" },
      ]);
      expect(capabilities.find((capability) => capability.key === "aspect_ratio")?.options).toEqual(
        [
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
        ],
      );
      expect(capabilities.find((capability) => capability.key === "duration")?.options).toEqual([
        { value: 4, label: "4 秒" },
        { value: 6, label: "6 秒" },
        { value: 8, label: "8 秒" },
      ]);
      expect(capabilities.find((capability) => capability.key === "sampleCount")).toMatchObject({
        defaultValue: 1,
        minimum: 1,
        maximum: 4,
      });
      expect(capabilities.find((capability) => capability.key === "enhancePrompt")).toMatchObject({
        defaultValue: true,
      });
      expect(capabilities.find((capability) => capability.key === "seed")).toMatchObject({
        defaultValue: "",
        optional: true,
        minimum: 0,
        maximum: 4_294_967_295,
      });

      expect(generationParameters(capabilities, {}, false)).toEqual({
        resolution: "720p",
        aspect_ratio: "16:9",
        duration: 8,
        sampleCount: 1,
        enhancePrompt: true,
      });
      expect(
        generationParameters(capabilities, { seed: 42, negativePrompt: "blurry" }, false),
      ).toMatchObject({ seed: 42, negativePrompt: "blurry" });

      // 空参数档案（历史/供应商下发空对象）回退到 Veo 当前档案。
      const repaired = modelParameterCapabilities(
        { video_generation: { parameters: {} } },
        "video_generation",
        modelId,
      );
      expect(repaired.map((capability) => capability.key)).toContain("aspect_ratio");
    }
  });

  it("supports Vidu models with per-model resolution whitelists and metadata options", () => {
    const expectations: Record<string, { resolutions: string[]; defaultResolution: string }> = {
      "vidu2.0": { resolutions: ["360p", "720p", "1080p"], defaultResolution: "720p" },
      viduq1: { resolutions: ["1080p"], defaultResolution: "1080p" },
      "viduq3-pro": { resolutions: ["540p", "720p", "1080p"], defaultResolution: "720p" },
      "viduq3-turbo": { resolutions: ["540p", "720p", "1080p"], defaultResolution: "720p" },
    };
    for (const [modelId, { resolutions, defaultResolution }] of Object.entries(expectations)) {
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);

      expect(capabilities.map((capability) => capability.key)).toEqual([
        "resolution",
        "aspect_ratio",
        "duration",
        "seed",
        "watermark",
        "movement_amplitude",
        "style",
        "audio",
        "audio_type",
        "off_peak",
        "bgm",
      ]);
      const resolution = capabilities.find((capability) => capability.key === "resolution");
      expect(resolution?.defaultValue).toBe(defaultResolution);
      expect(resolution?.options).toEqual(resolutions.map((value) => ({ value, label: value })));
      expect(capabilities.find((capability) => capability.key === "aspect_ratio")?.options).toEqual(
        [
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
          { value: "1:1", label: "1:1" },
          { value: "3:4", label: "3:4" },
          { value: "4:3", label: "4:3" },
        ],
      );
      const duration = capabilities.find((capability) => capability.key === "duration");
      expect(duration?.defaultValue).toBe(5);
      expect(duration?.options).toHaveLength(16);
      expect(duration?.options[0]).toEqual({ value: 1, label: "1 秒" });
      expect(capabilities.find((capability) => capability.key === "seed")).toMatchObject({
        defaultValue: "",
        optional: true,
        minimum: -1,
        maximum: 4_294_967_295,
      });
      expect(capabilities.find((capability) => capability.key === "watermark")).toMatchObject({
        defaultValue: false,
      });
      expect(
        capabilities.find((capability) => capability.key === "movement_amplitude"),
      ).toMatchObject({
        defaultValue: "auto",
        options: [
          { value: "auto", label: "自动" },
          { value: "small", label: "小" },
          { value: "medium", label: "中" },
          { value: "large", label: "大" },
        ],
      });
      expect(capabilities.find((capability) => capability.key === "style")).toMatchObject({
        defaultValue: "general",
        options: [
          { value: "general", label: "通用" },
          { value: "anime", label: "动漫" },
        ],
      });
      expect(capabilities.find((capability) => capability.key === "audio")).toMatchObject({
        defaultValue: true,
      });
      expect(capabilities.find((capability) => capability.key === "audio_type")).toMatchObject({
        defaultValue: "",
        optional: true,
      });
      expect(capabilities.find((capability) => capability.key === "off_peak")).toMatchObject({
        defaultValue: false,
      });
      expect(capabilities.find((capability) => capability.key === "bgm")).toMatchObject({
        defaultValue: false,
      });

      expect(generationParameters(capabilities, {}, false)).toEqual({
        resolution: defaultResolution,
        aspect_ratio: "16:9",
        duration: 5,
        watermark: false,
        movement_amplitude: "auto",
        style: "general",
        audio: true,
        off_peak: false,
        bgm: false,
      });
      expect(
        generationParameters(
          capabilities,
          { seed: 42, audio_type: "music", audio: false, movement_amplitude: "large" },
          false,
        ),
      ).toMatchObject({
        seed: 42,
        audio_type: "music",
        audio: false,
        movement_amplitude: "large",
      });

      // 空参数档案（历史/供应商下发空对象）回退到 Vidu 当前档案。
      const repaired = modelParameterCapabilities(
        { video_generation: { parameters: {} } },
        "video_generation",
        modelId,
      );
      expect(repaired.map((capability) => capability.key)).toContain("movement_amplitude");
      expect(repaired.find((capability) => capability.key === "resolution")?.options).toEqual(
        resolutions.map((value) => ({ value, label: value })),
      );
    }
  });

  it("supports MiniMax-H3 with top-level resolution/ratio/duration and task type", () => {
    for (const modelId of ["MiniMax-H3", "minimax-h3", "minimax_h3_260901"]) {
      expect(isMinimaxH3VideoModel(modelId)).toBe(true);
      const schema = defaultModelOperationSchema(modelId, ["video_generation"]);
      const capabilities = modelParameterCapabilities(schema, "video_generation", modelId);

      expect(capabilities.map((capability) => capability.key)).toEqual([
        "task_type",
        "resolution",
        "ratio",
        "duration",
        "aigc_watermark",
      ]);
      const taskType = capabilities.find((capability) => capability.key === "task_type");
      expect(taskType).toMatchObject({
        defaultValue: "generation",
        options: [
          { value: "generation", label: "生成" },
          { value: "regeneration", label: "再生成" },
          { value: "h3_context_ir", label: "智能扩写" },
        ],
      });
      const resolution = capabilities.find((capability) => capability.key === "resolution");
      expect(resolution?.defaultValue).toBe("2K");
      expect(resolution?.options).toEqual([
        { value: "768P", label: "768P" },
        { value: "2K", label: "2K" },
      ]);
      const ratio = capabilities.find((capability) => capability.key === "ratio");
      expect(ratio?.defaultValue).toBe("adaptive");
      expect(ratio?.options.map((option) => option.value)).toEqual([
        "adaptive",
        "21:9",
        "16:9",
        "4:3",
        "1:1",
        "3:4",
        "9:16",
      ]);
      const duration = capabilities.find((capability) => capability.key === "duration");
      expect(duration?.defaultValue).toBe(5);
      expect(duration?.options).toHaveLength(12);
      expect(duration?.options[0]).toEqual({ value: 4, label: "4 秒" });
      expect(capabilities.find((capability) => capability.key === "aigc_watermark")).toMatchObject({
        defaultValue: false,
      });

      expect(generationParameters(capabilities, {}, false)).toEqual({
        task_type: "generation",
        resolution: "2K",
        ratio: "adaptive",
        duration: 5,
        aigc_watermark: false,
      });
      expect(
        generationParameters(
          capabilities,
          { task_type: "regeneration", resolution: "2K", ratio: "16:9", aigc_watermark: true },
          false,
        ),
      ).toMatchObject({
        task_type: "regeneration",
        ratio: "16:9",
        aigc_watermark: true,
      });

      // 空参数档案（历史/供应商下发空对象）回退到 MiniMax-H3 当前档案。
      const repaired = modelParameterCapabilities(
        { video_generation: { parameters: {} } },
        "video_generation",
        modelId,
      );
      expect(repaired.map((capability) => capability.key)).toEqual([
        "task_type",
        "resolution",
        "ratio",
        "duration",
        "aigc_watermark",
      ]);
    }
  });

  it("uses aspect-ratio size for Gemini image models without quality or count", () => {
    for (const modelId of ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]) {
      expect(isGeminiImageModel(modelId)).toBe(true);
      const schema = defaultModelOperationSchema(modelId, ["text_to_image"]);
      const capabilities = modelParameterCapabilities(schema, "text_to_image", modelId);

      expect(capabilities.map((capability) => capability.key)).toEqual(["size"]);
      expect(capabilities[0]).toMatchObject({
        key: "size",
        defaultValue: "1:1",
        options: [
          { value: "1:1", label: "1:1" },
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "3:2", label: "3:2" },
          { value: "2:3", label: "2:3" },
        ],
      });

      expect(generationParameters(capabilities, {}, false)).toEqual({ size: "1:1" });
      expect(generationParameters(capabilities, { size: "9:16" }, false)).toEqual({
        size: "9:16",
      });
      // Gemini 接口忽略 n：不声明批量数量参数，多张由业务侧拆分任务。
      expect(modelSupportsBatchCount(schema, "text_to_image", modelId)).toBe(false);

      // 图生图（图片参考生成）同样只声明画幅比例 `size`（JSON data URI 契约），
      // 不声明 quality / n。
      const editSchema = defaultModelOperationSchema(modelId, ["image_to_image"]);
      const editCapabilities = modelParameterCapabilities(editSchema, "image_to_image", modelId);
      expect(editCapabilities.map((capability) => capability.key)).toEqual(["size"]);
      expect(editCapabilities[0]).toMatchObject({
        key: "size",
        defaultValue: "1:1",
        options: [
          { value: "1:1", label: "1:1" },
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "3:2", label: "3:2" },
          { value: "2:3", label: "2:3" },
        ],
      });
      expect(generationParameters(editCapabilities, {}, true)).toEqual({ size: "1:1" });
      expect(generationParameters(editCapabilities, { size: "3:4" }, true)).toEqual({
        size: "3:4",
      });
      expect(modelSupportsBatchCount(editSchema, "image_to_image", modelId)).toBe(false);

      // 空参数档案（历史/供应商下发空对象）回退到 Gemini 图片当前档案。
      const repaired = modelParameterCapabilities(
        { text_to_image: { parameters: {} } },
        "text_to_image",
        modelId,
      );
      expect(repaired.map((capability) => capability.key)).toEqual(["size"]);
    }

    // 非 Gemini 图片模型不被误判。
    expect(isGeminiImageModel("gemini-2.5-flash")).toBe(false);
    expect(isGeminiImageModel("gpt-image-2")).toBe(false);
  });
});
