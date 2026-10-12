import { Icon } from "../../components/Icon";
import { memo, useEffect, useId, useRef } from "react";
import { WorkflowPreparation } from "./WorkflowGuidance";
import { WORKFLOW_GUIDES } from "./workflowGuidanceContent";
import { WORKFLOW_KINDS, type WorkflowKind } from "./workflowKinds";

export interface WorkflowRepositoryProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** 插入一个工作流类型；类型清单与卡片数据都来自 WORKFLOW_KINDS 注册表。 */
  readonly onInsert: (kind: WorkflowKind) => void;
}

export const WorkflowRepository = memo(function WorkflowRepository({
  expanded,
  onToggle,
  onInsert,
}: WorkflowRepositoryProps) {
  const contentId = useId();
  const toggleLabelId = useId();
  const repositoryRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const content = contentRef.current;
    const toggle = toggleRef.current;
    content
      ?.querySelector<HTMLButtonElement>(".workflow-repository__insert:not(:disabled)")
      ?.focus();
    return () => {
      if (content?.contains(document.activeElement)) toggle?.focus();
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      onToggle();
    };
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !repositoryRef.current?.contains(event.target)) {
        dismiss();
      }
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [expanded, onToggle]);

  return (
    <aside
      ref={repositoryRef}
      className={`workflow-repository${expanded ? " workflow-repository--expanded" : ""}`}
      aria-label="工作流仓库"
    >
      <button
        ref={toggleRef}
        type="button"
        className="workflow-repository__toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        <span className="workflow-repository__toggle-mark" aria-hidden="true">
          <Icon name="stack-simple" size="xl" />
        </span>
        <span className="workflow-repository__toggle-copy">
          <span id={toggleLabelId} className="workflow-repository__title">
            工作流仓库
          </span>
        </span>
        <Icon
          name="caret-right"
          className="workflow-repository__toggle-icon"
          aria-hidden="true"
          size="lg"
        />
      </button>

      <div
        ref={contentRef}
        id={contentId}
        className="workflow-repository__content"
        role="dialog"
        aria-labelledby={toggleLabelId}
        hidden={!expanded}
      >
        <div className="workflow-repository__content-heading">
          <span className="workflow-repository__count">
            {Object.keys(WORKFLOW_GUIDES).length} 个自动工作流
          </span>
          <button
            type="button"
            className="workflow-repository__close"
            aria-label="关闭工作流仓库"
            onClick={onToggle}
          >
            <Icon name="x" size="lg" aria-hidden="true" />
          </button>
        </div>
        {WORKFLOW_KINDS.map((entry) => {
          const card = entry.repository;
          return (
            <article className="workflow-repository__card" key={entry.id}>
              <div className="workflow-repository__card-mark" aria-hidden="true">
                <Icon name={card.icon} size="2xl" />
              </div>
              <div className="workflow-repository__card-body">
                <div className="workflow-repository__card-heading">
                  <span className="workflow-repository__badge">单节点</span>
                  <h2 className="workflow-repository__card-title">{card.title}</h2>
                </div>
                <p className="workflow-repository__description">{card.description}</p>
                <WorkflowPreparation kind={entry.id} />
                <ol className="workflow-repository__stages" aria-label={card.stagesAriaLabel}>
                  {card.stages.map((label, index) => (
                    <li key={label} className="workflow-repository__stage">
                      {card.numberedStages ? (
                        <span className="workflow-repository__stage-number" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                      ) : null}
                      <span className="workflow-repository__stage-name">{label}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <button
                type="button"
                className="workflow-repository__insert"
                onClick={() => onInsert(entry.id)}
                aria-label={card.insertAriaLabel}
              >
                <Icon name="plus" aria-hidden="true" size="lg" />
                {card.insertLabel}
              </button>
            </article>
          );
        })}
      </div>
    </aside>
  );
});
