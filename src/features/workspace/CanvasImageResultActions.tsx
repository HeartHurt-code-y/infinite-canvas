import { useState } from "react";
import { backendErrorMessage, isDesktopRuntime } from "../../lib/backend";
import { toast } from "../../lib/toast";
import { downloadCanvasImage } from "./canvasImageActions";
import type { CanvasImageTransform } from "./CanvasImageInlineEditor";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import type { GenNodeData, OutputNodeData } from "./workspaceModel";

export function CanvasImageResultActions({ node, output, onPreview, onEnhance, onTransform }: {
  readonly node: Extract<GenNodeData, { kind: "image" }>;
  readonly output: OutputNodeData | null | undefined;
  readonly onPreview: (key: string) => void;
  readonly onEnhance: (key: string, output: OutputNodeData) => void;
  readonly onTransform: (mode: CanvasImageTransform, output: OutputNodeData) => void;
}) {
  const [exporting, setExporting] = useState(false);
  if (!output || (!output.finalPath && !output.previewSrc)) return null;

  const localPath = output.finalPath;
  const download = async () => {
    if (!localPath || exporting) return;
    setExporting(true);
    try {
      const savedPath = await downloadCanvasImage({
        name: node.name ?? "图片",
        localPath,
        src: output.previewSrc ?? null,
      });
      if (savedPath) toast.success("图片已保存");
    } catch (error) {
      toast.error("下载失败：" + backendErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="canvas-image-result-actions nodrag nopan" role="group" aria-label="图片操作"
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}>
      <button type="button" aria-label="高清" data-tooltip={localPath ? "创建高清节点" : "图片保存后可创建高清节点"}
        disabled={!localPath} onClick={() => onEnhance(node.key, output)}>
        <LibTVMediaIcon name="hd" size={16} />
      </button>
      {localPath && isDesktopRuntime() ? <>
        <button type="button" aria-label="扩图" data-tooltip="扩图" onClick={() => onTransform("outpaint", output)}>
          <LibTVMediaIcon name="expand" size={16} />
        </button>
        <button type="button" aria-label="重绘" data-tooltip="重绘" onClick={() => onTransform("repaint", output)}>
          <LibTVMediaIcon name="repaint" size={16} />
        </button>
        <button type="button" data-image-transform-trigger="crop" aria-label="裁剪" data-tooltip="裁剪" onClick={() => onTransform("crop", output)}>
          <LibTVMediaIcon name="cut" size={16} />
        </button>
        <button type="button" data-image-transform-trigger="rotate" aria-label="旋转与镜像" data-tooltip="旋转与镜像" onClick={() => onTransform("rotate", output)}>
          <LibTVMediaIcon name="rotate-image" size={16} />
        </button>
        <button type="button" aria-label={exporting ? "下载中" : "下载图片"} data-tooltip="下载图片"
          disabled={exporting} onClick={() => { void download(); }}>
          <LibTVMediaIcon name={exporting ? "icon-loading" : "download"} size={16} className={exporting ? "spin-icon" : ""} />
        </button>
      </> : null}
      <button type="button" aria-label="全屏预览" data-tooltip="全屏预览" onClick={() => onPreview(node.key)}>
        <LibTVMediaIcon name="broad-picture" size={16} />
      </button>
    </div>
  );
}
