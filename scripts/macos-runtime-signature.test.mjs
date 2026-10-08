import assert from "node:assert/strict";
import test from "node:test";
import { ensureMacExecutableSignature } from "./macos-runtime-signature.mjs";

test("Mac native tools are signed before their hashes are pinned and valid signatures are preserved", () => {
  for (const initiallySigned of [false, true]) {
    let signed = initiallySigned;
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      if (command.endsWith("lipo")) return { status: 0, stdout: "arm64\n" };
      if (args.includes("--sign")) {
        signed = true;
        return { status: 0 };
      }
      return { status: signed ? 0 : 1 };
    };
    ensureMacExecutableSignature("/prepared tools/ffmpeg", { arch: "arm64", run });
    assert.equal(
      calls.filter(({ args }) => args.includes("--sign")).length,
      initiallySigned ? 0 : 1,
    );
    assert.deepEqual(calls.at(-1).args, ["--verify", "--strict", "/prepared tools/ffmpeg"]);
  }
});

test("wrong architecture, failed signing and invalid signed bytes stop Mac preparation", () => {
  assert.throws(
    () =>
      ensureMacExecutableSignature("tool", {
        arch: "arm64",
        run: () => ({ status: 0, stdout: "x86_64" }),
      }),
    /native architecture/,
  );
  assert.throws(
    () =>
      ensureMacExecutableSignature("tool", {
        arch: "arm64",
        run: (command) =>
          command.endsWith("lipo") ? { status: 0, stdout: "arm64" } : { status: 1 },
      }),
    /ad-hoc sign/,
  );
  assert.throws(
    () =>
      ensureMacExecutableSignature("tool", {
        arch: "x64",
        run: (command, args) =>
          command.endsWith("lipo")
            ? { status: 0, stdout: "x86_64" }
            : { status: args.includes("--sign") ? 0 : 1 },
      }),
    /signature is invalid/,
  );
});
