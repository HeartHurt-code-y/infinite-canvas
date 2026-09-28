# Windows 小型更新与过渡发版

Tauri 2 在 Windows 上把完整 NSIS/MSI 安装器作为 updater 产物，因此本项目的 `0.1.7` 更新下载约 733 MiB。这里的小型更新仍是经过 Tauri 签名的 NSIS 安装器；它只包含新的程序，不重复携带稳定的 Blender、Remotion、FFmpeg 与风格库资源。首次安装始终提供包含全部资源的离线安装包。

## 兼容边界

- `0.1.7` 客户端固定读取 `infinite-canvas/updates/latest.json`，Windows 和 macOS 共用一个顶层版本。它不能区分先前使用 NSIS 还是 MSI 安装。**该旧地址只接收同一版本的完整 Windows 与 macOS 过渡安装包**；不能直接换成小型 Windows 包，也不能把旧 Mac 产物合并进新版本清单。
- 过渡版改用 `updates/{{target}}-{{arch}}/latest.json`。这样其后的 Windows 与 macOS 版本可以独立推进。发布旧地址之前，先初始化两个平台的新地址，避免客户升级后检查更新失败。
- 过渡版启动后，在后台把四类稳定资源复制到 `AppLocalData/runtime-components/` 的版本目录，逐文件校验后才标记完成。迁移期间依旧使用安装目录里的完整资源。组件未准备好时，应用内更新会等待并显示本地进度；失败时保留原安装并显示错误。
- 小包的 NSIS 安装程序在卸载任何旧版之前，先运行新程序的只读组件自检。自检只接受四类已持久化且与新构建清单匹配的资源，手动运行小包或静默安装也必须通过；失败时停止安装，改用完整离线包修复。
- 新版客户端在下载小型 NSIS 前先获取目标版本的签名资源清单。它按 SHA-256 复用本地已有文件，仅下载缺少或内容变化的对象，逐文件校验后在持久组件目录发布完整的目标版本；安装器预检再以新程序内置的清单核对这四类组件。失败时保留旧组件与旧程序，可重试。
- 应用保持自动检查更新；发现新版本后在后台准备资源并下载小型安装包。下载完成只提示“安装并重启”，由用户决定何时中断当前画布会话。
- `update:baseline` 保留完整过渡包的版本、签名包哈希与资源映射来源。`tauri:bundle:slim` 要求本版完整 NSIS 文件表覆盖四类资源的每个文件，且新程序内置的四个清单哈希与签名资源清单一致，才允许这些组件的资源树变化。资源映射或未纳入按文件更新的其他技能资源变化仍需新的完整过渡包。
- 旧 NSIS 的 `/UPDATE` 安装会保留未列入新包的资源；从 MSI 来的客户可能先卸载原安装。持久组件目录覆盖这两条路径。小包安装失败时仍可运行完整离线安装包修复。

## 构建和发布顺序

1. 将 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 升到相同的新版本。备齐原 updater 签名私钥；不能更换已经发给客户的公钥。
2. Windows 上运行 `pnpm tauri:build` 生成并保留同版签名 NSIS。对构建时准备的稳定资源运行 `pnpm update:baseline -- --out <bridge-baseline.json> --full-nsis <同版完整NSIS路径>`，把含完整包及签名哈希的基线与安装包一同归档。将同版源码提交推送到 Codemagic 所用分支，确认 `updater_signing` 环境组中的 updater 私钥与 TOS 上传凭据后，再触发 `codemagic.yaml` 的 `macos-package`。本项目不要求 Apple 公证；无证书时使用 ad-hoc 签名，并向首次安装者提供隔离属性处理指引。
3. Windows 用 `pnpm update:publish -- --channel windows-x86_64 --bundle-dir <windows-full-dir> --full-bundle-dir <windows-full-dir> --version <version>` 发布。Codemagic 的 Mac 工作流在验签后用 `--channel darwin-aarch64 --bundle-dir <mac-full-dir> --full-bundle-dir <mac-dmg-dir> --version <version>` 先上传同版离线 DMG 与安装脚本，再切换平台 `latest.json`。旧 Mac 客户端若在资源迁移阶段卡住，可用离线 DMG 一次性覆盖安装。`.github/workflows/macos-package.yml` 只构建产物，作为备用入口。
4. Mac 工作流确认公开 Windows 与 Mac 平台清单同版，且 Windows 包为完整 NSIS 后，自动运行 `--promote-legacy` 切换旧共享地址。未齐备两个平台时不得切换。
5. **仅在过渡版的迁移与升级路径通过验证后**，下次常规 Windows 发版先构建完整离线安装包，再运行 `pnpm tauri:bundle:slim -- --baseline <bridge-baseline.json>`。此步骤从完整 NSIS 文件表生成目标版本的签名资源清单，并要求完整包的修改时间晚于新程序及清单覆盖的所有资源源文件；小型包继续只包含程序。检查清单、完整包、小包及签名，再用 `--channel windows-x86_64 --bundle-dir <slim-dir> --full-bundle-dir <full-dir> --version <version>` 发布。发布脚本先确认内容哈希对象与清单均可匿名访问，最后切换 `latest.json`；完整安装包继续作为离线安装和修复入口。

上述命令中的目录必须来自同一次构建。`TOS_ACCESS_KEY`、`TOS_SECRET_KEY` 只从环境变量读取；不要放进命令、文档或仓库。每次更新都升版本号，避免 CDN 的长期缓存复用旧安装包 URL。
修改时间检查能拦住完整包构建后又修改程序或资源的常见失配，但不是完整 NSIS 内每个文件字节与当前源码一致的证明。发布验收仍需核对实际完整包和小包。

## 最小验收

1. 运行更新脚本的定向测试、Rust 组件迁移及按文件预备的定向测试，以及 TypeScript 类型检查。
2. 对实际生成的 NSIS 脚本确认小包未含 `blender/`、`remotion-runtime/`、`ffmpeg/`、`skills/`；比较完整包与小包的字节数，并确认两份 `.sig` 均非空。
3. 在隔离的 Windows 安装上依次执行 `0.1.7 → 完整过渡版 → 小型更新版`，至少覆盖 NSIS 与 MSI 来源各一次。用目标版本只修改少量资源的样本核对下载字节数、未变文件复用、断点重试、哈希错误拒绝与旧版本保留。检查画布/密钥保留，以及断网后的 Blender、Remotion、FFmpeg 与风格库图片可用；目标组件未准备完成时应拒绝小包安装。
4. 发布后读取两个新平台清单和旧共享清单，核对版本、唯一的版本化下载 URL、签名和 HTTP 可访问性；旧共享清单只在完整过渡版发布时更新。

## 2026-09-28 已发布版本的修复边界

`0.1.8` 完整过渡版和 `0.1.9` Windows 小包已发布。检查 `0.1.8` MSI 的文件表发现，风格库清单所要求的 `LICENSE` 是唯一缺失的文件：旧配置把它单独重映射到 `licenses/`，同时又映射整目录。旧版因此无法完成持久组件迁移，应用内更新会在下载 `0.1.9` 小包前失败；跳过等待也会被小包安装预检拒绝。

修复后的资源配置只映射风格库整目录。下一版必须先发布包含全部资源的完整 NSIS 安装包，重新生成资源基线，再考虑之后的小包。新基线同时记录资源映射；旧 `0.1.8` 基线不能继续用于制作小包。已安装且迁移失败的旧客户端运行的是不可变的旧代码，需一次手动安装修复后的完整包，保留应用数据；安装后启动应用并确认组件迁移完成。发布前应在隔离安装上验证 NSIS 与 MSI 来源的升级路径，并逐项核对新安装包中的风格库清单文件。

按文件下载是新客户端具备的更新能力，不能反向修复已经安装的旧代码。尤其 `0.1.8` 的资源迁移失败发生在旧更新逻辑内，仍需上述一次性完整包桥接。完成桥接后，后续四类资源的内容变化才可通过签名清单按文件更新；每版程序本身仍通过 Tauri 签名的小型 NSIS 更新。
