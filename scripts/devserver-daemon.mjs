/*
 * 以脱离 DSH 作业树的方式管理画布 dev server。
 *
 * 用法：node scripts/devserver-daemon.mjs start|stop|status
 *
 * 为什么需要它：用后台作业（`run_in_background`）起的 vite 会挂在作业进程树下，
 * 已经两次在没有报错的情况下被整个终止（exit -1，日志停在依赖预打包阶段）。
 * 这里用 detached + unref 起独立进程，生命周期与作业树无关。
 *
 * 状态与日志刻意放在仓库之外：vite 会监听项目目录，把日志写在项目里会让它
 * 监听一个自己不断写入的文件，正是本仓库多次 EBUSY 退出的成因。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(homedir(), ".dsh", "tmp", "canvas-devserver");
const PID_FILE = join(STATE, "devserver.pid");
const LOG_FILE = join(STATE, "devserver.log");
const PORT = Number(process.env.CANVAS_DEV_PORT ?? 1420);

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const status = () => {
  if (!existsSync(PID_FILE)) return { running: false, reason: "no pid file", log: LOG_FILE };
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  const alive = Number.isInteger(pid) && isAlive(pid);
  return {
    running: alive,
    pid: alive ? pid : undefined,
    stalePid: alive ? undefined : pid,
    log: LOG_FILE,
  };
};

const command = process.argv[2] ?? "status";

if (command === "start") {
  const current = status();
  if (current.running) {
    console.log(JSON.stringify({ alreadyRunning: true, ...current }));
    process.exit(0);
  }
  mkdirSync(STATE, { recursive: true });
  const out = openSync(LOG_FILE, "w");
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "node_modules/vite/bin/vite.js"),
      "--port",
      String(PORT),
      "--strictPort",
      "--clearScreen",
      "false",
    ],
    { cwd: ROOT, detached: true, stdio: ["ignore", out, out], windowsHide: true },
  );
  child.unref();
  writeFileSync(PID_FILE, String(child.pid), "utf8");
  console.log(JSON.stringify({ started: true, pid: child.pid, port: PORT, log: LOG_FILE }));
  process.exit(0);
}

if (command === "stop") {
  const current = status();
  if (!current.running) {
    rmSync(PID_FILE, { force: true });
    console.log(JSON.stringify({ stopped: false, reason: "not running" }));
    process.exit(0);
  }
  process.kill(current.pid, "SIGTERM");
  rmSync(PID_FILE, { force: true });
  console.log(JSON.stringify({ stopped: true, pid: current.pid }));
  process.exit(0);
}

console.log(JSON.stringify(status()));
