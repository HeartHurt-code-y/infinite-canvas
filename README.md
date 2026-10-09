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

| 命令                         | 用途                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`                   | 仅启动 Vite 前端（复用已在运行的 dev server，没有则启动一个）               |
| `pnpm dev:daemon`            | 以脱离作业树的方式常驻启动 dev server（`status` / `stop` 同前缀）           |
| `pnpm tauri:dev`             | 启动完整桌面应用（自动预置动画、FFmpeg 与 Blender 引擎）                    |
| `pnpm build`                 | 类型检查并构建前端                                                          |
| `pnpm tauri:build`           | 构建带完整本地引擎的离线安装包；有升级私钥时同时签名 updater 产物           |
| `pnpm tauri:build:online`    | 构建 Windows / macOS 原生架构轻量联网版，按需安装功能组件，使用独立更新频道 |
| `pnpm update:publish:online` | 校验轻量版构建凭证、签名与七种组件，上传并逐字节验证后发布独立更新频道      |
| `pnpm tauri:build:offline`   | 构建 Windows 完整离线套件：安装包内置五种组件，两种 AI 组件随附 ZIP         |
| `pnpm components:pack`       | 校验运行资源并生成压缩组件包、固定摘要目录及离线导入用 ZIP                  |
| `pnpm tauri:bundle:slim`     | 基于已构建程序生成 Windows 小型更新包，需提供已发布完整包的资源基线         |
| `pnpm update:manifest`       | 根据指定版本的 updater 产物生成 `latest.json`                               |
| `pnpm test`                  | 运行前端测试                                                                |
| `pnpm lint`                  | 执行类型感知 ESLint 检查                                                    |
| `pnpm format`                | 使用 Prettier 格式化工程文件                                                |
| `pnpm check`                 | 执行前端、Rust 格式化及 Clippy 全量检查                                     |
| `pnpm ffmpeg:prepare`        | 下载并预置内置 FFmpeg 引擎到 `src-tauri/resources/ffmpeg/`                  |
| `pnpm remotion:prepare`      | 准备内置动画渲染运行时                                                      |
| `pnpm blender:prepare`       | 校验并预置随安装包分发的完整 Blender 引擎、许可与对应源码                   |
| `pnpm macos:verify-bundle`   | 校验 macOS 产物签名与内置可执行文件签名                                     |

Windows x64 与 macOS Apple Silicon 提供轻量联网版。轻量版保留日常媒体处理所需的 FFmpeg，Blender、动画和网页解析、动捕、图片风格库及 AI 媒体运行时通过顶部「功能组件」安装；对应功能首次使用时会打开所需组件列表。支持中断续传、修复及离线 ZIP 导入，安装后返回原功能主动继续操作，保留草稿与已有任务。构建机仍须预先准备并校验全部七种组件，生成本版本程序信任的目录、摘要和各原生架构的压缩包。显式选择外部 Blender 继续作为高级可选设置。

Windows 完整离线套件的安装包内置 Blender、Remotion、FFmpeg、动捕和风格库五种组件，两种 AI 组件以 ZIP 随套件提供；安装应用后在「功能组件」分别导入随附 ZIP，即可离线准备全部七种组件，无需下载。交付时须保留安装包、签名、两种 AI ZIP 与离线组件收据的完整套件，单独安装 EXE 不会同时安装两种 AI 组件。macOS 联网版首次安装交付 DMG，更新交付签名的 `.app.tar.gz`，使用独立 `darwin-aarch64-online/latest.json` 频道；目前仅构建 Apple Silicon。macOS 完整版继续使用原构建入口。分发与校验流程见 [功能组件与轻量版](docs/integrations/runtime-components.md) 和 [Blender 桥接](tools/blender/README.md)。

发行资源准备会精简运行时不需要的开发内容：Windows Blender 排除 PDB 调试符号；Remotion 按实际依赖关系合并可兼容的重复副本，并排除旧的 `.ignored_*` 依赖目录；独立 AI 组件排除指定开发静态链接库与 C/C++ 头文件。引擎动态库、Python/Node、浏览器、模型、参考原图、许可证与对应源码继续保留。完整性清单在精简后重新生成，程序须根据这些清单重新构建；不能手动删除资源后继续复用旧程序或旧签名清单。

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

ad-hoc 签名后，首次从下载的 DMG 安装仍需清除 macOS 的隔离属性。双击挂载 DMG，把「无限画布.app」拖进「应用程序」，然后在终端运行内置脚本：

```bash
sudo bash "/Applications/无限画布.app/Contents/Resources/unlock-installed-macos-app.sh"
```

脚本随 DMG 中的 app 一起交付，无需另行下载。它先校验已安装 app 的签名，只移除该 app 的 `com.apple.quarantine`，再复验签名；完成后从「应用程序」打开即可。它不会覆盖或重新签名 app，因此不会改变包级差分更新所需的文件内容。

旧版 DMG 没有内置脚本时，仍可使用 `sudo xattr -dr com.apple.quarantine "/Applications/无限画布.app"` 解锁已安装、签名校验通过的 app。联网版首次安装也可使用交付目录的 `helper/install-macos.sh`（源码为 `scripts/install-macos.sh`）：`sudo bash install-macos.sh /path/to/无限画布_<版本>_aarch64-online.dmg`。脚本检验并保留联网版已有签名及组件固定摘要，清除隔离属性并安装到 `/Applications`；原有签名损坏时须重新下载。公开分发的脚本使用 `install-macos-<版本>.sh` 文件名，与对应应用版本绑定。

**为什么 ad-hoc 是必须的**（网上「只需清 quarantine」的建议不完整）：Apple Silicon 上 **arm64 可执行文件必须有有效签名才能被内核执行**。没有 `signingIdentity: "-"` 时 Tauri 什么都不签，未签名的 bundle 甚至不给你绕过 Gatekeeper 的机会，直接报「已损坏」。

未公证的 DMG 需要用户对新安装的 app 执行一次解锁命令；如果日后重新从 DMG 安装，也需要对新副本重新执行。

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

macOS 联网版使用 GitHub Actions 的 `macOS Online Package` 手动工作流，选择 `arm64`，启用 `publish` 后发布经验证的 Apple Silicon DMG、Tauri 更新包、安装脚本及七种独立组件。流程校验应用代码签名、版本、架构、更新签名、目录固定摘要及 DMG/更新归档的实际内容，并从真实 DMG 安装到临时目录校验安装后字节和权限。程序与组件先上传并通过匿名完整下载校验，最后切换独立 `darwin-aarch64-online/latest.json` 清单。首次安装脚本保留联网版的原始签名；未经公证的包可能被 Gatekeeper 拦截，须按前述安装指引处理。

macOS 完整版更新继续使用 `codemagic.yaml` 的 `macos-package` 工作流；`updater_signing` 环境组需要 Tauri updater 私钥和 TOS 上传凭据。Apple 证书与公证凭据不是项目发布前提，缺少证书时使用 ad-hoc 签名。原 `.github/workflows/macos-package.yml` 手动工作流仅构建、暂存完整包。旧共享更新清单不再发布，各平台和联网版使用各自频道。

### 自检

- 自己开发用：把包留在本机即可，**不需要任何证书**。
- 方案 B 打包后自检：`pnpm macos:verify-bundle "src-tauri/target/release/bundle/macos/无限画布.app"`。
  它会跑 `spctl -a -t exec`（Finder 双击时 Gatekeeper 走的同一判定）与 `stapler validate`，
  所以**它就是「所有人能不能打开」的答案**；同时检查内置 FFmpeg / Blender 的签名。
- 方案 A 的脚本语法自检：`bash -n scripts/unlock-installed-macos-app.sh`；构建流水线还会核对 `.app` 和 DMG 中的脚本内容及应用签名。
- 当前 Codemagic 构建机为 `mac_mini_m2`；产物要求 macOS 11.0+（见 `tauri.conf.json` 的 `minimumSystemVersion`）。

## 应用内升级

客户**不必卸载重装**。新版本覆盖安装目录里的程序；画布、密钥、素材库在用户数据目录，升级不会清掉。

| 平台    | 已安装用户怎么升级                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Windows | 直接运行新的安装包即可覆盖。NSIS（`.exe`）是自动更新用的包；WiX（`.msi`）靠固定 `upgradeCode` + **升高版本号** 做覆盖安装。 |
| macOS   | 旧版若在资源迁移阶段无法下载更新，使用同版离线 DMG 覆盖 `/Applications` 中的 `.app`；之后即可走应用内更新。                 |

应用启动后会静默检查更新；运行期间窗口可见且联网时每两分钟检查一次，窗口重新获得焦点或网络恢复时也会补查。发现新版本后自动准备资源、下载安装并重启应用；画布保存失败时停止安装并显示错误。设置页「应用升级」也可手动检查。

Windows `0.1.10` 完整过渡版把内置引擎与风格图片安全转存到用户数据目录；完成桥接的客户端可通过 `0.1.11` 平台频道下载小型程序安装包和变化的资源文件。Tauri 的 Windows updater 仍下载所选安装包，并非二进制差分。`0.1.11` 发版在本地构建完整 NSIS 以校验小包，默认不上传完整离线包。`0.1.8`、`0.1.9` 等尚未完成桥接的客户端需先手动安装 `0.1.10` 完整过渡版；旧共享频道客户端在旧清单删除后也需手动过渡。详细发版顺序和验证边界见 [Windows 小型更新方案](docs/integrations/windows-small-updates.md)。

当前已装的 `0.1.0` **还没有更新器**，需要装一次 `0.1.1`。从 `0.1.1` 起就可以在应用里直接升。

### 发版时开发者要做的

每次发版都升高 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本号并保持一致。签名私钥只放在本机被忽略的 `src-tauri/.updater-key` 或 CI 密钥环境变量中，上传凭据只使用 `TOS_ACCESS_KEY` / `TOS_SECRET_KEY`。Mac Codemagic 工作流通过产物校验后只发布 macOS 平台清单，触发前须确认源码提交。Windows 小包发布前仍须在本地构建、验签同版完整 NSIS，但默认只上传小包和变化的资源文件。完整命令、平台通道和回滚要求见 [Windows 小型更新方案](docs/integrations/windows-small-updates.md)。

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
