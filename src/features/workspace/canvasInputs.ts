import type { CanvasDocument, CanvasNodeEntry, CanvasNodesByKey } from "../canvas/canvasStore";
import { toMediaSrc } from "../../lib/backend";
import {
  assetGenerationInput,
  outputGenerationInput,
  type AssetEdgeData,
  type AssetKind,
  type GenerationMediaInput,
  type KnowledgeVideoWorkflowCheckpoint,
  type OutputNodeData,
} from "./workspaceModel";

/** edgeId is the removable edge entering the consumer, even for a relayed source. */
export interface ConnectedCanvasMediaInput extends GenerationMediaInput {
  readonly sourceKey: string;
  readonly edgeId: string;
  readonly sourceLabel: "素材" | "产物";
  readonly src: string | null;
  readonly finalPath: string | null;
}

export interface ConnectedCanvasTextInput {
  readonly key: string;
  readonly sourceKey: string;
  readonly name: string;
  readonly text: string;
  readonly edgeId: string;
}

export interface ResolvedCanvasInputs {
  readonly media: readonly ConnectedCanvasMediaInput[];
  readonly texts: readonly ConnectedCanvasTextInput[];
  readonly pending: readonly {
    readonly sourceKey: string;
    readonly edgeId: string;
    readonly name: string;
  }[];
}

type OwnMedia = Omit<ConnectedCanvasMediaInput, "edgeId">;
type OwnText = Omit<ConnectedCanvasTextInput, "edgeId">;
interface NodePayload {
  readonly media: readonly OwnMedia[];
  readonly texts: readonly OwnText[];
}

export function canvasNodeIndex(entries: readonly CanvasNodeEntry[]): CanvasNodesByKey {
  return {
    asset: new Map(entries.flatMap((e) => (e.type === "asset" ? [[e.data.key, e.data]] : []))),
    gen: new Map(entries.flatMap((e) => (e.type === "gen" ? [[e.data.key, e.data]] : []))),
    screenplay: new Map(
      entries.flatMap((e) => (e.type === "screenplay" ? [[e.data.key, e.data]] : [])),
    ),
    storyboard: new Map(
      entries.flatMap((e) => (e.type === "storyboard" ? [[e.data.key, e.data]] : [])),
    ),
    knowledgeVideoWorkflow: new Map(
      entries.flatMap((e) => (e.type === "knowledgeVideoWorkflow" ? [[e.data.key, e.data]] : [])),
    ),
    viralRemix: new Map(
      entries.flatMap((e) => (e.type === "viralRemix" ? [[e.data.key, e.data]] : [])),
    ),
    videoComposer: new Map(
      entries.flatMap((e) => (e.type === "videoComposer" ? [[e.data.key, e.data]] : [])),
    ),
    videoDownloader: new Map(
      entries.flatMap((e) => (e.type === "videoDownloader" ? [[e.data.key, e.data]] : [])),
    ),
    frameExtractor: new Map(
      entries.flatMap((e) => (e.type === "frameExtractor" ? [[e.data.key, e.data]] : [])),
    ),
    result: new Map(entries.flatMap((e) => (e.type === "result" ? [[e.data.key, e.data]] : []))),
    output: new Map(entries.flatMap((e) => (e.type === "output" ? [[e.data.key, e.data]] : []))),
  };
}

export function canvasNodesByKeyFromDocument(document: CanvasDocument): CanvasNodesByKey {
  return {
    asset: new Map(document.assetNodes.map((n) => [n.key, n])),
    gen: new Map(document.genNodes.map((n) => [n.key, n])),
    screenplay: new Map((document.screenplayNodes ?? []).map((n) => [n.key, n])),
    storyboard: new Map((document.storyboardNodes ?? []).map((n) => [n.key, n])),
    knowledgeVideoWorkflow: new Map(
      (document.knowledgeVideoWorkflowNodes ?? []).map((n) => [n.key, n]),
    ),
    viralRemix: new Map((document.viralRemixNodes ?? []).map((n) => [n.key, n])),
    videoComposer: new Map((document.videoComposerNodes ?? []).map((n) => [n.key, n])),
    videoDownloader: new Map((document.videoDownloaderNodes ?? []).map((n) => [n.key, n])),
    frameExtractor: new Map((document.frameExtractorNodes ?? []).map((n) => [n.key, n])),
    result: new Map(document.resultNodes.map((n) => [n.key, n])),
    output: new Map((document.outputNodes ?? []).map((n) => [n.key, n])),
  };
}

function outputPayload(output: OutputNodeData): NodePayload {
  if (output.mediaType === "text") {
    const text = output.textContent?.trim() ?? "";
    return {
      media: [],
      texts: text
        ? [{ key: output.key, sourceKey: output.key, name: output.name ?? "文本产物", text }]
        : [],
    };
  }
  const input = outputGenerationInput(output);
  return {
    media: input
      ? [
          {
            ...input,
            sourceKey: output.key,
            sourceLabel: "产物",
            src: input.previewUrl ?? null,
            finalPath: output.finalPath,
          },
        ]
      : [],
    texts: [],
  };
}

/** Read current deliverables only; historical revisions never become new request inputs. */
function workflowPayload(key: string, checkpoint: KnowledgeVideoWorkflowCheckpoint): NodePayload {
  const media: OwnMedia[] = [];
  const texts: OwnText[] = [];
  const paths = new Set<string>();
  const addFile = (id: string, name: string, kind: AssetKind, path: string | null | undefined) => {
    if (!path?.trim() || paths.has(path)) return;
    paths.add(path);
    const sourceKey = `${key}:${id}`;
    media.push({
      key: sourceKey,
      sourceKey,
      name,
      kind,
      sourceLabel: "产物",
      target: { kind: "local_file", path, canvasNodeKey: sourceKey, mediaType: kind },
      previewUrl: toMediaSrc(path),
      src: toMediaSrc(path),
      finalPath: path,
    });
  };
  const addText = (id: string, name: string, text: string | null | undefined) => {
    if (!text?.trim()) return;
    const sourceKey = `${key}:${id}`;
    texts.push({ key: sourceKey, sourceKey, name, text });
  };
  addText("script", "工作流剧本", checkpoint.script);
  addText("storyboard", "工作流分镜", checkpoint.storyboard);
  for (const artifact of checkpoint.film?.artifacts ?? []) {
    if (!artifact.stale) addText(`film:${artifact.stage}`, artifact.stage, artifact.content);
  }
  for (const episode of checkpoint.comicDrama?.episodes ?? []) {
    for (const [stage, run] of Object.entries(episode.stages)) {
      addText(`comic:${episode.id}:${stage}`, `${episode.title} · ${stage}`, run.artifact?.content);
    }
  }
  for (const [stage, run] of Object.entries(checkpoint.commerce?.stages ?? {})) {
    addText(`commerce:${stage}`, `剧情带货 · ${stage}`, run.artifact?.content);
  }
  addText("cover-prompt", "封面提示词", checkpoint.xhsCover?.plan?.prompt);
  if (checkpoint.remotion?.plan)
    addText("animation-plan", "动画方案", JSON.stringify(checkpoint.remotion.plan, null, 2));
  if (checkpoint.reverseVideo?.analysis) {
    addText(
      "reverse-analysis",
      "视频反推分析",
      JSON.stringify(checkpoint.reverseVideo.analysis, null, 2),
    );
  }
  const finalIsImage =
    checkpoint.xhsCover != null ||
    (checkpoint.remotion?.renderJob?.gifPath != null &&
      checkpoint.finalPath === checkpoint.remotion.renderJob.gifPath);
  addFile(
    "final",
    finalIsImage ? "工作流图片" : "工作流成片",
    finalIsImage ? "image" : "video",
    checkpoint.finalPath,
  );
  addFile(
    "cover",
    "工作流封面",
    "image",
    checkpoint.xhsCover?.finalPath ?? checkpoint.coverImagePath,
  );
  const render = checkpoint.remotion?.renderJob;
  if (render?.status === "succeeded") {
    addFile("animation-video", "动画视频", "video", render.videoPath);
    addFile("animation-gif", "动画 GIF", "image", render.gifPath);
    addFile("animation-preview", "动画预览", "image", render.previewPath);
  }
  const filmAssets = checkpoint.film?.artifacts.some((a) => a.stage === "assets" && a.stale)
    ? []
    : (checkpoint.film?.assets ?? []);
  for (const asset of [
    ...filmAssets,
    ...(checkpoint.comicDrama?.sharedAssets ?? []),
    ...(checkpoint.commerce?.sharedAssets ?? []),
  ]) {
    addFile(`asset:${asset.id}`, asset.name, "image", asset.path);
  }
  for (const shot of checkpoint.shots) {
    const run = checkpoint.shotRuns[shot.id];
    if (!run?.redoRequested) addFile(`shot:${shot.id}`, shot.title, "video", run?.clipPath);
  }
  addFile("reverse-video", "反推原视频", "video", checkpoint.reverseVideo?.videoPath);
  return { media, texts };
}

/**
 * One index per semantic graph snapshot; each target is resolved once. All node families relay
 * ordered inputs. Iterative traversal avoids stack overflow and visits each node at most once,
 * so diamonds and cycles cannot multiply payloads or feed the target's own data back into it.
 */
export function createCanvasInputResolver(
  nodeByKey: CanvasNodesByKey,
  edges: readonly AssetEdgeData[],
): (targetKey: string) => ResolvedCanvasInputs {
  const nodes = new Map<string, CanvasNodeEntry>();
  for (const type of Object.keys(nodeByKey) as (keyof CanvasNodesByKey)[]) {
    for (const [key, data] of nodeByKey[type]) nodes.set(key, { type, data } as CanvasNodeEntry);
  }
  const incoming = new Map<string, AssetEdgeData[]>();
  for (const edge of edges) {
    const target = nodeByKey.output.get(edge.toKey);
    // This automatic edge records provenance. A selected output stays pinned to its own task.
    if (target?.sourceNodeId === edge.fromKey) continue;
    const list = incoming.get(edge.toKey) ?? [];
    list.push(edge);
    incoming.set(edge.toKey, list);
  }
  const outputsByProducer = new Map<string, Map<string, NodePayload[]>>();
  for (const output of nodeByKey.output.values()) {
    // A task's first placeholder fixes its order. Late layers from an older task must not
    // make that task newer than a subsequent completed run from the same producer.
    const tasks = outputsByProducer.get(output.sourceNodeId) ?? new Map<string, NodePayload[]>();
    const taskOutputs = tasks.get(output.taskId) ?? [];
    const payload = outputPayload(output);
    if (payload.media.length > 0 || payload.texts.length > 0) taskOutputs.push(payload);
    tasks.set(output.taskId, taskOutputs);
    outputsByProducer.set(output.sourceNodeId, tasks);
  }
  const ownPayloads = new Map<string, NodePayload>();
  const ownPayload = (entry: CanvasNodeEntry): NodePayload => {
    const key = entry.data.key;
    const cached = ownPayloads.get(key);
    if (cached) return cached;
    let payload: NodePayload = { media: [], texts: [] };
    if (entry.type === "asset") {
      payload = {
        media: [
          {
            ...assetGenerationInput(entry.data),
            sourceKey: key,
            sourceLabel: "素材",
            src: entry.data.videoUrl ?? entry.data.previewUrl,
            finalPath: null,
          },
        ],
        texts: [],
      };
    } else if (entry.type === "output") {
      payload = outputPayload(entry.data);
    } else if (entry.type === "gen" && entry.data.kind === "prompt") {
      const text = entry.data.config.generatedPrompt.trim();
      payload = {
        media: [],
        texts: text ? [{ key, sourceKey: key, name: "提示词节点", text }] : [],
      };
    } else if (
      entry.type === "screenplay" ||
      entry.type === "storyboard" ||
      entry.type === "viralRemix"
    ) {
      const text = entry.data.config.currentDocument.trim();
      const fallback =
        entry.type === "screenplay"
          ? "剧本节点"
          : entry.type === "storyboard"
            ? "分镜节点"
            : "复刻方案";
      payload = {
        media: [],
        texts: text
          ? [{ key, sourceKey: key, name: text.match(/^#+\s+(.+)$/m)?.[1] ?? fallback, text }]
          : [],
      };
    } else if (entry.type === "knowledgeVideoWorkflow") {
      payload = workflowPayload(key, entry.data.config.checkpoint);
    }
    if (entry.type !== "asset" && entry.type !== "output") {
      const latest =
        Array.from(outputsByProducer.get(key)?.values() ?? [])
          .reverse()
          .find((outputs) => outputs.length > 0) ?? [];
      payload = {
        media: [...payload.media, ...latest.flatMap((p) => p.media)],
        texts: [...payload.texts, ...latest.flatMap((p) => p.texts)],
      };
    }
    ownPayloads.set(key, payload);
    return payload;
  };
  const resolved = new Map<string, ResolvedCanvasInputs>();
  return (targetKey) => {
    const cached = resolved.get(targetKey);
    if (cached) return cached;
    const media: ConnectedCanvasMediaInput[] = [];
    const texts: ConnectedCanvasTextInput[] = [];
    const pending: { sourceKey: string; edgeId: string; name: string }[] = [];
    const seenNodes = new Set([targetKey]);
    const seenMedia = new Set([targetKey]);
    const seenTexts = new Set([targetKey]);
    const stack = (incoming.get(targetKey) ?? [])
      .map((edge) => ({ key: edge.fromKey, edgeId: edge.id }))
      .reverse();
    while (stack.length) {
      const next = stack.pop()!;
      if (seenNodes.has(next.key)) continue;
      seenNodes.add(next.key);
      const entry = nodes.get(next.key);
      const parents = incoming.get(next.key) ?? [];
      const payload = entry ? ownPayload(entry) : { media: [], texts: [] };
      for (const item of payload.media) {
        if (seenMedia.has(item.sourceKey)) continue;
        seenMedia.add(item.sourceKey);
        media.push({ ...item, edgeId: next.edgeId });
      }
      for (const item of payload.texts) {
        if (seenTexts.has(item.sourceKey)) continue;
        seenTexts.add(item.sourceKey);
        texts.push({ ...item, edgeId: next.edgeId });
      }
      if (
        !payload.media.length &&
        !payload.texts.length &&
        (entry?.type !== "result" || !parents.length)
      ) {
        pending.push({
          sourceKey: next.key,
          edgeId: next.edgeId,
          name: entry?.type === "output" ? (entry.data.name ?? "待完成产物") : next.key,
        });
      }
      for (let i = parents.length - 1; i >= 0; i--) {
        stack.push({ key: parents[i]!.fromKey, edgeId: next.edgeId });
      }
    }
    const result = { media, texts, pending };
    // 链式连接时按源头优先排序：从目标节点出发，深度越大（越上游的源头）越靠前。
    // 例如 A → B → 生成节点，当前 DFS 会先收集 B 再收集 A，此处重排为 [A, B]。
    // 直连素材深度相同，相对顺序保持不变，后续 inputSlots 排序再调整直连素材间的顺序。
    const depthByKey = new Map<string, number>();
    const depthVisited = new Set<string>();
    const computeDepth = (key: string): number => {
      if (depthByKey.has(key)) return depthByKey.get(key)!;
      if (depthVisited.has(key)) return 0; // 防循环引用
      depthVisited.add(key);
      const parents = incoming.get(key) ?? [];
      let maxParentDepth = 0;
      for (const parent of parents) {
        maxParentDepth = Math.max(maxParentDepth, computeDepth(parent.fromKey));
      }
      depthVisited.delete(key);
      const depth = maxParentDepth + 1;
      depthByKey.set(key, depth);
      return depth;
    };
    media.sort((a, b) => computeDepth(b.sourceKey) - computeDepth(a.sourceKey));
    // 生成节点（图片/视频）若配置了 inputSlots，则对直连素材按槽位顺序排序；
    // 只重排有槽位的素材之间的相对顺序，保持它们在原数组中的位置区间，
    // 不影响继承素材（来自提示词节点）与直连素材之间的先后关系。
    const targetEntry = nodes.get(targetKey);
    if (
      targetEntry &&
      targetEntry.type === "gen" &&
      (targetEntry.data.kind === "image" || targetEntry.data.kind === "video") &&
      targetEntry.data.config.inputSlots &&
      targetEntry.data.config.inputSlots.length > 0
    ) {
      const slotOrder = new Map<string, number>();
      targetEntry.data.config.inputSlots.forEach((slot, index) => {
        if (slot !== null) slotOrder.set(slot, index);
      });
      const slottedIndices: number[] = [];
      const slottedItems: ConnectedCanvasMediaInput[] = [];
      media.forEach((item, index) => {
        if (slotOrder.has(item.sourceKey)) {
          slottedIndices.push(index);
          slottedItems.push(item);
        }
      });
      slottedItems.sort(
        (left, right) =>
          (slotOrder.get(left.sourceKey) ?? Number.MAX_SAFE_INTEGER) -
          (slotOrder.get(right.sourceKey) ?? Number.MAX_SAFE_INTEGER),
      );
      const resultMedia = [...media];
      slottedIndices.forEach((arrayIndex, i) => {
        resultMedia[arrayIndex] = slottedItems[i]!;
      });
      result.media = resultMedia;
    }
    resolved.set(targetKey, result);
    return result;
  };
}
