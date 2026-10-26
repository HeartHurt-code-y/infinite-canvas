/*
 * 即梦原生图标的渲染器。
 *
 * 路径数据在 `jimengIcons.ts`（从原站活体 DOM 抽取的原文）。
 * 这里只负责把它渲染成 svg：尺寸走 `1em`（跟原站一致，颜色继承 `currentColor`）。
 */
import { JIMENG_ICONS, type JimengIconName } from "./jimengIcons";

export type { JimengIconName };

export interface JimengIconProps {
  readonly name: JimengIconName;
  /** 覆盖默认的 `1em` 尺寸。 */
  readonly size?: string;
  readonly className?: string;
  readonly title?: string;
}

export function JimengIcon({ name, size, className, title }: JimengIconProps): React.ReactElement {
  const icon = JIMENG_ICONS[name];
  return (
    <svg
      className={className}
      viewBox={icon.vb}
      width={size ?? "1em"}
      height={size ?? "1em"}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title === undefined ? "presentation" : "img"}
      aria-hidden={title === undefined ? "true" : undefined}
      aria-label={title}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: icon.raw }}
    />
  );
}
