# references/01-official-api.md — 万相3.0 官方 API 锚点（权威）

> 来源：阿里云百炼《万相3.0-视频生成 API 参考》与《Wan3.0 视频创作者手册》。字段名与取值保持原样。本文件为**权威事实层**，SKILL.md 的方法论必须在此边界内。

## 1. 模型与端点

- **模型名（固定）**：`wan3.0-video`
- 调用方式：异步（HTTP 必须带 `X-DashScope-Async: enable`，否则报错 "current user api does not support synchronous calls"）。流程 = 创建任务 → 轮询 `task_id`（有效期 24h，勿重复创建）。
- 地域一致性：模型、Endpoint URL、API Key 必须同地域（北京 / 新加坡 / 美东弗吉尼亚），跨地域调用失败。

## 2. 两种模式

| 模式 | 适用 | media 形态 |
|---|---|---|
| **全能参考模式**（All-in-One） | 自由参考生成与视频编辑，覆盖绝大多数任务 | reference_image / reference_video / reference_audio / file / link |
| **首尾帧模式** | 严格遵循首帧/尾帧生成 | first_frame（≤1）+ last_frame（≤1） |

> 两模式**互斥**：进入首尾帧模式后不再支持参考输入。

## 3. 请求参数（parameters，整体可选，子字段亦可选）

| 字段 | 类型 | 默认 | 可选值 / 范围 |
|---|---|---|---|
| `resolution` | string | `1080P` | `480P` / `720P` / `1080P` |
| `ratio` | string | `adaptive` | `adaptive`（自适应）/ `16:9` / `9:16` / `4:3` / `3:4` / `1:1` |
| `duration` | integer | `5` | 无视频输入：`[2,30]`；有视频输入：输入+输出 ≤30；`-1`=智能时长 |
| `audio` | boolean | `true` | `true` 含音轨 / `false` 无音轨 |
| `seed` | integer | 无 | `[0, 2147483647]` |
| `prompt_extend` | boolean | `true` | `true` 智能改写 / `false` 关闭 |
| `watermark` | boolean | `false` | `false` 无水印 / `true` 加水印 |

- 必选字段仅 `model` 与 `input`；`input.prompt` 与 `input.media` 二选一必填其一。
- `prompt` ≤ 20000 字符（每汉字/字母占 1 字符，超出自动截断），支持中英文。

## 4. 媒体类型限制（input.media 数组元素）

| type | 最大 | 限制 |
|---|---|---|
| `first_frame` | 1 张 | 严格作为第一帧；JPEG/JPG/PNG/BMP/WEBP，单边[240,8000]px，长宽比≤8:1，≤20MB |
| `last_frame` | 1 张 | 严格作为最后一帧；同图片限制 |
| `reference_image` | 10 张 | 同图片限制 |
| `reference_video` | 5 段 | 单段[1,15]s，总时长≤15s；mp4/mov；单边[240,4096]px；≤100MB |
| `reference_audio` | 5 段 | 单段[1,15]s，总时长≤15s；wav/mp3；≤15MB |
| `file` | 1 个 | 与 `link` 二选一；docx/doc/xlsx/xls/pptx/ppt/pdf/txt/md（API 额外支持 key/pages/numbers），≤100MB，≤50 页 |
| `link` | 1 个 | 公网 HTTP/HTTPS；与 `file` 二选一 |

**互斥约束（官方硬规则）**：
- `reference_image / reference_video / reference_audio / file / link` 与 `first_frame / last_frame` **不能同时出现**于同一 media 数组。错误码提示："The two modes are mutually exclusive. Do not pass reference_xx and first_frame/last_frame at the same time."
- `file` 与 `link` 互斥。

## 5. 参考指代顺序（全能参考模式）

- 在 media 数组中**按顺序**定义 prompt 中的素材引用；图与视频**分别计数**（图1 与 视频1 可共存）。
- 第 1 个 `reference_video` → 视频1；第 2 个 → 视频2……
- 第 1 个 `reference_image` → 图1；第 2 个 → 图2……
- 第 1 个 `reference_audio` → 音频1；第 2 个 → 音频2……
- **指代符号校准**：本技能用 `@图片1 / @视频1 / @音频1`（等价于官方 wire 形式 `图1 / 视频1 / 音频1`）；模型两种都接受。提交原始 API 时按上述顺序映射即可。

## 6. 文档/网页输入（"万物皆视频"）

- `file` 或 `link` 可承载 doc/docx/xls/xlsx/ppt/pptx/pdf/txt/md（API 额外 key/pages/numbers），≤100MB、≤50 页。
- 用法：产品 PPT→品牌片、培训 deck→视频课件、表格→动态图表、报告→旁白简报。提示词只定**风格与方向**，不必重复文档内容。

## 7. 能力边界提示（官方亮点）

- 原生 30s 单生成；智能时长推荐 + 视频延长。
- 多模态参考：文本/图片/音频/视频/文档/网页；首次支持文档解析。
- 真实感：人物千人千面、自然微表情、参考一致性（人物/道具/空间/风格）。
- 内置视频编辑：改视觉/剧情/对白，无需整段重生成。

## 8. 错误码速记

| 现象 | 原因 |
|---|---|
| "current user api does not support synchronous calls" | 缺 `X-DashScope-Async: enable` |
| "The two modes are mutually exclusive..." | 参考类与首尾帧混用 |
| 跨地域调用失败 | 模型/URL/Key 地域不一致 |
| 内容被截断 | prompt > 20000 字符 |
