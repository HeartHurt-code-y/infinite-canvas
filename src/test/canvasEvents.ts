import { act } from "@testing-library/react";

/**
 * 画布手势事件：jsdom/vitest 下 MouseEvent 构造器不接受 view 初始化（IDL 校验失败），
 * 而 d3-drag/d3-zoom 依赖 event.view 把 move/up 监听挂到 window ——
 * 这里手工构造事件并在实例上覆写 view 后派发。
 */
export function fireCanvasMouse(
  target: EventTarget,
  type: "mousedown" | "mousemove" | "mouseup",
  coords: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: coords.clientX,
    clientY: coords.clientY,
  });
  Object.defineProperty(event, "view", { configurable: true, value: document.defaultView });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** React Flow 的连线把手走 React onPointerDown（PointerEvent），pointer 事件无需覆写 view。 */
export function fireCanvasPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  coords: { clientX: number; clientY: number },
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: coords.clientX,
      clientY: coords.clientY,
    }),
  );
}
