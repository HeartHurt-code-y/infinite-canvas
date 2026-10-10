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
 *   - 字段标签统一用 `<RequiredMark />` / `<OptionalMark />`：必填画红色
 *     星号，选填写「（可选）」，不写就是选填 —— 不再出现手写的中文括号字样。
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
 * 「这一项必填」。渲染成红色星号 +「（必填）」。
 *
 * 结构：`{children}` 与标记是**同级兄弟**，`children` 若是纯文本就直接成为标签里的
 * 独立文本节点。这不是洁癖，而是三个约束同时成立的前提：
 *
 *   1. 不额外包一层元素，`.xxx__field > span`、`.canvas-knowledge-workflow__brief > span`
 *      这类标签排版的结构选择器就继续命中标签文字，字号字重不会掉回正文。
 *   2. 标记对辅助技术可见（**不**用 `aria-hidden` 藏起来）：可访问名与可见文本保持
 *      一致，屏幕阅读器同样能听到「必填」，DOM 查询也不会拿到两套事实。
 *   3. 星号单独成一个 span，才能只给星号上红色而不整体变色。星号本身是纯装饰、
 *      读出来反而像噪声，所以只有它自己带 `aria-hidden`，语义由「（必填）」承担。
 *
 * 代价是控件的可访问名会带上标记（「供应商*（必填）」）。这是显式取舍：与其让
 * 屏幕阅读器用户看不到必填信息，不如让名字长一点；查询侧用 /供应商/ 这类模式匹配。
 */
export function RequiredMark({ children }: { readonly children?: ReactNode }) {
  return (
    <>
      {children}
      <span className="workflow-required-mark__asterisk" aria-hidden="true">
        *
      </span>
      <span className="workflow-required-mark__required-text">（必填）</span>
    </>
  );
}

/** 「这一项选填，不填会自动处理」。用于已有默认值或可自动推断的参数。 */
export function OptionalMark({ children }: { readonly children?: ReactNode }) {
  return (
    <>
      {children}
      <span className="workflow-required-mark__optional">（可选）</span>
    </>
  );
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
      <small className="workflow-required-hint__foot">
        其余参数已按推荐值预置，可以不改直接开始。
      </small>
    </div>
  );
}
