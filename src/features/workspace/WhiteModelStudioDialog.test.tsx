import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WhiteModelStudioModule from "../../lib/whiteModelStudio";
import {
  createWhiteModelStudioDraft,
  whiteModelRenderSignature,
  type BlenderRenderJob,
  type WhiteModelStudioDraft,
} from "../../lib/whiteModelStudio";
import { WhiteModelStudioDialog } from "./WhiteModelStudioDialog";

const mocks = vi.hoisted(() => ({
  engine: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  openProject: vi.fn(),
  chooseFile: vi.fn(),
}));
vi.mock("../../lib/whiteModelStudio", async (importOriginal) => ({
  ...(await importOriginal<typeof WhiteModelStudioModule>()),
  getBlenderEngine: mocks.engine,
  startBlenderRender: mocks.start,
  getBlenderRender: mocks.get,
  cancelBlenderRender: mocks.cancel,
  openBlenderProject: mocks.openProject,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.chooseFile }));

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

function harness(initial: WhiteModelStudioDraft) {
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
      />
    );
  }
  return { ...render(<Host />), onClose, onUse, saved: () => saved };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engine.mockResolvedValue({
    available: true,
    executablePath: "C:/Blender/blender.exe",
    version: "Blender 4.5",
    message: "Blender 已就绪",
  });
  mocks.start.mockResolvedValue(job("queued"));
  mocks.get.mockResolvedValue(job("running"));
  mocks.cancel.mockResolvedValue(job("cancelled"));
  mocks.openProject.mockResolvedValue(undefined);
  mocks.chooseFile.mockResolvedValue(null);
});

describe("白模工作室", () => {
  it("保存真实角色与相机设置，关闭继续渲染，恢复使用成片并将精修工程作为下次渲染源", async () => {
    const view = harness(createWhiteModelStudioDraft());
    const renderButton = screen.getByRole("button", { name: "渲染白模视频" });
    await waitFor(() => expect(renderButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText("几何体 1"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("角色 1 终点 X"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("角色 1 终点朝向（度）"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("相机运动"), { target: { value: "orbit" } });
    fireEvent.change(screen.getByLabelText("环绕角度"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("片长（秒）"), { target: { value: "0" } });
    expect(view.saved().plan.durationSeconds).toBe(8);
    fireEvent.change(screen.getByLabelText("片长（秒）"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("画幅"), { target: { value: "540:960" } });
    fireEvent.click(renderButton);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({
      sourceBlendPath: null,
      plan: {
        durationSeconds: 12,
        width: 540,
        height: 960,
        camera: { motion: "orbit", orbitDegrees: 180 },
        objects: [
          {
            shape: "box",
            keyframes: [{ time: 0 }, { time: 12, position: [4, 0, 0], yaw: 90 }],
          },
        ],
      },
    });
    await waitFor(() => expect(view.saved().jobId).toBe("render-1"));
    expect(view.saved().jobInputSignature).toBe(whiteModelRenderSignature(view.saved()));
    expect(screen.getByLabelText("角色 1 终点 X")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭工作室" }));
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
    fireEvent.change(screen.getByLabelText("角色 1 终点 X"), { target: { value: "5" } });
    expect(use).toBeDisabled();
    expect(
      screen.getByText("设置已修改，当前预览属于上次渲染。请重新渲染后使用视频。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在 Blender 中精修工程" }));
    await waitFor(() =>
      expect(mocks.openProject).toHaveBeenCalledWith(null, "C:/renders/render-1/scene.blend"),
    );
    fireEvent.click(screen.getByRole("button", { name: "将此工程设为下次渲染源" }));
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
      plan: { durationSeconds: 12, width: 540, height: 960 },
    });
    await waitFor(() => expect(use).toBeEnabled());
    expect(restored.saved().jobId).toBe("render-2");
    fireEvent.click(use);
    await waitFor(() =>
      expect(restored.onUse).toHaveBeenLastCalledWith(job("succeeded", "render-2")),
    );
  });

  it("恢复中可取消，迟到的运行状态不覆盖取消结果，保留草稿可重试", async () => {
    const draft = createWhiteModelStudioDraft();
    draft.jobId = "render-1";
    draft.jobInputSignature = whiteModelRenderSignature(draft);
    let resolvePoll: (value: BlenderRenderJob) => void = () => {};
    mocks.get.mockReturnValue(
      new Promise<BlenderRenderJob>((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const view = harness(draft);
    expect(screen.getByLabelText("角色名称 1")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消渲染" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("render-1"));
    expect(await screen.findByText("渲染已取消，可以调整设置后重新渲染。")).toBeInTheDocument();
    await act(async () => {
      resolvePoll(job("running"));
      await Promise.resolve();
    });
    expect(screen.getByText("渲染已取消，可以调整设置后重新渲染。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新渲染白模" })).toBeEnabled();
    expect(screen.getByLabelText("角色名称 1")).toBeEnabled();
    expect(view.saved().jobId).toBe("render-1");
    expect(screen.getByRole("button", { name: "使用白模视频" })).toBeDisabled();
  });

  it("选择 Blender 与导入工程使用文件路径，不可用引擎明确阻止渲染", async () => {
    mocks.engine.mockResolvedValueOnce({
      available: false,
      executablePath: null,
      version: null,
      message: "未检测到 Blender，请选择已安装的程序。",
    });
    const view = harness(createWhiteModelStudioDraft());
    expect(await screen.findByText("未检测到 Blender，请选择已安装的程序。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "渲染白模视频" })).toBeDisabled();
    mocks.chooseFile.mockResolvedValueOnce("D:/Tools/Blender/blender.exe");
    fireEvent.click(screen.getByRole("button", { name: "选择 Blender" }));
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
