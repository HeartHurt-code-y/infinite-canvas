import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPLE_DEVELOPMENT_PREFIX,
  decideSigningOutcome,
  DEVELOPER_ID_PREFIX,
  isDistributionGrade,
  LOCAL_PREFIX,
  parseSecurityFindIdentityOutput,
  planSigningIdentity,
  publishEnvironment,
  selectSigningIdentity,
} from "./macos-signing-identity.mjs";

// 这些用例守的是同一件事：**打包前必须挑出一个确定且稳定的签名身份**。
// 只要 `tauri build` 拿不到稳定身份，产物的 code identity 就会随代码变化（未签名时
// 顶多是链接器给的 ad-hoc 签名，其 requirement 就是 cdhash），钥匙串 ACL 随即失配，
// macOS 会请用户输入登录钥匙串密码——这正是「新 mac 包每次升级都弹窗」的根因。

const DEVELOPER_ID = {
  hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  name: `${DEVELOPER_ID_PREFIX} Infinite Canvas (TEAM123456)`,
};
const SECOND_DEVELOPER_ID = {
  hash: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  name: `${DEVELOPER_ID_PREFIX} AAA Older Cert (TEAM123456)`,
};
const APPLE_DEVELOPMENT = {
  hash: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  name: `${APPLE_DEVELOPMENT_PREFIX} dev@example.com (TEAM123456)`,
};

test("publishes the selected identity to Codemagic's later steps", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "canvas-codemagic-env-"));
  try {
    const cmEnv = path.join(directory, "cm.env");
    assert.equal(
      await publishEnvironment({ APPLE_SIGNING_IDENTITY: DEVELOPER_ID.name }, { CM_ENV: cmEnv }),
      true,
    );
    assert.equal(readFileSync(cmEnv, "utf8"), `APPLE_SIGNING_IDENTITY=${DEVELOPER_ID.name}\n`);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parses identities and ignores the trailing summary line", () => {
  const output = [
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Infinite Canvas (TEAM123456)"',
    '  2) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Development: dev@example.com (TEAM123456)"',
    "     2 valid identities found",
    "",
  ].join("\n");

  assert.deepEqual(parseSecurityFindIdentityOutput(output), [DEVELOPER_ID, APPLE_DEVELOPMENT]);
  // 只有汇总行、没有身份时必须是空数组，而不是解析出一个假身份。
  assert.deepEqual(parseSecurityFindIdentityOutput("     0 valid identities found\n"), []);
});

test("an untrusted or empty cert name is not treated as a usable identity", () => {
  assert.deepEqual(
    parseSecurityFindIdentityOutput('  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ""\n'),
    [],
  );
});

// 回归守卫：没有显式指定时优先 Developer ID，且选择必须**确定**。
// 若这里退化成字典序之外的不稳定选择（或挑到 Apple Development），
// 打包出来的包对用户的钥匙串表现就会随构建而变。
test("prefers Developer ID and picks deterministically by name", () => {
  const selected = selectSigningIdentity(
    [DEVELOPER_ID, SECOND_DEVELOPER_ID, APPLE_DEVELOPMENT],
    "",
  );
  assert.equal(selected.name, SECOND_DEVELOPER_ID.name);

  // 输入顺序颠倒也必须得到同一个身份——稳定性是这段逻辑唯一的产出。
  const reversed = selectSigningIdentity(
    [APPLE_DEVELOPMENT, SECOND_DEVELOPER_ID, DEVELOPER_ID],
    "",
  );
  assert.equal(reversed.name, SECOND_DEVELOPER_ID.name);
});

test("falls back to Apple Development only when no Developer ID exists", () => {
  assert.equal(selectSigningIdentity([APPLE_DEVELOPMENT], "").name, APPLE_DEVELOPMENT.name);

  // Apple Development 只够本机开发，绝不能当成可分发身份。
  assert.equal(
    isDistributionGrade(
      planSigningIdentity({ platform: "darwin", identities: [APPLE_DEVELOPMENT] }),
    ),
    false,
  );
});

test("an explicitly requested identity wins, by name or by 40-hex hash", () => {
  const byName = planSigningIdentity({
    platform: "darwin",
    requested: APPLE_DEVELOPMENT.name,
    identities: [DEVELOPER_ID, APPLE_DEVELOPMENT],
  });
  assert.equal(byName.status, "resolved");
  assert.equal(byName.identity.name, APPLE_DEVELOPMENT.name);
  // 显式指定成 Apple Development 时，来源必须如实标成 apple-development。
  assert.equal(byName.source, "apple-development");

  const byHash = planSigningIdentity({
    platform: "darwin",
    requested: DEVELOPER_ID.hash.toLowerCase(),
    identities: [DEVELOPER_ID, APPLE_DEVELOPMENT],
  });
  assert.equal(byHash.status, "resolved");
  assert.equal(byHash.identity.name, DEVELOPER_ID.name);
  assert.equal(byHash.source, "developer-id");
  assert.equal(isDistributionGrade(byHash), true);
});

// 回归守卫：显式指定的身份不在钥匙串里时**必须**报错，而不是静默挑别的证书。
// 静默回退会让产物在只留下一条日志告警的情况下降级（Developer ID → Apple Development），
// 这正是「CI 绿了但发出去的包还是弹密码框」的成因。
test("a requested identity missing from the keychain is a hard miss, never a silent swap", () => {
  const missingName = `${DEVELOPER_ID_PREFIX} 并不存在的证书 (TEAM123456)`;
  const plan = planSigningIdentity({
    platform: "darwin",
    requested: missingName,
    identities: [APPLE_DEVELOPMENT],
  });
  assert.equal(plan.status, "requested-missing");
  assert.equal(plan.requested, missingName);
});

test("no usable identity yields a missing plan instead of a fabricated one", () => {
  assert.deepEqual(planSigningIdentity({ platform: "darwin", identities: [] }), {
    status: "missing",
    requested: "",
  });
});

test("non-macOS platforms are skipped rather than failed", () => {
  for (const platform of ["win32", "linux"]) {
    assert.deepEqual(planSigningIdentity({ platform, identities: [] }), {
      status: "unsupported-platform",
      platform,
    });
  }
});

// 回归守卫：分发流水线只认 Developer ID。
// 构建机上留一张 Apple Development 证书是很常见的事；如果放行条件写成「有身份即可」，
// CI 会变绿、产物却依然不能分发给用户——这个用例钉住的就是这条边界。
test("a distribution build refuses anything that is not Developer ID", () => {
  const developmentOnly = planSigningIdentity({
    platform: "darwin",
    identities: [APPLE_DEVELOPMENT],
  });
  assert.equal(developmentOnly.status, "resolved");

  const gate = { requireIdentity: true, requireDistribution: true };
  assert.deepEqual(decideSigningOutcome(developmentOnly, gate), {
    allowed: false,
    publish: false,
  });

  const developerIdPlan = planSigningIdentity({
    platform: "darwin",
    identities: [DEVELOPER_ID, APPLE_DEVELOPMENT],
  });
  assert.equal(decideSigningOutcome(developerIdPlan, gate).allowed, true);
  assert.equal(decideSigningOutcome(developerIdPlan, gate).identity.name, DEVELOPER_ID.name);
});

test("a missing identity fails a requiring build but only warns otherwise", () => {
  const missing = planSigningIdentity({ platform: "darwin", identities: [] });

  assert.equal(decideSigningOutcome(missing, { requireIdentity: true }).allowed, false);
  // 本机开发（未加 --require）允许继续，但要明确不发布身份，避免误当成已签名的包。
  assert.deepEqual(decideSigningOutcome(missing, {}), { allowed: true, publish: false });
});

test("--require still accepts Apple Development for local development", () => {
  const developmentOnly = planSigningIdentity({
    platform: "darwin",
    identities: [APPLE_DEVELOPMENT],
  });
  const decision = decideSigningOutcome(developmentOnly, { requireIdentity: true });
  assert.equal(decision.allowed, true);
  assert.equal(decision.publish, true);
});

// 回归守卫：本机自签身份必须能被自动选中，且来源标注正确。
// 拿不到 Apple 证书时（例如自签证书或企业 CA）它需要能被自动选中；
// 若这里挑不中，预检会直接失败，用户就「装完还是不能用」。
test("the local self-signed identity is selected and labelled distinctly", () => {
  const localOnly = planSigningIdentity({
    platform: "darwin",
    identities: [{ hash: "D".repeat(40), name: `${LOCAL_PREFIX}` }],
  });
  assert.equal(localOnly.status, "resolved");
  assert.equal(localOnly.source, "local-self-signed");
  // 自签身份只够本机：绝不能被当成可分发身份。
  assert.equal(isDistributionGrade(localOnly), false);

  // 本机开发（--require）放行；分发流水线拒绝。
  assert.equal(decideSigningOutcome(localOnly, { requireIdentity: true }).allowed, true);
  assert.equal(
    decideSigningOutcome(localOnly, { requireIdentity: true, requireDistribution: true }).allowed,
    false,
  );
});

test("a real Developer ID outranks a local self-signed identity on a dev machine", () => {
  const selected = selectSigningIdentity(
    [{ hash: "D".repeat(40), name: `${LOCAL_PREFIX}` }, DEVELOPER_ID],
    "",
  );
  assert.equal(selected.name, DEVELOPER_ID.name);
});

test(
  "bundle verifier accepts ad-hoc and Developer ID, but rejects unsigned or invalid signatures",
  {
    skip: !["bash", "/bin/bash", "C:/Git/bin/bash.exe"].some((candidate) => {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      return !probe.error && probe.status === 0;
    })
      ? "bash is unavailable"
      : false,
  },
  () => {
    const bash = ["bash", "/bin/bash", "C:/Git/bin/bash.exe"].find((candidate) => {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      return !probe.error && probe.status === 0;
    });
    const directory = mkdtempSync(path.join(os.tmpdir(), "canvas-signing-test-"));
    try {
      const app = path.join(directory, "Fixture.app");
      const mock = path.join(directory, "mock-macos-tools.sh");
      mkdirSync(app);
      writeFileSync(
        mock,
        `
uname() { printf 'Darwin\\n'; }
codesign() {
  case "$1" in
    -dv)
      case "$IC_TEST_SIGNING_MODE" in
        adhoc|invalid) printf 'Signature=adhoc\\nTeamIdentifier=not set\\n' ;;
        developer|developer-cdhash) printf 'Signature=size(1234)\\nAuthority=Developer ID Application: Test (TEAM123456)\\nTeamIdentifier=TEAM123456\\n' ;;
        unsigned) printf 'code object is not signed at all\\n' >&2; return 1 ;;
      esac
      ;;
    --verify) [ "$IC_TEST_SIGNING_MODE" != invalid ] ;;
    -d)
      if [ "$IC_TEST_SIGNING_MODE" = developer ]; then
        printf 'designated => identifier "com.infinitecanvas.desktop" and anchor apple generic\\n'
      else
        printf 'designated => identifier "com.infinitecanvas.desktop" and cdhash H"012345"\\n'
      fi
      ;;
    *) return 1 ;;
  esac
}
spctl() { return 1; }
`,
        "utf8",
      );
      const script = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "verify-macos-bundle.sh",
      );
      const run = (mode) =>
        spawnSync(bash, [script, app], {
          encoding: "utf8",
          env: { ...process.env, BASH_ENV: mock, IC_TEST_SIGNING_MODE: mode },
        });
      const adhoc = run("adhoc");
      assert.equal(adhoc.status, 0, adhoc.stderr);
      assert.match(adhoc.stdout, /身份等级：ad-hoc/);
      const developer = run("developer");
      assert.equal(developer.status, 0, developer.stderr);
      assert.match(developer.stdout, /身份等级：Developer ID/);
      assert.equal(run("developer-cdhash").status, 1);
      assert.equal(run("unsigned").status, 1);
      assert.equal(run("invalid").status, 1);
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
