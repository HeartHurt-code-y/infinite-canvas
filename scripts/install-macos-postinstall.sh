#!/bin/bash
# Native PKG postinstall: the helper is embedded in the package's Scripts archive.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
target_volume="${3:-/}"
app="${target_volume%/}/Applications/无限画布.app"
[ -d "$app" ] && [ ! -L "$app" ] || { echo '应用没有完整安装，请重新下载可信安装包并重试。' >&2; exit 1; }
exec /bin/bash "$script_dir/install-macos.sh" "$app" --no-install
