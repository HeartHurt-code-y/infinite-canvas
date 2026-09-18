import { describe, expect, it } from "vitest";
import { formatLicenseDuration, formatLicenseError, unlockedLicenseSnapshot } from "./license";

describe("license helpers", () => {
  it("formats remaining trial time in Chinese units", () => {
    expect(formatLicenseDuration(23 * 60 * 60 * 1000 + 12 * 60 * 1000)).toBe("23 小时 12 分钟");
    expect(formatLicenseDuration(2 * 60 * 60 * 1000)).toBe("2 小时");
    expect(formatLicenseDuration(8 * 60 * 1000)).toBe("8 分钟");
    expect(formatLicenseDuration(20_000)).toBe("不足 1 分钟");
  });

  it("prefers the backend validation message when activation fails", () => {
    expect(formatLicenseError(new Error("该激活码已在本机使用过。"))).toBe(
      "该激活码已在本机使用过。",
    );
    expect(formatLicenseError({ message: "激活码无效，请向作者微信确认后再试。" })).toBe(
      "激活码无效，请向作者微信确认后再试。",
    );
  });

  it("keeps an unlocked snapshot inside the paid contract", () => {
    const snapshot = unlockedLicenseSnapshot();
    expect(snapshot.unlocked).toBe(true);
    expect(snapshot.priceYuan).toBe(150);
    expect(snapshot.trialHours).toBe(24);
  });
});
