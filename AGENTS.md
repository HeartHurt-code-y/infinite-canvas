# 项目发布约定

- macOS 构建与更新发布不要求 Apple 公证；不要因缺少公证凭据暂停发布，也不要在每次发布时重复询问。
- 没有 Developer ID 证书时，沿用项目的 ad-hoc 签名方案。发布前仍须校验应用包签名、Tauri 更新签名、版本和实际产物。
- 发布说明须告知用户未经公证的包可能被 Gatekeeper 拦截，并提供 `scripts/install-macos.sh` 的首次安装指引。
- 只有用户明确改变要求时，才把 Apple 公证加入发布流程。

# 项目组件分发约定

- 已取消“Blender 必须随主安装包完整内置、使用时无需下载”的项目约定。允许将 Blender 作为独立功能组件按需下载或通过离线组件包安装；完整离线安装包可作为可选交付方式。

# 报错提示约定

- 用户看到的报错必须用人话：一律用 `src/components/ErrorAlert.tsx`（红色高亮 + 图标 + 文字）渲染，显示 `backendErrorMessage(error)` 的摘要；原始 payload / 堆栈只放进「展开完整报错」。
- 不要再用 `<p role="alert">{error}</p>` 或 `formatRawBackendError(error)` 直接给用户看：那会把 `{"details":null,"kind":"validation",…}` 这种 JSON 印在界面上，读屏软件还会整段朗读。
- `formatRawBackendError` 只用于日志与调试输出，不是用户文案。
- 报错不能只靠颜色区分（WCAG 1.4.1）：必须同时有图标和文字；触发错误的控件用 `aria-describedby` 指向错误元素（WCAG 3.3.1）。
- 报错要能回答「接下来怎么办」：`ErrorAlert` 的 `hint` 写补救动作；只说「这张图不合格」不说换什么图，用户只能靠猜。
- 产品场景这套工作流里，模式决定素材口径（原图保真合成只收白底/透明底，AI 多机位 + 品牌摄影与珠宝原片保护才保留整张原片）。判定统一读 `productScenePreservesSourcePhotos`，不要在界面、提示文案、模式切换清理里各复制一份。
