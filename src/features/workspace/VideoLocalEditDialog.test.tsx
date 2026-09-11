import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptReferenceCandidate } from "../../lib/promptReferences";
import {
  VideoLocalEditDialog,
  type VideoLocalEditFrameResolution,
  type VideoLocalEditResult,
  type VideoLocalEditSource,
} from "./VideoLocalEditDialog";
import {
  VIDEO_EDIT_THUMBNAIL_RESOLUTION,
  captureVideoEditFrameThumbnail,
  exportVideoLocalEditFrame,
} from "./videoLocalEditDrawing";
import type * as VideoLocalEditDrawing from "./videoLocalEditDrawing";
import type * as VideoLocalEditModule from "../../lib/videoLocalEdit";

const prepareSource = vi.hoisted(() => vi.fn());
const saveFrame = vi.hoisted(() => vi.fn());
// 只替换需要拦截的导出：整模块替身会让弹窗新增的引用展开函数变成 undefined，
// 报错会伪装成「提交按钮没反应」。
vi.mock("../../lib/videoLocalEdit", async (importOriginal) => {
  const original = await importOriginal<typeof VideoLocalEditModule>();
  return {
    ...original,
    prepareVideoEditSource: prepareSource,
    // 落盘是桌面能力：测试替换为固定路径，避免真的调用 Tauri invoke。
    saveVideoEditFrame: saveFrame,
  };
});

vi.mock("./videoLocalEditDrawing", async (importOriginal) => {
  const original = await importOriginal<typeof VideoLocalEditDrawing>();
  return {
    ...original,
    exportVideoLocalEditFrame: vi.fn(() => "data:image/png;base64,annotated-frame"),
    // jsdom 没有可解码的 video：缩略图取帧按接口契约替换，几何计算仍走真实实现。
    captureVideoEditFrameThumbnail: vi.fn(() => Promise.resolve<string | null>(null)),
  };
});

const source = { key: "canvas-video-stable", label: "餐厅原视频", src: "blob:restaurant-source" };

/** 当前生成节点已连接的替换素材；编辑要求可用 @ 引用。 */
const roseCandidate: PromptReferenceCandidate = {
  canvasNodeKey: "prop-image",
  assetId: "asset-rose",
  providerConnectionId: "project-provider",
  name: "红玫瑰.png",
  kind: "image",
};

function renderDialog(
  options: {
    readonly source?: VideoLocalEditSource;
    readonly candidates?: readonly PromptReferenceCandidate[];
    readonly onClose?: () => void;
    /** 覆盖提交实现（默认立即成功），返回值仍是可直接断言的 mock。 */
    readonly onApplyImpl?: () => Promise<void>;
    /** 云端素材库连接是否可用；不可用时弹窗不渲染上传选项。 */
    readonly canUploadToLibrary?: boolean;
    /** 覆盖标注帧身份解析；默认入库成功，返回 asset:// 资产身份。 */
    readonly resolveFrameImpl?: (request: {
      readonly path: string;
      readonly name: string;
      readonly onProgress: (label: string) => void;
    }) => Promise<VideoLocalEditFrameResolution>;
  } = {},
) {
  const onApply = vi.fn<(result: VideoLocalEditResult) => Promise<void>>(
    options.onApplyImpl ?? (async () => {}),
  );
  const onClose = options.onClose ?? vi.fn();
  const resolveFrame = vi.fn(
    options.resolveFrameImpl ??
      ((): Promise<VideoLocalEditFrameResolution> =>
        Promise.resolve({
          uploadedToLibrary: true,
          target: {
            kind: "asset",
            providerConnectionId: "project-provider",
            assetId: "asset-frame",
            canvasNodeKey: "annotation-node",
            mediaType: "image",
          },
        })),
  );
  const view = render(
    <VideoLocalEditDialog
      source={options.source ?? source}
      candidates={options.candidates ?? []}
      canUploadToLibrary={options.canUploadToLibrary ?? false}
      resolveFrame={resolveFrame}
      onClose={onClose}
      onApply={onApply}
    />,
  );
  return { ...view, onApply, onClose, resolveFrame };
}

/** 编辑要求沿用与画布一致的引用编辑器：正文即编辑要求，@ 引用是原子 chip。 */
function instruction(text: string) {
  return { schema: "prompt-content", version: 1, items: [{ kind: "text", text }] };
}

function loadVideo() {
  const video = screen.getByLabelText<HTMLVideoElement>("待编辑视频：餐厅原视频");
  Object.defineProperties(video, {
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
    duration: { value: 15 },
    readyState: { value: 2 },
  });
  fireEvent.loadedData(video);
  return video;
}

/**
 * 后台取帧元素：弹窗为缩略图另挂的 video，不显示也不参与预览。
 * jsdom 不解码视频，因此用例必须显式给它画面尺寸并标成已就绪（loadeddata）。
 */
function readyCaptureVideo() {
  const video = document.querySelector<HTMLVideoElement>(
    ".video-local-edit-dialog__capture-source",
  )!;
  Object.defineProperties(video, {
    videoWidth: { value: 1920, configurable: true },
    videoHeight: { value: 1080, configurable: true },
    duration: { value: 15, configurable: true },
    readyState: { value: 2, configurable: true },
  });
  fireEvent.loadedData(video);
  return video;
}

/**
 * jsdom 没有布局：叠加层量出来永远是 0×0，缩略图几何就无从计算。
 * 给量测面一个真实的显示尺寸，缩略图的位置与尺寸才与 WebView 里一致。
 */
function layoutThumbnailLayer(width = 1280, height = 800) {
  const layer = document.querySelector<HTMLElement>(".video-local-edit-dialog__thumbnails")!;
  Object.defineProperties(layer, {
    clientWidth: { value: width, configurable: true },
    clientHeight: { value: height, configurable: true },
  });
  // 量测由 ResizeObserver 回调驱动：stub 在 observe 后异步派发一次。
  return layer;
}

/** 缩略图裁剪用的 2D 上下文替身：jsdom 没有真实 canvas 实现。 */
function drawingContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
}

function pointerEvent(type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

function pointer(type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) {
  const overlay = screen.getByRole("img", { name: /视频标注区域/ });
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
    right: 400,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent(overlay, pointerEvent(type, x, y));
}

function drawRectangle() {
  pointer("pointerdown", 100, 143.75);
  pointer("pointerup", 300, 256.25);
}

/**
 * 通过界面跳转时间：标记归属以播放头为准，测试也必须走真实路径 ——
 * 直接写 video.currentTime 不会经过 React 状态，弹窗不知道画面变了。
 */
function seekToFrame(seconds: number) {
  fireEvent.change(screen.getByRole("slider", { name: "视频时间" }), {
    target: { value: String(seconds) },
  });
  fireEvent.seeked(screen.getByLabelText<HTMLVideoElement>("待编辑视频：餐厅原视频"));
}

/** 1920×1080 画面被 letterbox 放进 400×400 的容器：纵向可绘制区间是 87.5–312.5。 */
function drawRegion(left: number, top: number, right: number, bottom: number) {
  const x = (value: number) => value * 400;
  const y = (value: number) => 87.5 + value * 225;
  pointer("pointerdown", x(left), y(top));
  pointer("pointermove", x(right), y(bottom));
  pointer("pointerup", x(right), y(bottom));
}

beforeEach(() => {
  prepareSource.mockReset();
  saveFrame.mockReset().mockResolvedValue({
    path: "C:\\generated\\annotation.png",
    width: 1920,
    height: 1080,
  });
  vi.mocked(exportVideoLocalEditFrame)
    .mockReset()
    .mockReturnValue("data:image/png;base64,annotated-frame");
  vi.mocked(captureVideoEditFrameThumbnail).mockReset().mockResolvedValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe("VideoLocalEditDialog", () => {
  it("prepares a cloud video by stable identity before loading cross-origin pixels", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    prepareSource.mockResolvedValue({ src: "http://asset.localhost/preview.mp4", release });
    const cloud = {
      ...source,
      src: "https://cdn.example.test/no-cors.mp4?expired=1",
      target: {
        kind: "asset" as const,
        providerConnectionId: "provider",
        assetId: "video-id",
        mediaType: "video" as const,
      },
    };
    const { unmount } = renderDialog({ source: cloud });
    expect(screen.getByLabelText("待编辑视频：餐厅原视频")).not.toHaveAttribute("src", cloud.src);
    await waitFor(() => expect(prepareSource).toHaveBeenCalledWith(cloud.target, cloud.src));
    expect(screen.getByLabelText("待编辑视频：餐厅原视频")).toHaveAttribute(
      "src",
      "http://asset.localhost/preview.mp4",
    );
    loadVideo();
    drawRectangle();
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();
    unmount();
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it("requires both a visible region and instructions, preserving real source identity on apply", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    const submit = screen.getByRole("button", { name: "添加到生成节点" });
    expect(submit).toBeDisabled();
    loadVideo();
    seekToFrame(3.25);
    await user.type(screen.getByRole("textbox"), "消除圈出的路人，保留桌子");
    expect(submit).toBeDisabled();
    pointer("pointerdown", 30, 30);
    pointer("pointerup", 300, 250);
    // 起手落在画面外的黑边上：夹到画面内成框，而不是静默丢弃这次拖拽。
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("img", { name: /已有 0 处标记/ })).toBeInTheDocument();
    drawRectangle();
    expect(submit).toBeEnabled();
    expect(
      screen.getByRole("img", { name: /已有 1 处标记/ }).querySelector("rect"),
    ).toHaveAttribute("x", "480");
    await user.click(submit);
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply).toHaveBeenCalledWith({
      imageDataUrl: "data:image/png;base64,annotated-frame",
      sourceKey: source.key,
      timeSeconds: 3.25,
      instructionDocument: instruction("消除圈出的路人，保留桌子"),
      operation: "remove",
      timeRange: null,
      // 弹窗先落盘再解析身份：提交给调用方的是可直接接入节点的帧信息。
      frame: {
        path: "C:\\generated\\annotation.png",
        name: "餐厅原视频 · 3.250s 标注",
        target: {
          kind: "asset",
          providerConnectionId: "project-provider",
          assetId: "asset-frame",
          canvasNodeKey: "annotation-node",
          mediaType: "image",
        },
        uploadedToLibrary: true,
        aspectRatio: 1920 / 1080,
      },
      // 本次提交只画当前画面，编辑要求也没有引用别的时间点的标注。
      offFrameReferenceTimes: [],
    });
    const exportedFrame = vi.mocked(exportVideoLocalEditFrame).mock.calls.at(-1)![1];
    expect(exportedFrame).toHaveLength(1);
    expect(exportedFrame[0]).toMatchObject({
      kind: "rectangle",
      color: "#ff4865",
      points: [
        { x: 0.25, y: 0.25 },
        { x: 0.75, y: 0.75 },
      ],
    });
    expect(exportedFrame[0]!.id).toMatch(/^mark-/);
  });

  it("releases a late prepared preview after closing without loading it", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    let finish: (result: { src: string; release: () => Promise<void> }) => void = () => {
      throw new Error("Preparation not started");
    };
    prepareSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pendingSource = {
      ...source,
      target: {
        kind: "url" as const,
        url: "https://cdn.example.test/video.mp4",
        mediaType: "video" as const,
      },
    };
    const { unmount } = renderDialog({ source: pendingSource });
    expect(screen.getByText("正在读取原视频…")).toBeInTheDocument();
    unmount();
    await act(async () => {
      finish({ src: "http://asset.localhost/late.mp4", release });
      await Promise.resolve();
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a new video's preview when the previous source finishes late", async () => {
    const oldRelease = vi.fn().mockResolvedValue(undefined);
    const newRelease = vi.fn().mockResolvedValue(undefined);
    let finishOld: (result: { src: string; release: () => Promise<void> }) => void = () => {
      throw new Error("Preparation not started");
    };
    prepareSource
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ src: "http://asset.localhost/new.mp4", release: newRelease });
    const target = {
      kind: "asset" as const,
      providerConnectionId: "provider",
      assetId: "old",
      mediaType: "video" as const,
    };
    const { rerender, unmount } = renderDialog({ source: { ...source, target } });
    rerender(
      <VideoLocalEditDialog
        source={{ ...source, target: { ...target, assetId: "new" } }}
        candidates={[]}
        canUploadToLibrary={false}
        resolveFrame={vi.fn()}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("待编辑视频：餐厅原视频")).toHaveAttribute(
        "src",
        "http://asset.localhost/new.mp4",
      ),
    );
    await act(async () => {
      finishOld({ src: "http://asset.localhost/old.mp4", release: oldRelease });
      await Promise.resolve();
    });
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newRelease).not.toHaveBeenCalled();
    expect(screen.getByLabelText("待编辑视频：餐厅原视频")).toHaveAttribute(
      "src",
      "http://asset.localhost/new.mp4",
    );
    unmount();
    expect(newRelease).toHaveBeenCalledOnce();
  });

  it("retries native source resolution while preserving the editing instructions", async () => {
    const user = userEvent.setup();
    prepareSource.mockRejectedValueOnce({ message: "云素材暂时不可读取" }).mockResolvedValueOnce({
      src: "http://asset.localhost/retry.mp4",
      release: vi.fn().mockResolvedValue(undefined),
    });
    const target = {
      kind: "local_asset" as const,
      stagingJobId: "job",
      mediaType: "video" as const,
    };
    renderDialog({ source: { ...source, src: "", target } });
    expect(await screen.findByRole("alert")).toHaveTextContent("云素材暂时不可读取");
    await user.type(screen.getByRole("textbox"), "保留左边人物");
    await user.click(screen.getByRole("button", { name: "重新读取视频" }));
    await waitFor(() =>
      expect(screen.getByLabelText("待编辑视频：餐厅原视频")).toHaveAttribute(
        "src",
        "http://asset.localhost/retry.mp4",
      ),
    );
    expect(prepareSource).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox")).toHaveTextContent("保留左边人物");
  });

  it("supports colored freehand strokes, undo, and clearing without changing instructions", async () => {
    const user = userEvent.setup();
    renderDialog();
    loadVideo();
    drawRectangle();
    await user.click(screen.getByRole("button", { name: "画笔" }));
    await user.click(screen.getByRole("button", { name: "蓝色标记" }));
    pointer("pointerdown", 100, 150);
    pointer("pointermove", 200, 200);
    pointer("pointerup", 100, 150);
    expect(
      screen.getByRole("img", { name: /已有 2 处标记/ }).querySelector("polyline"),
    ).toHaveAttribute("stroke", "#5caeff");
    await user.type(screen.getByRole("textbox"), "替换圈出的杯子");
    await user.click(screen.getByRole("button", { name: "撤销" }));
    const remainingMarks = screen.getByRole("img", { name: /已有 1 处标记/ });
    expect(remainingMarks.querySelector("polyline")).toBeNull();
    await user.click(screen.getByRole("button", { name: "清除" }));
    expect(screen.getByRole("img", { name: /已有 0 处标记/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("替换圈出的杯子");
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  });

  it("keeps the marks of other frames when the time changes, and blocks annotation until the frame decodes", () => {
    renderDialog();
    const video = loadVideo();
    drawRectangle();
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "视频时间" }), { target: { value: "5" } });
    expect(video.currentTime).toBe(5);
    // 标注属于它标记的那一帧：换帧只是换画面看，清单里仍然留着并可回到该画面。
    expect(screen.getByRole("img", { name: /已有 0 处标记/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const list = screen.getByRole("list", { name: "已标注区域" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list).toHaveTextContent("标注1");
    expect(screen.getByRole("button", { name: "回到 0:00.00 标注的画面" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加到生成节点" })).toBeDisabled();
    expect(screen.getByText(/标注只对它所标记的那一帧生效/)).toBeInTheDocument();

    // 未解码完成前不能标注，解码后恢复。
    expect(screen.getByRole("button", { name: "框选" })).toBeDisabled();

    // 点时间即可回到标注所在画面，标注随之恢复显示与提交资格。
    fireEvent.click(screen.getByRole("button", { name: "回到 0:00.00 标注的画面" }));
    fireEvent.seeked(video);
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "框选" })).toBeEnabled();
  });

  it("supports keyboard coordinate regions and a validated edit interval independent of the locator frame", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    loadVideo();
    seekToFrame(2);
    await user.click(screen.getByText("输入坐标框选"));
    await user.click(screen.getByRole("button", { name: "添加框选" }));
    await user.click(screen.getByRole("button", { name: "替换与编辑" }));
    await user.type(screen.getByRole("textbox"), "红框内的杯子变成花瓶");
    await user.click(screen.getByRole("button", { name: "指定时段" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "开始时间（秒）" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "结束时间（秒）" }), {
      target: { value: "4" },
    });
    expect(screen.getByRole("button", { name: "添加到生成节点" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("结束时间须晚于开始时间");
    fireEvent.change(screen.getByRole("spinbutton", { name: "结束时间（秒）" }), {
      target: { value: "8" },
    });
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        timeSeconds: 2,
        operation: "replace",
        timeRange: { startSeconds: 5, endSeconds: 8 },
      }),
    );
  });

  it("blocks duplicate submissions and dismissal while saving, then retains the draft on failure", async () => {
    const user = userEvent.setup();
    let fail: (error: Error) => void = () => {};
    const onClose = vi.fn();
    const { onApply } = renderDialog({
      onClose,
      onApplyImpl: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    });
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除右侧路人");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    expect(screen.getByRole("button", { name: "正在添加标注帧…" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveFocus();
    await user.keyboard("{Escape}{Tab}");
    expect(onClose).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledOnce();
    await act(async () => {
      fail(new Error("磁盘写入失败"));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("磁盘写入失败");
    expect(screen.getByRole("textbox")).toHaveTextContent("消除右侧路人");
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加到生成节点" })).toBeEnabled();
  });

  it("shows load and capture failures and does not submit a blank frame", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    const video = screen.getByLabelText("待编辑视频：餐厅原视频");
    fireEvent.error(video);
    expect(screen.getByRole("alert")).toHaveTextContent("无法加载此视频");
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除路人");
    vi.mocked(exportVideoLocalEditFrame).mockImplementation(() => {
      throw new Error("视频来源不允许截取画面");
    });
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    expect(screen.getByRole("alert")).toHaveTextContent("视频来源不允许截取画面");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("offers the connected materials as @ 引用 in the edit requirement and keeps the reference identity", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog({ candidates: [roseCandidate] });
    loadVideo();
    seekToFrame(4);
    drawRectangle();
    await user.click(screen.getByRole("button", { name: "替换与编辑" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox").querySelector("p")).toHaveAttribute(
        "data-placeholder",
        "例如：把 @标注1 替换为红玫瑰、消除 @标注2，并说明哪些内容需要保持。",
      ),
    );
    await user.type(screen.getByRole("textbox"), "去掉，改为");
    await user.click(screen.getByRole("button", { name: "引用素材到提示词（候选 1 个）" }));
    // @ 菜单里同时有画面标注与连线素材；这里只取连线素材那一项。
    await user.click(await screen.findByRole("option", { name: /红玫瑰\.png/ }));
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const result = onApply.mock.calls[0]![0];
    expect(result.operation).toBe("replace");
    expect(result.timeSeconds).toBe(4);
    expect(result.instructionDocument.items).toMatchObject([
      { kind: "text", text: "去掉，改为" },
      {
        kind: "media_reference",
        canvasNodeKey: "prop-image",
        displayNameSnapshot: "红玫瑰.png",
      },
    ]);
  });

  it("hides the library upload option when no asset library connection is configured", () => {
    renderDialog({ canUploadToLibrary: false });
    loadVideo();
    expect(
      screen.queryByRole("checkbox", { name: /上传标注帧到云端素材库/ }),
    ).not.toBeInTheDocument();
  });

  it("requests the library upload by default so real-person frames keep a verifiable origin", async () => {
    const user = userEvent.setup();
    const { onApply, resolveFrame } = renderDialog({ canUploadToLibrary: true });
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除路人");
    expect(screen.getByRole("checkbox", { name: /上传标注帧到云端素材库/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    // 弹窗自己发起入库：调用方拿到的已经是解析好的资产身份。
    expect(resolveFrame).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:\\generated\\annotation.png" }),
    );
    expect(onApply.mock.calls[0]![0].frame).toEqual({
      path: "C:\\generated\\annotation.png",
      name: "餐厅原视频 · 0.000s 标注",
      target: {
        kind: "asset",
        providerConnectionId: "project-provider",
        assetId: "asset-frame",
        canvasNodeKey: "annotation-node",
        mediaType: "image",
      },
      uploadedToLibrary: true,
      aspectRatio: 1920 / 1080,
    });
  });

  it("skips the library upload when the option is unchecked", async () => {
    const user = userEvent.setup();
    // 没有连接可用时弹窗不渲染选项，因此这里直接按未勾选路径断言本地文件身份。
    const { onApply, resolveFrame } = renderDialog({
      canUploadToLibrary: true,
      resolveFrameImpl: () =>
        Promise.resolve({
          uploadedToLibrary: false,
          target: {
            kind: "local_file",
            path: "C:\\generated\\annotation.png",
            canvasNodeKey: "annotation-node",
            mediaType: "image",
          },
        }),
    });
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除路人");
    await user.click(screen.getByRole("checkbox", { name: /上传标注帧到云端素材库/ }));
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0]![0].frame.uploadedToLibrary).toBe(false);
    expect(onApply.mock.calls[0]![0].frame.target.kind).toBe("local_file");
    expect(resolveFrame).toHaveBeenCalledOnce();
  });

  it("keeps the dialog and the marks when the frame import fails, then retries the import only", async () => {
    const user = userEvent.setup();
    const resolveFrame = vi
      .fn<
        (request: {
          readonly path: string;
          readonly name: string;
          readonly uploadToLibrary: boolean;
        }) => Promise<VideoLocalEditFrameResolution>
      >()
      .mockRejectedValueOnce(new Error("标注帧上传素材库失败：对象存储未配置"))
      .mockResolvedValue({
        uploadedToLibrary: true,
        target: {
          kind: "asset",
          providerConnectionId: "project-provider",
          assetId: "asset-frame",
          canvasNodeKey: "annotation-node",
          mediaType: "image",
        },
      });
    const onApply = vi.fn<(result: VideoLocalEditResult) => Promise<void>>(async () => {});
    render(
      <VideoLocalEditDialog
        source={source}
        candidates={[]}
        canUploadToLibrary
        resolveFrame={resolveFrame}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除路人");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));

    // 入库失败：弹窗不关、标注不丢，错误留在原地并给出重试入口。
    expect(await screen.findByRole("alert")).toHaveTextContent("对象存储未配置");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "已标注区域" })).toHaveTextContent("标注1");
    expect(screen.getByRole("textbox")).toHaveTextContent("消除路人");
    expect(saveFrame).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "重试入库并添加" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    // 重试只重跑入库：本地标注帧不重复导出、也不重复落盘。
    expect(saveFrame).toHaveBeenCalledOnce();
    expect(resolveFrame).toHaveBeenCalledTimes(2);
    expect(resolveFrame.mock.calls[0]![0].path).toBe(resolveFrame.mock.calls[1]![0].path);
    expect(resolveFrame.mock.calls[1]![0].uploadToLibrary).toBe(true);

    expect(onApply.mock.calls[0]![0].frame.uploadedToLibrary).toBe(true);
  });

  it("lets the user drop the library requirement after a failed import and submit the saved frame locally", async () => {
    const user = userEvent.setup();
    const resolveFrame = vi.fn(
      (request: {
        readonly path: string;
        readonly uploadToLibrary: boolean;
      }): Promise<VideoLocalEditFrameResolution> =>
        request.uploadToLibrary
          ? Promise.reject(new Error("标注帧上传素材库失败：平台审核未通过"))
          : Promise.resolve({
              uploadedToLibrary: false,
              target: {
                kind: "local_file",
                path: request.path,
                canvasNodeKey: "",
                mediaType: "image",
              },
            }),
    );
    const onApply = vi.fn<(result: VideoLocalEditResult) => Promise<void>>(async () => {});
    render(
      <VideoLocalEditDialog
        source={source}
        candidates={[]}
        canUploadToLibrary
        resolveFrame={resolveFrame}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    loadVideo();
    drawRectangle();
    await user.type(screen.getByRole("textbox"), "消除路人");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("平台审核未通过");

    // 放弃入库不等于放弃这次编辑：取消勾选后仍然用同一张已落盘的标注帧提交。
    await user.click(screen.getByRole("checkbox", { name: /上传标注帧到云端素材库/ }));
    await user.click(screen.getByRole("button", { name: "重试入库并添加" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(saveFrame).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]![0].frame).toMatchObject({
      path: "C:\\generated\\annotation.png",
      uploadedToLibrary: false,
      target: { kind: "local_file", path: "C:\\generated\\annotation.png" },
    });
  });

  it("keeps several regions at once and lists every one of them for review", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    loadVideo();
    seekToFrame(2);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    drawRegion(0.1, 0.1, 0.4, 0.4);
    drawRegion(0.5, 0.5, 0.9, 0.9);
    expect(screen.getByRole("img", { name: /已有 3 处标记/ })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "已标注区域" });
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(list).toHaveTextContent(
      "标注1当前帧红色框选，画面左侧 25%、顶部 25% 至右侧 75%、底部 75%",
    );
    expect(list).toHaveTextContent(
      "标注3当前帧红色框选，画面左侧 50%、顶部 50% 至右侧 90%、底部 90%",
    );

    // 逐条删除：删掉中间一处后其余标记顺次前移，编号与清单保持一致。
    await user.click(screen.getByRole("button", { name: "删除标注2" }));
    const remaining = screen.getByRole("list", { name: "已标注区域" });
    expect(remaining.querySelectorAll("li")).toHaveLength(2);
    expect(remaining).toHaveTextContent(
      "标注2当前帧红色框选，画面左侧 50%、顶部 50% 至右侧 90%、底部 90%",
    );

    await user.type(screen.getByRole("textbox"), "多处一起改");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const exported = vi.mocked(exportVideoLocalEditFrame).mock.calls.at(-1)![1];
    expect(exported).toHaveLength(2);
    expect(exported[0]!.points).toEqual([
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.75 },
    ]);
    expect(exported[1]!.points).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.9 },
    ]);
    expect(exported[0]!.id).not.toBe(exported[1]!.id);
  });

  it("references each marked region from the edit requirement and expands it into the prompt", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    loadVideo();
    seekToFrame(1.5);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    drawRegion(0.1, 0.1, 0.4, 0.4);
    await user.type(screen.getByRole("textbox"), "把 ");
    await user.click(screen.getByRole("button", { name: "引用素材到提示词（候选 0 个）" }));
    await user.click(await screen.findByRole("option", { name: /标注2，画面标注/ }));
    const chip = screen.getByRole("textbox").querySelector("[data-mark-id]");
    expect(chip).toHaveAttribute("data-display-name", "标注2");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    // 标注引用在导出时展开成自述正文：生成请求仍然只有正文与素材引用两种条目。
    // 描述一律带帧时间，模型因此知道这一处落在视频的哪一刻。
    expect(onApply.mock.calls[0]![0].instructionDocument.items).toEqual([
      {
        kind: "text",
        text: "把 标注2（视频 0:01.50 处：红色框选，画面左侧 10%、顶部 10% 至右侧 40%、底部 40%）",
      },
    ]);
  });

  it("drops the references of a removed region and renumbers the chips that stay", async () => {
    const user = userEvent.setup();
    renderDialog();
    loadVideo();
    drawRegion(0.25, 0.25, 0.75, 0.75);
    drawRegion(0.1, 0.1, 0.4, 0.4);
    await user.click(screen.getByRole("button", { name: "在编辑要求中引用标注2" }));
    const chip = screen.getByRole("textbox").querySelector("[data-mark-id]");
    expect(chip).toHaveAttribute("data-display-name", "标注2");
    const referencedMarkId = chip?.getAttribute("data-mark-id");

    // 删掉未被引用的标注1：剩下的区域接替编号，chip 必须跟着改，否则正文指向另一处。
    await user.click(screen.getByRole("button", { name: "删除标注1" }));
    const renumbered = screen.getByRole("textbox").querySelector("[data-mark-id]");
    expect(renumbered).toHaveAttribute("data-display-name", "标注1");

    // 删掉被引用的区域：引用一并移除，并明确告知，而不是留下指向空画面的描述。
    await user.click(screen.getByRole("button", { name: "删除标注1" }));
    const instructionEditor = screen.getByRole("textbox");
    expect(instructionEditor.querySelector("[data-mark-id]")).toBeNull();
    expect(instructionEditor).not.toHaveTextContent("标注");
    expect(
      screen.getByText("标注已删除，编辑要求中指向它的 1 处引用已同步移除。"),
    ).toBeInTheDocument();
    expect(referencedMarkId).toBeTruthy();
  });

  it("takes the visible frame's thumbnail from the paused preview with adaptive geometry", async () => {
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,preview-frame");
    renderDialog();
    const video = loadVideo();
    layoutThumbnailLayer();
    readyCaptureVideo();
    // jsdom 不会真的推进 main 预览的 currentTime，因此让标记就落在播放头的 0 秒上：
    // 这正是「标记属于当前画面」的情形，缩略图应当直接来自主预览。
    drawRegion(0.25, 0.25, 0.75, 0.75);
    // 原来的红色序号圆圈已经不再出现在画面上：只有一处标记时本来也没有编号。
    expect(
      screen.getByRole("img", { name: /已有 1 处标记/ }).querySelectorAll("circle"),
    ).toHaveLength(0);
    const figure = await screen.findByRole("figure", { hidden: true });
    expect(figure).toHaveAttribute("data-frame-thumbnail", "0.000");
    expect(figure).toHaveTextContent("1");
    expect(figure.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,preview-frame",
    );
    expect(encode).toHaveBeenCalledWith("image/png");
    // 按标记区域外扩一圈（24%）裁剪：只裁标记周围那一块，不整帧缩放。
    const drawCall = context.drawImage.mock.calls.at(-1) as unknown as readonly [
      HTMLVideoElement,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const [drawnFrom, cropX, cropY, cropWidth, cropHeight, , , canvasWidth, canvasHeight] =
      drawCall;
    expect(drawnFrom).toBe(video);
    expect(Math.round(cropX)).toBe(250);
    expect(Math.round(cropY)).toBe(140);
    expect(Math.round(cropWidth)).toBe(1421);
    expect(Math.max(canvasWidth, canvasHeight)).toBe(VIDEO_EDIT_THUMBNAIL_RESOLUTION);
    expect(canvasWidth / canvasHeight).toBeCloseTo(cropWidth / cropHeight, 2);
    // 缩略图横置在标记区域上边缘居中处，显示尺寸随区域比例自适应、与裁剪画面同比例。
    const shownWidth = Number.parseFloat(figure.style.width);
    const shownHeight = Number.parseFloat(figure.style.height);
    expect(figure).toHaveStyle({ left: "576px" });
    expect(shownWidth / shownHeight).toBeCloseTo(canvasWidth / canvasHeight, 1);
    expect(shownWidth).toBeGreaterThanOrEqual(48);
    expect(shownWidth).toBeLessThanOrEqual(128);
    // 主预览能给出这一帧时不必再等后台取帧。
    expect(captureVideoEditFrameThumbnail).not.toHaveBeenCalled();
  });

  it("falls back to the background element for another frame's mark, retrying a failed seek", async () => {
    vi.mocked(captureVideoEditFrameThumbnail)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("data:image/png;base64,mark-frame");
    renderDialog();
    loadVideo();
    layoutThumbnailLayer();
    readyCaptureVideo();
    seekToFrame(2);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    const figure = await screen.findByRole("figure", { hidden: true });
    expect(figure).toHaveAttribute("data-frame-thumbnail", "2.000");
    /*
     * 播放头回到第 0 秒：这处标记属于第 2 秒，主预览已经给不出它的画面，
     * 缩略图必须由后台元素 seek 到标记自己那一帧取回。
     * jsdom 的 seeked 不会自己来，所以轮询补发，直到后台取帧真的被走到。
     */
    await waitFor(() =>
      expect(
        (() => {
          fireEvent.seeked(screen.getByLabelText<HTMLVideoElement>("待编辑视频：餐厅原视频"));
          return vi.mocked(captureVideoEditFrameThumbnail).mock.calls.length;
        })(),
      ).toBeGreaterThan(0),
    );
    const capture = vi.mocked(captureVideoEditFrameThumbnail).mock.calls.at(-1)!;
    expect(capture[1].timeSeconds).toBe(2);
    // 第一次 seek 失败（源还没缓冲好）不算终局：失败会被重试，缩略图最终仍然出现。
    await waitFor(() =>
      expect(vi.mocked(captureVideoEditFrameThumbnail).mock.calls.length).toBeGreaterThan(1),
    );
    expect(figure.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,mark-frame");
  });

  it("leaves the user's frame untouched while thumbnails are being captured", async () => {
    // 后台元素取不到帧时，取帧兜底会去动主预览；但它必须把用户停留的位置还原回去，
    // 也不能把内部跳帧显示成「正在定位画面…」。取帧本身的行为在 drawing 单测里覆盖。
    vi.mocked(captureVideoEditFrameThumbnail).mockResolvedValue(null);
    renderDialog();
    const video = loadVideo();
    layoutThumbnailLayer();
    readyCaptureVideo();
    seekToFrame(2);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    // 让取帧循环跑几轮（后台元素始终取不到帧）。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(video.currentTime).toBe(2);
    expect(screen.queryByText("正在定位画面…")).not.toBeInTheDocument();
  });

  it("offers the frame thumbnail in the @ menu so a mark is recognizable by sight", async () => {
    const user = userEvent.setup();
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,menu-thumb",
    );
    renderDialog();
    loadVideo();
    layoutThumbnailLayer();
    readyCaptureVideo();
    // 标记落在播放头的 0 秒上：直接由主预览裁剪，缩略图随标记立即可用。
    drawRegion(0.25, 0.25, 0.75, 0.75);
    await screen.findByRole("figure", { hidden: true });

    await user.click(screen.getByRole("button", { name: "引用素材到提示词（候选 0 个）" }));
    const option = await screen.findByRole("option", { name: /标注1，画面标注/ });
    const thumb = option.querySelector<HTMLImageElement>(".prompt-mention__thumb--annotation img")!;
    expect(thumb).toHaveAttribute("src", "data:image/png;base64,menu-thumb");
    // 有缩略图时按标记区域比例自适应：高度固定、宽度自动，不再压成方块。
    expect(thumb.closest(".prompt-mention__thumb--annotation")).toHaveClass(
      "prompt-mention__thumb--auto-size",
    );
  });

  it("replaces the ordinal circle only once the frame thumbnail is available", async () => {
    vi.mocked(captureVideoEditFrameThumbnail).mockResolvedValue("data:image/png;base64,mark-frame");
    renderDialog();
    loadVideo();
    layoutThumbnailLayer();
    seekToFrame(2);
    drawRegion(0.15, 0.15, 0.45, 0.45);
    drawRegion(0.55, 0.55, 0.85, 0.85);
    // 后台元素还没就绪：两处标记此时仍是序号圆圈，缩略图到位后才让位。
    expect(
      screen.getByRole("img", { name: /已有 2 处标记/ }).querySelectorAll("circle"),
    ).toHaveLength(2);
    readyCaptureVideo();
    const figures = await screen.findAllByRole("figure", { hidden: true });
    expect(figures.map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(
      screen.getByRole("img", { name: /已有 2 处标记/ }).querySelectorAll("circle"),
    ).toHaveLength(0);
  });

  it("keeps the marks of several time points and submits only the frame on screen", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    loadVideo();
    seekToFrame(2);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    seekToFrame(6);
    drawRegion(0.1, 0.1, 0.4, 0.4);

    const list = screen.getByRole("list", { name: "已标注区域" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    // 两处标注各自记着自己的画面，清单同时列出；属于其它画面的那处可一键回去。
    // 编号全片唯一：第一处永远是「标注1」，不会因为换帧换号（也不会有两个「标注1」）。
    expect(list).toHaveTextContent("标注2当前帧红色框选，画面左侧 10%");
    expect(screen.getByRole("button", { name: "回到 0:02.00 标注的画面" })).toBeInTheDocument();
    // 属于其它画面的标注照样可以引用：按钮只按帧时间区分它，不再禁用。
    expect(
      screen.getByRole("button", { name: "在编辑要求中引用 0:02.00 画面的标注1" }),
    ).toBeEnabled();
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "替换成花束");
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0]![0].timeSeconds).toBe(6);
    const exported = vi.mocked(exportVideoLocalEditFrame).mock.calls.at(-1)![1];
    expect(exported).toHaveLength(1);
    expect(exported[0]!.points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ]);
  });

  it("references a region of another time point by quoting its frame time instead of refusing it", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    loadVideo();
    seekToFrame(2);
    drawRegion(0.25, 0.25, 0.75, 0.75);
    await user.type(screen.getByRole("textbox"), "替换成花束");
    await user.click(screen.getByRole("button", { name: "在编辑要求中引用标注1" }));
    const chip = screen.getByRole("textbox").querySelector("[data-mark-id]");
    expect(chip).toHaveAttribute("data-display-name", "标注1");
    expect(chip?.className).not.toContain("is-off-frame");

    seekToFrame(6);
    // 换帧后该引用降级显示：它属于 0:02.00 的画面，本次提交的标注帧不画它。
    const offFrameChip = screen.getByRole("textbox").querySelector("[data-mark-id]");
    expect(offFrameChip?.className).toContain("is-off-frame");

    // 另一帧上的标注不再被禁用：它的描述里带上帧时间，提示词仍然指得清是哪一处。
    // 同一个标记可以被引用多次，每次都是独立的引用身份（这里刻意引用了两次）。
    drawRegion(0.1, 0.1, 0.4, 0.4);
    await user.click(screen.getByRole("button", { name: "在编辑要求中引用 0:02.00 画面的标注1" }));
    expect(
      screen.getByText("已把 标注1（0:02.00 的画面）的引用插入编辑要求。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "在编辑要求中引用标注2" }));
    await user.click(screen.getByRole("button", { name: "添加到生成节点" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const result = onApply.mock.calls[0]![0];
    // 引用都展开成正文：每一处都带自己的帧时间，因此换帧引用不会指错画面。
    expect(result.instructionDocument.items).toEqual([
      {
        kind: "text",
        text: "替换成花束标注1（视频 0:02.00 处：红色框选，画面左侧 25%、顶部 25% 至右侧 75%、底部 75%）标注1（视频 0:02.00 处：红色框选，画面左侧 25%、顶部 25% 至右侧 75%、底部 75%）标注2（视频 0:06.00 处：红色框选，画面左侧 10%、顶部 10% 至右侧 40%、底部 40%）",
      },
    ]);
    // 导出帧只画当前画面；引用到的另一帧必须回报给调用方，让用户知道那一帧没有定位线。
    expect(result.offFrameReferenceTimes).toEqual(["0:02.00"]);
    expect(onApply.mock.calls[0]![0].timeSeconds).toBe(6);
  });

  it("commits a drag released outside the frame instead of blocking every later mark", () => {
    renderDialog();
    loadVideo();
    drawRectangle();
    // 第二次拖拽的 pointerup 不落在 <svg> 上：真实 WebView 里指针捕获可能失效，
    // 只靠元素上的 pointerup 会让画布永久卡在「正在拖拽」状态。
    pointer("pointerdown", 40, 110);
    fireEvent(document.body, pointerEvent("pointerup", 160, 177.5));
    expect(screen.getByRole("img", { name: /已有 2 处标记/ })).toBeInTheDocument();
    drawRectangle();
    expect(screen.getByRole("img", { name: /已有 3 处标记/ })).toBeInTheDocument();
  });

  it("traps keyboard focus, isolates canvas shortcuts, and resets marks when the video identity changes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const shortcut = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(
      <div onKeyDown={shortcut}>
        <VideoLocalEditDialog
          source={source}
          candidates={[]}
          canUploadToLibrary={false}
          resolveFrame={vi.fn()}
          onClose={onClose}
          onApply={onApply}
        />
      </div>,
    );
    expect(screen.getByRole("button", { name: "关闭局部编辑" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭局部编辑" })).toHaveFocus();
    loadVideo();
    drawRectangle();
    rerender(
      <div onKeyDown={shortcut}>
        <VideoLocalEditDialog
          source={{ ...source, key: "different-source" }}
          candidates={[]}
          canUploadToLibrary={false}
          resolveFrame={vi.fn()}
          onClose={onClose}
          onApply={onApply}
        />
      </div>,
    );
    expect(screen.getByRole("img", { name: /已有 0 处标记/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(shortcut).not.toHaveBeenCalled();
  });
});
