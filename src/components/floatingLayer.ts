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
  const width = Math.max(rect.width, minWidth);
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
  const maxHeight = Math.max(140, Math.min(heightCap, available));

  /*
   * 高度用实测值。量不到（首次渲染）时退回一个保守估计，
   * 避免用上限把面板顶到天上去。
   */
  const measured = options.measuredHeight ?? null;
  const effectiveHeight = measured === null ? Math.min(maxHeight, 320) : measured;

  const left = Math.min(
    Math.max(margin, rect.left + leftOffset),
    Math.max(margin, window.innerWidth - width - margin),
  );
  /*
   * 向上弹：面板**底边**贴触发器顶边上方 gap 处 → 顶边 = 触发器顶边 − gap − 面板高。
   * 下方空间不够时把面板顶边夹在视口内，别让它掉出屏幕。
   */
  const top = placeAbove
    ? Math.max(margin, rect.top - gap - effectiveHeight)
    : Math.min(rect.bottom + gap, Math.max(margin, window.innerHeight - effectiveHeight - margin));
  return { top, left, width, maxHeight, measuredHeight: measured };
}
