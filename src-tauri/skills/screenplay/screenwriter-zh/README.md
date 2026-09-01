# Screenwriter Skill — 快速入门

通用编剧工具技能。不绑定特定故事。在 Claude / Cowork / Claude Code 中作为技能文件夹运行。

---

## 内含内容

- **`SKILL.md`** — 技能主要描述（首先读取）。
- **`methodology.md`** — 麦基 + 坎贝尔 + 亚里士多德。
- **`style-rules.md`** — 好莱坞格式写作规则。
- **`workflow.md`** — 与用户的工作模式。
- **`timing-and-cutting.md`** — 屏幕时间估算与长度剪辑。
- **`templates/`** — 属于你故事的空模板。
- **`tools/`** — .docx 生成器（剧本、双语、分集大纲）。

---

## 如何开始

### 步骤 1. 安装

将 `screenwriter-skill/` 文件夹复制到方便的位置：Claude Code 项目内、作为 Cowork 的用户技能 (`~/.claude/skills/screenwriter/`)，或直接放在工作文件旁边。

### 步骤 2. 告诉 Claude

> 「加载 screenwriter 技能，我们开始。」

Claude 会读取 SKILL.md、方法论、写作规则和工作流程。

### 步骤 3. 提供素材

以下情况之一：

**A. 你已有梗概 / 分集大纲 / 场景草稿。**
发送文件 — Claude 会读取并询问从哪个节点开始工作。

**B. 你只有想法。**
用一到两段话描述。Claude 会提问，首先帮你打磨梗概，然后是分集大纲，最后是具体场景。

**C. 你只有标题和类型。**
填写 `templates/synopsis.template.md` 和 `templates/characters.template.md`。接下来 — 迭代进行。

### 步骤 4. 逐场推进

标准循环：
1. 你根据分集大纲要求写一场戏。
2. Claude 给出**一个**版本 + 理由。
3. 你说修改意见。
4. Claude 精准修改。
5. 场景定稿后 — 通过 `tools/build_screenplay.js` 导出 .docx。

---

## 导出工具

### 剧本（好莱坞格式）
```bash
cp tools/build_screenplay.js my_scene.js
# 打开 my_scene.js，通过 slug/action/character/dial/trans 填充 `screenplay` 数组
NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules node my_scene.js
# 得到 screenplay.docx
```

### 双语（对话 + 翻译）
```bash
cp tools/build_bilingual.js my_bilingual.js
# 通过 ...dialB("主语言", "译文") 填充
node my_bilingual.js
# 得到 screenplay-bilingual.docx
```

### 分集大纲
```bash
cp tools/build_treatment.js my_treatment.js
# 通过 scene("标题", "正文", "[可选] 审核标签") 填充
node my_treatment.js
# 得到 treatment.docx
```

---

## 对技能的典型请求

| 请求 | Claude 做什么 |
|---|---|
| 「写第5场戏」 | 读取分集大纲 → 写一个版本 + 理由 |
| 「这不行」 | 问一个狭义的二元问题 → 新版本 |
| 「做成双语」 | 使用 `tools/build_bilingual.js` |
| 「做因果关系审核」 | 遍历分集大纲并标记 ⚠ |
| 「一共多少分钟？」 | 按场景类型计算（见 `timing-and-cutting.md`） |
| 「压缩到 X 分钟」 | 给出带具体数字的剪辑方案 |
| 「让角色 Y 的声音跟 X 区分开」 | 对比台词，提出修改 |

---

## Claude 不会做的三件事

1. **不写5个版本** — 只给**一个** + 理由。
2. **不「优化」旁边的台词** — 只改被要求改的。
3. **不描述情绪** — 只用动作动词。

如果 Claude 违规 — 说：「一个版本，不是五个」或「只改 X」。

---

## 技能个性化

如果你在同一个类型中写多部电影 — 可以 fork 这个技能并添加：

- **`reference-films.md`** — 参考片单及场景分析。
- **`my-style.md`** — 你的个人风格偏好（例如「不喜欢闪回」、「总以静默收尾」）。
- **`recurring-tropes.md`** — 你的常用手法。

技能成为你自己的，而非通用的。
