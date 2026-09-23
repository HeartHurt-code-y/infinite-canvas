// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { MediaReferenceTarget } from "./backend";
import {
  cleanGeneratedPrompt,
  createPromptContentEditorSession,
  createPromptContentModule,
  decodePromptContentDocument,
  type PromptContentConnection,
  type PromptContentDocumentV1,
} from "./promptContent";
import type { PromptReferenceCandidate } from "./promptReferences";

function assetCandidate(
  canvasNodeKey: string,
  name = "角色.png",
  assetId = "asset-1",
): PromptReferenceCandidate {
  return {
    canvasNodeKey,
    assetId,
    providerConnectionId: "provider-1",
    referenceKind: "asset",
    kind: "image",
    name,
  };
}

function targetFor(candidate: PromptReferenceCandidate): MediaReferenceTarget {
  return {
    kind: "asset",
    providerConnectionId: candidate.providerConnectionId,
    assetId: candidate.assetId,
    canvasNodeKey: candidate.canvasNodeKey,
    mediaType: "image",
  };
}

function connectionFor(candidate: PromptReferenceCandidate): PromptContentConnection {
  return {
    key: candidate.canvasNodeKey,
    name: candidate.name,
    kind: "image",
    target: targetFor(candidate),
  };
}

describe("prompt content interface", () => {
  it("preserves ordinary names until the user explicitly requests name recognition", () => {
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    session.replaceText("让 角色.png 看向镜头");
    expect(session.autoResolve()).toMatchObject({ converted: 0 });
    expect(session.read().plainText).toBe("让 角色.png 看向镜头");
    expect(session.autoResolve({ mode: "names" })).toMatchObject({ converted: 1 });
    expect(session.read().referenceCount).toBe(1);
  });

  it("resolves explicit references identically on paste, import, and immediate submission", () => {
    const candidate = assetCandidate("asset-node-1");
    for (const entry of ["paste", "replace", "submit"] as const) {
      const session = createPromptContentEditorSession([candidate]);
      if (entry === "paste") session.pastePlainText("看向 @图片1");
      else if (entry === "replace") session.replaceText("看向 @图片1");
      else
        session.restore({
          schema: "prompt-content",
          version: 1,
          items: [{ kind: "text", text: "看向 @图片1" }],
        });
      const prepared = session.prepareGeneration({
        connections: [connectionFor(candidate)],
        allowMediaOnly: false,
      });
      expect(prepared).toMatchObject({
        ok: true,
        frozen: {
          segments: [
            { kind: "text", text: "看向 " },
            {
              kind: "media_reference",
              target: targetFor(candidate),
              typePosition: 1,
              contentIndex: 1,
            },
          ],
        },
      });
    }
  });

  it("never learns a same-name choice or silently confirms after a disconnection", () => {
    const first = assetCandidate("asset-node-1", "角色.png", "asset-1");
    const second = assetCandidate("asset-node-2", "角色.png", "asset-2");
    const session = createPromptContentEditorSession([first, second]);
    session.replaceText("@角色.png");
    expect(session.confirmPending("角色.png", first)).toBe(1);
    session.pastePlainText(" 与 @角色.png");
    expect(session.read().pendingCount).toBe(1);
    session.updateConnections([first]);
    expect(session.read().pendingCount).toBe(1);
    expect(
      session.prepareGeneration({ connections: [connectionFor(first)], allowMediaOnly: false }),
    ).toMatchObject({ ok: false, issues: [{ kind: "pending_reference" }] });
    expect(session.confirmPending("角色.png", second)).toBe(0);
    expect(session.confirmPending("角色.png", first)).toBe(1);
  });

  it("keeps connection numbering and special roles when references appear in reverse order", () => {
    const first = assetCandidate("asset-node-1", "开场.png", "asset-1");
    const second = assetCandidate("asset-node-2", "结尾.png", "asset-2");
    const session = createPromptContentEditorSession([first, second]);
    session.replaceText("@图片2 @图片1 @图片2");
    const prepared = session.prepareGeneration({
      connections: [
        { ...connectionFor(first), role: "first_frame" },
        { ...connectionFor(second), role: "last_frame" },
      ],
      allowMediaOnly: false,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      prepared.frozen.segments
        .filter((segment) => segment.kind === "media_reference")
        .map((segment) => segment.typePosition),
    ).toEqual([2, 1, 2]);
    expect(prepared.frozen.explicitMedia).toMatchObject([
      { target: targetFor(first), role: "first_frame", typePosition: 1, contentIndex: 1 },
      { target: targetFor(second), role: "last_frame", typePosition: 2, contentIndex: 2 },
    ]);
    session.replaceText("之后的提示词");
    expect(
      prepared.frozen.segments.filter((segment) => segment.kind === "media_reference"),
    ).toHaveLength(3);
  });

  it("round-trips local-file references through editor, saved document, and submission", () => {
    const candidate: PromptReferenceCandidate = {
      ...assetCandidate("frame-1"),
      referenceKind: "local_file",
      source: "local",
      providerConnectionId: "",
      assetId: "C:\\frames\\frame.png",
    };
    const target: MediaReferenceTarget = {
      kind: "local_file",
      path: candidate.assetId,
      mediaType: "image",
      canvasNodeKey: candidate.canvasNodeKey,
    };
    const session = createPromptContentEditorSession([candidate]);
    session.attach(document.createElement("div"));
    session.insertReference(candidate);
    const snapshot = session.snapshot();
    expect(decodePromptContentDocument(snapshot)).toEqual(snapshot);
    session.attach(null);
    session.restore(snapshot);
    session.attach(document.createElement("div"));
    expect(
      session.prepareGeneration({
        connections: [
          { key: candidate.canvasNodeKey, name: candidate.name, kind: candidate.kind, target },
        ],
        allowMediaOnly: false,
      }),
    ).toMatchObject({ ok: true, frozen: { segments: [{ kind: "media_reference", target }] } });
    expect(
      session.prepareGeneration({
        connections: [
          {
            key: candidate.canvasNodeKey,
            name: candidate.name,
            kind: candidate.kind,
            target: { ...target, path: "C:\\frames\\different.png" },
          },
        ],
        allowMediaOnly: false,
      }),
    ).toMatchObject({ ok: false, issues: [{ kind: "reference_identity_changed" }] });
    session.attach(null);
  });

  it("turns a unique connected name into an ordered canonical media reference", () => {
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    const element = document.createElement("div");
    session.attach(element);

    expect(session.replaceText("让 @角色.png 看向镜头")).toMatchObject({
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

    expect(session.replaceText("@角色.png 与 @角色.png")).toMatchObject({
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
    expect(session.confirmPending("角色.png", option.candidate)).toBe(2);
    expect(session.snapshot().items.filter((item) => item.kind === "media_reference")).toHaveLength(
      2,
    );
  });

  it("freezes every connected instance once and keeps prompt references separate", () => {
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
        explicitMedia: [
          { target: { canvasNodeKey: "asset-node-1" } },
          { target: { canvasNodeKey: "asset-node-2" } },
        ],
      },
    });
  });

  it("passes an explicit role through to unmentioned explicit media", () => {
    const candidate = assetCandidate("asset-node-9", "晨雾海岸.png", "asset-frame");
    const session = createPromptContentEditorSession([candidate]);
    session.attach(document.createElement("div"));

    const prepared = session.prepareGeneration({
      connections: [{ ...connectionFor(candidate), role: "first_frame" }],
      allowMediaOnly: true,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.ok && prepared.frozen.explicitMedia).toEqual([
      {
        target: {
          kind: "asset",
          providerConnectionId: "provider-1",
          assetId: "asset-frame",
          canvasNodeKey: "asset-node-9",
          mediaType: "image",
        },
        role: "first_frame",
        displayNameSnapshot: "晨雾海岸.png",
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
  });

  it("carries url targets as explicit media with file/link role", () => {
    const session = createPromptContentEditorSession([]);
    session.attach(document.createElement("div"));

    const prepared = session.prepareGeneration({
      connections: [
        {
          key: "url:url-1",
          name: "网页链接",
          kind: "image",
          target: { kind: "url", url: "https://example.com/public-article", mediaType: "image" },
          role: "link",
        },
      ],
      allowMediaOnly: true,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.ok && prepared.frozen.explicitMedia).toMatchObject([
      {
        target: { kind: "url", url: "https://example.com/public-article", mediaType: "image" },
        role: "link",
        displayNameSnapshot: "网页链接",
      },
    ]);
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

  it("mounts a V1 snapshot as Tiptap content with an atomic media reference", () => {
    const candidate = assetCandidate("asset-node-1");
    const persisted: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "参考 " },
        {
          kind: "media_reference",
          mentionId: "mention-persisted",
          canvasNodeKey: candidate.canvasNodeKey,
          target: targetFor(candidate),
          displayNameSnapshot: candidate.name,
        },
        { kind: "text", text: "\n继续运镜" },
      ],
    };
    const session = createPromptContentEditorSession([candidate]);
    session.restore(persisted);
    const host = document.createElement("div");
    session.attach(host);

    const editor = host.querySelector<HTMLElement>(".ProseMirror[contenteditable='true']");
    const reference = host.querySelector<HTMLElement>("[data-mention-id='mention-persisted']");
    expect(editor).not.toBeNull();
    expect(reference).toHaveAttribute("contenteditable", "false");
    expect(reference).toHaveAttribute("data-canvas-node-key", "asset-node-1");
    expect(reference).toHaveTextContent("@角色.png");
    expect(session.snapshot()).toEqual(persisted);
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
    const candidate: PromptReferenceCandidate = {
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

  it("applies an upstream change to a restored node before its editor first mounts", () => {
    const candidate = assetCandidate("asset-node-1");
    const module = createPromptContentModule();
    module.restoreAll({
      offscreen: {
        schema: "prompt-content",
        version: 1,
        items: [{ kind: "text", text: "旧输出" }],
      },
    });
    expect(module.replaceText("offscreen", "新输出 @图片1", [candidate])).toMatchObject({
      converted: 1,
    });
    const editor = createPromptContentEditorSession([candidate]);
    module.adoptEditor("offscreen", editor);
    expect(editor.read().plainText).toBe("新输出 @角色.png");
    expect(module.snapshotAll()["offscreen"]?.items).toMatchObject([
      { kind: "text", text: "新输出 " },
      { kind: "media_reference", canvasNodeKey: candidate.canvasNodeKey },
    ]);
  });

  it("does not rebuild the editor DOM when auto-resolve changes nothing", () => {
    // 回归：输入中文等与任何素材名都不匹配的文本时，自动识别不应触发 setContent
    // 重建整个编辑器 DOM。重建会打断 IME 组合（拼音被打散成错乱字符）并重置光标。
    const session = createPromptContentEditorSession();
    const element = document.createElement("div");
    session.attach(element);
    session.replaceText("普通中文内容，不匹配任何素材名");

    const editor = element.querySelector<HTMLElement>(".ProseMirror");
    expect(editor).not.toBeNull();
    const paragraph = editor!.querySelector("p");
    const textNodeBefore = paragraph?.firstChild;
    const domBefore = editor!.innerHTML;

    expect(session.autoResolve({ fresh: true })).toMatchObject({
      converted: 0,
      ambiguous: 0,
      pending: 0,
    });

    // 内容没有变化，编辑器 DOM 不应被替换重建（text node 引用必须保持不变）。
    expect(editor!.innerHTML).toBe(domBefore);
    expect(editor!.querySelector("p")?.firstChild).toBe(textNodeBefore);
  });

  it("keeps multiple native paragraphs and the caret untouched when nothing matches", () => {
    const session = createPromptContentEditorSession([assetCandidate("asset-node-1")]);
    const host = document.createElement("div");
    document.body.append(host);
    session.attach(host);
    const input = host.querySelector<HTMLElement>(".ProseMirror")!;
    input.innerHTML = "<p>第一段普通文字</p><p>第二段继续写作</p>";
    session.acceptNativeInput();
    const paragraphs = [...input.querySelectorAll("p")];
    const text = paragraphs[1]!.firstChild!;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(text, 3, text, 3);
    expect(session.autoResolve()).toMatchObject({ converted: 0, ambiguous: 0 });
    session.updateConnections([]);
    expect([...input.querySelectorAll("p")]).toEqual(paragraphs);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(3);
    session.attach(null);
    host.remove();
  });

  it("does not put disconnected presentation updates in undo history", () => {
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    const host = document.createElement("div");
    document.body.append(host);
    session.attach(host);
    session.insertReference(candidate);
    session.pastePlainText("尾句");
    session.updateConnections([]);
    const input = host.querySelector<HTMLElement>(".ProseMirror")!;
    expect(input.querySelector("[data-mention-id]")).toHaveClass("is-stale");
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(session.acceptNativeInput().plainText).not.toContain("尾句");
    session.attach(null);
    host.remove();
  });

  it("素材节点被删除后重连同名素材：引用原地重连并从灰化恢复", () => {
    const original = assetCandidate("asset-node-1", "角色.png", "asset-1");
    const session = createPromptContentEditorSession([original]);
    const host = document.createElement("div");
    document.body.append(host);
    session.attach(host);
    session.insertReference(original);
    const reference = session.snapshot().items[0]!;
    expect(reference).toMatchObject({ kind: "media_reference", canvasNodeKey: "asset-node-1" });
    if (reference.kind !== "media_reference") throw new Error("引用未插入");

    // 原素材节点被删除，用户重新连上一份同名素材（新实例、新上传 job）。
    const replacement = assetCandidate("asset-node-9", "角色.png", "staging-9");
    expect(
      session.updateConnections([replacement], {
        aliveCanvasNodeKeys: new Set(["asset-node-9"]),
      }),
    ).toMatchObject([{ canvasNodeKey: "asset-node-9", matchedBy: "name" }]);

    const rebound = session.snapshot().items[0]!;
    // mentionId 不变：DOM 身份、撤销栈与已验证的选择都不被打断，只有实例身份换新。
    expect(rebound).toMatchObject({
      kind: "media_reference",
      mentionId: reference.mentionId,
      canvasNodeKey: "asset-node-9",
      target: { kind: "asset", assetId: "staging-9", canvasNodeKey: "asset-node-9" },
    });
    const chip = host.querySelector<HTMLElement>(".ProseMirror [data-mention-id]")!;
    expect(chip).not.toHaveClass("is-stale");
    // 重连成功的引用按「刚识别到」闪一次高亮，用户能看见是哪一处自愈了。
    expect(chip).toHaveClass("is-fresh");
    expect(
      session.prepareGeneration({
        connections: [connectionFor(replacement)],
        allowMediaOnly: false,
      }),
    ).toMatchObject({ ok: true });
    session.attach(null);
    host.remove();
  });

  it("换图：位置快照随存档往返后仍能认出替换关系", () => {
    // 第 1 位放着旧图；用户把这一处的图换掉（解绑 + 连上新图）。
    const oldImage = { ...assetCandidate("asset-old", "旧图.png", "asset-old"), slotIndex: 0 };
    const session = createPromptContentEditorSession([oldImage]);
    const host = document.createElement("div");
    document.body.append(host);
    session.attach(host);
    session.insertReference(oldImage);
    // 引用记下了自己占的位置，并随编辑器文档往返保留。
    expect(session.snapshot().items[0]).toMatchObject({ slotSnapshot: 0 });
    session.attach(null);

    const restored = createPromptContentEditorSession([]);
    restored.restore(session.snapshot());
    const restoredHost = document.createElement("div");
    document.body.append(restoredHost);
    restored.attach(restoredHost);
    expect(restored.snapshot().items[0]).toMatchObject({ slotSnapshot: 0 });

    const newImage = { ...assetCandidate("asset-new", "新图.png", "asset-new"), slotIndex: 0 };
    expect(
      restored.updateConnections([newImage], {
        // 旧图节点仍在画布上（换图是解绑 + 连接，不是删节点）。
        aliveCanvasNodeKeys: new Set(["asset-old", "asset-new"]),
      }),
    ).toMatchObject([{ canvasNodeKey: "asset-new", matchedBy: "slot" }]);
    expect(restored.snapshot().items[0]).toMatchObject({
      canvasNodeKey: "asset-new",
      displayNameSnapshot: "新图.png",
      slotSnapshot: 0,
    });
    restored.attach(null);
    restoredHost.remove();
    host.remove();
  });

  it("重排只刷新已连接 @ 引用的位置；后续换图按新位置匹配", () => {
    const first = { ...assetCandidate("asset-first", "第一张.png", "asset-first"), slotIndex: 0 };
    const second = {
      ...assetCandidate("asset-second", "第二张.png", "asset-second"),
      slotIndex: 1,
    };
    const third = { ...assetCandidate("asset-third", "第三张.png", "asset-third"), slotIndex: 2 };
    const session = createPromptContentEditorSession([first, second, third]);
    const host = document.createElement("div");
    document.body.append(host);
    session.attach(host);
    session.insertReference(first);
    session.pastePlainText(" 的姿态");
    const original = session.snapshot().items[0];
    if (original?.kind !== "media_reference") throw new Error("引用未插入");
    const paragraph = host.querySelector(".ProseMirror p");
    const textNode = paragraph?.lastChild;
    const reordered = [
      { ...second, slotIndex: 0 },
      { ...third, slotIndex: 1 },
      { ...first, slotIndex: 2 },
    ];

    expect(
      session.updateConnections(reordered, {
        aliveCanvasNodeKeys: new Set(["asset-first", "asset-second", "asset-third"]),
      }),
    ).toEqual([]);
    expect(session.snapshot().items[0]).toMatchObject({
      mentionId: original.mentionId,
      canvasNodeKey: original.canvasNodeKey,
      target: original.target,
      slotSnapshot: 2,
      aliasSnapshot: "图片3",
    });
    expect(host.querySelector(".ProseMirror p")).toBe(paragraph);
    expect(paragraph?.lastChild).toBe(textNode);
    const chip = host.querySelector(`[data-mention-id="${original.mentionId}"]`);
    session.updateConnections(reordered);
    expect(host.querySelector(`[data-mention-id="${original.mentionId}"]`)).toBe(chip);

    const replacement = {
      ...assetCandidate("asset-new", "新图.png", "asset-new"),
      slotIndex: 2,
    };
    expect(
      session.updateConnections([reordered[0]!, reordered[1]!, replacement], {
        aliveCanvasNodeKeys: new Set(["asset-first", "asset-second", "asset-third", "asset-new"]),
      }),
    ).toMatchObject([{ canvasNodeKey: "asset-new", matchedBy: "slot" }]);
    expect(session.snapshot().items[0]).toMatchObject({
      mentionId: original.mentionId,
      canvasNodeKey: "asset-new",
      target: targetFor(replacement),
      slotSnapshot: 2,
    });
    session.attach(null);
    host.remove();
  });

  it("只是解除连线时保持灰化，不按同名素材改绑", () => {
    const first = assetCandidate("asset-node-1");
    const second = assetCandidate("asset-node-2");
    const session = createPromptContentEditorSession([first, second]);
    session.replaceText("@图片1");
    expect(session.read().referenceCount).toBe(1);

    // 两个节点都还在画布上，只是第一个被解除了连线：这是用户明确的选择，交给他处理。
    expect(
      session.updateConnections([second], {
        aliveCanvasNodeKeys: new Set(["asset-node-1", "asset-node-2"]),
      }),
    ).toEqual([]);
    expect(session.read().issues).toMatchObject([
      { kind: "disconnected_reference", canvasNodeKey: "asset-node-1" },
    ]);
  });

  it("still converts a typed connected name into a mention chip via auto-resolve", () => {
    // 功能不回归：手输匹配素材名时，auto-resolve 仍应把纯文本转成引用 chip。
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    const element = document.createElement("div");
    session.attach(element);
    session.restore({
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "让 @角色.png 看向镜头" }],
    });

    expect(session.autoResolve({ fresh: true })).toMatchObject({
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
      },
      { kind: "text", text: " 看向镜头" },
    ]);
  });

  it("recognizes a typed 参考图N reference alias as a mention chip", () => {
    // 用户手写「参考图1」参考语义别名时，应同「图片1」一样自动识别为媒体引用。
    const first = assetCandidate("asset-node-1", "角色.png", "asset-1");
    const second = assetCandidate("asset-node-2", "背景.png", "asset-2");
    const session = createPromptContentEditorSession([first, second]);
    const element = document.createElement("div");
    session.attach(element);
    session.restore({
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "让 @参考图1 跟随 @参考图2 移动" }],
    });

    expect(session.autoResolve({ fresh: true })).toMatchObject({
      converted: 2,
      ambiguous: 0,
      pending: 0,
    });
    const references = session.snapshot().items.filter((item) => item.kind === "media_reference");
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      kind: "media_reference",
      canvasNodeKey: "asset-node-1",
      target: { assetId: "asset-1" },
    });
    expect(references[1]).toMatchObject({
      kind: "media_reference",
      canvasNodeKey: "asset-node-2",
      target: { assetId: "asset-2" },
    });
  });

  it("recognizes a typed 图N short alias as a mention chip", () => {
    // 用户手写「图1」这类短别名时，也应自动识别为媒体引用。
    const first = assetCandidate("asset-node-1", "角色.png", "asset-1");
    const second = assetCandidate("asset-node-2", "背景.png", "asset-2");
    const session = createPromptContentEditorSession([first, second]);
    const element = document.createElement("div");
    session.attach(element);
    session.restore({
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "让 @图1 跟随 @图2 移动" }],
    });

    expect(session.autoResolve({ fresh: true })).toMatchObject({
      converted: 2,
      ambiguous: 0,
      pending: 0,
    });
    const references = session.snapshot().items.filter((item) => item.kind === "media_reference");
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      kind: "media_reference",
      canvasNodeKey: "asset-node-1",
      target: { assetId: "asset-1" },
    });
    expect(references[1]).toMatchObject({
      kind: "media_reference",
      canvasNodeKey: "asset-node-2",
      target: { assetId: "asset-2" },
    });
  });

  it("converts a typed full-width ＠ reference like the ASCII @", () => {
    // 回归：中文输入法（尤其 macOS）会把 Shift+2 提交成全角 "＠"，它和 "@" 是同义的引用标记，
    // 转成 chip 时也不该把全角标记留在正文里。
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    session.replaceText("开场 ＠图片1 收尾");

    expect(session.read().referenceCount).toBe(1);
    expect(session.snapshot().items).toMatchObject([
      { kind: "text", text: "开场 " },
      { kind: "media_reference", canvasNodeKey: "asset-node-1" },
      { kind: "text", text: " 收尾" },
    ]);
    expect(session.read().plainText).not.toContain("＠");
  });

  it("converts a typed @别名 split across text items into one mention chip", () => {
    // 回归：手打 @ 后 IME 输入中文时，@ 与别名可能落在不同的文本项/文本节点里，
    // auto-resolve 仍应把「@图片1」整体转成单个引用 chip，且不残留多余的 @。
    const candidate = assetCandidate("asset-node-1");
    const session = createPromptContentEditorSession([candidate]);
    const element = document.createElement("div");
    session.attach(element);
    session.restore({
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "开场 " },
        { kind: "text", text: "@" },
        { kind: "text", text: "图片1" },
      ],
    });

    expect(session.autoResolve({ fresh: true })).toMatchObject({
      converted: 1,
      ambiguous: 0,
      pending: 0,
    });
    const items = session.snapshot().items;
    expect(items).toMatchObject([
      { kind: "text", text: "开场 " },
      {
        kind: "media_reference",
        canvasNodeKey: "asset-node-1",
        displayNameSnapshot: "角色.png",
      },
    ]);
    const plainText = items
      .filter((item) => item.kind === "text")
      .map((item) => (item as { text: string }).text)
      .join("");
    expect(plainText).not.toContain("@@");
    expect(plainText).not.toContain("@");
  });
});

describe("cleanGeneratedPrompt", () => {
  it("移除正文之后的「无需额外补问」类附加说明段落", () => {
    const input = [
      "生成一张16:9横版高清电影制作板，主题为「艾莉丝·伯雷亚斯·格雷拉特 剑士修炼记录」。",
      "整体呈现写实奇幻电影前期制作板风格，布局简洁、分区明确。",
      "",
      "无需额外补问，角色外观、风格与修炼主题均已依据参考图完成设定，可直接用于生成制作板图片。",
    ].join("\n\n");
    const result = cleanGeneratedPrompt(input);
    expect(result).not.toContain("无需额外补问");
    expect(result).not.toContain("可直接用于生成");
    expect(result).toContain("生成一张16:9横版高清电影制作板");
    expect(result).toContain("整体呈现写实奇幻电影前期制作板风格");
  });

  it("不移除正文内容，即使正文较长", () => {
    const input = [
      "第一段正文内容，描述画面主体与氛围。",
      "第二段正文内容，描述镜头与构图。",
      "第三段正文内容，描述灯光与色彩。",
    ].join("\n\n");
    const result = cleanGeneratedPrompt(input);
    expect(result).toBe(input);
  });

  it("移除段落开头的省略号（三点号）", () => {
    const input = "……正文内容开始。\n\n…另一段正文。";
    const result = cleanGeneratedPrompt(input);
    expect(result).not.toMatch(/^[…。.]/);
    expect(result).toContain("正文内容开始");
    expect(result).toContain("另一段正文");
  });

  it("连续多个附加说明段落都移除", () => {
    const input = ["正文内容。", "", "注：以上内容仅供参考。", "", "希望对你有帮助。"].join("\n\n");
    const result = cleanGeneratedPrompt(input);
    expect(result).toBe("正文内容。");
  });

  it("空字符串返回空字符串", () => {
    expect(cleanGeneratedPrompt("")).toBe("");
  });

  it("单段正文命中附加说明前缀时仍保留，避免提示词被清空", () => {
    const input = "根据参考图，一位女孩站在雨夜里，电影感侧光。";
    expect(cleanGeneratedPrompt(input)).toBe(input);
  });

  it("多段附加说明剥到只剩一段时停止，结果不为空", () => {
    const input = ["无需额外补问。", "", "希望对你有帮助。"].join("\n\n");
    expect(cleanGeneratedPrompt(input)).toBe("无需额外补问。");
  });
});

describe("prompt content annotation references", () => {
  const markedRegion = (markId: string, label: string, description: string) => ({
    markId,
    label,
    description,
    color: "#ff4865",
  });

  it("counts a region reference as text, not as a media reference that needs a connection", () => {
    const session = createPromptContentEditorSession();
    session.insertMarkReference(markedRegion("mark-a", "标注1", "红色框选，画面左侧 25%"));
    const view = session.read();
    expect(view.referenceCount).toBe(0);
    expect(view.issues).toEqual([]);
    expect(view.plainText).toBe("标注1（红色框选，画面左侧 25%）");
    expect(view.segments).toEqual([{ kind: "text", text: "标注1（红色框选，画面左侧 25%）" }]);
  });

  it("removes the references of a deleted region and keeps numbering out of the document", () => {
    const session = createPromptContentEditorSession();
    session.replaceText("把 ");
    session.insertMarkReference(markedRegion("mark-a", "标注1", "红色框选 A"));
    session.insertMarkReference(markedRegion("mark-b", "标注2", "蓝色框选 B"));
    expect(session.removeMarkReferences(["mark-a"])).toBe(1);
    expect(session.removeMarkReferences(["mark-a"])).toBe(0);
    expect(session.read().plainText).toBe("把 标注2（蓝色框选 B）");
    // 展示编号由渲染层提供：文档里保留插入时的快照，导出时才换成最新编号。
    session.updateMarkReferencePresentation(
      new Map([["mark-b", { label: "标注1", frameLabel: "0:02.00" }]]),
    );
    expect(session.snapshot().items).toMatchObject([
      { kind: "text", text: "把 " },
      { kind: "mark_reference", markId: "mark-b", labelSnapshot: "标注2" },
    ]);
  });

  it("rejects a document whose reference identities stopped being addressable", () => {
    const reference = {
      kind: "mark_reference" as const,
      mentionId: "mention-1",
      markId: "mark-a",
      labelSnapshot: "标注1",
      descriptionSnapshot: "红色框选",
      color: "#ff4865",
    };
    const document: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "把 " }, reference],
    };
    expect(decodePromptContentDocument(document)).toEqual(document);
    expect(
      decodePromptContentDocument({ ...document, items: [reference, { ...reference }] }),
    ).toBeNull();
  });
});
