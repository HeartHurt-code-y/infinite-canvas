# 03 · Negative 精简规范 + 常见坑

## 1. 官方态度

MiniMax H3 官方提示词结构中**没有独立的 Negative Prompt 字段**。
社区实践中 Negative 作为辅助手段被广泛使用，有一定效果，但**必须精简**。

## 2. 原则：少而精

把 Negative 精简到**真正关键、容易出问题**的方面。
冗长堆砌会稀释关键指令，反而降低效果。

**上限：10 个关键词。**

## 3. 精简示例

❌ 冗余写法（26 个词）：
```
Negative: subtitles, text, watermark, logo, on-screen text, captions, characters, words,
no other people, no crowd, no passerby, no stranger, no background people, no extra people,
no additional characters, no camera static, no still camera, no locked-off shot,
no fixed camera, no exaggerated expression, no facial distortion, no dramatic expression,
no slow motion, no freeze frame, no crying, no tears streaming, no waterfall tears,
no sobbing, no wailing, no open mouth crying, no smile, no laugh, no grin,
```

✅ 精简写法（7 个词）：
```
Negative: no other people, no exaggerated expression, no tears streaming,
no sobbing, no text, no watermark, no camera static,
```

## 4. 五个高频类别（按需各挑 1–2 个，别全抄）

| 类别 | 常用词 |
|------|--------|
| 画面污染 | `no text`, `no watermark`, `no subtitles`, `no logo` |
| 多余人物 | `no other people`, `no crowd`, `no passerby` |
| 表情失控 | `no exaggerated expression`, `no facial distortion`, `no tears streaming`, `no sobbing` |
| 机位失效 | `no camera static`, `no locked-off shot`, `no freeze frame` |
| 节奏异常 | `no slow motion`, `no time-lapse` |

**选词逻辑**：只写这次生成**最可能出问题**的 2–3 类，每类 1–2 个词。
比如「独角戏 + 固定场景」，重点写 `no other people` + `no camera static`。

## 5. 常见坑

| 坑 | 症状 | 解法 |
|----|------|------|
| 背景污染 | 成片出现参考图的灰/白棚拍背景 | Subject 里写「`<Picture N>` 不得展示 X 背景，替换为实际场景」 |
| 角色换脸 | 换了镜头人物就变样 | 角色图进 `<Subject>` 而非独立 `<Picture>`；retention 用 `fully_preserved` |
| 镜头不动 | 写了运镜但机位纹丝不动 | 补齐官方三维度（类型 + 幅度 + 速度）；Negative 加 `no camera static` |
| 表情过火 | 一秒从平静到大哭 | 微表情按 0.5s 拆节拍；Negative 加 `no exaggerated expression` |
| 乱入路人 | 画面里突然多出陌生人 | detailed_description 明写「画面中只有 X 人」+ Negative 加 `no other people` |
| 焦点失效 | 该虚化的没虚化 | 分开写「镜头位置保持不动，仅做焦点推移」 |
| 情绪标签无效 | 写「她很伤心」没反应 | 全换成可观察动作（见 02 号文件禁用词表） |
| 参考图过多 | 生成失败率上升 | 图控制在 1–3 张，其余用文字描述定义为 Subject |
| 超长提示词 | 被截断 | 控制在 7000 字符内；单段 4–15 秒 |
| 时间码对不上 | 结尾动作没演完 | 最后一段明写「X 秒结束」，并核对各段之和 = 总时长 |

### V1.3 新增：14 种失效模式（交付前逐个过）

来自 `minimax-h3-prompt-standardizer` 的可靠性清单，按出现频率排序：

| # | 失效模式 | 症状 | 预防写法 |
|---|---------|------|---------|
| 1 | 身份漂移 | 人物中途变脸 | 角色图进 `<Subject>`，`fully_preserved` |
| 2 | 换脸 | 切个镜头脸就换了 | 同上 + `retention_analysis` 逐项列面部特征 |
| 3 | 服装变更 | 衣服颜色/款式自己变 | 服装写进 Subject 并在 retention 里重申 |
| 4 | 道具复制 | 一个杯子变两个 | 道具也定义为 `<Subject>`，明写数量 |
| 5 | 手部畸形 | 六根手指、手掌糊掉 | 手不特写；必要时 Negative 加 `no extra fingers` |
| 6 | 多指 | 手指数量不对 | 同上 |
| 7 | 对眼 | 视线发散、瞳孔不同步 | 明写「看着镜头」或「看着 X 的眼睛」 |
| 8 | 口型错位 | 声音和嘴对不上 | 对白七要素里的**口型**项必写 |
| 9 | 动作瞬移 | 人物位置突然跳变 | 动作写全七要素，尤其是**收势** |
| 10 | 轴线反转 | 两人左右位置对调 | 定死「A 在画左、B 在画右」，全文不改 |
| 11 | 镜头跳切 | 机位无故跳 | 运镜只写一次，写完不再改 |
| 12 | 光线不一致 | 前后镜光源方向变了 | 锚定光源方向与色温，写进场景 Subject |
| 13 | 多余文字 | 画面冒出字幕/水印 | Negative 加 `no text`, `no watermark` |
| 14 | 风格漂移 | 画风中途变了 | Shot 1 定风格后不再重述 |

**不需要 14 条全防**——按这次生成最可能翻车的挑 3–5 条针对性预防即可。

### V1.5 新增：无图模式的 6 条必知风险

走无图模式（用户确认不要参考图）时，下面 6 条**每次都要在交付时讲给用户**：

| # | 风险 | 后果 | 缓解 |
|---|------|------|------|
| 1 | 人脸不可复用 | 同一个角色，两次生成是两张脸 | 保留标记只能用 `weak_reference`；**不要写 `fully_preserved`**（没有图就无从"完全保留"） |
| 2 | 服装 / 妆造漂移 | 同一场戏前后镜衣服变了 | 服装写到「颜色 + 材质 + 版型 + 明显细节」，并在每个镜头首句复述一次 |
| 3 | 场景与光线靠猜 | 空间结构、光源方向与色温全靠文字 | 场景单独一个 `<Subject>`，写死「主光源方向 + 色温 + 辅光」 |
| 4 | 细节越写越糊 | 描述越长，模型越容易丢项 | 每个 Subject 的外观控制在 3–5 个可辨识特征 |
| 5 | 补图即重做 | 后续补了图，之前的片段全部作废 | 交付时附「上线前必须补图」清单，并标注补图后要重生成哪几段 |
| 6 | 容易误当 Ref2VA 用 | 其实应该用官方 T2VA 通道 | 无参考素材时优先考虑官方 `h3-prompt-writing`（T2VA），本 skill 只在用户明确要全参考结构时才用 |

> 校验器对应检查码：`IMG-DECL`（无图未声明，警告）、
> `IMG-TXT-DEF`（声明了但 Subject 没标注，警告）、
> `IMG-CONFLICT`（无图声明与参考图同时出现，错误）、
> `IMG-MODE`（合规，提示）、`IMG-CALIB`（有图时提醒先做读图校准，提示）、
> `IMG-INHERIT`（多段续段无图属正常，提示）。

### V1.3 新增：过载时的降级顺序

提示词塞太满，H3 不会报错，只会**悄悄丢掉一部分**。发现装不下时，
按这个顺序扔东西，**不要平均削减**：

1. **先减同时进行的动作数**（两个角色各做两件事 → 各做一件）
2. **再简化运镜**（弧形环绕 → 直线推近；多段运镜 → 单段）
3. **再砍台词字数**（长句拆短句，或整句删掉）
4. **最后才考虑拆段**——且必须切在合法切点上（见 02 号文件 §2.6）
5. 兜底：砍掉画面里的次要角色或次要道具

> 规范器原话：*"When an input is overloaded, reduce simultaneous actions,
> simplify the camera, or split at a genuine visual boundary."*
> 本 skill 把它整理成了带优先级的顺序——先减动作而不是先拆段，
> 因为拆段会引入跨段一致性风险，代价最高。

## 6. 模糊词替换表（V1.3 新增）

抽象形容词对模型是**无效指令**。按下表换成可生成的维度。

| ❌ 模糊词 | ✅ 换成（挑 2–3 个维度写） |
|----------|--------------------------|
| 震撼 | 广角低机位 + 主体占画面 1/4 + 逆光剪影 + 缓慢推近 |
| 高级感 | 低饱和 + 单一主色 + 大面积留白 + 柔光无硬阴影 |
| 唯美 | 逆光发丝 + 浅景深 + 暖调 + 慢速飘动 |
| 电影感 | 见下方⚠️ |
| 氛围感 | 具体光源 + 可见光斑/雾气 + 色温 + 明暗比 |
| 有张力 | 两人对视 + 轴线正对 + 静止 3 秒后突然推近 |
| 丝滑 | 具体匹配元素（见 02 号文件 §2.7） |
| 舒服的节奏 | 每 X 秒一次景别变化 + 运镜速度 X |

### ⚠️ 「电影感 / cinematic」不能一刀切禁用

规范器把「电影感」列为该替换的模糊词，但**官方不这么认为**：

> 官方 base-en §4.2 原文：
> *"At the beginning of `[Shot 1]`, state the overall style and initial composition.
> Common styles include `Cinematic`, `live-action`, `2D-animated`..."*

官方示例就是 `[Shot 1] Live-action, cinematic, a medium-wide shot frames...`。

**正确用法**——按位置区分：

| 位置 | 判定 | 写法 |
|------|------|------|
| `detailed_description` **首句**整体风格 | ✅ **允许**，官方许可 | `[Shot 1] 真人实拍，cinematic 风格，中景…` |
| 用来替代具体光位/构图/运镜 | ❌ **禁止** | 改写成「侧逆光、硬阴影、2.35:1 画幅、缓慢横移」 |

**结论**：`cinematic` 作**风格标签**用是合规的；拿它**当细节描写**用才是偷懒。
本 skill 采用官方口径，不跟随规范器一刀切。

- [ ] 六段齐全、顺序正确、字段名全小写带冒号
- [ ] 每个 `<Subject>` / `<Picture>` / `<Video>` / `<Audio>` 都在 subject_definitions 里定义过
- [ ] 标签在全文含义一致，无重复定义
- [ ] 角色图走 Subject，没有只为角色建 Picture
- [ ] 参考图有纯色背景 → 已写「不得展示 X 背景」
- [ ] retention_analysis 只有保留关系 + 动作链，无画面构成
- [ ] detailed_description 时间码分段 ≥4 段，且各段之和 = 总时长
- [ ] 无内心独白、无情绪标签
- [ ] 每段运镜都写全官方三维度（类型 + 幅度 + 速度），且是自然英文动作句而非堆标签
- [ ] 说话的角色都有稳定 ID `(S1)`/`(S2)`，放在 `<d>` 之外，跨镜头一致
- [ ] 对话全部在 `<d>[语言] ...</d>` 里，`<d>` 内只有语言标签和台词原文
- [ ] 多镜头：首镜无时间戳，后续镜头切点严格递增且不超总时长
- [ ] 中文台词按 4.5 字/秒估过时长，每镜都塞得下（留 ≥1.2s 给动作/反应）
- [ ] `non_diegetic_music` 只写乐器/速度/节奏/力度，无抽象情绪词
- [ ] `non_diegetic_music` 不需要时写了 `N/A`
- [ ] Negative ≤ 10 词
- [ ] 总字符 ≤ 7000，时长 4–15s
- [ ] 已跑 `scripts/validate_ref2va.py`
- [ ] **无模糊词**（震撼/高级感/唯美/氛围感/丝滑）；`cinematic` 仅作首句风格标签
- [ ] **转场写了可见匹配元素**，不是「丝滑过渡」这类空话
- [ ] **动作有收势**，没停在半途
- [ ] **对白补了口型**（说完嘴唇如何）
- [ ] **多段时每段有尾帧状态 + 下段切点**，切点落在合法位置
- [ ] 过载已按降级顺序处理（先减动作 → 再简运镜 → 再砍台词 → 最后才拆段）
