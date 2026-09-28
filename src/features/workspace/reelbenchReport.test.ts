import { describe, expect, it, vi } from "vitest";
import type { ReelbenchShotDraft } from "../../lib/reelbenchBackend";
import { reelbenchReportHtml, writeReelbenchReports } from "./reelbenchReport";

const writeTextFile = vi.fn((...args: [string, string]) => {
  void args;
  return Promise.resolve();
});
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile }));
vi.mock("@tauri-apps/api/path", () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

const draft: ReelbenchShotDraft = {
  runId: "19dd8970-95a0-402c-b49a-291e41642510",
  videoPath: "C:\\other\\source.mp4",
  outputDir: "C:\\app\\reelbench\\run",
  sourceIdentity: { sizeBytes: 12345, modifiedUnixMs: 100, sha256: "a".repeat(64) },
  meta: { durationSeconds: 3, fps: 30, width: 720, height: 1280, hasAudio: true },
  sceneThreshold: 0.3,
  minShotSeconds: 0.25,
  seedCuts: [],
  manualCuts: [],
  cast: [],
  trackPath: "C:\\app\\reelbench\\run\\track.json",
  sheets: [],
  shots: [
    {
      id: "S01",
      start: 0,
      end: 3,
      seconds: 3,
      motion: 0.01,
      size: "medium",
      category: "subject",
      camera: "static",
      transitionIn: "cut",
      subjects: [],
      frame: "<img src='https://outside.example/pixel'> 人物在桌边拿起透明水杯。",
      onscreenText: "",
      audio: "",
      rhythm: "",
      rhythmNote: "",
      note: "",
      frameAPath: "C:\\app\\reelbench\\run\\frames\\S01a.jpg",
      frameBPath: "C:\\app\\reelbench\\run\\frames\\S01b.jpg",
    },
  ],
};
const validation = {
  ok: true,
  gates: [{ id: "time", ok: true, skipped: false, issues: [] }],
  hints: [],
};

describe("Reelbench offline report", () => {
  it("escapes annotation HTML and refers to its own frame files by relative path", () => {
    const result = reelbenchReportHtml(draft, validation, "zh");
    expect(result).toContain("&lt;img src=&#39;https://outside.example/pixel&#39;&gt;");
    expect(result).not.toContain("<img src='https://outside.example/pixel'>");
    expect(result).toContain('src="frames/S01a.jpg"');
    expect(result).not.toContain('src="https://outside.example');
    expect(result).toContain('type="file" accept="video/*"');
  });

  it("writes JSON, Markdown and HTML under the app-owned run directory", async () => {
    writeTextFile.mockClear();
    const result = await writeReelbenchReports(draft, validation, "zh");
    expect(result.reportHtmlPath).toBe("C:\\app\\reelbench\\run/shots-report.html");
    expect(writeTextFile).toHaveBeenCalledTimes(3);
    for (const call of writeTextFile.mock.calls) {
      expect(call[0]).toMatch(/^C:\\app\\reelbench\\run\//);
    }
  });
});
