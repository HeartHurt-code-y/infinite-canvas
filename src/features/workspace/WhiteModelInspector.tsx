import { useState } from "react";
import {
  CAMERA_MOVES,
  POSE_PRESETS,
  SHOT_ANGLES,
  SHOT_DIRECTIONS,
  SHOT_SIZES,
  actorHeight,
  cameraKeyframeFromWorld,
  cameraMoveKeyframes,
  convertCameraFollow,
  evaluateActor,
  evaluateCamera,
  rescalePlanDuration,
  roundTo,
  solveShot,
  upsertKeyframe,
  type CameraMovePreset,
  type ShotAngle,
  type ShotDirection,
  type ShotSize,
  type WhiteModelObject,
  type WhiteModelScenePlan,
  type WhiteModelVector,
} from "../../lib/whiteModelScene";
import { createWhiteModelObject } from "../../lib/whiteModelStudio";
import type { PlaybackClock } from "./whiteModelPlayback";

export interface MotionCaptureState {
  readonly actorId: string;
  readonly progress: number;
  readonly message: string;
}

export interface WhiteModelInspectorProps {
  readonly plan: WhiteModelScenePlan;
  readonly clock: PlaybackClock;
  readonly locked: boolean;
  readonly selectedActorId: string | null;
  readonly onSelectActor: (actorId: string | null) => void;
  readonly onPlanChange: (plan: WhiteModelScenePlan) => void;
  readonly capture: MotionCaptureState | null;
  readonly captureAvailable: boolean;
  readonly onCaptureMotion: (actorId: string) => void;
  readonly onCancelCapture: () => void;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = "any",
  disabled = false,
  compact,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number | "any";
  readonly disabled?: boolean;
  readonly compact?: boolean;
}) {
  const [editingValue, setEditingValue] = useState<string | null>(null);
  return (
    <label className={`white-model-studio__field${compact ? " white-model-studio__field--compact" : ""}`}>
      <span>{label}</span>
      <input
        type="number"
        required
        value={editingValue ?? String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
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
  axes = ["X", "Y", "Z"],
  disabled = false,
}: {
  readonly label: string;
  readonly value: WhiteModelVector;
  readonly onChange: (value: WhiteModelVector) => void;
  readonly axes?: readonly string[];
  readonly disabled?: boolean;
}) {
  return (
    <div className="white-model-studio__vector">
      {axes.map((axis, index) => (
        <NumberField
          key={axis}
          compact
          label={`${label} ${axis}`}
          value={roundTo(value[index]!, 3)}
          min={-100}
          max={100}
          step="any"
          disabled={disabled}
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

const RATIOS = [
  { value: "960:540", label: "16:9 · 横屏" },
  { value: "540:960", label: "9:16 · 竖屏" },
  { value: "768:768", label: "1:1 · 方形" },
  { value: "960:720", label: "4:3 · 横屏" },
];

/** 右侧检查器：角色、机位、输出与镜头语言预设；所有修改都产出新的方案对象。 */
export function WhiteModelInspector({
  plan,
  clock,
  locked,
  selectedActorId,
  onSelectActor,
  onPlanChange,
  capture,
  captureAvailable,
  onCaptureMotion,
  onCancelCapture,
}: WhiteModelInspectorProps) {
  const [shotSize, setShotSize] = useState<ShotSize>("medium");
  const [shotAngle, setShotAngle] = useState<ShotAngle>("eye");
  const [shotDirection, setShotDirection] = useState<ShotDirection>("front_left");
  const selected = plan.objects.find((actor) => actor.id === selectedActorId) ?? null;
  const subject = selected ?? plan.objects[0] ?? null;
  const time = () => clock.get();

  const updatePlan = (patch: Partial<WhiteModelScenePlan>) => onPlanChange({ ...plan, ...patch });
  const updateCamera = (patch: Partial<WhiteModelScenePlan["camera"]>) =>
    updatePlan({ camera: { ...plan.camera, ...patch } });
  const updateActor = (id: string, patch: Partial<WhiteModelObject>) =>
    updatePlan({
      objects: plan.objects.map((actor) => (actor.id === id ? { ...actor, ...patch } : actor)),
    });
  const addActor = (shape: WhiteModelObject["shape"]) => {
    const actor = createWhiteModelObject(plan.objects.length, plan.durationSeconds, shape);
    updatePlan({ objects: [...plan.objects, actor] });
    onSelectActor(actor.id);
  };
  const removeActor = (id: string) => {
    const objects = plan.objects.filter((actor) => actor.id !== id);
    const follow = plan.camera.follow?.actorId === id ? null : plan.camera.follow;
    onPlanChange({
      ...plan,
      objects,
      camera: follow === plan.camera.follow ? plan.camera : convertCameraFollow(plan, null),
    });
    onSelectActor(objects[0]?.id ?? null);
  };
  const applyShot = () => {
    if (!subject) return;
    const now = time();
    const state = evaluateActor(subject, now);
    const shot = solveShot(
      {
        position: state.position,
        yaw: state.yaw,
        height: actorHeight(subject),
        isPerson: subject.shape === "person",
      },
      { size: shotSize, angle: shotAngle, direction: shotDirection },
      plan.camera.lens,
      plan.width / plan.height,
    );
    updateCamera({
      keyframes: upsertKeyframe(plan.camera.keyframes, now, plan.fps, () =>
        cameraKeyframeFromWorld(plan, now, shot),
      ),
    });
  };
  const applyMove = (move: CameraMovePreset) => {
    const now = time();
    const base = evaluateCamera(plan, now);
    const keyframes = cameraMoveKeyframes(base, move, plan.durationSeconds).map((frame) =>
      cameraKeyframeFromWorld(plan, frame.time, frame),
    );
    updateCamera({ keyframes });
  };
  const jump = (value: number) => {
    clock.pause();
    clock.set(value);
  };

  return (
    <div className="white-model-inspector">
      <fieldset disabled={locked} className="white-model-studio__section">
        <legend>角色</legend>
        <div className="white-model-inspector__chips" role="group" aria-label="角色列表">
          {plan.objects.map((actor) => (
            <button
              type="button"
              key={actor.id}
              className={`white-model-inspector__chip${actor.id === selectedActorId ? " white-model-inspector__chip--active" : ""}`}
              aria-pressed={actor.id === selectedActorId}
              onClick={() => onSelectActor(actor.id)}
            >
              <span className="white-model-inspector__swatch" style={{ background: actor.color }} />
              {actor.name}
            </button>
          ))}
        </div>
        <div className="white-model-studio__actions">
          <button type="button" onClick={() => addActor("person")}>
            ＋ 人形
          </button>
          <button type="button" onClick={() => addActor("box")}>
            ＋ 几何体
          </button>
        </div>
        {selected ? (
          <ActorPanel
            key={selected.id}
            plan={plan}
            actor={selected}
            onChange={(patch) => updateActor(selected.id, patch)}
            onRemove={() => removeActor(selected.id)}
            onJump={jump}
            capture={capture?.actorId === selected.id ? capture : null}
            captureAvailable={captureAvailable}
            captureBusy={capture != null}
            onCaptureMotion={() => onCaptureMotion(selected.id)}
            onCancelCapture={onCancelCapture}
          />
        ) : (
          <p className="white-model-studio__hint">在视口里点击角色，或在上方选择要编辑的角色。</p>
        )}
      </fieldset>

      <fieldset disabled={locked} className="white-model-studio__section">
        <legend>机位</legend>
        <div className="white-model-studio__row">
          <NumberField
            label="焦距（毫米）"
            value={plan.camera.lens}
            min={10}
            max={300}
            step={1}
            onChange={(lens) => updateCamera({ lens })}
          />
          <label className="white-model-studio__field">
            <span>机位过渡</span>
            <select
              value={plan.camera.interpolation}
              onChange={(event) =>
                updateCamera({
                  interpolation: event.target.value === "smooth" ? "smooth" : "linear",
                })
              }
            >
              <option value="smooth">缓入缓出</option>
              <option value="linear">匀速</option>
            </select>
          </label>
        </div>
        <div className="white-model-studio__actions white-model-inspector__lenses" role="group" aria-label="常用焦距">
          {[24, 35, 50, 85].map((lens) => (
            <button
              type="button"
              key={lens}
              className={plan.camera.lens === lens ? "white-model-inspector__chip--active" : undefined}
              onClick={() => updateCamera({ lens })}
            >
              {lens}mm
            </button>
          ))}
        </div>
        <div className="white-model-studio__row">
          <label className="white-model-studio__field">
            <span>跟随角色</span>
            <select
              value={plan.camera.follow?.mode ?? "none"}
              onChange={(event) => {
                const mode = event.target.value;
                const actorId = plan.camera.follow?.actorId ?? subject?.id;
                updatePlan({
                  camera: convertCameraFollow(
                    plan,
                    mode === "none" || !actorId
                      ? null
                      : { actorId, mode: mode === "track" ? "track" : "aim" },
                  ),
                });
              }}
            >
              <option value="none">不跟随</option>
              <option value="aim">对准角色（机位固定）</option>
              <option value="track">跟拍角色（机位随行）</option>
            </select>
          </label>
          {plan.camera.follow ? (
            <label className="white-model-studio__field">
              <span>跟随对象</span>
              <select
                value={plan.camera.follow.actorId}
                onChange={(event) =>
                  updatePlan({
                    camera: convertCameraFollow(plan, {
                      actorId: event.target.value,
                      mode: plan.camera.follow!.mode,
                    }),
                  })
                }
              >
                {plan.objects.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="white-model-inspector__group">
          <strong>取景（以{subject ? `「${subject.name}」` : "所选角色"}为主体）</strong>
          <div className="white-model-studio__row">
            <label className="white-model-studio__field">
              <span>景别</span>
              <select value={shotSize} onChange={(event) => setShotSize(event.target.value as ShotSize)}>
                {SHOT_SIZES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="white-model-studio__field">
              <span>角度</span>
              <select value={shotAngle} onChange={(event) => setShotAngle(event.target.value as ShotAngle)}>
                {SHOT_ANGLES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="white-model-studio__field">
              <span>方位</span>
              <select
                value={shotDirection}
                onChange={(event) => setShotDirection(event.target.value as ShotDirection)}
              >
                {SHOT_DIRECTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" disabled={!subject} onClick={applyShot}>
            按景别取景（写入当前时间的机位关键帧）
          </button>
        </div>

        <div className="white-model-inspector__group">
          <strong>运镜（以当前画面为基准，生成整段机位）</strong>
          <div className="white-model-studio__actions">
            {CAMERA_MOVES.map((move) => (
              <button type="button" key={move.value} onClick={() => applyMove(move.value)}>
                {move.label}
              </button>
            ))}
          </div>
          <p className="white-model-studio__hint">
            机位视角里：左键拖动环绕主体，右键拖动摇镜，Shift+拖动平移，滚轮推拉；每次操作都会写入当前时间的机位关键帧。
          </p>
        </div>

        <details className="white-model-inspector__keyframes">
          <summary>机位关键帧（{plan.camera.keyframes.length}）</summary>
          {plan.camera.keyframes.map((frame, index) => (
            <div className="white-model-studio__keyframe" key={index}>
              <div className="white-model-studio__keyframe-head">
                <strong>机位 {index + 1}</strong>
                <button type="button" onClick={() => jump(frame.time)}>
                  定位
                </button>
                {plan.camera.keyframes.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateCamera({
                        keyframes: plan.camera.keyframes.filter((_, entry) => entry !== index),
                      })
                    }
                  >
                    删除
                  </button>
                ) : null}
              </div>
              <div className="white-model-studio__row">
                <NumberField
                  compact
                  label={`机位 ${index + 1} 时间（秒）`}
                  value={frame.time}
                  min={0}
                  max={plan.durationSeconds}
                  step="any"
                  onChange={(value) =>
                    updateCamera({
                      keyframes: plan.camera.keyframes.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, time: value } : entry,
                      ),
                    })
                  }
                />
              </div>
              <VectorFields
                label={plan.camera.follow?.mode === "track" ? `机位 ${index + 1} 相对位置` : `机位 ${index + 1} 位置`}
                value={frame.position}
                onChange={(position) =>
                  updateCamera({
                    keyframes: plan.camera.keyframes.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, position } : entry,
                    ),
                  })
                }
              />
              {plan.camera.follow?.mode !== "aim" ? (
                <VectorFields
                  label={`机位 ${index + 1} 注视点`}
                  value={frame.target}
                  onChange={(target) =>
                    updateCamera({
                      keyframes: plan.camera.keyframes.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, target } : entry,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
          ))}
        </details>
      </fieldset>

      <fieldset disabled={locked} className="white-model-studio__section">
        <legend>输出</legend>
        <div className="white-model-studio__row">
          <NumberField
            label="片长（秒）"
            value={plan.durationSeconds}
            min={1}
            max={30}
            step={0.5}
            onChange={(durationSeconds) => {
              if (durationSeconds <= 0 || durationSeconds > 30) return;
              onPlanChange(rescalePlanDuration(plan, durationSeconds));
              clock.setDuration(durationSeconds);
            }}
          />
          <NumberField
            label="帧率"
            value={plan.fps}
            min={8}
            max={30}
            step={1}
            onChange={(fps) => updatePlan({ fps })}
          />
          <label className="white-model-studio__field">
            <span>画幅</span>
            <select
              value={`${plan.width}:${plan.height}`}
              onChange={(event) => {
                const [width, height] = event.target.value.split(":").map(Number);
                if (width && height) updatePlan({ width, height });
              }}
            >
              {!RATIOS.some((option) => option.value === `${plan.width}:${plan.height}`) ? (
                <option value={`${plan.width}:${plan.height}`}>
                  {plan.width} × {plan.height}
                </option>
              ) : null}
              {RATIOS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
    </div>
  );
}

function ActorPanel({
  plan,
  actor,
  onChange,
  onRemove,
  onJump,
  capture,
  captureAvailable,
  captureBusy,
  onCaptureMotion,
  onCancelCapture,
}: {
  readonly plan: WhiteModelScenePlan;
  readonly actor: WhiteModelObject;
  readonly onChange: (patch: Partial<WhiteModelObject>) => void;
  readonly onRemove: () => void;
  readonly onJump: (time: number) => void;
  readonly capture: MotionCaptureState | null;
  readonly captureAvailable: boolean;
  readonly captureBusy: boolean;
  readonly onCaptureMotion: () => void;
  readonly onCancelCapture: () => void;
}) {
  const isPerson = actor.shape === "person";
  const motionKind = actor.motion.kind;
  const clip = actor.motion.kind === "clip" ? actor.motion : null;
  return (
    <div className="white-model-inspector__actor">
      <div className="white-model-studio__row">
        <label className="white-model-studio__field">
          <span>角色名称</span>
          <input required value={actor.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="white-model-studio__field">
          <span>几何体</span>
          <select
            value={actor.shape}
            onChange={(event) => {
              const shape = event.target.value as WhiteModelObject["shape"];
              const wasPerson = actor.shape === "person";
              onChange({
                shape,
                size:
                  shape === "person" && !wasPerson ? 1.75 : shape !== "person" && wasPerson ? 1 : actor.size,
              });
            }}
          >
            <option value="person">人形</option>
            <option value="box">立方体</option>
            <option value="sphere">球体</option>
            <option value="cylinder">圆柱体</option>
          </select>
        </label>
        <label className="white-model-studio__field">
          <span>颜色</span>
          <input type="color" value={actor.color} onChange={(event) => onChange({ color: event.target.value })} />
        </label>
        <NumberField
          label={isPerson ? "身高（米）" : "尺寸（米）"}
          value={actor.size}
          min={0.1}
          max={10}
          step={0.05}
          onChange={(size) => onChange({ size })}
        />
      </div>
      <div className="white-model-studio__row">
        <label className="white-model-studio__field">
          <span>朝向</span>
          <select
            value={actor.facing}
            onChange={(event) => onChange({ facing: event.target.value === "manual" ? "manual" : "path" })}
          >
            <option value="path">自动面向行进方向</option>
            <option value="manual">手动（拖动朝向手柄）</option>
          </select>
        </label>
        {isPerson ? (
          <label className="white-model-studio__field">
            <span>动作来源</span>
            <select
              value={motionKind}
              onChange={(event) => {
                const kind = event.target.value;
                if (kind === "pose") onChange({ motion: { kind: "pose", pose: "stand" } });
                else if (kind === "auto") onChange({ motion: { kind: "auto" } });
              }}
            >
              <option value="auto">自动走位（站立/行走/奔跑）</option>
              <option value="pose">姿势预设</option>
              <option value="clip" disabled={!clip}>
                视频动捕{clip ? `（${clip.clip.sourceName}）` : "（先捕捉）"}
              </option>
            </select>
          </label>
        ) : null}
      </div>
      {isPerson && actor.motion.kind === "pose" ? (
        <div className="white-model-studio__actions">
          {POSE_PRESETS.map((pose) => (
            <button
              type="button"
              key={pose.value}
              className={
                actor.motion.kind === "pose" && actor.motion.pose === pose.value
                  ? "white-model-inspector__chip--active"
                  : undefined
              }
              onClick={() => onChange({ motion: { kind: "pose", pose: pose.value } })}
            >
              {pose.label}
            </button>
          ))}
        </div>
      ) : null}
      {isPerson ? (
        <div className="white-model-inspector__group">
          <div className="white-model-studio__actions">
            <button
              type="button"
              disabled={captureBusy || !captureAvailable}
              onClick={onCaptureMotion}
              title={captureAvailable ? "选择一段真人表演视频，一键提取动作驱动白模" : "动作捕捉模型未随应用打包"}
            >
              一键动捕：从视频提取动作…
            </button>
            {capture ? (
              <button type="button" onClick={onCancelCapture}>
                取消捕捉
              </button>
            ) : null}
          </div>
          {capture ? (
            <div className="white-model-studio__job">
              <p role="status">{capture.message}</p>
              <progress aria-label="动作捕捉进度" max={100} value={capture.progress} />
            </div>
          ) : null}
          {clip ? (
            <div className="white-model-studio__row">
              <NumberField
                compact
                label="动作起始（秒）"
                value={clip.startTime}
                min={-30}
                max={30}
                step="any"
                onChange={(startTime) => onChange({ motion: { ...clip, startTime } })}
              />
              <NumberField
                compact
                label="动作速度"
                value={clip.speed}
                min={0.1}
                max={4}
                step={0.1}
                onChange={(speed) => onChange({ motion: { ...clip, speed } })}
              />
              <label className="white-model-studio__field white-model-studio__field--compact">
                <span>循环播放</span>
                <input
                  type="checkbox"
                  checked={clip.loop}
                  onChange={(event) => onChange({ motion: { ...clip, loop: event.target.checked } })}
                />
              </label>
              <p className="white-model-studio__hint">
                {clip.clip.sourceName} · {clip.clip.frameCount} 帧 ·{" "}
                {(clip.clip.frameCount / clip.clip.fps).toFixed(1)} 秒
              </p>
            </div>
          ) : null}
          {!captureAvailable ? (
            <p className="white-model-studio__hint">
              动作捕捉模型未随此构建打包（运行 pnpm pose:prepare 后重新构建即可启用）。
            </p>
          ) : null}
        </div>
      ) : null}
      <details className="white-model-inspector__keyframes" open>
        <summary>
          路径点（{actor.keyframes.length}）· 在视口拖动角色即可在当前时间写入
        </summary>
        {actor.keyframes.map((frame, index) => (
          <div className="white-model-studio__keyframe" key={index}>
            <div className="white-model-studio__keyframe-head">
              <strong>路径点 {index + 1}</strong>
              <button type="button" onClick={() => onJump(frame.time)}>
                定位
              </button>
              {actor.keyframes.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ keyframes: actor.keyframes.filter((_, entry) => entry !== index) })
                  }
                >
                  删除
                </button>
              ) : null}
            </div>
            <div className="white-model-studio__row">
              <NumberField
                compact
                label={`路径点 ${index + 1} 时间（秒）`}
                value={frame.time}
                min={0}
                max={plan.durationSeconds}
                step="any"
                onChange={(value) =>
                  onChange({
                    keyframes: actor.keyframes.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, time: value } : entry,
                    ),
                  })
                }
              />
              {actor.facing === "manual" ? (
                <NumberField
                  compact
                  label={`路径点 ${index + 1} 朝向（度）`}
                  value={frame.yaw}
                  min={-3600}
                  max={3600}
                  step="any"
                  onChange={(yaw) =>
                    onChange({
                      keyframes: actor.keyframes.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, yaw } : entry,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
            <VectorFields
              label={`路径点 ${index + 1}`}
              value={frame.position}
              onChange={(position) =>
                onChange({
                  keyframes: actor.keyframes.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, position } : entry,
                  ),
                })
              }
            />
          </div>
        ))}
      </details>
      <div className="white-model-studio__actions">
        <button type="button" onClick={onRemove}>
          移除「{actor.name}」
        </button>
      </div>
    </div>
  );
}
