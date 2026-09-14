#!/usr/bin/env node
/**
 * dev server 入口：复用已在运行的、或启动一个属于本项目的。
 *
 * 为什么不是直接 `vite`：`vite.config.ts` 固定 `port: 1420 + strictPort`，这个端口只有一个
 * 主人。任何遗留的 vite（上一次会话被强杀、后台任务拉起后没人回收、或
 * `scripts/devserver-daemon.mjs` 起的常驻服务）都会让 `pnpm tauri dev` 的 beforeDevCommand
 * 以 `Port 1420 is already in use` 失败。而 beforeDevCommand 与 cargo 是并行跑的：cargo 那半
 * 边已经把窗口启起来了，于是现象很迷惑 —— 终端报端口被占用、CLI 退出码 1，屏幕上却仍有一个
 * 能用的窗口（它加载的正是那个遗留 server 的页面）。这个窗口已经脱离 CLI：Ctrl+C 关不掉它，
 * 遗留 server 一旦消失它就白屏。
 *
 * 因此这里按「先复用、再接管、最后报错」三段处理：
 * 1. 端口上已有能正常服务本项目的 dev server → 直接复用它并退出 0，不再起第二个 vite；
 * 2. 端口上是本项目的 vite 但不响应页面（残留僵死）→ 结束它，再起一个；
 * 3. 端口被别的程序占用 → 打印 PID 与命令行并以非零码退出，不杀非本项目的进程。
 *
 * 输出重定向交给 shell 而不是 Node 管道：受限环境（无法打开命名管道）下同样可用。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 1420);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITE_BIN = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const IS_WINDOWS = process.platform === "win32";
/**
 * 复用探针的预算。
 *
 * 单次请求很短，但要给冷启动留足时间：vite 首次预打包依赖时会把页面请求排在优化之后，
 * 本仓库的依赖图（react / tiptap / xyflow）冷启动可以到十几秒。预算太短会把一个「正在
 * 热身」的 dev server 误判成僵死，然后把它杀掉重来 —— 那正是这个脚本要消除的折腾。
 */
const PROBE_ATTEMPT_TIMEOUT_MS = 4_000;
const PROBE_BUDGET_MS = 20_000;
const PROBE_INTERVAL_MS = 500;

/** 在 shell 里跑一条命令并把 stdout 收进临时文件（不经过 Node 管道）。 */
function capture(command) {
  const directory = mkdtempSync(join(tmpdir(), "dev-server-"));
  const file = join(directory, "out.txt");
  const redirect = IS_WINDOWS ? `> "${file}" 2>nul` : `> "${file}" 2>/dev/null`;
  try {
    spawnSync(`${command} ${redirect}`, { shell: true, stdio: "inherit", windowsHide: true });
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 监听该端口的进程 id；端口空闲时返回 null。 */
function listeningPid(port) {
  if (IS_WINDOWS) {
    const output = capture(
      `powershell -NoLogo -NoProfile -NonInteractive -Command "Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`,
    );
    const pid = Number(output);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  const pid = Number(capture(`lsof -ti tcp:${port} -sTCP:LISTEN | head -n 1`));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 进程命令行；查不到返回空串。 */
function commandLineOf(pid) {
  if (IS_WINDOWS) {
    return capture(
      `powershell -NoLogo -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
    );
  }
  return capture(`ps -p ${pid} -o args=`);
}

/** 是否是本项目的 vite dev server（而不是别的程序的合法占用）。 */
function isOurDevServer(commandLine) {
  const normalized = commandLine.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes("vite")) return false;
  const mentionsPort =
    normalized.includes(`--port ${PORT}`) || normalized.includes(`--port=${PORT}`);
  const mentionsProject = normalized.includes(ROOT.replace(/\\/g, "/").toLowerCase());
  // 端口或项目路径认出一个即可：`pnpm dev`、tauri 的 beforeDevCommand 与 daemon 三种启动形态都覆盖。
  return mentionsPort || mentionsProject;
}

/**
 * 该端口是否正在服务本项目（index.html 引用本项目的入口模块）。
 *
 * 依次试 IPv4 与 IPv6 回环：`vite.config.ts` 用的是 `host: false`（Node 解析 localhost 到
 * IPv6），只试 127.0.0.1 会把一个健康的 server 判成无响应。`localhost` 本身不可靠（Node 会
 * 先连 IPv4 并长时间挂住），因此只用两个字面量地址。
 */
async function servingThisProject() {
  // IPv6 优先：本仓库的 vite（`host: false`）实际只监听 ::1，先试它能省掉一次必然失败的请求。
  const urls = [`http://[::1]:${PORT}/`, `http://127.0.0.1:${PORT}/`];
  const deadline = Date.now() + PROBE_BUDGET_MS;
  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(PROBE_ATTEMPT_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const html = await response.text();
        if (html.includes("/src/main.tsx")) return url;
      } catch {
        // 端口不通/超时/优化中：留给下一轮重试。
      }
      if (Date.now() >= deadline) break;
    }
    await new Promise((done) => setTimeout(done, PROBE_INTERVAL_MS));
  }
  return null;
}

function killProcessTree(pid) {
  if (IS_WINDOWS) {
    spawnSync(`taskkill /PID ${pid} /T /F`, { shell: true, stdio: "inherit", windowsHide: true });
    return;
  }
  spawnSync(`kill -TERM -${pid} 2>/dev/null || kill -TERM ${pid}`, {
    shell: true,
    stdio: "inherit",
  });
}

function waitForPortFree(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listeningPid(PORT) == null) return true;
    spawnSync(IS_WINDOWS ? "ping -n 1 127.0.0.1 > nul" : "sleep 0.1", {
      shell: true,
      stdio: "ignore",
      windowsHide: true,
    });
  }
  return listeningPid(PORT) == null;
}

function startVite() {
  console.log(`[dev-server] 启动 vite（端口 ${PORT}）`);
  const child = spawn(process.execPath, [VITE_BIN], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  // 交互式 Ctrl+C 由控制台同组广播，这里补上被显式终止时带走子进程的路径。
  const stopChild = () => {
    if (child.exitCode == null && child.signalCode == null) child.kill();
  };
  process.on("SIGINT", stopChild);
  process.on("SIGTERM", stopChild);
  process.on("exit", stopChild);
  child.on("exit", (code, signal) => process.exit(code ?? (signal != null ? 1 : 0)));
}

async function main() {
  const pid = listeningPid(PORT);
  if (pid != null) {
    const commandLine = commandLineOf(pid);
    if (!isOurDevServer(commandLine)) {
      console.error(
        `[dev-server] 端口 ${PORT} 被其他程序占用（PID ${pid}）：${commandLine || "命令行不可读"}`,
      );
      console.error("[dev-server] 不自动结束非本项目的进程；请先自行处理该进程，再重试。");
      return 1;
    }
    const url = await servingThisProject();
    if (url != null) {
      console.log(
        `[dev-server] 复用已在运行的 dev server（PID ${pid}，${url}）；本窗口不再另起 vite。`,
      );
      console.log("[dev-server] 需要自己独占端口时，先停掉它：pnpm dev:daemon:stop");
      return 0;
    }
    console.log(
      `[dev-server] 端口 ${PORT} 上的本项目 dev server 无响应（PID ${pid}），先清理再启动。`,
    );
    killProcessTree(pid);
    if (!waitForPortFree()) {
      console.error(`[dev-server] 端口 ${PORT} 未能释放，请手动处理后再启动。`);
      return 1;
    }
  }
  startVite();
  // startVite 自己负责进程退出码；这里的返回值只在启动前失败时使用。
  return 0;
}

process.exitCode = await main();
