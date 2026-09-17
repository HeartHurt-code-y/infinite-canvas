import { nearestKeyframeIndex, type WhiteModelScenePlan } from "../../lib/whiteModelScene";
import { usePlaybackClock, type PlaybackClock } from "./whiteModelPlayback";

export interface WhiteModelTimelineProps {
  readonly clock: PlaybackClock;
  readonly plan: WhiteModelScenePlan;
  readonly selectedActorId: string | null;
  readonly disabled: boolean;
  readonly onAddActorKeyframe: () => void;
  readonly onAddCameraKeyframe: () => void;
  readonly onDeleteKeyframes: () => void;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)} s`;
}

/** 时间轴：播放/暂停、逐关键帧跳转、拖动刮擦；机位与所选角色的关键帧显示为可点击标记。 */
export function WhiteModelTimeline({
  clock,
  plan,
  selectedActorId,
  disabled,
  onAddActorKeyframe,
  onAddCameraKeyframe,
  onDeleteKeyframes,
}: WhiteModelTimelineProps) {
  const { time, playing } = usePlaybackClock(clock);
  const duration = plan.durationSeconds;
  const actor = plan.objects.find((entry) => entry.id === selectedActorId) ?? null;
  const cameraTimes = plan.camera.keyframes.map((frame) => frame.time);
  const actorTimes = actor?.keyframes.map((frame) => frame.time) ?? [];
  const allTimes = [...new Set([...cameraTimes, ...actorTimes])].sort((a, b) => a - b);
  const previous = [...allTimes].reverse().find((value) => value < time - 1e-6);
  const next = allTimes.find((value) => value > time + 1e-6);
  const onCameraKey = nearestKeyframeIndex(plan.camera.keyframes, time, plan.fps) >= 0;
  const onActorKey = actor ? nearestKeyframeIndex(actor.keyframes, time, plan.fps) >= 0 : false;
  const percent = (value: number) => `${(Math.min(duration, Math.max(0, value)) / duration) * 100}%`;

  return (
    <div className="white-model-timeline">
      <div className="white-model-timeline__controls">
        <button
          type="button"
          className="white-model-timeline__play"
          onClick={() => clock.toggle()}
          aria-label={playing ? "暂停预览" : "播放预览"}
          aria-pressed={playing}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          onClick={() => clock.set(previous ?? 0)}
          aria-label="上一个关键帧"
          disabled={previous == null}
        >
          ⏮
        </button>
        <button
          type="button"
          onClick={() => clock.set(next ?? duration)}
          aria-label="下一个关键帧"
          disabled={next == null}
        >
          ⏭
        </button>
        <output className="white-model-timeline__time" aria-live="off">
          {formatSeconds(time)} / {formatSeconds(duration)}
        </output>
        <span className="white-model-timeline__spacer" />
        <button type="button" disabled={disabled || !actor} onClick={onAddActorKeyframe}>
          {onActorKey ? "更新角色关键帧" : "＋ 角色关键帧"}
        </button>
        <button type="button" disabled={disabled} onClick={onAddCameraKeyframe}>
          {onCameraKey ? "更新机位关键帧" : "＋ 机位关键帧"}
        </button>
        <button
          type="button"
          disabled={disabled || (!onCameraKey && !onActorKey)}
          onClick={onDeleteKeyframes}
        >
          删除当前关键帧
        </button>
      </div>
      <div className="white-model-timeline__track">
        <input
          type="range"
          className="white-model-timeline__scrubber"
          aria-label="时间轴"
          min={0}
          max={duration}
          step={1 / plan.fps}
          value={time}
          onChange={(event) => {
            clock.pause();
            clock.set(event.target.valueAsNumber);
          }}
        />
        <div className="white-model-timeline__markers white-model-timeline__markers--camera">
          {plan.camera.keyframes.map((frame, index) => (
            <button
              type="button"
              key={`camera-${index}`}
              className="white-model-timeline__marker white-model-timeline__marker--camera"
              style={{ left: percent(frame.time) }}
              aria-label={`机位关键帧 ${index + 1}：${formatSeconds(frame.time)}`}
              title={`机位关键帧 · ${formatSeconds(frame.time)}`}
              onClick={() => {
                clock.pause();
                clock.set(frame.time);
              }}
            />
          ))}
        </div>
        <div className="white-model-timeline__markers white-model-timeline__markers--actor">
          {actor?.keyframes.map((frame, index) => (
            <button
              type="button"
              key={`actor-${index}`}
              className="white-model-timeline__marker white-model-timeline__marker--actor"
              style={{ left: percent(frame.time), background: actor.color }}
              aria-label={`${actor.name} 路径点 ${index + 1}：${formatSeconds(frame.time)}`}
              title={`${actor.name} · ${formatSeconds(frame.time)}`}
              onClick={() => {
                clock.pause();
                clock.set(frame.time);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
