import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { formatRawBackendError } from "../../lib/backend";
import { exportBrandDesignBundle, readBrandDesignImage } from "../../lib/brandDesignClient";
import {
  brandDesignInputSignature,
  createBrandDesignDocument,
  parseBrandDesignDocument,
  type BrandDesignDocument,
  type BrandDesignSlot,
} from "./brandDesignModel";
import { renderBrandDesignBundle, renderBrandDesignPage } from "./brandDesignRenderer";
import type { JewelryLaunchDraft, JewelryLaunchSlotId } from "./jewelryLaunchPlan";
import "./BrandDesignStudio.css";

export interface BrandDesignCandidate {
  readonly path: string;
  readonly label: string;
  readonly contentHash?: string;
  readonly kind: "source" | "generated";
  readonly taskId?: string;
  readonly resultIndex?: number;
  readonly sourceNodeId?: string;
}

interface BrandDesignStudioProps {
  readonly draft: JewelryLaunchDraft;
  readonly design?: BrandDesignDocument;
  readonly candidates?: readonly BrandDesignCandidate[];
  readonly disabled: boolean;
  readonly onChange: (design: BrandDesignDocument) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onApplyAiStyle?: (style: BrandDesignDocument["preset"], brief: string) => void;
}

export function BrandDesignStudio({
  draft,
  design,
  candidates = [],
  disabled,
  onChange,
  onBusyChange,
  onApplyAiStyle,
}: BrandDesignStudioProps) {
  const [pageId, setPageId] = useState<JewelryLaunchSlotId | "HOME" | "DETAIL">("HOME");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ signature: string; pageId: string; url: string } | null>(
    null,
  );
  const latest = useRef(design);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    latest.current = design;
  }, [design]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const slot = design?.slots.find((item) => item.id === pageId);
  const signature = design ? brandDesignInputSignature(design) : "";
  const sourceChoices = Array.from(
    new Map<string, BrandDesignCandidate>([
      ...draft.slots.flatMap((item) =>
        item.source
          ? [
              [
                item.source.preparedPath,
                {
                  path: item.source.preparedPath,
                  label: item.source.label,
                  contentHash: item.source.contentHash,
                  kind: "source" as const,
                },
              ] as const,
            ]
          : [],
      ),
      ...candidates.map((item) => [item.path, item] as const),
    ]).values(),
  );

  function update(patch: Partial<BrandDesignDocument>, clearLogo = false) {
    const current = latest.current;
    if (!current || disabled || operation.current) return;
    const next = { ...current, ...patch, revision: current.revision + 1 };
    if (clearLogo) delete next.logo;
    const saved = { ...next, inputSignature: brandDesignInputSignature(next) };
    latest.current = saved;
    onChange(saved);
    setNotice(null);
  }

  function updateSlot(patch: Partial<BrandDesignSlot>, clearSource = false) {
    const current = latest.current;
    if (!current || !slot) return;
    update({
      slots: current.slots.map((item) => {
        if (item.id !== slot.id) return item;
        const next = { ...item, ...patch };
        if (clearSource) delete next.source;
        return next;
      }),
    });
  }

  async function work(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(formatRawBackendError(cause));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange?.(false);
    }
  }

  function pickLogo() {
    void work(async () => {
      const path = await open({
        multiple: false,
        title: "选择真实品牌 Logo",
        filters: [{ name: "图片", extensions: ["png", "webp"] }],
      });
      if (typeof path !== "string") return;
      const image = await readBrandDesignImage(path);
      const current = latest.current;
      if (!current || !mounted.current) return;
      const next = {
        ...current,
        logo: { path, contentHash: image.contentHash },
        revision: current.revision + 1,
      };
      const saved = { ...next, inputSignature: brandDesignInputSignature(next) };
      latest.current = saved;
      onChange(saved);
    });
  }

  function importDesign() {
    void work(async () => {
      const path = await open({
        multiple: false,
        title: "打开品牌设计工程",
        filters: [{ name: "设计工程", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const imported = parseBrandDesignDocument(await readTextFile(path));
      if (!mounted.current) return;
      latest.current = imported;
      onChange(imported);
      setPreview(null);
      setNotice("设计工程已打开。源图片按工程中的本地路径读取，可逐图更换。");
    });
  }

  function pickImage() {
    const selectedId = slot?.id;
    if (!selectedId) return;
    void work(async () => {
      const path = await open({
        multiple: false,
        title: "选择原图或已保存的 AI 成图",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof path !== "string") return;
      const image = await readBrandDesignImage(path);
      const current = latest.current;
      if (!current || !mounted.current) return;
      const next = {
        ...current,
        revision: current.revision + 1,
        slots: current.slots.map((item) =>
          item.id === selectedId
            ? {
                ...item,
                source: {
                  path,
                  contentHash: image.contentHash,
                  kind: "source" as const,
                  label: path.split(/[\\/]/).at(-1) ?? path,
                },
              }
            : item,
        ),
      };
      const saved = { ...next, inputSignature: brandDesignInputSignature(next) };
      latest.current = saved;
      onChange(saved);
    });
  }

  function previewPage() {
    if (!design) return;
    const snapshot = design;
    const id = pageId;
    void work(async () => {
      const result = await renderBrandDesignPage(snapshot, id, readBrandDesignImage, 0.3);
      if (!mounted.current) return;
      setPreview({
        signature: brandDesignInputSignature(snapshot),
        pageId: id,
        url: result.pngDataUrl,
      });
      setNotice(
        result.notes.length ? result.notes.join("；") : "预览已更新，商品图片默认完整放置。",
      );
    });
  }

  function exportDesign() {
    if (!design) return;
    const snapshot = design;
    void work(async () => {
      const bundle = await renderBrandDesignBundle(snapshot, readBrandDesignImage);
      const result = await exportBrandDesignBundle(bundle.files, JSON.stringify(bundle.manifest));
      if (!result || !mounted.current) return;
      setNotice(
        `已导出 ${bundle.manifest.pages.length} 个成图页面至 ${result.directory}。PNG、可编辑 SVG 与设计工程已保存。${bundle.notes.filter((note) => note.includes("未导出")).join("；")} 来源及其他处理记录见 manifest.json。`,
      );
    });
  }

  return (
    <details className="brand-design" aria-label="品牌图文设计">
      <summary>品牌图文设计与成图交付</summary>
      <div className="brand-design__body">
        <p>用同一套风格制作商品图、首页主视觉和连续详情。可选原图或已保存的 AI 成图。</p>
        <div className="brand-design__actions">
          <button type="button" disabled={disabled || busy} onClick={importDesign}>
            打开设计工程
          </button>
        </div>
        {!design ? (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => onChange(createBrandDesignDocument(draft))}
          >
            从十图方案建立设计
          </button>
        ) : (
          <>
            {design.sourceDraftSignature !== draft.inputSignature && (
              <p className="brand-design__hint">
                制作单已更新，此设计保留已有修改，可继续编辑和导出。
              </p>
            )}
            <fieldset disabled={disabled || busy} className="brand-design__fields">
              <label>
                品牌名称
                <ImeInput
                  value={design.brandName}
                  onValueChange={(brandName) => update({ brandName })}
                />
              </label>
              <label>
                系列名称
                <ImeInput
                  value={design.seriesTitle}
                  onValueChange={(seriesTitle) => update({ seriesTitle })}
                />
              </label>
              <label>
                视觉风格
                <select
                  value={design.preset}
                  onChange={(event) =>
                    update({ preset: event.target.value as BrandDesignDocument["preset"] })
                  }
                >
                  <option value="editorial">冷白杂志</option>
                  <option value="retro">复古时装</option>
                  <option value="quiet">暖白意境</option>
                </select>
              </label>
              <label>
                系列说明
                <ImeTextarea
                  value={design.seriesDescription}
                  rows={3}
                  onValueChange={(seriesDescription) => update({ seriesDescription })}
                />
              </label>
              <div className="brand-design__actions">
                <button type="button" onClick={pickLogo}>
                  {design.logo ? "更换品牌 Logo" : "添加真实 Logo"}
                </button>
                {design.logo && (
                  <button type="button" onClick={() => update({}, true)}>
                    移除 Logo
                  </button>
                )}
                {onApplyAiStyle && (
                  <button
                    type="button"
                    onClick={() => onApplyAiStyle(design.preset, design.seriesDescription)}
                  >
                    将风格用于 AI 场景图
                  </button>
                )}
              </div>
              <label>
                编辑图位
                <select
                  value={pageId}
                  onChange={(event) => setPageId(event.target.value as typeof pageId)}
                >
                  <option value="HOME">首页主视觉</option>
                  {design.slots.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.title}
                    </option>
                  ))}
                  <option value="DETAIL">连续详情预览</option>
                </select>
              </label>
              {pageId === "HOME" && (
                <>
                  <label>
                    首页标题
                    <ImeInput
                      value={design.homepage.title}
                      onValueChange={(title) => update({ homepage: { ...design.homepage, title } })}
                    />
                  </label>
                  <label>
                    首页说明
                    <ImeTextarea
                      rows={3}
                      value={design.homepage.body}
                      onValueChange={(body) => update({ homepage: { ...design.homepage, body } })}
                    />
                  </label>
                  <label>
                    首页图片图位
                    <select
                      value={design.homepage.heroSlotId}
                      onChange={(event) =>
                        update({
                          homepage: {
                            ...design.homepage,
                            heroSlotId: event.target.value as JewelryLaunchSlotId,
                          },
                        })
                      }
                    >
                      {design.slots.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.id} · {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {slot && (
                <>
                  <label>
                    图位图片
                    <select
                      value={slot.source?.path ?? ""}
                      onChange={(event) => {
                        const selected = sourceChoices.find(
                          (item) => item.path === event.target.value,
                        );
                        updateSlot(selected ? { source: selected } : {}, !selected);
                      }}
                    >
                      <option value="">尚未指定图片</option>
                      {slot.source &&
                        !sourceChoices.some((item) => item.path === slot.source?.path) && (
                          <option value={slot.source.path}>
                            {slot.source.label ?? slot.source.path}
                          </option>
                        )}
                      {sourceChoices.map((item) => (
                        <option key={item.path} value={item.path}>
                          {item.kind === "generated" ? "成图" : "原图"} · {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="brand-design__actions">
                    <button type="button" onClick={pickImage}>
                      导入图位图片
                    </button>
                  </div>
                  {slot.id !== "M05" && (
                    <label>
                      图片放置
                      <select
                        value={slot.fit}
                        onChange={(event) =>
                          updateSlot({ fit: event.target.value as BrandDesignSlot["fit"] })
                        }
                      >
                        <option value="contain">完整放置，保留商品边缘</option>
                        <option value="cover">填满区域，允许裁切</option>
                      </select>
                    </label>
                  )}
                  {slot.source && (
                    <label>
                      图片来源类型
                      <select
                        value={slot.source.kind}
                        onChange={(event) =>
                          updateSlot({
                            source: {
                              ...slot.source!,
                              kind: event.target.value as "source" | "generated",
                            },
                          })
                        }
                      >
                        <option value="source">原始照片</option>
                        <option value="generated">已生成图片</option>
                      </select>
                    </label>
                  )}
                  {slot.fit === "cover" && (
                    <p className="brand-design__hint">填满会裁切画面，请检查商品与必要细节。</p>
                  )}
                  {slot.id !== "M05" && (
                    <label>
                      图上标题
                      <ImeInput
                        value={slot.copy.title}
                        onValueChange={(title) => updateSlot({ copy: { ...slot.copy, title } })}
                      />
                    </label>
                  )}
                  {slot.id !== "M05" && (
                    <label>
                      图上正文
                      <ImeTextarea
                        rows={4}
                        value={slot.copy.body}
                        onValueChange={(body) => updateSlot({ copy: { ...slot.copy, body } })}
                      />
                    </label>
                  )}
                  {slot.id === "M05" && (
                    <p>
                      此图位保持白色版式底板、无文字和
                      Logo。原照片背景仍保留，请核对是否符合实际白底图要求。
                    </p>
                  )}
                </>
              )}
              {pageId === "DETAIL" && (
                <p>连续详情沿用 D01–D05 文案与图片，五个图位都有图片后输出整页。</p>
              )}
            </fieldset>
            <div className="brand-design__actions">
              <button type="button" disabled={busy || disabled} onClick={previewPage}>
                {busy ? "正在处理…" : "更新设计预览"}
              </button>
              <button type="button" disabled={busy} onClick={exportDesign}>
                导出品牌设计成图
              </button>
            </div>
            {preview && (
              <div className="brand-design__preview">
                {(preview.signature !== signature || preview.pageId !== pageId) && (
                  <p className="brand-design__hint">当前显示上次预览，点击更新查看新修改。</p>
                )}
                <img src={preview.url} alt={`${preview.pageId} 品牌设计预览`} />
              </div>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
    </details>
  );
}
