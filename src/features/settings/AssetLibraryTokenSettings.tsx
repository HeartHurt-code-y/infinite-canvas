import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { CloudArrowDown } from "@phosphor-icons/react/CloudArrowDown";
import { Key } from "@phosphor-icons/react/Key";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useId, useState } from "react";
import {
  ASSET_LIBRARY_CREDENTIAL_REF,
  assetLibraryCredentialRef,
  assetLibraryClient,
  formatRawBackendError,
  providerSettingsClient,
  type AssetLibraryClient,
  type CloudAsset,
  type ProviderConnection,
  type ProviderSettingsClient,
} from "../../lib/backend";

type CredentialClient = Pick<ProviderSettingsClient, "getCredential" | "setCredential">;

export function AssetLibraryTokenSettings({
  provider,
  providers = provider ? [provider] : [],
  onProviderChanged = () => undefined,
  credentialClient = providerSettingsClient,
  libraryClient = assetLibraryClient,
  onAssetsLoaded,
  onPullStarted = () => undefined,
  onPullFailed = () => undefined,
}: {
  readonly provider: ProviderConnection | null;
  readonly providers?: readonly ProviderConnection[];
  readonly onProviderChanged?: (providerConnectionId: string) => void;
  readonly credentialClient?: CredentialClient;
  readonly libraryClient?: AssetLibraryClient;
  readonly onAssetsLoaded: (providerConnectionId: string, assets: readonly CloudAsset[]) => void;
  readonly onPullStarted?: (providerConnectionId: string) => void;
  readonly onPullFailed?: (providerConnectionId: string, error: string) => void;
}) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const providerSelectId = `${inputId}-provider`;
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return "";
      setLoading(true);
      setToken("");
      setFieldError(null);
      setRequestError(null);
      setSuccessMessage(null);
      if (!provider) return "";
      const scopedRef = assetLibraryCredentialRef(provider.id);
      try {
        const scopedToken = await credentialClient.getCredential(scopedRef);
        if (scopedToken) return scopedToken;
      } catch {
        // 首次切换到该供应商时专用凭据不存在属于正常状态。
      }
      try {
        // 兼容旧版本的全局令牌；下次保存会迁移到供应商专用引用。
        return await credentialClient.getCredential(ASSET_LIBRARY_CREDENTIAL_REF);
      } catch {
        return "";
      }
    })()
      .then((savedToken) => {
        if (active) setToken(savedToken);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [credentialClient, provider]);

  const validate = (): string | null => {
    if (!token.trim()) return "请输入素材库令牌。";
    if (!provider) return "请先保存至少一条供应商连接，用它的 Base URL 访问素材接口。";
    if (!provider.enabled) return "请先在上方保存该供应商连接，再配置素材库令牌。";
    if (!provider.baseUrl.trim()) return "请先在上方填写并保存该供应商的 Base URL。";
    return null;
  };

  const handleSaveAndPull = async () => {
    const validationError = validate();
    setFieldError(validationError);
    setRequestError(null);
    setSuccessMessage(null);
    if (validationError || !provider) return;

    onPullStarted(provider.id);
    setSaving(true);
    try {
      const normalizedToken = token.trim();
      await credentialClient.setCredential({
        credentialRef: assetLibraryCredentialRef(provider.id),
        secret: normalizedToken,
      });
      setToken(normalizedToken);
      const assets = await libraryClient.list({ providerConnectionId: provider.id });
      onAssetsLoaded(provider.id, assets);
      setSuccessMessage(`令牌已保存，并拉取到 ${assets.length} 个素材。`);
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(formatted);
      onPullFailed(provider.id, formatted);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="asset-token-settings" aria-labelledby="asset-token-settings-title">
      <div className="provider-form__heading">
        <span className="settings-step" aria-hidden="true">
          <Key size={15} weight="bold" />
        </span>
        <div>
          <strong id="asset-token-settings-title">素材库令牌</strong>
          <p>素材令牌按供应商隔离；切换连接后，素材库会使用对应 Base URL 和令牌。</p>
        </div>
        <span
          className="asset-token-status"
          data-state={loading ? "loading" : token.trim() ? "configured" : "empty"}
        >
          {loading ? (
            <CircleNotch size={13} weight="bold" aria-hidden="true" />
          ) : token.trim() ? (
            <CheckCircle size={13} weight="fill" aria-hidden="true" />
          ) : (
            <WarningCircle size={13} weight="fill" aria-hidden="true" />
          )}
          {loading ? "读取中" : token.trim() ? "已配置" : "未配置"}
        </span>
      </div>

      {providers.length > 0 ? (
        <div className="asset-token-settings__provider">
          <label htmlFor={providerSelectId}>素材库供应商连接</label>
          <select
            id={providerSelectId}
            value={provider?.id ?? ""}
            onChange={(event) => onProviderChanged(event.target.value)}
            aria-describedby={`${providerSelectId}-hint`}
          >
            <option value="" disabled>
              选择供应商连接
            </option>
            {providers.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </option>
            ))}
          </select>
          <small id={`${providerSelectId}-hint`}>
            为不同供应商分别保存素材库令牌；令牌不会在供应商之间复用。
          </small>
        </div>
      ) : null}

      <div className="asset-token-settings__control">
        <label htmlFor={inputId}>素材库令牌值</label>
        <div>
          <input
            id={inputId}
            type="text"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="输入素材库对应的 Bearer 令牌"
            aria-describedby={`${hintId}${fieldError ? ` ${errorId}` : ""}`}
            aria-invalid={fieldError ? "true" : undefined}
            onChange={(event) => {
              setToken(event.target.value);
              if (fieldError && event.target.value.trim()) setFieldError(null);
            }}
            onBlur={() => {
              if (!token.trim()) setFieldError("请输入素材库令牌。");
            }}
          />
          <button
            type="button"
            className="asset-token-save-action"
            data-state={saving ? "loading" : undefined}
            disabled={
              loading || saving || !provider || !provider.enabled || !provider.baseUrl.trim()
            }
            onClick={() => {
              void handleSaveAndPull();
            }}
          >
            {saving ? (
              <CircleNotch size={16} weight="bold" aria-hidden="true" />
            ) : (
              <CloudArrowDown size={16} weight="bold" aria-hidden="true" />
            )}
            {saving ? "正在拉取…" : "保存并拉取素材"}
          </button>
        </div>
        <small id={hintId}>
          {provider?.enabled && provider.baseUrl.trim()
            ? `通过「${provider.displayName}」的 Base URL 访问素材接口；令牌只保存在 Windows 凭据管理器。`
            : provider
              ? "请先在上方填写并保存该供应商的 Base URL，再配置素材库令牌。"
              : "请先保存供应商连接，再配置素材库令牌。"}
        </small>
        {fieldError ? (
          <small id={errorId} className="asset-token-settings__field-error">
            {fieldError}
          </small>
        ) : null}
      </div>

      {requestError ? (
        <div className="settings-error asset-token-settings__notice" role="alert">
          <strong>素材库拉取失败</strong>
          <pre tabIndex={0}>{requestError}</pre>
        </div>
      ) : null}
      {successMessage ? (
        <p className="settings-success asset-token-settings__notice" role="status">
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
          {successMessage}
        </p>
      ) : null}
    </section>
  );
}
