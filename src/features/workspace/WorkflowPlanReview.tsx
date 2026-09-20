import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";
import { toMediaSrc } from "../../lib/backend";
import {
  getWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
  topologicallySortWorkflowSteps,
} from "./workflowExecutionPlan";
import "./WorkflowPlanReview.css";

export function WorkflowPlanReview({
  node,
  disabled,
  onApprove,
}: {
  readonly node: KnowledgeVideoWorkflowNodeData;
  readonly disabled: boolean;
  readonly onApprove: () => void;
}) {
  const plan = getWorkflowExecutionPlan(node);
  if (!plan) return null;
  const approved = isWorkflowExecutionPlanApproved(plan, node);
  let error: string | null = null;
  let steps = plan.steps;
  try {
    steps = topologicallySortWorkflowSteps(plan.steps);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "计划依赖关系无效";
  }
  const titles = new Map(steps.map((step) => [step.id, step.title]));
  return (
    <section className="workflow-plan-review" aria-label="执行计划审核">
      <header>
        <strong>{plan.scope === "delivery" ? "制作交付计划" : "多步执行计划"}</strong>
        <span>
          版本 {plan.revision} · {approved ? "已确认" : "等待你确认"}
        </span>
      </header>
      <p>以下步骤按依赖顺序执行。修改输入、分镜或恢复历史版本后，需要重新确认。</p>
      {plan.review ? (
        <div className="workflow-plan-review__media">
          <strong>
            {
              {
                assets: "检查角色与场景资产",
                first_shot: "检查首镜试产",
                composition: "检查全部片段，确认后合成",
                final: "检查最终成片",
              }[plan.review.kind]
            }
          </strong>
          {plan.review.paths.map((path, index) =>
            plan.review?.kind === "assets" ? (
              <img
                key={path}
                src={toMediaSrc(path)}
                alt={`待审核资产 ${index + 1}`}
                loading="lazy"
              />
            ) : (
              <video
                key={path}
                src={toMediaSrc(path)}
                controls
                preload="metadata"
                aria-label={`待审核视频 ${index + 1}`}
              />
            ),
          )}
        </div>
      ) : null}
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <strong>{step.title}</strong>
            <span>
              {step.dependsOn.length
                ? `依赖：${step.dependsOn.map((id) => titles.get(id) ?? id).join("、")}`
                : "可首先执行"}
            </span>
          </li>
        ))}
      </ol>
      {error ? <p role="alert">{error}</p> : null}
      {!approved ? (
        <button
          type="button"
          className="canvas-knowledge-workflow__primary"
          disabled={disabled || !!error}
          onClick={onApprove}
        >
          确认计划并执行
        </button>
      ) : null}
    </section>
  );
}
