/*
 * 浮层定位：把挂在 document.body 上的浮层对齐到触发元素。
 *
 * 为什么放共享模块：画布节点的下拉（CanvasSelect）、创作台的下拉与参数面板
 * 都要在「任意滚动／缩放容器里」工作，定位规则必须一致——各写一份迟早漂移。
 *
 * 为什么必须用 portal：浮层一旦留在触发元素所在的 DOM 里，就会被祖先的
 * overflow 裁掉。创作台的参数工具条是 `overflow-x: auto` 的横向滚动容器，
 * 浮层朝上弹出时整块被裁，用户看到的就是「点了没反应」。
 *
 * ── 锚定规则（对齐即梦实测）─────────────────────────────────────
 * 即梦的浮层用 `lv-trigger-position-bl` 挂在触发器上：面板**底边**贴住
 * 触发器**顶边**，留 7～8px 缝隙。实测（2026-10-22，1720×876 视口）：
 *   · 参数面板 336×213.3，触发器顶边 807.3，面板底边 799.6 → 缝隙 7.7px；
 *   · 创作类型下拉 200×317，面板底边 799.6、触发器顶边 807.3 → 同样 7.7px。
 * 所以本模块的契约是：**面板底边 = 触发器顶边 − 8px**。
 *
 * ── 左边缘：即梦的浮层比触发器左边缘**左移 16px** ────────────────────
 * 2026-10-22 二次实测（1707×876、DPR 1.5）逐个点开四块浮层量到的：
 *   · 创作类型下拉：触发器左 476.33 → 浮层左 460.33，差 **−16**；
 *   · 技能下拉：    触发器左 661.38 → 浮层左 645.38，差 **−16**；
 *   · 主体选择器：  触发器左 725.38 → 浮层左 709.38，差 **−16**；
 *   · 生成偏好面板：触发器左 379.38 → 浮层左 363.38，差 **−16**。
 * 四处完全一致，说明这是即梦统一的浮层偏移（Arco Trigger 的 offset
 * `[-16, -8]`），不是某个下拉的特例。创作台的浮层一律按 −16 贴；
 * 画布节点自己的菜单不走这条规则，用默认的 0（见 `leftOffset`）。
 *
 * ── 为什么不能拿 maxHeight 当高度用（这是旧版飘离的根因）────────────
 * 旧实现在向上弹时把 `top` 算成 `rect.top − maxHeight − 6`，把**高度上限**
 * 当成了**实际高度**。CSS 的 `top` 锚定的是面板**顶边**，于是面板整体
 * 上浮了 `maxHeight − 实际高度` px：
 *   · 创作类型下拉实际高 320、上限 320 → 恰好贴合（这个侥幸没露馅）；
 *   · 参数面板实际高约 120、上限 420 → 面板顶边被推到触发器上方 306px，
 *     面板孤零零飘在视口中间，与触发器之间出现一条 100+px 的黑缝。
 * 现在改为**测量浮层自身的实际高度**再定位，并把结果回写给调用方。
 */

/** 浮层与视口边缘的最小留白。 */
export const FLOATING_LAYER_MARGIN = 8;

/** 浮层与触发器之间的缝隙；对齐即梦实测的 7～8px。 */
export const FLOATING_LAYER_GAP = 8;

/** Measured side menu placement shared by canvas reference and media action menus. */
export function placeSideMenu(parent: HTMLElement, anchor: HTMLElement, menu: HTMLElement) {
  const parentBox = parent.getBoundingClientRect();
  const anchorBox = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const right = parentBox.right + 4;
  return {
    left: right + box.width <= document.documentElement.clientWidth - 8
      ? right : Math.max(8, parentBox.left - box.width - 4),
    top: Math.max(8, Math.min(anchorBox.top, window.innerHeight - box.height - 8)),
  };
}

/** 说明气泡与视口边缘的最小留白。 */
export const TOOLTIP_LAYER_MARGIN = 8;

/** 说明气泡与触发器之间的缝隙。 */
export const TOOLTIP_LAYER_GAP = 8;

/**
 * 说明气泡的估算高度（px）。
 *
 * 仅在**量不到**时兜底（首次渲染、或触发器已卸载）。取值偏大是故意的：
 * 估算偏小会让下方明明放不下却判定放得下，说明照样被视口下沿切掉；
 * 偏大只是让气泡提前翻到上方，不会造成截断。
 */
export const TOOLTIP_ESTIMATED_HEIGHT = 40;

/** 箭头距离气泡左右边缘的最小距离（px），免得箭头跑到圆角外面。 */
const ARROW_INSET = 8;

export interface FloatingLayerPlacement {
  /** 视口坐标（配合 `position: fixed` 使用）。 */
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  /**
   * 面板实际高度（调用方测量后回写，用于下一次定位）。
   *
   * 旧版本只回写高度上限，导致向上弹出时面板按「上限」定位而不是按
   * 「实际高度」定位，浮层会飘离触发器。
   */
  readonly measuredHeight: number | null;
}

export interface FloatingLayerOptions {
  readonly maxWidth?: number | undefined;
  /** 水平贴靠方式；摄像机面板在触发器中心展开，其余浮层默认左对齐。 */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 浮层最小宽度；最终宽度取触发器宽度与它的较大者。 */
  readonly minWidth?: number | undefined;
  /** 上下空间都不够时是否翻到上方。默认按空间自动判断。 */
  readonly preferAbove?: boolean | undefined;
  /** 最大高度上限（视口空间更小时以视口为准）。 */
  readonly maxHeight?: number | undefined;
  /** 视口留白。 */
  readonly margin?: number | undefined;
  /**
   * 浮层左边缘相对触发器左边缘的额外偏移；负数向左。
   *
   * 即梦创作台的浮层统一是 −16（见文件头实测）；画布节点菜单不需要，
   * 保持默认 0。
   */
  readonly leftOffset?: number | undefined;
  /**
   * 浮层与触发器之间的缝隙。
   *
   * 默认 8（即梦朝上浮层的实测 7.7px 取整）；顶栏筛选那种朝下弹的
   * 浮层实测是 12px，单独传。
   */
  readonly gap?: number | undefined;
  /**
   * 浮层上一次测得的实际高度。
   *
   * 首次打开时浮层还没渲染，量不到高度；调用方可以先用面板内容高度
   * 估算，或者接受首帧的轻微偏移（下一帧会自我纠正）。
   */
  readonly measuredHeight?: number | null | undefined;
}

/**
 * 计算浮层位置。
 *
 * 规则：宽度贴着触发器（至少 `minWidth`）；优先贴在触发器**顶边上方**
 * （即梦的 `lv-trigger-position-bl` 语义），空间不足时才翻到下方；
 * 高度用**实测值**而不是上限；左右不越出视口。
 */
export function placeFloatingLayer(
  anchor: HTMLElement,
  options: FloatingLayerOptions = {},
): FloatingLayerPlacement {
  const margin = options.margin ?? FLOATING_LAYER_MARGIN;
  const minWidth = options.minWidth ?? 200;
  const heightCap = options.maxHeight ?? 320;
  const gap = options.gap ?? FLOATING_LAYER_GAP;
  const leftOffset = options.leftOffset ?? 0;
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const width = Math.min(Math.max(rect.width, minWidth), options.maxWidth ?? Infinity, Math.max(0, viewportWidth - margin * 2));
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  /*
   * 方向：
   *   - `preferAbove: true`（创作台浮坞，贴底）→ 默认朝上；但上方装不下
   *     （小于 140）时改朝下，否则面板会被视口上沿切掉。
   *   - `preferAbove: false`（画布节点的菜单）→ 下方够就朝下贴着卡片，
   *     不够且上方更宽裕才朝上。
   *   - 不传 → 与 `true` 同义（浮坞类浮层的默认语义）。
   */
  const wantAbove = options.preferAbove ?? true;
  const fitsAbove = spaceAbove >= 140;
  const placeAbove = wantAbove ? fitsAbove : spaceBelow < 160 && spaceAbove > spaceBelow;
  const available = placeAbove ? spaceAbove : spaceBelow;
  // An anchor can move outside the viewport during a canvas resize. Its available
  // space must never make the popover taller than the visible viewport itself.
  const viewportHeightCap = Math.max(0, window.innerHeight - margin * 2);
  const maxHeight = Math.min(viewportHeightCap, Math.max(140, Math.min(heightCap, available)));

  /*
   * 高度用实测值。量不到（首次渲染）时退回一个保守估计，
   * 避免用上限把面板顶到天上去。
   */
  const measured = options.measuredHeight ?? null;
  const effectiveHeight = Math.min(maxHeight, measured ?? 320);

  const preferredLeft = options.align === "center" ? rect.left + (rect.width - width) / 2
    : options.align === "end" ? rect.right - width : rect.left;
  const left = Math.min(
    Math.max(margin, preferredLeft + leftOffset),
    Math.max(margin, viewportWidth - width - margin),
  );
  /*
   * 向上弹：面板**底边**贴触发器顶边上方 gap 处 → 顶边 = 触发器顶边 − gap − 面板高。
   * 下方空间不够时把面板顶边夹在视口内，别让它掉出屏幕。
   */
  const preferredTop = placeAbove
    ? Math.max(margin, rect.top - gap - effectiveHeight)
    : Math.min(rect.bottom + gap, Math.max(margin, window.innerHeight - effectiveHeight - margin));
  const top = Math.min(preferredTop, Math.max(margin, window.innerHeight - effectiveHeight - margin));
  return { top, left, width, maxHeight, measuredHeight: measured };
}

/** 说明气泡的贴靠方向。 */
export type TooltipSide = "top" | "bottom";

export interface TooltipPlacement {
  /** 视口坐标（配合 `position: fixed` 使用）。 */
  readonly top: number;
  readonly left: number;
  /** 实际贴靠方向：下方空间不足时会翻到 `top`。 */
  readonly side: TooltipSide;
  /**
   * 箭头在气泡内的水平位置（px，相对气泡左沿）。
   *
   * 箭头要**指向触发器**，不能写死 50%：气泡被视口边缘夹住时，气泡中心
   * 并不在触发器正上方，写死 50% 会让箭头指错方向。夹在气泡圆角内，
   * 免得箭头跑到圆角外面变成一个孤立的方块。
   */
  readonly arrowLeft: number;
}

export interface TooltipPlacementOptions {
  readonly preferAbove?: boolean | undefined;
  /** 视口留白。 */
  readonly margin?: number | undefined;
  /** 说明与触发器之间的缝隙。 */
  readonly gap?: number | undefined;
  /**
   * 说明的实测宽度。
   *
   * 必须用**实测值**：说明文本长度不定，用估算值会在长文案时算错左右
   * 夹取的位置，导致说明越出视口右沿。
   */
  readonly measuredWidth?: number | undefined;
  /**
   * 说明的实测高度。
   *
   * 同理必须实测：翻面判断（「下方装不装得下」）全靠这个值。
   * 估算偏小会让下方明明放不下却判定放得下，说明照样被视口下沿切掉。
   */
  readonly measuredHeight?: number | undefined;
  /**
   * 触发器**已测得**的矩形。
   *
   * 调用方若已经量过（为了做可见性判定），传进来可省一次
   * `getBoundingClientRect()`——那是**强制同步布局**的读取，在按帧/按间隔
   * 跟随时是实打实的开销。不传则由本函数自己量一次。
   */
  readonly anchorRect?: DOMRectReadOnly | undefined;
}

/**
 * 计算说明气泡（tooltip）的位置。
 *
 * 为什么不用 CSS 伪元素（`[data-tooltip]::after`）：
 *   - 伪元素**永远朝下**展开（`top: calc(100% + gap)`）。贴底的控件
 *     （画布左下控件组、底部浮坞）下方没有空间，说明被视口下沿切掉。
 *   - 伪元素挂在触发器内部，会被祖先的 `overflow: hidden`
 *     （`.canvas-stage`）裁掉，也无法翻到上方。
 *   - 伪元素量不到自己的宽度，长文案无法在视口右沿夹住。
 *
 * 规则：优先朝下（与原有视觉一致）；下方空间装不下就翻到上方；
 * 水平方向以触发器中心对齐，超出视口时夹在视口内。
 */
export function placeTooltip(
  anchor: HTMLElement,
  options: TooltipPlacementOptions = {},
): TooltipPlacement {
  const margin = options.margin ?? TOOLTIP_LAYER_MARGIN;
  const gap = options.gap ?? TOOLTIP_LAYER_GAP;
  /* 调用方已量过就复用，省一次强制同步布局的读取。 */
  const rect = options.anchorRect ?? anchor.getBoundingClientRect();
  /*
   * 视口尺寸的取法要分横向纵向：
   *
   *   - 横向用 `clientWidth`：`position: fixed` 的包含块是**视口可见区**，
   *     不含滚动条。实测有 15px 滚动条时，`innerWidth` 是 1000 而 fixed
   *     元素的右沿只能到 985——用 `innerWidth` 夹取会让气泡压到滚动条上。
   *   - 纵向用 `innerHeight`：`documentElement.clientHeight` 在**根元素本身
   *     可滚动**时是内容高度（实测 3000），不是视口高，用它会把气泡算到
   *     屏幕外。`innerHeight` 始终是视口高度。
   */
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = window.innerHeight;
  /*
   * 宽高都用**实测值**。高度尤其关键：翻面判断（「下方装不装得下」）
   * 全靠它。量不到时退回保守估计，宁可提前翻面也不要让说明被切掉。
   */
  const measuredWidth = options.measuredWidth ?? 0;
  const bubbleHeight = options.measuredHeight ?? TOOLTIP_ESTIMATED_HEIGHT;
  const spaceBelow = viewportHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  /*
   * 翻面条件：下方装不下（放不下就被视口下沿切掉）**且**上方放得下。
   * 两边都不够时仍选下方并把它夹进视口——此时说明会盖住触发器，
   * 但至少文字完整可读，不会被切成半行。
   */
  const side: TooltipSide =
    options.preferAbove
      ? spaceAbove >= bubbleHeight || spaceAbove > spaceBelow ? "top" : "bottom"
      : spaceBelow < bubbleHeight && spaceAbove > spaceBelow ? "top" : "bottom";

  const top =
    side === "top"
      ? Math.max(margin, rect.top - gap - bubbleHeight)
      : Math.min(rect.bottom + gap, Math.max(margin, viewportHeight - bubbleHeight - margin));

  /*
   * 水平：默认以触发器中心对齐（与原伪元素的 `left: 50%` 一致），
   * 越出视口时夹在视口内。宽度用实测值——估算值会让长文案算错夹取位置。
   *
   * 夹取必须**先算下界再算上界**，不能写成
   * `min(max(margin, centered), max(margin, viewportWidth - w - margin))`：
   * 那种写法在气泡比视口还宽时，两个边界的大小关系会反转，结果取到下界，
   * 气泡照样溢出视口。这里显式分成两种情况处理。
   */
  const centered = rect.left + rect.width / 2 - measuredWidth / 2;
  const maxLeft = viewportWidth - measuredWidth - margin;
  const left =
    /* 气泡本身比可用宽度还宽：贴左沿放，宁可右边溢出也要让开头可读。 */
    maxLeft <= margin ? margin : Math.min(Math.max(margin, centered), maxLeft);

  /*
   * 箭头对准触发器中心：触发器中心 − 气泡左沿。
   * 夹在 [8, 气泡宽 − 8] 内，避免箭头贴到圆角外面。
   */
  const anchorCenter = rect.left + rect.width / 2;
  const arrowLeft = Math.min(
    Math.max(ARROW_INSET, anchorCenter - left),
    Math.max(ARROW_INSET, measuredWidth - ARROW_INSET),
  );

  return { top, left, side, arrowLeft };
}
