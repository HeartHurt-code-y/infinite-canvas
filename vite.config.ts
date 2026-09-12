import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const isWindows = process.env.TAURI_ENV_PLATFORM === "windows";

// Stable framework chunks keep the application entry focused on product code and
// let Tauri reuse cached React/canvas dependencies across releases.
// `[\\/]` separators keep regex checks correct on Windows paths.
const vendorGroups = [
  {
    name: "icons-vendor",
    test: /[\\/]node_modules[\\/]@phosphor-icons[\\/]react[\\/]/,
  },
  {
    name: "canvas-vendor",
    test: /[\\/]node_modules[\\/](@xyflow[\\/]|d3-|delaunator[\\/]|internmap[\\/]|robust-predicates[\\/])/,
  },
  {
    name: "tiptap-vendor",
    test: /[\\/]node_modules[\\/](@tiptap[\\/]|prosemirror-)/,
  },
  {
    name: "react-vendor",
    test: /[\\/]node_modules[\\/](react[\\/]|react-dom[\\/]|scheduler[\\/]|@tanstack[\\/](?:query-core|react-query)[\\/]|use-sync-external-store[\\/]|zustand[\\/])/,
  },
  {
    name: "markdown-vendor",
    test: /[\\/]node_modules[\\/](react-markdown|remark-|unified[\\/]|micromark|mdast-util-|hast-util-|unist-util-|vfile|character-entities|decode-named-character-reference|comma-separated-tokens|space-separated-tokens|ccount[\\/]|escape-string-regexp[\\/]|trim-lines[\\/]|zwitch[\\/]|bail[\\/]|trough[\\/]|is-plain-obj[\\/]|is-buffer[\\/]|property-information|stringify-entities|parse-entities|devlop[\\/]|extend[\\/]|emoji-regex[\\/]|html-void-elements[\\/]|web-namespaces[\\/])/,
  },
  {
    name: "misc-vendor",
    test: /[\\/]node_modules[\\/](diff[\\/]|valibot[\\/]|sonner[\\/]|react-hotkeys-hook[\\/]|zundo[\\/])/,
  },
  {
    name: "tauri-vendor",
    test: /[\\/]node_modules[\\/]@tauri-apps[\\/]/,
  },
  {
    name: "other-vendor",
    test: /[\\/]node_modules[\\/](?!@phosphor-icons[\\/]|@xyflow[\\/]|d3-|delaunator[\\/]|internmap[\\/]|robust-predicates[\\/]|@tiptap[\\/]|prosemirror-|react[\\/]|react-dom[\\/]|scheduler[\\/]|@tanstack[\\/]|use-sync-external-store[\\/]|zustand[\\/]|react-markdown|remark-|unified[\\/]|micromark|mdast-util-|hast-util-|unist-util-|vfile|character-entities|decode-named-character-reference|comma-separated-tokens|space-separated-tokens|ccount[\\/]|escape-string-regexp[\\/]|trim-lines[\\/]|zwitch[\\/]|bail[\\/]|trough[\\/]|is-plain-obj[\\/]|is-buffer[\\/]|property-information|stringify-entities|parse-entities|devlop[\\/]|extend[\\/]|emoji-regex[\\/]|html-void-elements[\\/]|web-namespaces[\\/]|diff[\\/]|valibot[\\/]|sonner[\\/]|react-hotkeys-hook[\\/]|zundo[\\/]|@tauri-apps[\\/])/,
  },
];

function manualVendorChunk(id: string): string | undefined {
  if (!id.includes("/node_modules/") && !id.includes("\\node_modules\\")) return;
  for (const { name, test } of vendorGroups) {
    if (test.test(id)) return name;
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Also expose the variables the Tauri CLI injects (TAURI_ENV_*) to frontend
  // code via `import.meta.env`, next to the default VITE_* prefix.
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // Tauri runs on the evergreen Chromium WebView2 on Windows and on WebKit
    // (WKWebView / WebKitGTK) on macOS and Linux; the lower WebKit floor keeps
    // older OS webviews working at a small transpile cost.
    target: isWindows ? "chrome105" : "safari13",
    // Don't minify debug builds (default Oxc minifier for release builds).
    minify: !process.env.TAURI_ENV_DEBUG,
    // Produce sourcemaps for debug builds only.
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // 画布编辑器核心（WorkspaceApp + 节点视图 + store/backend client）启动必需，
    // 主包 ~560 kB 是合理体积；第三方依赖已全部拆为独立 vendor chunk。
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Keep framework-heavy dependencies in dedicated vendor chunks.
        manualChunks: (id) => manualVendorChunk(id),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //    同时忽略「原子写」临时产物：不少编辑器与工具保存文件时先写
      //    `.<名称>.<pid>.<uuid>.tmpdir/<名称>.tmp` 再改名。Vite 会在这些临时
      //    文件被改名或删除的瞬间拿到 EBUSY，并让整个 dev server 退出。
      ignored: ["**/src-tauri/**", "**/*.tmpdir/**", "**/*.tmp", "**/.*.tmp*"],
    },
  },
}));
