import { useSyncExternalStore } from "react";

/**
 * 导演台的播放时钟：视口在 requestAnimationFrame 里直接读它，不经过 React 重渲染；
 * 需要显示时间的组件用 `usePlaybackClock` 订阅。
 */
export class PlaybackClock {
  private time = 0;
  private duration: number;
  private playing = false;
  private frame: number | null = null;
  private lastTimestamp: number | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: { readonly time: number; readonly playing: boolean; readonly duration: number };

  constructor(duration: number) {
    this.duration = Math.max(0.01, duration);
    this.snapshot = { time: 0, playing: false, duration: this.duration };
  }

  get(): number {
    return this.time;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getDuration(): number {
    return this.duration;
  }

  getSnapshot = () => this.snapshot;

  setDuration(duration: number): void {
    this.duration = Math.max(0.01, duration);
    if (this.time > this.duration) this.time = this.duration;
    this.emit();
  }

  set(time: number): void {
    const next = Math.min(this.duration, Math.max(0, time));
    if (next === this.time) return;
    this.time = next;
    this.emit();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTimestamp = null;
    this.frame = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private readonly tick = (timestamp: number) => {
    if (!this.playing) return;
    if (this.lastTimestamp != null) {
      const elapsed = (timestamp - this.lastTimestamp) / 1000;
      let next = this.time + elapsed;
      if (next >= this.duration) next -= this.duration;
      this.time = Math.max(0, next);
      this.emit();
    }
    this.lastTimestamp = timestamp;
    this.frame = requestAnimationFrame(this.tick);
  };

  private emit(): void {
    this.snapshot = { time: this.time, playing: this.playing, duration: this.duration };
    for (const listener of this.listeners) listener();
  }
}

export function usePlaybackClock(clock: PlaybackClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
