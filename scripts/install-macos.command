#!/bin/bash
# DMG 内置安装入口：从当前卷取出应用和同版安装脚本，无需再下载脚本。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
helper="$script_dir/install-macos.sh"
[ -f "$helper" ] && [ ! -L "$helper" ] || { echo '安装脚本缺失，请重新下载完整的 DMG。' >&2; exit 1; }
shopt -s nullglob
apps=("$script_dir/"*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] && [ ! -L "${apps[0]}" ] || {
  echo '安装包内必须有且只有一个完整应用，请重新下载可信 DMG。' >&2
  exit 1
}

# 空跑沿用安装脚本的跨平台参数自检；真正安装会先检查 macOS 再请求管理员权限。
for argument in "$@"; do
  if [ "$argument" = '--dry-run' ] || [ "$argument" = '--help' ] || [ "$argument" = '-h' ]; then
    exec /bin/bash "$helper" "${apps[0]}" "$@"
  fi
done
[ "$(uname -s)" = 'Darwin' ] || { echo '此安装入口只在 macOS 上运行。' >&2; exit 1; }
if [ "$(id -u)" -ne 0 ]; then
  exec sudo /bin/bash "$helper" "${apps[0]}" "$@"
fi
exec /bin/bash "$helper" "${apps[0]}" "$@"
