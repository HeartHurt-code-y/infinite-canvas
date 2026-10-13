import { vi } from "vitest";

import { KnowledgeVideoWorkflowNode } from "../features/workspace/KnowledgeVideoWorkflowNode";
import type { KnowledgeVideoWorkflowNodeProps } from "../features/workspace/KnowledgeVideoWorkflowNode";
import { WorkflowSessionRegistry } from "../features/workspace/workflowSessionRegistry";
import {
  WorkflowSessionsProvider,
  type WorkflowSessions,
} from "../features/workspace/useWorkflowSessions";

/**
 * 工作流会话控制器测试桩：全部动作为可断言的 vi.fn，状态面为空。
 * 节点组件测试用它包裹 WorkflowSessionsProvider，直接对 sessions.execute 等
 * 断言调用，无需渲染 WorkspaceApp。
 */
export function createWorkflowSessionsStub(): WorkflowSessions {
  return {
    runs: {},
    registry: new WorkflowSessionRegistry(),
    activeHistoryRunIds: [],
    run: vi.fn(),
    execute: vi.fn(),
    approvePlan: vi.fn(),
    continueRun: vi.fn(),
    redoShot: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
    undoVersion: vi.fn(),
    redoVersion: vi.fn(),
    restoreVersion: vi.fn(),
    revealResult: vi.fn(),
    revealRemotionProject: vi.fn(),
    exportDocuments: vi.fn(),
    openHistory: vi.fn(),
    pickMaterials: vi.fn(() => Promise.resolve()),
    removeMaterial: vi.fn(),
    pickCommerceMaterials: vi.fn(() => Promise.resolve()),
    removeCommerceMaterial: vi.fn(),
    pickCoverImages: vi.fn(() => Promise.resolve()),
    removeCoverImage: vi.fn(),
    pickReverseVideo: vi.fn(() => Promise.resolve()),
    removeReverseVideo: vi.fn(),
    pickReelbenchVideo: vi.fn(() => Promise.resolve()),
    removeReelbenchVideo: vi.fn(),
    pickMusicVideoMaterial: vi.fn(() => Promise.resolve()),
    clearRun: vi.fn(),
    clearAllRuns: vi.fn(),
    pendingReviewHistoryEdit: vi.fn(() => undefined),
    trackReviewHistoryEdit: vi.fn(),
    resumeHistory: vi.fn(() => Promise.resolve()),
    restartHistory: vi.fn(() => Promise.resolve()),
    locateHistory: vi.fn(),
  };
}

/**
 * 区块（sections）测试的适配组件：会话动作已改经 context 下发，而这些用例仍以
 * 回调 props 形态编写并断言 callbacks 上的 mock。本组件把旧 props 形态映射进
 * 会话桩后挂载真实节点，既有用例只需替换元素名。
 */
export function LegacySessionNode({
  onExecute,
  onApprovePlan,
  onContinue,
  onCancel,
  onRedoShot,
  onRemove,
  onRevealResult,
  onOpenHistory,
  onUndoVersion,
  onRedoVersion,
  onRestoreVersion,
  onExportDocuments,
  onRevealRemotionProject,
  onPickMaterials,
  onRemoveMaterial,
  onPickCommerceMaterials,
  onRemoveCommerceMaterial,
  onPickCoverImages,
  onRemoveCoverImage,
  onPickReverseVideo,
  onPickReelbenchVideo,
  onPickMusicVideoMaterial,
  onRemoveReverseVideo,
  onRemoveReelbenchVideo,
  ...node
}: KnowledgeVideoWorkflowNodeProps & {
  readonly onExecute?: (key: string) => void;
  readonly onApprovePlan?: (key: string) => void;
  readonly onContinue?: (key: string, resolution?: string) => void;
  readonly onCancel?: (key: string) => void;
  readonly onRedoShot?: (key: string, shotId: string) => void;
  readonly onRemove?: (key: string) => void;
  readonly onRevealResult?: (key: string) => void;
  readonly onOpenHistory?: (key: string) => void;
  readonly onUndoVersion?: (key: string) => void;
  readonly onRedoVersion?: (key: string, versionId?: string) => void;
  readonly onRestoreVersion?: (key: string, versionId: string) => void;
  readonly onExportDocuments?: (key: string) => void;
  readonly onRevealRemotionProject?: (key: string) => void;
  readonly onPickMaterials?: (key: string) => Promise<void>;
  readonly onRemoveMaterial?: (key: string, localPath: string) => void;
  readonly onPickCommerceMaterials?: (key: string) => Promise<void>;
  readonly onRemoveCommerceMaterial?: (key: string, localPath: string) => void;
  readonly onPickCoverImages?: (key: string, role: "portrait" | "material") => Promise<void>;
  readonly onRemoveCoverImage?: (key: string, role: "portrait" | "material", path: string) => void;
  readonly onPickReverseVideo?: (key: string) => Promise<void> | void;
  readonly onPickReelbenchVideo?: (key: string) => Promise<void> | void;
  readonly onPickMusicVideoMaterial?: (key: string, role: "song" | "character") => Promise<void>;
  readonly onRemoveReverseVideo?: (key: string) => void;
  readonly onRemoveReelbenchVideo?: (key: string) => void;
}) {
  const sessions = createWorkflowSessionsStub();
  if (onExecute) sessions.execute = onExecute;
  if (onApprovePlan) sessions.approvePlan = onApprovePlan;
  if (onContinue) sessions.continueRun = onContinue;
  if (onCancel) sessions.cancel = onCancel;
  if (onRedoShot) sessions.redoShot = onRedoShot;
  if (onRemove) sessions.remove = onRemove;
  if (onRevealResult) sessions.revealResult = onRevealResult;
  if (onOpenHistory) sessions.openHistory = onOpenHistory;
  if (onUndoVersion) sessions.undoVersion = onUndoVersion;
  if (onRedoVersion) sessions.redoVersion = onRedoVersion;
  if (onRestoreVersion) sessions.restoreVersion = onRestoreVersion;
  if (onExportDocuments) sessions.exportDocuments = onExportDocuments;
  if (onRevealRemotionProject) sessions.revealRemotionProject = onRevealRemotionProject;
  if (onPickMaterials) sessions.pickMaterials = onPickMaterials;
  if (onRemoveMaterial) sessions.removeMaterial = onRemoveMaterial;
  if (onPickCommerceMaterials) sessions.pickCommerceMaterials = onPickCommerceMaterials;
  if (onRemoveCommerceMaterial) sessions.removeCommerceMaterial = onRemoveCommerceMaterial;
  if (onPickCoverImages) sessions.pickCoverImages = onPickCoverImages;
  if (onRemoveCoverImage) sessions.removeCoverImage = onRemoveCoverImage;
  if (onPickReverseVideo)
    sessions.pickReverseVideo = async (key) => void (await onPickReverseVideo(key));
  if (onPickReelbenchVideo)
    sessions.pickReelbenchVideo = async (key) => void (await onPickReelbenchVideo(key));
  if (onPickMusicVideoMaterial) sessions.pickMusicVideoMaterial = onPickMusicVideoMaterial;
  if (onRemoveReverseVideo) sessions.removeReverseVideo = onRemoveReverseVideo;
  if (onRemoveReelbenchVideo) sessions.removeReelbenchVideo = onRemoveReelbenchVideo;
  return (
    <WorkflowSessionsProvider value={sessions}>
      <KnowledgeVideoWorkflowNode {...node} />
    </WorkflowSessionsProvider>
  );
}
