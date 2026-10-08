// Sign native tools before recording their manifest hashes, never after cataloguing.
import { spawnSync } from "node:child_process";

export function ensureMacExecutableSignature(
  filename,
  { arch = process.arch, run = spawnSync } = {},
) {
  const expectedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : null;
  if (!expectedArch) throw new Error("Unsupported native Mac architecture");
  const execute = (command, args) =>
    run(command, args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
  const architectures = execute("/usr/bin/lipo", ["-archs", filename]);
  if (
    architectures.status !== 0 ||
    !architectures.stdout.trim().split(/\s+/).includes(expectedArch)
  )
    throw new Error("Prepared macOS executable does not contain the native architecture");
  if (execute("/usr/bin/codesign", ["--verify", "--strict", filename]).status !== 0) {
    const signed = execute("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      filename,
    ]);
    if (signed.status !== 0) throw new Error("Unable to ad-hoc sign prepared macOS executable");
  }
  if (execute("/usr/bin/codesign", ["--verify", "--strict", filename]).status !== 0)
    throw new Error("Prepared macOS executable signature is invalid");
}
