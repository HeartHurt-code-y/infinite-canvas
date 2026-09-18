import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import paymentQr from "../../assets/license/payment-qr.png";
import wechatQr from "../../assets/license/wechat-qr.png";
import { Icon } from "../../components/Icon";
import { isDesktopRuntime } from "../../lib/backend";
import {
  activateLicense,
  formatLicenseDuration,
  formatLicenseError,
  getLicenseStatus,
  unlockedLicenseSnapshot,
  type LicenseSnapshot,
} from "../../lib/license";
import "./LicenseGate.css";

const HEARTBEAT_MS = 15_000;

function lockedFallback(): LicenseSnapshot {
  return unlockedLicenseSnapshot({
    unlocked: false,
    phase: "locked",
    reason: "trial_expired",
    trialRemainingMs: 0,
    machineId: "",
  });
}

export function LicenseGate({ children }: { readonly children: ReactNode }) {
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<LicenseSnapshot | null>(() => {
    if (!desktop || import.meta.env.MODE === "test") return unlockedLicenseSnapshot();
    return null;
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) {
      setStatus(unlockedLicenseSnapshot());
      setLoadError(null);
      return;
    }
    try {
      setStatus(await getLicenseStatus());
      setLoadError(null);
    } catch (error) {
      if (import.meta.env.MODE === "test") {
        setStatus(unlockedLicenseSnapshot());
        setLoadError(null);
        return;
      }
      setLoadError(formatLicenseError(error));
      setStatus((current) => current ?? lockedFallback());
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    // 授权状态来自桌面后端，必须在挂载后拉取并按心跳续计时。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [desktop, refresh]);

  const locked = desktop && status !== null && !status.unlocked;
  const loading = desktop && status === null;

  return (
    <div className="license-shell">
      <div className="license-shell__workspace" inert={locked || loading ? true : undefined}>
        {children}
      </div>
      {loading ? (
        <div className="license-scrim" role="status">
          正在校验授权…
        </div>
      ) : null}
      {locked && status ? (
        <LicensePaywall
          status={status}
          loadError={loadError}
          onActivated={setStatus}
          onRetry={() => {
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function LicensePaywall({
  status,
  loadError,
  onActivated,
  onRetry,
}: {
  readonly status: LicenseSnapshot;
  readonly loadError: string | null;
  readonly onActivated: (status: LicenseSnapshot) => void;
  readonly onRetry: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const error = activateError ?? loadError;
  const expiredBySubscription = status.reason === "subscription_expired";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setActivateError(null);
    try {
      onActivated(await activateLicense(trimmed));
    } catch (cause) {
      setActivateError(formatLicenseError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyMachineId() {
    if (!status.machineId) return;
    try {
      await navigator.clipboard.writeText(status.machineId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setActivateError("复制机器码失败，请手动抄写后发给作者。");
    }
  }

  return (
    <div
      className="license-paywall"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <div className="license-paywall__card">
        <header className="license-paywall__header">
          <span className="license-paywall__mark" aria-hidden="true">
            <Icon name="key" size="xl" />
          </span>
          <div>
            <h1 id={titleId}>{expiredBySubscription ? "会员已到期" : "试用已结束"}</h1>
            <p>
              包月 {status.priceYuan} 元 · {status.periodDays} 天
            </p>
          </div>
        </header>

        <div id={descriptionId} className="license-paywall__copy">
          <p>开发不易，谢谢老板打赏，您的支持是我持续更新下去的动力！</p>
          <p>有反馈和疑问及时联系作者本人微信。</p>
        </div>

        <div className="license-paywall__codes">
          <figure>
            <img src={paymentQr} alt="收款二维码，扫码支付包月 150 元" />
            <figcaption>收款码 · 包月 {status.priceYuan} 元</figcaption>
          </figure>
          <figure>
            <img src={wechatQr} alt="作者微信好友二维码" />
            <figcaption>作者微信 · 付款后发截图领激活码</figcaption>
          </figure>
        </div>

        <p className="license-paywall__hint">
          付款后把转账截图发给作者微信，并附上机器码。作者确认后会发月卡激活码，输入即可解锁画布与全部功能。
        </p>

        {status.machineId ? (
          <div className="license-paywall__machine">
            <span>机器码</span>
            <code>{status.machineId}</code>
            <button type="button" onClick={() => void copyMachineId()}>
              <Icon name="copy-simple" size="sm" />
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        ) : null}

        <form className="license-paywall__form" onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="license-activation-code">月卡激活码</label>
          <input
            ref={inputRef}
            id="license-activation-code"
            name="licenseCode"
            value={code}
            autoComplete="off"
            spellCheck={false}
            placeholder="粘贴作者发来的激活码"
            disabled={busy}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
          <div className="license-paywall__actions">
            <button type="submit" disabled={busy || code.trim() === ""}>
              {busy ? "正在激活…" : "激活会员"}
            </button>
            {loadError ? (
              <button
                type="button"
                className="license-paywall__retry"
                onClick={onRetry}
                disabled={busy}
              >
                重新校验
              </button>
            ) : null}
          </div>
        </form>

        {error ? (
          <p className="license-paywall__error" role="alert">
            {error}
          </p>
        ) : null}

        {status.trialRemainingMs > 0 ? (
          <p className="license-paywall__meta">
            试用剩余 {formatLicenseDuration(status.trialRemainingMs)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
