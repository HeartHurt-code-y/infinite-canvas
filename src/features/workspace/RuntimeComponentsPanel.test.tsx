import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComponentsModule from "../../lib/runtimeComponents";
import type * as BackendModule from "../../lib/backend";
import type * as ClipboardModule from "../../lib/clipboard";
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
  copy: vi.fn(),
}));
vi.mock("../../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof BackendModule>()),
  isDesktopRuntime: mocks.desktop,
}));
vi.mock("../../lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof ClipboardModule>()),
  copyErrorTextToClipboard: mocks.copy,
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
  mocks.copy.mockResolvedValue(undefined);
});

describe("RuntimeComponentsPanel", () => {
  it("waits for component validation before offering installation or repair", async () => {
    current = { ...current, components: [{ ...current.components[0]!, state: "checking" }] };
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "正在校验" })).toBeDisabled();
    expect(row().getByRole("status")).toHaveTextContent("正在校验");
    expect(row().getByRole("button", { name: "导入离线 ZIP" })).toBeDisabled();
    expect(row().queryByText("尚未安装")).not.toBeInTheDocument();
    current = { ...current, components: [{ ...current.components[0]!, state: "ready" }] };
    expect(await screen.findByRole("button", { name: "修复组件" })).toBeEnabled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

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

  it("explains unavailable installation and import when the trusted catalog is missing", async () => {
    current = { ...current, catalogReady: false, catalogError: "组件目录文件缺失" };
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    expect(await screen.findByText("组件目录文件缺失")).toBeInTheDocument();
    expect(row().getByRole("button", { name: "安装组件" })).toBeDisabled();
    expect(row().getByRole("button", { name: "导入离线 ZIP" })).toBeDisabled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("在线安装和离线导入均不可用");
    expect(alert).toHaveTextContent("重新安装");
    expect(row().getByRole("button", { name: "安装组件" })).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining(alert.id),
    );
    await user.click(screen.getByRole("button", { name: "复制完整报错" }));
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining(current.catalogError!));
    expect(mocks.importArchive).not.toHaveBeenCalled();
  });

  it("imports the selected ZIP when a trusted catalog is available", async () => {
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Blender 白模引擎" });
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

  it("shows a damaged component as an actionable summary and copies the full diagnostics", async () => {
    const diagnostic = "组件文件校验失败：models/depth/model.onnx 的 SHA-256 与当前版本不符。";
    current = {
      ...current,
      components: [{ ...current.components[0]!, state: "damaged", error: diagnostic }],
    };
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Blender 白模引擎" });
    const alert = row().getByRole("alert");
    expect(alert).toHaveTextContent(diagnostic);
    expect(alert).toHaveTextContent("修复组件");
    expect(row().getByRole("button", { name: "修复组件" })).toBeEnabled();
    expect(row().getByRole("button", { name: "修复组件" })).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining(alert.id),
    );
    await user.click(row().getByRole("button", { name: "复制完整报错" }));
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
    await user.click(row().getByRole("button", { name: "修复组件" }));
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith("blender", true);
  });

  it("retains structured action errors for readable summaries, expansion and full copying", async () => {
    const diagnostic = {
      kind: "validation",
      message: "离线包文件校验失败。",
      details: { path: "models/depth/model.onnx", reason: "SHA-256 mismatch" },
    };
    mocks.importArchive.mockRejectedValueOnce(diagnostic);
    const user = userEvent.setup();
    render(<RuntimeComponentsPanel onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "导入离线 ZIP" }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(diagnostic.message);
    expect(alert).not.toHaveTextContent("models/depth/model.onnx");
    await user.click(screen.getByRole("button", { name: "复制完整报错" }));
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(diagnostic, null, 2)),
    );
    await user.click(screen.getByText("展开完整报错"));
    expect(screen.getByText(/"path": "models\/depth\/model.onnx"/)).toBeVisible();
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
