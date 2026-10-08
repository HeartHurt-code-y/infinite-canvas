import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mediaClient,
  type GenerationTaskClient,
  type GenerationTaskDetail,
} from "../../lib/backend";
import { HistoryDialog } from "./HistoryDialog";

const originalPath = "C:/outputs/dreamina-history.mp4";
const posterPath = "C:/cache/dreamina-history.jpg";
const detail: GenerationTaskDetail = {
  summary: {
    id: "task-history-video",
    canvasId: "canvas-1",
    sourceNodeId: "node-1",
    operation: "video_generation",
    status: "succeeded",
    queryHealth: "healthy",
    providerConnectionId: "provider-1",
    providerDisplayNameSnapshot: "海外平台",
    modelDefinitionId: "dreamina-seedance-2.5",
    remoteModelIdSnapshot: "dreamina-seedance-2.5",
    remoteTaskId: "remote-video-1",
    progress: 100,
    tokens: null,
    createdAt: 1_777_000_000_000,
    updatedAt: 1_777_000_002_000,
    completedAt: 1_777_000_002_000,
  },
  logicalRequest: {},
  resolvedRequest: {},
  attempts: [],
  calls: [],
  events: [],
  textOutput: null,
  finalError: null,
  results: [
    {
      taskId: "task-history-video",
      resultIndex: 0,
      mediaType: "video",
      remoteTaskId: "remote-video-1",
      source: null,
      saveStatus: "succeeded",
      finalPath: originalPath,
      relativePath: "dreamina-history.mp4",
      byteSize: 14_000_000,
      mimeType: "video/mp4",
      sha256: null,
      savedAt: 1_777_000_002_000,
      error: null,
    },
  ],
};

function client(): GenerationTaskClient {
  return {
    start: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [detail.summary], nextCursorCreatedBefore: null }),
    get: vi.fn().mockResolvedValue(detail),
    getProgress: vi.fn(),
    queryVideoTaskNow: vi.fn(),
  };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    invoke: () => Promise.resolve(null),
    transformCallback: () => 1,
    convertFileSrc: (path: string) => `asset://localhost/${path}`,
    metadata: { currentWindow: { label: "main" } },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("历史记录本地视频封面", () => {
  it("封面只解码 JPEG，点开后仍播放原视频", async () => {
    const createThumbnail = vi
      .spyOn(mediaClient, "createThumbnail")
      .mockResolvedValue({ path: posterPath, width: 288, height: 512 });
    render(<HistoryDialog open client={client()} onClose={vi.fn()} />);
    const resultLabel = await screen.findByText(/结果 1 · 视频/);
    const preview = resultLabel.closest("button")!;

    await waitFor(() => expect(createThumbnail).toHaveBeenCalledWith(originalPath, 512));
    await waitFor(() =>
      expect(preview.querySelector("img")).toHaveAttribute(
        "src",
        `asset://localhost/${posterPath}`,
      ),
    );
    expect(preview.querySelector("video")).toBeNull();

    fireEvent.click(preview);
    expect(screen.getByRole("dialog", { name: "媒体预览" }).querySelector("video")).toHaveAttribute(
      "src",
      `asset://localhost/${originalPath}`,
    );
  });
});
