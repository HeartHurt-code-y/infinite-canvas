# 08 · 实战教训复盘（V1.6 新增）

> 来源：2026-09-05《橘子汽水味的夏天》高二三班教室戏（上课借笔，13s 四镜，3 图 + 音色）
> 实际生成翻车后的逐条复盘。每条都附「翻车现场 → 根因 → 修法」。

## 教训一：镜头几何不锁，模型造出「不可能构图」

**翻车现场**：生成的教室镜头里，老师正面朝镜头、学生也正面朝镜头——
机位无论在讲台还是在后排，两者不可能同时成立。

**根因（三层叠加）**：
1. 初稿写过 `facing the class`，但在**压长度的多轮修改中被删掉**，朝向指令丢失；
2. `A medium shot frames the front of the classroom` 只说了「拍哪里」（画面框住什么），
   **没说机位在哪**（镜头站在教室哪个位置）、人物面朝哪；
3. retention 写 `absolutely no other people`，正文却写 `the class settles into quiet attention`
   （必然引入全班学生）——模型为同时满足「有全班 + 老师露正脸」，
   造出「双正面」这种几何上不可能的构图。

**修法（写进正文的固定句式）**：
```text
The camera is placed at the rear of the classroom among the students, looking toward the front.
A medium shot shows <Subject 2>, standing behind the lectern at the front, facing the camera and the class.
The backs of the nearest students appear as blurred silhouettes in the foreground, with no clear faces.
```
中文版：`机位放在教室后方、学生中间，朝向教室前方拍摄。……正面朝向镜头和全班。前景学生背影呈虚化剪影，不出现清晰面部。`

## 教训二：背景人群 vs「无其他人」是自相矛盾

场景天然含群众（教室全班、街道行人、餐厅食客）时：
- retention **不许**写 `no other people` / `absolutely no other people`；
- 改写为：`背景人群全程虚化、无清晰面部、不开口说话`
  （英文：`any background people stay blurred with no clear faces and never speak`）；
- Negative 用 `no sharp background faces`，**不用** `no other people`；
- 正文删掉必然引入清晰群众的句子，或与上述声明配套使用。

## 教训三：压长度不许删「几何/一致性锚点」

多轮压缩后翻车的直接推手是删错了东西。**压缩保护清单（删修饰词，不删这些）**：
- 机位与人物朝向
- 光源方向与色温
- 说话人 ID 与台词归属
- 参考图去污染声明
- 背景人群处理方式

可以先删的：重复的形容词、summary 与 detailed_description 的重复信息、
语气副词、可从图片推断的外观细节。

## 教训四：英文版不是默认，是条件触发

**只有三种情况必须整段切英文官方版**：
1. 有音色参考 / 音频复用（`<Audio N>` + timbre 标记）；
2. 需要精确音画对齐；
3. 台词跨切镜（需 `<scenetrans>`）。

**纯图片参考 + 多人对白，中文版完全够用**：说话人归属由「→角色名说"……"」承载，
不需要 (S1)/(S2)。用户拿英文版问「为什么是英文」时，先检查这三条是否真的命中。

## 教训五：删 `<Audio N>` 要四处全清

去掉音色参考时，漏一处就会报 `LBL-UNDEF` 判错：
1. 前置「图片上传顺序」块里的 `@Audio N` 行；
2. `subject_definitions` 里的 `<Audio N> is the voice-timbre reference for ...`；
3. `retention_analysis` 里的 `<Audio N>: reference - ...` 行；
4. `detailed_description` 里所有 `using the voice timbre referenced from <Audio N>` 措辞
   → 改为普通形容词直述（`in an even, gentle middle-aged female voice`）；
5. summary 前缀 `[reference generation + audio reference]` → `[reference generation]`；
6. summary 正文里的 `with the voice timbre referenced from <Audio N>` → 直接写音色特质。

## 教训六：中文版多镜头的两处格式坑（校验器实测）

1. **台词行必须独立成行、行首 `→`**：`→班主任说"大家开始上课。"` 单独占一行。
   嵌在段落中间（`……开口。→班主任说"……"`）校验器解析不到，报 `DLG-FMT`；
   音色/语气描述放在 `→` 行之前的叙述句里。
2. **切点时间戳统一写 `At 00:03.000`**：中文叙述也保留英文 `At`
   （`At 00:03.000，镜头切至……`）。写成「在 00:03.000」解析不出切点，
   全部镜头按 0s 起点，报 `SHOT-NOEND`。

## 附：本次修复前后对照

| 项 | 翻车版 | 修复版 |
|---|---|---|
| Shot 1 机位 | `A medium shot frames the front of the classroom` | `The camera is placed at the rear of the classroom among the students, looking toward the front` |
| 老师朝向 | 无（初稿的 facing the class 被压缩删掉） | `standing behind the lectern, facing the camera and the class` |
| 前景学生 | 无声明 → 模型渲染成正面全班 | `backs ... blurred silhouettes in the foreground, with no clear faces` |
| retention | `absolutely no other people` | `background classmates stay blurred with no clear faces and never speak` |
| Negative | `no other people` | `no sharp background faces` |
| 语言 | 英文（音色触发） | 中文版为主，音色版存档 |
