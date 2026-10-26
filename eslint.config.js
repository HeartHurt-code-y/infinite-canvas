import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "coverage/**",
    "dist/**",
    "node_modules/**",
    // 本机构建冒烟、安装包测量与发布中转产物（见 .gitignore 的 .cache/ 段）。
    ".cache/**",
    // 本地临时目录（.gitignore 已忽略）：逆向分析下载的第三方产物、
    // 抓包日志与临时脚本都在这里，不是本项目源码，不参与 lint。
    ".tmp/**",
    // src-tauri 下的 skills 为 Rust 侧技能资产的独立 CommonJS 工具脚本，
    // 不参与前端构建，不纳入前端 lint 范围。
    "src-tauri/skills/**",
    // ts-rs 生成的跨语言契约绑定（pnpm codegen 产物），不参与前端 lint。
    "src/lib/bindings/**",
    "src-tauri/gen/**",
    "src-tauri/target/**",
    // Qoder Canvas 会话产物（.canvas.tsx），不属于本项目源码也不在 tsconfig 内，
    // 类型感知解析器会直接报 parser 错误。
    ".qoder-credits/**",
    // vendored 的第三方源码（wry 等）：只做补丁，不参与本仓库的 lint 与格式。
    "src-tauri/vendor/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      // 不直接用 strictTypeChecked：no-unsafe-* / no-non-null-assertion 在本库
      // 会产生数百条噪音。改为在 recommended 基础上精选"零噪音、高价值"的
      // 类型感知规则（见 rules），收益集中在真实 bug 上。
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // —— 类型感知规则：在本库全量扫描为 0 违规，防止未来引入悬空 promise ——
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      // switch 必须覆盖所有判别分支，新增枚举/字面量时编译期即暴露遗漏
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // 可空类型上禁止 ||（空字符串会被误吞），统一使用 ?? 或显式三元；
      // 本库多处有意把 "" 归一化为"缺失"，三元形式是语义等价的正确写法。
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignoreTernaryTests: true }],
      // 运行时日志统一走 frontendLog / Tauri plugin-log，console 仅作为
      // backend.ts 中插件不可用时的兜底（该处已用行内豁免说明）。
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@phosphor-icons/react",
              message:
                "Use @phosphor-icons/react/<IconName> so Vite does not analyze the icon barrel.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended, prettier],
  },
  {
    files: ["*.config.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // zustand 仓库文件：vanilla store 工厂 / hook / Provider 同文件导出是有意为之，
    // Fast refresh 对纯状态仓库不生效也无影响。
    files: ["src/features/canvas/canvasStore.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]);
