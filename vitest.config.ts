import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // scripts/ 与 tools/remotion-runtime/ 下的 .mjs 测试走 node --test（原生 runner），
    // 不归 vitest；不加排除会被 test:coverage 扫到并报 No test suite found。
    exclude: [
      ...configDefaults.exclude,
      "scripts/**",
      "tools/remotion-runtime/**",
      "src-tauri/resources/**",
    ],
    // 画布集成用例会同时挂载大量媒体节点；并行全量运行时 5 秒默认值容易产生假超时。
    testTimeout: 10_000,
    // 隔离卫生兜底：现有用例已在 afterEach 手动 restore，这里保证未来新增用例
    // 即使忘记清理，spy/stub 也不会泄漏到下一个测试。
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/test/**",
        "src/**/*.{test,spec}.{ts,tsx}",
      ],
      reporter: ["text", "html", "lcov"],
      // 棘轮阈值：略低于当前基线（stmts 69 / branch 66 / funcs 69 / lines 72），
      // 只防回退不追认现状；videoComposer / videoFrameSampler 是主要补测目标。
      thresholds: {
        lines: 70,
        functions: 65,
        statements: 65,
        branches: 65,
      },
    },
  },
});
