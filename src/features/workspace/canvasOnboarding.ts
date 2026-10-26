/*
 * 新手引导的「看过没有」标记。
 *
 * 单独放一个文件：组件文件只导出组件，React Fast Refresh 才不会因为
 * 额外的常量/函数导出而整页重载（见 eslint react-refresh/only-export-components）。
 */

/** 已看过引导的标记。 */
export const ONBOARDING_SEEN_KEY = "canvas-onboarding-seen-v1";

/** 读「是否已经看过引导」。隐私模式下读不到就当成没看过。 */
export function readOnboardingSeen(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 记下「已经看过引导」，以后不再自动弹出。 */
export function writeOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // 存不了就存不了：引导已经关掉，不影响使用。
  }
}
