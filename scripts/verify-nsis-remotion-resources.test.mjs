import assert from "node:assert/strict";
import test from "node:test";
import { verifyNsisRemotionResourceTable } from "./verify-nsis-remotion-resources.mjs";

test("full NSIS file table must materialize every Remotion logical path", () => {
  const inventory = [
    { path: "node_modules/.pnpm/pkg/index.js" },
    { path: "node_modules/pkg/index.js" },
  ];
  const complete = [
    'File /a "/oname=remotion-runtime\\node_modules\\.pnpm\\pkg\\index.js" "source"',
    'File /a "/oname=remotion-runtime\\node_modules\\pkg\\index.js" "source"',
    'File /a "/oname=remotion-runtime\\files-manifest.json" "source"',
    'File /a "/oname=remotion-runtime\\runtime-manifest.json" "source"',
  ].join("\n");
  assert.equal(verifyNsisRemotionResourceTable(complete, inventory), 4);
  assert.throws(
    () =>
      verifyNsisRemotionResourceTable(
        complete.replace(
          'File /a "/oname=remotion-runtime\\node_modules\\pkg\\index.js" "source"\n',
          "",
        ),
        inventory,
      ),
    /缺 1/,
  );
});
