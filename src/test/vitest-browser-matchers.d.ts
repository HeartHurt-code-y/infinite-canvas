import "vitest";

/**
 * 导入 `vitest/browser` 会把 Browser Mode 的 jest-dom 类型合进全局 Assertion，
 * 其中 `toHaveTextContent` 只接受 string | number。jsdom 用例仍按
 * @testing-library/jest-dom 传入 RegExp，这里把签名加回去。
 */
declare module "vitest" {
  interface Assertion {
    toHaveTextContent(
      text: string | number | RegExp,
      options?: { normalizeWhitespace: boolean },
    ): void;
  }
}
