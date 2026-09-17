#!/usr/bin/env bash
#
# 校验 macOS 构建产物：签名身份是否稳定，以及随包分发的原生可执行文件是否自带签名。
#
# 为什么还关心签名（凭据已经不放在钥匙串里了）：
#   1. 未签名的 bundle 在别的 Mac 上会被 Gatekeeper 拦下，用户得手动点「仍要打开」
#      或清隔离位；macOS 15 起右键「打开」也不再是有效绕过方式。
#   2. Tauri 只签 Contents/MacOS，**不签 Contents/Resources**；而 Apple Silicon 上
#      没有有效签名的 arm64 Mach-O 会被内核直接杀掉，表现为内置 FFmpeg / Blender
#      「引擎不可用」。上游发行包通常已自行签名并公证，所以这里只报不拦。
#
# 注意：**本脚本不再检查钥匙串**。应用凭据已改为默认存放于应用数据目录下的明文
# JSON（见 src-tauri/src/backend/credentials.rs），macOS 上完全不碰钥匙串，
# 「想要访问你的钥匙串中的密钥」这个弹窗因此不会再出现，与签名身份无关。
#
# 用法：
#   scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/无限画布.app"
#
# 退出码：0 通过；1 断言失败；2 用法/平台错误。
set -euo pipefail

log() { printf '[verify-macos-bundle] %s\n' "$*"; }
fail() {
  printf '[verify-macos-bundle] 失败：%s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  log "非 macOS（$(uname -s)），跳过。"
  exit 0
fi

app_path="${1:-}"
[ -n "$app_path" ] || fail "用法：$0 <path/to/App.app>"
[ -d "$app_path" ] || fail "找不到 app bundle：$app_path"

# ---- 1. 必须有签名，且不是 ad-hoc ---------------------------------------------
#
# 没有签名身份时 Tauri **什么都不签**（不是退回 ad-hoc，而是整段跳过且不打日志）。
# ad-hoc（authority 为 "-"）与未签名的包在别的 Mac 上都会被 Gatekeeper 拦下。
signature_info="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
if ! grep -q '^Authority=' <<<"$signature_info"; then
  fail "该 bundle 没有代码签名（很可能是未签名或仅 ad-hoc）：
$signature_info"
fi
if grep -q '^Authority=-$' <<<"$signature_info"; then
  fail "该 bundle 是 ad-hoc 签名：其他用户的 Gatekeeper 会拦下它。
请配置 Developer ID 证书后重新打包（.github/workflows/macos-package.yml）。"
fi

authority="$(grep -m1 '^Authority=' <<<"$signature_info" | cut -d= -f2-)"
team_id="$(grep -m1 '^TeamIdentifier=' <<<"$signature_info" | cut -d= -f2- || true)"
log "签名 Authority：$authority"
log "TeamIdentifier：${team_id:-<无>}"

case "$authority" in
  "Developer ID Application:"*)
    log "身份等级：Developer ID（可对外分发）。"
    ;;
  *)
    log "警告：非 Developer ID 的签名证书，其他用户首次打开需绕过 Gatekeeper"
    log "      （系统设置 → 隐私与安全性 → 仍要打开，或 xattr -dr com.apple.quarantine）。"
    ;;
esac

# ---- 2. designated requirement 必须锚定证书，而不是 cdhash ---------------------
#
# 「稳定」的可执行定义：requirement 里出现 cdhash 就意味着身份随代码变化。
# 注意：本项与钥匙串无关——凭据已不走钥匙串，这里只是确认签名本身可跨版本识别。
requirement="$(codesign -d -r- "$app_path" 2>&1 | sed -n 's/^designated => //p' || true)"
if [ -n "$requirement" ]; then
  log "designated requirement：$requirement"
  if grep -q 'cdhash' <<<"$requirement"; then
    fail "designated requirement 里含 cdhash，说明身份绑定到代码哈希而非证书：
$requirement"
  fi
  if grep -q 'anchor apple' <<<"$requirement"; then
    log "requirement 锚定 Apple 证书链。"
  elif grep -qE 'certificate (root|leaf)' <<<"$requirement"; then
    # 非 Apple 签发的证书（自签/企业 CA）会走这条：requirement 里是证书哈希。
    log "requirement 锚定到证书哈希（非 Apple 签发链）。"
  else
    log "警告：requirement 既未锚定 Apple 证书链，也未锚定到证书，请人工确认。"
  fi
else
  log "警告：未能解析 designated requirement（codesign 输出格式可能与预期不同），跳过该断言。"
fi

# ---- 3. Gatekeeper 评估：这一项才回答「所有人都能打开吗」 ------------------------
#
# `spctl -a -t exec` 就是 Finder 双击时 Gatekeeper 走的判定。它会检查 Developer ID
# 签名**以及**公证票据，因此这是唯一能证明「陌生用户双击即可打开」的断言。
# 前面的签名检查全过但这里失败，通常意味着**没有公证**（Apple 自 macOS 10.15 起要求
# 分发到 App Store 之外的软件必须公证）。
spctl_status=0
spctl_output="$(spctl -a -t exec -vv "$app_path" 2>&1)" || spctl_status=$?
if [ "$spctl_status" -eq 0 ]; then
  log "Gatekeeper 评估通过：$(printf '%s' "$spctl_output" | tr '\n' ' ')"
  notarized=1
else
  # 自签/未签名的包本来就会被拒，这里不 fail，但必须说清后果。
  log "警告：Gatekeeper 评估未通过——其他用户双击时会被拦下："
  printf '%s\n' "$spctl_output" | sed 's/^/        /'
  log "        原因通常是未公证或非 Developer ID 签名。用户只能手动绕过："
  log "          系统设置 → 隐私与安全性 → 「仍要打开」（macOS 15 起右键打开已失效）"
  log "          或 xattr -dr com.apple.quarantine \"<app>\""
  notarized=0
fi

# ---- 4. 公证票据是否已装订（stapled）-----------------------------------------
#
# 票据钉进产物后，用户离线也能通过 Gatekeeper 校验；没有 stapled 的包在无网环境下
# 首次打开会失败或长时间转圈。Tauri 构建时会自动 staple。
if [ "$notarized" -eq 1 ]; then
  if xcrun stapler validate "$app_path" >/dev/null 2>&1; then
    log "公证票据已装订（stapler validate 通过）。"
  else
    log "警告：Gatekeeper 通过但 stapler 校验失败——离线首次打开可能失败。"
  fi
fi

# ---- 5. 随包分发的原生可执行文件是否自带有效签名 --------------------------------
#
# Tauri 不签 Contents/Resources（源码已确认）。Apple Silicon 上未签名的 arm64
# Mach-O 会被内核直接杀掉，表现为内置引擎「不可用」。上游发行包一般已签名，故只报不拦。
resources_dir="$app_path/Contents/Resources"
if [ -d "$resources_dir" ]; then
  unsigned=0
  checked=0
  while IFS= read -r candidate; do
    # 只检查 Mach-O 可执行文件（magic：0xFEEDFACF / 0xCAFEBABE 等）。
    magic="$(head -c 4 "$candidate" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')"
    case "$magic" in
      cffaedfe | cefaedfe | cafebabe | bebafeca | feedface) ;;
      *) continue ;;
    esac
    checked=$((checked + 1))
    if ! codesign --verify --strict "$candidate" >/dev/null 2>&1; then
      unsigned=$((unsigned + 1))
      log "警告：Resources 下的可执行文件签名无效/缺失：${candidate#"$app_path"/}"
    fi
  done < <(find "$resources_dir" -type f -perm -u+x 2>/dev/null || true)

  if [ "$checked" -eq 0 ]; then
    log "Resources 下未发现 Mach-O 可执行文件（跳过该项检查）。"
  elif [ "$unsigned" -gt 0 ]; then
    log "警告：$checked 个内置可执行文件中有 $unsigned 个签名无效——在 Apple Silicon 上可能被内核杀掉。"
    log "        上游发行包一般已签名；若确有失败，需在打包后对它们单独 codesign。"
  else
    log "Resources 下 $checked 个内置可执行文件签名均有效。"
  fi
else
  log "本 bundle 没有 Contents/Resources 目录（跳过内置可执行文件检查）。"
fi

log "通过：$app_path 检查完成。"
