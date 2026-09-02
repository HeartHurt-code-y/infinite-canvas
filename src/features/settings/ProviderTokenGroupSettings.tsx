import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Key } from "@phosphor-icons/react/Key";
import { Plus } from "@phosphor-icons/react/Plus";
import { Trash } from "@phosphor-icons/react/Trash";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useCallback, useEffect, useId, useState } from "react";
import {
  formatRawBackendError,
  providerSettingsClient,
  type ConnectivityTestResult,
  type ProviderConnection,
  type ProviderSettingsClient,
  type ProviderTokenGroup,
} from "../../lib/backend";

type CredentialClient = Pick<ProviderSettingsClient, "getCredential">;

const NOOP_TOKEN_GROUPS_CHANGED = () => undefined;

/**
 * 供应商「令牌分组」设置：同一供应商接口可能签发多组分组令牌，
 * 不同分组能拉取/调用的模型不同（如 as 分组可调 sd、默认分组可调 image）。
 * 每个模型绑定记录使用哪个分组令牌；分组密钥只写入 Windows 凭据管理器。
 */
export function ProviderTokenGroupSettings({
  provider,
  providers = provider ? [provider] : [],
  onProviderChanged = () => undefined,
  client = providerSettingsClient,
  credentialClient = providerSettingsClient,
  onTokenGroupsChanged = NOOP_TOKEN_GROUPS_CHANGED,
}: {
  readonly provider: ProviderConnection | null;
  readonly providers?: readonly ProviderConnection[];
  readonly onProviderChanged?: (providerConnectionId: string) => void;
  readonly client?: ProviderSettingsClient;
  readonly credentialClient?: CredentialClient;
  /** 分组列表变化时回调，供父组件同步模型列表的「调用令牌」下拉选项。 */
  readonly onTokenGroupsChanged?: (groups: readonly ProviderTokenGroup[]) => void;
}) {
  const inputId = useId();
  const providerSelectId = `${inputId}-provider`;
  const [groups, setGroups] = useState<ProviderTokenGroup[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupSecret, setNewGroupSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!provider) {
      setGroups([]);
      setSecrets({});
      onTokenGroupsChanged([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await client.listProviderTokenGroups(provider.id);
      setGroups(list);
      onTokenGroupsChanged(list);
      const next: Record<string, string> = {};
      await Promise.all(
        list.map(async (group) => {
          try {
            next[group.id] = await credentialClient.getCredential(group.credentialRef);
          } catch {
            next[group.id] = "";
          }
        }),
      );
      setSecrets(next);
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(formatted);
      setGroups([]);
      onTokenGroupsChanged([]);
    } finally {
      setLoading(false);
    }
  }, [client, credentialClient, onTokenGroupsChanged, provider]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setNewGroupName("");
      setNewGroupSecret("");
      setRequestError(null);
      setSuccessMessage(null);
      await reload();
    })();
    return () => {
      active = false;
    };
  }, [reload]);

  const canManage = Boolean(provider && provider.enabled && provider.baseUrl.trim());

  const validateGroup = (name: string, secret: string, isNew: boolean): string | null => {
    if (!provider) return "请先保存至少一条供应商连接。";
    if (!provider.enabled) return "请先在上方保存并启用该供应商连接。";
    if (!provider.baseUrl.trim()) return "请先在上方填写并保存该供应商的 Base URL。";
    const trimmed = name.trim();
    if (!trimmed) return "请输入分组名称。";
    if (trimmed.length > 64) return "分组名称不能超过 64 个字符。";
    // 重名校验只针对新增分组；保存已有分组时它自己就在列表中。
    if (isNew && groups.some((group) => group.groupName === trimmed)) {
      return `分组「${trimmed}」已存在。`;
    }
    if (isNew && !secret.trim()) return "请输入该分组的令牌值。";
    return null;
  };

  const showTestResult = (name: string, result: ConnectivityTestResult) => {
    if (result.ok) {
      setSuccessMessage(`分组「${name}」连通性正常（${result.elapsedMs}ms）。`);
    } else {
      setRequestError(
        `分组「${name}」连通性失败：${result.reason ?? "未知原因"}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      );
    }
  };

  const handleSaveGroup = async (group: ProviderTokenGroup) => {
    const secret = (secrets[group.id] ?? "").trim();
    const validationError = validateGroup(group.groupName, secret, false);
    setRequestError(null);
    setSuccessMessage(null);
    if (validationError) {
      setRequestError(validationError);
      return;
    }
    setBusyId(group.id);
    try {
      await client.upsertProviderTokenGroup({
        providerConnectionId: group.providerConnectionId,
        groupName: group.groupName,
        enabled: true,
        secret: secret || null,
      });
      setSuccessMessage(`分组「${group.groupName}」已保存。`);
      await reload();
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(formatted);
    } finally {
      setBusyId(null);
    }
  };

  const handleTestGroup = async (group: ProviderTokenGroup) => {
    setBusyId(group.id);
    setRequestError(null);
    setSuccessMessage(null);
    try {
      const result = await client.testConnection(group.providerConnectionId, group.groupName);
      showTestResult(group.groupName, result);
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(`分组「${group.groupName}」连通性测试失败：${formatted}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteGroup = async (group: ProviderTokenGroup) => {
    setBusyId(group.id);
    setRequestError(null);
    setSuccessMessage(null);
    try {
      await client.deleteProviderTokenGroup(group.providerConnectionId, group.groupName);
      setSuccessMessage(`分组「${group.groupName}」已删除，其绑定的模型将回到默认令牌。`);
      await reload();
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(formatted);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddGroup = async () => {
    if (!provider) return;
    const validationError = validateGroup(newGroupName, newGroupSecret, true);
    setRequestError(null);
    setSuccessMessage(null);
    if (validationError) {
      setRequestError(validationError);
      return;
    }
    setBusyId("new");
    try {
      await client.upsertProviderTokenGroup({
        providerConnectionId: provider.id,
        groupName: newGroupName.trim(),
        enabled: true,
        secret: newGroupSecret.trim() || null,
      });
      setNewGroupName("");
      setNewGroupSecret("");
      setSuccessMessage(`分组「${newGroupName.trim()}」已添加。`);
      await reload();
    } catch (error: unknown) {
      const formatted = error instanceof Error ? error.message : formatRawBackendError(error);
      setRequestError(formatted);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="token-group-settings" aria-labelledby="token-group-settings-title">
      <div className="provider-form__heading">
        <span className="settings-step" aria-hidden="true">
          <Key size={15} weight="bold" />
        </span>
        <div>
          <strong id="token-group-settings-title">令牌分组</strong>
          <p>
            同一供应商的不同分组令牌可访问不同模型（如 as 分组调 sd、默认分组调 image）；
            每个模型在下方选择调用哪个分组的令牌。
          </p>
        </div>
        <span
          className="asset-token-status"
          data-state={loading ? "loading" : groups.length > 0 ? "configured" : "empty"}
        >
          {loading ? (
            <CircleNotch size={13} weight="bold" aria-hidden="true" />
          ) : groups.length > 0 ? (
            <CheckCircle size={13} weight="fill" aria-hidden="true" />
          ) : (
            <WarningCircle size={13} weight="fill" aria-hidden="true" />
          )}
          {loading ? "读取中" : groups.length > 0 ? `${groups.length} 个分组` : "未配置"}
        </span>
      </div>

      {providers.length > 0 ? (
        <div className="asset-token-settings__provider">
          <label htmlFor={providerSelectId}>令牌分组所属供应商</label>
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
            分组令牌按供应商隔离；每个模型的「调用令牌」下拉会列出这里的全部分组。
          </small>
        </div>
      ) : null}

      {groups.map((group) => (
        <div className="token-group-settings__row" key={group.id}>
          <div className="token-group-settings__name">
            <label htmlFor={`${inputId}-name-${group.id}`}>分组名称</label>
            <input
              id={`${inputId}-name-${group.id}`}
              type="text"
              value={group.groupName}
              disabled
              spellCheck={false}
            />
          </div>
          <div className="token-group-settings__secret">
            <label htmlFor={`${inputId}-secret-${group.id}`}>令牌值</label>
            <input
              id={`${inputId}-secret-${group.id}`}
              type="text"
              value={secrets[group.id] ?? ""}
              autoComplete="off"
              spellCheck={false}
              placeholder="留空表示沿用已保存的令牌"
              aria-describedby={`${inputId}-hint-${group.id}`}
              onChange={(event) =>
                setSecrets((current) => ({ ...current, [group.id]: event.target.value }))
              }
            />
            <small id={`${inputId}-hint-${group.id}`}>
              分组「{group.groupName}」调用该供应商接口时使用此令牌。
            </small>
          </div>
          <div className="token-group-settings__actions">
            <button
              type="button"
              data-state={busyId === group.id ? "loading" : undefined}
              disabled={busyId !== null || !canManage}
              onClick={() => {
                void handleSaveGroup(group);
              }}
            >
              {busyId === group.id ? (
                <CircleNotch size={14} weight="bold" aria-hidden="true" />
              ) : (
                <CheckCircle size={14} weight="bold" aria-hidden="true" />
              )}
              保存
            </button>
            <button
              type="button"
              disabled={busyId !== null || !canManage}
              onClick={() => {
                void handleTestGroup(group);
              }}
            >
              测试
            </button>
            <button
              type="button"
              className="token-group-settings__delete"
              disabled={busyId !== null}
              onClick={() => {
                void handleDeleteGroup(group);
              }}
            >
              <Trash size={14} weight="bold" aria-hidden="true" />
              删除
            </button>
          </div>
        </div>
      ))}

      <div className="token-group-settings__row token-group-settings__row--new">
        <div className="token-group-settings__name">
          <label htmlFor={`${inputId}-new-name`}>新增分组名称</label>
          <input
            id={`${inputId}-new-name`}
            type="text"
            value={newGroupName}
            autoComplete="off"
            spellCheck={false}
            placeholder="如：as分组"
            disabled={busyId !== null}
            onChange={(event) => {
              setNewGroupName(event.target.value);
              if (requestError) setRequestError(null);
            }}
          />
        </div>
        <div className="token-group-settings__secret">
          <label htmlFor={`${inputId}-new-secret`}>令牌值</label>
          <input
            id={`${inputId}-new-secret`}
            type="text"
            value={newGroupSecret}
            autoComplete="off"
            spellCheck={false}
            placeholder="输入该分组的 Bearer 令牌"
            disabled={busyId !== null}
            onChange={(event) => {
              setNewGroupSecret(event.target.value);
              if (requestError) setRequestError(null);
            }}
          />
        </div>
        <div className="token-group-settings__actions">
          <button
            type="button"
            className="token-group-settings__add"
            data-state={busyId === "new" ? "loading" : undefined}
            disabled={busyId !== null || !canManage}
            onClick={() => {
              void handleAddGroup();
            }}
          >
            {busyId === "new" ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" />
            ) : (
              <Plus size={14} weight="bold" aria-hidden="true" />
            )}
            添加分组
          </button>
        </div>
      </div>

      {requestError ? (
        <div className="settings-error token-group-settings__notice" role="alert">
          <strong>令牌分组操作失败</strong>
          <pre tabIndex={0}>{requestError}</pre>
        </div>
      ) : null}
      {successMessage ? (
        <p className="settings-success token-group-settings__notice" role="status">
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
          {successMessage}
        </p>
      ) : null}
    </section>
  );
}
