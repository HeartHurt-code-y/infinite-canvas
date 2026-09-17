import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WhiteModelStudioModule from "../../lib/whiteModelStudio";
import {
  createWhiteModelStudioDraft,
  whiteModelRenderSignature,
  type BlenderRenderJob,
  type BlenderRenderRequest,
  type WhiteModelStudioDraft,
} from "../../lib/whiteModelStudio";
import { createWhiteModelBlockingDraft } from "../../lib/whiteModelBlocking";
import { WhiteModelStudioDialog, type WhiteModelStudioDialogProps } from "./WhiteModelStudioDialog";

const mocks = vi.hoisted(() => ({
  engine: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  openProject: vi.fn(),
  chooseFile: vi.fn(),
  poseAvailable: vi.fn(),
  captureMotion: vi.fn(),
  saveStill: vi.fn(),
}));
vi.mock("../../lib/whiteModelStudio", async (importOriginal) => ({
  ...(await importOriginal<typeof WhiteModelStudioModule>()),
  getBlenderEngine: mocks.engine,
  startBlenderRender: mocks.start,
  getBlenderRender: mocks.get,
  cancelBlenderRender: mocks.cancel,
  openBlenderProject: mocks.openProject,
}));
vi.mock("../../lib/whiteModelBlocking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/whiteModelBlocking")>();
  return { ...actual, saveWhiteModelStill: mocks.saveStill };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.chooseFile }));
vi.mock("../../lib/poseCapture", () => ({
  poseCaptureAvailable: mocks.poseAvailable,
  captureMotionFromVideo: mocks.captureMotion,
}));
vi.mock("./WhiteModelViewport", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    WhiteModelViewport: forwardRef((_props: unknown, ref) => {
      useImperativeHandle(ref, () => ({
        captureStill: () => "data:image/png;base64,iVBORw0KGgo=",
      }));
      return <div data-testid="white-model-viewport" />;
    }),
  };
});

function job(status: BlenderRenderJob["status"], jobId = "render-1"): BlenderRenderJob {
  return {
    jobId,
    status,
    progress: status === "succeeded" ? 100 : 30,
    message: status === "succeeded" ? "白模视频已完成" : "正在渲染白模",
    error: null,
    videoPath: status === "succeeded" ? `C:/renders/${jobId}/output.mp4` : null,
    previewPath: status === "succeeded" ? `C:/renders/${jobId}/preview.png` : null,
    projectPath: status === "succeeded" ? `C:/renders/${jobId}/scene.blend` : null,
    width: 960,
    height: 540,
    durationSeconds: 8,
    createdAt: 1,
    updatedAt: 2,
  };
}

function harness(
  initial: WhiteModelStudioDraft,
  extras: Partial<WhiteModelStudioDialogProps> = {},
) {
  let saved = initial;
  const onClose = vi.fn();
  const onUse = vi.fn();
  function Host() {
    const [draft, setDraft] = useState(initial);
    return (
      <WhiteModelStudioDialog
        draft={draft}
        onDraftChange={(next) => {
          saved = structuredClone(next);
          setDraft(next);
        }}
        onClose={onClose}
        onUse={onUse}
        {...extras}
      />
    );
  }
  return { ...render(<Host />), onClose, onUse, saved: () => saved };
}

function openEnginePanel() {
  fireEvent.click(screen.getByText("场景来源与渲染引擎"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engine.mockResolvedValue({
    available: true,
    executablePath: "C:/InfiniteCanvas/resources/blender/blender.exe",
    version: "Blender 4.5",
    message: "内置 Blender 已就绪",
  });
  mocks.start.mockResolvedValue(job("queued"));
  mocks.get.mockResolvedValue(job("running"));
  mocks.cancel.mockResolvedValue(job("cancelled"));
  mocks.openProject.mockResolvedValue(undefined);
  mocks.chooseFile.mockResolvedValue(null);
  mocks.poseAvailable.mockResolvedValue(true);
  mocks.captureMotion.mockResolvedValue({
    fps: 24,
    frameCount: 24,
    joints: "AAAA",
    sourceName: "walk.mp4",
  });
  mocks.saveStill.mockResolvedValue({
    path: "C:/white-model-stills/still-1.png",
    width: 1280,
    height: 720,
  });
});

describe("白模导演台", () => {
  it("默认机位视角与镜头语言，保存走位后渲染并可恢复成片与精修工程", async () => {
    const view = harness(createWhiteModelStudioDraft());
    const renderButton = screen.getByRole("button", { name: "渲染白模视频" });
    await waitFor(() => expect(renderButton).toBeEnabled());
    expect(mocks.engine).toHaveBeenCalledWith("");
    expect(screen.getByText(/应用已内置 Blender，无需另行安装或下载/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "机位视角" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "导演视角" })).toBeInTheDocument();
    expect(screen.getByTestId("white-model-viewport")).toBeInTheDocument();
    expect(screen.getByLabelText("时间轴")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按景别取景（写入当前时间的机位关键帧）" })).toBeEnabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "一键动捕：从视频提取动作…" })).toBeEnabled(),
    );
    expect(screen.queryByRole("textbox", { name: "外部 Blender 路径" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择外部 Blender" })).not.toBeInTheDocument();
    expect(mocks.chooseFile).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("几何体"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("路径点 2 X"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "左环绕" }));
    fireEvent.change(screen.getByLabelText("片长（秒）"), { target: { value: "0" } });
    expect(view.saved().plan.durationSeconds).toBe(8);
    fireEvent.change(screen.getByLabelText("片长（秒）"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("画幅"), { target: { value: "540:960" } });
    const startButton = screen.getByRole("button", { name: "渲染白模视频" });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    const request = mocks.start.mock.calls[0]![0] as BlenderRenderRequest;
    expect(request).toMatchObject({
      executablePath: null,
      sourceBlendPath: null,
      plan: {
        durationSeconds: 12,
        width: 540,
        height: 960,
        objects: [
          {
            shape: "box",
            keyframes: [{ time: 0 }, { time: 12, position: [4, 0, 0] }],
          },
        ],
      },
    });
    expect(request.plan.camera.keyframes.length).toBeGreaterThan(1);
    expect(request.bake?.frameCount).toBe(12 * 24);
    await waitFor(() => expect(view.saved().jobId).toBe("render-1"));
    expect(view.saved().jobInputSignature).toBe(whiteModelRenderSignature(view.saved()));
    expect(screen.getByLabelText("路径点 2 X")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭导演台" }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    const persisted = structuredClone(view.saved());
    view.unmount();

    mocks.get.mockResolvedValue(job("succeeded"));
    const restored = harness(persisted);
    const use = screen.getByRole("button", { name: "使用白模视频" });
    await waitFor(() => expect(use).toBeEnabled());
    expect(mocks.get).toHaveBeenCalledWith("render-1");
    expect(screen.getByLabelText("白模视频预览")).toHaveAttribute(
      "src",
      "C:/renders/render-1/output.mp4",
    );
    fireEvent.click(use);
    await waitFor(() => expect(restored.onUse).toHaveBeenCalledWith(job("succeeded")));
    await waitFor(() => expect(use).toBeEnabled());
    fireEvent.change(screen.getByLabelText("路径点 2 X"), { target: { value: "5" } });
    expect(use).toBeDisabled();
    expect(
      screen.getByText("设置已修改，当前预览属于上次渲染。请重新渲染后使用视频。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在 Blender 中精修工程" }));
    await waitFor(() =>
      expect(mocks.openProject).toHaveBeenCalledWith(null, "C:/renders/render-1/scene.blend"),
    );
    fireEvent.click(screen.getByRole("button", { name: "将此工程设为下次渲染源" }));
    openEnginePanel();
    expect(screen.getByLabelText("场景来源")).toHaveValue("blend");
    expect(screen.getByLabelText("Blender 工程文件")).toHaveValue(
      "C:/renders/render-1/scene.blend",
    );
    expect(use).toBeDisabled();
    mocks.start.mockResolvedValue(job("queued", "render-2"));
    mocks.get.mockResolvedValue(job("succeeded", "render-2"));
    fireEvent.click(screen.getByRole("button", { name: "重新渲染白模" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.start.mock.calls[1]![0]).toMatchObject({
      sourceBlendPath: "C:/renders/render-1/scene.blend",
      bake: null,
      plan: { durationSeconds: 12, width: 540, height: 960 },
    });
    await waitFor(() => expect(use).toBeEnabled());
    expect(restored.saved().jobId).toBe("render-2");
    fireEvent.click(use);
    await waitFor(() =>
      expect(restored.onUse).toHaveBeenLastCalledWith(job("succeeded", "render-2")),
    );
  });

  it("一键动捕把参考视频编码为角色动作片段", async () => {
    const view = harness(createWhiteModelStudioDraft());
    mocks.chooseFile.mockResolvedValueOnce("C:/takes/walk.mp4");
    const captureButton = await screen.findByRole("button", { name: "一键动捕：从视频提取动作…" });
    await waitFor(() => expect(captureButton).toBeEnabled());
    fireEvent.click(captureButton);
    await waitFor(() => expect(mocks.captureMotion).toHaveBeenCalledTimes(1));
    expect(mocks.captureMotion.mock.calls[0]![0]).toContain("walk.mp4");
    await waitFor(() => expect(view.saved().plan.objects[0]?.motion.kind).toBe("clip"));
    expect(view.saved().plan.objects[0]?.motion).toMatchObject({
      kind: "clip",
      startTime: 0,
      loop: true,
      speed: 1,
      clip: { sourceName: "walk.mp4", frameCount: 24 },
    });
    expect(screen.getByText(/已从「walk.mp4」提取 24 帧动作/)).toBeInTheDocument();
    expect(screen.getByLabelText("动作来源")).toHaveValue("clip");
  });

  it("恢复中可取消，迟到的运行状态不覆盖取消结果，保留草稿可重试", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.executablePath = "D:/Tools/Blender/blender.exe";
    draft.jobId = "render-1";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    let resolvePoll: (value: BlenderRenderJob) => void = () => {};
    mocks.get.mockReturnValue(
      new Promise<BlenderRenderJob>((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const view = harness(draft);
    openEnginePanel();
    expect(screen.getByRole("textbox", { name: "外部 Blender 路径" })).toHaveValue(
      "D:/Tools/Blender/blender.exe",
    );
    expect(screen.getByLabelText("角色名称")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消渲染" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("render-1"));
    expect(await screen.findByText("渲染已取消，可以调整设置后重新渲染。")).toBeInTheDocument();
    await act(async () => {
      resolvePoll(job("running"));
      await Promise.resolve();
    });
    expect(screen.getByText("渲染已取消，可以调整设置后重新渲染。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新渲染白模" })).toBeEnabled();
    expect(screen.getByLabelText("角色名称")).toBeEnabled();
    expect(view.saved().jobId).toBe("render-1");
    expect(screen.getByRole("button", { name: "使用白模视频" })).toBeDisabled();
  });

  it("内置引擎异常引导修复应用，高级设置可选外部程序并保留工程导入与重试", async () => {
    mocks.engine.mockResolvedValueOnce({
      available: false,
      executablePath: null,
      version: null,
      message: "安装包内置 Blender 不完整，请修复安装包或重新安装应用。",
    });
    const view = harness(createWhiteModelStudioDraft());
    expect(
      await screen.findByText("安装包内置 Blender 不完整，请修复安装包或重新安装应用。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "渲染白模视频" })).toBeDisabled();
    openEnginePanel();
    fireEvent.click(screen.getByText("高级设置：使用外部 Blender（可选）"));
    mocks.chooseFile.mockResolvedValueOnce("D:/Tools/Blender/blender.exe");
    fireEvent.click(await screen.findByRole("button", { name: "选择外部 Blender" }));
    await waitFor(() => expect(mocks.engine).toHaveBeenCalledWith("D:/Tools/Blender/blender.exe"));
    mocks.chooseFile.mockResolvedValueOnce("D:/Projects/精修镜头.blend");
    fireEvent.click(screen.getByRole("button", { name: "导入已有 .blend 工程" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Blender 工程文件")).toHaveValue("D:/Projects/精修镜头.blend"),
    );
    expect(view.saved()).toMatchObject({
      executablePath: "D:/Tools/Blender/blender.exe",
      mode: "blend",
      sourceBlendPath: "D:/Projects/精修镜头.blend",
    });
    mocks.start.mockRejectedValueOnce({
      code: "invalid_scene",
      message: "工程未设置活动相机，请在 Blender 中指定相机。",
      details: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "渲染白模视频" }));
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          executablePath: "D:/Tools/Blender/blender.exe",
          sourceBlendPath: "D:/Projects/精修镜头.blend",
        }),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "工程未设置活动相机，请在 Blender 中指定相机。",
    );
    expect(view.saved().sourceBlendPath).toBe("D:/Projects/精修镜头.blend");
    expect(screen.getByRole("button", { name: "渲染白模视频" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "渲染白模视频" }));
    await waitFor(() => expect(view.saved().jobId).toBe("render-1"));
  });
});

describe("白模导演台 · 站位", () => {
  it("跳过 Blender，摆假人、换场景并导出站位图", async () => {
    const scene = {
      key: "scene",
      name: "宗门全景",
      kind: "image" as const,
      target: {
        kind: "local_file" as const,
        path: "C:/scene.png",
        canvasNodeKey: "scene",
        mediaType: "image" as const,
      },
      src: "asset://scene",
    };
    const hero = {
      key: "hero",
      name: "男主",
      kind: "image" as const,
      target: {
        kind: "local_file" as const,
        path: "C:/hero.png",
        canvasNodeKey: "hero",
        mediaType: "image" as const,
      },
      src: "asset://hero",
    };
    const onExportBlocking = vi.fn();
    const view = harness(
      { ...createWhiteModelBlockingDraft(), environment: { key: scene.key, name: scene.name, target: scene.target } },
      { purpose: "blocking", imageInputs: [scene, hero], onExportBlocking },
    );
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "＋ 假人" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "渲染白模视频" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("时间轴")).not.toBeInTheDocument();
    expect(screen.getByLabelText("全景图 / 场景图")).toHaveValue(JSON.stringify([scene.key, scene.target]));
    fireEvent.click(screen.getByRole("button", { name: "↑ 替换" }));
    await waitFor(() => expect(view.saved().environment?.key).toBe("hero"));
    fireEvent.change(screen.getByLabelText("1号假人角色参考"), { target: { value: JSON.stringify([hero.key, hero.target]) } });
    await waitFor(() =>
      expect(view.saved().characterBindings).toEqual([
        { actorId: view.saved().plan.objects[0]?.id, reference: { key: hero.key, name: hero.name, target: hero.target } },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "导出站位图" }));
    await waitFor(() => expect(mocks.saveStill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onExportBlocking).toHaveBeenCalledTimes(1));
    expect(onExportBlocking.mock.calls[0]![0]).toMatchObject({
      path: "C:/white-model-stills/still-1.png",
      width: 1280,
      height: 720,
      environment: { key: "hero" },
      assignments: [{ dummyNumber: 1, character: { key: "hero", name: "男主" } }],
    });
    expect(view.saved().blockingImagePath).toBe("C:/white-model-stills/still-1.png");
  });
});
