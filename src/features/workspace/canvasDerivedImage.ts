import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { localBase64AssetClient, type MediaReferenceTarget } from "../../lib/backend";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import type { CanvasCommands, CanvasNodeEntry, CanvasStore } from "../canvas/canvasStore";
import { imageNodePreview } from "./imageNodeResults";
import {
  assetNodeDimensions,
  assetNodeKey,
  assetNodeReferenceTarget,
  fitMediaNodeDimensions,
  genNodeDimensions,
  nearestAvailableNodePosition,
  NEW_NODE_GAP,
  outputNodeDimensions,
  type AssetNodeData,
  type OutputNodeData,
} from "./workspaceModel";

export type CanvasLocalEditSource = OutputNodeData | {
  readonly key: string;
  readonly finalPath: string;
  readonly name: string;
  readonly target: MediaReferenceTarget;
};

export function findCanvasLocalEditSource(store: CanvasStore, nodeKey: string, output: CanvasLocalEditSource) {
  const state = store.getState();
  const owner = state.nodesById[nodeKey];
  if ("target" in output) {
    if (owner?.type !== "asset" || owner.data.key !== output.key ||
        !sameMediaReferenceTarget(assetNodeReferenceTarget(owner.data), output.target)) return null;
    return { state, owner, source: owner };
  }
  if (owner?.type === "output") {
    if (owner.data.key !== output.key || owner.data.taskId !== output.taskId ||
        owner.data.resultKey !== output.resultKey || owner.data.finalPath !== output.finalPath) return null;
    return { state, owner, source: owner };
  }
  if (owner?.type !== "gen") return null;
  const result = state.nodesById[output.key];
  const current = result?.type === "output" && result.data.sourceNodeId === nodeKey
    ? result.data
    : owner.data.kind === "image" ? imageNodePreview(owner.data) : null;
  if (!current || current.key !== output.key || current.taskId !== output.taskId ||
      current.resultKey !== output.resultKey || current.finalPath !== output.finalPath) return null;
  return { state, owner, source: result?.type === "output" ? result : owner };
}

function nodeSize(entry: CanvasNodeEntry) {
  if (entry.type === "asset") return assetNodeDimensions(entry.data);
  if (entry.type === "output") return outputNodeDimensions(entry.data);
  if (entry.type === "gen") return entry.data.measured ?? genNodeDimensions(entry.data.kind);
  return entry.data.measured ?? { width: 622, height: 400 };
}

export function planCanvasDerivedImage(store: CanvasStore, nodeKey: string, output: CanvasLocalEditSource, ratio: number) {
  const live = findCanvasLocalEditSource(store, nodeKey, output);
  if (!live) throw new Error("来源已变化，请重新打开工具。");
  const { state, owner } = live;
  const size = fitMediaNodeDimensions(ratio);
  const sourceRect = { x: owner.data.x, y: owner.data.y, ...nodeSize(owner) };
  const position = nearestAvailableNodePosition({
    x: sourceRect.x + sourceRect.width + NEW_NODE_GAP,
    y: sourceRect.y,
    ...size,
  }, Object.values(state.nodesById).map(entry => ({ x: entry.data.x, y: entry.data.y, ...nodeSize(entry) })));
  return { ...position, ...size, sourceRect };
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    result => result ? resolve(result) : reject(new Error("无法编码编辑后的图片。")),
    "image/png",
  ));
}

/** 任务的冻结输入留在应用数据目录，供历史重试使用。 */
export async function stageCanvasRegionImages(taskId: string, image: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const directory = await join(await appDataDir(), "canvas-region-inputs");
  await mkdir(directory, { recursive: true });
  const imagePath = await join(directory, taskId + "-image.png");
  const maskPath = await join(directory, taskId + "-mask.png");
  const discard = async () => {
    await Promise.allSettled([remove(imagePath), remove(maskPath)]);
  };
  try {
    const imageBytes = await encodePng(image);
    const maskBytes = await encodePng(mask);
    await writeFile(imagePath, new Uint8Array(await imageBytes.arrayBuffer()));
    await writeFile(maskPath, new Uint8Array(await maskBytes.arrayBuffer()));
    return { imagePath, maskPath, discard };
  } catch (failure) {
    await discard();
    throw failure;
  }
}

/** 本地编辑产物进入现有素材库，保留来源连线和稳定的素材 ID。 */
export async function saveCanvasDerivedImage({
  canvas, name, store, commands, nodeKey, output, signal, position,
}: {
  readonly canvas: HTMLCanvasElement;
  readonly name: string;
  readonly store: CanvasStore;
  readonly commands: CanvasCommands;
  readonly nodeKey: string;
  readonly output: CanvasLocalEditSource;
  readonly signal: AbortSignal;
  readonly position?: { readonly x: number; readonly y: number };
}): Promise<void> {
  await saveCanvasDerivedImages({ images: [{ canvas, name }], store, commands, nodeKey, output, signal, position });
}

export async function saveCanvasDerivedImages({ images, store, commands, nodeKey, output, signal, position }: {
  readonly images: readonly { canvas: HTMLCanvasElement; name: string }[];
  readonly store: CanvasStore;
  readonly commands: CanvasCommands;
  readonly nodeKey: string;
  readonly output: CanvasLocalEditSource;
  readonly signal: AbortSignal;
  readonly position?: { readonly x: number; readonly y: number } | undefined;
}): Promise<readonly string[]> {
  signal.throwIfAborted();
  if (!findCanvasLocalEditSource(store, nodeKey, output)) throw new Error("来源已变化，请重新打开工具。");
  const directory = await join(await appDataDir(), "canvas-derived-images");
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const { canvas, name } of images) {
    signal.throwIfAborted();
    const path = await join(directory, crypto.randomUUID() + ".png");
    try {
      const blob = await encodePng(canvas);
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      signal.throwIfAborted();
      const record = await localBase64AssetClient.importAsset({ localPath: path, name: name + ".png" });
      records.push({ record, name, ratio: canvas.width / canvas.height });
    } finally {
      await remove(path).catch(() => {});
    }
  }
  signal.throwIfAborted();
  const live = findCanvasLocalEditSource(store, nodeKey, output);
  if (!live) throw new Error("来源已变化，编辑后的图片已保存在素材库。");
  const first = records[0];
  if (!first) return [];
  const origin = position ?? planCanvasDerivedImage(store, nodeKey, output, first.ratio);
  const occupied = Object.values(live.state.nodesById).map(entry => ({ x: entry.data.x, y: entry.data.y, ...nodeSize(entry) }));
  let nextY = origin.y;
  const assets = records.map(({ record, name, ratio }, index): AssetNodeData => {
    const size = fitMediaNodeDimensions(ratio);
    const placement = index === 0 ? origin : nearestAvailableNodePosition({ x: origin.x, y: nextY, ...size }, occupied);
    occupied.push({ ...placement, ...size });
    nextY = placement.y + size.height + NEW_NODE_GAP;
    return {
      key: assetNodeKey(),
      assetId: record.id,
      providerConnectionId: "",
      source: "local",
      kind: "image",
      name,
      previewUrl: record.previewUrl,
      videoUrl: null,
      aspectRatio: ratio,
      x: placement.x,
      y: placement.y,
    };
  });
  const fromKey = live.source.data.key;
  if (commands.insertSubgraph(assets.map(data => ({ type: "asset", data })), assets.map(asset => ({
    id: fromKey + "->" + asset.key,
    fromKey,
    toKey: asset.key,
  })), { selectNodeKey: assets[0]!.key }) !== "applied") {
    throw new Error("图片已保存在素材库，请从素材库添加到画布。");
  }
  return assets.map(asset => asset.key);
}
