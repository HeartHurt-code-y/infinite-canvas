# macOS 应用包差分更新

macOS arm64 平台频道的 `latest.json` 始终把标准 `platforms.darwin-aarch64.url` 和 `signature` 指向完整、已签名的 `.app.tar.gz`。支持差分的客户端另外读取 `macDeltaManifest`。旧客户端忽略这个附加字段，仍能通过 Tauri updater 下载完整包；共用旧版频道也只发布完整包，不携带差分信息。

已安装的 `.app` 不保留原始 tar/gzip 元数据，因此不能可靠重建上一版 `.app.tar.gz` 供二进制补丁使用。差分按应用包**文件树**计算：签名清单列出目标 `.app` 内所有目录、符号链接以及普通文件的路径、权限、大小和 SHA-256。与上一版同路径且内容、权限都相同的文件标为 `base`；变化文件标为 `object`，按 SHA-256 作为对象名上传。客户端仅在当前版本等于清单的 `baseVersion` 时尝试差分；先验签清单，再验证本机可复用文件与下载对象，重建并验证整个目标文件树后交给原生 macOS updater 安装。差分下载或准备失败时，客户端自动改走 Tauri 完整包；进入原生安装步骤后则由 Tauri 安装器处理，不能承诺任意安装失败都有原子回滚。跳过一个或多个版本时也使用完整包。虽然网络只下载变化文件，本机仍要重建整包，更新时需数 GB 可用临时空间。

`macDeltaManifest` 的 URL 固定为 `updates/mac-delta/<version>/darwin-aarch64/manifest.json`，其 `.sig` 同目录；变化文件保存在跨版本去重的 `updates/mac-delta/objects/<sha256>`。清单用与 Tauri updater 完整包相同的私钥签名。发布器严格校验签名、平台/版本、固定 HTTPS 对象前缀、路径、对象哈希与大小。完整 updater 包验签后，发布器只读流式扫描其中的每个目录、文件和符号链接，逐项比对差分清单的目标树；两份各自有效却内容不同的包不能混装发布。这个检查不解包到磁盘，文件内容按块计算 SHA-256。先上传并核验不可变对象与清单，再上传完整 DMG、完整 updater 包，**最后**切换平台 `latest.json`。已发布同版但内容不同的清单不得覆盖。

如果变化对象加清单与签名的传输字节数不小于完整 `.app.tar.gz`，发布器明确记录原因，本版仅发布完整包，不添加差分字段。

Codemagic 在当前版构建完成后，从公开的 Mac 平台频道读取上一版；如需重跑已发布版本，可设置 `MAC_DELTA_BASE_VERSION` 指明较早的基线。流水线下载上一版完整 updater 包及 `.sig`，验签并核对旧版 `.app/Contents/Info.plist` 版本，再从已验签的本版完整包解出目标 `.app`。两棵树生成清单及变化对象，签名和验证后才调用 `pnpm update:publish`。已安装 0.1.10 的客户端尚无差分代码，因此首次含差分代码的新版本仍通过完整包过渡；之后的相邻版本才会实际走差分。

发布前只运行更新路径的 Node 测试、版本及 source commit 检查、macOS `.app` 代码签名校验、DMG 校验、完整 updater 与差分清单验签。发布后核对公开平台清单、签名、对象可读性和下载大小；客户机升级仍需单独验证。当前流水线不以 Apple 公证为发布前提；无 Developer ID 时用 ad-hoc 签名。离线安装时，双击挂载 DMG、把「无限画布.app」拖入「应用程序」，再运行随 app 内置的命令 `sudo bash "/Applications/无限画布.app/Contents/Resources/unlock-installed-macos-app.sh"`。该脚本只对已安装 app 验签并清除隔离属性，不重新签名，因而保留差分更新所需的本地文件哈希。
