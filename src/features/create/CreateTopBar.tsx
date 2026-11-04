/*
 * 生成页右上角操作条，以及那枚「筛选」按钮弹出的浮层。
 *
 * 实测规格（从右往左）：
 *   - 积分胶囊：高 28、圆角 6、内边距 0 6px 0 8px、gap 8；数字 12/20 字重 500、
 *     色 #009EFA；
 *   - 消息中心：28×28、圆角 6、内边距 6px、色 #fff；
 *   - 图标组：高 36、圆角 8、底 rgba(18,18,18,.6)、边框 1px rgba(255,255,255,.08)、
 *     内边距 4px 6px 4px 4px、gap 2px，并带 backdrop-filter: blur(20px)；
 *     组内三颗 28×28 的图标钮——搜索（圆角 8）、筛选（圆角 12）、资产库（圆角 12），
 *     搜索与筛选之间、筛选与资产库之间各有一道 0.7×12 的竖分隔线。
 *
 * ── 搜索的交互逻辑（对齐即梦实测，2026-10-22）──────────────────────
 * 即梦的搜索**不是**「一个图标按钮，点开换成另一个输入框」：
 *   - 容器常驻一个 `<input>`，收起态宽 4px（被容器裁掉，只露出放大镜）；
 *   - 容器靠 class 切换 `collapsed` → `expanded`，宽度从 28 过渡到 254
 *     （transition: width .2s cubic-bezier(.4,0,.2,1)）；
 *   - 展开时**整组左移**（不是覆盖）：同组的分隔线、筛选钮、资产库钮跟着
 *     重新排布，容器不会盖住它们；
 *   - 点放大镜或聚焦输入框都会展开；`maxlength=100`；
 *   - placeholder 14/400、色 rgba(229,233,250,.4)。
 *
 * 本地先前是「按钮 ↔ label+input」的整体替换：DOM 会重建，输入框拿不到
 * 焦点历史，展开时后面的按钮还留在原地（不重新排布），与即梦不一致。
 * 这里改成同一套：input 常驻，容器用 data 属性切状态。
 *
 * 两处与即梦不同，且是刻意的：
 *   1. 即梦有「消息中心」铃铛，本项目没有通知子系统，不放一个点不动的铃铛；
 *   2. 即梦那枚积分胶囊是 SaaS 的余额。本项目按供应商 API 计费，没有积分概念，
 *      所以那枚胶囊显示当前生效的供应商连接——位置、尺寸、字号、颜色都一样。
 *
 * ── 筛选浮层（对齐即梦实测，2026-10-22 二次实测）────────────────────
 * 即梦那枚「筛选」按钮弹出的浮层（`div.lv-popover-content.lv-popover-content-bl`）：
 *   - 280×621（max-width 350），底 #262626、圆角 12、描边 1px rgba(204,221,255,.08)、
 *     投影 rgba(0,0,0,.24) 0 8px 56px；字 12/16、色 rgba(246,247,255,.7)；
 *   - **往下弹**：触发器 rect [1365, 24, 28, 28]，浮层 rect [1364.5, 64, 280, 621.33]
 *     ——左边缘与触发器左边缘对齐（偏移 0，不是创作台其它浮层的 −16），
 *     触发器底边 52 与浮层顶边 64 之间留 12px；
 *   - 内容是四组加一条页脚：日期 / 创作 / 分类 / 编辑 / 清空全部；
 *     分组标题实测 12/12、色 rgba(255,255,255,.35)、内边距 12px 12px 8px。
 *
 * 本地先前把筛选做成按钮下方一条右对齐的三项列表（全部/图片/视频）：既没走
 * 共享锚定（浮层留在顶栏 DOM 里，祖先的 overflow 能裁它），方向与对齐也和
 * 即梦不同。现在改成 portal + 共享锚定 hook，内容按即梦的五块重建。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { JimengIcon } from "./JimengIcon";
import type { CreateRecordFilter } from "./createPageModel";
import { useCreateFloatingLayerAnchor, useDismissOnOutside } from "./useFloatingLayerAnchor";
import "./CreateTopBar.css";

export interface CreateTopBarProps {
  /** 记录搜索词；输入即过滤记录流。 */
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly filter: CreateRecordFilter;
  readonly onFilterChange: (filter: CreateRecordFilter) => void;
  /** 打开资产库抽屉。 */
  readonly onOpenAssets: () => void;
  /** 资产库抽屉是否已打开（决定按钮的选中态）。 */
  readonly assetsOpen: boolean;
  /** 当前生效的供应商连接名；null = 尚未接入供应商。 */
  readonly providerName: string | null;
}

/** 浮层里的一行。 */
interface FilterEntry {
  readonly id: string;
  readonly label: string;
  /**
   * 命中本地记录模型的筛选值。
   *
   * null = 本项目还没有对应能力：照实置灰并标注「后端暂未接入」，
   * 不做成点了没反应的空项。
   */
  readonly filter: CreateRecordFilter | null;
}

/**
 * 筛选浮层的分组（即梦实测：创作 / 分类 / 编辑，日期组另有一对日期框）。
 *
 * 只有「创作」里的图片、视频能真的改变记录流：本地记录的筛选维度
 * `CreateRecordFilter` 只有 all | image | video 三个值（见 createPageModel.ts）。
 * 其余项要么是即梦独有的创作类型（对口型 / 动作模仿 / Agent 模式 / 音频），
 * 要么是服务端概念（收藏 / 超清 / 补帧）——本地记录模型里没有对应字段，
 * 接不上就是接不上，置灰标注比假装能用诚实。
 */
const FILTER_SECTIONS: readonly {
  readonly title: string;
  readonly entries: readonly FilterEntry[];
}[] = [
  {
    title: "创作",
    entries: [
      { id: "image", label: "图片", filter: "image" },
      { id: "video", label: "视频", filter: "video" },
      { id: "lip-sync", label: "对口型", filter: null },
      { id: "agent", label: "Agent 模式", filter: null },
      { id: "motion", label: "动作模仿", filter: null },
      { id: "audio", label: "音频", filter: null },
    ],
  },
  {
    title: "分类",
    entries: [{ id: "favorite", label: "收藏", filter: null }],
  },
  {
    title: "编辑",
    entries: [
      { id: "ultra-hd", label: "超清", filter: null },
      { id: "frame-interpolation", label: "补帧", filter: null },
    ],
  },
];

/**
 * 日期的三个快捷区间（即梦实测有这三项）。
 *
 * 区间筛选要落到记录流的创建时间上，而本地记录的筛选维度只有媒体类型
 * （`CreateRecordFilter`），没有时间窗这一路通道：接上需要改
 * `createPageModel.ts` 与 `CreateRecordList.tsx` 两个别的写者拥有的文件。
 * 这里置灰并标注原因，不给一个点了不动的假开关。
 */
const DATE_RANGES: readonly { readonly id: string; readonly label: string }[] = [
  { id: "week", label: "最近一周" },
  { id: "month", label: "最近一个月" },
  { id: "quarter", label: "最近三个月" },
];

interface FilterPopoverProps {
  /** 浮层根节点的 ref：共享锚定 hook 量尺寸、贴位置都用它。 */
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly filter: CreateRecordFilter;
  readonly onFilterChange: (filter: CreateRecordFilter) => void;
}

/**
 * 筛选浮层本体。
 *
 * 结构对齐即梦：四组（日期 / 创作 / 分类 / 编辑）加一条页脚「清空全部」。
 * 浮层挂在 document.body 上，位置由 `useFloatingLayerAnchor` 按视口算
 * （左边缘与触发器对齐、往下弹、留 12px 缝），不会被顶栏裁掉。
 */
function FilterPopover({
  popoverRef,
  filter,
  onFilterChange,
}: FilterPopoverProps): React.ReactElement {
  const hasFilter = filter !== "all";

  /**
   * 勾选/取消一个媒体类型。
   *
   * 即梦的创作类型是多选复选；本地记录只有一个媒体类型维度，复选框因此
   * 退化成「选中 / 再点一次取消」——多选在现模型里表达不了。
   */
  const toggle = useCallback(
    (entry: FilterEntry): void => {
      if (entry.filter === null) return;
      onFilterChange(filter === entry.filter ? "all" : entry.filter);
    },
    [filter, onFilterChange],
  );

  /** 上下键在可用的条目之间移动焦点（role="menu" 的键盘约定）。 */
  const moveFocus = useCallback(
    (delta: number): void => {
      const layer = popoverRef.current;
      if (layer === null) return;
      const items = [...layer.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].filter(
        (item) => !item.disabled,
      );
      if (items.length === 0) return;
      const active = document.activeElement;
      const current = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
      const next =
        current === -1
          ? delta > 0
            ? 0
            : items.length - 1
          : (current + delta + items.length) % items.length;
      items[next]?.focus();
    },
    [popoverRef],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveFocus(event.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      ref={popoverRef}
      role="menu"
      aria-label="筛选"
      tabIndex={-1}
      className="create-topbar__filter-popover"
      onKeyDown={handleKeyDown}
    >
      {/*
       * 日期组：即梦是「开始日期 - 结束日期」加三个快捷区间。
       * 日期框与区间都还没有落地通道，整组置灰。
       */}
      <div role="group" aria-label="日期" className="create-topbar__filter-section">
        <div className="create-topbar__filter-title" aria-hidden="true">
          日期
        </div>
        <div role="none" className="create-topbar__filter-range" title="日期筛选后端暂未接入">
          <span className="create-topbar__filter-field">开始日期</span>
          <span className="create-topbar__filter-range-sep" aria-hidden="true">
            -
          </span>
          <span className="create-topbar__filter-field">结束日期</span>
        </div>
        {DATE_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            role="menuitemradio"
            aria-checked={false}
            aria-disabled={true}
            disabled
            className="create-topbar__filter-option"
            title={`${range.label}后端暂未接入`}
          >
            <span
              className="create-topbar__filter-box create-topbar__filter-box--radio"
              aria-hidden="true"
            />
            <span className="create-topbar__filter-label">{range.label}</span>
            <span className="create-topbar__filter-note">后端暂未接入</span>
          </button>
        ))}
      </div>

      {FILTER_SECTIONS.map((section) => (
        <div
          key={section.title}
          role="group"
          aria-label={section.title}
          className="create-topbar__filter-section"
        >
          <div className="create-topbar__filter-title" aria-hidden="true">
            {section.title}
          </div>
          {section.entries.map((entry) => {
            const available = entry.filter !== null;
            const checked = available && filter === entry.filter;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                aria-disabled={!available}
                disabled={!available}
                data-checked={checked ? "true" : "false"}
                className="create-topbar__filter-option"
                title={available ? undefined : `${entry.label}后端暂未接入`}
                onClick={() => toggle(entry)}
              >
                <span className="create-topbar__filter-box" aria-hidden="true">
                  {checked ? <Icon name="check" size="2xs" aria-hidden="true" /> : null}
                </span>
                <span className="create-topbar__filter-label">{entry.label}</span>
                {available ? null : (
                  <span className="create-topbar__filter-note">后端暂未接入</span>
                )}
              </button>
            );
          })}
        </div>
      ))}

      {/*
        页脚：清空全部。没有选中任何条件时是禁用态（即梦实测就是禁用态），
        但仍留在无障碍树里，读屏用户能听到「当前没有可清空的筛选」。
      */}
      <div role="none" className="create-topbar__filter-footer">
        <button
          type="button"
          role="menuitem"
          aria-disabled={!hasFilter}
          className="create-topbar__filter-clear"
          onClick={() => {
            if (!hasFilter) return;
            onFilterChange("all");
          }}
        >
          清空全部
        </button>
      </div>
    </div>
  );
}

export function CreateTopBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  onOpenAssets,
  assetsOpen,
  providerName,
}: CreateTopBarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  /*
   * 点别处收回搜索（即梦实测：展开后点页面其它地方，搜索框立刻收回）。
   *
   * 用 pointerdown 而不是 blur：
   *   - blur 在「输入框已聚焦时点放大镜」会先触发收起、再被 click 展开，中途闪一下；
   *   - pointerdown 还能覆盖「点了不可聚焦的元素」——那种情况 blur 根本不发生。
   */
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && searchBoxRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [searchOpen]);

  /*
   * 筛选浮层的锚定：走共享 hook，与创作台其它浮层同一套规则。
   *
   * 这一个浮层有两条与默认不同的实测值：
   *   - `leftOffset: 0`：即梦的筛选浮层左边缘与触发器左边缘对齐
   *     （触发器 1365 → 浮层 1364.5），不是创作台其它浮层那个 −16；
   *   - `gap: 12` + `preferAbove: false`：即梦这枚浮层**往下**弹，
   *     触发器底边 52 与浮层顶边 64 之间留 12px。
   */
  const { ref: filterPopoverRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open: filterOpen,
    anchorRef: filterTriggerRef,
    minWidth: 280,
    maxHeight: 630,
    leftOffset: 0,
    gap: 12,
    preferAbove: false,
  });
  /* 点外部关闭：浮层与触发器都在 document.body 之外的 DOM 里，交给共享 hook。 */
  useDismissOnOutside(
    filterOpen,
    filterPopoverRef,
    filterTriggerRef,
    () => setFilterOpen(false),
    layerId,
  );

  /* 展开后把焦点交给输入框，否则用户还得再点一次。 */
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  /* 浮层打开时把焦点收进来，键盘用户可以直接用上下键走条目。 */
  useEffect(() => {
    if (filterOpen) filterPopoverRef.current?.focus();
  }, [filterOpen, filterPopoverRef]);

  /*
   * Esc 关掉筛选浮层：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 浮层是最上层，Esc 归它；但仲裁器保证**一次按键只关一层**。
   */
  useEscapeHandler(
    {
      canHandle: () => filterOpen,
      handle: () => setFilterOpen(false),
    },
    filterOpen,
  );

  return (
    <div className="create-topbar">
      <div className="create-topbar__group">
        {/*
         * 搜索：input 常驻，收起时宽度 4px 被容器裁掉（只露出放大镜），
         * 展开时容器变宽并让整组重新排布——与即梦一致。
         *
         * 展开的触发：点放大镜，或聚焦输入框。
         * 即梦实测 **hover 不会展开**（收起态 hover 后容器仍是 28 宽），
         * 所以这里不做 hover 展开。
         */}
        <div
          className="create-topbar__search-box"
          ref={searchBoxRef}
          data-open={searchOpen ? "true" : "false"}
        >
          <span
            className="create-topbar__search-icon"
            role="button"
            tabIndex={0}
            aria-label="展开搜索"
            onClick={() => {
              setSearchOpen(true);
              searchInputRef.current?.focus();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setSearchOpen(true);
              searchInputRef.current?.focus();
            }}
          >
            <JimengIcon name="search" />
          </span>
          <input
            ref={searchInputRef}
            type="text"
            name="create-search"
            value={search}
            placeholder="搜索"
            aria-label="搜索"
            maxLength={100}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onSearchChange("");
                setSearchOpen(false);
                searchInputRef.current?.blur();
              }
            }}
          />
        </div>

        <span className="create-topbar__separator" aria-hidden="true" />

        <div className="create-topbar__filter">
          <button
            ref={filterTriggerRef}
            type="button"
            className="create-topbar__icon-button"
            aria-label="筛选"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            data-active={filter !== "all" ? "true" : "false"}
            onClick={() => setFilterOpen((open) => !open)}
          >
            <JimengIcon name="filter" />
          </button>
        </div>

        <span className="create-topbar__separator" aria-hidden="true" />

        <button
          type="button"
          className="create-topbar__icon-button"
          aria-label="资产库"
          aria-expanded={assetsOpen}
          data-active={assetsOpen ? "true" : "false"}
          onClick={onOpenAssets}
        >
          <JimengIcon name="assets" />
        </button>
      </div>

      {/*
        积分位：即梦放余额，这里放当前供应商连接。
        形状、字号、颜色都对齐即梦那枚胶囊，未接入供应商时显示提示而不是数字。
      */}
      <div className="create-topbar__provider">
        <span className="create-topbar__provider-name">{providerName ?? "未接入供应商"}</span>
      </div>

      {filterOpen
        ? createPortal(
            <FilterPopover
              popoverRef={filterPopoverRef}
              filter={filter}
              onFilterChange={onFilterChange}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
