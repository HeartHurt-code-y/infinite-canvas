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
node scripts/verify-edition-release.mjs --distribution-dir "$online_root/artifacts/$release_version"
# Exercise the exact first-install helper on a temporary target. A component
# catalog pins native bytes, so clearing Gatekeeper attributes must preserve them.
install_check_root="$(mktemp -d "$online_root/install-check.XXXXXX")"
case "$install_check_root" in "$online_root"/install-check.*) ;; *) echo 'Unexpected installation check path' >&2; exit 1 ;; esac
trap 'sudo /bin/rm -rf -- "$install_check_root"' EXIT
export IC_MAC_INSTALL_CHECK_ROOT="$install_check_root"
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
const dmgs = readdirSync(path.join(directory, 'dmg')).filter(name => name.endsWith('.dmg'));
if (dmgs.length !== 1) throw new Error('Installation check needs exactly one verified DMG');
const target = path.join(process.env.IC_MAC_INSTALL_CHECK_ROOT, 'Applications');
execFileSync('sudo', ['bash', 'scripts/install-macos.sh', path.join(directory, 'dmg', dmgs[0]), '--target', target], {stdio: 'inherit'});
const installed = path.join(target, `${config.productName}.app`);
assertMacAppInventories(await inventoryMacApp(installed), expected, 'First installation');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], {stdio: 'inherit'});
execFileSync(path.join(installed, 'Contents/MacOS/infinite-canvas'), ['--print-component-catalog-pins'], {stdio: 'inherit'});
console.log('First installation preserves signed application and component bytes.');
NODE
sudo /bin/rm -rf -- "$install_check_root"
trap - EXIT
echo "Verified macOS $release_version $native_arch online DMG and updater archive."
echo 'This package is not Apple notarized. First installation may be blocked by Gatekeeper; use the included install-macos.sh.'
