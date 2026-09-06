import { describe, expect, it } from "vitest";
import { parseHistoryDateRange } from "./historyDateRange";

describe("history date range", () => {
  it("converts device-local time and includes the entire last second", () => {
    expect(parseHistoryDateRange("2026-09-05T10:20:30.000", "2026-09-05T10:20:30.000")).toEqual({
      createdFrom: new Date(2026, 8, 5, 10, 20, 30).getTime(),
      createdTo: new Date(2026, 8, 5, 10, 20, 30, 999).getTime(),
    });
    expect(parseHistoryDateRange("2026-09-05T10:20:30", "2026-09-05T10:20:30")).toEqual({
      createdFrom: new Date(2026, 8, 5, 10, 20, 30).getTime(),
      createdTo: new Date(2026, 8, 5, 10, 20, 30, 999).getTime(),
    });
    expect(parseHistoryDateRange("", "2026-09-05T10:20")).toEqual({
      createdTo: new Date(2026, 8, 5, 10, 20, 0, 999).getTime(),
    });
    expect(parseHistoryDateRange("", "")).toEqual({});
  });

  it("rejects inverted and invalid calendar dates", () => {
    expect(() => parseHistoryDateRange("2026-09-06T00:00", "2026-09-05T23:59:59")).toThrow(
      "开始时间不能晚于结束时间",
    );
    expect(() => parseHistoryDateRange("2026-02-30T00:00", "")).toThrow();
    expect(() => parseHistoryDateRange("invalid", "")).toThrow();
  });
});
