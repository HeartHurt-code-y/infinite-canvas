// 用例守护 scripts/install-macos.sh 的**参数契约**与**平台守卫**。
//
// 为什么值得写：这个脚本会被贴给终端用户手动执行（`sudo bash install-macos.sh <dmg>`），
// 参数一旦解析错，用户看到的是「什么都没发生」或误装到别处，而开发者手上没有复现环境。
// 因此这里用 --dry-run 在任意平台覆盖解析路径（macOS 上再额外断言平台守卫）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "install-macos.sh");
const IS_MACOS = process.platform === "darwin";

/** 找一个可用的 bash；没有就跳过（Windows 上通常没有）。 */
function findBash() {
  for (const candidate of [
    "bash",
    "/bin/bash",
    "/usr/bin/bash",
    "C:/Program Files/Git/bin/bash.exe",
  ]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const bash = findBash();
const source = readFileSync(SCRIPT, "utf8");
const skipWithoutBash = { skip: bash === null ? "no bash available on this host" : false };

// ---------------------------------------------------------------------------
// 静态结构断言：不需要 bash，因此在任何平台（含 Windows 开发机）都有约束力。
// 这几条恰恰覆盖最容易写错、且用户端才会暴露的地方。
// ---------------------------------------------------------------------------

test("shell structure is balanced (case/do/fi)", () => {
  const count = (re) => (source.match(re) ?? []).length;
  const opens = count(/^\s*case\s/gm);
  const closes = count(/^\s*esac/gm);
  assert.equal(opens, closes, "case/esac must balance");
  assert.ok(opens > 0, "expected at least one case statement");

  const dos = count(/;\s*do\s*$|^\s*do\s*$/gm);
  const dones = count(/^\s*done/gm);
  assert.equal(dos, dones, "do/done must balance");

  const ifs = count(/^\s*if\s/gm) + count(/\|\|\s*$/gm) + count(/&&\s*$/gm);
  const fis = count(/^\s*fi\s*$/gm);
  assert.ok(fis > 0, "expected fi terminators");
  assert.ok(ifs > 0, "expected if statements");
});

test("declares strict mode and ships an LF-only script", () => {
  assert.match(source, /^#!\/usr\/bin\/env bash/, "must have a bash shebang");
  assert.match(source, /set -euo pipefail/, "must fail fast");
  assert.ok(!source.includes("\r\n"), "CRLF line endings break bash on macOS");
});

// 回归守卫：Apple Silicon 上 arm64 可执行文件必须有有效签名才能运行，
// 所以脚本必须真的做 ad-hoc 重签（`-s -`），而不只是清 quarantine。
// 只清 quarantine 是网上最常见的错误建议——app 会因为内层二进制未被签名而启动失败。
test("performs ad-hoc re-signing, not just quarantine removal", () => {
  assert.match(source, /xattr -dr com\.apple\.quarantine/, "must clear quarantine");
  assert.match(source, /codesign --force --sign -/, "must ad-hoc re-sign");
  assert.match(source, /codesign --verify/, "must verify the result");
});

test("clears quarantine on the DMG before mounting it", () => {
  const dmgClear = source.indexOf('xattr -dr com.apple.quarantine "$source_path"');
  const attach = source.indexOf("hdiutil attach");
  assert.ok(dmgClear > 0, "must clear quarantine on the DMG itself");
  assert.ok(attach > 0, "must mount the DMG");
  // 顺序错了的话，挂载后里面的 app 会继承 DMG 的隔离属性。
  assert.ok(dmgClear < attach, "quarantine must be cleared BEFORE mounting");
});

// 回归守卫：签名必须由深到浅。先签外层会让已签的内层失效，
// 于是 app 能打开但内置 FFmpeg/Blender 一跑就被内核杀掉。
test("orders signing from deepest path to shallowest", () => {
  assert.match(source, /sort -rn/, "must sort by descending path length");
  const order = source.indexOf("ordered.txt");
  const signLoop = source.indexOf('codesign --force --sign - --timestamp=none "$candidate"');
  assert.ok(order > 0 && signLoop > order, "signing loop must consume the depth-ordered list");
});

test("guards on platform and privileges before mutating anything", () => {
  const unameGuard = source.indexOf("uname -s");
  const idGuard = source.indexOf("id -u");
  const firstMutation = source.indexOf("xattr -dr");
  assert.ok(unameGuard > 0, "must check for macOS");
  assert.ok(idGuard > 0, "must require root");
  assert.ok(
    unameGuard < firstMutation && idGuard < firstMutation,
    "guards must run before any filesystem mutation",
  );
});

test("cleans up the mount point and temp dir on every exit", () => {
  assert.match(source, /trap cleanup EXIT/, "must register an exit trap");
  assert.match(source, /hdiutil detach/, "must detach the mounted DMG");
  assert.match(source, /rm -rf "\$work_dir"/, "must remove its temp dir");
});

test("mentions no developer certificate requirement", () => {
  // 整个脚本的前提就是「没有 Apple 证书」，出现签名身份要求即为写错。
  assert.ok(
    !/Developer ID Application:/.test(source),
    "the unsigned-install path must not require a Developer ID identity",
  );
});

// ---------------------------------------------------------------------------
// 回归守卫：tauri.conf.json 必须让 Tauri 真的签名。
// ---------------------------------------------------------------------------

// 这是用户实际踩到的坑：bundle.macOS 里没有 signingIdentity 时，Tauri **整段跳过签名**
// （不打日志、也不退回 ad-hoc），产出的未签名 bundle 在 macOS 上被报成
// 「已损坏，无法打开」——连绕过 Gatekeeper 的机会都没有。设成 "-" 才会执行 ad-hoc 签名。
test("tauri.conf.json pins an ad-hoc signing identity so bundles are never unsigned", () => {
  const confPath = path.resolve(path.dirname(SCRIPT), "..", "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  assert.equal(
    conf?.bundle?.macOS?.signingIdentity,
    "-",
    'bundle.macOS.signingIdentity must be "-" (ad-hoc); otherwise Tauri skips signing entirely and the app is reported as damaged',
  );
});

// 同一条守卫的另一半：BOM 会让 serde_json 直接报错（"expected value at line 1 column 1"），
// 而编辑器/PowerShell 很容易在无意间写入 BOM。构建整个挂在解析配置上，值得一条用例钉住。
test("tauri.conf.json carries no UTF-8 BOM", () => {
  const confPath = path.resolve(path.dirname(SCRIPT), "..", "src-tauri", "tauri.conf.json");
  const raw = readFileSync(confPath);
  assert.notDeepEqual(
    [...raw.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    "tauri.conf.json must not start with a UTF-8 BOM; serde_json fails to parse it",
  );
});

// ---------------------------------------------------------------------------
// 参数契约：需要 bash，走 --dry-run 完整执行解析逻辑。
// ---------------------------------------------------------------------------

/** 跑一次 dry-run，返回 { status, stdout, stderr }。 */
function dryRun(args, options = {}) {
  const result = spawnSync(bash, [SCRIPT, ...args], { encoding: "utf8", ...options });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withTempDir(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ic-install-test-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script exists and parses as bash", skipWithoutBash, () => {
  assert.ok(existsSync(SCRIPT), "install-macos.sh must exist");
  const syntax = spawnSync(bash, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `bash -n failed:\n${syntax.stderr}`);
});

test("--help prints usage without touching the system", skipWithoutBash, () => {
  const result = dryRun(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /install-macos/);
  assert.match(result.stdout, /--no-install/, "help must mention --no-install");
  assert.match(result.stdout, /--dry-run/, "help must mention --dry-run");
});

test("a missing path and a missing argument both fail loudly", skipWithoutBash, () => {
  // 没有给路径：必须报用法，而不是静默什么都不做。
  const noArgs = dryRun([]);
  assert.notEqual(noArgs.status, 0);
  assert.match(noArgs.stderr, /用法|失败/);

  // 给了不存在的路径：必须明确报找不到。
  const missing = dryRun(["/definitely/not/here.dmg", "--dry-run"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /找不到/);
});

test("an unknown flag is rejected instead of ignored", skipWithoutBash, () =>
  withTempDir((dir) => {
    const dmg = path.join(dir, "app.dmg");
    writeFileSync(dmg, "not a real dmg");
    const result = dryRun([dmg, "--nonsense"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未知参数/);
  }),
);

// 回归守卫：.dmg 与 .app 必须被区分开（前者要挂载、后者直接用），
// 而无法识别的扩展名必须被拒绝——否则脚本会拿着一个 .zip 去 hdiutil attach。
test("dry-run classifies the source and reports the resolved plan", skipWithoutBash, () =>
  withTempDir((dir) => {
    const dmg = path.join(dir, "无限画布_0.1.0_aarch64.dmg");
    writeFileSync(dmg, "stub");
    const dmgPlan = dryRun([dmg, "--dry-run"]);
    assert.equal(dmgPlan.status, 0, dmgPlan.stderr);
    assert.match(dmgPlan.stdout, /kind=dmg/);
    assert.match(dmgPlan.stdout, /target=\/Applications/);
    assert.match(dmgPlan.stdout, /install=1/);

    const appDir = path.join(dir, "无限画布.app");
    mkdirSync(appDir);
    const appPlan = dryRun([appDir, "--dry-run"]);
    assert.equal(appPlan.status, 0, appPlan.stderr);
    assert.match(appPlan.stdout, /kind=app/);

    const zip = path.join(dir, "bundle.zip");
    writeFileSync(zip, "stub");
    const rejected = dryRun([zip, "--dry-run"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /无法识别的文件类型/);
  }),
);

test("--target and --no-install are honoured in the resolved plan", skipWithoutBash, () =>
  withTempDir((dir) => {
    const dmg = path.join(dir, "app.dmg");
    writeFileSync(dmg, "stub");
    const result = dryRun([dmg, "--target", "/tmp/custom-place", "--no-install", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target=\/tmp\/custom-place/);
    assert.match(result.stdout, /install=0/);
  }),
);

test("only one source path may be given", skipWithoutBash, () =>
  withTempDir((dir) => {
    const first = path.join(dir, "a.dmg");
    const second = path.join(dir, "b.dmg");
    writeFileSync(first, "stub");
    writeFileSync(second, "stub");
    const result = dryRun([first, second, "--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /只能指定一个/);
  }),
);

// 真实执行路径必须有平台与权限守卫：在非 macOS 上不能尝试调用 hdiutil。
// 注意 --dry-run 会提前退出，因此这里断言的是**不带** dry-run 的行为。
test("a real run is gated on macOS", skipWithoutBash, () =>
  withTempDir((dir) => {
    const dmg = path.join(dir, "app.dmg");
    writeFileSync(dmg, "stub");
    const result = dryRun([dmg]);
    if (IS_MACOS) {
      // macOS 上先撞到的是权限检查（测试环境非 root）。
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /管理员权限|失败/);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /只在 macOS 上运行/);
    }
  }),
);
