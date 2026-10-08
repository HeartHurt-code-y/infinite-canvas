import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComponentsModule from "../../lib/runtimeComponents";
import type { RuntimeComponentManagerStatus } from "../../lib/runtimeComponents";
import { RuntimeComponentsPanel } from "./RuntimeComponentsPanel";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  status: vi.fn(),
  feature: vi.fn(),
  install: vi.fn(),
  importArchive: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  changed: vi.fn(),
}));
vi.mock("../../lib/backend", () => ({
  isDesktopRuntime: mocks.desktop,
  formatRawBackendError: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason),
}));
vi.mock("../../lib/runtimeComponents", async (importOriginal) => ({
  ...(await importOriginal<typeof ComponentsModule>()),
  runtimeComponentsClient: {
    status: mocks.status,
    featureStatus: mocks.feature,
    install: mocks.install,
    importArchive: mocks.importArchive,
    cancel: mocks.cancel,
  },
  publishRuntimeComponentsChanged: mocks.changed,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

const initial: RuntimeComponentManagerStatus = {
  edition: "online",
  catalogReady: true,
  catalogError: null,
  components: [
    {
      id: "blender",
      title: "Blender 白模引擎",
      description: "本地白模渲染与工程精修",
      version: "4.5",
      state: "not_installed",
      rootPath: null,
      installedBytes: 900 * 1024 * 1024,
      downloadBytes: 300 * 1024 * 1024,
      dependencies: ["ffmpeg"],
      error: null,
    },
  ],
  transfer: {
    active: false,
    componentId: null,
    phase: "idle",
    completedBytes: 0,
    totalBytes: 0,
    reusedBytes: 0,
    downloadedBytes: 0,
    error: null,
  },
};
let current: RuntimeComponentManagerStatus;
function row() {
  return within(screen.getByRole("heading", { name: "Blender 白模引擎" }).closest("li")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  current = structuredClone(initial);
  mocks.desktop.mockReturnValue(true);
  mocks.status.mockImplementation(() => Promise.resolve(current));
  mocks.feature.mockResolvedValue({
    id: "white-model-render",
    title: "白模渲染",
    ready: false,
    missingComponents: ["blender"],
    error: null,
  });
  mocks.open.mockResolvedValue("C:/Downloads/blender.zip");
  mocks.install.mockResolvedValue(undefined);
  mocks.importArchive.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
});

describe("RuntimeComponentsPanel", () => {
  it("shows initial sizes and dependencies and installs only after an explicit click", async () => {
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} initialFeatureId="white-model-render" />);
    expect(await screen.findByText("下载 300.0 MiB，安装后 900.0 MiB · 4.5")).toBeInTheDocument();
    expect(screen.getByText(/此功能需要/)).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
    mocks.install.mockImplementationOnce(() => {
      current = {
        ...current,
        components: [{ ...current.components[0]!, state: "ready" }],
        transfer: { ...current.transfer, componentId: "blender", phase: "ready" },
      };
      return Promise.resolve();
    });
    await user.click(row().getByRole("button", { name: "安装组件" }));
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith("blender", false);
    await waitFor(() => expect(mocks.changed).toHaveBeenCalled());
    expect(row().getByRole("button", { name: "修复组件" })).toBeEnabled();
  });

  it("allows cancellation while the install call is pending and offers continuation", async () => {
    const user = userEvent.setup();
    let finishInstall!: () => void;
    mocks.install.mockImplementationOnce(() => {
      current = {
        ...current,
        transfer: {
          ...current.transfer,
          componentId: "blender",
          active: true,
          phase: "downloading",
          totalBytes: 300,
          completedBytes: 100,
          downloadedBytes: 100,
        },
      };
      return new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
    });
    mocks.cancel.mockImplementationOnce(() => {
      current = {
        ...current,
        transfer: { ...current.transfer, active: false, phase: "cancelled" },
      };
      finishInstall();
      return Promise.resolve();
    });
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "安装组件" }));
    await user.click(await screen.findByRole("button", { name: "取消安装" }, { timeout: 2500 }));
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "继续安装" })).toBeEnabled();
    expect(mocks.changed).not.toHaveBeenCalled();
  });

  it("imports the selected ZIP and keeps download unavailable when the catalog is missing", async () => {
    current = { ...current, catalogReady: false, catalogError: "下载目录暂不可用，请导入离线包。" };
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    expect(await screen.findByText("下载目录暂不可用，请导入离线包。")).toBeInTheDocument();
    expect(row().getByRole("button", { name: "安装组件" })).toBeDisabled();
    await user.click(row().getByRole("button", { name: "导入离线 ZIP" }));
    expect(mocks.importArchive).toHaveBeenCalledExactlyOnceWith(
      "blender",
      "C:/Downloads/blender.zip",
    );
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        filters: [{ name: "组件安装包", extensions: ["zip"] }],
      }),
    );
  });

  it("retains an import error and closes without cancelling an active installation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mocks.importArchive.mockRejectedValueOnce(new Error("离线包签名与当前应用不匹配"));
    const view = render(<RuntimeComponentsPanel onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "导入离线 ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("离线包签名与当前应用不匹配");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("离线包签名与当前应用不匹配");
    await user.click(screen.getByRole("button", { name: "关闭组件管理" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("keeps browser previews independent of native component calls", () => {
    mocks.desktop.mockReturnValue(false);
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    expect(screen.getByText(/画布编辑与浏览器预览可继续使用/)).toBeInTheDocument();
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
