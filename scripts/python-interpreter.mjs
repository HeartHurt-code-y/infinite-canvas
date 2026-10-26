// Resolve a local Python 3 interpreter for the publishing helpers that need
// one (for example reading the local credential database through sqlite3).
// Nothing is ever downloaded: a missing interpreter is a hard, explicit error.
import { existsSync } from "node:fs";
import path from "node:path";

function findPythonOnPath(environment, platform) {
  const names = platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  const extensions = platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  const directories = (environment.PATH ?? environment.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function resolvePythonInterpreter(environment = process.env, platform = process.platform) {
  const configured = environment.IC_PYTHON_INTERPRETER;
  const executable =
    (configured && existsSync(configured) ? configured : null) ??
    findPythonOnPath(environment, platform);
  if (!executable)
    throw new Error(
      "This publishing step needs a local Python 3 interpreter: set IC_PYTHON_INTERPRETER or put python3 on PATH; no download is performed.",
    );
  return executable;
}
