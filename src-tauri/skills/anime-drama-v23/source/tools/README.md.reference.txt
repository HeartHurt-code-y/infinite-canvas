# tools/ · skill 自我进化与回退

这套工具解决一件事：**让 skill 在每个项目里持续进化，同时又永远退得回去。**

| 文件 | 作用 |
|---|---|
| `snapshot.py` | 一次进化结束时的唯一收尾动作：跑回归自检 → **绝对路径门禁（工作区 + 包本体各扫一遍）** → 追加 `CHANGELOG.md` → 打 zip 快照 → git commit + tag |
| `rollback.py` | 列出/退回任意历史版本（git tag 优先，`_versions/*.zip` 兜底）；回退前自动备份当前状态 |
| `checks.txt` | **不变式清单**：`相对路径\|必须出现的关键字`。老修复被改丢时，这里会立刻报警 |
| `doctor.py` | **新电脑第一步**：环境体检（必需/推荐/可选三档）+ 每项缺失都给出**可直接粘贴给 项目模型** 的安装话术 |
| `scan_paths.py` | **打包前绝对路径门禁**：拦下写死作者机器路径的内容（`snapshot.py` 自动调用） |
| `scan_secrets.py` | **打包前凭证门禁**：拦下真密钥、密钥指纹、凭证文件本体（命中一律只打码显示） |

> 关于「为什么需要 `doctor.py` / `scan_paths.py` / `scan_secrets.py`」与自包含分发机制
> （`references/deps.py` + `vendor/`），见 **`references/00-新电脑部署.md`**
> 和 `SKILL.md` 的**铁律 G 组**。
>
> **三道门禁的分工**（工作区 + 包本体各扫一遍，`_versions/*.zip` 与 git 是两条出口）：
> 路径 → `scan_paths.py` + `.gitignore`；密钥 → `scan_secrets.py` + `snapshot.py` 打包排除规则。
> 两者不能互相替代，也不能只堵一条出口。

## 典型用法

```bash
# 0) 新电脑 / 换机之后：先体检，缺什么照话术发给 项目模型 安装
python tools/doctor.py                       # 完整体检；--quiet 只报问题；--json 给 Agent 读
python references/deps.py --describe          # 每个依赖现在用的到底是哪一份（内置/外部）

# 1) 改完 skill（代码 + 文档要同步改），跑一次发版
python tools/snapshot.py \
    --version 1.4 --kind minor \
    --project "《橘子汽水味的夏天 第二季》" \
    --summary "新增 XXX 能力，修掉 YYY 坑" \
    --item "改了 A：原因是 B" \
    --item "改了 C：原因是 D" \
    --verify "实测：N 段全过 / 成本 X 币 / 耗时 Y 分钟" \
    --add-check "references/xxx.py|新函数名"

# 2) 只想确认「老修复还在不在」/「包里有没有本机路径 / 密钥」
python tools/snapshot.py --check-only        # 不变式自检
python tools/scan_paths.py                   # 绝对路径扫描（默认扫本 skill 目录；--all-zips 复检全部历史包）
python tools/scan_secrets.py                 # 凭证泄漏扫描（同上；命中只打码显示，不回显本体）
python examples/test_scan_paths.py           # 扫描器**对抗测试**（必跑：证明它真的会拦，且不误报）
python examples/test_scan_secrets.py         # 同上（21 项：11 该报 + 5 不该报 + 自指 + zip + 不回显）

# 3) 某次进化把版本搞坏了 → 先看有哪些版本，再退回去
python tools/rollback.py --list
python tools/rollback.py --to V1.3.1
# git 也坏了就用 zip 快照兜底：
python tools/rollback.py --to V1.3.1 --from-zip

# 4) 退回后想撤销再退回去
python tools/rollback.py --list      # 里面有 rollback: 那次提交之前的状态
```

## 版本号规则

| `--kind` | 何时用 | 例 |
|---|---|---|
| `patch` | 小修小补（补一个函数、改一处提示语） | V1.3.1 → V1.3.2 |
| `minor` | **铁律级 / 行为变更**（新增铁律、改流程、改门禁） | V1.3.1 → V1.4 |
| `major` | 架构级重做 | V1.3.1 → V2.0 |

## 三条纪律

1. **只记在项目日志里不算数** —— 可复用的修复必须落进 skill 代码或 SKILL.md，并能被 `checks.txt` grep 到。
2. **每次进化都要留一个回退点** —— 不跑 `snapshot.py` 就不算发版。
3. **回退本身也是一次进化** —— 回退会作为新提交记录，不会抹掉历史。
