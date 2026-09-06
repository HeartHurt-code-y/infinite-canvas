import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  createPromptContentModule,
  type PromptContentEditorSession,
} from "../../lib/promptContent";
import { PromptMentionInput } from "./PromptNodeViews";
import type { MentionCandidate } from "./workspaceModel";

const NODE_KEY = "ime-prompt";

function mountPrompt(initialText = "", candidates: readonly MentionCandidate[] = []) {
  const module = createPromptContentModule();
  let session: PromptContentEditorSession | null = null;
  if (initialText) module.restoreAll({ [NODE_KEY]: initialText });
  const registerInput = (nodeKey: string, editorSession: PromptContentEditorSession | null) => {
    if (editorSession != null) session = editorSession;
    module.adoptEditor(nodeKey, editorSession);
  };
  const { rerender } = render(
    <PromptMentionInput nodeKey={NODE_KEY} candidates={candidates} registerInput={registerInput} />,
  );
  const input = screen.getByRole<HTMLDivElement>("textbox", {
    name: "提示词输入框，输入 @ 引用素材",
  });
  const readSession = () => {
    if (session == null) throw new Error("The actual Tiptap session was not registered");
    return session;
  };
  const updateCandidates = (next: readonly MentionCandidate[]) =>
    rerender(
      <PromptMentionInput nodeKey={NODE_KEY} candidates={next} registerInput={registerInput} />,
    );
  return { input, module, readSession, updateCandidates };
}

function setCaret(text: Text, offset: number) {
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * jsdom has no operating-system IME. Keep the real Tiptap view, DOMObserver,
 * composition events and React handlers; only emulate the browser's text mutation.
 */
async function compositionMutation(input: HTMLDivElement, text: Text, value: string) {
  await act(async () => {
    text.data = value;
    setCaret(text, value.length);
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: value,
        isComposing: true,
      }),
    );
    await Promise.resolve();
  });
}

describe("PromptMentionInput Tiptap IME regression", () => {
  const referenceCandidate: MentionCandidate = {
    canvasNodeKey: "reference-image",
    assetId: "asset-reference",
    providerConnectionId: "project-provider",
    name: "角色.png",
    kind: "image",
  };

  it.each(["click", "keyboard"] as const)(
    "preserves preceding @ text when choosing from the button menu with %s",
    (method) => {
      const { input, readSession } = mountPrompt("保留@旧正文\n下一段", [referenceCandidate]);
      fireEvent.click(screen.getByRole("button", { name: "引用素材到提示词（候选 1 个）" }));
      if (method === "click") fireEvent.click(screen.getByRole("option"));
      else fireEvent.keyDown(input, { key: "Enter" });
      expect(readSession().snapshot().items).toMatchObject([
        { kind: "text", text: "保留@旧正文\n下一段" },
        { kind: "media_reference", canvasNodeKey: "reference-image" },
      ]);
    },
  );

  it.each(["图片1", "参考图1", "图1"])(
    "searches and replaces the typed @%s through the shared candidate rules",
    async (alias) => {
      const { input, readSession } = mountPrompt("@", [referenceCandidate]);
      const text = input.querySelector("p")!.firstChild as Text;
      setCaret(text, 1);
      fireEvent.keyDown(input, { key: "@" });
      await screen.findByRole("listbox", { name: "素材引用候选" });
      text.data = `@${alias}`;
      setCaret(text, text.length);
      fireEvent.input(input);
      expect(screen.getByRole("option")).toHaveTextContent("角色.png");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(readSession().snapshot().items).toMatchObject([
        { kind: "media_reference", canvasNodeKey: "reference-image" },
      ]);
      expect(readSession().snapshot().items).toHaveLength(1);
    },
  );

  it("inserts a button-selected reference at the existing caret", () => {
    const { input, readSession } = mountPrompt("前后", [referenceCandidate]);
    input.focus();
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, 1);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "引用素材到提示词（候选 1 个）" }));
    fireEvent.click(screen.getByRole("option"));
    expect(readSession().snapshot().items).toMatchObject([
      { kind: "text", text: "前" },
      { kind: "media_reference", canvasNodeKey: "reference-image" },
      { kind: "text", text: "后" },
    ]);
  });

  it("closes an empty candidate menu with Escape and preserves the unknown @ text", async () => {
    const { input, readSession } = mountPrompt("@", [referenceCandidate]);
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, 1);
    fireEvent.keyDown(input, { key: "@" });
    await screen.findByRole("listbox", { name: "素材引用候选" });
    text.data = "@不存在的素材";
    setCaret(text, text.length);
    fireEvent.input(input);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "素材引用候选" })).not.toBeInTheDocument();
    expect(readSession().snapshot().items).toEqual([{ kind: "text", text: "@不存在的素材" }]);
  });

  it("keeps IME drafts out of the persisted prompt and commits 日本 exactly once", async () => {
    const { input, module, readSession } = mountPrompt();
    input.focus();
    fireEvent.compositionStart(input);
    const paragraph = input.querySelector("p")!;
    const compositionText = document.createTextNode("");
    paragraph.prepend(compositionText);
    setCaret(compositionText, 0);

    const persistedDrafts: string[] = [];
    for (const draft of ["r", "ri", "ri'b", "ri'be", "ri'ben"]) {
      await compositionMutation(input, compositionText, draft);
      // The canvas snapshots this module; it must observe the last committed value.
      module.snapshotAll();
      persistedDrafts.push(module.read(NODE_KEY)?.plainText ?? "");
    }

    await compositionMutation(input, compositionText, "日本");
    fireEvent.compositionEnd(input, { data: "日本" });
    fireEvent.input(input, {
      inputType: "insertText",
      data: "日本",
      isComposing: false,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(persistedDrafts).toEqual(["", "", "", "", ""]);
    expect(input).toHaveTextContent(/^日本$/);
    expect(readSession().snapshot().items).toEqual([{ kind: "text", text: "日本" }]);
  });

  it("leaves mention candidates unchanged until the IME query is committed", async () => {
    const candidate: MentionCandidate = {
      canvasNodeKey: "japan-image",
      assetId: "asset-japan",
      providerConnectionId: "project-provider",
      name: "日本.png",
      kind: "image",
    };
    const { input, module } = mountPrompt("@", [candidate]);
    fireEvent.click(screen.getByRole("button", { name: "引用素材到提示词（候选 1 个）" }));
    const option = screen.getByRole("option");
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, 1);
    fireEvent.compositionStart(input);
    await compositionMutation(input, text, "@ri'ben");

    expect(option).toBeInTheDocument();
    expect(module.snapshotAll()[NODE_KEY]?.items).toEqual([{ kind: "text", text: "@" }]);

    await compositionMutation(input, text, "@日本");
    fireEvent.compositionEnd(input, { data: "日本" });
    fireEvent.input(input, { inputType: "insertText", data: "日本", isComposing: false });
    expect(input).toHaveTextContent(/^@日本$/);
    expect(screen.getByRole("option")).toHaveTextContent("日本.png");
  });

  it("keeps pending references explicit after a connection changes during IME", async () => {
    const first: MentionCandidate = {
      canvasNodeKey: "image-first",
      assetId: "asset-first",
      providerConnectionId: "project-provider",
      name: "角色.png",
      kind: "image",
    };
    const second: MentionCandidate = {
      ...first,
      canvasNodeKey: "image-second",
      assetId: "asset-second",
    };
    const { input, readSession, updateCandidates } = mountPrompt("@角色.png 后", [first, second]);
    act(() => {
      readSession().autoResolve();
    });
    const pending = input.querySelector("[data-ambiguous-pattern]");
    expect(pending).toBeInTheDocument();
    input.focus();
    const text = input.querySelector("p")!.lastChild as Text;
    setCaret(text, text.length);
    fireEvent.compositionStart(input);
    await compositionMutation(input, text, " 后ri");
    updateCandidates([first]);

    expect(pending).toBeInTheDocument();
    expect(input.contains(text)).toBe(true);

    await compositionMutation(input, text, " 后日本");
    fireEvent.compositionEnd(input, { data: "日本" });
    fireEvent.input(input, { inputType: "insertText", data: "日本", isComposing: false });
    expect(input).toHaveTextContent("后日本");
    await waitFor(() => expect(readSession().isComposing()).toBe(false));
    expect(input.querySelector("[data-ambiguous-pattern]")).toBeInTheDocument();
    expect(readSession().snapshot().items).toEqual([
      expect.objectContaining({ kind: "pending_reference", normalizedPattern: "角色.png" }),
      { kind: "text", text: " 后日本" },
    ]);
  });

  it("keeps the caret when the parent restores an unchanged persisted document", async () => {
    const { input, module } = mountPrompt("甲乙日本丙丁");
    const user = userEvent.setup();
    input.focus();
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, 4);
    await user.keyboard("{Backspace}");
    expect(input).toHaveTextContent(/^甲乙日丙丁$/);
    const persisted = module.snapshotAll();
    const anchorNode = window.getSelection()?.anchorNode;
    const anchorOffset = window.getSelection()?.anchorOffset;

    act(() => {
      module.restoreAll(persisted);
    });

    expect(window.getSelection()?.anchorNode).toBe(anchorNode);
    expect(window.getSelection()?.anchorOffset).toBe(anchorOffset);
    await user.keyboard("{Backspace}{Backspace}");
    expect(input).toHaveTextContent(/^甲丙丁$/);
    expect(module.snapshotAll()[NODE_KEY]?.items).toEqual([{ kind: "text", text: "甲丙丁" }]);
  });

  it("maps the caret through a text-to-reference conversion before consecutive Backspace", async () => {
    const candidate: MentionCandidate = {
      canvasNodeKey: "actor-image",
      assetId: "asset-actor",
      providerConnectionId: "project-provider",
      name: "角色.png",
      kind: "image",
    };
    const { input, readSession } = mountPrompt("前 角色.png 后日本尾巴", [candidate]);
    const user = userEvent.setup();
    input.focus();
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, "前 角色.png 后日本".length);
    fireEvent(document, new Event("selectionchange"));

    act(() => {
      readSession().autoResolve({ mode: "names" });
    });

    const tail = input.querySelector("p")!.lastChild;
    expect(window.getSelection()?.anchorNode).toBe(tail);
    expect(window.getSelection()?.anchorOffset).toBe(" 后日本".length);
    await user.keyboard("{Backspace}{Backspace}");
    expect(readSession().snapshot().items).toEqual([
      { kind: "text", text: "前 " },
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "actor-image" }),
      { kind: "text", text: " 后尾巴" },
    ]);
  });

  it("preserves the caret between two independently converted references", async () => {
    const first: MentionCandidate = {
      canvasNodeKey: "actor-image",
      assetId: "asset-actor",
      providerConnectionId: "project-provider",
      name: "角色.png",
      kind: "image",
    };
    const second: MentionCandidate = {
      ...first,
      canvasNodeKey: "scene-image",
      assetId: "asset-scene",
      name: "背景.png",
    };
    const { input, readSession } = mountPrompt("角色.png 中日本文本 背景.png", [first, second]);
    const user = userEvent.setup();
    input.focus();
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, "角色.png 中日本".length);
    fireEvent(document, new Event("selectionchange"));

    act(() => {
      readSession().autoResolve({ mode: "names" });
    });

    const middle = Array.from(input.querySelector("p")!.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent === " 中日本文本 ",
    );
    expect(window.getSelection()?.anchorNode).toBe(middle);
    expect(window.getSelection()?.anchorOffset).toBe(" 中日本".length);
    await user.keyboard("{Backspace}{Backspace}");
    expect(readSession().snapshot().items).toEqual([
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "actor-image" }),
      { kind: "text", text: " 中文本 " },
      expect.objectContaining({ kind: "media_reference", canvasNodeKey: "scene-image" }),
    ]);
  });

  it("cancels an older deferred restore when the parent echoes the committed value", async () => {
    const { input, module, readSession } = mountPrompt("原稿");
    const committed = module.snapshotAll();
    input.focus();
    const text = input.querySelector("p")!.firstChild as Text;
    setCaret(text, text.length);
    fireEvent.compositionStart(input);
    await compositionMutation(input, text, "原稿ri");
    act(() => {
      module.restoreAll({ [NODE_KEY]: "过时的外部稿" });
      module.restoreAll(committed);
    });

    await compositionMutation(input, text, "原稿日本");
    fireEvent.compositionEnd(input, { data: "日本" });
    fireEvent.input(input, { inputType: "insertText", data: "日本", isComposing: false });
    await waitFor(() => {
      expect(readSession().isComposing()).toBe(false);
    });

    expect(input).toHaveTextContent(/^原稿日本$/);
    expect(module.snapshotAll()[NODE_KEY]?.items).toEqual([{ kind: "text", text: "原稿日本" }]);
  });
});
