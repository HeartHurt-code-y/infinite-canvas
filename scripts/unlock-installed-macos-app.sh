#!/usr/bin/env bash
# 首次安装未公证的 macOS 应用后运行：仅清除隔离属性，不改动应用文件或代码签名。
# 先将 DMG 中的「无限画布.app」拖到「应用程序」，再在终端执行：
# sudo bash "/Applications/无限画布.app/Contents/Resources/unlock-installed-macos-app.sh"
set -euo pipefail

app_path="/Applications/无限画布.app"

if [ "${1:-}" = "--help" ] && [ "$#" -eq 1 ]; then
  printf '先将 DMG 中的「无限画布.app」拖到「应用程序」，然后执行：\n'
  printf 'sudo bash "/Applications/无限画布.app/Contents/Resources/unlock-installed-macos-app.sh"\n'
  exit 0
fi

[ "$#" -eq 0 ] || { echo "此脚本不接受应用路径或其他参数。" >&2; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { echo "此脚本只在 macOS 上运行。" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "需要管理员权限，请使用上方的 sudo 命令。" >&2; exit 1; }
[ -d "$app_path" ] || { echo "请先将无限画布.app 从 DMG 拖到 /Applications。" >&2; exit 1; }

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")"
[ "$bundle_id" = "com.infinitecanvas.desktop" ] || {
  echo "应用标识不符，拒绝修改：$bundle_id" >&2
  exit 1
}

# 如果下载或复制破坏了应用签名，不应以清除 Gatekeeper 标记掩盖损坏。
/usr/bin/codesign --verify --deep --strict "$app_path"

# quarantine 是文件扩展属性；删除它不会重签或更改应用包中的文件。
# 已清除过的属性会使 xattr -d 报错，因此在最终检查前允许“属性不存在”。
/usr/bin/xattr -dr com.apple.quarantine "$app_path" 2>/dev/null || true

attributes="$(mktemp "${TMPDIR:-/tmp}/infinite-canvas-xattr.XXXXXX")"
trap 'rm -f "$attributes"' EXIT
/usr/bin/xattr -lr "$app_path" > "$attributes"
if /usr/bin/grep -Fq 'com.apple.quarantine:' "$attributes"; then
  echo "仍有隔离属性，未完成解锁。请确认终端具有访问应用程序的权限。" >&2
  exit 1
fi

/usr/bin/codesign --verify --deep --strict "$app_path"
echo "已解锁 $app_path；应用包内容与签名保持不变，现在可从“应用程序”打开。"
