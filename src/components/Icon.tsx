/*
 * 图标层：全产品图标的唯一来源。
 *
 * 为什么需要这一层
 * ----------------
 * 重构前有 335 个图标调用点，每一处都各自手写 `size` 与 `weight`：
 *
 *   - 实际用出 16 种尺寸（10,11,12,13,14,15,16,17,18,20,22,24,26,28,48,56），
 *     其中 13/15/17 是非标准值。同一个 X 图标在 15 个地方用了 10 种不同尺寸。
 *   - 43 处**根本没有写 weight**。Phosphor 的默认值是 regular，于是界面上
 *     同时存在 bold 与 regular 两套笔画粗细——这是最刺眼的「不像成品」的
 *     观感来源，而且从代码里几乎看不出来。
 *   - 23 处没写 size，静默继承 1em，图标大小会随所在文字的字号漂移。
 *   - 15 处用了 duotone，在一个已统一成单一强调色的产品里是纯杂色。
 *
 * 这一层把上述决策收敛到一处：调用点只说「用哪个图标、多大」，
 * 字重由本模块按尺寸统一决定，尺寸只能取自 tokens.css 的 --icon-* 八档。
 *
 * 用法
 * ----
 *   import { Icon } from "../../components/Icon";
 *
 *   <Icon name="caret-down" size="sm" />
 *   <Icon name={glyphFromData} size="xl" />
 *
 * 关于图标集
 * ----------
 * 使用 Phosphor（MIT，9072 个图标）。它对本品类的关键优势是提供多档字重，
 * 因此可以按渲染尺寸做视觉补偿；多数现代线性图标集只有单一字重，
 * 在 10px 与 48px 会呈现同样的相对笔画，两端必然有一端不合适。
 *
 * 这里故意不使用 `@phosphor-icons/react` 的桶导入：项目已用
 * no-restricted-imports 明确禁止（会让 Vite 分析整个图标桶）。因此逐个深导入
 * 实际用到的图标，并以它们构成唯一的具名映射——这同时让「产品里到底用了
 * 哪些图标」只有一处答案。
 */
/* eslint-disable react-refresh/only-export-components --
 * 本模块刻意把「图标映射 + 图标组件 + 类型 + 查询函数」放在一个文件里：
 * 项目的 no-restricted-imports 禁止桶导入 Phosphor（会让 Vite 分析全部 9000+
 * 图标），因此图标必须逐个深导入；拆成两个文件就意味着要把 59 个导入抄一遍。
 * 这里没有导出常量组件，fast refresh 的损失仅限于本文件自身的编辑体验。 */
import { createElement, forwardRef } from "react";
import type { CSSProperties } from "react";
/*
 * 从官方 `./lib` 子路径取字重类型，而不是从包根取。
 * 包根是 barrel（会命中项目的 no-restricted-imports），./lib 在 exports 里
 * 显式声明过，且只包含类型与底层实现，不牵引图标集合。
 */
import type { IconWeight } from "@phosphor-icons/react/lib";

/* 逐图标深导入（禁止桶导入，见文件头说明）。 */
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowSquareOut } from "@phosphor-icons/react/ArrowSquareOut";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { At } from "@phosphor-icons/react/At";
import { BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretLeft } from "@phosphor-icons/react/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Clock } from "@phosphor-icons/react/Clock";
import { CloudArrowDown } from "@phosphor-icons/react/CloudArrowDown";
import { CloudArrowUp } from "@phosphor-icons/react/CloudArrowUp";
import { Copy } from "@phosphor-icons/react/Copy";
import { CopySimple } from "@phosphor-icons/react/CopySimple";
import { CornersOut } from "@phosphor-icons/react/CornersOut";
import { CrosshairSimple } from "@phosphor-icons/react/CrosshairSimple";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { FileText } from "@phosphor-icons/react/FileText";
import { FilmSlate } from "@phosphor-icons/react/FilmSlate";
import { FilmStrip } from "@phosphor-icons/react/FilmStrip";
import { FloppyDisk } from "@phosphor-icons/react/FloppyDisk";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { FolderSimplePlus } from "@phosphor-icons/react/FolderSimplePlus";
import { GearSix } from "@phosphor-icons/react/GearSix";
import { Globe } from "@phosphor-icons/react/Globe";
import { IdentificationBadge } from "@phosphor-icons/react/IdentificationBadge";
import { Image } from "@phosphor-icons/react/Image";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { Images } from "@phosphor-icons/react/Images";
import { Key } from "@phosphor-icons/react/Key";
import { LinkSimple } from "@phosphor-icons/react/LinkSimple";
import { MagicWand } from "@phosphor-icons/react/MagicWand";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Minus } from "@phosphor-icons/react/Minus";
import { MusicNotes } from "@phosphor-icons/react/MusicNotes";
import { PaperPlaneRight } from "@phosphor-icons/react/PaperPlaneRight";
import { Paperclip } from "@phosphor-icons/react/Paperclip";
import { Pause } from "@phosphor-icons/react/Pause";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Play } from "@phosphor-icons/react/Play";
import { Plus } from "@phosphor-icons/react/Plus";
import { Rectangle } from "@phosphor-icons/react/Rectangle";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { StackSimple } from "@phosphor-icons/react/StackSimple";
import { TextAa } from "@phosphor-icons/react/TextAa";
import { TextT } from "@phosphor-icons/react/TextT";
import { Trash } from "@phosphor-icons/react/Trash";
import { TrashSimple } from "@phosphor-icons/react/TrashSimple";
import { UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { UserFocus } from "@phosphor-icons/react/UserFocus";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { Warning } from "@phosphor-icons/react/Warning";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { Waveform } from "@phosphor-icons/react/Waveform";
/* Phosphor 已把 X 更名为 XIcon，原 X 标记为 deprecated。 */
import { XIcon } from "@phosphor-icons/react/X";

/** 与 tokens.css 的 --icon-* 一一对应。 */
export type IconSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const SIZE_VAR: Record<IconSize, string> = {
  "2xs": "var(--icon-2xs)",
  xs: "var(--icon-xs)",
  sm: "var(--icon-sm)",
  md: "var(--icon-md)",
  lg: "var(--icon-lg)",
  xl: "var(--icon-xl)",
  "2xl": "var(--icon-2xl)",
  "3xl": "var(--icon-3xl)",
};

/*
 * 图标名 -> 组件。这是产品图标的唯一清单。
 * 名字沿用 Phosphor 的短横线短名（caret-down 而不是 CaretDown），
 * 与 Iconify 的命名习惯一致；将来若要整体替换图标集，只需替换这个映射。
 */
const GLYPHS = {
  "arrow-clockwise": ArrowClockwise,
  "arrow-counter-clockwise": ArrowCounterClockwise,
  "arrow-down": ArrowDown,
  "arrow-square-out": ArrowSquareOut,
  "arrow-up": ArrowUp,
  "arrows-clockwise": ArrowsClockwise,
  at: At,
  "book-open-text": BookOpenText,
  "caret-down": CaretDown,
  "caret-left": CaretLeft,
  "caret-right": CaretRight,
  check: Check,
  "check-circle": CheckCircle,
  "circle-notch": CircleNotch,
  clock: Clock,
  "cloud-arrow-down": CloudArrowDown,
  "cloud-arrow-up": CloudArrowUp,
  copy: Copy,
  "copy-simple": CopySimple,
  "corners-out": CornersOut,
  "crosshair-simple": CrosshairSimple,
  "download-simple": DownloadSimple,
  "file-text": FileText,
  "film-slate": FilmSlate,
  "film-strip": FilmStrip,
  "floppy-disk": FloppyDisk,
  "folder-open": FolderOpen,
  "folder-simple-plus": FolderSimplePlus,
  "gear-six": GearSix,
  globe: Globe,
  "identification-badge": IdentificationBadge,
  image: Image,
  "image-square": ImageSquare,
  images: Images,
  key: Key,
  "link-simple": LinkSimple,
  "magic-wand": MagicWand,
  "magnifying-glass": MagnifyingGlass,
  minus: Minus,
  "music-notes": MusicNotes,
  "paper-plane-right": PaperPlaneRight,
  paperclip: Paperclip,
  pause: Pause,
  "pencil-simple": PencilSimple,
  play: Play,
  plus: Plus,
  rectangle: Rectangle,
  sparkle: Sparkle,
  "stack-simple": StackSimple,
  "text-aa": TextAa,
  "text-t": TextT,
  trash: Trash,
  "trash-simple": TrashSimple,
  "upload-simple": UploadSimple,
  "user-focus": UserFocus,
  "video-camera": VideoCamera,
  warning: Warning,
  "warning-circle": WarningCircle,
  waveform: Waveform,
  x: XIcon,
} as const;

/** 产品中可用的图标名。 */
export type IconName = keyof typeof GLYPHS;

/*
 * 字重按渲染尺寸选择。
 *
 * Phosphor 的图标画在 256 单位画布上：regular 笔画约 16 单位（渲染为尺寸的
 * 6.25%），bold 约 24 单位（9.4%）。同一个 bold 图标在 14px 时笔画约 1.3px、
 * 在 48px 时约 4.5px，相对粗细完全不同；反过来 regular 在 10px 下笔画不足
 * 1px，会发灰发虚。
 *
 * 因此：行内尺寸用 regular 保持字腔通透，展示级尺寸用 bold 保持分量。
 * 阈值取 24px —— 本产品里「行内图标」与「展示级图标」的分界。
 * 需要覆盖时显式传 weight，但请先确认确有理由：335 个调用点各自决定字重
 * 正是上一版的失败原因。
 */
function opticalWeight(size: IconSize): IconWeight {
  return size === "2xl" || size === "3xl" ? "bold" : "regular";
}

export interface IconProps {
  /** 图标名，取自 GLYPHS。 */
  readonly name: IconName;
  /** 尺寸档位，取自 tokens.css 的 --icon-*。默认 md（16px）。 */
  readonly size?: IconSize;
  /** 覆盖自动字重。默认不需要，也不建议传。 */
  readonly weight?: IconWeight;
  /**
   * 装饰性图标保持默认（不传即为 true）；仅当图标是唯一语义载体时
   * 显式传 `aria-hidden={false}`。
   *
   * 也接受 JSX 里常见的字符串写法 `aria-hidden="true"`，组件内部会归一化，
   * 不会把 `aria-hidden="false"` 原样写进 SVG（那反而会把它从无障碍树里摘掉）。
   */
  readonly "aria-hidden"?: boolean | "true" | "false";
  readonly className?: string;
  readonly style?: CSSProperties;
  /** 显式携带 `undefined` 以兼容 exactOptionalPropertyTypes 下的条件传值。 */
  readonly "data-spin"?: string | undefined;
}

/**
 * 图标组件。
 *
 * ref 指向内部真实的 svg 元素，因此既有的 `svg[data-spin="true"]` 与
 * `.parent > svg` 这类 CSS 选择器继续有效。
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = "md", weight, "aria-hidden": ariaHidden = true, style, ...rest },
  ref,
) {
  /* 归一化：字符串 "false" 必须变成布尔 false，否则 aria-hidden="false"
     会被无障碍树当成「隐藏」。 */
  const hidden = ariaHidden !== false && ariaHidden !== "false";

  return createElement(GLYPHS[name], {
    ...rest,
    ref,
    /*
     * 尺寸走 SVG 的 width/height 属性而不是内联 style：
     * 两者都能解析 var()，但属性形式在服务端渲染、快照与测试环境里都稳定可见，
     * 不会因为 CSSOM 不解析自定义属性而丢掉尺寸。
     */
    width: SIZE_VAR[size],
    height: SIZE_VAR[size],
    weight: weight ?? opticalWeight(size),
    "aria-hidden": hidden,
    focusable: false,
    style: { display: "block", flex: "0 0 auto", ...style },
  });
});

/** 图标名是否有效；用于由数据驱动的图标字段。 */
export function isIconName(value: string): value is IconName {
  return Object.hasOwn(GLYPHS, value);
}
