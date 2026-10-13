/*
 * 工作流会话控制器。
 *
 * 为什么需要这一层
 * ----------------
 * 工作流节点「一次制作会话」的完整生命周期——启动/审批/续跑/重做镜头/取消/移除、
 * 版本切换、素材挑选、结果导出、历史恢复——此前全部内联在 WorkspaceApp 的
 * 万行函数体里，节点宿主被迫以 52 个 props 接收这些回调，测试只能 render(<App/>)
 * 从顶到底驱动 DOM。本模块把 runs 进度记录、会话注册表与上述动作收进一个
 * deep hook，经 context 下发给节点宿主：节点 props 从 38 个塌缩到 18 个，
 * 控制器逻辑第一次可以在不渲染任何组件的情况下单测。
 *
 * 语义锚点（与抽取前逐位等价）：
 * - 非活跃画布的进度写入走 useDeferredSessionState 缓冲，切画布不中断任务；
 * - run 的启动守卫、完成注销、历史 run 互斥全部走 WorkflowSessionRegistry；
 * - checkpoint 落卡走 runWithCoalescedHistory 时间窗折叠。
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { ErrorAlert } from "../../components/ErrorAlert";
import {
  isDesktopRuntime,
  pickPromptMultimodalFiles,
  videoComposerClient,
  type ProviderCatalogEntry,
} from "../../lib/backend";
import {
  formatWorkflowFailure,
  workflowErrorPresentation,
  workflowUsageError,
} from "../../lib/workflowErrors";
import { workflowHistoryClient, type WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { canvasNodesOfState, useCanvasCommands, useCanvasStore } from "../canvas/canvasStore";
import type { CanvasNodeRect } from "./workspaceModel";
import {
  KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
  createKnowledgeVideoWorkflowConfig,
  knowledgeVideoWorkflowNodeWidth,
  markdownDocumentExportName,
  nearestAvailableNodePosition,
  type KnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowRunState,
  type KnowledgeVideoWorkflowShotRun,
  type KnowledgeVideoWorkflowCheckpoint,
} from "./workspaceModel";
import {
  revealDesktopItem,
  saveMarkdownDocumentToDesktop,
  saveWorkflowBundleToDesktop,
} from "./desktopActions";
import {
  approveWorkflowExecutionPlan,
  createWorkflowDeliveryPlan,
  createWorkflowExecutionPlan,
  getWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
  isWorkflowExecutionPlanCurrent,
  workflowExecutionInputSignature,
} from "./workflowExecutionPlan";
import { createRecordedWorkflowRunner } from "./workflowHistoryExecution";
import { restoreWorkflowHistoryNode } from "./workflowHistoryRestore";
import { workflowMaterialPathKey } from "./workflowMaterials";
import { workflowKindDefinitionOf, workflowKindOf } from "./workflowKinds";
import {
  redoWorkflowVersion,
  restoreWorkflowVersion,
  undoWorkflowVersion,
} from "./workflowVersionHistory";
import { useDeferredSessionState } from "./useDeferredSessionState";
import {
  withCanvasWorkflowMaterials,
  withLiveWorkflowCanvasInputs,
  workflowCanvasInputsFromDocument,
} from "./workflowCanvasInputs";
import type { WorkflowSessionRegistry } from "./workflowSessionRegistry";

/** 宿主（WorkspaceApp）注入的画布级能力；其余依赖由控制器自行从 store 取。 */
export interface WorkflowSessionsHost {
  readonly canvasId: string;
  readonly active: boolean;
  readonly activeRef: RefObject<boolean>;
  /**
   * 会话注册表由宿主创建并注入：删除校验、清空画布、撤销/重做等宿主职责在
   * 本钩子之前就需要读写它；runs 进度记录等 React 状态仍归本钩子所有。
   */
  readonly registry: WorkflowSessionRegistry;
  /** 历史档案恢复；由画布会话服务提供（多画布共享去重）。 */
  readonly recoverWorkflowHistory: () => Promise<unknown>;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly scheduleCanvasSave: () => void;
  /** 打开历史面板并定位到工作流页签。 */
  readonly showHistoryPanel: (workflowId: string | null) => void;
  /** 关闭历史面板（恢复/定位完成后）。 */
  readonly closeHistoryPanel: () => void;
  /** 视口居中到画布坐标（恢复/定位后把镜头交给目标节点）。 */
  readonly centerView: (boardX: number, boardY: number) => void;
  readonly viewportCenterBoardCoordinates: () => { x: number; y: number };
  readonly occupiedNodeRects: readonly CanvasNodeRect[];
}

/**
 * 会话控制器的公开面。节点宿主经 context 消费动作组；WorkspaceApp 消费
 * runs/registry/历史动作。所有动作都以节点 key 开头，签名与抽取前的
 * props 回调一一对应。
 */
export interface WorkflowSessions {
  /** 每节点运行进度记录（节点宿主渲染消费）。 */
  readonly runs: Readonly<Record<string, KnowledgeVideoWorkflowRunState>>;
  readonly registry: WorkflowSessionRegistry;
  /** 活跃历史 run id 快照（历史横幅渲染消费）。 */
  readonly activeHistoryRunIds: readonly string[];

  run: (
    key: string,
    resume: boolean,
    decisionResolution?: string,
    restoredNode?: KnowledgeVideoWorkflowNodeData,
  ) => void;
  execute: (key: string) => void;
  approvePlan: (key: string) => void;
  continueRun: (key: string, resolution?: string) => void;
  redoShot: (key: string, shotId: string) => void;
  cancel: (key: string) => void;
  remove: (key: string) => void;
  undoVersion: (key: string) => void;
  redoVersion: (key: string, versionId?: string) => void;
  restoreVersion: (key: string, versionId: string) => void;
  revealResult: (key: string) => void;
  revealRemotionProject: (key: string) => void;
  exportDocuments: (key: string) => void;
  openHistory: (key: string) => void;
  pickMaterials: (key: string) => Promise<void>;
  removeMaterial: (key: string, localPath: string) => void;
  pickCommerceMaterials: (key: string) => Promise<void>;
  removeCommerceMaterial: (key: string, localPath: string) => void;
  pickCoverImages: (key: string, role: "portrait" | "material") => Promise<void>;
  removeCoverImage: (key: string, role: "portrait" | "material", path: string) => void;
  pickReverseVideo: (key: string) => Promise<void>;
  removeReverseVideo: (key: string) => void;
  pickReelbenchVideo: (key: string) => Promise<void>;
  removeReelbenchVideo: (key: string) => void;
  pickMusicVideoMaterial: (key: string, role: "song" | "character") => Promise<void>;

  /** 丢弃某节点的运行进度记录（配置编辑使旧进度失效、删除节点）。 */
  clearRun: (key: string) => void;
  /** 清空全部运行进度记录（画布清空）。 */
  clearAllRuns: () => void;
  /** 审核历史编辑链：读在途保存（updateConfig 串行化同 key 的历史写入）。 */
  pendingReviewHistoryEdit: (key: string) => Promise<void> | undefined;
  /** 登记一次在途的审核历史保存。 */
  trackReviewHistoryEdit: (key: string, save: Promise<void>) => void;
  resumeHistory: (record: WorkflowHistoryRecord, resolution?: string) => Promise<void>;
  restartHistory: (record: WorkflowHistoryRecord) => Promise<void>;
  locateHistory: (record: WorkflowHistoryRecord) => void;
}

export function useWorkflowSessions(host: WorkflowSessionsHost): WorkflowSessions {
  const {
    active,
    activeRef,
    canvasId,
    centerView,
    closeHistoryPanel,
    occupiedNodeRects,
    providerCatalog,
    recoverWorkflowHistory,
    registry: workflowSessions,
    scheduleCanvasSave,
    showHistoryPanel,
    viewportCenterBoardCoordinates,
  } = host;
  const {
    addNode,
    patchNode,
    removeNode: removeCanvasNode,
    runWithCoalescedHistory,
    selectNode,
    snapshotV2,
  } = useCanvasCommands();
  const canvasStore = useCanvasStore();
  const workflowNodesNow = useCallback(
    () => canvasNodesOfState(canvasStore.getState(), "knowledgeVideoWorkflow"),
    [canvasStore],
  );

  const [runs, setRunsInternal] = useState<
    Readonly<Record<string, KnowledgeVideoWorkflowRunState>>
  >({});
  const setRuns = useDeferredSessionState(setRunsInternal, activeRef, active);
  const recordedWorkflowRunner = useMemo(
    () => createRecordedWorkflowRunner({ canvasId }),
    [canvasId],
  );
  const [activeHistoryRunIds, setActiveHistoryRunIds] = useState<readonly string[]>([]);
  const reviewHistoryEditsRef = useRef(new Map<string, Promise<void>>());

  const clearRun = useCallback(
    (key: string) => {
      setRuns((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [setRuns],
  );

  const clearAllRuns = useCallback(() => {
    setRuns({});
  }, [setRuns]);

  const trackReviewHistoryEdit = useCallback((key: string, save: Promise<void>) => {
    reviewHistoryEditsRef.current.set(key, save);
  }, []);

  const pendingReviewHistoryEdit = useCallback(
    (key: string) => reviewHistoryEditsRef.current.get(key),
    [],
  );

  const navigateWorkflowVersion = useCallback(
    (
      key: string,
      operation: (config: KnowledgeVideoWorkflowConfig) => KnowledgeVideoWorkflowConfig,
    ) => {
      const source = snapshotV2({}).knowledgeVideoWorkflowNodes?.find((node) => node.key === key);
      if (!source) return;
      const run = runs[key];
      if (
        workflowSessions.isRunning(key) ||
        (source.config.historyRunId &&
          workflowSessions.isHistoryActionActive(source.config.historyRunId)) ||
        ["planning", "generating", "qc", "composing"].includes(
          run?.phase ?? source.config.checkpoint.phase,
        )
      ) {
        toast.info("请先暂停当前工作流或等待完成，再切换工作流版本。");
        return;
      }
      try {
        const config = operation(source.config);
        if (config === source.config) return;
        patchNode("knowledgeVideoWorkflow", key, (current) => ({ ...current, config }));
        clearRun(key);
        scheduleCanvasSave();
      } catch (error) {
        toast.error("工作流版本无法恢复", { description: <ErrorAlert error={error} workflow /> });
      }
    },
    [snapshotV2, runs, workflowSessions, patchNode, clearRun, scheduleCanvasSave],
  );
  const undoVersion = useCallback(
    (key: string) => navigateWorkflowVersion(key, undoWorkflowVersion),
    [navigateWorkflowVersion],
  );
  const redoVersion = useCallback(
    (key: string, id?: string) =>
      navigateWorkflowVersion(key, (config) => redoWorkflowVersion(config, id)),
    [navigateWorkflowVersion],
  );
  const restoreVersion = useCallback(
    (key: string, id: string) =>
      navigateWorkflowVersion(key, (config) => restoreWorkflowVersion(config, id)),
    [navigateWorkflowVersion],
  );

  const run = useCallback(
    (
      key: string,
      resume: boolean,
      decisionResolution?: string,
      restoredNode?: KnowledgeVideoWorkflowNodeData,
    ) => {
      if (workflowSessions.isRunning(key)) return;
      const document = snapshotV2({});
      const sourceNode =
        restoredNode ??
        document.knowledgeVideoWorkflowNodes?.find((candidate) => candidate.key === key);
      if (!sourceNode) return;
      const currentNode = withCanvasWorkflowMaterials(
        sourceNode,
        workflowCanvasInputsFromDocument(document, key),
      );
      if (!isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(currentNode), currentNode)) {
        try {
          const previousPlan = getWorkflowExecutionPlan(currentNode);
          const changedInput =
            previousPlan != null &&
            previousPlan.inputSignature !== workflowExecutionInputSignature(currentNode);
          const plan = isWorkflowExecutionPlanCurrent(previousPlan, currentNode)
            ? previousPlan!
            : previousPlan?.scope === "delivery" && resume && !changedInput
              ? createWorkflowDeliveryPlan(currentNode)
              : createWorkflowExecutionPlan(
                  currentNode,
                  resume && !changedInput ? "resume" : "restart",
                );
          patchNode("knowledgeVideoWorkflow", key, (current) => ({
            ...current,
            config: {
              ...current.config,
              executionPlan: plan,
              checkpoint: {
                ...(changedInput
                  ? createKnowledgeVideoWorkflowConfig(
                      {
                        prompt: current.config.models.text,
                        image: current.config.models.image,
                        video: current.config.models.video,
                      },
                      current.config.catalogResolved,
                    ).checkpoint
                  : current.config.checkpoint),
                executionPlan: plan,
                phase: "awaiting_approval",
                error: null,
              },
            },
          }));
          setRuns((current) => ({
            ...current,
            [key]: {
              phase: "awaiting_approval",
              progress: 0,
              message: "请检查执行计划并确认后开始。",
              error: null,
            },
          }));
        } catch (error) {
          const message = formatWorkflowFailure(error);
          setRuns((current) => ({
            ...current,
            [key]: {
              phase: "failed",
              progress: 0,
              message: workflowErrorPresentation(error).summary,
              error: message,
            },
          }));
        }
        return;
      }
      if (!isDesktopRuntime()) {
        setRuns((current) => ({
          ...current,
          [key]: {
            phase: "failed",
            progress: 0,
            message: "请在桌面应用中执行工作流。",
            error: formatWorkflowFailure(
              workflowUsageError("runtime", "自动工作流需要桌面端的项目供应商和本地合成能力。"),
            ),
          },
        }));
        return;
      }
      const historyRunId =
        resume && sourceNode.config.historyRunId
          ? sourceNode.config.historyRunId
          : crypto.randomUUID();
      if (!workflowSessions.beginHistoryRun(historyRunId)) return;
      const savedNode = { ...sourceNode, config: { ...sourceNode.config, historyRunId } };
      const node = withCanvasWorkflowMaterials(
        savedNode,
        workflowCanvasInputsFromDocument(document, key),
      );
      patchNode("knowledgeVideoWorkflow", key, () => savedNode);
      setActiveHistoryRunIds(workflowSessions.historyRunIds());
      const session = workflowSessions.begin(key);
      // 同步段无重入，这里不会撞上刚被占用的 key；防御性兜底保持守卫语义完整。
      if (!session) return;
      setRuns((current) => ({
        ...current,
        [key]: {
          phase: resume ? node.config.checkpoint.phase : "planning",
          progress: resume ? 20 : 2,
          message: resume ? "正在从已保存进度继续…" : "正在启动自动工作流…",
          error: null,
        },
      }));
      void recoverWorkflowHistory()
        .then(() => reviewHistoryEditsRef.current.get(key)?.catch(() => undefined))
        .then(() =>
          recordedWorkflowRunner.run({
            node,
            versionConfig: savedNode.config,
            providerCatalog,
            resume,
            newHistory: !sourceNode.config.historyRunId,
            ...(decisionResolution === undefined ? {} : { decisionResolution }),
            signal: session.signal,
            onCheckpoint: (checkpoint, versionHistory) => {
              // checkpoint 落卡是机器驱动的连续写入：走时间窗折叠，撤销栈不随跑批灌满。
              runWithCoalescedHistory(() =>
                patchNode("knowledgeVideoWorkflow", key, (currentNode) => ({
                  ...currentNode,
                  config: {
                    ...currentNode.config,
                    checkpoint,
                    ...(versionHistory ? { versionHistory } : {}),
                  },
                })),
              );
            },
            onProgress: (runState) => {
              setRuns((current) => ({ ...current, [key]: runState }));
            },
          }),
        )
        .then((checkpoint) => {
          if (checkpoint.phase === "done") {
            toast.success(
              node.config.productScene
                ? "产品场景图审核完成"
                : node.config.reelbench
                  ? "视频拉片与分镜合成完成"
                  : node.config.musicVideo
                    ? "音乐 MV 制作完成"
                    : node.config.xhsCover
                      ? "小红书封面制作完成"
                      : node.config.remotion
                        ? "动画逻辑图制作完成"
                        : node.config.commerce
                          ? "剧情带货制作完成"
                          : node.config.brandVideo
                            ? "品牌视觉短片制作完成"
                            : node.config.comicDrama
                              ? "漫剧制作完成"
                              : node.config.film
                                ? "影视制作完成"
                                : "知识视频制作完成",
              {
                description: node.config.productScene
                  ? "逐张审核记录已保存，可从节点导出已选用图片。"
                  : node.config.reelbench
                    ? "镜头表、质检结果与本地报告已保存在工作流节点中。"
                    : node.config.xhsCover
                      ? "封面方案、提示词与交付物已保存在工作流节点中。"
                      : node.config.remotion
                        ? "动画、预览图和可编辑工程已保存在工作流节点中。"
                        : checkpoint.documentsOnly
                          ? "制作文档与提示词已保存在工作流节点中。"
                          : "完整成片与过程文档已保存在工作流节点中。",
              },
            );
          } else if (checkpoint.phase === "awaiting_approval") {
            toast.info("工作流需要一项确认", {
              description: checkpoint.decision?.question ?? "请在节点内确认后继续。",
            });
          }
        })
        .catch((error: unknown) => {
          const message = formatWorkflowFailure(error);
          setRuns((current) => ({
            ...current,
            [key]: { phase: "failed", progress: 0, message: "工作流执行失败。", error: message },
          }));
        })
        .finally(() => {
          workflowSessions.endHistoryRun(historyRunId);
          setActiveHistoryRunIds(workflowSessions.historyRunIds());
          session.end();
        });
    },
    [
      workflowSessions,
      snapshotV2,
      recoverWorkflowHistory,
      providerCatalog,
      recordedWorkflowRunner,
      patchNode,
      runWithCoalescedHistory,
      setRuns,
    ],
  );

  const restoreStoredWorkflow = useCallback(
    async (
      record: WorkflowHistoryRecord,
      action: "resume" | "restart" | "locate",
      resolution?: string,
    ) => {
      if (!workflowSessions.beginHistoryAction(record.id)) return;
      try {
        await recoverWorkflowHistory();
        const latest = (await workflowHistoryClient.get(record.id)).record;
        if (latest.canvasId !== canvasId)
          throw workflowUsageError("task_identity", "请先打开这条工作流所属的画布。");
        if (workflowSessions.isHistoryRunActive(latest.id) && action !== "locate")
          throw workflowUsageError(
            "task_pending",
            "这条工作流正在运行，请先在画布中暂停后再处理。",
          );
        const document = snapshotV2({});
        const nodes = document.knowledgeVideoWorkflowNodes ?? [];
        const activeNode = nodes.find(
          (item) => item.config.historyRunId === latest.id && workflowSessions.isRunning(item.key),
        );
        if (activeNode && action === "locate") {
          selectNode(activeNode.key);
          centerView(
            activeNode.x +
              (activeNode.measured?.width ?? knowledgeVideoWorkflowNodeWidth(window.innerWidth)) /
                2,
            activeNode.y + 100,
          );
          closeHistoryPanel();
          return;
        }
        const anchor = viewportCenterBoardCoordinates();
        const occupiedKeys = new Set(
          [
            ...document.assetNodes,
            ...document.genNodes,
            ...document.resultNodes,
            ...(document.outputNodes ?? []),
            ...(document.screenplayNodes ?? []),
            ...(document.storyboardNodes ?? []),
            ...(document.viralRemixNodes ?? []),
            ...(document.videoComposerNodes ?? []),
            ...(document.videoDownloaderNodes ?? []),
            ...(document.frameExtractorNodes ?? []),
            ...nodes,
          ].map((item) => item.key),
        );
        let restored = restoreWorkflowHistoryNode(
          latest,
          nodes.map((node) =>
            withCanvasWorkflowMaterials(node, workflowCanvasInputsFromDocument(document, node.key)),
          ),
          {
            restart: action === "restart",
            occupiedKeys,
            newKey: `workflow-restored-${crypto.randomUUID()}`,
            position: nearestAvailableNodePosition(
              {
                x: anchor.x - knowledgeVideoWorkflowNodeWidth(window.innerWidth) / 2,
                y: anchor.y - 180,
                width: knowledgeVideoWorkflowNodeWidth(window.innerWidth),
                height: KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
              },
              occupiedNodeRects,
            ),
          },
        );
        if (restored.replace) {
          // The history owns a full input snapshot; the live canvas continues to own its edges.
          const original = nodes.find((node) => node.key === restored.node.key);
          restored = {
            ...restored,
            node: withLiveWorkflowCanvasInputs(restored.node, original),
          };
          patchNode("knowledgeVideoWorkflow", restored.node.key, () => restored.node);
        } else addNode("knowledgeVideoWorkflow", restored.node, { select: true });
        selectNode(restored.node.key);
        centerView(
          restored.node.x +
            (restored.node.measured?.width ?? knowledgeVideoWorkflowNodeWidth(window.innerWidth)) /
              2,
          restored.node.y + 180,
        );
        if (action !== "locate") {
          run(restored.node.key, action === "resume", resolution, restored.node);
        }
        closeHistoryPanel();
        if (!restored.replace)
          toast.success(
            action === "restart" ? "已按历史输入重新制作" : "工作流已从历史记录恢复到画布",
          );
      } finally {
        workflowSessions.endHistoryAction(record.id);
      }
    },
    [
      workflowSessions,
      recoverWorkflowHistory,
      canvasId,
      centerView,
      closeHistoryPanel,
      viewportCenterBoardCoordinates,
      occupiedNodeRects,
      snapshotV2,
      selectNode,
      patchNode,
      addNode,
      run,
    ],
  );
  const resumeHistory = useCallback(
    (record: WorkflowHistoryRecord, resolution?: string) =>
      restoreStoredWorkflow(record, "resume", resolution),
    [restoreStoredWorkflow],
  );
  const restartHistory = useCallback(
    (record: WorkflowHistoryRecord) => restoreStoredWorkflow(record, "restart"),
    [restoreStoredWorkflow],
  );
  const locateHistory = useCallback(
    (record: WorkflowHistoryRecord) => {
      void restoreStoredWorkflow(record, "locate").catch((error: unknown) =>
        toast.error("恢复工作流失败", { description: <ErrorAlert error={error} workflow /> }),
      );
    },
    [restoreStoredWorkflow],
  );

  const openHistory = useCallback(
    (key: string) => {
      const node = workflowNodesNow().find((item) => item.key === key);
      showHistoryPanel(node?.config.historyRunId ?? null);
    },
    [workflowNodesNow, showHistoryPanel],
  );

  const pickMusicVideoMaterial = useCallback(
    async (key: string, role: "song" | "character") => {
      try {
        const picked = await pickPromptMultimodalFiles({
          title: role === "song" ? "选择 MV 原曲" : "添加 MV 人物参考图",
          kinds: role === "song" ? ["audio"] : ["image"],
        });
        if (!picked.length) return;
        if (role === "song" && picked.length !== 1) {
          toast.error("选择 MV 原曲失败", {
            description: (
              <ErrorAlert
                error={workflowUsageError("materials", "一次请选择一首完整歌曲")}
                workflow
              />
            ),
          });
          return;
        }
        patchNode("knowledgeVideoWorkflow", key, (node) => {
          const options = node.config.musicVideo;
          if (
            !options ||
            workflowSessions.isRunning(key) ||
            node.config.checkpoint.phase === "awaiting_approval"
          )
            return node;
          const refs = [...options.characterReferences];
          const paths = new Set(refs.map(workflowMaterialPathKey));
          for (const item of role === "character" ? picked : []) {
            if (
              item.kind === "image" &&
              item.byteSize > 0 &&
              !paths.has(workflowMaterialPathKey(item))
            ) {
              paths.add(workflowMaterialPathKey(item));
              refs.push(item);
            }
          }
          return {
            ...node,
            config: {
              ...node.config,
              musicVideo:
                role === "song"
                  ? { ...options, songPath: picked[0]!.localPath, songName: picked[0]!.displayName }
                  : { ...options, characterReferences: refs },
            },
          };
        });
      } catch (error) {
        toast.error("选择 MV 素材失败", {
          description: (
            <ErrorAlert
              error={workflowUsageError("materials", "未能选择 MV 原曲或人物参考图。", error)}
              workflow
            />
          ),
        });
      }
    },
    [patchNode, workflowSessions],
  );

  const pickReverseVideo = useCallback(
    async (key: string) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selection = await open({
          multiple: false,
          directory: false,
          title: "选择要反推的本地视频",
          filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v"] }],
        });
        if (typeof selection !== "string" || !selection) return;
        patchNode("knowledgeVideoWorkflow", key, (node) => {
          if (
            !node.config.reverseVideo ||
            workflowSessions.isRunning(key) ||
            node.config.checkpoint.phase === "awaiting_approval"
          )
            return node;
          return {
            ...node,
            config: {
              ...node.config,
              reverseVideo: {
                ...node.config.reverseVideo,
                sourceUrl: "",
                localVideoPath: selection,
                localVideoName: selection.split(/[\\/]/).at(-1) ?? "本地视频",
              },
            },
          };
        });
      } catch (error) {
        toast.error("选择视频失败", {
          description: (
            <ErrorAlert
              error={workflowUsageError("materials", "未能选择要反推的本地视频。", error)}
              workflow
            />
          ),
        });
      }
    },
    [patchNode, workflowSessions],
  );

  const removeReverseVideo = useCallback(
    (key: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (
          !node.config.reverseVideo ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            reverseVideo: {
              ...node.config.reverseVideo,
              localVideoPath: "",
              localVideoName: "",
            },
          },
        };
      });
    },
    [patchNode, workflowSessions],
  );

  const pickReelbenchVideo = useCallback(
    async (key: string) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selection = await open({
          multiple: false,
          directory: false,
          title: "选择要拉片的本地视频",
          filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v"] }],
        });
        if (typeof selection !== "string" || !selection) return;
        patchNode("knowledgeVideoWorkflow", key, (node) => {
          if (
            !node.config.reelbench ||
            workflowSessions.isRunning(key) ||
            node.config.checkpoint.phase === "awaiting_approval"
          )
            return node;
          return {
            ...node,
            config: {
              ...node.config,
              reelbench: {
                ...node.config.reelbench,
                sourceUrl: "",
                localVideoPath: selection,
                localVideoName: selection.split(/[\\/]/).at(-1) ?? "本地视频",
              },
            },
          };
        });
      } catch (error) {
        toast.error("选择视频失败", {
          description: (
            <ErrorAlert
              error={workflowUsageError("materials", "未能选择要拉片的本地视频。", error)}
              workflow
            />
          ),
        });
      }
    },
    [patchNode, workflowSessions],
  );

  const removeReelbenchVideo = useCallback(
    (key: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (
          !node.config.reelbench ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            reelbench: {
              ...node.config.reelbench,
              localVideoPath: "",
              localVideoName: "",
            },
          },
        };
      });
    },
    [patchNode, workflowSessions],
  );

  const pickMaterials = useCallback(
    async (key: string) => {
      const picked = await pickPromptMultimodalFiles({ title: "为工作流添加参考素材" });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (workflowSessions.isRunning(key) || node.config.checkpoint.phase === "awaiting_approval")
          return node;
        const materials = [...(node.config.materials ?? [])];
        const generalPaths = new Set(materials.map(workflowMaterialPathKey));
        for (const item of picked) {
          const path = workflowMaterialPathKey(item);
          if (generalPaths.has(path) || !Number.isFinite(item.byteSize) || item.byteSize <= 0) {
            rejected++;
            continue;
          }
          generalPaths.add(path);
          materials.push(item);
        }
        return { ...node, config: { ...node.config, materials } };
      });
      if (rejected)
        toast.info(`${rejected} 项参考素材未添加`, {
          description: "重复文件会跳过，不支持空文件。",
        });
    },
    [patchNode, workflowSessions],
  );

  const removeMaterial = useCallback(
    (key: string, localPath: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        if (workflowSessions.isRunning(key) || node.config.checkpoint.phase === "awaiting_approval")
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            materials: (node.config.materials ?? []).filter((item) => item.localPath !== localPath),
          },
        };
      });
    },
    [patchNode, workflowSessions],
  );

  const pickCoverImages = useCallback(
    async (key: string, role: "portrait" | "material") => {
      const picked = await pickPromptMultimodalFiles({
        title: role === "portrait" ? "添加同一人物的封面参考图" : "添加封面截图、产品图或标志",
        kinds: ["image"],
      });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.xhsCover;
        if (
          !options ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const field = role === "portrait" ? "portraits" : "materials";
        const items = [...options[field]];
        const existing = [...options.portraits, ...options.materials];
        const paths = new Set(existing.map(workflowMaterialPathKey));
        for (const item of picked) {
          if (
            item.kind !== "image" ||
            paths.has(workflowMaterialPathKey(item)) ||
            items.length >= (role === "portrait" ? 3 : 5) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0
          ) {
            rejected++;
            continue;
          }
          paths.add(workflowMaterialPathKey(item));
          items.push(item);
        }
        return { ...node, config: { ...node.config, xhsCover: { ...options, [field]: items } } };
      });
      if (rejected)
        toast.info(`${rejected} 张图片未添加`, {
          description: "人物参考图最多 3 张、补充图片最多 5 张，仅支持非空图片，重复图片会跳过。",
        });
    },
    [patchNode, workflowSessions],
  );

  const removeCoverImage = useCallback(
    (key: string, role: "portrait" | "material", path: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.xhsCover;
        if (
          !options ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const field = role === "portrait" ? "portraits" : "materials";
        return {
          ...node,
          config: {
            ...node.config,
            xhsCover: {
              ...options,
              [field]: options[field].filter((item) => item.localPath !== path),
            },
          },
        };
      });
    },
    [patchNode, workflowSessions],
  );

  const pickCommerceMaterials = useCallback(
    async (key: string) => {
      const picked = await pickPromptMultimodalFiles({
        title: "为带货工作流添加商品原图和资料",
        kinds: ["image", "document"],
      });
      if (!picked.length) return;
      let rejected = 0;
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.commerce;
        if (
          !options ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        const materials = [...options.materials];
        const paths = new Set(materials.map(workflowMaterialPathKey));
        for (const item of picked) {
          if (
            (item.kind !== "image" && item.kind !== "document") ||
            paths.has(workflowMaterialPathKey(item)) ||
            !Number.isFinite(item.byteSize) ||
            item.byteSize <= 0
          ) {
            rejected++;
            continue;
          }
          paths.add(workflowMaterialPathKey(item));
          materials.push(item);
        }
        return { ...node, config: { ...node.config, commerce: { ...options, materials } } };
      });
      if (rejected)
        toast.info(`${rejected} 项产品资料未添加`, {
          description: "支持非空图片与文档，重复文件会跳过。",
        });
    },
    [patchNode, workflowSessions],
  );

  const removeCommerceMaterial = useCallback(
    (key: string, localPath: string) => {
      patchNode("knowledgeVideoWorkflow", key, (node) => {
        const options = node.config.commerce;
        if (
          !options ||
          workflowSessions.isRunning(key) ||
          node.config.checkpoint.phase === "awaiting_approval"
        )
          return node;
        return {
          ...node,
          config: {
            ...node.config,
            commerce: {
              ...options,
              materials: options.materials.filter((item) => item.localPath !== localPath),
            },
          },
        };
      });
    },
    [patchNode, workflowSessions],
  );

  const execute = useCallback(
    (key: string) => {
      if (workflowSessions.isRunning(key)) return;
      const document = snapshotV2({});
      const source = document.knowledgeVideoWorkflowNodes?.find((item) => item.key === key);
      if (!source) return;
      const node = withCanvasWorkflowMaterials(
        source,
        workflowCanvasInputsFromDocument(document, key),
      );
      const plan = createWorkflowExecutionPlan(node, "restart");
      patchNode("knowledgeVideoWorkflow", key, (current) => ({
        ...current,
        config: {
          ...current.config,
          executionPlan: plan,
          checkpoint: {
            ...createKnowledgeVideoWorkflowConfig(
              {
                prompt: current.config.models.text,
                image: current.config.models.image,
                video: current.config.models.video,
              },
              current.config.catalogResolved,
            ).checkpoint,
            executionPlan: plan,
            phase: "awaiting_approval",
          },
        },
      }));
      setRuns((current) => ({
        ...current,
        [key]: {
          phase: "awaiting_approval",
          progress: 0,
          message: "请检查执行计划并确认后开始。",
          error: null,
        },
      }));
    },
    [workflowSessions, snapshotV2, patchNode, setRuns],
  );

  const approvePlan = useCallback(
    (key: string) => {
      if (workflowSessions.isRunning(key)) return;
      const document = snapshotV2({});
      const source = document.knowledgeVideoWorkflowNodes?.find((item) => item.key === key);
      if (!source) return;
      const node = withCanvasWorkflowMaterials(
        source,
        workflowCanvasInputsFromDocument(document, key),
      );
      const plan = getWorkflowExecutionPlan(node);
      if (!plan) return;
      try {
        if (!isWorkflowExecutionPlanCurrent(plan, node)) {
          const changedInput = plan.inputSignature !== workflowExecutionInputSignature(node);
          const refreshed =
            plan.scope === "delivery" && !changedInput
              ? createWorkflowDeliveryPlan(node)
              : createWorkflowExecutionPlan(node, changedInput ? "restart" : plan.executionIntent);
          patchNode("knowledgeVideoWorkflow", key, (current) => ({
            ...current,
            config: {
              ...current.config,
              executionPlan: refreshed,
              checkpoint: {
                ...(changedInput
                  ? createKnowledgeVideoWorkflowConfig(
                      {
                        prompt: current.config.models.text,
                        image: current.config.models.image,
                        video: current.config.models.video,
                      },
                      current.config.catalogResolved,
                    ).checkpoint
                  : current.config.checkpoint),
                executionPlan: refreshed,
                phase: "awaiting_approval",
              },
            },
          }));
          toast.info("输入已改变，执行计划已更新，请重新检查后确认。");
          return;
        }
        const approved = approveWorkflowExecutionPlan(plan, node);
        const approvedNode = {
          ...source,
          config: {
            ...source.config,
            executionPlan: approved,
            checkpoint: {
              ...(plan.executionIntent === "restart"
                ? createKnowledgeVideoWorkflowConfig(
                    {
                      prompt: source.config.models.text,
                      image: source.config.models.image,
                      video: source.config.models.video,
                    },
                    source.config.catalogResolved,
                  ).checkpoint
                : source.config.checkpoint),
              executionPlan: approved,
            },
          },
        };
        patchNode("knowledgeVideoWorkflow", key, () => approvedNode);
        run(key, plan.executionIntent === "resume", undefined, approvedNode);
      } catch (error) {
        toast.error("执行计划无法确认", { description: <ErrorAlert error={error} workflow /> });
      }
    },
    [workflowSessions, snapshotV2, patchNode, run],
  );

  const continueRun = useCallback(
    (key: string, resolution?: string) => run(key, true, resolution),
    [run],
  );

  const redoShot = useCallback(
    (key: string, shotId: string) => {
      if (workflowSessions.isRunning(key)) return;
      const node = workflowNodesNow().find((candidate) => candidate.key === key);
      const checkpoint: KnowledgeVideoWorkflowCheckpoint | undefined = node?.config.checkpoint;
      const shotRun: KnowledgeVideoWorkflowShotRun | undefined = checkpoint?.shotRuns[shotId];
      const shot = checkpoint?.shots.find((item) => item.id === shotId);
      if (!node || !checkpoint || !shotRun || !shot) return;
      const supersededTaskId = shotRun.videoTaskId ?? null;
      const nextRun: KnowledgeVideoWorkflowShotRun = {
        ...shotRun,
        redoRequested: true,
        videoTaskId: null,
        clipPath: null,
        qcStatus: "pending",
        retryCount: 0,
        repairPrompt: null,
        qcReport: "用户要求重做此镜头，已重新提交生成。",
        ...(supersededTaskId
          ? { supersededTaskIds: [...(shotRun.supersededTaskIds ?? []), supersededTaskId] }
          : {}),
      };
      const nextCheckpoint: KnowledgeVideoWorkflowCheckpoint = {
        ...checkpoint,
        phase: "paused",
        lastActivePhase: checkpoint.lastActivePhase ?? "generating",
        activeCompositionJobId: null,
        finalPath: null,
        error: null,
        decision: null,
        shotRuns: { ...checkpoint.shotRuns, [shotId]: nextRun },
        updatedAt: Date.now(),
      };
      patchNode("knowledgeVideoWorkflow", key, (currentNode) => ({
        ...currentNode,
        config: { ...currentNode.config, checkpoint: nextCheckpoint },
      }));
      toast.info("正在重做该镜头", {
        description: `镜头 ${shot.sequence} 只重跑这一个分镜，其他镜头保持不变。`,
      });
      run(key, true);
    },
    [workflowSessions, workflowNodesNow, patchNode, run],
  );

  const cancel = useCallback(
    (key: string) => {
      workflowSessions.abort(key);
      const node = workflowNodesNow().find((candidate) => candidate.key === key);
      const jobId = node?.config.checkpoint.activeCompositionJobId;
      if (jobId) void videoComposerClient.cancelJob(jobId).catch(() => undefined);
    },
    [workflowSessions, workflowNodesNow],
  );

  const remove = useCallback(
    (key: string) => {
      workflowSessions.abort(key);
      workflowSessions.remove(key);
      removeCanvasNode(key);
      clearRun(key);
    },
    [workflowSessions, removeCanvasNode, clearRun],
  );

  const revealResult = useCallback(
    (key: string) => {
      const checkpoint = workflowNodesNow().find((node) => node.key === key)?.config.checkpoint;
      const path =
        checkpoint?.xhsCover?.finalPath ??
        checkpoint?.xhsCover?.imagePath ??
        checkpoint?.finalPath ??
        checkpoint?.remotion?.renderJob?.gifPath ??
        checkpoint?.remotion?.renderJob?.videoPath ??
        checkpoint?.remotion?.renderJob?.previewPath;
      if (path) void revealDesktopItem(path).catch(() => undefined);
    },
    [workflowNodesNow],
  );

  const revealRemotionProject = useCallback(
    (key: string) => {
      const path = workflowNodesNow().find((node) => node.key === key)?.config.checkpoint.remotion
        ?.renderJob?.projectPath;
      if (path)
        void revealDesktopItem(path).catch((error: unknown) =>
          toast.error("打开动画工程失败", {
            description: (
              <ErrorAlert
                error={workflowUsageError("storage", "未能打开已保存的动画工程。", error)}
                workflow
              />
            ),
          }),
        );
    },
    [workflowNodesNow],
  );

  const exportDocuments = useCallback(
    (key: string) => {
      const node = workflowNodesNow().find((item) => item.key === key);
      if (!node) return;
      // 导出正文、文档标题与四件套打包全部由注册表按工作流类型分发；
      // 无文档交付的类型（或正文为空）在此静默返回，与原闸门同语义。
      const delivery = workflowKindDefinitionOf(workflowKindOf(node.config));
      const content = delivery.deliveryMarkdown?.(node.config.checkpoint) ?? "";
      if (!content || delivery.deliveryTitle == null) return;
      const title = delivery.deliveryTitle;
      const fileName = markdownDocumentExportName(content, key, title);
      void (async () => {
        try {
          if (delivery.deliveryBundle) {
            const files = delivery.deliveryBundle(node.config.checkpoint);
            const bundleTitle = delivery.deliveryBundleTitle ?? title;
            if (isDesktopRuntime()) {
              const folder = await saveWorkflowBundleToDesktop(files, bundleTitle);
              if (!folder) return;
              toast.success(`${bundleTitle}四件套已导出`, { description: folder });
            } else {
              for (const file of files) {
                const url = URL.createObjectURL(
                  new Blob([file.content], { type: `${file.mediaType};charset=utf-8` }),
                );
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = file.fileName;
                anchor.click();
                URL.revokeObjectURL(url);
              }
              toast.success(`${bundleTitle}四件套已导出`);
            }
            return;
          }
          if (isDesktopRuntime()) {
            if (!(await saveMarkdownDocumentToDesktop(content, fileName, title))) return;
          } else {
            const url = URL.createObjectURL(
              new Blob([content], { type: "text/markdown;charset=utf-8" }),
            );
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
            URL.revokeObjectURL(url);
          }
          toast.success(`${title}已导出`);
        } catch (error) {
          toast.error(`${title}导出失败`, {
            description: (
              <ErrorAlert
                error={workflowUsageError("storage", `${title}未能保存到所选位置。`, error)}
                workflow
              />
            ),
          });
        }
      })();
    },
    [workflowNodesNow],
  );

  return useMemo<WorkflowSessions>(
    () => ({
      runs,
      registry: workflowSessions,
      activeHistoryRunIds,
      run,
      execute,
      approvePlan,
      continueRun,
      redoShot,
      cancel,
      remove,
      undoVersion,
      redoVersion,
      restoreVersion,
      revealResult,
      revealRemotionProject,
      exportDocuments,
      openHistory,
      pickMaterials,
      removeMaterial,
      pickCommerceMaterials,
      removeCommerceMaterial,
      pickCoverImages,
      removeCoverImage,
      pickReverseVideo,
      removeReverseVideo,
      pickReelbenchVideo,
      removeReelbenchVideo,
      pickMusicVideoMaterial,
      clearRun,
      clearAllRuns,
      pendingReviewHistoryEdit,
      trackReviewHistoryEdit,
      resumeHistory,
      restartHistory,
      locateHistory,
    }),
    [
      runs,
      workflowSessions,
      activeHistoryRunIds,
      run,
      execute,
      approvePlan,
      continueRun,
      redoShot,
      cancel,
      remove,
      undoVersion,
      redoVersion,
      restoreVersion,
      revealResult,
      revealRemotionProject,
      exportDocuments,
      openHistory,
      pickMaterials,
      removeMaterial,
      pickCommerceMaterials,
      removeCommerceMaterial,
      pickCoverImages,
      removeCoverImage,
      pickReverseVideo,
      removeReverseVideo,
      pickReelbenchVideo,
      removeReelbenchVideo,
      pickMusicVideoMaterial,
      clearRun,
      clearAllRuns,
      pendingReviewHistoryEdit,
      trackReviewHistoryEdit,
      resumeHistory,
      restartHistory,
      locateHistory,
    ],
  );
}

const WorkflowSessionsContext = createContext<WorkflowSessions | null>(null);

export function WorkflowSessionsProvider({
  value,
  children,
}: {
  readonly value: WorkflowSessions;
  readonly children: ReactNode;
}) {
  return createElement(WorkflowSessionsContext.Provider, { value }, children);
}

/** 节点宿主内的组件读取会话动作；缺 Provider 属于接线错误，立即抛出。 */
export function useWorkflowSessionActions(): WorkflowSessions {
  const sessions = useContext(WorkflowSessionsContext);
  if (!sessions)
    throw new Error("KnowledgeVideoWorkflowNode 必须位于 WorkflowSessionsProvider 内。");
  return sessions;
}
