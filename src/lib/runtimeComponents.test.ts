// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureRuntimeFeatureInstalled,
  requestRuntimeComponents,
  runtimeComponentsClient,
  RUNTIME_COMPONENTS_REQUEST_EVENT,
} from "./runtimeComponents";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./backend", () => ({ isDesktopRuntime: mocks.desktop }));

describe("runtime component IPC and feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.desktop.mockReturnValue(true);
  });

  it("opens the missing feature without installing or submitting anything", async () => {
    const event = vi.fn();
    window.addEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    try {
      mocks.invoke.mockResolvedValue({
        id: "white-model-render",
        title: "白模渲染",
        ready: false,
        missingComponents: ["blender", "ffmpeg"],
        error: null,
      });
      expect(await ensureRuntimeFeatureInstalled("white-model-render")).toBe(false);
      expect(event).toHaveBeenCalledOnce();
      expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        featureId: "white-model-render",
      });
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("get_runtime_feature_status", {
        featureId: "white-model-render",
      });
    } finally {
      window.removeEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    }
  });

  it("allows an already ready feature and preserves browser previews without native calls", async () => {
    mocks.invoke.mockResolvedValue({
      id: "motion-capture",
      title: "动作捕捉",
      ready: true,
      missingComponents: [],
      error: null,
    });
    expect(await ensureRuntimeFeatureInstalled("motion-capture")).toBe(true);
    mocks.invoke.mockClear();
    mocks.desktop.mockReturnValue(false);
    expect(await ensureRuntimeFeatureInstalled("white-model-render")).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await expect(runtimeComponentsClient.status()).rejects.toThrow("桌面应用");
  });

  it("rejects malformed status and unknown component identities", async () => {
    mocks.invoke.mockResolvedValue({
      edition: "online",
      components: [],
      transfer: { active: true },
    });
    await expect(runtimeComponentsClient.status()).rejects.toThrow();
    mocks.invoke.mockClear();
    expect(() => runtimeComponentsClient.install("unknown" as "blender")).toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("never accepts readiness for a different feature", async () => {
    mocks.invoke.mockResolvedValue({
      id: "animation-render",
      title: "动画",
      ready: true,
      missingComponents: [],
      error: null,
    });
    await expect(runtimeComponentsClient.featureStatus("white-model-render")).rejects.toThrow(
      "不一致",
    );
  });

  it("keeps repair and ZIP imports explicit and passes exact native argument names", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await runtimeComponentsClient.install("blender", true);
    await runtimeComponentsClient.importArchive("blender", "C:/Downloads/blender.zip");
    await runtimeComponentsClient.cancel();
    expect(mocks.invoke.mock.calls).toEqual([
      ["install_runtime_component", { componentId: "blender", repair: true }],
      [
        "import_runtime_component_archive",
        { componentId: "blender", path: "C:/Downloads/blender.zip" },
      ],
      ["cancel_runtime_component_install", undefined],
    ]);
  });

  it("uses a featureId in the public UI event", () => {
    const event = vi.fn();
    window.addEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    requestRuntimeComponents("ai-media-lite");
    window.removeEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({ featureId: "ai-media-lite" });
  });
});
