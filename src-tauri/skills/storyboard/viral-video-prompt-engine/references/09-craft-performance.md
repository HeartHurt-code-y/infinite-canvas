# 09 · 工艺·表演词库（含活人感方法论）

> 何时用：编运动提示词的【画面内容】时按需加载。
> 依赖：无。
> 产出：表演词汇与方法。
> 只在编对应那一维时读入，平时不占上下文。

---

## 核心铁律：情绪靠动作堆，不直说

- ❌ "她很难过"
- ✅ "她眼角紧绷的线条松开，嘴角牵起一个疲惫的半笑，呼出一口气在冷空气里凝成白雾"

- ❌ "他很愤怒"
- ✅ "他下颌绷紧，喉结滚动一下，垂在身侧的手指攥成拳又松开"

- ❌ "她很紧张"
- ✅ "她的手指无意识地搓着衣角，目光在门和窗之间来回扫了两次"

> 半笑和笑是两回事。人累到极点，大笑或普通笑都表达不出那股累，半笑配上瘫软的状态，那种又累又由衷的劲儿一下就具体了。

---

## 动作写到身体部位

穷尽到身体部位，不要笼统：

| 笼统（❌） | 具体（✅） |
|---|---|
| 她走过来 | 她从画面右侧步入，脚步拖沓，鞋底在碎石上磨出沙沙声 |
| 他看了她一眼 | 他的目光从桌面移到她的脸上，停留了两秒 |
| 她笑了 | 她嘴角牵起一个半笑，眼角的纹路跟着松开 |
| 他转身 | 他的左脚蹬地，身体向右后方转，披风被惯性带起一个弧 |

---

## 微表情词库

| 情绪 | 微表情（具体物理动作） |
|---|---|
| 疲惫 | 揉太阳穴 / 眼角线条松开 / 半笑 / 呼气凝白雾 |
| 压抑 | 下颌绷紧 / 喉结滚动 / 手指攥拳又松 / 目光下压 |
| 紧张 | 搓衣角 / 目光扫视 / 呼吸变浅 / 指尖微颤 |
| 警觉 | 后背挺直 / 下巴微抬 / 瞳孔收缩 / 头微转 |
| 从容 | 肩膀放松 / 嘴角微挑 / 步伐不紧不慢 / 手指轻敲 |
| 火爆 | 眉头拧紧 / 嘴唇抿成一线 / 脚步重 / 拳头攥死 |

---

## 走位与体位

多人同框时把"关系"翻译成具体 blocking：

- 谁坐 / 卧 / 倚 / 立
- 谁高谁低
- 谁俯视谁仰视
- 谁的目光锁在谁脸上

> 漏写体位 → 模型默认全员站立齐高。只写"看向某方向" → 望向虚空而非看人。

---

## 强者平静，弱者张扬

- **真正的强者**：平静、从容、甚至零特效。强到不需要展示力量。
- **弱/急的一方**：张扬、用力、满身特效。越使劲越显被压制。
- 关系定了全片一致，别中途反过来。

---

## 活人感：让人物不像 AI（V4.7 并入）

> **来源**：本节为该技能包内置的活人感方法论（模型无关部分）。
> **完整方法论**（含 H3 专属的 Ref2VA 结构纪律、道具图片锚定、空间锁定、成片验收清单）
> 本节为该方法的落地入口，完整方法论见本包 references/09-craft-performance.md。
> 本包**不依赖**该 skill，本节已自包含可用。

### 核心理念：AI 人物假，不是五官不真，是这个人太闲了

把精力全花在皮肤质感、光影、发丝上，生成出来还是一眼 AI。解决办法是**给人物找事情做、给行为动机**——
哪怕脸没那么完美，观众也会下意识觉得这个人活着。

> 真实的人永远在被生活推着走：会赶时间、会分心、会走神、会下意识做和主题无关的小动作。

### 表演公式

**单个人物**：`人物 + 正在做的小事 + 下意识反应 + 情绪落点`

**多个人物**：不要让每个人都表演。**一人行动，另一人反应，反应慢半拍**——真实的人回应时注意力还在别处。

**英文模板**（用于 H3 / Ref2VA 等英文提示词：放在 `detailed_description` 的 `[Shot 1]` **之前**，作为整段表演开场）：

```
Acting direction for the whole sequence: nobody stands idle or poses for the camera. Every character is always occupied with some small piece of business — handling an object, finishing a movement, glancing at something off-topic. In every exchange one character acts while the other reacts, and reactions arrive a beat late, the way real people respond while their attention is still somewhere else. Small involuntary gestures (swallowing, shifting weight, thumb rubbing an edge, a delayed look-up) matter more than polished facial expressions.
```

**中文模板**（用于 Seedance 2.5 / 中文视频提示词：作为脚本开头的「全局表演指导」区，与「场景调度宪法」并列，整场写一次）：

```
全局表演指导（整场通用）：
本片没有人站着摆拍——每个角色手上始终有事做（端杯、整理衣角、翻找口袋、摩挲物件边缘）；
对话或对峙时一人行动、另一人反应，反应迟半拍，注意力还在自己手上的事。
情绪不直说：先给人物一个想藏的隐藏目的，用一个大动作盖住真实反应，情绪写成变化过程
（先…停一拍…然后…）而不是最终状态。程度词取"一点点/几乎察觉不到/迟半拍"。每镜小动作 1–2 个。
```

> **各模型落点（V4.9）**：Seedance 2.5 → 脚本开头「全局表演指导」+ 每段 `【表演指导】` 硬栏位（中文）；MiniMax H3 Ref2VA → `detailed_description` 内 `[Shot 1]` 前写 `Acting direction for the whole sequence:`（英文）。完整落点表与 H3 专属结构纪律见本篇所在技能包。

### 小动作词库（按功能分类，写提示词时取用）

- **赶时间/紧张**：slightly out of breath, clutching the folder against his chest, swallowing once, tugging his jacket hem straight（求人前下意识整理衣服）
- **分心/走神**：eyes flicking toward the alarm lamp / the corridor door, not looking up when the door opens, half-turning his head toward off-screen business
- **思考/沉住气**：turning a pipe in one hand, tapping the pipe bowl against the palm, taking one slow unhurried draw, letting the question hang（不接话，让话晾着）
- **情绪落点（要克制）**：the smile fading, shoulders settling a fraction, thumb rubbing the folder's edge, the faintest breath of a laugh through the nose, regret deepening almost imperceptibly

> **程度词是灵魂**：`a fraction` / `faintest` / `almost imperceptibly` / `a beat late`——情绪越克制越真。

### 反面教训

- 不要只堆表情词（brows knitted, eyes pleading...）而不给动作——那是"表演"，不是"活着"。表情必须挂在动作和反应链上。
- 小动作宁少勿滥：**每镜 1–2 个**。跟踪能力有限，动作太多会拖垮台词节奏。如果成片台词说不利索，优先砍台词中间插入的分心动作。
- 人物"演技差"通常不是表情不够丰富，而是**演得太用力**——用下面的反向表演三技巧收敛。

### 反向表演三技巧（情绪要藏，不要演）

AI 人物演技差的常见根源不是表情不丰富，而是演得太用力：写提示词时把全部精力放在表情上——眉毛怎么皱、嘴角怎么动、眼泪什么时候掉——
结果内心情绪被原样写在脸上，一眼 AI。核心是：**让情绪藏进目的、大动作和时间线里**。

**技巧一：给情绪一个隐藏目的（先给目的，再给情绪）。**
只写内心情绪（"他很紧张"）等于告诉模型用最大幅度演紧张——不写目的，模型默认就是最大值。
先写人物**想对外维持什么状态**：`他很紧张，但为了不让对方发现，表面依然保持平静`。有了目的，模型才会走微表情路径。

**技巧二：用大动作掩盖小动作。**
专门写小表情（紧张→四下张望）反而刻意，刻意就是 AI 假感的来源。真实的人在隐藏情绪时，会用一个大动作掩盖真实反应：
紧张时端起水杯，尴尬时低头整理衣服，难过时转身收拾东西。大动作本身不表达情绪，却把眼神闪躲、手指颤抖这些小动作藏在里面。

**技巧三：给情绪加时间顺序。**
最容易忽略的犯错点：写微表情只写最终状态——"他紧张了""他笑了"，这是静态的截图。
微表情的本质是**变化过程**，真实反应一定有先后。把过程写进去：先……停了一拍……然后……。模型接收到时间关系，
生成的就不再是截图脸，而是正在发生的画面。

正反对照：

```
反面（只给情绪 + 最终状态，生成结果：用力演、截图脸）：
She is nervous and glances around, then smiles.

正面（目的 + 大动作掩盖 + 时间顺序）：
She is nervous about the inspection, but doesn't want the visitor to notice
(hidden purpose). She turns back to the desk and starts stacking files to busy
herself (big action covering the tells); her thumb keeps rubbing the folder's
edge (small tell hidden inside), and only after a beat do her shoulders settle
(time sequence).
```

**适用判断**：当成片里人物表情夸张、情绪直给、像在"演给镜头看"时，逐镜检查三件事——
有没有隐藏目的、有没有大动作可藏、情绪有没有先后过程；缺哪个补哪个。
