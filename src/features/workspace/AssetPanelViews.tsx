//! 素材面板（#asset-panel）的分区子组件：从 WorkspaceApp 拆出，按 UI 区块划分。
//!
//! 状态与请求逻辑仍全部留在 WorkspaceApp，这里只做展示与事件转发；
//! DOM 结构与 aria 属性保持与拆分前一致（App.test.tsx 依赖这些语义）。

import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/Plus";
import { StackSimple } from "@phosphor-icons/react/StackSimple";
import { Trash } from "@phosphor-icons/react/Trash";
import { UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { UserFocus } from "@phosphor-icons/react/UserFocus";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState } from "react";
import {
  isDesktopRuntime,
  type AssetGroupRecord,
  type ProviderConnection,
} from "../../lib/backend";
import { AssetFlow, AssetPanelError, AssetUploadRow } from "./AssetLibraryViews";
import { AssetKindIcon } from "./PromptNodeViews";
import type { AssetItem, AssetKind, AssetLibrarySource, AssetUploadEntry } from "./workspaceModel";
import { ASSET_KIND_LABELS } from "./workspaceModel";

/** 素材面板标题行：面板名 + 上传入口。 */
export function AssetPanelHeader({
  uploadActionLabel,
  onImport,
}: {
  readonly uploadActionLabel: string;
  readonly onImport: () => void;
}) {
  return (
    <div className="panel-title-row">
      <div className="panel-title-row__identity">
        <StackSimple size={18} weight="bold" aria-hidden="true" />
        <h2>素材库</h2>
      </div>
      <button
        type="button"
        className="square-action"
        aria-label={uploadActionLabel}
        data-tooltip={uploadActionLabel}
        onClick={onImport}
      >
        <UploadSimple size={18} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

/** 断网提示条：文案按来源区分（本地素材仅影响对象存储预览/上传）。 */
export function AssetOfflineBanner({ source }: { readonly source: AssetLibrarySource }) {
  return (
    <div className="asset-panel__offline" role="status">
      <WarningCircle size={14} weight="fill" aria-hidden="true" />
      <span>
        {source === "local"
          ? "网络连接已断开，对象存储预览与上传暂时不可用。"
          : "网络连接已断开，云端拉取与上传暂时不可用；恢复后会自动刷新素材列表。"}
      </span>
    </div>
  );
}

/** 来源切换行：云端/本地下拉、整桶拉取（仅本地）、连接状态与就绪图标。 */
export function AssetOriginSwitcher({
  source,
  providerId,
  pullingBucket,
  assetsLoading,
  libraryError,
  onSourceChange,
  onPullBucket,
}: {
  readonly source: AssetLibrarySource;
  /** 当前云端供应商连接 ID；null = 未连接。 */
  readonly providerId: string | null;
  readonly pullingBucket: boolean;
  readonly assetsLoading: boolean;
  readonly libraryError: boolean;
  readonly onSourceChange: (next: AssetLibrarySource) => void;
  readonly onPullBucket: () => void;
}) {
  return (
    <div className="asset-origin">
      <label className="sr-only" htmlFor="asset-library-source">
        素材库来源
      </label>
      <select
        id="asset-library-source"
        aria-label="素材库来源"
        value={source}
        onChange={(event) => {
          onSourceChange(event.target.value as AssetLibrarySource);
        }}
      >
        <option value="cloud">云端素材</option>
        <option value="local">本地素材</option>
      </select>
      {source === "local" && isDesktopRuntime() ? (
        <button
          type="button"
          className="asset-origin__pull"
          aria-label="拉取整个存储桶的素材文件"
          disabled={pullingBucket}
          onClick={onPullBucket}
        >
          {pullingBucket ? (
            <CircleNotch size={12} weight="bold" aria-hidden="true" data-spin="true" />
          ) : (
            <ArrowsClockwise size={12} weight="bold" aria-hidden="true" />
          )}
          拉取整桶
        </button>
      ) : null}
      <span className="asset-origin__status">
        {source === "local"
          ? "本地索引 · 对象存储"
          : isDesktopRuntime()
            ? providerId != null
              ? "已连接"
              : "未连接"
            : "Moyu · 制作库"}
      </span>
      {assetsLoading ? (
        <CircleNotch size={14} weight="bold" aria-hidden="true" data-spin="true" />
      ) : libraryError ? (
        <WarningCircle size={14} weight="fill" aria-hidden="true" />
      ) : source === "local" || providerId != null || !isDesktopRuntime() ? (
        <CheckCircle size={14} weight="fill" aria-hidden="true" />
      ) : (
        <WarningCircle size={14} weight="fill" aria-hidden="true" />
      )}
    </div>
  );
}

/** 云端来源专属区：供应商切换下拉 + 明星真人素材 H5 入口。 */
export function AssetCloudControls({
  providerId,
  availableProviders,
  isOffline,
  onProviderChange,
  onOpenRealPersonDialog,
}: {
  readonly providerId: string | null;
  readonly availableProviders: readonly ProviderConnection[];
  readonly isOffline: boolean;
  readonly onProviderChange: (providerConnectionId: string) => void;
  readonly onOpenRealPersonDialog: () => void;
}) {
  return (
    <>
      <div className="asset-provider-switcher">
        <label htmlFor="asset-library-provider">供应商</label>
        <select
          id="asset-library-provider"
          aria-label="素材库供应商"
          value={providerId ?? ""}
          disabled={availableProviders.length === 0}
          onChange={(event) => {
            onProviderChange(event.target.value);
          }}
        >
          {availableProviders.length > 0 ? (
            availableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))
          ) : (
            <option value="">未配置启用的供应商</option>
          )}
        </select>
      </div>
      <button
        type="button"
        className="real-person-entry"
        disabled={!isDesktopRuntime() || providerId == null || isOffline}
        aria-label="打开明星真人素材 H5 认证与上传"
        onClick={onOpenRealPersonDialog}
      >
        <span className="real-person-entry__icon" aria-hidden="true">
          <UserFocus size={20} weight="duotone" />
        </span>
        <span className="real-person-entry__copy">
          <strong>明星真人素材</strong>
          <small>
            {providerId == null
              ? "先配置供应商与素材库令牌"
              : isOffline
                ? "网络恢复后可进行 H5 认证"
                : "H5 人脸认证 · 同人素材上传"}
          </small>
        </span>
        <CaretRight size={16} weight="bold" aria-hidden="true" />
      </button>
    </>
  );
}

/** 云端素材分组：新建/删除分组、分组下拉、加载失败重试。 */
export function AssetGroupsPicker({
  groups,
  selectedGroupId,
  loading,
  error,
  providerConnectionId,
  onGroupChange,
  onCreateGroup,
  onDeleteGroup,
  onRetry,
}: {
  readonly groups: readonly AssetGroupRecord[];
  readonly selectedGroupId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onGroupChange: (groupId: string | null, providerConnectionId: string) => void;
  readonly onCreateGroup: () => void;
  /** 删除云端素材库分组（连带组内全部素材，不可逆）；选中「全部素材」时不触发。 */
  readonly onDeleteGroup: (groupId: string) => void;
  /** 分组重试需要供应商 ID（分组区仅在已连接供应商时渲染）。 */
  readonly onRetry: (providerConnectionId: string) => void;
  readonly providerConnectionId: string;
}) {
  // 删除采用两段式确认：第一次点击进入「确认删除?」危险态，4 秒内再点才真正删除，
  // 避免误触；组件卸载或切换分组时取消计时，不残留到下次。
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteArmTimerRef = useRef<number | null>(null);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;

  useEffect(() => {
    return () => {
      if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    };
  }, []);

  const armDelete = () => {
    if (confirmingDelete || selectedGroupId == null) return;
    setConfirmingDelete(true);
    if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    deleteArmTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), 4_000);
  };
  const confirmDelete = () => {
    if (!confirmingDelete || selectedGroupId == null) return;
    if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    setConfirmingDelete(false);
    onDeleteGroup(selectedGroupId);
  };

  return (
    <div className="asset-groups">
      <div className="asset-groups__heading">
        <span className="asset-groups__title">分组</span>
      </div>
      <div className="asset-groups__select-row">
        <label className="sr-only" htmlFor="asset-group-select">
          素材库分组
        </label>
        <select
          id="asset-group-select"
          aria-label="素材库分组"
          value={selectedGroupId ?? ""}
          disabled={loading && groups.length === 0}
          onChange={(event) => {
            const value = event.target.value;
            setConfirmingDelete(false);
            if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
            onGroupChange(value ? value : null, providerConnectionId);
          }}
        >
          <option value="">全部素材</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
              {group.isDefault ? " · 默认" : ""}
            </option>
          ))}
        </select>
        {loading ? (
          <CircleNotch size={14} weight="bold" data-spin="true" aria-hidden="true" />
        ) : null}
        <div className="asset-groups__actions">
          <button
            type="button"
            className="asset-groups__create"
            aria-label="新建素材分组"
            onClick={onCreateGroup}
          >
            <Plus size={12} weight="bold" aria-hidden="true" />
            新建分组
          </button>
          {selectedGroupId != null ? (
            <button
              type="button"
              className={`asset-groups__delete${confirmingDelete ? " is-armed" : ""}`}
              aria-label={
                confirmingDelete
                  ? `确认删除分组：${selectedGroup?.name ?? ""}`
                  : `删除分组：${selectedGroup?.name ?? ""}`
              }
              onClick={confirmingDelete ? confirmDelete : armDelete}
            >
              <Trash size={12} weight="bold" aria-hidden="true" />
              {confirmingDelete ? "确认删除？" : "删除分组"}
            </button>
          ) : null}
        </div>
      </div>
      {selectedGroup != null && !confirmingDelete ? (
        <span className="asset-groups__upload-hint" role="status">
          上传的素材会归入「{selectedGroup.name}」，不会落到其他分组。
        </span>
      ) : null}
      {confirmingDelete ? (
        <span className="asset-groups__delete-hint" role="status">
          <WarningCircle size={13} weight="fill" aria-hidden="true" />
          分组及组内全部素材将从云端永久删除，此操作不可撤销。
        </span>
      ) : null}
      {error ? (
        <span className="asset-groups__error" role="status">
          <WarningCircle size={13} weight="fill" aria-hidden="true" />
          分组加载失败，仍显示全部素材
          <button type="button" onClick={() => onRetry(providerConnectionId)}>
            重试
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** 素材类型 Tab：图片/视频/音频，角标计数由调用方按来源解析（null = 尚无计数，不显示）。 */
export function AssetKindTabs({
  kind,
  getKindCount,
  onKindChange,
}: {
  readonly kind: AssetKind;
  readonly getKindCount: (kind: AssetKind) => number | null;
  readonly onKindChange: (kind: AssetKind) => void;
}) {
  return (
    <div className="asset-tabs" role="tablist" aria-label="素材类型">
      {(["image", "video", "audio"] as const).map((tabKind) => {
        const kindCount = getKindCount(tabKind);
        return (
          <button
            key={tabKind}
            type="button"
            role="tab"
            aria-label={
              kindCount == null
                ? ASSET_KIND_LABELS[tabKind]
                : `${ASSET_KIND_LABELS[tabKind]} ${kindCount}`
            }
            aria-selected={kind === tabKind}
            onClick={() => {
              onKindChange(tabKind);
            }}
          >
            <AssetKindIcon kind={tabKind} />
            <span className="asset-tab__label">{ASSET_KIND_LABELS[tabKind]}</span>
            {kindCount != null ? <span>{kindCount}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 素材搜索行：关键词输入、云端刷新签名、清除按钮与屏幕阅读器计数。 */
export function AssetSearchBar({
  kind,
  source,
  providerId,
  search,
  searchPending,
  resultSummary,
  onSearchChange,
  onRefreshCloud,
}: {
  readonly kind: AssetKind;
  readonly source: AssetLibrarySource;
  readonly providerId: string | null;
  readonly search: string;
  readonly searchPending: boolean;
  /** 屏幕阅读器计数文案（浏览器=全库数，本地=总数，云端=本页数）。 */
  readonly resultSummary: string;
  readonly onSearchChange: (value: string) => void;
  readonly onRefreshCloud: () => void;
}) {
  return (
    <div className="asset-search-group">
      <label className="asset-search-label" htmlFor="asset-search-input">
        筛选当前素材
      </label>
      <div className="asset-search">
        <MagnifyingGlass size={16} weight="bold" aria-hidden="true" />
        <input
          id="asset-search-input"
          type="search"
          aria-label={`搜索${ASSET_KIND_LABELS[kind]}素材`}
          aria-describedby="asset-search-status"
          aria-controls="asset-grid"
          placeholder={`搜索${ASSET_KIND_LABELS[kind]}素材`}
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
        />
        {source === "cloud" && providerId != null ? (
          <button
            type="button"
            className="asset-search__refresh"
            aria-label="刷新素材列表（重新获取视频签名 URL）"
            data-tooltip="刷新素材列表"
            onClick={onRefreshCloud}
          >
            <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
        {search ? (
          <button
            type="button"
            className="asset-search__clear"
            aria-label="清除素材搜索"
            onClick={() => {
              onSearchChange("");
            }}
          >
            <X size={14} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <span
        id="asset-search-status"
        className="sr-only"
        role="status"
        aria-atomic="true"
        aria-busy={searchPending}
      >
        {resultSummary}
      </span>
    </div>
  );
}

/** 素材网格空态：按加载/错误/来源派生提示文案与操作按钮。 */
export function AssetEmptyState({
  source,
  loading,
  libraryError,
  hasProvider,
  search,
  uploadGroupName,
  onClearSearch,
  onImport,
}: {
  readonly source: AssetLibrarySource;
  readonly loading: boolean;
  readonly libraryError: boolean;
  readonly hasProvider: boolean;
  readonly search: string;
  /** 当前选中的云端分组名；非 null 时上传会直接归入该分组，空态里点明去向。 */
  readonly uploadGroupName: string | null;
  readonly onClearSearch: () => void;
  readonly onImport: () => void;
}) {
  return (
    <div className="asset-empty">
      {loading ? (
        <CircleNotch size={24} weight="bold" aria-hidden="true" data-spin="true" />
      ) : libraryError ? (
        <WarningCircle size={24} weight="fill" aria-hidden="true" />
      ) : (
        <MagnifyingGlass size={24} weight="regular" aria-hidden="true" />
      )}
      <strong>
        {loading
          ? source === "local"
            ? "正在读取本地素材…"
            : "正在拉取云端素材…"
          : libraryError
            ? source === "local"
              ? "本地素材库不可用"
              : "云端素材库不可用"
            : "没有找到素材"}
      </strong>
      <span>
        {loading
          ? source === "local"
            ? "正在从本机索引签发对象存储预览地址。"
            : "云端素材库正在同步，稍候即可看到最新素材。"
          : libraryError
            ? source === "local"
              ? "无法读取本地索引或对象存储配置，详情见上方错误信息。"
              : "云端请求失败（可能是供应商故障或鉴权问题），详情见上方错误信息，稍后可点击「重新拉取」重试。"
            : source === "cloud" && isDesktopRuntime() && !hasProvider
              ? "请先在全局设置中配置并启用供应商连接。"
              : isDesktopRuntime()
                ? source === "local"
                  ? "上传的素材只会写入对象存储，不会导入云端素材库。"
                  : uploadGroupName != null
                    ? `该分组还没有素材；从此处上传的素材会归入「${uploadGroupName}」。`
                    : "试试上传本地素材，或切换素材类型。"
                : "试试更短的名称，或切换素材类型。"}
      </span>
      {!loading && search ? (
        <button type="button" onClick={onClearSearch}>
          <X size={14} weight="bold" aria-hidden="true" />
          清除搜索
        </button>
      ) : null}
      {!loading && isDesktopRuntime() && (source === "local" || hasProvider) ? (
        <button type="button" onClick={onImport}>
          <UploadSimple size={14} weight="bold" aria-hidden="true" />
          {source === "local" ? "上传到本地素材库" : "上传本地素材"}
        </button>
      ) : null}
    </div>
  );
}

/** 分页控件：本地显示「第 x/y 页 · 共 N 个」，云端仅页码（上游无总数）。 */
export function AssetPagination({
  source,
  localPage,
  localTotalPages,
  localTotal,
  cloudPage,
  cloudHasMore,
  onLocalPageChange,
  onCloudPageChange,
}: {
  readonly source: AssetLibrarySource;
  readonly localPage: number;
  readonly localTotalPages: number;
  readonly localTotal: number;
  readonly cloudPage: number;
  readonly cloudHasMore: boolean;
  readonly onLocalPageChange: (page: number) => void;
  readonly onCloudPageChange: (page: number) => void;
}) {
  const currentPage = source === "local" ? localPage : cloudPage;
  // 云端上游无过滤总数，无法钳制上限；超出范围的页码会返回空页，用上一页/跳转自然纠正。
  const maxPage = source === "local" ? localTotalPages : null;
  const [pageDraft, setPageDraft] = useState("");

  const submitPageJump = () => {
    const parsed = Number.parseInt(pageDraft, 10);
    if (Number.isNaN(parsed)) return;
    let target = Math.max(1, parsed);
    if (maxPage != null) target = Math.min(maxPage, target);
    setPageDraft("");
    if (target === currentPage) return;
    if (source === "local") onLocalPageChange(target);
    else onCloudPageChange(target);
  };

  return (
    <div className="asset-pagination">
      <span>
        {source === "local"
          ? `第 ${localPage} / ${localTotalPages} 页 · 共 ${localTotal} 个`
          : `第 ${cloudPage} 页`}
      </span>
      <span className="asset-pagination__controls">
        <button
          type="button"
          disabled={source === "local" ? localPage <= 1 : cloudPage <= 1}
          aria-label="上一页素材"
          onClick={() => {
            if (source === "local") onLocalPageChange(localPage - 1);
            else onCloudPageChange(cloudPage - 1);
          }}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={source === "local" ? localPage >= localTotalPages : !cloudHasMore}
          aria-label="下一页素材"
          onClick={() => {
            if (source === "local") onLocalPageChange(localPage + 1);
            else onCloudPageChange(cloudPage + 1);
          }}
        >
          下一页
        </button>
        <span className="asset-pagination__jump">
          <label className="sr-only" htmlFor="asset-page-jump-input">
            跳转到指定页码
          </label>
          <span aria-hidden="true">跳至</span>
          <input
            id="asset-page-jump-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxPage ?? undefined}
            placeholder={String(currentPage)}
            value={pageDraft}
            aria-label="跳转到指定页码"
            onChange={(event) => {
              setPageDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitPageJump();
            }}
          />
          <span aria-hidden="true">页</span>
          <button type="button" aria-label="跳转到输入的页码" onClick={submitPageJump}>
            跳转
          </button>
        </span>
      </span>
    </div>
  );
}

/**
 * 素材面板整卡：组合以上分区子组件。
 * 事件回调在 WorkspaceApp 侧组装（含刷新/翻页等副作用），这里只做展示与转发。
 */
export function AssetPanel({
  mobileOpen,
  onCloseMobilePanel,
  uploadActionLabel,
  onImportLocalAssets,
  isOffline,
  source,
  onSourceChange,
  pullingBucket,
  onPullBucket,
  providerId,
  availableProviders,
  onProviderChange,
  onOpenRealPersonDialog,
  assetsLoading,
  libraryError,
  assetsError,
  onRetryLocal,
  onRetryCloud,
  uploads,
  onDismissUpload,
  groups,
  groupsLoading,
  groupsError,
  selectedGroupId,
  onGroupChange,
  onRefreshGroups,
  onCreateGroup,
  onDeleteGroup,
  kind,
  getKindCount,
  onKindChange,
  search,
  onSearchChange,
  searchPending,
  resultSummary,
  uploadGroupName,
  visibleAssets,
  onPreviewAsset,
  onDropAssetToCanvas,
  localPage,
  localTotalPages,
  localTotal,
  cloudPage,
  cloudHasMore,
  onLocalPageChange,
  onCloudPageChange,
}: {
  /** 移动端抽屉是否展开（mobilePanel === "assets"）。 */
  readonly mobileOpen: boolean;
  readonly onCloseMobilePanel: () => void;
  /** 上传按钮的 aria/tooltip 文案（按来源区分）。 */
  readonly uploadActionLabel: string;
  readonly onImportLocalAssets: () => void;
  /** 全局断网标记（仅桌面端展示提示条）。 */
  readonly isOffline: boolean;
  readonly source: AssetLibrarySource;
  readonly onSourceChange: (next: AssetLibrarySource) => void;
  readonly pullingBucket: boolean;
  readonly onPullBucket: () => void;
  readonly providerId: string | null;
  readonly availableProviders: readonly ProviderConnection[];
  readonly onProviderChange: (providerConnectionId: string) => void;
  readonly onOpenRealPersonDialog: () => void;
  /** 当前来源的加载/库错误/上传错误状态。 */
  readonly assetsLoading: boolean;
  readonly libraryError: boolean;
  readonly assetsError: string | null;
  readonly onRetryLocal: () => void;
  readonly onRetryCloud: () => void;
  readonly uploads: readonly AssetUploadEntry[];
  readonly onDismissUpload: (jobId: string) => void;
  readonly groups: readonly AssetGroupRecord[];
  readonly groupsLoading: boolean;
  readonly groupsError: string | null;
  readonly selectedGroupId: string | null;
  readonly onGroupChange: (groupId: string | null, providerConnectionId: string) => void;
  readonly onRefreshGroups: (providerConnectionId: string) => void;
  readonly onCreateGroup: () => void;
  /** 删除云端素材库分组（连带组内全部素材，不可逆）。 */
  readonly onDeleteGroup: (groupId: string) => void;
  readonly kind: AssetKind;
  /**
   * Tab 角标计数：浏览器=演示数据计数，本地=分页响应全库计数，
   * 云端=面板打开时扫一次全库的类型计数（null = 尚无计数，不显示角标）。
   */
  readonly getKindCount: (kind: AssetKind) => number | null;
  readonly onKindChange: (kind: AssetKind) => void;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly searchPending: boolean;
  readonly resultSummary: string;
  /** 当前选中的云端分组名：空态里据此说明上传去向。 */
  readonly uploadGroupName: string | null;
  readonly visibleAssets: readonly AssetItem[];
  readonly onPreviewAsset: (asset: AssetItem) => void;
  readonly onDropAssetToCanvas: (asset: AssetItem, clientX: number, clientY: number) => void;
  readonly localPage: number;
  readonly localTotalPages: number;
  readonly localTotal: number;
  readonly cloudPage: number;
  readonly cloudHasMore: boolean;
  readonly onLocalPageChange: (page: number) => void;
  readonly onCloudPageChange: (page: number) => void;
}) {
  return (
    <aside
      id="asset-panel"
      className={`asset-panel${mobileOpen ? " is-mobile-open" : ""}`}
      aria-label="素材库"
    >
      <button
        type="button"
        className="mobile-panel-close mobile-panel-close--assets"
        aria-label="关闭素材库"
        onClick={onCloseMobilePanel}
      >
        <X size={18} weight="bold" aria-hidden="true" />
      </button>
      <AssetPanelHeader
        uploadActionLabel={uploadActionLabel}
        onImport={() => {
          onImportLocalAssets();
        }}
      />
      {isDesktopRuntime() && isOffline ? <AssetOfflineBanner source={source} /> : null}
      <AssetOriginSwitcher
        source={source}
        providerId={providerId}
        pullingBucket={pullingBucket}
        assetsLoading={assetsLoading}
        libraryError={libraryError}
        onSourceChange={onSourceChange}
        onPullBucket={onPullBucket}
      />
      {source === "cloud" ? (
        <AssetCloudControls
          providerId={providerId}
          availableProviders={availableProviders}
          isOffline={isOffline}
          onProviderChange={onProviderChange}
          onOpenRealPersonDialog={onOpenRealPersonDialog}
        />
      ) : null}
      {assetsError ? (
        <AssetPanelError
          title={
            libraryError
              ? source === "local"
                ? "本地素材库不可用"
                : "云端素材库不可用"
              : "素材上传失败"
          }
          error={assetsError}
          actionLabel={libraryError ? (source === "local" ? "重新读取" : "重新拉取") : undefined}
          onAction={
            libraryError && (source === "local" || providerId != null)
              ? source === "local"
                ? onRetryLocal
                : onRetryCloud
              : undefined
          }
        />
      ) : null}
      {uploads.length > 0 ? (
        <ul className="asset-uploads" aria-label="本地上传进度">
          {uploads.map((entry) => (
            <AssetUploadRow
              key={entry.jobId}
              entry={entry}
              onDismiss={() => onDismissUpload(entry.jobId)}
            />
          ))}
        </ul>
      ) : null}
      {source === "cloud" && isDesktopRuntime() && providerId != null ? (
        <AssetGroupsPicker
          groups={groups}
          selectedGroupId={selectedGroupId}
          loading={groupsLoading}
          error={groupsError}
          providerConnectionId={providerId}
          onGroupChange={onGroupChange}
          onCreateGroup={onCreateGroup}
          onDeleteGroup={onDeleteGroup}
          onRetry={onRefreshGroups}
        />
      ) : null}
      <AssetKindTabs kind={kind} getKindCount={getKindCount} onKindChange={onKindChange} />
      <AssetSearchBar
        kind={kind}
        source={source}
        providerId={providerId}
        search={search}
        searchPending={searchPending}
        resultSummary={resultSummary}
        onSearchChange={onSearchChange}
        onRefreshCloud={onRetryCloud}
      />
      <div id="asset-grid" className="asset-grid" aria-busy={assetsLoading || searchPending}>
        {visibleAssets.length > 0 ? (
          <AssetFlow
            assets={visibleAssets}
            onPreview={onPreviewAsset}
            onDropToCanvas={onDropAssetToCanvas}
          />
        ) : (
          <AssetEmptyState
            source={source}
            loading={assetsLoading}
            libraryError={libraryError}
            hasProvider={providerId != null}
            search={search}
            uploadGroupName={uploadGroupName}
            onClearSearch={() => {
              onSearchChange("");
            }}
            onImport={() => {
              onImportLocalAssets();
            }}
          />
        )}
        {isDesktopRuntime() &&
        !assetsLoading &&
        !libraryError &&
        (source === "local"
          ? localTotal > 0 || localPage > 1
          : visibleAssets.length > 0 || cloudPage > 1) ? (
          <AssetPagination
            source={source}
            localPage={localPage}
            localTotalPages={localTotalPages}
            localTotal={localTotal}
            cloudPage={cloudPage}
            cloudHasMore={cloudHasMore}
            onLocalPageChange={onLocalPageChange}
            onCloudPageChange={onCloudPageChange}
          />
        ) : null}
      </div>
      <p className="asset-panel__hint">
        单击素材查看源媒体与完整信息；拖到画布创建节点，连线后可在提示词中 @ 引用。
      </p>
    </aside>
  );
}
