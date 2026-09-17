# 无限画布

基于 Tauri 2、React 19、TypeScript 和 Vite 的桌面应用工程。

## 环境要求

- Node.js 22.12 或更高版本
- pnpm 11 或更高版本
- Rust stable（项目会自动安装 `rustfmt` 与 `clippy` 组件）
- 对应操作系统的 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)

## 开发

```sh
pnpm install
pnpm tauri:dev
```

`1420` 是 Vite 的固定端口（`strictPort`），同一时间只能有一个 dev server。`pnpm dev` 因此先做一次端口预检（`scripts/dev-server.mjs`）：已有能正常服务本项目的 dev server 就直接复用它（不再另起第二个 vite，也不会因为端口被占用让 `beforeDevCommand` 失败），残留的僵死 server 会被清理后重启，被其他程序占用时只报告 PID 与命令行并拒绝启动。

需要自己独占端口（例如改了 `vite.config.ts` 想让配置生效）时，先停掉常驻的 dev server：

```sh
pnpm dev:daemon:stop    # 停止常驻 dev server（状态：pnpm dev:daemon:status）
```

后端的供应商配置、生成任务、持久化、结果保存、素材接口与 TOS 预签名服务契约见 [后端实现与接入说明](docs/backend-implementation.md)。

## 常用命令

| 命令                       | 用途                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `pnpm dev`                 | 仅启动 Vite 前端（复用已在运行的 dev server，没有则启动一个）     |
| `pnpm dev:daemon`          | 以脱离作业树的方式常驻启动 dev server（`status` / `stop` 同前缀） |
| `pnpm tauri:dev`           | 启动完整桌面应用（自动预置动画、FFmpeg 与 Blender 引擎）          |
| `pnpm build`               | 类型检查并构建前端                                                |
| `pnpm tauri:build`         | 构建桌面安装包（内置 FFmpeg 与 Blender，离线可用）                |
| `pnpm test`                | 运行前端测试                                                      |
| `pnpm lint`                | 执行类型感知 ESLint 检查                                          |
| `pnpm format`              | 使用 Prettier 格式化工程文件                                      |
| `pnpm check`               | 执行前端、Rust 格式化及 Clippy 全量检查                           |
| `pnpm ffmpeg:prepare`      | 下载并预置内置 FFmpeg 引擎到 `src-tauri/resources/ffmpeg/`        |
| `pnpm remotion:prepare`    | 准备内置动画渲染运行时                                            |
| `pnpm blender:prepare`     | 校验并预置随安装包分发的完整 Blender 引擎、许可与对应源码         |
| `pnpm macos:verify-bundle` | 校验 macOS 产物签名与内置可执行文件签名                           |

白模工作室默认使用应用内置 Blender，用户无需另行安装或首次运行时下载引擎。构建准备在开发机器上完成，正式安装包包含完整运行库、Python 与工程精修所需资源。外部 Blender 仅作为高级可选设置；内置资源缺失时会报告安装包损坏。打包方式、支持平台与验证说明见 [Blender 桥接](tools/blender/README.md)。

## 凭据存储：默认明文文件

API Key / 素材库令牌 / TOS AK-SK 默认存放在**应用数据目录下的 JSON 文件**：

- macOS：`~/Library/Application Support/com.infinitecanvas.desktop/credentials.json`
- Windows：默认走系统凭据管理器（想统一成文件则设 `INFINITE_CANVAS_CREDENTIAL_BACKEND=file`）

原因是 macOS 钥匙串条目的访问控制绑定「创建它的那个应用」的代码签名身份，并且有**两道**独立的门：ACL 里的可信应用列表，以及一条按 `partition_id` 授权的条目。没有 Apple 签名证书时，进程的 partition id 是 `cdhash:<代码哈希>`，**每出一个新版本都会变**——即使自签证书能把第一道门稳住，第二道门依然会失配，于是每次升级都要用户输入一次登录钥匙串密码，且该门无法通过列出「未来版本的哈希」来预先放行。

因此这里直接不碰钥匙串：文件权限收窄到 0600（仅本用户可读写），**不弹任何密码框、不需要 Apple 证书、不需要管理员命令**。

**这是明确的取舍**：能读到该文件的进程就能读到全部密钥。App 内的密钥输入框本来也是明文显示（既定产品行为）。

- 换回系统凭据库：`INFINITE_CANVAS_CREDENTIAL_BACKEND=keyring`。
- 备份/迁移密钥：直接复制上面那个 JSON 文件。

## macOS 打包：让所有人都能打开

凭据已不走钥匙串，所以**签名与「弹不弹密码框」无关**。签名只关系到**别人能不能打开你的包**：

- 未签名的包在别的 Mac 上会被 Gatekeeper 拦下；macOS 15 起右键「打开」已不再能绕过。
- Apple Silicon 上未签名的 arm64 可执行文件会被内核直接杀掉。
- 注意 Tauri 在 macOS 上**没有配置签名身份时根本不做签名**（不是退回 ad-hoc，而是整段跳过且不打日志）。

### 方案 A：没有 Apple 证书 —— 用户跑一条命令

`scripts/install-macos.sh` 随包一起发出去，用户只需：

```bash
sudo bash install-macos.sh ~/Downloads/无限画布_0.1.0_aarch64.dmg
```

脚本会：清掉 DMG 与 app 的隔离属性 → **由内到外 ad-hoc 重签 app 内所有可执行文件** → 装到 `/Applications` → 校验。

**为什么不能只清 quarantine**（网上最常见的错误建议）：清 quarantine 只解决 Gatekeeper。Apple Silicon 上 **arm64 可执行文件必须有有效签名才能被内核执行**，而 Tauri 在没有证书时什么都不签，内置 FFmpeg / Blender 也可能未签名——只清 quarantine 的话，app 能打开但一用到这些引擎就被杀。所以脚本必须同时做 **ad-hoc 重签**（`codesign -s -`，不需要任何证书）。

代价：用户要手动跑一条命令（**这就是没有 Apple 证书的必然代价**，没有技术替代方案）；且每次把 app 移到新位置或重新下载，都要再跑一次。

### 方案 B：有 Apple 证书 —— 用户双击即可

要让**任何** Mac 双击就能打开，必须同时具备三样：

| 前置                                   | 作用                                                     | 缺失后果                     |
| -------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| Apple Developer Program 会员（$99/年） | 签发 Developer ID 证书的前提                             | 无法签名，陌生人必须手动绕过 |
| **Developer ID Application** 证书      | 证明来源可信                                             | 提示「无法验证开发者」       |
| **公证（notarization）凭据**           | Apple 自 macOS 10.15 起要求 App Store 之外的软件必须公证 | 签名有效但仍被拦下           |

**只签名不公证是不够的**——这是最常见的误解：Developer ID 签名只解决「谁签的」，公证才解决「Apple 已检查过」。公证凭据两种任选：

- Apple ID：`APPLE_ID` + `APPLE_PASSWORD`（**App 专用密码**，不是账号密码）+ `APPLE_TEAM_ID`
- App Store Connect API Key（推荐，不受双重验证影响）：`APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`

CI 侧全部配在 `.github/workflows/macos-package.yml` 的 job 级环境变量里；配齐后流水线会自动签名 → 公证 → 装订票据（stapler）。没配齐时 run summary 会明确写出缺哪一项、以及用户需要手动做什么。

### 自检

- 自己开发用：把包留在本机即可，**不需要任何证书**。
- 方案 B 打包后自检：`pnpm macos:verify-bundle "src-tauri/target/release/bundle/macos/无限画布.app"`。
  它会跑 `spctl -a -t exec`（Finder 双击时 Gatekeeper 走的同一判定）与 `stapler validate`，
  所以**它就是「所有人能不能打开」的答案**；同时检查内置 FFmpeg / Blender 的签名。
- 方案 A 的参数自检：`bash scripts/install-macos.sh <dmg> --dry-run`（只解析参数、不做任何改动，任意平台可跑）。
- macOS 14 是本项目 CI 的构建机版本；产物要求 macOS 11.0+（见 `tauri.conf.json` 的 `minimumSystemVersion`）。

## 系统访问能力

此工程按初始化要求使用有意开放的 Tauri 能力配置。`full-access` 能力作用于所有桌面窗口、WebView 以及 HTTP/HTTPS 远程页面，并启用文件系统、Shell、HTTP、进程、操作系统、剪贴板、对话框、全局快捷键、通知、日志、持久化存储、上传、WebSocket 和打开器插件。

Shell 插件提供以下无参数限制的命令别名：`cmd`、`powershell`、`pwsh`、`sh`、`bash`、`zsh`。前端可通过这些系统命令解释器执行任意可用命令。文件系统和资源协议范围均为 `**`，CSP 已关闭，Tauri 全局 API 与发布版开发者工具均已启用。

权限配置位于 `src-tauri/capabilities/full-access.json`。这是高风险配置，只适合明确需要完全本机权限且完全信任所有加载内容的应用。

## 目录结构

```text
src/                         React + TypeScript 前端
src-tauri/src/backend/       Rust 业务后端、SQLite、供应商与本地结果模块
src-tauri/src/lib.rs         Tauri 应用入口、后端初始化与命令注册
src-tauri/capabilities/      Tauri 2 权限能力
src-tauri/tauri.conf.json    应用、窗口、构建与安全配置
```
