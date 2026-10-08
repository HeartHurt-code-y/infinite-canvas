# tools/ · skill 自我进化与回退

这套工具解决一件事：**让 skill 在每支 MV 里持续进化，同时又永远退得回去。**

| 文件 | 作用 |
|---|---|
| `snapshot.py` | 一次进化结束时的唯一收尾动作：跑回归自检 → 追加 `CHANGELOG.md` → 打 zip 快照 → git commit + tag |
| `rollback.py` | 列出/退回任意历史版本（git tag 优先，`_versions/*.zip` 兜底）；回退前自动备份当前状态 |
| `checks.txt` | **不变式清单**：`相对路径\|必须出现的关键字`。老修复被改丢时，这里会立刻报警 |

## 典型用法

```bash
# 1) 改完 skill（代码 + 文档要同步改），跑一次发版
python tools/snapshot.py \
    --version 1.1 --kind minor \
    --project "《某支 MV》" \
    --summary "新增 XXX 能力，修掉 YYY 坑" \
    --item "改了 A：原因是 B" \
    --item "改了 C：原因是 D" \
    --verify "实测：N 段全过 / 对齐滞后 0.0s / 成本 X 币" \
    --add-check "references/xxx.py|新函数名"

# 2) 只想确认「老修复还在不在」（这一条随时可跑，不发版）
python tools/snapshot.py --check-only

# 3) 某次进化把版本搞坏了 → 先看有哪些版本，再退回去
python tools/rollback.py --list
python tools/rollback.py --to V1.0
# git 也坏了就用 zip 快照兜底：
python tools/rollback.py --to V1.0 --from-zip

# 4) 退回后想撤销（回退本身也是一次提交，里面有 rollback: 那次提交之前的状态）
python tools/rollback.py --list
```

## 版本号规则

| `--kind` | 何时用 | 例 |
|---|---|---|
| `patch` | 小修小补（补一个函数、改一处提示语、纯文档） | V1.0 → V1.0.1 |
| `minor` | **铁律级 / 行为变更**（新增铁律、改流程、改门禁） | V1.0 → V1.1 |
| `major` | 架构级重做 | V1.0 → V2.0 |

## 四条纪律

1. **只记在项目日志里不算数** —— 可复用的修复必须落进 skill 代码或 SKILL.md，
   并能被 `checks.txt` grep 到。**只改文档 = 没修**（铁律 F2）。
2. **每次进化都要留一个回退点** —— 不跑 `snapshot.py` 就不算发版（铁律 F3）。
3. **回退本身也是一次进化** —— 回退会作为新提交记录，不会抹掉历史。
4. **checks.txt 的关键字是「照抄原文」** —— 包括 markdown 反引号。
   清单里写 `不出现 <Audio N>` 而 SKILL.md 写的是 `不出现 \`<Audio N>\``，自检就会报「找不到」——
   那不是文档缺内容，是清单没照抄书写形式。**改文案时两处一起改。**
5. **手改过 `VERSION` 就不要再让 `snapshot.py` 自增**（V1.0.4 真翻过这一次车）：
   `--kind patch` 是**从 `VERSION` 现值自增**的，所以「先手写 VERSION=1.0.4，再跑 snapshot」
   → 直接发成 **V1.0.5**（跳号），CHANGELOG 里还会同时挂上机器生成与手写两条。
   **二选一**：① 手过了就显式 `--version 1.0.4`；② 干脆不手改 `VERSION`，把版本号交给它自增。
   判据同「版本号只有一处来源」。

## 当前状态

- 精确版本**以 `VERSION` 文件为唯一权威**（本文件不再重复写版本号 —— 两处写 = 漂移源；
  这里曾停在 V1.0 而 VERSION 已经走到 V1.0.3）。可回退清单看 `python tools/rollback.py --list`。
- `checks.txt` 共 **163 条不变式**（跑法：`python tools/snapshot.py --check-only`，只跑自检不发版）。
- ⚠️ **改了 `checks.txt` 的关键字，必须和正文一起改**（纪律 4）。
