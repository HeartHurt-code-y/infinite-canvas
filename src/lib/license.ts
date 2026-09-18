import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { BackendContractError, isDesktopRuntime } from "./backend";

export const LICENSE_PRICE_YUAN = 150;
export const LICENSE_PERIOD_DAYS = 30;
export const LICENSE_TRIAL_HOURS = 24;

export type LicensePhase = "trial" | "paid" | "locked";
export type LicenseReason = "trial" | "paid" | "bypass" | "trial_expired" | "subscription_expired";

export interface LicenseSnapshot {
  readonly unlocked: boolean;
  readonly phase: LicensePhase;
  readonly reason: LicenseReason;
  readonly trialRemainingMs: number;
  readonly paidUntilMs: number | null;
  readonly paidRemainingMs: number | null;
  readonly machineId: string;
  readonly priceYuan: number;
  readonly periodDays: number;
  readonly trialHours: number;
}

const licenseSnapshotSchema = v.looseObject({
  unlocked: v.boolean(),
  phase: v.picklist(["trial", "paid", "locked"]),
  reason: v.picklist(["trial", "paid", "bypass", "trial_expired", "subscription_expired"]),
  trialRemainingMs: v.number(),
  paidUntilMs: v.nullable(v.number()),
  paidRemainingMs: v.nullable(v.number()),
  machineId: v.string(),
  priceYuan: v.number(),
  periodDays: v.number(),
  trialHours: v.number(),
}) satisfies v.GenericSchema<LicenseSnapshot>;

export function unlockedLicenseSnapshot(overrides: Partial<LicenseSnapshot> = {}): LicenseSnapshot {
  return {
    unlocked: true,
    phase: "trial",
    reason: "trial",
    trialRemainingMs: LICENSE_TRIAL_HOURS * 60 * 60 * 1000,
    paidUntilMs: null,
    paidRemainingMs: null,
    machineId: "TEST-MACHINE-ID00",
    priceYuan: LICENSE_PRICE_YUAN,
    periodDays: LICENSE_PERIOD_DAYS,
    trialHours: LICENSE_TRIAL_HOURS,
    ...overrides,
  };
}

export function formatLicenseDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (hours > 0) return `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分钟`;
  return "不足 1 分钟";
}

export function formatLicenseError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "激活失败，请检查激活码后重试。";
}

async function invokeLicense(
  command: string,
  args?: Record<string, unknown>,
): Promise<LicenseSnapshot> {
  if (!isDesktopRuntime()) {
    return unlockedLicenseSnapshot({ reason: "bypass", phase: "paid" });
  }
  const payload = await invoke<unknown>(command, args);
  const parsed = v.safeParse(licenseSnapshotSchema, payload);
  if (parsed.success) return parsed.output;
  throw new BackendContractError(
    command,
    parsed.issues.map((issue) => ({
      path: v.getDotPath(issue) ?? "",
      message: issue.message,
    })),
  );
}

export async function getLicenseStatus(): Promise<LicenseSnapshot> {
  return invokeLicense("get_license_status");
}

export async function activateLicense(code: string): Promise<LicenseSnapshot> {
  return invokeLicense("activate_license", { code });
}
