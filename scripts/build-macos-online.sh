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
repo_root="$(pwd -P)"
test -f "$repo_root/package.json"
test -f "$repo_root/src-tauri/tauri.online.conf.json"
release_version="$(node -p "require('./package.json').version")"
# Remove only generated outputs inside this verified workspace; retain Cargo's cache.
online_root="$repo_root/.cache/tauri-editions/online"
mkdir -p "$online_root"
test "$(cd "$online_root" && pwd -P)" = "$online_root"
rm -rf "$online_root/target/release/bundle" "$online_root/artifacts/$release_version"
pnpm tauri:build:online --bundles app,dmg
IC_DISTRIBUTION_EDITION=online CARGO_TARGET_DIR="$online_root/target" cargo test --manifest-path src-tauri/Cargo.toml --locked --lib component_
node scripts/verify-edition-release.mjs --distribution-dir "$online_root/artifacts/$release_version"
echo "Verified macOS $release_version $native_arch online DMG and updater archive."
echo 'This package is not Apple notarized. First installation may be blocked by Gatekeeper; use the included install-macos.sh.'
