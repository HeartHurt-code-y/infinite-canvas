// Build-time only: guarantee the macOS bundle carries a *stable* code signing
// identity before Tauri signs it.
//
// 背景（macOS 安装包每次升级都弹「想要访问你的钥匙串中的密钥」的根因）：
//
// 所有密钥（供应商 API Key / 素材库令牌 / TOS AK-SK）都由 keyring 的
// `apple-native` 后端写进**登录钥匙串**，服务名 `com.infinitecanvas.desktop`。
// 该后端调用的是旧版 Keychain Services API（`SecKeychainAddGenericPassword` /
// `SecKeychainFindGenericPassword`，见 security-framework 的 passwords.rs），
// 建条目时会给条目挂上一条 ACL，ACL 里记录的是「创建它的那个应用」的
// **代码签名身份**。
//
// 为什么不签名一样会弹这个框：没有 `APPLE_SIGNING_IDENTITY` 也没有 `APPLE_CERTIFICATE`
// 时，Tauri **不做任何签名**（tauri-bundler 的 `keychain()` 返回 None，整段签名流程被跳过，
// 且不打日志——不会退回 ad-hoc）。此时可执行文件顶多带着链接器给的 ad-hoc 签名，
// 而 ad-hoc 没有 Team ID，designated requirement 退化成 `cdhash H"…"`——**cdhash 就是
// 代码本身的哈希**，于是每出一个新版本、哪怕只改一行，代码身份就变了。新版本去读旧条目时
// ACL 匹配不上，macOS 只能请用户输入登录钥匙串密码来授权。
//
// 结论：这不是 keyring 用法或 feature 配置的 bug（两者都已正确，见
// src-tauri/Cargo.toml 的 apple-native 与 backend/credentials.rs 的持久化守卫），
// 而是**签名身份不稳定 / 缺失**。签上证书后 designated requirement 锚定到证书
// （`identifier "com.infinitecanvas.desktop" and certificate leaf[…]`），跨版本恒定，
// 钥匙串不再弹窗。
//
// 因此本脚本在打包前把身份定下来：解析得出唯一确定的 identity 写进
// GITHUB_ENV / 标准输出，让 `tauri build` 通过 APPLE_SIGNING_IDENTITY 沿用
// （Tauri CLI 2.11.4 读取该环境变量，已核实其二进制内字符串）。
// `--require` 下拿不到身份就直接失败——让 CI 红，而不是把「会弹密码框」的包
// 发给用户。
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SIGNING_IDENTITY_ENV = "APPLE_SIGNING_IDENTITY";
export const IDENTITY_SOURCE_ENV = "INFINITE_CANVAS_SIGNING_IDENTITY_SOURCE";

/** 分发到用户机器必须用 Developer ID；Apple Development 仅够本机开发自测。 */
export const DEVELOPER_ID_PREFIX = "Developer ID Application:";
export const APPLE_DEVELOPMENT_PREFIX = "Apple Development:";
/**
 * 本机自签的代码签名身份（无 Apple 证书时唯一的签名手段）。
 *
 * 它没有 Apple Team ID，但证书 subject 稳定，因此 designated requirement 锚定到证书
 * 而不是 cdhash——钥匙串 ACL 跨版本不失配。这正是「拿不到 Apple 证书也不弹窗」的原理。
 * 它是本机专用身份，**不能**分发给其他用户。
 */
export const LOCAL_PREFIX = "Infinite Canvas Local Signing";

export const EXIT_UNSUPPORTED_PLATFORM = 2;
export const EXIT_NO_USABLE_IDENTITY = 3;

/**
 * 解析 `security find-identity -v -p codesigning` 的输出。
 *
 * 行格式：`  1) 0A1B… "Developer ID Application: Foo (TEAMID)"`
 * 末尾的 `N valid identities found` 汇总行不含引号，天然被过滤掉。
 */
export function parseSecurityFindIdentityOutput(output) {
  const identities = [];
  for (const line of String(output ?? "").split("\n")) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]*)"/);
    if (match === null) continue;
    const [, hash, name] = match;
    if (name.trim().length === 0) continue;
    identities.push({ hash: hash.toUpperCase(), name: name.trim() });
  }
  return identities;
}

/**
 * 从候选身份里挑出唯一确定的一个。
 *
 * 优先级：显式指定 > Developer ID > Apple Development > 本机自签 > 任意 codesigning。
 * 每条规则内部按名字字典序取最小，保证同一台机器反复构建得到**同一个**身份——
 * 确定性本身就是这个脚本存在的意义。
 */
export function selectSigningIdentity(identities, preferred) {
  const preferredName = typeof preferred === "string" ? preferred.trim() : "";
  if (preferredName.length > 0) {
    const exact = identities.find((identity) => identity.name === preferredName);
    if (exact !== undefined) return exact;
    // 名字没匹配上时再给一次机会：调用方可能传的是 40 位证书哈希（codesign 也认）。
    const byHash = identities.find(
      (identity) => identity.hash.toUpperCase() === preferredName.toUpperCase(),
    );
    if (byHash !== undefined) return byHash;
    // 显式要求了身份却没找到：**不**退回自动挑选。
    // 静默换一个证书会让产物在不知不觉中降级（例如从 Developer ID 变成
    // Apple Development），而失败信息只淹没在日志里。这里直接把选择权交回调用方。
    return null;
  }

  for (const prefix of [DEVELOPER_ID_PREFIX, APPLE_DEVELOPMENT_PREFIX, LOCAL_PREFIX]) {
    const matches = identities
      .filter((identity) => identity.name.startsWith(prefix))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matches.length > 0) return matches[0];
  }

  return [...identities].sort((left, right) => left.name.localeCompare(right.name))[0] ?? null;
}

/**
 * 判断当前环境是否具备「跨版本稳定」的钥匙串访问前提。
 *
 * 这是纯决策函数，与平台和钥匙串无关，因此可以在任何开发机上被用例覆盖。
 * 返回值里的 `source` 正是 `--require` 失败时给人看的那句话。
 */
export function planSigningIdentity({ platform, requested, identities } = {}) {
  if (platform !== "darwin") {
    return { status: "unsupported-platform", platform: platform ?? "unknown" };
  }

  const preferred = typeof requested === "string" ? requested.trim() : "";
  const selected = selectSigningIdentity(identities ?? [], preferred);
  if (selected === null) {
    // 区分两种「拿不到身份」：显式指定但不存在（配置错了）vs 本机压根没有。
    // 两者的修复动作不同，所以状态必须分开，不能都报成 missing。
    return { status: preferred.length > 0 ? "requested-missing" : "missing", requested: preferred };
  }

  let source;
  if (selected.name.startsWith(DEVELOPER_ID_PREFIX)) {
    source = "developer-id";
  } else if (selected.name.startsWith(APPLE_DEVELOPMENT_PREFIX)) {
    source = "apple-development";
  } else if (selected.name.startsWith(LOCAL_PREFIX)) {
    source = "local-self-signed";
  } else {
    source = "other-codesigning";
  }

  return { status: "resolved", identity: selected, source };
}

/** Developer ID 之外的身份（尤其 Apple Development）不足以分发给终端用户。 */
export function isDistributionGrade(plan) {
  return plan?.status === "resolved" && plan.source === "developer-id";
}

/**
 * 决定这次预检是否放行，以及是否要把身份写回环境。
 *
 * 单独抽成纯函数是因为「放行条件」正是修这个 bug 的核心：它决定了会不会有
 * 一个没签名的包被发给用户。放在 main 里就只能靠读代码确认。
 */
export function decideSigningOutcome(
  plan,
  { requireIdentity = false, requireDistribution = false } = {},
) {
  if (plan?.status === "resolved" && (isDistributionGrade(plan) || !requireDistribution)) {
    return { allowed: true, publish: true, identity: plan.identity };
  }
  return { allowed: !requireIdentity, publish: false };
}

export function isMacOS(platform = process.platform) {
  return platform === "darwin";
}

function listCodesigningIdentities() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`无法执行 security find-identity：${result.error.message}`);
  }
  const identities = parseSecurityFindIdentityOutput(result.stdout);
  if (identities.length === 0 && result.status !== 0) {
    throw new Error(
      `security find-identity 退出码 ${result.status}：${(result.stderr ?? "").trim()}`,
    );
  }
  return identities;
}

async function publishEnvironment(values) {
  const githubEnv = process.env.GITHUB_ENV;
  if (typeof githubEnv !== "string" || githubEnv.length === 0) return false;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await appendFile(githubEnv, `${lines.join("\n")}\n`, "utf8");
  return true;
}

async function main() {
  // --require-distribution 同时约束两件事：必须有身份，且必须是 Developer ID。
  // 只要求「有身份」是不够的：构建机上可能残留一张 Apple Development 证书，
  // 自动挑选会挑到它，于是 CI 变绿、产物却仍然不能分发给用户。
  const requireDistribution = process.argv.includes("--require-distribution");
  const requiredIdentity = requireDistribution || process.argv.includes("--require");

  if (!isMacOS()) {
    console.log(`[macos-signing-identity] 非 macOS（${process.platform}），跳过签名身份检查。`);
    return 0;
  }

  const requested = (process.env[SIGNING_IDENTITY_ENV] ?? "").trim();
  const identities = listCodesigningIdentities();
  const plan = planSigningIdentity({ platform: process.platform, requested, identities });
  const decision = decideSigningOutcome(plan, {
    requireIdentity: requiredIdentity,
    requireDistribution,
  });

  if (decision.allowed && decision.publish) {
    console.log(`[macos-signing-identity] 使用签名身份（${plan.source}）：${plan.identity.name}`);
    if (!isDistributionGrade(plan)) {
      console.warn(
        "[macos-signing-identity] 该身份不是 Developer ID Application：钥匙串访问在**同一台机器**上可保持稳定，" +
          "但这样的包分发给其他用户会被 Gatekeeper 拦下，且需要用户手动信任。",
      );
    }
    await publishEnvironment({
      [SIGNING_IDENTITY_ENV]: plan.identity.name,
      [IDENTITY_SOURCE_ENV]: plan.source,
    });
    return 0;
  }

  // 走到这里有两种情况：没有可用身份，或是要求 Developer ID 却只找到别的身份。
  const notDistributionGrade = plan.status === "resolved";
  const detail = notDistributionGrade
    ? `只找到「${plan.identity.name}」，它${plan.source === "apple-development" ? "是 Apple Development 证书" : "不是 Developer ID Application 证书"}，` +
      "不能用于分发（其他用户的 Gatekeeper 会拦下，且只有本机构建能复用钥匙串授权）。"
    : plan.status === "requested-missing"
      ? `指定的 ${SIGNING_IDENTITY_ENV}="${plan.requested}" 不在本机钥匙串的签名身份中。` +
        "（CI 上常见原因：APPLE_SIGNING_IDENTITY 与 APPLE_CERTIFICATE 导入出的证书名不一致。）"
      : "本机钥匙串没有任何可用的 codesigning 身份。";
  const remedy = [
    `[macos-signing-identity] ${detail}`,
    "",
    notDistributionGrade
      ? "  缺少可分发身份时产出的包要么被 Gatekeeper 拦下，要么每次升级都重新弹钥匙串密码。"
      : "  继续构建将得到一个未签名（或仅 ad-hoc）的包：每次升级都会弹「想要访问你的钥匙串中的密钥」，",
    notDistributionGrade ? "" : "  用户必须输入登录密码，密钥才会被重新授权。",
    "",
    "  修复方式（任选其一）：",
    "    1. 分发用（推荐）：Apple Developer Program 的 “Developer ID Application” 证书，",
    "       用 security import 装进构建机的钥匙串（CI 见 .github/workflows/macos-package.yml）。",
    "    2. 仅本机开发：Xcode 用任意 Apple ID 登录一次并生成 “Apple Development” 证书，",
    "       钥匙串弹窗在同一台机器上同样会消失（但该证书不能分发给别人）。",
    "",
    "  查看本机可用身份：security find-identity -v -p codesigning",
  ].join("\n");

  if (requiredIdentity) {
    console.error(remedy);
    return EXIT_NO_USABLE_IDENTITY;
  }

  console.warn(remedy);
  console.warn(
    "[macos-signing-identity] 未加 --require/--require-distribution，本次仅告警并继续（该包不会获得稳定签名身份）。",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main();
}
