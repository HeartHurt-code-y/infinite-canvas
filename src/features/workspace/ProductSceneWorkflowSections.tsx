import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { formatRawBackendError, pickPromptMultimodalFiles, toMediaSrc } from "../../lib/backend";
import { productSceneImageClient } from "../../lib/productSceneImages";
import {
  productSceneGenerationMode,
  productSceneQualityEnabled,
  productSceneRowCanAccept,
  resetProductSceneQuality,
  resetProductSceneRow,
  type ProductSceneRow,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";
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
  onChange,
  onBusyChange,
}: {
  readonly options: ProductSceneWorkflowOptions;
  readonly disabled: boolean;
  readonly onChange: (options: ProductSceneWorkflowOptions) => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const generationMode = productSceneGenerationMode(options);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
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
        title: "选择同一版本产品的白底或透明原图",
        kinds: ["image"],
      });
      const added: ProductSceneWorkflowOptions["views"][number][] = [];
      for (const file of files) {
        if (file.kind !== "image") continue;
        const prepared = await productSceneImageClient.prepare({ sourcePath: file.localPath });
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

  return (
    <fieldset className="product-scene__configuration" disabled={disabled || busy}>
      <label>
        产品名称
        <ImeInput
          aria-label="产品名称"
          value={options.productName}
          onValueChange={(productName) => onChange({ ...options, productName })}
        />
      </label>
      <label>
        生成方式
        <select
          aria-label="产品场景生成方式"
          value={generationMode}
          onChange={(event) =>
            onChange({
              ...options,
              generationMode: event.target.value as "reference" | "composite",
            })
          }
        >
          <option value="reference">AI 多机位</option>
          <option value="composite">原图保真合成</option>
        </select>
      </label>
      <p>
        {generationMode === "reference"
          ? "用已确认的同一产品图片作为参考，工作流随机组合目标机位和场景，交给图片模型生成完整画面。新机位可以由提示词引导，无需先补拍或提供 CAD；产品形体、接口与 Logo 必须逐张审核。"
          : "AI 生成空场景，已确认产品原图在本地合成，保留原图的产品结构。此模式仅使用原图已有角度。"}
      </p>
      <button type="button" onClick={() => void pickProducts()}>
        {busy ? "正在处理产品图…" : "添加白底 / 透明产品原图"}
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
                alt={`${view.label} 抠图预览`}
                loading="lazy"
              />
            </button>
            <strong>{view.label}</strong>
            {view.width && view.height ? (
              <small>
                {view.width} × {view.height}
                {view.width < (options.aspectRatio === "3:4" ? 830 : 622)
                  ? generationMode === "reference"
                    ? " · 参考图细节较少，请仔细审核生成的接口与文字"
                    : " · 本次合成可能放大，建议换用更高清原图"
                  : ""}
              </small>
            ) : null}
            <label>
              {generationMode === "reference" ? "参考图原始角度（与目标机位独立）" : "原图角度"}
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
              确认同一产品版本，原始角度标注正确，边缘 / Logo / 接口完整
            </label>
            <button
              type="button"
              onClick={() =>
                onChange({ ...options, views: options.views.filter((item) => item.id !== view.id) })
              }
            >
              移除 {view.label}
            </button>
          </article>
        ))}
      </div>
      <small>
        请先放大核对透明区域、金色格栅及脚垫是否被误删。参考图原始角度用于识别产品；AI
        多机位模式的拍摄角度由制作计划另行安排。
      </small>
      <div className="product-scene__settings">
        <label>
          总计划张数
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
          每批张数
          <input
            aria-label="每批张数"
            type="number"
            min={10}
            max={50}
            value={options.batchSize}
            onChange={(event) =>
              onChange({
                ...options,
                batchSize: Math.min(50, Math.max(10, Number(event.target.value) || 10)),
              })
            }
          />
        </label>
        <label>
          场景倾向
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
        <label>
          图片比例
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
            <option value="3:4">3:4 · 1536 × 2048</option>
            <option value="9:16">9:16 · 1152 × 2048</option>
          </select>
        </label>
        <label>
          产品画面占比
          <input
            aria-label="产品画面占比"
            type="range"
            min={0.3}
            max={0.65}
            step={0.01}
            value={options.productScale ?? 0.48}
            onChange={(event) => onChange({ ...options, productScale: Number(event.target.value) })}
          />
          <small>{Math.round((options.productScale ?? 0.48) * 100)}% · 产品宽度占画面宽度</small>
        </label>
        <label>
          背景景深
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
        <label>
          场景种子
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
      </div>
      <small>
        手机随拍风格为 AI 展示图。导出清单会标明生成方式；不写入虚假的手机拍摄信息或买家身份。
      </small>
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
          自动检测可见接口
        </label>
        {options.quality?.inspectPorts ? (
          <label>
            已确认接口规格（可选）
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
              确认此 Logo 内容与透明边缘正确
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
      {preview ? (
        <ProductSceneImagePreview path={preview} onClose={() => setPreview(null)} />
      ) : null}
    </fieldset>
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
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const state = checkpoint.productScene;
  const generationMode = productSceneGenerationMode(options);
  if (!state?.rows.length) return null;
  const accepted = state.rows.filter(
    (row) => row.status === "accepted" && productSceneRowCanAccept(row, options),
  );
  const currentRows = state.rows.filter((row) => row.index <= state.approvedThrough);
  const awaitingReview = currentRows.some(
    (row) =>
      ["needs_review", "running", "queued", "error"].includes(row.status) ||
      (row.status === "accepted" && !productSceneRowCanAccept(row, options)),
  );
  const filtered = state.rows.filter((row) => filter === "all" || row.status === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * 12, (safePage + 1) * 12);
  const hasNext = state.approvedThrough < state.rows.length;
  const canNext = !disabled && !awaitingReview && hasNext;

  function review(id: string, status: "accepted" | "rejected") {
    if (!state || disabled) return;
    const selected = state.rows.find((row) => row.id === id);
    if (status === "accepted" && (!selected || !productSceneRowCanAccept(selected, options)))
      return;
    const rows = state.rows.map((row) => (row.id === id ? { ...row, status } : row));
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

  function continueBatch() {
    if (!state || !canNext) return;
    onChange({
      ...checkpoint,
      phase: "paused",
      decision: null,
      productScene: {
        ...state,
        approvedThrough: Math.min(state.rows.length, state.approvedThrough + options.batchSize),
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

  async function exportAccepted() {
    if (!accepted.length || exporting || disabled) return;
    setExporting(true);
    setMessage("");
    try {
      const result = await productSceneImageClient.export({
        paths: accepted.map((row) => row.outputPath!),
        manifest: JSON.stringify(
          {
            schemaVersion: "product-scene-delivery.v1",
            generationMode,
            provenance:
              generationMode === "reference"
                ? "基于用户确认产品参考图，由 AI 生成不同机位与场景的展示图"
                : "AI 生成场景与用户确认产品原图的本地合成展示图",
            productName: options.productName,
            aspectRatio: options.aspectRatio,
            seed: options.seed,
            views: options.views,
            quality: options.quality ?? null,
            rows: accepted,
          },
          null,
          2,
        ),
      });
      if (result) setMessage(`已导出 ${result.count} 张选用图片：${result.directory}`);
    } catch (error) {
      setMessage(`导出失败：${formatRawBackendError(error)}`);
    } finally {
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
          : "请逐张核对背景合理性、产品比例、透视、落地阴影和边缘。"}
        相似度检查只能辅助去重；选用后才进入导出包。
      </p>
      <div className="product-scene__actions">
        <button type="button" disabled={!canNext} onClick={continueBatch}>
          {state.approvedThrough === 0
            ? `确认生成首批 ${Math.min(options.batchSize, state.rows.length)} 张`
            : `确认生成下一批 ${Math.min(options.batchSize, state.rows.length - state.approvedThrough)} 张`}
        </button>
        <button
          type="button"
          disabled={disabled || exporting || !accepted.length}
          onClick={() => void exportAccepted()}
        >
          {exporting ? "正在导出…" : `导出已选用 ${accepted.length} 张`}
        </button>
      </div>
      {awaitingReview ? <small>完成当前批次审核后可开启下一批；失败项可重做或拒绝。</small> : null}
      {message ? <p role="status">{message}</p> : null}
      <label>
        筛选图片
        <select
          aria-label="筛选产品场景图"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as typeof filter);
            setPage(0);
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
            {row.outputPath ? (
              <button
                type="button"
                className="product-scene__preview"
                onClick={() => setPreview(row.outputPath)}
                aria-label={`放大第 ${row.index} 张`}
              >
                <img
                  src={toMediaSrc(row.outputPath)}
                  alt={`第 ${row.index} 张 ${row.recipe.label}`}
                  loading="lazy"
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
            {row.quality?.basePath && row.quality.basePath !== row.outputPath ? (
              <button type="button" onClick={() => setPreview(row.quality!.basePath)}>
                查看第 {row.index} 张贴回前原图
              </button>
            ) : null}
            <div className="product-scene__actions">
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
        <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
          上一页
        </button>
        <span>
          {safePage + 1} / {pageCount}
        </span>
        <button
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => setPage(safePage + 1)}
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
