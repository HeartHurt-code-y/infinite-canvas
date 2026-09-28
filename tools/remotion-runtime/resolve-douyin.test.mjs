import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isAllowedMediaUrl,
  parseDouyinInput,
  parseDouyinRequest,
  selectH264MediaUrls,
} from "./resolve-douyin.mjs";

test("Douyin resolver accepts official links and rejects host lookalikes", () => {
  assert.deepEqual(parseDouyinInput("https://www.douyin.com/video/7672064275116162235"), {
    kind: "direct",
    id: "7672064275116162235",
  });
  assert.deepEqual(parseDouyinInput("https://v.douyin.com/abc_DEF/"), {
    kind: "short",
    url: "https://v.douyin.com/abc_DEF/",
  });
  assert.throws(() => parseDouyinInput("https://www.douyin.com.attacker.example/video/7672064275116162235"));
  assert.throws(() => parseDouyinInput("https://user:pass@www.douyin.com/video/7672064275116162235"));
  assert.throws(() => parseDouyinInput("http://www.douyin.com:8080/video/7672064275116162235"));
});

test("Douyin resolver binds exact video identity and filters media hosts", () => {
  const id = "7672064275116162235";
  const trusted = "https://v26-web.douyinvod.com/video/path?token=opaque";
  assert.equal(isAllowedMediaUrl(trusted), true);
  assert.equal(isAllowedMediaUrl("http://v26-web.douyinvod.com/video/path"), false);
  assert.equal(isAllowedMediaUrl("https://v26-web.douyinvod.com.attacker.example/path"), false);
  assert.equal(isAllowedMediaUrl("https://user:pass@v26-web.douyinvod.com/path"), false);
  const detail = {
    aweme_id: id,
    video: {
      duration: 70636,
      play_addr_h264: {
        url_list: [
          "https://www.douyin.com/redirect",
          trusted,
          trusted,
          "https://v11-weba.douyinvod.com/video/path",
        ],
      },
      bit_rate: [{ is_h265: 0, play_addr: { url_list: ["https://v3.douyinvod.com/path"] } }],
    },
  };
  assert.deepEqual(selectH264MediaUrls(detail, id), {
    videoId: id,
    durationMs: 70636,
    mediaUrls: [
      trusted,
      "https://v11-weba.douyinvod.com/video/path",
      "https://v3.douyinvod.com/path",
    ],
  });
  assert.throws(() => selectH264MediaUrls(detail, "7672064275116162236"));
});

test("Douyin resolver rejects hostile input without echoing URL or token", () => {
  const input = "https://www.douyin.com.attacker.example/video/7672064275116162235?token=private";
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./resolve-douyin.mjs", import.meta.url)), "C:\\missing-chrome.exe"],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "unsupported_url" });
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes("private"));
});

test("Douyin resolver accepts legacy URL and scoped-cookie JSON on stdin", () => {
  const url = "https://www.douyin.com/video/7672064275116162235";
  assert.deepEqual(parseDouyinRequest(url), { url, cookies: [] });
  assert.deepEqual(parseDouyinRequest(JSON.stringify({
    url,
    cookies: [
      { name: "sessionid", value: "opaque", domain: ".douyin.com" },
      { name: "passport", value: "opaque", domain: "passport.douyin.com" },
    ],
  })), {
    url,
    cookies: [
      { name: "sessionid", value: "opaque", domain: ".douyin.com", path: "/" },
      { name: "passport", value: "opaque", domain: "passport.douyin.com", path: "/" },
    ],
  });
});

test("Douyin resolver rejects foreign or malformed cookies without echoing credentials", () => {
  const url = "https://www.douyin.com/video/7672064275116162235";
  for (const cookie of [
    { name: "sessionid", value: "secret", domain: ".evil.example" },
    { name: "sessionid", value: "secret", domain: ".douyin.com.evil.example" },
    { name: "bad name", value: "secret", domain: ".douyin.com" },
    { name: "sessionid", value: "secret\nheader", domain: ".douyin.com" },
    { name: "sessionid", value: "secret", domain: ".douyin.com", url: "https://evil.example" },
    { name: "sessionid", value: "secret", domain: ".douyin.com", sameSite: "None", secure: false },
  ]) {
    assert.throws(() => parseDouyinRequest(JSON.stringify({ url, cookies: [cookie] })),
      (error) => error.code === "invalid_cookies");
  }
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("./resolve-douyin.mjs", import.meta.url)), "C:\\missing-chrome.exe"],
    { input: JSON.stringify({ url, cookies: [{ name: "sessionid", value: "secret", domain: "evil.example" }] }),
      encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "invalid_cookies" });
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes("secret"));
});
