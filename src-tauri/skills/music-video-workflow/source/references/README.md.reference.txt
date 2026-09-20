# references 目录说明

本目录存放 mv-auto-pipeline 的全部执行脚本。**10 个脚本 + 1 份注册表 + 1 份真实工作流 JSON**，
除 `ffmpeg`（音视频裁切/贴合/合成）与本机可选的 ASR 后端外，**全部纯标准库、零 pip 依赖**。

## 文件清单

| 文件 | 对应阶段 | 作用 | 主要产物 |
|---|---|---|---|
| `mv_workflows.json` | 阶段〇 | 工作流注册表：节点契约 / 分辨率默认值 / 17 帧对齐公式 | —— |
| `mv_workflow_api.json` | 阶段〇 | 从 project_provider 拉回的真实工作流 JSON（30 节点，整包直传用） | —— |
| `rh_client.py` | 阶段〇 · 十二 | project_provider API 客户端 | —— |
| `extract_lyrics.py` | 阶段一 | 歌曲探测 + ASR（四路降级） | `状态/lyrics_asr.json` |
| `align_lyrics.py` | 阶段一 | 歌词 ↔ 时间轴**强制对齐**（关 1） | `状态/lyrics.json` · `审核/01_歌词时间轴审核.html` |
| `plan_mv_storyboard.py` | 阶段三 | MV 分镜规划（窗口切分 + 口型分配） | `分镜脚本/storyboard.json` |
| `mv_to_h3_prompts.py` | 阶段五 | 分镜 → 项目视频模型 六段式提示词 + 机检 11 项（关 5） | `视频/shot_NN_*/prompt.txt` · `状态/prompt_review.json` |
| `build_mv_workflow.py` | 阶段七 | 工作流拉取 / 体检 / 改造（图槽、断参考） | `references/mv_wf_<key>_modified.json` |
| `batch_run_mv.py` | 阶段八~十 | 批量驱动（双门禁 + 提交 + 轮询 + 时长贴合 + 双成片） | `视频/shot_NN_*/output.mp4` · `成片/final*.mp4` |
| `check_alignment.py` | 关 6 · 关 8 | 窗口规划校验 + 音画对齐三验 | `审核/06_*.html` · `审核/08_*.html` |
| `audit_html_builder.py` | 全程 | 8 关审核页 + 全链总览 生成器 | `审核/*.html` |

> ⚠️ 所有脚本都以 `--project-root` 为**唯一入口**，产物一律落在项目根下，
> 不在 skill 目录里写任何东西（skill 目录是只读的"程序"，项目目录才是"数据"）。

---

## 三个必须记住的实现要点

### ① 17 帧对齐公式（`plan_mv_storyboard.py::align_frames`）

```python
def align_frames(sec):
    f = max(5, round(sec * 24))                 # 24fps，下限 5 帧
    return (f + (5 - f % 17) % 17) / 24.0       # 向上取到最近的 17 帧网格
```

项目视频模型 的实际出片长度被**量化到 17 帧网格**，所以「请求 12s」拿到的是 `12.25s`，
「请求 6s」拿到的是 `6.58s`。请求时长必须先过这个公式，否则后面必漂。

### ② 时长贴合 conform（`batch_run_mv.py::conform`）

```bash
# 裁：目标比实际短
ffmpeg -i src -t <target> -c:v libx264 -an dst
# 补：目标比实际长 → 克隆尾帧（不重复整段、不黑屏）
ffmpeg -i src -vf tpad=stop_mode=clone:stop_duration=<d> -t <target> -c:v libx264 -an dst
```

**为什么必须有这一步**：请求 12s 实得 12.25s，一条 3 分钟的 MV 有 18 段左右，
不裁就累出 4.5s 的偏移——嘴巴会越来越对不上。裁/补之后 **Σ各段 = 全曲长**，
各段首尾相接即天然对齐。写入用「先写 tmp 再 `os.replace`」，避免半截文件。

### ③ 对齐三验：包络 + 局部搜索（`check_alignment.py`）

**不要对整首歌做互相关。** 8kHz 单声道 213s ≈ 1.7M 采样，全量互相关是十亿级运算，
纯 Python 跑不动、numpy 又违背零依赖。

做法：降到 **RMS 包络 10 帧/秒**（`SR=8000, HOP=800`），再在期望位置 **±1.5s 局部搜索**
（`for off in range(-15, 16)`），运算量降到万级，秒级出结果。三项判据：

1. **时长**：`Σ段长 == 曲长`（容差 0.05s）
2. **RMS 包络局部相关**：最佳滞后 ≈ 0s、相关系数达标
3. **人声能量非空**：确认这一段真的有唱（而不是静音或纯伴奏被当成人声段）

### ④ 母带必须**本体**注入音频加载节点（`batch_run_mv.py::song_path` / `upload_cached`）

`music_mode=offset` 只注 node 85 的「起点 + 时长」，**并不会有声音**——因为声音的来源是
node 34 `LoadAudio` 里的那个文件，而它默认是工作流作者放的**示例 mp3**。
不替换 = 窗口取对了、歌是别人的（本项目实测：整片 22 段全废）。

所以：**与 music_mode 无关，母带都要原样注进 node 34**，且全片**只上传一次**
（sha1 指纹 → `状态/素材上传台账.json`）；参考图同理走同一个缓存。

⚠️ 台账缓存前必须判断「这个值是真结果还是『还没做』的标记」：RH 的 `fileName`
永远形如 `api/<hash>.<ext>`，**以 `<` 开头的一定是占位串**，必须重传而不是直接注入。

### ⑤ 空镜段必须摘图槽连线 + 整包直传（`batch_run_mv.py::bake_workflow`）

原工作流 node 36 里挂着**一张示例人物图**。段内本来不需要参考图时（空镜 / 纯环境段），
若只走 `nodeInfoList` 注入，那张示例图会被当成本段参考 → **空镜画面里冒出别人的脸**。

这类段必须：① 把 `nodeInfoList` **烧进**工作流 JSON；② 摘掉所有「指向图槽节点」的连线；
③ 用 `workflow` 参数**整包直传**（`rh_client` 在给了 `workflow` 时**根本不发 `nodeInfoList`**，
注入只有烧进 JSON 才生效）。

烧之前顺手剥掉本地 API JSON 里的 `_meta`（节点标题，**真 API 格式没有这个键**，
带着它直传可能被平台判非法字段）。

---

## 各脚本用法

### extract_lyrics.py · 歌曲探测 + ASR

```bash
# 只探测（看时长/采样率/声道，不跑 ASR）—— 首问阶段就能用
python references/extract_lyrics.py --project-root <项目根> --probe

# 跑 ASR（backend=auto 时按 faster-whisper → whisper-cli → whisper.cpp → api 依次降级）
python references/extract_lyrics.py --project-root <项目根> \
  --song <项目根>/音乐/song.mp3 --language zh --model-size medium --device cpu

# 用 OpenAI 兼容接口兜底
python references/extract_lyrics.py --project-root <项目根> \
  --backend api --api-base $ASR_API_BASE --api-key $ASR_API_KEY --model whisper-1
```

四路后端全失败时**不静默失败**，会打印三条明确的安装指引。

### align_lyrics.py · 歌词强制对齐（关 1）

```bash
# 推荐：官方歌词定文本 + ASR 定时间，字符级 Needleman-Wunsch 全局对齐
python references/align_lyrics.py --project-root <项目根> \
  --asr <项目根>/状态/lyrics_asr.json \
  --official <项目根>/音乐/lyrics_official.txt \
  --song <项目根>/音乐/song.mp3

# 有现成 LRC：直接转（无需 ASR）
python references/align_lyrics.py --project-root <项目根> \
  --lrc <项目根>/音乐/song.lrc --song <项目根>/音乐/song.mp3

# 只复核不改数据（用户手工改过 lyrics.json 之后跑这个）
python references/align_lyrics.py --project-root <项目根> --qc-only
```

- `--min-hit`（默认 0.55）：单行命中率低于此值 → 标 `review_needed`，**必须人工确认**；
  这是防「听写错字污染歌词」的关键闸门。
- `--gap`（默认 2.0）：空档超过该秒数 → 显式插入 `[instrumental]` 行。
  **间奏决定分镜切点**，不标出来分镜就会把间奏算成唱段。

### plan_mv_storyboard.py · MV 分镜规划（阶段三）

```bash
python references/plan_mv_storyboard.py --project-root <项目根> \
  --target-dur 11 --min-dur 4 --max-dur 15 \
  --sync-ratio 0.45 --max-consec-sync 3

# 先看看会切成什么样，不落盘
python references/plan_mv_storyboard.py --project-root <项目根> --dry-run
```

- **切点只落歌词行尾**：宁可某段略超 `--target-dur`，也不切半句。
- 景别白名单：`SHOT_SYNC = {ECU, CU, MCU, MS}`（可对口型）·
  `SHOT_NOSYNC = {MS, MLS, LS, WS, EMPTY}`（不可）。
  注意 `MS`（中景）在两边都出现——这是**有意**的：中景是边界景别，
  按用户拍板「特写+近景+中景 算」，中景归入可对口型，但抽样时优先给近景。
- `--sync-ratio 0.45` 是**目标**不是硬约束：先按等距抽样铺开，再受 `--max-consec-sync` 压制。

### mv_to_h3_prompts.py · 分镜 → 项目视频模型 提示词（关 5）

```bash
# 第一步：生成提示词产物（零算力、零 API）
python references/mv_to_h3_prompts.py --project-root <项目根> \
  --lang zh --acting-mode auto --dump-prompts

# 第二步：用户审过 05 页后放行
python references/mv_to_h3_prompts.py --project-root <项目根> \
  --approve-prompts --confirmed-resolution "9:16 竖屏 · 档位 2"
```

**发声行格式**（唱歌，不是说话）：

```
→沈鸾音 (S1) sings: <d>[中文]明月照我一身霜雪</d>
```

框架词 `sings:` 用官方英文原文，`<d>[语言]` 标语言，内容用中文；
**一句台词独立成行**，行首统一 `→`。合唱写 `(S1,S2) sings:`。

**`no_sync` 段零 `sings:` 行**，改为写声明：

```
本段人物**不对口型**：嘴唇保持自然闭合，或只做与歌词无关的日常动作（呼吸、吞咽、微笑、说话前吸气），
不得跟随音乐人声开合。
```

并在 Negative 里压 `no lip sync, no mouthing lyrics, no extra vocals`。

**MV 全片禁用 `<Audio N>`** —— 声音全部来自歌曲母带（工作流切窗注入），
写 `<Audio N>` 会 `LBL-UNDEF`，且与「母带为准」自相矛盾。

机检 11 项 = S1~S7（结构）+ M1~M4（MV 专用），明细见 SKILL.md 阶段五。

### build_mv_workflow.py · 工作流拉取 / 体检 / 改造（阶段七）

```bash
# 一条命令接入真实契约（拿到 API Key 后跑这个）
python references/build_mv_workflow.py --fetch --inspect --write-registry

# 只看某一个节点（例如确认 85 到底叫 clip_start 还是 start_time）
python references/build_mv_workflow.py --fetch --inspect --node 85

# 不想走网络：拿本地导出的 API 格式 JSON
python references/build_mv_workflow.py --src <导出的 workflow.json> \
  --inspect --write-registry

# 改造落盘（--image-slots N 增减图槽；--drop-refs 才会真的断连线）
python references/build_mv_workflow.py --build --image-slots 2 --out <项目根>/工作流/mv_modified.json
```

- `--inspect --write-registry` 会把猜到的字段名回写 `mv_workflows.json`，
  但**不会**自动把 `contract_verified` 置 true——必须人眼确认过才算数（铁律 D4）。
- 未使用的槽位默认断开；`--drop-refs` 是真断开连线，危险，必须显式给。

### batch_run_mv.py · 批量驱动（阶段八~十）

```bash
# 干跑：把注入计划全打出来，一行不发（强烈建议先跑）
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential --dry-run

# 真跑
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential \
  --workflow MV-1 --workers 5 --instance-type plus

# 单段重抽卡
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential --only 5 --new-seed

# 只出片段、先不合成
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential --no-compose

# ⚠️ 授权「消费级被占 → 自动改用企业级」= 拿真钱换速度（默认关闭，必须显式开）
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential \
  --api-key-e $project_credential_E --allow-enterprise-fallback

# ⚠️⚠️ 双池并行（V1.0.4）：两把 key **同时**开跑，墙钟约减半；企业级那份是真钱
python references/batch_run_mv.py --project-root <项目根> --api-key $project_credential \
  --api-key-e $project_credential_E --enterprise-parallel --enterprise-parallel-max 8 \
  --workers 5 --workers-e 5 --instance-type plus
```

**提交前硬门禁**（关 5 + 关 6，任一不满足直接 `sys.exit`，**零算力**）：
提示词 `prompt_review.json` 齐备且逐段 approved、sha1 与审核时一致、
音乐窗口首尾相接且 Σ = 曲长、口型段景别在中近景、每段时长在 [4,15]。
`--dry-run` 下门禁问题**只提示不拦截**（方便排障），真跑才拦。

**四类注入**：`87` 提示词文本 · `85` 音乐窗口（start/dur）· `61` 分辨率 · `42` 图片，
外加 `seed`。上传图片拿到的键是 **`fileName`**，不是 `download_url`。
⚠️ 还有第五类、最容易漏的一类：**母带本体 → `34` LoadAudio.audio**（见实现要点 ④）。

**账号与续跑（V1.0.3）**：
- **在途 `submitted` 段走 rescue，绝不重新提交**（有 `taskId` 就先轮询它）→ 不双倍烧币。
- **企业级降级必须显式授权**：`--api-key-e` 只是"给凭证"，
  `--allow-enterprise-fallback` 才是"同意花钱"——**两者不能互相推定**。
- 降级只对"池子被占"类错误生效（`DEGRADE_PAT`），自己的 bug 不降级；连续 3 次降级失败即熔断。
- 每次降级写 `状态/调度日志.csv`（含**计费口径**），否则事后算不清「烧的是币还是钱」。
- 离线单测：`python examples/test_account_fallback.py`（零算力、零网络）。

**双池并行（V1.0.4）**：
- `--enterprise-parallel` 是**第三个独立开关**：提供凭证 / 授权降级 / 授权并行，**三者互不推定**。
- 一个**共享队列** + 两条车道同时抢（`--workers` ∥ `--workers-e`）；
  不用「对半切开」是因为单段耗时 600~900s 差得远，静态对半必然一条车道空转。
- `--enterprise-parallel-max N` = **真钱封顶**（最多 N 段走企业级，用完车道退役、余下回消费级）；
  不设就是不限，开跑前会打印最坏 / 对半两档预估（≈ **¥1.21/段**）。
- **池满 = 没烧钱** → 段**放回队列**重试，不记 `failed`；且池满**不走降级**
  （本车道改走真钱 = 消费级一被占就把整片甩给企业级）。
- 「可重试」≠「可降级」：`TRANSIENT_PAT` 才算瞬时；余额不足 / `APIKEY_INVALID` 不算。
- 车道退役后**必须有队列兜底**（回落消费级跑完）—— 否则那几段既没跑也没记 failed，
  **成片短一截而账面正常**。
- 池满**不会挂死**：判据是「等了多久」而不是「错了几次」（`BUSY_GIVE_UP_SEC`，默认 30 分钟），
  且**两条车道一视同仁**；等够了就退役并把队列交给兜底路径。
- 离线单测：`python examples/test_parallel_lanes.py`（零算力、零网络）。

### check_alignment.py · 关 6 + 关 8

```bash
# 关 6：窗口规划校验（不碰音频，秒出）
python references/check_alignment.py --project-root <项目根> --plan

# 关 8：对齐三验（真的去读音频算包络）
python references/check_alignment.py --project-root <项目根> --verify --max-lag 1.5
```

`--verify` 会生成 `审核/08_成片审核.html`，逐段列出「时长 / 最佳滞后 / 相关系数 / 人声能量」。

### audit_html_builder.py · 审核页生成器

```bash
# 全部 9 张（8 关 + 全链总览）
python references/audit_html_builder.py --project-root <项目根> --stage all

# 只出某一关
python references/audit_html_builder.py --project-root <项目根> --stage prompt
# stage ∈ lyrics/style/cast/storyboard/prompt/music/video/final/overview/all
```

页面里所有图片/视频路径一律 **`file:///` 绝对路径**（相对路径在部分浏览器下不加载）。
未生成的文件渲染成灰底「未审」，不会静默省略。

---

## project_provider 口径坑（已踩过，别再踩）

| 坑 | 现象 | 正解 |
|---|---|---|
| 参数名大小写 | `/uc/openapi/accountStatus` 传 `apiKey` 一直报鉴权失败 | 是 **小写 `apikey`** |
| `code=804` | `getOutputs` 拿到 `data` 是 dict 不是 list，解析崩 | 804 = `APIKEY_TASK_IS_RUNNING`，轮询到真 list 为止 |
| 素材注入键 | 用 `download_url` 注入 → 节点读不到图 | 上传返回的键叫 **`fileName`** |
| 产物有效期 | 过一天再下载 404 | 产物 URL **仅 24h 有效**，出片即刻下载落盘 |
| **FAILED 不给原因** | 报错只有 `任务失败: code=0 msg=success`，等于没报 | status 端点失败时**只回状态码**；真实原因在 `/task/openapi/outputs`（`code=805 APIKEY_TASK_STATUS_ERROR`）的 `data.failedReason` → 用 `fetch_failure()` 自动回挖 |
| **台账缓存住「未完成」** | 节点报 `Invalid audio file: <上传:song.mp3>` | 台账里的 `<...>` 是**占位标记不是真 fileName**；`upload_cached()` 已加 `<` 前缀守卫，判「未上传」并重传 |

---

## 计费口径

| 实例 | 单价 | 说明 |
|---|---|---|
| 消费级（默认） | 0.4 供应商报告费用 / 秒**耗时** | 按 `taskCostTime` 墙钟秒计，与视频时长无关 |
| 企业级 | ¥6 / 小时耗时 | 按秒扣**钱包真钱**；`--allow-enterprise-fallback`（失败降级）或 `--enterprise-parallel`（双池并行）才启用 |

消费级被占满、且用户已授权时才会降级企业级，并在 `状态/调度日志.csv` 留痕。

⚠️ **两把 key 指向同一个钱包**：`apiType=NORMAL`（消费级）与 `apiType=SHARED`（企业级）
实测 `remainCoins` / `remainMoney` 完全相同 —— 所以「双池并行」烧的不是两笔独立预算，
而是**同一钱包里的币 + 真钱**。逐段账单看 `状态/成本台账.csv` 的
「账号」列（consumer / enterprise）与「**钱包元**」列。

⚠️ `accountStatus` 的 `currentTaskCounts` = **此刻正在跑的任务数**，不是并发额度；
账号并发上限**没有接口能读**，只能靠「池满就放回队列」自适应兜住。

### 凭证配置（★ V1.0.6：**四级读取，永不问用户要 key**）

```ini
# 消费级：走 供应商报告费用，不扣钱包真钱（默认用它）
project_provider_API_KEY=<consumer key>
project_provider_API_KEY_C=<同上，别名>

# 企业级：⚠️ 不走 供应商报告费用，按秒扣钱包真钱 —— 只在获得用户明确同意时用
project_provider_API_KEY_E=<enterprise key>

# 其他视频网关（可选；项目模型 / 项目模型等）
项目模型_API_KEY=<key>
项目模型_API_BASE=[项目内资源]
```

**放哪里**（优先级由低到高）：

| 位置 | 作用 |
|---|---|
| `~/.project_provider/credentials/mv-auto-pipeline/keys.env` | ★ **用户级凭证** · 跨项目永久生效（默认就位，新项目零参数可跑） |
| `<项目根>/.env` | 项目级覆盖（不同项目用不同账号时才建） |
| 真实环境变量 | 最高，**永不被文件改写**（`bash export` 在 PowerShell 子进程里读不到，故不能只靠它） |
| `--api-key` / `--api-key-e` | 仅当次有效，用于临时换账号 |

`rh_client.load_dotenv(project_root)` 把它们读进 `os.environ`；`resolve_key()` 带 **self_heal**
（无条件加载），调用方忘了 `load_dotenv` 也读得到。`enterprise_key()` 同级，两处入口都自愈。

🔒 **凭证不进 skill 目录、不进 git** —— skill 包必须保持可分发、不含任何 key。

诊断（不打印 key 本体，只报「有没有 + 从哪来」）：

```bash
python -c "import sys; sys.path.insert(0,'references'); import rh_client as r; [print(x) for x in r.credential_report('.')]"
```

自证「换新项目也不会再问用户要」：`python examples/test_credentials.py`（22 条断言）。

> ⚠️ **记在 `MEMORY.md` 里不算修好，代码能读到才算修好。**
> 2026-09-17 用户质问「我不是说了把这些key永久记住吗，怎么还找我要？」——
> key 早在 2026-09-14 就永久写进记忆了，但 `load_dotenv` 只认「当前项目目录下的 `.env`」，
> 换个项目就报缺 key。详见 SKILL.md 铁律 **D12**。
