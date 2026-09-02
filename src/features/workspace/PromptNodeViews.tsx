import { BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { CornersOut } from "@phosphor-icons/react/CornersOut";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { FilmSlate } from "@phosphor-icons/react/FilmSlate";
import { FilmStrip } from "@phosphor-icons/react/FilmStrip";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { Waveform as WaveformIcon } from "@phosphor-icons/react/Waveform";
import { X } from "@phosphor-icons/react/X";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  frontendLog,
  type GenerationOperation,
  type PromptOptimizationMode,
  type ProviderCatalogEntry,
} from "../../lib/backend";
import {
  modelParameterCapabilities,
  resolvedParameterValue,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import {
  createPromptContentEditorSession,
  describePromptContentCandidates,
  PROMPT_AUTO_DETECT_DEBOUNCE_MS,
  type PromptContentEditorSession,
} from "../../lib/promptContent";
import { diffPromptRuns } from "../../lib/promptDiff";

import type {
  AssetItem,
  AssetKind,
  ImageNodeConfig,
  MentionCandidate,
  NodePromptOptimizationConfig,
  PromptOptimizationPanelState,
  RepositoryNodeKind,
  VideoNodeConfig,
} from "./workspaceModel";
import {
  CONTACT_SHEET_SRC,
  IMAGE_PROMPT_OPTIMIZATION_DEFAULT_MODE,
  IMAGE_PROMPT_OPTIMIZATION_MODES,
  MAX_GENERATION_COUNT,
  PROMPT_OPTIMIZATION_MODE_LABELS,
  VIDEO_PROMPT_OPTIMIZATION_DEFAULT_MODE,
  VIDEO_PROMPT_OPTIMIZATION_MODES,
  firstTextModelSelection,
  isImageGenerationModel,
  isTextGenerationModel,
  parseGenerationCountInput,
  supportsGenerationNode,
} from "./workspaceModel";

export function AssetKindIcon({
  kind,
  size = 15,
}: {
  readonly kind: AssetKind;
  readonly size?: number;
}) {
  const iconProps = { size, weight: "bold" as const, "aria-hidden": true };

  if (kind === "image") return <ImageSquare {...iconProps} />;
  if (kind === "video") return <VideoCamera {...iconProps} />;
  return <WaveformIcon {...iconProps} />;
}

export function NodeTypeIcon({
  kind,
  size = 14,
}: {
  readonly kind: RepositoryNodeKind | "result";
  readonly size?: number;
}) {
  const iconProps = { size, weight: "bold" as const, "aria-hidden": true };

  if (kind === "image") return <ImageSquare {...iconProps} />;
  if (kind === "video") return <VideoCamera {...iconProps} />;
  if (kind === "prompt") return <Sparkle {...iconProps} />;
  if (kind === "screenplay") return <BookOpenText {...iconProps} />;
  if (kind === "storyboard") return <FilmSlate {...iconProps} />;
  if (kind === "viral_remix") return <FilmStrip {...iconProps} />;
  if (kind === "video_composer") return <FilmStrip {...iconProps} />;
  if (kind === "video_downloader") return <DownloadSimple {...iconProps} />;
  return <FolderOpen {...iconProps} />;
}

export function ContactSheetCrop({
  visual,
  className = "",
}: {
  readonly visual: Exclude<AssetItem["visual"], "ambience">;
  readonly className?: string;
}) {
  return (
    <img
      src={CONTACT_SHEET_SRC}
      alt=""
      width={1254}
      height={1254}
      draggable={false}
      decoding="async"
      fetchPriority="high"
      className={`contact-sheet-crop contact-sheet-crop--${visual}${className ? ` ${className}` : ""}`}
    />
  );
}

type AutoMentionFeedbackKind =
  "ready" | "scanning" | "success" | "ambiguous" | "no-match" | "empty";

interface AutoMentionFeedback {
  readonly kind: AutoMentionFeedbackKind;
  readonly message: string;
}

const AUTO_MENTION_FEEDBACK_MS = 2400;
/** 手动点击重扫时至少展示一次可感知的“扫描中”状态，避免同步结果被 React 合并掉。 */
const MANUAL_AUTO_DETECT_DELAY_MS = 420;

function readyAutoMentionFeedback(candidates: readonly MentionCandidate[]): AutoMentionFeedback {
  if (candidates.length === 0) {
    return { kind: "empty", message: "连接素材后自动识别引用" };
  }
  const ambiguousCount = describePromptContentCandidates(candidates).ambiguousPatternCount;
  if (ambiguousCount > 0) {
    return {
      kind: "ready",
      message: `自动识别已开启 · ${candidates.length} 个素材 · 同名项会高亮确认`,
    };
  }
  return {
    kind: "ready",
    message: `自动识别已开启 · ${candidates.length} 个可引用素材`,
  };
}

/**
 * 生成节点内的提示词输入框：Tiptap 管理编辑态，V1 canonical document 管理持久化。
 * - 输入 "@" 或点击 "@" 按钮弹出候选下拉（连线的素材优先）；
 * - 选中后由提示内容 adapter 插入 Tiptap 原子引用节点；
 * - canonical document、结构化持久化与冻结提交均由提示内容 module 负责。
 */
export function PromptMentionInput({
  nodeKey,
  candidates,
  registerInput,
  labelledBy,
  describedBy,
  expandable = false,
}: {
  readonly nodeKey: string;
  /** 候选素材：连线的素材节点在前，素材库其余素材在后。 */
  readonly candidates: readonly MentionCandidate[];
  readonly registerInput: (nodeKey: string, session: PromptContentEditorSession | null) => void;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly expandable?: boolean;
}) {
  const inputRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<PromptContentEditorSession | null>(null);
  sessionRef.current ??= createPromptContentEditorSession(candidates);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreExpandFocusRef = useRef(false);
  const replaceTypedQueryOnSelectRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [characterCount, setCharacterCount] = useState(0);
  const [autoMentionResolvedNames, setAutoMentionResolvedNames] = useState<readonly string[]>([]);
  const [activeAmbiguity, setActiveAmbiguity] = useState<{
    readonly pattern: string;
    readonly displayName: string;
  } | null>(null);
  const [autoMentionFeedback, setAutoMentionFeedback] = useState<AutoMentionFeedback>(() =>
    readyAutoMentionFeedback(candidates),
  );
  const editorId = `prompt-editor-${nodeKey}`;
  const editorTitleId = `${editorId}-title`;
  const editorDescriptionId = `${editorId}-description`;
  const autoMentionStatusId = `${editorId}-auto-status`;
  const attachInput = useCallback(
    (host: HTMLDivElement | null) => {
      const ariaLabel = expanded
        ? "放大的提示词输入框，输入 @ 引用素材"
        : labelledBy
          ? null
          : "提示词输入框，输入 @ 引用素材";
      const ariaLabelledBy = expanded ? null : (labelledBy ?? null);
      const ariaDescribedBy = expanded ? editorDescriptionId : (describedBy ?? null);
      sessionRef.current?.attach(host, {
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        ...(ariaLabelledBy ? { "aria-labelledby": ariaLabelledBy } : {}),
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
      });
      inputRef.current = host?.querySelector<HTMLDivElement>("[contenteditable='true']") ?? null;
      registerInput(nodeKey, host == null ? null : sessionRef.current);
    },
    [describedBy, editorDescriptionId, expanded, labelledBy, nodeKey, registerInput],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return candidates;
    return candidates.filter(
      (candidate) =>
        candidate.name.toLowerCase().includes(keyword) ||
        candidate.assetId.toLowerCase().includes(keyword) ||
        candidate.canvasNodeKey.toLowerCase().includes(keyword),
    );
  }, [candidates, query]);

  const candidateDescription = useMemo(
    () => describePromptContentCandidates(candidates, activeAmbiguity?.pattern),
    [activeAmbiguity?.pattern, candidates],
  );
  const candidateAliases = candidateDescription.aliases;
  const candidateConnectionSignature = JSON.stringify(
    candidates.map((candidate) => [
      candidate.canvasNodeKey,
      candidate.assetId,
      candidate.providerConnectionId,
      candidate.source,
      candidate.referenceKind,
      candidate.generationTaskId,
      candidate.resultIndex,
      candidate.kind,
      candidate.name,
    ]),
  );
  const latestCandidatesRef = useRef(candidates);
  useEffect(() => {
    latestCandidatesRef.current = candidates;
  }, [candidates]);
  const recognizableCandidates = useMemo(
    () =>
      candidates.slice(0, 5).map((candidate, index) => ({
        candidate,
        alias: candidateAliases[index]?.label ?? `素材${index + 1}`,
      })),
    [candidateAliases, candidates],
  );
  const ambiguityOptions = candidateDescription.ambiguityOptions;

  const closeMenu = useCallback(() => {
    replaceTypedQueryOnSelectRef.current = false;
    setMenuOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const openAmbiguityChip = useCallback(
    (pending: { readonly normalizedPattern: string; readonly displayText: string }) => {
      setMenuOpen(false);
      setQuery("");
      setActiveIndex(0);
      setActiveAmbiguity({
        pattern: pending.normalizedPattern,
        displayName: pending.displayText,
      });
    },
    [],
  );

  const openFirstPendingAmbiguity = useCallback((): boolean => {
    const pending = sessionRef.current?.firstPending();
    if (pending == null) {
      setActiveAmbiguity(null);
      return false;
    }
    openAmbiguityChip(pending);
    return true;
  }, [openAmbiguityChip]);

  const updatePromptSnapshot = useCallback((input: HTMLDivElement) => {
    const view = sessionRef.current?.acceptNativeInput();
    setCharacterCount(
      view?.characterCount ?? (input.textContent ?? "").replaceAll("\u200b", "").length,
    );
  }, []);

  const closeExpandedEditor = useCallback(() => {
    if (inputRef.current) updatePromptSnapshot(inputRef.current);
    closeMenu();
    setActiveAmbiguity(null);
    setExpanded(false);
  }, [closeMenu, updatePromptSnapshot]);

  useEffect(() => {
    if (!expanded) return;
    const workspace = document.querySelector<HTMLElement>(".workspace-shell");
    const workspaceWasInert = workspace?.inert ?? false;
    const previousAriaHidden = workspace?.getAttribute("aria-hidden") ?? null;
    if (workspace) {
      workspace.inert = true;
      workspace.setAttribute("aria-hidden", "true");
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input == null) return;
      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (workspace) {
        workspace.inert = workspaceWasInert;
        if (previousAriaHidden == null) workspace.removeAttribute("aria-hidden");
        else workspace.setAttribute("aria-hidden", previousAriaHidden);
      }
      restoreExpandFocusRef.current = true;
    };
  }, [expanded]);

  useEffect(() => {
    if (expanded || !restoreExpandFocusRef.current) return;
    restoreExpandFocusRef.current = false;
    const focusFrame = window.requestAnimationFrame(() => expandButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [expanded]);

  /** 删除光标前仍处于编辑状态的 "@查询词"，并把光标收回删除位置。 */
  const removeActiveMentionQuery = useCallback(() => {
    sessionRef.current?.removeMentionQueryAtCaret();
  }, []);

  /** 在当前光标处插入引用 chip；无光标时追加到末尾。 */
  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      const input = inputRef.current;
      if (input == null) return;
      sessionRef.current?.insertReference(candidate);
      closeMenu();
      frontendLog(
        "info",
        `[canvas] @引用插入: node=${nodeKey}, asset=${candidate.name}（${candidate.assetId}）`,
      );
    },
    [closeMenu, nodeKey],
  );

  /** 输入过程中同步下拉过滤词：取最后一个 "@" 到光标之间的文本。 */
  const syncQueryFromCaret = useCallback(() => {
    if (!menuOpen) return;
    const caretQuery = sessionRef.current?.mentionQueryAtCaret();
    if (caretQuery == null) {
      closeMenu();
      return;
    }
    setQuery(caretQuery);
    setActiveIndex(0);
  }, [closeMenu, menuOpen]);

  const composingRef = useRef(false);
  const autoDetectTimerRef = useRef<number | null>(null);
  const feedbackResetTimerRef = useRef<number | null>(null);

  const confirmActiveAmbiguity = useCallback(
    (candidate: MentionCandidate, alias: string) => {
      const input = inputRef.current;
      if (input == null || activeAmbiguity == null) return;
      const confirmed =
        sessionRef.current?.confirmPending(activeAmbiguity.pattern, candidate, alias) ?? 0;
      if (confirmed === 0) {
        openFirstPendingAmbiguity();
        return;
      }
      if (autoDetectTimerRef.current != null) {
        window.clearTimeout(autoDetectTimerRef.current);
        autoDetectTimerRef.current = null;
      }
      if (feedbackResetTimerRef.current != null) {
        window.clearTimeout(feedbackResetTimerRef.current);
        feedbackResetTimerRef.current = null;
      }
      const hasMorePending = openFirstPendingAmbiguity();
      setAutoMentionFeedback(
        hasMorePending
          ? {
              kind: "ambiguous",
              message: `已确认 ${confirmed} 处为 ${alias} · 还有同名项待确认`,
            }
          : {
              kind: "success",
              message: `已确认 ${confirmed} 处为 ${alias} · 后续同名词自动沿用`,
            },
      );
      if (!hasMorePending) {
        feedbackResetTimerRef.current = window.setTimeout(() => {
          feedbackResetTimerRef.current = null;
          setAutoMentionFeedback(readyAutoMentionFeedback(candidates));
        }, AUTO_MENTION_FEEDBACK_MS);
      }
      input.focus();
      frontendLog(
        "info",
        `[canvas] 同名引用已确认: node=${nodeKey}, pattern=${activeAmbiguity.pattern}, target=${candidate.canvasNodeKey}, count=${confirmed}`,
      );
    },
    [activeAmbiguity, candidates, nodeKey, openFirstPendingAmbiguity],
  );

  /**
   * 扫描输入框纯文本，把已连线素材名（完整名/词干）原地转成引用 chip。
   * 粘贴与手动触发立即执行；手输走 scheduleAutoDetect 防抖。
   * 自动模式在 @ 候选菜单打开或 IME 组合中时跳过，避免干扰进行中的查询。
   */
  const runAutoDetect = useCallback(
    (manual: boolean) => {
      if (!manual && (menuOpen || composingRef.current)) return;
      const input = inputRef.current;
      if (input == null) return;
      if (autoDetectTimerRef.current != null) {
        window.clearTimeout(autoDetectTimerRef.current);
        autoDetectTimerRef.current = null;
      }
      if (feedbackResetTimerRef.current != null) {
        window.clearTimeout(feedbackResetTimerRef.current);
        feedbackResetTimerRef.current = null;
      }
      const resolution = sessionRef.current?.autoResolve({ fresh: true }) ?? {
        converted: 0,
        ambiguous: 0,
        pending: 0,
      };
      const promptText = (input.textContent ?? "").replaceAll("\u200b", "").trim();
      if (resolution.converted > 0 || resolution.ambiguous > 0) {
        const resolvedNames = sessionRef.current?.freshResolvedNames() ?? [];
        // 上面的合成 input 会安排下一轮扫描；本轮已经拿到确定结果，取消重复扫描。
        if (autoDetectTimerRef.current != null) {
          window.clearTimeout(autoDetectTimerRef.current);
          autoDetectTimerRef.current = null;
        }
        // 合成 input 会先触发 scheduleAutoDetect 并清空旧结果；因此必须在它之后
        // 写入本轮名称，才能让成功卡稳定展示“本次已绑定”的对象。
        setAutoMentionResolvedNames(resolvedNames);
        if (resolution.pending > 0) {
          openFirstPendingAmbiguity();
          setAutoMentionFeedback({
            kind: "ambiguous",
            message: `检测到 ${resolution.pending} 处同名引用 · 请选择具体对象`,
          });
        } else {
          setActiveAmbiguity(null);
          setAutoMentionFeedback({
            kind: "success",
            message: `已自动引用 ${resolution.converted} 处素材`,
          });
          feedbackResetTimerRef.current = window.setTimeout(() => {
            feedbackResetTimerRef.current = null;
            setAutoMentionFeedback(readyAutoMentionFeedback(candidates));
          }, AUTO_MENTION_FEEDBACK_MS);
        }
        frontendLog(
          "info",
          `[canvas] 提示词自动识别引用: node=${nodeKey}, 转换 ${resolution.converted} 处, 待确认 ${resolution.pending} 处`,
        );
        return;
      }

      setAutoMentionResolvedNames([]);
      if (resolution.pending > 0) {
        openFirstPendingAmbiguity();
        setAutoMentionFeedback({
          kind: "ambiguous",
          message: `仍有 ${resolution.pending} 处同名引用待确认`,
        });
      } else if (!promptText) {
        setAutoMentionFeedback(readyAutoMentionFeedback(candidates));
      } else if (candidates.length === 0) {
        setAutoMentionFeedback({ kind: "empty", message: "未连接素材，暂时无法自动引用" });
      } else {
        setAutoMentionFeedback({ kind: "no-match", message: "未匹配到已连接素材名" });
      }
    },
    [candidates, menuOpen, nodeKey, openFirstPendingAmbiguity],
  );

  /** 手输防抖：停止键入一段时间后扫描一次。 */
  const scheduleAutoDetect = useCallback(() => {
    if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
    if (feedbackResetTimerRef.current != null) {
      window.clearTimeout(feedbackResetTimerRef.current);
      feedbackResetTimerRef.current = null;
    }
    if (!menuOpen && !composingRef.current) {
      setAutoMentionResolvedNames([]);
      setAutoMentionFeedback({ kind: "scanning", message: "正在识别素材引用…" });
    }
    autoDetectTimerRef.current = window.setTimeout(() => {
      autoDetectTimerRef.current = null;
      runAutoDetect(false);
    }, PROMPT_AUTO_DETECT_DEBOUNCE_MS);
  }, [menuOpen, runAutoDetect]);

  /**
   * 手动重扫保留一个短暂但可感知的“扫描中”阶段；否则同步解析会让 React
   * 将 scanning 与最终结果合并成一次绘制，用户看起来就像按钮没有生效。
   */
  const runManualAutoDetect = useCallback(() => {
    if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
    if (feedbackResetTimerRef.current != null) {
      window.clearTimeout(feedbackResetTimerRef.current);
      feedbackResetTimerRef.current = null;
    }
    setAutoMentionResolvedNames([]);
    setAutoMentionFeedback({ kind: "scanning", message: "正在重新扫描已连接素材…" });
    autoDetectTimerRef.current = window.setTimeout(() => {
      autoDetectTimerRef.current = null;
      runAutoDetect(true);
    }, MANUAL_AUTO_DETECT_DELAY_MS);
  }, [runAutoDetect]);

  useEffect(
    () => () => {
      if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
      if (feedbackResetTimerRef.current != null) {
        window.clearTimeout(feedbackResetTimerRef.current);
      }
    },
    [],
  );

  // 连线集合变化时同步断线灰化态；如果同名待确认项只剩唯一在线候选，直接安全收敛。
  useEffect(() => {
    const input = inputRef.current;
    if (input == null) return;
    const currentCandidates = latestCandidatesRef.current;
    sessionRef.current?.updateConnections(currentCandidates);
    const pendingCount = sessionRef.current?.read().pendingCount ?? 0;
    if (pendingCount > 0) {
      openFirstPendingAmbiguity();
      setAutoMentionFeedback({
        kind: "ambiguous",
        message: `仍有 ${pendingCount} 处同名引用待确认`,
      });
    } else {
      setActiveAmbiguity(null);
      setAutoMentionResolvedNames([]);
      setAutoMentionFeedback(readyAutoMentionFeedback(currentCandidates));
    }
  }, [candidateConnectionSignature, openFirstPendingAmbiguity]);

  const autoMentionFeedbackIcon =
    autoMentionFeedback.kind === "scanning" ? (
      <CircleNotch size={12} weight="bold" className="spin-icon" aria-hidden="true" />
    ) : autoMentionFeedback.kind === "success" ? (
      <CheckCircle size={12} weight="fill" aria-hidden="true" />
    ) : autoMentionFeedback.kind === "ambiguous" || autoMentionFeedback.kind === "no-match" ? (
      <WarningCircle size={12} weight="bold" aria-hidden="true" />
    ) : (
      <Sparkle size={12} weight="fill" aria-hidden="true" />
    );

  const isProminentAutoMentionFeedback =
    autoMentionFeedback.kind === "success" ||
    autoMentionFeedback.kind === "ambiguous" ||
    autoMentionFeedback.kind === "no-match";
  const autoMentionFeedbackTitle =
    autoMentionFeedback.kind === "ready"
      ? "自动引用已开启"
      : autoMentionFeedback.kind === "scanning"
        ? "正在识别素材引用…"
        : autoMentionFeedback.kind === "success"
          ? "自动引用完成"
          : autoMentionFeedback.kind === "ambiguous"
            ? "发现同名素材，需要确认"
            : autoMentionFeedback.kind === "no-match"
              ? "没有识别到可绑定的素材"
              : "暂无可自动引用素材";
  const autoMentionFeedbackDetail =
    autoMentionFeedback.kind === "no-match"
      ? "提示词中没有出现已连接素材的名称。可使用下方任一名称，或点击 @ 手动选择。"
      : autoMentionFeedback.kind === "success"
        ? `${autoMentionFeedback.message}，已转换成高亮 @ 引用。`
        : autoMentionFeedback.kind === "ambiguous"
          ? `${autoMentionFeedback.message}。请选择具体对象后继续。`
          : autoMentionFeedback.message;

  const editor = (
    <div
      id={expanded ? editorId : undefined}
      className={`prompt-mention${expanded ? " is-expanded" : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-labelledby={expanded ? editorTitleId : undefined}
      aria-describedby={expanded ? editorDescriptionId : undefined}
      onKeyDown={(event) => {
        if (activeAmbiguity != null && event.key === "Escape") {
          event.preventDefault();
          setActiveAmbiguity(null);
          return;
        }
        if (!expanded || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          closeExpandedEditor();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          surfaceRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((element) => element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {expanded ? (
        <div
          className="prompt-mention__backdrop"
          aria-hidden="true"
          onMouseDown={closeExpandedEditor}
        />
      ) : null}
      <div ref={surfaceRef} className="prompt-mention__surface">
        {expanded ? (
          <div className="prompt-mention__expanded-header">
            <span className="prompt-mention__expanded-identity">
              <span className="prompt-mention__expanded-icon" aria-hidden="true">
                <CornersOut size={18} weight="bold" />
              </span>
              <span>
                <strong id={editorTitleId}>放大编辑提示词</strong>
                <small id={editorDescriptionId}>更大的编辑区域，内容实时保存到当前节点</small>
              </span>
            </span>
            <button
              type="button"
              className="prompt-mention__expanded-close"
              aria-label="关闭放大提示词编辑器"
              onClick={closeExpandedEditor}
            >
              <X size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className="prompt-mention__field">
          <div
            ref={attachInput}
            className="prompt-mention__editor"
            onInput={() => {
              const input = inputRef.current;
              // IME 组合期间不强制读取/同步编辑器 DOM：此时输入法仍持有未提交的
              // 候选拼音，提前 flush 会把组合文本错误提交成错乱字符。
              if (input != null && !composingRef.current) updatePromptSnapshot(input);
              syncQueryFromCaret();
              scheduleAutoDetect();
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              scheduleAutoDetect();
            }}
            onPaste={(event) => {
              // 统一替换为纯文本插入（换行转 <br>），随后立即识别素材引用；
              // 同时杜绝富文本 HTML 直接混入提示词。
              const text = event.clipboardData?.getData("text/plain") ?? "";
              event.preventDefault();
              const resolution = sessionRef.current?.pastePlainText(text);
              if (resolution?.pending) openFirstPendingAmbiguity();
              runAutoDetect(true);
            }}
            onClick={(event) => {
              const pending = sessionRef.current?.pendingAt(event.target) ?? null;
              if (pending != null) {
                openAmbiguityChip(pending);
              }
            }}
            onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const pending = sessionRef.current?.pendingAt(event.target) ?? null;
              if (pending != null && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
                openAmbiguityChip(pending);
                return;
              }
              if (activeAmbiguity != null && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setActiveAmbiguity(null);
                return;
              }
              if (menuOpen && filtered.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => (current + 1) % filtered.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => (current - 1 + filtered.length) % filtered.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const candidate = filtered[activeIndex] ?? filtered[0];
                  if (candidate) {
                    // 先移除已输入的 "@查询词"，再插入 chip。
                    removeActiveMentionQuery();
                    insertMention(candidate);
                    // 插入不产生原生 input 事件，补一次防抖扫描让其余命中文本也能转换。
                    scheduleAutoDetect();
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeMenu();
                  return;
                }
              }
              if (event.key === "@") {
                // 让 "@" 字符先落入输入框，再打开候选下拉。
                window.setTimeout(() => {
                  setActiveAmbiguity(null);
                  replaceTypedQueryOnSelectRef.current = true;
                  setMenuOpen(true);
                  setQuery("");
                  setActiveIndex(0);
                }, 0);
              }
            }}
          />
          <div className="prompt-mention__actions">
            {expandable && !expanded ? (
              <button
                ref={expandButtonRef}
                type="button"
                className="prompt-mention__expand"
                aria-label="放大编辑提示词"
                aria-haspopup="dialog"
                aria-controls={editorId}
                title="放大编辑提示词"
                onClick={() => {
                  const input = inputRef.current;
                  if (input == null) return;
                  updatePromptSnapshot(input);
                  closeMenu();
                  setExpanded(true);
                }}
              >
                <CornersOut size={14} weight="bold" aria-hidden="true" />
                <span>放大</span>
              </button>
            ) : null}
            <button
              type="button"
              className="prompt-mention__trigger prompt-mention__trigger--detect"
              aria-label="自动识别提示词中的素材引用"
              aria-describedby={autoMentionStatusId}
              aria-busy={autoMentionFeedback.kind === "scanning"}
              data-result={autoMentionFeedback.kind}
              title="立即重扫引用：把已连线素材名转成 @ 引用"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                closeMenu();
                runManualAutoDetect();
              }}
            >
              {autoMentionFeedback.kind === "scanning" ? (
                <CircleNotch size={12} weight="bold" className="spin-icon" aria-hidden="true" />
              ) : autoMentionFeedback.kind === "success" ? (
                <CheckCircle size={12} weight="fill" aria-hidden="true" />
              ) : autoMentionFeedback.kind === "no-match" ||
                autoMentionFeedback.kind === "ambiguous" ? (
                <WarningCircle size={12} weight="bold" aria-hidden="true" />
              ) : (
                <Sparkle size={12} weight="bold" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="prompt-mention__trigger"
              aria-label={`引用素材到提示词（候选 ${candidates.length} 个）`}
              title="引用素材"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const input = inputRef.current;
                if (input == null) return;
                input.focus();
                // 光标移动到末尾后打开下拉。
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                range.collapse(false);
                selection?.removeAllRanges();
                selection?.addRange(range);
                replaceTypedQueryOnSelectRef.current = false;
                setActiveAmbiguity(null);
                setMenuOpen((open) => !open);
                setQuery("");
                setActiveIndex(0);
              }}
            >
              @
            </button>
          </div>
          {menuOpen ? (
            <div className="prompt-mention__menu" role="listbox" aria-label="素材引用候选">
              {filtered.length === 0 ? (
                <span className="prompt-mention__empty">
                  没有匹配素材。先从素材库拖素材到画布并连线，或在素材库中确认名称。
                </span>
              ) : (
                filtered.map((candidate, index) => (
                  <button
                    key={`${candidate.assetId}-${candidate.canvasNodeKey}`}
                    type="button"
                    className={`prompt-mention__option${index === activeIndex ? " is-active" : ""}`}
                    role="option"
                    aria-label={`${candidate.name}，已连线，素材 ID ${candidate.assetId}，实例 ID ${candidate.canvasNodeKey}`}
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      if (replaceTypedQueryOnSelectRef.current) removeActiveMentionQuery();
                      insertMention(candidate);
                      // 与键盘选中一致：插入后补一次防抖扫描。
                      scheduleAutoDetect();
                    }}
                  >
                    <AssetKindIcon kind={candidate.kind} />
                    <span className="prompt-mention__option-name">{candidate.name}</span>
                    <span className="prompt-mention__option-tag">
                      {candidateAliases[
                        candidates.findIndex(
                          (entry) => entry.canvasNodeKey === candidate.canvasNodeKey,
                        )
                      ]?.label ?? "已连线"}
                      {` · ${candidate.canvasNodeKey.slice(-6)}`}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          {activeAmbiguity != null ? (
            <div
              className="prompt-ambiguity__menu"
              role="group"
              aria-label={`选择“${activeAmbiguity.displayName}”引用的具体素材`}
            >
              <div className="prompt-ambiguity__header">
                <span className="prompt-ambiguity__heading">
                  <WarningCircle size={14} weight="fill" aria-hidden="true" />
                  <span>
                    <strong>“{activeAmbiguity.displayName}”有同名对象</strong>
                    <small>选择一次，当前节点后续自动沿用</small>
                  </span>
                </span>
                <button
                  type="button"
                  className="prompt-ambiguity__close"
                  aria-label="暂时关闭同名素材选择器"
                  onClick={() => setActiveAmbiguity(null)}
                >
                  <X size={13} weight="bold" aria-hidden="true" />
                </button>
              </div>
              <div className="prompt-ambiguity__options" role="listbox">
                {ambiguityOptions.length === 0 ? (
                  <span className="prompt-ambiguity__unavailable">
                    候选素材已断开。请重新连线，或删除提示词中的待确认引用。
                  </span>
                ) : (
                  ambiguityOptions.map(({ candidate, alias }) => (
                    <button
                      key={candidate.canvasNodeKey}
                      type="button"
                      className="prompt-ambiguity__option"
                      role="option"
                      aria-selected={false}
                      aria-label={`选择 ${alias}：${candidate.name}，实例 ${candidate.canvasNodeKey.slice(-6)}`}
                      onClick={() => confirmActiveAmbiguity(candidate, alias)}
                    >
                      <span className="prompt-ambiguity__kind" aria-hidden="true">
                        <AssetKindIcon kind={candidate.kind} />
                      </span>
                      <span className="prompt-ambiguity__option-copy">
                        <strong>{candidate.name}</strong>
                        <small>实例 {candidate.canvasNodeKey.slice(-6)}</small>
                      </span>
                      <span className="prompt-ambiguity__alias">{alias}</span>
                      <Check size={14} weight="bold" aria-hidden="true" />
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div
          id={autoMentionStatusId}
          className={`prompt-mention__status is-${autoMentionFeedback.kind}${isProminentAutoMentionFeedback ? " is-prominent" : ""}`}
          role="status"
          aria-label={`自动引用状态：${autoMentionFeedbackTitle}。${autoMentionFeedbackDetail}`}
          aria-live="polite"
          aria-atomic="true"
          data-state={autoMentionFeedback.kind}
        >
          <span className="prompt-mention__status-icon" aria-hidden="true">
            {autoMentionFeedbackIcon}
          </span>
          <span className="prompt-mention__status-copy">
            <strong>{autoMentionFeedbackTitle}</strong>
            <small>{autoMentionFeedbackDetail}</small>
          </span>
          {autoMentionFeedback.kind === "no-match" && recognizableCandidates.length > 0 ? (
            <span className="prompt-mention__recognizable" aria-label="可自动识别的素材名称">
              <span className="prompt-mention__recognizable-label">可识别名称</span>
              {recognizableCandidates.map(({ candidate, alias }) => (
                <span
                  key={candidate.canvasNodeKey}
                  className="prompt-mention__recognizable-tag"
                  title={`${candidate.name}（也可输入 ${alias}）`}
                >
                  <strong>{candidate.name}</strong>
                  <small>{alias}</small>
                </span>
              ))}
              {candidates.length > recognizableCandidates.length ? (
                <span className="prompt-mention__recognizable-more">
                  +{candidates.length - recognizableCandidates.length}
                </span>
              ) : null}
            </span>
          ) : null}
          {autoMentionFeedback.kind === "success" && autoMentionResolvedNames.length > 0 ? (
            <span className="prompt-mention__resolved" aria-label="本次已绑定素材">
              {autoMentionResolvedNames.slice(0, 5).map((name) => (
                <span key={name}>@{name}</span>
              ))}
            </span>
          ) : null}
        </div>

        {expanded ? (
          <div className="prompt-mention__expanded-footer">
            <span>
              支持 <kbd>@</kbd> 引用已连素材 · 粘贴/输入素材名自动识别 · <kbd>Esc</kbd> 关闭
            </span>
            <span className="prompt-mention__character-count">{characterCount} 字</span>
            <button type="button" onClick={closeExpandedEditor}>
              完成
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );

  return expanded ? createPortal(editor, document.body) : editor;
}

export function ImageNodeSettings({
  config,
  providerCatalog,
  hasMediaInputs,
  onChange,
}: {
  readonly config: ImageNodeConfig;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly hasMediaInputs: boolean;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const operation: GenerationOperation = hasMediaInputs ? "image_to_image" : "text_to_image";
  const availableProviders = providerCatalog.filter(
    (entry) => entry.provider.enabled && entry.models.some(isImageGenerationModel),
  );
  const selectedProvider = availableProviders.find(
    (entry) => entry.provider.id === config.modelSelection.providerId,
  );
  const availableModels = selectedProvider?.models.filter(isImageGenerationModel) ?? [];
  const selectedModel = availableModels.find(
    (model) => model.definitionId === config.modelSelection.modelDefinitionId,
  );
  const selectedModelSupportsOperation = selectedModel?.operations.includes(operation) ?? false;
  const parameterCapabilities = selectedModelSupportsOperation
    ? modelParameterCapabilities(
        selectedModel!.operationSchema,
        operation,
        selectedModel!.remoteModelId,
      )
    : [];

  return (
    <div className="canvas-gen-node__settings" aria-label="图片生成参数">
      <div className="canvas-gen-node__operation" role="status" aria-live="polite">
        <span className="canvas-gen-node__operation-icon" aria-hidden="true">
          <ImageSquare size={16} weight="bold" />
        </span>
        <span className="canvas-gen-node__operation-copy">
          <strong>{operation === "image_to_image" ? "图片参考生成" : "文生图"}</strong>
          <small>
            {operation === "image_to_image"
              ? "已使用连入的图片或视频作为参考"
              : "连接参考图片或视频后自动切换"}
          </small>
        </span>
      </div>

      <label className="canvas-gen-node__field canvas-gen-node__field--provider">
        <span>供应商</span>
        <select
          value={config.modelSelection.providerId}
          onChange={(event) => {
            const providerId = event.target.value;
            const modelDefinitionId =
              availableProviders
                .find((entry) => entry.provider.id === providerId)
                ?.models.find((model) => model.operations.includes(operation))?.definitionId ?? "";
            onChange({
              ...config,
              modelSelection: { providerId, modelDefinitionId },
              parameterValues: {},
            });
          }}
        >
          {!config.modelSelection.providerId ? <option value="">请选择供应商</option> : null}
          {config.modelSelection.providerId && !selectedProvider ? (
            <option value={config.modelSelection.providerId}>
              {config.modelSelection.providerId}（不可用）
            </option>
          ) : null}
          {availableProviders.map((entry) => (
            <option key={entry.provider.id} value={entry.provider.id}>
              {entry.provider.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--count">
        <span>生成数量</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_GENERATION_COUNT}
          value={config.generationCount}
          onChange={(event) =>
            onChange({
              ...config,
              generationCount: parseGenerationCountInput(event.target.value),
            })
          }
        />
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--model">
        <span>图片模型</span>
        <select
          value={config.modelSelection.modelDefinitionId}
          onChange={(event) =>
            onChange({
              ...config,
              modelSelection: {
                ...config.modelSelection,
                modelDefinitionId: event.target.value,
              },
              parameterValues: {},
            })
          }
        >
          {!config.modelSelection.modelDefinitionId ? (
            <option value="">
              {availableModels.some((model) => model.operations.includes(operation))
                ? "请选择图片模型"
                : "没有支持当前操作的图片模型"}
            </option>
          ) : null}
          {config.modelSelection.modelDefinitionId && !selectedModel ? (
            <option value={config.modelSelection.modelDefinitionId}>
              {config.modelSelection.modelDefinitionId}（不可用）
            </option>
          ) : null}
          {availableModels.map((model) => (
            <option
              key={model.definitionId}
              value={model.definitionId}
              disabled={!model.operations.includes(operation)}
            >
              {model.displayName}
              {model.operations.includes(operation) ? "" : "（不支持当前操作）"}
            </option>
          ))}
        </select>
      </label>

      {parameterCapabilities.map((capability) => (
        <GenerationParameterField
          key={capability.key}
          capability={capability}
          value={resolvedParameterValue(capability, config.parameterValues)}
          hasMediaInputs={hasMediaInputs}
          onChange={(value) =>
            onChange({
              ...config,
              parameterValues: { ...config.parameterValues, [capability.key]: value },
            })
          }
        />
      ))}

      <NodePromptOptimizationSettings
        config={config}
        providerCatalog={providerCatalog}
        availableModes={IMAGE_PROMPT_OPTIMIZATION_MODES}
        defaultMode={IMAGE_PROMPT_OPTIMIZATION_DEFAULT_MODE}
        onChange={(optimization) => onChange({ ...config, promptOptimization: optimization })}
      />
    </div>
  );
}

function GenerationParameterField({
  capability,
  value,
  hasMediaInputs,
  onChange,
}: {
  readonly capability: ModelParameterCapability;
  readonly value: ModelParameterValue;
  readonly hasMediaInputs: boolean;
  readonly onChange: (value: ModelParameterValue) => void;
}) {
  const disabled = capability.requiresNoMedia && hasMediaInputs;
  if (capability.type === "boolean") {
    const checked = !disabled && value === true;
    return (
      <label className="canvas-gen-node__field canvas-gen-node__field--half">
        <span>{capability.label}</span>
        <span className="canvas-gen-node__toggle-control">
          <input
            type="checkbox"
            aria-label={capability.label}
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span aria-hidden="true">{disabled ? "需无媒体输入" : checked ? "开启" : "关闭"}</span>
        </span>
      </label>
    );
  }

  if (capability.options.length > 0) {
    return (
      <label className="canvas-gen-node__field canvas-gen-node__field--half">
        <span>{capability.label}</span>
        <select
          value={String(value)}
          onChange={(event) => {
            const selected = capability.options.find(
              (option) => String(option.value) === event.target.value,
            );
            if (selected) onChange(selected.value);
          }}
        >
          {capability.options.map((option) => (
            <option key={`${capability.key}-${String(option.value)}`} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const numeric = capability.type === "integer" || capability.type === "number";
  return (
    <label className="canvas-gen-node__field canvas-gen-node__field--half">
      <span>{capability.label}</span>
      <input
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "numeric" : "text"}
        min={capability.minimum}
        max={capability.maximum}
        step={capability.step ?? (capability.type === "integer" ? 1 : undefined)}
        placeholder={capability.optional ? "随机" : undefined}
        value={String(value)}
        onChange={(event) => {
          if (!numeric) {
            onChange(event.target.value);
            return;
          }
          if (event.target.value === "") {
            onChange("");
            return;
          }
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

export function VideoNodeSettings({
  config,
  providerCatalog,
  hasMediaInputs,
  onChange,
}: {
  readonly config: VideoNodeConfig;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly hasMediaInputs: boolean;
  readonly onChange: (config: VideoNodeConfig) => void;
}) {
  const availableProviders = providerCatalog.filter(
    (entry) =>
      entry.provider.enabled &&
      entry.models.some((model) => supportsGenerationNode(model, "video")),
  );
  const selectedProvider = availableProviders.find(
    (entry) => entry.provider.id === config.modelSelection.providerId,
  );
  const availableModels =
    selectedProvider?.models.filter((model) => supportsGenerationNode(model, "video")) ?? [];
  const selectedModel = availableModels.find(
    (model) => model.definitionId === config.modelSelection.modelDefinitionId,
  );
  const parameterCapabilities = selectedModel
    ? modelParameterCapabilities(
        selectedModel.operationSchema,
        "video_generation",
        selectedModel.remoteModelId,
      )
    : [];

  return (
    <div className="canvas-gen-node__settings" aria-label="视频生成参数">
      <div className="canvas-gen-node__operation" role="status" aria-live="polite">
        <span className="canvas-gen-node__operation-icon" aria-hidden="true">
          <VideoCamera size={16} weight="bold" />
        </span>
        <span className="canvas-gen-node__operation-copy">
          <strong>{hasMediaInputs ? "参考素材生成" : "文生视频"}</strong>
          <small>{hasMediaInputs ? "已使用直连或随提示词继承的素材" : "连接素材后自动切换"}</small>
        </span>
      </div>

      <label className="canvas-gen-node__field canvas-gen-node__field--provider">
        <span>供应商</span>
        <select
          value={config.modelSelection.providerId}
          onChange={(event) => {
            const providerId = event.target.value;
            const modelDefinitionId =
              availableProviders
                .find((entry) => entry.provider.id === providerId)
                ?.models.find((model) => supportsGenerationNode(model, "video"))?.definitionId ??
              "";
            onChange({
              ...config,
              modelSelection: { providerId, modelDefinitionId },
              parameterValues: {},
            });
          }}
        >
          {!config.modelSelection.providerId ? <option value="">请选择供应商</option> : null}
          {config.modelSelection.providerId && !selectedProvider ? (
            <option value={config.modelSelection.providerId}>
              {config.modelSelection.providerId}（不可用）
            </option>
          ) : null}
          {availableProviders.map((entry) => (
            <option key={entry.provider.id} value={entry.provider.id}>
              {entry.provider.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--count">
        <span>生成数量</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_GENERATION_COUNT}
          value={config.generationCount}
          onChange={(event) =>
            onChange({
              ...config,
              generationCount: parseGenerationCountInput(event.target.value),
            })
          }
        />
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--model">
        <span>视频模型</span>
        <select
          value={config.modelSelection.modelDefinitionId}
          onChange={(event) =>
            onChange({
              ...config,
              modelSelection: {
                ...config.modelSelection,
                modelDefinitionId: event.target.value,
              },
              parameterValues: {},
            })
          }
        >
          {!config.modelSelection.modelDefinitionId ? (
            <option value="">请选择视频模型</option>
          ) : null}
          {config.modelSelection.modelDefinitionId && !selectedModel ? (
            <option value={config.modelSelection.modelDefinitionId}>
              {config.modelSelection.modelDefinitionId}（不可用）
            </option>
          ) : null}
          {availableModels.map((model) => (
            <option key={model.definitionId} value={model.definitionId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>

      {parameterCapabilities.map((capability) => (
        <GenerationParameterField
          key={capability.key}
          capability={capability}
          value={resolvedParameterValue(capability, config.parameterValues)}
          hasMediaInputs={hasMediaInputs}
          onChange={(value) =>
            onChange({
              ...config,
              parameterValues: { ...config.parameterValues, [capability.key]: value },
            })
          }
        />
      ))}

      <NodePromptOptimizationSettings
        config={config}
        providerCatalog={providerCatalog}
        availableModes={VIDEO_PROMPT_OPTIMIZATION_MODES}
        defaultMode={VIDEO_PROMPT_OPTIMIZATION_DEFAULT_MODE}
        onChange={(optimization) => onChange({ ...config, promptOptimization: optimization })}
      />
    </div>
  );
}

/**
 * 图片/视频生成节点共用的提示词优化设置：开关、技能模式与所接入的文本大模型。
 * 只使用在全局设置里配置为「文本模型」的模型（text_generation），
 * 防止误选图片/视频模型导致请求格式不匹配。
 */
function NodePromptOptimizationSettings({
  config,
  providerCatalog,
  availableModes,
  defaultMode,
  onChange,
}: {
  readonly config: {
    readonly promptOptimization?: NodePromptOptimizationConfig | null;
  };
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly availableModes: readonly PromptOptimizationMode[];
  readonly defaultMode: PromptOptimizationMode;
  readonly onChange: (optimization: NodePromptOptimizationConfig) => void;
}) {
  const optimization: NodePromptOptimizationConfig = config.promptOptimization ?? {
    enabled: false,
    mode: defaultMode,
    providerId: "",
    modelDefinitionId: "",
  };
  const textModelProviders = providerCatalog
    .map((entry) => ({
      provider: entry.provider,
      models: entry.models.filter(isTextGenerationModel),
    }))
    .filter((entry) => entry.provider.enabled && entry.models.length > 0);
  const selectedTextProvider = textModelProviders.find(
    (entry) => entry.provider.id === optimization.providerId,
  );
  const selectedTextModel =
    selectedTextProvider?.models.find(
      (model) => model.definitionId === optimization.modelDefinitionId,
    ) ?? null;
  const updateOptimization = (patch: Partial<NodePromptOptimizationConfig>) => {
    onChange({ ...optimization, ...patch });
  };
  const enableOptimization = (enabled: boolean) => {
    // 开启时若尚未选择（或选择已失效），直接应用第一个可用的文本模型。
    if (
      enabled &&
      (!optimization.providerId ||
        !optimization.modelDefinitionId ||
        !textModelProviders.some(
          (entry) =>
            entry.provider.id === optimization.providerId &&
            entry.models.some((model) => model.definitionId === optimization.modelDefinitionId),
        ))
    ) {
      const fallback = firstTextModelSelection(providerCatalog);
      updateOptimization({ enabled, ...fallback });
      return;
    }
    updateOptimization({ enabled });
  };

  return (
    <>
      <div className="canvas-gen-node__opt-toggle">
        <label className="canvas-gen-node__opt-toggle-label">
          <input
            type="checkbox"
            checked={optimization.enabled}
            onChange={(event) => enableOptimization(event.target.checked)}
          />
          <span>提示词优化</span>
        </label>
        <span
          className="canvas-gen-node__opt-toggle-hint"
          title="开启后自动应用已配置的文本模型，按所选提示词技能规范优化提示词"
        >
          {optimization.enabled
            ? `已开启 · ${PROMPT_OPTIMIZATION_MODE_LABELS[optimization.mode]}`
            : "提示词技能加持"}
        </span>
      </div>

      <label className="canvas-gen-node__field canvas-gen-node__field--model">
        <span>优化模式</span>
        <select
          value={optimization.mode}
          onChange={(event) =>
            updateOptimization({
              mode: event.target.value as PromptOptimizationMode,
            })
          }
        >
          {(Object.keys(PROMPT_OPTIMIZATION_MODE_LABELS) as PromptOptimizationMode[])
            .filter((mode) => availableModes.includes(mode))
            .map((mode) => (
              <option key={mode} value={mode}>
                {PROMPT_OPTIMIZATION_MODE_LABELS[mode]}
              </option>
            ))}
        </select>
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--provider">
        <span>优化文本模型供应商</span>
        <select
          value={optimization.providerId}
          onChange={(event) => {
            const providerId = event.target.value;
            const modelDefinitionId =
              textModelProviders.find((entry) => entry.provider.id === providerId)?.models[0]
                ?.definitionId ?? "";
            updateOptimization({ providerId, modelDefinitionId });
          }}
        >
          {!optimization.providerId ? <option value="">请选择供应商</option> : null}
          {optimization.providerId && !selectedTextProvider ? (
            <option value={optimization.providerId}>{optimization.providerId}（不可用）</option>
          ) : null}
          {textModelProviders.map((entry) => (
            <option key={entry.provider.id} value={entry.provider.id}>
              {entry.provider.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="canvas-gen-node__field canvas-gen-node__field--model">
        <span>优化文本模型</span>
        <select
          value={optimization.modelDefinitionId}
          onChange={(event) => updateOptimization({ modelDefinitionId: event.target.value })}
        >
          {!optimization.modelDefinitionId ? <option value="">请选择文本模型</option> : null}
          {optimization.modelDefinitionId && !selectedTextModel ? (
            <option value={optimization.modelDefinitionId}>
              {optimization.modelDefinitionId}（不可用）
            </option>
          ) : null}
          {selectedTextProvider?.models.map((model) => (
            <option key={model.definitionId} value={model.definitionId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** 原提示词与优化后提示词的差异高亮对比：删除部分红色、新增部分绿色。 */
function PromptDiffView({
  original,
  optimized,
  originalLabel = "原提示词",
  optimizedLabel = "优化后",
  ariaLabel = "提示词优化对比",
}: {
  readonly original: string;
  readonly optimized: string;
  readonly originalLabel?: string;
  readonly optimizedLabel?: string;
  readonly ariaLabel?: string;
}) {
  const { originalRuns, optimizedRuns } = useMemo(
    () => diffPromptRuns(original, optimized),
    [original, optimized],
  );
  return (
    <div className="prompt-opt-diff" aria-label={ariaLabel}>
      <div className="prompt-opt-diff__pane">
        <span className="prompt-opt-diff__label">{originalLabel}</span>
        <div className="prompt-opt-diff__text">
          {originalRuns.map((run, index) =>
            run.type === "removed" ? (
              <mark key={index} className="prompt-opt-diff__mark prompt-opt-diff__mark--removed">
                {run.text}
              </mark>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </div>
      </div>
      <div className="prompt-opt-diff__pane">
        <span className="prompt-opt-diff__label">{optimizedLabel}</span>
        <div className="prompt-opt-diff__text">
          {optimizedRuns.map((run, index) =>
            run.type === "added" ? (
              <mark key={index} className="prompt-opt-diff__mark prompt-opt-diff__mark--added">
                {run.text}
              </mark>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 视频节点的提示词优化面板：发起优化、展示进行中/错误状态、
 * 优化完成后对比差异并选择采用 / 不采用 / 继续细节优化。
 */
export function PromptOptimizationPanel({
  state,
  onStart,
  onAdopt,
  onDiscard,
}: {
  readonly state: PromptOptimizationPanelState | undefined;
  readonly onStart: (detailReview: boolean) => void;
  readonly onAdopt: () => void;
  readonly onDiscard: () => void;
}) {
  const busy = state?.status === "running";
  return (
    <div className="prompt-opt-panel" aria-label="提示词优化">
      <div className="prompt-opt-panel__toolbar">
        <button
          type="button"
          className="prompt-opt-panel__start"
          disabled={busy}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStart(false);
          }}
        >
          {busy ? (
            <CircleNotch size={13} weight="bold" aria-hidden="true" className="spin-icon" />
          ) : (
            <Sparkle size={13} weight="fill" aria-hidden="true" />
          )}
          {busy ? "优化中…" : "优化提示词"}
        </button>
        {state && state.round > 0 ? (
          <span className="prompt-opt-panel__round">
            {state.detail ? `细节审查 · 第 ${state.round} 轮` : `已优化 ${state.round} 轮`}
          </span>
        ) : null}
      </div>

      {state?.status === "running" ? (
        <p className="prompt-opt-panel__status">
          <CircleNotch size={13} weight="bold" aria-hidden="true" className="spin-icon" />
          {state.detail
            ? "正在严格审查提示词是否符合技能规范…"
            : "正在按提示词技能优化提示词，完成前生成按钮暂不可用…"}
        </p>
      ) : null}

      {state?.status === "error" ? (
        <div className="prompt-opt-panel__error">
          <p>{state.error ?? "提示词优化失败。"}</p>
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onStart(state.detail);
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      {state?.status === "done" && state.optimizedPrompt ? (
        <div className="prompt-opt-panel__result">
          <PromptDiffView original={state.originalPrompt} optimized={state.optimizedPrompt} />
          <div className="prompt-opt-panel__actions">
            <button
              type="button"
              className="prompt-opt-panel__adopt"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAdopt();
              }}
            >
              采用
            </button>
            <button
              type="button"
              className="prompt-opt-panel__discard"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDiscard();
              }}
            >
              不采用
            </button>
            <button
              type="button"
              className="prompt-opt-panel__detail"
              title="把之前所有上下文注入系统提示词，严格审查当前提示词是否符合技能规范的最优版本"
              disabled={busy}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onStart(true);
              }}
            >
              细节优化
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 独立提示词节点的多轮审计面板：展示 Diff，并要求用户确认是否应用建议。 */
export function PromptAuditPanel({
  state,
  onAudit,
  onApply,
  onDiscard,
  subject = "提示词",
  originalLabel = "当前输出",
  optimizedLabel = "审计建议",
}: {
  readonly state: PromptOptimizationPanelState | undefined;
  readonly onAudit: () => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly subject?: string;
  readonly originalLabel?: string;
  readonly optimizedLabel?: string;
}) {
  const busy = state?.status === "running";
  return (
    <div className="canvas-prompt-node__audit-panel" aria-label={`${subject}审计结果`}>
      {state?.round ? (
        <div className="canvas-prompt-node__audit-heading">
          <span>第 {state.round} 轮审计</span>
          {state.status === "done" ? <small>请确认是否应用审计建议</small> : null}
        </div>
      ) : null}

      {state?.status === "running" ? (
        <div className="canvas-prompt-node__audit-status" role="status" aria-live="polite">
          <CircleNotch size={14} weight="bold" aria-hidden="true" className="spin-icon" />
          正在载入完整技能与全部对话上下文并审计当前{subject}…
        </div>
      ) : null}

      {state?.status === "error" ? (
        <div className="canvas-prompt-node__audit-error" role="alert">
          <span>{state.error ?? `${subject}审计失败。`}</span>
          <button
            type="button"
            disabled={busy}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onAudit();
            }}
          >
            重试审计
          </button>
        </div>
      ) : null}

      {state?.status === "done" && state.optimizedPrompt ? (
        <div className="canvas-prompt-node__audit-result">
          <PromptDiffView
            original={state.originalPrompt}
            optimized={state.optimizedPrompt}
            originalLabel={originalLabel}
            optimizedLabel={optimizedLabel}
            ariaLabel={`${subject}审计差异对比`}
          />
          <div className="canvas-prompt-node__audit-actions">
            <button
              type="button"
              className="canvas-prompt-node__audit-apply"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onApply();
              }}
            >
              应用审计结果
            </button>
            <button
              type="button"
              className="canvas-prompt-node__audit-discard"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDiscard();
              }}
            >
              保留当前输出
            </button>
            <button
              type="button"
              className="canvas-prompt-node__audit-again"
              disabled={busy}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAudit();
              }}
            >
              再次审计
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
