import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import {
  MUSIC_VIDEO_APPROVAL,
  createMusicVideoCheckpoint,
  createMusicVideoOptions,
} from "./musicVideoWorkflowModel";
import { initializeWorkflowVersions, recordWorkflowVersion } from "./workflowVersionHistory";
import { createWorkflowExecutionPlan } from "./workflowExecutionPlan";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";

function config(): KnowledgeVideoWorkflowConfig {
  const original = node().config;
  return {
    ...original,
    brief: "",
    musicVideo: { ...createMusicVideoOptions(), deliverable: "documents" },
    models: {
      ...original.models,
      image: { providerId: "", modelDefinitionId: "" },
      video: { providerId: "", modelDefinitionId: "" },
    },
    checkpoint: { ...original.checkpoint, musicVideo: createMusicVideoCheckpoint() },
  };
}
const props = () => ({
  providerCatalog: catalog,
  onChange: vi.fn(),
  onExecute: vi.fn(),
  onContinue: vi.fn(),
  onCancel: vi.fn(),
  onRemove: vi.fn(),
  onRevealResult: vi.fn(),
  onApprovePlan: vi.fn(),
  onPickMusicVideoMaterial: vi.fn(() => Promise.resolve()),
});

describe("MV workflow user controls", () => {
  it("requires a real song, routes the picker to this node, and gates reference characters", () => {
    const callbacks = props();
    const source = { ...node(), key: "mv-one", config: config() };
    const { rerender } = render(<KnowledgeVideoWorkflowNode {...callbacks} node={source} />);
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "选择歌曲" }));
    expect(callbacks.onPickMusicVideoMaterial).toHaveBeenCalledWith("mv-one", "song");
    const withSong = {
      ...source.config,
      musicVideo: {
        ...source.config.musicVideo!,
        songPath: "C:/songs/track.mp3",
        songName: "歌曲",
      },
    };
    rerender(<KnowledgeVideoWorkflowNode {...callbacks} node={{ ...source, config: withSong }} />);
    // Complete the asynchronous picker lifecycle before testing readiness.
    return Promise.resolve().then(() => {
      rerender(
        <KnowledgeVideoWorkflowNode {...callbacks} node={{ ...source, config: withSong }} />,
      );
      expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "查看执行计划" }));
      expect(callbacks.onExecute).toHaveBeenCalledWith("mv-one");
      rerender(
        <KnowledgeVideoWorkflowNode
          {...callbacks}
          node={{
            ...source,
            config: {
              ...withSong,
              musicVideo: { ...withSong.musicVideo, characterMode: "reference" },
            },
          }}
        />,
      );
      expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "添加人物参考图" })).toBeEnabled();
    });
  });

  it("requires explicit plan approval and sends the actual MV stage decision on click", () => {
    const callbacks = props();
    const base = config();
    const source = {
      ...node(),
      config: { ...base, musicVideo: { ...base.musicVideo!, songPath: "C:/song.mp3" } },
    };
    const plan = createWorkflowExecutionPlan(source);
    const { rerender } = render(
      <KnowledgeVideoWorkflowNode
        {...callbacks}
        node={{
          ...source,
          config: {
            ...source.config,
            executionPlan: plan,
            checkpoint: {
              ...source.config.checkpoint,
              executionPlan: plan,
              phase: "awaiting_approval",
            },
          },
        }}
      />,
    );
    expect(callbacks.onApprovePlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认计划并执行" }));
    expect(callbacks.onApprovePlan).toHaveBeenCalledWith(source.key);
    rerender(
      <KnowledgeVideoWorkflowNode
        {...callbacks}
        node={{
          ...source,
          config: {
            ...source.config,
            checkpoint: {
              ...source.config.checkpoint,
              phase: "awaiting_approval",
              decision: {
                kind: "planning",
                question: "请试听确认当前歌词时间线",
                recommendation: MUSIC_VIDEO_APPROVAL,
              },
            },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "采用推荐并继续" }));
    expect(callbacks.onContinue).toHaveBeenCalledWith(source.key, MUSIC_VIDEO_APPROVAL);
    fireEvent.change(screen.getByRole("textbox", { name: "你的回答（可选）" }), {
      target: { value: "第二段改为间奏" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(callbacks.onContinue).toHaveBeenLastCalledWith(source.key, "第二段改为间奏");
  });

  it("saves edited MV stage content as a new local workflow version and locks editing during production", () => {
    const callbacks = props();
    function Harness({ running = false }: { readonly running?: boolean }) {
      const [value, setValue] = useState(() => {
        const base = config();
        return initializeWorkflowVersions({
          ...base,
          musicVideo: { ...base.musicVideo!, songPath: "C:/song.mp3" },
          checkpoint: {
            ...base.checkpoint,
            phase: "paused",
            musicVideo: {
              ...createMusicVideoCheckpoint(),
              stages: {
                timeline: {
                  artifact: {
                    version: 1,
                    createdAt: 1,
                    content: "原歌词时间线",
                    inputSummary: "用户 LRC",
                    timeline: [
                      {
                        id: "seg-1",
                        startSeconds: 0,
                        endSeconds: 5,
                        kind: "vocal",
                        text: "原歌词",
                        section: "主歌",
                      },
                    ],
                  },
                  review: { result: "PASS", report: "文本完整" },
                  approvedVersion: 1,
                  history: [],
                },
              },
            },
          },
        });
      });
      return (
        <KnowledgeVideoWorkflowNode
          {...callbacks}
          node={{ ...node(), config: value }}
          onChange={(next) => setValue((previous) => recordWorkflowVersion(previous, next))}
          {...(running
            ? {
                runState: {
                  phase: "generating" as const,
                  progress: 50,
                  message: "制作中",
                  error: null,
                },
              }
            : {})}
        />
      );
    }
    const { rerender } = render(<Harness />);
    expect(screen.getByText("1 个工作流版本")).toBeInTheDocument();
    fireEvent.click(screen.getByText("歌曲时间线 · v1 · 已确认"));
    fireEvent.click(screen.getByRole("button", { name: "编辑歌曲时间线" }));
    fireEvent.change(screen.getByRole("textbox", { name: "歌词" }), {
      target: { value: "用户校正后的歌词" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存阶段新版本" }));
    expect(screen.getByText("2 个工作流版本")).toBeInTheDocument();
    expect(screen.getByText("歌曲时间线 · v2 · 待确认")).toBeInTheDocument();
    expect(screen.getByText("1 份历史稿")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "MV 阶段交付物" });
    expect(within(section).getByText(/0.00–5.00 秒 · 用户校正后的歌词/)).toBeInTheDocument();
    rerender(<Harness running />);
    expect(screen.getByRole("button", { name: "编辑歌曲时间线" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "MV 官方歌词" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看当前工作流版本历史" })).toBeDisabled();
  });
});
