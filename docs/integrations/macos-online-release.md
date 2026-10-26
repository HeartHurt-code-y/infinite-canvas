# Mac 轻量联网版构建与交付

Mac 联网版的主安装包内置应用、基础 FFmpeg 和必要方法文档。媒体处理能力随应用直接就绪，不再有需要用户单独安装的组件；缺少内置引擎时保留草稿，由用户主动继续，不自动提交付费任务。

## 原生构建

Apple Silicon 用原生 arm64 Node/Rust，Intel 用原生 x64 Node/Rust；构建、组件准备和完整性验证都在对应 Mac 完成，不支持跨编译或 universal 应用包。依赖沿用 `pnpm install --frozen-lockfile`。准备 Tauri 更新签名私钥后执行：

```sh
bash scripts/prepare-macos-online-signing.sh
bash scripts/build-macos-online.sh
```

CI 的第一个脚本把选定身份写入后续步骤环境。本地 shell 可明确使用 `APPLE_SIGNING_IDENTITY=-`（无证书默认值），或已有 Developer ID 身份。脚本不会要求 Apple 公证凭据。

通用构建入口为 `pnpm tauri:build:online --bundles app,dmg`。完整构建仍用 `pnpm tauri:build`；Windows 的 online/offline 入口保持原行为。

## 交付目录

`.cache/tauri-editions/online/artifacts/<version>/` 包含：

- `dmg/无限画布_<version>_<aarch64|x64>-online.dmg`：首次安装。
- `macos/无限画布_<version>_<aarch64|x64>-online.app.tar.gz` 及 `.sig`：应用内更新。
- `helper/install-macos.sh`：首次安装及 Gatekeeper 解锁指引。
- `distribution.json`、`build-source.json`、`latest.json` 与 `publish-manifest.json`：版本、源码、组件目录、真实产物摘要和发布目标。

`.cache/runtime-components/packages/*.zip` 是按内容摘要命名的组件包；它们与 `src-tauri/resources/component-catalog.json` 一起保留。Mac 包保留文件执行权限以及安全的相对软链接，安装时先落普通文件再创建软链接，并验证完整目录、目标和权限。

`node scripts/verify-edition-release.mjs --distribution-dir <交付目录>` 必须在原生 Mac 上通过。它验证应用代码签名、版本/标识/架构、编译目录 pins、精确轻量资源表、更新签名、归档和 DMG 里的应用字节与权限；不执行 Apple 公证。

## CI 与发布

GitHub 的 `macos-online-package.yml` 仅手动触发；可选 arm64 或 x64，分别使用对应原生 runner。`publish` 默认关闭，构建成功后上传交付目录和可信组件 ZIP。Codemagic 新增 `macos-online-package`（M2 arm64），沿用 `updater_signing` 环境组；只有 `IC_PUBLISH_ONLINE_RELEASE=true` 时公开发布。原完整 Mac 流水线继续保留。

GitHub 联网构建缓存已准备的原生 FFmpeg 目录和组件 ZIP。缓存键按系统、架构、Node 版本及组件准备输入摘要区分，不包含应用版本号；仅升级应用或修改普通业务代码时可复用。仅恢复精确匹配的组件准备输入，不通过前缀恢复旧配方；输入或依赖改变时重新准备。准备脚本仍检查现有源码指纹和完整文件摘要，ZIP 仍逐项校验后复用。本次应用的组件目录清单、安装包与更新签名始终重新生成。缓存只在真实 Mac 构建与交付验证成功后保存；首次未命中或缓存被 GitHub 清理时仍需完整准备。

公开发布使用：

```sh
pnpm update:publish:online --distribution-dir .cache/tauri-editions/online/artifacts/<version>
```

频道按架构隔离为 `darwin-aarch64-online` 和 `darwin-x86_64-online`，不覆盖既有完整 Mac 频道。发布者先验证全部本地产物及源码身份，再上传程序、签名、DMG、版本化安装脚本 `install-macos-<version>.sh` 与组件 ZIP，并检查公开对象摘要/大小，最后切换 `latest.json`。

包未经 Apple 公证，首次安装可能被 Gatekeeper 拦截。联网版首次安装保留已验证的原始代码签名及组件字节，仅清理隔离属性；签名无效时要求重新下载，不能重签绕过组件摘要。构建脚本会用实际 DMG 在临时目录执行首次安装并复验全部字节和权限。保留整个交付目录，可用 `sudo bash helper/install-macos.sh '<DMG路径>'` 安装，或按应用内解锁脚本指引处理。

## 验证边界

Windows/Linux 上的目录、ZIP 和模拟归档测试只验证合同及拒绝错误输入的行为。真实 Mac 的代码签名、DMG 挂载、组件权限/软链接恢复和实际功能启动，必须由 Mac 构建任务和后续安装验收证明。产物尚未构建、验签并取得实际下载地址前，不标记为已交付。
