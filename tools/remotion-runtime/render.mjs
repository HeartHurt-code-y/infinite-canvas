import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openBrowser,
  selectComposition,
  renderMedia,
  renderStill,
  makeCancelSignal,
} from "@remotion/renderer";
import { validatePlan } from "./plan.mjs";

const runtime = path.dirname(fileURLToPath(import.meta.url));
const jobDirectory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("缺少动画任务目录");
let lastProgress = -1;
let lastMessage = "";
function progress(value, message) {
  const next = Math.max(0, Math.min(100, Math.floor(value)));
  if (next === lastProgress && message === lastMessage && next !== 100) return;
  lastProgress = next;
  lastMessage = message;
  const temporary = path.join(jobDirectory, "progress.json.tmp");
  writeFileSync(temporary, JSON.stringify({ progress: next, message }));
  renameSync(temporary, path.join(jobDirectory, "progress.json"));
}
const { cancelSignal, cancel } = makeCancelSignal();
let cancelled = false;
function checkCancelled() {
  if (existsSync(path.join(jobDirectory, "cancel"))) {
    cancelled = true;
    cancel();
  }
  if (cancelled) throw new Error("动画渲染已取消");
}
const interval = setInterval(() => {
  if (existsSync(path.join(jobDirectory, "cancel"))) {
    cancelled = true;
    cancel();
  }
}, 200);
let browser;
try {
  checkCancelled();
  const inputPath = path.join(jobDirectory, "input.json");
  if ((await stat(inputPath)).size > 128 * 1024) throw new Error("动画输入超过大小限制");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const plan = validatePlan(input.plan);
  if (!["gif", "mp4", "both"].includes(input.format)) throw new Error("不支持的动画输出格式");
  const manifest = JSON.parse(await readFile(path.join(runtime, "runtime-manifest.json"), "utf8"));
  const browserExecutable = path.resolve(runtime, manifest.browserExecutable);
  if (!browserExecutable.startsWith(runtime + path.sep) || !existsSync(browserExecutable))
    throw new Error("动画运行时浏览器不完整，请重新安装应用");
  const serveUrl = path.join(runtime, "bundle");
  if (!existsSync(path.join(serveUrl, "index.html")))
    throw new Error("动画模板运行时不完整，请重新安装应用");
  const inputProps = { plan };
  progress(2, "准备动画画面");
  browser = await openBrowser("chrome", { browserExecutable, logLevel: "error" });
  checkCancelled();
  const composition = await selectComposition({
    serveUrl,
    id: "Animation",
    inputProps,
    puppeteerInstance: browser,
    logLevel: "error",
  });
  checkCancelled();
  progress(5, "生成完整画面预览");
  await renderStill({
    composition,
    serveUrl,
    inputProps,
    puppeteerInstance: browser,
    output: path.join(jobDirectory, "preview.png"),
    frame: plan.durationInFrames - 1,
    imageFormat: "png",
    cancelSignal,
    logLevel: "error",
  });
  const formats = input.format === "both" ? ["mp4", "gif"] : [input.format];
  for (const [index, format] of formats.entries()) {
    checkCancelled();
    const base = 8 + (index * 86) / formats.length;
    const extent = 86 / formats.length;
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      puppeteerInstance: browser,
      codec: format === "gif" ? "gif" : "h264",
      outputLocation: path.join(jobDirectory, `animation.${format}`),
      concurrency: 2,
      muted: true,
      imageFormat: "png",
      cancelSignal,
      logLevel: "error",
      ...(format === "gif"
        ? { everyNthFrame: 2, numberOfGifLoops: null }
        : { crf: 18, pixelFormat: "yuv420p", x264Preset: "fast" }),
      onProgress: ({ progress: completed }) =>
        progress(base + completed * extent, `渲染 ${format.toUpperCase()} 动画`),
    });
  }
  checkCancelled();
  progress(96, "整理可编辑动画工程");
  const project = path.join(jobDirectory, "project");
  await mkdir(project, { recursive: true });
  await copyFile(path.join(runtime, "Composition.tsx"), path.join(project, "Composition.tsx"));
  await writeFile(path.join(project, "plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(
    path.join(project, "index.tsx"),
    `import React from 'react';\nimport {Composition, registerRoot} from 'remotion';\nimport {Animation} from './Composition';\nimport plan from './plan.json';\nconst Root = () => <Composition id="Animation" component={Animation} defaultProps={{plan}} width={plan.width} height={plan.height} fps={plan.fps} durationInFrames={plan.durationInFrames}/>;\nregisterRoot(Root);\n`,
  );
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "animation-project",
        version: "1.0.0",
        private: true,
        scripts: {
          studio: "remotion studio index.tsx",
          mp4: "remotion render index.tsx Animation animation.mp4",
          gif: "remotion render index.tsx Animation animation.gif --codec=gif --every-nth-frame=2",
        },
        dependencies: {
          "@remotion/cli": manifest.remotionVersion,
          remotion: manifest.remotionVersion,
          react: "19.1.0",
          "react-dom": "19.1.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(project, "README.md"),
    "# 可编辑动画工程\n\n修改 plan.json 中的标题、内容、颜色与排版数据，或编辑 Composition.tsx 调整动画。\n\n安装 Node.js 后在此目录运行 pnpm install，然后使用 pnpm run studio 预览，pnpm run mp4 或 pnpm run gif 导出。工程仅包含可信模板与本次数据，无供应商凭据。\n",
  );
  checkCancelled();
  progress(100, "动画与可编辑工程已完成");
} catch (error) {
  const isCancelled = cancelled;
  const message = isCancelled
    ? "动画渲染已取消"
    : error instanceof Error
      ? error.message
      : String(error);
  try {
    progress(lastProgress, message);
  } catch {
    /* Preserve the original render failure. */
  }
  process.stderr.write(message + "\n");
  process.exitCode = isCancelled ? 130 : 1;
} finally {
  clearInterval(interval);
  if (browser) await browser.close({ silent: true });
}
