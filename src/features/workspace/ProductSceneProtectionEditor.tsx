import { useRef, useState } from "react";
import { toMediaSrc } from "../../lib/backend";
import type { ProductSceneView } from "./productSceneWorkflowModel";
import { WorkflowFieldHelp } from "./WorkflowGuidance";
import "./ProductSceneProtectionEditor.css";

type Protection = NonNullable<ProductSceneView["protection"]>;
type Rect = Protection["rect"];
const FULL_PHOTO: Rect = { x: 0, y: 0, width: 1, height: 1 };

/** Draft edits stay local until the user applies them; saving requires a new source approval. */
export function ProductSceneProtectionEditor({
  view,
  onSave,
  onCancel,
}: {
  readonly view: ProductSceneView;
  readonly onSave: (protection: Protection) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Protection>(
    view.protection ?? { rect: FULL_PHOTO, feather: 0.025, use: "product" },
  );
  const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  function point(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }
  function updateRect(key: keyof Rect, value: number) {
    setDraft((current) => {
      const rect = { ...current.rect, [key]: Math.min(1, Math.max(0, value)) };
      rect.width = Math.max(0.001, Math.min(rect.width, 1 - rect.x));
      rect.height = Math.max(0.001, Math.min(rect.height, 1 - rect.y));
      rect.x = Math.min(rect.x, 1 - rect.width);
      rect.y = Math.min(rect.y, 1 - rect.height);
      return { ...current, rect };
    });
  }
  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }
  return (
    <section className="product-scene-protection" aria-label={`${view.label} 保护范围编辑`}>
      <strong>保留原片范围</strong>
      <p>
        框住完整商品、细链、接触阴影及透明珠子透过的原背景。佩戴图还应保留手腕和真实遮挡。
        框内保留实拍内容，框外留出边缘融合余量；不改变原片里的姿势与佩戴比例。
      </p>
      <div
        className="product-scene-protection__canvas nodrag nopan"
        aria-label="拖动框选保护范围，也可使用下方百分比输入"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          drag.current = { ...point(event), pointerId: event.pointerId };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const end = point(event);
          const width = Math.abs(end.x - start.x);
          const height = Math.abs(end.y - start.y);
          if (width < 0.001 || height < 0.001) return;
          setDraft((current) => ({
            ...current,
            rect: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height },
          }));
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <img
          src={toMediaSrc(view.preparedPath)}
          alt={`${view.label} 完整实拍母版`}
          draggable={false}
          width={view.width}
          height={view.height}
        />
        <div
          className="product-scene-protection__rect"
          style={{
            left: `${draft.rect.x * 100}%`,
            top: `${draft.rect.y * 100}%`,
            width: `${draft.rect.width * 100}%`,
            height: `${draft.rect.height * 100}%`,
          }}
        >
          <span>保留原片</span>
        </div>
      </div>
      <div className="product-scene-protection__fields">
        {(
          [
            [
              "x",
              "左侧位置",
              "填写 0%～100% 内的数值，表示保护框左边距原图左边的比例。0% 从最左边开始；左侧位置与保护宽度相加不能超过 100%，可先拖框再微调。",
            ],
            [
              "y",
              "顶部位置",
              "填写 0%～100% 内的数值，表示保护框上边距原图顶部的比例。0% 从最顶部开始；顶部位置与保护高度相加不能超过 100%，可先拖框再微调。",
            ],
            [
              "width",
              "保护宽度",
              "保护框占原图宽度的比例，可填 0.1%～100%，还需扣除左侧位置。框住完整商品与必要阴影，不要只框商品中心。",
            ],
            [
              "height",
              "保护高度",
              "保护框占原图高度的比例，可填 0.1%～100%，还需扣除顶部位置。保留完整商品、细链及必要手腕，超出原图时会自动收回边界。",
            ],
          ] as const
        ).map(([key, label, help]) => (
          <label key={key}>
            {label}（%）
            <input
              aria-label={`${view.label} ${label}百分比`}
              type="number"
              min={key === "width" || key === "height" ? 0.1 : 0}
              max={100}
              step={0.1}
              value={Math.round(draft.rect[key] * 1000) / 10}
              onChange={(event) => updateRect(key, Number(event.target.value) / 100)}
            />
            <WorkflowFieldHelp>{help}</WorkflowFieldHelp>
          </label>
        ))}
        <label>
          边缘融合余量（%）
          <input
            aria-label={`${view.label} 边缘融合余量百分比`}
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={draft.feather * 100}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                feather: Math.min(0.1, Math.max(0, Number(event.target.value) / 100)),
              }))
            }
          />
          <WorkflowFieldHelp>
            填写 0%～10%，初始
            2.5%，按原片较短边计算框外融合距离。接缝明显时可适当增加；融合只在框外进行，关键商品细节仍应完整框住。
          </WorkflowFieldHelp>
        </label>
        <label>
          原片用途
          <select
            aria-label={`${view.label} 原片用途`}
            value={draft.use}
            onChange={(event) =>
              setDraft((current) => ({ ...current, use: event.target.value as Protection["use"] }))
            }
          >
            <option value="product">商品摆拍 · 保留阴影与透射背景</option>
            <option value="wearing">真实佩戴 · 同时保留手腕与遮挡</option>
          </select>
          <WorkflowFieldHelp>
            商品放在台面等环境中选「商品摆拍」；已经戴在人身上选「真实佩戴」，同时保留手腕与遮挡。按原片实际内容选择，再应用保护范围并重新确认原图。
          </WorkflowFieldHelp>
        </label>
      </div>
      <small>
        百分比以整张原片为基准。核心内容来自原片，随整张照片等比缩放；框外融合区需要人工核对，关键商品细节应全部在框内。
      </small>
      <div className="product-scene__actions">
        <button
          type="button"
          onClick={() => setDraft((current) => ({ ...current, rect: FULL_PHOTO }))}
        >
          重置为整张原片
        </button>
        <button type="button" onClick={() => onSave(draft)}>
          应用保护范围
        </button>
        <button type="button" onClick={onCancel}>
          取消编辑
        </button>
      </div>
    </section>
  );
}
