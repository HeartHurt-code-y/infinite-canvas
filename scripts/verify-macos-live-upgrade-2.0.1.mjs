import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateMacDeltaManifest } from './mac-delta-manifest.mjs';
import { verifyUpdaterSignature, verifyUpdaterSignatureBytes } from './verify-updater-signature.mjs';

assert(process.platform === 'darwin' && process.arch === 'arm64');
const channel = 'https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/darwin-aarch64-online';
const backupHash = '92cfea895d5950419bcfdcc84c7a2cc0bf58ad596c6c32f0d471489c296898fa';
const pubkey = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).plugins.updater.pubkey;
const appName = '无限画布.app';
const root = path.join(process.env.RUNNER_TEMP, 'ic-live-upgrade-2.0.1');
const output = path.join(process.env.RUNNER_TEMP, 'ic-live-upgrade-evidence');
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options });
const curl = (url, file) => run('/usr/bin/curl', ['-fSs', '--retry', '2', '--max-time', '720', '--output', file, url]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(root);
await mkdir(output);
const feedFile = path.join(root, 'previous.json');
curl(`${channel}/latest.json`, feedFile);
if (hash(await readFile(feedFile)) !== backupHash) curl(`${channel}/backups/${backupHash}.json`, feedFile);
const previousBytes = await readFile(feedFile);
assert.equal(hash(previousBytes), backupHash);
const previous = JSON.parse(previousBytes);
assert.equal(previous.version, '2.0.0');
const asset = previous.platforms['darwin-aarch64'];
assert.equal(asset.url, `${channel}/${encodeURIComponent('无限画布_2.0.0_aarch64-online.app.tar.gz')}`);
const base = path.join(root, 'base.tar.gz');
curl(asset.url, base);
await writeFile(`${base}.sig`, asset.signature);
await verifyUpdaterSignature(base, `${base}.sig`, pubkey);
run('/usr/bin/tar', ['-xpf', base, '-C', root]);
const app = path.join(root, appName);
const version = () => run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')]).trim();
assert.equal(version(), '2.0.0');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log('Signed native 2.0.0 baseline verified');

const live = path.join(root, 'live.json');
let feed;
for (let deadline = Date.now() + 26 * 60_000; Date.now() < deadline;) {
  curl(`${channel}/latest.json`, live);
  feed = JSON.parse(await readFile(live, 'utf8'));
  if (feed.version !== '2.0.0') break;
  await delay(15000);
}
assert.equal(feed.version, '2.0.1');
const descriptor = feed.macDeltaManifest;
assert.equal(descriptor.url, 'https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/mac-delta/2.0.1/darwin-aarch64/manifest.json');
const manifestFile = path.join(root, 'manifest.json');
curl(descriptor.url, manifestFile);
const manifestBytes = await readFile(manifestFile);
verifyUpdaterSignatureBytes(manifestBytes, descriptor.signature, pubkey);
const manifest = JSON.parse(manifestBytes);
validateMacDeltaManifest(manifest);
assert.equal(manifest.baseVersion, '2.0.0');
const expectedObjects = new Set(manifest.files.filter(entry => entry.source === 'object').map(entry => entry.sha256));
const executable = path.join(app, 'Contents/MacOS/infinite-canvas');
const started = Date.now();
const child = spawn(executable, [], { cwd: root, stdio: 'ignore' });
const localData = path.join(process.env.HOME, 'Library/Application Support/com.infinitecanvas.desktop');
const seen = new Set();
let reached = false;
try {
  for (let deadline = Date.now() + 12 * 60_000; Date.now() < deadline;) {
    for (const candidate of await readdir(localData).catch(() => [])) {
      if (!candidate.startsWith('mac-delta-')) continue;
      const dir = path.join(localData, candidate, 'objects');
      for (const object of await readdir(dir).catch(() => [])) {
        if (expectedObjects.has(object)) seen.add(object);
      }
    }
    try { reached = version() === '2.0.1'; } catch {}
    if (reached) break;
    await delay(750);
  }
  assert(reached, 'The installed 2.0.0 client did not replace itself with public 2.0.1');
  assert(seen.size > 0, 'The client did not use the published delta objects');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const logs = path.join(process.env.HOME, 'Library/Logs/com.infinitecanvas.desktop');
  for (const name of await readdir(logs).catch(() => [])) {
    if (!name.endsWith('.log')) continue;
    const filename = path.join(logs, name);
    if ((await stat(filename)).mtimeMs < started) continue;
    const text = await readFile(filename, 'utf8');
    assert(!text.includes('macOS 差分不可用') && !text.includes('macOS 差分安装前校验失败'), 'Client fell back to the full archive');
  }
  const receipt = { platform: 'darwin-aarch64', baseline: '2.0.0', target: '2.0.1', publicDeltaVerified: true, observedObjects: seen.size, expectedObjects: expectedObjects.size, codeSignatureVerified: true, installedVersion: version() };
  await writeFile(path.join(output, 'native-delta-upgrade.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  if (child.exitCode === null) child.kill();
}
