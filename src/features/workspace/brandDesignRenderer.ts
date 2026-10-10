import "@fontsource-variable/noto-sans-sc";
import type { BrandDesignExportFile, BrandDesignImage } from "../../lib/brandDesignClient";
import {
  BRAND_DESIGN_PAGE_IDS,
  brandDesignInputSignature,
  brandDesignPageSize,
  type BrandDesignDocument,
  type BrandDesignPageId,
  type BrandDesignSource,
  type BrandDesignSlot,
} from "./brandDesignModel";

export type BrandDesignImageLoader = (path: string) => Promise<BrandDesignImage>;
export interface BrandDesignRenderedSource extends BrandDesignSource {
  readonly pageId: BrandDesignPageId;
  readonly role: "image" | "logo";
  readonly actualContentHash: string;
  readonly changed: boolean;
}
export interface BrandDesignRenderedPage {
  readonly pageId: BrandDesignPageId;
  readonly width: number;
  readonly height: number;
  readonly pngDataUrl: string;
  readonly svg: string;
  readonly sources: readonly BrandDesignRenderedSource[];
  readonly notes: readonly string[];
}
export interface BrandDesignManifest {
  readonly schemaVersion: 1;
  readonly inputSignature: string;
  readonly sourceDraftSignature: string;
  readonly generatedAt: string;
  readonly pages: readonly {
    readonly pageId: BrandDesignPageId;
    readonly width: number;
    readonly height: number;
    readonly png: string;
    readonly svg: string;
  }[];
  readonly sources: readonly BrandDesignRenderedSource[];
  readonly notes: readonly string[];
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly secondary: string;
}
const PALETTES: Record<BrandDesignDocument["preset"], Palette> = {
  editorial: { background: "#f8f8f6", foreground: "#171a1e", secondary: "#65696e" },
  retro: { background: "#151719", foreground: "#f1eee8", secondary: "#c2b69e" },
  quiet: { background: "#ece7de", foreground: "#272723", secondary: "#776956" },
};
const FONT_FAMILY = "Noto Sans SC Variable, sans-serif";
const SVG_FONT_FAMILY = "Noto Sans SC Variable, sans-serif";

export function escapeBrandDesignXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法创建品牌设计绘图画布。");
  return context;
}

function validDocument(document: BrandDesignDocument): void {
  if (document.schemaVersion !== 1 || !PALETTES[document.preset])
    throw new Error("品牌设计版本或风格无效，请重新建立设计。");
  if (new Set(document.slots.map((slot) => slot.id)).size !== document.slots.length)
    throw new Error("品牌设计包含重复图位，请重新建立设计。");
  for (const slot of document.slots) {
    if (!BRAND_DESIGN_PAGE_IDS.includes(slot.id) || !["contain", "cover"].includes(slot.fit))
      throw new Error("品牌设计图位或图片布局无效。");
  }
}

/** Wait for the actual CJK subsets used by this document, including preview renders. */
async function ensureFonts(document: BrandDesignDocument): Promise<void> {
  const sample = [
    document.brandName,
    document.seriesTitle,
    document.seriesDescription,
    document.homepage.title,
    document.homepage.body,
    ...document.slots.flatMap((slot) => [slot.copy.title, slot.copy.body]),
  ].join(" ");
  await window.document.fonts.ready;
  await Promise.all(
    [400, 500, 600].map((weight) =>
      window.document.fonts.load(`${weight} 64px "Noto Sans SC Variable"`, sample || "品牌"),
    ),
  );
  await window.document.fonts.ready;
}

/** Measured glyph widths, including manual paragraph breaks. Never truncate copy. */
function wrappedLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const glyph of Array.from(paragraph)) {
      if (line && context.measureText(line + glyph).width > width) {
        result.push(line.trimEnd());
        line = glyph.trimStart();
      } else line += glyph;
    }
    result.push(line.trimEnd());
  }
  return result;
}

function drawText(
  context: CanvasRenderingContext2D,
  svg: string[],
  id: string,
  text: string,
  rect: Rect,
  size: number,
  minSize: number,
  weight: number,
  fill: string,
): void {
  if (!text.trim()) return;
  for (let fittedSize = size; fittedSize >= minSize; fittedSize -= 2) {
    context.font = `${weight} ${fittedSize}px ${FONT_FAMILY}`;
    const lines = wrappedLines(context, text, rect.width);
    const lineHeight = fittedSize * 1.42;
    if (
      lines.length * lineHeight > rect.height ||
      lines.some((line) => context.measureText(line).width > rect.width)
    )
      continue;
    context.fillStyle = fill;
    context.textBaseline = "alphabetic";
    const spans: string[] = [];
    lines.forEach((line, index) => {
      const y = rect.y + fittedSize * 1.08 + index * lineHeight;
      context.fillText(line, rect.x, y);
      spans.push(`<tspan x="${rect.x}" y="${y}">${escapeBrandDesignXml(line)}</tspan>`);
    });
    svg.push(
      `<text id="${id}" font-family="${SVG_FONT_FAMILY}" font-weight="${weight}" font-size="${fittedSize}" fill="${fill}">${spans.join("")}</text>`,
    );
    return;
  }
  throw new Error(`${id} 文案超出当前版式的可读容量，请缩短文字或拆分到其他图位；文字未被截断。`);
}

async function loadRaster(
  path: string,
  loader: BrandDesignImageLoader,
): Promise<{
  readonly image: HTMLImageElement;
  readonly png: string;
  readonly metadata: BrandDesignImage;
}> {
  const metadata = await loader(path);
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(metadata.dataUrl))
    throw new Error("图片读取结果不是安全的 PNG、JPEG 或 WebP；品牌图层不执行 SVG 或外部地址。");
  if (
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width * metadata.height > 64_000_000
  )
    throw new Error("图片像素尺寸无效或超过当前本地排版的可解码范围。");
  const image = new Image();
  image.src = metadata.dataUrl;
  await image.decode();
  if (image.naturalWidth !== metadata.width || image.naturalHeight !== metadata.height)
    throw new Error("图片解码尺寸与读取结果不一致，请重新读取原图。");
  // SVG includes only normalized raster data. PNG input does not need another copy.
  if (metadata.dataUrl.startsWith("data:image/png;base64,"))
    return { image, png: metadata.dataUrl, metadata };
  const normalized = window.document.createElement("canvas");
  normalized.width = metadata.width;
  normalized.height = metadata.height;
  try {
    contextFor(normalized).drawImage(image, 0, 0);
    return { image, png: normalized.toDataURL("image/png"), metadata };
  } finally {
    normalized.width = 0;
    normalized.height = 0;
  }
}

async function drawImageLayer(
  context: CanvasRenderingContext2D,
  svg: string[],
  id: string,
  source: BrandDesignSource,
  rect: Rect,
  fit: "contain" | "cover",
  pageId: BrandDesignPageId,
  loader: BrandDesignImageLoader,
  sources: BrandDesignRenderedSource[],
  notes: string[],
  role: BrandDesignRenderedSource["role"] = "image",
): Promise<void> {
  const { image, png, metadata } = await loadRaster(source.path, loader);
  try {
    const ratio =
      fit === "cover"
        ? Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
        : Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * ratio;
    const height = image.naturalHeight * ratio;
    const x = rect.x + (rect.width - width) / 2;
    const y = rect.y + (rect.height - height) / 2;
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    context.drawImage(image, x, y, width, height);
    context.restore();
    const clipId = `${id}-clip`;
    svg.push(
      `<defs><clipPath id="${clipId}"><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"/></clipPath></defs>`,
    );
    svg.push(
      `<image id="${id}" x="${x}" y="${y}" width="${width}" height="${height}" href="${png}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`,
    );
    const changed = Boolean(source.contentHash && source.contentHash !== metadata.contentHash);
    sources.push({ ...source, pageId, role, actualContentHash: metadata.contentHash, changed });
    if (changed)
      notes.push(
        `${pageId} ${role === "logo" ? "Logo" : "图片"}内容已改变：历史摘要 ${source.contentHash}，本次摘要 ${metadata.contentHash}。请复核当前内容。`,
      );
    if (!source.contentHash)
      notes.push(
        `${pageId} ${role === "logo" ? "Logo" : "图片"}未保存历史摘要，本次读取摘要已记入来源清单。`,
      );
  } finally {
    image.src = "";
  }
}

interface RenderState {
  readonly context: CanvasRenderingContext2D;
  readonly svg: string[];
  readonly document: BrandDesignDocument;
  readonly loader: BrandDesignImageLoader;
  readonly sources: BrandDesignRenderedSource[];
  readonly notes: string[];
}

async function drawBrand(
  state: RenderState,
  pageId: BrandDesignPageId,
  width: number,
): Promise<void> {
  const { context, svg, document, loader, sources, notes } = state;
  const palette = PALETTES[document.preset];
  const inset = width === 2048 ? 112 : 96;
  if (document.logo) {
    await drawImageLayer(
      context,
      svg,
      `${pageId}-logo`,
      {
        path: document.logo.path,
        ...(document.logo.contentHash ? { contentHash: document.logo.contentHash } : {}),
        kind: "source",
      },
      { x: inset, y: 68, width: 230, height: 100 },
      "contain",
      pageId,
      loader,
      sources,
      notes,
      "logo",
    );
  }
  drawText(
    context,
    svg,
    `${pageId}-brand`,
    document.brandName,
    {
      x: document.logo ? inset + 270 : inset,
      y: 76,
      width: width - inset * 2 - (document.logo ? 270 : 0),
      height: 96,
    },
    56,
    30,
    500,
    palette.foreground,
  );
}

async function drawSlot(state: RenderState, slot: BrandDesignSlot): Promise<void> {
  if (!slot.source?.path) throw new Error(`${slot.id} 缺少可读取的图片，未输出占位成品。`);
  const { context, svg, document, loader, sources, notes } = state;
  const palette = PALETTES[document.preset];
  const square = slot.id.startsWith("M");
  const { width, height } = brandDesignPageSize(slot.id);
  if (slot.id === "M05") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    svg.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    await drawImageLayer(
      context,
      svg,
      `${slot.id}-image`,
      slot.source,
      { x: 0, y: 0, width, height },
      "contain",
      slot.id,
      loader,
      sources,
      notes,
    );
    notes.push(
      "M05 使用白色版式底板，不添加文字或 Logo；原照片内背景、道具、透射关系和阴影保持在图层内，未自动抠图，也未自动验证纯白商品图条件。",
    );
    return;
  }
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  svg.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${palette.background}"/>`);
  await drawBrand(state, slot.id, width);
  if (square) {
    const noCopy = !slot.copy.title.trim() && !slot.copy.body.trim();
    await drawImageLayer(
      context,
      svg,
      `${slot.id}-image`,
      slot.source,
      { x: 112, y: 260, width: 1824, height: noCopy ? 1676 : 1190 },
      slot.fit,
      slot.id,
      loader,
      sources,
      notes,
    );
    drawText(
      context,
      svg,
      `${slot.id}-title`,
      slot.copy.title,
      { x: 112, y: 1518, width: 1824, height: 252 },
      96,
      50,
      500,
      palette.foreground,
    );
    drawText(
      context,
      svg,
      `${slot.id}-body`,
      slot.copy.body,
      { x: 112, y: 1810, width: 1824, height: 156 },
      44,
      28,
      400,
      palette.secondary,
    );
  } else {
    drawText(
      context,
      svg,
      `${slot.id}-title`,
      slot.copy.title,
      { x: 96, y: 230, width: 1344, height: 235 },
      82,
      48,
      500,
      palette.foreground,
    );
    await drawImageLayer(
      context,
      svg,
      `${slot.id}-image`,
      slot.source,
      { x: 96, y: 520, width: 1344, height: 1080 },
      slot.fit,
      slot.id,
      loader,
      sources,
      notes,
    );
    drawText(
      context,
      svg,
      `${slot.id}-body`,
      slot.copy.body,
      { x: 96, y: 1680, width: 1344, height: 285 },
      46,
      30,
      400,
      palette.secondary,
    );
  }
}

async function drawHomepage(state: RenderState): Promise<void> {
  const { context, svg, document, loader, sources, notes } = state;
  const slot = document.slots.find((item) => item.id === document.homepage.heroSlotId);
  if (!slot?.source?.path)
    throw new Error(`首页主视觉关联的 ${document.homepage.heroSlotId} 缺少图片，未输出占位成品。`);
  const palette = PALETTES[document.preset];
  context.fillStyle = palette.background;
  context.fillRect(0, 0, 2048, 1152);
  svg.push(`<rect x="0" y="0" width="2048" height="1152" fill="${palette.background}"/>`);
  await drawBrand(state, "HOME", 2048);
  await drawImageLayer(
    context,
    svg,
    "HOME-image",
    slot.source,
    { x: 900, y: 218, width: 1036, height: 830 },
    slot.fit,
    "HOME",
    loader,
    sources,
    notes,
  );
  drawText(
    context,
    svg,
    "HOME-title",
    document.homepage.title,
    { x: 112, y: 330, width: 692, height: 470 },
    98,
    48,
    500,
    palette.foreground,
  );
  drawText(
    context,
    svg,
    "HOME-body",
    document.homepage.body,
    { x: 112, y: 850, width: 692, height: 218 },
    42,
    26,
    400,
    palette.secondary,
  );
}

/** PNG and SVG share one measured layout; scale affects raster output only. */
export async function renderBrandDesignPage(
  document: BrandDesignDocument,
  pageId: BrandDesignPageId,
  loader: BrandDesignImageLoader,
  scale = 1,
): Promise<BrandDesignRenderedPage> {
  validDocument(document);
  if (!BRAND_DESIGN_PAGE_IDS.includes(pageId)) throw new Error("未知品牌设计图位。");
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1)
    throw new Error("品牌设计预览比例必须大于 0 且不超过 1。");
  await ensureFonts(document);
  const size = brandDesignPageSize(pageId);
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = contextFor(canvas);
  // Integer raster dimensions can round, so preserve complete content at tiny preview sizes.
  context.scale(canvas.width / size.width, canvas.height / size.height);
  const svg: string[] = [];
  const sources: BrandDesignRenderedSource[] = [];
  const notes: string[] = [];
  const state: RenderState = { context, svg, document, loader, sources, notes };
  try {
    if (pageId === "HOME") await drawHomepage(state);
    else if (pageId === "DETAIL") {
      const detail = ["D01", "D02", "D03", "D04", "D05"] as const;
      for (const [index, id] of detail.entries()) {
        const slot = document.slots.find((item) => item.id === id);
        if (!slot?.source?.path) throw new Error(`连续详情缺少 ${id} 图片，未输出不完整长图。`);
        context.save();
        context.translate(0, index * 2048);
        svg.push(`<g id="${id}-module" transform="translate(0 ${index * 2048})">`);
        await drawSlot(state, slot);
        svg.push("</g>");
        context.restore();
      }
    } else {
      const slot = document.slots.find((item) => item.id === pageId);
      if (!slot) throw new Error(`${pageId} 图位已缺失。`);
      await drawSlot(state, slot);
    }
    const pngDataUrl = canvas.toDataURL("image/png");
    if (!pngDataUrl.startsWith("data:image/png;base64,"))
      throw new Error("品牌设计画布编码失败，未输出空白图片。");
    return {
      pageId,
      width: canvas.width,
      height: canvas.height,
      pngDataUrl,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${svg.join("")}</svg>`,
      sources,
      notes,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(""));
}

/** Serial rendering frees each full-resolution canvas before the next page. */
export async function renderBrandDesignBundle(
  document: BrandDesignDocument,
  loader: BrandDesignImageLoader,
): Promise<{
  readonly files: readonly BrandDesignExportFile[];
  readonly manifest: BrandDesignManifest;
  readonly notes: readonly string[];
}> {
  validDocument(document);
  const files: BrandDesignExportFile[] = [];
  const pages: BrandDesignManifest["pages"][number][] = [];
  const sources: BrandDesignRenderedSource[] = [];
  const notes = [
    "图片以等比缩放参与排版；contain 保留完整画面，cover 是用户选定的裁切。原文件未改写，缩放后的像素不等同于原始像素。",
    "可编辑 SVG 使用 Noto Sans SC Variable 字体；在外部编辑器修改文字时需安装该字体。PNG 为本次字体加载后的确定排版结果。",
  ];
  for (const pageId of BRAND_DESIGN_PAGE_IDS) {
    try {
      const page = await renderBrandDesignPage(document, pageId, loader);
      const png = `${pageId}.png`;
      const svg = `${pageId}.svg`;
      files.push(
        { name: png, base64: page.pngDataUrl.slice("data:image/png;base64,".length) },
        { name: svg, base64: utf8Base64(page.svg) },
      );
      pages.push({ pageId, width: page.width, height: page.height, png, svg });
      sources.push(...page.sources);
      notes.push(...page.notes);
    } catch (error) {
      notes.push(`${pageId} 未导出：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const manifest: BrandDesignManifest = {
    schemaVersion: 1,
    inputSignature: brandDesignInputSignature(document),
    sourceDraftSignature: document.sourceDraftSignature,
    generatedAt: new Date().toISOString(),
    pages,
    sources,
    notes: [...new Set(notes)],
  };
  if (!pages.length)
    throw new Error(
      `当前设计没有可导出的成图。${manifest.notes.filter((note) => note.includes("未导出")).join(" ")}`,
    );
  files.push(
    {
      name: "design.json",
      base64: utf8Base64(
        JSON.stringify({ ...document, inputSignature: manifest.inputSignature }, null, 2),
      ),
    },
    { name: "manifest.json", base64: utf8Base64(JSON.stringify(manifest, null, 2)) },
  );
  return { files, manifest, notes: manifest.notes };
}
