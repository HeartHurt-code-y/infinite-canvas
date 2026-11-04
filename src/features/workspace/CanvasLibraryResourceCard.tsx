import { LibTVMediaIcon } from "./LibTVMediaIcon";
import { canvasLibraryResourcePreview, type CanvasLibraryResource, type ConnectedLibraryResource } from "./canvasLibraryResources";

const RESOURCE_ICON = { style: "style-cube", effect: "lens-aperture" } as const;

export function CanvasLibraryResourceCard({ resource, name, onReplace }: {
  readonly resource: CanvasLibraryResource;
  readonly name: string;
  readonly onReplace: () => void;
}) {
  const { src } = canvasLibraryResourcePreview(resource);
  const kindLabel = resource.kind === "style" ? "风格" : "特效";
  return (
    <div className="canvas-library-card" aria-label={kindLabel + "素材节点"}>
      <div className="canvas-library-card__title">
        <LibTVMediaIcon name={RESOURCE_ICON[resource.kind]} size={16} />
        <span>{name}</span>
      </div>
      <div className="canvas-library-card__cover">
        {src ? <img src={src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" /> :
          <LibTVMediaIcon name={RESOURCE_ICON[resource.kind]} size={40} />}
      </div>
      <button type="button" className="canvas-library-card__replace nodrag nopan" onClick={(event) => {
        event.stopPropagation();
        onReplace();
      }}>更换{kindLabel}</button>
    </div>
  );
}

export function CanvasLibraryResourceInputs({ inputs, onUnlink }: {
  readonly inputs: readonly ConnectedLibraryResource[];
  readonly onUnlink: (edgeId: string) => void;
}) {
  if (inputs.length === 0) return null;
  return (
    <div className="canvas-library-refs" aria-label="素材库引用">
      {inputs.map(({ edgeId, name, resource }) => (
        <span key={edgeId}>
          <LibTVMediaIcon name={RESOURCE_ICON[resource.kind]} size={14} />
          {name}
          <button type="button" aria-label={`断开引用：${name}`} onClick={() => onUnlink(edgeId)}>
            <LibTVMediaIcon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
