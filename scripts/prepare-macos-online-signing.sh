#!/usr/bin/env bash
# Optional Developer ID import; ad-hoc signing remains the default.
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo 'macOS signing requires a Mac' >&2; exit 1; }
if [ -n "${APPLE_CERTIFICATE:-}" ]; then
  signing_temp="$(mktemp -d "${TMPDIR:-/tmp}/infinite-canvas-signing.XXXXXX")"
  trap 'rm -f "$signing_temp/certificate.p12"; rmdir "$signing_temp"' EXIT
  signing_keychain="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/infinite-canvas-online.keychain-db"
  signing_password="$(openssl rand -base64 32)"
  security create-keychain -p "$signing_password" "$signing_keychain"
  security set-keychain-settings -lut 14400 "$signing_keychain"
  security unlock-keychain -p "$signing_password" "$signing_keychain"
  security list-keychains -d user -s "$signing_keychain" "$HOME/Library/Keychains/login.keychain-db"
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$signing_temp/certificate.p12"
  security import "$signing_temp/certificate.p12" -k "$signing_keychain" -P "${APPLE_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$signing_password" "$signing_keychain" >/dev/null
fi
node scripts/macos-signing-identity.mjs
