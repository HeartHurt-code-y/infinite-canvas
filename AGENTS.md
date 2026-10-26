# 画布节点交互约定

- 画布节点里的下拉（供应商、模型、参数枚举、任务类型、素材角色）一律用 `src/components/CanvasSelect.tsx`，不要再用原生 `<select>`：原生弹层由浏览器画在 React Flow 缩放层之外，WebView2/WKWebView 的非整数缩放下点击经常落空，用户要点好几次甚至切不动。`CanvasSelect` 的菜单挂在 body 上，点击必然落位。
- 节点设置面板（`VideoNodeSettingsControls`）的「点外部关闭」判断要放过 portal 出去的浮层（如 `.canvas-select__menu`），否则 capture 阶段先关面板，菜单随面板卸载，选项点不中。
- 提示词内容存在提示词模块（`promptContents`）里，**不进画布 store**，所以内容变化不会触发 store 订阅里的落盘。改字必须显式排期落盘（`scheduleCanvasSaveRef`）：节点卡里的编辑器靠 `input` 事件冒泡到画布视口触发排期，而独立编辑区（视口之外）的冒泡到不了视口，只靠那一条会丢掉独立编辑区里改的字。
- **提示词住在 `promptContents` 的节点类型，必须显式进 `collectCanvasDocument` 的快照 key 集合**（`promptContents.snapshotAll(keys)` 只快照给定 key）。漏掉时排期与落盘都"正常"，但存出来的画布文档里没有这段提示词，重新打开就丢了——智能剪辑节点（`videoClipNodes`）就是这么漏过一次，提示词节点（`gen` 的 `kind: "prompt"`）也漏过一次。复制粘贴走 `document.promptContents` 按 key 过滤（通用），所以只要存进文档，复制就自动带上。
- **快照 key 集合不再按节点类型登记，改成「画布里现存的节点 key」**（`WorkspaceApp.tsx` 的 `collectCanvasDocument` 用 `useAllCanvasNodeKeys()` 求交集）。此前靠「`gen` + `videoClip`」两份手工列表推导，而那份登记表与真正的注册点（`PromptMentionInput` 挂载处）**没有任何编译期关联** —— 已经因此丢过两次提示词，且症状最难察觉（排期与落盘都正常，只是重开丢了 @引用的素材身份绑定与粘贴附件，纯文本有 `config` 镜像所以不丢）。**新增任何注册 `PromptMentionInput` 的节点类型不需要再登记任何地方**，天然被覆盖。

# 提示词编辑器约定

- 提示词编辑器不再提供富格式工具栏：格式按钮与「插入媒体文件」选择器已整体移除，编辑器只保留纯文本输入与 @ 引用。富文本标记仍由内容模型承载（历史文档里的加粗/标题照常显示），Ctrl+B 等键盘快捷键仍可用。
- **canonical 文档里，标题、列表项、引用、代码块、分割线各自占一条独立条目**；普通段落才靠条目内的 `\n` 分隔。往 canonical 重建文档时**只有普通段落可以跨条目合并**（`appendStyledText`）：合并块级条目会把相邻列表项焊成一条（反向转换每条只生成一个 `listItem`，两个列表项于是塌成一个）、同级标题并成一段、有序列表编号少算一项。空文本只有分割线（`block: "hr"`）需要保留，其余空串直接丢弃。
- **`appendStyledText` 的两种合并语义必须分开**（`options.mergeWithinBlock`）：跨条目重建（存档解码、引用解析的扁平合并）时块级条目**不**合并；但**同一个块内部**的行内片段与软换行（`Shift+Enter`）必须并成**同一条**——块内片段与「相邻两个块」在样式上完全相同（同样 block、同样 marks），只能靠「这是该块专属的 sink」这个上下文区分。不区分就会把「列表项里按 Shift+Enter」拆成多条，反向转换时一个列表项裂成三个（其中一个只含一个换行）、有序列表编号错位，**存盘后结构永久损坏**。`promptTiptap` 的 `walkInline` 必须传 `mergeWithinBlock: true`。
- **`plainText` 是 `segments` 的界面镜像，两者必须一致**。发给供应商的文本走 `segments`（Rust `media.rs` 逐段 `push_str`，段间没有分隔符），只给其中一边补换行会让「用户看到的」与「模型收到的」不是同一份文本。
- 附件走粘贴与拖拽进入提示词（`onPaste` / `onDrop` → `ingestAttachmentFiles`）；没有文件选择器入口后，别再引入只依赖选择器的附件路径。

# 项目发布约定

- macOS 构建与更新发布不要求 Apple 公证；不要因缺少公证凭据暂停发布，也不要在每次发布时重复询问。
- 没有 Developer ID 证书时，沿用项目的 ad-hoc 签名方案。发布前仍须校验应用包签名、Tauri 更新签名、版本和实际产物。
- 发布说明须告知用户未经公证的包可能被 Gatekeeper 拦截，并提供 `scripts/install-macos.sh` 的首次安装指引。
- 只有用户明确改变要求时，才把 Apple 公证加入发布流程。
- **vendored 第三方源码必须随仓库提交**：`src-tauri/vendor/`（当前是打了补丁的 wry 0.55.1）被 `src-tauri/Cargo.toml` 的 `[patch.crates-io] wry = { path = "vendor/wry" }` 当作**构建期 path 依赖**引用。它不进版本库时，干净检出的机器上连 `cargo metadata` 都会直接失败（`error: failed to load source for dependency 'wry'`），CI 与本地打包全部红。该目录**不要**加进 `.gitignore`；补丁内容与理由见 `src-tauri/vendor/wry/VENDORED-PATCH.md`。

# 项目组件分发约定

- **「功能组件」按需下载机制已整体下线**：顶栏入口、`src/features/workspace/RuntimeComponentsPanel.*`、`src/lib/runtimeComponents.ts`、组件目录 JSON（`src-tauri/resources/component-catalog.json`）、下载/校验后端命令（`component_manager.rs` / `component_download.rs` / `component_archive.rs` / `runtime_components.rs`）、组件打包脚本（`package-runtime-components.mjs`）与 TOS 组件上传路径、CI 里的组件任务都不再保留。Windows slim 安装包（`tauri.slim.conf.json` 与对应 NSIS 模板）随之删除——它的存在前提就是「不打包 ffmpeg，改由运行时下载组件」。
- **FFmpeg 改为随安装包内置**：`src-tauri/resources/ffmpeg/` → 安装包 `ffmpeg/`，由 `pnpm ffmpeg:prepare` 在构建前准备。视频合成、抽帧、下载转码照常可用，运行顺序是「系统 ffmpeg → 内置资源 → 官方构建回退」。不要因为组件面板消失就动这条内置路径。
- **签名资源更新是另一个功能，必须保留**：`scripts/runtime-resource-baseline.mjs`、`scripts/runtime-resource-release.mjs`、`src-tauri/src/backend/resource_update.rs` 与前端 `src/lib/appUpdate.ts` 的资源补丁流程更新的是应用自带资源，与「功能组件」无关，不要连带删除。
- 已整体删除三个大型运行时组件及其功能：`blender`（白模渲染）、`remotion-runtime`（动画渲染与网页视频解析）、`pose-runtime`（动作捕捉）。对应的功能特性 `white-model-render`、`animation-render`、`browser-download`、`motion-capture` 一并移除，Rust 后端、前端、构建脚本与 CI 中都不再保留对应分支。
- 已整体删除另外三个组件：`gpt-image-2-style-library`（图片风格库，连同提示词节点的「GPT Image 2 风格库」模式 `gpt_image_2_style` 与技能包 `src-tauri/skills/gpt-image-2-style-library/`）、`ai-media-runtime` 与 `ai-media-quality-runtime`（AI 媒体深度估计与人声/背景音分离，含 `AiMediaPanel`）。对应特性 `image-style-library`、`ai-media-lite`、`ai-media-quality` 一并移除。
- 白模导演台（3D 视口、时间轴、检查器）、站位图导出与白模渲染任务随之删除，`whiteModelStudio` 节点配置字段不再读写；Rust 侧的 `save_white_model_still` 命令一并移除。
- 本地产物的 origin 枚举 `white_model` / `white_model_still` / `ai_media` 保留，让历史画布里的旧白模与 AI 媒体产物仍能正常渲染和作为本地文件连入生成；只删能力，不删旧数据标识。
- 「专业级白模控制」仍然保留：它只把画布上已有的视频／图片节点编译成 Seedance 2.5 的冻结提示词，不依赖任何本地渲染组件。相关代码在 `src/lib/whiteModelControl.ts` 与 `src/features/workspace/WhiteModelControlSection.tsx`，改动这两个文件时不要误删。
- 全景图（panorama）能力与白模无关，代码在 `src/lib/panorama.ts`，不要与白模代码一起删除。
- 删除组件时，同时删除因此失去唯一入口的功能（例如 `pose-runtime` 只有白模导演台一个入口，删掉 Blender 后动作捕捉即成空壳），不要在组件面板里留下装完却用不了的条目。
- 删除组件时同步清理 `package.json` 里因此失效的依赖：CI 有 `pnpm knip` 门禁（未使用依赖检测），删了组件却留着依赖会让 CI 直接红。删依赖后要跑 `pnpm install --lockfile-only` 更新 lockfile（CI 用 frozen lockfile 安装）。
- 删除前先查共享代码：白模场景模型曾同时供白模渲染与站位图使用，删渲染器不等于删整块模块；与被删组件无关的能力（如专业级白模控制、全景图）要保留并单独成模块。

# 工作流功能约定

- 「工作流仓库」及其 11 类自动工作流（知识视频、AI 影视、漫剧、电商、品牌视频、MV、Remotion、小红书封面、产品场景图、短视频反推、视频拉片）已整体移除，前端、Rust 存储、提示词模式与对应 skill 包都不再保留；不要在没有用户明确要求时重新引入这套机制。
- 画布仍保留通用能力：素材、生图／生视频、提示词（文本）、剧本创作、视频合成（智能剪辑）与创作台。数字模特库、品牌设计工作台等非工作流功能不受影响。
- **数字模特库与品牌设计工作台的 Rust 命令仍在线**（`list_brand_models` / `save_brand_model_version` / `approve_brand_model_version` / `validate_brand_model_version` / `archive_brand_model` / `read_brand_design_image` / `export_brand_design_bundle`，见 `src-tauri/src/lib.rs`），前端客户端 `src/lib/brandModels.ts` 与 `src/lib/brandDesignClient.ts` 也保留。它们的 UI 入口原本只挂在已下线的工作流面板上（`BrandVideoWorkflowSections` / `ProductSceneWorkflowSections`），工作流下线后**当前没有入口**——这是待补的独立功能入口，不是死代码：`knip.json` 的 `ignore` 里显式豁免了这两个文件，**不要当死代码删掉**，也不要因为「knip 报未使用」就顺手移除豁免。
- **`src/lib/bindings/**` 是 ts-rs 生成物**（由 `pnpm codegen` 产出），不是手写源码：Rust 侧类型删了但绑定文件仍在是正常的（下次 codegen 会清），反过来手删绑定文件也会被 codegen 重新生成。`knip.json` 已整目录豁免。
- **画布的节点类型清单与 liblib.tv 画布逐项对齐**（逆向规格 `docs/integrations/liblib-canvas-re.md` 第 3.3 节）：文本 / 图片 / 视频 / 智能剪辑 / 导演台 / 逐帧拉片 / 音频 / 剧本 / 参考节点。原站没有的节点类型（网络爆款视频下载 / 视频抽帧 / 爆款视频复刻）**已删除**，不要再加回来；原站有而本项目后端尚未提供的（导演台 / 逐帧拉片 / 音频 / 参考节点）保留条目与文案，点击给出「后端暂未接入」的明确说明，不静默失败。
- 历史数据不做兼容：旧画布里的工作流节点直接丢弃，Rust 侧 `workflow_history` 表不再读写。

# 已下线功能约定

以下四块功能已整体删除，前端、Rust 后端、构建脚本、CI 与 skill 包都不再保留对应分支；没有用户明确要求时不要重新引入：

- **故事板**：顶栏「故事板视图」面板与投影逻辑（`CanvasStoryboard.*`、`storyboardProjection.ts`、`useStoryboardTaskArchive.ts`）、提示词节点的「故事板」(`storyboard_prompt`) 与「多宫格分镜」(`multi_grid_storyboard`) 两个技能模式、画布节点「剧本转工业级分镜脚本」(`storyboard` 节点类型与 `storyboard` 提示词模式)、以及 `src-tauri/skills/storyboard-prompt/`、`src-tauri/skills/multi-grid-storyboard-prompter/`、`src-tauri/skills/storyboard/` 三个技能包。**剧本创作与优化**（`screenplay` 节点与 `src-tauri/skills/screenplay/`）是另一个功能，保留。
- **创作助手**：画布右侧助手面板（`src/features/workspace/agent/` 整目录）、`canvas_agent` 提示词模式、`src-tauri/skills/canvas-agent/` 技能包与 `docs/integrations/canvas-agent.md`。
- **反馈与诊断**：反馈弹窗（`src/features/feedback/`）、后台自动错误上报、诊断资料收集与上传（`src/lib/errorReporting.ts`、`src/lib/diagnosticAttachments.ts`、`src/lib/collectFeedbackDiagnostics.ts`）、报错条里的「反馈问题」按钮。**「复制报错」必须保留**——AGENTS.md 的报错约定依赖它。
- **功能组件下载**：见「项目组件分发约定」。

# 测试约定

- **本项目不再保留任何测试资产，也不再执行测试**：没有 Vitest 用例、没有 `*.test.ts(x)` / `*.test.mjs`、没有 Rust `#[cfg(test)]` 模块、没有 `src-tauri/tests/` 目录。删测试时一并清掉测试依赖（`vitest`、`@testing-library/*`、`@vitest/browser-playwright`、`playwright`、`jsdom`、jest 相关插件等）、`vitest.config.ts`、eslint 的测试插件与 CI 里的测试步骤。
- **不要为了「跑通门禁」新增测试**：`pnpm check` / `pnpm knip` / `cargo clippy` 等既有门禁照常维护，但只做**功能实现**与**编译验证**，不要写测试来证明功能。
- **默认不跑任何测试与质量套件**（用户 2026-10-24 明确「以后不跑任何测试和质量套件」「以后都不用跑ESLint和tsc」）：不跑 vitest、`npx tsc --noEmit`、`pnpm lint` / eslint、`pnpm knip`、`cargo clippy`、`prettier --check`。前端改动的正确性靠逐处自查与真机行为验证；Rust 侧保留 `cargo check` 作为编译验证（它不是质量套件，是编译器本身）。交付说明里如实写「本轮没跑门禁，验证方式是……」，门禁留给用户自己安排。
- **别指望门禁兜底**：上面这条免掉的不只是时间，还有发现手段。async 函数被当 void 回调传、`useMemo` 依赖数组漏项、React 回调不稳定导致 effect 反复重跑这类问题，只能靠读代码时逐处核对；写回调、传 props、列依赖、传回调给 hook 这四类地方要主动多看一眼。
- **`pnpm codegen` 保留**：`cargo test --lib export_bindings` 跑的是 ts-rs 宏在编译期生成的绑定导出用例，不是手写测试；`src/lib/bindings/*.ts` 仍由它生成，改 Rust 类型后照常跑。

# 生成请求约定

- 生成接口的能力、素材数量/格式/大小/时长、参数范围、枚举、账户权限及参数组合由服务端兜底；不要在 React 前端或 Tauri 本地后端按缓存目录、旧文档或本地白名单拦截用户请求。
- 客户端负责按当前 API 文档完整编码用户参数与素材；文档新增字段时补齐上传和映射，不能以“未定义/不支持”为由拦截，也不能静默丢弃输入。界面枚举仅提供选项与默认值，保留用户显式参数。
- 保留本地文件读取、素材/任务身份、凭据冻结和请求编码完整性保障；服务端拒绝时呈现其真实错误。付费提交回执不明确时核对原任务，不删字段重发或自动重复扣费。

# 入口与生成页约定

- 同一个前端产物只有两个入口，由 `src/features/create/createEntry.ts` 统一判定：`studio`（默认，画布工作台）与 `create`（创作台）。判定通道：URL `?view=` > hash > Tauri 窗口标签。新增入口时在这一个文件里加，不要在 `App.tsx` 里散落判断。
- 创作台在 `src/features/create/`：侧栏 / 顶栏 / 记录流 / 底部浮坞 / 资产库抽屉五件套。视觉规格全部来自对即梦创作页的实测，数值落在 `tokens.css` 的 `--color-create-*` / `--size-create-*` / `--create-text-*` 令牌组里；改样式时只改令牌，不写字面值。
- **资产库不是外部服务**：它接本项目自己的素材库（本机 Base64 + 已接入供应商的云端），实现在 `src/features/create/useCreateAssets.ts`。不要为了「看起来更像」去接别人的资产接口。
- 参考素材必须带**素材身份**而不是 URL：`CreateReference` 有 `local_file` / `asset` / `local_base64_asset` 三种形状，映射到后端三种合法 target（`src/features/create/useCreateSession.ts`）。`mediaType` 取素材真实类型，role 由媒体类型分派（`reference_image` / `reference_video` / `reference_audio`，与后端 `media.rs` 的归一表一致）。把 video 素材按 image 送，后端会按图片通道读视频字节——失败或静默忽略。
- 资产库抽屉是**页面网格里的第三列**，不是 `position: fixed` 浮层。做成浮层会把底部浮坞的提交钮压在抽屉底下，用户表现为「面板开着就发不了」。
- **顶栏挂在整页上，不在内容列里**（即梦实测 `top-actions-host` 是整页级绝对定位）：抽屉开合时主区会变窄，但顶栏不跟着移。放在内容列里的话，抽屉一开顶栏就左移 94px，看着像被挤走了。顶栏移到 `.create-surface` 顶层，抽屉打开时右缘让开抽屉宽度即可。
- 逆向结论与逐项实测数值见 `docs/integrations/jimeng-generate-page-re.md`（页面外壳）与 `docs/integrations/jimeng-model-switching-re.md`（模型与参数）。

# Agent 模式约定

即梦的 `?type=agentic` 是**同一个创作页的另一套浮坞**，不是第三个入口。创作台仍是两个入口之一（`studio` / `create`），进入方式是 `?view=create&type=agentic`。

- **URL 只承载 `agentic`**：`?type=` 存在即 Agent 浮坞，离开时删掉这个参数。其余四种生成类型（图片/视频/文本/音频）仍走服务端偏好 `creationMode`，不让 URL 和服务端偏好抢同一个状态。
- **两套创作类型互不干扰**：`standardMode` 是标准浮坞的模式（落服务端偏好），`creationMode` 是 Agent 浮坞那份 7 项清单的当前项（即梦的 option value：`agentic / image / video / music / audio / digitalHuman / actionCopy`）。即梦两个浮坞的下拉本来就是两份清单，不要合成一份。
- **七项创作类型全部要列出来**：音乐生成 / 数字人 / 动作模仿本项目后端没有对应能力，但前端照做，并在下拉里标「后端暂未接入」——不许藏起来，也不许让用户点了才发现报错。
- **Agent 模式允许空提示词**（实测校验项 `allowEmpty`）：选了技能或主体就算有效输入。提示词上限 20000 字（实测 `get_agent_config.promptMaxLength`）。
- **三块浮层各有各的形态**：技能下拉是「搜索 + 官方角标 + 一行简介 + 更多技能」；「自动」展开的是**生成偏好面板**（自动开关 / 图片视频 / 比例 / 模型），不是模型下拉；「@」是主体选择器（空态要有「创建主体」出口）。别拿普通 `CreateSelect` 套这三块。
- **普通浮坞与 Agent 浮坞是两套控件序列**：普通浮坞（`?type=image`）实测是 `创作类型 → 模型 → 比例+分辨率 → 生成数量 → 文字效果增强 → @主体 → 生成`；比例与分辨率**合并**成一个按钮（中间用 3×3 圆点 `.divider-OobeV4` 分隔），但**生成数量独立成按钮**（「2张」，浮层 320×97 / 圆角 16 / 8 个 34×36 数字磁贴 / 无标题）。「技能」「语音」是 Agent 浮坞独有，普通浮坞没有。参数与数量按钮都是**前置图标 + 文字、没有下拉箭头**。
- **参考上传砖是斜的**：48×64、逆时针 8°（实测 matrix `0.990268, -0.139173`）、虚线描边、悬停 `translateY(-8px) scale(1.125)`。
- **字体用即梦的栈**：`--font-jimeng`（正文：`"CapCut Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial`）与 `--font-jimeng-montserrat`（工具条按钮与下拉数字：Montserrat 打头）。**不要用 `--font-body` / `--font-display`**——那是画布工作台的字体，用了会一眼看出不是原站。
- **图标用即梦原生路径**：`src/features/create/jimengIcons.ts`（从原站活体 DOM 抽的原文 path）+ `JimengIcon.tsx` 渲染。**不要再用 `src/components/Icon.tsx` 的 Phosphor**——那是通用图标库，形状与原站不同。覆盖侧栏、顶栏、浮坞、工具条、创作类型 7 枚、**记录卡 hover 层（下载/查看更多/收藏 + 播放条 3 枚 + 底部 9 枚编辑工具）与两处菜单的图标**。即梦的「查看更多」是**横向**三点，别再用竖排的 `dots-three-vertical`。
- **记录卡的 hover 层与菜单按即梦实测来**（2026-10-22 活体，见 `docs/integrations/jimeng-generate-page-re.md` 第七节）：
  - 工具组是**每格一份**（hover 哪格就在哪格上），两组共用一块面板底（`rgba(24,25,29,.9)` + 0.5px 描边 + 圆角 8 + 内边距 2 + 间隙 2），按钮 28×28、图标 16×16。
  - 右上工具组 3 枚：下载 / 查看更多 / 收藏。**图片格与视频格的底组条目不通用**：图片 7 枚（用作参考图/智能超清/超清/智能改图/局部重绘/扩图/查看更多），视频 9 枚（局部重拍/用作参考视频/智能超清/视频延长/视频编辑/补帧/对口型/全能配音/擦除字幕）。
  - **一共有三处「更多」菜单，别混**：操作行末位 = 记录菜单（删除/反馈生成问题）；格子右上 ⋯ = 产物菜单（图片：复制/用作参考图/创建主体/──/发布/删除/举报；视频少「复制」）；图片格右下末位 ⋯ = 工具菜单（生成视频/去画布编辑/消除笔/多角度(New)/细节修复/对口型）。
  - 资产库素材卡的更多菜单是**七项**（下载/收藏/用作参考视频/创建主体/发布/删除/举报），即梦用**右键**触发，本项目照做并另加一枚 hover 显形的「⋯」。
  - 视频格左下**没有**时长角标（那是资产页那一套），时长显示在播放条里，格式是两位分钟 `00:05`。
  - 视频格**hover 即自动播放、移开暂停并复位到 0**（即梦实测 `paused` 由 true 变 false）；先试有声，被浏览器策略拒绝再退回静音。
  - 时间分隔符是 **0.5px × 10px 竖线 rotate(15deg)**（渲染出来是斜杠），别画成纯竖线。
  - **长提示词的抬头是 hover 展开的浮层**：默认只显示 2 行（48px），悬停展开成最多 10 行（240px）的可滚动面板，底色 `#262626`、圆角 8px、投影 `0 4px 12px #0000000f, 0 2px 6px #00000005`、`z-index: 10`；右下角绝对定位一枚「⧉ 使用提示词」文字按钮（`right:4px; bottom:4px`，文字 `#ffffff99`、14px/24px，图标 16×16），点它把提示词填进浮坞输入框。
  - **浮坞的蓝色 ✦ 与消耗位**：即梦给「新模型 / 新能力」在参数摘要末尾挂一枚 12×12 蓝色 ✦（`#2b6cf6`），标记由能力目录的 `ModelParameterOption.aiMark` 驱动（只对语义明确是 AI 能力的选项打标，如「智能比例」）；提交键左边是消耗位（16×16 蓝色四角星 + 12px/12px Montserrat 500 的文字、`rgba(255,255,255,.6)`），即梦那是它 SaaS 的积分单价，本项目没有成本预估接口，保留位置与外观、内容如实写「待接入」，不编造假单价。
  - **点开产物进的是「产物详情整页视图」**（`CreateDetailView.tsx`），不是弹个遮罩：左边大图 + 底部 `‹ n / N ›` 翻页 + 左上返回箭头；右侧栏 **440 宽**、`padding: 8px 40px 20px`：顶部行（下载 / ☆ / ⋯）、缩略图条（86×86、间隙 4）、`图片提示词`（14px/22、`#ffffff99`）、参数标签行、**两块工具卡片**（底色 `rgba(255,255,255,.08)`、圆角 12px、内边距 4px；卡内 168×36 两列网格、间隙 4px，按钮圆角 8px、内边距 `0 14px`、图标 16px、文字 13px/24，末行占满两列）、底部卡片「重新编辑 / 再次生成」。
  - **视频产物走的是另一套详情布局**：标题「视频提示词」；没有缩略图条；翻页是大图区**右侧竖排**两枚箭头；「详细信息 ⓘ」另起一行；工具卡 1 = 用作参考视频 | 去画布编辑 ›，卡 2 = 8 枚视频工具（局部重拍/智能超清✦/视频延长/视频编辑/补帧✦/对口型/全能配音/擦除字幕✦New）；播放器是自绘控件条（播放/暂停 + `00:00 / 00:00` + 静音 + 全屏 + 2px 进度线，贴住**视频**底边）。`✦` 是即梦给 AI 能力打的蓝色标记（`toolAiMark`）。
- **搜索点别处就收回**（即梦实测）：展开后点页面其它地方，容器立刻从 254 宽回到 28 宽。用 `pointerdown` 外部判定，不要用 `blur`（点放大镜时会先收起再展开，闪一下）。
- **下拉浮层按作者值写**：即梦机器 DPR=1.5，实测到的 `0.67px` 描边其实是 `1px` 被设备像素对齐后的回读值。照抄实测数字会在别的 DPR 上错一档。
- **后端暂未接入的能力**（Agent 对话流 `/mweb/v1/creation_agent/v2/conversation`、技能市场、主体体系、语音输入）走 `TODO(agent-*)` 标注 + 前端占位：结构定死、交互做全、点击给出明确说明，不静默失败。载荷契约见 `createAgentModel.ts` 的 `AgentSubmissionPayload`。
- 逆向结论与逐项实测数值见 `docs/integrations/jimeng-agentic-page-re.md`。

# 浮层锚定约定

- **浮层必须贴在触发器上**：面板**底边**贴触发器**顶边**，留 8px 缝（实测即梦 7.7px）。这是即梦 `lv-trigger-position-bl` 的语义，所有浮层（下拉、参数面板、生成偏好、技能、主体）一律照做。
- **浮层左边缘比触发器左边缘左移 16px**，不是对齐。源码级证据：即梦 `js/async/420.ce00760bd1.js` 模块 `342266` 的 `popupAlign: { top: [-16, 8], bottom: [-16, 8] }`（常量 `ED = -16`）；四处浮层（创作类型下拉 / 技能下拉 / 主体选择器 / 生成偏好面板）活体实测也全部是 −16、缝隙 7.67px。创作台用 `useCreateFloatingLayerAnchor`（默认 `leftOffset = -16`）；**朝下弹**的浮层（如顶栏筛选）不左移，给 `leftOffset: 0` + `gap: 12`。
- **定位必须用浮层的「实测高度」，不能用高度上限**。CSS 的 `top` 锚定的是**顶边**，拿 `max-height` 当高度算，面板会多上浮「上限 − 实际高度」px，与触发器之间裂开一条黑缝——参数面板上限 420、实际 120 时会飘到触发器上方 300px，孤零零挂在视口中间。正确做法是用 `ResizeObserver` 量浮层自己的高度，量到后再定位。
- 统一走 `src/components/floatingLayer.ts`（坐标计算，`leftOffset` / `gap` 可配）+ `src/features/create/useFloatingLayerAnchor.ts`（测量与贴靠，五个浮层共用）。**不要各写一份**——旧版本就是五处各写各的，其中一处把上限当高度，浮层直接飘了。
- 浮层一律 portal 到 `document.body` + `position: fixed`：创作台的参数工具条是 `overflow-x: auto` 的横向滚动容器，浮层留在工具条 DOM 里会被祖先裁掉，用户看到的是「点了没反应」。
- 顶栏搜索按即梦的逻辑做：**input 常驻**（收起时宽 4px 被容器裁掉，只露放大镜），靠容器 `data-open` 切状态，**不是**「按钮 ↔ 输入框」整体替换。展开的触发是**点放大镜**（hover 不展开）。展开时整组向左生长，组右端与组内右侧按钮位置都不变。
- 网格里的卡片若要显示长文本：`<button>` 的 UA 样式表带 `align-items: flex-start`，交叉轴不 stretch，文本宽度会退化成 max-content 画到邻列上。必须显式写 `align-items: stretch`，网格轨道写 `minmax(0, 1fr)`（不是 `1fr`），文本本身补 `min-width: 0` 才能让省略号生效。

# 报错提示约定

- 用户看到的报错必须用人话：一律用 `src/components/ErrorAlert.tsx`（红色高亮 + 图标 + 文字）渲染，显示 `backendErrorMessage(error)` 的摘要；原始 payload / 堆栈只放进「展开完整报错」。
- 不要再用 `<p role="alert">{error}</p>` 或 `formatRawBackendError(error)` 直接给用户看：那会把 `{"details":null,"kind":"validation",…}` 这种 JSON 印在界面上，读屏软件还会整段朗读。
- `formatRawBackendError` 只用于日志与调试输出，不是用户文案。
- 报错不能只靠颜色区分（WCAG 1.4.1）：必须同时有图标和文字；触发错误的控件用 `aria-describedby` 指向错误元素（WCAG 3.3.1）。
- 报错要能回答「接下来怎么办」：`ErrorAlert` 的 `hint` 写补救动作；只说「这张图不合格」不说换什么图，用户只能靠猜。
- 任何报错都必须支持一键复制：`ErrorAlert` 自带「复制报错」按钮（复制摘要 + 完整原始 payload）；手写报错条旁边放 `src/components/ErrorCopyButton.tsx`，错误 toast 一律从 `src/lib/toast.ts` 导入 `toast`（`error` 自动带「复制报错」动作）。复制的内容必须是完整诊断文本，不要只复制界面上被截断的摘要。
- 报错不再自动上报：反馈与诊断子系统已下线（见「已下线功能约定」）。需要留下现场时只写本地日志（`frontendLog`）与剪贴板，不要新增任何静默上传路径。

# 画布外壳对齐约定（liblib.tv）

- 画布工作台的**视觉层与前端逻辑层**以 `docs/integrations/liblib-canvas-re.md` 为真值源：那份文档里的每个数值都来自 liblib.tv 画布页的**活体实测计算样式**（登录态、DPR=1.5），不是观感推测。改动画布外壳前先读它。
- 画布外壳用**独立的一组令牌**（`--canvas-*` / `--panel-background` / `--nt-*` / `--topnav-btn-border` / `--radius-ll-float` / `--shadow-ll-float` …），**不要**混进全局 `--color-surface-*` 阶梯：原站画布底色是 `#141414`（比本项目原来的纯黑亮）、节点卡 `#191e26`（带蓝相），混用会让画布层次塌掉。
- 左下控件组是**一条连续胶囊**，组内**只有原站那六项**：资产管理 / 整理画布 / 切换小地图 / 隐藏节点连线 / 网格吸附 / 缩放。组内按钮 28px 高、8px 圆角、4px 间隙，各自**没有**边框与投影（表面由外层组提供）；hover 底 `--canvas-controls-hover`，按下 `--canvas-controls-active`。别把它做成一排各自带面板底的小盒子，也**不要**再加回原站没有的按钮组。
- 底部浮坞居中，**只有原站那八格**：`⊕ 创建节点` / 移动·框选 / 功能组件 / 表情 / 时钟 / 键盘 / ? / 品牌胶囊。功能组件与表情在原站是应用入口，本项目对应能力已下线，**保留位置并标注「后端暂未接入」**，不留点了没反应的空按钮。
- **画布外壳的图标用 Lucide，不用 Phosphor**：原站用 Iconify，除品牌图标（`iconify--libtv`）外都是 `iconify--lucide`，与 Lucide 是同一套矢量。全站其它地方仍用 Phosphor，只有画布外壳走 `src/features/workspace/CanvasChromeIcons.tsx`。原站自有的品牌图标无法逐字复刻，用语义最近的 Lucide 代替。
- 画布外壳的实测尺寸（别凭观感估）：底坞 padding 8 / gap 8 / 按钮 32×32 / **图标 20px** / 圆角 12 / 底色 `#262626`；左下控件组 gap 4 / 内边距 6 / 按钮 28×28 / **图标 14px** / 文字 13px。
- **原站没有的视觉/样式/前端逻辑，一律不做**：要加一个入口前先查本文档的 UI 面清单；原站没有的按钮组（例如节点操作组、归位、撤销重做、素材库浮坞格）不要留在画布外壳上，它们的能力走**键盘快捷键**与**右键菜单**。
- 顶栏按钮按原站是 32×32、8px 圆角、**0.5px** 描边（原站声明 `border-[0.5px]`，DPR=1.5 下回读成 0.667px——按 0.5px 写，见「浮层锚定约定」同类结论），底色 `color-mix(in srgb, var(--panel-background) 80%, transparent)`。
- 顶栏的画布切换按原站是「画布 N ⌄」chip + 下拉（`CanvasTabs` 的 `canvas-tabs__switcher`）：重命名与删除收在菜单里，标签上不再挂行内按钮。
- 浮层圆角是 **12px**（`--radius-ll-float`），投影是三层（`--shadow-ll-float`），描边 `--canvas-controls-border`。不要用全局的 16px `--radius-panel`。
- 原站的**资产管理**是左侧全高抽屉 + 右侧 12px 可拖动调宽把手（`workspace-panel-drawer-resize-handle`），内容是「画布列表 → 资产」两级树。抽屉必须 portal 到 `document.body`：画布视口带 transform，会劫持 `position: fixed`。
- 节点卡、连线与手柄按原站实测值写死在 `CanvasNodeCard.css` / `CanvasNodeCardIcons.tsx`：连线 2px `#86909c`（悬停 `#c0c8d0`、选中 `#e0e4e8`，所有连线同色）、手柄本体 0×0 + 80px 命中区 + 20px 旋钮（默认隐藏，悬停/选中才出现）、媒体区 12px 圆角 + hairline 描边 + 底色 `#171717`（选中描边 `#a8a8a8`）、节点根**没有**边框圆角内边距。节点卡的图标走 `CanvasNodeCardIcons.tsx`（Lucide 直导）。
- **原站没有的节点卡与连线元素一律删除**：连线上的顺序徽标、删除按钮、卡片上的删除/改名按钮都不存在——连线删除走「点中连线后按 `Delete`」，节点删除走「选中后按 `Delete`」，画布改名走「点标题就地编辑」。
- 新手引导按原站是**首次进入画布**时弹的一次性 4 步浮层（`CanvasOnboardingGuide`），文案抄原站 i18n（`onboardingStep1~4Title/Desc` + `guideDefaultSkipLabel/PreviousLabel/NextLabel/DoneLabel`）；看过一次记进 `localStorage`（`canvas-onboarding-seen-v1`），不要再改文案或改成常驻入口。浮坞的「教程」格可以再次打开它。
- **空画布状态**按原站是「一行提示 + 一排创建入口」，不是说明卡片：指针图标 + 「双击画布 自由生成节点」，下面一行五个入口（图片生成 / 视频生成 / 音频生成 / 剧本生成 / 智能剪辑，每个约 208×44），点一下直接建对应节点（`EMPTY_CANVAS_SHORTCUTS`）。
- 底部浮坞居中，**只有原站那八格 + 一枚品牌球**：`⊕ 添加节点` / `移动` / `功能组件` / `表情` / `全部功能` / `生成历史` / `快捷键` / `教程`，右侧是 **48×48** 的品牌球（深色圆底 + hairline 描边，内嵌渐变球，**在浮坞容器外面**）；「快捷键」与「教程」之间有一根 **1×24** 的竖分隔线。功能组件、表情、全部功能本项目没有对应能力，**保留位置与图标并标注「后端暂未接入」**。原站浮坞中间几格随项目内容变化（有素材库/角色造型室能力的项目会替换「功能组件/表情」），本项目按默认工作区那一组实现，顺序与图标是活体 DOM 实测的，别凭印象改。
- 左下控件组是**一条半透明胶囊**：背景 `rgb(26 26 26 / 70%)`、圆角 12、内边距 6、间隙 4，**没有描边也没有投影**（所以它几乎融进画布）；组内六项（资产管理 / 整理画布 / 切换小地图 / 隐藏节点连线 / 网格吸附 / 缩放档位）各自透明、28px 高、图标 14px，整理画布是**图标按钮**（不是文字），缩放档位只有百分比没有下拉箭头。
- 分组（组框）按原站是**半透明彩色大框 + 左上角同色小标签**，框上没有工具条：框 = 该色 14% 填充 + 45° 斜纹（1px 线 / 7px 间距）+ 同色边框；标签 = 同色实底、白字 11px、圆角 4、高 20px，压在框的上边线上，同时是整组的拖动手柄。组动作（复制整组 / 折叠 / 添加到素材库 / 解散）走**右键菜单**，改名是**双击标签就地编辑**。配色登记在 `tokens.css` 的 `--canvas-group-ink-1..6`（按组 id 稳定取色）。
- 原站的技术栈是 Tailwind v4 + Mantine 7 + Ant Design + React Flow 混合体。**我们不引入这些依赖**，只对齐它们的结果：类名等价物写进我们的 CSS，数值写进 `tokens.css`。
- 逆向产物在 `.tmp/rea-liblib/`（gitignored）：`i18n.json` 8655 条文案、`tailwind-classes.json` 1898 个类、`design-tokens.json` 1124 个令牌、`measurements.json` 实测计算样式、`survey/` 交互截图。改画布外壳前可以先查这些原始证据。

# 画布编辑层对齐约定（liblib.tv）

- 生成节点的编辑层（`MediaNodeViews.tsx` 的 `CanvasGenNode` + `CanvasGenEditor.css`）结构按原站 liblib 的**实测**结构定死，顺序不能改：
  **工具 chips 行（参考 / 标记 / 角色库 / 运镜）→ 已连接素材缩略图瓦片 → 提示词正文 → 底栏**。
  原站没有可见的「提示词」标题行，那段文字只作读屏标签（`aria-labelledby` / `aria-describedby`），不要改回可见标题。
- 原站的编辑层**宽 658.67px**（本项目写 660），面板根是 `flex flex-col gap-2 p-2`（间隙 8、内边距 8）；不要为了「看起来更宽」擅自拉宽——原站那 1145px 是被 chips 与缩略图撑出来的。
- 底栏只有四段：**模型按钮 · 全能参考按钮 · 1px 分隔线（#525252，高 14）· 参数汇总按钮**；右侧是 32×32 白底、圆角 12 的提交键（**不带文字标签**）。原站没有「更多设置」这个底栏按钮——本项目的更多设置收在参数浮层底部的「高级设置」折叠区（hairline 上边框 + 12px 粗体标题）。
- 参考素材是 **48×48 方形瓦片**（1px hairline #525252、圆角 8、object-cover 裁切），左上角 14×14 序号角标、右下角 12×12 的 **@ 圆钮**（把这份参考插进提示词）、hover 时右上角出现 15×15 解除连线按钮；原站用拖拽排序、没有上移/下移按钮，所以编辑层里那两个按钮是隐藏的，键盘排序由瓦片自身（可聚焦，↑/↓）承担。瓦片上**不放**素材名、不放来源角标——原站没有，来源信息收进瓦片 title。
- 提示词正文：14px、行高 1.8、最小高 80px、滚动区上限 100px、右内边距 6px；面板圆角 12。**提示词区里不放任何按钮**（原站没有）：@ 在参考瓦片上，识别素材名仍留在提示词节点里。
- 设置浮层（模型 / 参数）宽 **365px**，**底边贴触发器顶边上方 8px**，挂在**编辑层 DOM 内**（编辑层是定位祖先，按相对坐标贴靠，画布平移缩放不用重新测量）。浮层内容不是编辑层 DOM 的后代会让既有断言查不到它，别改成挂到 `document.body`。

# 智能剪辑（video clip）约定

- 「智能剪辑」是**独立节点类型** `video_clip`（原站 liblib 的 `video-clip`）。它取代了本项目原有的本地「视频拼接与合成」节点（`video_composer`，已整体下线）。逆向规格见 `docs/integrations/liblib-video-clip-re.md`，数值全部来自 2026-10-23 的活体实测。
- 节点卡两态照抄原站：**空态 350×350**（40px 剪刀 + 「空空如也，请连接视频节点后操作」+「尝试：」四个预设：讲解视频 / 批量广告 / 口播视频 / 素材混剪）；**连接态 566×350**（252px 封面 + 82px 时间刻度 + 「打开智能剪辑」）。提示文案与预设顺序一字不改。
- 合成编辑层（`VideoClipEditor.tsx`）结构照抄原站，顺序不能改：
  **「＋参考」chip + 素材瓦片（48×48，左上角序号、左下角时长）→ 提示词正文（占位「描述想剪成什么效果」）→ 底栏（剪辑模式按钮 · 参数汇总按钮 · 32×32 提交键）**。
  原站智能剪辑的编辑层**没有模型按钮、没有「更多设置」**，工具行**只有「＋参考」**（生成节点那四枚 chips 不照搬过来）。
- 剪辑模式目录在 `videoClipModes.ts`：五个模式（默认模式 / 讲解视频 / 批量广告 / 口播视频 / 素材混剪），每个模式声明自己的**素材槽位**（节点类型 / 必填 / 最少 / 最多）、预置提示词与技能标识。槽位归属按模式声明顺序分槽，一份素材只进一个槽位。
- 槽位校验文案用原站原文：`还需添加{label}（至少 {min} 个）` / `{label}最多 {max} 个` / `请填写提示词`；label 取 视频 / 音频 / 文字 / 产品图 / 参考视频 / 生成视频。
- 参数是**模式表之外**的一份全局配置：比例 21:9 / 16:9 / 9:16 / 1:1 / 4:3 / 3:4、时长 0~300 秒、清晰度 480P / 720P / 1080P，默认 16:9 · 720P · 30s，摘要文案 `16:9 · 720P · 30s`。
- 两个浮层（剪辑模式 229.3×170.1、参数 341.3×310）与生成节点的设置浮层**做法不同**：原站这两个是 Mantine Popover，挂在 `document.body` 上、与触发器左边缘齐平（不左移），底边分别距触发器顶边 4px / 0px。本项目用 `placeFloatingLayer` + `ResizeObserver` 实测高度贴靠，**高度必须用实测值**，不能拿上限当高度。
- 提示词**不进画布 store**：住在提示词模块（`promptContents`）里，与生成节点一致。保存画布时它的 key 必须进 `collectCanvasDocument` 的快照集合，否则重开画布提示词会丢。
- 原站的预置素材是它自家 CDN 的资源地址，本项目**不拉外链**：预设只落「模式 + 提示词」，素材由用户自己连进来。**这些外链 URL 也不要留在源码里**——既误导（本项目不引入外链素材），又留着将来误接的风险；预设表里只保留提示词文案。
- 成片名带序号（`智能剪辑成片 {index}`，与节点名「智能剪辑 N」呼应）：产物名同时用于输出节点显示名与任务历史，固定文案会让多个智能剪辑的成片同名，画布上无法分辨。产物名只作本地命名元数据，**不参与结果文件命名**，所以不会互相覆盖。
- 后端契约在 `src-tauri/src/backend/video_clip.rs`（命令 `start_video_clip`）：校验模式 / 槽位 / 参数，把「用户提示词 + 文字槽位正文 + `，参数是 {params}`」组装成既有 `StartGenerationCommand`，走同一套生成任务管线。模型不暴露给用户，提交时取工作区默认的**视频模型**。
- 「打开智能剪辑」指向原站的视频剪辑时间轴编辑器（字幕轨 / 文本轨 / 转场 / PR·剪映工程导出），本项目后端**尚未接入**：点击给出明确说明，不静默失败。
- 原站的预置素材是它自家 CDN 的资源地址，本项目**不拉外链**：预设只落「模式 + 提示词」，素材由用户自己连进来。
- 「智能剪辑」在画布创建菜单里指向 `video_clip`。旧的 `video_composer`（本地「视频拼接与合成」）节点类型**已整体下线**：模型、store 类型面、视图、样式、客户端、合成任务后端（`start_video_composition` 等命令）与 WebView MediaRecorder 实时合成模块全部删除；旧画布里的这类节点按已下线类型的先例**直接丢弃，不做兼容读取**。原站画布节点清单里没有「视频拼接与合成」这一项。
- **新增画布节点类型时，`WorkspaceApp.tsx` 的 `CANVAS_NODE_TYPE_KEYS` 必须同步加进去**。这个清单决定「画布成员 key 集合」，选中集、@ 引用候选、节点查找都从它派生；漏登记的症状是节点能建出来、能渲染，但**永远选不中**（点它没反应、编辑层不打开）。目前登记：`asset / gen / screenplay / videoClip / result / output`。

# 画布快捷键约定

- **快捷键面板（`CanvasShortcutsDialog`）列出的每一条都必须真的绑上**。面板文案照抄原站 i18n，但原站有、本项目没有对应能力的条目（画布连线、复制整组、搜索节点、整理画布、抓手/移动工具、导演台整组）必须标 `available: false`，渲染成置灰 + 「待接入」角标。**不能让用户照着面板按却毫无反应**——那比不列出来更糟。
- 缩放键位是 `mod+=` / `mod+-` / `mod+0`（原站注册表口径），`0` 走 `fitView`（适应画布），不是"重置到 50%"。不要绑裸键 `+` / `=` / `-` / `0`——那会让随手敲一个等号就缩放。
- **`react-hotkeys-hook@5.3.3` 默认按 `event.code`（物理键位）匹配**，除非显式传 `useKey: true` 改用 `event.key`（字符值）。`"="` 的 code 是 `Equal`、`"-"` 的是 `Minus`——按 code 匹配时 `mod+=` / `mod+-` **永远匹配不上，缩放快捷键会完全失效且毫无报错**。凡是用字符键（`=`、`-`、`.`、`,` 等非字母数字键）的热键，都必须带 `useKey: true`。
- 成组 `mod+g`、解组 `mod+shift+g`、撤销 `mod+z`、重做 `mod+shift+z`、复制 `mod+c`、粘贴 `mod+v`、复制节点 `mod+d`、删除 `Delete`/`Backspace`、退出 `Esc` 已实装。新增快捷键时同步更新面板的 `keys` 与 `available`。
