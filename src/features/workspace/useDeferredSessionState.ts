import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

/** 缓冲上限：达到后立即回放一次，防止长时间后台运行无界累积 updater。 */
const MAX_PENDING_ACTIONS = 500;

/**
 * 非活跃画布的会话态缓冲。后台事件（工作流进度、下载进度、流式文本）在画布不可见时
 * 不再逐次 setState 重渲染整个组件：updater 进入缓冲区，画布重新激活时按提交顺序回放，
 * 组合语义与实时 setState 完全一致（updater 均为纯函数）。缓冲超限时立即回放一次，
 * 代价只是一次不可见渲染，换取内存有界。
 */
export function useDeferredSessionState<T>(
  setter: Dispatch<SetStateAction<T>>,
  activeRef: RefObject<boolean>,
  active: boolean,
): Dispatch<SetStateAction<T>> {
  const pendingRef = useRef<SetStateAction<T>[]>([]);
  const setterRef = useRef(setter);
  useEffect(() => {
    setterRef.current = setter;
  }, [setter]);

  const replay = useCallback(() => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setterRef.current((current) => {
      let next = current;
      for (const action of pending) {
        // 泛型 T 未实例化时 `typeof` 无法收窄 SetStateAction 的函数分支，需要显式断言。
        next = typeof action === "function" ? (action as (prev: T) => T)(next) : action;
      }
      return next;
    });
  }, []);

  // 激活时一次性回放隐藏期间积累的进度；回放发生在激活渲染之后，补一次提交。
  useEffect(() => {
    if (active) replay();
  }, [active, replay]);

  return useCallback(
    (action: SetStateAction<T>) => {
      if (!activeRef.current) {
        pendingRef.current.push(action);
        if (pendingRef.current.length >= MAX_PENDING_ACTIONS) replay();
        return;
      }
      setterRef.current(action);
    },
    [activeRef, replay],
  );
}
