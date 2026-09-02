import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const isWindows = process.env.TAURI_ENV_PLATFORM === "windows";

// Stable framework chunks keep the application entry focused on product code and
// let Tauri reuse cached React/canvas dependencies across releases. Feature-only
// modules still use explicit dynamic imports and remain outside these groups.
// `[\\/]` separators keep the tests correct on Windows paths.
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
];

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
    rolldownOptions: {
      output: {
        // Vite 8 (Rolldown) replacement for the deprecated `manualChunks` form.
        codeSplitting: {
          groups: vendorGroups,
        },
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
      ignored: ["**/src-tauri/**"],
    },
  },
}));
