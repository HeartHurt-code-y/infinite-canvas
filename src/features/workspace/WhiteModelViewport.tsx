import { useEffect, useRef, useState } from "react";
import type { WhiteModelScenePlan } from "../../lib/whiteModelScene";
import type { PlaybackClock } from "./whiteModelPlayback";
import type {
  WhiteModelViewMode,
  WhiteModelViewportCallbacks,
  WhiteModelViewportController,
} from "./whiteModelViewportController";

export interface WhiteModelViewportProps extends WhiteModelViewportCallbacks {
  readonly plan: WhiteModelScenePlan;
  readonly clock: PlaybackClock;
  readonly view: WhiteModelViewMode;
  readonly selectedActorId: string | null;
  readonly resetSignal: number;
}

interface LensRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 导演台画布的 React 外壳：管理 WebGL 控制器的生命周期、尺寸与回调，
 * 并在机位视角叠加输出画幅的取景框与三分线。
 */
export function WhiteModelViewport({
  plan,
  clock,
  view,
  selectedActorId,
  resetSignal,
  onSelectActor,
  onActorMove,
  onWaypointMove,
  onActorRotate,
  onCameraChange,
}: WhiteModelViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<WhiteModelViewportController | null>(null);
  const callbacksRef = useRef<WhiteModelViewportCallbacks>({
    onSelectActor,
    onActorMove,
    onWaypointMove,
    onActorRotate,
    onCameraChange,
  });
  const [fallback, setFallback] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    callbacksRef.current = { onSelectActor, onActorMove, onWaypointMove, onActorRotate, onCameraChange };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    let controller: WhiteModelViewportController | null = null;
    let observer: ResizeObserver | null = null;
    void import("./whiteModelViewportController")
      .then((module) => {
        if (disposed) return;
        controller = new module.WhiteModelViewportController(canvas, clock, {
          onSelectActor: (id) => callbacksRef.current.onSelectActor(id),
          onActorMove: (id, position, time) => callbacksRef.current.onActorMove(id, position, time),
          onWaypointMove: (id, index, position) =>
            callbacksRef.current.onWaypointMove(id, index, position),
          onActorRotate: (id, yaw, time) => callbacksRef.current.onActorRotate(id, yaw, time),
          onCameraChange: (state, time) => callbacksRef.current.onCameraChange(state, time),
        });
        controllerRef.current = controller;
        const measure = () => {
          const bounds = container.getBoundingClientRect();
          const width = Math.max(1, Math.floor(bounds.width));
          const height = Math.max(1, Math.floor(bounds.height));
          controller?.setSize(width, height);
          setSize({ width, height });
        };
        measure();
        observer = new ResizeObserver(measure);
        observer.observe(container);
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setFallback(
          `当前环境无法创建 3D 预览（${cause instanceof Error ? cause.message : String(cause)}）。仍可在右侧用数值编辑并渲染。`,
        );
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      controller?.dispose();
      controllerRef.current = null;
    };
  }, [clock]);

  useEffect(() => {
    controllerRef.current?.setPlan(plan);
  }, [plan, ready]);
  useEffect(() => {
    controllerRef.current?.setView(view);
  }, [view, ready]);
  useEffect(() => {
    controllerRef.current?.setSelected(selectedActorId);
  }, [selectedActorId, ready]);
  useEffect(() => {
    if (resetSignal > 0) controllerRef.current?.resetDirectorView();
  }, [resetSignal]);

  const lensRect = view === "lens" && ready ? computeLensRect(size, plan) : null;

  return (
    <div
      ref={containerRef}
      className={`white-model-viewport white-model-viewport--${view}`}
      data-testid="white-model-viewport"
    >
      <canvas ref={canvasRef} className="white-model-viewport__canvas" aria-label="白模导演台" />
      {lensRect ? (
        <div
          className="white-model-viewport__frame"
          aria-hidden="true"
          style={{
            left: lensRect.x,
            top: lensRect.y,
            width: lensRect.width,
            height: lensRect.height,
          }}
        >
          <span className="white-model-viewport__third white-model-viewport__third--v1" />
          <span className="white-model-viewport__third white-model-viewport__third--v2" />
          <span className="white-model-viewport__third white-model-viewport__third--h1" />
          <span className="white-model-viewport__third white-model-viewport__third--h2" />
        </div>
      ) : null}
      {fallback ? (
        <p className="white-model-viewport__fallback" role="status">
          {fallback}
        </p>
      ) : null}
    </div>
  );
}

function computeLensRect(size: { width: number; height: number }, plan: WhiteModelScenePlan): LensRect {
  const aspect = plan.width / plan.height;
  let width = size.width;
  let height = Math.round(width / aspect);
  if (height > size.height) {
    height = size.height;
    width = Math.round(height * aspect);
  }
  return {
    x: Math.floor((size.width - width) / 2),
    y: Math.floor((size.height - height) / 2),
    width,
    height,
  };
}
