import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

const sharedExclude = [
  ...configDefaults.exclude,
  "scripts/**",
  "tools/remotion-runtime/**",
  "src-tauri/resources/**",
];

/** `.test.ts` 里真正碰到 DOM / localStorage / canvas 的文件，归 jsdom 项目。 */
const jsdomTsTests = [
  "src/lib/promptContent.test.ts",
  "src/lib/promptOrdinalMentions.test.ts",
  "src/lib/appUpdate.test.ts",
  "src/lib/backend.test.ts",
  "src/lib/canvasDocumentClient.test.ts",
  "src/lib/videoComposer.test.ts",
  "src/lib/videoFrameSampler.test.ts",
  "src/features/canvas/canvasDocumentRepository.test.ts",
  "src/features/canvas/canvasWorkflowVersions.test.ts",
  "src/features/workspace/workspaceModel.test.ts",
  "src/features/workspace/mediaByteCache.test.ts",
  "src/features/workspace/videoLocalEditDrawing.test.ts",
];

export default defineConfig({
  plugins: [react()],
  test: {
    // scripts/ 与 tools/remotion-runtime/ 下的 .mjs 测试走 node --test（原生 runner），
    // 不归 vitest；不加排除会被 test:coverage 扫到并报 No test suite found。
    exclude: sharedExclude,
    // vitest doctor 在本套件上测得 threads 比默认 forks 快约 12%；isolate 仍按文件隔离。
    pool: "threads",
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
      // 棘轮阈值：略低于当前基线，只防回退不追认现状。
      // videoComposer / videoFrameSampler 在早期退出路径补测后单独加高。
      thresholds: {
        lines: 70,
        functions: 65,
        statements: 65,
        branches: 65,
        "src/lib/videoComposer.ts": {
          lines: 28,
          functions: 24,
          statements: 28,
          branches: 40,
        },
        "src/lib/videoFrameSampler.ts": {
          lines: 38,
          functions: 40,
          statements: 38,
          branches: 42,
        },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [...sharedExclude, ...jsdomTsTests, "src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.test.tsx", ...jsdomTsTests],
          exclude: [...sharedExclude, "src/**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          testTimeout: 20_000,
          include: ["src/**/*.browser.test.{ts,tsx}"],
          exclude: sharedExclude,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium", viewport: { width: 800, height: 600 } }],
          },
        },
      },
    ],
  },
});
