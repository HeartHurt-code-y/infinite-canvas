# liblib.tv 画布「文本节点 + 悬浮生成器面板」逆向规格

> 目标：把原站 `https://www.liblib.tv/canvas` 的**文本节点空态「尝试：」卡片**与
> **节点下方的悬浮生成器面板**（提示词输入 / 模型选择 / 翻译 / 消耗位 / 提交）
> 逆向出来，并在本项目「无限画布」里落地成可用功能。
>
> 逆向方法：REA 静态恢复（Wakaru 1.14.0）+ 登录态活体实测（DOM / 计算样式 / 交互）。
> 每条结论标注证据来源与置信度。

- 采样页面：`https://www.liblib.tv/canvas?spaceId=13107991&projectId=db8d363bb7a7400f9b336a5555e06660`
- 采样时间：2026-10-27（北京时间）
- 本轮用户指定画布：`spaceId=13169671`、`projectId=2754fff0b5254fdda8f1c29ecfe51a74`。本轮内置浏览器打开该地址超时，未能确认该画布的登录态；下文的浏览器实测来自上面的历史采样画布，不能当作本轮对用户指定画布的实时观察。
- 证据产物：`.tmp/rea-textnode-20261027/`
  - `live/`：当前线上 137 个 `_next/static/chunks/*.js`（2026-10-27 现取的当前构建）
  - `recovered-textnode/`：REA 恢复的文本节点所在分包（`19e5aippy_pto.js`，1.67 MB → 3.92 MB 可读源码）
  - `recovered-composer/`：REA 恢复的提示词编辑器分包（`3nqo0ojjasef8.js`，130 KB → 346 KB 可读源码）
  - 证据 ID：
    - `ev_9783eea40b711a3ffc51108f71be9b738c1d051dc88e72a57ac363c0b15f3e7c`（文本节点分包恢复）
    - `ev_9bc7ea7f9b6ad0a30849d03f673d05a3068325dd3d35a7f86f3e4d63383ce5da`（提示词编辑器分包恢复）
    - `ev_ef2db51ada5200d332a723831472d5f30209d08203160126a4b70353f4fa0a88`（本轮对已保存的编辑器分包重新运行 REA；输入 SHA-256 `8b01115c6ae24d9cd3d7da0ea5e462060155adb804a0226c07d009b7e362d267`；1 个模块成功、0 个失败；恢复结果不保证与原始源码或运行时等价）
- 原站技术栈（实测）：Next.js 16 App Router + Turbopack + Tailwind v4 + Mantine 7 + React Flow + Iconify(`iconify--libtv`)

---

## 1. 文本节点

### 1.1 节点卡实测（登录态，选中前后一致）

| 项 | 实测值 |
| --- | --- |
| 卡片尺寸 | 350 × 350 |
| 卡片底色 | `#262626`（`--panel-background`） |
| 卡片圆角 | 12px |
| 卡片描边 | 0.667px（声明 0.5px，DPR=1.5 回读）`#525252`（`--border-default`） |
| 卡片背景模糊 | `backdrop-filter: blur(1.5px)` |
| 标题条 | 节点**上方**：`iconify--libtv` 14×14 图标 + 13px 文字 `#919191`（可就地改名） |

### 1.2 节点状态机（源码级，置信度：源码级）

恢复后的文本节点组件用 `eM` 表达节点状态，取值与渲染分支一一对应：

| 状态 | 判定 | 渲染 |
| --- | --- | --- |
| `generating` | `taskInfo.loading === true` | 任务进度组件 `Lk1Component` |
| `failed` | 任务失败 | 失败态 `td.U` |
| `resource` | 有正文内容，或 `action === TEXT_RESOURCE` | 内联 Markdown 编辑器 `t4.f`（滚动视口 `ru.S`） |
| `pending` | 既无内容又处于待定 | 居中占位图标 |
| `empty_generate` | 以上都不是 | **「尝试：」卡片**（本文档重点） |

> 源码：`eM = ev ? "generating" : eb ? "failed" : ey || eN ? "resource" : d ? "pending" : "empty_generate"`

---

## 2. 「尝试：」卡片（`TcComponent`）

> 证据：REA 恢复源码 + 登录态计算样式实测。

### 2.1 结构与类名（源码级）

```
div.flex.h-full.flex-col.items-center.justify-center.px-6        ← 整卡（实测 padding 0 24px）
├ div.mb-4                                                       ← 只读态无 mb-4
│   └ svg 90×90 .text-fg-disabled                                 ← 大图标（实测 90×90，色 #525252）
├ div.text-fg-muted.mb-2.text-sm                                  ← 「尝试：」（实测 #919191 / 14px / lh 20px）
└ div.flex.flex-col.items-start.gap-1                             ← 动作列表（行距 4px）
   └ button.group/btn.text-fg-default.hover:bg-canvas-controls-hover
          .flex.w-fit.items-center.gap-2.rounded-lg.px-3.py-2.text-left.text-sm.transition-colors
      ├ svg 14×14
      ├ span  ← 文案
      └ span.text-fg-muted.ml-auto.text-xs.opacity-0.transition-opacity.group-hover\/btn:opacity-100  ← hint（悬停显现）
```

按钮实测：字号 14px、字色 `#f7f7f7`、内边距 `8px 12px`、圆角 8px、行高 36px、图标 14×14。

### 2.2 文案与图标（i18n `canvas:` 命名空间）

| i18n key | 文案 | 遥测 `functionKey` |
| --- | --- | --- |
| `tryLabel` | 尝试： | — |
| `textActionWriteContent` | 自己编写内容 | `writeText` |
| `textActionTextToVideo` | 文生视频 | `textToVideo` |
| `textActionImageToPrompt` | 图片反推提示词 | `imageToPrompt` |
| `textActionTextToMusic` | 文字生音乐 | `textToMusic` |

图标（`iconify--libtv`）：自己编写内容 = 文本行图标；文生视频 = `VideoAddS`；图片反推提示词 = `ImageS`；文字生音乐 = `music`。

### 2.3 受限体验策略

`restrictedExperiencePolicy.active` 为真时，`TEXT / IMAGE / VIDEO / AUDIO` 四类节点的
「尝试」区块整体不渲染（源码 `td = new Set([TEXT, IMAGE, VIDEO, AUDIO])`）。

### 2.4 遥测

点任一动作会上报 `libtv.canvas.node.hint.click`，变量为
`node_uuid` / `node_type` / `function_key`（模块 `327189` 的 `S` 导出）。
`function_key` 取值白名单：`writeText / textToVideo / imageToPrompt / textToMusic /
longVideo / firstLastFrameToVideo / firstFrameToVideo / imageToImage / imageUpscale /
audioToVideo / scriptToStoryboard / characterToStoryboard / writeStoryboard /
videoToStoryboard / default / explainerVideo / batchAd / talkingHeadVideo / smartMixCut`。

---

## 3. 四个动作的源码行为

> 证据：REA 恢复源码（`recovered-textnode/modules/bundle.js`）。

设文本节点 id 为 `id`，其坐标为 `t.position`；`V.m` = 节点宽度、`V.U` = 节点间距。

### 3.1 `writeText` — 自己编写内容

```js
h(id, { content: [], action: TEXT_RESOURCE });
```

节点从 `empty_generate` 切到 `resource`，内联 Markdown 编辑器出现（可编辑正文）。
本项目对应：提示词节点的编辑器本来就是常驻编辑器，此动作改为**聚焦编辑器**。

### 3.2 `textToVideo` — 文生视频

```js
h(id, { content: [B.k(B.R.textToVideo.prompts)], action: TEXT_GENERATE });
// 在右侧 V.m + V.U 处创建 VIDEO 节点
f({ id, type: VIDEO, data: { type: VIDEO, name: t("canvas:video"), url: [], poster: "",
     action: VIDEO_GENERATE, params: { prompt: B.R.textToVideo.videoPrompt } },
   position: { x: t.position.x + V.m + V.U, y: t.position.y } });
// 连线：文本节点 → 视频节点
g({ id, source: id, sourceHandle: "source", target: videoId, targetHandle: "target" });
```

`B.k` = 随机取一个（`t[Math.floor(Math.random()*t.length)]`）。

### 3.3 `imageToPrompt` — 图片反推提示词

```js
// 在左侧 V.m + V.U 处创建 IMAGE 节点（作为参考图）
f({ id, type: IMAGE, data: { type: IMAGE, name: ..., url: [B.R.imageToPrompt.imageUrl],
     alt: t("canvas:promptReverseImageAlt"), action: IMAGE_RESOURCE },
   position: { x: t.position.x - V.m - V.U, y: t.position.y } });
// 连线方向相反：图片节点 → 文本节点（文本节点消费这张图）
g({ id, source: imageId, sourceHandle: "source", target: id, targetHandle: "target" });
// 文本节点改写为「看图写提示词」的任务
h(id, { content: [], params: { ...params, prompt: B.R.imageToPrompt.prompt }, action: TEXT_GENERATE });
```

注意方向：**图片节点在左、文本节点在右**，边是「图片 → 文本」。

### 3.4 `textToMusic` — 文字生音乐

```js
h(id, { content: [B.R.textToMusic.prompt], action: TEXT_GENERATE });
// 右侧创建 AUDIO 节点
f({ id, type: AUDIO, data: { type: AUDIO, name: t("canvas:audioFile"), url: [],
     action: AUDIO_GENERATE, params: { scene: "Music" } },
   position: { x: t.position.x + V.m + V.U, y: t.position.y } });
g({ id, source: id, sourceHandle: "source", target: audioId, targetHandle: "target" });
```

### 3.5 预置提示词原文（源码级常量，模块 `R` 导出）

```js
textToVideo: {
  prompts: [
    "爆款情绪短片\n傍晚的城市天台，一个年轻人迎着晚风张开双手，镜头从远景缓慢推进到中景，头发被风吹起，夕阳逆光，光晕明显，空气中有漂浮微尘，电影级色彩分级，浅景深，情绪张力强，慢动作",
    "电影级人物镜头\n雨夜街头，霓虹灯反射在湿漉漉的地面，女主撑伞站在路灯下，表情克制而坚定，镜头环绕人物360度缓慢移动，浅景深，光影对比强烈，电影级调色，真实皮肤质感",
    "高级广告镜头\n黑色背景中一款高端腕表悬浮出现，镜头从极近距离微距开始，缓慢拉远，金属表面光泽细腻，细节清晰，柔光灯打亮轮廓，商业广告级质感，干净构图，慢速旋转展示"
  ],
  videoPrompt: "根据文字描述生成视频。"
},
imageToPrompt: {
  prompt: "根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。",
  imageUrl: "https://libtv-res.liblib.art/upload-images/8cee65f5355e48c09bd7b07487dc9e20/80e55bef8f60b9cade198a0d98f66694ef3874a1.png"
},
textToMusic: {
  prompt: "生成一首现代品牌电子音乐（约 110 BPM），干净有力的低频贝斯，清晰电子鼓点，整体风格高级、未来感强。开场节奏型贝斯与简洁合成器音色建立律动。主段加入稳定鼓点，节奏清晰，保持克制的张力。强化段加入更丰富的音层，合成器音色提升，律动增强但不过度拥挤。结尾鼓点减弱，仅保留低频与氛围音渐出，干净利落收尾。"
}
```

> `imageToPrompt.imageUrl` 是原站 CDN 上的示例图；本项目不引外链素材，改为选择用户的本地图片并在左侧建立素材节点。

---

## 4. 悬浮生成器面板

### 4.1 触发条件

**选中文本节点即出现**（实测：点一下节点卡，面板立刻从节点下方展开）。
节点未选中时不渲染（DOM 里连面板容器都没有，不是隐藏）。

### 4.2 锚点（源码级 + 实测）

```
div.node-floating-ui.nodrag.nowheel.nopan.origin-top
    .transition-opacity.duration-150.ease-out.motion-reduce:transition-none
    .absolute.-bottom-4.left-1/2.z-20.-translate-x-1\/2.translate-y-full
    .w-full.min-w-[660px].max-w-[660px]
```

即：**贴节点下沿外扩 16px**（`-bottom-4` + `translate-y-full`），水平居中于节点，固定宽 660px。

### 4.3 面板本体（实测）

| 项 | 实测值 |
| --- | --- |
| 尺寸 | 660 × 149 |
| 底色 | `#262626`（`--panel-background`） |
| 圆角 | 16px（`rounded-2xl`） |
| 描边 | 0.667px `#363636`（`--border-muted`） |
| 投影 | `rgba(0,0,0,.12) 0 4px 10px` |
| 内边距 | 8px（`p-2`） |
| 层叠 | `z-20`（在节点之上、模态之下） |

### 4.4 内部结构（源码级类名 + 实测）

```
div.bg-panel-background.relative.flex.w-full.flex-col.gap-0.overflow-hidden.rounded-2xl
    .shadow-[0px_4px_10px_0px_rgba(0,0,0,0.12)].border-hair.border-border-muted
├ div.flex.min-h-0.w-full.flex-col
│  └ div.flex.min-h-0.flex-col.p-2
│     ├ div.flex.items-center.gap-2.pl-1.pt-1                 ← 工具行（本节点类型下为空）
│     ├ div.relative.flex.gap-1  [data-practice-anchor=gen.prompt] [data-canvas-onboarding-target=prompt]
│     │  └ div.relative.flex-1.overflow-hidden.rounded-xl.p-2.min-h-20  [data-quick-guide-anchor=generator-prompt]
│     │     ├ p.absolute.left-2.right-2.top-2.text-sm.leading-[1.8]        ← 占位文案
│     │     └ div.generator-prompt-scroll-region.relative.z-10.-mr-2.min-h-20.max-h-[100px]
│     │        └ Mantine ScrollArea → div[contenteditable=true].min-h-20   ← 正文输入
│     └ div.flex.w-full.items-center.gap-1                    ← 底栏
│        ├ button[data-practice-anchor=gen.model][data-quick-guide-anchor=generator-model-select]
│        │    .flex.items-center.justify-between.h-8.w-auto.gap-1.rounded-lg.px-2.py-1
│        │    ├ img.light-invert-icon.object-contain.size-4                 ← 模型图标 16×16
│        │    ├ span.text-fg-default.truncate.text-[13px]                  ← 模型名（实测「GVLM 3.1」）
│        │    └ svg.size-3.5.shrink-0.transition-transform                 ← 下拉箭头 14px
│        ├ div.flex-1                                                 ← 弹性空隙
│        └ div.flex.shrink-0.items-center.gap-2
│           ├ button[data-practice-generator-lock].size-8.rounded-lg      ← 翻译（文A 图标）
│           ├ div.text-fg-muted.flex.h-8.items-center.gap-2
│           │  └ span.flex.items-center.gap-[2px]
│           │     ├ svg.h-[14px].w-[10px]                                ← 闪电积分图标
│           │     └ span.min-w-5.text-center.text-[12px]                  ← 消耗数字（实测 6）
│           └ button[data-quick-guide-anchor=generator-submit]
│                .bg-btn-invert-bg.size-8.rounded-xl                       ← 提交（白底圆角 12）
│                └ svg.size-3                                             ← 上箭头
└ button.bg-panel-background.absolute.right-2.top-2.z-10.size-7.rounded-lg ← 右上角展开（对角箭头 14px）
```

实测尺寸：模型按钮 111×32；翻译按钮 32×32；提交按钮 32×32；展开按钮 28×28。
提交按钮在提示词为空时 `disabled`（`disabled:opacity-50`）。

### 4.5 占位文案（i18n `common:` 命名空间）

```
promptPlaceholderText  = 写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。
promptPlaceholderVideo = 描述你想要生成的画面内容
promptPlaceholderAudio= 描述音乐风格、情绪或使用场景。例如：轻快的夏日旅行音乐，原声吉他旋律。
promptPlaceholderScript= 描述剧情或添加角色参考、视频参考等，为你生成分镜脚本
```

原站的占位映射函数（源码 `er`）把 `image` 也指向 `promptPlaceholderVideo`——这是原站自己的
取值笔误（图片提示词区给的是视频文案），本项目不照搬这一处。

### 4.6 翻译按钮

- i18n：`translatePromptTitle` = 翻译提示词；`promptEmptyForTranslate` = 提示词为空，请输入内容后点击。
- 交互：点一下把当前提示词**翻译成英文**并回填；提示词为空时给出上面的提示文案。

### 4.7 消耗位（闪电 + 数字）

原站的 `6` 是哩布TV SaaS 积分余额计费（后端 `POST /api/task/generation/power/calculator`
按模型 + 参数算价）。本项目按供应商 API 实际计费，**没有积分概念**，因此该位不伪造数字。

---

## 5. 原站后端 API 契约（前端可观测）

> 证据：当前线上分包里出现的路径常量（`3ztmk959_33mx.js` / `11d0zy5lfbip0.js` / `246-wom6eljcr.js`）。
> 置信度：源码级（路径常量）+ 前端调用点。

| 路径 | 用途 |
| --- | --- |
| `POST /api/task/generation/create` | 提交生成任务（文本 / 图片 / 视频 / 音频统一入口） |
| `GET  /api/task/generation/detail` | 任务详情 |
| `GET  /api/task/generation/progress` | 任务进度轮询 |
| `POST /api/task/generation/power/calculator` | 计算本次消耗（积分） |
| `POST /api/task/prompt-optimization` | 提示词生成 / 优化 |
| `POST /api/canva/translate` | 提示词翻译 |
| `GET  /api/task/free-quota/remaining` | 免费额度余量 |
| `GET  /api/www/model/...`（`modelDetail` / `apiPower` / `search` …） | 模型目录与计价 |
| `GET  /api/canvas/node/payload/{get,save}` | 节点正文（提示词）存取 |
| `GET/POST /api/canvas/project/...` | 画布工程与节点持久化 |

原站服务端源码不可得；以上是**接口契约级**逆向，不是服务端实现。

---

## 6. 本项目的落地口径

### 6.1 对照表

| 原站 | 本项目 | 说明 |
| --- | --- | --- |
| 文本节点（`TEXT`） | 提示词节点（`gen` + `kind: "prompt"`） | 本项目早于本次逆向就有「文本」快捷入口，落在提示词节点上 |
| 空态「尝试：」卡片 | 提示词节点的「尝试：」卡片 | 四个动作逐项对应第 3 节 |
| 卡片只出现在节点本体 | **画布预览卡片 + 独立编辑区两处** | 画布卡片主体 350×350，使用原站实测的 90px 图标；独立编辑区复用动作列表 |
| `writeText` | 画布卡片：打开独立编辑区并把光标放进正文；编辑区：直接聚焦正文编辑器 | 本项目正文编辑器常驻，无需切换状态 |
| `textToVideo` | 随机一段爆款故事写进**文本节点正文** → 右侧建**视频节点** → 连线（文本 → 视频） | 视频节点本项目已实现。**不往视频节点另写指令句**：正文由连线自动同步（`synchronizePromptSources`），另写会被同步覆盖 |
| `imageToPrompt` | 选择本地图片 → 保存到本地素材库 → 左侧创建素材节点并连线（图片 → 文本）→ 写入看图指令 | 需要支持图片理解的文本模型；选择期间节点被编辑或删除时保留素材，不覆盖节点内容 |
| `textToMusic` | 音乐提示词写进**文本节点正文** → 提示音频节点未接入 | 用户明确要求本阶段只做前端占位，不接音乐后端；不发音乐生成请求 |
| 悬浮生成器面板 | 提示词节点下方的**悬浮生成器面板** | 只挂在**画布预览卡片**下方（经 `CanvasContentNode.floatingPanel`）：独立编辑区是固定尺寸面板，660px 宽的面板塞不进去 |
| 面板提示词框 | 直接读写节点的「创意 / 需求」（`config.sourcePrompt`） | 面板不是独立状态，与节点内的输入框永远一致 |
| 面板模型下拉 | 直接读写节点的模型绑定（`config.modelSelection`） | 同上 |
| 面板提交 | 现有文本任务生命周期 + 通用文本系统指令 | 保留模型凭据冻结、历史和图片引用，不套用视频提示词技能；结果先写入 canonical 文档再与节点镜像同批保存，独立编辑区的技能模式保持原有行为 |
| 模型下拉（GVLM 3.1） | 项目**供应商目录**里的文本模型 | 原站模型是 SaaS 清单，本项目按已配置供应商的文本模型列；重名补供应商名 |
| 消耗位 `⚡6` | 保留位置与外观，数字显示 `—` | 本项目按供应商 API 实际计费，无积分余额可显示；不伪造数字 |
| 翻译按钮 | 后端 `translate_canvas_text`（文本模型翻译） | 复用既有文本调用链路；原站是 `POST /api/canva/translate`。请求期间输入改变时保留新输入，译文可复制或从任务历史查看 |
| 右上角展开键 | 面板提示词区拉高到 320px | 原站这一键的具体行为没逆向出来；这里只保证「点得动、有反馈」（长稿能写） |

### 6.2 落地文件

| 文件 | 作用 |
| --- | --- |
| `src/features/workspace/canvasTextTryActionCatalog.ts` | 四个动作的定义与三段预置故事原文 |
| `src/features/workspace/CanvasTextTryActions.tsx` | 「尝试：」卡片（紧凑 / 完整两种排版） |
| `src/features/workspace/CanvasTextGeneratorPanel.tsx` | 悬浮生成器面板 |
| `src/features/workspace/CanvasTextGenerator.css` | 两块 UI 的样式；颜色一律走 tokens.css，只把原站实测的尺寸当硬约束 |
| `src/features/workspace/CanvasContentNode.tsx` | 新增 `cardBody` / `floatingPanel` 两个可选位 |
| `src/features/workspace/DocumentNodeViews.tsx` | 提示词节点接「尝试：」动作与正文聚焦 |
| `src/features/workspace/WorkspaceApp.tsx` | 动作分发、翻译、面板与节点状态的绑定 |
| `src-tauri/src/backend/prompt_optimize.rs` | `translate_canvas_text` 后端实现 |

### 6.3 与本项目既有约定的关系

- 解释说明统一由 `src/components/TooltipLayer.tsx` 的 `data-tooltip` 提供，本实现不写 CSS 伪元素。
- 节点内的下拉一律用 `src/components/CanvasSelect.tsx`（原生 `<select>` 在 WebView2 非整数缩放下会点空）。
- 面板根节点挂 `nodrag nowheel nopan`：不触发节点拖拽、不让滚轮缩放画布、不平移画布。
- 「音频节点后端暂未接入」按 AGENTS.md 的既有口径处理：保留入口与文案，给出明确说明。
- 面板挂在节点内部（不 portal），随 React Flow 缩放；靠画布边缘时按可见区域缩窄、水平夹取或翻到节点上方，短窗口允许滚动。
- 用户要求本轮不运行编译、测试或质量门禁；本轮只做了源码与现有逆向产物的人工核对。

### 6.4 尚未验证 / 尚未接入

- **文本生成、图片理解和翻译未做真实供应商调用**：需要已配置的对应文本／视觉模型；本轮没有运行编译或应用端验证。
- **音频节点未接入**：按用户要求先做前端占位，音乐提示词会写进文本节点正文，但不会建音频节点或提交生成。
- **消耗预估未接入**：面板消耗位固定显示 `—`。
- **面板「展开」键的具体行为未逆向出来**：这里只保证「点得动、有反馈」。
