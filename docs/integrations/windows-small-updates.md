# Windows 发版与轻量联网版

> **小型更新（slim/瘦包）机制已整体下线。** Windows 小型更新依赖「不把 FFmpeg 打进安装包、改由运行时下载组件」，
> 而「功能组件」按需下载机制已随故事板／创作助手／反馈与诊断一并移除，Windows slim 安装包
> （`tauri.slim.conf.json` 与对应 NSIS 模板、`pnpm tauri:bundle:slim`）不再存在。
> 现在所有 Windows 安装包都内置 FFmpeg 引擎，`pnpm update:baseline` 的资源基线与按文件资源更新
> 流程不再用于制作小包。本文件只保留仍然生效的发版约定。

## Windows 轻量联网版发布

轻量联网版使用独立的 `windows-x86_64-online/latest.json`，采用完整轻量 NSIS 更新。媒体处理所需的 FFmpeg
随安装包内置，不再有需要单独分发的组件 ZIP；该频道不使用旧组件的 `resourceManifest`，不会改写既有
Windows、macOS 或已退役共享频道。

运行 `pnpm tauri:build:online --bundles nsis --ci` 生成本版产物，然后先运行 `pnpm update:publish:online --distribution-dir .cache/tauri-editions/online/artifacts/<版本> --dry-run`。构建前后必须具有相同的源码指纹，`build-source.json` 绑定实际程序 SHA-256 与全部编译输入；发布时再次核对当前源码、程序版本、更新签名与安装器文件表。修改源码后必须重建，不能发布旧产物。

正式发布使用同一命令并去掉 `--dry-run`。上传先创建安装包及其签名，所有对象以匿名完整 GET 校验大小和 SHA-256，随后复核本地产物与源码，最后以条件写入切换在线清单。版本化对象禁止覆盖；同版本内容冲突和降级均停止。已有清单会先备份并验证，清单并发变化会阻止发布。若清单写入结果无法确认，必须先读取线上清单确认实际状态，不能直接宣称成功或回滚。

上传凭据优先读取环境变量 `TOS_ACCESS_KEY`、`TOS_SECRET_KEY`；Windows 未提供时，只读取应用已经配置的同一可信 TOS 来源及其凭据引用，密钥仅保留在进程内。上传续传记录存于 `.cache/online-publish/uploads/`，不能放入安装产物目录。发布前的定向回归用 `pnpm update:publish:online --distribution-dir .cache/tauri-editions/online/artifacts/<版本> --dry-run`（它会校验源码指纹、签名与逐字节传输）；本项目已不再保留自动化测试套件，该回归由这条 dry-run 命令与人工核对承担。首次从旧完整版转入轻量版需要手动安装轻量版安装器；后续更新由独立在线频道提供。

## 签名与版本

上述命令中的目录必须来自同一次构建。`TOS_ACCESS_KEY`、`TOS_SECRET_KEY` 只从环境变量读取；不要放进命令、文档或仓库。每次更新都升版本号，避免 CDN 的长期缓存复用旧安装包 URL。

发布后读取两个平台清单，核对版本、唯一的版本化下载 URL、签名和 HTTP 可访问性。记录旧客户端需要手动过渡的影响。
