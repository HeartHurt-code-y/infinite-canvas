# 04 · 完整提示词示例

> **语言策略（V1.1 改版）**：字段名 / 标签 / 保留标记 / Negative 用**英文**，其余用**中文**。
> 示例 A、B 是**中文实战版**，可直接粘贴进 H3。
> 示例 C 是**英文版**，仅在需要官方完整语法（音频标记、说话人 ID、任务类型前缀）时使用。

---

## 示例 A：对白密集 · 节拍模式 · 10 秒 · 双角色

标准模板示例。两人边走边说，动作是离散事件，用 `→` 铺节拍。

> **提示词之外的前置块**（V1.3 新增）：有参考图时，先在提示词前声明上传顺序。

```text
图片上传顺序：
@图片1：唐糖主参考，锁定面容、发型、服装和体型；忽略原图水印与界面文字
@图片2：林浩主参考，锁定面容、发型、服装和体型；忽略原图水印与界面文字

subject_definitions:
<Subject 1>：唐糖，24 岁左右中国年轻女性，棕色长发中分披肩，戴银色船锚耳坠，穿蓝色横条纹短袖 T 恤，红蓝白编织带手环，蓝色牛仔背带裤。完全参照 <Picture 1> 外观。
<Subject 2>：林浩，24 岁左右中国青年男子，黑色短发，穿浅蓝色短袖纽扣衬衫和黑色长裤。完全参照 <Picture 2> 外观。
<Subject 3>：夜晚街头，路灯、车流、店铺灯光、城市天际线、街道、人行道、夜晚。无参考图，由文字描述定义。

summary:
10 秒一镜到底，场景是夜晚街头。唐糖和林浩并肩在街上行走，镜头从正面跟随拍摄，全程保持两人中景构图。

retention_analysis:
<Subject 1>：fully_preserved 唐糖全套外观，动作：挽着林浩的胳膊一起走路。
<Subject 2>：fully_preserved 林浩全套外观，动作：和唐糖一起并肩走路。
<Subject 3>：fully_preserved 夜晚街头场景（路灯、车流、店铺灯光、城市天际线、街道）。
画面里只有唐糖、林浩，绝对没有其它人。

detailed_description:
[一镜到底] 0–10s，场景是夜晚街头。唐糖和林浩并肩在街上行走，镜头从正面跟随拍摄，全程保持和两人的距离。
→林浩看着唐糖。
→林浩说"唐糖，你今天真漂亮！"。
→林浩看着镜头，唐糖笑了，看着林浩。
→唐糖说"林大哥，你今天真会说话！"。
→林浩拍了拍胸部。
→林浩说"那是，做舔狗，我是专业的！"。
→唐糖看着林浩，用手指着林浩。
→唐糖说"舔狗舔狗，一无所有！"。
→俩人看着镜头，继续走路。

overall_soundscape:
远处车流声，风吹过街道的声音。

non_diegetic_music: N/A

Negative: no other people, no exaggerated expression, no tears streaming, no sobbing, no text, no watermark, no camera static,
```

**这一版的四个关键**

| 点 | 说明 |
|---|---|
| 节拍而非时间码 | 对白密集，用 `→` 铺事件流比切时间码更准 |
| 台词配视线 | 每句台词前后都挂了「谁看谁」，避免站桩念稿 |
| 防乱入约束 | retention 末尾一行「画面里只有唐糖、林浩」 |
| **上传顺序前置块** | V1.3 新增。提示词之外先声明 `@图片N`，H3 只按上传先后认图 |
| 参考图顺序连续 | 编号全局唯一即可，**但写了上传顺序块时建议连续编号**，否则 `@图片3` 上方会出现空缺，对图时容易错位 |

> **跑校验器会得到 2 条 BG-POLLUTION 警告**，这是因为示例假设参考图已是实景照片。
> 若你的参考图带棚拍纯色背景（灰 / 白 / 黑），在每条 Subject 末尾补一句：
> `<Picture 1> 不得展示灰色背景，实际场景替换为夜晚街头。`
> 补完即可 0 警告。写法见示例 B。

---

## 示例 B：表演密集 · 时间码模式 · 8 秒 · 三角色

无对白，全靠微表情和运镜，用时间码逐拍写。
参考图带棚拍纯色背景，所以每个 Subject 都加了「不得展示 X 背景」。

```text
图片上传顺序：
@图片1：唐糖主参考，锁定面容、发型、服装和体型；忽略原图灰色棚拍背景与水印
@图片2：宝儿主参考，锁定面容、发型、服装和体型；忽略原图黑色棚拍背景与水印
@图片3：林浩主参考，锁定面容、发型、服装和体型；忽略原图纯白棚拍背景与水印

subject_definitions:
<Subject 1>：唐糖，24 岁左右中国年轻女性，棕色长发中分披肩，戴银色船锚耳坠，穿蓝色横条纹短袖 T 恤，红蓝白编织带手环，蓝色牛仔背带裤。完全参照 <Picture 1> 外观。<Picture 1> 不得展示灰色背景，实际场景替换为夜晚街头。
<Subject 2>：宝儿，24 岁左右中国年轻女性，黑色长发中分披肩，戴珍珠耳坠，戴珍珠项链，穿银白色亮片旗袍（立领 + 半透视网纱 + 珍珠装饰纽扣 + 银白色亮片条纹图案）。完全参照 <Picture 2> 外观。<Picture 2> 不得展示黑色背景，实际场景替换为夜晚街头。
<Subject 3>：林浩，24 岁左右中国青年男子，黑色短发，穿浅蓝色短袖纽扣衬衫和黑色长裤。完全参照 <Picture 3> 外观。<Picture 3> 不得展示纯白背景，实际场景替换为夜晚街头。
<Subject 4>：夜晚街头，路灯、车流、店铺灯光、城市天际线、街道、人行道、夜晚。无参考图，由文字描述定义。

summary:
8 秒一镜到底，场景是夜晚街头。镜头从远景开始：唐糖背影（近景虚化），宝儿和林浩在前面挽手行走（远景清晰）。随后焦点从远景切换到近景唐糖。接着镜头做 90° 弧形运镜，从唐糖背后旋转到侧面，最后缓慢推近至唐糖侧面中近景，长时间停留在唐糖微表情上。

retention_analysis:
<Subject 1>：fully_preserved 唐糖全套外观，动作：站在马路上 → 背影 → 侧脸 → 微表情变化。
<Subject 2>：fully_preserved 宝儿全套外观，动作：挽着林浩一起走路。
<Subject 3>：fully_preserved 林浩全套外观，动作：搂着宝儿一起走路。
<Subject 4>：fully_preserved 夜晚街头场景（路灯、车流、店铺灯光、城市天际线、街道）。
画面里只有唐糖、宝儿、林浩三人，绝对没有其它人。

detailed_description:
**[一镜到底] 0–8s**

**0–1s：** 远景。夜晚街头（Subject 4）。画面中只有唐糖、宝儿、林浩三人。唐糖（Subject 1）背对镜头站在马路中央（近景，处于虚化模糊状态）。宝儿（Subject 2）和林浩（Subject 3）手挽手在远处行走，背对镜头（远景，清晰可见）。

**1–2.5s：** 镜头焦点从远景缓慢切换到近景——宝儿和林浩逐渐变模糊，唐糖逐渐变清晰。镜头位置保持不动，仅做焦点推移。

**2.5–4.5s：** 镜头开始沿弧线轨迹移动。以唐糖为轴心，从唐糖背后向左侧旋转，运镜方向平滑，90° 弧形运镜，镜头高度保持不变。唐糖的面部从背面逐渐转到侧面，背景（宝儿和林浩已完全虚化）同步旋转。

**4.5–5s：** 镜头完成 90° 弧形运镜，定格在唐糖侧面中近景（胸部到头顶），唐糖占画面约 60%，侧脸清晰。

**5–5.5s：** 唐糖眼睛微眯，瞳孔失焦无神，目光空洞地看着前方，眼眶开始微微泛红。

**5.5–6.5s：** 泪水慢慢涌出眼眶，在睫毛处停留，嘴唇微微颤抖。

**6.5–7.5s：** 泪水滑落脸颊，下颌收紧，嘴角微微下沉，整张脸呈现出一种被掏空的状态。

**7.5–8s：** 目光仍然空洞地看着前方，泪痕未干，下颌仍收紧着，嘴角仍向下压着。8 秒结束。

overall_soundscape:
夜晚街头环境音，远处车流声，风吹过街道的声音，唐糖浅浅的抽泣声。

non_diegetic_music: N/A

Negative: no other people, no exaggerated expression, no tears streaming, no sobbing, no text, no watermark, no camera static,
```

---

## 示例 C：英文版 · 需要官方完整语法时使用

以下场景必须切回英文官方写法：视频编辑 / 续写、音频复用 / 音色克隆、
多人对白需说话人 ID、台词需精确音画对齐。

> 英文版的前置块也用英文写，保持整段语言一致（不中英混写）。

```text
Image upload order:
@Image 1: Primary reference for <Subject 1>, locking face, hairstyle,
  clothing, and body type. Ignore the watermark and UI text in the source image.
@Audio 1: Voice-timbre reference for <Subject 1>.

subject_definitions:

- <Subject 1>: Tangtang, a Chinese woman in her mid-20s, brown
  shoulder-length hair parted in the middle, silver anchor earrings,
  a blue horizontal-striped short-sleeve T-shirt, and blue denim
  overalls. Her appearance follows <Picture 1> exactly. <Picture 1>
  must not show its grey studio background; the actual setting is
  replaced by a night street.

- <Subject 2>: The night street setting, with streetlamps, passing
  traffic, shopfront lights, and the city skyline. No reference
  image; defined by text only.

- <Audio 1> is the voice-timbre reference for <Subject 1> (S1).

summary:
[reference generation + audio reference] An 8-second single
continuous shot set on a night street. <Subject 1> walks along the
street while the camera tracks backwards in front of her, holding a
medium two-shot throughout. <Audio 1> provides the voice-timbre
reference for <Subject 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Tangtang's full
outfit and identity. Action chain: walking -> turning to profile ->
micro-expression shift.
<Subject 2> (appears in [Shot 1]): fully_preserved - the night
street setting.
<Audio 1>: reference - its vocal timbre guides the dialogue delivery
of <Subject 1> without copying the original signal.

detailed_description:
The target video uses a live-action cinematic night-street look
with practical streetlight sources and a slightly cool colour cast.

[Shot 1] 0-8s A medium two-shot frames <Subject 1> walking along
the night street, the camera tracking backwards in front of her at a
steady pace.

**0-3s:** She walks forward with a slight sway, her eyes on the
street ahead. The camera holds a constant distance of about two
metres in front of her.

**3-5s:** She turns her head toward the camera, her gaze lifting.

**5-7s:** <Subject 1> (S1) says in the clear youthful voice referenced from
<Audio 1>, <d>[Chinese] 今晚的月亮真圆。</d> The corners of her mouth
lift into a small smile as she speaks, then her lips close gently
as the line ends.

**7-8s:** She looks away and keeps walking. The shot ends at 8
seconds.

overall_soundscape:
Night-street ambience, distant traffic, wind moving along the street.

non_diegetic_music: N/A

Negative: no other people, no exaggerated expression, no text,
no watermark, no camera static,
```

**示例 C 比中文版多出来的三样**

| 元素 | 作用 |
|------|------|
| `[reference generation + audio reference]` | summary 任务类型前缀 |
| `<Audio 1>` + `reference` | 音频关系标记 |
| `<Subject 1> (S1)` + `<d>[Chinese] …</d>` | 说话人 ID + 对话包裹 |

---

## 示例 D：官方多镜头短剧 · 三镜头 · 15 秒 · 实战版

**适用**：短剧/MV 里最常见的「正反打 + 面向观众收尾」结构，两个人都说话。
这一版按官方 §4.2 / §4.3 / §4.4 全套语法写，校验器 **0 错 0 警（除参考图背景条件提醒）**。

```text
Image upload order:
@Image 1: Primary reference for <Subject 2> (沈怀瑾), locking face,
  hairstyle, and clothing.
@Image 2: Primary reference for <Subject 1> (温念), locking face,
  hairstyle, and clothing.
@Image 3: Environment reference for <Subject 3> (sedan rear cabin),
  locking space, colour, and light direction; the studio backdrop in
  the source image is not carried over.

subject_definitions:
<Subject 2> is the man 沈怀瑾 shown in <Picture 1>, with short black hair, faint fresh small cuts on the bridge of his nose and cheekbone, and a dusty grey-brown work jacket with small tears over a white undershirt, matching worn trousers, and rugged hands.
<Subject 1> is the young woman 温念 shown in <Picture 2>, with long loose dark hair, a worn dark navy-blue hooded sweatshirt with faded patches, blue jeans, and pale worn sneakers; she has a delicate oval face, slightly red-rimmed eyes, and natural realistic skin texture.
<Subject 3> is the rear cabin of a luxury sedan shown in <Picture 3>, with black quilted-leather seats, an illuminated starlight headliner, a wood-and-chrome rear console, and a glowing city skyline visible through the windows at dusk.

summary:
[reference generation] The target video is a 15-second photorealistic live-action Chinese short-drama dialogue scene. <Subject 2> and <Subject 1> sit together in <Subject 3> at dusk: <Subject 2> turns to gaze at <Subject 1> and tells her she deserves it, <Subject 1> tears up with a happy smile and thanks him, then <Subject 2> faces the camera and asks viewers to leave warm blessings in the comments. The three reference pictures define the two characters and the car interior; they are generation guidance only, not frame anchors.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her long dark hair, worn navy-blue hoodie, jeans, and delicate facial features are retained throughout.
<Subject 2> (appears in [Shot 1], [Shot 3]): fully_preserved - his short black hair, faint facial cuts, dusty grey-brown work jacket, and white undershirt are retained throughout.
<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the black quilted-leather seats, starlight headliner, wood-and-chrome console, and dusk city skyline are retained as the continuous environment.

detailed_description:
The target video is a photorealistic live-action Chinese short-drama scene in 8K ultra-high definition, with true-to-life skin pores and fabric weave, natural reflections and refractions in the car glass, a high-end film color grade, and no subtitles, watermarks, or logos anywhere in the frame.
[Shot 1] The scene opens inside <Subject 3>, the luxury sedan rear cabin at dusk, with a soft golden-blue city glow through the windows. A two-person side-profile medium close-up shows <Subject 2>, the man in the dusty grey-brown work jacket with faint cuts on his nose bridge and cheekbone, seated on frame right, and <Subject 1>, the young woman in the worn navy-blue hoodie with long loose dark hair, seated on frame left. The camera pushes in with small amplitude at slow speed toward the midpoint between the two subjects. <Subject 2> turns his head toward <Subject 1> on frame left and holds a deep, tender gaze on her, his rugged hands resting calmly. He speaks in a firm yet doting, steady male voice (S1), <d>[Chinese] 你值得。</d> His eyes stay warm and certain as the camera keeps drifting closer.
[Shot 2] At 00:02.500, the shot cuts to a side-profile close-up of <Subject 1>. She looks toward frame right where <Subject 2> sits just out of frame. Her red-rimmed eyes glisten, one tear slides slowly down her cheek, and a happy trembling smile spreads across her lips. A soft gentle crying sound accompanies her line. She answers in a grateful, choked-up female voice that wavers slightly between words (S2), <d>[Chinese] 谢谢你。</d> The camera holds nearly still with a barely perceptible drift as the tear reaches her jaw and her smile steadies.
[Shot 3] At 00:06.500, the shot cuts back to a frontal medium close-up of <Subject 2>. He turns his head from <Subject 1>'s direction to look straight into the camera lens, his expression sincere. He then gives a slight respectful bow of his head and upper body toward the camera and straightens halfway. Speaking directly to the audience in the same firm, doting male voice (S1) at an earnest, slightly brisk pace, he says, <d>[Chinese] 如果家人们愿意成全我们，请在评论区留下一句暖心祝福，给念念撑撑腰。</d> He finishes with a small grateful nod as the video ends on his steady gaze.

overall_soundscape:
Quiet luxury-car cabin room tone continues throughout, with a faint muffled city traffic hum outside the windows, soft leather creaks as the characters move, and the soft gentle crying sound under <Subject 1>'s line in [Shot 2].

non_diegetic_music:
A piano-and-strings score at a slow tempo, restrained in dynamics, swells gently under [Shot 2], then settles into a sustained chord beneath [Shot 3] without any dramatic climax.

Negative: no subtitles, no watermarks, no logos, no extra people, no exaggerated sobbing, no camera shake
```

**示例 D 的五个关键点**

| 点 | 写法 | 为什么 |
|----|------|--------|
| 切点递增 | `[Shot 1]` 无时间戳，`00:02.500` / `00:06.500` 递增 | 官方 §4.2 强制 |
| 说话人 ID | `(S1)` 男 / `(S2)` 女，放 `<d>` 之外，跨镜一致 | 官方 §4.4 强制 |
| 运镜三维度 | `pushes in with small amplitude at slow speed` | 官方 §4.3 |
| 台词时长 | 末镜 30 字 ÷ 4.5 ≈ 6.7s，8.5s 装得下 | 本 skill 独有校验 |
| BGM 无情绪词 | 只写乐器/速度/力度，删掉 warm / hopeful | 官方 §162 禁止 |

> **原稿的致命问题**：末镜原为 `10–15s`（5 秒）却塞了 41 字台词（需 9.1s），
> 必然导致台词被截断或语速失真。修法二选一：
> **① 砍台词**（45 字 → 30 字）；**② 重排切点**（前三镜压缩，把末镜拉到 8.5s）。
> 上面这版两个都做了。

---

## 关键规则速查表

| 规则 | 说明 |
|------|------|
| 六段式顺序固定 | subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music |
| 字段名 / 标签 / 保留标记 / Negative 用英文 | 叙述性文本用中文 |
| 节拍模式 | 对白密集用 `→`，一行一事件 |
| 时间码模式 | 表演密集用 `**0–1s：**`，最细 0.5s |
| 台词格式 | `→角色名说"台词"。`，配视线与动作 |
| 时长 4–15 秒 | 提示词 ≤ 7000 字符 |
| Ref2VA 参考上限 | 最多 9 图 + 3 视频 + 3 音频，总数 ≤ 12 |
| 角色图应在 Subject 中引用 | 不单独创建 Picture 条目 |
| 场景也需定义为 Subject | 纯文字描述的场景同样需要定义 |
| Negative 保持精简 | 不超过 10 个关键词，英文 |
| 删除所有内心独白 | 只保留可观察的动作和表情 |
| 具体动作代替情绪标签 | 「低头、抿嘴」代替「害羞」 |
| 运镜：类型 + 幅度 + 速度 | 「90° 弧形运镜，大幅度缓慢环绕」 |
| 弧形/环绕可选加轴心点 | 「以唐糖为轴心」，写为 `with Subject 1 as the pivot` |
