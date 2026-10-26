/*
 * 产物详情整页视图（即梦的「作品详情」浮层）。
 *
 * 实测规格（2026-10-22 活体，见 docs/integrations/jimeng-generate-page-re.md 第七节）：
 *   · 左侧：大图区（按高度自适应，居中）；图片版底部有 `‹ n / N ›` 翻页，
 *     视频版则是大图区**右侧竖排**两枚 36×36 箭头；
 *   · 右侧栏 `.detail-area-kykVkS`：宽 440、底色 #121212、内边距 8px 40px 20px、可滚动；
 *     - 顶部行 `.operation-area-PCKujQ`：左「下载」，右「☆ / ⋯」；
 *     - 中段 `.info-section-EmHOQF`：图片版有缩略图条（86×86、间隙 4px），
 *       标题是「图片提示词」/「视频提示词」（14px/22、色 rgba(255,255,255,.6)），
 *       提示词正文（可展开/收起）+ 参数标签行；
 *       视频版的「详细信息 ⓘ」**另起一行**（`.detail-info-fBoMDH` 是 column 布局）；
 *     - 工具面板：两块卡片 `.group-container-Sia8JH`
 *       （底色 rgba(255,255,255,.08)、圆角 12px、内边距 4px），
 *       卡内是 168×36 的两列网格（间隙 4px），按钮
 *       `.detail-button-view-z0I6nJ`：圆角 8px、内边距 0 14px、图标 16px、
 *       文字 13px/24、色 rgb(250,250,250)；
 *     - 底部卡片：重新编辑 / 再次生成。
 *
 * **工具面板按媒体类型不同**（活体实测）：
 *   图片：卡 1 = 生成视频 | 去画布编辑 › / 用作参考图（整行）；
 *         卡 2 = 智能超清 | 多角度(New) / 超清 | 智能改图 / 细节修复 | 局部重绘 /
 *               扩图 | 消除笔 / 对口型（整行）
 *   视频：卡 1 = 用作参考视频 | 去画布编辑 ›；
 *         卡 2 = 局部重拍 | 智能超清✦ / 视频延长 | 视频编辑 / 补帧✦ | 对口型 /
 *               全能配音 | 擦除字幕✦New
 *
 * 本项目能真做的只有「用作参考图/视频」「生成视频」「重新编辑」「再次生成」，
 * 其余都是即梦后端的能力，按项目约定保留入口并标出「后端暂未接入」。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useModalFocusTrap } from "../../components/useModalFocusTrap";
import { backendErrorMessage } from "../../lib/backend";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { toast } from "../../lib/toast";
import { JimengIcon, type JimengIconName } from "./JimengIcon";
import { RecordProductMenu } from "./CreateProductMenu";
import { productMenuEntries } from "./createProductMenuModel";
import type { CreateRecord, CreateResultItem } from "./useCreateSession";
import "./CreateDetailView.css";

export interface CreateDetailViewProps {
  readonly record: CreateRecord;
  /** 抬头显示的标题（重命名后是用户起的新名字，否则是提示词）。 */
  readonly title: string;
  /** 当前看的是第几个产物。 */
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  /**
   * 打开这一页的媒体元素（记录流里那张图 / 那个视频）。
   *
   * 关闭时要把焦点还给它：焦点掉回 `document.body` 的话，键盘用户既看不到
   * 自己在哪，也接不上「再生成一次」。
   */
  readonly returnFocusTo?: HTMLElement | null | undefined;
  readonly onUseAsReference?: ((result: CreateResultItem) => void) | undefined;
  readonly onGenerateVideo?: ((result: CreateResultItem) => void) | undefined;
  readonly onRegenerate?: ((record: CreateRecord) => void) | undefined;
  readonly onEdit?: ((record: CreateRecord) => void) | undefined;
  /**
   * 重命名这条记录。
   *
   * 即梦的详情浮层顶部只有「下载 / 收藏 / ⋯」，没有重命名；但本项目有
   * 「给产物命名」的后端能力，删掉就丢了，所以在这层补一枚入口。
   */
  readonly onRename?: ((record: CreateRecord, name: string) => Promise<void>) | undefined;
}

/** 工具面板里的一项。 */
interface DetailTool {
  readonly id: string;
  readonly label: string;
  readonly icon: JimengIconName;
  /** 占满两列（即梦的「用作参考图」「对口型」）。 */
  readonly wide?: boolean;
  /** 即梦给「新功能」打的 New 角标。 */
  readonly isNew?: boolean;
  /** 即梦给 AI 能力打的蓝色 ✦ 标记。 */
  readonly aiMark?: boolean;
  /** 点下去要做什么；没有就是后端未接入。 */
  readonly action?: "reference" | "generate-video";
}

/** 图片版的第一块卡片：生成视频 / 去画布编辑 / 用作参考图。 */
const DETAIL_GROUP_PRIMARY_IMAGE: readonly DetailTool[] = [
  { id: "generate-video", label: "生成视频", icon: "toolGenerateVideo", action: "generate-video" },
  { id: "canvas-edit", label: "去画布编辑", icon: "toolCanvasEdit" },
  {
    id: "as-reference",
    label: "用作参考图",
    icon: "toolAsReferenceImage",
    wide: true,
    action: "reference",
  },
];

/** 图片版的第二块卡片：八个图片编辑工具。 */
const DETAIL_GROUP_EDIT_IMAGE: readonly DetailTool[] = [
  { id: "super-resolution", label: "智能超清", icon: "toolSuperResolution" },
  { id: "multi-angle", label: "多角度", icon: "toolMultiAngle", isNew: true },
  { id: "ultra-clear", label: "超清", icon: "toolUltraClear" },
  { id: "smart-edit", label: "智能改图", icon: "toolSmartEdit" },
  { id: "detail-fix", label: "细节修复", icon: "toolDetailFix" },
  { id: "local-redraw", label: "局部重绘", icon: "toolLocalRedraw" },
  { id: "outpaint", label: "扩图", icon: "toolOutpaint" },
  { id: "eraser", label: "消除笔", icon: "toolEraser" },
  { id: "lip-sync", label: "对口型", icon: "toolLipSync", wide: true },
];

/** 视频版的第一块卡片：用作参考视频 / 去画布编辑（没有「生成视频」）。 */
const DETAIL_GROUP_PRIMARY_VIDEO: readonly DetailTool[] = [
  { id: "as-reference", label: "用作参考视频", icon: "toolAsReference", action: "reference" },
  { id: "canvas-edit", label: "去画布编辑", icon: "toolCanvasEdit" },
];

/** 视频版的第二块卡片：八个视频编辑工具（带 ✦ 的是即梦打了 AI 标记的）。 */
const DETAIL_GROUP_EDIT_VIDEO: readonly DetailTool[] = [
  { id: "retake", label: "局部重拍", icon: "toolRetake" },
  { id: "super-resolution", label: "智能超清", icon: "toolSuperResolution", aiMark: true },
  { id: "extend", label: "视频延长", icon: "toolExtendVideo" },
  { id: "video-edit", label: "视频编辑", icon: "toolVideoEdit" },
  { id: "interpolate", label: "补帧", icon: "toolInterpolate", aiMark: true },
  { id: "lip-sync", label: "对口型", icon: "toolLipSync" },
  { id: "dubbing", label: "全能配音", icon: "toolDubbing" },
  {
    id: "remove-subtitle",
    label: "擦除字幕",
    icon: "toolRemoveSubtitle",
    aiMark: true,
    isNew: true,
  },
];

/** 产物可显示的地址：本地落盘优先，否则回退到远端地址。 */
function mediaSrc(result: CreateResultItem): string | null {
  if (result.finalPath) return convertFileSrc(result.finalPath);
  if (result.remoteUrl) return toMediaProxyUrl(result.remoteUrl);
  return null;
}

/** 秒 → `mm:ss`（即梦播放条的时间写法）。 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.round(seconds);
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 提示词区的展开/收起切换。 */
function usePromptToggle(): {
  readonly expanded: boolean;
  readonly toggle: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback((): void => setExpanded((previous) => !previous), []);
  return { expanded, toggle };
}

/** 视频详情页里那条自带控制条的播放器。 */
function DetailVideoPlayer({ src }: { readonly src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  const toggle = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seek = useCallback((ratio: number): void => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(1, Math.max(0, ratio)) * video.duration;
  }, []);

  const fullscreen = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    const holder = video.closest(".create-detail__player");
    const target = holder instanceof HTMLElement ? holder : video;
    void target.requestFullscreen?.().catch(() => undefined);
  }, []);

  const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  return (
    <div className="create-detail__player">
      <video
        ref={videoRef}
        className="create-detail__video"
        src={src}
        playsInline
        loop
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div
        className="create-detail__player-progress"
        role="slider"
        aria-label="调整视频播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width <= 0) return;
          seek((event.clientX - box.left) / box.width);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") seek(Math.min(1, ratio + 0.05));
          if (event.key === "ArrowLeft") seek(Math.max(0, ratio - 0.05));
        }}
      >
        <div className="create-detail__player-track">
          <div className="create-detail__player-played" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
      <div className="create-detail__player-bar">
        <div className="create-detail__player-left">
          <button
            type="button"
            className="create-detail__player-button"
            aria-label={playing ? "暂停" : "播放"}
            onClick={toggle}
          >
            <JimengIcon name={playing ? "playerPause" : "playerPlay"} />
          </button>
          <span className="create-detail__player-time">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
        <div className="create-detail__player-right">
          <button
            type="button"
            className="create-detail__player-button"
            aria-label={muted ? "取消静音" : "静音"}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !video.muted;
              setMuted(video.muted);
            }}
          >
            <JimengIcon name={muted ? "playerMuted" : "playerMute"} />
          </button>
          <button
            type="button"
            className="create-detail__player-button"
            aria-label="全屏"
            onClick={fullscreen}
          >
            <JimengIcon name="playerFullscreen" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function CreateDetailView({
  record,
  title,
  index,
  onIndexChange,
  onClose,
  returnFocusTo,
  onUseAsReference,
  onGenerateVideo,
  onRegenerate,
  onEdit,
  onRename,
}: CreateDetailViewProps) {
  const results = record.results;
  const current = results[index];
  const isVideo = current?.mediaType === "video";
  const labels = [record.modelName, ...record.parameterLabels];
  const { expanded, toggle } = usePromptToggle();

  /* 焦点管理：进得来、关得回（由 useModalFocusTrap 统一负责）。 */
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  /* 缩略图：只有能显示的产物才进条。视频版即梦不显示缩略图条（用右侧箭头翻页）。 */
  const thumbs = useMemo(
    () =>
      isVideo
        ? []
        : results
            .map((result, position) => ({ result, position }))
            .filter((item) => mediaSrc(item.result) !== null),
    [isVideo, results],
  );

  const runTool = useCallback(
    (tool: DetailTool): void => {
      if (tool.action === "reference" && onUseAsReference !== undefined && current !== undefined) {
        onUseAsReference(current);
        return;
      }
      if (
        tool.action === "generate-video" &&
        onGenerateVideo !== undefined &&
        current !== undefined
      ) {
        onGenerateVideo(current);
        return;
      }
      toast("该功能后端暂未接入。");
    },
    [current, onGenerateVideo, onUseAsReference],
  );

  /* 重命名：即梦这层没有这个入口，是本项目多出来的（后端有「给产物命名」能力）。 */
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [productOpen, setProductOpen] = useState(false);

  /*
   * Esc 关闭 + Tab 焦点圈 + 背景冻结，统一交给 `useModalFocusTrap`。
   *
   * 之前这里是**自建**的两套：自己监听 document 的 keydown 关 Esc，自己在容器上
   * 算 Tab 焦点圈，自己在 effect 里把焦点移进/移出对话框。结果是全项目 6 个真模态
   * 里只有这一个**没有冻结背景** —— `aria-modal="true"` 只让读屏屏蔽背景，
   * **拦不住指针与焦点**：鼠标点到底层记录流后按 Tab，焦点就逃出去了（自建的
   * Tab 圈只在焦点还在对话框内时收，一旦跑出去就不管了）。
   *
   * 换成 hook 后三件事一起解决：Esc 由 window 捕获阶段接管（嵌套弹窗不抢）、
   * Tab 在弹窗内循环（焦点跑出去也会被收回来）、背景（非弹窗分支的 body 直接
   * 子节点）置 inert —— 指针点不动、读屏与键盘都到不了背景。打开时聚焦返回按钮、
   * 关闭时把焦点还给触发的那张记录图，也都由 hook 负责（`initialFocusRef` /
   * `returnFocusRef`）。
   *
   * 产物菜单（右上角 ⋯）开着时不抢 Esc：那一步先关菜单，而不是把整页关掉。
   */
  /*
   * 焦点归还目标：调用方给的是**元素本身**（打开这一页的那张记录图），
   * hook 要的是 RefObject —— 这里用一个 ref 承载，元素变化时同步进去。
   *
   * 刻意在**渲染期**赋值而不是放进 effect：hook 在**卸载时**读这个 ref 来归还
   * 焦点。放进 effect 的话，effect 要等渲染+提交后才跑，若组件在 effect 之前
   * 就被卸载，ref 还是 null，焦点就永远还不回去了。渲染期赋值是同步的，没有
   * 这个时序漏洞。
   *
   * 渲染期写 ref 通常不被推荐，但这里的值来自 props 且**在整个弹窗生命周期内
   * 不变**（就是打开这一页的那张记录图），不存在「渲染被丢弃后 ref 指向未提交
   * 的值」的问题。严格模式的双渲染也只是把同一个值写两遍，无害。
   */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  returnFocusRef.current = returnFocusTo ?? null;
  const trap = useModalFocusTrap({
    active: true,
    onEscape: productOpen ? undefined : onClose,
    initialFocusRef: backRef,
    returnFocusRef,
  });

  const save = async (): Promise<void> => {
    const name = draft.trim();
    if (name === "") {
      toast.error("名称不能为空", { description: "给这条记录起个名字再保存。" });
      return;
    }
    setSaving(true);
    try {
      await onRename?.(record, name);
      setRenaming(false);
      toast.success("已重命名", { description: `新名称：${name}` });
    } catch (error) {
      toast.error(backendErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  /*
   * 模态一律 **portal 到 body**。
   *
   * 焦点陷阱的「冻结背景」是按 `document.body` 的**直接子节点**做的：不在弹窗
   * 自己那条分支上的顶层子树全部置 inert。模态若留在 #root 内部，#root 就在
   * 「弹窗的祖先链」上 → 整棵 #root 被豁免 → **背景根本没被冻结**。
   * 创作台的详情视图是真模态，同样要 portal。
   */
  return createPortal(
    <div
      className="create-detail"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={trap.ref}
      /* 容器本身可聚焦：里面一个可聚焦元素都没有时，焦点仍有地方落。 */
      {...trap.containerProps}
    >
      {/* 对话框的可访问名：视觉上这一层没有标题，标题只给读屏。 */}
      <h2 id={titleId} className="sr-only">
        产物详情
      </h2>
      <button
        type="button"
        className="create-detail__back"
        ref={backRef}
        aria-label="返回记录流"
        onClick={onClose}
      >
        <JimengIcon name="detailBack" />
      </button>

      <div className="create-detail__stage">
        <div className="create-detail__media">
          {current === undefined ? null : isVideo ? (
            <DetailVideoPlayer src={mediaSrc(current) ?? ""} />
          ) : (
            <img className="create-detail__image" src={mediaSrc(current) ?? ""} alt="" />
          )}
        </div>
        {isVideo ? (
          /* 视频版即梦没有缩略图条，翻页是大图区右侧竖排的两枚箭头。 */
          <div className="create-detail__pager create-detail__pager--vertical">
            <button
              type="button"
              className="create-detail__pager-button"
              aria-label="上一个"
              disabled={index <= 0}
              onClick={() => onIndexChange(index - 1)}
            >
              <JimengIcon name="detailPrev" />
            </button>
            <button
              type="button"
              className="create-detail__pager-button"
              aria-label="下一个"
              disabled={index >= results.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              <JimengIcon name="detailNext" />
            </button>
          </div>
        ) : (
          <div className="create-detail__pager">
            <button
              type="button"
              className="create-detail__pager-button"
              aria-label="上一个"
              disabled={index <= 0}
              onClick={() => onIndexChange(index - 1)}
            >
              <JimengIcon name="detailPrev" />
            </button>
            <span className="create-detail__counter">
              {index + 1} / {results.length}
            </span>
            <button
              type="button"
              className="create-detail__pager-button"
              aria-label="下一个"
              disabled={index >= results.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              <JimengIcon name="detailNext" />
            </button>
          </div>
        )}
      </div>

      <aside className="create-detail__panel">
        <div className="create-detail__top">
          {renaming ? (
            <div className="create-detail__rename">
              <label className="create-detail__rename-label" htmlFor={inputId}>
                重命名
              </label>
              <input
                id={inputId}
                className="create-detail__rename-input"
                value={draft}
                maxLength={128}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
              <button
                type="button"
                className="create-detail__rename-button"
                disabled={saving}
                onClick={() => void save()}
              >
                保存
              </button>
              <button
                type="button"
                className="create-detail__rename-button"
                onClick={() => setRenaming(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="create-detail__download"
                onClick={() => toast("下载后端暂未接入。")}
              >
                <JimengIcon name="recordDownload" />
                下载
              </button>
              {onRename !== undefined ? (
                <button
                  type="button"
                  className="create-detail__rename-trigger"
                  onClick={() => {
                    setDraft(title);
                    setRenaming(true);
                  }}
                >
                  重命名
                </button>
              ) : null}
            </>
          )}
          <div className="create-detail__top-actions">
            <button
              type="button"
              className="create-detail__icon-button"
              aria-label="收藏"
              onClick={() => toast("收藏后端暂未接入。")}
            >
              <JimengIcon name="recordFavorite" />
            </button>
            <button
              ref={moreRef}
              type="button"
              className="create-detail__icon-button"
              aria-label="更多操作"
              aria-haspopup="dialog"
              aria-expanded={productOpen}
              onClick={() => setProductOpen((previous) => !previous)}
            >
              <JimengIcon name="recordMore" />
            </button>
          </div>
        </div>
        {productOpen && current !== undefined ? (
          <RecordProductMenu
            open
            anchorRef={moreRef}
            items={productMenuEntries(
              isVideo ? "video" : "image",
              current.finalPath !== null && current.finalPath !== "",
              onUseAsReference === undefined
                ? undefined
                : () => {
                    setProductOpen(false);
                    onUseAsReference?.(current);
                  },
            )}
            onClose={() => setProductOpen(false)}
          />
        ) : null}

        <div className="create-detail__info">
          {thumbs.length > 0 ? (
            <div className="create-detail__thumbs">
              {thumbs.map((item) => (
                <button
                  key={`${item.result.taskId}-${item.result.resultIndex}`}
                  type="button"
                  className="create-detail__thumb"
                  data-active={item.position === index ? "true" : "false"}
                  aria-label={`第 ${item.position + 1} 个产物`}
                  onClick={() => onIndexChange(item.position)}
                >
                  <img src={mediaSrc(item.result) ?? ""} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          ) : null}

          <div className="create-detail__prompt-title">{isVideo ? "视频提示词" : "图片提示词"}</div>
          <div className="create-detail__prompt-box">
            <p className="create-detail__prompt" data-expanded={expanded ? "true" : "false"}>
              {record.prompt}
            </p>
            <div className="create-detail__prompt-arrows">
              <button
                type="button"
                className="create-detail__prompt-arrow"
                aria-label="展开提示词"
                onClick={toggle}
              >
                <JimengIcon name="detailChevronUp" />
              </button>
              <button
                type="button"
                className="create-detail__prompt-arrow"
                aria-label="收起提示词"
                onClick={toggle}
              >
                <JimengIcon name="detailChevronDown" />
              </button>
            </div>
          </div>

          <div className="create-detail__labels">
            {labels.map((label) => (
              <span key={label} className="create-detail__label">
                {label}
              </span>
            ))}
          </div>
          {isVideo ? (
            /* 视频版即梦的「详细信息」另起一行。 */
            <div className="create-detail__detail-line">
              <button type="button" className="create-detail__detail">
                详细信息
                <JimengIcon name="detailInfo" />
              </button>
            </div>
          ) : null}
        </div>

        <div className="create-detail__tools">
          {(isVideo
            ? [DETAIL_GROUP_PRIMARY_VIDEO, DETAIL_GROUP_EDIT_VIDEO]
            : [DETAIL_GROUP_PRIMARY_IMAGE, DETAIL_GROUP_EDIT_IMAGE]
          ).map((group, groupIndex) => (
            <div key={groupIndex} className="create-detail__group">
              {group.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className="create-detail__tool"
                  data-wide={tool.wide === true ? "true" : "false"}
                  onClick={() => runTool(tool)}
                >
                  <JimengIcon name={tool.icon} />
                  <span className="create-detail__tool-label">{tool.label}</span>
                  {tool.aiMark === true ? (
                    <JimengIcon name="toolAiMark" className="create-detail__tool-ai" />
                  ) : null}
                  {tool.isNew === true ? (
                    <span className="create-detail__tool-new">New</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="create-detail__bottom">
          <div className="create-detail__group">
            <button type="button" className="create-detail__tool" onClick={() => onEdit?.(record)}>
              <JimengIcon name="detailEdit" />
              <span className="create-detail__tool-label">重新编辑</span>
            </button>
            <button
              type="button"
              className="create-detail__tool"
              onClick={() => onRegenerate?.(record)}
            >
              <JimengIcon name="detailRegenerate" />
              <span className="create-detail__tool-label">再次生成</span>
            </button>
          </div>
        </div>

        {record.error ? (
          <ErrorAlert
            error={record.error}
            hint="这条记录里有产物没生成成功，可以点「再次生成」重试。"
          />
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
