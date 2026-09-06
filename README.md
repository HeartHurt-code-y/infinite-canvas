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

后端的供应商配置、生成任务、持久化、结果保存、素材接口与 TOS 预签名服务契约见 [后端实现与接入说明](docs/backend-implementation.md)。

## 常用命令

| 命令               | 用途                                    |
| ------------------ | --------------------------------------- |
| `pnpm dev`         | 仅启动 Vite 前端                        |
| `pnpm tauri:dev`   | 启动完整桌面应用（自动预置动画与 FFmpeg 引擎） |
| `pnpm build`       | 类型检查并构建前端                      |
| `pnpm tauri:build` | 构建桌面安装包（内置 FFmpeg，离线可用） |
| `pnpm test`        | 运行前端测试                            |
| `pnpm lint`        | 执行类型感知 ESLint 检查                |
| `pnpm format`      | 使用 Prettier 格式化工程文件            |
| `pnpm check`       | 执行前端、Rust 格式化及 Clippy 全量检查 |
| `pnpm ffmpeg:prepare` | 下载并预置内置 FFmpeg 引擎到 `src-tauri/resources/ffmpeg/` |
| `pnpm remotion:prepare` | 准备内置动画渲染运行时               |

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
