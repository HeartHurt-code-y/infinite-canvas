import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../../../components/Icon";
import { MarkdownView } from "../../../components/MarkdownView";
import type { ProviderCatalogEntry } from "../../../lib/backend";
import { whiteModelPlanIssue, type WhiteModelScenePlan } from "../../../lib/whiteModelScene";
import { WhiteModelViewport } from "../WhiteModelViewport";
import { PlaybackClock, usePlaybackClock } from "../whiteModelPlayback";
import type { AgentAction, AgentPlan, AgentTool } from "./agentTypes";
import type { CanvasAgentController } from "./canvasAgentController";
import "../WhiteModelStudioDialog.css";
import "./CanvasAgentPanel.css";

interface CanvasAgentPanelProps {
  readonly controller: CanvasAgentController;
  readonly catalog: readonly ProviderCatalogEntry[];
  readonly disabled?: boolean;
}

const EXAMPLES = [
  "制作一个 6 秒白模：两个人相向走近，镜头缓缓向前推进，横屏。",
  "让人物先蹲下，再起身挥右手，把抬手动作放慢一些。",
  "帮我在画布上添加图片生成节点，并写好一段极简客厅的提示词。",
  "查看当前画布，告诉我接下来可以怎样继续制作。",
];

const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  title: "名称",
  name: "名称",
  label: "名称",
  text: "内容",
  content: "内容",
  prompt: "提示词",
  brief: "制作要求",
  nodeKey: "目标节点",
  nodeId: "目标节点",
  sourceKey: "来源节点",
  sourceNodeKey: "来源节点",
  targetKey: "目标节点",
  targetNodeKey: "目标节点",
  fromKey: "来源节点",
  toKey: "目标节点",
  kind: "节点类型",
  durationSeconds: "时长（秒）",
  width: "宽度",
  height: "高度",
  fps: "每秒帧数",
  x: "横向位置",
  y: "纵向位置",
};

const VALUE_LABELS: Readonly<Record<string, string>> = {
  prompt: "提示词",
  image: "图片生成",
  video: "视频生成",
  text: "文本",
  white_model: "白模",
  person: "人物",
  box: "方体",
  sphere: "球体",
  cylinder: "圆柱",
};

function previewScene(
  action: AgentAction,
  tool: AgentTool | undefined,
  derivedScene?: WhiteModelScenePlan,
): WhiteModelScenePlan | null {
  const value = derivedScene ?? action.args["scene"] ?? action.args["plan"];
  if (!tool || !value || typeof value !== "object") return null;
  const scene = value as WhiteModelScenePlan;
  try {
    tool.validate(action.args);
    if (
      scene.version !== 2 ||
      !Number.isFinite(scene.durationSeconds) ||
      scene.durationSeconds <= 0 ||
      !Number.isFinite(scene.width) ||
      !Number.isFinite(scene.height) ||
      scene.width <= 0 ||
      scene.height <= 0 ||
      whiteModelPlanIssue(scene)
    ) {
      return null;
    }
    return scene;
  } catch {
    return null;
  }
}

function actionSummary(
  action: AgentAction,
  actions: readonly AgentAction[],
  catalog: readonly ProviderCatalogEntry[],
  scene: WhiteModelScenePlan | null,
): readonly string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(action.args)) {
    const label = PARAMETER_LABELS[key];
    if (label && (typeof value === "string" || typeof value === "number")) {
      const step =
        typeof value === "string" && value.startsWith("$")
          ? actions.findIndex((item) => item.id === value.slice(1)) + 1
          : 0;
      lines.push(
        `${label}：${step ? `第 ${step} 步创建的节点` : (VALUE_LABELS[String(value)] ?? String(value))}`,
      );
    }
  }
  if (typeof action.args["modelDefinitionId"] === "string") {
    const provider = catalog.find((entry) => entry.provider.id === action.args["providerId"]);
    const model = provider?.models.find(
      (item) => item.definitionId === action.args["modelDefinitionId"],
    );
    lines.push(
      `模型：${model ? `${model.displayName} · ${provider!.provider.displayName}` : "当前目录中不可用，请修改计划"}`,
    );
  }
  if (scene) {
    lines.push(
      `${scene.durationSeconds} 秒 · ${scene.width} × ${scene.height} · ${scene.fps} 帧/秒`,
      `场景：${scene.objects.map((item) => `${item.name}（${VALUE_LABELS[item.shape] ?? item.shape}）`).join("、")}`,
      `机位：${scene.camera.lens} mm · ${scene.camera.keyframes.length > 1 ? "移动镜头" : "固定镜头"}`,
    );
  }
  return lines;
}

const ignorePreviewEdit = () => undefined;

function ScenePreview({ scene }: { readonly scene: WhiteModelScenePlan }) {
  const [clock] = useState(() => new PlaybackClock(scene.durationSeconds));
  const { time, playing } = usePlaybackClock(clock);
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => clock.setDuration(scene.durationSeconds), [clock, scene.durationSeconds]);

  return (
    <div className="canvas-agent__preview" aria-label="白模方案预览">
      <div className="canvas-agent__preview-stage">
        <WhiteModelViewport
          plan={scene}
          clock={clock}
          view="lens"
          selectedActorId={null}
          resetSignal={0}
          onSelectActor={ignorePreviewEdit}
          onActorMove={ignorePreviewEdit}
          onWaypointMove={ignorePreviewEdit}
          onActorRotate={ignorePreviewEdit}
          onCameraChange={ignorePreviewEdit}
        />
      </div>
      <div className="canvas-agent__preview-controls">
        <button
          type="button"
          onClick={() => clock.toggle()}
          aria-label={playing ? "暂停预览" : "播放预览"}
        >
          <Icon name={playing ? "pause" : "play"} size="sm" />
        </button>
        <input
          aria-label="预览时间"
          type="range"
          min={0}
          max={scene.durationSeconds}
          step={0.1}
          value={time}
          onChange={(event) => clock.set(Number(event.target.value))}
        />
        <span>
          {time.toFixed(1)} / {scene.durationSeconds} 秒
        </span>
      </div>
      <p className="canvas-agent__hint">预览角色走位与镜头；确认后才开始本地渲染。</p>
    </div>
  );
}

function PlanReview({
  plan,
  tools,
  catalog,
  previews,
  disabled,
  onApprove,
  onReject,
}: {
  readonly plan: AgentPlan;
  readonly tools: readonly AgentTool[];
  readonly catalog: readonly ProviderCatalogEntry[];
  readonly previews: ReadonlyMap<string, WhiteModelScenePlan>;
  readonly disabled: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <section className="canvas-agent__plan" aria-label="待确认的制作计划">
      <div className="canvas-agent__plan-heading">
        <Icon name="clipboard" size="md" />
        <strong>请确认制作计划</strong>
        <span>{plan.actions.length} 步</span>
      </div>
      {plan.message ? <MarkdownView content={plan.message} /> : null}
      {plan.review?.length ? (
        <details className="canvas-agent__details" open>
          <summary>本次制作内容</summary>
          {plan.review.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </details>
      ) : null}
      <ol className="canvas-agent__steps">
        {plan.actions.map((action, index) => {
          const tool = tools.find((item) => item.name === action.tool);
          const scene = previewScene(action, tool, previews.get(action.id));
          const summary = actionSummary(action, plan.actions, catalog, scene);
          const dependencySteps = action.dependsOn.map(
            (id) => plan.actions.findIndex((item) => item.id === id) + 1,
          );
          return (
            <li key={action.id}>
              <div className="canvas-agent__step-heading">
                <span>{index + 1}</span>
                <strong>{tool?.title ?? "创作操作"}</strong>
              </div>
              {summary.map((line, lineIndex) => (
                <p key={lineIndex}>{line}</p>
              ))}
              {tool?.effect === "generate" ? (
                <p className="canvas-agent__hint">调用生成模型，可能产生费用。</p>
              ) : null}
              {tool?.effect === "render" ? (
                <p className="canvas-agent__hint">使用本机 Blender 渲染。</p>
              ) : null}
              {dependencySteps.length > 0 ? (
                <p className="canvas-agent__hint">
                  在第 {dependencySteps.join("、")} 步完成后执行。
                </p>
              ) : null}
              {scene ? <ScenePreview key={`${plan.id}:${action.id}`} scene={scene} /> : null}
              <details className="canvas-agent__details">
                <summary>查看完整参数</summary>
                <pre>{JSON.stringify(action.args, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
      <p className="canvas-agent__hint">
        确认后按顺序操作当前画布。也可以在下方描述修改，重新制定计划。
      </p>
      <div className="canvas-agent__plan-actions">
        <button type="button" onClick={onReject} disabled={disabled}>
          修改计划
        </button>
        <button
          className="canvas-agent__primary"
          type="button"
          onClick={onApprove}
          disabled={disabled}
        >
          <Icon name="check" size="sm" />
          确认并执行
        </button>
      </div>
    </section>
  );
}

export function CanvasAgentPanel({ controller, catalog, disabled = false }: CanvasAgentPanelProps) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getState = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(state.expanded);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const busy = state.status !== "idle";
  const models = catalog
    .filter((entry) => entry.provider.enabled)
    .flatMap((entry) =>
      entry.models
        .filter((model) => model.operations.includes("text_generation"))
        .map((model) => ({
          key: JSON.stringify([entry.provider.id, model.definitionId]),
          label: `${model.displayName} · ${entry.provider.displayName}`,
          selection: { providerId: entry.provider.id, modelDefinitionId: model.definitionId },
        })),
    );
  const selectedKey = state.model
    ? JSON.stringify([state.model.providerId, state.model.modelDefinitionId])
    : "";
  const hasModel = models.some((model) => model.key === selectedKey);

  useEffect(() => {
    if (state.expanded) inputRef.current?.focus();
    else if (wasExpanded.current) toggleRef.current?.focus();
    wasExpanded.current = state.expanded;
  }, [state.expanded]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followMessages.current) transcript.scrollTop = transcript.scrollHeight;
  }, [state.expanded, state.messages, state.pending, state.progress]);

  const run = async (action: () => Promise<void>) => {
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };
  const send = () => {
    const text = draft.trim();
    if (!text || disabled || busy || !hasModel || composing.current) return;
    followMessages.current = true;
    setDraft("");
    void run(async () => {
      try {
        await controller.send(text);
      } catch (error) {
        setDraft((current) => current || text);
        throw error;
      }
    });
  };

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="canvas-agent-toggle"
        aria-label={state.expanded ? "收起创作助手" : "打开创作助手"}
        aria-expanded={state.expanded}
        aria-controls="canvas-agent-panel"
        data-status={busy ? state.status : state.pending ? "pending" : "idle"}
        title={`${state.expanded ? "收起创作助手（保留对话和任务）" : "打开创作助手"}${busy ? (state.status === "thinking" ? " · 思考中" : " · 制作中") : state.pending ? " · 待确认" : ""}`}
        onClick={() => controller.setExpanded(!state.expanded)}
      >
        <span className="canvas-agent-toggle__triangle" aria-hidden="true" />
      </button>
      {state.expanded ? (
        <aside
          id="canvas-agent-panel"
          className="canvas-agent"
          aria-label="创作助手"
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="canvas-agent__header">
            <Icon name="sparkle" size="lg" />
            <div>
              <strong>创作助手</strong>
              <p>描述想法，一起完成画布创作</p>
            </div>
          </header>
          <div className="canvas-agent__model">
            <label htmlFor="canvas-agent-model">对话模型</label>
            <select
              id="canvas-agent-model"
              value={hasModel ? selectedKey : ""}
              disabled={disabled || busy || models.length === 0}
              onChange={(event) =>
                controller.setModel(
                  models.find((model) => model.key === event.target.value)?.selection ?? null,
                )
              }
            >
              <option value="">
                {models.length === 0 ? "请先在设置中启用文本模型" : "请选择文本模型"}
              </option>
              {models.map((model) => (
                <option value={model.key} key={model.key}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div
            className="canvas-agent__transcript"
            ref={transcriptRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              followMessages.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            {state.messages.length === 0 ? (
              <div className="canvas-agent__empty">
                <h2>把想法说出来</h2>
                <p>
                  可以制作白模、添加和连接节点，或用已有模型生成内容。助手会先展示制作计划，等你确认。
                </p>
                <div className="canvas-agent__examples">
                  {EXAMPLES.map((example) => (
                    <button
                      type="button"
                      key={example}
                      disabled={disabled || busy}
                      onClick={() => {
                        setDraft(example);
                        inputRef.current?.focus();
                      }}
                    >
                      {example}
                      <Icon name="arrow-up" size="sm" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="canvas-agent__messages" role="log" aria-label="助手对话">
              {state.messages.map((message) => (
                <article
                  key={message.id}
                  className={`canvas-agent__message canvas-agent__message--${message.role}`}
                >
                  <span className="canvas-agent__speaker">
                    {message.role === "user"
                      ? "你"
                      : message.role === "tool"
                        ? "执行记录"
                        : "创作助手"}
                  </span>
                  {message.role === "tool" ? (
                    <details className="canvas-agent__details">
                      <summary>{message.content.split("：", 1)[0]}</summary>
                      <p>{message.content}</p>
                    </details>
                  ) : message.role === "assistant" ? (
                    <MarkdownView content={message.content} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                </article>
              ))}
            </div>
            {state.pending ? (
              <PlanReview
                key={state.pending.id}
                plan={state.pending}
                tools={controller.getTools()}
                catalog={catalog}
                previews={controller.getScenePreviews(state.pending.actions)}
                disabled={disabled || busy}
                onApprove={() => {
                  followMessages.current = true;
                  void run(() => controller.approve());
                }}
                onReject={() => {
                  controller.reject();
                  inputRef.current?.focus();
                }}
              />
            ) : null}
          </div>
          {busy ? (
            <div className="canvas-agent__progress" role="status">
              <div>
                <Icon name="circle-notch" size="sm" />
                <span>
                  {state.progress ||
                    (state.status === "thinking" ? "正在理解需求并制定计划…" : "正在执行制作计划…")}
                </span>
              </div>
              <button type="button" onClick={() => controller.stop()}>
                停止后续操作
              </button>
              <p>已提交的模型请求可能继续运行；本地渲染会请求取消。收起面板不会停止任务。</p>
            </div>
          ) : null}
          {state.error || localError ? (
            <p className="canvas-agent__error" role="alert">
              <Icon name="warning-circle" size="sm" />
              {state.error ?? localError}
            </p>
          ) : null}
          <form
            className="canvas-agent__composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              aria-label="给创作助手的消息"
              placeholder="描述你的需求，或继续修改方案…"
              rows={3}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="canvas-agent__composer-actions">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <button
                type="submit"
                className="canvas-agent__primary"
                disabled={disabled || busy || !hasModel || !draft.trim()}
              >
                <Icon name="paper-plane-right" size="sm" />
                发送
              </button>
            </div>
          </form>
        </aside>
      ) : null}
    </>
  );
}
