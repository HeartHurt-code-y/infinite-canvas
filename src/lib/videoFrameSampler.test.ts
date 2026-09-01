import { describe, expect, it } from "vitest";
import { videoSamplingTimeline } from "./videoFrameSampler";

describe("videoSamplingTimeline", () => {
  it("densely samples short videos and separately densifies the final five seconds", () => {
    const timeline = videoSamplingTimeline(19.34);
    const overview = timeline.filter((point) => point.phase === "overview");
    const tail = timeline.filter((point) => point.phase === "tail");

    expect(overview[0]?.time).toBe(0);
    expect(overview[1]?.time).toBe(0.5);
    expect(overview.length).toBeGreaterThanOrEqual(39);
    expect(tail[0]?.time).toBeCloseTo(14.34, 2);
    expect(tail[1]!.time - tail[0]!.time).toBeCloseTo(1 / 6, 2);
    expect(tail.at(-1)!.time).toBeCloseTo(19.339, 3);
  });

  it("uses twelve overview frames for long videos while retaining the tail pass", () => {
    const timeline = videoSamplingTimeline(90);
    expect(timeline.filter((point) => point.phase === "overview")).toHaveLength(12);
    expect(timeline.filter((point) => point.phase === "tail").length).toBeGreaterThanOrEqual(30);
  });

  it("rejects invalid durations", () => {
    expect(videoSamplingTimeline(0)).toEqual([]);
    expect(videoSamplingTimeline(Number.NaN)).toEqual([]);
  });
});
