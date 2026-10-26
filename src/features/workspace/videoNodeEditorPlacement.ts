import type { CanvasNodeRect } from "./workspaceModel";

export function videoNodeEditorPlacement(
  node: CanvasNodeRect,
  viewport: { readonly width: number; readonly height: number },
  editorHeight: number,
  zoom: number,
  bottomClearance: number,
) {
  const margin = 8;
  /*
   * 原站 liblib 的编辑层比节点宽（约 1145px），因为它那一行里还挂着
   * 「+参考 / 标记 / 角色库 / 运镜」和参考缩略图。本项目的编辑区没有这排
   * 内容，宽度沿用 660px——把它拉成 1145 只会留大片空白。
   */
  const width = Math.max(0, Math.min(660, viewport.width - margin * 2));
  const maxHeight = Math.max(0, viewport.height - bottomClearance - margin * 2);
  const height = Math.min(editorHeight, maxHeight);
  const gap = 8 * zoom;
  const below = node.y + node.height + gap;
  // 节点名称位于媒体框上方；向上避让时一并留出标题的空间。
  const above = node.y - height - gap - 32 * zoom;
  const bottom = viewport.height - bottomClearance - margin;
  const top =
    below + height <= bottom ? below : above >= margin ? above : Math.min(below, bottom - height);
  return {
    width,
    maxHeight,
    left: Math.max(
      margin,
      Math.min(node.x + node.width / 2 - width / 2, viewport.width - width - margin),
    ),
    top: Math.max(margin, top),
  };
}
