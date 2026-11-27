import assert from "node:assert/strict";
import {createDecipheriv,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {cpSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
assert.equal(process.platform,"win32");
assert.equal(process.arch,"x64");
const root=process.cwd(), temp=process.env.RUNNER_TEMP;
const prefix=process.env.GITHUB_SHA+":.github/release-input/";
const git=name=>execFileSync("git",["show",prefix+name],{maxBuffer:60*1024**2,windowsHide:true});
const metadata=JSON.parse(git("mac-260-index.json"));
assert.equal(metadata.base,"e5a19b05aafe354d73a662d8296b524a68c7c322");
const key=process.env.IC_RELEASE_SNAPSHOT_KEY?.trim()??"";
assert.match(key,/^[a-f0-9]{64}$/);
function decrypt(bytes) {
  const d=createDecipheriv("aes-256-gcm",Buffer.from(key,"hex"),bytes.subarray(0,12));
  d.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]);
}
function restore(name,bytes) {
  const archive=path.join(temp,name+".tar.gz"), target=path.join(temp,name);
  mkdirSync(target);
  writeFileSync(archive,bytes);
  execFileSync("tar",["-xzf",archive,"-C",target],{windowsHide:true});
  for(const entry of JSON.parse(readFileSync(path.join(target,"removed.json"),"utf8"))) {
    assert.ok(!path.isAbsolute(entry)&&entry.split("/").every(part=>part&&part!==".."&&part!==".git"));
    rmSync(path.join(root,entry),{force:true});
  }
  cpSync(path.join(target,"files"),root,{recursive:true});
  rmSync(target,{recursive:true,force:true});
  rmSync(archive,{force:true});
}
assert.ok(metadata.parts.every(p=>/^mac-260-source\.enc\.[0-9]+$/.test(p)));
const bytes=decrypt(Buffer.concat(metadata.parts.map(git)));
assert.equal(createHash("sha256").update(bytes).digest("hex"),metadata.sourceSha256);
restore("ic-windows-shared-source",bytes);
restore("ic-windows-release-helpers",decrypt(git("win-260-helpers.enc")));
writeFileSync(path.join(temp,"ic-seal-build-log.mjs"),git("mac-260-seal-log.mjs"));
assert.equal(JSON.parse(readFileSync("package.json","utf8")).version,"2.6.0");
console.log("Authenticated encrypted 2.6.0 sources and Windows release helpers restored.");

