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

  /*
   * 激活时一次性回放隐藏期间积累的进度。
   *
   * 顺序要紧：回放必须在「画布重新变为 active」这件事对写入方可见**之前**完成，
   * 否则切回画布的瞬间到达的后台事件会走直连分支直接落到真实 state，
   * 随后再把**更早**的缓冲事件叠加上去——流式文本是追加语义，
   * 结果就是新片段在前、旧片段在后，用户看到文字"倒退"。
   *
   * 所以写入方不能只看 active：只要缓冲里还有没回放的事件，这次写入就压到
   * 缓冲尾部一起回放，顺序天然正确。渲染期翻转 activeRef（WorkspaceApp 里
   * `activeRef.current = active`）造成的那个窗口，就由这里兜住。
   */
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
      /*
       * 画布已激活但缓冲还没回放：这次写入不能走直连。
       * 直连会让它排在缓冲事件之前，顺序就乱了。
       * 先回放缓冲，再把这次写入压到缓冲尾部一起回放，顺序天然正确。
       */
      if (pendingRef.current.length > 0) {
        pendingRef.current.push(action);
        replay();
        return;
      }
      setterRef.current(action);
    },
    [activeRef, replay],
  );
}
