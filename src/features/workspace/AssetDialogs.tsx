import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOut } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Copy } from "@phosphor-icons/react/Copy";
import { FolderSimplePlus } from "@phosphor-icons/react/FolderSimplePlus";
import { IdentificationBadge } from "@phosphor-icons/react/IdentificationBadge";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Trash } from "@phosphor-icons/react/Trash";
import { UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { Waveform as WaveformIcon } from "@phosphor-icons/react/Waveform";
import { X } from "@phosphor-icons/react/X";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import {
  assetLibraryClient,
  formatRawBackendError,
  type RealPersonAssetLibraryClient,
  type RealPersonAuthLink,
  type RealPersonGroup,
} from "../../lib/backend";
import { copyTextToDesktopClipboard, openExternalUrl } from "./desktopActions";
import { AssetMediaState } from "./AssetLibraryViews";
import type { AssetItem } from "./workspaceModel";
import {
  ASSET_CLOUD_STATUS_LABELS,
  ASSET_KIND_LABELS,
  assetErrorPresentation,
} from "./workspaceModel";

type RealPersonDialogClient = Pick<
  RealPersonAssetLibraryClient,
  "createRealPersonAuthLink" | "listRealPersonGroups"
>;

function realPersonErrorSummary(error: unknown): string {
  return assetErrorPresentation(formatRawBackendError(error)).summary;
}

function formatAuthorizedAt(value: string | null): string {
  if (value == null) return "时间待同步";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function RealPersonAssetDialog({
  providerConnectionId,
  providerDisplayName,
  onClose,
  onUploadToGroup,
  client = assetLibraryClient,
  copyLink = copyTextToDesktopClipboard,
  openLink = openExternalUrl,
}: {
  readonly providerConnectionId: string;
  readonly providerDisplayName: string;
  readonly onClose: () => void;
  readonly onUploadToGroup: (group: RealPersonGroup) => Promise<number>;
  readonly client?: RealPersonDialogClient;
  readonly copyLink?: (url: string) => Promise<void>;
  readonly openLink?: (url: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const artistNameRef = useRef<HTMLInputElement | null>(null);
  const groupRequestRef = useRef(0);
  const pendingArtistNameRef = useRef<string | null>(null);
  const [artistName, setArtistName] = useState("");
  const [artistDesc, setArtistDesc] = useState("");
  const [authLink, setAuthLink] = useState<RealPersonAuthLink | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [groups, setGroups] = useState<readonly RealPersonGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [linkBusy, setLinkBusy] = useState(false);
  const [uploadingGroupId, setUploadingGroupId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const secondsRemaining =
    expiresAt == null ? 0 : Math.max(0, Math.ceil((expiresAt - clockNow) / 1000));
  const linkExpired = authLink != null && secondsRemaining === 0;

  const refreshGroups = useCallback(
    async (showBusy: boolean) => {
      const requestId = ++groupRequestRef.current;
      if (showBusy) setGroupsLoading(true);
      try {
        const nextGroups = await client.listRealPersonGroups(providerConnectionId);
        if (requestId !== groupRequestRef.current) return;
        setGroups(nextGroups);
        setError(null);
        const pendingArtistName = pendingArtistNameRef.current;
        if (
          pendingArtistName &&
          nextGroups.some((group) => group.artistName === pendingArtistName)
        ) {
          setNotice(`已检测到“${pendingArtistName}”认证成功，可以上传同一人的素材。`);
          pendingArtistNameRef.current = null;
          setAuthLink(null);
          setExpiresAt(null);
        }
      } catch (refreshError: unknown) {
        if (requestId !== groupRequestRef.current) return;
        if (showBusy) setError(realPersonErrorSummary(refreshError));
      } finally {
        if (requestId === groupRequestRef.current) setGroupsLoading(false);
      }
    },
    [client, providerConnectionId],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    artistNameRef.current?.focus();
    void Promise.resolve().then(() => refreshGroups(false));
    return () => {
      groupRequestRef.current += 1;
      if (dialog.hasAttribute("open")) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [refreshGroups]);

  useEffect(() => {
    if (authLink == null || expiresAt == null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      if (now < expiresAt) void refreshGroups(false);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [authLink, expiresAt, refreshGroups]);

  const createAuthLink = async () => {
    const normalizedName = artistName.trim();
    if (!normalizedName) {
      setError("请输入明星或授权人的名称。");
      artistNameRef.current?.focus();
      return;
    }
    setLinkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const link = await client.createRealPersonAuthLink({
        providerConnectionId,
        artistName: normalizedName,
        artistDesc: artistDesc.trim() || null,
      });
      const now = Date.now();
      setAuthLink(link);
      pendingArtistNameRef.current = normalizedName;
      setClockNow(now);
      setExpiresAt(now + 120_000);
      setNotice("认证链接已生成，请在 120 秒内让本人用手机完成刷脸认证。");
    } catch (createError: unknown) {
      setError(realPersonErrorSummary(createError));
    } finally {
      setLinkBusy(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="real-person-dialog"
      aria-labelledby="real-person-dialog-title"
      aria-describedby="real-person-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="real-person-dialog__header">
        <div className="real-person-dialog__title-row">
          <span className="real-person-dialog__mark" aria-hidden="true">
            <IdentificationBadge size={24} weight="duotone" />
          </span>
          <div>
            <p className="real-person-dialog__eyebrow">REAL PERSON · H5 AUTH</p>
            <h2 id="real-person-dialog-title">明星真人素材</h2>
          </div>
        </div>
        <p id="real-person-dialog-description">
          先由本人完成一次性人脸认证，再把同一个人的图片、视频或音频上传到授权组。
        </p>
        <button
          type="button"
          className="real-person-dialog__close"
          aria-label="关闭明星素材"
          onClick={onClose}
        >
          <X size={20} weight="bold" aria-hidden="true" />
        </button>
      </header>

      <div className="real-person-dialog__body">
        <section className="real-person-auth" aria-labelledby="real-person-auth-title">
          <div className="real-person-section-heading">
            <div>
              <p className="real-person-section-heading__step">步骤 1</p>
              <h3 id="real-person-auth-title">创建 H5 认证链接</h3>
            </div>
            <span>{providerDisplayName}</span>
          </div>
          <form
            className="real-person-auth__form"
            onSubmit={(event) => {
              event.preventDefault();
              void createAuthLink();
            }}
          >
            <label htmlFor="real-person-artist-name">
              明星 / 授权人名称
              <span aria-hidden="true">*</span>
            </label>
            <input
              ref={artistNameRef}
              id="real-person-artist-name"
              value={artistName}
              maxLength={32}
              required
              autoComplete="off"
              placeholder="例如：张三"
              onChange={(event) => setArtistName(event.target.value)}
            />
            <span className="real-person-auth__counter">{artistName.length} / 32</span>

            <label htmlFor="real-person-artist-desc">用途说明（可选）</label>
            <textarea
              id="real-person-artist-desc"
              value={artistDesc}
              maxLength={300}
              rows={3}
              placeholder="例如：品牌代言人真人素材组"
              onChange={(event) => setArtistDesc(event.target.value)}
            />
            <span className="real-person-auth__counter">{artistDesc.length} / 300</span>

            <button
              type="submit"
              className="real-person-primary-action"
              disabled={linkBusy || !artistName.trim()}
            >
              {linkBusy ? (
                <CircleNotch size={16} weight="bold" data-spin="true" aria-hidden="true" />
              ) : (
                <IdentificationBadge size={17} weight="bold" aria-hidden="true" />
              )}
              {linkBusy ? "正在生成…" : authLink ? "重新生成认证链接" : "生成认证链接"}
            </button>
          </form>

          {authLink ? (
            <div className="real-person-link" data-expired={linkExpired}>
              <div className="real-person-link__status">
                <strong>{linkExpired ? "链接已过期" : "一次性链接已就绪"}</strong>
                <span aria-live="polite">
                  {linkExpired
                    ? "请重新生成"
                    : `${String(Math.floor(secondsRemaining / 60)).padStart(2, "0")}:${String(secondsRemaining % 60).padStart(2, "0")} 后失效`}
                </span>
              </div>
              <code>{authLink.h5Url}</code>
              <div className="real-person-link__actions">
                <button
                  type="button"
                  disabled={linkExpired}
                  onClick={() => {
                    void copyLink(authLink.h5Url).then(
                      () => setNotice("认证链接已复制，可发送给本人在手机上打开。"),
                      (copyError: unknown) => setError(realPersonErrorSummary(copyError)),
                    );
                  }}
                >
                  <Copy size={16} weight="bold" aria-hidden="true" />
                  复制链接
                </button>
                <button
                  type="button"
                  disabled={linkExpired}
                  onClick={() => {
                    void openLink(authLink.h5Url).catch((openError: unknown) =>
                      setError(realPersonErrorSummary(openError)),
                    );
                  }}
                >
                  <ArrowSquareOut size={16} weight="bold" aria-hidden="true" />
                  浏览器打开
                </button>
              </div>
              <p>{authLink.tip ?? "链接有效期 120 秒，使用一次后失效。"}</p>
            </div>
          ) : null}

          {error ? (
            <p className="real-person-dialog__message" data-state="error" role="alert">
              <WarningCircle size={16} weight="fill" aria-hidden="true" />
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="real-person-dialog__message" data-state="success" role="status">
              <CheckCircle size={16} weight="fill" aria-hidden="true" />
              {notice}
            </p>
          ) : null}
        </section>

        <section className="real-person-groups" aria-labelledby="real-person-groups-title">
          <div className="real-person-section-heading">
            <div>
              <p className="real-person-section-heading__step">步骤 2</p>
              <h3 id="real-person-groups-title">选择已授权明星组</h3>
            </div>
            <button
              type="button"
              className="real-person-refresh"
              disabled={groupsLoading}
              aria-label="刷新已授权明星组"
              onClick={() => void refreshGroups(true)}
            >
              <ArrowClockwise
                size={16}
                weight="bold"
                data-spin={groupsLoading ? "true" : undefined}
                aria-hidden="true"
              />
              刷新
            </button>
          </div>

          <p className="real-person-groups__hint">
            上传时使用下方平台组 ID。系统会校验素材人脸与认证本人一致。
          </p>

          {groupsLoading && groups.length === 0 ? (
            <div className="real-person-groups__empty" role="status">
              <CircleNotch size={22} weight="bold" data-spin="true" aria-hidden="true" />
              <span>正在读取已授权明星组…</span>
            </div>
          ) : groups.length === 0 ? (
            <div className="real-person-groups__empty">
              <IdentificationBadge size={28} weight="duotone" aria-hidden="true" />
              <strong>还没有完成认证的明星组</strong>
              <span>生成链接并由本人刷脸后，这里会自动出现授权组。</span>
            </div>
          ) : (
            <ul className="real-person-group-list">
              {groups.map((group) => (
                <li key={group.id} className="real-person-group-card">
                  <div className="real-person-group-card__header">
                    <span className="real-person-group-card__avatar" aria-hidden="true">
                      {group.artistName.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{group.artistName}</strong>
                      <span>{group.artistDesc ?? "已完成人脸授权"}</span>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>平台组 ID</dt>
                      <dd>{group.id}</dd>
                    </div>
                    <div>
                      <dt>已有素材</dt>
                      <dd>{group.assetCount} 个</dd>
                    </div>
                    <div>
                      <dt>授权时间</dt>
                      <dd>{formatAuthorizedAt(group.authorizedAt)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="real-person-upload-action"
                    disabled={uploadingGroupId != null}
                    onClick={() => {
                      setUploadingGroupId(group.id);
                      setError(null);
                      void onUploadToGroup(group)
                        .then((count) => {
                          if (count > 0) {
                            setNotice(
                              `已将 ${count} 个文件加入“${group.artistName}”真人素材上传队列。`,
                            );
                          }
                        })
                        .catch((uploadError: unknown) =>
                          setError(realPersonErrorSummary(uploadError)),
                        )
                        .finally(() => setUploadingGroupId(null));
                    }}
                  >
                    {uploadingGroupId === group.id ? (
                      <CircleNotch size={16} weight="bold" data-spin="true" aria-hidden="true" />
                    ) : (
                      <UploadSimple size={16} weight="bold" aria-hidden="true" />
                    )}
                    {uploadingGroupId === group.id ? "正在选择…" : "上传同一人的素材"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

export function AssetGroupCreateDialog({
  providerDisplayName,
  onClose,
  onCreate,
  busy,
}: {
  readonly providerDisplayName: string;
  readonly onClose: () => void;
  readonly onCreate: (name: string) => void;
  readonly busy: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !busy;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    inputRef.current?.focus();

    return () => {
      if (dialog.hasAttribute("open")) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="asset-group-dialog"
      aria-labelledby="asset-group-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="asset-group-dialog__header">
        <div className="asset-group-dialog__title-row">
          <span className="asset-group-dialog__mark" aria-hidden="true">
            <FolderSimplePlus size={22} weight="duotone" />
          </span>
          <div>
            <p className="asset-group-dialog__eyebrow">ASSET LIBRARY · GROUP</p>
            <h2 id="asset-group-dialog-title">新建素材分组</h2>
          </div>
        </div>
        <p>分组按当前令牌作用域隔离；所有供应商和平台共用同一套素材库接口。</p>
        <button
          type="button"
          className="asset-group-dialog__close"
          aria-label="关闭新建分组"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} weight="bold" aria-hidden="true" />
        </button>
      </header>

      <div className="asset-group-dialog__body">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) onCreate(trimmed);
          }}
        >
          <label htmlFor="asset-group-name">
            分组名称
            <span aria-hidden="true">*</span>
          </label>
          <input
            ref={inputRef}
            id="asset-group-name"
            value={name}
            maxLength={64}
            required
            autoComplete="off"
            placeholder="例如：客户 A 品牌物料"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="asset-group-dialog__counter">{name.length} / 64</span>
          <span className="asset-group-dialog__hint">当前供应商连接：{providerDisplayName}</span>
          <div className="asset-group-dialog__actions">
            <button type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="real-person-primary-action" disabled={!canCreate}>
              {busy ? (
                <CircleNotch size={16} weight="bold" data-spin="true" aria-hidden="true" />
              ) : (
                <FolderSimplePlus size={17} weight="bold" aria-hidden="true" />
              )}
              {busy ? "正在创建…" : "创建分组"}
            </button>
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}

export function AssetSourceDialog({
  asset,
  onClose,
  onDelete,
  onRename,
}: {
  readonly asset: AssetItem;
  readonly onClose: () => void;
  /** 云端素材提供删除；本地素材传 null 不渲染删除操作。 */
  readonly onDelete: (() => void) | null;
  /** 云端素材提供改名；本地素材传 null 不渲染改名操作。 */
  readonly onRename: ((name: string) => void) | null;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const typeLabel = ASSET_KIND_LABELS[asset.kind];
  const mediaSrc = asset.kind === "video"
    ? toMediaProxyUrl(asset.videoUrl ?? asset.previewUrl)
    : asset.previewUrl;
  const [failedMediaSrc, setFailedMediaSrc] = useState<string | null>(null);
  const mediaFailed = mediaSrc == null || failedMediaSrc === mediaSrc;
  // 删除采用两段式确认：第一次点击进入「确认删除?」危险态，4 秒内再点才真正删除，
  // 避免误触；弹窗关闭时取消计时，不会在下次打开时残留。
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteArmTimerRef = useRef<number | null>(null);
  // 改名采用行内编辑：点「重命名」展开输入框，保存后调用 onRename 并关闭弹窗。
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(asset.name);
  const renameDirty = renameValue.trim() !== asset.name && renameValue.trim().length > 0;

  useEffect(() => {
    return () => {
      if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    };
  }, []);

  const startRenaming = () => {
    setRenameValue(asset.name);
    setRenaming(true);
    // 输入框在同帧挂载，焦点延迟到微任务提交后设置。
    void Promise.resolve().then(() => renameInputRef.current?.focus());
  };
  const cancelRenaming = () => {
    setRenaming(false);
    setRenameValue(asset.name);
  };
  const commitRename = () => {
    if (!renaming || onRename == null) return;
    const nextName = renameValue.trim();
    if (nextName.length === 0) {
      renameInputRef.current?.focus();
      return;
    }
    if (nextName === asset.name) {
      setRenaming(false);
      return;
    }
    setRenaming(false);
    onRename(nextName);
  };

  const armDelete = () => {
    if (confirmingDelete) return;
    setConfirmingDelete(true);
    if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    deleteArmTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), 4_000);
  };
  const confirmDelete = () => {
    if (!confirmingDelete || onDelete == null) return;
    if (deleteArmTimerRef.current != null) window.clearTimeout(deleteArmTimerRef.current);
    setConfirmingDelete(false);
    onDelete();
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    closeButtonRef.current?.focus();

    return () => {
      if (dialog.hasAttribute("open")) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="asset-source-dialog"
      aria-label={asset.name}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="asset-source-dialog__layout">
        <section className="asset-source-dialog__stage" aria-label={`${asset.name}源媒体`}>
          <button
            ref={closeButtonRef}
            type="button"
            className="asset-source-dialog__close"
            aria-label="关闭素材详情"
            onClick={onClose}
          >
            <X size={22} weight="bold" aria-hidden="true" />
          </button>
          {asset.kind === "image" && mediaSrc && !mediaFailed ? (
            <img
              className="asset-source-dialog__media"
              src={mediaSrc}
              alt={asset.name}
              draggable={false}
              onError={() => setFailedMediaSrc(mediaSrc)}
            />
          ) : asset.kind === "video" && mediaSrc && !mediaFailed ? (
            <video
              className="asset-source-dialog__media"
              src={mediaSrc}
              aria-label={asset.name}
              controls
              playsInline
              preload="metadata"
              onError={() => setFailedMediaSrc(mediaSrc)}
            />
          ) : asset.kind === "audio" && mediaSrc && !mediaFailed ? (
            <div className="asset-source-dialog__audio">
              <WaveformIcon size={48} weight="regular" aria-hidden="true" />
              <audio
                src={mediaSrc}
                aria-label={asset.name}
                controls
                preload="metadata"
                onError={() => setFailedMediaSrc(mediaSrc)}
              />
            </div>
          ) : asset.kind === "audio" ? (
            <div className="asset-source-dialog__audio" role="img" aria-label={asset.name}>
              <WaveformIcon size={56} weight="regular" aria-hidden="true" />
              <span>预览不可用</span>
            </div>
          ) : asset.source != null ? (
            <div className="asset-source-dialog__fallback" role="img" aria-label={asset.name}>
              <AssetMediaState kind={asset.kind} state="unavailable" />
            </div>
          ) : (
            <div className="asset-source-dialog__fallback" role="img" aria-label={asset.name}>
              <AssetMediaState kind={asset.kind} state="unavailable" />
            </div>
          )}
        </section>

        <aside className="asset-source-dialog__details" aria-label="素材详细信息">
          <dl>
            <div>
              <dt>名称</dt>
              <dd className="asset-source-dialog__name">
                {renaming ? (
                  <span className="asset-source-dialog__rename-form">
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      maxLength={64}
                      aria-label={`${asset.name}的新名称`}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") cancelRenaming();
                      }}
                    />
                    <button type="button" disabled={!renameDirty} onClick={commitRename}>
                      保存
                    </button>
                    <button type="button" onClick={cancelRenaming}>
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="asset-source-dialog__name-text">{asset.name}</span>
                    {onRename ? (
                      <button
                        type="button"
                        className="asset-source-dialog__rename-toggle"
                        aria-label={`重命名素材：${asset.name}`}
                        onClick={startRenaming}
                      >
                        <PencilSimple size={14} weight="bold" aria-hidden="true" />
                        重命名
                      </button>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>素材 ID</dt>
              <dd className="mono">{asset.id}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{typeLabel}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{asset.source === "local" ? "本地素材库" : "云端素材库"}</dd>
            </div>
            {asset.cloudStatus ? (
              <div>
                <dt>状态</dt>
                <dd>{ASSET_CLOUD_STATUS_LABELS[asset.cloudStatus]}</dd>
              </div>
            ) : null}
            {asset.providerDisplayName ? (
              <div>
                <dt>供应商连接</dt>
                <dd>{asset.providerDisplayName}</dd>
              </div>
            ) : null}
          </dl>
          {onDelete ? (
            <div className="asset-source-dialog__delete">
              <button
                type="button"
                className={`asset-source-dialog__delete-button${confirmingDelete ? " is-armed" : ""}`}
                aria-label={
                  confirmingDelete ? `确认删除素材：${asset.name}` : `删除素材：${asset.name}`
                }
                onClick={confirmingDelete ? confirmDelete : armDelete}
              >
                {confirmingDelete ? (
                  <>
                    <WarningCircle size={16} weight="bold" aria-hidden="true" />
                    确认删除？
                  </>
                ) : (
                  <>
                    <Trash size={16} weight="regular" aria-hidden="true" />
                    删除素材
                  </>
                )}
              </button>
              {confirmingDelete ? (
                <p className="asset-source-dialog__delete-hint">
                  素材将从云端素材库永久删除，此操作不可撤销。
                </p>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </dialog>,
    document.body,
  );
}
