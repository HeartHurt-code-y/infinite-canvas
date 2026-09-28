import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import {
  defaultModelOperationSchema,
  modelParameterCapabilities,
} from "../../lib/modelCapabilities";
import { resolveSeedanceTask } from "../../lib/seedanceTasks";
import { VideoNodeSettings } from "./PromptNodeViews";
import type { ConnectedAssetInput, VideoNodeConfig } from "./workspaceModel";

const DOMESTIC = "doubao-seedance-2-5-260628";
const OVERSEAS = "dreamina-seedance-2.5";
const PER_TASK = "sp2.5-720p-30s-ch5";
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
    models: [DOMESTIC, OVERSEAS, "wan3.0-video", PER_TASK, "sp2.5-720p-30s-ch4"].map((id) => ({
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
  it.each([DOMESTIC, OVERSEAS])(
    "locks edit constraints and opens annotation for the chosen video on %s",
    (modelId) => {
      const { changed, annotate } = mountSettings(modelId);
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "edit" } });
      expect(screen.getByLabelText("画幅")).toHaveValue("adaptive");
      expect(screen.getByLabelText("画幅")).toBeDisabled();
      expect(screen.getByLabelText("时长")).toHaveValue("-1");
      expect(screen.getByLabelText("时长")).toBeDisabled();
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        seedanceTaskMode: "edit",
        parameterValues: { ratio: "adaptive", duration: -1 },
      });
      fireEvent.click(screen.getByRole("button", { name: "局部消除与编辑 · 原视频" }));
      expect(annotate).toHaveBeenCalledWith(video);
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
      expect(screen.getByLabelText("时长")).toBeEnabled();
      expect(screen.getByLabelText("画幅")).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "局部消除与编辑 · 原视频" }),
      ).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "reference" } });
      expect(screen.getByLabelText("画幅")).toBeEnabled();
    },
  );

  it("shows a missing-video error and assigns swappable first/last frames by stable identity", () => {
    const { changed } = mountSettings(DOMESTIC, [first, last]);
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "edit" } });
    expect(screen.getByRole("alert")).toHaveTextContent("请连接至少 1 个待编辑的视频");
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
    expect(screen.getByRole("alert")).toHaveTextContent("只能连接 1 张图片");
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

  it("offers only the task/provider duration intersection and submits the displayed selection", () => {
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
    const { changed } = mountSettings(DOMESTIC, [video], customCatalog);
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
    const duration = screen.getByRole("combobox", { name: "时长" });
    expect(
      within(duration)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["6", "12"]);
    expect(duration).toHaveValue("6");
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
    expect(screen.getByText(/每个参考视频须为 2–30 秒/)).toHaveTextContent(
      "最多 10 个且合计不超过 30 秒",
    );
  });

  it("disables unavailable duration rather than presenting invalid custom options", () => {
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
    mountSettings(DOMESTIC, [video], customCatalog);
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "extend" } });
    expect(screen.getByLabelText("时长")).toBeDisabled();
    expect(screen.getByLabelText("时长")).toHaveValue(null);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "未开放智能（-1）或 4–30 秒范围内的可用时长",
    );
  });
});

describe("VideoNodeSettings SP 2.5 public references", () => {
  it("saves typed image and audio URLs without losing them when switching models", () => {
    const imageUrl = "https://assets.example.test/image.png?signature=img%2F1";
    const audioUrl = "https://assets.example.test/audio.wav?signature=aud%2B2";
    const { changed } = mountSettings(PER_TASK, [], catalog, {
      urlMedia: [
        { id: "wan-doc", role: "file", label: "文档", url: "https://example.test/doc.pdf" },
      ],
    });
    expect(screen.getByText(/已保留 1 个万相文档\/网页 URL/)).toBeInTheDocument();
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
    expect(screen.getByText(/已保留 2 个按次参考 URL/)).toBeInTheDocument();
    expect(screen.queryByLabelText("按次参考 URL")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "视频模型" }), {
      target: { value: PER_TASK },
    });
    expect(within(screen.getByLabelText("按次参考 URL")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(imageUrl)).toBeInTheDocument();
    expect(screen.getByText(audioUrl)).toBeInTheDocument();
    expect(changed.mock.lastCall?.[0].urlMedia).toHaveLength(1);
  });

  it("blocks an invalid or over-limit URL before adding it to a paid request", () => {
    const { changed } = mountSettings(
      "sp2.5-720p-30s-ch4",
      Array.from({ length: 9 }, (_, index) => asset(`图${index}`, "image")),
    );
    expect(screen.queryByRole("button", { name: "粘贴参考音频 URL" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "粘贴参考图 URL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "参考图 URL" }), {
      target: { value: "https://assets.example.test/extra.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("alert")).toHaveTextContent("最多支持 9 张参考图");
    expect(changed).not.toHaveBeenCalled();
  });
});
