import { useEffect, useId, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CanvasScriptEditor } from "./CanvasScriptGenerator";
import { LibTVMediaIcon } from "./LibTVMediaIcon";

export function StoryboardScriptDialog({ onClose, ...editor }: ComponentProps<typeof CanvasScriptEditor> & {
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<dialog ref={dialogRef} id={`node-editor-${editor.node.key}`} className="storyboard-script-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="storyboard-script-dialog__header">
      <LibTVMediaIcon name="icon-storyboard-gen" size={20} />
      <h2 id={titleId}>分镜脚本</h2>
      <button type="button" data-tooltip="关闭分镜脚本" aria-label="关闭分镜脚本" onClick={onClose}>
        <LibTVMediaIcon name="close" size={18} />
      </button>
    </div>
    <div className="storyboard-script-dialog__body"><CanvasScriptEditor {...editor} /></div>
  </dialog>, document.body);
}
