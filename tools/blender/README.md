# 白模工作室与 Blender 桥接

视频节点的「白模工作室」可搭建彩色几何体与简易人形、设置路径关键帧和相机运动，再在本机渲染视频。完成后点击「使用白模视频」，即可继续配置专业级白模控制中的角色、道具和场景对应关系。

内置人形是用于走位、站位和构图的粗模，只随路径平移、转向。复杂骨骼动作、肢体表演和专业场景可以通过「在 Blender 中精修工程」完成：保存 `.blend` 后，选择「渲染 Blender 工程」回到应用渲染。导入模式沿用活动场景中的对象、动画和摄影机，按工作室指定的片长、帧率与画幅导出。

本桥接使用应用内固定 Python 脚本驱动 Blender。原文链接的即梦官方插件手册在本次读取时没有返回正文，尚未验证其可调用接口。本实现无需安装该插件，生成的白模视频通过已有视频参考输入参与后续生成。

## 引擎

需要 Blender **4.5 或更新版本**，实际验证版本为 **4.5.13 LTS**。应用支持自动检测或选择已有 Blender 可执行文件。Windows 便携版检测位置为：

```text
%LOCALAPPDATA%\InfiniteCanvas\tools\blender-4.5.13\blender-4.5.13-windows-x64\blender.exe
```

[官方 4.5 LTS 下载页](https://www.blender.org/download/lts/4-5/)提供 Windows ZIP；[4.5.13 官方校验文件](https://download.blender.org/release/Blender4.5/blender-4.5.13.sha256)中，Windows x64 ZIP 的 SHA-256 为：

```text
b5fdf800ce65fa2f209e8f68d02667e4d720fa1c42f247c72d1882ab04decba6
```

Workbench 适合白模预演，保留物体颜色、空间遮挡和相机动画，输出不透明画面。它仍需可用的显卡驱动，后台运行不等于只使用 CPU。所选引擎的实际启动和渲染错误会返回任务状态。

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
cargo test --manifest-path src-tauri/Cargo.toml --locked blender_real_engine_renders_mp4_and_reimports_editable_project -- --ignored --nocapture
```

可先单独执行 `blender.exe --version` 检查原生进程是否能读取安装目录。本次工具环境中，PowerShell 曾能读取 AppData 内解压的文件，而原生进程看不到对应运行库，导致 SideBySide 错误；使用原生 Python 从已校验 ZIP 解压到同一便携目录后恢复。该问题通过文件落盘方式解决，未修改系统注册表或系统运行库。

接口依据为 [Blender 4.5 命令行文档](https://docs.blender.org/manual/en/4.5/advanced/command_line/arguments.html)、[Python API](https://docs.blender.org/api/4.5/)及 [Workbench 说明](https://docs.blender.org/manual/en/4.5/render/workbench/introduction.html)。
