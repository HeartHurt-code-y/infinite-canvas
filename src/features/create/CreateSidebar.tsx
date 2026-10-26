/*
 * 生成页左侧栏（对应即梦的 `aside.sidebar`）。
 *
 * 实测规格：宽 240px、底色 #171717、内边距 14px 12px 12px、纵向 flex、gap 32px；
 * 主导航项高 36px、圆角 8px、内边距 0 8px、图标 24px + 文案 14px/22px 字重 500；
 * 分区标题（对话 / 画布）13px/20px、字重 400、色 rgba(255,255,255,.6)、圆角 6px。
 *
 * 即梦的「探索 / 主体」分区本项目没有对应子系统，这两页签保留在导航里但
 * 标记为未落地——它们的样式与「创作 / 资产」完全一致，差别只在是否可点。
 */
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { JimengIcon, type JimengIconName } from "./JimengIcon";
import { toast } from "../../lib/toast";
import { CREATE_NAV_ITEMS } from "./createPageModel";

/**
 * 导航项 → 图标。
 *
 * 用即梦原生的路径（`jimengIcons.ts`，从原站活体 DOM 抽取），
 * 不用项目通用的 Phosphor —— 形状不同一眼就看得出来。
 */
const NAV_ICONS: Record<string, JimengIconName> = {
  create: "navCreate",
  explore: "navExplore",
  asset: "navAsset",
  subject: "navSubject",
};

export interface CreateSidebarProps {
  /** 侧栏是否收起（收起后只留图标条）。 */
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** 当前会话名；对应即梦的「默认创作」。 */
  readonly conversationName: string;
  /** 「新建对话」：清空当前输入与参考，开始新一轮。 */
  readonly onNewConversation: () => void;
  /** 跳回画布工作台。 */
  readonly onOpenWorkspace: () => void;
  /** 打开资产库抽屉。 */
  readonly onOpenAssets: () => void;
}

export function CreateSidebar({
  collapsed,
  onToggleCollapsed,
  conversationName,
  onNewConversation,
  onOpenWorkspace,
  onOpenAssets,
}: CreateSidebarProps) {
  /*
   * 「对话」「画布」是两个可折叠的分区（多级树的第二层）。
   *
   * 即梦活体实测：这两个标题是 `aria-expanded="true"` 的可展开按钮，
   * 展开时露出各自的子项（对话 → 新建对话 / 默认创作；画布 → 全部 / 新建画布）。
   * 上一版只把 `aria-expanded` 写成 true 却不能折叠——控件在、可点不动。
   */
  const [sections, setSections] = useState({ chat: true, canvas: true });
  const toggleSection = (key: "chat" | "canvas"): void => {
    setSections((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  return (
    <aside
      className="create-sidebar"
      aria-label="主导航"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="create-sidebar__header">
        <button type="button" className="create-sidebar__brand" aria-label="无限画布">
          <span className="create-sidebar__logo" aria-hidden="true">
            <JimengIcon name="sidebarBrand" size="1.25rem" />
          </span>
          <span className="create-sidebar__wordmark">无限画布</span>
        </button>
        <button
          type="button"
          className="create-sidebar__toggle"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <JimengIcon name="sidebarCollapse" />
        </button>
      </div>

      <div className="create-sidebar__content">
        <nav className="create-sidebar__nav" aria-label="主功能">
          {CREATE_NAV_ITEMS.map((item) => {
            const icon = NAV_ICONS[item.id] ?? "navCreate";
            const active = item.id === "create";
            /*
             * 「探索 / 主体」本项目没有对应子系统。
             *
             * 但它们**不能是点了没反应的空按钮**（AGENTS.md「画布外壳对齐
             * 约定」对下线入口的要求：保留位置并标注「后端暂未接入」），
             * 所以照样可点，点了讲清楚为什么不通。
             */
            const onClick =
              item.id === "asset"
                ? onOpenAssets
                : item.id === "create"
                  ? undefined
                  : () => toast(`${item.label}分区后端暂未接入。`);
            return (
              <button
                key={item.id}
                type="button"
                className="create-sidebar__nav-item"
                aria-current={active ? "page" : undefined}
                data-enabled={onClick ? "true" : "false"}
                onClick={onClick}
              >
                <JimengIcon name={icon} className="create-sidebar__nav-icon" />
                <span className="create-sidebar__nav-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="create-sidebar__projects">
          <button
            type="button"
            className="create-sidebar__section"
            aria-expanded={sections.chat}
            onClick={() => toggleSection("chat")}
          >
            对话
          </button>
          {sections.chat ? (
            <>
              <button
                type="button"
                className="create-sidebar__sub-action"
                onClick={onNewConversation}
              >
                <JimengIcon name="newChat" />
                新建对话
              </button>
              <div className="create-sidebar__conversation">
                <span className="create-sidebar__conversation-thumb" aria-hidden="true">
                  <JimengIcon name="sidebarBrand" size="0.875rem" />
                </span>
                <span className="create-sidebar__conversation-name">{conversationName}</span>
              </div>
            </>
          ) : null}

          <button
            type="button"
            className="create-sidebar__section"
            aria-expanded={sections.canvas}
            onClick={() => toggleSection("canvas")}
          >
            画布
          </button>
          {sections.canvas ? (
            <>
              <button
                type="button"
                className="create-sidebar__sub-action"
                onClick={onOpenWorkspace}
              >
                <Icon name="stack-simple" size="xs" aria-hidden="true" />
                全部
              </button>
              <button
                type="button"
                className="create-sidebar__sub-action"
                onClick={onOpenWorkspace}
              >
                <JimengIcon name="newChat" />
                新建画布
              </button>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
