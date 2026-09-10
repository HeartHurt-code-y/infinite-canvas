# 11 · API 模型与参数兼容性（官方教程）

本文件收录火山方舟（Volcengine Ark）官方教程文档中的 **API 层事实**，用于把「参数分离 / 参数锁定」原则落到具体字段。教程文档：`docs.volcengine.com/docs/82379/2607688`（API 参考）与 `2607689`（概述/兼容性）。

> 这些参数通过生成页面或接口设置，**不写进 Prompt**（见 04 参数锁定表、10 原则 7）。本文件只帮你在提交时填对字段、避开报错。

---

## 一、模型标识（endpoint model）

| 模型                     | 标识串                            | 说明                            |
| ------------------------ | --------------------------------- | ------------------------------- |
| **Seedance 2.5（当前）** | `doubao-seedance-2-5-260628`      | 本技能全部方法论对应此模型      |
| Seedance 2.0             | `doubao-seedance-2-0-260128`      | 旧版，单段最长 15 秒、最高 720p |
| Seedance 2.0 fast        | `doubao-seedance-2-0-fast-260128` | 高速版                          |
| Seedance 2.0 mini        | `doubao-seedance-2-0-mini-260615` | 轻量版                          |

调用时通常带 `&projectName=default`，例如 `doubao-seedance-2-5-260628&projectName=default`。

---

## 二、2.5 与 2.0 关键能力差异（兼容性）

| 维度            | Seedance 2.5                         | Seedance 2.0     |
| --------------- | ------------------------------------ | ---------------- |
| 单段时长        | **4–30 秒**                          | 4–15 秒          |
| 分辨率          | 480p / 720p / **1080p**              | 480p / 720p      |
| 参考素材上限    | 图片 30 + 视频 10 + 音频 10（共 50） | 更少（见各文档） |
| `duration = -1` | 支持（模型自动选最佳时长）           | 支持             |

> 本技能所有模板默认按 2.5 能力（30 秒、50 素材、1080p）编写。

---

## 三、关键请求参数（与提示词无关，靠接口设置）

| 参数                | 取值与约束                                                                                                                                                                                   | 备注                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `duration`          | **视频生成/其他**：`4~30`（秒）或 `-1`（模型自动选最佳时长）；**视频编辑**：固定 `-1`，自动保持与待编辑视频时长基本一致，**不支持自定义**；**视频延长**：`-1` 表示自动保持，延长时长可自定义 | 不要写进 Prompt；见 04 参数锁定表        |
| `resolution`        | `480p` / `720p` / `1080p`（2.5）                                                                                                                                                             | 2.5 才支持 1080p                         |
| `ratio`（画幅比例） | **视频编辑任务必须为 `adaptive`**（自动保持输入视频比例）；其他任务按页面/接口选择                                                                                                           | 编辑任务写固定比例会触发任务类型约束报错 |
| `fps` / 帧率        | 由接口设置                                                                                                                                                                                   | 不写进 Prompt                            |
| 音频开关            | 由接口/页面设置                                                                                                                                                                              | 不写进 Prompt                            |

### 子任务自动判定与异步报错

当 `content.role` 配置为 `reference_image` / `reference_video` / `reference_audio` 时，模型会**根据提示词意图判定子任务类型**（参考生视频 / 视频编辑 / 视频延长），再校验该子任务下输入参数的合法性（例如编辑任务中 `ratio` 必须为 `adaptive`）。因此相关报错**需排队等待任务启动、模型完成判定后异步返回**，并非即时校验。

- 因任务类型导致的参数不兼容报错错误码：**`InvalidParameter.TaskTypeConstraint`**（详见官方错误码文档 `docs.volcengine.com/docs/82379/1299023`）。
- 多个参数同时违规时，报错信息一次性列出所有违规项。

---

## 四、新手入口（非必需）

- 控制台体验中心（含模板库，一键生成同款视频，免代码）：`console.volcengine.com/ark/region:cn-beijing/experience/vision?modelId=doubao-seedance-2-5-260628&tab=GenVideo`
- API Explorer（快速试调）：`api.volcengine.com/api-explorer/?action=CreateContentsGenerationsTasks&groupName=视频生成API&serviceCode=ark&version=2024-01`
- 获取 API Key：`console.volcengine.com/ark/region:cn-beijing/apikey`

---

## 五、与技能其他部分的关系

- 参数「不写进 Prompt」的纪律 → [10-pe-discipline](10-pe-discipline.md) 原则 7、[04-edit-extend-keyframe](04-edit-extend-keyframe.md) 参数锁定表
- 素材上限 50 份 → [02-assets-routing](02-assets-routing.md)
- 视频编辑 `ratio=adaptive` 与范围闭环 → [04-edit-extend-keyframe](04-edit-extend-keyframe.md) + [10-pe-discipline](10-pe-discipline.md) 第五节
- 视频延长边界连续 → [04-edit-extend-keyframe](04-edit-extend-keyframe.md) + [10-pe-discipline](10-pe-discipline.md) 第六节

> 本文件摘取官方 API 教程的**稳定事实**（模型名、时长/分辨率/比例约束、错误码）。具体字段名与默认值以官方最新文档为准；模型会持续迭代。

---

## 六、时效性核对注记（2026-08-12 复核）

- **模型 ID 仍为当前**：`doubao-seedance-2-5-260628`（火山方舟官方页面"模型全面开放"，8 月 7 日 API 公测上线）。
- 单次 30 秒直出、50 个全模态素材、秒级时间戳编辑、十余种语言——与本文及技能 01–13 口径一致。
- **「180 秒」的精确区分**：即梦**产品端**存在"超长模式"（第三方报道称最长 180 秒），属**产品层能力**；**API 层单次直出仍 ≤30 秒**（`duration` 取 4–30 或 `-1`），**不存在 180 秒的任务类型参数**。因此提示词层组织方式不变：单段（≤30s）+ 延长接力（见 [09-timed-script-prompter](09-timed-script-prompter.md) / [12-fight-combat](12-fight-combat.md) 校准声明）——产品端的"超长模式"不改变 API 参数约束与提示词写法。
