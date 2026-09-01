import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { FloppyDisk } from "@phosphor-icons/react/FloppyDisk";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/Plus";
import { TextAa } from "@phosphor-icons/react/TextAa";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  describeConnectivityTest,
  formatRawBackendError,
  assetLibraryClient,
  providerScopedModelDefinitionId,
  providerSettingsClient,
  tosStagingClient,
  type CloudAsset,
  type AssetLibraryClient,
  type GenerationOperation,
  type ProviderConnection,
  type ProviderSettingsClient,
  type RemoteModelOption,
  type TosStagingClient,
} from "../../lib/backend";
import { AssetLibraryTokenSettings } from "./AssetLibraryTokenSettings";
import { TosStagingSettings } from "./TosStagingSettings";

interface ProviderDraft {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
}

interface ModelUsage {
  readonly kind: "none" | "image" | "video" | "text";
  readonly textToImage: boolean;
  readonly imageToImage: boolean;
}

type ModelTypeFilter = "all" | Exclude<ModelUsage["kind"], "none">;

type BusyAction =
  | "loading-connections"
  | "restoring-models"
  | "saving-connection"
  | "fetching-models"
  | "saving-models"
  | "testing-connection"
  | null;

const NEW_PROVIDER_ID = "__new_provider__";

function createProviderId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ? `provider-${id}` : `provider-${Date.now()}`;
}

function emptyProviderDraft(): ProviderDraft {
  return {
    id: createProviderId(),
    displayName: "公司接口",
    baseUrl: "",
  };
}

function usageFromOperations(operations: readonly GenerationOperation[]): ModelUsage {
  const hasImageOperation =
    operations.includes("text_to_image") || operations.includes("image_to_image");
  const hasVideoOperation = operations.includes("video_generation");
  const hasTextOperation = operations.includes("text_generation");
  return {
    kind: hasTextOperation
      ? "text"
      : hasImageOperation && !hasVideoOperation
        ? "image"
        : hasVideoOperation && !hasImageOperation
          ? "video"
          : "none",
    textToImage: operations.includes("text_to_image"),
    imageToImage: operations.includes("image_to_image"),
  };
}

function operationsFromUsage(usage: ModelUsage): GenerationOperation[] {
  if (usage.kind === "video") return ["video_generation"];
  if (usage.kind === "text") return ["text_generation"];
  if (usage.kind !== "image") return [];
  const operations: GenerationOperation[] = [];
  if (usage.textToImage) operations.push("text_to_image");
  if (usage.imageToImage) operations.push("image_to_image");
  return operations;
}

function emptyModelUsage(): ModelUsage {
  return { kind: "none", textToImage: false, imageToImage: false };
}

function initialModelUsage(model: RemoteModelOption): ModelUsage {
  if (model.hasConfiguredBinding) {
    return usageFromOperations(model.configuredOperations);
  }
  const usage = usageFromOperations(model.suggestedOperations ?? []);
  return usage.kind === "image" ? { ...usage, imageToImage: true } : usage;
}

function usageWithKind(
  model: RemoteModelOption,
  usage: ModelUsage,
  kind: ModelUsage["kind"],
): ModelUsage {
  if (kind !== "image" || usage.textToImage || usage.imageToImage) {
    return { ...usage, kind };
  }
  const suggested = usageFromOperations(model.suggestedOperations);
  if (suggested.kind === "image") return { ...suggested, imageToImage: true };
  return { ...usage, kind, textToImage: true, imageToImage: true };
}

function providerDraft(provider: ProviderConnection): ProviderDraft {
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
  };
}

export function ProviderSettingsDialog({
  open,
  onClose,
  onCatalogChanged,
  activeAssetProviderId = null,
  onAssetProviderChanged = () => undefined,
  onAssetLibraryLoaded = () => undefined,
  onAssetLibraryLoading = () => undefined,
  onAssetLibraryLoadFailed = () => undefined,
  client = providerSettingsClient,
  assetClient = assetLibraryClient,
  tosClient = tosStagingClient,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCatalogChanged: () => Promise<void> | void;
  readonly activeAssetProviderId?: string | null;
  readonly onAssetProviderChanged?: (providerConnectionId: string) => void;
  readonly onAssetLibraryLoaded?: (
    providerConnectionId: string,
    assets: readonly CloudAsset[],
  ) => void;
  readonly onAssetLibraryLoading?: (providerConnectionId: string) => void;
  readonly onAssetLibraryLoadFailed?: (providerConnectionId: string, error: string) => void;
  readonly client?: ProviderSettingsClient;
  readonly assetClient?: AssetLibraryClient;
  readonly tosClient?: TosStagingClient;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const baseUrlRef = useRef<HTMLInputElement | null>(null);
  const apiKeyRef = useRef<HTMLInputElement | null>(null);
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const savedModelsRequestRef = useRef(0);
  const apiKeyRequestRef = useRef(0);
  const [providers, setProviders] = useState<ProviderConnection[]>([]);
  const [assetTokenProviderId, setAssetTokenProviderId] = useState<string | null>(
    activeAssetProviderId,
  );
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft());
  const [remoteModels, setRemoteModels] = useState<RemoteModelOption[]>([]);
  const [modelUsage, setModelUsage] = useState<Record<string, ModelUsage>>({});
  const [modelSearch, setModelSearch] = useState("");
  const [modelTypeFilter, setModelTypeFilter] = useState<ModelTypeFilter>("all");
  const [busyAction, setBusyAction] = useState<BusyAction>("loading-connections");
  const [rawError, setRawError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<{
    readonly ok: boolean;
    readonly message: string;
  } | null>(null);

  // 已保存的模型配置从本地数据库恢复（不走网络），供应商连接与其模型分类在每次打开
  // 设置时原样重现，无需重新拉取或重新配置。请求序号防止快速切换供应商时旧响应覆盖新选择。
  const restoreSavedModels = useCallback(
    async (providerId: string) => {
      const requestId = ++savedModelsRequestRef.current;
      setBusyAction("restoring-models");
      try {
        const models = await client.listSavedProviderModels(providerId);
        if (requestId !== savedModelsRequestRef.current) return;
        setRemoteModels(models);
        setModelUsage(
          Object.fromEntries(models.map((model) => [model.id, initialModelUsage(model)])),
        );
        setModelSearch("");
        setModelTypeFilter("all");
      } catch (error: unknown) {
        if (requestId !== savedModelsRequestRef.current) return;
        setRawError(formatRawBackendError(error));
      } finally {
        if (requestId === savedModelsRequestRef.current) setBusyAction(null);
      }
    },
    [client],
  );

  // 重新打开设置 / 切换供应商时，把已保存的 API Key 明文回填到输入框，使其「持久化一直显露」。
  // 读取失败（如凭据不存在）则保持留空，沿用「留空则沿用已保存密钥」语义。请求序号防止
  // 快速切换时旧响应覆盖新选择。
  const loadApiKey = useCallback(
    async (provider: ProviderConnection) => {
      const requestId = ++apiKeyRequestRef.current;
      if (!provider.apiKeyRef) {
        if (apiKeyRef.current) apiKeyRef.current.value = "";
        return;
      }
      try {
        const secret = await client.getCredential(provider.apiKeyRef);
        if (requestId !== apiKeyRequestRef.current) return;
        if (apiKeyRef.current) apiKeyRef.current.value = secret ?? "";
      } catch {
        if (requestId !== apiKeyRequestRef.current) return;
        if (apiKeyRef.current) apiKeyRef.current.value = "";
      }
    },
    [client],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    client
      .listProviderConnections()
      .then(async (connections) => {
        if (!active) return;
        setProviders(connections);
        const initialProvider =
          connections.find((provider) => provider.id === activeAssetProviderId) ?? connections[0];
        setAssetTokenProviderId(initialProvider?.id ?? null);
        if (initialProvider) {
          setDraft(providerDraft(initialProvider));
          await restoreSavedModels(initialProvider.id);
          await loadApiKey(initialProvider);
        }
      })
      .catch((error: unknown) => {
        if (active) setRawError(formatRawBackendError(error));
      })
      .finally(() => {
        if (active) setBusyAction(null);
      });
    const animationFrame = window.requestAnimationFrame(() => baseUrlRef.current?.focus());
    return () => {
      active = false;
      savedModelsRequestRef.current += 1;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [activeAssetProviderId, client, open, restoreSavedModels, loadApiKey]);

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase();
    return remoteModels.filter((model) => {
      const usage = modelUsage[model.id] ?? emptyModelUsage();
      if (modelTypeFilter !== "all" && usage.kind !== modelTypeFilter) return false;
      if (!query) return true;
      return `${model.displayName} ${model.id} ${model.ownedBy ?? ""}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [modelSearch, modelTypeFilter, modelUsage, remoteModels]);

  const selectedImageModelCount = Object.values(modelUsage).filter(
    (usage) => usage.kind === "image",
  ).length;
  const selectedVideoModelCount = Object.values(modelUsage).filter(
    (usage) => usage.kind === "video",
  ).length;
  const selectedTextModelCount = Object.values(modelUsage).filter(
    (usage) => usage.kind === "text",
  ).length;

  if (!open) return null;

  const selectProvider = (providerId: string) => {
    if (apiKeyRef.current) apiKeyRef.current.value = "";
    setRemoteModels([]);
    setModelUsage({});
    setModelSearch("");
    setModelTypeFilter("all");
    setRawError(null);
    setSuccessMessage(null);
    setTestNotice(null);
    if (providerId === NEW_PROVIDER_ID) {
      setDraft(emptyProviderDraft());
      setAssetTokenProviderId(null);
      if (apiKeyRef.current) apiKeyRef.current.value = "";
      return;
    }
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider) {
      setDraft(providerDraft(provider));
      setAssetTokenProviderId(provider.id);
      onAssetProviderChanged(provider.id);
      void restoreSavedModels(provider.id);
      void loadApiKey(provider);
    }
  };

  const validateConnectionDraft = (): { readonly apiKey: string } | null => {
    const existingProvider = providers.some((provider) => provider.id === draft.id);
    const apiKey = apiKeyRef.current?.value ?? "";
    if (!draft.displayName.trim() || !draft.baseUrl.trim()) {
      setRawError("供应商名称和 Base URL 不能为空。完整地址会交给后端继续校验。");
      return null;
    }
    if (!existingProvider && !apiKey) {
      setRawError("新供应商连接需要输入 API Key；保存后密钥只进入 Windows 凭据管理器。");
      return null;
    }
    return { apiKey };
  };

  const persistConnection = async (apiKey: string): Promise<ProviderConnection> => {
    const provider = await client.upsertProviderConnection({
      id: draft.id,
      displayName: draft.displayName.trim(),
      adapterId: "moyu_v1",
      baseUrl: draft.baseUrl.trim(),
      enabled: true,
    });
    if (apiKey) {
      await client.setCredential({ credentialRef: provider.apiKeyRef, secret: apiKey });
    }
    setProviders((current) => {
      const withoutCurrent = current.filter((candidate) => candidate.id !== provider.id);
      return [...withoutCurrent, provider].sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "zh-CN"),
      );
    });
    setDraft(providerDraft(provider));
    setAssetTokenProviderId(provider.id);
    onAssetProviderChanged(provider.id);
    return provider;
  };

  const handleSaveConnection = async (event: FormEvent) => {
    event.preventDefault();
    setRawError(null);
    setSuccessMessage(null);
    const connectionInput = validateConnectionDraft();
    if (!connectionInput) return;

    setBusyAction("saving-connection");
    try {
      const provider = await persistConnection(connectionInput.apiKey);
      await restoreSavedModels(provider.id);
      await onCatalogChanged();
      setSuccessMessage(`已保存 ${provider.displayName} 的连接信息。`);
    } catch (error) {
      setRawError(formatRawBackendError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleFetchModels = async () => {
    setRawError(null);
    setSuccessMessage(null);
    const connectionInput = validateConnectionDraft();
    if (!connectionInput) return;

    setBusyAction("fetching-models");
    try {
      const provider = await persistConnection(connectionInput.apiKey);
      const models = await client.fetchProviderModels(provider.id);
      setRemoteModels(models);
      setModelUsage(
        Object.fromEntries(models.map((model) => [model.id, initialModelUsage(model)])),
      );
      setModelSearch("");
      setModelTypeFilter("all");
      setSuccessMessage(`已保存连接，并从 ${provider.displayName} 拉取 ${models.length} 个模型。`);
      window.requestAnimationFrame(() => modelSearchRef.current?.focus());
    } catch (error) {
      setRawError(formatRawBackendError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveModels = async () => {
    setRawError(null);
    setSuccessMessage(null);
    setTestNotice(null);
    const incompleteImageModel = remoteModels.find((model) => {
      const usage = modelUsage[model.id] ?? emptyModelUsage();
      return usage.kind === "image" && !usage.textToImage && !usage.imageToImage;
    });
    if (incompleteImageModel) {
      setRawError(`${incompleteImageModel.displayName} 至少需要启用一种图片生成能力。`);
      return;
    }
    setBusyAction("saving-models");
    try {
      const selections = remoteModels.map((model) => {
        const usage = modelUsage[model.id] ?? emptyModelUsage();
        const enabledOperations = operationsFromUsage(usage);
        return {
          // 不信任来源数据中的 modelDefinitionId（历史 DB 可能存裸远程模型 ID），
          // 按后端规范 `remote::{provider}::{remote_model_id}` 构造，杜绝作用域校验失败。
          modelDefinitionId: providerScopedModelDefinitionId(draft.id, model.id),
          displayName: model.displayName,
          remoteModelId: model.id,
          enabled: enabledOperations.length > 0,
          enabledOperations,
          operationSchema: model.operationSchema ?? {},
        };
      });
      await client.replaceProviderModelBindings(draft.id, selections);
      await onCatalogChanged();
      setSuccessMessage(
        `已保存 ${selectedImageModelCount} 个图片模型、${selectedVideoModelCount} 个视频模型、${selectedTextModelCount} 个文本模型，对应生成节点与文本功能使用的模型列表已更新。`,
      );
      // 保存成功后自动做一次真实请求的连通性测试；无论结果如何都提示用户。
      // 测试失败不影响已保存的配置，因此失败只降级为提示而不是错误。
      setBusyAction("testing-connection");
      try {
        const result = await client.testConnection(draft.id);
        setTestNotice({
          ok: result.ok,
          message: describeConnectivityTest(result, `供应商 ${draft.displayName} `),
        });
      } catch (error) {
        setTestNotice({
          ok: false,
          message: `供应商 ${draft.displayName} 连通性测试失败：${formatRawBackendError(error)}`,
        });
      }
    } catch (error) {
      setRawError(formatRawBackendError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="settings-layer">
      <button
        type="button"
        className="settings-backdrop"
        aria-label="关闭全局设置"
        onClick={onClose}
      />
      <section
        id="global-settings-dialog"
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-settings-title"
        aria-busy={busyAction !== null}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-dialog__header">
          <span className="settings-dialog__eyebrow">
            <GearSix size={14} weight="bold" aria-hidden="true" />
            全局设置
          </span>
          <h2 id="provider-settings-title">供应商连接与模型</h2>
          <p>保存公司接口地址与密钥，然后从接口读取实际可用模型。</p>
          <button
            type="button"
            className="settings-dialog__close"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-dialog__body">
          <form
            className="provider-form"
            onSubmit={(event) => {
              void handleSaveConnection(event);
            }}
          >
            <div className="provider-form__heading">
              <span className="settings-step">01</span>
              <div>
                <strong>连接信息</strong>
                <p>同一个模型可以由多个供应商连接提供，每条连接使用独立地址和密钥。</p>
              </div>
            </div>
            <div className="provider-switcher">
              <label htmlFor="provider-connection-select">供应商连接</label>
              <div>
                <select
                  id="provider-connection-select"
                  value={
                    providers.some((provider) => provider.id === draft.id)
                      ? draft.id
                      : NEW_PROVIDER_ID
                  }
                  onChange={(event) => selectProvider(event.target.value)}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                  <option value={NEW_PROVIDER_ID}>新建连接</option>
                </select>
                <button type="button" onClick={() => selectProvider(NEW_PROVIDER_ID)}>
                  <Plus size={15} weight="bold" aria-hidden="true" />
                  新建
                </button>
              </div>
            </div>

            <div className="provider-field-grid">
              <label>
                <span>供应商名称</span>
                <input
                  value={draft.displayName}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, displayName: event.target.value }))
                  }
                  autoComplete="organization"
                />
              </label>
              <label className="provider-field--url">
                <span>Base URL</span>
                <input
                  ref={baseUrlRef}
                  value={draft.baseUrl}
                  inputMode="url"
                  spellCheck={false}
                  placeholder="https://api.company.com 或 …/v1"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  aria-describedby="base-url-hint"
                />
                <small id="base-url-hint">
                  支持根地址和以 /v1 结尾的地址；模型从 /v1/models 拉取。
                </small>
              </label>
              <label className="provider-field--key">
                <span>API Key</span>
                <input
                  ref={apiKeyRef}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    providers.some((provider) => provider.id === draft.id)
                      ? "留空则沿用已保存密钥"
                      : "输入该接口的 API Key"
                  }
                  aria-describedby="api-key-hint"
                />
                <small id="api-key-hint">
                  只保存到 Windows 凭据管理器，不写入数据库、画布或任务日志。
                </small>
              </label>
            </div>

            <div className="provider-form__actions">
              <button
                type="submit"
                className="provider-save-action"
                data-state={busyAction === "saving-connection" ? "loading" : undefined}
                disabled={busyAction !== null}
              >
                {busyAction === "saving-connection" ? (
                  <CircleNotch size={16} weight="bold" aria-hidden="true" />
                ) : (
                  <FloppyDisk size={16} weight="bold" aria-hidden="true" />
                )}
                {busyAction === "saving-connection" ? "正在保存…" : "保存连接"}
              </button>
              <button
                type="button"
                className="provider-fetch-action"
                data-state={busyAction === "fetching-models" ? "loading" : undefined}
                disabled={busyAction !== null}
                onClick={() => {
                  void handleFetchModels();
                }}
              >
                {busyAction === "fetching-models" ? (
                  <CircleNotch size={16} weight="bold" aria-hidden="true" />
                ) : (
                  <MagnifyingGlass size={16} weight="bold" aria-hidden="true" />
                )}
                {busyAction === "fetching-models" ? "正在拉取…" : "拉取模型"}
              </button>
            </div>
          </form>

          {rawError ? (
            <div className="settings-error" role="alert">
              <strong>完整原始错误</strong>
              <pre tabIndex={0}>{rawError}</pre>
            </div>
          ) : null}
          {successMessage ? (
            <p className="settings-success" role="status">
              <CheckCircle size={15} weight="fill" aria-hidden="true" />
              {successMessage}
            </p>
          ) : null}

          <AssetLibraryTokenSettings
            provider={providers.find((provider) => provider.id === assetTokenProviderId) ?? null}
            providers={providers}
            onProviderChanged={(providerId) => setAssetTokenProviderId(providerId)}
            credentialClient={client}
            libraryClient={assetClient}
            onAssetsLoaded={onAssetLibraryLoaded}
            onPullStarted={onAssetLibraryLoading}
            onPullFailed={onAssetLibraryLoadFailed}
          />

          {remoteModels.length > 0 ? (
            <section className="model-picker" aria-labelledby="model-picker-title">
              <div className="model-picker__header">
                <div>
                  <span className="settings-step">02</span>
                  <h3 id="model-picker-title">分类生成模型</h3>
                  <p>
                    每个供应商分别保存图片、视频与文本模型；图片能力在对应模型内设置，文本模型自动用于提示词优化等功能。
                  </p>
                </div>
              </div>

              <div className="model-picker__toolbar">
                <div className="model-type-filter" role="group" aria-label="按模型类型筛选">
                  <button
                    type="button"
                    aria-label={`全部模型，${remoteModels.length} 个`}
                    aria-pressed={modelTypeFilter === "all"}
                    onClick={() => setModelTypeFilter("all")}
                  >
                    全部
                    <span aria-hidden="true">{remoteModels.length}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`文本模型，${selectedTextModelCount} 个`}
                    aria-pressed={modelTypeFilter === "text"}
                    onClick={() => setModelTypeFilter("text")}
                  >
                    <TextAa size={14} weight="bold" aria-hidden="true" />
                    文本
                    <span aria-hidden="true">{selectedTextModelCount}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`图片模型，${selectedImageModelCount} 个`}
                    aria-pressed={modelTypeFilter === "image"}
                    onClick={() => setModelTypeFilter("image")}
                  >
                    <ImageSquare size={14} weight="bold" aria-hidden="true" />
                    图片
                    <span aria-hidden="true">{selectedImageModelCount}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`视频模型，${selectedVideoModelCount} 个`}
                    aria-pressed={modelTypeFilter === "video"}
                    onClick={() => setModelTypeFilter("video")}
                  >
                    <VideoCamera size={14} weight="bold" aria-hidden="true" />
                    视频
                    <span aria-hidden="true">{selectedVideoModelCount}</span>
                  </button>
                </div>
                <label className="model-search">
                  <MagnifyingGlass size={15} weight="bold" aria-hidden="true" />
                  <span className="sr-only">搜索已拉取模型</span>
                  <input
                    ref={modelSearchRef}
                    type="search"
                    value={modelSearch}
                    placeholder="搜索模型名称或 ID"
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                </label>
              </div>

              <div className="model-list" aria-label="已拉取模型">
                {visibleModels.length > 0 ? (
                  visibleModels.map((model) => {
                    const usage = modelUsage[model.id] ?? emptyModelUsage();
                    return (
                      <article className="model-option" key={model.id}>
                        <div className="model-option__identity">
                          <strong>{model.displayName}</strong>
                          <code>{model.id}</code>
                          {model.ownedBy ? <span>{model.ownedBy}</span> : null}
                        </div>
                        <div className="model-option__classification">
                          <div
                            className="model-option__kind"
                            role="radiogroup"
                            aria-label={`${model.displayName}模型类型`}
                          >
                            {(["none", "image", "video", "text"] as const).map((kind) => (
                              <label key={kind}>
                                <input
                                  type="radio"
                                  name={`model-kind-${model.id}`}
                                  checked={usage.kind === kind}
                                  onChange={() =>
                                    setModelUsage((current) => ({
                                      ...current,
                                      [model.id]: usageWithKind(model, usage, kind),
                                    }))
                                  }
                                />
                                {kind === "none" ? (
                                  "不启用"
                                ) : kind === "image" ? (
                                  <>
                                    <ImageSquare size={14} weight="bold" aria-hidden="true" />
                                    图片模型
                                  </>
                                ) : kind === "video" ? (
                                  <>
                                    <VideoCamera size={14} weight="bold" aria-hidden="true" />
                                    视频模型
                                  </>
                                ) : (
                                  <>
                                    <TextAa size={14} weight="bold" aria-hidden="true" />
                                    文本模型
                                  </>
                                )}
                              </label>
                            ))}
                          </div>
                          {usage.kind === "image" ? (
                            <div
                              className="model-option__uses"
                              role="group"
                              aria-label={`${model.displayName}图片能力`}
                            >
                              <label>
                                <input
                                  type="checkbox"
                                  checked={usage.textToImage}
                                  onChange={(event) =>
                                    setModelUsage((current) => ({
                                      ...current,
                                      [model.id]: { ...usage, textToImage: event.target.checked },
                                    }))
                                  }
                                />
                                文生图
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={usage.imageToImage}
                                  onChange={(event) =>
                                    setModelUsage((current) => ({
                                      ...current,
                                      [model.id]: { ...usage, imageToImage: event.target.checked },
                                    }))
                                  }
                                />
                                图片参考生成
                              </label>
                            </div>
                          ) : usage.kind === "video" ? (
                            <span className="model-option__type-note">
                              <VideoCamera size={14} weight="bold" aria-hidden="true" />
                              视频生成
                            </span>
                          ) : usage.kind === "text" ? (
                            <span className="model-option__type-note">
                              <TextAa size={14} weight="bold" aria-hidden="true" />
                              对话补全 · 自动适配 OpenAI / Anthropic / Gemini 接口格式
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="model-list__empty">
                    <MagnifyingGlass size={20} weight="regular" aria-hidden="true" />
                    <strong>没有匹配的模型</strong>
                    <span>
                      {modelSearch.trim()
                        ? "尝试缩短名称或直接搜索模型 ID。"
                        : "当前分类暂无模型，可以切换到其他类型或全部模型。"}
                    </span>
                  </div>
                )}
              </div>

              <footer className="model-picker__footer">
                <div className="model-picker__summary" aria-live="polite">
                  <span>
                    <ImageSquare size={14} weight="bold" aria-hidden="true" />
                    图片模型 {selectedImageModelCount}
                  </span>
                  <span>
                    <VideoCamera size={14} weight="bold" aria-hidden="true" />
                    视频模型 {selectedVideoModelCount}
                  </span>
                  <span>
                    <TextAa size={14} weight="bold" aria-hidden="true" />
                    文本模型 {selectedTextModelCount}
                  </span>
                </div>
                <button
                  type="button"
                  className="model-save-action"
                  data-state={
                    busyAction === "saving-models" || busyAction === "testing-connection"
                      ? "loading"
                      : undefined
                  }
                  disabled={busyAction !== null}
                  onClick={() => {
                    void handleSaveModels();
                  }}
                >
                  {busyAction === "saving-models" || busyAction === "testing-connection" ? (
                    <CircleNotch size={16} weight="bold" aria-hidden="true" />
                  ) : (
                    <CheckCircle size={16} weight="bold" aria-hidden="true" />
                  )}
                  {busyAction === "saving-models"
                    ? "正在保存…"
                    : busyAction === "testing-connection"
                      ? "正在测试连通性…"
                      : "保存图片、视频与文本模型"}
                </button>
              </footer>

              {testNotice ? (
                <p className={testNotice.ok ? "settings-success" : "settings-error"} role="status">
                  {testNotice.ok ? (
                    <CheckCircle size={15} weight="fill" aria-hidden="true" />
                  ) : (
                    <WarningCircle size={15} weight="fill" aria-hidden="true" />
                  )}
                  {testNotice.message}
                </p>
              ) : null}
            </section>
          ) : busyAction == null ? (
            <div className="model-picker-placeholder">
              <span className="settings-step">02</span>
              <strong>模型会显示在这里</strong>
              <p>已保存的模型在打开设置时自动恢复；拉取模型可从接口刷新最新列表。</p>
            </div>
          ) : null}

          <TosStagingSettings client={tosClient} />
        </div>
      </section>
    </div>
  );
}
