import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { toMediaSrc } from "../../lib/backend";
import { captureMotionFromVideo, poseCaptureAvailable } from "../../lib/poseCapture";
import {
  cameraKeyframeFromWorld,
  evaluateActor,
  evaluateCamera,
  nearestKeyframeIndex,
  upsertKeyframe,
  whiteModelPlanIssue,
  type WhiteModelCameraState,
  type WhiteModelScenePlan,
  type WhiteModelVector,
} from "../../lib/whiteModelScene";
import {
  cancelBlenderRender,
  getBlenderEngine,
  getBlenderRender,
  normalizeWhiteModelStudioDraft,
  openBlenderProject,
  startBlenderRender,
  whiteModelRenderRequest,
  whiteModelRenderSignature,
  type BlenderEngineStatus,
  type BlenderRenderJob,
  type WhiteModelStudioDraft,
} from "../../lib/whiteModelStudio";
import { WhiteModelInspector, type MotionCaptureState } from "./WhiteModelInspector";
import { WhiteModelTimeline } from "./WhiteModelTimeline";
import { WhiteModelViewport, type WhiteModelViewportHandle } from "./WhiteModelViewport";
import { PlaybackClock } from "./whiteModelPlayback";
import type { WhiteModelViewMode } from "./whiteModelViewportController";
import {
  blockingAssignmentsFromDraft,
  blockingStillName,
  environmentPreviewSrc,
  nextEnvironmentBinding,
  pruneWhiteModelCharacterBindings,
  saveWhiteModelStill,
  upsertCharacterBinding,
  whiteModelBlockingSignature,
  type WhiteModelBlockingCapture,
  type WhiteModelStudioMediaInput,
} from "../../lib/whiteModelBlocking";
import "./WhiteModelStudioDialog.css";

export interface WhiteModelStudioDialogProps {
  readonly draft: WhiteModelStudioDraft;
  readonly onDraftChange: (draft: WhiteModelStudioDraft) => void;
  readonly onClose: () => void;
  readonly onUse: (job: BlenderRenderJob) => Promise<void> | void;
  readonly purpose?: "video" | "blocking";
  readonly imageInputs?: readonly WhiteModelStudioMediaInput[];
  readonly onExportBlocking?: (capture: WhiteModelBlockingCapture) => Promise<void> | void;
}

const COMMIT_DELAY_MS = 120;
const EMPTY_IMAGE_INPUTS: readonly WhiteModelStudioMediaInput[] = [];

const activeJob = (job: BlenderRenderJob | null) =>
  job?.status === "queued" || job?.status === "running";
const errorMessage = (cause: unknown) => {
  if (cause instanceof Error) return cause.message;
  if (
    typeof cause === "object" &&
    cause != null &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  return String(cause);
};
const isAbort = (cause: unknown) =>
  cause instanceof DOMException ? cause.name === "AbortError" : false;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * 白模导演台：左侧实时 3D 视口 + 时间轴，右侧镜头语言检查器；渲染仍交给本机 Blender，
 * 但预览与渲染共用同一套烘焙数据。关闭对话框只停止轮询，不会中断渲染。
 */
export function WhiteModelStudioDialog({
  draft,
  onDraftChange,
  onClose,
  onUse,
  purpose = "video",
  imageInputs = EMPTY_IMAGE_INPUTS,
  onExportBlocking,
}: WhiteModelStudioDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<WhiteModelViewportHandle>(null);
  const titleId = useId();
  const formId = useId();
  const blocking = purpose === "blocking";

  // ---- 本地草稿：交互即时更新，节流写回画布，保证拖拽流畅且撤销栈不被刷爆 ----
  const initial = useMemo(() => normalizeWhiteModelStudioDraft(draft), [draft]);
  const [local, setLocal] = useState<WhiteModelStudioDraft>(initial);
  const localRef = useRef(local);
  const onDraftChangeRef = useRef(onDraftChange);
  const pendingRef = useRef<WhiteModelStudioDraft | null>(null);
  const timerRef = useRef<number | null>(null);
  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending) {
      pendingRef.current = null;
      onDraftChangeRef.current(pending);
    }
  }, []);
  const commit = useCallback(
    (next: WhiteModelStudioDraft) => {
      localRef.current = next;
      setLocal(next);
      pendingRef.current = next;
      timerRef.current ??= window.setTimeout(flush, COMMIT_DELAY_MS);
    },
    [flush],
  );
  const commitNow = useCallback(
    (next: WhiteModelStudioDraft) => {
      localRef.current = next;
      setLocal(next);
      pendingRef.current = next;
      flush();
    },
    [flush],
  );
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  });
  useEffect(() => {
    // 旧版方案迁移后立刻写回，画布里保存的就是 v2。
    if (initial !== draft) onDraftChangeRef.current(initial);
    // 只在挂载时同步一次：对话框打开期间它是草稿唯一的编辑者。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => flush(), [flush]);

  const [clock] = useState(() => new PlaybackClock(initial.plan.durationSeconds));
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => {
    clock.setDuration(local.plan.durationSeconds);
  }, [clock, local.plan.durationSeconds]);

  const [view, setView] = useState<WhiteModelViewMode>("lens");
  const [resetSignal, setResetSignal] = useState(0);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(
    initial.plan.objects[0]?.id ?? null,
  );
  const [engine, setEngine] = useState<BlenderEngineStatus | null>(null);
  const [enginePath, setEnginePath] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [job, setJob] = useState<BlenderRenderJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [using, setUsing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [advancedEngineOpen, setAdvancedEngineOpen] = useState(
    Boolean(initial.executablePath.trim()),
  );
  const [capture, setCapture] = useState<MotionCaptureState | null>(null);
  const [captureAvailable, setCaptureAvailable] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const captureAbort = useRef<AbortController | null>(null);
  const engineRequestId = useRef(0);

  const loadedJob = job?.jobId === local.jobId ? job : null;
  const restoring = !blocking && Boolean(local.jobId) && loadedJob == null;
  const rendering = !blocking && (starting || restoring || activeJob(loadedJob));
  const locked = rendering || using;
  const signatureMatches = local.jobInputSignature === whiteModelRenderSignature(local);
  const finished = !blocking && loadedJob?.status === "succeeded" && Boolean(loadedJob.videoPath);
  const sceneIssue = local.mode === "create" ? whiteModelPlanIssue(local.plan) : null;
  const engineReady = engine?.available && enginePath === local.executablePath.trim();
  const selectedActor =
    local.plan.objects.find((actor) => actor.id === selectedActorId) ?? null;
  const environmentSrc = environmentPreviewSrc(local.environment ?? null, imageInputs);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (blocking) return;
    let alive = true;
    void poseCaptureAvailable().then((available) => {
      if (alive) setCaptureAvailable(available);
    });
    return () => {
      alive = false;
      captureAbort.current?.abort();
    };
  }, [blocking]);

  useEffect(() => {
    if (blocking) return;
    let alive = true;
    const requestId = ++engineRequestId.current;
    const path = initial.executablePath;
    void getBlenderEngine(path)
      .then((result) => {
        if (alive && requestId === engineRequestId.current) {
          setEngine(result);
          setEnginePath(path.trim());
        }
      })
      .catch((cause: unknown) => {
        if (alive)
          setError(
            path.trim()
              ? errorMessage(cause)
              : `内置 Blender 检查失败：${errorMessage(cause)} 请修复安装包或重新安装应用。`,
          );
      });
    return () => {
      alive = false;
    };
  }, [blocking, initial.executablePath]);

  useEffect(() => {
    if (blocking || !local.jobId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const jobId = local.jobId;
    const poll = async () => {
      try {
        const current = await getBlenderRender(jobId);
        if (!alive) return;
        setJob((previous) =>
          previous?.jobId === current.jobId &&
          (previous.updatedAt > current.updatedAt || (!activeJob(previous) && activeJob(current)))
            ? previous
            : current,
        );
        setPollError(null);
        if (activeJob(current))
          timer = setTimeout(() => {
            void poll();
          }, 1000);
      } catch (cause) {
        if (alive) setPollError(errorMessage(cause));
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [blocking, local.jobId, pollVersion]);

  // ---- 编辑辅助 ----
  const updateDraft = (patch: Partial<WhiteModelStudioDraft>) =>
    commit({ ...localRef.current, ...patch });
  const updatePlan = (plan: WhiteModelScenePlan) =>
    commit({
      ...localRef.current,
      plan,
      characterBindings: pruneWhiteModelCharacterBindings(
        localRef.current.characterBindings,
        plan.objects,
      ),
    });
  const patchPlan = (mutate: (plan: WhiteModelScenePlan) => WhiteModelScenePlan) =>
    updatePlan(mutate(localRef.current.plan));

  const handleActorMove = useCallback(
    (actorId: string, position: WhiteModelVector, time: number) =>
      patchPlan((plan) => ({
        ...plan,
        objects: plan.objects.map((actor) =>
          actor.id === actorId
            ? {
                ...actor,
                keyframes: upsertKeyframe(actor.keyframes, time, plan.fps, (existing) => ({
                  time,
                  position,
                  yaw: existing?.yaw ?? evaluateActor(actor, time).yaw,
                })),
              }
            : actor,
        ),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handleWaypointMove = useCallback(
    (actorId: string, index: number, position: WhiteModelVector) =>
      patchPlan((plan) => ({
        ...plan,
        objects: plan.objects.map((actor) =>
          actor.id === actorId
            ? {
                ...actor,
                keyframes: actor.keyframes.map((frame, entry) =>
                  entry === index ? { ...frame, position } : frame,
                ),
              }
            : actor,
        ),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handleActorRotate = useCallback(
    (actorId: string, yaw: number, time: number) =>
      patchPlan((plan) => ({
        ...plan,
        objects: plan.objects.map((actor) =>
          actor.id === actorId
            ? {
                ...actor,
                keyframes: upsertKeyframe(actor.keyframes, time, plan.fps, (existing) => ({
                  time,
                  position: existing?.position ?? evaluateActor(actor, time).position,
                  yaw,
                })),
              }
            : actor,
        ),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handleCameraChange = useCallback(
    (state: WhiteModelCameraState, time: number) =>
      patchPlan((plan) => ({
        ...plan,
        camera: {
          ...plan.camera,
          keyframes: upsertKeyframe(plan.camera.keyframes, time, plan.fps, () =>
            cameraKeyframeFromWorld(plan, time, state),
          ),
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const addActorKeyframe = () => {
    const actor = selectedActor;
    if (!actor) return;
    const time = clock.get();
    const state = evaluateActor(actor, time);
    handleActorMove(actor.id, state.position, time);
  };
  const addCameraKeyframe = () => {
    const time = clock.get();
    patchPlan((plan) => ({
      ...plan,
      camera: {
        ...plan.camera,
        keyframes: upsertKeyframe(plan.camera.keyframes, time, plan.fps, (existing) =>
          existing ?? cameraKeyframeFromWorld(plan, time, evaluateCamera(plan, time)),
        ),
      },
    }));
  };
  const deleteKeyframes = () => {
    const time = clock.get();
    patchPlan((plan) => {
      const cameraIndex = nearestKeyframeIndex(plan.camera.keyframes, time, plan.fps);
      return {
        ...plan,
        camera:
          cameraIndex >= 0 && plan.camera.keyframes.length > 1
            ? {
                ...plan.camera,
                keyframes: plan.camera.keyframes.filter((_, index) => index !== cameraIndex),
              }
            : plan.camera,
        objects: plan.objects.map((actor) => {
          if (actor.id !== selectedActorId || actor.keyframes.length <= 1) return actor;
          const index = nearestKeyframeIndex(actor.keyframes, time, plan.fps);
          return index >= 0
            ? { ...actor, keyframes: actor.keyframes.filter((_, entry) => entry !== index) }
            : actor;
        }),
      };
    });
  };

  // ---- 一键动捕 ----
  const captureMotion = async (actorId: string) => {
    if (capture) return;
    setError(null);
    setCaptureNotice(null);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: false,
        title: "选择真人表演参考视频",
        filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "m4v", "avi"] }],
      });
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    if (typeof selected !== "string") return;
    const controller = new AbortController();
    captureAbort.current = controller;
    setCapture({ actorId, progress: 0, message: "正在加载动作捕捉模型…" });
    try {
      const clip = await captureMotionFromVideo(toMediaSrc(selected), {
        fps: localRef.current.plan.fps,
        sourceName: fileName(selected),
        signal: controller.signal,
        onProgress: (done, total, message) =>
          setCapture({ actorId, progress: (done / Math.max(1, total)) * 100, message }),
      });
      const plan = localRef.current.plan;
      const actor = plan.objects.find((entry) => entry.id === actorId);
      if (!actor) throw new Error("角色已被移除，动作片段未应用。");
      commitNow({
        ...localRef.current,
        plan: {
          ...plan,
          objects: plan.objects.map((entry) =>
            entry.id === actorId
              ? {
                  ...entry,
                  shape: "person",
                  motion: {
                    kind: "clip",
                    clip,
                    startTime: entry.keyframes[0]?.time ?? 0,
                    loop: true,
                    speed: 1,
                  },
                }
              : entry,
          ),
        },
      });
      setCaptureNotice(
        `已从「${clip.sourceName}」提取 ${clip.frameCount} 帧动作（${(clip.frameCount / clip.fps).toFixed(1)} 秒），白模会照着表演；机位与走位仍可自由调整。`,
      );
      clock.set(actor.keyframes[0]?.time ?? 0);
      clock.play();
    } catch (cause) {
      if (!isAbort(cause)) setError(`动作捕捉失败：${errorMessage(cause)}`);
    } finally {
      captureAbort.current = null;
      setCapture(null);
    }
  };

  // ---- 引擎与任务 ----
  const detectEngine = async (path = localRef.current.executablePath) => {
    const requestId = ++engineRequestId.current;
    setDetecting(true);
    setError(null);
    try {
      const result = await getBlenderEngine(path);
      if (requestId === engineRequestId.current) {
        setEngine(result);
        setEnginePath(path.trim());
      }
    } catch (cause) {
      if (requestId === engineRequestId.current) {
        setEngine(null);
        setError(
          path.trim()
            ? errorMessage(cause)
            : `内置 Blender 检查失败：${errorMessage(cause)} 请修复安装包或重新安装应用。`,
        );
      }
    } finally {
      if (requestId === engineRequestId.current) setDetecting(false);
    }
  };
  const chooseFile = async (kind: "engine" | "blend") => {
    try {
      const selected = await open({
        multiple: false,
        title: kind === "engine" ? "选择 Blender 可执行文件" : "导入 Blender 工程",
        ...(kind === "blend" ? { filters: [{ name: "Blender 工程", extensions: ["blend"] }] } : {}),
      });
      if (typeof selected !== "string") return;
      if (kind === "engine") {
        commitNow({ ...localRef.current, executablePath: selected });
        await detectEngine(selected);
      } else commitNow({ ...localRef.current, mode: "blend", sourceBlendPath: selected });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const startRender = async () => {
    if (locked || !engineReady || sceneIssue) return;
    clock.pause();
    const snapshot = structuredClone(localRef.current);
    const signature = whiteModelRenderSignature(snapshot);
    setStarting(true);
    setError(null);
    setPollError(null);
    try {
      const created = await startBlenderRender(whiteModelRenderRequest(snapshot));
      // 先把任务编号连同冻结请求一起写回画布，再允许关闭对话框。
      commitNow({ ...snapshot, jobId: created.jobId, jobInputSignature: signature });
      setJob(created);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  };
  const cancelRender = async () => {
    if (!local.jobId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      setJob(await cancelBlenderRender(local.jobId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  };
  const openProject = async (path: string) => {
    setOpening(true);
    setError(null);
    try {
      await openBlenderProject(localRef.current.executablePath.trim() || null, path);
      const current = localRef.current;
      if (current.mode === "blend" && current.sourceBlendPath === path && current.jobId) {
        commitNow({ ...current, jobInputSignature: "" });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  };
  const handleUseVideo = async () => {
    if (!loadedJob || !finished || !signatureMatches || using) return;
    flush();
    setUsing(true);
    setError(null);
    try {
      await onUse(loadedJob);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUsing(false);
    }
  };
  const exportBlockingStill = async () => {
    if (!blocking || using || sceneIssue) return;
    clock.pause();
    const dataUrl = viewportRef.current?.captureStill() ?? null;
    if (!dataUrl) {
      setError("3D 预览尚未就绪，请稍候再导出站位图。");
      return;
    }
    flush();
    setUsing(true);
    setError(null);
    try {
      const saved = await saveWhiteModelStill(dataUrl);
      const snapshot = localRef.current;
      const name = blockingStillName();
      commitNow({
        ...snapshot,
        blockingImagePath: saved.path,
        blockingImageSignature: whiteModelBlockingSignature(snapshot),
      });
      await onExportBlocking?.({
        path: saved.path,
        width: saved.width,
        height: saved.height,
        name,
        environment: snapshot.environment ?? null,
        assignments: blockingAssignmentsFromDraft(snapshot),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUsing(false);
    }
  };
  const replaceEnvironment = () =>
    commitNow({
      ...localRef.current,
      environment: nextEnvironmentBinding(localRef.current.environment ?? null, imageInputs),
    });
  const close = () => {
    if (starting || using) return;
    clock.pause();
    flush();
    onClose();
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="white-model-studio"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        const target = event.target as HTMLElement;
        const editing = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"].includes(target.tagName);
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === " " && !editing && local.mode === "create" && !blocking) {
          event.preventDefault();
          clock.toggle();
        } else if (event.key === "Tab") {
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button, input, select, textarea, summary, video[controls], [tabindex="0"]',
            ) ?? [],
          ).filter((element) => {
            const closedDetails = element.closest("details:not([open])");
            return (
              !element.matches(":disabled") &&
              (!closedDetails ||
                (element.tagName === "SUMMARY" && element.parentElement === closedDetails))
            );
          });
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="white-model-studio__header">
        <div>
          <h2 id={titleId}>{blocking ? "白模导演台 · 站位" : "白模导演台"}</h2>
          <p>
            {blocking
              ? "把全景环境铺进视口，摆好编号假人，导出站位图后自动写好多参考提示词。"
              : "像走戏一样摆位、取景、运镜，实时预览即渲染结果；成片用于专业级白模控制。"}
          </p>
        </div>
        {local.mode === "create" ? (
          <div className="white-model-studio__views" role="group" aria-label="视角">
            <button
              type="button"
              className={view === "lens" ? "white-model-studio__view--active" : undefined}
              aria-pressed={view === "lens"}
              onClick={() => setView("lens")}
            >
              机位视角
            </button>
            <button
              type="button"
              className={view === "director" ? "white-model-studio__view--active" : undefined}
              aria-pressed={view === "director"}
              onClick={() => setView("director")}
            >
              导演视角
            </button>
            {view === "director" ? (
              <button type="button" onClick={() => setResetSignal((value) => value + 1)}>
                重置视角
              </button>
            ) : null}
          </div>
        ) : null}
        <button type="button" onClick={close} disabled={starting || using}>
          关闭导演台
        </button>
      </header>
      <div className="white-model-studio__layout">
        <section
          className={`white-model-studio__stage${blocking ? " white-model-studio__stage--still" : ""}`}
          aria-label="导演台预览"
        >
          {local.mode === "create" ? (
            <>
              <WhiteModelViewport
                ref={viewportRef}
                plan={local.plan}
                clock={clock}
                view={view}
                selectedActorId={selectedActorId}
                resetSignal={resetSignal}
                environmentSrc={environmentSrc}
                showDummyLabels={blocking}
                onSelectActor={setSelectedActorId}
                onActorMove={handleActorMove}
                onWaypointMove={handleWaypointMove}
                onActorRotate={handleActorRotate}
                onCameraChange={handleCameraChange}
              />
              {blocking ? (
                <button
                  type="button"
                  className="white-model-studio__replace"
                  disabled={locked || imageInputs.length === 0}
                  onClick={replaceEnvironment}
                >
                  ↑ 替换
                </button>
              ) : null}
              <p className="white-model-studio__hud">
                {view === "lens"
                  ? blocking
                    ? "机位视角 · 拖动假人站位 · 左键环绕 / 右键摇镜 / Shift 平移 / 滚轮推拉"
                    : "机位视角 · 拖动角色走位 · 左键环绕 / 右键摇镜 / Shift 平移 / 滚轮推拉 · 空格播放"
                  : "导演视角 · 拖动角色或路径点走位 · 拖动摄影机改机位 · 空白处拖动旋转视角 · 双击复位"}
              </p>
              {blocking ? null : (
                <WhiteModelTimeline
                  clock={clock}
                  plan={local.plan}
                  selectedActorId={selectedActorId}
                  disabled={locked}
                  onAddActorKeyframe={addActorKeyframe}
                  onAddCameraKeyframe={addCameraKeyframe}
                  onDeleteKeyframes={deleteKeyframes}
                />
              )}
              {sceneIssue ? (
                <p className="white-model-studio__error" role="alert">
                  {sceneIssue}
                </p>
              ) : null}
              {captureNotice ? (
                <p className="white-model-studio__hint" role="status">
                  {captureNotice}
                </p>
              ) : null}
            </>
          ) : (
            <div className="white-model-studio__placeholder white-model-studio__placeholder--stage">
              <strong>渲染 Blender 工程</strong>
              <p>
                沿用工程里的角色、动画和相机，按右侧片长与画幅导出。实时预览仅对导演台搭建的场景可用。
              </p>
              {local.sourceBlendPath ? <code>{local.sourceBlendPath}</code> : null}
            </div>
          )}
        </section>
        <aside className="white-model-studio__side">
          <form
            id={formId}
            className="white-model-studio__settings"
            onSubmit={(event) => {
              event.preventDefault();
              if (blocking) void exportBlockingStill();
              else void startRender();
            }}
          >
            {local.mode === "create" ? (
              <WhiteModelInspector
                plan={local.plan}
                clock={clock}
                locked={locked}
                selectedActorId={selectedActorId}
                onSelectActor={setSelectedActorId}
                onPlanChange={updatePlan}
                capture={capture}
                captureAvailable={captureAvailable}
                purpose={purpose}
                imageInputs={imageInputs}
                environment={local.environment ?? null}
                onEnvironmentChange={(environment) => updateDraft({ environment })}
                characterBindings={local.characterBindings ?? []}
                onCharacterBindingChange={(actorId, reference) =>
                  updateDraft({
                    characterBindings: upsertCharacterBinding(
                      localRef.current.characterBindings,
                      actorId,
                      reference,
                    ),
                  })
                }
                onCaptureMotion={(actorId) => {
                  void captureMotion(actorId);
                }}
                onCancelCapture={() => captureAbort.current?.abort()}
              />
            ) : (
              <fieldset disabled={locked} className="white-model-studio__section">
                <legend>输出</legend>
                <div className="white-model-studio__row">
                  <label className="white-model-studio__field">
                    <span>片长（秒）</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={0.5}
                      value={local.plan.durationSeconds}
                      onChange={(event) => {
                        const value = event.target.valueAsNumber;
                        if (Number.isFinite(value) && value > 0 && value <= 30)
                          updatePlan({ ...localRef.current.plan, durationSeconds: value });
                      }}
                    />
                  </label>
                  <label className="white-model-studio__field">
                    <span>帧率</span>
                    <input
                      type="number"
                      min={8}
                      max={30}
                      step={1}
                      value={local.plan.fps}
                      onChange={(event) => {
                        const value = event.target.valueAsNumber;
                        if (Number.isFinite(value)) updatePlan({ ...localRef.current.plan, fps: value });
                      }}
                    />
                  </label>
                  <label className="white-model-studio__field">
                    <span>画幅</span>
                    <select
                      value={`${local.plan.width}:${local.plan.height}`}
                      onChange={(event) => {
                        const [width, height] = event.target.value.split(":").map(Number);
                        if (width && height) updatePlan({ ...localRef.current.plan, width, height });
                      }}
                    >
                      <option value="960:540">16:9 · 横屏</option>
                      <option value="540:960">9:16 · 竖屏</option>
                      <option value="768:768">1:1 · 方形</option>
                      <option value="960:720">4:3 · 横屏</option>
                    </select>
                  </label>
                </div>
              </fieldset>
            )}
            {blocking ? null : (
            <details className="white-model-studio__advanced white-model-studio__section">
              <summary>场景来源与渲染引擎</summary>
              <div className="white-model-studio__advanced-body">
                <label className="white-model-studio__field">
                  <span>场景来源</span>
                  <select
                    value={local.mode}
                    disabled={locked}
                    onChange={(event) =>
                      commitNow({
                        ...localRef.current,
                        mode: event.target.value === "blend" ? "blend" : "create",
                      })
                    }
                  >
                    <option value="create">在导演台搭建白模</option>
                    <option value="blend">渲染 Blender 工程</option>
                  </select>
                </label>
                {local.mode === "blend" ? (
                  <>
                    <label className="white-model-studio__field">
                      <span>Blender 工程文件</span>
                      <input
                        required
                        disabled={locked}
                        value={local.sourceBlendPath}
                        placeholder="选择 .blend 工程"
                        onChange={(event) => updateDraft({ sourceBlendPath: event.target.value })}
                      />
                    </label>
                    <div className="white-model-studio__actions">
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          void chooseFile("blend");
                        }}
                      >
                        导入 .blend 工程
                      </button>
                      <button
                        type="button"
                        disabled={!local.sourceBlendPath.trim() || opening}
                        onClick={() => {
                          void openProject(local.sourceBlendPath);
                        }}
                      >
                        打开源工程精修
                      </button>
                    </div>
                    <p className="white-model-studio__hint">
                      精修后先在 Blender 保存，再重新渲染。
                    </p>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      void chooseFile("blend");
                    }}
                  >
                    导入已有 .blend 工程
                  </button>
                )}
                <p className="white-model-studio__hint">
                  渲染与工程精修均可直接使用内置引擎。
                </p>
                {!local.executablePath.trim() && engine && !engine.available ? (
                  <p className="white-model-studio__hint">
                    内置引擎无法启动，请修复安装包或重新安装应用。
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={detecting}
                  onClick={() => {
                    void detectEngine();
                  }}
                >
                  {detecting
                    ? "正在检查…"
                    : local.executablePath.trim()
                      ? "重新检查外部引擎"
                      : "重新检查内置引擎"}
                </button>
                <details
                  className="white-model-studio__advanced"
                  open={advancedEngineOpen}
                  onToggle={(event) => setAdvancedEngineOpen(event.currentTarget.open)}
                >
                  <summary>高级设置：使用外部 Blender（可选）</summary>
                  {advancedEngineOpen ? (
                    <div className="white-model-studio__advanced-body">
                      <p className="white-model-studio__hint">
                        仅在需要指定其他版本时使用。留空即使用应用内置版本。
                      </p>
                      <label className="white-model-studio__field">
                        <span>外部 Blender 路径</span>
                        <input
                          value={local.executablePath}
                          disabled={locked}
                          placeholder="留空使用内置 Blender"
                          onChange={(event) => updateDraft({ executablePath: event.target.value })}
                        />
                      </label>
                      <div className="white-model-studio__actions">
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            void chooseFile("engine");
                          }}
                        >
                          选择外部 Blender
                        </button>
                        {local.executablePath.trim() ? (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              commitNow({ ...localRef.current, executablePath: "" });
                              void detectEngine("");
                            }}
                          >
                            恢复使用内置引擎
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </details>
              </div>
            </details>
            )}
          </form>
          {blocking ? (
            error ? (
              <p role="alert" className="white-model-studio__error">
                {error}
              </p>
            ) : null
          ) : (
          <section className="white-model-studio__output" aria-label="白模渲染结果">
            <p className="white-model-studio__hint" role="status">
              {enginePath !== local.executablePath.trim() && engine
                ? "外部程序路径已修改，请重新检查引擎。"
                : engine
                  ? `${engine.message}${engine.version ? ` · ${engine.version}` : ""}`
                  : local.executablePath.trim()
                    ? "正在检查指定的外部 Blender…"
                    : "正在检查内置 Blender…"}
            </p>
            {finished && loadedJob?.videoPath ? (
              <div className="white-model-studio__preview">
                <video
                  controls
                  src={toMediaSrc(loadedJob.videoPath)}
                  poster={loadedJob.previewPath ? toMediaSrc(loadedJob.previewPath) : undefined}
                  aria-label="白模视频预览"
                />
              </div>
            ) : null}
            {restoring ? <p role="status">正在恢复渲染任务…</p> : null}
            {loadedJob ? (
              <div className="white-model-studio__job">
                <p role="status">{loadedJob.message}</p>
                <progress aria-label="白模渲染进度" max={100} value={loadedJob.progress} />
                <small>
                  {loadedJob.width} × {loadedJob.height} · {loadedJob.durationSeconds} 秒 ·{" "}
                  {Math.round(loadedJob.progress)}%
                </small>
                {loadedJob.error ? (
                  <p role="alert" className="white-model-studio__error">
                    {loadedJob.error}
                  </p>
                ) : null}
                {loadedJob.status === "cancelled" ? (
                  <p>渲染已取消，可以调整设置后重新渲染。</p>
                ) : null}
                {loadedJob.status === "failed" ? <p>已保留草稿，可以重新渲染。</p> : null}
              </div>
            ) : null}
            {pollError ? (
              <div role="alert" className="white-model-studio__error">
                <p>读取任务失败：{pollError}</p>
                <button type="button" onClick={() => setPollVersion((version) => version + 1)}>
                  重试读取任务
                </button>
              </div>
            ) : null}
            {activeJob(loadedJob) || restoring ? (
              <>
                <p className="white-model-studio__hint">
                  关闭导演台后继续渲染；再次打开可恢复查看进度。
                </p>
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => {
                    void cancelRender();
                  }}
                >
                  {cancelling ? "正在取消…" : "取消渲染"}
                </button>
              </>
            ) : null}
            {finished && !signatureMatches ? (
              <p role="status" className="white-model-studio__hint">
                设置已修改，当前预览属于上次渲染。请重新渲染后使用视频。
              </p>
            ) : null}
            {finished && loadedJob?.projectPath ? (
              <div className="white-model-studio__project">
                <strong>继续专业精修</strong>
                <p className="white-model-studio__hint">
                  在 Blender 中编辑角色、动画与相机，保存工程后将它设为渲染源。
                </p>
                <div className="white-model-studio__actions">
                  <button
                    type="button"
                    disabled={opening || using}
                    onClick={() => {
                      void openProject(loadedJob.projectPath!);
                    }}
                  >
                    {opening ? "正在打开…" : "在 Blender 中精修工程"}
                  </button>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() =>
                      commitNow({
                        ...localRef.current,
                        mode: "blend",
                        sourceBlendPath: loadedJob.projectPath!,
                        jobInputSignature: "",
                      })
                    }
                  >
                    将此工程设为下次渲染源
                  </button>
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="white-model-studio__error">
                {error}
              </p>
            ) : null}
          </section>
          )}
        </aside>
      </div>
      <footer className="white-model-studio__footer">
        {blocking ? (
          <>
            <p>
              导出站位图后，会把场景图、站位图和角色参考连回当前图片节点，并按假人编号写好多参考提示词。
            </p>
            <div className="white-model-studio__actions">
              <button
                type="submit"
                form={formId}
                className="white-model-studio__primary"
                disabled={locked || Boolean(sceneIssue)}
              >
                {using ? "正在导出…" : "导出站位图"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              预览与成片共用同一份逐帧数据；应用已内置 Blender，无需另行安装或下载。使用视频后可继续配置角色映射。
            </p>
            <div className="white-model-studio__actions">
              <button
                type="submit"
                form={formId}
                disabled={locked || !engineReady || Boolean(sceneIssue)}
              >
                {starting
                  ? "正在创建任务…"
                  : finished || loadedJob?.status === "failed" || loadedJob?.status === "cancelled"
                    ? "重新渲染白模"
                    : "渲染白模视频"}
              </button>
              <button
                type="button"
                className="white-model-studio__primary"
                disabled={!finished || !signatureMatches || locked}
                onClick={() => {
                  void handleUseVideo();
                }}
              >
                {using ? "正在加入画布…" : "使用白模视频"}
              </button>
            </div>
          </>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
