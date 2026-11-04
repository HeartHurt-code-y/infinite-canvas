/*
 * Agent 模式的「技能」下拉。
 *
 * 实测（2026-10-22，即梦 `?type=agentic`）：
 *   - 触发器 60×32、内边距 0 8px、圆角 8、字 12/20 字重 450，**没有箭头**；
 *   - 浮层 365×432（内容 360），圆角 12，底 #262626，
 *     描边 0.67px rgba(204,221,255,.08)，投影 rgba(0,0,0,.24) 0 8px 56px；
 *   - 浮层内从上到下：搜索行（高 36，内边距 0 12px，gap 4）+「更多技能」按钮
 *     → 1px 分隔线 → 技能列表（最大高 314）；
 *   - 每一项高 52、内边距 5px 12px、圆角 8：16px 图标 + 名称（13/22）
 *     +「官方」角标（26×16、圆角 4、底 rgba(255,255,255,.08)、字 9/12），
 *     下一行是简介（12/20、色 rgba(255,255,255,.35)、左缩进 24）。
 *
 * 为什么不用 `CreateSelect`：普通下拉的选项是「一行文字 + 一行说明」，
 * 而技能项是「图标 + 名称 + 角标 + 两行说明」，还要在顶部带搜索框。
 * 两套结构的行高、内边距与信息密度都不同，合并会让普通下拉变胖。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { JimengIcon } from "./JimengIcon";
import {
  AGENT_COPY,
  AGENT_POPUP_WIDTH_TOKENS,
  filterAgentSkills,
  readCreateSizeTokenPx,
  type AgentSkill,
} from "./createAgentModel";
import { useControllableOpen } from "./useControllableOpen";
import { useDismissOnOutside, useCreateFloatingLayerAnchor } from "./useFloatingLayerAnchor";

export interface CreateAgentSkillSelectProps {
  readonly skills: readonly AgentSkill[];
  readonly value: AgentSkill | null;
  readonly onChange: (skill: AgentSkill | null) => void;
  /** 「更多技能」：打开技能库。 */
  readonly onOpenLibrary: () => void;
  readonly disabled?: boolean;
  /** 受控开合：提示词里打 `/` 时由外面打开。 */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function CreateAgentSkillSelect({
  skills,
  value,
  onChange,
  onOpenLibrary,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: CreateAgentSkillSelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const { open, setOpen } = useControllableOpen({
    open: controlledOpen,
    onOpenChange,
  });

  const visible = useMemo(() => filterAgentSkills(skills, query), [query, skills]);

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      setQuery("");
      if (refocus) triggerRef.current?.focus();
    },
    [setOpen],
  );

  /*
   * 即梦的技能浮层实测 365 宽（内容 360）。宽度取自 tokens.css 的
   * `--size-create-agentic-popup-skill`：浮层定位要拿这个数算左边缘，
   * 所以在运行时把令牌读成 px，而不是在代码里写死 365。
   */
  const popupWidth = useMemo(() => readCreateSizeTokenPx(AGENT_POPUP_WIDTH_TOKENS.skill, 365), []);
  const { ref: popoverRef, layerId } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: triggerRef,
    minWidth: popupWidth,
    maxHeight: 432,
  });
  useDismissOnOutside(open, popoverRef, triggerRef, () => setOpen(false), layerId);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  /*
   * Esc 关闭技能浮层：交给全应用唯一的仲裁器（`escapeArbiter`）。
   *
   * 内层浮层先认领的 Escape 不再动作（仲裁器统一判断 `defaultPrevented`），
   * 一次按键只关一层。
   */
  useEscapeHandler(
    {
      canHandle: () => open,
      handle: () => close(),
    },
    open,
  );

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="create-agent-skill-trigger"
        aria-label="技能"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <JimengIcon name="skill" className="create-agent-skill-trigger__icon" />
        <span className="create-agent-skill-trigger__label">技能</span>
      </button>

      {open
        ? createPortal(
            <div
              ref={popoverRef}
              id={listId}
              role="listbox"
              aria-label="技能"
              className="create-agent-skill-popup"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              }}
            >
              <div className="create-agent-skill-popup__search">
                <label className="create-agent-skill-popup__search-field">
                  <Icon
                    name="magnifying-glass"
                    size="xs"
                    className="create-agent-skill-popup__search-icon"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    name="create-skill-search"
                    value={query}
                    placeholder={AGENT_COPY.skillSearchPlaceholder}
                    aria-label={AGENT_COPY.skillSearchPlaceholder}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="create-agent-skill-popup__library"
                  onClick={() => {
                    close(false);
                    onOpenLibrary();
                  }}
                >
                  {AGENT_COPY.skillLibraryLabel}
                </button>
              </div>

              <div className="create-agent-skill-popup__divider" role="presentation" />

              <div className="create-agent-skill-popup__list">
                {visible.length === 0 ? (
                  <p className="create-agent-skill-popup__empty">{AGENT_COPY.skillEmpty}</p>
                ) : (
                  visible.map((skill) => {
                    const selected = skill.id === value?.id;
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`create-agent-skill-option${selected ? " is-selected" : ""}`}
                        onClick={() => {
                          onChange(selected ? null : skill);
                          close();
                        }}
                      >
                        <span className="create-agent-skill-option__icon">
                          <JimengIcon name="skill" />
                        </span>
                        <span className="create-agent-skill-option__body">
                          <span className="create-agent-skill-option__head">
                            <span className="create-agent-skill-option__name">{skill.name}</span>
                            {skill.official ? (
                              <span className="create-agent-skill-option__tag">官方</span>
                            ) : null}
                          </span>
                          <span className="create-agent-skill-option__description">
                            {skill.description}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
