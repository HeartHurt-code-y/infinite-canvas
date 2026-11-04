import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { Icon, type IconSize } from "../../components/Icon";
import { CanvasSelect } from "../../components/CanvasSelect";
import { compileCanvasVideoMode } from "../../lib/canvasVideoMode";
import { ErrorAlert } from "../../components/ErrorAlert";
import { localBase64AssetClient } from "../../lib/backend";
import {
  ingestPromptAttachments,
  type PromptAttachmentIngestReport,
} from "../../lib/promptAttachments";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PromptFloatingMenu } from "./promptFloatingMenu";
import "./PromptEditor.css";
import {
  frontendLog,
  refreshMediaUrlWithStagingFallback,
  type GenerationOperation,
  type ProviderCatalogEntry,
} from "../../lib/backend";
import {
  isFzyVideoSchema,
  isMinimaxH3VideoModel,
  isWan30VideoModel,
  modelParameterCapabilities,
  resolvedParameterValue,
  wanMediaRolesForKind,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import {
  resolveSeedanceTask,
  seedanceTaskInputs,
} from "../../lib/seedanceTasks";
import {
  perTaskVideoProfile,
  perTaskVideoUrlIssue,
  type PerTaskVideoProfile,
  type PerTaskVideoUrlInput,
} from "../../lib/perTaskVideo";
import {
  createPromptContentEditorSession,
  describePromptContentCandidates,
  PROMPT_AUTO_DETECT_DEBOUNCE_MS,
  type PromptContentEditorSession,
  type PromptMarkReferenceInput,
} from "../../lib/promptContent";
import { normalizePromptReferenceText } from "../../lib/promptReferences";
import { useMediaByteSource } from "./mediaByteCache";
import { VideoMiddleFrame } from "./VideoMiddleFrame";
import { isVideoSourceUrl } from "./mediaPreview";
import { WhiteModelControlSection } from "./WhiteModelControlSection";
import { GreenScreenSection, type GreenScreenResult } from "./GreenScreenSection";
import { resolveGreenScreen } from "../../lib/greenScreen";
import { supportsSeedanceDraft } from "../../lib/seedanceDraft";
import { CanvasVideoSettings } from "./CanvasVideoSettings";
import { CanvasImageSettings, CanvasImageParameterOptions, canvasImageHasOptionButtons } from "./CanvasImageSettings";

import type {
  AssetKind,
  ConnectedAssetInput,
  ImageNodeConfig,
  InheritedAssetInput,
  MentionCandidate,
  RepositoryNodeKind,
  VideoNodeConfig,
  VideoUrlMediaInput,
} from "./workspaceModel";
import {
  MAX_GENERATION_COUNT,
  isImageGenerationModel,
  parseGenerationCountInput,
  supportsGenerationNode,
} from "./workspaceModel";

export function AssetKindIcon({
  kind,
  size = "md",
}: {
  readonly kind: AssetKind | "text";
  readonly size?: IconSize;
}) {
  if (kind === "text") return <Icon name="file-text" size={size} />;
  if (kind === "image") return <Icon name="image-square" size={size} />;
  if (kind === "video") return <Icon name="video-camera" size={size} />;
  return <Icon name="waveform" size={size} />;
}

/** @ 候选缩略图：自动适应原始媒体宽高比，完整显示不裁剪；视频取中间帧作封面。 */
function MentionOptionThumb({ candidate }: { readonly candidate: MentionCandidate }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // 云端素材签名过期时续签一次得到的新地址；未刷新时用候选携带的原始地址。
  const [refreshedUrl, setRefreshedUrl] = useState<string | null>(null);
  const refreshAttemptedRef = useRef(false);
  const preview = refreshedUrl ?? candidate.previewUrl ?? null;
  // 已下载过的素材直接复用会话内字节：候选面板反复开关、同一素材被多个节点引用时都不再重复下载。
  const previewBytes = useMediaByteSource(candidate.assetId, candidate.kind, preview);
  const resolvedPreview = previewBytes.url ?? preview;
  const failed = resolvedPreview != null && failedUrl === resolvedPreview;
  const videoSource =
    candidate.kind === "video" && isVideoSourceUrl(resolvedPreview) ? resolvedPreview : null;
  const showVideo = videoSource != null && !failed;
  const imageSource =
    videoSource == null && resolvedPreview != null && !failed && candidate.kind !== "audio"
      ? resolvedPreview
      : null;
  // 宽高比与来源地址一起记忆：封面续签换地址后旧比例立即失效。
  const [measured, setMeasured] = useState<{ url: string; ratio: number } | null>(null);
  const aspectRatio = measured != null && measured.url === resolvedPreview ? measured.ratio : null;

  const handleImageError = () => {
    setFailedUrl(resolvedPreview);
    // 当前地址加载失败：本地副本坏了就重下一次，远端地址失败则先在本地字节里找一次。
    previewBytes.retry();
    if (previewBytes.fromCache) return;
    if (preview == null || refreshAttemptedRef.current) return;
    if (candidate.source === "cloud" && candidate.providerConnectionId === "") return;
    refreshAttemptedRef.current = true;
    // 云端素材回读供应商记录、本地素材重签对象存储地址；上游把导入时的暂存租约地址当
    // 预览地址回放时续签不会换地址，共享入口会继续按对象键重签暂存副本。
    void refreshMediaUrlWithStagingFallback(
      {
        id: candidate.assetId,
        source: candidate.source,
        providerConnectionId: candidate.providerConnectionId,
      },
      candidate.kind,
      preview,
    ).then((freshUrl) => {
      if (freshUrl != null && freshUrl !== "" && freshUrl !== preview) {
        setRefreshedUrl(freshUrl);
        setFailedUrl(null);
      }
    });
  };

  const measure = (url: string, ratio: number) => {
    if (Number.isFinite(ratio) && ratio > 0) setMeasured({ url, ratio });
  };

  // 限制最大宽度，避免宽图占用过多空间；高度固定为 2.75rem
  const maxWidth = "8rem";
  const thumbStyle =
    aspectRatio != null
      ? { width: `min(${maxWidth}, calc(2.75rem * ${aspectRatio}))`, aspectRatio: `${aspectRatio}` }
      : undefined;
  const fallback = !showVideo && imageSource == null;

  return (
    <span
      className={`prompt-mention__thumb prompt-mention__thumb--auto-size${
        fallback ? " prompt-mention__thumb--fallback" : ""
      }`}
      style={thumbStyle}
      aria-hidden="true"
    >
      {showVideo ? (
        <VideoMiddleFrame
          src={videoSource}
          eager
          placeholder={<AssetKindIcon kind="video" size="xl" />}
          onAspectRatioChange={(ratio) => measure(videoSource, ratio)}
          onLoadError={() => setFailedUrl(videoSource)}
        />
      ) : imageSource != null ? (
        <img
          src={imageSource}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onError={handleImageError}
          onLoad={(event) => {
            const image = event.currentTarget;
            measure(imageSource, image.naturalWidth / image.naturalHeight);
          }}
        />
      ) : (
        <AssetKindIcon kind={candidate.kind} size="xl" />
      )}
    </span>
  );
}

export function NodeTypeIcon({
  kind,
  size = 14,
}: {
  readonly kind: RepositoryNodeKind | "result";
  readonly size?: number;
}) {
  const iconProps = { size, weight: "bold" as const, "aria-hidden": true };

  if (kind === "image") return <Icon name="image-square" {...iconProps} size="md" />;
  if (kind === "video") return <Icon name="video-camera" {...iconProps} size="md" />;
  if (kind === "prompt") return <Icon name="sparkle" {...iconProps} size="md" />;
  if (kind === "screenplay") return <Icon name="book-open-text" {...iconProps} size="md" />;
  if (kind === "viral_remix") return <Icon name="film-strip" {...iconProps} size="md" />;
  if (kind === "video_downloader") return <Icon name="download-simple" {...iconProps} size="md" />;
  return <Icon name="folder-open" {...iconProps} size="md" />;
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

function readyAutoMentionFeedback(
  candidates: readonly MentionCandidate[],
  referenceCount = 0,
): AutoMentionFeedback {
  if (candidates.length === 0) {
    return { kind: "empty", message: "连接素材后，输入 @ 选择引用" };
  }
  // 已引用数是「识别到了」的常驻回执：提示内容被外部写入（弹窗「添加到生成节点」）
  // 时不会有别的反馈，只写「普通文字保持原样」会让人以为一处都没认出来。
  const bound = referenceCount > 0 ? `已引用 ${referenceCount} 处素材 · ` : "";
  const ambiguousCount = describePromptContentCandidates(candidates).ambiguousPatternCount;
  if (ambiguousCount > 0) {
    return {
      kind: "ready",
      message: `输入 @ 或选素材名引用 · ${bound}${candidates.length} 个素材 · 同名项需确认`,
    };
  }
  return {
    kind: "ready",
    message: `输入 @ 或选素材名引用 · ${bound}${candidates.length} 个可引用素材`,
  };
}

/**
 * 生成节点内的提示词输入框：Tiptap 管理编辑态，V1 canonical document 管理持久化。
 * - 输入 "@" 或点击 "@" 按钮弹出当前已连接素材的候选下拉；
 * - 选中后由提示内容 adapter 插入 Tiptap 原子引用节点；
 * - canonical document、结构化持久化与冻结提交均由提示内容 module 负责。
 */
/**
 * @ 下拉的统一候选：连线素材，或画面上的区域标注。
 * 两者共用同一个下拉与同一套键盘导航，避免为了非素材引用再造一个菜单。
 */
type MentionMenuEntry =
  | { readonly type: "media"; readonly candidate: MentionCandidate }
  | { readonly type: "annotation"; readonly annotation: PromptMarkReferenceInput };

/** 本次输入里是否插入了引用标记：半角 "@" 与输入法常用的全角 "＠"。 */
const MENTION_MARKER_IN_TEXT = /[@\uff20]/u;

export function PromptMentionInput({
  nodeKey,
  candidates,
  annotationMentions,
  aliveCanvasNodeKeys,
  registerInput,
  labelledBy,
  describedBy,
  expandable = false,
  onTextChange,
  placeholder,
  onSession,
  autoLink = false,
  leadingContent,
}: {
  readonly nodeKey: string;
  /** 仅包含已连接到当前生成节点的素材实例。 */
  readonly candidates: readonly MentionCandidate[];
  /** 额外的非素材引用候选（如视频局部编辑的区域标注）；缺省时菜单与今天完全一致。 */
  readonly annotationMentions?: readonly PromptMarkReferenceInput[];
  /**
   * 画布上仍然存在的节点 key。用来区分「素材节点被删掉」与「只是解除连线」：
   * 前者按同源/同名素材自愈重连引用，后者保持灰化等用户决定。缺省时不做自愈。
   */
  readonly aliveCanvasNodeKeys?: ReadonlySet<string> | undefined;
  readonly registerInput: (nodeKey: string, session: PromptContentEditorSession | null) => void;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly expandable?: boolean;
  /** 内容变化时的回调，传递纯文本（用于外部持久化，如提示词生成节点的 generatedPrompt）。 */
  readonly onTextChange?: (text: string) => void;
  /** 空内容占位文案；缺省时使用提示词输入框的默认文案。仅在首次挂载时生效。 */
  readonly placeholder?: string;
  /**
   * 编辑会话的出口。
   *
   * 生成节点的编辑层里，参考瓦片上的「@」按钮要往提示词里插引用（原站
   * liblib 的 @ 就在瓦片上，不在提示词区），而会话由本组件创建——通过这个
   * 回调把会话交给上层，瓦片才能调用 `insertReference`。
   */
  readonly onSession?: ((session: PromptContentEditorSession | null) => void) | undefined;
  readonly autoLink?: boolean;
  /** 视觉前缀不进入提示词文档，不参与复制、撤销或引用解析。 */
  readonly leadingContent?: ReactNode;
}) {
  const inputRef = useRef<HTMLDivElement | null>(null);
  const [promptSession] = useState(() => createPromptContentEditorSession(candidates, placeholder));
  useLayoutEffect(() => { promptSession.setPlaceholder(placeholder); }, [promptSession, placeholder]);
  const sessionRef = useRef(promptSession);
  useEffect(() => {
    onSession?.(promptSession);
    return () => onSession?.(null);
  }, [onSession, promptSession]);
  /** 附件摄取的用户可见结果：失败与被忽略文件各给一句人话和补救动作。 */
  const [attachmentNotice, setAttachmentNotice] = useState<{
    readonly message: string;
    readonly hint: string;
  } | null>(null);
  // 粘贴/拖拽共用的摄取：扩展名口径、临时文件与素材导入都在
  // lib/promptAttachments；这里只接线，并把结果翻译成用户能读懂的提示。
  const ingestAttachmentFiles = useCallback(async (files: readonly File[]) => {
    setAttachmentNotice(null);
    let report: PromptAttachmentIngestReport;
    try {
      report = await ingestPromptAttachments(files, {
        saveTempFile: async (fileName, bytes) => {
          const directory = await join(await appDataDir(), "prompt-attachments");
          await mkdir(directory, { recursive: true }).catch(() => {});
          const tempPath = await join(directory, `${globalThis.crypto.randomUUID()}-${fileName}`);
          await writeFile(tempPath, bytes);
          return tempPath;
        },
        importLocalAsset: (command) => localBase64AssetClient.importAsset(command),
        deleteFile: (path) => remove(path),
      });
    } catch {
      setAttachmentNotice({
        message: "附件读取失败，这次没有文件被导入。",
        hint: "请重新粘贴或选择文件再试一次；仍失败可先把文件保存到本机再拖入。",
      });
      return;
    }
    if (report.attachments.length > 0) sessionRef.current?.insertAttachments(report.attachments);
    if (report.failed.length > 0) {
      setAttachmentNotice({
        message: `${report.failed.join("、")} 导入失败，其余文件已正常插入。`,
        hint: "请单独重试这个文件；仍失败可先在素材库上传，再把素材节点连到本节点。",
      });
    } else if (report.skipped.length > 0) {
      setAttachmentNotice({
        message: `已忽略不支持的文件：${report.skipped.join("、")}。`,
        hint: "提示词附件目前支持图片、视频和音频；文档类资料请放进节点的通用参考素材。",
      });
    }
  }, []);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreExpandFocusRef = useRef(false);
  const replaceTypedQueryOnSelectRef = useRef(false);
  /** 组合结束后补判一次候选菜单的定时器。 */
  const mentionSyncTimerRef = useRef<number | null>(null);
  // 跟踪最后一次 mousedown 的目标，用于判断 blur 是否由拖拽节点/点击下拉栏触发
  const lastMouseDownTargetRef = useRef<EventTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [characterCount, setCharacterCount] = useState(0);
  const [activeAmbiguity, setActiveAmbiguity] = useState<{
    readonly pattern: string;
    readonly displayName: string;
  } | null>(null);
  /** 识别按钮的短暂状态与读屏反馈；不再渲染常驻状态面板。 */
  const [autoMentionFeedbackState, setAutoMentionFeedbackState] = useState<AutoMentionFeedback>(
    () => readyAutoMentionFeedback(candidates),
  );
  /** 提示内容里已绑定的引用数：它是「@ 有没有被识别到」的直接证据，用于读屏反馈。 */
  const [referenceCount, setReferenceCount] = useState(0);
  /**
   * 回到常驻提示。文案不在这里定：常驻提示的数字必须跟着当前连线与内容走，
   * 而防抖/复位计时器闭包住的是"调度那一刻"的候选（连线刚变化时还是旧的），
   * 由它们写文案会让灰条长期停在过期的候选数上
   * ——节点已接 2 个素材，却一直显示「1 个可引用素材」。
   */
  const showReadyFeedback = useCallback(() => {
    setAutoMentionFeedbackState({ kind: "ready", message: "" });
  }, []);
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
      // 挂载/放大重挂时同步一次已引用数：存档恢复出来的内容不会产生 input 事件。
      setReferenceCount(sessionRef.current?.read().referenceCount ?? 0);
      registerInput(nodeKey, host == null ? null : sessionRef.current);
    },
    [describedBy, editorDescriptionId, expanded, labelledBy, nodeKey, registerInput],
  );

  const candidateDescription = useMemo(
    () => describePromptContentCandidates(candidates, activeAmbiguity?.pattern),
    [activeAmbiguity?.pattern, candidates],
  );
  const candidateAliases = candidateDescription.aliases;
  const filtered = useMemo(() => candidateDescription.search(query), [candidateDescription, query]);
  const menuEntries = useMemo<readonly MentionMenuEntry[]>(() => {
    const media = filtered.map((candidate): MentionMenuEntry => ({ type: "media", candidate }));
    if (annotationMentions == null || annotationMentions.length === 0) return media;
    const normalized = normalizePromptReferenceText(query).replace(/^@/u, "");
    const annotations = annotationMentions
      .filter(
        (entry) =>
          !normalized ||
          normalizePromptReferenceText(`${entry.label} ${entry.description}`).includes(normalized),
      )
      .map((annotation): MentionMenuEntry => ({ type: "annotation", annotation }));
    return [...annotations, ...media];
  }, [annotationMentions, filtered, query]);
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
      candidate.slotIndex,
    ]),
  );
  const latestCandidatesRef = useRef(candidates);
  useEffect(() => {
    latestCandidatesRef.current = candidates;
  }, [candidates]);
  const ambiguityOptions = candidateDescription.ambiguityOptions;

  const closeMenu = useCallback(() => {
    replaceTypedQueryOnSelectRef.current = false;
    setMenuOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  // 全局监听 mousedown，记录最后一次点击目标，用于判断 blur 是否由拖拽节点/点击下拉栏触发
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      lastMouseDownTargetRef.current = event.target;
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
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

  const updatePromptSnapshot = useCallback(
    (input: HTMLDivElement) => {
      const view = sessionRef.current?.acceptNativeInput();
      const plainText = view?.plainText ?? (input.textContent ?? "").replaceAll("\u200b", "");
      setCharacterCount(view?.characterCount ?? plainText.length);
      // 外部写入（弹窗「添加到生成节点」、存档恢复、@ 菜单插入）都会派发 input 事件，
      // 因此这里读到的引用数就是当前内容里的真实绑定数。
      setReferenceCount(view?.referenceCount ?? 0);

      onTextChange?.(plainText);
    },
    [onTextChange],
  );

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

  /**
   * 输入过程中同步候选菜单：开合与过滤词都以光标所在的 "@查询词" 为准。
   *
   * macOS 中文输入法把 "@" 当组合文本提交：keydown 要么报 229、要么根本不报 "@"
   * （Windows 输入法多半直接透传），只按键盘事件开菜单会让 Mac 上永远等不到候选，
   * 只剩右下角按钮能用。因此开菜单改看「本次输入是否真的插入了 @」：
   *   - 本次输入带进 @（键入或输入法组合提交）→ 打开候选；
   *   - 光标本来就停在某个 @ 查询词里 → 只刷新过滤词，不把 Escape 关掉的菜单弹回来；
   *   - 光标离开查询词 → 收起菜单。
   * 只有“打开”需要证据，过滤/收起按光标判定，因此程序化写入（存档恢复、生成结果回填、
   * 粘贴已解析的引用）不会凭空弹出候选。
   */
  const syncMentionMenuFromCaret = useCallback(
    (options?: { readonly data?: string | undefined; readonly force?: boolean }) => {
      const caretQuery = sessionRef.current?.mentionQueryAtCaret() ?? null;
      if (caretQuery == null) {
        closeMenu();
        return;
      }
      const insertedMarker = MENTION_MARKER_IN_TEXT.test(options?.data ?? "");
      if (!menuOpen && options?.force !== true && !insertedMarker) return;
      setActiveAmbiguity(null);
      replaceTypedQueryOnSelectRef.current = true;
      setMenuOpen(true);
      setQuery(caretQuery);
      setActiveIndex(0);
    },
    [closeMenu, menuOpen],
  );

  /**
   * 输入法组合提交后 ProseMirror 才写回文档与选区，因此延迟一帧带上提交文本再判一次：
   * 会话在组合结束时也会派发一次带同样文本的 input，两条路径互为兜底。
   */
  const scheduleMentionMenuSync = useCallback(
    (options?: { readonly data?: string | undefined; readonly force?: boolean }) => {
      if (mentionSyncTimerRef.current != null) window.clearTimeout(mentionSyncTimerRef.current);
      mentionSyncTimerRef.current = window.setTimeout(() => {
        mentionSyncTimerRef.current = null;
        syncMentionMenuFromCaret(options);
      }, 0);
    },
    [syncMentionMenuFromCaret],
  );

  const composingRef = useRef(false);
  const autoDetectTimerRef = useRef<number | null>(null);
  const feedbackResetTimerRef = useRef<number | null>(null);
  const manualScanRequestedRef = useRef(false);

  const confirmActiveAmbiguity = useCallback(
    (candidate: MentionCandidate, alias: string) => {
      const input = inputRef.current;
      if (input == null || activeAmbiguity == null) return;
      const confirmed = sessionRef.current?.confirmPending(activeAmbiguity.pattern, candidate) ?? 0;
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
      setAutoMentionFeedbackState(
        hasMorePending
          ? {
              kind: "ambiguous",
              message: `已确认 ${confirmed} 处为 ${alias} · 还有同名项待确认`,
            }
          : {
              kind: "success",
              message: `已将当前 ${confirmed} 处同名引用确认为 ${alias}`,
            },
      );
      if (!hasMorePending) {
        feedbackResetTimerRef.current = window.setTimeout(() => {
          feedbackResetTimerRef.current = null;
          showReadyFeedback();
        }, AUTO_MENTION_FEEDBACK_MS);
      }
      input.focus();
      frontendLog(
        "info",
        `[canvas] 同名引用已确认: node=${nodeKey}, pattern=${activeAmbiguity.pattern}, target=${candidate.canvasNodeKey}, count=${confirmed}`,
      );
    },
    [activeAmbiguity, nodeKey, openFirstPendingAmbiguity, showReadyFeedback],
  );

  /**
   * 输入与粘贴只解析显式 @ 引用；「识别素材名」额外扫描正文里的位置词与普通名称。
   * 位置词（图2、参考图2、第2张图）按连线顺序解析，也就是清单上的行号与请求体里的「图片N」。
   * 粘贴使用 session 的统一解析结果；手输走 scheduleAutoDetect 防抖。
   * 自动模式在 @ 候选菜单打开或 IME 组合中时跳过，避免干扰进行中的查询。
   */
  const runAutoDetect = useCallback(
    (
      mode: "explicit" | "names" = "explicit",
      resolved?: ReturnType<PromptContentEditorSession["autoResolve"]>,
    ) => {
      if (resolved == null && (menuOpen || composingRef.current)) return;
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
      const resolution = resolved ??
        sessionRef.current?.autoResolve({ fresh: true, mode }) ?? {
          converted: 0,
          ambiguous: 0,
          pending: 0,
          unbound: [],
        };
      const promptText = (input.textContent ?? "").replaceAll("\u200b", "").trim();
      if (resolution.converted > 0 || resolution.ambiguous > 0) {

        // 上面的合成 input 会安排下一轮扫描；本轮已经拿到确定结果，取消重复扫描。
        if (autoDetectTimerRef.current != null) {
          window.clearTimeout(autoDetectTimerRef.current);
          autoDetectTimerRef.current = null;
        }


        if (resolution.pending > 0) {
          openFirstPendingAmbiguity();
          setAutoMentionFeedbackState({
            kind: "ambiguous",
            message: `检测到 ${resolution.pending} 处同名引用 · 请选择具体对象`,
          });
        } else {
          setActiveAmbiguity(null);
          setAutoMentionFeedbackState({
            kind: "success",
            message:
              resolution.unbound.length > 0
                ? `已自动引用 ${resolution.converted} 处素材 · 另 ${resolution.unbound.length} 处位置词没能绑定`
                : `已自动引用 ${resolution.converted} 处素材`,
          });
          // 复位只是回到常驻提示：文案由渲染时按当前候选与已引用数重算。
          feedbackResetTimerRef.current = window.setTimeout(() => {
            feedbackResetTimerRef.current = null;
            showReadyFeedback();
          }, AUTO_MENTION_FEEDBACK_MS);
        }
        frontendLog(
          "info",
          `[canvas] 提示词自动识别引用: node=${nodeKey}, 转换 ${resolution.converted} 处, 待确认 ${resolution.pending} 处`,
        );
        return;
      }

      if (resolution.pending > 0) {

        openFirstPendingAmbiguity();
        setAutoMentionFeedbackState({
          kind: "ambiguous",
          message: `仍有 ${resolution.pending} 处同名引用待确认`,
        });
      } else if (!promptText) {

        showReadyFeedback();
      } else if (candidates.length === 0) {

        setAutoMentionFeedbackState({ kind: "empty", message: "未连接素材，暂时无法引用" });
      } else if (mode === "names") {

        setAutoMentionFeedbackState({
          kind: "no-match",
          message:
            resolution.unbound.length > 0 ? "有位置词未绑定，请使用 @ 选择对应素材" : "没有新增引用，已有引用保持不变",
        });
      } else {

        showReadyFeedback();
      }
    },
    [candidates, menuOpen, nodeKey, openFirstPendingAmbiguity, showReadyFeedback],
  );

  /** 手输防抖：停止键入一段时间后扫描一次。 */
  const scheduleAutoDetect = useCallback(() => {
    manualScanRequestedRef.current = false;
    if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
    if (feedbackResetTimerRef.current != null) {
      window.clearTimeout(feedbackResetTimerRef.current);
      feedbackResetTimerRef.current = null;
    }
    if (!menuOpen && !composingRef.current) {

      setAutoMentionFeedbackState({ kind: "scanning", message: "正在识别素材引用…" });
    }
    autoDetectTimerRef.current = window.setTimeout(() => {
      autoDetectTimerRef.current = null;
      runAutoDetect(autoLink ? "names" : "explicit");
    }, PROMPT_AUTO_DETECT_DEBOUNCE_MS);
  }, [autoLink, menuOpen, runAutoDetect]);

  useEffect(() => () => {
    if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
    autoDetectTimerRef.current = null;
  }, [autoLink]);

  const chooseMention = useCallback(
    (candidate: MentionCandidate) => {
      if (replaceTypedQueryOnSelectRef.current) removeActiveMentionQuery();
      insertMention(candidate);
      scheduleAutoDetect();
    },
    [insertMention, removeActiveMentionQuery, scheduleAutoDetect],
  );


  /** 标注引用插入的是区域标记，不是素材，因此不走素材自动识别。 */
  const insertAnnotationMention = useCallback(
    (annotation: PromptMarkReferenceInput) => {
      if (inputRef.current == null) return;
      if (replaceTypedQueryOnSelectRef.current) removeActiveMentionQuery();
      sessionRef.current?.insertMarkReference(annotation);
      closeMenu();
      frontendLog(
        "info",
        `[canvas] @标注引用插入: node=${nodeKey}, mark=${annotation.markId}（${annotation.label}）`,
      );
    },
    [closeMenu, nodeKey, removeActiveMentionQuery],
  );

  const chooseMenuEntry = useCallback(
    (entry: MentionMenuEntry) => {
      if (entry.type === "annotation") insertAnnotationMention(entry.annotation);
      else chooseMention(entry.candidate);
    },
    [chooseMention, insertAnnotationMention],
  );

  /**
   * 候选菜单关闭后补一次重扫。手打 @ 会打开菜单，期间自动识别被跳过
   * （避免干扰菜单查询）；若用户未从菜单选择而是直接关掉菜单，输入框里
   * 的 @别名 / @素材名 仍是纯文本，需要这次重扫把它转换成引用 chip。
   * 仅在仍存在 chip 之外的纯文本时重扫，避免选中菜单后误报 no-match。
   */
  const hasUnboundPlainText = useCallback((input: HTMLElement): boolean => {
    const doc = input.ownerDocument ?? document;
    const walker = doc.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.data) continue;
      if (node.parentElement?.closest("[data-mention-id], [data-ambiguous-pattern]") != null)
        continue;
      return true;
    }
    return false;
  }, []);

  const previousMenuOpenRef = useRef(menuOpen);
  useEffect(() => {
    const wasOpen = previousMenuOpenRef.current;
    previousMenuOpenRef.current = menuOpen;
    if (!wasOpen || menuOpen || manualScanRequestedRef.current) return;
    const input = inputRef.current;
    if (input == null) return;
    if (!hasUnboundPlainText(input)) return;
    scheduleAutoDetect();
  }, [hasUnboundPlainText, menuOpen, scheduleAutoDetect]);

  /**
   * 手动重扫保留一个短暂但可感知的“扫描中”阶段；否则同步解析会让 React
   * 将 scanning 与最终结果合并成一次绘制，用户看起来就像按钮没有生效。
   */
  const runManualAutoDetect = useCallback(() => {
    manualScanRequestedRef.current = true;
    if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
    if (feedbackResetTimerRef.current != null) {
      window.clearTimeout(feedbackResetTimerRef.current);
      feedbackResetTimerRef.current = null;
    }

    setAutoMentionFeedbackState({ kind: "scanning", message: "正在重新扫描已连接素材…" });
    autoDetectTimerRef.current = window.setTimeout(() => {
      autoDetectTimerRef.current = null;
      manualScanRequestedRef.current = false;
      runAutoDetect("names");
    }, MANUAL_AUTO_DETECT_DELAY_MS);
  }, [runAutoDetect]);

  useEffect(
    () => () => {
      if (autoDetectTimerRef.current != null) window.clearTimeout(autoDetectTimerRef.current);
      if (feedbackResetTimerRef.current != null) {
        window.clearTimeout(feedbackResetTimerRef.current);
      }
      if (mentionSyncTimerRef.current != null) window.clearTimeout(mentionSyncTimerRef.current);
    },
    [],
  );

  /**
   * 连线集合变化只同步候选和断线状态；既有待确认项继续要求用户选择。
   * 被引用的素材节点已经不在画布上时，updateConnections 会按同源/同名素材自愈重连，
   * 这里把重连处数报给用户：灰掉的 chip 变回高亮，说清楚是被谁接上的。
   */
  useEffect(() => {
    const input = inputRef.current;
    if (input == null) return;
    const currentCandidates = latestCandidatesRef.current;
    const rebinds =
      sessionRef.current?.updateConnections(currentCandidates, { aliveCanvasNodeKeys }) ?? [];
    const pendingCount = sessionRef.current?.read().pendingCount ?? 0;
    if (pendingCount > 0) {
      openFirstPendingAmbiguity();
      setAutoMentionFeedbackState({
        kind: "ambiguous",
        message: `仍有 ${pendingCount} 处同名引用待确认`,
      });
    } else {
      setActiveAmbiguity(null);

      showReadyFeedback();
      if (rebinds.length > 0) {
        if (feedbackResetTimerRef.current != null) {
          window.clearTimeout(feedbackResetTimerRef.current);
        }
        // 换图（原来占的位置被新素材顶上）与同名素材重连是两回事，回执要分开说。
        const replaced = rebinds.filter((rebind) => rebind.matchedBy === "slot").length;
        const renamed = rebinds.length - replaced;
        const parts = [
          ...(replaced > 0 ? [`已跟随换上的新素材更新 ${replaced} 处引用`] : []),
          ...(renamed > 0 ? [`已按同名素材自动重连 ${renamed} 处引用`] : []),
        ];
        setAutoMentionFeedbackState({ kind: "success", message: parts.join("；") });
        feedbackResetTimerRef.current = window.setTimeout(() => {
          feedbackResetTimerRef.current = null;
          showReadyFeedback();
        }, AUTO_MENTION_FEEDBACK_MS);
      }
    }
  }, [
    aliveCanvasNodeKeys,
    candidateConnectionSignature,
    openFirstPendingAmbiguity,
    showReadyFeedback,
  ]);

  /**
   * 对外展示的识别状态：常驻提示（ready）在每次渲染时按当前候选与已引用数重算，
   * 一次性结果（正在识别 / 已识别 / 待确认 / 未匹配 / 未连接素材）照原样展示。
   */
  const autoMentionFeedback =
    autoMentionFeedbackState.kind === "ready"
      ? readyAutoMentionFeedback(candidates, referenceCount)
      : autoMentionFeedbackState;

  const editor = (
    <div
      id={expanded ? editorId : undefined}
      className={`prompt-mention${expanded ? " is-expanded" : ""}`}
      role={expanded ? "dialog" : undefined}
      /*
       * 刻意**不**声明 `aria-modal`。
       *
       * 这个编辑区是**画布节点的一部分**，不是独立模态：展开时用户要的是
       * 「在这个节点里编辑提示词」，而 `aria-modal="true"` 会让读屏屏蔽整个
       * 画布 —— 正好屏蔽掉用户此刻仍要参照的其它节点与连线。
       *
       * 连带后果同上：画布子树内存在 aria-modal 时，焦点陷阱冻结背景的豁免
       * 会跳过整棵画布，背景就始终可聚焦。
       */
      aria-labelledby={expanded ? editorTitleId : undefined}
      aria-describedby={expanded ? editorDescriptionId : undefined}
      onKeyDown={(event) => {
        if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
                <Icon name="corners-out" size="lg" />
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
              <Icon name="x" aria-hidden="true" size="md" />
            </button>
          </div>
        ) : null}

        <div ref={fieldRef} className="prompt-mention__field" data-leading-content={leadingContent ? "" : undefined}>
          {attachmentNotice != null && (
            <ErrorAlert error={attachmentNotice.message} hint={attachmentNotice.hint} />
          )}
          {leadingContent ? <div className="prompt-mention__leading-content">{leadingContent}</div> : null}
          <div
            ref={attachInput}
            className="prompt-mention__editor"
            onInput={(event) => {
              if (
                composingRef.current ||
                sessionRef.current?.isComposing() ||
                event.nativeEvent.isComposing
              )
                return;
              const input = inputRef.current;
              // IME 组合期间不强制读取/同步编辑器 DOM：此时输入法仍持有未提交的
              // 候选拼音，提前 flush 会把组合文本错误提交成错乱字符。
              if (input != null && !composingRef.current) updatePromptSnapshot(input);
              // 候选菜单由这里的实际输入驱动，不依赖 keydown："@" 是否被浏览器报成
              // 普通按键由输入法决定，macOS 上常常只报 229。
              syncMentionMenuFromCaret({ data: event.nativeEvent.data ?? "" });
              scheduleAutoDetect();
            }}
            onCompositionStart={() => {
              composingRef.current = true;
              if (autoDetectTimerRef.current != null)
                window.clearTimeout(autoDetectTimerRef.current);
              autoDetectTimerRef.current = null;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              // 输入法提交的文本是 macOS 上 "@" 的唯一线索：keydown 只报 229。
              scheduleMentionMenuSync({ data: event.data ?? "" });
              scheduleAutoDetect();
            }}
            onPaste={(event) => {
              // 剪贴板里有文件（截图/复制的文件）时优先作为附件摄取。
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void ingestAttachmentFiles(files);
                return;
              }
              // 统一插入纯文本；AutoLink 开启时继续把普通素材名绑定为引用。
              // 同时杜绝富文本 HTML 直接混入提示词。
              const text = event.clipboardData?.getData("text/plain") ?? "";
              event.preventDefault();
              const resolution = sessionRef.current?.pastePlainText(text);
              if (resolution?.pending) openFirstPendingAmbiguity();
              if (autoLink) runAutoDetect("names");
              else runAutoDetect("explicit", resolution);
            }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (files.length === 0) return;
              event.preventDefault();
              void ingestAttachmentFiles(files);
            }}
            onClick={(event) => {
              const pending = sessionRef.current?.pendingAt(event.target) ?? null;
              if (pending != null) {
                openAmbiguityChip(pending);
              }
            }}
            onBlur={() => {
              // 检查最后一次 mousedown 的目标：如果是在节点或下拉栏内，不关闭下拉栏
              // （拖拽节点或点击下拉栏选项时，编辑器会失去焦点，但不应关闭下拉栏）
              const target = lastMouseDownTargetRef.current;
              if (target instanceof Element) {
                const isInMenu = target.closest(".prompt-mention__menu") != null;
                const isInNode = target.closest(".react-flow__node") != null;
                const isInAmbiguityMenu = target.closest(".prompt-ambiguity__menu") != null;
                if (isInMenu || isInNode || isInAmbiguityMenu) {
                  return;
                }
              }
              window.setTimeout(closeMenu, 120);
            }}
            onKeyDownCapture={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)
                return;
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
              if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                return;
              }
              if (menuOpen && menuEntries.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveIndex((current) => (current + 1) % menuEntries.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveIndex(
                    (current) => (current - 1 + menuEntries.length) % menuEntries.length,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  event.stopPropagation();
                  const entry = menuEntries[activeIndex] ?? menuEntries[0];
                  if (entry) {
                    chooseMenuEntry(entry);
                  }
                  return;
                }
              }
              if (event.key === "@") {
                // 让 "@" 字符先落入输入框，再按光标打开候选下拉。
                // 键盘事件能报出 "@" 时立刻开，不必等输入法/浏览器的 input 事件。
                scheduleMentionMenuSync({ force: true });
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
                <Icon name="corners-out" aria-hidden="true" size="sm" />
                <span>放大</span>
              </button>
            ) : null}
            <button
              type="button"
              className="prompt-mention__trigger prompt-mention__trigger--detect"
              aria-label="识别素材名"
              aria-describedby={autoMentionStatusId}
              aria-busy={autoMentionFeedback.kind === "scanning"}
              data-result={autoMentionFeedback.kind}
              title="识别素材名：把正文里的位置词（图1、参考图2、第2张图）与已连接素材名绑定为引用"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                closeMenu();
                runManualAutoDetect();
              }}
            >
              {autoMentionFeedback.kind === "scanning" ? (
                <Icon name="circle-notch" className="spin-icon" aria-hidden="true" size="xs" />
              ) : autoMentionFeedback.kind === "success" ? (
                <Icon name="check-circle" aria-hidden="true" size="xs" />
              ) : autoMentionFeedback.kind === "ambiguous" ? (
                <Icon name="warning-circle" aria-hidden="true" size="xs" />
              ) : (
                <Icon name="sparkle" aria-hidden="true" size="xs" />
              )}
              <span>识别素材名</span>
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
                // onMouseDown 保留编辑器当前选区，按钮与键入 @ 都在光标处插入。
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
            <PromptFloatingMenu
              anchorRef={fieldRef}
              className="prompt-mention__menu prompt-mention__menu--floating nodrag nopan nowheel"
              role="listbox"
              aria-label={
                annotationMentions != null && annotationMentions.length > 0
                  ? "引用候选"
                  : "素材引用候选"
              }
            >
              {menuEntries.length === 0 ? (
                <span className="prompt-mention__empty">
                  {annotationMentions != null && annotationMentions.length > 0
                    ? "没有匹配的素材或画面标注。先在画面上框选或圈出要修改的区域，或改成其它关键字。"
                    : "没有匹配素材。先从素材库拖素材到画布并连线，或在素材库中确认名称。"}
                </span>
              ) : (
                menuEntries.map((entry, index) =>
                  entry.type === "annotation" ? (
                    <button
                      key={`annotation-${entry.annotation.markId}`}
                      type="button"
                      className={`prompt-mention__option prompt-mention__option--annotation${index === activeIndex ? " is-active" : ""}`}
                      role="option"
                      aria-label={`${entry.annotation.label}，画面标注，${entry.annotation.description}`}
                      aria-selected={index === activeIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => chooseMenuEntry(entry)}
                    >
                      <span
                        className={`prompt-mention__thumb prompt-mention__thumb--annotation${
                          entry.annotation.thumbnail ? " prompt-mention__thumb--auto-size" : ""
                        }`}
                        style={{ "--annotation-color": entry.annotation.color } as CSSProperties}
                        aria-hidden="true"
                      >
                        {entry.annotation.thumbnail ? (
                          <img src={entry.annotation.thumbnail} alt="" />
                        ) : null}
                      </span>
                      <span className="prompt-mention__option-copy">
                        <strong>{entry.annotation.label}</strong>
                        <small title={entry.annotation.description}>
                          {entry.annotation.description}
                        </small>
                      </span>
                    </button>
                  ) : (
                    <button
                      key={`${entry.candidate.assetId}-${entry.candidate.canvasNodeKey}`}
                      type="button"
                      className={`prompt-mention__option${index === activeIndex ? " is-active" : ""}`}
                      role="option"
                      aria-label={`${entry.candidate.name}，已连线，素材 ID ${entry.candidate.assetId}，实例 ID ${entry.candidate.canvasNodeKey}`}
                      aria-selected={index === activeIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => chooseMenuEntry(entry)}
                    >
                      <MentionOptionThumb candidate={entry.candidate} />
                      <span className="prompt-mention__option-name">{entry.candidate.name}</span>
                      <span className="prompt-mention__option-tag">
                        {candidateAliases[
                          candidates.findIndex(
                            (candidate) =>
                              candidate.canvasNodeKey === entry.candidate.canvasNodeKey,
                          )
                        ]?.label ?? "已连线"}
                        {` · ${entry.candidate.canvasNodeKey.slice(-6)}`}
                      </span>
                    </button>
                  ),
                )
              )}
            </PromptFloatingMenu>
          ) : null}
          {activeAmbiguity != null ? (
            <PromptFloatingMenu
              anchorRef={fieldRef}
              className="prompt-ambiguity__menu prompt-ambiguity__menu--floating nodrag nopan nowheel"
              role="group"
              aria-label={`选择“${activeAmbiguity.displayName}”引用的具体素材`}
            >
              <div className="prompt-ambiguity__header">
                <span className="prompt-ambiguity__heading">
                  <Icon name="warning-circle" aria-hidden="true" size="sm" />
                  <span>
                    <strong>“{activeAmbiguity.displayName}”有同名对象</strong>
                    <small>此次选择应用于当前全部同名待确认项；新输入仍需确认</small>
                  </span>
                </span>
                <button
                  type="button"
                  className="prompt-ambiguity__close"
                  aria-label="暂时关闭同名素材选择器"
                  onClick={() => setActiveAmbiguity(null)}
                >
                  <Icon name="x" aria-hidden="true" size="sm" />
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
                      <MentionOptionThumb candidate={candidate} />
                      <span className="prompt-ambiguity__option-copy">
                        <strong>{candidate.name}</strong>
                        <small>实例 {candidate.canvasNodeKey.slice(-6)}</small>
                      </span>
                      <span className="prompt-ambiguity__alias">{alias}</span>
                      <Icon name="check" aria-hidden="true" size="sm" />
                    </button>
                  ))
                )}
              </div>
            </PromptFloatingMenu>
          ) : null}
        </div>

        <span id={autoMentionStatusId} className="sr-only" role="status" aria-live="polite">
          {autoMentionFeedback.message}
        </span>

        {expanded ? (
          <div className="prompt-mention__expanded-footer">
            <span>
              输入 <kbd>@</kbd> 引用已连素材 · 普通文字保持原样 · <kbd>Esc</kbd> 关闭
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

/**
 * 供应商下拉里的展示名。
 *
 * 同一个网关常被配成多条连接（改线路、换 key、留测试通道），它们的展示名可能完全
 * 一样——下拉里两行同名就分不出该选哪条。同名时补一段连接 id 区分，避免用户对着
 * 两个一样的名字猜。
 */
function providerOptionLabels(
  providers: readonly ProviderCatalogEntry[],
): ReadonlyMap<string, string> {
  const totals = new Map<string, number>();
  for (const entry of providers) {
    const name = entry.provider.displayName;
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const entry of providers) {
    const name = entry.provider.displayName;
    const id = entry.provider.id;
    labels.set(
      id,
      (totals.get(name) ?? 0) > 1
        ? `${name} · ${id.length > 12 ? `${id.slice(0, 8)}…` : id}`
        : name,
    );
  }
  return labels;
}

export function ImageNodeSettings({
  presentation = "full",
  active = true,
  advancedHostId,
  config,
  providerCatalog,
  hasMediaInputs,
  onChange,
}: {
  readonly presentation?: "full" | "compact";
  readonly active?: boolean;
  readonly advancedHostId?: string;
  readonly config: ImageNodeConfig;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly hasMediaInputs: boolean;
  readonly onChange: (config: ImageNodeConfig) => void;
}) {
  const operation: GenerationOperation = hasMediaInputs || config.styleReference != null ? "image_to_image" : "text_to_image";
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
  const providerLabels = providerOptionLabels(availableProviders);
  const parameterCapabilities = selectedModel
    ? modelParameterCapabilities(
        selectedModel.operationSchema,
        operation,
        selectedModel.remoteModelId,
      )
    : [];
  const batchCountCapability = parameterCapabilities.find(
    (capability) => capability.key === "n" && capability.type === "integer",
  );
  const supportsBatchCount = batchCountCapability != null;
  /*
   * Remote n is one request; the cap comes from the **contract's own maximum**
   * (Qwen Image 3.0 Pro: 1–4, GPT-Image: 1–10). A contract that does not declare
   * a maximum stays uncapped. The backend rejects an out-of-range `n` locally
   * (no charge), but clamping here keeps the node's own count usable.
   */
  const countMaximum =
    batchCountCapability?.maximum ??
    (supportsBatchCount ? Number.MAX_SAFE_INTEGER : MAX_GENERATION_COUNT);
  // `n` 由上方「生成数量」字段承载，避免与模型参数区重复渲染。
  // Seedream 组图数量 `max_images` 仅在组图模式为 auto 时展示。
  const sequentialMode = String(
    config.parameterValues["sequential_image_generation"] ?? "disabled",
  );
  const modelParameterCapabilitiesWithoutCount = parameterCapabilities.filter(
    (capability) =>
      capability.key !== "n" && capability.key !== "mask" && capability.key !== "mask_url" &&
      !(capability.key === "max_images" && sequentialMode !== "auto"),
  ).map((capability): ModelParameterCapability => capability.key === "background" && capability.options.length === 0 ? {
    ...capability,
    label: "背景",
    defaultValue: capability.defaultValue || "auto",
    options: [{ value: "auto", label: "自动" }, { value: "opaque", label: "保留" }, { value: "transparent", label: "透明" }],
  } : capability);

  const modelFields = (
    <>
      <div className="canvas-gen-node__field canvas-gen-node__field--provider">
        <span>供应商</span>
        <CanvasSelect
          ariaLabel="供应商"
          value={config.modelSelection.providerId}
          options={[
            ...(config.modelSelection.providerId ? [] : [{ value: "", label: "请选择供应商" }]),
            ...(config.modelSelection.providerId && !selectedProvider
              ? [
                  {
                    value: config.modelSelection.providerId,
                    label: `${config.modelSelection.providerId}（不可用）`,
                  },
                ]
              : []),
            ...availableProviders.map((entry) => ({
              value: entry.provider.id,
              label: providerLabels.get(entry.provider.id) ?? entry.provider.displayName,
            })),
          ]}
          onChange={(providerId) => {
            const modelDefinitionId =
              availableProviders
                .find((entry) => entry.provider.id === providerId)
                ?.models.find(isImageGenerationModel)?.definitionId ?? "";
            onChange({
              ...config,
              modelSelection: { providerId, modelDefinitionId },
              parameterValues: {},
            });
          }}
        />
      </div>

      <div className="canvas-gen-node__field canvas-gen-node__field--model">
        <span>图片模型</span>
        <CanvasSelect
          ariaLabel="图片模型"
          value={config.modelSelection.modelDefinitionId}
          options={[
            ...(config.modelSelection.modelDefinitionId
              ? []
              : [
                  {
                    value: "",
                    label: availableModels.length > 0 ? "请选择图片模型" : "没有可用的图片模型",
                  },
                ]),
            ...(config.modelSelection.modelDefinitionId && !selectedModel
              ? [
                  {
                    value: config.modelSelection.modelDefinitionId,
                    label: `${config.modelSelection.modelDefinitionId}（不可用）`,
                  },
                ]
              : []),
            ...availableModels.map((model) => ({
              value: model.definitionId,
              label: `${model.displayName}${
                model.operations.includes(operation) ? "" : "（目录未声明当前操作）"
              }`,
            })),
          ]}
          onChange={(modelDefinitionId) =>
            onChange({
              ...config,
              modelSelection: {
                ...config.modelSelection,
                modelDefinitionId,
              },
              parameterValues: {},
            })
          }
        />
      </div>
    </>
  );
  const parameterFields = (
    <>
      {modelParameterCapabilitiesWithoutCount.map((capability) => presentation === "compact" && canvasImageHasOptionButtons(capability) ? (
        <CanvasImageParameterOptions key={capability.key} capability={capability} value={resolvedParameterValue(capability, config.parameterValues)} onChange={value => onChange({ ...config, parameterValues: { ...config.parameterValues, [capability.key]: value } })} />
      ) : (
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
      <div className="canvas-gen-node__field canvas-gen-node__field--count">
        <span>生成数量</span>
        {presentation === "compact" ? <span className="canvas-video-options" role="group" aria-label="图片数量">{[...new Set([1, 2, 4, config.generationCount])].filter(count => count >= 1 && count <= countMaximum).sort((a, b) => a - b).map(count => <button key={count} type="button" aria-pressed={config.generationCount === count} onClick={() => onChange({ ...config, generationCount: count })}>{count}张</button>)}</span> : null}
        {presentation !== "compact" ? <input
          aria-label="图片生成数量"
          type="number"
          inputMode="numeric"
          min={1}
          max={countMaximum}
          value={config.generationCount}
          onChange={(event) =>
            onChange({
              ...config,
              generationCount: parseGenerationCountInput(event.target.value, countMaximum),
            })
          }
        /> : null}
      </div>
    </>
  );
  if (presentation === "compact" && advancedHostId)
    return (
      <CanvasImageSettings
        advancedHostId={advancedHostId}
        triggerHostId={advancedHostId.replace("image-advanced-", "image-settings-")}
        active={active}
        config={config}
        capabilities={modelParameterCapabilitiesWithoutCount}
        providerCatalog={providerCatalog}
        modelLabel={selectedModel?.displayName ?? "选择图片模型"}
        model={modelFields}
        parameters={parameterFields}
        onChange={onChange}
      />
    );
  return (
    <div className="canvas-gen-node__settings" aria-label="图片生成参数">
      {modelFields}
      {parameterFields}
    </div>
  );
}

function GenerationParameterField({
  capability,
  value,
  locked = false,
  allowAutomatic = false,
  onChange,
}: {
  readonly capability: ModelParameterCapability;
  readonly value: ModelParameterValue;
  readonly hasMediaInputs: boolean;
  readonly locked?: boolean;
  readonly allowAutomatic?: boolean;
  readonly onChange: (value: ModelParameterValue) => void;
}) {
  const disabled = locked;
  /*
   * 参数说明（`capability.description`）来自模型契约。
   *
   * 挂在**字段容器**上而不是控件上，有两个好处：
   *   - 悬停标签文字（`<span>`）也能出说明，不必精确移到控件上；
   *   - 焦点落在容器内的控件上时，说明层的 `findAnchor` 用 `closest()`
   *     找到这个容器，而 `aria-describedby` 会挂到**真正聚焦的元素**
   *     （事件 target）上——读屏因此能读到这条说明。
   *
   * 没有说明的参数不写这个属性：说明层会把它当成「这里没有说明」。
   */
  const description = capability.description;
  if (capability.type === "boolean" && capability.optional && allowAutomatic) {
    return (
      <div className="canvas-gen-node__field canvas-gen-node__field--half" data-tooltip={description}>
        <span>{capability.label}</span>
        <CanvasSelect
          ariaLabel={capability.label}
          value={typeof value === "boolean" ? String(value) : ""}
          disabled={disabled}
          options={[
            { value: "", label: "自动" },
            { value: "true", label: "开启" },
            { value: "false", label: "关闭" },
          ]}
          onChange={(next) => onChange(next === "" ? "" : next === "true")}
        />
      </div>
    );
  }
  if (capability.type === "boolean") {
    const checked = !disabled && value === true;
    return (
      <label className="canvas-gen-node__field canvas-gen-node__field--half" data-tooltip={description}>
        <span>{capability.label}</span>
        <span className="canvas-gen-node__toggle-control">
          <input
            type="checkbox"
            aria-label={capability.label}
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span aria-hidden="true">{checked ? "开启" : "关闭"}</span>
        </span>
      </label>
    );
  }

  if (capability.options.length > 0) {
    const keepAutomatic = capability.optional && allowAutomatic;
    const currentIsListed = capability.options.some((option) => option.value === value);
    return (
      <div className="canvas-gen-node__field canvas-gen-node__field--half" data-tooltip={description}>
        <span>{capability.label}</span>
        <CanvasSelect
          ariaLabel={capability.label}
          value={String(value)}
          disabled={disabled}
          title={locked ? "由当前任务类型自动设置" : undefined}
          options={[
            ...(keepAutomatic ? [{ value: "", label: "自动" }] : []),
            ...((!keepAutomatic || value !== "") && !currentIsListed
              ? [{ value: String(value), label: `${String(value)}（当前值）` }]
              : []),
            ...capability.options.map((option) => ({
              value: String(option.value),
              label: option.label,
            })),
          ]}
          onChange={(next) => {
            if (keepAutomatic && next === "") {
              onChange("");
              return;
            }
            const selected = capability.options.find((option) => String(option.value) === next);
            if (selected) onChange(selected.value);
          }}
        />
      </div>
    );
  }

  const numeric = capability.type === "integer" || capability.type === "number";
  return (
    <label className="canvas-gen-node__field canvas-gen-node__field--half" data-tooltip={description}>
      <span>{capability.label}</span>
      <input
        type={numeric ? "number" : "text"}
        disabled={disabled}
        title={locked ? "由当前任务类型自动设置" : undefined}
        inputMode={numeric ? "numeric" : "text"}
        step={capability.step ?? (capability.type === "integer" ? 1 : undefined)}
        placeholder={
          capability.optional ? (capability.key === "seed" ? "随机" : "可选") : undefined
        }
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
  mediaInputs,
  onChange,
  onGreenScreenGenerate,
  onGreenScreenUseResult,
  onImportGreenScreenVideo,
  greenScreenResults,
  greenScreenBusy,
  active = true,
  advancedHostId,
}: {
  readonly active?: boolean;
  readonly advancedHostId?: string | undefined;
  readonly config: VideoNodeConfig;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly mediaInputs?: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly onChange: (config: VideoNodeConfig) => void;
  readonly onGreenScreenGenerate?: (() => void) | undefined;
  readonly onGreenScreenUseResult?: ((key: string) => void) | undefined;
  readonly onImportGreenScreenVideo?: (() => void) | undefined;
  readonly greenScreenResults?: readonly GreenScreenResult[] | undefined;
  readonly greenScreenBusy?: boolean | undefined;
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
  const providerLabels = providerOptionLabels(availableProviders);
  const fzyVideo = isFzyVideoSchema(selectedModel?.operationSchema ?? {});
  const perTaskProfile = fzyVideo ? null : perTaskVideoProfile(selectedModel?.remoteModelId ?? "");
  const perTaskPublicUrls = config.perTaskUrlMedia ?? [];
  const parameterCapabilities = selectedModel
    ? modelParameterCapabilities(
        selectedModel.operationSchema,
        "video_generation",
        selectedModel.remoteModelId,
      )
    : [];

  const greenScreenInputs = (mediaInputs ?? []).flatMap((input) =>
    input.target
      ? [{ key: input.key, name: input.name, kind: input.kind, target: input.target }]
      : [],
  );
  const greenScreen = config.greenScreen?.enabled
    ? resolveGreenScreen(config.greenScreen, greenScreenInputs, selectedModel?.remoteModelId ?? "")
    : null;
  const taskState = resolveSeedanceTask(
    selectedModel?.remoteModelId ?? "",
    parameterCapabilities,
    greenScreen ? { ...config, seedanceTaskMode: greenScreen.taskMode } : config,
    seedanceTaskInputs(greenScreen ? greenScreen.connections : (mediaInputs ?? [])),
    selectedModel?.operationSchema,
  );
  // These tools compile ordinary prompt/media requests; acceptance comes from the service.
  const showSeedanceExtras = taskState.enabled;
  const showSeedanceDraft = supportsSeedanceDraft(
    selectedProvider?.provider.adapterId ?? "",
    selectedModel?.remoteModelId ?? "",
  );
  const seedanceDraftEnabled = showSeedanceDraft && config.parameterValues["draft"] === true;

  const frameMode = config.videoMode ?? config.seedanceTaskMode ?? taskState.mode;
  const frameIntent = compileCanvasVideoMode(frameMode, mediaInputs ?? [], taskState.mediaRoles);
  const referenceFields = (
    <>
          {(frameMode === "first_frame" || frameMode === "first_last_frame") &&
          (mediaInputs?.length ?? 0) > 0 ? (
            <div className="canvas-gen-node__media-roles" aria-label="首尾帧素材">
              <ol className="canvas-gen-node__media-role-list">
                {mediaInputs?.map((input) => (
                  <li key={input.key} className="canvas-gen-node__media-role">
                    <AssetKindIcon kind={input.kind} size="md" />
                    <span className="canvas-gen-node__media-role-name">{input.name}</span>
                    <span>
                      {frameIntent.mediaRoles[input.key] === "first_frame"
                        ? "首帧"
                        : frameIntent.mediaRoles[input.key] === "last_frame"
                          ? "尾帧"
                          : "参考素材"}
                    </span>
                  </li>
                ))}
              </ol>
              {frameMode === "first_last_frame" && !taskState.issue ? (
                <button
                  type="button"
                  className="canvas-gen-node__url-add"
                  onClick={() =>
                    onChange({
                      ...config,
                      seedanceTaskMode: frameMode,
                      parameterValues: taskState.parameterValues,
                      mediaRoles: Object.fromEntries(
                        Object.entries(frameIntent.mediaRoles).map(([key, role]) => [
                          key,
                          role === "first_frame"
                            ? "last_frame"
                            : role === "last_frame"
                              ? "first_frame"
                              : role,
                        ]),
                      ),
                    })
                  }
                >
                  交换首尾帧
                </button>
              ) : null}
            </div>
          ) : null}
      {fzyVideo ||
      isWan30VideoModel(selectedModel?.definitionId ?? selectedModel?.remoteModelId ?? "") ||
      isMinimaxH3VideoModel(selectedModel?.definitionId ?? selectedModel?.remoteModelId ?? "") ? (
        <VideoMediaRoleSection
          inputs={mediaInputs ?? []}
          roles={config.mediaRoles ?? {}}
          pairedFrames={fzyVideo}
          onChange={(roles) => onChange({ ...config, mediaRoles: roles })}
        />
      ) : null}
      {!fzyVideo &&
      isWan30VideoModel(selectedModel?.definitionId ?? selectedModel?.remoteModelId ?? "") ? (
        <VideoUrlMediaSection
          urlMedia={config.urlMedia ?? []}
          hasConnectedMedia={(mediaInputs?.length ?? 0) > 0}
          onChange={(urlMedia) => onChange({ ...config, urlMedia })}
        />
      ) : null}
      {perTaskProfile ? (
        <PerTaskVideoUrlSection
          profile={perTaskProfile}
          urlMedia={perTaskPublicUrls}
          connectedInputs={mediaInputs ?? []}
          onChange={(perTaskUrlMedia) => onChange({ ...config, perTaskUrlMedia })}
        />
      ) : null}
    </>
  );
  const modelFeatureFields = (
    <>
      {showSeedanceExtras || config.greenScreen ? (
        <GreenScreenSection
          config={config.greenScreen}
          inputs={greenScreenInputs}
          modelId={selectedModel?.remoteModelId ?? ""}
          results={greenScreenResults}
          busy={greenScreenBusy}
          onGenerate={onGreenScreenGenerate}
          onUseResult={onGreenScreenUseResult}
          onImportVideo={onImportGreenScreenVideo}
          onChange={(next) =>
            onChange({
              ...config,
              greenScreen: next,
              ...(next.enabled && config.whiteModelControl?.enabled
                ? { whiteModelControl: { ...config.whiteModelControl, enabled: false } }
                : {}),
            })
          }
        />
      ) : null}

      {showSeedanceExtras || config.whiteModelControl ? (
        <WhiteModelControlSection
          {...(config.whiteModelControl ? { config: config.whiteModelControl } : {})}
          inputs={(mediaInputs ?? []).flatMap((input) =>
            input.target
              ? [{ key: input.key, name: input.name, kind: input.kind, target: input.target }]
              : [],
          )}
          modelId={selectedModel?.remoteModelId ?? ""}
          taskMode={taskState.mode}
          onChange={(whiteModelControl) =>
            onChange({
              ...config,
              whiteModelControl,
              ...(whiteModelControl.enabled && config.greenScreen?.enabled
                ? { greenScreen: { ...config.greenScreen, enabled: false } }
                : {}),
            })
          }
        />
      ) : null}

      {showSeedanceDraft ? (
        <div className="canvas-gen-node__media-roles" aria-label="草稿样片与正片">
          <label className="canvas-gen-node__field">
            <span>先生成草稿样片</span>
            <span className="canvas-gen-node__toggle-control">
              <input
                type="checkbox"
                aria-label="先生成草稿样片"
                checked={seedanceDraftEnabled}
                onChange={(event) =>
                  onChange({
                    ...config,
                    parameterValues: {
                      ...taskState.parameterValues,
                      draft: event.target.checked,
                      ...(event.target.checked ? { resolution: "480p" } : {}),
                    },
                  })
                }
              />
              <span aria-hidden="true">{seedanceDraftEnabled ? "开启" : "关闭"}</span>
            </span>
          </label>
          <small>
            {seedanceDraftEnabled
              ? "先生成 480p 样片；在产物的「原任务」中预览并审核后，可人工发起 1080p 正片。正片会创建独立付费任务，保留样片。"
              : "直接生成支持 480p / 720p。需要 1080p 时先生成草稿样片，审核后再生成正片。"}
          </small>
          <small>可直接使用供应商 API Key，无需额外配置令牌分组。</small>
          {seedanceDraftEnabled &&
          config.parameterValues["resolution"] !== "480p" &&
          config.parameterValues["resolution"] != null ? (
            <small>
              此存档保留了 {String(config.parameterValues["resolution"])}{" "}
              分辨率；建议关闭后重新开启草稿以选择 480p，当前请求由服务端判定。
            </small>
          ) : null}
        </div>
      ) : null}

    </>
  );
  return (
      <CanvasVideoSettings
        config={config}
        onChange={onChange}
        active={active}
        advancedHostId={advancedHostId}
        providerCatalog={providerCatalog}
        modelLabel={selectedModel?.displayName ?? "选择视频模型"}
        capabilities={taskState.parameterCapabilities}
        inputs={mediaInputs ?? []}
        referenceSettings={referenceFields}
        modelFeatures={modelFeatureFields}
        model={<div className="canvas-video-model-list" aria-label="视频模型">
          {availableProviders.flatMap(entry => entry.models
            .filter(model => supportsGenerationNode(model, "video"))
            .map(model => <button type="button" key={`${entry.provider.id}:${model.definitionId}`}
              data-video-model-option
              aria-pressed={config.modelSelection.providerId === entry.provider.id && config.modelSelection.modelDefinitionId === model.definitionId}
              onClick={() => {
                if (config.modelSelection.providerId === entry.provider.id && config.modelSelection.modelDefinitionId === model.definitionId) return;
                onChange({ ...config, modelSelection: { providerId: entry.provider.id, modelDefinitionId: model.definitionId }, parameterValues: {}, seedanceTaskMode: "auto", videoMode: config.videoMode === "longVideo2video" ? "longVideo2video" : "auto", mediaRoles: {} });
              }}>
              <Icon name="video-camera" size="sm" aria-hidden="true" />
              <span>{model.displayName}{availableProviders.length > 1 ? <small>{providerLabels.get(entry.provider.id) ?? entry.provider.displayName}</small> : null}</span>
              {config.modelSelection.providerId === entry.provider.id && config.modelSelection.modelDefinitionId === model.definitionId ? <Icon name="check" size="sm" aria-hidden="true" /> : null}
            </button>))}
          {availableProviders.length === 0 ? <p role="status">请先在全局设置中配置视频模型。</p> : null}
        </div>}
      />
    );
}

/** 万相 3.0 连接素材角色的默认值（与后端 default_reference_role 对齐）。 */
function defaultWanMediaRole(kind: AssetKind): string {
  if (kind === "video") return "reference_video";
  if (kind === "audio") return "reference_audio";
  return "reference_image";
}

/** 万相 3.0 连接素材角色选择：为每路直连/继承素材分配首帧、首尾帧或参考角色。 */
function VideoMediaRoleSection({
  inputs,
  roles,
  onChange,
  pairedFrames = false,
}: {
  readonly inputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly roles: Readonly<Record<string, string>>;
  readonly onChange: (roles: Readonly<Record<string, string>>) => void;
  readonly pairedFrames?: boolean;
}) {
  const issueId = useId();
  if (inputs.length === 0) return null;
  const effectiveRoles = inputs.map((input) => roles[input.key] ?? defaultWanMediaRole(input.kind));
  const hasFrame = effectiveRoles.some((role) => role === "first_frame" || role === "last_frame");
  const hasReference = effectiveRoles.some(
    (role, index) =>
      role.startsWith("reference_") && (!pairedFrames || inputs[index]?.kind === "image"),
  );
  const conflict = hasFrame && hasReference;
  const unpaired =
    pairedFrames &&
    hasFrame &&
    (!effectiveRoles.includes("first_frame") || !effectiveRoles.includes("last_frame"));
  const issue = unpaired
    ? "首尾帧需要成对使用。"
    : conflict
      ? "当前请求同时包含首尾帧与参考素材。"
      : null;
  return (
    <div className="canvas-gen-node__media-roles" aria-label="素材角色">
      <div className="canvas-gen-node__section-title">
        <span>素材角色</span>
        <small>
          {pairedFrames ? "首尾帧须成对，不能与参考图混用" : "首帧/首尾帧与参考素材不可混用"}
        </small>
      </div>
      <ol className="canvas-gen-node__media-role-list">
        {inputs.map((input, index) => {
          const options = wanMediaRolesForKind(input.kind);
          const current = roles[input.key] ?? defaultWanMediaRole(input.kind);
          return (
            <li key={`${input.key}:${index}`} className="canvas-gen-node__media-role">
              <AssetKindIcon kind={input.kind} size="md" />
              <span className="canvas-gen-node__media-role-name" title={input.name}>
                {input.name}
              </span>
              <CanvasSelect
                className="canvas-gen-node__media-role-select"
                ariaLabel={`${input.name} 的素材角色`}
                ariaDescribedBy={issue ? issueId : undefined}
                value={current}
                options={options.map((option) => ({
                  value: option.value,
                  label: pairedFrames && option.value === "last_frame" ? "尾帧" : option.label,
                }))}
                onChange={(next) => {
                  const nextRoles = { ...roles, [input.key]: next };
                  onChange(nextRoles);
                }}
              />
            </li>
          );
        })}
      </ol>
      {issue ? (
        <ErrorAlert
          id={issueId}
          error={issue}
          hint={
            pairedFrames
              ? "请分别指定首帧和尾帧，并移除其他参考图；或把所有图片都设为参考图。"
              : "请确认素材用途；当前输入将完整提交，支持范围由服务端返回。"
          }
        />
      ) : null}
    </div>
  );
}

/** 万相 3.0 URL 素材（文档 file / 网页 link）：解析公开文档或网页内容生成视频。 */
function VideoUrlMediaSection({
  urlMedia,
  onChange,
}: {
  readonly urlMedia: readonly VideoUrlMediaInput[];
  readonly hasConnectedMedia: boolean;
  readonly onChange: (urlMedia: readonly VideoUrlMediaInput[]) => void;
}) {
  const [draftRole, setDraftRole] = useState<"file" | "link" | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const commitDraft = () => {
    const trimmed = draftUrl.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) {
      setDraftError("仅支持公网 http(s) 链接");
      return;
    }
    if (draftRole == null) return;
    const next: VideoUrlMediaInput = {
      id: `url-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      url: trimmed,
      role: draftRole,
      label: draftRole === "file" ? "文档素材" : "网页链接",
    };
    onChange([...urlMedia, next]);
    setDraftUrl("");
    setDraftError(null);
    setDraftRole(null);
  };

  return (
    <div className="canvas-gen-node__url-media" aria-label="URL 素材（文档/网页）">
      <div className="canvas-gen-node__section-title">
        <span>文档 / 网页生视频</span>
        <small>完整提交文档、网页和已连接素材；支持范围由服务端返回</small>
      </div>
      {urlMedia.length > 0 ? (
        <ol className="canvas-gen-node__url-list">
          {urlMedia.map((input) => (
            <li key={input.id} className="canvas-gen-node__url-item">
              {input.role === "file" ? (
                <Icon name="file-text" aria-hidden="true" size="md" />
              ) : (
                <Icon name="globe" aria-hidden="true" size="md" />
              )}
              <span className="canvas-gen-node__url-copy">
                <strong>{input.role === "file" ? "文档" : "网页"}</strong>
                <small title={input.url}>{input.url}</small>
              </span>
              <button
                type="button"
                className="canvas-gen-node__url-remove"
                aria-label="移除 URL 素材"
                onClick={() => onChange(urlMedia.filter((item) => item.id !== input.id))}
              >
                <Icon name="x" aria-hidden="true" size="xs" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      {draftRole != null ? (
        <div className="canvas-gen-node__url-draft">
          <span className="canvas-gen-node__url-draft-label">
            {draftRole === "file" ? "文档 URL" : "网页链接"}
          </span>
          <input
            type="text"
            className="canvas-gen-node__url-draft-input"
            placeholder={
              draftRole === "file" ? "https://…/public-doc.pdf" : "https://…/public-article"
            }
            value={draftUrl}
            onChange={(event) => {
              setDraftUrl(event.target.value);
              setDraftError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") {
                setDraftRole(null);
                setDraftUrl("");
                setDraftError(null);
              }
            }}
            autoFocus
          />
          <button type="button" className="canvas-gen-node__url-draft-add" onClick={commitDraft}>
            添加
          </button>
          <button
            type="button"
            className="canvas-gen-node__url-draft-cancel"
            aria-label="取消"
            onClick={() => {
              setDraftRole(null);
              setDraftUrl("");
              setDraftError(null);
            }}
          >
            <Icon name="x" aria-hidden="true" size="xs" />
          </button>
        </div>
      ) : (
        <div className="canvas-gen-node__url-actions">
          <button
            type="button"
            className="canvas-gen-node__url-add"
            onClick={() => {
              setDraftRole("file");
              setDraftUrl("");
              setDraftError(null);
            }}
          >
            <Icon name="file-text" aria-hidden="true" size="sm" />
            粘贴文档 URL
          </button>
          <button
            type="button"
            className="canvas-gen-node__url-add"
            onClick={() => {
              setDraftRole("link");
              setDraftUrl("");
              setDraftError(null);
            }}
          >
            <Icon name="link-simple" aria-hidden="true" size="sm" />
            粘贴网页链接
          </button>
        </div>
      )}
      {draftError ? (
        <ErrorAlert error={draftError} variant="inline" />
      ) : null}
    </div>
  );
}

/** Public image/audio references for the SP 2.5 per-task gateway. */
function PerTaskVideoUrlSection({
  urlMedia,
  onChange,
}: {
  readonly profile: PerTaskVideoProfile;
  readonly urlMedia: readonly PerTaskVideoUrlInput[];
  readonly connectedInputs: readonly (ConnectedAssetInput | InheritedAssetInput)[];
  readonly onChange: (urlMedia: readonly PerTaskVideoUrlInput[]) => void;
}) {
  const [draftKind, setDraftKind] = useState<"image" | "audio" | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const cancelDraft = () => {
    setDraftKind(null);
    setDraftUrl("");
    setDraftError(null);
  };
  const commitDraft = () => {
    if (draftKind == null) return;
    const next: PerTaskVideoUrlInput = {
      id: `sp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      kind: draftKind,
      url: draftUrl.trim(),
    };
    const issue = perTaskVideoUrlIssue([...urlMedia, next]);
    if (issue) {
      setDraftError(issue);
      return;
    }
    onChange([...urlMedia, next]);
    cancelDraft();
  };

  return (
    <div className="canvas-gen-node__url-media" aria-label="按次参考 URL">
      <div className="canvas-gen-node__section-title">
        <span>公网参考 URL</span>
        <small>可与画布连线素材一起使用；提交时保留原 URL 和签名参数</small>
      </div>
      {urlMedia.length > 0 ? (
        <ol className="canvas-gen-node__url-list">
          {urlMedia.map((input) => (
            <li key={input.id} className="canvas-gen-node__url-item">
              <AssetKindIcon kind={input.kind} size="md" />
              <span className="canvas-gen-node__url-copy">
                <strong>{input.kind === "image" ? "参考图" : "参考音频"}</strong>
                <small title={input.url}>{input.url}</small>
              </span>
              <button
                type="button"
                className="canvas-gen-node__url-remove"
                aria-label={`移除${input.kind === "image" ? "参考图" : "参考音频"} URL`}
                onClick={() => onChange(urlMedia.filter((item) => item.id !== input.id))}
              >
                <Icon name="x" aria-hidden="true" size="xs" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {draftKind != null ? (
        <div className="canvas-gen-node__url-draft">
          <span className="canvas-gen-node__url-draft-label">
            {draftKind === "image" ? "参考图 URL" : "参考音频 URL"}
          </span>
          <input
            type="url"
            className="canvas-gen-node__url-draft-input"
            aria-label={draftKind === "image" ? "参考图 URL" : "参考音频 URL"}
            placeholder={
              draftKind === "image" ? "https://…/reference.png" : "https://…/reference.mp3"
            }
            value={draftUrl}
            onChange={(event) => {
              setDraftUrl(event.target.value);
              setDraftError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") cancelDraft();
            }}
            autoFocus
          />
          <button type="button" className="canvas-gen-node__url-draft-add" onClick={commitDraft}>
            添加
          </button>
          <button
            type="button"
            className="canvas-gen-node__url-draft-cancel"
            aria-label="取消"
            onClick={cancelDraft}
          >
            <Icon name="x" aria-hidden="true" size="xs" />
          </button>
        </div>
      ) : (
        <div className="canvas-gen-node__url-actions">
          <button
            type="button"
            className="canvas-gen-node__url-add"
            onClick={() => setDraftKind("image")}
          >
            粘贴参考图 URL
          </button>
          <button
            type="button"
            className="canvas-gen-node__url-add"
            onClick={() => setDraftKind("audio")}
          >
            粘贴参考音频 URL
          </button>
        </div>
      )}
      {draftError ? (
        <ErrorAlert error={draftError} variant="inline" />
      ) : null}
    </div>
  );
}
