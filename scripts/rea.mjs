import { spawn } from "node:child_process";

// REA's Wakaru adapter uses Linux prlimit. Run the configured WSL toolchain on
// Windows, preserving each argument instead of constructing a shell command.
const args = process.argv.slice(2);

function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `${command} exited with ${code}`));
      else resolve(stdout.trim());
    });
  });
}

try {
  let command = process.env.REA_COMMAND || "rea";
  let commandArgs = args;
  if (process.platform === "win32") {
    const distro = process.env.REA_WSL_DISTRO || "Ubuntu-24.04";
    const rea = process.env.REA_WSL_COMMAND || "/opt/rea-tools/bin/rea";
    const converted = await Promise.all(args.map((arg) =>
      /^(?:[a-z]:[\\/]|\\\\)/i.test(arg)
        ? capture("wsl.exe", ["-d", distro, "--exec", "wslpath", "-a", "-u", arg])
        : arg,
    ));
    command = "wsl.exe";
    commandArgs = ["-d", distro, "--exec", rea, ...converted];
  }
  const child = spawn(command, commandArgs, { stdio: "inherit", windowsHide: true });
  child.on("error", (error) => {
    console.error(`REA 启动失败：${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(`REA 路径转换失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
