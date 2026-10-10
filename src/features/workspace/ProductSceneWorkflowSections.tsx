import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import {
  formatRawBackendError,
  isDesktopRuntime,
  mediaClient,
  pickPromptMultimodalFiles,
  toMediaSrc,
} from "../../lib/backend";
import { productSceneImageClient, productSceneOutputSize } from "../../lib/productSceneImages";
import { ProductSceneJewelryLaunch } from "./ProductSceneJewelryLaunch";
import type { BrandDesignCandidate } from "./BrandDesignStudio";
import {
  createJewelrySceneOptions,
  canRetryProductSceneRow,
  JEWELRY_REVIEW_CHECKS,
  productSceneGenerationMode,
  productSceneJewelryReviewWarnings,
  productSceneQualityEnabled,
  productSceneRowCanAccept,
  resetProductSceneQuality,
  resetProductSceneRow,
  retryProductSceneRow,
  updateProductSceneViewProtection,
  PRODUCT_SCENE_BRAND_STYLES,
  type ProductSceneRow,
  type ProductSceneJewelryReview,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";
import { ProductSceneProtectionEditor } from "./ProductSceneProtectionEditor";
import { OptionalMark, RequiredMark } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "./ProductSceneWorkflowSections.css";

const ANGLES = {
  front45: "侧前 45°",
  rear30: "接口侧 30°",
  eye: "平视",
  top45: "俯视 45°",
  top90: "正俯视 90°",
} as const;
const STATUS = {
  queued: "待制作",
  running: "制作中",
  needs_review: "待审核",
  accepted: "已选用",
  rejected: "已拒绝",
  error: "失败",
} as const;
const PORT_STATUS = {
  pass: "可见接口通过",
  fail: "不通过",
  uncertain: "无法确定",
  not_visible: "不可见 · 未验证",
} as const;
const QUALITY_STATUS = {
  pending: "待检查",
  passed: "检查完成",
  blocked: "待处理",
  failed: "检查失败",
} as const;
const PRODUCT_SCENE_THUMBNAIL_MAX_DIMENSION = 512;

function jewelryReviewForOutput(row: ProductSceneRow): ProductSceneJewelryReview {
  if (row.jewelryReview?.outputPath === row.outputPath) return row.jewelryReview;
  return {
    outputPath: row.outputPath ?? "",
    checks: {
      connections: "uncertain",
      shape: "uncertain",
      details: "uncertain",
      texture: "uncertain",
      scale: "uncertain",
      style: "uncertain",
    },
    notes: "",
  };
}

function ProductSceneJewelryReviewDetails({
  row,
  options,
  sourcePath,
  disabled,
  onChange,
  onPreview,
}: {
  readonly row: ProductSceneRow;
  readonly options: ProductSceneWorkflowOptions;
  readonly sourcePath: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (review: ProductSceneJewelryReview) => void;
  readonly onPreview: (path: string) => void;
}) {
  if (!row.outputPath) return null;
  const review = jewelryReviewForOutput(row);
  return (
    <section
      className="product-scene__jewelry-review"
      aria-label={`第 ${row.index} 张珠宝人工复核`}
    >
      <strong>对照实拍母版，逐项人工核对</strong>
      {sourcePath ? (
        <button type="button" onClick={() => onPreview(sourcePath)}>
          查看第 {row.index} 张实拍母版对照
        </button>
      ) : null}
      {row.protection ? (
        <small>
          制作时保护核验：{row.protection.verified ? "记录为通过" : "记录为未通过"} · 原片{" "}
          {row.protection.sourceWidth} × {row.protection.sourceHeight} · 核验{" "}
          {row.protection.corePixelCount} 个像素
        </small>
      ) : (
        <small>尚无原片保护核验记录，可以继续选用或导出。</small>
      )}
      <small>
        复核和保护记录供参考，不限制选用或导出。连接、天然特征、佩戴关系及融合边缘可按需要逐项检查。
      </small>
      {productSceneJewelryReviewWarnings(row, options).map((warning, index) => (
        <small key={index}>提示：{warning}</small>
      ))}
      {JEWELRY_REVIEW_CHECKS.map(({ key, label }) => (
        <label key={key}>
          {label}
          <select
            aria-label={`第 ${row.index} 张 ${label}`}
            value={review.checks[key]}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...review,
                checks: {
                  ...review.checks,
                  [key]: event.target.value as "pass" | "fail" | "uncertain",
                },
              })
            }
          >
            <option value="uncertain">待核对 / 无法确定</option>
            <option value="pass">人工核对通过</option>
            <option value="fail">不通过</option>
          </select>
        </label>
      ))}
      <label>
        复核备注
        <ImeTextarea
          aria-label={`第 ${row.index} 张珠宝复核备注`}
          rows={2}
          value={review.notes}
          disabled={disabled}
          onValueChange={(notes) => onChange({ ...review, notes })}
          placeholder="记录对照依据、需要精修的边缘或不通过原因。"
        />
      </label>
    </section>
  );
}

function ProductSceneRowThumbnail({ path, alt }: { readonly path: string; readonly alt: string }) {
  const desktop = isDesktopRuntime();
  const [thumbnail, setThumbnail] = useState<{
    sourcePath: string;
    thumbnailPath: string | null;
    ready: boolean;
  } | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let current = true;
    void mediaClient
      .createThumbnail(path, PRODUCT_SCENE_THUMBNAIL_MAX_DIMENSION)
      .then((result) => {
        if (current)
          setThumbnail({ sourcePath: path, thumbnailPath: result?.path ?? null, ready: true });
      })
      .catch(() => {
        if (current) setThumbnail({ sourcePath: path, thumbnailPath: null, ready: true });
      });
    return () => {
      current = false;
    };
  }, [desktop, path]);
  const matching = thumbnail?.sourcePath === path ? thumbnail : null;
  const src = desktop
    ? matching?.thumbnailPath
      ? toMediaSrc(matching.thumbnailPath)
      : null
    : toMediaSrc(path);
  return src ? (
    <img src={src} alt={alt} loading="lazy" />
  ) : (
    <span className="product-scene__placeholder">
      {matching?.ready ? "预览不可用，点开查看原图" : "正在加载预览"}
    </span>
  );
}

function ProductSceneQualityDetails({
  row,
  options,
}: {
  readonly row: ProductSceneRow;
  readonly options: ProductSceneWorkflowOptions;
}) {
  if (!productSceneQualityEnabled(options)) return null;
  const quality = row.quality;
  const inspection = quality?.inspection;
  return (
    <section className="product-scene__quality-result" aria-label={`第 ${row.index} 张自动检查`}>
      <strong>自动检查：{quality ? QUALITY_STATUS[quality.status] : "待检查"}</strong>
      {quality ? <small>第 {quality.attempt + 1} 次检查</small> : null}
      {options.quality?.inspectPorts && inspection ? (
        <>
          <span>接口：{PORT_STATUS[inspection.ports.status]}</span>
          {inspection.ports.status === "not_visible" ? (
            <small>该机位未展示接口，不能据此判断全部接口正确。</small>
          ) : null}
          <details>
            <summary>接口检查证据</summary>
            <p>{inspection.ports.evidence}</p>
            {inspection.ports.items.map((item, index) => (
              <p key={index}>
                {item.name} · {PORT_STATUS[item.status]}
                <br />
                预期：{item.expected}
                <br />
                观察：{item.observed}
              </p>
            ))}
          </details>
        </>
      ) : null}
      {options.quality?.logo && inspection ? (
        <>
          <span>
            Logo：
            {inspection.logo.status === "not_visible"
              ? "本机位不可见 · 未贴回"
              : inspection.logo.status === "uncertain"
                ? "定位不确定 · 待处理"
                : quality?.status === "passed"
                  ? "已按透视贴回"
                  : "尚未完成贴回"}
          </span>
          <small>
            模型自评定位置信度 {Math.round(inspection.logo.confidence * 100)}%（不代表实际正确率）
          </small>
          <details>
            <summary>Logo 定位证据</summary>
            <p>{inspection.logo.evidence}</p>
          </details>
        </>
      ) : null}
      {quality?.error ? <p role="alert">{quality.error}</p> : null}
      <small>可重新检查当前基图；不会重新生成图片。</small>
    </section>
  );
}

function ProductSceneImagePreview({
  path,
  onClose,
}: {
  readonly path: string;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="product-scene__lightbox"
      role="dialog"
      aria-label="产品场景图预览"
      aria-modal="true"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button ref={closeRef} type="button" onClick={onClose}>
        关闭预览
      </button>
      <img src={toMediaSrc(path)} alt="产品原图或场景图完整预览" />
    </div>,
    document.body,
  );
}

export function ProductSceneConfiguration({
  options,
  disabled,
  planningDisabled = disabled,
  onChange,
  onBusyChange,
  designCandidates,
}: {
  readonly options: ProductSceneWorkflowOptions;
  readonly disabled: boolean;
  readonly planningDisabled?: boolean;
  readonly onChange: (options: ProductSceneWorkflowOptions) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly designCandidates?: readonly BrandDesignCandidate[];
}) {
  const [busy, setBusy] = useState(false);
  const generationMode = productSceneGenerationMode(options);
  const preserveReference =
    generationMode === "protected" ||
    (generationMode === "reference" && Boolean(options.brandCreative));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [editingProtection, setEditingProtection] = useState<string | null>(null);
  const picking = useRef(false);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  }, [options]);

  async function pickProducts() {
    if (disabled || picking.current) return;
    picking.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const files = await pickPromptMultimodalFiles({
        title: preserveReference
          ? "选择这件实物的完整摆拍或真实佩戴原片"
          : "选择同一版本产品的白底或透明原图",
        kinds: ["image"],
      });
      const added: ProductSceneWorkflowOptions["views"][number][] = [];
      for (const file of files) {
        if (file.kind !== "image") continue;
        const prepared = await productSceneImageClient.prepare({
          sourcePath: file.localPath,
          ...(preserveReference ? { preservePhoto: true } : {}),
        });
        if (
          [...latest.current.views, ...added].some(
            (view) => view.contentHash === prepared.contentHash,
          )
        )
          continue;
        added.push({
          id: crypto.randomUUID(),
          label: file.displayName,
          angle: "front45",
          sourcePath: file.localPath,
          preparedPath: prepared.path,
          contentHash: prepared.contentHash,
          width: prepared.width,
          height: prepared.height,
          approved: false,
          ...(generationMode === "protected"
            ? {
                protection: {
                  rect: { x: 0, y: 0, width: 1, height: 1 },
                  feather: 0.025,
                  use: "product" as const,
                },
              }
            : {}),
        });
      }
      if (added.length) onChange({ ...latest.current, views: [...latest.current.views, ...added] });
    } catch (failure) {
      setError(formatRawBackendError(failure));
    } finally {
      picking.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function restoreBrandReference(view: ProductSceneWorkflowOptions["views"][number]) {
    if (disabled || picking.current || generationMode !== "reference" || !options.brandCreative)
      return;
    picking.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const prepared = await productSceneImageClient.prepare({
        sourcePath: view.sourcePath,
        preservePhoto: true,
      });
      const current = latest.current;
      if (productSceneGenerationMode(current) !== "reference" || !current.brandCreative) return;
      onChange({
        ...current,
        views: current.views.map((item) =>
          item.id === view.id && item.sourcePath === view.sourcePath
            ? {
                ...item,
                preparedPath: prepared.path,
                contentHash: prepared.contentHash,
                width: prepared.width,
                height: prepared.height,
                approved: false,
              }
            : item,
        ),
      });
    } catch (failure) {
      setError(formatRawBackendError(failure));
    } finally {
      picking.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function pickLogo() {
    if (disabled || picking.current || generationMode !== "reference") return;
    picking.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const files = await pickPromptMultimodalFiles({
        title: "选择需要原样贴回的透明 PNG Logo",
        kinds: ["image"],
      });
      const file = files[0];
      if (!file) return;
      const prepared = await productSceneImageClient.prepareLogo({ sourcePath: file.localPath });
      const current = latest.current;
      onChange({
        ...current,
        quality: {
          inspectPorts: false,
          portSpecification: "",
          ...current.quality,
          logo: { ...prepared, approved: false },
        },
      });
    } catch (failure) {
      setError(formatRawBackendError(failure));
    } finally {
      picking.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  const configuration = (
    <fieldset className="product-scene__configuration" disabled={disabled || busy}>
      {/* 缺口清单由节点 footer 统一渲染（idle 状态始终可见、就在「查看执行计划」旁）。
          这里再放一份会在同一张卡片上出现两条一模一样的清单。 */}
      <label>
        <RequiredMark>产品名称</RequiredMark>
        <ImeInput
          aria-label="产品名称"
          value={options.productName}
          onValueChange={(productName) => onChange({ ...options, productName })}
        />
      </label>
      <label>
        <OptionalMark>生成方式</OptionalMark>
        <select
          aria-label="产品场景生成方式"
          value={generationMode}
          onChange={(event) => {
            const nextMode = event.target.value as "reference" | "composite" | "protected";
            setEditingProtection(null);
            setError(null);
            const normalOptions = { ...options };
            // Keep the editable brand project when changing generation modes.
            // Source preparation for the next paid operation remains explicit.
            onChange(
              nextMode === "protected"
                ? createJewelrySceneOptions(options)
                : {
                    ...normalOptions,
                    generationMode: nextMode,
                    ...(generationMode === "protected" ? { views: [] } : {}),
                  },
            );
          }}
        >
          <option value="reference">AI 多机位</option>
          <option value="composite">原图保真合成</option>
          <option value="protected">珠宝原片保护</option>
        </select>
      </label>
      <p>
        {generationMode === "reference"
          ? options.brandCreative
            ? "用同款商品与真实佩戴照片制作品牌摄影，按选定风格组合构图、灯光与场景。AI 可以生成新姿势与画面，实际商品结构、佩戴比例和人物一致性仍需逐张核对。"
            : "用已确认的同一产品图片作为参考，工作流随机组合目标机位和场景，交给图片模型生成完整画面。新机位可以由提示词引导，无需先补拍或提供 CAD；产品形体、接口与 Logo 必须逐张审核。"
          : generationMode === "protected"
            ? "保留获批实拍母版的完整范围，AI 制作外围场景。透明珠子相关原背景和真实佩戴关系一并保留；适合忠实展示同一件实物，不产生新的商品角度或佩戴姿势。"
            : "AI 生成空场景，已确认产品原图在本地合成，保留原图的产品结构。此模式仅使用原图已有角度。"}
      </p>
      <label>
        <OptionalMark>AI 品牌摄影风格</OptionalMark>
        <select
          aria-label="AI 品牌摄影风格"
          value={options.brandCreative?.style ?? ""}
          onChange={(event) => {
            const next = { ...options };
            const style = event.target.value;
            if (!style) delete next.brandCreative;
            else
              next.brandCreative = {
                style: style as NonNullable<ProductSceneWorkflowOptions["brandCreative"]>["style"],
                brief: options.brandCreative?.brief ?? "",
              };
            onChange(next);
          }}
        >
          <option value="">沿用现有产品场景</option>
          {PRODUCT_SCENE_BRAND_STYLES.map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </select>
      </label>
      {options.brandCreative && (
        <label>
          <OptionalMark>品牌画面要求</OptionalMark>
          <ImeTextarea
            rows={3}
            value={options.brandCreative.brief}
            placeholder="例如：黑衣与冷白背景，大面积留白，金属高光克制，保留实际商品结构。"
            onValueChange={(brief) =>
              onChange({ ...options, brandCreative: { ...options.brandCreative!, brief } })
            }
          />
          <span>参考图使用本款真实商品或真实佩戴照片；品牌风格变化后需重新确认生成计划。</span>
        </label>
      )}
      {generationMode === "protected" && options.jewelry ? (
        <section className="product-scene__jewelry-settings" aria-label="珠宝实物与系列模板">
          <strong>实物身份与系列模板</strong>
          <label>
            <RequiredMark>商品 SKU</RequiredMark>
            <ImeInput
              aria-label="珠宝商品 SKU"
              value={options.jewelry.skuId}
              onValueChange={(skuId) =>
                onChange({ ...options, jewelry: { ...options.jewelry!, skuId } })
              }
            />
          </label>
          <label>
            <RequiredMark>单件实物编号 / 天然纹理身份</RequiredMark>
            <ImeInput
              aria-label="单件实物编号"
              value={options.jewelry.specimenId}
              onValueChange={(specimenId) =>
                onChange({ ...options, jewelry: { ...options.jewelry!, specimenId } })
              }
            />
            <small>同 SKU 的不同手串也需分别记录，不能共用天然纹理、棉絮或包裹物身份。</small>
          </label>
          <label>
            <RequiredMark>必须保留的关键特征</RequiredMark>
            <ImeTextarea
              aria-label="珠宝关键特征"
              rows={3}
              value={options.jewelry.criticalFeatures}
              onValueChange={(criticalFeatures) =>
                onChange({ ...options, jewelry: { ...options.jewelry!, criticalFeatures } })
              }
              placeholder="例如珠子数量与顺序、爱心珠朝向、异形主珠轮廓、棉絮与包裹物位置。"
            />
          </label>
          {(
            [
              ["name", "系列模板名称"],
              ["version", "系列模板版本"],
              ["background", "系列背景要求"],
              ["lighting", "系列光照要求"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {/* 系列模板自带推荐默认值，改不改都能出图，所以标“可选”而不是必填。 */}
              <OptionalMark>{label}</OptionalMark>
              <ImeInput
                aria-label={label}
                value={options.jewelry!.seriesStyle[key]}
                onValueChange={(value) =>
                  onChange({
                    ...options,
                    jewelry: {
                      ...options.jewelry!,
                      seriesStyle: { ...options.jewelry!.seriesStyle, [key]: value },
                    },
                  })
                }
              />
            </label>
          ))}
          <small>
            以上字段用于场景制作；十图方案可在资料未齐时先生成。构图与原片占比在同一系列内固定；修改实物、母版、范围或模板后需重新审批制作计划。
          </small>
        </section>
      ) : null}
      <button type="button" onClick={() => void pickProducts()}>
        {busy
          ? "正在处理产品图…"
          : preserveReference
            ? "添加完整实拍 / 佩戴原片"
            : "添加白底 / 透明产品原图"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <div className="product-scene__views">
        {options.views.map((view) => (
          <article key={view.id} className="product-scene__view">
            <button
              type="button"
              className="product-scene__preview"
              onClick={() => setPreview(view.preparedPath)}
              aria-label={`放大产品原图 ${view.label}`}
            >
              <img
                src={toMediaSrc(view.preparedPath)}
                alt={`${view.label} ${generationMode === "protected" ? "完整实拍原片" : options.brandCreative && generationMode === "reference" ? "品牌摄影参考预览" : "抠图预览"}`}
                loading="lazy"
              />
            </button>
            <strong>{view.label}</strong>
            {generationMode === "reference" && options.brandCreative && (
              <button type="button" onClick={() => void restoreBrandReference(view)}>
                重新准备 {view.label} 完整原片
              </button>
            )}
            {view.width && view.height ? (
              <small>
                {view.width} × {view.height}
                {view.width <
                productSceneOutputSize(options.aspectRatio).width * (options.productScale ?? 0.48)
                  ? generationMode === "reference"
                    ? options.brandCreative
                      ? " · 参考图细节较少，请核对商品细节与佩戴比例"
                      : " · 参考图细节较少，请仔细审核生成的接口与文字"
                    : " · 本次合成可能放大，建议换用更高清原图"
                  : ""}
              </small>
            ) : null}
            {generationMode !== "protected" ? (
              <label>
                <OptionalMark>
                  {generationMode === "reference" ? "参考图原始角度（与目标机位独立）" : "原图角度"}
                </OptionalMark>
                <select
                  aria-label={`${view.label} 原图角度`}
                  value={view.angle}
                  onChange={(event) =>
                    onChange({
                      ...options,
                      views: options.views.map((item) =>
                        item.id === view.id
                          ? {
                              ...item,
                              angle: event.target.value as typeof view.angle,
                              approved: false,
                            }
                          : item,
                      ),
                    })
                  }
                >
                  {Object.entries(ANGLES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {generationMode === "protected" || options.brandCreative ? (
              <label>
                <OptionalMark>照片用途</OptionalMark>
                <select
                  aria-label={`${view.label} 照片用途`}
                  value={view.photoRole ?? ""}
                  onChange={(event) => {
                    const photoRole = event.target.value;
                    onChange({
                      ...options,
                      views: options.views.map((item) => {
                        if (item.id !== view.id) return item;
                        const next = { ...item };
                        if (
                          photoRole === "full" ||
                          photoRole === "detail" ||
                          photoRole === "wearing"
                        )
                          next.photoRole = photoRole;
                        else delete next.photoRole;
                        return next;
                      }),
                    });
                  }}
                >
                  <option value="">未标注 · 方案暂定分配</option>
                  <option value="full">商品全貌</option>
                  <option value="detail">局部细节</option>
                  <option value="wearing">真实佩戴</option>
                </select>
              </label>
            ) : null}
            {generationMode === "protected" ? (
              <>
                <small>
                  {view.protection?.use === "wearing"
                    ? "真实佩戴母版 · 保留手腕与遮挡"
                    : "商品摆拍母版 · 保留阴影与透射背景"}
                  {view.protection
                    ? ` · 保护 ${Math.round(view.protection.rect.width * 100)}% × ${Math.round(view.protection.rect.height * 100)}% 原片`
                    : " · 尚未设置保护范围"}
                </small>
                {editingProtection === view.id ? (
                  <ProductSceneProtectionEditor
                    view={view}
                    onSave={(protection) => {
                      onChange({
                        ...options,
                        views: options.views.map((item) =>
                          item.id === view.id
                            ? updateProductSceneViewProtection(item, protection)
                            : item,
                        ),
                      });
                      setEditingProtection(null);
                    }}
                    onCancel={() => setEditingProtection(null)}
                  />
                ) : (
                  <button type="button" onClick={() => setEditingProtection(view.id)}>
                    编辑 {view.label} 保护范围
                  </button>
                )}
              </>
            ) : null}
            <label className="product-scene__approval">
              <input
                type="checkbox"
                checked={view.approved}
                onChange={(event) =>
                  onChange({
                    ...options,
                    views: options.views.map((item) =>
                      item.id === view.id ? { ...item, approved: event.target.checked } : item,
                    ),
                  })
                }
              />
              {/* 勾选确认是付费制作前的硬门槛，因此同样标必填：不标会被当成可选。 */}
              <RequiredMark>
                {generationMode === "protected"
                  ? "确认这件实物与母版一致，保护范围含完整商品、阴影、透射原背景及必要手腕"
                  : "确认同一产品版本，原始角度标注正确，边缘 / Logo / 接口完整"}
              </RequiredMark>
            </label>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...options,
                  views: options.views.filter((item) => item.id !== view.id),
                })
              }
            >
              移除 {view.label}
            </button>
          </article>
        ))}
      </div>
      <small>
        {generationMode === "protected"
          ? "原片完整保留，不做白底阈值抠图。先放大核对实物身份与保护边界，默认整张原片；需要制作外围时再缩小范围并重新确认。透明珠子透过的原背景不会自动换成新背景。"
          : preserveReference
            ? "本模式新添加的照片完整保留，不做白底阈值抠图。请标注商品全貌、局部细节或真实佩戴；切换风格前已处理的旧图可点击“重新准备完整原片”，然后重新确认。"
            : "请先放大核对透明区域、金色格栅及脚垫是否被误删。参考图原始角度用于识别产品；AI 多机位模式的拍摄角度由制作计划另行安排。"}
      </small>
      <div className="product-scene__settings">
        <label>
          <OptionalMark>总计划张数</OptionalMark>
          <input
            aria-label="总计划张数"
            type="number"
            min={1}
            max={500}
            value={options.totalCount}
            onChange={(event) =>
              onChange({
                ...options,
                totalCount: Math.min(500, Math.max(1, Number(event.target.value) || 1)),
              })
            }
          />
        </label>
        <label>
          <OptionalMark>同时生成张数上限</OptionalMark>
          <input
            aria-label="同时生成张数上限"
            type="number"
            min={1}
            max={50}
            value={options.maxConcurrency ?? 10}
            onChange={(event) =>
              onChange({
                ...options,
                maxConcurrency: Math.min(50, Math.max(1, Number(event.target.value) || 1)),
              })
            }
          />
          <small>
            一键审批后同时提交最多 {options.maxConcurrency ?? 10} 张；受模型服务的并发额度限制。
          </small>
        </label>
        {generationMode !== "protected" && !options.brandCreative ? (
          <label>
            <OptionalMark>场景倾向</OptionalMark>
            <select
              aria-label="场景倾向"
              value={options.sceneBias}
              onChange={(event) =>
                onChange({
                  ...options,
                  sceneBias: event.target.value as ProductSceneWorkflowOptions["sceneBias"],
                })
              }
            >
              <option value="mixed">均衡混合</option>
              <option value="geek">桌面极客</option>
              <option value="office">企业办公</option>
              <option value="unboxing">开箱摆放</option>
            </select>
          </label>
        ) : null}
        <label>
          <OptionalMark>图片比例</OptionalMark>
          <select
            aria-label="产品场景图片比例"
            value={options.aspectRatio}
            onChange={(event) =>
              onChange({
                ...options,
                aspectRatio: event.target.value as ProductSceneWorkflowOptions["aspectRatio"],
              })
            }
          >
            <option value="1:1">1:1 · 2048 × 2048</option>
            <option value="3:4">3:4 · 1536 × 2048</option>
            <option value="9:16">9:16 · 1152 × 2048</option>
          </select>
        </label>
        <label>
          <OptionalMark>
            {generationMode === "protected" ? "完整原片画面占比" : "产品画面占比"}
          </OptionalMark>
          <input
            aria-label={generationMode === "protected" ? "完整原片画面占比" : "产品画面占比"}
            type="range"
            min={0.3}
            max={0.65}
            step={0.01}
            value={options.productScale ?? 0.48}
            onChange={(event) => onChange({ ...options, productScale: Number(event.target.value) })}
          />
          <small>
            {Math.round((options.productScale ?? 0.48) * 100)}% ·{" "}
            {generationMode === "protected"
              ? "完整原片宽度占画面宽度，保持片内佩戴关系；不是毫米尺寸标定"
              : "产品宽度占画面宽度"}
          </small>
        </label>
        {generationMode !== "protected" ? (
          <label>
            <OptionalMark>背景景深</OptionalMark>
            <input
              aria-label="背景景深"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={options.depthStrength}
              onChange={(event) =>
                onChange({ ...options, depthStrength: Number(event.target.value) })
              }
            />
            <small>
              {Math.round(options.depthStrength * 100)}% ·{" "}
              {generationMode === "reference"
                ? "通过拍摄提示词控制景深"
                : "调整背景虚化，产品保持清晰"}
            </small>
          </label>
        ) : null}
        {generationMode !== "protected" ? (
          <label>
            <OptionalMark>场景种子</OptionalMark>
            <input
              aria-label="场景种子"
              type="number"
              min={0}
              step={1}
              value={options.seed}
              onChange={(event) =>
                onChange({
                  ...options,
                  seed: Math.max(0, Math.floor(Number(event.target.value) || 0)),
                })
              }
            />
          </label>
        ) : null}
      </div>
      {generationMode !== "protected" ? (
        <small>
          {options.brandCreative
            ? "品牌摄影风格用于 AI 展示图，成图需核对商品细节与佩戴关系。"
            : "手机随拍风格为 AI 展示图。"}
          导出清单会标明生成方式；不写入虚假的手机拍摄信息或买家身份。
        </small>
      ) : (
        <small>
          导出清单记录这件实物、母版、保护范围、模板版本与人工复核；生成背景不会冒充实拍或买家反馈。
        </small>
      )}
      {generationMode !== "protected" ? (
        <section className="product-scene__quality-settings" aria-label="产品自动检查与 Logo 贴回">
          <strong>自动检查与 Logo 贴回</strong>
          <label className="product-scene__approval">
            <input
              type="checkbox"
              checked={options.quality?.inspectPorts ?? false}
              onChange={(event) =>
                onChange({
                  ...options,
                  quality: {
                    portSpecification: "",
                    ...options.quality,
                    inspectPorts: event.target.checked,
                  },
                })
              }
            />
            <OptionalMark>自动检测可见接口</OptionalMark>
          </label>
          {options.quality?.inspectPorts ? (
            <label>
              <OptionalMark>已确认接口规格</OptionalMark>
              <ImeTextarea
                aria-label="已确认接口规格"
                rows={3}
                value={options.quality.portSpecification}
                onValueChange={(portSpecification) =>
                  onChange({
                    ...options,
                    quality: { inspectPorts: true, ...options.quality, portSpecification },
                  })
                }
                placeholder="只填写你已确认的接口类型、数量、排列和位置；留空时依据产品参考图检查可见部分。"
              />
              <small>接口面未出现在图片中会标记“不可见”，不会视为全部接口已通过验证。</small>
            </label>
          ) : null}
          <button
            type="button"
            disabled={generationMode !== "reference"}
            onClick={() => void pickLogo()}
          >
            上传透明 PNG Logo 原样贴回
          </button>
          <small>
            {generationMode === "reference"
              ? "仅在模型高置信定位到 Logo 所在平面时，按透视贴回已确认 Logo；定位不确定时保留待处理状态。"
              : "原图保真合成保留产品原图上的 Logo，不添加额外 Logo。"}
          </small>
          {options.quality?.logo ? (
            <div className="product-scene__logo">
              <button
                type="button"
                className="product-scene__preview"
                onClick={() => setPreview(options.quality!.logo!.path)}
                aria-label="放大源 Logo"
              >
                <img
                  src={toMediaSrc(options.quality.logo.path)}
                  alt="待贴回的源 Logo"
                  loading="lazy"
                />
              </button>
              <small>
                {options.quality.logo.width} × {options.quality.logo.height} ·
                此透明图用于原样贴回，不由图片模型重新绘制。
              </small>
              <label className="product-scene__approval">
                <input
                  type="checkbox"
                  checked={options.quality.logo.approved}
                  onChange={(event) => {
                    const quality = options.quality;
                    if (quality?.logo)
                      onChange({
                        ...options,
                        quality: {
                          ...quality,
                          logo: { ...quality.logo, approved: event.target.checked },
                        },
                      });
                  }}
                />
                <RequiredMark>确认此 Logo 内容与透明边缘正确</RequiredMark>
              </label>
              <button
                type="button"
                onClick={() => {
                  const quality = { ...options.quality! };
                  delete quality.logo;
                  onChange({ ...options, quality });
                }}
              >
                移除 Logo 贴回
              </button>
              {generationMode !== "reference" ? (
                <p role="alert">请移除此额外 Logo，或切换到 AI 多机位模式。</p>
              ) : null}
            </div>
          ) : null}
          {productSceneQualityEnabled(options) ? (
            <small>
              启用后需要选择可看图的项目文本模型，每张会额外执行视觉检查；仍需你选用后才会导出。
            </small>
          ) : null}
        </section>
      ) : null}
      {preview ? (
        <ProductSceneImagePreview path={preview} onClose={() => setPreview(null)} />
      ) : null}
    </fieldset>
  );
  return (
    <>
      {configuration}
      {options.jewelry ? (
        <ProductSceneJewelryLaunch
          options={options}
          disabled={planningDisabled || busy}
          onChange={onChange}
          onBusyChange={onBusyChange}
          {...(designCandidates ? { designCandidates } : {})}
        />
      ) : options.brandCreative ? (
        <button
          type="button"
          disabled={planningDisabled || busy}
          onClick={() => {
            const jewelry = createJewelrySceneOptions(options).jewelry;
            if (jewelry) onChange({ ...options, jewelry });
          }}
        >
          建立品牌图文制作单
        </button>
      ) : null}
    </>
  );
}

export function ProductSceneDeliverables({
  options,
  checkpoint,
  disabled,
  onChange,
  onContinue,
}: {
  readonly options: ProductSceneWorkflowOptions;
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly disabled: boolean;
  readonly onChange: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => void;
  readonly onContinue: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "needs_review" | "accepted" | "rejected" | "error">(
    "all",
  );
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const exportPending = useRef(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const state = checkpoint.productScene;
  const selectionScope = JSON.stringify([
    checkpoint.runId,
    state?.inputSignature,
    state?.approvedThrough,
  ]);
  const [selection, setSelection] = useState<{ scope: string; ids: readonly string[] }>({
    scope: selectionScope,
    ids: [],
  });
  const selectedIds = selection.scope === selectionScope ? selection.ids : [];
  function setSelectedIds(
    next: readonly string[] | ((current: readonly string[]) => readonly string[]),
  ) {
    setSelection((current) => {
      const ids = current.scope === selectionScope ? current.ids : [];
      return {
        scope: selectionScope,
        ids: typeof next === "function" ? next(ids) : next,
      };
    });
  }
  const generationMode = productSceneGenerationMode(options);
  // 全量行过滤都走 useMemo：跑批期间检查点以秒级频率更新 500 行计划，
  // 未变化的行引用不变，配合 productSceneRowCanAccept 的按行缓存几乎零成本。
  const rows = state?.rows;
  const approvedThrough = state?.approvedThrough ?? 0;
  const accepted = useMemo(
    () =>
      (rows ?? []).filter(
        (row) => row.status === "accepted" && productSceneRowCanAccept(row, options),
      ),
    [rows, options],
  );
  const generated = useMemo(() => (rows ?? []).filter((row) => Boolean(row.outputPath)), [rows]);
  const filtered = useMemo(
    () => (rows ?? []).filter((row) => filter === "all" || row.status === filter),
    [rows, filter],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * 12, (safePage + 1) * 12);
  // 一键全量审批后不再有批次窗口：选用范围覆盖整个计划。
  const pendingReview = useMemo(
    () => (rows ?? []).filter((row) => row.status !== "accepted" && row.status !== "rejected"),
    [rows],
  );
  const eligible = useMemo(
    () =>
      pendingReview.filter(
        (row) => row.status === "needs_review" && productSceneRowCanAccept(row, options),
      ),
    [pendingReview, options],
  );
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const visibleEligibleIds = visible.filter((row) => eligibleIds.has(row.id)).map((row) => row.id);
  const selectedVisibleIds = visibleEligibleIds.filter((id) => selectedIds.includes(id));
  const hasNext = approvedThrough < (rows?.length ?? 0);
  const canNext = !disabled && hasNext;
  if (!state?.rows.length) return null;

  function saveReviewedRows(rows: readonly ProductSceneRow[]) {
    if (!state) return;
    const complete = rows.every(
      (row) =>
        (row.status === "accepted" && productSceneRowCanAccept(row, options)) ||
        row.status === "rejected",
    );
    onChange({
      ...checkpoint,
      productScene: { ...state, rows },
      ...(complete ? { phase: "done", decision: null } : {}),
    });
  }

  function review(id: string, status: "accepted" | "rejected") {
    if (!state || disabled) return;
    const selected = state.rows.find((row) => row.id === id);
    if (status === "accepted" && (!selected || !productSceneRowCanAccept(selected, options)))
      return;
    const rows = state.rows.map((row) => (row.id === id ? { ...row, status } : row));
    setSelectedIds((current) => current.filter((selectedId) => selectedId !== id));
    saveReviewedRows(rows);
  }

  function updateJewelryReview(id: string, jewelryReview: ProductSceneJewelryReview) {
    if (!state || disabled) return;
    const row = state.rows.find((entry) => entry.id === id);
    if (!row?.outputPath || jewelryReview.outputPath !== row.outputPath) return;
    onChange({
      ...checkpoint,
      productScene: {
        ...state,
        rows: state.rows.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                jewelryReview,
              }
            : entry,
        ),
      },
    });
  }

  function acceptRows(ids: readonly string[]) {
    if (!state || disabled || !ids.length) return;
    const requested = new Set(ids);
    let changed = false;
    const rows = state.rows.map((row) => {
      if (
        !requested.has(row.id) ||
        row.status !== "needs_review" ||
        !productSceneRowCanAccept(row, options)
      )
        return row;
      changed = true;
      return { ...row, status: "accepted" as const };
    });
    if (!changed) return;
    setSelectedIds([]);
    saveReviewedRows(rows);
  }

  function approveAll() {
    if (!state || !canNext) return;
    onChange({
      ...checkpoint,
      phase: "paused",
      decision: null,
      productScene: {
        ...state,
        approvedThrough: state.rows.length,
        batchReviewPending: false,
      },
    });
    onContinue();
  }

  function redo(id: string) {
    if (!state || disabled) return;
    onChange({
      ...checkpoint,
      phase: "paused",
      decision: null,
      error: null,
      productScene: resetProductSceneRow(state, id),
    });
    onContinue();
  }

  function recheck(id: string) {
    if (!state || disabled || !productSceneQualityEnabled(options)) return;
    onChange({
      ...checkpoint,
      phase: "paused",
      decision: null,
      error: null,
      productScene: resetProductSceneQuality(state, id),
    });
    onContinue();
  }

  function retry(id: string) {
    if (!state || disabled) return;
    const row = state.rows.find((value) => value.id === id);
    if (!row || !canRetryProductSceneRow(row)) return;
    const next = retryProductSceneRow(state, id);
    if (next === state) return;
    onChange({
      ...checkpoint,
      phase: "paused",
      decision: null,
      error: null,
      productScene: next,
    });
    onContinue();
  }

  async function exportImages(deliveryRows: readonly ProductSceneRow[], allOutputs = false) {
    if (!deliveryRows.length || exportPending.current || disabled) return;
    exportPending.current = true;
    setExporting(true);
    setMessage("");
    try {
      const result = await productSceneImageClient.export({
        paths: deliveryRows.map((row) => row.outputPath!),
        manifest: JSON.stringify(
          {
            schemaVersion: "product-scene-delivery.v1",
            generationMode,
            provenance:
              generationMode === "reference"
                ? "基于用户确认产品参考图，由 AI 生成不同机位与场景的展示图"
                : generationMode === "protected"
                  ? "实拍母版保护范围与 AI 外围场景本地合成；审核及保护记录供参考，文件变更提示不阻止导出"
                  : "AI 生成场景与用户确认产品原图的本地合成展示图",
            productName: options.productName,
            aspectRatio: options.aspectRatio,
            seed: options.seed,
            views: options.views,
            quality: options.quality ?? null,
            jewelry: options.jewelry ?? null,
            exportScope: allOutputs ? "all_outputs" : "accepted",
            rows: deliveryRows.map((row) =>
              generationMode === "protected"
                ? { ...row, reviewWarnings: productSceneJewelryReviewWarnings(row, options) }
                : row,
            ),
          },
          null,
          2,
        ),
      });
      if (result)
        setMessage(
          `已导出 ${result.count} 张${allOutputs ? "成图" : "选用图片"}：${result.directory}`,
        );
    } catch (error) {
      setMessage(`导出失败：${formatRawBackendError(error)}`);
    } finally {
      exportPending.current = false;
      setExporting(false);
    }
  }

  return (
    <section className="product-scene__deliverables" aria-label="产品场景图审核">
      <strong>
        计划 {state.rows.length} 张 · 已选用 {accepted.length} 张 · 本轮已批准{" "}
        {state.approvedThrough} 张
      </strong>
      <p>
        {generationMode === "reference"
          ? "请逐张核对产品形体、接口数量与排列、Logo 文字，以及目标机位是否真正落实，再检查背景逻辑、透视和阴影。"
          : generationMode === "protected"
            ? "可以直接选用或导出成图。六项人工复核、旧审核及源片或成图变更只作提示；需要时可对照实拍母版检查。"
            : "请逐张核对背景合理性、产品比例、透视、落地阴影和边缘。"}
        {generationMode === "protected"
          ? "可导出已选用图片或全部已有成图，清单保留原有审核状态和来源记录。"
          : "相似度检查只能辅助去重；选用后才进入导出包。"}
      </p>
      <div className="product-scene__actions">
        <button type="button" disabled={!canNext} onClick={approveAll}>
          {state.approvedThrough === 0
            ? `一键审批全部 ${state.rows.length} 张并生成`
            : `一键审批剩余 ${state.rows.length - state.approvedThrough} 张并生成`}
        </button>
        <button
          type="button"
          disabled={disabled || exporting || !accepted.length}
          onClick={() => void exportImages(accepted)}
        >
          {exporting ? "正在导出…" : `导出已选用 ${accepted.length} 张`}
        </button>
        {generationMode === "protected" ? (
          <button
            type="button"
            disabled={disabled || exporting || !generated.length}
            onClick={() => void exportImages(generated, true)}
          >
            导出全部成图 {generated.length} 张
          </button>
        ) : null}
      </div>
      {message ? <p role="status">{message}</p> : null}
      {state.approvedThrough > 0 ? (
        <div className="product-scene__bulk-review" aria-label="批量选用产品场景图">
          <small>
            全部计划：可选用 {eligible.length} 张
            {pendingReview.length > eligible.length
              ? `，另有 ${pendingReview.length - eligible.length} 张尚不符合选用条件，需逐张处理`
              : ""}
            。请先检查画面；批量选用只处理待审核且符合当前选用条件的图片。
          </small>
          <div className="product-scene__actions">
            <button
              type="button"
              disabled={disabled || !eligible.length}
              onClick={() => acceptRows(eligible.map((row) => row.id))}
            >
              {generationMode === "protected" ? "一键选用全部成图" : "一键选用全部合格图"}（
              {eligible.length} 张）
            </button>
            <button
              type="button"
              disabled={disabled || !visibleEligibleIds.length}
              onClick={() =>
                setSelectedIds(
                  selectedVisibleIds.length === visibleEligibleIds.length ? [] : visibleEligibleIds,
                )
              }
            >
              {selectedVisibleIds.length === visibleEligibleIds.length && visibleEligibleIds.length
                ? "取消本页选择"
                : `选择本页${generationMode === "protected" ? "成图" : "合格图"}（${visibleEligibleIds.length} 张）`}
            </button>
            <button
              type="button"
              disabled={disabled || !selectedVisibleIds.length}
              onClick={() => acceptRows(selectedVisibleIds)}
            >
              选用所选 {selectedVisibleIds.length} 张
            </button>
          </div>
        </div>
      ) : null}
      <label>
        筛选图片
        <select
          aria-label="筛选产品场景图"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as typeof filter);
            setPage(0);
            setSelectedIds([]);
          }}
        >
          <option value="all">全部计划</option>
          <option value="needs_review">待审核</option>
          <option value="accepted">已选用</option>
          <option value="rejected">已拒绝</option>
          <option value="error">失败</option>
        </select>
      </label>
      <div className="product-scene__rows">
        {visible.map((row) => (
          <article key={row.id} className="product-scene__row">
            {eligibleIds.has(row.id) ? (
              <label className="product-scene__approval">
                <input
                  type="checkbox"
                  aria-label={`选择第 ${row.index} 张`}
                  checked={selectedVisibleIds.includes(row.id)}
                  disabled={disabled}
                  onChange={(event) =>
                    setSelectedIds((current) =>
                      event.target.checked
                        ? [...current.filter((id) => id !== row.id), row.id]
                        : current.filter((id) => id !== row.id),
                    )
                  }
                />
                加入批量选用
              </label>
            ) : null}
            {row.outputPath ? (
              <button
                type="button"
                className="product-scene__preview"
                onClick={() => setPreview(row.outputPath)}
                aria-label={`放大第 ${row.index} 张`}
              >
                <ProductSceneRowThumbnail
                  path={row.outputPath}
                  alt={`第 ${row.index} 张 ${row.recipe.label}`}
                />
              </button>
            ) : (
              <div className="product-scene__placeholder">{STATUS[row.status]}</div>
            )}
            <strong>
              {row.index}. {row.recipe.label}
            </strong>
            <small>
              {STATUS[row.status]} · {row.recipe.material} · {row.recipe.camera}
            </small>
            {row.recipe.targetCamera ? (
              <small>
                目标机位：{row.recipe.targetCamera.label} · 方位 {row.recipe.targetCamera.azimuth}°
                / 俯仰 {row.recipe.targetCamera.elevation}° / 等效{" "}
                {row.recipe.targetCamera.focalLength} mm
              </small>
            ) : null}
            <small>
              {(row.recipe.generationMode ?? "composite") === "reference"
                ? `产品参考：${options.views.map((view) => view.label).join("、")}`
                : `原图视角：${options.views.find((view) => view.id === row.recipe.viewId)?.label ?? row.recipe.viewId}`}
            </small>
            {row.error ? <p role="alert">{row.error}</p> : null}
            {row.reviewNotes.map((note, index) => (
              <small key={index}>{note}</small>
            ))}
            <ProductSceneQualityDetails row={row} options={options} />
            {generationMode === "protected" ? (
              <ProductSceneJewelryReviewDetails
                row={row}
                options={options}
                sourcePath={
                  options.views.find((view) => view.id === row.recipe.viewId)?.preparedPath
                }
                disabled={disabled}
                onChange={(review) => updateJewelryReview(row.id, review)}
                onPreview={setPreview}
              />
            ) : null}
            {row.quality?.basePath && row.quality.basePath !== row.outputPath ? (
              <button type="button" onClick={() => setPreview(row.quality!.basePath)}>
                查看第 {row.index} 张贴回前原图
              </button>
            ) : null}
            <div className="product-scene__actions">
              {canRetryProductSceneRow(row) && row.index <= state.approvedThrough ? (
                <button type="button" disabled={disabled} onClick={() => retry(row.id)}>
                  {row.backgroundPath
                    ? `重试第 ${row.index} 张本地合成（沿用背景）`
                    : `重试第 ${row.index} 张（沿用原任务）`}
                </button>
              ) : null}
              <button
                type="button"
                disabled={
                  disabled || !productSceneRowCanAccept(row, options) || row.status === "accepted"
                }
                onClick={() => review(row.id, "accepted")}
              >
                选用第 {row.index} 张
              </button>
              <button
                type="button"
                disabled={disabled || !["needs_review", "accepted", "error"].includes(row.status)}
                onClick={() => review(row.id, "rejected")}
              >
                拒绝第 {row.index} 张
              </button>
              <button
                type="button"
                disabled={
                  disabled ||
                  !["needs_review", "accepted", "rejected", "error"].includes(row.status)
                }
                onClick={() => redo(row.id)}
              >
                重做第 {row.index} 张
              </button>
            </div>
            {productSceneQualityEnabled(options) ? (
              <button
                type="button"
                disabled={disabled || !(row.quality?.basePath ?? row.outputPath)}
                onClick={() => recheck(row.id)}
              >
                重新检查第 {row.index} 张
              </button>
            ) : null}
            {row.attempts.length ? (
              <details>
                <summary>制作记录（{row.attempts.length}）</summary>
                {row.attempts.map((attempt, index) => (
                  <p key={index}>
                    {attempt.taskId ?? "未提交模型"}
                    {attempt.error ? ` · ${attempt.error}` : ""}
                  </p>
                ))}
              </details>
            ) : null}
          </article>
        ))}
      </div>
      <div className="product-scene__actions">
        <button
          type="button"
          disabled={safePage === 0}
          onClick={() => {
            setPage(safePage - 1);
            setSelectedIds([]);
          }}
        >
          上一页
        </button>
        <span>
          {safePage + 1} / {pageCount}
        </span>
        <button
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => {
            setPage(safePage + 1);
            setSelectedIds([]);
          }}
        >
          下一页
        </button>
      </div>
      {preview ? (
        <ProductSceneImagePreview path={preview} onClose={() => setPreview(null)} />
      ) : null}
    </section>
  );
}
