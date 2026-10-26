import {
  ArrowUp,
  AudioLines,
  Briefcase,
  Camera,
  CaptionsOff,
  CircleHelp,
  Clapperboard,
  Clock,
  Crosshair,
  Download,
  Film,
  Grid2x2Plus,
  Grid3x3,
  Image,
  Images,
  Keyboard,
  Layers,
  LayoutGrid,
  Magnet,
  Maximize,
  MousePointer2,
  Orbit,
  Pencil,
  Plus,
  Replace,
  Scissors,
  Shapes,
  Smile,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Table2,
  User,
  Video,
  type LucideIcon,
} from "lucide-react";

/**
 * 画布外壳的图标集。
 *
 * 原站 liblib 画布用 **Iconify**：品牌图标取自它自有的 `iconify--libtv` 集，
 * 其余取自 **Lucide**（`iconify--lucide`）。本项目原本全站用 Phosphor，
 * 画布外壳的图标字形因此和原站对不上（线条粗细、端点形状都不同）。
 * 这里把画布外壳换成 Lucide——与原站同一套矢量，形状一致。
 *
 * 自有品牌图标（Logo、积分超市、会员等）无法逐字复刻，用 Lucide 里语义最近的
 * 代替，并在各处标注了对应关系。
 */
export type CanvasChromeIconName =
  | "plus"
  | "move"
  | "grid"
  | "smile"
  | "clock"
  | "keyboard"
  | "help"
  | "assets"
  | "minimap"
  | "member"
  | "adjust"
  | "snap"
  | "panorama"
  | "angle"
  | "light"
  | "grid3"
  | "upscale"
  | "edit"
  | "split"
  | "cut"
  | "image"
  | "video"
  | "retake"
  | "breakdown"
  | "subtitle"
  | "separate"
  | "replace"
  | "titlecard"
  | "camera"
  | "download"
  | "fullscreen"
  /** 编辑层工具 chips：参考 / 标记 / 角色库 / 运镜。 */
  | "crosshair"
  | "universal"
  /** 浮坞：四宫格（功能组件）、表情、全部功能（提包）。 */
  | "grid2plus"
  | "features"
  /** 生成提交按钮（原站是白底圆角方块里的向上箭头）。 */
  | "arrow-up";

const ICONS: Record<CanvasChromeIconName, LucideIcon> = {
  plus: Plus,
  move: MousePointer2,
  grid: LayoutGrid,
  smile: Smile,
  clock: Clock,
  keyboard: Keyboard,
  help: CircleHelp,
  assets: Layers,
  minimap: Table2,
  member: User,
  adjust: SlidersHorizontal,
  snap: Magnet,
  panorama: Images,
  angle: Orbit,
  light: Sun,
  grid3: Grid3x3,
  upscale: Sparkles,
  edit: Pencil,
  split: Layers,
  cut: Scissors,
  image: Image,
  video: Video,
  retake: Clapperboard,
  breakdown: Film,
  subtitle: CaptionsOff,
  separate: AudioLines,
  replace: Replace,
  titlecard: Shapes,
  camera: Camera,
  download: Download,
  fullscreen: Maximize,
  crosshair: Crosshair,
  universal: Sparkles,
  grid2plus: Grid2x2Plus,
  features: Briefcase,
  "arrow-up": ArrowUp,
};

export interface CanvasChromeIconProps {
  readonly name: CanvasChromeIconName;
  /** 图标边长（px）。原站：底坞 20，左下控件组 14。 */
  readonly size?: number;
  readonly className?: string;
}

export function CanvasChromeIcon({ name, size = 20, className }: CanvasChromeIconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      strokeWidth={1.75}
      focusable="false"
    />
  );
}
