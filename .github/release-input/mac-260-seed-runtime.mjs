import assert from "node:assert/strict";
import https from "node:https";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { requestOnlineObject } from "./online-update-transport.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { componentFileSha256 } from "./runtime-resources.mjs";
import { tosUpdatesPublicBaseUrl } from "./tos-updates-config.mjs";

assert.equal(process.platform,"darwin");
assert.equal(process.arch,"arm64");
const platform="darwin-aarch64";
const channel=tosUpdatesPublicBaseUrl()+"/"+platform+"-online";
const baseline="2.0.1";
const baselineFeedSha256="35f8cd607dcd6d343f4522994e811e810acfdb87073af741fa4b4061a99262be";
const config=JSON.parse(await readFile("src-tauri/tauri.conf.json","utf8"));
const identity={"accept-encoding":"identity","cache-control":"no-cache"};
const feedResult=await requestOnlineObject({url:channel+"/latest.json",headers:identity,timeoutMs:45000});
assert.equal(feedResult.status,200);
assert.equal(createHash("sha256").update(feedResult.body).digest("hex"),baselineFeedSha256);
const feed=JSON.parse(feedResult.body);
assert.equal(feed.version,baseline);
const release=feed.platforms[platform];
assert.equal(release.url, channel+"/"+encodeURIComponent(config.productName+"_"+baseline+"_aarch64-online.app.tar.gz"));
const state=process.env.RUNNER_TEMP;
const archive=path.join(state,"ic-baseline-2.0.1.tar.gz");
const agent=new https.Agent({keepAlive:true,maxSockets:10});
const read=(args)=>requestOnlineObject(args,(options,listener)=>https.request({...options,agent},listener));
try {
  const head=await read({url:release.url,method:"HEAD",headers:identity,timeoutMs:45000,maxBytes:0});
  assert.equal(head.status,200);
  const size=Number(head.headers["content-length"]);
  assert.ok(Number.isSafeInteger(size)&&size>0&&size<2*1024**3&&head.etag);
  const part=8*1024**2;
  const count=Math.ceil(size/part);
  const file=await open(archive,"wx",0o600);
  try {
    await file.truncate(size);
    let at=0, completed=0;
    const failures=[];
    await Promise.all(Array.from({length:10},async()=>{
      while (!failures.length) {
        const index=at++;
        if (index>=count) return;
        const start=index*part, end=Math.min(size-1,start+part-1);
        try {
          for (let attempt=0;;attempt++) {
            try {
              const response=await read({
                url:release.url,headers:{...identity,range:"bytes="+start+"-"+end,"if-match":head.etag},
                maxBytes:end-start+1,timeoutMs:90000,
              });
              if([408,429,500,502,503,504].includes(response.status)&&attempt<3) continue;
              assert.equal(response.status,206);
              assert.equal(response.etag,head.etag);
              assert.equal(response.headers["content-range"],"bytes "+start+"-"+end+"/"+size);
              assert.equal(response.size,end-start+1);
              let offset=0;
              while(offset<response.body.length) {
                const written=await file.write(response.body,offset,response.body.length-offset,start+offset);
                if (!written.bytesWritten) throw new Error("Could not write baseline range");
                offset+=written.bytesWritten;
              }
              completed++;
              if(completed%10===0||completed===count) console.log("Signed baseline ranges "+completed+"/"+count);
              break;
            } catch(error) {
              if(attempt>=3||!["ETIMEDOUT","ECONNRESET","EPIPE","EAI_AGAIN","ENOTFOUND"].includes(error.code)) throw error;
            }
          }
        } catch(error) { failures.push(error); }
      }
    }));
    if(failures.length) throw failures[0];
    assert.equal(completed,count);
  } finally { await file.close(); }
} finally { agent.destroy(); }
await writeFile(archive+".sig",release.signature);
await verifyUpdaterSignature(archive,archive+".sig",config.plugins.updater.pubkey);

const temp=path.join(state,"ic-baseline-runtime-2.0.1");
await mkdir(temp);
const prefix=config.productName+".app/Contents/Resources/ffmpeg/";
const resourceNames=["ffmpeg","ffprobe","manifest.json"];
execFileSync("/usr/bin/tar",["-xpf",archive,"-C",temp,...resourceNames.map(name=>prefix+name)],{stdio:"inherit"});
const expected={
  ffmpeg:"77d2c853f431318d55ec02676d9b2f185ebfdddb9f7677a251fbe453affe025a",
  ffprobe:"babf170e86bd6b0b2fefee5fa56f57721b0acb98ad2794b095d8030b02857dfe",
  "manifest.json":"19cf0b7a50ef87470c7b85792bddab0665fef8c255b79b1c7ecfb9065ff0801d",
};
const dest="src-tauri/resources/ffmpeg";
await mkdir(dest,{recursive:true});
for(const name of resourceNames) {
  const from=path.join(temp,prefix,name);
  assert.ok((await stat(from)).isFile());
  assert.equal(await componentFileSha256(from),expected[name]);
  const output=path.join(dest,name);
  await copyFile(from,output);
  if (name!=="manifest.json") {
    await chmod(output,0o755);
    execFileSync("/usr/bin/codesign",["--verify","--strict",path.resolve(output)],{stdio:"inherit"});
    const info=execFileSync(path.resolve(output),["-version"],{encoding:"utf8"}).split(/\r?\n/)[0];
    assert.ok(info.startsWith(name+" version "));
    console.log(info);
  }
}
console.log("Verified original Apple Silicon FFmpeg runtime from the signed 2.0.1 archive.");

