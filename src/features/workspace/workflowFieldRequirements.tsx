/*
 * 工作流参数必填标识与缺口提示的唯一来源。
 *
 * 为什么需要这一层
 * ----------------
 * 「必填」此前只存在于各个运行器的 `*InputReady()` 布尔判断里：界面能拦下
 * 提交，但说不出**缺的是哪一项**。于是同一个产品里出现三种说法 —— 有的写
 * 「（必填）」、有的写「（可选）」、多数什么都不写；小白用户看到「查看执行
 * 计划」灰掉却不知道还差什么，只能逐项乱试。
 *
 * 这一层把「必填」变成可渲染的数据：
 *
 *   - 每个工作流模型导出 `*Requirements(...)`，返回**尚缺**的必填项
 *     （`field` = 界面上的字段名，`hint` = 一句给用户看的补法）。
 *   - 运行器的 `*InputReady()` 一律由同一份需求清单推导，界面与拦截不再
 *     可能各说一套。
 *   - 字段标签统一用 `<RequiredMark />` / `<OptionalMark />`：必填项旁一个红色
 *     星号，选填项不渲染标记 —— 界面不再出现手写的中文括号字样，也不为每个
 *     选填项重复一句「可选」（那会把卡片撑得很长）。
 *
 * 边界原则（对小白用户）
 * ----------------------
 * 只有**缺了就一定做不出结果、而且无法合理推断**的输入才算必填：素材
 * （图片/原片/歌曲）、内容要求。风格、画幅、时长、交付方式等一律预置默认值
 * 并保持选填，由工作流自动决定。
 *
 * 适用范围
 * --------
 * 只标注**工作流节点的参数**。图片/视频生成节点里的「供应商 / 模型」同样是必填，
 * 但它们的 label 文本直接充当输入控件的可访问名（全仓约 140 处
 * `getByLabelText("供应商")` 依赖它），改动收益不抵回归风险，暂不介入。
 */
import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";

/* eslint-disable react-refresh/only-export-components --
 * 本模块刻意把「类型 + 需求清单判定 + 标识组件 + 缺口清单」放在一个文件里：
 * 这三者互为同一条契约（模型层产出 WorkflowRequirements，界面层渲染它），
 * 拆开就会多出一个只有三行的类型文件，调用点也要多一条 import。fast refresh
 * 的损失仅限于本文件自身的编辑体验，与 Icon.tsx 的取舍一致。 */

/** 一个尚未满足的必填项。`field` 与界面上的字段名同名，方便对照。 */
export interface WorkflowRequirement {
  readonly field: string;
  readonly hint: string;
}

export type WorkflowRequirements = readonly WorkflowRequirement[];

/**
 * 「这一项必填」：标签文字旁的红色星号，**仅此而已**。
 *
 * 不加「（必填）」文字是刻意的：标签容器多为 `display: grid` 或带 `gap` 的 flex，
 * 多出来的文字会各占一行/一格，把工作流卡片撑得很长。星号是通用约定，配上节点
 * 底部的缺口清单已经足够；屏幕阅读器侧的必填语义由 RequiredMark 给控件挂上的
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
      <span className="workflow-required-mark__asterisk" aria-hidden="true">
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
 * 全部必填项都已就绪。运行器判定 `*InputReady()` 时统一走这里，避免「界面
 * 显示齐全、点下去仍然报『设置无效』」这类错位。
 */
export function requirementsMet(requirements: WorkflowRequirements): boolean {
  return requirements.length === 0;
}

/** 把缺失项拼成一句可访问的短句，用作按钮 title 或提示。 */
export function workflowRequirementsSummary(requirements: WorkflowRequirements): string {
  if (requirements.length === 0) return "";
  return `还差 ${requirements.length} 项必填内容：${requirements
    .map((requirement) => requirement.field)
    .join("、")}`;
}

/**
 * 缺口清单：一次列全部必填项，而不是只报第一项。
 * 小白用户看一眼就知道还差什么，不用来回试错。
 *
 * 刻意只保留「标题 + 逐项补法」两段：这张卡片挂在节点底部，每多一行都会把整张
 * 卡片（以及它下面的按钮）往下推，因此不再追加「其余参数已按推荐值预置」之类的
 * 收尾说明——那属于产品说明，不属于当下的行动指引。
 */
export function WorkflowRequirementsHint({
  requirements,
}: {
  readonly requirements: WorkflowRequirements;
}) {
  if (requirements.length === 0) return null;
  return (
    <div className="workflow-required-hint" role="status">
      <strong className="workflow-required-hint__title">
        <Icon name="warning-circle" aria-hidden="true" size="sm" />
        还差 {requirements.length} 项必填内容
      </strong>
      <ul className="workflow-required-hint__list">
        {requirements.map((requirement) => (
          <li key={requirement.field}>
            <span className="workflow-required-hint__field">{requirement.field}</span>
            <span className="workflow-required-hint__text">{requirement.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
