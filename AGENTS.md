# 项目发布约定

- macOS 构建与更新发布不要求 Apple 公证；不要因缺少公证凭据暂停发布，也不要在每次发布时重复询问。
- 没有 Developer ID 证书时，沿用项目的 ad-hoc 签名方案。发布前仍须校验应用包签名、Tauri 更新签名、版本和实际产物。
- 发布说明须告知用户未经公证的包可能被 Gatekeeper 拦截，并提供 `scripts/install-macos.sh` 的首次安装指引。
- 只有用户明确改变要求时，才把 Apple 公证加入发布流程。
