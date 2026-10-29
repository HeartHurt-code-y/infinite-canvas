/*
 * Agent 模式的底部浮坞。
 *
 * 实测（2026-10-22，即梦 `?type=agentic`）：
 *
 *   dimension-layout（sticky 卡片）
 *   ├─ content（flex row，gap 12）
 *   │  ├─ references（宽 64）
 *   │  │  └─ reference-upload  48×64 的上传砖，**逆时针 -8°**，
 *   │  │     底 rgba(255,255,255,.08)、圆角 2px、
 *   │  │     虚线描边 0.67px rgba(255,255,255,.04)；悬停放大到 56×70
 *   │  └─ prompt-editor（548.667×76，overflow hidden）
 *   │     └─ ProseMirror：字 14/24 白字，占位 rgba(255,255,255,.35)
 *   │        占位文案里嵌着两枚可点的行内芯片：「/」与「@」
 *   └─ toolbar（高 32，gap 12）
 *      ├─ settings：创作类型 ▾ | 自动 | 技能 ▾ | @
 *      ├─ voice-input（32×32 圆形）
 *      └─ submit（32×32 圆形）
 *
 * 与普通创作页浮坞的差别（这才是「Agent 模式」的全部增量）：
 *   - 创作类型从 4 项扩到 7 项；
 *   - 「自动」不再是模型下拉，而是一块**生成偏好面板**；
 *   - 「技能」是一份带搜索的富列表；
 *   - 「@」是主体选择器；
 *   - 多了一枚语音输入按钮；
 *   - 占位文案里带 `/` 与 `@` 两枚芯片，且提示词支持 20000 字。
 */
import { useCallback, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Icon } from "../../components/Icon";
import { JimengIcon } from "./JimengIcon";
import { ImeTextarea } from "../../components/ImeTextField";
import { toast } from "../../lib/toast";
import { CreateAgentPreferences } from "./CreateAgentPreferences";
import { CreateAgentSkillSelect } from "./CreateAgentSkillSelect";
import { CreateModeIcon } from "./createModeIcons";
import { CreateSelect } from "./CreateSelect";
import { CreateSubjectPicker } from "./CreateSubjectPicker";
import {
  AGENT_COPY,
  AGENT_CREATION_MODES,
  AGENT_PROMPT_MAX_LENGTH,
  agentModePendingBadge,
  agentModePendingNote,
  agentModePendingNotice,
  type AgentCreationModeId,
  type AgentPreferences,
  type AgentSkill,
  type AgentSubject,
} from "./createAgentModel";
import { useControllableOpen } from "./useControllableOpen";
import { useCreateAssetDrag } from "./createAssetDrag";
import type { CreateModelOption, CreateReference } from "./useCreateSession";

/**
 * 「创作类型」下拉的浮层宽度。
 *
 * 即梦实测这一档浮层是 **200 宽**（`.lv-select-popup{width:200px}` 是全局默认，
 * 且创作类型下拉 `autoAlignPopupWidth:false` → 不跟随触发器宽）。
 * 本项目沿用 200：下拉里那一项的第二行只放通用标记「后端暂未接入」，
 * 具体退路放 tooltip 与点击后的提示，所以 200 宽放得下。
 */
const CREATION_TYPE_POPOVER_WIDTH = 200;

export interface CreateAgentComposerProps {
  readonly prompt: string;
  readonly onPromptChange: (value: string) => void;
  readonly references: readonly CreateReference[];
  readonly onReferencesChange: (references: readonly CreateReference[]) => void;
  /** 打开资产库抽屉挑参考素材。 */
  readonly onOpenAssetLibrary: () => void;

  readonly mode: AgentCreationModeId;
  readonly onModeChange: (mode: AgentCreationModeId) => void;

  readonly skill: AgentSkill | null;
  readonly onSkillChange: (skill: AgentSkill | null) => void;
  readonly skills: readonly AgentSkill[];
  readonly onOpenSkillLibrary: () => void;

  readonly subjects: readonly AgentSubject[];
  readonly selectedSubjects: readonly AgentSubject[];
  readonly onSubjectsChange: (subjects: readonly AgentSubject[]) => void;
  readonly onCreateSubject: () => void;

  readonly preferences: AgentPreferences;
  readonly onPreferencesChange: (preferences: AgentPreferences) => void;
  readonly models: readonly CreateModelOption[];
  readonly onModelChange: (model: CreateModelOption) => void;

  readonly canSubmit: boolean;
  readonly submitting: boolean;
  readonly disabledHint: string | null;
  /**
   * 提交失败的报错 id（页面上的 ErrorAlert）。
   *
   * 提交键用它做 `aria-describedby`：键盘用户走到提交键就知道刚才为什么失败。
   */
  readonly submitErrorId?: string | undefined;
  readonly onSubmit: () => void;
}

/** 参考素材的缩略图地址。 */
function referenceSrc(reference: CreateReference): string | null {
  if (reference.previewUrl) return reference.previewUrl;
  if (reference.kind === "local_file" && reference.path) return convertFileSrc(reference.path);
  return null;
}

export function CreateAgentComposer({
  prompt,
  onPromptChange,
  references,
  onReferencesChange,
  onOpenAssetLibrary,
  mode,
  onModeChange,
  skill,
  onSkillChange,
  skills,
  onOpenSkillLibrary,
  subjects,
  selectedSubjects,
  onSubjectsChange,
  onCreateSubject,
  preferences,
  onPreferencesChange,
  models,
  onModelChange,
  canSubmit,
  submitting,
  disabledHint,
  submitErrorId,
  onSubmit,
}: CreateAgentComposerProps) {
  /*
   * `/` 与 `@` 的触发。
   *
   * 实测：即梦在提示词里打 `/` 会弹出技能列表，打 `@` 会弹出主体列表——
   * 这两枚字符既是快捷键也是占位文案里的芯片。这里按「光标前一个字符」判定，
   * 选中后把触发字符从提示词里去掉，避免留下一个孤零零的斜杠。
   */
  const skillPicker = useControllableOpen();
  const subjectPicker = useControllableOpen();
  const { open: skillOpen, setOpen: setSkillOpen } = skillPicker;
  const { open: subjectOpen, setOpen: setSubjectOpen } = subjectPicker;

  const triggerRefs = useRef<{ kind: "skill" | "subject"; at: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /* 素材从资产库抽屉拖进来时的落点状态（见 createAssetDrag.ts）。 */
  const dropActive = useCreateAssetDrag().overTarget;

  const modeOptions = useMemo(
    () =>
      AGENT_CREATION_MODES.map((item) => {
        /*
         * 后端没接入的类型照常列出来，但要把「为什么不通」摆出来。
         *
         * 摆法照即梦的机制来：即梦给不可用的项挂一枚角标 + tooltip
         * （源码 `extra.tooltipProps.content`，zh-Hans 实际值
         * 「此功能在您所在的地区不可用」）。本项目对应地：
         *   · 名称右侧一枚「后端暂未接入」角标——**同一行**，不占额外高度，
         *     所以选项仍是即梦那套 36px、浮层仍是 200×317；
         *   · 具体退路放 tooltip 与点击后的提示里。
         */
        const badge = agentModePendingBadge(item.id);
        const note = agentModePendingNote(item.id);
        return {
          value: item.id,
          label: item.label,
          icon: <CreateModeIcon mode={item.icon} className="create-select__mode-icon" />,
          ...(badge === null ? {} : { badge }),
          ...(note === null ? {} : { title: note }),
        };
      }),
    [],
  );

  /**
   * 选了创作类型。
   *
   * 点了后端没接入的类型时先说清楚会发生什么（退到哪条能力上提交），
   * 再切浮坞——不静默失败是 AGENTS.md 的硬要求。
   */
  const onModePicked = useCallback(
    (next: AgentCreationModeId) => {
      const notice = agentModePendingNotice(next);
      if (notice !== null) toast(notice);
      onModeChange(next);
    },
    [onModeChange],
  );

  const onInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      const element = event.currentTarget;
      const caret = element.selectionStart ?? element.value.length;
      const before = element.value.slice(0, caret);
      const last = before.slice(-1);
      if (last !== "/" && last !== "@") {
        triggerRefs.current = null;
        return;
      }
      // 前面紧挨着别的词时不触发：只有「行首或空白之后」的斜杠才是命令。
      const previous = before.slice(-2, -1);
      if (previous !== "" && !/\s/.test(previous)) return;
      triggerRefs.current = { kind: last === "/" ? "skill" : "subject", at: caret - 1 };
      if (last === "/") setSkillOpen(true);
      else setSubjectOpen(true);
    },
    [setSkillOpen, setSubjectOpen],
  );

  /**
   * 选中后把触发字符（`/` 或 `@`）从提示词里抹掉。
   *
   * 只在那一格**仍然是触发字符**时才删：用户可能已经继续输入别的字，
   * 那时把别的字删掉就是数据丢失，宁可留着那个斜杠。
   */
  const consumeTrigger = useCallback(
    (kind: "skill" | "subject") => {
      const trigger = triggerRefs.current;
      if (trigger == null || trigger.kind !== kind) return;
      triggerRefs.current = null;
      const char = kind === "skill" ? "/" : "@";
      if (prompt[trigger.at] !== char) return;
      const next = prompt.slice(0, trigger.at) + prompt.slice(trigger.at + 1);
      onPromptChange(next);
      const element = textareaRef.current;
      if (element) {
        const caret = Math.max(0, trigger.at);
        requestAnimationFrame(() => {
          element.focus();
          element.setSelectionRange(caret, caret);
        });
      }
    },
    [onPromptChange, prompt],
  );

  const onSkillPicked = useCallback(
    (picked: AgentSkill | null) => {
      consumeTrigger("skill");
      onSkillChange(picked);
    },
    [consumeTrigger, onSkillChange],
  );

  const onSubjectPicked = useCallback(
    (picked: readonly AgentSubject[]) => {
      consumeTrigger("subject");
      onSubjectsChange(picked);
    },
    [consumeTrigger, onSubjectsChange],
  );

  const onVoice = useCallback(() => {
    toast(AGENT_COPY.voiceUnavailable);
  }, []);

  return (
    <div className="create-agent-dock">
      <div
        className={`create-agent-dock__surface${dropActive ? " is-drop-target" : ""}`}
        data-create-drop-zone="agent-dock"
      >
        {dropActive ? (
          <span className="create-agent-dock__drop-hint" aria-hidden="true">
            松开添加为参考素材
          </span>
        ) : null}
        <div className="create-agent-dock__content">
          <div className="create-agent-dock__references">
            {references.map((reference) => {
              const src = referenceSrc(reference);
              return (
                <div
                  key={`${reference.kind}-${reference.assetId ?? reference.path}`}
                  className="create-agent-reference"
                >
                  {src ? (
                    <img className="create-agent-reference__media" src={src} alt="" />
                  ) : (
                    <span
                      className="create-agent-reference__media create-agent-reference__media--empty"
                      aria-hidden="true"
                    >
                      <Icon name="image-square" size="xs" />
                    </span>
                  )}
                  <button
                    type="button"
                    className="create-agent-reference__remove"
                    aria-label={`移除参考 ${reference.name}`}
                    onClick={() =>
                      onReferencesChange(references.filter((item) => item !== reference))
                    }
                  >
                    <Icon name="x" size="2xs" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="create-agent-reference-upload"
              aria-label="上传参考"
              onClick={onOpenAssetLibrary}
            >
              <Icon name="plus" size="sm" aria-hidden="true" />
            </button>
          </div>

          <div className="create-agent-dock__prompt">
            {/*
              富占位符：即梦的占位文案里嵌着「/」与「@」两枚行内芯片，
              点它们分别打开技能与主体选择器。这里用覆盖层实现同一效果：
              输入框保持原生 textarea（中文输入法友好），占位文案单独一层。
            */}
            {prompt.length === 0 ? (
              <div className="create-agent-dock__placeholder">
                <span>{AGENT_COPY.promptPlaceholderLead} </span>
                <button
                  type="button"
                  className="create-agent-dock__chip"
                  aria-label="使用技能"
                  onClick={() => setSkillOpen(true)}
                >
                  /
                </button>
                <span> {AGENT_COPY.promptPlaceholderSlash}，</span>
                <button
                  type="button"
                  className="create-agent-dock__chip"
                  aria-label="在提示词里添加主体"
                  onClick={() => setSubjectOpen(true)}
                >
                  {/*
                   * 即梦这枚芯片里是 `@` 的图标（14×14，路径取自原站
                   * `.rich-placeholder-widget` 里的行内按钮），不是文字。
                   */}
                  <JimengIcon name="subject" size="0.875rem" />
                </button>
                <span> {AGENT_COPY.promptPlaceholderAt}</span>
                <span>{AGENT_COPY.promptPlaceholderTail}</span>
              </div>
            ) : null}
            <ImeTextarea
              ref={textareaRef}
              value={prompt}
              onValueChange={onPromptChange}
              onInput={onInput}
              placeholder=""
              rows={3}
              maxLength={AGENT_PROMPT_MAX_LENGTH}
              aria-label="提示词"
            />
            {selectedSubjects.length > 0 ? (
              <div className="create-agent-dock__subjects">
                {selectedSubjects.map((subject) => (
                  <button
                    key={subject.referenceId}
                    type="button"
                    className="create-agent-dock__subject"
                    aria-label={`移除主体 ${subject.name}`}
                    onClick={() =>
                      onSubjectsChange(
                        selectedSubjects.filter((item) => item.referenceId !== subject.referenceId),
                      )
                    }
                  >
                    @{subject.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="create-agent-dock__toolbar">
          <div className="create-agent-dock__settings">
            <CreateSelect
              primary
              title="创作类型"
              showCheck
              ariaLabel="创作类型"
              value={mode}
              options={modeOptions}
              /* 这是创作类型下拉，不是模型下拉：陈旧 id 时不能显示「默认模型」。 */
              fallbackLabel="创作类型"
              onChange={(id) => onModePicked(id as AgentCreationModeId)}
              icon={<CreateModeIcon mode={mode} className="create-select__mode-icon" />}
              popoverWidth={CREATION_TYPE_POPOVER_WIDTH}
            />
            <CreateAgentPreferences
              preferences={preferences}
              onChange={onPreferencesChange}
              models={models}
              onModelChange={onModelChange}
            />
            <CreateAgentSkillSelect
              skills={skills}
              value={skill}
              onChange={onSkillPicked}
              onOpenLibrary={onOpenSkillLibrary}
              open={skillOpen}
              onOpenChange={setSkillOpen}
            />
            <CreateSubjectPicker
              subjects={subjects}
              selected={selectedSubjects}
              onChange={onSubjectPicked}
              onCreateSubject={onCreateSubject}
              open={subjectOpen}
              onOpenChange={setSubjectOpen}
            />
            {/*
             * 提示文字放在左半区的末尾（而不是语音与提交之间）。
             *
             * 即梦的工具条是 `justify-content: space-between`：左半区吸掉剩余
             * 宽度，语音与提交相邻贴住浮坞右缘。提示夹在中间会把语音和提交
             * 撑开，右边留一大片空白。
             */}
            {disabledHint ? (
              <span className="create-hint" role="status">
                {disabledHint}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            className="create-agent-voice"
            aria-label={AGENT_COPY.voiceIdle}
            onClick={onVoice}
          >
            <JimengIcon name="voice" />
          </button>

          <div className="create-agent-dock__actions">
            <button
              type="button"
              className="create-agent-submit"
              disabled={!canSubmit || submitting}
              aria-label={submitting ? "生成中" : "生成"}
              aria-describedby={submitErrorId}
              onClick={onSubmit}
            >
              {submitting ? (
                <Icon name="circle-notch" size="sm" data-spin="true" aria-hidden="true" />
              ) : (
                <JimengIcon name="submit" size="1.25rem" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
