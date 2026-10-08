import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatRawBackendError, isDesktopRuntime } from "../../lib/backend";
import {
  isRuntimeComponentFeature,
  publishRuntimeComponentsChanged,
  runtimeComponentsClient,
  type RuntimeComponentId,
  type RuntimeComponentManagerStatus,
  type RuntimeComponentTransfer,
  type RuntimeFeatureStatus,
} from "../../lib/runtimeComponents";
import "./RuntimeComponentsPanel.css";

export interface RuntimeComponentsPanelProps {
  readonly onClose: () => void;
  readonly initialFeatureId?: string | null;
}

const PHASE_LABELS: Record<RuntimeComponentTransfer["phase"], string> = {
  idle: "等待安装",
  downloading: "正在下载",
  verifying: "正在校验",
  extracting: "正在解包",
  installing: "正在安装",
  ready: "组件已就绪",
  cancelled: "已取消，下载进度已保留",
  error: "安装失败",
};

function formatComponentBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function RuntimeComponentsPanel({ onClose, initialFeatureId }: RuntimeComponentsPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const desktop = isDesktopRuntime();
  const featureId = isRuntimeComponentFeature(initialFeatureId) ? initialFeatureId : null;
  const [status, setStatus] = useState<RuntimeComponentManagerStatus | null>(null);
  const [feature, setFeature] = useState<RuntimeFeatureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const previousStatus = useRef<RuntimeComponentManagerStatus | null>(null);
  const requestId = useRef(0);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (!dialog) return;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function acceptStatus(next: RuntimeComponentManagerStatus) {
    const previous = previousStatus.current;
    previousStatus.current = next;
    setStatus(next);
    if (
      previous &&
      ((next.transfer.phase === "ready" && previous.transfer.phase !== "ready") ||
        next.components.some(
          (component) =>
            component.state === "ready" &&
            previous.components.find((entry) => entry.id === component.id)?.state !== "ready",
        ))
    )
      publishRuntimeComponentsChanged();
  }

  useEffect(() => {
    mounted.current = true;
    if (!desktop)
      return () => {
        mounted.current = false;
      };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const request = ++requestId.current;
      const results = await Promise.allSettled([
        runtimeComponentsClient.status(),
        featureId ? runtimeComponentsClient.featureStatus(featureId) : Promise.resolve(null),
      ]);
      if (disposed) return;
      if (request !== requestId.current) {
        timer = setTimeout(() => void poll(), 1000);
        return;
      }
      const [managerResult, featureResult] = results;
      if (managerResult.status === "fulfilled") {
        acceptStatus(managerResult.value);
        setPollError(null);
      } else setPollError(formatRawBackendError(managerResult.reason));
      if (featureResult.status === "fulfilled") setFeature(featureResult.value);
      else setFeature(null);
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [desktop, featureId]);

  async function run(action: string, operation: () => Promise<void>) {
    if (busy && action !== "cancel") return;
    setBusy(action);
    setError(null);
    try {
      await operation();
      const request = ++requestId.current;
      const next = await runtimeComponentsClient.status();
      if (mounted.current && request === requestId.current) acceptStatus(next);
      if (next.transfer.phase === "ready") publishRuntimeComponentsChanged();
    } catch (reason) {
      if (mounted.current) setError(formatRawBackendError(reason));
    } finally {
      if (mounted.current) setBusy((current) => (current === action ? null : current));
    }
  }

  async function importArchive(componentId: RuntimeComponentId) {
    await run(`import:${componentId}`, async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "选择组件离线安装包",
        directory: false,
        multiple: false,
        filters: [{ name: "组件安装包", extensions: ["zip"] }],
      });
      if (typeof selected === "string" && selected)
        await runtimeComponentsClient.importArchive(componentId, selected);
    });
  }

  const transfer = status?.transfer;
  const active = Boolean(transfer?.active);
  const titles = new Map(status?.components.map((component) => [component.id, component.title]));
  const missing = new Set(feature?.missingComponents ?? []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="runtime-components"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <header className="runtime-components__header">
        <div>
          <h2 id={titleId}>功能组件</h2>
          <p>按需要安装本地功能，已安装的组件可离线使用。</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭组件管理">
          关闭
        </button>
      </header>
      <div className="runtime-components__body">
        {!desktop ? (
          <p role="status">组件安装需要在桌面应用中运行。画布编辑与浏览器预览可继续使用。</p>
        ) : (
          <>
            {feature ? (
              <p className="runtime-components__feature" role="status">
                {feature.ready
                  ? `${feature.title}所需组件已就绪，可返回继续使用。`
                  : `${feature.title}需要准备下方标记的组件。`}
                {feature.error ? ` ${feature.error}` : ""}
              </p>
            ) : null}
            {!status && !error && !pollError ? (
              <p role="status">正在检查已安装组件与下载目录…</p>
            ) : null}
            {status && !status.catalogReady ? (
              <p className="runtime-components__notice" role="status">
                {status.catalogError ??
                  "当前无法获取组件下载目录。可导入与此应用匹配的离线安装包。"}
              </p>
            ) : null}
            {error || pollError ? (
              <p className="runtime-components__error" role="alert">
                {error ?? pollError}
              </p>
            ) : null}
            {transfer && transfer.phase !== "idle" ? (
              <section className="runtime-components__transfer" aria-label="组件安装进度">
                <p role="status">
                  {transfer.componentId
                    ? `${titles.get(transfer.componentId) ?? "功能组件"}：`
                    : ""}
                  {PHASE_LABELS[transfer.phase]}
                </p>
                {active ? (
                  <progress
                    aria-label="组件安装进度"
                    {...(transfer.phase === "downloading" && transfer.totalBytes > 0
                      ? {
                          max: transfer.totalBytes,
                          value: Math.min(transfer.completedBytes, transfer.totalBytes),
                        }
                      : {})}
                  />
                ) : null}
                {transfer.totalBytes > 0 ? (
                  <p>
                    {formatComponentBytes(transfer.completedBytes)} /{" "}
                    {formatComponentBytes(transfer.totalBytes)}
                    {transfer.reusedBytes > 0
                      ? `，已复用 ${formatComponentBytes(transfer.reusedBytes)}`
                      : ""}
                  </p>
                ) : null}
                {transfer.error ? (
                  <p className="runtime-components__error" role="alert">
                    {transfer.error}
                  </p>
                ) : null}
                {active ? (
                  <button
                    type="button"
                    disabled={busy === "cancel"}
                    onClick={() => void run("cancel", () => runtimeComponentsClient.cancel())}
                  >
                    取消安装
                  </button>
                ) : null}
              </section>
            ) : null}
            <ul className="runtime-components__list" aria-label="可用功能组件">
              {status?.components.map((component) => {
                const required = missing.has(component.id);
                const interrupted =
                  transfer?.componentId === component.id &&
                  ["cancelled", "error"].includes(transfer.phase);
                return (
                  <li
                    key={component.id}
                    className={
                      required
                        ? "runtime-components__item runtime-components__item--required"
                        : "runtime-components__item"
                    }
                  >
                    <div className="runtime-components__identity">
                      <h3>{component.title}</h3>
                      <span>
                        {component.state === "ready"
                          ? "已就绪"
                          : component.state === "damaged"
                            ? "需要修复"
                            : "尚未安装"}
                        {required ? " · 此功能需要" : ""}
                      </span>
                    </div>
                    <p>{component.description}</p>
                    <p className="runtime-components__size">
                      {component.downloadBytes > 0
                        ? `下载 ${formatComponentBytes(component.downloadBytes)}`
                        : "下载大小待确认"}
                      {component.installedBytes > 0
                        ? `，安装后 ${formatComponentBytes(component.installedBytes)}`
                        : ""}
                      {component.version ? ` · ${component.version}` : ""}
                    </p>
                    {component.dependencies.length ? (
                      <p className="runtime-components__dependencies">
                        同时准备：
                        {component.dependencies.map((id) => titles.get(id) ?? id).join("、")}
                      </p>
                    ) : null}
                    {component.error ? (
                      <p className="runtime-components__error">{component.error}</p>
                    ) : null}
                    <div className="runtime-components__actions">
                      <button
                        type="button"
                        disabled={active || busy != null || !status.catalogReady}
                        onClick={() =>
                          void run(component.id, () =>
                            runtimeComponentsClient.install(
                              component.id,
                              component.state !== "not_installed",
                            ),
                          )
                        }
                      >
                        {component.state === "ready" || component.state === "damaged"
                          ? "修复组件"
                          : interrupted
                            ? transfer?.phase === "cancelled"
                              ? "继续安装"
                              : "重试安装"
                            : "安装组件"}
                      </button>
                      <button
                        type="button"
                        disabled={active || busy != null}
                        onClick={() => void importArchive(component.id)}
                      >
                        导入离线 ZIP
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <footer className="runtime-components__footer">
        <p>
          {active
            ? "关闭面板后仍会继续准备组件。取消后再次安装可复用已下载内容。"
            : "安装完成后，返回原功能继续操作；现有草稿会保留。"}
        </p>
      </footer>
    </dialog>,
    document.body,
  );
}
