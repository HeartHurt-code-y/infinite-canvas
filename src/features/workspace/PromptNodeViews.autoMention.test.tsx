import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createPromptContentModule,
  PROMPT_AUTO_DETECT_DEBOUNCE_MS,
  type PromptContentDocumentV1,
  type PromptContentEditorSession,
} from "../../lib/promptContent";
import { createPromptReference } from "../../lib/promptReferences";
import { PromptMentionInput } from "./PromptNodeViews";
import type { MentionCandidate } from "./workspaceModel";

const NODE_KEY = "gen-1";

const VIDEO: MentionCandidate = {
  canvasNodeKey: "video-1",
  assetId: "/media/原视频.mp4",
  providerConnectionId: "",
  source: "local",
  referenceKind: "local_file",
  kind: "video",
  name: "微信视频2026-09-08_194710_526.mp4",
};

const FRAME: MentionCandidate = {
  canvasNodeKey: "frame-1",
  assetId: "asset-42",
  providerConnectionId: "provider-1",
  source: "cloud",
  referenceKind: "asset",
  kind: "image",
  name: "微信视频2026-09-08_194710_526.mp4 · 0.000s 标注",
};

function mountPrompt(candidates: readonly MentionCandidate[]) {
  const module = createPromptContentModule();
  let session: PromptContentEditorSession | null = null;
  const registerInput = (nodeKey: string, editorSession: PromptContentEditorSession | null) => {
    if (editorSession != null) session = editorSession;
    module.adoptEditor(nodeKey, editorSession);
  };
  const view = (next: readonly MentionCandidate[]) => (
    <PromptMentionInput nodeKey={NODE_KEY} candidates={next} registerInput={registerInput} />
  );
  const { rerender } = render(view(candidates));
  const input = screen.getByRole<HTMLDivElement>("textbox", {
    name: "提示词输入框，输入 @ 引用素材",
  });
  return {
    input,
    module,
    session: () => {
      if (session == null) throw new Error("编辑器会话未注册");
      return session;
    },
    updateCandidates: (next: readonly MentionCandidate[]) => rerender(view(next)),
  };
}

/** 识别状态条（常驻提示所在的 live region）。 */
function statusStrip(): HTMLElement {
  return screen.getByRole("status");
}

/** 模拟编辑器内容变化（弹窗「添加到生成节点」与外部恢复都走这条 input 事件）。 */
function emitEditorInput(input: HTMLDivElement) {
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("提示词框的自动识别状态", () => {
  it("连线增加候选后，常驻提示按当前候选显示数量，不被旧的防抖扫描覆盖", async () => {
    // 真实场景：用户在提示词框里打过字（排了一次防抖扫描，此时只接了视频），
    // 紧接着「添加到生成节点」接上标注帧。防抖计时器闭包里仍是"1 个候选"，
    // 它落地时不能把已经变成 2 个候选的提示覆盖回 1。
    const { input, updateCandidates } = mountPrompt([VIDEO]);
    emitEditorInput(input);
    act(() => {
      updateCandidates([VIDEO, FRAME]);
    });

    // 等旧计时器（420ms 防抖）落地之后再断言终态。
    await new Promise((resolve) => setTimeout(resolve, PROMPT_AUTO_DETECT_DEBOUNCE_MS + 250));
    expect(statusStrip()).toHaveTextContent("2 个可引用素材");
    expect(statusStrip()).not.toHaveTextContent("1 个可引用素材");
  });

  it("外部写入带引用的提示内容后，常驻提示给出已引用处数", async () => {
    const { module, session } = mountPrompt([VIDEO, FRAME]);
    expect(statusStrip()).toHaveTextContent("2 个可引用素材");
    expect(statusStrip()).not.toHaveTextContent("已引用");

    // 模拟弹窗提交：把带两处引用的文档写进目标节点。
    const document: PromptContentDocumentV1 = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "视频编辑：以" },
        createPromptReference(VIDEO),
        { kind: "text", text: "为待编辑原视频。" },
        createPromptReference(FRAME),
      ],
    };
    act(() => {
      module.restoreDocument(NODE_KEY, document);
    });
    expect(session().read().referenceCount).toBe(2);

    await waitFor(() => {
      expect(statusStrip()).toHaveTextContent("已引用 2 处素材");
    });
    expect(statusStrip()).toHaveTextContent("2 个可引用素材");
  });
});
