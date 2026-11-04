import * as v from "valibot";
import { invokeDesktop } from "./ipc";

const styleSchema = v.object({ id: v.string(), name: v.string(), imageUrl: v.string(), author: v.string(), modelUrl: v.string() });
export type ImageStyleReference = v.InferOutput<typeof styleSchema>;
const pageSchema = v.object({ items: v.array(styleSchema), hasMore: v.boolean() });
const categorySchema = v.array(v.object({ name: v.string(), ids: v.array(v.number()) }));
const librarySchema = v.object({ favorites: v.array(styleSchema), recent: v.array(styleSchema) });
const LIBRARY_KEY = "canvas.image-style-reference-library.v1";
export const imageStyleMarket = {
  browse: (query: { page: number; requestId: string; keyword: string; tagIds: readonly number[] }) => invokeDesktop("list_image_styles", pageSchema, { query }),
  categories: () => invokeDesktop("list_image_style_categories", categorySchema),
};
export function readStyleLibrary(): v.InferOutput<typeof librarySchema> {
  try { return v.parse(librarySchema, JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "")); }
  catch { return { favorites: [], recent: [] }; }
}
export function saveStyleLibrary(library: v.InferOutput<typeof librarySchema>): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
}
