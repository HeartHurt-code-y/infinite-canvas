import { stableJsonSignature } from "../../lib/workflowSignatures";
import { workflowMaterialsSignature } from "./workflowMaterials";
import { comicDramaStageDependencies, COMIC_DRAMA_STAGE_LABELS } from "./comicDramaWorkflowModel";
import {
  productSceneGenerationMode,
  productSceneQualityEnabled,
} from "./productSceneWorkflowModel";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

export interface WorkflowExecutionStep {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly action?: "assets" | "cover" | "video" | "qc" | "compose";
  readonly shotId?: string;
}

export type WorkflowMediaReviewKind = "assets" | "first_shot" | "composition" | "final";
export interface WorkflowMediaApproval {
  readonly signature: string;
  readonly approvedAt: number;
}

export interface WorkflowExecutionPlan {
  readonly version: 1;
  readonly id: string;
  readonly revision: number;
  readonly scope: "workflow" | "delivery";
  readonly executionIntent: "restart" | "resume";
  readonly inputSignature: string;
  readonly contentSignature?: string;
  readonly steps: readonly WorkflowExecutionStep[];
  readonly review?: {
    readonly kind: WorkflowMediaReviewKind;
    readonly paths: readonly string[];
    readonly signature: string;
  };
  readonly approval: {
    readonly planSignature: string;
    readonly approvedAt: number;
  } | null;
}

/** Stable Kahn traversal. Validate the entire graph before permitting any side effect. */
export function topologicallySortWorkflowSteps<
  T extends { readonly id: string; readonly dependsOn: readonly string[] },
>(steps: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const step of steps) {
    if (!step.id || byId.has(step.id)) throw new Error(`执行计划步骤身份重复或为空：${step.id}`);
    byId.set(step.id, step);
  }
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of steps) {
    const dependencies = new Set(step.dependsOn);
    if (dependencies.size !== step.dependsOn.length)
      throw new Error(`执行计划步骤 ${step.id} 包含重复依赖。`);
    indegree.set(step.id, dependencies.size);
    for (const dependency of dependencies) {
      if (!byId.has(dependency))
        throw new Error(`执行计划步骤 ${step.id} 引用了不存在的依赖 ${dependency}。`);
      const dependents = children.get(dependency) ?? [];
      dependents.push(step.id);
      children.set(dependency, dependents);
    }
  }
  const ready = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  const ordered: T[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor]!;
    ordered.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ordered.length !== steps.length) {
    const blocked = steps.filter((step) => indegree.get(step.id)! > 0).map((step) => step.id);
    throw new Error(`执行计划存在循环依赖，无法执行：${blocked.join("、")}`);
  }
  return ordered;
}

/** Execute dependency-ready waves; failures/pause prevent downstream work, active calls settle first. */
export async function executeWorkflowSteps<T extends WorkflowExecutionStep>(
  steps: readonly T[],
  execute: (step: T) => Promise<void | false>,
  options: { readonly signal?: AbortSignal; readonly concurrency?: number } = {},
): Promise<boolean> {
  const ordered = topologicallySortWorkflowSteps(steps);
  const completed = new Set<string>();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  while (completed.size < ordered.length) {
    if (options.signal?.aborted) throw new DOMException("已暂停", "AbortError");
    const ready = ordered.filter(
      (step) => !completed.has(step.id) && step.dependsOn.every((id) => completed.has(id)),
    );
    let cursor = 0;
    let stopped = false;
    let failed = false;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ready.length) }, async () => {
        while (!stopped && !failed && cursor < ready.length) {
          const step = ready[cursor++]!;
          try {
            if (options.signal?.aborted) throw new DOMException("已暂停", "AbortError");
            if ((await execute(step)) === false) stopped = true;
            else completed.add(step.id);
          } catch (error) {
            failed = true;
            failure = error;
          }
        }
      }),
    );
    if (failed) throw failure;
    if (stopped) return false;
  }
  return true;
}

/** Presentation URLs and runtime progress cannot change an approval's durable input identity. */
export function workflowExecutionInputSignature(node: KnowledgeVideoWorkflowNodeData): string {
  return stableJsonSignature({
    ...Object.fromEntries(
      Object.entries(node.config).filter(
        ([key]) =>
          ![
            "checkpoint",
            "executionPlan",
            "versionHistory",
            "historyRunId",
            "catalogResolved",
            "materials",
            "connectedMaterials",
            "connectedTexts",
          ].includes(key),
      ),
    ),
    materialsSignature: workflowMaterialsSignature(node.config),
  });
}

function deliveryContentSignature(checkpoint: KnowledgeVideoWorkflowCheckpoint): string {
  return stableJsonSignature({
    planRevision: checkpoint.planRevision,
    manifest: checkpoint.manifest,
    script: checkpoint.script,
    storyboard: checkpoint.storyboard,
    shots: checkpoint.shots,
    ...(checkpoint.musicVideo
      ? {
          musicVideo: {
            song: checkpoint.musicVideo.song,
            stages: Object.fromEntries(
              Object.entries(checkpoint.musicVideo.stages).map(([stage, run]) => [
                stage,
                run?.artifact,
              ]),
            ),
          },
        }
      : {}),
    assets: checkpoint.film?.assets.map(({ id, kind, name, prompt }) => ({
      id,
      kind,
      name,
      prompt,
    })),
  });
}

function planSignature(plan: WorkflowExecutionPlan): string {
  return stableJsonSignature({ ...plan, approval: undefined });
}

export function getWorkflowExecutionPlan(
  node: KnowledgeVideoWorkflowNodeData,
): WorkflowExecutionPlan | undefined {
  return node.config.checkpoint.executionPlan ?? node.config.executionPlan;
}

export function isWorkflowExecutionPlanApproved(
  plan: WorkflowExecutionPlan | undefined,
  node: KnowledgeVideoWorkflowNodeData,
): boolean {
  return (
    !!plan?.approval &&
    isWorkflowExecutionPlanCurrent(plan, node) &&
    plan.approval.planSignature === planSignature(plan)
  );
}

export function isWorkflowExecutionPlanCurrent(
  plan: WorkflowExecutionPlan | undefined,
  node: KnowledgeVideoWorkflowNodeData,
): boolean {
  try {
    if (!plan || plan.inputSignature !== workflowExecutionInputSignature(node)) return false;
    if (
      plan.scope === "delivery" &&
      plan.contentSignature !== deliveryContentSignature(node.config.checkpoint)
    )
      return false;
    if (
      plan.scope === "delivery" &&
      stableJsonSignature(plan.steps) !==
        stableJsonSignature(createVideoWorkflowExecutionSteps(node.config.checkpoint))
    )
      return false;
    if (
      plan.review &&
      plan.review.signature !==
        workflowMediaReviewSignature(node.config.checkpoint, plan.review.kind)
    )
      return false;
    topologicallySortWorkflowSteps(plan.steps);
    return true;
  } catch {
    return false;
  }
}

export function approveWorkflowExecutionPlan(
  plan: WorkflowExecutionPlan,
  node: KnowledgeVideoWorkflowNodeData,
  now = Date.now(),
): WorkflowExecutionPlan {
  topologicallySortWorkflowSteps(plan.steps);
  if (!isWorkflowExecutionPlanCurrent(plan, node))
    throw new Error("制作输入或分镜版本已改变，请重新生成执行计划后确认。");
  return { ...plan, approval: { planSignature: planSignature(plan), approvedAt: now } };
}

function serialSteps(titles: readonly string[]): WorkflowExecutionStep[] {
  return titles.map((title, index) => ({
    id: `stage-${index + 1}`,
    title,
    dependsOn: index ? [`stage-${index}`] : [],
  }));
}

export function createWorkflowExecutionPlan(
  node: KnowledgeVideoWorkflowNodeData,
  executionIntent: "restart" | "resume" = "restart",
): WorkflowExecutionPlan {
  const config = node.config;
  const titles = config.productScene
    ? productSceneGenerationMode(config.productScene) === "reference"
      ? [
          `使用已确认产品参考图，规划 ${config.productScene.totalCount} 张不同目标机位与场景`,
          `逐批确认后调用参考图生成，每批最多 ${config.productScene.batchSize} 张，同时运行最多 ${Math.min(config.productScene.batchSize, config.productScene.maxConcurrency ?? 10)} 个生成任务`,
          "按目标机位生成完整画面，统一尺寸并辅助检查画面相似度",
          ...(productSceneQualityEnabled(config.productScene)
            ? [
                "逐张调用视觉文本模型，检查可见接口与 Logo 所在平面",
                ...(config.productScene.quality?.logo
                  ? ["定位可靠且表面清晰时按透视贴回已确认 Logo"]
                  : []),
              ]
            : []),
          "逐张审核产品形体、接口、Logo 与机位，导出已选用图片及清单",
        ]
      : [
          `使用已确认产品角度，规划 ${config.productScene.totalCount} 张不同场景`,
          `逐批确认后生成空背景，每批最多 ${config.productScene.batchSize} 张，同时运行最多 ${Math.min(config.productScene.batchSize, config.productScene.maxConcurrency ?? 10)} 个生成任务`,
          "本地回贴产品原图并检查背景相似度",
          ...(productSceneQualityEnabled(config.productScene)
            ? ["逐张调用视觉文本模型，检查可见接口"]
            : []),
          "逐张审核、拒绝或重做，导出已选用图片与清单",
        ]
    : config.reverseVideo
      ? ["获取原片与真实抽帧", "视频反推分析", "独立复核与必要修订", "导出文档并保存案例"]
      : config.xhsCover
        ? ["制定封面与标题方案", "生成封面或交付提示词", "人物与文字检查", "保存交付结果"]
        : config.remotion
          ? ["检查本地渲染环境", "生成声明式动画计划", "检查内容与动画时序", "本地渲染与交付"]
          : config.comicDrama
            ? [
                "逐集剧本共创与审核",
                "风格锁定与审核",
                "服化道与跨集资产设计",
                "导演分镜与双审",
                "执行提示词与双审",
                "确认实际分镜执行计划",
                ...(config.comicDrama.deliverable === "documents"
                  ? ["导出制作文档"]
                  : ["资产及镜头生成", "逐镜质检与必要返工", "合成并保存成片"]),
              ]
            : config.film
              ? [
                  "概念、角色与世界观规划",
                  "剧本、资产与表演设计",
                  "视频提示词与分镜",
                  ...(config.film.deliverable === "documents"
                    ? ["导出制作文档"]
                    : [
                        "确认实际分镜执行计划",
                        "资产及镜头生成",
                        "逐镜质检与必要返工",
                        "合成并保存成片",
                      ]),
                ]
              : config.commerce
                ? [
                    "产品资料核对",
                    "剧情创意与分镜设计",
                    ...(config.commerce.deliverable === "documents"
                      ? ["导出制作文档"]
                      : [
                          "确认实际分镜执行计划",
                          "一致性资产与镜头生成",
                          "产品保真与视觉质检",
                          "合成并保存成片",
                        ]),
                  ]
                : [
                    "内容诊断与六段式教学规划",
                    "生成脚本与分镜",
                    "确认实际分镜执行计划",
                    "生成封面与镜头",
                    "逐镜视觉质检与必要返工",
                    "合成并保存成片",
                  ];
  let steps = serialSteps(titles);
  if (config.musicVideo) {
    steps = serialSteps([
      "读取原曲并审核完整歌词时间线",
      "确认视觉风格与人物设定",
      "确认逐段分镜与音乐窗口",
      "审核视频提示词与唱词、嘴型策略",
      ...(config.musicVideo.deliverable === "documents"
        ? ["导出歌词、时间线、分镜提示词与审核报告"]
        : [
            "确认镜头依赖与制作计划",
            "确认人物及场景资产",
            "首镜试产并人工审核",
            "按依赖生成并逐段检查",
            "选用片段并按原曲窗口合成",
            "检查音视频时长并预览确认成片",
          ]),
    ]);
  }
  if (config.comicDrama) {
    const drama = config.comicDrama;
    const stages = comicDramaStageDependencies(drama.episodes).map((stage) => ({
      id: stage.id,
      title: `${drama.episodes[stage.episodeIndex]!.title} · ${COMIC_DRAMA_STAGE_LABELS[stage.stage]}（双审后由你确认）`,
      dependsOn: stage.dependsOn,
    }));
    const deliveryTitles =
      drama.deliverable === "documents"
        ? ["导出制作文档"]
        : [
            "确认实际分镜依赖与执行计划",
            "生成并审核角色、场景和道具资产",
            "首镜试产并人工审核",
            "按依赖批量生成与逐镜质检",
            "人工选用片段后合成",
            "预览并确认最终成片",
          ];
    steps = [
      ...stages,
      ...deliveryTitles.map((title, index) => ({
        id: `delivery-${index}`,
        title,
        dependsOn: index ? [`delivery-${index - 1}`] : stages.length ? [stages.at(-1)!.id] : [],
      })),
    ];
  }
  return {
    version: 1,
    id: crypto.randomUUID(),
    revision: (getWorkflowExecutionPlan(node)?.revision ?? 0) + 1,
    scope: "workflow",
    executionIntent,
    inputSignature: workflowExecutionInputSignature(node),
    steps,
    approval: null,
  };
}

/** The same graph is displayed for approval and dispatched by the production video runner. */
export function createVideoWorkflowExecutionSteps(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
): WorkflowExecutionStep[] {
  const orderedShots = orderedWorkflowShots(checkpoint);
  const pilotId = orderedShots[0]?.id;
  const hasExplicitDependencies = checkpoint.shots.some(
    (shot) => (shot.dependsOn?.length ?? 0) > 0 || !!shot.continuationFromShotId,
  );
  // Keep one visible QC decision at a time while independent video generation remains concurrent.
  const previousQc = new Map(
    orderedShots.map((shot, index) => [
      shot.id,
      index ? [`qc:${orderedShots[index - 1]!.id}`] : [],
    ]),
  );
  const videoIds = checkpoint.shots.map((shot) => `video:${shot.id}`);
  const qcIds = checkpoint.shots.map((shot) => `qc:${shot.id}`);
  return [
    { id: "assets", title: "准备角色、场景与产品参考资产", dependsOn: [], action: "assets" },
    { id: "cover", title: "生成封面与首帧参考图", dependsOn: ["assets"], action: "cover" },
    ...checkpoint.shots.map((shot) => ({
      id: `video:${shot.id}`,
      title: `镜头 ${shot.sequence} · ${shot.title}（${shot.durationSeconds} 秒）`,
      dependsOn: [
        ...new Set([
          "cover",
          ...(shot.id !== pilotId && pilotId ? [`video:${pilotId}`] : []),
          ...(shot.dependsOn ?? []).map((id) => `qc:${id}`),
          ...(shot.continuationFromShotId ? [`qc:${shot.continuationFromShotId}`] : []),
        ]),
      ],
      action: "video" as const,
      shotId: shot.id,
    })),
    ...checkpoint.shots.map((shot, index) => ({
      id: `qc:${shot.id}`,
      title: `验收镜头 ${shot.sequence} · ${shot.title}`,
      dependsOn: hasExplicitDependencies
        ? [`video:${shot.id}`, ...(previousQc.get(shot.id) ?? [])]
        : index
          ? [qcIds[index - 1]!, `video:${shot.id}`]
          : videoIds,
      action: "qc" as const,
      shotId: shot.id,
    })),
    {
      id: "compose",
      title: "按分镜顺序合成并保存成片",
      dependsOn: qcIds.length ? qcIds : ["cover"],
      action: "compose",
    },
  ];
}

export function orderedWorkflowShots(checkpoint: KnowledgeVideoWorkflowCheckpoint) {
  return topologicallySortWorkflowSteps(
    checkpoint.shots.map((shot) => ({
      ...shot,
      dependsOn: [
        ...new Set([
          ...(shot.dependsOn ?? []),
          ...(shot.continuationFromShotId ? [shot.continuationFromShotId] : []),
        ]),
      ],
    })),
  );
}

export function createWorkflowDeliveryPlan(
  node: KnowledgeVideoWorkflowNodeData,
  checkpoint: KnowledgeVideoWorkflowCheckpoint = node.config.checkpoint,
): WorkflowExecutionPlan {
  const steps = createVideoWorkflowExecutionSteps(checkpoint);
  topologicallySortWorkflowSteps(steps);
  return {
    version: 1,
    id: crypto.randomUUID(),
    revision:
      (checkpoint.executionPlan?.revision ?? getWorkflowExecutionPlan(node)?.revision ?? 0) + 1,
    scope: "delivery",
    executionIntent: "resume",
    inputSignature: workflowExecutionInputSignature(node),
    contentSignature: deliveryContentSignature(checkpoint),
    steps,
    approval: null,
  };
}

export function workflowMediaReviewPaths(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  kind: WorkflowMediaReviewKind,
): string[] {
  if (kind === "assets")
    return [
      ...new Set(
        [
          checkpoint.coverImagePath,
          ...(checkpoint.film?.assets.map((asset) => asset.path) ?? []),
        ].filter((path): path is string => !!path),
      ),
    ];
  if (kind === "final") return checkpoint.finalPath ? [checkpoint.finalPath] : [];
  const shots =
    kind === "first_shot" ? orderedWorkflowShots(checkpoint).slice(0, 1) : checkpoint.shots;
  return shots
    .map((shot) => checkpoint.shotRuns[shot.id]?.clipPath)
    .filter((path): path is string => !!path);
}

export function workflowMediaReviewSignature(
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
  kind: WorkflowMediaReviewKind,
): string {
  return stableJsonSignature({
    kind,
    runId: checkpoint.runId,
    content: deliveryContentSignature(checkpoint),
    paths: workflowMediaReviewPaths(checkpoint, kind),
  });
}

export function createWorkflowMediaReviewPlan(
  node: KnowledgeVideoWorkflowNodeData,
  kind: WorkflowMediaReviewKind,
): WorkflowExecutionPlan {
  const checkpoint = node.config.checkpoint;
  return {
    ...createWorkflowDeliveryPlan(node),
    review: {
      kind,
      paths: workflowMediaReviewPaths(checkpoint, kind),
      signature: workflowMediaReviewSignature(checkpoint, kind),
    },
  };
}
