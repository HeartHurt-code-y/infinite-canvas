// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MediaReferenceTarget } from "./backend";
import type { PromptContentDocumentV1 } from "./promptContent";
import {
  buildReferenceCatalog,
  candidateTarget,
  createPromptReference,
  normalizePromptReferenceText,
  referenceCandidateFromTarget,
  referenceQueryInText,
  resolvePromptReferences,
  type PromptReferenceCandidate,
} from "./promptReferences";

function candidate(
  canvasNodeKey: string,
  name: string,
  extra: Partial<PromptReferenceCandidate> = {},
): PromptReferenceCandidate {
  return {
    canvasNodeKey,
    assetId: `asset-${canvasNodeKey}`,
    providerConnectionId: "provider-1",
    kind: "image",
    name,
    ...extra,
  };
}

function document(text: string): PromptContentDocumentV1 {
  return { schema: "prompt-content", version: 1, items: [{ kind: "text", text }] };
}

function references(result: ReturnType<typeof resolvePromptReferences>) {
  return result.document.items.filter((item) => item.kind === "media_reference");
}

describe("prompt reference catalog", () => {
  it("keeps per-kind connection order and exposes all names and aliases through one catalog", () => {
    const candidates = [
      candidate("first", "Red Cat.png"),
      candidate("video", "Clip.mp4", { kind: "video" }),
      candidate("second", "Other.png"),
      candidate("audio", "Voice.mp3", { kind: "audio" }),
    ];
    const catalog = buildReferenceCatalog(candidates);
    expect(catalog.aliases).toEqual([
      { candidateIndex: 0, label: "图片1" },
      { candidateIndex: 1, label: "视频1" },
      { candidateIndex: 2, label: "图片2" },
      { candidateIndex: 3, label: "音频1" },
    ]);
    expect(catalog.options("red\tcat")[0]?.candidate).toBe(candidates[0]);
    expect(catalog.options("参考图2")[0]?.candidateIndex).toBe(2);
    expect(catalog.options("视1")[0]?.candidateIndex).toBe(1);
    expect(catalog.options("音1")[0]?.candidateIndex).toBe(3);
    expect(catalog.search(" @RED  CAT ")).toEqual([candidates[0]]);
    expect(catalog.search("参考图2")).toEqual([candidates[2]]);
    expect(catalog.search("asset-video")).toEqual([candidates[1]]);
  });

  it("preserves numbered aliases and reports a natural-name collision as ambiguity", () => {
    const candidates = [candidate("first", "cat.png"), candidate("second", "图片1.png")];
    const catalog = buildReferenceCatalog(candidates);
    expect(catalog.aliases.map((entry) => entry.label)).toEqual(["图片1", "图片2"]);
    expect(catalog.options("图片1").map((option) => option.candidateIndex)).toEqual([0, 1]);
    expect(catalog.ambiguousPatternCount).toBe(1);
    const result = resolvePromptReferences(document("@图片1 与 @图片2"), candidates, {
      mode: "explicit",
    });
    expect(result).toMatchObject({ converted: 1, ambiguous: 1, pending: 1 });
    expect(result.document.items[0]).toEqual({
      kind: "pending_reference",
      normalizedPattern: "图片1",
      displayText: "图片1",
      candidateCount: 2,
    });
    expect(references(result)[0]?.canvasNodeKey).toBe("second");
  });

  it("treats repeated canvas instances of one source as distinct choices", () => {
    const candidates = [
      candidate("instance-a", "cat.png", { assetId: "same-source" }),
      candidate("instance-b", "cat.png", { assetId: "same-source" }),
    ];
    const result = resolvePromptReferences(document("@cat @图片2"), candidates, {
      mode: "explicit",
    });
    expect(result).toMatchObject({ converted: 1, ambiguous: 1, pending: 1 });
    expect(references(result)[0]).toMatchObject({
      canvasNodeKey: "instance-b",
      aliasSnapshot: "图片2",
      target: { assetId: "same-source", canvasNodeKey: "instance-b" },
    });
  });
});

describe("resolvePromptReferences", () => {
  it("only resolves @ syntax by default; explicit bulk name mode also resolves bare names", () => {
    const candidates = [candidate("cat", "cat.png")];
    const source = document("cat.png，cat，图片1，@cat.png，@cat，@图片1");
    const explicit = resolvePromptReferences(source, candidates, { mode: "explicit" });
    expect(explicit.converted).toBe(3);
    expect(explicit.document.items[0]).toEqual({ kind: "text", text: "cat.png，cat，图片1，" });
    const names = resolvePromptReferences(source, candidates, { mode: "names" });
    expect(names.converted).toBe(6);
    expect(names.freshMentionIds).toHaveLength(6);
    expect(new Set(names.freshMentionIds).size).toBe(6);
    expect(source.items).toEqual([
      { kind: "text", text: "cat.png，cat，图片1，@cat.png，@cat，@图片1" },
    ]);
  });

  it("matches the longest name and never truncates numbered aliases or longer filenames", () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(`image-${index + 1}`, index === 0 ? "cat.png" : `name-${index + 1}.png`),
    );
    candidates.push(candidate("short", "cat"));
    const result = resolvePromptReferences(
      document("@图片10，@图片1，@图片100，@cat.png，@cat.png.bak，@catfish"),
      candidates,
      { mode: "explicit" },
    );
    expect(references(result).map((item) => item.canvasNodeKey)).toEqual([
      "image-10",
      "image-1",
      "image-1",
    ]);
    expect(result.document.items.at(-1)).toEqual({
      kind: "text",
      text: "，@cat.png.bak，@catfish",
    });
  });

  it("normalizes case and horizontal whitespace without corrupting original UTF-16 text offsets", () => {
    const candidates = [candidate("cat", "  İSTANBUL  CAT.png ")];
    const source = document("😀前文 @İstanbul\t\tCAT.png 后文🪄");
    const result = resolvePromptReferences(source, candidates, { mode: "explicit" });
    expect(normalizePromptReferenceText(candidates[0]!.name)).toBe("i̇stanbul cat.png");
    expect(result.document.items).toEqual([
      { kind: "text", text: "😀前文 " },
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "cat" }),
      { kind: "text", text: " 后文🪄" },
    ]);
  });

  it("preserves original spelling and spacing in ambiguous displays", () => {
    const candidates = [candidate("one", "Red Cat.png"), candidate("two", "red cat.jpg")];
    const result = resolvePromptReferences(document("@RED\t  Cat"), candidates, {
      mode: "explicit",
    });
    expect(result.document.items[0]).toEqual({
      kind: "pending_reference",
      normalizedPattern: "red cat",
      displayText: "RED\t  Cat",
      candidateCount: 2,
    });
  });

  it("merges adjacent text fragments before resolving a reference", () => {
    const source: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "使用 @" },
        { kind: "text", text: "Red " },
        { kind: "text", text: "Cat.png，结束" },
      ],
    };
    const result = resolvePromptReferences(source, [candidate("cat", "Red Cat.png")], {
      mode: "explicit",
    });
    expect(result.converted).toBe(1);
    expect(result.document.items).toEqual([
      { kind: "text", text: "使用 " },
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "cat" }),
      { kind: "text", text: "，结束" },
    ]);
  });

  it.each(["explicit", "names"] as const)(
    "protects email, URLs, paths and unknown @ text in %s mode",
    (mode) => {
      const candidates = [candidate("cat", "cat.png"), candidate("cn", "猫.png")];
      const text = [
        "person@cat.png",
        "https://example.com/@cat.png",
        "https://example.com/?ref=@猫",
        "https://example.com/cat.png",
        "C:\\media\\@cat.png",
        "./folder/@猫",
        "folder/@cat.png",
        "@陌生猫",
        "@未知图片1",
        "@unknown",
      ].join(" ");
      const result = resolvePromptReferences(document(text), candidates, { mode });
      expect(result).toMatchObject({ converted: 0, ambiguous: 0 });
      expect(result.document).toEqual(document(text));
    },
  );

  it.each(["\n", "\r\n", "\u2028", "\u2029"])(
    "never matches names across line break %j",
    (separator) => {
      const candidates = [candidate("cat", "Red Cat.png")];
      const text = `@Red${separator}Cat.png`;
      const result = resolvePromptReferences(document(text), candidates, { mode: "explicit" });
      expect(result.converted).toBe(0);
      expect(result.document).toEqual(document(text));
    },
  );

  it("does not use a previous confirmation as a learned rule or rebind existing pending items", () => {
    const candidates = [candidate("one", "cat.png"), candidate("two", "cat.png")];
    const confirmed = { ...createPromptReference(candidates[0]!), learnedPattern: "cat" };
    const pending = {
      kind: "pending_reference",
      normalizedPattern: "orphan",
      displayText: "orphan",
      candidateCount: 2,
    } as const;
    const source: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [confirmed, { kind: "text", text: " @cat " }, pending],
    };
    const result = resolvePromptReferences(source, candidates, { mode: "explicit" });
    expect(result).toMatchObject({ converted: 0, ambiguous: 1, pending: 2 });
    expect(result.document.items[0]).toBe(confirmed);
    expect(result.document.items.at(-1)).toBe(pending);
    const disconnected = resolvePromptReferences(result.document, [], { mode: "names" });
    expect(disconnected).toMatchObject({ converted: 0, ambiguous: 0, pending: 2 });
    expect(disconnected.document).toEqual(result.document);
  });

  it("keeps references as fragment boundaries and is idempotent after a conversion", () => {
    const candidates = [candidate("cat", "Red Cat.png")];
    const existing = createPromptReference(candidates[0]!);
    const source: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "@Red " }, existing, { kind: "text", text: "Cat.png @图片1" }],
    };
    const result = resolvePromptReferences(source, candidates, { mode: "explicit" });
    expect(result.converted).toBe(1);
    expect(result.document.items[1]).toBe(existing);
    const again = resolvePromptReferences(result.document, candidates, { mode: "explicit" });
    expect(again.converted).toBe(0);
    expect(again.freshMentionIds).toEqual([]);
    expect(again.document).toEqual(result.document);
  });
});

describe("reference identity factory", () => {
  it.each([
    { kind: "asset", assetId: "asset-17", providerConnectionId: "provider-9", mediaType: "image" },
    { kind: "local_asset", stagingJobId: "staging-17", mediaType: "audio" },
    { kind: "local_result", generationTaskId: "task-17", resultIndex: 3, mediaType: "video" },
    { kind: "local_file", path: "C:\\frames\\frame.png", mediaType: "image" },
  ] satisfies MediaReferenceTarget[])(
    "roundtrips $kind through the candidate without changing source identity",
    (target) => {
      const withInstance = { ...target, canvasNodeKey: "instance-17" };
      const fromTarget = referenceCandidateFromTarget({
        canvasNodeKey: "instance-17",
        target: withInstance,
        name: "原始名称",
        previewUrl: "https://example.com/preview.png",
      });
      expect(fromTarget).toMatchObject({
        canvasNodeKey: "instance-17",
        kind: target.mediaType,
        source: target.kind === "asset" ? "cloud" : "local",
        referenceKind: target.kind,
        name: "原始名称",
        previewUrl: "https://example.com/preview.png",
      });
      expect(candidateTarget(fromTarget)).toEqual(withInstance);
      const secondInstance = referenceCandidateFromTarget({
        canvasNodeKey: "instance-18",
        target,
        name: "另一画布实例",
      });
      expect(candidateTarget(secondInstance)).toEqual({ ...target, canvasNodeKey: "instance-18" });
      expect(secondInstance).not.toHaveProperty("previewUrl");
    },
  );

  it("preserves explicit source kinds, including local file paths and generation result identity", () => {
    const cloud = candidate("cloud", "cat.png", { source: "local", referenceKind: "asset" });
    expect(candidateTarget(cloud)).toMatchObject({
      kind: "asset",
      assetId: "asset-cloud",
      providerConnectionId: "provider-1",
    });
    const local = candidate("local", "cat.png", { source: "local" });
    expect(candidateTarget(local)).toEqual({
      kind: "local_asset",
      stagingJobId: "asset-local",
      canvasNodeKey: "local",
      mediaType: "image",
    });
    const file = candidate("file", "frame.png", {
      referenceKind: "local_file",
      assetId: "C:\\frames\\frame.png",
      source: "local",
    });
    expect(candidateTarget(file)).toEqual({
      kind: "local_file",
      path: "C:\\frames\\frame.png",
      canvasNodeKey: "file",
      mediaType: "image",
    });
    const result = candidate("result", "clip.mp4", {
      referenceKind: "local_result",
      kind: "video",
      generationTaskId: "task-17",
      resultIndex: 3,
    });
    expect(candidateTarget(result)).toEqual({
      kind: "local_result",
      generationTaskId: "task-17",
      resultIndex: 3,
      canvasNodeKey: "result",
      mediaType: "video",
    });
    const resolved = resolvePromptReferences(document("@图片1"), [file], { mode: "explicit" });
    expect(references(resolved)[0]?.target).toEqual(createPromptReference(file).target);
  });
});

describe("referenceQueryInText", () => {
  it("reads incomplete names with spaces using the original UTF-16 caret range", () => {
    expect(referenceQueryInText("😀使用@Red Cat")).toEqual({ query: "Red Cat", start: 4 });
    expect(referenceQueryInText("前文\n@图片")).toEqual({ query: "图片", start: 3 });
    expect(referenceQueryInText("前文\ufffc@")).toEqual({ query: "", start: 3 });
    expect(referenceQueryInText("@one @two")).toEqual({ query: "two", start: 5 });
  });

  it.each([
    "no query",
    "person@cat",
    "https://example.com/?ref=@cat",
    "C:\\files\\@cat",
    "folder/@cat",
    "@Red\nCat",
    "@Red\r\nCat",
    "@Red\ufffcCat",
    "@@cat",
  ])("does not open suggestions for %j", (prefix) => {
    expect(referenceQueryInText(prefix)).toBeNull();
  });
});
