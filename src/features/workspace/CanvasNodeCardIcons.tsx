import {
  CircleAlert,
  CircleCheck,
  Image,
  LoaderCircle,
  Pencil,
  Play,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/**
 * 节点卡（生成/产物节点）的图标集。
 *
 * 原站 liblib 的节点卡与标题条用 **Iconify**：
 * - 类型图标是 `iconify--libtv` 的自绘字形（图片=圆角方框里的山峰、视频=实心播放三角）；
 * - 标题条末尾还有一枚 `#09CAF5` 的盾牌徽标。
 * 自绘字形无法逐字复刻，这里按 AGENTS.md「画布外壳的图标用 Lucide」的约定，
 * 从 `lucide-react` 直接取语义最近的矢量：
 * - `image` → `Image`（方框里的山峰，与原站同构）
 * - `video` → `Play`（实心播放三角，与原站同构）
 * - `shield` → `ShieldCheck`（盾牌徽标）
 *
 * 与 `CanvasChromeIcons.tsx`（画布外壳图标集）分开：外壳图标集是共享文件，
 * 节点卡图标只服务节点卡，避免互相牵动。
 */
export type CanvasNodeCardIconName =
  /** 类型图标：图片节点。 */
  | "image"
  /** 类型图标：视频节点。 */
  | "video"
  /** 标题条末尾的品牌色盾牌徽标。 */
  | "shield"
  /** 生成中（旋转）。 */
  | "spinner"
  /** 生成失败。 */
  | "warning"
  /** 生成完成。 */
  | "done"
  /** 媒体右上角的动作按钮（编辑）。 */
  | "edit";

const ICONS: Record<CanvasNodeCardIconName, LucideIcon> = {
  image: Image,
  video: Play,
  shield: ShieldCheck,
  spinner: LoaderCircle,
  warning: CircleAlert,
  done: CircleCheck,
  edit: Pencil,
};

export interface CanvasNodeCardIconProps {
  readonly name: CanvasNodeCardIconName;
  /** 图标边长（px）。原站：类型图标 14，盾牌徽标 14。 */
  readonly size?: number;
  readonly className?: string;
  readonly strokeWidth?: number;
}

export function CanvasNodeCardIcon({
  name,
  size = 14,
  className,
  strokeWidth = 1.75,
}: CanvasNodeCardIconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      focusable="false"
    />
  );
}
