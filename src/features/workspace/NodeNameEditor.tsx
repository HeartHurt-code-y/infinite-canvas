import { useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { formatRawBackendError, frontendLog } from "../../lib/backend";
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
  // 存原始错误对象：摘要、展开与复制统一交给 ErrorAlert，界面不再自己拼 JSON。
  const [error, setError] = useState<unknown>(null);
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
      // 原始 payload 只进日志；界面上的摘要交给 ErrorAlert。
      frontendLog("error", `[canvas] 保存节点名称失败：${formatRawBackendError(failure)}`);
      setError(failure);
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
            <span className="node-name-editor__error">
              <ErrorAlert error={error} hint="请换一个名称后重试。" />
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
