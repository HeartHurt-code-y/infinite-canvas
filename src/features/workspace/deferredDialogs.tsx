import { Icon } from "../../components/Icon";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { lazy } from "react";
import { createPortal } from "react-dom";
import {
  loadAssetGroupCreateDialog,
  loadAssetSourceDialog,
  loadHistoryDialog,
  loadProviderSettingsDialog,
  loadRealPersonAssetDialog,
} from "./deferredDialogLoaders";

export const HistoryDialog = lazy(() =>
  loadHistoryDialog().then((module) => ({ default: module.HistoryDialog })),
);
export const ProviderSettingsDialog = lazy(() =>
  loadProviderSettingsDialog().then((module) => ({ default: module.ProviderSettingsDialog })),
);
export const AssetSourceDialog = lazy(() =>
  loadAssetSourceDialog().then((module) => ({ default: module.AssetSourceDialog })),
);
export const RealPersonAssetDialog = lazy(() =>
  loadRealPersonAssetDialog().then((module) => ({ default: module.RealPersonAssetDialog })),
);
export const AssetGroupCreateDialog = lazy(() =>
  loadAssetGroupCreateDialog().then((module) => ({ default: module.AssetGroupCreateDialog })),
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
  // 模态焦点陷阱：焦点要锁在里面，Esc 关闭。
  const trap = useModalFocusTrap({ active: true, onEscape: onClose });
  /*
   * 模态一律 **portal 到 body**。
   *
   * 焦点陷阱的「冻结背景」是按 `document.body` 的**直接子节点**做的：不在弹窗
   * 自己那条分支上的顶层子树全部置 inert。模态若留在 #root 内部，#root 就在
   * 「弹窗的祖先链」上 → 整棵 #root（含画布）被豁免 → **背景根本没被冻结**，
   * 读屏与键盘仍能落到遮住的画布上。
   *
   * portal 到 body 之后，弹窗自己就是 body 的直接子节点，背景（#root）被正常
   * 冻结，语义才真正成立。`#root` 没有 transform/filter/contain，
   * 不构成 containing block，所以 `position: fixed` 的定位不受影响。
   */
  return createPortal(
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
        ref={trap.ref}
        {...trap.containerProps}
      >
        <header className="settings-dialog__header">
          <span className="settings-dialog__eyebrow">
            <Icon name="circle-notch" aria-hidden="true" data-spin="true" size="sm" />
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
            <Icon name="x" aria-hidden="true" size="lg" />
          </button>
        </header>
      </section>
    </div>,
    document.body,
  );
}
