/*
 * 受控 / 非受控通用的开合状态。
 *
 * Agent 模式里，技能与主体两块浮层有**两个**触发口：
 *   - 工具条上的「技能」「@」按钮；
 *   - 提示词里打 `/`、`@` 触发的行内命令。
 * 触发口在浮层外面，所以浮层的开合必须能被外面接管。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ControllableOpen {
  /** 非受控时的初始开合。 */
  readonly defaultOpen?: boolean | undefined;
  /** 受控开关：给了就以它为准。 */
  readonly open?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}

export interface ControllableOpenResult {
  readonly open: boolean;
  readonly setOpen: (next: boolean) => void;
}

export function useControllableOpen(options: ControllableOpen = {}): ControllableOpenResult {
  const { defaultOpen = false, open: controlled, onOpenChange } = options;
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  /*
   * 回调走 ref：调用方通常传内联箭头函数，每次渲染都是新引用。
   * 直接把它放进依赖会让 `setOpen` 每次渲染都变，进而让定位用的
   * layout effect 每次渲染都重跑（浮层跟着抖一下）。走 ref 后
   * `setOpen` 的身份是稳定的，可以安全地进依赖数组。
   */
  const callbackRef = useRef(onOpenChange);
  useEffect(() => {
    callbackRef.current = onOpenChange;
  }, [onOpenChange]);
  const isControlled = controlled !== undefined;
  const open = isControlled ? controlled : uncontrolled;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolled(next);
      callbackRef.current?.(next);
    },
    [isControlled],
  );
  return { open, setOpen };
}
