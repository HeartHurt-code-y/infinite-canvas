import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCandidates,
  filterSiteCookies,
  matchesCookieApex,
  parseLoginRequest,
  siteForHost,
  summarizeErrorDetail,
} from "./capture-login.mjs";

test("错误摘要只取首行并截断到 200 字符", () => {
  assert.equal(
    summarizeErrorDetail(new Error("launch failed\n  at deep stack")),
    "launch failed",
  );
  assert.equal(summarizeErrorDetail(new Error(`x`.repeat(500))).length, 200);
  assert.equal(summarizeErrorDetail(new Error("  \n second")), undefined);
  assert.equal(summarizeErrorDetail(undefined), undefined);
  assert.equal(summarizeErrorDetail(new Error("")), undefined);
});

test("登录捕获只接受三个受支持站点的 https 链接与绝对 profileDir", () => {
  const request = parseLoginRequest(
    JSON.stringify({
      url: "https://www.douyin.com/video/7672064275116162235#share",
      profileDir: "/tmp/login-profile",
    }),
  );
  assert.equal(request.site, "douyin");
  assert.equal(request.url, "https://www.douyin.com/video/7672064275116162235");
  assert.equal(request.profileDir, "/tmp/login-profile");
  assert.equal(siteForHost("v.douyin.com"), "douyin");
  assert.equal(siteForHost("www.xiaohongshu.com"), "rednote");
  assert.equal(siteForHost("b23.tv"), "bilibili");
  assert.equal(siteForHost("www.douyin.com.attacker.example"), null);
  assert.equal(siteForHost("example.com"), null);

  for (const invalid of [
    JSON.stringify({ url: "http://www.douyin.com/video/1", profileDir: "/tmp/p" }),
    JSON.stringify({ url: "https://user:pass@www.douyin.com/video/1", profileDir: "/tmp/p" }),
    JSON.stringify({ url: "https://www.example.com/video/1", profileDir: "/tmp/p" }),
    JSON.stringify({ url: "https://www.douyin.com/video/1", profileDir: "relative/path" }),
    JSON.stringify({ url: "https://www.douyin.com/video/1", profileDir: "/tmp/p", extra: 1 }),
    JSON.stringify({ url: "https://www.douyin.com/video/1" }),
    "not json",
  ]) {
    assert.throws(() => parseLoginRequest(invalid));
  }
});

test("Cookie 过滤只保留目标站点主域且逐条丢弃非法字段", () => {
  assert.equal(matchesCookieApex(".douyin.com", "douyin"), true);
  assert.equal(matchesCookieApex("v.douyinvod.com", "douyin"), false);
  assert.equal(matchesCookieApex(".xiaohongshu.com.evil.example", "rednote"), false);

  const cookies = filterSiteCookies(
    [
      { name: "sessionid", value: "secret", domain: ".douyin.com", path: "/", secure: true, httpOnly: true, expires: 4102444800 },
      { name: "ttwid", value: "device", domain: "douyin.com", path: "/" },
      { name: "unrelated", value: "x", domain: ".example.com", path: "/" },
      { name: "lookalike", value: "x", domain: ".douyin.com.evil.example", path: "/" },
      { name: "bad name", value: "x", domain: ".douyin.com", path: "/" },
      { name: "bad_value", value: "x\ny", domain: ".douyin.com", path: "/" },
      { name: "bad_path", value: "x", domain: ".douyin.com", path: "no-slash" },
      { name: "bad_expiry", value: "x", domain: ".douyin.com", path: "/", expires: 5000000000 },
      "not-an-object",
      null,
    ],
    "douyin",
  );
  assert.deepEqual(
    cookies.map((cookie) => cookie.name),
    ["sessionid", "ttwid"],
  );
  assert.equal(cookies[0].domain, ".douyin.com");
  assert.equal(cookies[0].expires, 4102444800);
  assert.equal(filterSiteCookies("nope", "douyin").length, 0);
  // 上限封顶，防止异常站点输出撑爆会话文件。
  const flood = filterSiteCookies(
    Array.from({ length: 80 }, (_, index) => ({
      name: `c${index}`,
      value: "v",
      domain: ".bilibili.com",
      path: "/",
    })),
    "bilibili",
  );
  assert.equal(flood.length, 64);
});

test("浏览器候选清单覆盖 Edge/Chrome/Brave/Chromium 且按平台生成", () => {
  const candidates = browserCandidates();
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => typeof candidate === "string"));
  if (process.platform === "win32") {
    assert.ok(candidates.some((candidate) => candidate.toLowerCase().endsWith("msedge.exe")));
  }
});
