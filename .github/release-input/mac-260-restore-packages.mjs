import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp,mkdir,readFile,readdir,rename,stat,writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { verifyEditionRelease } from "./verify-edition-release.mjs";
import { assertEditionBuildSourceFreshness } from "./edition-source-fingerprint.mjs";
import { editionBuildPlan, writeEditionTargetMarker } from "./tauri-build-edition.mjs";

assert.equal(process.platform,"darwin");
assert.equal(process.arch,"arm64");
const root=process.cwd();
const cfg=JSON.parse(await readFile("src-tauri/tauri.conf.json","utf8"));
assert.equal(cfg.version,"2.6.0");
const version=cfg.version;
const download=path.join(process.env.RUNNER_TEMP,"ic-verified-mac-260");
const directory=path.join(root,".cache/tauri-editions/online/artifacts",version);
let artifactRoot=download;
if(!(await stat(path.join(artifactRoot,"distribution.json")).catch(()=>null))?.isFile()) {
  const entries=(await readdir(artifactRoot,{withFileTypes:true})).filter(item=>item.isDirectory());
  assert.equal(entries.length,1);
  artifactRoot=path.join(artifactRoot,entries[0].name);
}
assert.ok((await stat(path.join(artifactRoot,"distribution.json"))).isFile());
await mkdir(path.dirname(directory),{recursive:true});
try { await rename(artifactRoot,directory); }
catch(error) {
  if(error.code!=="EXDEV") throw error;
  await cp(artifactRoot,directory,{recursive:true,preserveTimestamps:true});
}
const record=JSON.parse(await readFile(path.join(directory,"build-source.json"),"utf8"));
const appName=cfg.productName+".app";
const parent=path.join(root,".cache/tauri-editions/online/target/release/bundle/macos");
const executable=path.join(parent,appName,"Contents/MacOS/infinite-canvas");
assert.equal(record.nativeExecutable.path,path.relative(root,executable));
const archive=path.join(directory,"macos",cfg.productName+"_"+version+"_aarch64-online.app.tar.gz");
await verifyUpdaterSignature(archive,archive+".sig",cfg.plugins.updater.pubkey);
await mkdir(parent,{recursive:true});
execFileSync("/usr/bin/tar",["-xpf",archive,"-C",parent],{stdio:"inherit"});
await assertEditionBuildSourceFreshness(record,{
  root,edition:"online",applicationVersion:version,executablePath:executable,
});
await writeEditionTargetMarker(editionBuildPlan("online"),version);
const manifestPath=path.join(directory,"publish-manifest.json");
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
for(const item of manifest.artifacts)item.localPath=path.join(directory,item.path);
manifest.feed.localPath=path.join(directory,"latest.json");
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
const verified=await verifyEditionRelease({distributionDirectory:directory,requireSourceFreshness:true});
assert.equal(verified.verified,true);
assert.equal(verified.platform,"darwin-aarch64");
console.log("Recovered the exact signed Apple Silicon 2.6.0 packages and verified source, signature, and native bundle.");

