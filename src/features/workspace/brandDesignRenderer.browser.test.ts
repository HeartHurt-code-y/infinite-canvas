import { describe, expect, it } from "vitest";
import type { BrandDesignImage } from "../../lib/brandDesignClient";
import { createJewelrySceneOptions } from "./productSceneWorkflowModel";
import { generateJewelryLaunchDraft } from "./jewelryLaunchPlan";
import { createBrandDesignDocument, type BrandDesignDocument } from "./brandDesignModel";
import { renderBrandDesignBundle, renderBrandDesignPage } from "./brandDesignRenderer";

function raster(logo = false): BrandDesignImage {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 100;
  const context = canvas.getContext("2d")!;
  if (logo) {
    context.fillStyle = "#ed0000";
    context.fillRect(10, 10, 180, 80);
  } else {
    context.fillStyle = "#00a000";
    context.fillRect(0, 0, 200, 100);
    context.fillStyle = "#e00000";
    context.fillRect(0, 0, 20, 100);
    context.fillStyle = "#0000e0";
    context.fillRect(180, 0, 20, 100);
  }
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: 200,
    height: 100,
    contentHash: (logo ? "b" : "a").repeat(64),
  };
}

function editableDocument(): BrandDesignDocument {
  const base = createBrandDesignDocument(generateJewelryLaunchDraft(createJewelrySceneOptions()));
  return {
    ...base,
    brandName: "闻山 珠宝",
    seriesTitle: "杉间新作",
    seriesDescription: "金属与珍珠的对话",
    logo: { path: "logo.png", contentHash: "b".repeat(64) },
    slots: base.slots.map((slot) => ({
      ...slot,
      copy: { title: `${slot.id} 杉间珍珠耳饰`, body: "真实材质与清晰轮廓。保留原图的完整构图。" },
      source: { path: "product.png", contentHash: "a".repeat(64), kind: "source" as const },
    })),
    homepage: { heroSlotId: "M01", title: "杉间新作", body: "金属与珍珠的对话" },
  };
}

async function decode(dataUrl: string): Promise<CanvasRenderingContext2D> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return context;
}

describe("brand design actual browser export", () => {
  it("renders Chinese, a real Logo and complete source edges; SVG has editable deterministic layers", async () => {
    const source = raster();
    const logo = raster(true);
    const page = await renderBrandDesignPage(
      editableDocument(),
      "M01",
      (path) => Promise.resolve(path === "logo.png" ? logo : source),
      0.25,
    );
    const context = await decode(page.pngDataUrl);
    expect(context.canvas.width).toBe(512);
    expect(context.canvas.height).toBe(512);
    expect(Array.from(context.getImageData(30, 210, 1, 1).data)).toEqual([224, 0, 0, 255]);
    expect(Array.from(context.getImageData(482, 210, 1, 1).data)).toEqual([0, 0, 224, 255]);
    expect(Array.from(context.getImageData(57, 29, 1, 1).data)).toEqual([237, 0, 0, 255]);
    expect(document.fonts.check('500 64px "Noto Sans SC Variable"', "闻山珠宝")).toBe(true);
    const brandInk = context.getImageData(95, 20, 150, 24).data;
    expect(
      Array.from(brandInk).filter((value, index) => index % 4 === 0 && value < 100).length,
    ).toBeGreaterThan(80);
    const svg = new DOMParser().parseFromString(page.svg, "image/svg+xml");
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.querySelector("#M01-brand")?.textContent).toBe("闻山 珠宝");
    expect(svg.querySelector("#M01-logo")?.getAttribute("href")).toBe(logo.dataUrl);
    expect(Number(svg.querySelector("#M01-image")?.getAttribute("height"))).toBeCloseTo(912);
    expect(svg.querySelector("script,foreignObject,style")).toBeNull();
    const white = await renderBrandDesignPage(
      {
        ...editableDocument(),
        slots: editableDocument().slots.map((slot) => ({ ...slot, fit: "cover" })),
      },
      "M05",
      () => Promise.resolve(source),
      0.25,
    );
    const whiteSvg = new DOMParser().parseFromString(white.svg, "image/svg+xml");
    expect(whiteSvg.querySelector("text")).toBeNull();
    const whitePixels = await decode(white.pngDataUrl);
    expect(Array.from(whitePixels.getImageData(5, 250, 1, 1).data)).toEqual([224, 0, 0, 255]);
    expect(Array.from(whitePixels.getImageData(506, 250, 1, 1).data)).toEqual([0, 0, 224, 255]);
    expect(whiteSvg.querySelector("#M05-logo")).toBeNull();
    expect(Array.from((await decode(white.pngDataUrl)).getImageData(30, 20, 1, 1).data)).toEqual([
      255, 255, 255, 255,
    ]);
    expect(white.notes.some((note) => note.includes("未自动抠图"))).toBe(true);
  });

  it("stitches five actual detail modules without seams and exports decodable original-size artifacts", async () => {
    const doc = editableDocument();
    const source = raster();
    const loader = (path: string) => Promise.resolve(path === "logo.png" ? raster(true) : source);
    const page = await renderBrandDesignPage(doc, "DETAIL", loader);
    const context = await decode(page.pngDataUrl);
    expect([context.canvas.width, context.canvas.height]).toEqual([1536, 10240]);
    const background = [248, 248, 246, 255];
    for (const y of [2047, 2048, 4095, 4096, 6143, 6144, 8191, 8192])
      expect(Array.from(context.getImageData(20, y, 1, 1).data)).toEqual(background);
    const single = await renderBrandDesignPage(doc, "D03", loader);
    const singleContext = await decode(single.pngDataUrl);
    expect(Array.from(context.getImageData(100, 2048 * 2 + 540, 800, 250).data)).toEqual(
      Array.from(singleContext.getImageData(100, 540, 800, 250).data),
    );
    const bundle = await renderBrandDesignBundle(doc, loader);
    expect(bundle.manifest.pages.map((item) => item.pageId)).toEqual([
      "M01",
      "M02",
      "M03",
      "M04",
      "M05",
      "D01",
      "D02",
      "D03",
      "D04",
      "D05",
      "HOME",
      "DETAIL",
    ]);
    const home = bundle.files.find((file) => file.name === "HOME.png")!;
    const homeContext = await decode(`data:image/png;base64,${home.base64}`);
    expect([homeContext.canvas.width, homeContext.canvas.height]).toEqual([2048, 1152]);
    const designJson = bundle.files.find((file) => file.name === "design.json")!;
    expect(atob(designJson.base64)).not.toContain("data:image");
    expect(bundle.files.length).toBe(26);
  }, 30_000);

  it("preserves exact AI identity, warns about changed content, rejects active images and never fakes missing pages", async () => {
    const source = raster();
    const base = editableDocument();
    const doc = {
      ...base,
      logo: undefined,
      slots: base.slots.map((slot, index) =>
        index === 0
          ? {
              ...slot,
              source: {
                path: "ai.png",
                contentHash: "c".repeat(64),
                kind: "generated" as const,
                taskId: "task-stable",
                resultIndex: 2,
                sourceNodeId: "node-8",
              },
              copy: { title: '<script>alert("文案")</script>', body: "完整保留" },
            }
          : { ...slot, source: undefined },
      ),
    } as unknown as BrandDesignDocument;
    const page = await renderBrandDesignPage(doc, "M01", () => Promise.resolve(source), 0.25);
    expect(page.sources[0]).toMatchObject({
      taskId: "task-stable",
      resultIndex: 2,
      sourceNodeId: "node-8",
      changed: true,
      actualContentHash: source.contentHash,
    });
    expect(page.notes.some((note) => note.includes("内容已改变"))).toBe(true);
    expect(
      new DOMParser().parseFromString(page.svg, "image/svg+xml").querySelector("script"),
    ).toBeNull();
    const bundle = await renderBrandDesignBundle(doc, () => Promise.resolve(source));
    expect(bundle.manifest.pages.map((item) => item.pageId)).toEqual(["M01", "HOME"]);
    expect(bundle.notes.some((note) => note.includes("连续详情缺少 D01"))).toBe(true);
    await expect(
      renderBrandDesignPage(doc, "M01", () =>
        Promise.resolve({
          ...source,
          dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        }),
      ),
    ).rejects.toThrow("安全的 PNG");
    await expect(
      renderBrandDesignPage(
        {
          ...doc,
          slots: doc.slots.map((slot) => ({
            ...slot,
            copy: { title: "中文".repeat(500), body: "" },
          })),
        },
        "M01",
        () => Promise.resolve(source),
        0.25,
      ),
    ).rejects.toThrow("文字未被截断");
    await expect(
      renderBrandDesignBundle(
        {
          ...doc,
          slots: doc.slots.map((slot) => ({ ...slot, source: undefined })),
        } as unknown as BrandDesignDocument,
        () => Promise.resolve(source),
      ),
    ).rejects.toThrow("没有可导出的成图");
  });
});
