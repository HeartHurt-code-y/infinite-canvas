import { readFile } from "@tauri-apps/plugin-fs";
import { generationClient } from "../../lib/backend";

export interface OpeningTextLayer {
  readonly kind: "text";
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: string;
  readonly color: string;
  readonly outline: string;
  readonly italic: boolean;
  readonly visible: boolean;
}

export interface OpeningImageLayer {
  readonly kind: "image";
  readonly id: string;
  readonly name: string;
  readonly image: HTMLImageElement;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export type OpeningLayer = OpeningTextLayer | OpeningImageLayer;

export function paintOpeningLayers(canvas: HTMLCanvasElement, frame: HTMLCanvasElement, layers: readonly OpeningLayer[]) {
  const context = canvas.getContext("2d");
  if (!context) return;
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  const { width, height } = frame;
  context.clearRect(0, 0, width, height);
  context.drawImage(frame, 0, 0);
  for (const layer of layers) {
    if (!layer.visible) continue;
    if (layer.kind === "image") {
      context.drawImage(layer.image, layer.x * width, layer.y * height, layer.width * width, layer.height * height);
      continue;
    }
    context.save();
    const size = Math.round(Math.min(width, height) * layer.size / 100);
    context.font = `${layer.italic ? "italic " : ""}700 ${size}px ${layer.font}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = layer.color;
    context.shadowColor = "#0009";
    context.shadowBlur = height * .012;
    if (layer.outline) {
      context.strokeStyle = layer.outline;
      context.lineJoin = "round";
      context.lineWidth = Math.max(2, size * .07);
      context.strokeText(layer.text, layer.x * width, layer.y * height, width * .9);
    }
    context.fillText(layer.text, layer.x * width, layer.y * height, width * .9);
    context.restore();
  }
}

export function copyOpeningFrame(frame: HTMLCanvasElement, width = frame.width) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * frame.height / frame.width));
  canvas.getContext("2d")?.drawImage(frame, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function boxFromLayer(value: unknown, width: number, height: number) {
  const box = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const read = (coords: unknown) => Array.isArray(coords) && coords.length === 4 &&
    coords.every(value => typeof value === "number" && Number.isFinite(value)) ? coords as number[] : null;
  const normalized = read(box["normalized"]);
  const absolute = read(box["absolute"]);
  const limit = normalized?.some(value => value > 1) ? 1000 : 1;
  const coords = normalized?.map(value => value / limit) ?? absolute?.map((value, index) => value / (index % 2 ? height : width));
  if (!coords) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = coords;
  if (x1 < 0 || y1 < 0 || x2 > 1.001 || y2 > 1.001 || x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

async function readLayerImage(path: string, signal: AbortSignal) {
  const bytes = await readFile(path);
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    signal.throwIfAborted();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

export async function waitForOpeningLayers(taskId: string, frame: HTMLCanvasElement, signal: AbortSignal) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await generationClient.getProgress(taskId);
    signal.throwIfAborted();
    if (result.summary.status === "failed" || result.summary.status === "cancelled") {
      throw new Error("图层分离未完成，请在生成历史查看供应商结果。");
    }
    if (result.summary.status === "succeeded") {
      const entries = result.results.flatMap(record => {
        const meta = (record.source as { layer?: { zIndex?: unknown; boundingBox?: unknown; name?: unknown } } | null)?.layer;
        return meta && typeof meta.zIndex === "number" ? [{ meta, record, zIndex: meta.zIndex }] : [];
      }).sort((a, b) => a.zIndex - b.zIndex);
      if (!entries.length && result.results.length) throw new Error("供应商返回了图片，但没有可编辑的图层信息。");
      if (entries.some(({ record }) => record.saveStatus === "failed")) {
        throw new Error("部分图层保存失败，请在生成历史检查文件。");
      }
      if (entries.length && entries.every(({ record }) => record.finalPath && record.saveStatus === "succeeded")) {
        const base = entries.find(entry => entry.zIndex === 0);
        const baseImage = base ? await readLayerImage(base.record.finalPath!, signal) : null;
        const width = baseImage?.naturalWidth ?? frame.width;
        const height = baseImage?.naturalHeight ?? frame.height;
        return Promise.all(entries.map(async ({ record, meta, zIndex }): Promise<OpeningImageLayer> => {
          const image = zIndex === 0 && baseImage ? baseImage : await readLayerImage(record.finalPath!, signal);
          const bounds = zIndex === 0 ? { x: 0, y: 0, width: 1, height: 1 } : boxFromLayer(meta.boundingBox, width, height);
          if (!bounds) throw new Error(`图层 ${zIndex} 缺少有效的位置，原始图片已保存在生成历史。`);
          return { id: taskId + "#" + record.resultIndex, kind: "image", image, ...bounds,
            name: typeof meta.name === "string" && meta.name ? meta.name : zIndex === 0 ? "底图" : `图层 ${zIndex}`, visible: true };
        }));
      }
    }
    await new Promise<void>(resolve => window.setTimeout(resolve, 1250));
  }
  throw new Error("图层尚未全部保存，可在生成历史查看进度。");
}
