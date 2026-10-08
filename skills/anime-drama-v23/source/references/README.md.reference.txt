# references 目录说明

本目录存放 drama-auto-pipeline skill 的辅助脚本与参考资料。

## 🆕 V2.0 · 自包含分发（铁律 G 组）

**这个 skill 的压缩包解压即可用，不需要安装任何其他 skill。** 机制在 `references/deps.py`：

| 文件 | 作用 |
|---|---|
| `references/deps.py` | **跨 skill 依赖的唯一入口**（定位器）。所有「找校验器 / 找执行器 / 找凭证」都走它 |
| `vendor/` | **随包内置的依赖副本**（h3 校验器 ×2、项目模型 执行器 ×1）+ `MANIFEST.json`（来源 skill / 来源版本 / sha256） |
| `tools/doctor.py` | **环境自检**：查 Python / ffmpeg / git / 字体 / 可选包 / 凭证，缺什么就给出**可直接粘贴给 项目模型** 的安装话术 |
| `tools/scan_paths.py` | **打包前绝对路径门禁**（`snapshot.py` 自动调用；工作区 + 包本体各扫一遍） |
| `00-新电脑部署.md` | **新电脑从零部署五步**（含三平台路径模板、冒烟验证三条命令） |

三条铁律（详见 `SKILL.md` 铁律 G 组）：

1. **G1** 跨 skill 依赖一律「内置副本 + 定位器」，**禁止硬编码本机绝对路径**
2. **G2** 默认**内置副本优先**；要用外部已装的版本必须显式 `DRAMA_USE_EXTERNAL=1`；
   依赖缺失**不许静默降级**（宁可报错，也不能「看起来跑过了其实没校验」）
3. **G3** 凭证必须落成**代码能读到的文件**（五级读取链），只写记忆 = 下次一定还会再问

一条命令看现状：

```bash
python references/deps.py --describe    # 每个依赖现在用的到底是哪一份 + 来源
python references/deps.py --selftest    # 9 项机制自检
python tools/doctor.py                  # 环境自检（缺什么 → 给出安装话术）
```

## 文件清单（V2.0）

### 项目模型_image_runner.py
项目模型 图像生成 API 运行器（纯标准库，无外部依赖）。

**实测数据（2026-09-12）**：
- 模型 ID：`zhenzhen-image-g-v2-lowprice`（注意 v2，不是 v2.5）
- 单价：¥0.04/张（1k 分辨率）
- 耗时：约 30 秒/张
- 结果 URL 24h 有效
- **必须伪装浏览器 UA**，否则 Cloudflare 拦 Python 默认 UA 返回 403

### voice_designer.py 🆕 V0.3
音色设计能力 音色设计运行器。工作流 ID `PROJECT_MODEL_BINDING`。

**节点映射**：
- node 8 `prompt` = 台词文本（3~5 秒量）
- node 9 `prompt` = 音色描述（中文自然语言，如"24 岁温柔女咖啡店主，中音偏暖带一点鼻音"）

**用法**：
```bash
python voice_designer.py --project_provider_setting $项目模型_project_provider_setting \
  --char-id char_01 \
  --voice-desc "24岁温柔女咖啡店主..." \
  --sample-text "你好，欢迎来到屿间咖啡。" \
  --output char_01/voice/voice_sample.mp3
```

### consistency_auditor.py 🆕 V0.3
一致性审核器（本地重模型路线）。

**判决维度**：
- 人脸一致性：insightface，阈值 > 0.75
- 音色一致性：resemblyzer，阈值 > 0.70
- 场景一致性：SSIM + 主色（scikit-image + PIL），阈值 > 0.65
- 道具一致性：VLM 判图（调子 Agent）

**用法**：
```bash
python consistency_auditor.py \
  --shot-dir "视频/shot_01_开场还伞" \
  --project-root <项目根>
```

输出 `audit/audit_result.json`。

### audit_html_builder.py 🆕 V0.5.6
6 个审核 HTML 页面生成器（剧本/资产/分镜/**提示词**/视频/成片）。单文件零依赖、深色影院风、内嵌播放器/图片/音频。

**用法**：
```bash
python audit_html_builder.py --project-root <项目根> --stage assets
# stage ∈ script / assets / storyboard / prompt / video / final
```

输出到 `审核/` 目录（关号与编号严格对应：关1↔01 … **关4↔04_提示词审核** … 关6↔06_成片审核）。

`--stage prompt` 的页面读 `状态/prompt_review.json`，含：分辨率复核区块 / 参考图与音色槽位
（与 `<Picture N>`/`<Audio N>` 同序，缺文件显红）/ 机检 8 项明细 / 官方校验器结果 / 可编辑提示词。

### batch_run_drama.py
短剧批量驱动器（基于 batch_run_rh.py 改造）。

**V0.3 新增**：
- `--project-root` 模式：自动从 `角色资产/char_<id>_*/` 读图和音色
- 每段独立目录：`视频/shot_NN_<关键词>/{output.mp4, refs/, audit/, prompt.txt, log.json, review.html}`
- `--only N` + `--new-seed`：单段重抽卡
- `speaker_char_id` 字段优先于旧 `voice_ref`

**用法**：
```bash
# V0.3 项目模式（推荐）
python batch_run_drama.py --project_provider_setting $项目模型_project_provider_setting \
  --project-root <项目根> \
  --storyboard <项目根>/分镜脚本/storyboard.json \
  --aspect "16:9 (Widescreen)" --workers 5 --instance-type plus

# 单段重抽
python batch_run_drama.py --project_provider_setting $项目模型_project_provider_setting \
  --project-root <项目根> \
  --storyboard <项目根>/分镜脚本/storyboard.json \
  --only 5 --new-seed
```

## 待补充

- `references/subagent_prompts/`：主 Agent 派子 Agent 的任务模板（script_writer / asset_designer / storyboard_writer / h3_translator / consistency_auditor / video_generator / reshooter）

## V0.4.1 新增（2026-09-13）

### build_multi_ref_workflow.py
把单参考图 RH B2 工作流改造成多参考图版。

**用法**：
```bash
python build_multi_ref_workflow.py \
  --orig workflow_b2_original.json \
  --out workflow_b2_multi_ref.json \
  --num-images 5 --num-audios 3
```

**产物**：`workflow_b2_multi_ref.json`（37 节点 vs 原 31 节点，加 4 个 LoadImage + 2 个 LoadAudio）

### workflow_b2_multi_ref.json
**5 张参考图 + 3 个音色**的改造版工作流。挂在 `MiniMaxH3ReferenceToVideo` 节点的：
- `ref_images.ref_image_0` ~ `ref_images.ref_image_4`（节点 326/1326/1327/1328/1329）
- `ref_audios.ref_audio_0` ~ `ref_audios.ref_audio_2`（节点 340/1340/1341）

**配套**：`batch_run_drama.py` 加 `--multi-ref-workflow` 参数启用。

## V0.5.5 新增 / 修改（2026-09-13）

### ⚠️ 未使用的槽必须断开（铁律 D8）

5 图槽 + 3 音色槽里**没用到的槽必须整条断开**，否则会带着工作流作者上传的默认素材一起提交：
多余的占位音频 → 输出全是杂音；多余的占位人像 → 主角不像本人。

驱动器已自动处理（`plan_ref_slots()` / `plan_audio_chars()` 同源产出槽位计划，
未用槽 `pop` 掉 265 的 `ref_*` 键并 `del` 掉对应 `LoadImage`/`LoadAudio` 节点）。
实测：3 图 + 2 音色时，节点数 37 → 34。

### 采样参数（2026-09-13 用户指定，测流程用）

- node 337 `ResolutionSelector.megapixels`：0.5 → **0.2**（一采分辨率）
- node 335 `easy float.value`：2 → **1**（二采放大倍数，被 node 140 `mode.scale` 引用）

> 这两个值是**测试档**（低分辨率 + 不放大），正式出片前要调回 0.5 / 2。

### batch_run_drama.py V0.5.5 变更

- **多说话人**：新增 `seg_dialogue()`（读 `dialogue` 数组，退回 `narration` 兼容）；
  `gen_drama_prompt` 逐句渲染官方英文框架（V1.9）`→顾砚辞用 <Audio 1> 的音色 (S1) says: <d>[中文]…</d>`
  （一句一行；六类有声源见 SKILL.md 铁律 A6；旧式「音色说"…"」已停用）
- **混合版语言**：字段名/标签/保留标记/Negative/`(S1)` ID 英文，叙述层与台词中文
- **说话人 ID 稳定**：`(SN)` 与 `<Audio N>` 编号锚在 `<Subject N>` 上（角色按 `char_NN` 升序），跨段不漂移
- **多音色**：新增 `resolve_audios()`，每个在场角色一条 `<Audio N>`
- **槽位同源**：`plan_ref_slots()` / `plan_audio_chars()` 同时驱动提示词与上传顺序，避免 `<Picture N>` 错位
- **缺文件立刻抛错**：计划内素材缺文件不再静默跳过
- **dry-run 输出**：改为显示「句数 / 字数 / 说话人」而非单一 narration 长度

### batch_run_drama.py V0.5.6 变更（审核关 4 · 视频提示词审核门禁）

**新增参数**：

| 参数 | 作用 |
|---|---|
| `--dump-prompts` | 审核关 4 第一步：生成每段 `prompt.txt` + `prompt_audit.json` + `状态/prompt_review.json` + `审核/04_提示词审核.html`（**零 API、零算力**） |
| `--approve-prompts` | 第二步：用户审过 04 页后标记通过（**必须同时给 `--confirmed-resolution`**） |
| `--confirmed-resolution` | 与用户复核确认的分辨率描述，如 `"16:9 1080P · 一采 0.2 MP · 二采 ×1"` |
| `--skip-prompt-approval` | [危险] 跳过门禁，仅调试用 |

**标准流程**：
```bash
# ① 生成审核产物
python batch_run_drama.py --project-root <项目根> \
  --storyboard <项目根>/分镜脚本/storyboard.json \
  --multi-ref-workflow references/workflow_b2_multi_ref.json \
  --aspect "16:9 (Widescreen)" --dump-prompts
# ② 用户审完 04 页 → 确认
python batch_run_drama.py --project-root <项目根> \
  --storyboard <项目根>/分镜脚本/storyboard.json \
  --aspect "16:9 (Widescreen)" --approve-prompts \
  --confirmed-resolution "16:9 1080P · 一采 0.2 MP · 二采 ×1"
# ③ 正常批量生成（门禁自动生效）
```

**新增函数**：`plan_ref_locals()`（纯本地槽位解析，`for_review` 开关；审核与实跑共用同一份
→ 审核页顺序 == 真跑上传顺序）、`run_h3_validator()`、`_en_ratio()`、`audit_prompt_machine()`
（机检 8 项 = D5 五条 + S1/S2/S3）、`workflow_resolution_summary()`、`prompt_sha1()`、
`dump_prompt_review()`。

**门禁校验项**（`batch_run_drama.py` 提交视频前硬校验，任一不满足 `sys.exit`）：
1. `状态/prompt_review.json` 存在
2. 整体 `status ∈ {approved, partial}`，且逐段 `status == approved`
3. `resolution_confirmed == true`
4. `aspect` 与本次一致
5. 工作流分辨率档位（一采 MP / 二采 ×倍数）未变
6. **逐段提示词 sha1 与审核时一致**（审了 A 却要跑 B → 拦）

**两个已修缺陷**：① 门禁原本排在 `--only` 清状态**之后**（被拦下时 done 状态已被清掉）→
改为门禁前置；② `--approve-prompts` 检测到提示词变动时原本会**改写 sha1**（等于默许下次直接
放行）→ 改为拒绝放行且不改写，强制重跑 `--dump-prompts`。

**踩坑提醒**：改了提示词就必须重跑关 4（sha1 门禁会拦），这是**设计如此**，不是 bug。

### V0.5.7 资产图规范（铁律 A7）

- **角色图**：只出**半身正面照**、比例 **3:4**、背景**纯白**；禁止三视图/全身/场景元素
- **场景图/道具图**：**严禁出现任何人**（`no people, no humans, empty scene`）——
  场景图里画了人，模型会把这些人的脸/服装迁移到生成视频里，覆盖角色参考图的锚定
  （2026-09-13 实测：食堂图画了穿蓝白运动校服的男生 → 段 4 男主被带成同款）

### 交付前校验（必跑）

校验器是**随包内置**的（`vendor/`，V2.0 自包含机制），所以命令里**不写本机绝对路径**：

```bash
# 在 skill 根目录下跑（<SKILL> = 你解压后的 drama-auto-pipeline 目录）
python "<SKILL>/vendor/h3-ref2va-optimizer/scripts/validate_ref2va.py" \
  prompt.txt --duration 15
python "<SKILL>/vendor/h3-ref2va-optimizer/scripts/validate_ref2va_local.py" \
  prompt.txt --duration 15 --cross-shot          # R37 跨镜段用这条
```

不知道 `<SKILL>` 在哪、或想让脚本自己找（内置优先、外部可选）：

```bash
python references/deps.py                 # 打印「现在用的是哪一份校验器」
```

目标 **0 错误 0 警告**。《橘子汽水味的夏天》第二集 5 段已全部达标。

⚠️ **去污染句必须紧跟各自的 `<Picture N>`**（同一逻辑行内）。
写成独立的「每个 `<Picture N>` …」块会被校验器漏判
（实测 `<Picture 3>` 的匹配会把 `<Picture 1>` 一起吃掉）。
