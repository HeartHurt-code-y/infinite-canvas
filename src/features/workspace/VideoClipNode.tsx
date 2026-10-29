import { memo } from "react";
import { CanvasNodeEditorShell } from "./CanvasNodeEditor";
import { VideoClipEditor } from "./VideoClipEditor";
import { VideoClipNodeView } from "./VideoClipNodeView";
import type { PromptContentEditorSession } from "../../lib/promptContent";
import type { MentionCandidate, VideoClipInput, VideoClipNodeData } from "./workspaceModel";
import type { VideoClipModeKey, VideoClipParams } from "./videoClipModes";
import { resolveVideoClipParams } from "./videoClipModes";

/**
 * 智能剪辑节点的两种呈现。
 *
 * - `card`：画布上的节点卡（空态 / 连接态）。
 * - `editor`：画布编辑层里的合成面板，由 `CanvasNodeEditorShell` 贴到节点下方。
 *
 * 与生成节点同一套机制：卡片随 React Flow 缩放，编辑层挂在独立的
 * `.video-node-editor-layer` 里保持 1:1（否则 45% 缩放下 658.7px 的面板会被缩成 296px）。
 */
export const VideoClipNode = memo(function VideoClipNode({
  node,
  inputs,
  candidates,
  aliveCanvasNodeKeys,
  selected,
  dragging,
  editorOpen,
  presentation = "card",
  busy,
  error,
  registerPromptInput,
  onSelect,
  onNodeDragStart,
  onCloseEditor,
  onModeChange,
  onParamsChange,
  onSubmit,
  onTryMode,
  onOpenEditor,
  onUnlink,
}: {
  readonly node: VideoClipNodeData;
  readonly inputs: readonly VideoClipInput[];
  readonly candidates: readonly MentionCandidate[];
  readonly aliveCanvasNodeKeys?: ReadonlySet<string> | undefined;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly editorOpen: boolean;
  readonly presentation?: "card" | "editor";
  readonly busy: boolean;
  readonly error: string | null;
  readonly registerPromptInput: (
    nodeKey: string,
    session: PromptContentEditorSession | null,
  ) => void;
  readonly onSelect: (key: string) => void;
  readonly onNodeDragStart: (
    key: string,
    x: number,
    y: number,
    clientX: number,
    clientY: number,
  ) => void;
  readonly onCloseEditor: () => void;
  readonly onModeChange: (nodeKey: string, modeKey: VideoClipModeKey) => void;
  readonly onParamsChange: (nodeKey: string, params: VideoClipParams) => void;
  readonly onSubmit: (nodeKey: string) => void;
  readonly onTryMode: (nodeKey: string, modeKey: string) => void;
  readonly onOpenEditor: (nodeKey: string) => void;
  readonly onUnlink: (edgeId: string) => void;
}) {
  if (presentation === "card") {
    return (
      <VideoClipNodeView
        node={node}
        inputs={inputs}
        selected={selected}
        busy={busy}
        dragging={dragging}
        onSelect={onSelect}
        onNodeDragStart={onNodeDragStart}
        onTryMode={onTryMode}
        onOpenEditor={onOpenEditor}
      />
    );
  }
  return (
    <CanvasNodeEditorShell
      nodeKey={node.key}
      kindLabel="智能剪辑"
      anchor={{
        x: node.x,
        y: node.y,
        width: node.measured?.width ?? 350,
        height: node.measured?.height ?? 350,
      }}
      name={node.name ?? "智能剪辑"}
      open={editorOpen}
      onClose={onCloseEditor}
    >
      <VideoClipEditor
        node={node}
        inputs={inputs}
        params={resolveVideoClipParams(node.config)}
        candidates={candidates}
        {...(aliveCanvasNodeKeys ? { aliveCanvasNodeKeys } : {})}
        registerPromptInput={registerPromptInput}
        busy={busy}
        error={error}
        onModeChange={(modeKey) => onModeChange(node.key, modeKey)}
        onParamsChange={(params) => onParamsChange(node.key, params)}
        onSubmit={() => onSubmit(node.key)}
        onUnlink={onUnlink}
      />
    </CanvasNodeEditorShell>
  );
});
