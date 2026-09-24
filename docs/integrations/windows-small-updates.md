# Windows 小型更新与过渡发版

Tauri 2 在 Windows 上把完整 NSIS/MSI 安装器作为 updater 产物，因此本项目的 `0.1.7` 更新下载约 733 MiB。这里的小型更新仍是经过 Tauri 签名的 NSIS 安装器；它只包含新的程序，不重复携带稳定的 Blender、Remotion、FFmpeg 与风格库资源。首次安装始终提供包含全部资源的离线安装包。

## 兼容边界

- `0.1.7` 客户端固定读取 `infinite-canvas/updates/latest.json`，Windows 和 macOS 共用一个顶层版本。它不能区分先前使用 NSIS 还是 MSI 安装。**该旧地址只接收同一版本的完整 Windows 与 macOS 过渡安装包**；不能直接换成小型 Windows 包，也不能把旧 Mac 产物合并进新版本清单。
- 过渡版改用 `updates/{{target}}-{{arch}}/latest.json`。这样其后的 Windows 与 macOS 版本可以独立推进。发布旧地址之前，先初始化两个平台的新地址，避免客户升级后检查更新失败。
- 过渡版启动后，在后台把四类稳定资源复制到 `AppLocalData/runtime-components/` 的版本目录，逐文件校验后才标记完成。迁移期间依旧使用安装目录里的完整资源。组件未准备好时，应用内更新会等待并显示本地进度；失败时保留原安装并显示错误。
- 小包的 NSIS 安装程序在卸载任何旧版之前，先运行新程序的只读组件自检。自检只接受四类已持久化且与新构建清单匹配的资源，手动运行小包或静默安装也必须通过；失败时停止安装，改用完整离线包修复。
- 小型更新只能复用过渡版已验证的相同组件。`update:baseline` 记录完整过渡包的资源树；`tauri:bundle:slim` 会逐文件比较当前构建资源。任何资源变化都必须重新发完整过渡包，不能发一个缺少新资源的小包。
- 旧 NSIS 的 `/UPDATE` 安装会保留未列入新包的资源；从 MSI 来的客户可能先卸载原安装。持久组件目录覆盖这两条路径。小包安装失败时仍可运行完整离线安装包修复。

## 构建和发布顺序

1. 将 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 升到相同的新版本。备齐原 updater 签名私钥；不能更换已经发给客户的公钥。
2. Windows 上运行 `pnpm tauri:build`，保留同版签名 NSIS、MSI。对构建时准备的稳定资源运行 `pnpm update:baseline -- --out <bridge-baseline.json> --full-nsis <同版完整NSIS路径>`，把含完整包及签名哈希的基线与安装包一同归档。将同版提交推送到默认分支并确认 macOS CI 的 updater 私钥、Developer ID 与公证凭据后，手动触发 `macos-package.yml`；它只生成并暂存带版本号的签名包，不自动更改公开清单。
3. 分别用 `pnpm update:publish -- --channel windows-x86_64 --bundle-dir <windows-full-dir> --full-bundle-dir <windows-full-dir> --version <version>` 与 `--channel darwin-aarch64 --bundle-dir <mac-full-dir> --version <version>` 初始化新平台地址。发布脚本要求显式指定只含本版产物的目录，并将 `latest.json` 最后上传。
4. 汇集同版 Windows 与 macOS 签名包到一个独立暂存目录，使用 `pnpm update:publish -- --channel legacy --bundle-dir <mixed-full-dir> --version <version>` 最后切换旧共享地址。未齐备两个平台时不得切换。
5. **仅在过渡版的迁移与升级路径通过验证后**，下次常规 Windows 发版先构建完整离线安装包，再运行 `pnpm tauri:bundle:slim -- --baseline <bridge-baseline.json>`。检查暂存的完整包和小包大小、签名及生成的 NSIS 资源表，然后用 `--channel windows-x86_64 --bundle-dir <slim-dir> --full-bundle-dir <full-dir> --version <version>` 发布小包与独立完整安装包。

上述命令中的目录必须来自同一次构建。`TOS_ACCESS_KEY`、`TOS_SECRET_KEY` 只从环境变量读取；不要放进命令、文档或仓库。每次更新都升版本号，避免 CDN 的长期缓存复用旧安装包 URL。

## 最小验收

1. 运行更新脚本的定向测试、Rust 组件迁移的定向测试，以及 TypeScript 类型检查。
2. 对实际生成的 NSIS 脚本确认小包未含 `blender/`、`remotion-runtime/`、`ffmpeg/`、`skills/`；比较完整包与小包的字节数，并确认两份 `.sig` 均非空。
3. 在隔离的 Windows 安装上依次执行 `0.1.7 → 完整过渡版 → 小型更新版`，至少覆盖 NSIS 与 MSI 来源各一次。检查画布/密钥保留，以及断网后的 Blender、Remotion、FFmpeg 与风格库图片可用。迁移未完成时应拒绝小包安装。
4. 发布后读取两个新平台清单和旧共享清单，核对版本、唯一的版本化下载 URL、签名和 HTTP 可访问性；旧共享清单只在完整过渡版发布时更新。

当前 `0.1.7` 已发布，过渡版和小型更新版尚未发布。上述本机打包和定向测试不能替代第 3 步的客户升级验收。
