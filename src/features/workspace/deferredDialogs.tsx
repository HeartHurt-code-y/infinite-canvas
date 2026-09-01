import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { X } from "@phosphor-icons/react/X";
import { lazy } from "react";
import { loadHistoryDialog, loadProviderSettingsDialog } from "./deferredDialogLoaders";

export const HistoryDialog = lazy(() =>
  loadHistoryDialog().then((module) => ({ default: module.HistoryDialog })),
);
export const ProviderSettingsDialog = lazy(() =>
  loadProviderSettingsDialog().then((module) => ({ default: module.ProviderSettingsDialog })),
);

export function DeferredDialogFallback({
  id,
  label,
  onClose,
}: {
  readonly id: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const titleId = `${id}-loading-title`;
  return (
    <div className="settings-layer">
      <button
        type="button"
        className="settings-backdrop"
        aria-label={`关闭${label}`}
        onClick={onClose}
      />
      <section
        id={id}
        className="settings-dialog deferred-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="settings-dialog__header">
          <span className="settings-dialog__eyebrow">
            <CircleNotch size={14} weight="bold" aria-hidden="true" data-spin="true" />
            按需加载
          </span>
          <h2 id={titleId}>正在加载{label}…</h2>
          <p>首次打开需要加载对应功能模块，后续打开会直接复用。</p>
          <button
            type="button"
            className="settings-dialog__close"
            aria-label={`关闭${label}`}
            onClick={onClose}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </header>
      </section>
    </div>
  );
}
