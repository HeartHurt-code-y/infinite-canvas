import { describe, expect, it, vi } from "vitest";

import {
  PROMPT_ATTACHMENT_ACCEPT,
  ingestPromptAttachments,
  promptAttachmentMediaType,
} from "./promptAttachments";
import type { PromptAttachmentIngestDeps } from "./promptAttachments";

describe("promptAttachmentMediaType", () => {
  it("maps supported extensions to media types case-insensitively", () => {
    expect(promptAttachmentMediaType("photo.PNG")).toBe("image");
    expect(promptAttachmentMediaType("clip.MP4")).toBe("video");
    expect(promptAttachmentMediaType("song.FLAC")).toBe("audio");
  });

  it("returns null for documents and names without a known extension", () => {
    expect(promptAttachmentMediaType("spec.pdf")).toBeNull();
    expect(promptAttachmentMediaType("README")).toBeNull();
    expect(promptAttachmentMediaType("archive.tar.mp3.bak")).toBeNull();
  });

  it("keeps the picker accept attribute derived from the same extension table", () => {
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(".png");
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(".mkv");
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(".flac");
    expect(PROMPT_ATTACHMENT_ACCEPT).not.toContain(".pdf");
    expect(PROMPT_ATTACHMENT_ACCEPT.split(",")).toHaveLength(16);
  });
});

function makeDeps(overrides: Partial<PromptAttachmentIngestDeps> = {}): {
  readonly deps: PromptAttachmentIngestDeps;
  readonly saved: string[];
  readonly deleted: string[];
} {
  const saved: string[] = [];
  const deleted: string[] = [];
  const deps: PromptAttachmentIngestDeps = {
    saveTempFile: (fileName) => {
      const path = `C:\\temp\\${fileName}`;
      saved.push(path);
      return Promise.resolve(path);
    },
    importLocalAsset: ({ name }) => Promise.resolve({ id: `asset-${name}` }),
    deleteFile: (path) => {
      deleted.push(path);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, saved, deleted };
}

function file(name: string, bytes = 4): File {
  return new File([new Uint8Array(bytes)], name);
}

describe("ingestPromptAttachments", () => {
  it("imports supported files, inserts items and always cleans temp files", async () => {
    const { deps, saved, deleted } = makeDeps();
    const report = await ingestPromptAttachments([file("a.png"), file("b.mp4")], deps);
    expect(report.attachments).toHaveLength(2);
    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    const [first] = report.attachments;
    expect(first).toMatchObject({
      kind: "attachment",
      target: { kind: "local_base64_asset", assetId: "asset-a.png", mediaType: "image" },
      name: "a.png",
      mediaType: "image",
    });
    expect(report.attachments[1]?.mediaType).toBe("video");
    expect(saved).toHaveLength(2);
    expect([...deleted].sort()).toEqual([...saved].sort());
  });

  it("reports unsupported files as skipped without touching storage", async () => {
    const importLocalAsset = vi.fn(({ name }: { localPath: string; name: string }) =>
      Promise.resolve({ id: `asset-${name}` }),
    );
    const { deps, saved, deleted } = makeDeps({ importLocalAsset });
    const report = await ingestPromptAttachments([file("notes.pdf"), file("cover.jpg")], deps);
    expect(report.skipped).toEqual(["notes.pdf"]);
    expect(report.attachments.map((item) => item.name)).toEqual(["cover.jpg"]);
    expect(importLocalAsset).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(deleted).toHaveLength(1);
  });

  it("isolates per-file failures and still cleans up their temp files", async () => {
    const { deps, deleted } = makeDeps({
      importLocalAsset: ({ name }) =>
        name === "broken.mov"
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve({ id: `asset-${name}` }),
    });
    const report = await ingestPromptAttachments(
      [file("ok.png"), file("broken.mov"), file("ok2.wav")],
      deps,
    );
    expect(report.attachments.map((item) => item.name)).toEqual(["ok.png", "ok2.wav"]);
    expect(report.failed).toEqual(["broken.mov"]);
    expect(deleted).toHaveLength(3);
  });
});
