import { describe, expect, it } from "vitest";
import type { MediaReferenceTarget } from "./backend";
import {
  createPromptContentEditorSession,
  createPromptContentModule,
  decodePromptContentDocument,
  type PromptContentConnection,
  type PromptContentDocumentV1,
} from "./promptContent";
import type { PromptAutoMentionCandidate } from "./promptAutoMention";

function assetCandidate(
  canvasNodeKey: string,
  name = "角色.png",
  assetId = "asset-1",
): PromptAutoMentionCandidate {
  return {
    canvasNodeKey,
    assetId,
    providerConnectionId: "provider-1",
    referenceKind: "asset",
    kind: "image",
    name,
  };
}

function targetFor(candidate: PromptAutoMentionCandidate): MediaReferenceTarget {
  return {
    kind: "asset",
    providerConnectionId: candidate.providerConnectionId,
    assetId: candidate.assetId,
    canvasNodeKey: candidate.canvasNodeKey,
    mediaType: "image",
  };
}

function connectionFor(candidate: PromptAutoMentionCandidate): PromptContentConnection {
  return {
    key: candidate.canvasNodeKey,
    name: candidate.name,
    kind: "image",
    target: targetFor(candidate),
  };
}

describe("prompt content interface", () => {
  it("turns a unique connected name into an ordered canonical media reference", () => {
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    const element = document.createElement("div");
    session.attach(element);

    expect(session.replaceText("让 角色.png 看向镜头")).toMatchObject({
      converted: 1,
      ambiguous: 0,
      pending: 0,
    });
    expect(session.snapshot().items).toMatchObject([
      { kind: "text", text: "让 " },
      {
        kind: "media_reference",
        canvasNodeKey: "asset-node-1",
        displayNameSnapshot: "角色.png",
        target: { kind: "asset", assetId: "asset-1", canvasNodeKey: "asset-node-1" },
      },
      { kind: "text", text: " 看向镜头" },
    ]);
  });

  it("keeps same-name matches pending until the caller confirms a concrete canvas instance", () => {
    const first = assetCandidate("asset-node-1", "角色.png", "asset-1");
    const second = assetCandidate("asset-node-2", "角色.png", "asset-2");
    const session = createPromptContentEditorSession([first, second]);
    session.attach(document.createElement("div"));

    expect(session.replaceText("角色.png 与 角色.png")).toMatchObject({
      converted: 0,
      ambiguous: 2,
      pending: 2,
    });
    const pendingPreparation = session.prepareGeneration({
      connections: [connectionFor(first), connectionFor(second)],
      allowMediaOnly: false,
    });
    expect(pendingPreparation.ok).toBe(false);
    expect(!pendingPreparation.ok && pendingPreparation.issues).toHaveLength(2);
    expect(!pendingPreparation.ok && pendingPreparation.issues[0]).toMatchObject({
      kind: "pending_reference",
    });

    const option = session.ambiguityOptions("角色.png")[1]!;
    expect(session.confirmPending("角色.png", option.candidate, option.alias)).toBe(2);
    expect(session.snapshot().items.filter((item) => item.kind === "media_reference")).toHaveLength(
      2,
    );
  });

  it("freezes prompt references and appends only unmentioned canvas instances", () => {
    const first = assetCandidate("asset-node-1", "角色.png", "shared-asset");
    const second = assetCandidate("asset-node-2", "角色副本.png", "shared-asset");
    const session = createPromptContentEditorSession([first, second]);
    session.attach(document.createElement("div"));
    session.insertReference(first);

    const prepared = session.prepareGeneration({
      connections: [connectionFor(first), connectionFor(second)],
      allowMediaOnly: false,
    });
    expect(prepared).toMatchObject({
      ok: true,
      frozen: {
        segments: [{ kind: "media_reference", target: { canvasNodeKey: "asset-node-1" } }],
        explicitMedia: [{ target: { canvasNodeKey: "asset-node-2" } }],
      },
    });
  });

  it("rejects disconnected and rebound references without changing their original identity", () => {
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    session.attach(document.createElement("div"));
    session.insertReference(candidate);

    expect(session.prepareGeneration({ connections: [], allowMediaOnly: false })).toMatchObject({
      ok: false,
      issues: [{ kind: "disconnected_reference" }],
    });

    const rebound = assetCandidate("asset-node-1", "替换.png", "asset-other");
    expect(
      session.prepareGeneration({
        connections: [connectionFor(rebound)],
        allowMediaOnly: false,
      }),
    ).toMatchObject({ ok: false, issues: [{ kind: "reference_identity_changed" }] });
    expect(session.snapshot().items[0]).toMatchObject({
      kind: "media_reference",
      target: { assetId: "asset-1" },
    });
  });

  it("round-trips newlines and structured snapshots while detached", () => {
    const session = createPromptContentEditorSession();
    const firstElement = document.createElement("div");
    session.attach(firstElement);
    session.replaceText("第一行\n第二行");
    const snapshot = session.snapshot();
    session.attach(null);

    const restored = createPromptContentEditorSession();
    restored.restore(snapshot);
    const secondElement = document.createElement("div");
    restored.attach(secondElement);

    expect(restored.read().plainText).toBe("第一行\n第二行");
    expect(secondElement.querySelector("br")).not.toBeNull();
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it("migrates legacy HTML through a whitelist instead of restoring arbitrary markup", () => {
    const session = createPromptContentEditorSession();
    const element = document.createElement("div");
    session.attach(element);
    session.restore(
      '<div>安全文本</div><script>window.evil = true</script><style>.x{}</style><b onclick="evil()">尾部</b>',
    );

    expect(session.read().plainText).toBe("安全文本\n尾部");
    expect(element.querySelector("script, style, b, [onclick]")).toBeNull();
  });

  it("keeps the current document when a structured restore is invalid", () => {
    const session = createPromptContentEditorSession();
    session.replaceText("保留我");

    session.restore({ schema: "prompt-content", version: 1, items: [{ kind: "unknown" }] });

    expect(session.read().plainText).toBe("保留我");
  });

  it("rejects duplicate mention ids at the document interface", () => {
    const reference = {
      kind: "media_reference",
      mentionId: "mention-1",
      canvasNodeKey: "asset-node-1",
      target: targetFor(assetCandidate("asset-node-1")),
      displayNameSnapshot: "角色.png",
    } as const;
    expect(
      decodePromptContentDocument({
        schema: "prompt-content",
        version: 1,
        items: [reference, reference],
      }),
    ).toBeNull();
  });

  it("preserves local-result canvas identity in the frozen target", () => {
    const candidate: PromptAutoMentionCandidate = {
      canvasNodeKey: "output-node-2",
      assetId: "task-1#0",
      providerConnectionId: "",
      referenceKind: "local_result",
      generationTaskId: "task-1",
      resultIndex: 0,
      kind: "video",
      name: "上一段.mp4",
    };
    const target: MediaReferenceTarget = {
      kind: "local_result",
      generationTaskId: "task-1",
      resultIndex: 0,
      canvasNodeKey: "output-node-2",
      mediaType: "video",
    };
    const session = createPromptContentEditorSession([candidate]);
    session.insertReference(candidate);

    expect(
      session.prepareGeneration({
        connections: [{ key: "output-node-2", name: "上一段.mp4", kind: "video", target }],
        allowMediaOnly: false,
      }),
    ).toMatchObject({
      ok: true,
      frozen: {
        segments: [
          {
            kind: "media_reference",
            target: { kind: "local_result", canvasNodeKey: "output-node-2" },
          },
        ],
      },
    });
  });

  it("keeps canonical content when a viewport remount adopts a new DOM adapter", () => {
    const module = createPromptContentModule();
    const first = createPromptContentEditorSession();
    first.attach(document.createElement("div"));
    module.adoptEditor("gen-1", first);
    module.replaceText("gen-1", "离屏后仍保留", []);
    first.attach(null);
    module.adoptEditor("gen-1", null);

    const remounted = createPromptContentEditorSession();
    const remountedElement = document.createElement("div");
    remounted.attach(remountedElement);
    module.adoptEditor("gen-1", remounted);

    expect(module.read("gen-1")?.plainText).toBe("离屏后仍保留");
    expect(remountedElement).toHaveTextContent("离屏后仍保留");
    expect(module.snapshotAll(new Set(["gen-1", "gen-empty"]))).toMatchObject({
      "gen-1": { schema: "prompt-content", version: 1 },
      "gen-empty": { schema: "prompt-content", version: 1, items: [] },
    });
  });

  it("validates a full restore plan before changing any registered prompt content", () => {
    const module = createPromptContentModule();
    const session = createPromptContentEditorSession();
    module.adoptEditor("gen-1", session);
    module.replaceText("gen-1", "原内容", []);

    const result = module.restoreAll({
      "gen-1": {
        schema: "prompt-content",
        version: 1,
        items: [{ kind: "unknown" }],
      } as unknown as PromptContentDocumentV1,
    });

    expect(result).toEqual({ ok: false, invalidNodeKeys: ["gen-1"] });
    expect(module.read("gen-1")?.plainText).toBe("原内容");
  });
});
