import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { placeFloatingLayer } from "../../components/floatingLayer";
import { backendErrorMessage, toMediaSrc, type GenerationTaskSummary, type ProviderCatalogEntry } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import type { PromptContentEditorSession, PromptContentModule } from "../../lib/promptContent";
import { toast } from "../../lib/toast";
import { artifactFileName, validateArtifactName } from "./artifactNames";
import { exportArtifactToDesktop } from "./desktopActions";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { CanvasNodeEditorShell } from "./CanvasNodeEditor";
import { CanvasAudioResultEdit } from "./CanvasAudioResultEdit";
import type { CanvasInlineFeatureRequest } from "./canvasFeatureCatalog";
import { CanvasReferenceTools } from "./CanvasReferenceTools";
import { MediaNodeTaskStatus, generationTaskNeedsAttention, nodeStatusTasks } from "./VideoGenerationNode";
import { PromptMentionInput } from "./PromptNodeViews";
import { CanvasNodeTitle } from "./VideoGenerationNode";
import {
  AUDIO_NODE_FORMAT_DISABLED,
  AUDIO_NODE_FORMATS,
  AUDIO_NODE_LANGUAGES,
  AUDIO_NODE_PITCH_RANGE,
  AUDIO_NODE_PROMPT_MAX_LENGTH,
  AUDIO_NODE_SAMPLE_RATES,
  AUDIO_NODE_SPEED_RANGE,
  AUDIO_NODE_VOLUME_RANGE,
  isAudioGenerationModel,
  type AudioNodeConfig,
  type AudioNodeFormat,
  type AudioNodeLanguage,
  type AudioNodeSampleRate,
  type ConnectedAssetInput,
  type GenNodeData,
  type MentionCandidate,
  type OutputNodeData,
} from "./workspaceModel";
import "./CanvasAudioNode.css";

/**
 * 音频节点（对齐 liblib.tv 画布的「音频」节点）。
 *
 * 规格来源：`docs/integrations/liblib-audio-node-re.md`——那份文档里的每个数值
 * 都来自原站画布页的**活体实测**（登录态、DPR 1.5），不是观感推测：
 *
 * - 空态卡片 320×350，中央是 48×48 的音符图标 + 「尝试：」+ 一枚「音频生视频」预设按钮；
 * - 生成编辑层自上而下是：工具 chips（上传 / 画布参考）→ 提示词正文 → 底栏；
 * - 底栏从左到右：模型下拉 → 格式下拉 → 翻译 → 高级设置开关 → 字数 → 消耗位 → 提交；
 * - 「高级设置」是可折叠面板，三档滑杆：语速 0.5–2、声调 -12–12、音量 0.01–10。
 *
 * 模型清单不照抄原站的 SaaS 模型（Seed Audio 1.0 / Eleven V3 / Mureka V8…），
 * 而是列本项目供应商目录里**真实可发起语音生成**的模型；消耗位显示「—」，
 * 因为本项目按供应商实际计费、没有积分余额，编一个单价出来就是骗人。
 */

export interface CanvasAudioNodeProps {
  readonly featureRequest?: CanvasInlineFeatureRequest | undefined;
  readonly node: Extract<GenNodeData, { kind: "audio" }>;
  readonly selected: boolean;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly activeTask: GenerationTaskSummary | null;
  readonly latestTask?: GenerationTaskSummary | null | undefined;
  readonly tasks: readonly GenerationTaskSummary[];
  readonly onOpenTask: (taskId: string) => void;
  readonly connectedInputs: readonly ConnectedAssetInput[];
  readonly mentionCandidates: readonly MentionCandidate[];
  readonly aliveCanvasNodeKeys?: ReadonlySet<string> | undefined;
  readonly registerPromptInput: (
    nodeKey: string,
    session: PromptContentEditorSession | null,
  ) => void;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly onSelect: (key: string) => void;
  readonly onStartGeneration: (key: string) => void;
  readonly onAudioConfigChange: (key: string, config: AudioNodeConfig) => void;
  /** 「音频生视频」：在右侧建一个视频节点并连入这段音频（不自动发起付费生成）。 */
  readonly onAudioToVideo?: ((nodeKey: string) => void) | undefined;
  /** 「翻译提示词」：把当前正文翻成英文。缺省时按钮置灰并说明原因。 */
  readonly onTranslatePrompt?: ((nodeKey: string) => void) | undefined;
  /** 本节点是否正在做提示词翻译。 */
  readonly translating?: boolean;
  readonly onRename?: ((key: string, name: string) => void) | undefined;
  readonly presentation?: "card" | "editor";
  readonly editorOpen?: boolean;
  readonly onCloseEditor?: (() => void) | undefined;
  readonly promptContents?: PromptContentModule | undefined;
  readonly previewOutput?: OutputNodeData | null | undefined;
}

/** 音频节点可用的模型项（来自本项目供应商目录）。 */
interface AudioModelOption {
  /** 选中值：`providerId::modelDefinitionId`。 */
  readonly value: string;
  readonly label: string;
  readonly providerId: string;
  readonly modelDefinitionId: string;
}

/**
 * 列出供应商目录里真正能发起语音生成的模型。
 *
 * 模型名重复时补上供应商名——两行同名模型在下拉里分不清是哪一家的。
 */
function audioModelOptions(
  providerCatalog: readonly ProviderCatalogEntry[],
): readonly AudioModelOption[] {
  const counts = new Map<string, number>();
  for (const entry of providerCatalog) {
    if (!entry.provider.enabled) continue;
    for (const model of entry.models) {
      if (!isAudioGenerationModel(model)) continue;
      counts.set(model.displayName, (counts.get(model.displayName) ?? 0) + 1);
    }
  }
  const options: AudioModelOption[] = [];
  for (const entry of providerCatalog) {
    if (!entry.provider.enabled) continue;
    for (const model of entry.models) {
      if (!isAudioGenerationModel(model)) continue;
      options.push({
        value: `${entry.provider.id}::${model.definitionId}`,
        label:
          (counts.get(model.displayName) ?? 0) > 1
            ? `${entry.provider.displayName} · ${model.displayName}`
            : model.displayName,
        providerId: entry.provider.id,
        modelDefinitionId: model.definitionId,
      });
    }
  }
  return options;
}

/** 浮层定位：跟随触发器，量一次实际高度后再决定朝上还是朝下。 */
interface AnchoredPopover {
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly placement: { readonly top: number; readonly left: number; readonly width: number } | null;
}

function useAnchoredPopover(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  minWidth: number,
): AnchoredPopover {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{
    readonly top: number;
    readonly left: number;
    readonly width: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const apply = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const measured = popoverRef.current?.getBoundingClientRect().height ?? null;
      const box = placeFloatingLayer(anchor, {
        align: "start",
        minWidth,
        maxHeight: 380,
        // 画布节点的菜单：下方够就朝下（贴着节点卡片），不够才朝上。
        preferAbove: false,
        measuredHeight: measured,
      });
      setPlacement({ top: box.top, left: box.left, width: box.width });
    };
    apply();
    window.addEventListener("resize", apply);
    const element = popoverRef.current;
    const observer =
      typeof ResizeObserver === "undefined" || element == null
        ? null
        : new ResizeObserver(apply);
    if (observer != null && element != null) observer.observe(element);
    return () => {
      window.removeEventListener("resize", apply);
      observer?.disconnect();
    };
  }, [anchorRef, minWidth, open]);
  return { popoverRef, placement };
}

/** 面板外壳：与原站同款（半透明面板底 + hair 描边）。 */
function AudioPopover({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div className={`canvas-audio-node__popover ${className ?? ""}`} role="dialog">
      {children}
    </div>
  );
}

/**
 * 音频节点的图标（活体 DOM 原文，见 docs/integrations/liblib-audio-node-re.md 1.1）。
 *
 * 原站用的是 Iconify 自有字形：标题条上的波形与卡片中央的音符。Lucide 里
 * 没有同构的字形，这里照抄原站 path —— 节点卡的身份图标是「一眼认得出
 * 这是音频节点」的关键，语义相近但形状差很多的替代品反而更糟。
 */

/** 标题条波形图标（16×16）。 */
function AudioWaveIcon({ className }: { readonly className?: string | undefined }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.33"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 13.5v-11a.67.67 0 0 1 1.33 0v11a.67.67 0 1 1-1.33 0m5.67-1.33V3.83a.67.67 0 0 1 1.33 0v8.34a.67.67 0 0 1-1.33 0m-2.84-1.34V5.17a.67.67 0 0 1 1.34 0v5.66a.67.67 0 0 1-1.34 0M1.83 9.5v-3a.67.67 0 0 1 1.34 0v3a.67.67 0 0 1-1.34 0m11 0v-3a.67.67 0 0 1 1.34 0v3a.67.67 0 0 1-1.34 0" />
    </svg>
  );
}

/** 卡片中央的音符图标（48×48）。 */
function AudioNoteIcon() {
  return (
    <svg
      className="canvas-audio-node__empty-icon"
      width="48"
      height="48"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8.19 0v1.2H5.66v4.97a2.83 2.83 0 1 1-1.2-2.32V0zM2.83 4.53a1.64 1.64 0 1 0 1.64 1.66h-.01v-.22a1.64 1.64 0 0 0-1.63-1.44"
        transform="translate(3.905 3.5)"
      />
    </svg>
  );
}

/** 「音频生视频」预设按钮的方框播放图标（14×14）。 */
function AudioToVideoIcon() {
  return (
    <svg
      className="canvas-audio-node__try-icon"
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M17.4 0A2.6 2.6 0 0 1 20 2.6v14.8a2.6 2.6 0 0 1-2.6 2.6H2.6A2.6 2.6 0 0 1 0 17.4V2.6A2.6 2.6 0 0 1 2.6 0zM8.53 5.96A1 1 0 0 0 7 6.81v6.39a1 1 0 0 0 1.53.85l5.11-3.19a1 1 0 0 0 0-1.7z" />
    </svg>
  );
}

export function CanvasAudioNode({
  node,
  selected,
  starting,
  startError,
  activeTask,
  latestTask,
  tasks,
  onOpenTask,
  connectedInputs,
  mentionCandidates,
  aliveCanvasNodeKeys,
  registerPromptInput,
  providerCatalog,
  onSelect,
  onStartGeneration,
  onAudioConfigChange,
  onAudioToVideo,
  onTranslatePrompt,
  translating = false,
  onRename,
  presentation = "card",
  editorOpen = selected,
  onCloseEditor,
  promptContents,
  previewOutput,
  featureRequest,
}: CanvasAudioNodeProps) {
  const config = node.config;
  const statusTasks = nodeStatusTasks(tasks, latestTask);
  const showTaskStatus = starting || activeTask != null || statusTasks.some(generationTaskNeedsAttention);
  const models = useMemo(() => audioModelOptions(providerCatalog), [providerCatalog]);
  const promptLabelId = useId();
  const promptHintId = useId();
  const formatAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const { popoverRef, placement } = useAnchoredPopover(formatOpen, formatAnchorRef, 260);
  /* 字数计数要放在所有条件返回之前：它是 hook，不能只在编辑层里调用。 */
  const characterCount = usePromptCharacterCount(promptContents, node.key);
  const [duration, setDuration] = useState<{ src: string; seconds: number } | null>(null);
  const playerRef = useRef<HTMLAudioElement>(null);
  const [exporting, setExporting] = useState(false);

  const modelValue = `${config.modelSelection.providerId}::${config.modelSelection.modelDefinitionId}`;

  const update = useCallback(
    (patch: Partial<AudioNodeConfig>) => {
      onAudioConfigChange(node.key, { ...config, ...patch });
    },
    [config, node.key, onAudioConfigChange],
  );

  /* 格式浮层：点击外部关闭。 */
  useEffect(() => {
    if (!formatOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(".canvas-audio-node__popover") ||
        target?.closest(".canvas-audio-node__format-trigger")
      ) {
        return;
      }
      setFormatOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [formatOpen]);

  /*
   * 编辑层收起时把浮层一并关掉。
   *
   * 浮层挂在 body 上，不在编辑层的 DOM 里：编辑层被收起（选中态变化、Esc、删除节点）
   * 时它不会跟着卸载，会变成一个没人管的浮层飘在屏幕上。
   */
  useEffect(() => {
    if (!editorOpen) setFormatOpen(false);
  }, [editorOpen]);

  const outputSrc = previewOutput?.finalPath
    ? toMediaSrc(previewOutput.finalPath)
    : (previewOutput?.previewSrc ?? null);
  const audioSrc = outputSrc ? (toMediaProxyUrl(outputSrc) ?? outputSrc) : null;
  const titleText = node.name ?? "音频节点";
  const sourceDuration = audioSrc && duration?.src === audioSrc ? duration.seconds : null;
  const durationSeconds = sourceDuration == null ? null : Math.floor(sourceDuration);
  const download = async () => {
    if (!previewOutput?.finalPath || exporting) return;
    const path = previewOutput.finalPath;
    const name = previewOutput.name?.trim() || "音频";
    setExporting(true);
    try {
      if (await exportArtifactToDesktop(path, artifactFileName(validateArtifactName(name) ? "音频" : name, path))) {
        toast.success("音频已保存");
      }
    } catch (failure) {
      toast.error("下载失败：" + backendErrorMessage(failure));
    } finally {
      setExporting(false);
    }
  };

  if (presentation === "card") {
    return (
      <div
        id={`node-preview-${node.key}`}
        className={`canvas-gen-node canvas-gen-node--audio canvas-node-preview canvas-audio-node${selected ? " is-selected" : ""}${audioSrc ? " has-audio-result" : ""}`}
        data-connection-target={node.key}
        aria-busy={starting || activeTask != null}
        onMouseDown={(event) => {
          if ((event.target as Element).closest("button, input, audio[controls]")) return;
          onSelect(node.key);
        }}
      >
        <div className="canvas-node-toolbar">
          <span className="canvas-node-toolbar__type">
            <AudioWaveIcon className="canvas-node-toolbar__icon" />
            <CanvasNodeTitle
              title={titleText}
              onRename={onRename ? (value) => onRename(node.key, value) : undefined}
            />
          </span>
          {durationSeconds != null ? <span className="canvas-node-toolbar__size">
            {Math.floor(durationSeconds / 60)}:{String(durationSeconds % 60).padStart(2, "0")}
          </span> : null}
        </div>
        <div className="canvas-audio-node__card">
          {audioSrc ? (
            <>
              <audio key={audioSrc} ref={playerRef} hidden preload="metadata" src={audioSrc}
                onLoadedMetadata={event => {
                  const seconds = event.currentTarget.duration;
                  if (Number.isFinite(seconds) && seconds > 0) setDuration({ src: audioSrc, seconds });
                }} />
              <CanvasAudioResultEdit key={audioSrc} nodeKey={node.key} output={previewOutput ?? null}
                duration={sourceDuration} playerRef={playerRef} providerCatalog={providerCatalog}
                exporting={exporting} onDownload={() => { void download(); }} onOpen={onCloseEditor}
                featureRequest={featureRequest} />
            </>
          ) : (
            <div className="canvas-audio-node__empty">
              <AudioNoteIcon />
              <div className="canvas-audio-node__try-label">尝试：</div>
              <div className="canvas-audio-node__try-list">
                <button
                  type="button"
                  className="canvas-audio-node__try"
                  disabled={!onAudioToVideo}
                  title={
                    onAudioToVideo
                      ? "选择音频，连入右侧新建的视频节点"
                      : "音频生视频暂不可用"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    onAudioToVideo?.(node.key);
                  }}
                >
                  <AudioToVideoIcon />
                  <span>音频生视频</span>
                </button>
              </div>
            </div>
          )}
        </div>
        {startError ? (
          <ErrorAlert
            id={`node-preview-error-${node.key}`}
            error={startError}
            variant="inline"
            hint="打开编辑区查看请求设置；提交回执不明确时请在历史中核对原任务。"
          />
        ) : null}
        {showTaskStatus ? <MediaNodeTaskStatus kind="audio" task={activeTask ?? latestTask ?? null} starting={starting}
          tasks={statusTasks}
          onOpenTask={onOpenTask} /> : null}
      </div>
    );
  }

  const selectionReady = Boolean(
    config.modelSelection.providerId && config.modelSelection.modelDefinitionId,
  );
  const counter = `${characterCount}/${AUDIO_NODE_PROMPT_MAX_LENGTH}`;
  const submitHint = !selectionReady ? "请先选择可用的供应商和语音模型"
    : characterCount === 0 ? "请输入要生成的音频文本"
      : characterCount > AUDIO_NODE_PROMPT_MAX_LENGTH ? "音频文本最多 2000 字" : null;
  const languageLabel =
    AUDIO_NODE_LANGUAGES.find((item) => item.value === config.language)?.label ?? "中文";
  const sampleRateLabel =
    AUDIO_NODE_SAMPLE_RATES.find((item) => item.value === config.sampleRate)?.label ?? "24k";
  const formatLabel =
    AUDIO_NODE_FORMATS.find((item) => item.value === config.format)?.label ?? "wav";

  const modelOptions = models.some((model) => model.value === modelValue)
    ? models.map((model) => ({ value: model.value, label: model.label }))
    : [
        {
          value: modelValue,
          label: config.modelSelection.modelDefinitionId
            ? `${config.modelSelection.modelDefinitionId}（不可用）`
            : models.length > 0
              ? "请选择语音模型"
              : "没有可用语音模型",
        },
        ...models.map((model) => ({ value: model.value, label: model.label })),
      ];

  const form = (
    <div className="video-node-editor__form canvas-audio-node__editor" aria-busy={starting || activeTask != null}>
      {/* 工具 chips 行：上传 / 画布参考（原站同款顺序与文案）。 */}
      <div className="canvas-gen-node__tool-chips" role="group" aria-label="创作工具">
        <CanvasReferenceTools node={node} active={editorOpen} />
      </div>

      {/* 提示词正文。 */}
      <div className="canvas-gen-node__prompt-area canvas-audio-node__prompt-area">
        <span id={promptLabelId} className="sr-only">
          提示词输入框，输入 @ 引用音频
        </span>
        <span id={promptHintId} className="sr-only">
          {connectedInputs.length > 0
            ? `${connectedInputs.length} 个参考音频已连接`
            : "描述你想要的音频效果，可用 @ 引用音频"}
        </span>
        <PromptMentionInput
          nodeKey={node.key}
          candidates={mentionCandidates}
          aliveCanvasNodeKeys={aliveCanvasNodeKeys}
          registerInput={registerPromptInput}
          labelledBy={promptLabelId}
          describedBy={promptHintId}
          expandable={false}
          autoLink={config.autoLink !== false}
          placeholder="描述你想要的音频效果，可用 @ 引用音频"
        />
      </div>

      {startError ? (
        <div aria-label="发起任务失败">
          <ErrorAlert
            id={`audio-start-error-${node.key}`}
            error={startError}
            hint="检查提示词与模型后重新发起；失败的任务不会自动重发。"
          />
        </div>
      ) : null}

      {/* 底栏。 */}
      <div className="canvas-gen-node__footer canvas-audio-node__footer">
        <CanvasSelect
          ariaLabel="语音生成模型"
          className="canvas-audio-node__model"
          value={modelValue}
          options={modelOptions}
          chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={14} />}
          selectedIcon={<LibTVMediaIcon name="check" size={12} />}
          onChange={(value) => {
            const separator = value.indexOf("::");
            if (separator <= 0) return;
            update({
              modelSelection: {
                providerId: value.slice(0, separator),
                modelDefinitionId: value.slice(separator + 2),
              },
            });
          }}
        />
        <button
          type="button"
          ref={formatAnchorRef}
          className="canvas-audio-node__format-trigger"
          aria-haspopup="dialog"
          aria-expanded={formatOpen}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            /*
             * Escape 必须在**冒泡阶段**由「真正拿到焦点的那个元素」处理。
             *
             * 挂在 document 的捕获阶段会抢在编辑层之前动手：编辑层自己的 Escape
             * （关掉整个编辑区）还没来得及认领这个键，浮层就先关了，随后编辑层
             * 照样把面板收掉 —— 一次按键关了两层。
             */
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            setFormatOpen(false);
          }}
          onClick={(event) => {
            event.stopPropagation();
            setFormatOpen((value) => !value);
          }}
        >
          <span className="canvas-audio-node__format-text">
            {languageLabel} · {sampleRateLabel} · {formatLabel}
          </span>
          <LibTVMediaIcon name="icon-chevron-down-small" size={14} />
        </button>
        <span className="canvas-audio-node__footer-spacer" />
        <button
          type="button"
          className="canvas-audio-node__icon-button"
          aria-label="翻译提示词"
          title="翻译提示词"
          data-tooltip="翻译提示词"
          disabled={!onTranslatePrompt || translating}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onTranslatePrompt?.(node.key);
          }}
        >
          <LibTVMediaIcon name="translate" size={16} />
        </button>
        <button
          type="button"
          className={`canvas-audio-node__icon-button${config.advancedOpen ? " is-active" : ""}`}
          aria-label="高级设置"
          aria-expanded={config.advancedOpen}
          title="高级设置"
          data-tooltip="高级设置"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            update({ advancedOpen: !config.advancedOpen });
          }}
        >
          <LibTVMediaIcon name="icon-generate-settings1" size={16} />
        </button>
        <span className="canvas-audio-node__counter">{counter}</span>
        {/*
          消耗位：保留原站的位置与外观，但本项目按供应商实际计费、没有积分余额，
          所以这里显示「—」而不是编造一个单价。
        */}
        <span className="canvas-audio-node__cost" title="按供应商实际计费">
          <LibTVMediaIcon name="icon-lightning-filled" size={12} />
          <span>—</span>
        </span>
        <button
          type="button"
          className="canvas-gen-node__start"
          data-canvas-generate=""
          aria-label="开始音频生成"
          aria-describedby={startError ? `audio-start-error-${node.key}` : undefined}
          data-tooltip={submitHint ?? "开始音频生成"}
          disabled={starting || Boolean(submitHint) || activeTask != null}
          data-state={starting ? "loading" : undefined}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(node.key);
            onStartGeneration(node.key);
          }}
        >
          {starting ? (
            <LibTVMediaIcon name="icon-loading" className="spin-icon" size={14} />
          ) : (
            <LibTVMediaIcon name="up-arrow" size={14} />
          )}
        </button>
      </div>

      {/* 高级设置。 */}
      <div
        className={`canvas-audio-node__advanced${config.advancedOpen ? " is-open" : ""}`}
        hidden={!config.advancedOpen}
      >
        <div className="canvas-audio-node__advanced-title">高级设置</div>
        <div className="canvas-audio-node__advanced-rows">
          <AudioSliderRow
            label="语速"
            value={config.voiceSettingSpeed}
            min={AUDIO_NODE_SPEED_RANGE.min}
            max={AUDIO_NODE_SPEED_RANGE.max}
            step={AUDIO_NODE_SPEED_RANGE.step}
            format={(value) => value.toFixed(2)}
            onChange={(value) => update({ voiceSettingSpeed: value })}
          />
          <AudioSliderRow
            label="声调"
            value={config.voiceSettingPitch}
            min={AUDIO_NODE_PITCH_RANGE.min}
            max={AUDIO_NODE_PITCH_RANGE.max}
            step={AUDIO_NODE_PITCH_RANGE.step}
            format={(value) => String(Math.round(value))}
            onChange={(value) => update({ voiceSettingPitch: Math.round(value) })}
          />
          <AudioSliderRow
            label="音量"
            value={config.voiceSettingVolume}
            min={AUDIO_NODE_VOLUME_RANGE.min}
            max={AUDIO_NODE_VOLUME_RANGE.max}
            step={AUDIO_NODE_VOLUME_RANGE.step}
            format={(value) => value.toFixed(1)}
            onChange={(value) => update({ voiceSettingVolume: value })}
          />
        </div>
      </div>

      {showTaskStatus ? (
        <MediaNodeTaskStatus kind="audio" task={activeTask ?? latestTask ?? null} starting={starting}
          tasks={statusTasks}
          onOpenTask={onOpenTask} />
      ) : null}
      {latestTask != null && latestTask.status === "failed" && !startError ? (
        <span className="sr-only">上一次音频生成失败</span>
      ) : null}
    </div>
  );

  return (
    <>
      <CanvasNodeEditorShell
        nodeKey={node.key}
        kindLabel="音频生成"
        name={node.name ?? "音频生成"}
        anchor={{
          x: node.x,
          y: node.y,
          width: node.measured?.width ?? 320,
          height: node.measured?.height ?? 350,
        }}
        open={editorOpen}
        onClose={() => onCloseEditor?.()}
      >
        {form}
      </CanvasNodeEditorShell>

      {formatOpen ? (
        createPortal(
          <div
            ref={popoverRef}
            className="canvas-audio-node__popover-host"
            style={{
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              width: placement?.width ?? 260,
              // 首帧还没量到高度：先藏起来，量完再显示，避免闪一下错位。
              visibility: placement == null ? "hidden" : "visible",
            }}
            onKeyDown={(event) => {
              // 焦点在浮层里时，Escape 只关浮层（与触发器同一条路径）。
              if (event.key !== "Escape" || event.defaultPrevented) return;
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              event.stopPropagation();
              setFormatOpen(false);
            }}
          >
            <AudioPopover className="canvas-audio-node__format-popover">
              <AudioFormatSection
                title="语种"
                options={AUDIO_NODE_LANGUAGES.map((item) => ({
                  value: String(item.value),
                  label: item.label,
                }))}
                value={config.language}
                onChange={(value) => update({ language: value as AudioNodeLanguage })}
              />
              <AudioFormatSection
                title="采样率"
                options={AUDIO_NODE_SAMPLE_RATES.map((item) => ({
                  value: String(item.value),
                  label: item.label,
                }))}
                value={String(config.sampleRate)}
                onChange={(value) => update({ sampleRate: Number(value) as AudioNodeSampleRate })}
              />
              <AudioFormatSection
                title="输出格式"
                options={AUDIO_NODE_FORMATS.map((item) => ({
                  value: item.value,
                  label: item.label,
                  ...(AUDIO_NODE_FORMAT_DISABLED[item.value] != null
                    ? { disabledHint: AUDIO_NODE_FORMAT_DISABLED[item.value] }
                    : {}),
                }))}
                value={config.format}
                onChange={(value) => update({ format: value as AudioNodeFormat })}
              />
            </AudioPopover>
          </div>,
          document.body,
        )
      ) : null}
    </>
  );
}

/** 格式下拉里的一个分区（语种 / 采样率 / 输出格式）。 */
function AudioFormatSection({
  title,
  options,
  value,
  onChange,
}: {
  readonly title: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    /** 不可用的选项：保留条目（与原站逐项对齐）但写明为什么不能用。 */
    readonly disabledHint?: string | undefined;
  }[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <section className="canvas-audio-node__format-section">
      <h4 className="canvas-audio-node__format-title">{title}</h4>
      <div className="canvas-audio-node__format-grid">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`canvas-audio-node__format-option${
              option.value === value ? " is-selected" : ""
            }`}
            aria-pressed={option.value === value}
            disabled={option.disabledHint != null}
            title={option.disabledHint}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 一行滑杆：滑杆 + 数值框（原站实测：176 宽滑杆 + 68 宽数值框）。 */
function AudioSliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
}) {
  const inputId = useId();
  return (
    <div className="canvas-audio-node__slider-row">
      <label className="canvas-audio-node__slider-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="canvas-audio-node__slider-controls">
        <input
          id={inputId}
          className="canvas-audio-node__slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          className="canvas-audio-node__slider-value"
          type="text"
          inputMode="decimal"
          value={format(value)}
          aria-label={`${label}数值`}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) return;
            onChange(Math.min(max, Math.max(min, parsed)));
          }}
        />
      </div>
    </div>
  );
}

/** 提示词字数：读 promptContents 模块里当前节点的正文长度。 */
function usePromptCharacterCount(
  promptContents: PromptContentModule | undefined,
  nodeKey: string,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!promptContents) return;
    const update = () => {
      setCount(promptContents.read(nodeKey)?.characterCount ?? 0);
    };
    update();
    return promptContents.subscribe(nodeKey, update);
  }, [promptContents, nodeKey]);
  return count;
}
