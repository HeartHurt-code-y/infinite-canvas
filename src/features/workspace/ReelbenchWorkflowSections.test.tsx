import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReelbenchShotDraft } from "../../lib/reelbenchBackend";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { ReelbenchConfiguration, ReelbenchDeliverables } from "./ReelbenchWorkflowSections";
import {
  createReelbenchCheckpoint,
  createReelbenchOptions,
  reelbenchDraftSignature,
  reelbenchInputSignature,
} from "./reelbenchWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

const draft: ReelbenchShotDraft = {
  runId: "19dd8970-95a0-402c-b49a-291e41642510",
  videoPath: "C:\\video\\source.mp4",
  outputDir: "C:\\app\\reelbench\\run",
  sourceIdentity: { sizeBytes: 12345, modifiedUnixMs: 100, sha256: "a".repeat(64) },
  meta: { durationSeconds: 3, fps: 30, width: 720, height: 1280, hasAudio: true },
  sceneThreshold: 0.3,
  minShotSeconds: 0.25,
  seedCuts: [],
  manualCuts: [],
  cast: [],
  trackPath: "C:\\app\\reelbench\\run\\track.json",
  sheets: [
    {
      fromId: "S01",
      toId: "S01",
      shotIds: ["S01"],
      frameAPath: "C:\\app\\reelbench\\run\\sheets\\a.jpg",
      frameBPath: "C:\\app\\reelbench\\run\\sheets\\b.jpg",
    },
  ],
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
      frame: "人物在右侧桌边拿起透明水杯，左侧窗光照在杯口。",
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

function checkpoint(): KnowledgeVideoWorkflowCheckpoint {
  return {
    ...node().config.checkpoint,
    phase: "paused",
    reelbench: {
      ...createReelbenchCheckpoint(),
      videoPath: draft.videoPath,
      draft,
      validation,
      validatedDraftSignature: reelbenchDraftSignature(draft),
      step: "review",
      approvedDraftSignature: reelbenchDraftSignature(draft),
    },
  };
}

describe("Reelbench shot review", () => {
  it("keeps the download diagnostic and separates retry from switching to a local video", async () => {
    const base = node();
    const linkedOptions = {
      ...createReelbenchOptions(),
      sourceUrl: "https://www.xiaohongshu.com/explore/example",
    };
    const savedLinkSignature = reelbenchInputSignature({
      ...base.config,
      reelbench: linkedOptions,
    });
    const source = {
      ...base,
      config: {
        ...base.config,
        reelbench: linkedOptions,
        checkpoint: {
          ...base.config.checkpoint,
          phase: "failed" as const,
          error: "requested format is not available",
          reelbench: {
            ...createReelbenchCheckpoint(),
            step: "source" as const,
            inputSignature: savedLinkSignature,
            downloadJobId: "download-1",
          },
        },
      },
    };
    const onPickReelbenchVideo = vi.fn(async () => {});
    const onContinue = vi.fn();
    const props = {
      providerCatalog: catalog,
      onChange: vi.fn(),
      onExecute: vi.fn(),
      onContinue,
      onCancel: vi.fn(),
      onRemove: vi.fn(),
      onRevealResult: vi.fn(),
      onPickReelbenchVideo,
    };
    const view = render(<KnowledgeVideoWorkflowNode node={source} {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("requested format is not available");
    expect(screen.getByText(/切换来源只是再次尝试/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试当前步骤" }));
    expect(onContinue).toHaveBeenCalledWith(base.key);
    fireEvent.click(screen.getByRole("button", { name: "选择本地视频后重新制作" }));
    expect(onPickReelbenchVideo).toHaveBeenCalledWith(base.key);

    view.rerender(
      <KnowledgeVideoWorkflowNode
        node={{
          ...source,
          config: {
            ...source.config,
            reelbench: {
              ...source.config.reelbench,
              sourceUrl: "",
              localVideoPath: "C:\\video\\source.mp4",
              localVideoName: "source.mp4",
            },
          },
        }}
        {...props}
      />,
    );
    expect(screen.getByText(/原片输入已改变/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试当前步骤" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "按当前资料重新制作" })).toBeEnabled(),
    );

    const originalLocalConfig = {
      ...source.config,
      reelbench: {
        ...source.config.reelbench,
        sourceUrl: "",
        localVideoPath: "C:\\video\\source.mp4",
        localVideoName: "source.mp4",
      },
    };
    view.rerender(
      <KnowledgeVideoWorkflowNode
        node={{
          ...source,
          config: {
            ...originalLocalConfig,
            checkpoint: {
              ...source.config.checkpoint,
              reelbench: {
                ...source.config.checkpoint.reelbench,
                inputSignature: reelbenchInputSignature(originalLocalConfig),
              },
            },
          },
        }}
        {...props}
      />,
    );
    expect(screen.getByRole("button", { name: "重试当前步骤" })).toBeEnabled();
    expect(screen.queryByText(/原片输入已改变/)).not.toBeInTheDocument();
  });

  it("offers browser Cookies for linked videos without claiming the login is valid", () => {
    const onSelectCookieBrowser = vi.fn();
    render(
      <ReelbenchConfiguration
        options={{ ...createReelbenchOptions(), sourceUrl: "https://www.bilibili.com/video/BV123" }}
        brief=""
        disabled={false}
        onChange={vi.fn()}
        onBriefChange={vi.fn()}
        cookieStatus={{
          state: "ready",
          version: "2026.09.27",
          binaryPath: "C:/app/yt-dlp.exe",
          cookieBrowser: "chrome",
          cookiesInstalled: false,
          bilibiliLoggedIn: false,
          lastError: null,
        }}
        onOpenDownloadSettings={vi.fn()}
        onSelectCookieBrowser={onSelectCookieBrowser}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("目标视频能否访问待实际下载验证");
    fireEvent.change(screen.getByRole("combobox", { name: "下载 Cookies 来源" }), {
      target: { value: "firefox" },
    });
    expect(onSelectCookieBrowser).toHaveBeenCalledWith("firefox");
  });

  it("invalidates validation and batch approval on any shot edit", () => {
    const onChange = vi.fn();
    render(
      <ReelbenchDeliverables
        checkpoint={checkpoint()}
        disabled={false}
        onChange={onChange}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑本镜" }));
    fireEvent.change(screen.getByLabelText("画面描述"), {
      target: { value: "人物转身把透明水杯放回桌面，窗光落在左侧。" },
    });
    fireEvent.change(screen.getByLabelText("主体（逗号分隔）"), {
      target: { value: "人物甲" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存本镜修改" }));
    const next = onChange.mock.lastCall?.[0] as KnowledgeVideoWorkflowCheckpoint;
    expect(next.reelbench?.draft?.shots[0]?.frame).toContain("转身");
    expect(next.reelbench?.draft?.cast).toContainEqual({ id: "人物甲", name: "人物甲", note: "" });
    expect(next.reelbench?.validation).toBeNull();
    expect(next.reelbench?.validatedDraftSignature).toBeNull();
    expect(next.reelbench?.approvedDraftSignature).toBeNull();
    expect(next.reelbench?.manualRevision).toBe(1);
    expect(next.reelbench?.completedDraftSignature).toBe(
      reelbenchDraftSignature(next.reelbench!.draft!),
    );
    expect(next.phase).toBe("paused");
  });

  it("approves the whole checked draft in one action and waits for a separate continue", () => {
    const onChange = vi.fn();
    const onContinue = vi.fn();
    const source = checkpoint();
    const unapproved = {
      ...source,
      reelbench: { ...source.reelbench!, approvedDraftSignature: null },
    };
    const view = render(
      <ReelbenchDeliverables
        checkpoint={unapproved}
        disabled={false}
        onChange={onChange}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已逐镜审阅，批量批准全部 1 镜/ }));
    const approvedCheckpoint = onChange.mock.lastCall?.[0] as KnowledgeVideoWorkflowCheckpoint;
    expect(approvedCheckpoint.reelbench?.approvedDraftSignature).toBe(
      reelbenchDraftSignature(draft),
    );
    expect(onContinue).not.toHaveBeenCalled();
    view.rerender(
      <ReelbenchDeliverables
        checkpoint={approvedCheckpoint}
        disabled={false}
        onChange={onChange}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /继续导出报告/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does not save an open editor while the workflow is running", () => {
    const onChange = vi.fn();
    const current = checkpoint();
    const view = render(
      <ReelbenchDeliverables
        checkpoint={current}
        disabled={false}
        onChange={onChange}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑本镜" }));
    view.rerender(
      <ReelbenchDeliverables
        checkpoint={current}
        disabled
        onChange={onChange}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "保存本镜修改" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存本镜修改" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("queues multiple manual cuts without losing the earlier cut", () => {
    const onChange = vi.fn();
    const onContinue = vi.fn();
    const view = render(
      <ReelbenchDeliverables
        checkpoint={checkpoint()}
        disabled={false}
        onChange={onChange}
        onContinue={onContinue}
      />,
    );
    fireEvent.change(screen.getByLabelText("补刀时间点"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "记录补刀" }));
    const first = onChange.mock.lastCall?.[0] as KnowledgeVideoWorkflowCheckpoint;
    view.rerender(
      <ReelbenchDeliverables
        checkpoint={first}
        disabled={false}
        onChange={onChange}
        onContinue={onContinue}
      />,
    );
    fireEvent.change(screen.getByLabelText("补刀时间点"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "记录补刀" }));
    const second = onChange.mock.lastCall?.[0] as KnowledgeVideoWorkflowCheckpoint;
    expect(second.reelbench?.pendingRecut?.splitCuts).toEqual([1, 2]);
    expect(second.reelbench?.manualRevision).toBe(2);
    view.rerender(
      <ReelbenchDeliverables
        checkpoint={second}
        disabled={false}
        onChange={onChange}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "应用切点修改并重新分析" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
