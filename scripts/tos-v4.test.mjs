import assert from "node:assert/strict";
import test from "node:test";
import { candidateSecretKeys, presignUrl, uriEncode } from "./tos-v4.mjs";
import {
  tosUpdatesLatestJsonUrl,
  tosUpdatesObjectKey,
  tosUpdatesPublicBaseUrl,
} from "./tos-updates-config.mjs";

test("uri encoding follows TOS rules", () => {
  assert.equal(uriEncode("a b/c", false), "a%20b/c");
  assert.equal(uriEncode("a/b", true), "a%2Fb");
  assert.equal(uriEncode("AZaz09-._~", false), "AZaz09-._~");
  assert.equal(uriEncode("中", false), "%E4%B8%AD");
});

test("presign matches the official documentation vector", () => {
  const signed = presignUrl({
    method: "GET",
    host: "examplebucket.tos-cn-beijing.volces.com",
    objectKey: "exampleobject",
    region: "cn-beijing",
    accessKey: "testAK",
    secretKey: "testSK",
    expiresSecs: 86_400,
    now: new Date("2022-01-01T00:00:00.000Z"),
  });
  assert.equal(
    signed.url,
    "https://examplebucket.tos-cn-beijing.volces.com/exampleobject?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=testAK%2F20220101%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Date=20220101T000000Z&X-Tos-Expires=86400&X-Tos-SignedHeaders=host&X-Tos-Signature=353aa55583eceb222aad4bdcb70d4045a202a4af9a3096f25a656b82c8ec2f56",
  );
});

test("public updater URLs stay on the Beijing TOS bucket prefix", () => {
  assert.equal(
    tosUpdatesPublicBaseUrl(),
    "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates",
  );
  assert.equal(
    tosUpdatesLatestJsonUrl(),
    "https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/latest.json",
  );
  assert.equal(tosUpdatesObjectKey("latest.json"), "infinite-canvas/updates/latest.json");
});

test("base64-wrapped secret keys are tried after the raw value", () => {
  const wrapped = Buffer.from("plain-secret-key-value", "utf8").toString("base64");
  assert.deepEqual(candidateSecretKeys(wrapped), [wrapped, "plain-secret-key-value"]);
  assert.deepEqual(candidateSecretKeys("already-plain"), ["already-plain"]);
});
