import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRednoteRequest, selectSiteCookies } from "./resolve-rednote.mjs";

const script = fileURLToPath(new URL("./resolve-rednote.mjs", import.meta.url));

function resolve(input) {
  const child = spawnSync(process.execPath, [script, process.execPath], {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 32 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout.trimEnd().split("\n").length, 1);
  return JSON.parse(child.stdout);
}

test("rejects private and lookalike share destinations without launching browser", () => {
  for (const input of [
    "http://127.0.0.1/o/5R8D9WCH5SX",
    "https://xhslink.com.evil.example/o/5R8D9WCH5SX",
    "https://xhslink.com:444/o/5R8D9WCH5SX",
    "https://www.rednote.com@evil.example/explore/6aab4a3f000000000d02574a",
    "https://www.xiaohongshu.com/explore/not-a-note-id",
  ]) {
    assert.deepEqual(resolve(input), { ok: false, reason: "invalid_share_link" });
  }
});

test("rejects oversized stdin and returns only a single structured line", () => {
  assert.deepEqual(resolve("x".repeat(2049)), { ok: false, reason: "invalid_input" });
});

test("RedNote resolver accepts old URL and scoped JSON envelope", () => {
  const url = "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a";
  assert.deepEqual(parseRednoteRequest(url), { url, cookies: [] });
  const request = parseRednoteRequest(JSON.stringify({
    url,
    cookies: [
      { name: "web_session", value: "secret_xhs", domain: ".xiaohongshu.com" },
      { name: "web_session", value: "secret_rednote", domain: ".rednote.com" },
      { name: "passport", value: "secret_auth", domain: "passport.xiaohongshu.com" },
    ],
  }));
  assert.equal(selectSiteCookies(request.cookies, "xiaohongshu.com").length, 2);
  assert.equal(selectSiteCookies(request.cookies, "xiaohongshu.com")[0].value, "secret_xhs");
  assert.equal(selectSiteCookies(request.cookies, "rednote.com").length, 1);
  assert.equal(selectSiteCookies(request.cookies, "rednote.com")[0].value, "secret_rednote");
});

test("RedNote resolver rejects foreign and malformed cookies without echoing values", () => {
  const url = "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a";
  for (const cookie of [
    { name: "web_session", value: "secret", domain: "evil.example" },
    { name: "web_session", value: "secret", domain: ".rednote.com.evil.example" },
    { name: "bad name", value: "secret", domain: ".rednote.com" },
    { name: "web_session", value: "secret\nheader", domain: ".rednote.com" },
    { name: "web_session", value: "secret", domain: ".rednote.com", url: "https://evil.example" },
  ]) {
    assert.throws(() => parseRednoteRequest(JSON.stringify({ url, cookies: [cookie] })),
      (error) => error.reason === "invalid_cookies");
  }
  const response = resolve(JSON.stringify({
    url,
    cookies: [{ name: "web_session", value: "secret", domain: "evil.example" }],
  }));
  assert.deepEqual(response, { ok: false, reason: "invalid_cookies" });
});
