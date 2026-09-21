# 无限画布

基于 Tauri 2、React 19、TypeScript 和 Vite 的桌面应用工程。

## 环境要求

- Node.js 22.12 或更高版本
- pnpm 12 或更高版本
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

| 命令                       | 用途                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`                 | 仅启动 Vite 前端（复用已在运行的 dev server，没有则启动一个）                        |
| `pnpm dev:daemon`          | 以脱离作业树的方式常驻启动 dev server（`status` / `stop` 同前缀）                    |
| `pnpm tauri:dev`           | 启动完整桌面应用（自动预置动画、FFmpeg 与 Blender 引擎）                             |
| `pnpm build`               | 类型检查并构建前端                                                                   |
| `pnpm tauri:build`         | 构建桌面安装包（内置 FFmpeg 与 Blender，离线可用；有升级私钥时同时生成可热更新产物） |
| `pnpm update:manifest`     | 根据本次 updater 产物生成 `latest.json`                                              |
| `pnpm test`                | 运行前端测试                                                                         |
| `pnpm lint`                | 执行类型感知 ESLint 检查                                                             |
| `pnpm format`              | 使用 Prettier 格式化工程文件                                                         |
| `pnpm check`               | 执行前端、Rust 格式化及 Clippy 全量检查                                              |
| `pnpm ffmpeg:prepare`      | 下载并预置内置 FFmpeg 引擎到 `src-tauri/resources/ffmpeg/`                           |
| `pnpm remotion:prepare`    | 准备内置动画渲染运行时                                                               |
| `pnpm blender:prepare`     | 校验并预置随安装包分发的完整 Blender 引擎、许可与对应源码                            |
| `pnpm macos:verify-bundle` | 校验 macOS 产物签名与内置可执行文件签名                                              |

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

### 排障时别混淆两种钥匙串故障

它们成因和修法都不同，`security(1)` 也把 partition list 描述为「ACL 之外的额外参数」：

| 条目所在                                              | 失效原因                                          | 修法                                                    |
| ----------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| 文件型登录钥匙串（`SecAccess` ACL，**本项目旧实现**） | designated requirement 失配 + partition list 失配 | 稳定签名身份 + 修 partition list                        |
| Data Protection keychain                              | entitlement / access group 变化                   | 保持 entitlement 稳定（`codesign -d --entitlements -`） |

另外注意：钥匙串弹的是**提示**，不是「永久读不到」。只有非交互路径下的 partition 失配才会硬失败（`errSecAuthFailed`，-25293）。

Apple 的 TN3127《Inside Code Signing: Requirements》描述了同一机制：ad-hoc 签名有 designated requirement，但绑定在那一份具体代码上，因此改了代码再运行会被再次索要授权。Apple 的首选解法是 data protection keychain，但那需要 provisioning profile（TN3137），没有开发者账号时不可用。

### 为什么不能「把 ACL 设成不再问密码」

因为 macOS 从 **10.13.1 起就不允许了**。Apple 文档（`SecACLCreateWithSimpleContents` / `SecACLSetContents` 两页同一段注释）明确写道：为增强安全性，系统**忽略 ACL 对象的 `promptSelector` 属性，并且在询问用户是否把某个 app 加入可信列表时总是索要钥匙串密码**。也就是说：

- 「请输入登录钥匙串密码」不是另一种对话框，而是与「拒绝 / 允许 / 始终允许」**并存**的一行；
- `-A`（allow all applications）里唯一还有作用的只是把应用列表置空；它清除 REQUIRE_PASSPHRASE 的那部分是历史遗留，在现代 macOS 上不生效；
- 因此**没有任何 ACL 开关（包括 `-A`）能免掉这个密码框**——唯一的杠杆是「不要把上面那两道门校验弄失配」。

补充一条相关事实：`始终允许` 需要系统能在磁盘上定位到该代码（`acl_keychain.cpp` 里 `remember && validation != errSecSecStaticCodeNotFound` 才记录授权），这正说明了**代码身份稳定**是授权能生效的前提。

> 诚实边界：Apple 文档说密码「总是」需要，但社区在个别更高版本上报告过不带密码句的对话框（VS Code / Azure Data Studio），无截图佐证。因此上面结论以 **securityd 机制**为准，不把对话框 UI 的细节当作已定论。

## macOS 打包：让所有人都能打开

凭据已不走钥匙串，所以**签名与「弹不弹密码框」无关**。签名只关系到**别人能不能打开你的包**：

- `bundle.macOS.signingIdentity` **未设置时 Tauri 整段跳过签名**（不打日志、不退回 ad-hoc）。未签名的 bundle 在 macOS 上被报成「**已损坏，无法打开**」，连绕过 Gatekeeper 的机会都没有。
- 本项目因此固定设 `"signingIdentity": "-"`（ad-hoc），保证**每次构建都得到签名自洽的 bundle**。有 Developer ID 证书时由 `APPLE_SIGNING_IDENTITY` 环境变量覆盖（该变量优先于配置，Tauri CLI 会读取）。
- Apple Silicon 上 **arm64 可执行文件必须有有效签名才会被执行**，否则被内核直接杀掉。

### 方案 A：没有 Apple 证书 —— 用户粘贴一条命令

**前提（重要）**：`bundle.macOS.signingIdentity` 必须是 `"-"`（本项目已配置）。不设它的话 Tauri 会**整段跳过签名**，产出的未签名 bundle 在 macOS 上会被报成「**已损坏，无法打开**」——这不是 Gatekeeper 的可绕过提示，而是 bundle 签名不自洽。设成 `"-"` 后 Tauri 会执行 **ad-hoc 签名**（`codesign -f -s -`），bundle 签名自洽，app 可以正常运行。

ad-hoc 之后，用户唯一需要做的就是把下载带来的隔离属性清掉。给用户**一条自包含、不依赖任何脚本文件**的命令：

```bash
APP=$(ls -d /Volumes/*/*.app 2>/dev/null | head -1); sudo xattr -cr "$APP"; sudo cp -R "$APP" /Applications/ && sudo xattr -cr "/Applications/$(basename "$APP")" && open "/Applications/$(basename "$APP")"
```

先**双击挂载 DMG**，再粘贴这一行。它做的事：把 DMG 里的 app 复制出来 → 清掉隔离属性 → 安装到 `/Applications` → 直接打开。

> 早期版本让用户执行 `sudo bash install-macos.sh <dmg>`，但那个脚本不在 DMG 里、也不在用户当前目录，用户会撞到 `No such file or directory`。上面这条命令因此不再依赖任何额外文件。`scripts/install-macos.sh` 仍保留给愿意下载脚本的人，功能更全（含由内到外的逐文件重签与校验）。

**为什么 ad-hoc 是必须的**（网上「只需清 quarantine」的建议不完整）：Apple Silicon 上 **arm64 可执行文件必须有有效签名才能被内核执行**。没有 `signingIdentity: "-"` 时 Tauri 什么都不签，未签名的 bundle 甚至不给你绕过 Gatekeeper 的机会，直接报「已损坏」。

代价：用户要粘贴一条命令（**这是没有 Apple 证书的必然代价**，没有技术替代方案）；每次重新下载都要再做一次。

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

## 应用内升级

客户**不必卸载重装**。新版本覆盖安装目录里的程序；画布、密钥、素材库在用户数据目录，升级不会清掉。

| 平台    | 已安装用户怎么升级                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Windows | 直接运行新的安装包即可覆盖。NSIS（`.exe`）是自动更新用的包；WiX（`.msi`）靠固定 `upgradeCode` + **升高版本号** 做覆盖安装。 |
| macOS   | 把新 `.app` 覆盖到 `/Applications`（现有安装命令已经是覆盖）。之后即可走应用内更新。                                        |

应用启动后会静默检查更新。发现新版本时画布上方出现提示，设置页「应用升级」也可手动检查。下载完成后点「立即重启」即完成。安装包含内置引擎，体积较大，因此**不会在后台偷偷下完整包**，必须用户确认。

当前已装的 `0.1.0` **还没有更新器**，需要装一次 `0.1.1`。从 `0.1.1` 起就可以在应用里直接升。

### 发版时开发者要做的

1. **升高版本号**（`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处保持一致）。Windows MSI 版本不变会被系统当成「已安装」，拒绝覆盖。
2. 构建机提供升级签名私钥：本机是 gitignored 的 `src-tauri/.updater-key`；CI 用环境变量 `TAURI_SIGNING_PRIVATE_KEY`（文件原文）。公钥已写入 `tauri.conf.json`，**私钥丢失则所有已发布安装包都无法再被热更新**。
3. `pnpm tauri:build` 会在有私钥时额外产出 `.app.tar.gz` / NSIS `-setup.exe` 及其 `.sig`。
4. 把这些文件和 `latest.json` 发到火山引擎 TOS 公开前缀 `infinite-canvas/updates/`（桶 `sd20-zq` / `cn-beijing`）：

```sh
pnpm update:publish -- --notes "修复说明"
```

应用内检查地址是 `https://sd20-zq.tos-cn-beijing.volces.com/infinite-canvas/updates/latest.json`。上传凭据用环境变量 `TOS_ACCESS_KEY` / `TOS_SECRET_KEY`，不要写进仓库。CI 构建成功后会自动执行 `pnpm update:publish`。

Windows 用户请优先分发 NSIS `.exe`：应用内更新走的就是它。已用 MSI 安装的用户，用更高版本号的 MSI 覆盖一次即可；之后的自动更新会改走 NSIS。

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
