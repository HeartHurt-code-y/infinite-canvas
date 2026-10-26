/*
 * Agent 模式的「@ 主体」选择器。
 *
 * 实测（2026-10-22）：工具条上那枚 32×32 的 `@` 按钮弹出一块 240×285 的浮层：
 *   - 圆角 12、底 #262626、描边 0.67px rgba(204,221,255,.08)、
 *     投影 rgba(0,0,0,.24) 0 8px 56px；
 *   - 顶部标题「可能@的内容」（12/12、色 rgba(255,255,255,.35)、
 *     内边距 12px 12px 8px）；
 *   - 主体列表；实测账号一个主体都没有，于是走空态：
 *     「你还没有创建过主体」+ 一枚「创建主体」按钮
 *     （105×36、圆角 8、底 rgba(255,255,255,.08)、字 13/20.43 字重 500）。
 *
 * 主体数据来自即梦的 `POST /mweb/v1/dreamina_subject/get`；本项目后端暂未接入
 * 主体体系（`TODO(agent-subjects)`），因此默认空列表，空态必须做完整——
 * 否则用户只会看到一块空白。
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { JimengIcon } from "./JimengIcon";
import {
  AGENT_COPY,
  AGENT_POPUP_WIDTH_TOKENS,
  readCreateSizeTokenPx,
  type AgentSubject,
} from "./createAgentModel";
import { useControllableOpen } from "./useControllableOpen";
import { useDismissOnOutside, useCreateFloatingLayerAnchor } from "./useFloatingLayerAnchor";

export interface CreateSubjectPickerProps {
  readonly subjects: readonly AgentSubject[];
  /** 已选中的主体（可多选）。 */
  readonly selected: readonly AgentSubject[];
  readonly onChange: (selected: readonly AgentSubject[]) => void;
  /** 「创建主体」：本项目暂无主体体系，给出说明而不是静默。 */
  readonly onCreateSubject: () => void;
  /** 受控开合：提示词里打 `@` 时由外面打开。 */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * 自定义触发器。
   *
   * 即梦**普通创作页**的那枚行内芯片（占位文案里的「主体」）点开的就是
   * 这块浮层——和工具条上那枚 `@` 按钮是同一个浮层、同一套形态。
   * 所以触发器要能换：由调用方给出（占位芯片），本组件只负责浮层。
   */
  readonly trigger?: ReactNode;
  /**
   * 锚点元素（自定义触发器时由调用方给出）。
   *
   * 浮层按它贴靠；不传就用内置的 `@` 按钮。
   */
  readonly anchorRef?: React.RefObject<HTMLElement | null>;
}

export function CreateSubjectPicker({
  subjects,
  selected,
  onChange,
  onCreateSubject,
  open: controlledOpen,
  onOpenChange,
  trigger,
  anchorRef,
}: CreateSubjectPickerProps) {
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const anchor = anchorRef ?? internalTriggerRef;
  const { open, setOpen } = useControllableOpen({
    open: controlledOpen,
    onOpenChange,
  });

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) anchor.current?.focus();
    },
    [anchor, setOpen],
  );

  /*
   * 即梦的主体浮层实测 240 宽。宽度取自 tokens.css 的
   * `--size-create-agentic-popup-subject`（浮层定位要用这个数算边缘）。
   */
  const popupWidth = useMemo(
    () => readCreateSizeTokenPx(AGENT_POPUP_WIDTH_TOKENS.subject, 240),
    [],
  );
  const { ref: popoverRef } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: anchor,
    minWidth: popupWidth,
    maxHeight: 320,
  });
  useDismissOnOutside(open, popoverRef, anchor, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close, open]);

  const toggle = (subject: AgentSubject) => {
    const exists = selected.some((item) => item.referenceId === subject.referenceId);
    onChange(
      exists
        ? selected.filter((item) => item.referenceId !== subject.referenceId)
        : [...selected, subject],
    );
  };

  return (
    <>
      {trigger !== undefined ? (
        trigger
      ) : (
        <button
          type="button"
          ref={internalTriggerRef}
          className="create-agent-subject-trigger"
          aria-label="添加主体"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (open) close();
            else setOpen(true);
          }}
        >
          <JimengIcon name="subject" />
        </button>
      )}

      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="listbox"
              aria-label={AGENT_COPY.subjectTitle}
              aria-multiselectable="true"
              className="create-agent-subject-popup"
            >
              <div className="create-agent-subject-popup__title">{AGENT_COPY.subjectTitle}</div>
              {subjects.length === 0 ? (
                <div className="create-agent-subject-popup__empty">
                  {/*
                    空态插画：即梦实测是一张 80×80 的插画（opacity .8）。
                    本仓库没有这套插画资源，先用一枚同尺寸的图标占位，
                    尺寸与透明度按实测值对齐。
                  */}
                  <span className="create-agent-subject-popup__empty-art" aria-hidden="true">
                    <Icon name="user-focus" size="3xl" />
                  </span>
                  <p className="create-agent-subject-popup__empty-text">
                    {AGENT_COPY.subjectEmpty}
                  </p>
                  <button
                    type="button"
                    className="create-agent-subject-popup__create"
                    onClick={() => {
                      close(false);
                      onCreateSubject();
                    }}
                  >
                    <Icon
                      name="plus"
                      size="xs"
                      className="create-agent-subject-popup__create-icon"
                      aria-hidden="true"
                    />
                    {AGENT_COPY.subjectCreate}
                  </button>
                </div>
              ) : (
                <div className="create-agent-subject-popup__list">
                  {subjects.map((subject) => {
                    const checked = selected.some(
                      (item) => item.referenceId === subject.referenceId,
                    );
                    return (
                      <button
                        key={subject.referenceId}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        className={`create-agent-subject-option${checked ? " is-selected" : ""}`}
                        onClick={() => toggle(subject)}
                      >
                        {subject.thumbnailUrl ? (
                          <img
                            className="create-agent-subject-option__thumb"
                            src={subject.thumbnailUrl}
                            alt=""
                          />
                        ) : (
                          <span className="create-agent-subject-option__thumb create-agent-subject-option__thumb--empty">
                            {subject.name.slice(0, 1)}
                          </span>
                        )}
                        <span className="create-agent-subject-option__name">{subject.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
