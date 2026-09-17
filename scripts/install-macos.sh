#!/usr/bin/env bash
#
# 无 Apple 证书的一键安装/修复脚本：让未签名的包在任何 Mac 上都能打开。
#
# 为什么需要它：没有 Developer ID 证书时，下载来的包会被两件事挡住，而且它们互相独立——
#   1. Gatekeeper：包带 com.apple.quarantine 属性 → 提示「无法验证开发者」或「已损坏」。
#   2. Apple Silicon 内核：arm64 可执行文件必须有有效签名才会被执行，
#      否则被直接杀掉（"Killed: 9"）。注意 Tauri 在没有签名身份时**什么都不签**
#      （不是退回 ad-hoc，而是整段跳过），随包分发的 FFmpeg / Blender 也可能未签名。
# 因此「清 quarantine」不足以让 app 正常跑起来，必须同时做 **ad-hoc 重新签名**。
#
# 用法（把 <文件> 换成 DMG 或 .app 的路径）：
#   sudo bash install-macos.sh ~/Downloads/无限画布_0.1.0_aarch64.dmg
#   sudo bash install-macos.sh ~/Downloads/无限画布.app
#
# 可选参数：
#   --target <dir>   安装到指定目录（默认 /Applications）
#   --no-install     就地修复，不复制到 /Applications（用于从 DMG 直接运行的场景）
#   --dry-run        只解析参数并打印将要做的事，不做任何改动（可在任意平台跑）
#
# 做了什么：清掉 DMG 与 .app 的隔离属性 → 由内到外 ad-hoc 重签 app 内所有可执行文件
#          → 装到 /Applications → 校验签名与 Gatekeeper 评估。
#
# 退出码：0 成功；1 失败；2 用法错误。
set -euo pipefail

log() { printf '[install-macos] %s\n' "$*"; }
warn() { printf '[install-macos] 警告：%s\n' "$*" >&2; }
fail() {
  printf '[install-macos] 失败：%s\n' "$*" >&2
  exit 1
}

# 自检用的空跑开关：完整走一遍参数解析与路径判断，但在任何真实改动前退出。
# 这样参数解析、来源类型识别、目标路径推导都能被用例覆盖（含非 macOS CI）。
dry_run=0

target_dir="/Applications"
install=1
source_path=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || fail "--target 需要一个目录参数"
      target_dir="$2"
      shift 2
      ;;
    --no-install)
      install=0
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      sed -n '2,26p' "$0"
      exit 0
      ;;
    -*)
      fail "未知参数：$1（可用：--target <dir> / --no-install / --dry-run / --help）"
      ;;
    *)
      [ -z "$source_path" ] || fail "只能指定一个 DMG 或 .app 路径"
      source_path="$1"
      shift
      ;;
  esac
done

[ -n "$source_path" ] || fail "用法：sudo bash $0 <path/to/xxx.dmg|xxx.app> [--target /Applications] [--no-install] [--dry-run]"
[ -e "$source_path" ] || fail "找不到：$source_path"

# 空跑：参数已全部解析、来源已确认存在，这里停下就不会产生任何真实改动。
# 放在平台/权限检查之前，使非 macOS 环境也能做参数自检。
if [ "$dry_run" -eq 1 ]; then
  case "$source_path" in
    *.dmg | *.DMG) source_kind="dmg" ;;
    *.app | *.APP) source_kind="app" ;;
    *) fail "无法识别的文件类型（需要 .dmg 或 .app）：$source_path" ;;
  esac
  printf 'source=%s\nkind=%s\ntarget=%s\ninstall=%s\n' \
    "$source_path" "$source_kind" "$target_dir" "$install"
  exit 0
fi

[ "$(uname -s)" = "Darwin" ] || fail "本脚本只在 macOS 上运行。"

# root 是必需的：Gatekeeper 的评估结果与已安装 app 的 xattr 都需要管理员权限才能改干净。
if [ "$(id -u)" -ne 0 ]; then
  fail "需要管理员权限。请用：sudo bash $0 \"$source_path\""
fi

mount_point=""
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/infinite-canvas-install.XXXXXX")"

# 单一清理出口：临时目录 + DMG 卸载。任何路径退出都不会留下挂载卷或临时文件。
cleanup() {
  rm -rf "$work_dir"
  if [ -n "$mount_point" ] && [ -d "$mount_point" ]; then
    hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- 1. 取出 .app（DMG 先挂载，并且**先清掉 DMG 自身的隔离属性**）-------------
#
# 顺序很关键：如果 DMG 带着 quarantine，挂载后里面的 app 会继承它，
# 所以要在挂载前就把 DMG 清干净，这样拷出来的 app 从一开始就是干净的。
case "$source_path" in
  *.dmg | *.DMG)
    [ -f "$source_path" ] || fail "不是文件：$source_path"
    log "清除 DMG 的隔离属性…"
    xattr -dr com.apple.quarantine "$source_path" 2>/dev/null || true

    log "挂载 DMG…"
    # -nobrowse 避免在 Finder 里弹出；-readonly 明确只读。
    mount_point="$(hdiutil attach "$source_path" -nobrowse -readonly |
      grep -o '/Volumes/.*' | head -n1)"
    [ -n "$mount_point" ] || fail "挂载失败：$source_path"

    app_in_dmg="$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit)"
    [ -n "$app_in_dmg" ] || fail "DMG 里没有找到 .app：$mount_point"
    log "DMG 中的 app：$app_in_dmg"
    source_app="$app_in_dmg"
    ;;
  *.app | *.APP)
    [ -d "$source_path" ] || fail "不是 app bundle：$source_path"
    source_app="$source_path"
    ;;
  *)
    fail "无法识别的文件类型（需要 .dmg 或 .app）：$source_path"
    ;;
esac

# ---- 2. 决定最终位置 ---------------------------------------------------------
app_name="$(basename "$source_app")"
if [ "$install" -eq 1 ]; then
  dest_app="$target_dir/$app_name"
  log "安装到：$dest_app"
  mkdir -p "$target_dir"
  # 覆盖安装前先移除旧包，避免新旧文件混合导致签名校验失败。
  rm -rf "$dest_app"
  # -R 保留结构；从只读的 DMG 复制到可写的 /Applications 后才能重签。
  cp -R "$source_app" "$dest_app"
else
  dest_app="$source_app"
  log "就地修复（不复制）：$dest_app"
fi

# ---- 3. 清除隔离属性 ---------------------------------------------------------
log "清除 app 的隔离属性…"
xattr -dr com.apple.quarantine "$dest_app" 2>/dev/null || true
# 其它扩展属性会让 codesign 报 "resource fork, Finder information, or similar detritus not allowed"。
xattr -cr "$dest_app" 2>/dev/null || true

# ---- 4. ad-hoc 重新签名（由内到外）-------------------------------------------
#
# Apple Silicon 上这一步是**必须**的：arm64 可执行文件没有有效签名会被内核直接杀掉。
# 顺序必须由深到浅，否则先签外层会让内层二进制失去签名。
# 用 `-s -` 即 ad-hoc 身份，不需要任何证书。
log "ad-hoc 重新签名（由内到外）…"

# 收集需要签名的 Mach-O 文件（magic: 0xFEEDFACF / 0xCAFEBABE 等）。
while IFS= read -r candidate; do
  [ -f "$candidate" ] || continue
  magic="$(head -c 4 "$candidate" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')"
  case "$magic" in
    cffaedfe | cefaedfe | cafebabe | bebafeca | feedface) printf '%s\n' "$candidate" ;;
  esac
done < <(find "$dest_app" -type f -perm -u+x 2>/dev/null || true) >"$work_dir/macho.txt"

# 由深到浅：先签最内层，再签外层，否则先签外层会让内层签名失效。
# awk 给每行加上长度前缀，sort -rn 即按路径长度倒序（越深的路径越长）。
awk '{ print length($0), $0 }' "$work_dir/macho.txt" | sort -rn | cut -d' ' -f2- >"$work_dir/ordered.txt"

signed_count=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  if codesign --force --sign - --timestamp=none "$candidate" >/dev/null 2>&1; then
    signed_count=$((signed_count + 1))
  else
    warn "无法签名（跳过）：$candidate"
  fi
done <"$work_dir/ordered.txt"

log "已签名 $signed_count 个可执行文件。"

# 最后签 bundle 本身（--deep 会重复签内层，这里不用；内层已逐个处理）。
if codesign --force --sign - --timestamp=none "$dest_app" >/dev/null 2>&1; then
  log "已签名 app bundle。"
else
  warn "签名 app bundle 失败，继续尝试校验。"
fi

# ---- 5. 校验 -----------------------------------------------------------------
log "校验签名…"
if codesign --verify --deep --strict "$dest_app" >/dev/null 2>&1; then
  log "签名校验通过。"
else
  warn "codesign --verify 未通过；app 可能仍能启动，但若打不开请把完整输出发给开发者。"
fi

# 这一项才是「能不能双击打开」的判据。ad-hoc 签名的包在 Gatekeeper 下仍然会被拒，
# 但 quarantine 已清除，所以不会再弹「已损坏」的对话框，可以直接运行。
spctl_status=0
spctl_output="$(spctl -a -t exec -vv "$dest_app" 2>&1)" || spctl_status=$?
if [ "$spctl_status" -eq 0 ]; then
  log "Gatekeeper 评估通过。"
else
  # 这是 ad-hoc 签名的预期结果，不是错误：quarantine 已清，双击即可运行。
  log "Gatekeeper 评估未通过（ad-hoc 签名的正常结果）：$(printf '%s' "$spctl_output" | head -n1)"
  log "隔离属性已清除，Finder 里双击不会再被拦。"
fi

log "完成：$dest_app"
if [ "$install" -eq 1 ]; then
  log "在「启动台」或「应用程序」里打开即可。"
fi
