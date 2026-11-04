import { CanvasChromeIcon, type CanvasChromeIconName } from "./CanvasChromeIcons";
import { CanvasDockLibrary } from "./CanvasDockLibrary";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { CanvasLibraryKind } from "./canvasLibraryResources";
import "./CanvasChromeControls.css";

/**
 * 画布外壳控件：对齐 liblib.tv 画布的左下控件组与底部浮坞。
 *
 * 逆向依据：docs/integrations/liblib-canvas-re.md（活体实测计算样式）。
 *  - 左下控件组：`fixed bottom-3 z-10 flex items-end gap-2`，组内 gap 4px、
 *    圆角 12px、内边距 6px；文字按钮 28px 高 / 12px 横内边距 / 13px 文字，
 *    纯图标按钮 28×28，**图标 14px**。
 *  - 底部浮坞：圆角 12px、**内边距 8px、间隙 8px**，按钮 **32×32**、
 *    **图标 20px**，底色 `--canvas-controls-bg`、描边 `--canvas-controls-border`。
 */
export interface CanvasChromeControlsProps {
  /** 打开资产抽屉（liblib 的「资产管理」）。 */
  readonly onOpenAssets: (trigger: HTMLElement) => void;
  readonly assetsOpen: boolean;
  /** 整理画布（liblib 的「整理画布」Alt+Shift+F）。 */
  readonly onFormatLayout: () => void;
  /** 小地图是否展开。 */
  readonly minimapVisible: boolean;
  readonly onToggleMinimap: () => void;
  /** 连线是否可见；按钮语义是「隐藏节点连线」。 */
  readonly edgesVisible: boolean;
  readonly onToggleEdges: () => void;
  /** 网格吸附是否开启。 */
  readonly snapToGrid: boolean;
  readonly onToggleSnap: () => void;
  /** 缩放控件：liblib 这一组里的最后一项（一个百分比按钮 + 菜单）。 */
  readonly zoomControl?: React.ReactNode;
}

export function CanvasChromeControls({
  onOpenAssets,
  assetsOpen,
  onFormatLayout,
  minimapVisible,
  onToggleMinimap,
  edgesVisible,
  onToggleEdges,
  snapToGrid,
  onToggleSnap,
  zoomControl,
}: CanvasChromeControlsProps) {
  return (
    <div className="canvas-chrome-items" role="group" aria-label="画布视图选项">
      <button
        type="button"
        className="canvas-chrome-items__button"
        aria-label="资产管理"
        data-tooltip="资产管理"
        aria-controls="canvas-asset-drawer"
        aria-pressed={assetsOpen}
        onClick={(event) => onOpenAssets(event.currentTarget)}
      >
        <CanvasChromeIcon name="assets" size={14} />
        <span className="canvas-chrome-items__label">资产管理</span>
      </button>
      <button
        type="button"
        className="canvas-chrome-items__button canvas-chrome-items__button--icon"
        aria-label="整理画布"
        data-tooltip="整理画布 · Alt+Shift+F"
        onClick={onFormatLayout}
      >
        <CanvasChromeIcon name="grid" size={14} />
      </button>
      <button
        type="button"
        className="canvas-chrome-items__button canvas-chrome-items__button--icon"
        aria-label="切换小地图"
        data-tooltip="切换小地图"
        aria-pressed={minimapVisible}
        onClick={onToggleMinimap}
      >
        <CanvasChromeIcon name="minimap" size={14} />
      </button>
      <button
        type="button"
        className="canvas-chrome-items__button canvas-chrome-items__button--icon"
        aria-label="隐藏节点连线"
        data-tooltip="隐藏节点连线"
        aria-pressed={!edgesVisible}
        onClick={onToggleEdges}
      >
        <CanvasChromeIcon name="adjust" size={14} />
      </button>
      <button
        type="button"
        className="canvas-chrome-items__button canvas-chrome-items__button--icon"
        aria-label="网格吸附"
        data-tooltip="网格吸附"
        aria-pressed={snapToGrid}
        onClick={onToggleSnap}
      >
        <CanvasChromeIcon name="snap" size={14} />
      </button>
      {zoomControl}
    </div>
  );
}

export interface CanvasBottomDockProps {
  /** 打开「添加节点」菜单。 */
  readonly onAddNode: (trigger: HTMLElement) => void;
  readonly addNodeOpen: boolean;
  /** 「添加节点」按钮的 ref：连接菜单要拿它做浮层锚点。 */
  readonly addNodeTriggerRef?: React.Ref<HTMLButtonElement>;
  /**
   * 画布拖拽模式。
   *
   * liblib 浮坞第二格是「移动」：拖动画布内容。点一次切到「框选」模式，
   * 再点一次切回「移动」——原站是同一个位置上的模式切换。
   */
  readonly handTool: boolean;
  readonly onToggleHandTool: () => void;
  readonly featuresOpen: boolean;
  readonly onOpenFeatures: () => void;
  readonly onOpenLibrary: (kind: CanvasLibraryKind) => void;
  readonly onOpenCharacterStudio: () => void;
  readonly characterStudioOpen: boolean;
  /** 打开教程（原站浮坞「教程」，对应本项目的 4 步新手引导）。 */
  readonly onOpenGuide?: () => void; /** 打开历史记录。 */
  readonly onOpenHistory: () => void;
  /** 悬停历史记录时预热弹窗，避免首次点击要等加载。 */
  readonly onPreloadHistory?: () => void;
  /** 打开快捷键面板。 */
  readonly shortcutsOpen: boolean;
  readonly onOpenShortcuts: (trigger: HTMLButtonElement) => void;
  readonly directorOpen: boolean;
  readonly onToggleDirector: () => void;
}

/**
 * 底部浮坞。
 *
 * 原站实测（2026-10-22，登录态活体 DOM，1707×898）：
 *   添加节点 ⊕ / 移动 / 素材库 / 角色造型室 / 全部功能 / 生成历史 / 快捷键 / 教程
 *   + 右侧一枚 **48×48** 的品牌胶囊（TV Director，渐变圆球）。
 *   八个图标格都是 32×32、圆角 8、图标 20px。
 *
 */
export function CanvasBottomDock({
  onAddNode,
  addNodeOpen,
  addNodeTriggerRef,
  handTool,
  onToggleHandTool,
  featuresOpen,
  onOpenFeatures,
  onOpenLibrary,
  onOpenCharacterStudio,
  characterStudioOpen,
  onOpenGuide,
  onOpenHistory,
  onPreloadHistory,
  onOpenShortcuts,
  shortcutsOpen,
  directorOpen,
  onToggleDirector,
}: CanvasBottomDockProps) {
  const dockIcon = (name: CanvasChromeIconName) => <CanvasChromeIcon name={name} size={20} />;
  return (
    <div className="canvas-bottom-dock-row">
      <div className="canvas-bottom-dock" role="group" aria-label="画布浮坞">
        <button
          ref={addNodeTriggerRef}
          type="button"
          className="canvas-bottom-dock__action canvas-bottom-dock__action--primary"
          aria-label="添加节点"
          aria-haspopup="menu"
          aria-expanded={addNodeOpen}
          title="添加节点（也可双击或右键画布空白处）"
          onClick={(event) => onAddNode(event.currentTarget)}
        >
          {dockIcon("plus")}
        </button>
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label={handTool ? "抓手工具" : "移动工具"}
          aria-pressed={handTool}
          data-tooltip={handTool ? "抓手工具 · 拖动画布 · 按 V 移动节点" : "移动工具 · 拖动节点，空白处框选 · 按 H 切换抓手"}
          onClick={onToggleHandTool}
        >
          {handTool ? <LibTVMediaIcon name="hand-n" size={20} /> : dockIcon("move")}
        </button>
        <CanvasDockLibrary onChoose={onOpenLibrary} />
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label="角色造型室"
          data-tooltip="角色造型室"
          aria-haspopup="dialog"
          aria-expanded={characterStudioOpen}
          onClick={onOpenCharacterStudio}
        >
          {dockIcon("smile")}
        </button>
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label="全部功能"
          aria-haspopup="dialog"
          aria-expanded={featuresOpen}
          data-tooltip="全部功能"
          onClick={onOpenFeatures}
        >
          {dockIcon("features")}
        </button>
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label="生成历史"
          data-tooltip="生成历史"
          onMouseEnter={onPreloadHistory}
          onFocus={onPreloadHistory}
          onClick={onOpenHistory}
        >
          {dockIcon("clock")}
        </button>
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label="快捷键"
          data-tooltip="快捷键"
          aria-haspopup="dialog"
          aria-expanded={shortcutsOpen}
          onClick={(event) => onOpenShortcuts(event.currentTarget)}
        >
          {dockIcon("keyboard")}
        </button>
        {/* 原站浮坞在「快捷键」与「教程」之间有一根 1×24 的竖分隔线。 */}
        <span className="canvas-bottom-dock__divider" aria-hidden="true" />
        <button
          type="button"
          className="canvas-bottom-dock__action"
          aria-label="教程"
          data-tooltip="教程"
          onClick={onOpenGuide}
        >
          {dockIcon("help")}
        </button>
      </div>
      <button
        type="button"
        className="canvas-bottom-dock__brand"
        aria-label="TV Director"
        aria-expanded={directorOpen}
        data-tooltip="TV Director"
        onClick={onToggleDirector}
      >
        <span className="canvas-bottom-dock__brand-mark" aria-hidden="true" />
      </button>
    </div>
  );
}
