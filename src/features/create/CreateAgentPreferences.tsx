/*
 * Agent 模式的「生成偏好」面板。
 *
 * 实测（2026-10-22）：点工具条上的「自动」按钮弹出的**不是**模型下拉，
 * 而是一块 486×303 的偏好面板：
 *   - 浮层 padding 16px、圆角 12、底 #262626、投影 rgba(0,0,0,.24) 0 8px 56px；
 *   - 内容区上下各留 24px，分区之间 gap 12px；
 *   - 分区一「生成偏好」：右侧一个「自动」开关（28×16，亮态 #009EFA，
 *     滑块 12×12 白），下面是「图片 / 视频」单选（每个 223×36）；
 *   - 分区二「选择比例」：智能 + 8 个固定比例的方卡（每个 48×60）；
 *   - 分区三「其他设置」：模型下拉（整行 453×36，底 rgba(255,255,255,.08)）。
 *
 * 「自动」打开时，产物类型与比例两组单选都是禁用态（实测类名带
 * `radio-group-disabled-*` / `aspect-ratio-radio-group-disabled-*`）——
 * 这两个值交给后端决定，前端不猜。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { JimengIcon } from "./JimengIcon";
import { CREATE_ASPECT_RATIOS } from "./createModel";
import {
  AGENT_COPY,
  AGENT_POPUP_WIDTH_TOKENS,
  readCreateSizeTokenPx,
  type AgentPreferences,
} from "./createAgentModel";
import { CreateModelSelect } from "./CreateModelSelect";
import { useControllableOpen } from "./useControllableOpen";
import { useDismissOnOutside, useCreateFloatingLayerAnchor } from "./useFloatingLayerAnchor";
import type { CreateModelOption } from "./useCreateSession";

export interface CreateAgentPreferencesProps {
  readonly preferences: AgentPreferences;
  readonly onChange: (preferences: AgentPreferences) => void;
  readonly models: readonly CreateModelOption[];
  readonly onModelChange: (model: CreateModelOption) => void;
}

export function CreateAgentPreferences({
  preferences,
  onChange,
  models,
  onModelChange,
}: CreateAgentPreferencesProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { open, setOpen } = useControllableOpen();

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) triggerRef.current?.focus();
    },
    [setOpen],
  );

  /*
   * 即梦的偏好面板宽 486（实测 `lv-popover-content` 486×303，padding 16、
   * 圆角 16、底 #262626）。面板顶边由实测高度推出，底边贴触发器顶边。
   * 宽度取自 tokens.css 的 `--size-create-agentic-popup-preferences`。
   *
   * 高度上限给到 420：本面板内容实测 389 高（三个分区 + 内边距），
   * 而面板是 `overflow: hidden`，上限 320 时最后一行被**直接切掉且滚不到**
   * （「其他设置」下面那句「未指定模型时按目录里的默认模型提交」正好被切）。
   * 上限取 420 让内容完整露出；视口不够时 `placeFloatingLayer` 仍会按
   * 可用空间收紧。
   */
  const popupWidth = useMemo(
    () => readCreateSizeTokenPx(AGENT_POPUP_WIDTH_TOKENS.preferences, 486),
    [],
  );
  const { ref: popoverRef } = useCreateFloatingLayerAnchor<HTMLDivElement>({
    open,
    anchorRef: triggerRef,
    minWidth: popupWidth,
    maxHeight: 420,
  });
  useDismissOnOutside(open, popoverRef, triggerRef, () => setOpen(false));

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

  const selectedModel = models.find(
    (model) => model.modelDefinitionId === preferences.modelDefinitionId,
  );

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="create-agent-preferences-trigger"
        aria-label="生成偏好"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <JimengIcon name="auto" className="create-agent-preferences-trigger__icon" />
        <span>{AGENT_COPY.preferencesAuto}</span>
      </button>

      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={AGENT_COPY.preferencesTitle}
              className="create-agent-preferences"
            >
              <div className="create-agent-preferences__fields">
                <section className="create-agent-preferences__field">
                  <header className="create-agent-preferences__title create-agent-preferences__title--primary">
                    {AGENT_COPY.preferencesTitle}
                  </header>
                  <div className="create-agent-preferences__auto">
                    <span className="create-agent-preferences__auto-label">
                      {AGENT_COPY.preferencesAuto}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={preferences.auto}
                      aria-label={AGENT_COPY.preferencesAuto}
                      className={`create-agent-switch${preferences.auto ? " is-on" : ""}`}
                      onClick={() => onChange({ ...preferences, auto: !preferences.auto })}
                    >
                      <span className="create-agent-switch__dot" />
                    </button>
                  </div>
                  <div
                    className={`create-agent-radios${preferences.auto ? " is-disabled" : ""}`}
                    role="radiogroup"
                    aria-label="产物类型"
                  >
                    {(
                      [
                        { id: "image", label: AGENT_COPY.outputImage },
                        { id: "video", label: AGENT_COPY.outputVideo },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={preferences.outputType === option.id}
                        disabled={preferences.auto}
                        className={`create-agent-radio${
                          preferences.outputType === option.id ? " is-checked" : ""
                        }`}
                        onClick={() => onChange({ ...preferences, outputType: option.id })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="create-agent-preferences__field">
                  <header className="create-agent-preferences__title">
                    {AGENT_COPY.preferencesRatioTitle}
                  </header>
                  <div
                    className={`create-agent-ratios${preferences.auto ? " is-disabled" : ""}`}
                    role="radiogroup"
                    aria-label={AGENT_COPY.preferencesRatioTitle}
                  >
                    {CREATE_ASPECT_RATIOS.map((ratio) => (
                      <button
                        key={ratio.id}
                        type="button"
                        role="radio"
                        aria-checked={preferences.aspectRatio === ratio.id}
                        disabled={preferences.auto}
                        className={`create-agent-ratio${
                          preferences.aspectRatio === ratio.id ? " is-checked" : ""
                        }`}
                        onClick={() => onChange({ ...preferences, aspectRatio: ratio.id })}
                      >
                        <span>{ratio.label}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="create-agent-preferences__field">
                  <header className="create-agent-preferences__title">
                    {AGENT_COPY.preferencesOtherTitle}
                  </header>
                  <div className="create-agent-preferences__other">
                    <CreateModelSelect
                      models={models}
                      /* 未指定模型时传 null：组件会落到第一个平台的第一个模型，
                         与「未指定就按目录默认模型提交」的口径一致。 */
                      model={selectedModel ?? null}
                      onModelChange={onModelChange}
                      className="create-agent-preferences__models"
                      platformClassName="create-agent-preferences__platform"
                      modelClassName="create-agent-preferences__model"
                    />
                    {selectedModel ? null : (
                      <p className="create-agent-preferences__model-hint">
                        未指定模型时按目录里的默认模型提交。
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
