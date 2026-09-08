import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoLocalEditDialog } from "./VideoLocalEditDialog";
import { exportVideoLocalEditFrame } from "./videoLocalEditDrawing";
import type * as VideoLocalEditDrawing from "./videoLocalEditDrawing";

const prepareSource = vi.hoisted(() => vi.fn());
vi.mock("../../lib/videoLocalEdit", () => ({ prepareVideoEditSource: prepareSource }));

vi.mock("./videoLocalEditDrawing", async (importOriginal) => {
  const original = await importOriginal<typeof VideoLocalEditDrawing>();
  return {
    ...original,
    exportVideoLocalEditFrame: vi.fn(() => "data:image/png;base64,annotated-frame"),
  };
});

const source = { key: "canvas-video-stable", label: "餐厅原视频", src: "blob:restaurant-source" };

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
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(overlay, event);
}

function drawRectangle() {
  pointer("pointerdown", 100, 143.75);
  pointer("pointerup", 300, 256.25);
}

beforeEach(() => {
  prepareSource.mockReset();
  vi.mocked(exportVideoLocalEditFrame)
    .mockReset()
    .mockReturnValue("data:image/png;base64,annotated-frame");
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
    const { unmount } = render(
      <VideoLocalEditDialog source={cloud} onClose={vi.fn()} onApply={vi.fn()} />,
    );
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
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<VideoLocalEditDialog source={source} onClose={vi.fn()} onApply={onApply} />);
    const submit = screen.getByRole("button", { name: "添加到生成节点" });
    expect(submit).toBeDisabled();
    const video = loadVideo();
    video.currentTime = 3.25;
    await user.type(screen.getByRole("textbox"), "消除圈出的路人，保留桌子");
    expect(submit).toBeDisabled();
    pointer("pointerdown", 30, 30);
    pointer("pointerup", 300, 250);
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
      instruction: "消除圈出的路人，保留桌子",
      operation: "remove",
      timeRange: null,
    });
    expect(exportVideoLocalEditFrame).toHaveBeenCalledWith(video, [
      {
        kind: "rectangle",
        color: "#ff4865",
        points: [
          { x: 0.25, y: 0.25 },
          { x: 0.75, y: 0.75 },
        ],
      },
    ]);
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
    const { unmount } = render(
      <VideoLocalEditDialog source={pendingSource} onClose={vi.fn()} onApply={vi.fn()} />,
    );
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
    const { rerender, unmount } = render(
      <VideoLocalEditDialog source={{ ...source, target }} onClose={vi.fn()} onApply={vi.fn()} />,
    );
    rerender(
      <VideoLocalEditDialog
        source={{ ...source, target: { ...target, assetId: "new" } }}
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
    render(
      <VideoLocalEditDialog
        source={{ ...source, src: "", target }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
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
    expect(screen.getByRole("textbox")).toHaveValue("保留左边人物");
  });

  it("supports colored freehand strokes, undo, and clearing without changing instructions", async () => {
    const user = userEvent.setup();
    render(<VideoLocalEditDialog source={source} onClose={vi.fn()} onApply={vi.fn()} />);
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
    expect(screen.getByRole("textbox")).toHaveValue("替换圈出的杯子");
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  });

  it("clears marks on seeking and prevents annotation until the selected frame has decoded", () => {
    render(<VideoLocalEditDialog source={source} onClose={vi.fn()} onApply={vi.fn()} />);
    const video = loadVideo();
    drawRectangle();
    fireEvent.change(screen.getByRole("slider", { name: "视频时间" }), { target: { value: "5" } });
    expect(video.currentTime).toBe(5);
    expect(screen.getByRole("img", { name: /已有 0 处标记/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "框选" })).toBeDisabled();
    fireEvent.seeked(video);
    expect(screen.getByRole("button", { name: "框选" })).toBeEnabled();
  });

  it("supports keyboard coordinate regions and a validated edit interval independent of the locator frame", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<VideoLocalEditDialog source={source} onClose={vi.fn()} onApply={onApply} />);
    const video = loadVideo();
    video.currentTime = 2;
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
    const onApply = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const onClose = vi.fn();
    render(<VideoLocalEditDialog source={source} onClose={onClose} onApply={onApply} />);
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
    expect(screen.getByRole("textbox")).toHaveValue("消除右侧路人");
    expect(screen.getByRole("img", { name: /已有 1 处标记/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加到生成节点" })).toBeEnabled();
  });

  it("shows load and capture failures and does not submit a blank frame", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<VideoLocalEditDialog source={source} onClose={vi.fn()} onApply={onApply} />);
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

  it("traps keyboard focus, isolates canvas shortcuts, and resets marks when the video identity changes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const shortcut = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(
      <div onKeyDown={shortcut}>
        <VideoLocalEditDialog source={source} onClose={onClose} onApply={onApply} />
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
