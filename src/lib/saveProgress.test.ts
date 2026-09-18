import { describe, expect, it } from "vitest";
import * as v from "valibot";

import { formatSaveProgress } from "./backend";
import { generationResultSaveProgressEventSchema } from "./backendSchemas";

describe("formatSaveProgress", () => {
  it("shows received, total, speed and remaining time", () => {
    expect(
      formatSaveProgress({
        received: 848 * 1024,
        total: 10 * 1024 * 1024,
        bytesPerSec: 12.8 * 1024,
      }),
    ).toBe("正在保存 848.0 KB / 10.0 MB · 12.8 KB/s · 约 12 分钟");
  });

  it("keeps going without a total size", () => {
    expect(
      formatSaveProgress({
        received: 2048,
        total: null,
        bytesPerSec: 1024,
      }),
    ).toBe("正在保存 2.0 KB · 1.0 KB/s");
  });
});

describe("generationResultSaveProgressEventSchema", () => {
  it("accepts numeric IPC payloads", () => {
    expect(
      v.parse(generationResultSaveProgressEventSchema, {
        taskId: "task-1",
        resultIndex: 1,
        received: 868352,
        total: 10485760,
        bytesPerSec: 13107.2,
      }),
    ).toMatchObject({
      taskId: "task-1",
      resultIndex: 1,
      received: 868352,
      total: 10485760,
    });
  });

  it("coerces string numbers and missing total so the card still updates", () => {
    expect(
      v.parse(generationResultSaveProgressEventSchema, {
        taskId: "task-1",
        resultIndex: "1",
        received: "868352",
        bytesPerSec: "13107.2",
      }),
    ).toEqual({
      taskId: "task-1",
      resultIndex: 1,
      received: 868352,
      total: null,
      bytesPerSec: 13107.2,
    });
  });
});
