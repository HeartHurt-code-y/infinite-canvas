import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { toMediaSrc } from "../../lib/backend";
import {
  cancelBlenderRender,
  createWhiteModelObject,
  getBlenderEngine,
  getBlenderRender,
  openBlenderProject,
  startBlenderRender,
  whiteModelRenderRequest,
  whiteModelRenderSignature,
  type BlenderEngineStatus,
  type BlenderRenderJob,
  type WhiteModelObject,
  type WhiteModelScenePlan,
  type WhiteModelStudioDraft,
  type WhiteModelVector,
} from "../../lib/whiteModelStudio";
import "./WhiteModelStudioDialog.css";

export interface WhiteModelStudioDialogProps {
  readonly draft: WhiteModelStudioDraft;
  readonly onDraftChange: (draft: WhiteModelStudioDraft) => void;
  readonly onClose: () => void;
  readonly onUse: (job: BlenderRenderJob) => Promise<void> | void;
}

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

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = "any",
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number | "any";
}) {
  const [editingValue, setEditingValue] = useState<string | null>(null);
  return (
    <label className="white-model-studio__field">
      <span>{label}</span>
      <input
        type="number"
        required
        value={editingValue ?? value}
        min={min}
        max={max}
        step={step}
        onBlur={() => setEditingValue(null)}
        onChange={(event) => {
          setEditingValue(event.target.value);
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function VectorFields({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: WhiteModelVector;
  readonly onChange: (value: WhiteModelVector) => void;
}) {
  return (
    <div className="white-model-studio__vector">
      {["X", "Y", "Z"].map((axis, index) => (
        <NumberField
          key={axis}
          label={`${label} ${axis}`}
          value={value[index]!}
          min={-100}
          max={100}
          onChange={(next) => {
            const vector: WhiteModelVector = [...value];
            vector[index] = next;
            onChange(vector);
          }}
        />
      ))}
    </div>
  );
}

function pathIssue(plan: WhiteModelScenePlan): string | null {
  if (!plan.objects.length) return "请添加至少一个角色或几何体。";
  for (const actor of plan.objects) {
    if (
      !actor.keyframes.length ||
      actor.keyframes.some(
        (frame, index) =>
          frame.time < 0 ||
          frame.time > plan.durationSeconds ||
          (index > 0 && frame.time <= actor.keyframes[index - 1]!.time),
      )
    ) {
      return `「${actor.name}」的路径时间必须递增，并且位于 0 至 ${plan.durationSeconds} 秒之间。`;
    }
  }
  return null;
}

/** A native modal over a durable local job. Closing stops polling, never the render itself. */
export function WhiteModelStudioDialog({
  draft,
  onDraftChange,
  onClose,
  onUse,
}: WhiteModelStudioDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const formId = useId();
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
    Boolean(draft.executablePath.trim()),
  );
  const engineRequestId = useRef(0);
  const initialPath = useRef(draft.executablePath);
  const loadedJob = job?.jobId === draft.jobId ? job : null;
  const restoring = Boolean(draft.jobId) && loadedJob == null;
  const rendering = starting || restoring || activeJob(loadedJob);
  const locked = rendering || using;
  const signatureMatches = draft.jobInputSignature === whiteModelRenderSignature(draft);
  const finished = loadedJob?.status === "succeeded" && Boolean(loadedJob.videoPath);
  const sceneIssue = draft.mode === "create" ? pathIssue(draft.plan) : null;
  const engineReady = engine?.available && enginePath === draft.executablePath.trim();

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
    let alive = true;
    const requestId = ++engineRequestId.current;
    void getBlenderEngine(initialPath.current)
      .then((result) => {
        if (alive && requestId === engineRequestId.current) {
          setEngine(result);
          setEnginePath(initialPath.current.trim());
        }
      })
      .catch((cause: unknown) => {
        if (alive)
          setError(
            initialPath.current.trim()
              ? errorMessage(cause)
              : `内置 Blender 检查失败：${errorMessage(cause)} 请修复安装包或重新安装应用。`,
          );
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!draft.jobId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const jobId = draft.jobId;
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
  }, [draft.jobId, pollVersion]);

  const updateDraft = (patch: Partial<WhiteModelStudioDraft>) =>
    onDraftChange({ ...draft, ...patch });
  const updatePlan = (patch: Partial<WhiteModelScenePlan>) =>
    updateDraft({ plan: { ...draft.plan, ...patch } });
  const updateCamera = (patch: Partial<WhiteModelScenePlan["camera"]>) =>
    updatePlan({ camera: { ...draft.plan.camera, ...patch } });
  const updateActor = (id: string, patch: Partial<WhiteModelObject>) =>
    updatePlan({
      objects: draft.plan.objects.map((actor) =>
        actor.id === id ? { ...actor, ...patch } : actor,
      ),
    });
  const detectEngine = async (path = draft.executablePath) => {
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
        updateDraft({ executablePath: selected });
        await detectEngine(selected);
      } else updateDraft({ mode: "blend", sourceBlendPath: selected });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const startRender = async () => {
    if (locked || !engineReady || sceneIssue) return;
    const snapshot = structuredClone(draft);
    const signature = whiteModelRenderSignature(snapshot);
    setStarting(true);
    setError(null);
    setPollError(null);
    try {
      const created = await startBlenderRender(whiteModelRenderRequest(snapshot));
      // Keep the job ID with its frozen request before allowing the dialog to close.
      onDraftChange({ ...snapshot, jobId: created.jobId, jobInputSignature: signature });
      setJob(created);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  };
  const cancelRender = async () => {
    if (!draft.jobId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      setJob(await cancelBlenderRender(draft.jobId));
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
      await openBlenderProject(draft.executablePath.trim() || null, path);
      if (draft.mode === "blend" && draft.sourceBlendPath === path && draft.jobId) {
        updateDraft({ jobInputSignature: "" });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  };
  const handleUseVideo = async () => {
    if (!loadedJob || !finished || !signatureMatches || using) return;
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
  const ratio = `${draft.plan.width}:${draft.plan.height}`;
  const ratios = [
    { value: "960:540", label: "16:9 · 横屏" },
    { value: "540:960", label: "9:16 · 竖屏" },
    { value: "768:768", label: "1:1 · 方形" },
    { value: "960:720", label: "4:3 · 横屏" },
  ];

  return createPortal(
    <dialog
      ref={dialogRef}
      className="white-model-studio"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!starting && !using) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          if (!starting && !using) onClose();
        }
        if (event.key === "Tab") {
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
          <h2 id={titleId}>白模工作室</h2>
          <p>安排角色走位与镜头，渲染白模视频后用于专业级白模控制。</p>
        </div>
        <button type="button" onClick={onClose} disabled={starting || using}>
          关闭工作室
        </button>
      </header>
      <div className="white-model-studio__layout">
        <form
          id={formId}
          className="white-model-studio__settings"
          onSubmit={(event) => {
            event.preventDefault();
            void startRender();
          }}
        >
          <fieldset disabled={locked} className="white-model-studio__section">
            <legend>渲染引擎</legend>
            <p className="white-model-studio__hint">
              应用已内置 Blender，无需另行安装或下载。渲染与工程精修均可直接使用内置引擎。
            </p>
            <p className="white-model-studio__hint" role="status">
              {enginePath !== draft.executablePath.trim() && engine
                ? "外部程序路径已修改，请重新检查引擎。"
                : engine
                  ? `${engine.message}${engine.version ? ` · ${engine.version}` : ""}`
                  : draft.executablePath.trim()
                    ? "正在检查指定的外部 Blender…"
                    : "正在检查内置 Blender…"}
            </p>
            {!draft.executablePath.trim() && engine && !engine.available ? (
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
                : draft.executablePath.trim()
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
                      value={draft.executablePath}
                      placeholder="留空使用内置 Blender"
                      onChange={(event) => updateDraft({ executablePath: event.target.value })}
                    />
                  </label>
                  <div className="white-model-studio__actions">
                    <button
                      type="button"
                      onClick={() => {
                        void chooseFile("engine");
                      }}
                    >
                      选择外部 Blender
                    </button>
                    {draft.executablePath.trim() ? (
                      <button
                        type="button"
                        onClick={() => {
                          updateDraft({ executablePath: "" });
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
          </fieldset>
          <fieldset disabled={locked} className="white-model-studio__section">
            <legend>场景来源与输出</legend>
            <label className="white-model-studio__field">
              <span>场景来源</span>
              <select
                value={draft.mode}
                onChange={(event) =>
                  updateDraft({ mode: event.target.value === "blend" ? "blend" : "create" })
                }
              >
                <option value="create">在工作室搭建白模</option>
                <option value="blend">渲染 Blender 工程</option>
              </select>
            </label>
            {draft.mode === "blend" ? (
              <>
                <label className="white-model-studio__field">
                  <span>Blender 工程文件</span>
                  <input
                    required
                    value={draft.sourceBlendPath}
                    placeholder="选择 .blend 工程"
                    onChange={(event) => updateDraft({ sourceBlendPath: event.target.value })}
                  />
                </label>
                <div className="white-model-studio__actions">
                  <button
                    type="button"
                    onClick={() => {
                      void chooseFile("blend");
                    }}
                  >
                    导入 .blend 工程
                  </button>
                  <button
                    type="button"
                    disabled={!draft.sourceBlendPath.trim() || opening}
                    onClick={() => {
                      void openProject(draft.sourceBlendPath);
                    }}
                  >
                    打开源工程精修
                  </button>
                </div>
                <p className="white-model-studio__hint">
                  沿用工程里的角色、动画和相机，按下方片长与画幅导出。精修后先在 Blender
                  保存，再重新渲染。
                </p>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void chooseFile("blend");
                }}
              >
                导入已有 .blend 工程
              </button>
            )}
            <div className="white-model-studio__row">
              <NumberField
                label="片长（秒）"
                value={draft.plan.durationSeconds}
                min={4}
                max={30}
                step={0.5}
                onChange={(durationSeconds) => {
                  if (durationSeconds <= 0) return;
                  updatePlan({
                    durationSeconds,
                    objects: draft.plan.objects.map((actor) => ({
                      ...actor,
                      keyframes: actor.keyframes.map((frame) => ({
                        ...frame,
                        time:
                          Math.round(
                            (frame.time / draft.plan.durationSeconds) * durationSeconds * 1000,
                          ) / 1000,
                      })),
                    })),
                  });
                }}
              />
              <NumberField
                label="帧率"
                value={draft.plan.fps}
                min={8}
                max={30}
                step={1}
                onChange={(fps) => updatePlan({ fps })}
              />
              <label className="white-model-studio__field">
                <span>画幅</span>
                <select
                  value={ratio}
                  onChange={(event) => {
                    const [width, height] = event.target.value.split(":").map(Number);
                    if (width && height) updatePlan({ width, height });
                  }}
                >
                  {!ratios.some((option) => option.value === ratio) ? (
                    <option value={ratio}>
                      {draft.plan.width} × {draft.plan.height}
                    </option>
                  ) : null}
                  {ratios.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          {draft.mode === "create" ? (
            <>
              <fieldset disabled={locked} className="white-model-studio__section">
                <legend>角色与运动路径</legend>
                <p className="white-model-studio__hint">
                  X、Y 控制地面位置，Z
                  控制高度。朝向以角度表示；不同颜色便于将白模对应到角色或道具。
                </p>
                {draft.plan.objects.map((actor, actorIndex) => (
                  <fieldset className="white-model-studio__actor" key={actor.id}>
                    <legend>角色 {actorIndex + 1}</legend>
                    <div className="white-model-studio__row">
                      <label className="white-model-studio__field">
                        <span>角色名称 {actorIndex + 1}</span>
                        <input
                          required
                          value={actor.name}
                          onChange={(event) => updateActor(actor.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="white-model-studio__field">
                        <span>几何体 {actorIndex + 1}</span>
                        <select
                          value={actor.shape}
                          onChange={(event) =>
                            updateActor(actor.id, {
                              shape: event.target.value as WhiteModelObject["shape"],
                            })
                          }
                        >
                          <option value="person">人形</option>
                          <option value="box">立方体</option>
                          <option value="sphere">球体</option>
                          <option value="cylinder">圆柱体</option>
                        </select>
                      </label>
                      <label className="white-model-studio__field">
                        <span>角色颜色 {actorIndex + 1}</span>
                        <input
                          type="color"
                          value={actor.color}
                          onChange={(event) => updateActor(actor.id, { color: event.target.value })}
                        />
                      </label>
                      <NumberField
                        label={`角色尺寸 ${actorIndex + 1}`}
                        value={actor.size}
                        min={0.1}
                        max={10}
                        onChange={(size) => updateActor(actor.id, { size })}
                      />
                    </div>
                    {actor.keyframes.map((frame, index) => {
                      const label = `角色 ${actorIndex + 1} ${index === 0 ? "起点" : index === actor.keyframes.length - 1 ? "终点" : `路径点 ${index}`}`;
                      const updateFrame = (patch: Partial<WhiteModelObject["keyframes"][number]>) =>
                        updateActor(actor.id, {
                          keyframes: actor.keyframes.map((entry, entryIndex) =>
                            entryIndex === index ? { ...entry, ...patch } : entry,
                          ),
                        });
                      return (
                        <div className="white-model-studio__keyframe" key={index}>
                          <strong>{label}</strong>
                          <div className="white-model-studio__row">
                            <NumberField
                              label={`${label}时间（秒）`}
                              value={frame.time}
                              min={0}
                              max={draft.plan.durationSeconds}
                              onChange={(time) => updateFrame({ time })}
                            />
                            <NumberField
                              label={`${label}朝向（度）`}
                              value={frame.yaw}
                              min={-3600}
                              max={3600}
                              onChange={(yaw) => updateFrame({ yaw })}
                            />
                          </div>
                          <VectorFields
                            label={label}
                            value={frame.position}
                            onChange={(position) => updateFrame({ position })}
                          />
                          {index > 0 && index < actor.keyframes.length - 1 ? (
                            <button
                              type="button"
                              onClick={() =>
                                updateActor(actor.id, {
                                  keyframes: actor.keyframes.filter(
                                    (_, entryIndex) => entryIndex !== index,
                                  ),
                                })
                              }
                            >
                              移除角色 {actorIndex + 1} 路径点 {index}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="white-model-studio__actions">
                      <button
                        type="button"
                        onClick={() => {
                          const frames = [...actor.keyframes];
                          const last = frames.at(-1)!;
                          const previous = frames.at(-2) ?? { ...last, time: 0 };
                          const time = (previous.time + last.time) / 2;
                          if (time <= previous.time || time >= last.time) return;
                          frames.splice(frames.length - 1, 0, {
                            time,
                            position: last.position.map(
                              (position, index) => (position + previous.position[index]!) / 2,
                            ) as WhiteModelVector,
                            yaw: (previous.yaw + last.yaw) / 2,
                          });
                          updateActor(actor.id, { keyframes: frames });
                        }}
                      >
                        添加角色 {actorIndex + 1} 路径点
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updatePlan({
                            objects: draft.plan.objects.filter((entry) => entry.id !== actor.id),
                          })
                        }
                      >
                        移除角色 {actorIndex + 1}
                      </button>
                    </div>
                  </fieldset>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    updatePlan({
                      objects: [
                        ...draft.plan.objects,
                        createWhiteModelObject(
                          draft.plan.objects.length,
                          draft.plan.durationSeconds,
                        ),
                      ],
                    })
                  }
                >
                  添加角色或几何体
                </button>
                {sceneIssue ? (
                  <p className="white-model-studio__error" role="alert">
                    {sceneIssue}
                  </p>
                ) : null}
              </fieldset>
              <fieldset disabled={locked} className="white-model-studio__section">
                <legend>相机与运镜</legend>
                <label className="white-model-studio__field">
                  <span>相机运动</span>
                  <select
                    value={draft.plan.camera.motion}
                    onChange={(event) =>
                      updateCamera({
                        motion: event.target.value as WhiteModelScenePlan["camera"]["motion"],
                      })
                    }
                  >
                    <option value="static">固定镜头</option>
                    <option value="dolly">推拉镜头</option>
                    <option value="truck">横移跟拍</option>
                    <option value="orbit">环绕目标</option>
                  </select>
                </label>
                <VectorFields
                  label="相机起点"
                  value={draft.plan.camera.start}
                  onChange={(start) => updateCamera({ start })}
                />
                {draft.plan.camera.motion !== "static" && draft.plan.camera.motion !== "orbit" ? (
                  <VectorFields
                    label="相机终点"
                    value={draft.plan.camera.end}
                    onChange={(end) => updateCamera({ end })}
                  />
                ) : null}
                <VectorFields
                  label="相机注视点"
                  value={draft.plan.camera.target}
                  onChange={(target) => updateCamera({ target })}
                />
                <div className="white-model-studio__row">
                  <NumberField
                    label="镜头焦距（毫米）"
                    value={draft.plan.camera.lens}
                    min={10}
                    max={300}
                    step={1}
                    onChange={(lens) => updateCamera({ lens })}
                  />
                  {draft.plan.camera.motion === "orbit" ? (
                    <NumberField
                      label="环绕角度"
                      value={draft.plan.camera.orbitDegrees}
                      min={-3600}
                      max={3600}
                      step={1}
                      onChange={(orbitDegrees) => updateCamera({ orbitDegrees })}
                    />
                  ) : null}
                </div>
              </fieldset>
            </>
          ) : null}
        </form>
        <aside className="white-model-studio__output" aria-label="白模渲染结果">
          <div className="white-model-studio__preview">
            {finished && loadedJob?.videoPath ? (
              <video
                controls
                src={toMediaSrc(loadedJob.videoPath)}
                poster={loadedJob.previewPath ? toMediaSrc(loadedJob.previewPath) : undefined}
                aria-label="白模视频预览"
              />
            ) : (
              <div className="white-model-studio__placeholder">
                <strong>白模视频预览</strong>
                <p>设置角色与相机后点击渲染。</p>
              </div>
            )}
          </div>
          {restoring ? <p role="status">正在恢复渲染任务…</p> : null}
          {loadedJob ? (
            <section className="white-model-studio__job">
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
            </section>
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
                关闭工作室后继续渲染；再次打开可恢复查看进度。
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
                  updateDraft({
                    mode: "blend",
                    sourceBlendPath: loadedJob.projectPath!,
                    jobInputSignature: "",
                  })
                }
              >
                将此工程设为下次渲染源
              </button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="white-model-studio__error">
              {error}
            </p>
          ) : null}
        </aside>
      </div>
      <footer className="white-model-studio__footer">
        <p>白模在本机渲染，使用视频后可继续配置角色映射。</p>
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
      </footer>
    </dialog>,
    document.body,
  );
}
