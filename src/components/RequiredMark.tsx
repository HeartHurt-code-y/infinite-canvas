import type { ReactNode } from "react";

import { Icon } from "./Icon";

/** 一个尚未满足的必填项。`field` 与界面上的字段名同名，方便对照。 */
export interface Requirement {
  readonly field: string;
  readonly hint: string;
}

export type Requirements = readonly Requirement[];

/**
 * 「这一项必填」：标签文字旁的红色星号，**仅此而已**。
 *
 * 不加「（必填）」文字是刻意的：标签容器多为 `display: grid` 或带 `gap` 的 flex，
 * 多出来的文字会各占一行/一格，把卡片撑得很长。星号是通用约定，配上字段下方的
 * 缺口清单已经足够；屏幕阅读器侧的必填语义由 RequiredMark 给控件挂上的
 * `aria-required` 承担。
 *
 * 结构上 `{children}` 必须与星号是同级兄弟，且星号必须是**单个 span**：
 *   - 包一层 wrapper 会让 `.xxx__field > span` 这类标签排版结构选择器失配；
 *   - 在 `display: grid` 的标签容器里，多个子元素会各占一个网格行，星号会被挤到
 *     单独一行（这正是之前把卡片撑长的原因）。
 */
export function RequiredMark({ children }: { readonly children?: ReactNode }) {
  const attachRequired = useMarkControl();
  return (
    <span ref={attachRequired}>
      {children}
      <span className="required-mark__asterisk" aria-hidden="true">
        *
      </span>
    </span>
  );
}

/**
 * 「这一项选填」。**不渲染任何标记**。
 *
 * 界面只区分「有红星」与「没有红星」：每个选填项都写一句「可选」，会把卡片撑得
 * 很长而信息量几乎为零。保留这个组件是为了让调用点仍然显式声明字段的必填性质
 * （读代码时看得出这一项是选填），从而不必在两层之间来回对照。
 */
export function OptionalMark({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * 把「必填」挂到标记所在标签真正关联的控件上。
 *
 * 这里刻意读 DOM 而不是给每个调用点加 prop：标记本身拿不到控件引用，而为几十处
 * 调用点各传一次 `required` 只会制造新的漏改点。`label.control` 是浏览器已经算好
 * 的控件归属（包裹式 label 与 `htmlFor` 两种写法都覆盖）。
 */
function useMarkControl() {
  return (element: HTMLSpanElement | null) => {
    if (element == null) return;
    const control = element.closest("label")?.control;
    if (control != null && !control.hasAttribute("aria-required")) {
      control.setAttribute("aria-required", "true");
    }
  };
}

/**
 * 缺口清单：一次列全部必填项，而不是只报第一项。
 * 小白用户看一眼就知道还差什么，不用来回试错。
 *
 * 刻意只保留「标题 + 逐项补法」两段：这张卡片挂在节点底部，每多一行都会把整张
 * 卡片（以及它下面的按钮）往下推，因此不再追加「其余参数已按推荐值预置」之类的
 * 收尾说明——那属于产品说明，不属于当下的行动指引。
 */
export function RequirementsHint({ requirements }: { readonly requirements: Requirements }) {
  if (requirements.length === 0) return null;
  return (
    <div className="requirements-hint" role="status">
      <strong className="requirements-hint__title">
        <Icon name="warning-circle" aria-hidden="true" size="sm" />
        还差 {requirements.length} 项必填内容
      </strong>
      <ul className="requirements-hint__list">
        {requirements.map((requirement) => (
          <li key={requirement.field}>
            <span className="requirements-hint__field">{requirement.field}</span>
            <span className="requirements-hint__text">{requirement.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
