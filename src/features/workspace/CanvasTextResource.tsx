import { useCallback, useEffect, useId, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { MarkdownView } from "../../components/MarkdownView";
import type { PromptContentEditorSession, PromptContentModule } from "../../lib/promptContent";
import { PromptMentionInput } from "./PromptNodeViews";
import { CanvasFeatureAssetPicker } from "./CanvasFeatureAssetPicker";

export function CanvasTextResource({ editor, text, contents, focus, onFocusHandled }: {
  readonly editor: ComponentProps<typeof PromptMentionInput>;
  readonly text: string;
  readonly contents: PromptContentModule;
  readonly focus: boolean;
  readonly onFocusHandled: (key: string) => void;
}) {
  const session = useRef<PromptContentEditorSession | null>(null);
  const setSession = useCallback((value: PromptContentEditorSession | null) => { session.current = value; }, []);
  useEffect(() => {
    const current = contents.read(editor.nodeKey);
    if (text && (!current || (!current.plainText && current.attachmentCount === 0))) {
      contents.replaceText(editor.nodeKey, text, editor.candidates);
    }
    if (focus && session.current?.focus()) onFocusHandled(editor.nodeKey);
  }, [contents, editor.nodeKey, editor.candidates, focus, onFocusHandled, text]);

  return <div className="canvas-text-resource nodrag nopan nowheel" onMouseDown={event => event.stopPropagation()}>
    <PromptMentionInput {...editor} placeholder="输入正文，或用 @ 引用素材" onSession={setSession} />
  </div>;
}

export function CanvasTextReading({ text }: { readonly text: string }) {
  return <div className="canvas-text-reading"><MarkdownView content={text} /></div>;
}

export function CanvasTextImagePicker({ onBack, ...props }: Omit<ComponentProps<typeof CanvasFeatureAssetPicker>, "kind" | "titleId">) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={ref} className="canvas-text-image-picker" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onBack(); }}>
    <CanvasFeatureAssetPicker {...props} kind="image" titleId={titleId} onBack={onBack} />
  </dialog>, document.body);
}
