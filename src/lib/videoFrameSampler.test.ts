import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVideoContactSheets, videoSamplingTimeline } from "./videoFrameSampler";

afterEach(() => vi.restoreAllMocks());

it("pauses during video loading and releases the decoder without waiting for its timeout", async () => {
  const video = document.createElement("video");
  const create = vi.spyOn(document, "createElement").mockReturnValue(video);
  const load = vi.spyOn(video, "load").mockImplementation(() => undefined);
  const controller = new AbortController();
  const pending = buildVideoContactSheets("/reference.mp4", controller.signal);
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(create).toHaveBeenCalledWith("video");
  expect(video).not.toHaveAttribute("src");
  expect(load).toHaveBeenCalledTimes(2);
});

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
