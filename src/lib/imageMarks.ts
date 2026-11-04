import * as v from "valibot";
import type { MediaReferenceTarget } from "./backend";

export interface ImageMarkSuggestion {
  readonly label: string;
  readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface ImageMark {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceName: string;
  readonly sourceTarget: MediaReferenceTarget;
  readonly point: { readonly x: number; readonly y: number };
  readonly suggestions: readonly ImageMarkSuggestion[];
  readonly selectedIndex: number;
}

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const suggestionSchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  bbox: v.object({ x: unit, y: unit, width: unit, height: unit }),
});

export function parseImageMarkSuggestions(raw: string, point: ImageMark["point"]): readonly ImageMarkSuggestion[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  const response = v.parse(v.object({ suggestions: v.array(suggestionSchema) }), JSON.parse(text));
  const labels = new Set<string>();
  const suggestions = response.suggestions.flatMap(suggestion => {
    const { x, y } = suggestion.bbox;
    const width = Math.min(suggestion.bbox.width, 1 - x);
    const height = Math.min(suggestion.bbox.height, 1 - y);
    if (width <= 0 || height <= 0 || labels.has(suggestion.label) ||
      point.x < x - .02 || point.x > x + width + .02 || point.y < y - .02 || point.y > y + height + .02) return [];
    labels.add(suggestion.label);
    return [{ label: suggestion.label, bbox: { x, y, width, height } }];
  }).slice(0, 5);
  if (!suggestions.length) throw new Error("未识别出任何内容，请重新尝试。");
  return suggestions;
}

export function imageMarkDescription(mark: ImageMark): string {
  const { x, y, width, height } = (mark.suggestions[mark.selectedIndex] ?? mark.suggestions[0])!.bbox;
  return `${mark.sourceName}中的局部元素，区域：左 ${Math.round(x * 100)}%、上 ${Math.round(y * 100)}%、宽 ${Math.round(width * 100)}%、高 ${Math.round(height * 100)}%`;
}

export function imageMarkRecognitionPrompt(point: ImageMark["point"]): string {
  return `识别参考图片中归一化坐标 (${point.x.toFixed(4)}, ${point.y.toFixed(4)}) 指向的可见元素。坐标原点为图片左上角，x 向右、y 向下，宽高均归一化为 1。
返回 1 至 5 个包含该点的候选，从最具体的局部到所属物体排列。label 用简短中文描述真实可见的元素及其颜色；bbox 是该元素的完整边界框，x/y/width/height 都是 0 到 1 的数字。不要猜测身份或不可见内容。没有可辨认元素时返回空 suggestions。
只输出严格 JSON，不要代码围栏或解释：{"suggestions":[{"label":"元素名称","bbox":{"x":0.1,"y":0.2,"width":0.3,"height":0.4}}]}`;
}
