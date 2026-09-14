# 白模工作室与 Blender 桥接

视频节点的「白模工作室」可搭建彩色几何体与简易人形、设置路径关键帧和相机运动，再在本机渲染视频。完成后点击「使用白模视频」，即可继续配置专业级白模控制中的角色、道具和场景对应关系。

内置人形是用于走位、站位和构图的粗模，只随路径平移、转向。复杂骨骼动作、肢体表演和专业场景可以通过「在 Blender 中精修工程」完成：保存 `.blend` 后，选择「渲染 Blender 工程」回到应用渲染。导入模式沿用活动场景中的对象、动画和摄影机，按工作室指定的片长、帧率与画幅导出。

本桥接使用应用内固定 Python 脚本驱动 Blender。原文链接的即梦官方插件手册在本次读取时没有返回正文，尚未验证其可调用接口。本实现无需安装该插件，生成的白模视频通过已有视频参考输入参与后续生成。

## 引擎

正式安装包内置完整 **Blender 4.5.13 LTS**，用户无需下载或安装 Blender。构建过程预先准备引擎、Python、动态库、资源与许可证；应用运行时使用包内引擎。显式选择其他本地 Blender 是可选的专业配置，桥接支持 4.5 或更新版本，实际验证基线为 4.5.13。

构建资源布局如下，缓存和解包暂存目录不进入安装包：

```text
src-tauri/resources/blender/
  manifest.json
  files-manifest.json
  SOURCE.txt
  runtime/                 # 完整官方发行内容
  sources/
    blender-4.5.13.tar.xz
    white_model.py
    white_model.LICENSE.txt
```

Windows 可执行文件为 `runtime/blender.exe`，macOS 为 `runtime/Blender.app/Contents/MacOS/Blender`，Linux 为 `runtime/blender`。

## 构建时准备

`scripts/prepare-blender-runtime.mjs` 使用 [官方 4.5.13 发行目录](https://download.blender.org/release/Blender4.5/)和固定 SHA-256。它完整解包官方发行内容，实际执行 `--version`，再发布资源目录。Windows 使用原生 `tar.exe`，macOS 使用 `hdiutil` 和 `ditto` 保留完整 `.app` 及其链接，Linux 使用 `tar`。不读取用户 AppData 中的已安装 Blender。

```powershell
pnpm blender:prepare
# 可选：使用已有官方归档，仍必须通过相同大小与 SHA-256 校验。
$env:BLENDER_ARCHIVE_PATH = 'C:\build-cache\blender-4.5.13-windows-x64.zip'
pnpm blender:prepare
```

源码包默认也从官方地址下载；离线构建可用 `BLENDER_SOURCE_ARCHIVE_PATH` 指定对应源码包。缓存位于 `node_modules/.cache/infinite-canvas/blender/4.5.13`，每次复用都重新校验归档或完整资源库存；同名文件被替换、Python/DLL 缺失、清单损坏会触发重新准备。无法取得或验证资源会中断构建，不产生缺引擎的安装包。`--force` 可明确重新准备。

支持官方提供的 Windows x64 / arm64、macOS x64 / arm64、Linux x64。4.5.13 没有官方 Linux arm64 便携发行包，该目标会明确报错。目标平台或架构与构建机不符时也会报错，避免混入宿主平台引擎；macOS arm64 CI 在原生 runner 准备对应 DMG。

[官方校验文件](https://download.blender.org/release/Blender4.5/blender-4.5.13.sha256)中的 Windows x64 ZIP SHA-256 为：

```text
b5fdf800ce65fa2f209e8f68d02667e4d720fa1c42f247c72d1882ab04decba6
```

Windows x64 归档约 **380.2 MiB**，完整资源包实测约 **963.0 MiB**，其中已包含约 **81.2 MiB** 的对应 Blender 源码归档；最终安装包大小由平台压缩与其他应用资源共同决定。全文件库存存放在独立 `files-manifest.json`，主 `manifest.json` 只保存平台、版本、路径、来源和库存摘要，启动时无需读取大型库存。

Workbench 适合白模预演，保留物体颜色、空间遮挡和相机动画，输出不透明画面。它仍需可用的显卡驱动，后台运行不等于只使用 CPU。所选引擎的实际启动和渲染错误会返回任务状态。

## 许可证与源码

保留原始发行包的 `copyright.txt` 和整个 `license/`；macOS 对应内容位于 `.app/Contents/Resources/text/`。[Blender 官方许可说明](https://www.blender.org/about/license/)说明二进制发行整体采用 GPLv3 或更新版本，包中各第三方组件继续保留各自许可。

包内附带[对应 Blender 4.5.13 源码归档](https://download.blender.org/source/blender-4.5.13.tar.xz)。官方为源码发布 MD5，本脚本核对官方 MD5 后记录本地计算的 SHA-256，不将它冒称为官方 SHA-256。`SOURCE.txt` 记录原发行与源码地址、校验信息和依赖源码获取位置；源码归档内保留官方构建文件、依赖下载地址与校验值。发布时应一起保留这些源码和许可文件。

本目录的 `white_model.py` 桥接脚本采用 **GPL-3.0-or-later**，文本见本目录 `LICENSE`，脚本源文件及许可同时复制到安装包的 `sources/`。该声明仅适用于该 Blender 桥接脚本，不改变其他主程序文件的许可。

## 固定脚本协议

Rust 使用参数数组启动进程，不将用户输入拼接为命令或 Python：

```text
blender --background --factory-startup --disable-autoexec --python-exit-code 1
  --python <white_model.py绝对路径>
  -- --input <input.json绝对路径> --output <任务目录绝对路径>
```

`input.json` 为 `{sourceBlendPath: null | string, plan: WhiteModelScenePlan}`，类型定义见 `src/lib/whiteModelStudio.ts`。脚本重新验证版本、数值、坐标、形状、颜色和路径时间顺序。输入始终作为数据读取。新场景的模型原点位于底部；坐标使用 Blender Z 轴向上，朝向为绕 Z 轴的角度。

每个任务独立输出：

| 文件                       | 用途                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `scene.blend`              | 可编辑的工程副本，导入的原工程保持不变                       |
| `frames/frame_000001.png`… | 从 1 开始连续编号的 RGB PNG 帧                               |
| `preview.png`              | 第一帧预览                                                   |
| `progress.json`            | 原子更新的 `{progress, message}`                             |
| `result.json`              | `{frameCount, fps, width, height, projectPath, previewPath}` |

帧数采用 `floor(durationSeconds * fps + 0.5)`，与 Rust、TypeScript 四舍五入一致。新建场景从第 1 帧开始，路径时间映射为 `1 + time * fps`；导入工程从其活动场景的起始帧取样，PNG 编号仍从 1 开始。Rust 随后使用现有 FFmpeg 编码 H.264 / yuv420p MP4，并核验输出视频。

导入时禁用自动脚本，先将资源路径转成原来源的绝对路径，再尝试打包资源并保存副本。打包失败会明确终止，不覆盖原工程。常规视口坐标轴、运动路径和相机辅助框不会进入相机渲染；标记 `white_model_guide = True` 的对象及以 `WIRE` / `BOUNDS` 显示的辅助几何体会从输出中隐藏，动画依赖仍保留。

## 必要验证

2026-09-13 在 Windows / Blender 4.5.13 LTS 上完成了实际创建与导入往返：320×180、8fps、1 秒，含四种模型、移动路径与环绕相机。生成 8 个不同画面；回导工程的 8 帧像素与原渲染一致，原 `.blend` SHA-256 保持不变，输出是无 alpha 的 RGB PNG。首末帧已经目视检查。

Rust 中保留一项需要本地引擎的手动 smoke，覆盖渲染、视频编码和工程再导入：

```powershell
# 可选：指定从安装包提取出的 blender 目录；不设置时使用构建资源。
$env:INFINITE_CANVAS_BLENDER_BUNDLE = 'C:\package-check\blender'
cargo test --manifest-path src-tauri/Cargo.toml --locked blender_real_engine_renders_mp4_and_reimports_editable_project -- --ignored --nocapture
```

构建准备测试使用 `node --test scripts/prepare-blender-runtime.test.mjs`，覆盖平台映射、归档校验、缓存缺少/篡改依赖及路径边界。

2026-09-14 完成 Windows x64 NSIS 正式构建，安装包为 753,312,356 字节（约 718.4 MiB）。从该安装包提取并逐项验证全部 5,529 个 Blender 文件／链接，内容与构建资源完全一致，FFmpeg 摘要也一致。以提取根运行上述单项 Rust smoke（6.12 秒通过），创建与工程回导均使用 `executablePath: null`，路径断言确认选择包内引擎；MP4、预览、可编辑工程、原工程保护和持久任务恢复均通过。本次未运行安装后的 GUI 点选验收，macOS/Linux 仍需在对应平台实际验证。

本次工具环境曾出现 PowerShell 能读取 AppData 内的文件、原生进程却看不到对应运行库的 SideBySide 错误。构建准备改用原生解包与原生执行验证，避免依赖该工具环境的路径映射；未修改系统注册表或系统运行库。

接口依据为 [Blender 4.5 命令行文档](https://docs.blender.org/manual/en/4.5/advanced/command_line/arguments.html)、[Python API](https://docs.blender.org/api/4.5/)及 [Workbench 说明](https://docs.blender.org/manual/en/4.5/render/workbench/introduction.html)。
