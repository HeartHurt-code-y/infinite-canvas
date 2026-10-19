import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import {
  defaultModelOperationSchema,
  modelParameterCapabilities,
} from "../../lib/modelCapabilities";
import { resolveSeedanceTask } from "../../lib/seedanceTasks";
import { FZY_ADAPTER_ID, FZY_VIDEO_PROFILE } from "../../lib/providerAdapters";
import { VideoNodeSettings } from "./PromptNodeViews";
import type { ConnectedAssetInput, VideoNodeConfig } from "./workspaceModel";

const DOMESTIC = "doubao-seedance-2-5-260628";
const DOMESTIC_ALIAS = "doubao-seedance-2.5";
const OVERSEAS = "dreamina-seedance-2.5";
const PER_TASK = "sp2.5-720p-30s-ch5";
const RD = "rd-seedance-2.5-720p";
const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "provider",
      displayName: "项目供应商",
      adapterId: "moyu_v1",
      baseUrl: "https://example.test",
      apiKeyRef: "key",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      DOMESTIC,
      DOMESTIC_ALIAS,
      OVERSEAS,
      RD,
      "wan3.0-video",
      PER_TASK,
      "sp2.5-720p-30s-ch4",
      "PixVerse-V6",
      "PixVerse-C1",
    ].map((id) => ({
      definitionId: id,
      remoteModelId: id,
      displayName: id,
      operations: ["video_generation"],
      operationSchema: defaultModelOperationSchema(id, ["video_generation"]),
    })),
  },
];
function asset(key: string, kind: ConnectedAssetInput["kind"]): ConnectedAssetInput {
  return { key, kind, name: key, edgeId: `edge-${key}`, sourceLabel: "素材", previewUrl: null };
}
const video = asset("原视频", "video");
const first = asset("首图", "image");
const last = asset("尾图", "image");
function mountSettings(
  modelId = DOMESTIC,
  inputs: readonly ConnectedAssetInput[] = [video],
  providerCatalog = catalog,
  initialConfig: Partial<VideoNodeConfig> = {},
) {
  const changed = vi.fn<(config: VideoNodeConfig) => void>();
  const annotate = vi.fn();
  function Harness() {
    const [config, setConfig] = useState<VideoNodeConfig>({
      modelSelection: { providerId: "provider", modelDefinitionId: modelId },
      generationCount: 1,
      catalogResolved: true,
      parameterValues: { ratio: "16:9", duration: 10 },
      ...initialConfig,
    });
    return (
      <VideoNodeSettings
        config={config}
        providerCatalog={providerCatalog}
        hasMediaInputs={inputs.length > 0}
        mediaInputs={inputs}
        onChange={(next) => {
          changed(next);
          setConfig(next);
        }}
        onAnnotateVideo={annotate}
      />
    );
  }
  render(<Harness />);
  return { changed, annotate };
}

describe("VideoNodeSettings Seedance task interaction", () => {
  it.each(["PixVerse-V6", DOMESTIC, PER_TASK])(
    "uses the FZY video contract and accessible frame roles for %s",
    (modelId) => {
      const fzyCatalog: readonly ProviderCatalogEntry[] = [
        {
          ...catalog[0]!,
          provider: { ...catalog[0]!.provider, adapterId: FZY_ADAPTER_ID },
          models: [
            {
              definitionId: modelId,
              remoteModelId: modelId,
              displayName: modelId,
              operations: ["video_generation"],
              operationSchema: {
                video_generation: {
                  resultType: "video",
                  requestProfileId: FZY_VIDEO_PROFILE,
                  parameters: {
                    duration: { type: "integer", label: "时长", default: 5 },
                    ratio: { type: "string", label: "画幅", default: "16:9" },
                    resolution: {
                      type: "string",
                      label: "分辨率（由模型档位决定）",
                      optional: true,
                    },
                    generate_audio: { type: "boolean", label: "生成音频", optional: true },
                  },
                },
              },
            },
          ],
        },
      ];
      const { changed } = mountSettings(modelId, [first, last], fzyCatalog, {
        parameterValues: {},
      });
      expect(screen.getByLabelText("时长")).toHaveValue(5);
      const audio = screen.getByRole("combobox", { name: "生成音频" });
      expect(audio).toHaveValue("");
      fireEvent.change(audio, { target: { value: "false" } });
      expect(changed.mock.lastCall?.[0].parameterValues["generate_audio"]).toBe(false);
      fireEvent.change(audio, { target: { value: "" } });
      expect(changed.mock.lastCall?.[0].parameterValues).not.toHaveProperty("generate_audio");
      expect(screen.queryByRole("combobox", { name: "能力模式" })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "任务类型" })).not.toBeInTheDocument();
      expect(screen.queryByText(/固定 30 秒/)).not.toBeInTheDocument();
      expect(screen.queryByText(/1080p 需要账户开通权限/)).not.toBeInTheDocument();
      expect(screen.getByText(/本地参考图、视频和音频会先免费上传/)).toBeInTheDocument();
      const firstRole = screen.getByRole("combobox", { name: "首图 的素材角色" });
      fireEvent.change(firstRole, { target: { value: "first_frame" } });
      expect(screen.getByRole("alert")).toHaveTextContent("首尾帧需要成对使用");
      expect(firstRole).toHaveAttribute("aria-describedby", screen.getByRole("alert").id);
      fireEvent.change(screen.getByRole("combobox", { name: "尾图 的素材角色" }), {
        target: { value: "last_frame" },
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("offers PixVerse defaults and returns explicit generation modes to automatic inference", () => {
    const { changed } = mountSettings("PixVerse-V6", [first], catalog, { parameterValues: {} });
    const mode = screen.getByRole("combobox", { name: "能力模式" });
    expect(mode).toHaveValue("");
    expect(
      within(mode)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "自动",
      "文生视频",
      "图生视频",
      "首尾帧生成",
      "延长",
      "多图融合",
      "对口型",
      "音效生成",
      "视频重绘",
      "主体替换",
      "智能多帧",
      "动作模仿",
      "视频编辑",
      "超清视频",
      "图片数字人",
      "爆款复刻",
    ]);
    expect(screen.getByLabelText("清晰度")).toHaveValue("540p");
    expect(screen.getByLabelText("时长")).toHaveValue("5");
    expect(screen.getByRole("checkbox", { name: "生成音频" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "多镜头" })).not.toBeChecked();
    expect(screen.getByText(/图生视频的画幅由参考图决定/)).toBeInTheDocument();
    expect(screen.getByLabelText("画幅")).toBeEnabled();
    expect(screen.getByText(/1080p 需要账户开通权限/)).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("清晰度")).getByRole("option", { name: "1080p" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "任务类型" })).not.toBeInTheDocument();
    fireEvent.change(mode, { target: { value: "img" } });
    expect(changed.mock.lastCall?.[0].parameterValues["action"]).toBe("img");
    fireEvent.change(mode, { target: { value: "" } });
    expect(mode).toHaveValue("");
    expect(changed.mock.lastCall?.[0].parameterValues).not.toHaveProperty("action");
  });

  it("keeps saved PixVerse parameters while offering C1 controls without the V6 multi-clip default", () => {
    mountSettings("PixVerse-C1", [], catalog, {
      parameterValues: {
        duration: 20,
        quality: "1080p",
        action: "modify",
        generate_multi_clip_switch: true,
      },
    });
    expect(screen.getByLabelText("时长")).toHaveValue("20");
    expect(screen.getByLabelText("清晰度")).toHaveValue("1080p");
    expect(screen.getByLabelText("能力模式")).toHaveValue("modify");
    expect(screen.queryByRole("checkbox", { name: "多镜头" })).not.toBeInTheDocument();
    expect(screen.getByText(/画幅参数仅在无参考图的文生视频中生效/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps audio alongside multiple PixVerse images and preserves exact source task IDs", () => {
    const { changed } = mountSettings(
      "PixVerse-V6",
      [first, last, asset("参考图3", "image"), asset("声音", "audio")],
      catalog,
      {
        parameterValues: { action: "fusion", duration: 30 },
      },
    );
    expect(screen.getByLabelText("时长")).toHaveValue("30");
    expect(screen.getByText(/视频和音频会先上传取得素材引用/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("能力模式"), { target: { value: "lip_sync" } });
    fireEvent.change(screen.getByLabelText("源视频任务 ID"), {
      target: { value: "18446744073709551615" },
    });
    expect(changed.mock.lastCall?.[0].parameterValues).toMatchObject({
      action: "lip_sync",
      source_video_id: "18446744073709551615",
      duration: 30,
    });
  });

  it.each([DOMESTIC, DOMESTIC_ALIAS])(
    "opts into 480p draft generation and explains the manual final step for %s",
    (modelId) => {
      const { changed } = mountSettings(modelId, [], catalog, {
        parameterValues: { resolution: "720p", duration: 5, ratio: "16:9" },
      });
      const draft = screen.getByRole("checkbox", { name: "先生成草稿样片" });
      expect(draft).not.toBeChecked();
      expect(screen.getByLabelText("分辨率")).toHaveValue("720p");
      expect(
        within(screen.getByLabelText("分辨率")).queryByRole("option", { name: "1080p" }),
      ).not.toBeInTheDocument();
      fireEvent.click(draft);
      expect(draft).toBeChecked();
      expect(screen.getByLabelText("分辨率")).toBeDisabled();
      expect(changed.mock.lastCall?.[0].parameterValues).toEqual({
        resolution: "480p",
        duration: 5,
        ratio: "16:9",
        draft: true,
      });
      expect(screen.getByText(/人工发起 1080p 正片/)).toHaveTextContent("独立付费任务");
      expect(screen.getByText(/无需额外配置令牌分组/)).toBeInTheDocument();
      fireEvent.click(draft);
      expect(changed.mock.lastCall?.[0].parameterValues["draft"]).toBe(false);
    },
  );

  it.each([DOMESTIC, DOMESTIC_ALIAS])(
    "does not offer Moyu draft generation on the Ark dialect for %s or another Seedance model",
    (modelId) => {
      const arkCatalog = catalog.map((entry) => ({
        ...entry,
        provider: { ...entry.provider, adapterId: "volcengine_ark_v1" },
      }));
      const { unmount } = render(
        <VideoNodeSettings
          config={{
            modelSelection: { providerId: "provider", modelDefinitionId: modelId },
            generationCount: 1,
            parameterValues: {},
            catalogResolved: true,
          }}
          providerCatalog={arkCatalog}
          hasMediaInputs={false}
          onChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole("checkbox", { name: "先生成草稿样片" })).not.toBeInTheDocument();
      unmount();
      mountSettings(OVERSEAS, []);
      expect(screen.queryByRole("checkbox", { name: "先生成草稿样片" })).not.toBeInTheDocument();
    },
  );

  it.each([DOMESTIC, OVERSEAS])(
    "offers edit defaults and keeps parameters editable on %s",
    (modelId) => {
      const { changed, annotate } = mountSettings(modelId);
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "edit" } });
      expect(screen.getByLabelText("画幅")).toHaveValue("adaptive");
      expect(screen.getByLabelText("画幅")).toBeEnabled();
      expect(screen.getByLabelText("时长")).toHaveValue("-1");
      expect(screen.getByLabelText("时长")).toBeEnabled();
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        seedanceTaskMode: "edit",
        parameterValues: { ratio: "adaptive", duration: -1 },
      });
      fireEvent.click(screen.getByRole("button", { name: "局部消除与编辑 · 原视频" }));
      expect(annotate).toHaveBeenCalledWith(video);
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
      expect(screen.getByLabelText("时长")).toBeEnabled();
      expect(screen.getByLabelText("画幅")).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "局部消除与编辑 · 原视频" }),
      ).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "reference" } });
      expect(screen.getByLabelText("画幅")).toBeEnabled();
    },
  );

  it("defers missing/mixed media acceptance and preserves swappable frame identities", () => {
    const { changed } = mountSettings(DOMESTIC, [first, last]);
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "edit" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "first_last_frame" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("首尾帧素材")).getAllByRole("listitem")).toHaveLength(2);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ mediaRoles: { 首图: "first_frame", 尾图: "last_frame" } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "交换首尾帧" }));
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ mediaRoles: { 首图: "last_frame", 尾图: "first_frame" } }),
    );
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "first_frame" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes stale task selection when the user switches to a different model", () => {
    const { changed } = mountSettings();
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "edit" } });
    fireEvent.change(screen.getByLabelText("视频模型"), { target: { value: "wan3.0-video" } });
    expect(screen.queryByRole("option", { name: "全参考 / 自动判断" })).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ seedanceTaskMode: "auto", parameterValues: {}, mediaRoles: {} }),
    );
  });

  it("retains catalog duration controls without imposing a task duration intersection", () => {
    const customCatalog = catalog.map((entry) => ({
      ...entry,
      models: entry.models.map((model) => ({
        ...model,
        operationSchema: {
          video_generation: {
            parameters: {
              ratio: { type: "string", enum: ["adaptive", "16:9"], default: "adaptive" },
              duration: { type: "integer", enum: [2, 3, 6, 12, 45], default: 45 },
            },
          },
        },
      })),
    }));
    const { changed } = mountSettings(DOMESTIC, [video], customCatalog, {
      parameterValues: { duration: 45 },
    });
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
    const duration = screen.getByRole("combobox", { name: "时长" });
    expect(
      within(duration)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["2", "3", "6", "12", "45"]);
    expect(duration).toHaveValue("45");
    fireEvent.change(duration, { target: { value: "12" } });
    expect(duration).toHaveValue("12");
    const selected = changed.mock.lastCall![0];
    const model = customCatalog[0]!.models[0]!;
    const caps = modelParameterCapabilities(
      model.operationSchema,
      "video_generation",
      model.remoteModelId,
    );
    const state = resolveSeedanceTask(model.remoteModelId, caps, selected, [video]);
    expect(state.issue).toBeNull();
    expect(state.parameters["duration"]).toBe(12);
    expect(screen.getByText(/完整提交当前任务/)).toHaveTextContent("由服务端返回");
  });

  it("shows a saved value outside the stale catalog and leaves it editable", () => {
    const customCatalog = catalog.map((entry) => ({
      ...entry,
      models: entry.models.map((model) => ({
        ...model,
        operationSchema: {
          video_generation: {
            parameters: {
              ratio: { type: "string", enum: ["adaptive"], default: "adaptive" },
              duration: { type: "integer", enum: [2, 3, 45], default: 45 },
            },
          },
        },
      })),
    }));
    mountSettings(DOMESTIC, [video], customCatalog, { parameterValues: { duration: 60 } });
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
    expect(screen.getByLabelText("时长")).toBeEnabled();
    expect(screen.getByLabelText("时长")).toHaveValue("60");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores RD edit intent with explicit ratio and duration", () => {
    mountSettings(RD, [video], catalog, {
      seedanceTaskMode: "edit",
      parameterValues: { ratio: "21:9", duration: 20 },
    });
    expect(screen.getByLabelText("任务类型")).toHaveValue("edit");
    expect(screen.getByLabelText("画幅")).toHaveValue("21:9");
    expect(screen.getByLabelText("时长")).toHaveValue("20");
    expect(screen.getByLabelText("画幅")).toBeEnabled();
    expect(screen.getByRole("button", { name: "局部消除与编辑 · 原视频" })).toBeInTheDocument();
  });
});

describe("VideoNodeSettings SP 2.5 public references", () => {
  it("keeps multiple Wan documents and webpages alongside connected media", () => {
    const { changed } = mountSettings("wan3.0-video", [video]);
    const section = screen.getByLabelText("URL 素材（文档/网页）");
    for (const [index, label] of ["粘贴文档 URL", "粘贴文档 URL", "粘贴网页链接"].entries()) {
      fireEvent.click(within(section).getByRole("button", { name: label }));
      fireEvent.change(within(section).getByRole("textbox"), {
        target: { value: `https://example.test/reference-${index}` },
      });
      fireEvent.click(within(section).getByRole("button", { name: "添加" }));
    }
    expect(changed.mock.lastCall?.[0].urlMedia?.map((input) => input.role)).toEqual([
      "file",
      "file",
      "link",
    ]);
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves typed image and audio URLs without losing them when switching models", () => {
    const imageUrl = "https://assets.example.test/image.png?signature=img%2F1";
    const audioUrl = "https://assets.example.test/audio.wav?signature=aud%2B2";
    const { changed } = mountSettings(PER_TASK, [], catalog, {
      urlMedia: [
        { id: "wan-doc", role: "file", label: "文档", url: "https://example.test/doc.pdf" },
      ],
    });
    expect(screen.getByText(/已保留 1 个文档\/网页 URL/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "粘贴文档 URL" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "粘贴参考图 URL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "参考图 URL" }), {
      target: { value: imageUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴参考音频 URL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "参考音频 URL" }), {
      target: { value: audioUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(changed.mock.lastCall?.[0].perTaskUrlMedia).toEqual([
      expect.objectContaining({ kind: "image", url: imageUrl }),
      expect.objectContaining({ kind: "audio", url: audioUrl }),
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "视频模型" }), {
      target: { value: "wan3.0-video" },
    });
    expect(screen.getByText(/已保留 2 个参考 URL/)).toBeInTheDocument();
    expect(screen.queryByLabelText("按次参考 URL")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "视频模型" }), {
      target: { value: PER_TASK },
    });
    expect(within(screen.getByLabelText("按次参考 URL")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(imageUrl)).toBeInTheDocument();
    expect(screen.getByText(audioUrl)).toBeInTheDocument();
    expect(changed.mock.lastCall?.[0].urlMedia).toHaveLength(1);
  });

  it("allows adding references beyond cached counts and exposes audio references", () => {
    const { changed } = mountSettings(
      "sp2.5-720p-30s-ch4",
      Array.from({ length: 9 }, (_, index) => asset(`图${index}`, "image")),
    );
    expect(screen.getByRole("button", { name: "粘贴参考音频 URL" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "粘贴参考图 URL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "参考图 URL" }), {
      target: { value: "https://assets.example.test/extra.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(changed.mock.lastCall?.[0].perTaskUrlMedia).toEqual([
      expect.objectContaining({ kind: "image", url: "https://assets.example.test/extra.png" }),
    ]);
  });
});
