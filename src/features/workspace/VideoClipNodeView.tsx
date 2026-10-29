import { memo } from "react";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
import type { VideoClipNodeData, VideoClipInput } from "./workspaceModel";
import { VIDEO_CLIP_MODES } from "./videoClipModes";
import "./VideoClipEditor.css";

/**
 * 「智能剪辑」节点卡。
 *
 * 照抄原站 liblib.tv 的 `video-clip` 节点（实测 2026-10-23，画布缩放 45%，
 * 下面的尺寸已换算回 100% 缩放）：
 *
 * - 节点类型名 `video-clip`，React Flow 根类 `react-flow__node-video-clip`。
 * - 空态卡片 350×350：40px 剪刀图标 + 「空空如也，请连接视频节点后操作」+
 *   「尝试：」一行四个预设模式（14px 图标 + 13px 文字）。
 * - 连接态卡片 566×350：252px 高的首素材预览（圆角 16 的封面图 + 压暗层 +
 *   居中剪刀图标 + 「打开智能剪辑」按钮），下面 82px 的时间刻度与两条轨道占位。
 * - 卡片外没有任何边框与圆角（圆角只在内容层 `rounded-xl`）。
 */
export const VideoClipNodeView = memo(function VideoClipNodeView({
  node,
  inputs,
  selected,
  busy,
  dragging,
  onSelect,
  onNodeDragStart,
  onTryMode,
  onOpenEditor,
}: {
  readonly node: VideoClipNodeData;
  readonly inputs: readonly VideoClipInput[];
  readonly selected: boolean;
  readonly busy: boolean;
  readonly dragging: boolean;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  /** 点「尝试：」里的某个模式：写入模式并预置提示词。 */
  readonly onTryMode: (nodeKey: string, modeKey: string) => void;
  /** 「打开智能剪辑」：进入原站的视频剪辑时间轴编辑器。 */
  readonly onOpenEditor: (nodeKey: string) => void;
}) {
  const primary = inputs.find((input) => input.nodeType === "video") ?? inputs[0] ?? null;

  return (
    <div
      id={`node-preview-${node.key}`}
      className={`video-clip-node${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ width: primary ? 566 : 350 }}
      aria-busy={busy || undefined}
      data-connection-target={node.key}
      onMouseDown={(event) => {
        onSelect(node.key);
        if ((event.target as HTMLElement).closest("button, input, textarea")) return;
        onNodeDragStart(node.key, node.x, node.y, event.clientX, event.clientY);
      }}
    >
      <div className="video-clip-node__card">
        {primary ? (
          <VideoClipConnectedBody primary={primary} onOpenEditor={() => onOpenEditor(node.key)} />
        ) : (
          <div className="video-clip-node__empty">
            <CanvasChromeIcon name="cut" size={40} className="video-clip-node__empty-icon" />
            <p className="video-clip-node__empty-hint">空空如也，请连接视频节点后操作</p>
            <div className="video-clip-node__try">
              <span className="video-clip-node__try-label">尝试：</span>
              {VIDEO_CLIP_MODES.map((mode) => {
                const ModeIcon = mode.icon;
                return (
                  <button
                    key={mode.modeKey}
                    type="button"
                    className="video-clip-node__try-item"
                    title={mode.description}
                    disabled={busy}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTryMode(node.key, mode.modeKey);
                    }}
                  >
                    <ModeIcon aria-hidden="true" width={14} height={14} strokeWidth={1.75} />
                    <span>{mode.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {busy ? <div className="video-clip-node__busy" role="status">剪辑中…</div> : null}
    </div>
  );
});

/**
 * 连接态：原站展示第一段视频作为封面，下面是时间刻度与两条轨道占位。
 * 刻度每 2 秒一格，标签用 `m:ss`。
 */
function VideoClipConnectedBody({
  primary,
  onOpenEditor,
}: {
  readonly primary: VideoClipInput;
  readonly onOpenEditor: () => void;
}) {
  const duration = Math.max(0, primary.durationSeconds ?? 0);
  const tickStep = Math.max(2, Math.ceil(duration / 16 / 2) * 2);
  const tickCount = Math.min(17, Math.max(1, Math.floor(duration / tickStep) + 1));
  return (
    <div className="video-clip-node__body">
      <div className="video-clip-node__preview">
        {primary.previewUrl ? (
          <img className="video-clip-node__cover" src={primary.previewUrl} alt={primary.name} />
        ) : null}
        <div className="video-clip-node__preview-backdrop" />
        <div className="video-clip-node__preview-center">
          <CanvasChromeIcon name="cut" size={18} />
          <button
            type="button"
            className="video-clip-node__open"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenEditor();
            }}
          >
            打开智能剪辑
          </button>
        </div>
      </div>
      <div className="video-clip-node__timeline">
        {/*
         * 刻度尺是纯视觉预览（原站的封面式时间轴），真实时长在素材信息与编辑层里。
         * 不标 aria-hidden 的话，读屏会把几十个「0:00、0:02…」逐个念出来。
         */}
        <div className="video-clip-node__ruler" aria-hidden="true">
          {Array.from({ length: tickCount }, (_, index) => {
            const seconds = index * tickStep;
            return (
              <div key={seconds} className="video-clip-node__tick">
                <span className="video-clip-node__tick-label">
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                </span>
                <span className="video-clip-node__tick-mark" />
              </div>
            );
          })}
        </div>
        <div className="video-clip-node__track">
          <div className="video-clip-node__track-bar" />
        </div>
        <div className="video-clip-node__track">
          <div className="video-clip-node__track-bar" />
        </div>
      </div>
    </div>
  );
}
