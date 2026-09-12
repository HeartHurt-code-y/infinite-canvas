import { Icon } from "../../components/Icon";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  isDesktopRuntime,
  type ExplicitMediaTarget,
  type MediaReferenceTarget,
} from "../../lib/backend";
import {
  createPromptContentModule,
  type PromptContentDocumentV1,
  type PromptContentEditorSession,
  type PromptMarkReferenceInput,
  type PromptMarkReferencePresentation,
} from "../../lib/promptContent";
import type { PromptReferenceCandidate } from "../../lib/promptReferences";
import {
  inlineVideoEditMarkReferences,
  prepareVideoEditSource,
  saveVideoEditFrame,
  videoLocalEditFrameName,
  type PreparedVideoEditSource,
} from "../../lib/videoLocalEdit";

import { PromptMentionInput } from "./PromptNodeViews";
import {
  VIDEO_EDIT_COLORS,
  capturePreviewSeekFrame,
  captureVideoEditFrameThumbnail,
  describeVideoEditMark,
  exportVideoLocalEditFrame,
  formatVideoEditTime,
  isVisibleVideoEditMark,
  newVideoEditMarkId,
  previewVideoEditMarkThumbnail,
  sameVideoEditFrame,
  videoEditMarkBadge,
  videoEditMarkLabel,
  videoEditMarkThumbnailGeometry,
  videoEditMarkThumbnailResolution,
  videoEditPointFromClient,
  videoEditStrokeWidth,
  type VideoEditMark,
  type VideoEditMarkThumbnailArea,
} from "./videoLocalEditDrawing";
import "./VideoLocalEditDialog.css";

/**
 * 把标记转换成可插入编辑要求的引用输入。
 *
 * 编号按整份清单（全片唯一）计算；description 一律带上所属画面的时间读数，
 * 因此无论引用的是本帧还是别的帧，提示词都说清了「哪一帧的哪一处」——
 * 导出帧只含当前画面，时间读数是那条描述唯一的落点。
 */
function markReferenceInput(
  mark: VideoEditMark,
  index: number,
  thumbnail: string | undefined,
): PromptMarkReferenceInput {
  return {
    markId: mark.id,
    label: videoEditMarkLabel(index),
    description: describeVideoEditMark(mark, mark.timeSeconds),
    color: mark.color,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

/**
 * 取「标记所在那一帧」的缩略图：裁剪区域与分辨率按原视频像素算（scale=1），
 * 因此无论叠加层当下多大多小，取到的画面比例都是标记区域本身的真实比例。
 * 叠加层里的显示尺寸另由 videoEditMarkThumbnailGeometry 按同一比例算出，故不会被拉伸。
 */
function markThumbnailCapture(mark: VideoEditMark, videoWidth: number, videoHeight: number) {
  const geometry = videoEditMarkThumbnailGeometry(mark, {
    videoWidth,
    videoHeight,
    displayWidth: videoWidth,
    displayHeight: videoHeight,
  });
  if (geometry == null) return null;
  const size = videoEditMarkThumbnailResolution(geometry.crop);
  return { crop: geometry.crop, size };
}

/**
 * 用主预览取一处标记的缩略图，并处理「这次跳帧是内部的」这个标记位。
 *
 * 具体取帧逻辑在 videoLocalEditDrawing 里（与导出标注帧共用同一条画布路径）；
 * 这里只负责让弹窗的事件回调知道：接下来这段 pause/seeked 不是用户操作。
 */
async function capturePreviewSeekThumbnail(
  preview: HTMLVideoElement,
  mark: VideoEditMark,
  crop: VideoEditMarkThumbnailArea,
  width: number,
  height: number,
  seekingRef: { current: boolean },
): Promise<string | null> {
  seekingRef.current = true;
  try {
    return await capturePreviewSeekFrame(preview, mark, crop, width, height, {
      alreadyAtTargetFrame: false,
    });
  } finally {
    seekingRef.current = false;
  }
}

/**
 * 后台取帧：为清单里的每一处标记生成「它那一帧」的自适应缩略图。
 *
 * 取帧是异步且可失败的展示增强，因此只往缓存里写成功的结果；失败就退回原来的
 * 序号标记，标注本身的提交资格不受影响。
 *
 * 取帧循环是「只有一个」的长驻任务，参数一律从 ref 读最新值：每加一处标记都会让
 * 依赖变化并重跑 effect，如果循环跟着每次重跑一起重启，正在等待 seek 的那一轮就会被
 * 取消，缩略图永远取不出来。
 */
function useVideoEditFrameThumbnails(
  captureVideo: HTMLVideoElement | null,
  captureSourceReady: boolean,
  sourceKey: string,
  items: readonly { readonly key: string; readonly mark: VideoEditMark }[],
  previewVideoRef: { readonly current: HTMLVideoElement | null },
  previewSeekingRef: { current: boolean },
): {
  readonly thumbnails: ReadonlyMap<string, string>;
  readonly capturingKeys: ReadonlySet<string>;
} {
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [capturingKeys, setCapturingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const cacheRef = useRef(new Map<string, string>());
  // 取帧失败过的标记：允许有限次重试，避免一次偶发失败（源还没缓冲好）就永久没有缩略图，
  // 同时也不会让同一处标记把取帧循环卡死。
  const failedRef = useRef(new Map<string, number>());
  /** 后台元素真正尝试过取帧的次数：用它决定要不要动用「跳主预览」这条有代价的兜底。 */
  const backgroundAttemptsRef = useRef(0);
  // 取帧循环长驻，因此参数走 ref：在 effect 里同步最新值，渲染期间不写 ref。
  const latestRef = useRef({ captureVideo, captureSourceReady, items });
  const mountedRef = useRef(true);
  const pumpingRef = useRef(false);
  const sourceKeyRef = useRef(sourceKey);

  useEffect(() => {
    latestRef.current = { captureVideo, captureSourceReady, items };
  });

  /**
   * 取帧循环长驻，参数一律从 ref 读最新值。
   *
   * 循环不跟着依赖重跑一起重启：每加一处标记都会重跑 effect，若循环随之取消，
   * 正在等待 seek 的那一轮就被扔掉，缩略图永远取不出来。
   * 也刻意不要求后台元素已就绪 —— 主预览本身就能给出「当前画面上的标注」的缩略图，
   * 等后台元素可用后这个 effect 会再跑一次，把其余标记补齐。
   * 卸载时只置一次挂载标记，不取消 in-flight Promise：取出的帧写回缓存也无人读取。
   */
  useEffect(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        while (mountedRef.current) {
          // 每轮让出一次事件循环再取最新参数，新增/删除的标记都能立刻跟上。
          await Promise.resolve();
          if (!mountedRef.current) break;
          const current = latestRef.current;
          const preview = previewVideoRef.current;
          const background =
            current.captureSourceReady && (current.captureVideo?.videoWidth ?? 0) > 0
              ? current.captureVideo
              : null;
          const next = current.items.find(
            (item) => !cacheRef.current.has(item.key) && (failedRef.current.get(item.key) ?? 0) < 3,
          );
          if (next == null) break;
          // 画面尺寸是裁剪的前提：优先用后台元素的，它没就绪时用主预览的。
          const width = background?.videoWidth ?? preview?.videoWidth ?? 0;
          const height = background?.videoHeight ?? preview?.videoHeight ?? 0;
          const capture = markThumbnailCapture(next.mark, width, height);
          if (capture == null) {
            // 尺寸都还没就绪：不记失败，等尺寸到位后这个 effect 会再跑一次。
            break;
          }
          const job = {
            crop: capture.crop,
            width: capture.size.width,
            height: capture.size.height,
          };
          setCapturingKeys((previous) =>
            previous.has(next.key) ? previous : new Set(previous).add(next.key),
          );
          /*
           * 三条路，从最可靠到最兜底：
           * 1) 主预览：标记就属于当前画面且预览已暂停时直接裁剪，最可靠；
           * 2) 后台元素：seek 到标记那一帧，完全不扰动用户画面（等待上限调短，
           *    不可用就尽快交给下一条）；
           * 3) 主预览 seek：与「导出标注帧」完全同一条画布路径，只要导出能用就一定能出图，
           *    代价是画面会短暂跳到那一帧再跳回来。
           */
          let dataUrl =
            preview == null
              ? null
              : previewVideoEditMarkThumbnail(preview, next.mark, job.crop, job.width, job.height);
          if (dataUrl == null && background != null && backgroundAttemptsRef.current < 2) {
            backgroundAttemptsRef.current += 1;
            dataUrl = await captureVideoEditFrameThumbnail(background, next.mark, {
              timeSeconds: next.mark.timeSeconds,
              crop: job.crop,
              width: job.width,
              height: job.height,
              waitMs: 1_500,
            });
            if (!mountedRef.current) break;
          }
          /*
           * 第三条路（跳主预览）代价最大：画面会短暂跳到那一帧。因此只有在后台元素
           * 真的试过并失败之后才动用它；后台元素都还没就绪时先等它 —— 那条路不打扰用户。
           * 但它不能永久缺席：连续两次都不出图（WebView 不给不可见元素解码帧），
           * 就接管过来，保证缩略图最终一定出得来。这一条只在后台元素真的存在时才可能触发，
           * 因此元素尚未挂载/尚未就绪的阶段绝不会去动用户的画面。
           */
          const usePreviewSeek =
            dataUrl == null && preview != null && backgroundAttemptsRef.current >= 2;
          if (usePreviewSeek) {
            dataUrl = await capturePreviewSeekThumbnail(
              preview,
              next.mark,
              job.crop,
              job.width,
              job.height,
              previewSeekingRef,
            );
            if (!mountedRef.current) break;
          }
          setCapturingKeys((previous) => {
            if (!previous.has(next.key)) return previous;
            const remaining = new Set(previous);
            remaining.delete(next.key);
            return remaining;
          });
          if (dataUrl == null) {
            // 三条路都取不到帧（源还没缓冲好、设备不支持）：记一次失败，本轮先跳过它，
            // 别让同一处标记卡住后面的标记，也不再永久放弃（换帧、加新标记都会重试）。
            failedRef.current.set(next.key, (failedRef.current.get(next.key) ?? 0) + 1);
            continue;
          }
          cacheRef.current.set(next.key, dataUrl);
          failedRef.current.delete(next.key);
          setThumbnails(new Map(cacheRef.current));
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [captureSourceReady, captureVideo, items, previewSeekingRef, previewVideoRef, sourceKey]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // 换源（重新读取原视频、换了一个视频）：清空缓存与失败计数，缩略图必须对应当前源。
    if (sourceKeyRef.current === sourceKey) return;
    sourceKeyRef.current = sourceKey;
    cacheRef.current = new Map();
    failedRef.current = new Map();
    setThumbnails(new Map());
  }, [sourceKey]);

  return { thumbnails, capturingKeys };
}

export interface VideoLocalEditSource {
  readonly key: string;
  readonly label: string;
  readonly src: string;
  readonly target?: ExplicitMediaTarget;
}

export interface VideoLocalEditResult {
  readonly imageDataUrl: string;
  readonly timeSeconds: number;
  /**
   * 编辑要求沿用提示内容的引用文档：正文与 @ 素材引用同构，
   * 由调用方并入生成节点提示词，保留引用身份而不是退化成素材名文本。
   */
  readonly instructionDocument: PromptContentDocumentV1;
  readonly operation: "remove" | "replace";
  readonly sourceKey: string;
  readonly timeRange: { readonly startSeconds: number; readonly endSeconds: number } | null;
  /**
   * 标注帧落盘后的身份：`path` 是本地文件，`target` 是它进入请求的方式。
   * 入库成功时 `target` 是 `asset://` 资产身份（含真人的素材只有这样才能过平台隐私预检）；
   * 未勾选入库或入库失败时是本地文件身份。
   *
   * 帧的保存与入库都由弹窗完成，因此调用方只需按这个身份接入节点，不必再走一次 I/O。
   */
  readonly frame: {
    readonly path: string;
    readonly name: string;
    readonly target: MediaReferenceTarget;
    readonly uploadedToLibrary: boolean;
    /** 标注帧（即原视频画面）的宽高比；调用方据此给产物卡片定尺寸，不必再读一次文件。 */
    readonly aspectRatio: number;
  };
  /**
   * 编辑要求里引用到的、不属于当前画面的标注时间读数（已格式化）。
   * 这些引用在提示词里带了时间读数、依然成立，但导出帧只画当前画面，
   * 调用方需要据此提示用户：那一处在标注帧里没有画出来。
   */
  readonly offFrameReferenceTimes?: readonly string[] | undefined;
}

export interface VideoLocalEditFrameResolution {
  /**
   * 帧的提交身份。`canvasNodeKey` 在解析阶段只能是占位值 —— 真正的产物节点 key
   * 由调用方在接入节点时才知道，必须由它覆写后再写入提示内容。
   */
  readonly target: MediaReferenceTarget;
  readonly uploadedToLibrary: boolean;
}

export interface VideoLocalEditDialogProps {
  readonly source: VideoLocalEditSource;
  /** 当前生成节点已连接的媒体素材，供编辑要求 @ 引用（替换素材即来自这里）。 */
  readonly candidates: readonly PromptReferenceCandidate[];
  /** 是否已配置可用的云端素材库连接；不可用时隐藏上传选项。 */
  readonly canUploadToLibrary: boolean;
  /**
   * 把已落盘的标注帧解析成提交身份（入库为 `asset://` 资产，或退回本地文件）。
   *
   * 实现放在调用方（需要素材库连接等画布级信息），但**改由弹窗发起**：
   * 入库失败时弹窗留在原地，让用户只重试入库这一步，而不是重新标注。
   */
  readonly resolveFrame: (request: {
    readonly path: string;
    readonly name: string;
    readonly dataUrl: string;
    /** 用户在弹窗里是否选择了入库；false 时只落本地文件，不产生云端素材。 */
    readonly uploadToLibrary: boolean;
    readonly onProgress: (label: string) => void;
  }) => Promise<VideoLocalEditFrameResolution>;
  readonly onClose: () => void;
  /**
   * 接入生成节点。可以是同步实现：弹窗统一用 `await` 承接，失败（包括同步抛出）
   * 一律表现为「弹窗留在原地 + 错误可见」，而不是把异常丢成未处理错误。
   */
  readonly onApply: (result: VideoLocalEditResult) => void | Promise<void>;
}

/** 编辑要求编辑器在弹窗私有提示内容模块中的固定键；与画布节点提示词互不干扰。 */
const INSTRUCTION_EDITOR_KEY = "video-local-edit-instruction";

export function VideoLocalEditDialog(props: VideoLocalEditDialogProps) {
  // A changed source must never inherit another video's frame or marks.
  return (
    <VideoLocalEditDialogContent
      key={`${props.source.key}:${props.source.src}:${JSON.stringify(props.source.target)}`}
      {...props}
    />
  );
}

function VideoLocalEditDialogContent({
  source,
  candidates,
  canUploadToLibrary,
  resolveFrame,
  onClose,
  onApply,
}: VideoLocalEditDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const draftRef = useRef<VideoEditMark | null>(null);
  const pointerRef = useRef<number | null>(null);
  const dragListenersRef = useRef<(() => void) | null>(null);
  /*
   * 提交中标记用 state 而不是 ref：Esc/取消的处理函数里要读它来决定是否允许关闭，
   * 而渲染期间读 ref 会让「是否可关闭」这一步依赖不到最新的提交状态。
   * 重入守卫另用一个同步局部标记（见 apply），避免同一次调用内读到自己刚写、还没生效的 state。
   */
  const [submitting, setSubmitting] = useState(false);
  // 编辑要求会话：标注引用的插入与失效清理都必须走它，才能与文档保持一致。
  const instructionSessionRef = useRef<PromptContentEditorSession | null>(null);
  const titleId = useId();
  const hintId = useId();
  const instructionLabelId = useId();
  const instructionHintId = useId();
  // 编辑要求与画布提示词共用引用规则，但使用弹窗私有的内容模块，不写入节点提示词。
  const [instructionModule] = useState(() => createPromptContentModule());
  const registerInstructionInput = useCallback(
    (nodeKey: string, session: PromptContentEditorSession | null) => {
      instructionModule.adoptEditor(nodeKey, session);
      if (session != null) instructionSessionRef.current = session;
    },
    [instructionModule],
  );
  const [dimensions, setDimensions] = useState({ width: 16, height: 9 });
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<VideoEditMark["kind"]>("rectangle");
  const [color, setColor] = useState<string>(VIDEO_EDIT_COLORS[0].value);
  const [marks, setMarks] = useState<VideoEditMark[]>([]);
  const [draft, setDraft] = useState<VideoEditMark | null>(null);
  const [operation, setOperation] = useState<VideoLocalEditResult["operation"]>("remove");
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [instructionText, setInstructionText] = useState("");
  const [busy, setBusy] = useState(false);
  // 默认开启：真人素材只有以入库资产身份提交才可能通过平台隐私预检，
  // 漏勾会以匿名 URL 提交并直接被拒；确认片中没有真人时可手动关闭。
  const [uploadToLibrary, setUploadToLibrary] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * 标注帧的落盘与入库状态：
   * - framePathRef：已经存过的本地文件。入库失败后重试只重跑入库，不重复导出/落盘；
   * - frameImportFailed：入库失败。此时**不消耗**这次提交，弹窗留在原地等重试，
   *   否则用户辛苦标的几处标注会随弹窗关闭一起丢掉。
   */
  const framePathRef = useRef<string | null>(null);
  const [frameImportFailed, setFrameImportFailed] = useState(false);
  const [frameProgress, setFrameProgress] = useState<string | null>(null);
  const frameProgressRef = useRef<string | null>(null);
  const setFrameProgressLabel = useCallback((label: string | null) => {
    frameProgressRef.current = label;
    setFrameProgress(label);
  }, []);
  const [sourceError, setSourceError] = useState(false);
  const needsPreparation = source.target != null || isDesktopRuntime();
  const [previewSrc, setPreviewSrc] = useState<string | null>(needsPreparation ? null : source.src);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const [region, setRegion] = useState({ x: 25, y: 25, width: 50, height: 50 });
  const [notice, setNotice] = useState<string | null>(null);
  // 缩略图层的量测：叠加层与视频同盒，缩略图位置/尺寸都按这里的 CSS 像素算。
  const thumbnailLayerRef = useRef<HTMLDivElement | null>(null);
  const thumbnailLayerObserverRef = useRef<ResizeObserver | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  /*
   * 主预览正在被「取缩略图」内部跳动：这段时间里的 pause/seeked 不是用户操作，
   * 不能拿来更新播放头、也不该闪加载遮罩。
   */
  const previewSeekingRef = useRef(false);
  // 取帧用的后台 video：只读源视频，不参与预览播放，因此不会打断用户的画面。
  // 元素放在 state 里（ref 回调只在引用变化时写入）：取帧循环需要等它挂载后才启动。
  const [captureVideo, setCaptureVideo] = useState<HTMLVideoElement | null>(null);
  const [thumbnailReadySourceKey, setThumbnailReadySourceKey] = useState<string | null>(null);
  const thumbnailSourceReady =
    thumbnailReadySourceKey != null && thumbnailReadySourceKey === previewSrc;
  const sourceKeyForThumbnails = `${source.key}|${source.src}`;
  // 取帧元素挂在 portal 里、首帧渲染后才存在，因此用状态通知取帧循环它已经可用。
  const attachCaptureVideo = useCallback((element: HTMLVideoElement | null) => {
    setCaptureVideo((previous) => (previous === element ? previous : element));
  }, []);
  const measureThumbnailLayer = useCallback((layer: HTMLDivElement | null) => {
    const observer = thumbnailLayerObserverRef.current;
    if (observer != null) {
      observer.disconnect();
      thumbnailLayerObserverRef.current = null;
    }
    thumbnailLayerRef.current = layer;
    if (layer == null) return;
    const measure = () => {
      const width = layer.clientWidth;
      const height = layer.clientHeight;
      setViewportSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const next = new ResizeObserver(measure);
      next.observe(layer);
      thumbnailLayerObserverRef.current = next;
    }
  }, []);
  useEffect(() => {
    return () => {
      thumbnailLayerObserverRef.current?.disconnect();
      thumbnailLayerObserverRef.current = null;
    };
  }, []);
  // 后台取帧元素跟随预览源：与预览同源同 CORS 设置，取到的就是同一份画面。
  useEffect(() => {
    const video = captureVideo;
    if (video == null || previewSrc == null) return;
    let disposed = false;
    /*
     * 记录「哪个源已经就绪」，而不是一个裸布尔：换源时状态自然回到未就绪，
     * 不需要在 effect 里同步 setState（那会触发级联渲染）。
     *
     * readyState 必须直接判一次：React 在提交阶段就写好了 src，元数据完全可能在
     * 本 effect 挂上监听之前就已到达 —— 只靠事件会永远等不到那一次通知。
     */
    const ready = () => {
      if (disposed) return;
      setThumbnailReadySourceKey(previewSrc);
    };
    video.addEventListener("loadedmetadata", ready);
    video.addEventListener("loadeddata", ready);
    video.addEventListener("canplay", ready);
    if (video.readyState >= 1) ready();
    // src 由 JSX 声明式给出（React 负责写 DOM），这里只等它解码出一帧。
    return () => {
      disposed = true;
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("canplay", ready);
    };
  }, [captureVideo, preparationAttempt, previewSrc]);
  const canDraw = ready && !seeking && !playing && !busy;
  const dimensionsRef = useRef(dimensions);
  useEffect(() => {
    dimensionsRef.current = dimensions;
  }, [dimensions]);
  /*
   * 标注属于它自己的那一帧：切换时间点不再删除它们，只有当前画面的标注会画在叠加层上、
   * 才会进入本次提交。编号不按帧重排（全片唯一），否则每帧的第一处都会叫「标注1」，
   * 清单与 chip 就无法区分它们，@ 引用也会指错。
   */
  const markFrames = useMemo(() => {
    const frames: { timeSeconds: number; marks: VideoEditMark[] }[] = [];
    for (const mark of marks) {
      const frame = frames.find((entry) => sameVideoEditFrame(entry.timeSeconds, mark.timeSeconds));
      if (frame != null) frame.marks.push(mark);
      else frames.push({ timeSeconds: mark.timeSeconds, marks: [mark] });
    }
    return frames.sort((first, second) => first.timeSeconds - second.timeSeconds);
  }, [marks]);
  /**
   * 当前画面的标注。归属一律从 markFrames 里选，而不是各自做一次容差判断：
   * 同一帧内两处标注的时间可能相差接近容差，各自判断会出现「清单说是别的帧、
   * 叠加层却画在这一帧」的分裂。
   */
  const nearestMarkFrame = useMemo(() => {
    let best: (typeof markFrames)[number] | null = null;
    for (const frame of markFrames) {
      if (best == null || Math.abs(frame.timeSeconds - time) < Math.abs(best.timeSeconds - time))
        best = frame;
    }
    return best;
  }, [markFrames, time]);
  const currentFrame =
    nearestMarkFrame != null && sameVideoEditFrame(nearestMarkFrame.timeSeconds, time)
      ? nearestMarkFrame
      : null;
  const currentMarks = useMemo<readonly VideoEditMark[]>(
    () => currentFrame?.marks ?? [],
    [currentFrame],
  );
  const markReferencePresentation = useMemo(() => {
    const presentation = new Map<string, PromptMarkReferencePresentation>();
    const indexByMarkId = new Map(marks.map((mark, index) => [mark.id, index] as const));
    for (const frame of markFrames) {
      const frameLabel = formatVideoEditTime(frame.timeSeconds);
      const offFrame = !sameVideoEditFrame(frame.timeSeconds, time);
      for (const mark of frame.marks) {
        presentation.set(mark.id, {
          label: videoEditMarkLabel(indexByMarkId.get(mark.id) ?? 0),
          frameLabel,
          offFrame,
        });
      }
    }
    return presentation;
  }, [markFrames, marks, time]);
  useEffect(() => {
    instructionSessionRef.current?.updateMarkReferencePresentation(markReferencePresentation);
  }, [markReferencePresentation]);
  const validRange =
    !rangeEnabled ||
    (Number.isFinite(rangeStart) &&
      Number.isFinite(rangeEnd) &&
      rangeStart >= 0 &&
      rangeEnd > rangeStart &&
      rangeEnd <= duration);
  const applyDisabledReason =
    currentMarks.length === 0 && nearestMarkFrame != null
      ? `标注只对它所标记的那一帧生效：请先回到 ${formatVideoEditTime(nearestMarkFrame.timeSeconds)} 再提交。`
      : null;
  // 编辑要求必须同时含正文：纯 @ 引用无法表达「改成什么、保持什么」，
  // 与原先的纯文本输入框保持同一道门槛。重复提交由 apply() 内部的重入守卫兜住，
  // 这里不读 ref（渲染期间不得访问 ref）。
  const canApply =
    canDraw &&
    currentMarks.some(isVisibleVideoEditMark) &&
    instructionText.trim().length > 0 &&
    !draft &&
    validRange;

  useEffect(() => {
    if (!needsPreparation) return;
    let disposed = false;
    let prepared: PreparedVideoEditSource | null = null;
    const video = videoRef.current;
    void prepareVideoEditSource(source.target, source.src).then(
      (result) => {
        if (disposed) {
          void result.release();
          return;
        }
        prepared = result;
        setPreviewSrc(result.src);
      },
      (reason: unknown) => {
        if (disposed) return;
        const message =
          reason instanceof Error
            ? reason.message
            : typeof reason === "object" &&
                reason != null &&
                "message" in reason &&
                typeof reason.message === "string"
              ? reason.message
              : "读取原视频失败，请重试。";
        setError(message);
        setSourceError(true);
      },
    );
    return () => {
      disposed = true;
      // Close WebView's file handle before releasing the owned preview on Windows.
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
      if (prepared) void prepared.release();
    };
  }, [needsPreparation, source.target, source.src, preparationAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else dialog.setAttribute("open", "");
    closeRef.current?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  // 标注拖拽的 move/up 挂在 window 上；弹窗关闭时必须摘掉，避免监听器泄漏到下一次打开。
  useEffect(() => {
    return () => {
      dragListenersRef.current?.();
      dragListenersRef.current = null;
    };
  }, []);

  function detachDragListeners() {
    dragListenersRef.current?.();
    dragListenersRef.current = null;
  }

  function resetDraft() {
    draftRef.current = null;
    pointerRef.current = null;
    detachDragListeners();
    setDraft(null);
  }

  /** 标记被删除后，编辑要求里指向它的引用必须一起消失，否则会指向画面外不存在的区域。 */
  function dropMarkReferences(markIds: readonly string[]) {
    const removed = instructionSessionRef.current?.removeMarkReferences(markIds) ?? 0;
    if (removed > 0) setNotice(`标注已删除，编辑要求中指向它的 ${removed} 处引用已同步移除。`);
  }

  /** 清空全部标注（重新读取源视频时用）；切换时间点不会走到这里。 */
  function clearMarks() {
    const ids = marks.map((mark) => mark.id);
    resetDraft();
    setMarks([]);
    dropMarkReferences(ids);
  }

  /** 撤销只作用于当前画面：在别的帧上删掉看不见的标注会让人不知所措。 */
  function undoMark() {
    const last = currentMarks.at(-1);
    if (last == null) return;
    setMarks((previous) => previous.filter((mark) => mark.id !== last.id));
    dropMarkReferences([last.id]);
  }

  function clearFrameMarks() {
    if (currentMarks.length === 0) return;
    const ids = currentMarks.map((mark) => mark.id);
    setMarks((previous) => previous.filter((mark) => !ids.includes(mark.id)));
    dropMarkReferences(ids);
  }

  function deleteMark(markId: string) {
    setMarks((previous) => previous.filter((mark) => mark.id !== markId));
    dropMarkReferences([markId]);
  }

  /** 把任意一处标注插入编辑要求：正文里即可写「把 @标注1 替换为…」。 */
  function quoteMark(index: number) {
    const mention = markReferences[index];
    const session = instructionSessionRef.current;
    if (mention == null) return;
    if (session == null) {
      setError("编辑要求尚未就绪，请重新打开局部编辑。");
      return;
    }
    session.insertMarkReference(mention);
    const mark = marks[index];
    setNotice(
      mark != null && !sameVideoEditFrame(mark.timeSeconds, time)
        ? `已把 ${mention.label}（${formatVideoEditTime(mark.timeSeconds)} 的画面）的引用插入编辑要求。`
        : `已把 ${mention.label} 的引用插入编辑要求。`,
    );
  }

  function reloadSource() {
    clearMarks();
    setPreviewSrc(null);
    setError(null);
    setNotice(null);
    setSourceError(false);
    setReady(false);
    setSeeking(false);
    setPlaying(false);
    setDuration(0);
    setTime(0);
    setPreparationAttempt((attempt) => attempt + 1);
  }

  function updateMetadata(video: HTMLVideoElement) {
    if (video.videoWidth > 0 && video.videoHeight > 0)
      setDimensions({ width: video.videoWidth, height: video.videoHeight });
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setTime(video.currentTime);
  }

  /** 客户端坐标 → 归一化画面坐标；画面外的黑边坐标会夹到画面边缘。 */
  function pointFromClient(clientX: number, clientY: number) {
    const overlay = overlayRef.current;
    if (overlay == null) return null;
    const current = dimensionsRef.current;
    return videoEditPointFromClient(
      { x: clientX, y: clientY },
      overlay.getBoundingClientRect(),
      current.width,
      current.height,
    );
  }

  function commitDraft() {
    const current = draftRef.current;
    if (current != null && isVisibleVideoEditMark(current))
      setMarks((previous) => [...previous, current]);
    resetDraft();
  }

  /** 当前播放头所在的时间点：新标注归属它，提交也以它为准。 */
  function frameTimeSeconds() {
    return videoRef.current?.currentTime ?? time;
  }

  function beginMark(event: ReactPointerEvent<SVGSVGElement>) {
    if (!canDraw || event.button !== 0 || pointerRef.current !== null) return;
    const point = pointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    pointerRef.current = pointerId;
    draftRef.current = {
      id: newVideoEditMarkId(),
      timeSeconds: frameTimeSeconds(),
      kind: tool,
      color,
      points: [point, point],
    };
    setDraft(draftRef.current);
    setError(null);
    setNotice(null);
    const extend = (clientX: number, clientY: number) => {
      const active = draftRef.current;
      const first = active?.points[0];
      const next = pointFromClient(clientX, clientY);
      if (!active || !first || !next) return;
      draftRef.current = {
        ...active,
        points: active.kind === "rectangle" ? [first, next] : [...active.points, next],
      };
      setDraft(draftRef.current);
    };
    /*
     * 拖拽期间的 move/up 挂在 window 上：指针捕获在部分 WebView 上不可用，松手时指针
     * 也可能已经移出画面。只在 <svg> 上监听 pointerup 会让 pointerRef 永久卡住 ——
     * 表现就是「只能标记一处，之后怎么拖都没反应」。
     */
    const onMove = (native: globalThis.PointerEvent) => {
      if (native.pointerId !== pointerId) return;
      extend(native.clientX, native.clientY);
    };
    const onUp = (native: globalThis.PointerEvent) => {
      if (native.pointerId !== pointerId) return;
      extend(native.clientX, native.clientY);
      commitDraft();
    };
    const onCancel = (native: globalThis.PointerEvent) => {
      if (native.pointerId !== pointerId) return;
      resetDraft();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragListenersRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }

  /**
   * 跳转到指定时间。**不再清空标注**：标注属于它自己的那一帧，切换时间点只是换一帧看，
   * 原来的标注仍留在清单里（回到该时间点即恢复显示与提交资格）。
   */
  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video || busy) return;
    video.pause();
    const next = Math.max(0, Math.min(duration, seconds));
    setPlaying(false);
    setTime(next);
    setSeeking(video.currentTime !== next);
    video.currentTime = next;
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video || busy) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    try {
      await video.play();
    } catch {
      setError("视频播放失败，请重新选择视频或检查文件是否可用。");
    }
  }

  async function apply() {
    const video = videoRef.current;
    if (!video || !canApply || submitting) return;
    const wantsLibrary = canUploadToLibrary && uploadToLibrary;
    setSubmitting(true);
    setBusy(true);
    setError(null);
    dialogRef.current?.focus();
    try {
      /*
       * 落盘只在第一次做：入库失败后重试走的是同一个本地文件（画面逐像素一致），
       * 既不用重新导出，也不会在磁盘上堆一串同内容的标注帧。
       */
      let path = framePathRef.current;
      let imageDataUrl: string | null = null;
      if (path == null) {
        imageDataUrl = exportVideoLocalEditFrame(video, currentMarks);
        path = (await saveVideoEditFrame(imageDataUrl)).path;
        framePathRef.current = path;
      }
      const name = videoLocalEditFrameName(source.label, video.currentTime);
      /*
       * 入库失败时绝不当成提交成功：弹窗留在原地，让用户只重试入库这一步。
       * 重试会命中已经校验过的本地文件，因此不用重新标注。
       *
       * 只有这一段失败才标记「已落盘、入库未完成」；后续接入节点的失败（素材断线、
       * 模型未选等）是另一类问题，不该给出「重试入库」的按钮。
       */
      setFrameImportFailed(false);
      if (wantsLibrary) setFrameProgressLabel("正在准备标注帧…");
      let resolution: VideoLocalEditFrameResolution;
      try {
        resolution = await resolveFrame({
          path,
          name,
          dataUrl: imageDataUrl ?? "",
          uploadToLibrary: wantsLibrary,
          onProgress: setFrameProgressLabel,
        });
      } catch (cause) {
        setFrameImportFailed(true);
        throw cause;
      }
      // 快照而非读取缓存视图：提交瞬间也要拿到编辑器里最新的引用文档。
      const snapshot = instructionModule.snapshotAll(new Set([INSTRUCTION_EDITOR_KEY]))[
        INSTRUCTION_EDITOR_KEY
      ];
      if (!snapshot) throw new Error("编辑要求无法读取，请重新填写。");
      // 引用一律按全片编号展开：属于其它时间点的标注在描述里已带帧时间，
      // 提示词仍然说得清它指哪一帧的哪一处（导出帧只含当前画面）。
      const labelsByMarkId = new Map(
        marks.map((mark, index) => [mark.id, videoEditMarkLabel(index)] as const),
      );
      // 被删除的标注必须挡下：它的引用会描述一处根本不存在的区域，绝不能静默丢弃。
      const staleReference = snapshot.items.find(
        (item) => item.kind === "mark_reference" && !labelsByMarkId.has(item.markId),
      );
      if (staleReference?.kind === "mark_reference")
        throw new Error("编辑要求引用了已删除的标注，请删除对应引用后重试。");
      // 标注引用在这一步展开为正文：画布提示内容仍然只有正文与素材引用两种条目。
      const instructionDocument = inlineVideoEditMarkReferences(snapshot, labelsByMarkId);
      const referencedMarkIds = new Set(
        snapshot.items.flatMap((item) => (item.kind === "mark_reference" ? [item.markId] : [])),
      );
      // 引用其它时间点的标注是允许的（描述里带了帧时间），但导出帧只画当前画面，
      // 调用方需要把这件事说出来，不能让用户以为标注帧里也画了那一处。
      const offFrameReferenceTimes = marks
        .filter(
          (mark) =>
            referencedMarkIds.has(mark.id) &&
            !sameVideoEditFrame(mark.timeSeconds, video.currentTime),
        )
        .map((mark) => formatVideoEditTime(mark.timeSeconds));
      await onApply({
        // 重试时不再重新导出：返回同一张已落盘标注帧的引用即可。
        imageDataUrl: imageDataUrl ?? "",
        timeSeconds: video.currentTime,
        instructionDocument,
        operation,
        sourceKey: source.key,
        timeRange: rangeEnabled ? { startSeconds: rangeStart, endSeconds: rangeEnd } : null,
        frame: {
          path,
          name,
          target: resolution.target,
          uploadedToLibrary: resolution.uploadedToLibrary,
          aspectRatio: video.videoWidth / video.videoHeight,
        },
        offFrameReferenceTimes,
      });
    } catch (cause) {
      // 失败一律保留弹窗与全部标注；「已落盘但入库未完成」在入库那一步单独标记。
      setError(cause instanceof Error ? cause.message : "添加标注帧失败，请重试。");
    } finally {
      setFrameProgressLabel(null);
      setSubmitting(false);
      setBusy(false);
    }
  }

  // 叠加层只画当前画面的标注：把别的时间点的标记画在这一帧上会误导定位。
  const displayedMarks = useMemo<readonly VideoEditMark[]>(
    () => (draft ? [...currentMarks, draft] : currentMarks),
    [currentMarks, draft],
  );
  // 缩略图按整份清单生成：清单外的标记（正在拖拽的草稿）没有缩略图也没有编号。
  // 缓存键用标记 id（稳定身份）：删掉前面一处不会让后面所有缩略图重取。
  const markThumbnailItems = useMemo(() => marks.map((mark) => ({ key: mark.id, mark })), [marks]);
  const { thumbnails: frameThumbnails, capturingKeys } = useVideoEditFrameThumbnails(
    captureVideo,
    thumbnailSourceReady,
    sourceKeyForThumbnails,
    markThumbnailItems,
    videoRef,
    previewSeekingRef,
  );
  /**
   * @ 候选与清单按钮共用的引用输入：全片所有标注都可引用，编号与画面上的序号一致。
   * 描述里一律带帧时间，因此提示词不会把任何一处落到错误的画面上；
   * 已经取到帧的候选还会带上缩略图，让 @ 菜单里能直接看出「这一处标的是什么」。
   */
  const markReferences: readonly PromptMarkReferenceInput[] = marks.map((mark, index) =>
    markReferenceInput(mark, index, frameThumbnails.get(mark.id)),
  );
  const markOrdinalByMarkId = useMemo(
    () => new Map(marks.map((mark, index) => [mark.id, index + 1] as const)),
    [marks],
  );
  const markIndexByMarkId = useMemo(
    () => new Map(marks.map((mark, index) => [mark.id, index] as const)),
    [marks],
  );
  const thumbnailGeometryByMarkId = useMemo(() => {
    const geometryByMarkId = new Map<string, ReturnType<typeof videoEditMarkThumbnailGeometry>>();
    if (!(viewportSize.width > 0 && viewportSize.height > 0)) return geometryByMarkId;
    const area = {
      videoWidth: dimensions.width,
      videoHeight: dimensions.height,
      displayWidth: viewportSize.width,
      displayHeight: viewportSize.height,
    };
    for (const mark of displayedMarks)
      geometryByMarkId.set(mark.id, videoEditMarkThumbnailGeometry(mark, area));
    return geometryByMarkId;
  }, [
    dimensions.height,
    dimensions.width,
    displayedMarks,
    viewportSize.height,
    viewportSize.width,
  ]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="video-local-edit-dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          // 编辑要求编辑器已用 Escape 关闭自己的候选菜单或待确认项时，不连带关闭弹窗。
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (!submitting) onClose();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable="true"], [tabindex="0"]',
            ),
          ).filter(
            (element) =>
              !element.closest("fieldset:disabled") &&
              (!element.closest("details:not([open])") || element.tagName === "SUMMARY"),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (busy || !first) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <header className="video-local-edit-dialog__header">
        <div>
          <h2 id={titleId}>局部消除与编辑</h2>
          <p>{source.label}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭局部编辑"
          onClick={onClose}
          disabled={busy}
        >
          <Icon name="x" aria-hidden="true" size="xl" />
        </button>
      </header>
      <div className="video-local-edit-dialog__body">
        <p id={hintId} className="video-local-edit-dialog__hint">
          暂停在需要修改的画面，框选或圈出对象，可连续标记多处。标注属于它标记的那一帧：
          切换时间不会删除标注，清单里会一直留着（点时间即可回到该画面）；编号全片唯一
          （标注1、标注2……），编辑要求里输入 @ 可以引用任意一处，包括其它时间点的标注。
        </p>
        <div className="video-local-edit-dialog__viewport">
          <video
            ref={videoRef}
            src={previewSrc ?? undefined}
            crossOrigin="anonymous"
            preload="auto"
            playsInline
            aria-label={`待编辑视频：${source.label}`}
            onLoadedMetadata={(event) => updateMetadata(event.currentTarget)}
            onLoadedData={(event) => {
              updateMetadata(event.currentTarget);
              setReady(true);
              setError(null);
              setSourceError(false);
            }}
            onDurationChange={(event) => updateMetadata(event.currentTarget)}
            onSeeking={() => {
              // 内部取缩略图引发的跳帧不该闪「正在定位画面…」。
              if (!previewSeekingRef.current) setSeeking(true);
            }}
            onSeeked={(event) => {
              if (previewSeekingRef.current) return;
              setTime(event.currentTarget.currentTime);
              setSeeking(false);
              setReady(event.currentTarget.readyState >= 2);
            }}
            onTimeUpdate={(event) => {
              if (previewSeekingRef.current) return;
              setTime(event.currentTarget.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={(event) => {
              if (previewSeekingRef.current) return;
              setPlaying(false);
              // 暂停时按元素真实时间校正：timeupdate 的读数可能落后一帧。
              setTime(event.currentTarget.currentTime);
            }}
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (!previewSrc) return;
              setReady(false);
              setSeeking(false);
              setSourceError(true);
              setError(
                "无法加载此视频。请重试读取原视频；如仍失败，请检查源文件是否有效或当前设备是否支持该视频编码。",
              );
            }}
          />
          <svg
            ref={overlayRef}
            className="video-local-edit-dialog__marks"
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={
              marks.length === currentMarks.length
                ? `视频标注区域，已有 ${marks.length} 处标记`
                : `视频标注区域，当前画面已有 ${currentMarks.length} 处标记，共 ${marks.length} 处`
            }
            aria-disabled={!canDraw}
            onPointerDown={beginMark}
            onPointerCancel={resetDraft}
          >
            {displayedMarks.map((mark) => {
              const first = mark.points[0];
              const last = mark.points.at(-1);
              if (!first || !last) return null;
              const style = {
                fill: "none",
                stroke: mark.color,
                strokeWidth: videoEditStrokeWidth(dimensions.width, dimensions.height),
                strokeLinecap: "round" as const,
                strokeLinejoin: "round" as const,
              };
              return mark.kind === "rectangle" ? (
                <rect
                  key={mark.id}
                  {...style}
                  x={Math.min(first.x, last.x) * dimensions.width}
                  y={Math.min(first.y, last.y) * dimensions.height}
                  width={Math.abs(last.x - first.x) * dimensions.width}
                  height={Math.abs(last.y - first.y) * dimensions.height}
                />
              ) : (
                <polyline
                  key={mark.id}
                  {...style}
                  points={mark.points
                    .map((point) => `${point.x * dimensions.width},${point.y * dimensions.height}`)
                    .join(" ")}
                />
              );
            })}
            {/*
              画面上的序号与清单、提示词里的「标注N」一一对应：多处标记时模型只靠彩色
              线条分不清哪条对应哪句话。只有一处标记时编号不产生歧义，保持画面干净。
              位置与半径复用导出帧的同一份计算，保证屏幕与模型看到的是同一个编号。
            */}
            {displayedMarks.length > 1
              ? displayedMarks.map((mark, index) => {
                  // 已经拿到该帧缩略图的标记不再画圆圈：缩略图上的编号徽标取代了它。
                  if (frameThumbnails.get(mark.id) != null) return null;
                  const badge = videoEditMarkBadge(mark, dimensions.width, dimensions.height);
                  if (badge == null) return null;
                  return (
                    <g
                      key={`ordinal-${mark.id}`}
                      aria-hidden="true"
                      /* 正在取这一帧的缩略图：圆圈先淡出，取到后整体让位给缩略图。 */
                      opacity={capturingKeys.has(mark.id) ? 0.45 : 1}
                    >
                      <circle
                        cx={badge.x}
                        cy={badge.y}
                        r={badge.radius}
                        fill="#ffffff"
                        stroke={mark.color}
                        strokeWidth={Math.max(1.5, badge.radius * 0.14)}
                      />
                      <text
                        x={badge.x}
                        y={badge.y}
                        fill={mark.color}
                        fontSize={badge.radius * 1.32}
                        fontWeight="bold"
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {index + 1}
                      </text>
                    </g>
                  );
                })
              : null}
          </svg>
          {/*
            标注缩略图：直接贴着标记区域站在画面上，尺寸随区域宽高比自适应，
            一眼就能认出「这一处标的是哪一帧里的什么东西」，比一个红圈更能区分多处标记。
            它不接指针事件，画面上照常框选/圈选。
          */}
          <div
            ref={measureThumbnailLayer}
            className="video-local-edit-dialog__thumbnails"
            aria-hidden="true"
          >
            {displayedMarks.map((mark) => {
              const source = frameThumbnails.get(mark.id);
              const geometry = thumbnailGeometryByMarkId.get(mark.id);
              if (source == null || geometry == null) return null;
              return (
                <figure
                  key={`thumbnail-${mark.id}`}
                  className="video-local-edit-dialog__thumbnail"
                  data-mark-id={mark.id}
                  data-frame-thumbnail={mark.timeSeconds.toFixed(3)}
                  style={
                    {
                      "--annotation-color": mark.color,
                      left: `${geometry.left}px`,
                      top: `${geometry.top}px`,
                      width: `${geometry.width}px`,
                      height: `${geometry.height}px`,
                    } as CSSProperties
                  }
                >
                  <img src={source} alt="" />
                  <figcaption className="video-local-edit-dialog__thumbnail-index">
                    {markOrdinalByMarkId.get(mark.id) ?? "?"}
                  </figcaption>
                </figure>
              );
            })}
          </div>
          {(!ready || seeking) && !error && (
            <div className="video-local-edit-dialog__loading" role="status">
              {seeking ? "正在定位画面…" : previewSrc ? "正在加载视频…" : "正在读取原视频…"}
            </div>
          )}
        </div>
        <div className="video-local-edit-dialog__timeline">
          <button
            type="button"
            aria-label={playing ? "暂停视频" : "播放视频"}
            onClick={() => void togglePlayback()}
            disabled={!ready || busy || seeking || !!draft}
          >
            {playing ? (
              <Icon name="pause" aria-hidden="true" size="lg" />
            ) : (
              <Icon name="play" aria-hidden="true" size="lg" />
            )}
          </button>
          <input
            type="range"
            aria-label="视频时间"
            min={0}
            max={duration || 1}
            step={0.01}
            value={time}
            onChange={(event) => seekTo(Number(event.target.value))}
            disabled={!ready || duration <= 0 || busy || !!draft}
            aria-valuetext={`${formatVideoEditTime(time)} / ${formatVideoEditTime(duration)}`}
          />
          <output>
            {formatVideoEditTime(time)} / {formatVideoEditTime(duration)}
          </output>
        </div>
        <div className="video-local-edit-dialog__toolbar" role="group" aria-label="区域标注工具">
          <button
            type="button"
            aria-pressed={tool === "rectangle"}
            disabled={!canDraw || !!draft}
            onClick={() => setTool("rectangle")}
          >
            <Icon name="rectangle" aria-hidden="true" size="lg" />
            框选
          </button>
          <button
            type="button"
            aria-pressed={tool === "freehand"}
            disabled={!canDraw || !!draft}
            onClick={() => setTool("freehand")}
          >
            <Icon name="pencil-simple" aria-hidden="true" size="lg" />
            画笔
          </button>
          <span className="video-local-edit-dialog__separator" />
          {VIDEO_EDIT_COLORS.map((entry) => (
            <button
              key={entry.value}
              className="video-local-edit-dialog__color"
              style={{ "--annotation-color": entry.value } as CSSProperties}
              type="button"
              aria-label={`${entry.label}标记`}
              aria-pressed={color === entry.value}
              disabled={!canDraw || !!draft}
              onClick={() => setColor(entry.value)}
            >
              {color === entry.value && <Icon name="check" aria-hidden="true" size="md" />}
            </button>
          ))}
          <span className="video-local-edit-dialog__separator" />
          <button
            type="button"
            title="撤销当前画面的最后一处标注"
            disabled={!canDraw || currentMarks.length === 0 || !!draft}
            onClick={undoMark}
          >
            <Icon name="arrow-counter-clockwise" aria-hidden="true" size="lg" />
            撤销
          </button>
          <button
            type="button"
            title="清除当前画面的全部标注，其它时间点的标注保留"
            disabled={!canDraw || currentMarks.length === 0 || !!draft}
            onClick={clearFrameMarks}
          >
            <Icon name="trash" aria-hidden="true" size="lg" />
            清除
          </button>
          <span className="video-local-edit-dialog__count" role="status">
            {playing
              ? "暂停后可标注"
              : marks.length === currentMarks.length
                ? `已标记 ${marks.length} 处`
                : `本帧 ${currentMarks.length} 处 · 全片 ${marks.length} 处`}
          </span>
        </div>
        {marks.length > 0 ? (
          <ul className="video-local-edit-dialog__mark-list" aria-label="已标注区域">
            {markFrames.flatMap((frame) => {
              const frameText = formatVideoEditTime(frame.timeSeconds);
              const isCurrent = frame === currentFrame;
              return frame.marks.map((mark) => {
                // 编号取标记在整份清单里的位置：全片唯一，因此「标注2」永远指同一处。
                const index = markIndexByMarkId.get(mark.id) ?? 0;
                const label = videoEditMarkLabel(index);
                return (
                  <li key={mark.id} className={isCurrent ? undefined : "is-off-frame"}>
                    <span
                      className="video-local-edit-dialog__mark-swatch"
                      style={{ "--annotation-color": mark.color } as CSSProperties}
                      aria-hidden="true"
                    />
                    <span className="video-local-edit-dialog__mark-label">{label}</span>
                    {isCurrent ? (
                      <span className="video-local-edit-dialog__mark-frame">当前帧</span>
                    ) : (
                      <button
                        type="button"
                        className="video-local-edit-dialog__mark-frame"
                        aria-label={`回到 ${frameText} 标注的画面`}
                        title={`回到 ${frameText} 标注的画面`}
                        disabled={busy}
                        onClick={() => seekTo(frame.timeSeconds)}
                      >
                        {frameText}
                      </button>
                    )}
                    <span className="video-local-edit-dialog__mark-detail">
                      {describeVideoEditMark(mark)}
                    </span>
                    <button
                      type="button"
                      /*
                       * 全片唯一的编号 + 描述里的帧时间，使任何一处标注都能被引用：
                       * 属于其它画面的标注在提示词里也说得清是「哪一帧的哪一处」。
                       */
                      aria-label={
                        isCurrent
                          ? `在编辑要求中引用${label}`
                          : `在编辑要求中引用 ${frameText} 画面的${label}`
                      }
                      title={
                        isCurrent
                          ? `在编辑要求中引用${label}`
                          : `引用 ${frameText} 画面的${label}：提示词会写明它的时间读数`
                      }
                      disabled={!canDraw || busy}
                      onClick={() => quoteMark(index)}
                    >
                      <Icon name="at" aria-hidden="true" size="md" />
                      引用
                    </button>
                    <button
                      type="button"
                      aria-label={isCurrent ? `删除${label}` : `删除 ${frameText} 画面的${label}`}
                      title={isCurrent ? `删除${label}` : `删除 ${frameText} 画面的${label}`}
                      disabled={busy}
                      onClick={() => deleteMark(mark.id)}
                    >
                      <Icon name="trash-simple" aria-hidden="true" size="md" />
                    </button>
                  </li>
                );
              });
            })}
          </ul>
        ) : null}
        <details className="video-local-edit-dialog__keyboard-region">
          <summary>输入坐标框选</summary>
          <fieldset disabled={!canDraw || !!draft}>
            <legend>按画面百分比指定区域</legend>
            {(
              [
                { key: "x", label: "左侧位置" },
                { key: "y", label: "顶部位置" },
                { key: "width", label: "区域宽度" },
                { key: "height", label: "区域高度" },
              ] as const
            ).map(({ key, label }) => (
              <label key={key}>
                {label} (%)
                <input
                  type="number"
                  min={key === "x" || key === "y" ? 0 : 1}
                  max={100}
                  value={region[key]}
                  onChange={(event) =>
                    setRegion((previous) => ({
                      ...previous,
                      [key]: Math.max(0, Math.min(100, Number(event.target.value))),
                    }))
                  }
                />
              </label>
            ))}
            <button
              type="button"
              disabled={
                region.width <= 0 || region.height <= 0 || region.x >= 100 || region.y >= 100
              }
              onClick={() => {
                setMarks((previous) => [
                  ...previous,
                  {
                    id: newVideoEditMarkId(),
                    timeSeconds: frameTimeSeconds(),
                    kind: "rectangle",
                    color,
                    points: [
                      { x: region.x / 100, y: region.y / 100 },
                      {
                        x: Math.min(100, region.x + region.width) / 100,
                        y: Math.min(100, region.y + region.height) / 100,
                      },
                    ],
                  },
                ]);
                setError(null);
              }}
            >
              添加框选
            </button>
          </fieldset>
        </details>
        <fieldset className="video-local-edit-dialog__instruction" disabled={busy}>
          <legend>编辑要求</legend>
          <div
            className="video-local-edit-dialog__operation"
            role="group"
            aria-label="局部编辑方式"
          >
            <button
              type="button"
              aria-pressed={operation === "remove"}
              onClick={() => setOperation("remove")}
            >
              局部消除
            </button>
            <button
              type="button"
              aria-pressed={operation === "replace"}
              onClick={() => setOperation("replace")}
            >
              替换与编辑
            </button>
          </div>
          <span id={instructionLabelId}>
            {operation === "remove"
              ? "要消除什么，哪些内容需要保持？"
              : "替换成什么，哪些内容需要保持？"}
          </span>
          <div className="video-local-edit-dialog__reference-editor">
            <PromptMentionInput
              nodeKey={INSTRUCTION_EDITOR_KEY}
              candidates={candidates}
              annotationMentions={markReferences}
              registerInput={registerInstructionInput}
              labelledBy={instructionLabelId}
              describedBy={instructionHintId}
              onTextChange={setInstructionText}
              placeholder="例如：把 @标注1 替换为红玫瑰、消除 @标注2，并说明哪些内容需要保持。"
            />
          </div>
          <div
            className="video-local-edit-dialog__operation"
            role="group"
            aria-label="编辑生效范围"
          >
            <button
              type="button"
              aria-pressed={!rangeEnabled}
              onClick={() => setRangeEnabled(false)}
            >
              全片生效
            </button>
            <button
              type="button"
              aria-pressed={rangeEnabled}
              onClick={() => {
                setRangeEnabled(true);
                if (rangeEnd === 0) setRangeEnd(duration);
              }}
            >
              指定时段
            </button>
          </div>
          {rangeEnabled && (
            <div className="video-local-edit-dialog__range">
              <label>
                开始时间（秒）
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={rangeStart}
                  onChange={(event) => setRangeStart(Number(event.target.value))}
                />
              </label>
              <label>
                结束时间（秒）
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={rangeEnd}
                  onChange={(event) => setRangeEnd(Number(event.target.value))}
                />
              </label>
              {!validRange && <p role="alert">结束时间须晚于开始时间，且范围须在视频时长内。</p>}
            </div>
          )}
          <p id={instructionHintId} className="video-local-edit-dialog__hint">
            当前帧用于定位对象；
            {rangeEnabled ? "只在指定时段执行修改。" : "将在全片中跟随该对象保持修改一致。"}
            输入 @ 可引用当前节点已连接的素材，也可引用任意画面标注（标注1、标注2…）：
            属于其它时间点的标注会带上它的时间读数写入提示词；未引用的连线素材仍会随请求传入。
          </p>
        </fieldset>
        {notice && (
          <p className="video-local-edit-dialog__notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="video-local-edit-dialog__error" role="alert">
            {error}
          </p>
        )}
        {error && sourceError && needsPreparation && (
          <button type="button" onClick={reloadSource} disabled={busy}>
            重新读取视频
          </button>
        )}
        {canUploadToLibrary && (
          <div className="video-local-edit-dialog__upload-option">
            <label>
              <input
                type="checkbox"
                checked={uploadToLibrary}
                disabled={busy}
                onChange={(event) => setUploadToLibrary(event.target.checked)}
              />
              上传标注帧到云端素材库
            </label>
            <p className="video-local-edit-dialog__hint">
              默认开启：只有入库的素材才会以平台可校验的资产身份提交，否则会被判定为来源不明的真人素材而拒绝。
              确认片中没有真人时可取消勾选，避免产生冗余的云端素材。
            </p>
          </div>
        )}
      </div>
      {/*
        取帧用的后台 video：只为生成标注缩略图，不显示也不参与预览播放，
        因此取帧永远不会打断画面上正在播放/暂停的那一帧。
      */}
      <video
        ref={attachCaptureVideo}
        className="video-local-edit-dialog__capture-source"
        src={previewSrc ?? undefined}
        crossOrigin="anonymous"
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        muted
        playsInline
      />
      <footer className="video-local-edit-dialog__footer">
        <p>
          {busy
            ? (frameProgress ?? "正在添加标注帧…")
            : frameImportFailed
              ? "标注帧已存到本地，但没有完成入库。修正后可直接重试；若只是想让任务先跑起来，也可以取消勾选上面的入库选项。"
              : (applyDisabledReason ?? "标注帧与编辑要求将添加到当前视频生成节点。")}
        </p>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="video-local-edit-dialog__apply"
          type="button"
          disabled={!canApply}
          onClick={() => void apply()}
        >
          {busy ? "正在添加标注帧…" : frameImportFailed ? "重试入库并添加" : "添加到生成节点"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
