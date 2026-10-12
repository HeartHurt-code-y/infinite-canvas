#!/usr/bin/env bash
# Build and verify native macOS online artifacts without publishing a feed.
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo 'macOS online packages must be built on a Mac' >&2; exit 1; }
native_arch="$(node -p 'process.arch')"
case "$native_arch" in arm64|x64) ;; *) echo "Unsupported native Mac architecture: $native_arch" >&2; exit 1 ;; esac
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ ! -f src-tauri/.updater-key ]; then
  echo 'Missing Tauri updater signing key; a signed online release cannot be delivered' >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
# Tauri tests certificate variable presence, so empty CI secret placeholders must
# be absent to select the project's ad-hoc signing path.
if [ -z "${APPLE_CERTIFICATE:-}" ]; then
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
fi
repo_root="$(pwd -P)"
test -f "$repo_root/package.json"
test -f "$repo_root/src-tauri/tauri.online.conf.json"
node scripts/verify-updater-signing-key.mjs
release_version="$(node -p "require('./package.json').version")"
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
# Remove only generated outputs inside this verified workspace; retain Cargo's cache.
online_root="$repo_root/.cache/tauri-editions/online"
mkdir -p "$online_root"
test "$(cd "$online_root" && pwd -P)" = "$online_root"
rm -rf "$online_root/target/release/bundle" "$online_root/artifacts/$release_version"
pnpm tauri:build:online --bundles app,dmg
IC_DISTRIBUTION_EDITION=online CARGO_TARGET_DIR="$online_root/target" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --lib component_
IC_DISTRIBUTION_EDITION=online CARGO_TARGET_DIR="$online_root/target" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --lib runtime_components::tests
IC_DISTRIBUTION_EDITION=online CARGO_TARGET_DIR="$online_root/target" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --lib product_scene_images
node scripts/verify-edition-release.mjs --distribution-dir "$online_root/artifacts/$release_version"
# Exercise the public one-command PKG installation on this disposable runner.
# The embedded postinstall must clear quarantine without changing any signed bytes.
export IC_MAC_DISTRIBUTION_DIR="$online_root/artifacts/$release_version"
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { inventoryMacApp, assertMacAppInventories } from './scripts/verify-macos-edition.mjs';
const directory = process.env.IC_MAC_DISTRIBUTION_DIR;
const receipt = JSON.parse(readFileSync(path.join(directory, 'build-source.json'), 'utf8'));
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const executable = path.resolve(receipt.nativeExecutable.path);
const sourceApp = path.dirname(path.dirname(path.dirname(executable)));
const expected = await inventoryMacApp(sourceApp);
const packages = readdirSync(path.join(directory, 'pkg')).filter(name => name.endsWith('.pkg'));
if (packages.length !== 1) throw new Error('Installation check needs exactly one verified PKG');
const packageFile = path.join(directory, 'pkg', packages[0]);
// Simulate a browser download. Installation itself must need only the documented command.
execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;5f000000;Safari;00000000-0000-0000-0000-000000000000', packageFile], {stdio: 'inherit'});
execFileSync('sudo', ['/usr/sbin/installer', '-pkg', packageFile, '-target', '/'], {stdio: 'inherit'});
const installed = path.join('/Applications', `${config.productName}.app`);
assertMacAppInventories(await inventoryMacApp(installed), expected, 'First installation');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], {stdio: 'inherit'});
const attributes = execFileSync('/usr/bin/xattr', ['-r', installed], {encoding: 'utf8'});
if (attributes.includes('com.apple.quarantine')) throw new Error('PKG postinstall left the application quarantined');
execFileSync(path.join(installed, 'Contents/MacOS/infinite-canvas'), ['--print-component-catalog-pins'], {stdio: 'inherit'});
console.log('Native one-command PKG installation runs its embedded helper, clears quarantine and preserves signed application and component bytes.');
NODE
echo "Verified macOS $release_version $native_arch online PKG, DMG and updater archive."
echo 'This package is not Apple notarized. First installation may be blocked by Gatekeeper; the DMG includes install-macos.command and install-macos.sh.'
