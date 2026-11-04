import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasLibraryItemDetail.css";

export type CanvasLibraryAction = "add" | "replace";

export function CanvasLibraryItemDetail({ title, cover, author, description, action, onBack, onApply }: {
  readonly title: string;
  readonly cover: string;
  readonly author?: string;
  readonly description: string;
  readonly action: CanvasLibraryAction;
  readonly onBack: () => void;
  readonly onApply: () => void;
}) {
  return (
    <div className="canvas-library-detail">
      <button type="button" className="canvas-library-detail__back" onClick={onBack}>
        <LibTVMediaIcon name="icon-chevron-left" size={16} />返回目录
      </button>
      <div className="canvas-library-detail__body">
        <img src={cover} alt={title} referrerPolicy="no-referrer" />
        <div className="canvas-library-detail__summary">
          <h3>{title}</h3>
          {author ? <p>{author}</p> : null}
          <p>{description}</p>
          <button type="button" className="canvas-library-detail__apply" onClick={onApply}>
            {action === "replace" ? "应用到当前节点" : "添加到画布"}
          </button>
        </div>
      </div>
    </div>
  );
}
