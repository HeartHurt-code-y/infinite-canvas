import { describe, expect, it } from "vitest";
import { classifyExternalMediaPaths, nativeDropClientPoint } from "./canvasExternalMediaDrop";

describe("external media drop", () => {
  it("converts Tauri physical pixels to DOM client coordinates", () => {
    expect(nativeDropClientPoint({ x: 900, y: 450 }, 1.5)).toEqual({ x: 600, y: 300 });
    expect(nativeDropClientPoint({ x: 140, y: 80 }, 1)).toEqual({ x: 140, y: 80 });
  });

  it("falls back to unit scale when the native scale is invalid", () => {
    expect(nativeDropClientPoint({ x: 140, y: 80 }, 0)).toEqual({ x: 140, y: 80 });
    expect(nativeDropClientPoint({ x: 140, y: 80 }, Number.NaN)).toEqual({ x: 140, y: 80 });
  });

  it("keeps supported image, video, and audio paths in drop order", () => {
    const paths = [
      "P:\\shots\\first.JPG",
      "P:\\shots\\clip.mp4",
      "P:\\shots\\second.webp",
      "P:\\shots\\notes.txt",
      "P:\\shots\\third.PNG",
      "P:\\shots\\voice.m4a",
    ];
    expect(classifyExternalMediaPaths(paths)).toEqual({
      mediaPaths: [paths[0], paths[1], paths[2], paths[4], paths[5]],
      skippedCount: 1,
    });
  });

  it("does not create a candidate for unsupported files or folders", () => {
    expect(classifyExternalMediaPaths(["P:\\shots\\notes.txt", "P:\\shots\\folder"])).toEqual({
      mediaPaths: [],
      skippedCount: 2,
    });
  });

  it("recognizes a Windows image path with a hash in its name", () => {
    const path = "C:\\art#1.jpg";
    expect(classifyExternalMediaPaths([path])).toEqual({ mediaPaths: [path], skippedCount: 0 });
  });

  it("accepts the additional media formats supported by the local importer", () => {
    const paths = [
      "C:\\shots\\clip.m4v",
      "C:\\shots\\voice.opus",
      "C:\\shots\\scan.tif",
      "C:\\shots\\scan.tiff",
      "C:\\shots\\photo.heic",
      "C:\\shots\\photo.heif",
    ];
    expect(classifyExternalMediaPaths(paths)).toEqual({ mediaPaths: paths, skippedCount: 0 });
  });
});
