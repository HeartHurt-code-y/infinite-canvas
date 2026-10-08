import { useState } from "react";
import { formatRawBackendError } from "../../lib/backend";
import { validateArtifactName } from "./artifactNames";
import "./NodeNameEditor.css";

export function NodeNameEditor({
  name,
  label,
  onSave,
}: {
  readonly name: string;
  readonly label: string;
  readonly onSave: (name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    const validation = validateArtifactName(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
      setError(null);
    } catch (failure) {
      setError(formatRawBackendError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span
      className="node-name-editor nodrag nopan nowheel"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {editing ? (
        <>
          <input
            autoFocus
            aria-label={label}
            value={draft}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setError(null);
              }
            }}
          />
          <button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存名称"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            取消
          </button>
          {error ? (
            <span className="node-name-editor__error" role="alert">
              {error}
            </span>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          aria-label={label}
          title="修改名称，导出文件沿用此名称"
          onClick={() => {
            setDraft(name);
            setError(null);
            setEditing(true);
          }}
        >
          改名
        </button>
      )}
    </span>
  );
}
