import { posix, win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportArtifactDeliveryToDesktop, type ArtifactDeliveryOutput } from "./artifactDelivery";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  open: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
  writeTextFile: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  resolve: vi.fn(),
  join: vi.fn(),
  dirname: vi.fn(),
  basename: vi.fn(),
  isAbsolute: vi.fn(),
}));
vi.mock("../../lib/backend", () => ({ isDesktopRuntime: mocks.desktop }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  copyFile: mocks.copyFile,
  mkdir: mocks.mkdir,
  exists: mocks.exists,
  stat: mocks.stat,
  writeTextFile: mocks.writeTextFile,
  rename: mocks.rename,
  remove: mocks.remove,
}));
vi.mock("@tauri-apps/api/path", () => ({
  resolve: mocks.resolve,
  join: mocks.join,
  dirname: mocks.dirname,
  basename: mocks.basename,
  isAbsolute: mocks.isAbsolute,
}));

const output: ArtifactDeliveryOutput = {
  key: "node-output-1",
  taskId: "generation-id-1",
  resultKey: "generation-id-1#0",
  sourceNodeId: "generation-node",
  origin: "generation",
  mediaType: "video",
  finalPath: "/sources/original.MP4",
  name: "E001_SH012",
};
const copied = { isFile: true, size: 42, mtime: new Date("2026-09-30T10:00:00Z") };

function setPaths(paths: typeof posix) {
  mocks.resolve.mockImplementation((...segments: string[]) =>
    Promise.resolve(paths.resolve(...segments)),
  );
  mocks.join.mockImplementation((...segments: string[]) =>
    Promise.resolve(paths.join(...segments)),
  );
  mocks.dirname.mockImplementation((value: string) => Promise.resolve(paths.dirname(value)));
  mocks.basename.mockImplementation((value: string) => Promise.resolve(paths.basename(value)));
  mocks.isAbsolute.mockImplementation((value: string) => Promise.resolve(paths.isAbsolute(value)));
}

function manifest() {
  const entry = mocks.writeTextFile.mock.calls.find(
    ([path]) => typeof path === "string" && path.endsWith("manifest.json"),
  );
  return JSON.parse(entry?.[1] as string) as {
    deliveryId: string;
    entries: {
      key: string;
      taskId: string;
      resultKey: string | null;
      finalPath: string;
      name: string;
      deliveryName: string;
    }[];
  };
}

describe("exportArtifactDeliveryToDesktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.desktop.mockReturnValue(true);
    mocks.open.mockResolvedValue("/exports");
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(false);
    mocks.stat.mockResolvedValue(copied);
    mocks.writeTextFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    setPaths(posix);
  });

  it("copies real extensions with deterministic case-insensitive suffixes and exact stable identities", async () => {
    const outputs = [
      output,
      {
        ...output,
        key: "node-output-2",
        taskId: "generation-id-2",
        resultKey: "generation-id-2#7",
        name: "e001_sh012.mp4",
      },
      {
        ...output,
        key: "node-output-3",
        name: "E001_SH012",
        finalPath: "/sources/audio.WAV",
        mediaType: "audio" as const,
      },
    ];
    const directory = await exportArtifactDeliveryToDesktop(outputs);
    expect(directory).toMatch(/^\/exports\/无限画布交付-[\da-f-]+$/);
    expect(mocks.mkdir).toHaveBeenCalledWith(
      `${posix.dirname(directory!)}/.${posix.basename(directory!)}.partial`,
      { recursive: false },
    );
    expect(mocks.copyFile.mock.calls.map(([, to]) => posix.basename(to as string))).toEqual([
      "E001_SH012.MP4",
      "e001_sh012-02.MP4",
      "E001_SH012.WAV",
    ]);
    expect(manifest().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "node-output-2",
          taskId: "generation-id-2",
          resultKey: "generation-id-2#7",
          finalPath: output.finalPath,
          name: "e001_sh012.mp4",
          deliveryName: "e001_sh012-02.MP4",
        }),
      ]),
    );
    expect(mocks.rename).toHaveBeenCalledWith(expect.stringMatching(/\.partial$/), directory);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(
      mocks.writeTextFile.mock.calls.find(([path]) => String(path).endsWith("delivery.csv"))?.[1],
    ).toContain('"generation-id-2","generation-id-2#7"');
  });

  it("changes only the delivery label when a node name changes", async () => {
    await exportArtifactDeliveryToDesktop([{ ...output, name: "另一个名称" }]);
    expect(manifest().entries[0]).toMatchObject({
      taskId: output.taskId,
      resultKey: output.resultKey,
      finalPath: output.finalPath,
      deliveryName: "另一个名称.MP4",
    });
    expect(mocks.copyFile.mock.calls[0]?.[0]).toBe(output.finalPath);
  });

  it("returns cancellation without reading or mutating any files", async () => {
    mocks.open.mockResolvedValue(null);
    expect(await exportArtifactDeliveryToDesktop([output])).toBeNull();
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("throws on copy failure and removes only the verified new directory on Windows", async () => {
    setPaths(win32);
    mocks.open.mockResolvedValue("C:\\exports");
    mocks.copyFile.mockRejectedValue(new Error("disk full"));
    await expect(
      exportArtifactDeliveryToDesktop([{ ...output, finalPath: "D:\\sources\\original.MP4" }]),
    ).rejects.toThrow("disk full");
    const staging = mocks.mkdir.mock.calls[0]?.[0] as string;
    expect(win32.dirname(staging)).toBe("C:\\exports");
    expect(win32.basename(staging)).toMatch(/^\.无限画布交付-[\da-f-]+\.partial$/);
    expect(mocks.remove).toHaveBeenCalledWith(staging, { recursive: true });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("does not clean up an existing directory when mkdir fails", async () => {
    mocks.mkdir.mockRejectedValue(new Error("Already exists"));
    await expect(exportArtifactDeliveryToDesktop([output])).rejects.toThrow("Already exists");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("checks files before creation and rejects missing, empty or changed sources", async () => {
    mocks.stat.mockResolvedValue({ ...copied, size: 0 });
    await expect(exportArtifactDeliveryToDesktop([output])).rejects.toThrow("为空");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    mocks.stat
      .mockResolvedValueOnce(copied)
      .mockResolvedValueOnce({ ...copied, size: 43 })
      .mockResolvedValueOnce(copied);
    await expect(exportArtifactDeliveryToDesktop([output])).rejects.toThrow("发生变化");
    expect(mocks.remove).toHaveBeenCalledWith(expect.stringMatching(/\.partial$/), {
      recursive: true,
    });
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("sanitizes file labels, reserves manifest names and quotes CSV values", async () => {
    await exportArtifactDeliveryToDesktop([
      { ...output, finalPath: "/sources/data.json", name: "manifest.json" },
      { ...output, key: "n2", name: '=镜头,"对白"\n后半段' },
    ]);
    expect(manifest().entries[0]?.deliveryName).toBe("manifest-02.json");
    const csv = mocks.writeTextFile.mock.calls.find(([path]) =>
      String(path).endsWith("delivery.csv"),
    )?.[1] as string;
    expect(csv).toContain('"\'=镜头,""对白""\n后半段"');
    expect(manifest().entries[1]?.name).toBe('=镜头,"对白"\n后半段');
  });

  it("requires desktop and refuses an unsafe staging directory without cleanup", async () => {
    mocks.desktop.mockReturnValue(false);
    await expect(exportArtifactDeliveryToDesktop([output])).rejects.toThrow("桌面应用");
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.desktop.mockReturnValue(true);
    mocks.join.mockImplementation((...paths: string[]) =>
      Promise.resolve(
        paths.at(-1)?.endsWith(".partial") ? "/escape/partial" : posix.join(...paths),
      ),
    );
    await expect(exportArtifactDeliveryToDesktop([output])).rejects.toThrow("超出了");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
