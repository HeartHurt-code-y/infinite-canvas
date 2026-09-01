import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 26 的实验性 global localStorage 在未指定文件时为 undefined，会覆盖
// jsdom 实现。测试环境用内存 Storage 复原 WebView 中的持久化 API。
const storageValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => {
    storageValues.delete(key);
  },
  setItem: (key, value) => {
    storageValues.set(key, String(value));
  },
};
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });
}

// jsdom 未实现 ResizeObserver，而 @xyflow/react 挂载与节点测量都依赖它。
// stub 会异步派发一次非零 contentRect，模拟浏览器首次布局，让 RF 完成
// 视口初始化（viewportInitialized → onInit → flowInstanceRef 就绪）。
const CANVAS_MEASURE_WIDTH = 1280;
const CANVAS_MEASURE_HEIGHT = 800;
class ResizeObserverStub implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    queueMicrotask(() => {
      this.callback.call(
        this,
        [
          {
            target,
            contentRect: {
              width: CANVAS_MEASURE_WIDTH,
              height: CANVAS_MEASURE_HEIGHT,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              right: CANVAS_MEASURE_WIDTH,
              bottom: CANVAS_MEASURE_HEIGHT,
            } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        this,
      );
    });
  }
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
  // @xyflow/system 通过 offsetWidth/offsetHeight 量取容器与节点尺寸（jsdom 恒为 0，
  // 会把节点隐藏并阻止视口初始化）。RF 容器给视口尺寸；把手给小尺寸，保证连线
  // 命中测试（connectionRadius 内）落在节点附近；节点卡片按 App 布局常量给尺寸，
  // 使避让/连线几何与真实运行一致。
  type NodeSize = { width: number; height: number };
  const DEFAULT_NODE_SIZE: NodeSize = { width: 240, height: 160 };
  const NODE_SIZES_BY_CLASS: ReadonlyArray<readonly [string, NodeSize]> = [
    ["canvas-gen-node--image", { width: 580, height: 480 }],
    ["canvas-gen-node--video", { width: 580, height: 900 }],
    ["canvas-gen-node--prompt", { width: 520, height: 650 }],
    ["canvas-screenplay-node--viral_remix", { width: 620, height: 780 }],
    ["canvas-screenplay-node", { width: 620, height: 760 }],
    ["canvas-video-composer", { width: 580, height: 500 }],
    ["canvas-video-downloader", { width: 580, height: 420 }],
    ["canvas-asset-node--output", { width: 320, height: 180 }],
    ["canvas-asset-node", { width: 500, height: 437.5 }],
    ["canvas-result-node", { width: 250, height: 300 }],
  ];
  const measureSizeFor = (element: HTMLElement): NodeSize => {
    for (const [className, size] of NODE_SIZES_BY_CLASS) {
      if (element.classList.contains(className)) return size;
    }
    return DEFAULT_NODE_SIZE;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("react-flow")) return CANVAS_MEASURE_WIDTH;
      if (this.classList.contains("react-flow__handle")) return 16;
      return measureSizeFor(this).width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("react-flow")) return CANVAS_MEASURE_HEIGHT;
      if (this.classList.contains("react-flow__handle")) return 16;
      return measureSizeFor(this).height;
    },
  });
}

// jsdom 未实现 document.elementFromPoint；xyflow 连线命中校验会调用它，
// 返回 null 时会回退到 closestHandle 距离判定，语义安全。
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
}

// d3-zoom/xyflow 用 DOMMatrixReadOnly 解析视口 transform（jsdom 未实现）。
// 这里解析 matrix(a,b,c,d,e,f) 字符串，m22 即缩放系数。
class DOMMatrixReadOnlyStub {
  m11 = 1;
  m12 = 0;
  m21 = 0;
  m22 = 1;
  m41 = 0;
  m42 = 0;
  constructor(init?: string | number[]) {
    if (typeof init === "string") {
      const match = init.match(/matrix\(([^)]+)\)/);
      if (match != null) {
        const [a, b, c, d, e, f] = match[1]!
          .split(",")
          .map((value) => Number.parseFloat(value.trim()));
        this.m11 = a ?? 1;
        this.m12 = b ?? 0;
        this.m21 = c ?? 0;
        this.m22 = d ?? 1;
        this.m41 = e ?? 0;
        this.m42 = f ?? 0;
      }
    }
  }
  get isIdentity(): boolean {
    return this.m11 === 1 && this.m22 === 1 && this.m41 === 0 && this.m42 === 0;
  }
}
if (typeof window !== "undefined" && typeof window.DOMMatrixReadOnly === "undefined") {
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    writable: true,
    value: DOMMatrixReadOnlyStub,
  });
  Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
    configurable: true,
    writable: true,
    value: DOMMatrixReadOnlyStub,
  });
}

afterEach(() => {
  cleanup();
  storageValues.clear();
});
