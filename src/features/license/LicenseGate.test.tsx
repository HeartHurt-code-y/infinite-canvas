import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unlockedLicenseSnapshot, type LicenseSnapshot } from "../../lib/license";
import { LicenseGate } from "./LicenseGate";

const DESKTOP_INTERNALS_KEY = "__TAURI_INTERNALS__";

function lockedSnapshot(): LicenseSnapshot {
  return unlockedLicenseSnapshot({
    unlocked: false,
    phase: "locked",
    reason: "trial_expired",
    trialRemainingMs: 0,
    machineId: "ABCD-EFGH-IJKL-MNOP",
  });
}

function mockDesktop(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
) {
  (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY] = {
    invoke,
    transformCallback: () => 1,
  };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[DESKTOP_INTERNALS_KEY];
  vi.restoreAllMocks();
});

describe("LicenseGate", () => {
  it("keeps the canvas usable in the browser preview", () => {
    render(
      <LicenseGate>
        <button type="button">画布可用</button>
      </LicenseGate>,
    );
    expect(screen.getByRole("button", { name: "画布可用" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "试用已结束" })).not.toBeInTheDocument();
  });

  it("locks every feature and shows the payment codes after trial expiry", async () => {
    mockDesktop((command) => {
      if (command === "get_license_status") return Promise.resolve(lockedSnapshot());
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(
      <LicenseGate>
        <button type="button">添加节点</button>
      </LicenseGate>,
    );

    const dialog = await screen.findByRole("dialog", { name: "试用已结束" });
    expect(dialog).toHaveTextContent("开发不易，谢谢老板打赏");
    expect(dialog).toHaveTextContent("包月 150 元");
    expect(
      screen.getByRole("img", { name: "收款二维码，扫码支付包月 150 元" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "作者微信好友二维码" })).toBeInTheDocument();
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加节点" }).closest("[inert]")).not.toBeNull();
  });

  it("unlocks the canvas after a valid monthly activation code", async () => {
    const paid = unlockedLicenseSnapshot({
      phase: "paid",
      reason: "paid",
      paidUntilMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
      paidRemainingMs: 30 * 24 * 60 * 60 * 1000,
      trialRemainingMs: 0,
    });
    mockDesktop((command) => {
      if (command === "get_license_status") return Promise.resolve(lockedSnapshot());
      if (command === "activate_license") return Promise.resolve(paid);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(
      <LicenseGate>
        <button type="button">添加节点</button>
      </LicenseGate>,
    );

    await screen.findByRole("dialog", { name: "试用已结束" });
    fireEvent.change(screen.getByLabelText("月卡激活码"), {
      target: { value: "IC1-AAAA-BBBB" },
    });
    fireEvent.click(screen.getByRole("button", { name: "激活会员" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "试用已结束" })).not.toBeInTheDocument();
    });
    const canvasButton = screen.getByRole("button", { name: "添加节点" });
    expect(canvasButton.closest(".license-shell__workspace")).not.toHaveAttribute("inert");
  });
});
