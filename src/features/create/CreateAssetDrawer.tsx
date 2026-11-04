/*
 * 生成页的资产库抽屉（对应即梦右侧 320px 的「资产库」面板）。
 *
 * 实测规格：宽 320px、底色 #1a1a1a、与页面等高；
 * 顶部是「全部资产」胶囊（高 36px、圆角 8px、底色 rgba(255,255,255,.08)、
 * 13px/22 字重 500、内边距 0 10px）与一枚 36×36 圆角 8px 的关闭按钮；
 * 那枚胶囊在即梦里是**筛选控件**（不是装饰），本项目里对应「分类 = 全部」，
 * 点它回到全部素材并把分组复位到「全部分组」；
 * 下面是搜索行（28px 高控件）、分类页签（13px/22、内边距 9.5px 8px、圆角 8px，
 * 选中态白字并带下划线）、来源页签「我的 / 官方」（12px/20、内边距 8px 16px、
 * 圆角 8px、选中态底色 rgba(255,255,255,.08)）；
 * 最后是 4 列 64×64 缩略图网格，缩略图下带素材名。
 *
 * 数据不是即梦的资产服务，而是**本项目的素材库**：本机 Base64 素材库与
 * 已接入供应商的云端素材库（见 useCreateAssets）。分类页签只留本项目真有的
 * 三种媒体——即梦还有「文档」「主体」，本项目没有对应物，不做点不动的页签。
 *
 * ── 素材卡的更多菜单（即梦资产页实测 2026-10-22）─────────────────────
 * 即梦资产页的素材卡右键弹出的菜单是七项：下载 / 收藏 / 用作参考视频 /
 * 创建主体 / 发布 / 删除 / 举报。原作是**右键**触发的，本项目照做：
 * 右键素材卡开菜单，另外在浏览态给每格加一枚 hover 才显形的「⋯」，
 * 免得用户根本不知道可以右键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Icon } from "../../components/Icon";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { toast } from "../../lib/toast";
import type { AssetItem } from "../workspace/workspaceModel";
import {
  beginCreateAssetDrag,
  endCreateAssetDrag,
  findCreateDropZone,
  setCreateAssetDragOverTarget,
} from "./createAssetDrag";
import {
  CREATE_ASSET_CATEGORIES,
  CREATE_ASSET_SOURCES,
  type CreateAssetCategoryId,
  type CreateAssetSource,
} from "./createPageModel";
import { JimengIcon } from "./JimengIcon";
import { useCreateFloatingLayerAnchor, useDismissOnOutside } from "./useFloatingLayerAnchor";
import type { CreateAssetGroup } from "./useCreateAssets";
import "./CreateAssetDrawer.css";

export interface CreateAssetDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly assets: readonly AssetItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly total: number;
  readonly source: CreateAssetSource;
  readonly onSourceChange: (source: CreateAssetSource) => void;
  readonly category: CreateAssetCategoryId;
  readonly onCategoryChange: (category: CreateAssetCategoryId) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly groups: readonly CreateAssetGroup[];
  readonly groupId: string | null;
  readonly onGroupIdChange: (groupId: string | null) => void;
  /** 云端素材库是否有可用的供应商连接。 */
  readonly cloudAvailable: boolean;
  /** 正在挑参考素材（从浮坞的「参考内容」打开）还是只是浏览。 */
  readonly picking: boolean;
  /** 已选中的素材 ID；只读。 */
  readonly pickedIds: readonly string[];
  readonly onPick: (asset: AssetItem) => void;
  readonly onConfirmPick: () => void;
  /**
   * 把素材直接作为参考素材送进浮坞（即梦资产卡菜单里的「用作参考视频/图」）。
   *
   * 本项目真能做的只有这一项：下载、收藏、创建主体、发布、删除、举报
   * 都没有后端能力，按项目约定保留入口并明确说明。
   */
  readonly onUseAsReference?: ((asset: AssetItem) => void) | undefined;
}

/** 素材缩略图地址：云端走媒体代理续签，本机素材保持原生协议地址。 */
function thumbSrc(asset: AssetItem): string | null {
  if (!asset.previewUrl) return null;
  return toMediaProxyUrl(asset.previewUrl, { assetId: asset.id });
}

/*
 * ── 拖拽进浮坞 ────────────────────────────────────────────────────────
 *
 * 素材卡可以**拖**到浮坞的参考条里，和「点开抽屉挑素材」是两条并行的路。
 *
 * 拖拽走指针事件而不是 HTML5 draggable：Tauri WebView 的系统拖放处理器
 * 会截走 dataTransfer 拖拽（见 workspaceModel.ts 里「素材卡片使用指针拖拽」
 * 那条注释），画布那边也是指针拖拽，这里沿用同一套。
 */

/** 超过这个位移才算「在拖」，否则仍是一次点击（点选素材）。 */
const DRAG_THRESHOLD_PX = 6;
/** 拖拽影子的边长。 */
const DRAG_GHOST_SIZE_PX = 48;

/**
 * 跟随指针的拖拽影子。
 *
 * 直接挂在 body 上、用 transform 移动：拖拽期间每帧都要动，走 React state
 * 会让整张素材网格（一页 60 张）每帧重渲染。
 */
function createDragGhost(asset: AssetItem, clientX: number, clientY: number): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "create-assets__drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const src = thumbSrc(asset);
  if (src !== null) {
    const image = document.createElement("img");
    image.src = src;
    image.alt = "";
    /* 缩略图默认可被浏览器原生拖走，那会让指针拖拽半路被系统拖放接管。 */
    image.draggable = false;
    ghost.appendChild(image);
  } else {
    ghost.classList.add("create-assets__drag-ghost--empty");
    ghost.textContent = asset.name;
  }
  document.body.appendChild(ghost);
  moveDragGhost(ghost, clientX, clientY);
  return ghost;
}

/** 移动拖拽影子：只改 transform，不碰 left/top（避免每帧重排）。 */
function moveDragGhost(ghost: HTMLElement, clientX: number, clientY: number): void {
  const offset = DRAG_GHOST_SIZE_PX / 2;
  ghost.style.transform = `translate3d(${clientX - offset}px, ${clientY - offset}px, 0)`;
}

/**
 * 素材卡的更多菜单（即梦资产页实测 2026-10-22）。
 *
 * 七项，顺序与即梦一致：下载 / 收藏 / 用作参考视频 / 创建主体 / 发布 / 删除 / 举报。
 * 菜单项 36px 高、内边距 9px 12px、圆角 8px，左侧一枚 1em 图标，文字 13px/24。
 *
 * 本项目只有「用作参考视频/图」是真的能做的，其余六项按项目约定保留入口，
 * 点下去明确说明「后端暂未接入」，不静默失败。
 */
function AssetMenu({
  asset,
  open,
  anchorRef,
  onClose,
  onUseAsReference,
}: {
  readonly asset: AssetItem;
  readonly open: boolean;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onUseAsReference?: ((asset: AssetItem) => void) | undefined;
}) {
  const { ref: menuRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef,
    minWidth: 196,
    maxHeight: 360,
    preferAbove: true,
  });

  useDismissOnOutside(open, menuRef, anchorRef, onClose, layerId);

  /* Esc 关闭菜单：交给全应用唯一的仲裁器（`escapeArbiter`）。 */
  useEscapeHandler(
    {
      canHandle: () => open,
      handle: () => onClose(),
    },
    open,
  );

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [menuRef, open]);

  const isVideo = asset.kind === "video";
  const isAudio = asset.kind === "audio";

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-label="素材更多操作"
      tabIndex={-1}
      className="create-assets-menu"
    >
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("下载后端暂未接入。");
        }}
      >
        <JimengIcon name="recordDownload" />
        <span className="create-assets-menu__label">下载</span>
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("收藏后端暂未接入。");
        }}
      >
        <JimengIcon name="recordFavorite" />
        <span className="create-assets-menu__label">收藏</span>
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        disabled={onUseAsReference === undefined}
        title={onUseAsReference === undefined ? "后端暂未接入" : undefined}
        onClick={() => {
          if (onUseAsReference === undefined) return;
          onClose();
          onUseAsReference(asset);
        }}
      >
        <JimengIcon name="toolAsReference" />
        <span className="create-assets-menu__label">
          {isVideo ? "用作参考视频" : isAudio ? "用作参考音频" : "用作参考图"}
        </span>
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("主体体系后端暂未接入。");
        }}
      >
        <JimengIcon name="assetCreateSubject" />
        <span className="create-assets-menu__label">创建主体</span>{" "}
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("发布后端暂未接入。");
        }}
      >
        <JimengIcon name="assetPublish" />
        <span className="create-assets-menu__label">发布</span>
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("删除后端暂未接入。");
        }}
      >
        <JimengIcon name="assetTrash" />
        <span className="create-assets-menu__label">删除</span>
      </button>
      <button
        type="button"
        className="create-assets-menu__item"
        onClick={() => {
          onClose();
          toast("举报后端暂未接入。");
        }}
      >
        <JimengIcon name="assetReport" />
        <span className="create-assets-menu__label">举报</span>
      </button>
    </div>,
    document.body,
  );
}

function AssetTile({
  asset,
  order,
  menuOpen,
  dragging,
  onPick,
  onMenuToggle,
  onMenuClose,
  onUseAsReference,
  onPointerDown,
}: {
  readonly asset: AssetItem;
  readonly order: number | null;
  readonly menuOpen: boolean;
  /** 这一格正被拖着。 */
  readonly dragging: boolean;
  readonly onPick: (asset: AssetItem) => void;
  readonly onMenuToggle: (asset: AssetItem) => void;
  readonly onMenuClose: () => void;
  readonly onUseAsReference?: ((asset: AssetItem) => void) | undefined;
  /** 按下：交给抽屉统一处理拖拽手势（一页 60 张卡不各挂一套监听）。 */
  readonly onPointerDown: (
    asset: AssetItem,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void;
}) {
  const src = thumbSrc(asset);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="create-assets__tile-wrap"
      onContextMenu={(event) => {
        /* 即梦资产页的素材菜单是右键触发的，这里照做。 */
        event.preventDefault();
        onMenuToggle(asset);
      }}
    >
      <button
        type="button"
        className="create-assets__tile"
        data-picked={order !== null ? "true" : "false"}
        data-dragging={dragging ? "true" : "false"}
        onPointerDown={(event) => onPointerDown(asset, event)}
        onClick={() => onPick(asset)}
        title={asset.name}
      >
        <span className="create-assets__thumb">
          {src ? (
            <img src={src} alt="" loading="lazy" draggable={false} />
          ) : (
            <Icon name="image-square" size="sm" aria-hidden="true" />
          )}
          {order !== null ? <span className="create-assets__order">{order}</span> : null}
        </span>
        <span className="create-assets__name">{asset.name}</span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="create-assets__tile-menu"
        aria-label="素材更多操作"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle(asset);
        }}
      >
        <JimengIcon name="recordMore" />
      </button>
      {menuOpen ? (
        <AssetMenu
          asset={asset}
          open
          anchorRef={triggerRef}
          onClose={onMenuClose}
          onUseAsReference={onUseAsReference}
        />
      ) : null}
    </div>
  );
}

export function CreateAssetDrawer({
  open,
  onClose,
  assets,
  loading,
  error,
  total,
  source,
  onSourceChange,
  category,
  onCategoryChange,
  query,
  onQueryChange,
  groups,
  groupId,
  onGroupIdChange,
  cloudAvailable,
  picking,
  pickedIds,
  onPick,
  onConfirmPick,
  onUseAsReference,
}: CreateAssetDrawerProps) {
  const orderById = useMemo(() => {
    const map = new Map<string, number>();
    pickedIds.forEach((id, index) => map.set(id, index + 1));
    return map;
  }, [pickedIds]);

  const groupOptions = useMemo(
    () => [{ id: null, name: "全部分组", count: null }, ...groups],
    [groups],
  );

  /*
   * 拖拽手势（抽屉统一处理）。
   *
   * 一页最多 60 张卡，若每张卡各挂一套 window 监听，就是 180 个监听在跑；
   * 这里按下手势只记一份，监听也只有一套。
   *
   * `dragRef` 记着手势本身（按下位置、是否越过阈值、拖的是哪张卡），
   * `draggedRef` 记着「刚刚发生过一次拖拽」——用来吞掉拖拽结束后浏览器
   * 补发的那一次 click，否则短距离拖一下会把素材也点选上。
   */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLElement | null;
    asset: AssetItem;
  } | null>(null);
  const draggedRef = useRef(false);
  /** 正在被拖动的那张卡的 ID（用来给卡片加 is-dragging 状态）。 */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /*
   * 落下时要用到的回调放 ref 里：它在父组件里是内联箭头，每次渲染都是
   * 新引用，若直接进依赖会让窗口监听每帧重挂。
   */
  const onDropRef = useRef(onUseAsReference);
  useEffect(() => {
    onDropRef.current = onUseAsReference;
  }, [onUseAsReference]);

  const onTilePointerDown = useCallback(
    (asset: AssetItem, event: React.PointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        ghost: null,
        asset,
      };
    },
    [],
  );

  /**
   * 素材卡的点选。
   *
   * 刚拖过一次的那一下 click 是拖拽的尾巴，不是点选——吞掉它，
   * 否则用户想把素材拖到浮坞却发现它同时被勾选进了挑选列表。
   */
  const handleTilePick = useCallback(
    (asset: AssetItem) => {
      if (draggedRef.current) {
        draggedRef.current = false;
        return;
      }
      onPick(asset);
    },
    [onPick],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        draggedRef.current = true;
        setDraggingId(drag.asset.id);
        const ghost = createDragGhost(drag.asset, event.clientX, event.clientY);
        drag.ghost = ghost;
        beginCreateAssetDrag(drag.asset);
        moveDragGhost(ghost, event.clientX, event.clientY);
      } else {
        moveDragGhost(drag.ghost as HTMLElement, event.clientX, event.clientY);
      }
      /* 拖起来之后别再选中文本。 */
      event.preventDefault();
      setCreateAssetDragOverTarget(findCreateDropZone(event.clientX, event.clientY) !== null);
    };

    const finishPointerDrag = (event: PointerEvent, cancelled: boolean): void => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setDraggingId(null);
      endCreateAssetDrag();
      drag.ghost?.remove();
      drag.ghost = null;
      if (!drag.active) return;
      event.preventDefault();
      if (!cancelled) {
        /* 落在浮坞上：把这张素材作为参考素材加进去。 */
        const zone = findCreateDropZone(event.clientX, event.clientY);
        if (zone !== null) onDropRef.current?.(drag.asset);
      }
      /*
       * click 在 pointerup 之后、rAF 之前派发：这一帧里它会看到
       * `draggedRef` 为 true 而把自己吞掉；下一帧再复位，后面的正常点击
       * 不受影响。
       */
      window.requestAnimationFrame(() => {
        draggedRef.current = false;
      });
    };

    const handlePointerUp = (event: PointerEvent): void => finishPointerDrag(event, false);
    const handlePointerCancel = (event: PointerEvent): void => finishPointerDrag(event, true);

    /**
     * 指针出了窗口：当作取消。
     *
     * 拖到窗口外松手时，浏览器不会派发 pointerup——手势会卡在「正在拖」
     * 状态，影子留在屏幕上、浮坞一直亮着。指针回到窗口内时的那次 move
     * 就是我们唯一的补救机会，所以在这里就地收尾。
     *
     * 判据是「relatedTarget 为空」且指针已到视口边缘：relatedTarget 为空
     * 只说明指针离开了文档（也可能只是下面的元素被卸载了），加上边缘这一
     * 条才是真的出了窗口。
     */
    const handlePointerLeaveWindow = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      if (event.relatedTarget !== null) return;
      const atEdge =
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight;
      if (!atEdge) return;
      finishPointerDrag(event, true);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("pointerout", handlePointerLeaveWindow);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("pointerout", handlePointerLeaveWindow);
      /* 抽屉在拖拽途中被关掉时，别把影子留在屏幕上。 */
      dragRef.current?.ghost?.remove();
      dragRef.current = null;
      endCreateAssetDrag();
    };
  }, []);

  /**
   * 素材卡的更多菜单。
   *
   * 一次只开一个：开着新的就关掉旧的。锚点是触发它的那个「⋯」按钮
   * （右键打开时锚在素材格上）。
   */
  const [menu, setMenu] = useState<{ readonly asset: AssetItem } | null>(null);
  const closeMenu = useCallback((): void => setMenu(null), []);
  const toggleMenu = useCallback((asset: AssetItem): void => {
    setMenu((previous) => (previous?.asset.id === asset.id ? null : { asset }));
  }, []);

  return (
    <aside
      className="create-assets"
      aria-label="资产库"
      data-open={open ? "true" : "false"}
      hidden={!open}
    >
      <div className="create-assets__header">
        <div className="create-assets__tabs">
          {/*
           * 即梦这枚「全部资产」是一枚**筛选控件**，不是装饰。
           * 本项目里它对应「分类 = 全部」：点它回到全部素材，分组也一并回到
           * 「全部分组」——否则会停在某个分组上，用户看着像「点了没反应」。
           * 外观见 CreateAssetDrawer.css。
           */}
          <button
            type="button"
            className="create-assets__filter"
            data-active={category === "all" ? "true" : "false"}
            aria-label="全部资产"
            aria-pressed={category === "all"}
            title={category === "all" ? "当前显示全部资产" : "切回全部资产"}
            onClick={() => {
              onCategoryChange("all");
              onGroupIdChange(null);
            }}
          >
            全部资产
          </button>
        </div>
        <button
          type="button"
          className="create-assets__close"
          aria-label="关闭资产库"
          onClick={onClose}
        >
          <Icon name="x" size="sm" aria-hidden="true" />
        </button>
      </div>

      <div className="create-assets__search-row">
        <label className="create-assets__search">
          <Icon name="magnifying-glass" size="xs" aria-hidden="true" />
          <input
            type="search"
            name="create-asset-search"
            value={query}
            placeholder="搜索全部资产"
            aria-label="搜索全部资产"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <CanvasSelect
          className="create-assets__group"
          ariaLabel="素材分组"
          value={groupId ?? ""}
          options={groupOptions.map((group) => ({
            value: group.id ?? "",
            label: group.count === null ? group.name : `${group.name} (${group.count})`,
          }))}
          onChange={(value) => onGroupIdChange(value || null)}
        />
      </div>

      <div className="create-assets__categories" role="tablist" aria-label="资产分类">
        {CREATE_ASSET_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className="create-assets__category"
            data-active={category === item.id ? "true" : "false"}
            onClick={() => onCategoryChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="create-assets__sources" role="tablist" aria-label="资产来源">
        {CREATE_ASSET_SOURCES.map((item) => {
          const disabled = item.id === "cloud" && !cloudAvailable;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={source === item.id}
              className="create-assets__source"
              data-active={source === item.id ? "true" : "false"}
              disabled={disabled}
              title={disabled ? "没有可用于云端素材库的供应商连接" : undefined}
              onClick={() => onSourceChange(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="create-assets__body">
        {error ? (
          <ErrorAlert error={error} hint="检查素材库连接后重试，或切换到另一来源。" />
        ) : null}
        {loading ? (
          <div className="create-assets__grid" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <div key={index} className="create-assets__tile create-assets__tile--skeleton" />
            ))}
          </div>
        ) : assets.length === 0 ? (
          <div className="create-assets__empty">暂无相关资产</div>
        ) : (
          <div className="create-assets__grid">
            {assets.map((asset) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                order={orderById.get(asset.id) ?? null}
                menuOpen={menu?.asset.id === asset.id}
                dragging={draggingId === asset.id}
                onPick={handleTilePick}
                onMenuToggle={toggleMenu}
                onMenuClose={closeMenu}
                onUseAsReference={onUseAsReference}
                onPointerDown={onTilePointerDown}
              />
            ))}
          </div>
        )}
        {!loading && assets.length > 0 ? (
          <div className="create-assets__count">共 {total} 个素材</div>
        ) : null}
      </div>

      {picking ? (
        <div className="create-assets__footer">
          <span className="create-assets__picked-count">已选 {pickedIds.length} 个</span>
          <button
            type="button"
            className="create-assets__confirm"
            disabled={pickedIds.length === 0}
            onClick={onConfirmPick}
          >
            添加为参考
          </button>
        </div>
      ) : null}
    </aside>
  );
}
