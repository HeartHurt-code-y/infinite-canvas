import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportArtifactToDesktop } from "./desktopActions";

const mocked = vi.hoisted(() => ({ save: vi.fn(), copyFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocked.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ copyFile: mocked.copyFile }));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: () => Promise.resolve("C:/outputs/task"),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

describe("named artifact export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.copyFile.mockResolvedValue(undefined);
  });
  it("suggests the current node name and copies the original into the chosen file", async () => {
    mocked.save.mockResolvedValue("C:/delivery/第01集_镜头003.mp4");
    await expect(
      exportArtifactToDesktop("C:/outputs/task/original.mp4", "第01集_镜头003.mp4"),
    ).resolves.toBe("C:/delivery/第01集_镜头003.mp4");
    expect(mocked.save).toHaveBeenCalledWith({
      title: "导出产物",
      defaultPath: "C:/outputs/task/第01集_镜头003.mp4",
    });
    expect(mocked.copyFile).toHaveBeenCalledExactlyOnceWith(
      "C:/outputs/task/original.mp4",
      "C:/delivery/第01集_镜头003.mp4",
    );
  });
  it("cancels or selects the same file without rewriting source bytes", async () => {
    mocked.save.mockResolvedValueOnce(null).mockResolvedValueOnce("C:/outputs/task/original.mp4");
    await expect(
      exportArtifactToDesktop("C:/outputs/task/original.mp4", "镜头.mp4"),
    ).resolves.toBeNull();
    await expect(exportArtifactToDesktop("C:/outputs/task/original.mp4", "镜头.mp4")).resolves.toBe(
      "C:/outputs/task/original.mp4",
    );
    expect(mocked.copyFile).not.toHaveBeenCalled();
  });
  it("reports a missing source or failed copy to the caller", async () => {
    mocked.save.mockResolvedValue("C:/delivery/镜头.mp4");
    mocked.copyFile.mockRejectedValue(new Error("源文件不存在"));
    await expect(
      exportArtifactToDesktop("C:/outputs/task/original.mp4", "镜头.mp4"),
    ).rejects.toThrow("源文件不存在");
  });
});
