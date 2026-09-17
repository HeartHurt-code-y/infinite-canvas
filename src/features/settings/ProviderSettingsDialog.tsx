import { Icon } from "../../components/Icon";
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
  type ProviderTokenGroup,
  type RemoteModelOption,
  type TosStagingClient,
} from "../../lib/backend";
import { AssetLibraryTokenSettings } from "./AssetLibraryTokenSettings";
import { ProviderTokenGroupSettings } from "./ProviderTokenGroupSettings";
import { TosStagingSettings } from "./TosStagingSettings";
import { assetLibraryProviders } from "../../lib/assetLibrarySupport";
import {
  ARK_ADAPTER_ID,
  BAILIAN_ADAPTER_ID,
  MOYU_ADAPTER_ID,
  assembleBailianBaseUrl,
  isArkAdapter,
  isBailianAdapter,
  isValidBailianWorkspaceId,
  parseBailianWorkspaceId,
} from "../../lib/providerAdapters";
import { SearchableMultiSelect } from "../../components/SearchableMultiSelect";

interface ProviderDraft {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly adapterId: string;
  readonly workspaceId: string;
}

/** 预置供应商连接模板：与后端 DEFAULT_PROVIDER_CONNECTIONS 保持一致。 */
interface ProviderPreset {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly adapterId: string;
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "aliyun-bailian",
    displayName: "阿里云百炼",
    baseUrl: "",
    adapterId: BAILIAN_ADAPTER_ID,
  },
  {
    id: "volcengine-ark",
    displayName: "火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    adapterId: ARK_ADAPTER_ID,
  },
  {
    id: "panqu-api",
    displayName: "盘趣API",
    // 必须用域名：直连 IP 115.191.2.88 的服务端证书只覆盖 *.panqu.com，TLS 校验会直接拒绝。
    baseUrl: "https://aiapis.panqu.com/",
    adapterId: MOYU_ADAPTER_ID,
  },
  {
    id: "moyu-ai",
    displayName: "魔芋AI",
    baseUrl: "https://www.moyu.info/",
    adapterId: MOYU_ADAPTER_ID,
  },
  {
    id: "overseas",
    displayName: "海外平台",
    baseUrl: "https://www.konjac.ai/v1",
    adapterId: MOYU_ADAPTER_ID,
  },
  {
    id: "sd20",
    displayName: "SD2.0",
    baseUrl: "https://47.94.250.161/",
    adapterId: MOYU_ADAPTER_ID,
  },
  {
    id: "maigateway",
    displayName: "MAIGateway",
    baseUrl: "https://mai.anquan.info/v1",
    adapterId: MOYU_ADAPTER_ID,
  },
];

/** 新建连接时是否启用预置模板选择。 */
const CUSTOM_PRESET_ID = "__custom__";

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
    adapterId: MOYU_ADAPTER_ID,
    workspaceId: "",
  };
}

/** 应用预置模板到新建连接草稿（保持草稿 id 不变）。 */
function applyProviderPreset(draft: ProviderDraft, preset: ProviderPreset): ProviderDraft {
  const workspaceId = isBailianAdapter(preset.adapterId)
    ? parseBailianWorkspaceId(preset.baseUrl)
    : "";
  return {
    id: draft.id,
    displayName: preset.displayName,
    baseUrl: isBailianAdapter(preset.adapterId)
      ? assembleBailianBaseUrl(workspaceId)
      : preset.baseUrl,
    adapterId: preset.adapterId,
    workspaceId,
  };
}

function providerDraft(provider: ProviderConnection): ProviderDraft {
  const workspaceId = isBailianAdapter(provider.adapterId)
    ? parseBailianWorkspaceId(provider.baseUrl)
    : "";
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    adapterId: provider.adapterId,
    workspaceId,
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
  const [tokenGroups, setTokenGroups] = useState<ProviderTokenGroup[]>([]);
  /** 每个模型使用的令牌分组（null = 供应商默认令牌），供保存绑定与回显。 */
  const [modelTokenGroups, setModelTokenGroups] = useState<Record<string, string | null>>({});
  /** 拉取模型时使用的令牌分组列表（空字符串 "" 表示默认令牌）。 */
  const [pullTokenGroups, setPullTokenGroups] = useState<string[]>([""]);
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
        setModelTokenGroups(
          Object.fromEntries(models.map((model) => [model.id, model.tokenGroup ?? null])),
        );
        setPullTokenGroups([""]);
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

  // 关键修复：子组件 ProviderTokenGroupSettings 的 reload 依赖 onTokenGroupsChanged 的引用身份。
  // 如果这里传入内联箭头函数，每次渲染都会生成新引用 → reload 重建 → effect 重跑 → 徽标
  // 「读取中/未配置」无限闪烁。用 useCallback 固定引用即可断开这个循环。
  const handleTokenGroupsChanged = useCallback((groups: readonly ProviderTokenGroup[]) => {
    setTokenGroups(Array.from(groups));
  }, []);

  const handleAssetProviderChanged = useCallback((providerConnectionId: string) => {
    setAssetTokenProviderId(providerConnectionId);
  }, []);

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

  // 素材库令牌只对实现了云端素材库的连接有意义：盘趣API 这类网关没有 `/v1/assets/*`，
  // 令牌与素材请求都无从落地，因此不出现在这里（该连接仍可正常用于模型生成）。
  const assetTokenProviders = useMemo(() => assetLibraryProviders(providers), [providers]);
  // 当前选中的连接没有素材库时，退到第一条可用连接，而不是让整段配置变成空状态。
  const assetTokenProvider =
    assetTokenProviders.find((provider) => provider.id === assetTokenProviderId) ??
    assetTokenProviders[0] ??
    null;

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

  // 所有分类计数统一从 remoteModels 列表 + modelUsage 推导，保证顶部标签与下方列表数量完全一致。
  // 不再单独用 Object.values(modelUsage) 统计，避免出现孤立条目或与列表不同步的情况。
  const modelTypeCounts = useMemo(() => {
    let image = 0;
    let video = 0;
    let text = 0;
    for (const model of remoteModels) {
      const usage = modelUsage[model.id] ?? emptyModelUsage();
      if (usage.kind === "image") image += 1;
      else if (usage.kind === "video") video += 1;
      else if (usage.kind === "text") text += 1;
    }
    return { all: remoteModels.length, image, video, text };
  }, [remoteModels, modelUsage]);

  if (!open) return null;

  const selectProvider = (providerId: string) => {
    if (apiKeyRef.current) apiKeyRef.current.value = "";
    setRemoteModels([]);
    setModelUsage({});
    setModelSearch("");
    setModelTypeFilter("all");
    setModelTokenGroups({});
    setPullTokenGroups([""]);
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

  const isNewProvider = !providers.some((provider) => provider.id === draft.id);
  const isVolcengineArkConnection = isArkAdapter(draft.adapterId);
  const isBailianConnection = isBailianAdapter(draft.adapterId);

  const validateConnectionDraft = (): { readonly apiKey: string } | null => {
    const existingProvider = providers.some((provider) => provider.id === draft.id);
    const apiKey = apiKeyRef.current?.value ?? "";
    if (!draft.displayName.trim()) {
      setRawError("供应商名称不能为空。");
      return null;
    }
    if (isBailianConnection) {
      if (!isValidBailianWorkspaceId(draft.workspaceId)) {
        setRawError("请填写业务空间 ID。地址会按华北2（北京）拼接为 https://{业务空间ID}.cn-beijing.maas.aliyuncs.com。");
        return null;
      }
    } else if (!draft.baseUrl.trim()) {
      setRawError("供应商名称和 Base URL 不能为空。完整地址会交给后端继续校验。");
      return null;
    }
    // 火山引擎方舟连接通过素材库令牌（AK/SK JSON）鉴权，供应商级 API Key 允许留空。
    if (!existingProvider && !apiKey && !isVolcengineArkConnection) {
      setRawError("新供应商连接需要输入 API Key；保存后密钥只进入系统凭据管理器。");
      return null;
    }
    return { apiKey };
  };

  const persistConnection = async (apiKey: string): Promise<ProviderConnection> => {
    const baseUrl = isBailianConnection
      ? assembleBailianBaseUrl(draft.workspaceId)
      : draft.baseUrl.trim();
    const provider = await client.upsertProviderConnection({
      id: draft.id,
      displayName: draft.displayName.trim(),
      adapterId: draft.adapterId,
      baseUrl,
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
      // 多分组令牌并行拉取，按 model.id 合并去重
      const results = await Promise.all(
        pullTokenGroups.map((group) =>
          client.fetchProviderModels(provider.id, group === "" ? null : group),
        ),
      );
      const merged = new Map<string, RemoteModelOption>();
      for (const models of results) {
        for (const model of models) {
          if (!merged.has(model.id)) {
            merged.set(model.id, model);
          }
        }
      }
      const models = Array.from(merged.values());
      setRemoteModels(models);
      setModelUsage(
        Object.fromEntries(models.map((model) => [model.id, initialModelUsage(model)])),
      );
      setModelTokenGroups(
        Object.fromEntries(models.map((model) => [model.id, model.tokenGroup ?? null])),
      );
      setModelSearch("");
      setModelTypeFilter("all");
      const groupLabels = pullTokenGroups.map((g) => (g === "" ? "默认令牌" : g));
      setSuccessMessage(
        `已保存连接，并从 ${provider.displayName}（${groupLabels.join("、")}）拉取 ${models.length} 个模型。`,
      );
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
          tokenGroup: modelTokenGroups[model.id] ?? null,
        };
      });
      await client.replaceProviderModelBindings(draft.id, selections);
      await onCatalogChanged();
      setSuccessMessage(
        `已保存 ${modelTypeCounts.image} 个图片模型、${modelTypeCounts.video} 个视频模型、${modelTypeCounts.text} 个文本模型，对应生成节点与文本功能使用的模型列表已更新。`,
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
            <Icon name="gear-six" aria-hidden="true" size="sm" />
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
            <Icon name="x" aria-hidden="true" size="lg" />
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
                  <Icon name="plus" aria-hidden="true" size="md" />
                  新建
                </button>
              </div>
            </div>

            <div className="provider-field-grid">
              {isNewProvider ? (
                <label className="provider-field--preset">
                  <span>预置模板</span>
                  <select
                    aria-label="预置模板"
                    value={CUSTOM_PRESET_ID}
                    onChange={(event) => {
                      if (event.target.value === CUSTOM_PRESET_ID) {
                        setDraft((current) => ({
                          ...emptyProviderDraft(),
                          id: current.id,
                        }));
                        return;
                      }
                      const preset = PROVIDER_PRESETS.find((p) => p.id === event.target.value);
                      if (preset) setDraft((current) => applyProviderPreset(current, preset));
                    }}
                    aria-describedby="preset-hint"
                  >
                    <option value={CUSTOM_PRESET_ID}>自定义（手动填写）</option>
                    {PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.displayName}
                      </option>
                    ))}
                  </select>
                  <small id="preset-hint">
                    选择预置模板会自动填入供应商名称与适配器。阿里云百炼需要填写业务空间
                    ID，地址按华北2（北京）拼接。
                  </small>
                </label>
              ) : null}
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
              {isBailianConnection ? (
                <label className="provider-field--url">
                  <span>业务空间 ID</span>
                  <input
                    id="provider-workspace-id"
                    value={draft.workspaceId}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="llm-xxxxxxxx"
                    onChange={(event) => {
                      const workspaceId = event.target.value;
                      setDraft((current) => ({
                        ...current,
                        workspaceId,
                        baseUrl: assembleBailianBaseUrl(workspaceId),
                      }));
                    }}
                    aria-describedby="workspace-id-hint"
                  />
                  <small id="workspace-id-hint">
                    仅阿里云百炼需要。华北2（北京）完整地址：
                    {assembleBailianBaseUrl(draft.workspaceId || "{WorkspaceId}")}
                  </small>
                </label>
              ) : (
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
              )}
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
                  {isVolcengineArkConnection
                    ? "用于拉取模型目录的方舟 API Key（Bearer 令牌）；素材库鉴权在下方「素材库令牌」处分别填写 AK 和 SK。"
                    : isBailianConnection
                      ? "阿里云百炼 API Key（Bearer）。须与业务空间同属华北2（北京）地域。"
                      : "只保存到系统凭据管理器（macOS 钥匙串 / Windows 凭据管理器），不写入数据库、画布或任务日志。"}
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
                  <Icon name="circle-notch" aria-hidden="true" size="md" />
                ) : (
                  <Icon name="floppy-disk" aria-hidden="true" size="md" />
                )}
                {busyAction === "saving-connection" ? "正在保存…" : "保存连接"}
              </button>
              <div className="provider-pull-token">
                <span>拉取令牌</span>
                <SearchableMultiSelect
                  options={[
                    { value: "", label: "默认令牌" },
                    ...tokenGroups.map((group) => ({
                      value: group.groupName,
                      label: group.groupName,
                    })),
                  ]}
                  value={pullTokenGroups}
                  onChange={(next) => setPullTokenGroups(Array.from(next))}
                  placeholder="选择拉取令牌分组"
                  searchPlaceholder="搜索分组…"
                  disabled={busyAction !== null}
                  ariaLabel="选择拉取模型的令牌分组"
                />
                <small id="provider-pull-token-hint">
                  可多选分组令牌并行拉取，合并去重后展示；已保存的模型绑定不会被重新拉取覆盖。
                </small>
              </div>
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
                  <Icon name="circle-notch" aria-hidden="true" size="md" />
                ) : (
                  <Icon name="magnifying-glass" aria-hidden="true" size="md" />
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
              <Icon name="check-circle" aria-hidden="true" size="md" />
              {successMessage}
            </p>
          ) : null}

          <AssetLibraryTokenSettings
            provider={assetTokenProvider}
            providers={assetTokenProviders}
            onProviderChanged={handleAssetProviderChanged}
            credentialClient={client}
            libraryClient={assetClient}
            onAssetsLoaded={onAssetLibraryLoaded}
            onPullStarted={onAssetLibraryLoading}
            onPullFailed={onAssetLibraryLoadFailed}
          />

          <ProviderTokenGroupSettings
            provider={providers.find((provider) => provider.id === assetTokenProviderId) ?? null}
            providers={providers}
            onProviderChanged={handleAssetProviderChanged}
            client={client}
            credentialClient={client}
            onTokenGroupsChanged={handleTokenGroupsChanged}
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
                    aria-label={`全部模型，${modelTypeCounts.all} 个`}
                    aria-pressed={modelTypeFilter === "all"}
                    onClick={() => setModelTypeFilter("all")}
                  >
                    全部
                    <span aria-hidden="true">{modelTypeCounts.all}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`文本模型，${modelTypeCounts.text} 个`}
                    aria-pressed={modelTypeFilter === "text"}
                    onClick={() => setModelTypeFilter("text")}
                  >
                    <Icon name="text-aa" aria-hidden="true" size="sm" />
                    文本
                    <span aria-hidden="true">{modelTypeCounts.text}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`图片模型，${modelTypeCounts.image} 个`}
                    aria-pressed={modelTypeFilter === "image"}
                    onClick={() => setModelTypeFilter("image")}
                  >
                    <Icon name="image-square" aria-hidden="true" size="sm" />
                    图片
                    <span aria-hidden="true">{modelTypeCounts.image}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`视频模型，${modelTypeCounts.video} 个`}
                    aria-pressed={modelTypeFilter === "video"}
                    onClick={() => setModelTypeFilter("video")}
                  >
                    <Icon name="video-camera" aria-hidden="true" size="sm" />
                    视频
                    <span aria-hidden="true">{modelTypeCounts.video}</span>
                  </button>
                </div>
                <label className="model-search">
                  <Icon name="magnifying-glass" aria-hidden="true" size="md" />
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
                                    <Icon name="image-square" aria-hidden="true" size="sm" />
                                    图片模型
                                  </>
                                ) : kind === "video" ? (
                                  <>
                                    <Icon name="video-camera" aria-hidden="true" size="sm" />
                                    视频模型
                                  </>
                                ) : (
                                  <>
                                    <Icon name="text-aa" aria-hidden="true" size="sm" />
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
                              <Icon name="video-camera" aria-hidden="true" size="sm" />
                              视频生成
                            </span>
                          ) : usage.kind === "text" ? (
                            <span className="model-option__type-note">
                              <Icon name="text-aa" aria-hidden="true" size="sm" />
                              对话补全 · 自动适配 OpenAI / Anthropic / Gemini 接口格式
                            </span>
                          ) : null}
                        </div>
                        <label className="model-option__token">
                          <span>调用令牌</span>
                          <select
                            value={modelTokenGroups[model.id] ?? ""}
                            onChange={(event) =>
                              setModelTokenGroups((current) => ({
                                ...current,
                                [model.id]: event.target.value ? event.target.value : null,
                              }))
                            }
                            aria-describedby={`${model.id}-token-hint`}
                          >
                            <option value="">默认令牌</option>
                            {tokenGroups.map((group) => (
                              <option key={group.id} value={group.groupName}>
                                {group.groupName}
                              </option>
                            ))}
                          </select>
                          <small id={`${model.id}-token-hint`}>
                            {modelTokenGroups[model.id] ?? "默认令牌"}{" "}
                            调用该模型；不同分组令牌可访问不同模型。
                          </small>
                        </label>
                      </article>
                    );
                  })
                ) : (
                  <div className="model-list__empty">
                    <Icon name="magnifying-glass" aria-hidden="true" size="xl" />
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
                    <Icon name="image-square" aria-hidden="true" size="sm" />
                    图片模型 {modelTypeCounts.image}
                  </span>
                  <span>
                    <Icon name="video-camera" aria-hidden="true" size="sm" />
                    视频模型 {modelTypeCounts.video}
                  </span>
                  <span>
                    <Icon name="text-aa" aria-hidden="true" size="sm" />
                    文本模型 {modelTypeCounts.text}
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
                    <Icon name="circle-notch" aria-hidden="true" size="md" />
                  ) : (
                    <Icon name="check-circle" aria-hidden="true" size="md" />
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
                    <Icon name="check-circle" aria-hidden="true" size="md" />
                  ) : (
                    <Icon name="warning-circle" aria-hidden="true" size="md" />
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
