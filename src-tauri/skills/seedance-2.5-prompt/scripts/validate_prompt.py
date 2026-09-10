#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Seedance 2.5 提示词自动体检
============================
对照官方《Seedance 2.5 提示词指南》SECTION04 的 14 条提交前检查清单，
对一条提示词做启发式体检，输出 PASS / WARN / FAIL 报告与修改建议。

用法：
    python scripts/validate_prompt.py prompt.txt
    cat prompt.txt | python scripts/validate_prompt.py
    python scripts/validate_prompt.py   # 无参数则从 stdin 读取

说明：
    这是"启发式"体检，不是模型判官。它能抓住最常见的几类问题
    （素材漏声明职责、时间段重叠、抽象情绪无可观察表现、让模型猜的模糊词、
     编辑/延长/白模/转场任务缺关键结构、计时脚本的时间戳重叠/跳空），
     但不能替代人工阅读官方指南。
"""

import sys
import os
import re

# ----------------------------------------------------------------------------
# 工具
# ----------------------------------------------------------------------------

def read_prompt(arg):
    if arg and os.path.exists(arg):
        with open(arg, encoding="utf-8") as f:
            return f.read()
    if arg:
        # 不是文件路径，当作直接文本
        return arg
    return sys.stdin.read()


def find_refs(text):
    """返回所有 @图片N/@视频N/@音频N/@白模N 的去重列表。"""
    return sorted(set(re.findall(r"@(?:图片|视频|音频|白模)\s*\d+", text)))


def near(ref, text, window=40):
    """返回 ref 在文中所有出现位置周围 window 字符的拼接。"""
    out = []
    for m in re.finditer(re.escape(ref), text):
        s = max(0, m.start() - 10)
        e = min(len(text), m.end() + window)
        out.append(text[s:e])
    return " … ".join(out)


# ----------------------------------------------------------------------------
# 检查项
# ----------------------------------------------------------------------------

class Issue:
    def __init__(self, level, item, msg, hint=""):
        self.level = level      # "FAIL" / "WARN" / "PASS"
        self.item = item        # 对应的清单编号或主题
        self.msg = msg
        self.hint = hint

    def __str__(self):
        tag = {"FAIL": "✗ FAIL", "WARN": "⚠ WARN", "PASS": "✓ PASS"}[self.level]
        base = f"[{tag}] ({self.item}) {self.msg}"
        if self.hint:
            base += f"\n        → {self.hint}"
        return base


DUTY_WORDS = ["采用", "不采用", "用于", "定义", "对应", "参考", "职责", "只采用", "仅提供", "保持"]


def check(text):
    issues = []
    refs = find_refs(text)

    # ---- 清单 1：主体 + 主要动作 ----
    if len(text.strip()) < 8:
        issues.append(Issue("FAIL", "1", "提示词过短，几乎无法判断主体和主要动作。"))
    else:
        issues.append(Issue("PASS", "1", "提示词非空，主体/动作需人工最后确认。"))

    # ---- 清单 2：每份素材声明采用/不采用 ----
    if refs:
        missing = []
        for r in refs:
            ctx = near(r, text)
            if not any(w in ctx for w in DUTY_WORDS):
                missing.append(r)
        if missing:
            issues.append(Issue(
                "FAIL", "2",
                f"以下素材未声明职责（缺少 采用/不采用/用于/定义/对应 等）：{', '.join(missing)}",
                "为每份素材补一行：@图片N用于<主体>的<属性>，不采用<无关内容>。"))
        else:
            issues.append(Issue("PASS", "2", f"全部 {len(refs)} 份素材均声明了职责。"))
    else:
        issues.append(Issue("PASS", "2", "无参考素材，跳过。"))

    # ---- 清单 3：不同主体逐一命名并绑定 ----
    if refs and ("人物" in text or "角色" in text or "商品" in text or "道具" in text):
        if "对应" in text or "定义" in text or "作为" in text:
            issues.append(Issue("PASS", "3", "检测到 对应/定义/作为 绑定写法（含打斗角色卡）。"))
        else:
            issues.append(Issue("WARN", "3",
                "出现人物/商品/道具但未见逐一绑定素材的 对应/定义/作为 写法。",
                "用 <人物A>对应@图片1 明确绑定（打斗角色卡可用 @图片N作为<角色>: 动作偏好）。"))

    # ---- 清单 4：多素材按场景选择，而非全部同时出现 ----
    if len(refs) >= 3:
        if "场景一" in text or "场景二" in text or "阶段" in text or "分组" in text or "【" in text:
            issues.append(Issue("PASS", "4", "检测到分场景/分组调用结构。"))
        else:
            issues.append(Issue("WARN", "4",
                f"素材多达 {len(refs)} 份但未看到分场景/分组结构，可能要求全部同时出现。",
                "按【人物】【道具】【场景】分组，并按场景调用，不要要求所有素材同框。"))

    # ---- 清单 5：长视频阶段（阶段收口）+ 官方 2.2 时间区间连续性（属清单 5 范畴）----
    ts = re.findall(r"(\d+)\s*[-~]\s*(\d+)\s*秒", text)
    if ts:
        nums = [(int(a), int(b)) for a, b in ts]
        # 重叠检测
        overlaps = []
        for i in range(len(nums)):
            for j in range(i + 1, len(nums)):
                a1, a2 = nums[i]
                b1, b2 = nums[j]
                if a1 < b2 and b1 < a2:
                    overlaps.append((nums[i], nums[j]))
        if overlaps:
            issues.append(Issue(
                "FAIL", "5",
                f"检测到时间区间重叠：{overlaps}",
                "时间段必须连续、不重叠（是时间预算，不是精准剪辑点）。"))
        else:
            issues.append(Issue("PASS", "5", f"检测到 {len(nums)} 个时间区间，无重叠。"))
        # 阶段结束状态
        if "结束时" in text or "结束画面" in text:
            issues.append(Issue("PASS", "5", "检测到 结束时 收口写法。"))
        else:
            issues.append(Issue("WARN", "5",
                "使用了时间戳但未见 结束时/结束画面 收口。",
                "每个阶段/区间写清结束时画面里能直接看到什么。"))

    # ---- 清单 6：人物数量/服装/道具归属/空间关系稳定 ----
    if "保持" in text or "稳定" in text or "不变" in text:
        issues.append(Issue("PASS", "6", "检测到 保持/稳定/不变 等一致性锚定写法。"))
    elif refs and ("人物" in text or "角色" in text):
        issues.append(Issue("WARN", "6",
            "有多主体但未显式声明保持一致。",
            "补一句：保持<人物身份、服装、道具归属、空间方向>稳定。"))

    # ---- 清单 7：视频编辑明确母版/范围/保持 ----
    if "编辑" in text and "@视频" in text:
        needed = ["母版", "编辑范围", "保持", "修改范围"]
        miss = [w for w in needed if w not in text]
        if miss:
            issues.append(Issue("WARN", "7",
                f"视频编辑任务缺少关键结构：{', '.join(miss)}。",
                "按【编辑目标】【原视频职责(唯一母版)】【编辑范围】【保持内容】四段写。"))
        else:
            issues.append(Issue("PASS", "7", "视频编辑四段结构齐全。"))
        if "只" in text or "仅" in text:
            issues.append(Issue("PASS", "7b", "检测到 只/仅 限定修改范围（避免重画整段）。"))
        else:
            issues.append(Issue("WARN", "7b", "编辑范围建议用 只/仅 限定，一次只解决一个主要问题。"))

    # ---- 清单 8：抽象情绪/术语对应可观察表现 ----
    emotion_words = ["紧张", "温馨", "压抑", "悲伤", "喜悦", "愤怒", "激动", "孤独",
                     "浪漫", "恐怖", "欢快", "宁静", "焦虑", "深情", "悲壮"]
    obs_words = ["眼神", "眉头", "嘴角", "呼吸", "视线", "手部", "手指", "肩膀",
                 "眼眶", "表情", "握", "停住", "转头", "低头", "抬头"]
    found_emo = [w for w in emotion_words if w in text]
    if found_emo:
        if any(w in text for w in obs_words):
            issues.append(Issue("PASS", "8", f"检测到情绪词 {found_emo} 且伴有可观察表现（眼神/眉头/手部等）。"))
        else:
            issues.append(Issue("WARN", "8",
                f"出现抽象情绪词 {found_emo} 但未见可观察表现。",
                "写明眼神、眉头、嘴角、呼吸、视线或手部动作；多转折按触发事件分阶段。"))

    # ---- 清单 9：首尾帧/多关键帧职责 + 同画幅 ----
    if "首帧" in text or "尾帧" in text or "关键帧" in text:
        if any(w in text for w in DUTY_WORDS):
            issues.append(Issue("PASS", "9", "检测到首尾帧/关键帧职责声明。"))
        else:
            issues.append(Issue("WARN", "9", "首尾帧/关键帧未逐张声明职责。"))
        if "首帧" in text and "尾帧" in text and "相同画幅" not in text and "同画幅" not in text:
            issues.append(Issue("WARN", "9b", "同时写了首帧与尾帧，但未声明使用相同画幅（尾帧可能被拉伸）。"))

    # ---- 清单 10：宫格分镜 / 白模 ----
    if "宫格" in text or "分镜" in text:
        if "顺序" in text and ("读取" in text or "按照" in text):
            issues.append(Issue("PASS", "10", "宫格分镜写清了读取顺序。"))
        else:
            issues.append(Issue("WARN", "10", "宫格分镜未写清继承结构与读取顺序。"))
    if "白模" in text:
        if "粗粒度" in text or "细粒度" in text:
            issues.append(Issue("PASS", "10b", "白模已判断粗/细粒度。"))
        else:
            issues.append(Issue("WARN", "10b", "使用白模但未先判断粗粒度或细粒度。"))
        if "保持" in text or "继承" in text or "不采用" in text:
            issues.append(Issue("PASS", "10c", "白模写清了需继承的时序/结构/材质/风格。"))
        else:
            issues.append(Issue("WARN", "10c", "白模未写清需要继承的时序、结构、材质和风格。"))

    # ---- 清单 11：参数锁定规则 ----
    if "编辑" in text and "@视频" in text:
        if ("比例" not in text) and ("时长" not in text):
            issues.append(Issue("PASS", "11",
                "视频编辑：比例与时长自动锁定，提示词未另行写这两项，符合规则。"))
        else:
            issues.append(Issue("WARN", "11",
                "编辑任务另行写了 画幅比例/时长，但这两项会被输入视频锁定（时长差 ≤0.3 秒），建议移除。"))
    if "延长" in text:
        issues.append(Issue("PASS", "11b", "视频延长：比例锁定、时长可设，已符合规则。"))

    # ---- 清单 13：一键成片结构 ----
    if "成片" in text or "一键成片" in text:
        needed = ["素材职责", "图片顺序", "动态", "剪辑", "声音"]
        miss = [w for w in needed if w not in text]
        if miss:
            issues.append(Issue("WARN", "13", f"一键成片缺少：{', '.join(miss)}。"))
        else:
            issues.append(Issue("PASS", "13", "一键成片五段结构齐全。"))

    # ---- 清单 14：无缝转场结构 ----
    if "转场" in text:
        needed = ["触发", "过渡", "到达", "保持"]
        miss = [w for w in needed if w not in text]
        if miss:
            issues.append(Issue("WARN", "14", f"无缝转场缺少：{', '.join(miss)}。"))
        else:
            issues.append(Issue("PASS", "14", "无缝转场四要素（触发/过渡/到达/保持）齐全。"))

    # ---- 通用：模糊词（让模型猜） ----
    vague = ["分别定义", "等", "之类", "合适的", "一些", "某种", "大概", "大约", "其它", "其他"]
    hit = [v for v in vague if v in text]
    # "等" 可能是正常用法，单独弱提示
    if hit:
        issues.append(Issue("WARN", "通用", f"疑似模糊词：{hit}。",
                            "把'分别定义/等/之类/合适的'替换为明确指认，避免让模型猜。"))

    # ---- 计时专属：秒级时间戳区间 0-Xs：/X-Y秒： 连续性 ----
    # 官方指南（2.2）以「0-X 秒时间区间」分配剧情节奏，同时支持「第 X 秒时间点」与
    # 「相对时间（开始时/主要事件/结束时）」。本检查只校验最易出错的区间连续性。
    # 匹配 "0-3s：" / "0-3秒：" / "0-3 秒：" / "5-10s：" 等区间前缀
    sec_intervals = re.findall(r"(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[:：]", text)

    if sec_intervals:
        ivs = sorted((float(a), float(b)) for a, b in sec_intervals)
        # 重叠检测
        ov = [(ivs[i], ivs[j]) for i in range(len(ivs))
              for j in range(i + 1, len(ivs))
              if ivs[i][0] < ivs[j][1] and ivs[j][0] < ivs[i][1]]
        if ov:
            issues.append(Issue(
                "FAIL", "计时",
                f"时间区间重叠：{ov}",
                "时间戳区间必须连续、不重叠（官方 2.2：时间区间用于分配剧情节奏）。"))
        else:
            issues.append(Issue("PASS", "计时", f"共 {len(ivs)} 个区间，无重叠。"))
        # 连续不跳空检测（容差 0.5s）
        gaps = [(ivs[i][1], ivs[i + 1][0])
                for i in range(len(ivs) - 1)
                if ivs[i + 1][0] - ivs[i][1] > 0.5]
        if gaps:
            issues.append(Issue(
                "WARN", "计时",
                f"时间区间跳空（间隔 >0.5s）：{gaps}",
                "区间应连续衔接，避免成片出现未定义的空档。"))
        else:
            issues.append(Issue("PASS", "计时2", "区间首尾连续衔接，无跳空。"))
        issues.append(Issue("PASS", "计时3",
            f"检测到计时脚本（共 {len(ivs)} 个时间区间），建议同时输出 多模态版 + 纯文字版 双版本（见 09 / templates H2）。"))

    # ---- 官方强化：编辑范围闭环 / 延长单一实例（references/10）----
    is_edit = ("编辑@视频" in text) or ("编辑视频" in text)
    if is_edit:
        has_close = ("其他可见" in text and "保持原样" in text) or ("删除" in text and "其他可见主体" in text)
        if has_close:
            issues.append(Issue("PASS", "编辑闭环",
                "编辑 Prompt 含范围闭环句（局部修改 / 只保留目标对象），符合官方 sd25-pe 强化规则。"))
        else:
            issues.append(Issue("WARN", "编辑闭环",
                "编辑类 Prompt 缺少范围闭环句（局部修改：「除以上明确修改对象外，@视频1中其他可见人物、道具和背景元素保持原样」；"
                "或只保留目标对象版）。每条编辑 Prompt 必备其一。",
                "见 references/10 第五节 / references/04。"))

    is_extend = ("延长@视频" in text) or ("延长视频" in text)
    if is_extend:
        has_single = (("不重复" in text and "不分裂" in text) or ("同一个连续对象" in text)
                      or ("单一实例" in text) or ("拓扑" in text))
        if has_single:
            issues.append(Issue("PASS", "延长实例",
                "延长 Prompt 声明了单一实例 / 不分裂 / 拓扑要求，符合官方强化规则。"))
        else:
            issues.append(Issue("WARN", "延长实例",
                "延长类 Prompt 未显式声明「同一主体始终为同一个连续对象，不重复、不分裂；部件数量与拓扑关系保持稳定」。"
                "该要求必须写进最终 Prompt（见 references/10 第六节）。"))
        # ---- 清单 12：延长边界连续（官方 SECTION04 清单 12 / 10 第六节 2）----
        has_boundary = (("承接" in text or "衔接" in text or "接续" in text or "第一帧" in text or "最后一帧" in text)
                        and ("趋势" in text or "运动" in text or "朝向" in text))
        if has_boundary:
            issues.append(Issue("PASS", "12",
                "延长 Prompt 声明了边界连续（承接/衔接边界帧 + 运动趋势/朝向），符合官方清单 12。"))
        else:
            issues.append(Issue("WARN", "12",
                "延长类 Prompt 未明确声明边界连续：向后延长承接尾帧 / 向前延长衔接首帧，并保持姿态朝向、运动趋势与声音连续"
                "（见 references/10 第六节 2 / 官方清单 12）。"))

    # ---- 打斗垂直（references/12）：打斗/动作戏任务强制时间戳节拍 ----
    fight_words = ["打斗", "对决", "变身", "群战", "对打", "武打", "动作戏", "连击", "追击", "扑击", "厮杀"]
    if any(w in text for w in fight_words):
        if sec_intervals:
            issues.append(Issue("PASS", "打斗",
                "打斗/动作戏任务已使用时间戳节拍（X-X秒：分段），符合 references/12 垂直规则。"))
        else:
            issues.append(Issue("WARN", "打斗",
                "打斗/动作戏任务未见时间戳节拍（X-X秒：分段）。每个攻防节点建议钉死秒数（见 references/12 4.2）。"))

    # ---- 通用：四符号统计 ----
    sym = {
        "音乐()": text.count("("),
        "音效<>": text.count("<") - text.count("《"),
        "台词{}": text.count("{"),
        "字幕【】": text.count("【"),
    }
    issues.append(Issue("PASS", "符号", f"符号统计：{sym}（<> 中已扣除《》书名号）。"))

    return issues


# ----------------------------------------------------------------------------
# 报告
# ----------------------------------------------------------------------------

def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    text = read_prompt(arg)
    if not text.strip():
        print("未读取到提示词内容。用法：python validate_prompt.py prompt.txt")
        sys.exit(1)

    print("=" * 64)
    print("Seedance 2.5 提示词体检报告")
    print("=" * 64)
    issues = check(text)
    fails = warns = passes = 0
    for it in issues:
        if it.level == "FAIL":
            fails += 1
        elif it.level == "WARN":
            warns += 1
        else:
            passes += 1
        print(it)
    print("-" * 64)
    print(f"结果：PASS {passes} · WARN {warns} · FAIL {fails}")
    if fails == 0 and warns == 0:
        print("✓ 未检出明显问题，建议仍对照 references/07 人工复核。")
    elif fails == 0:
        print("⚠ 无致命问题，但存在可优化项；优先处理 WARN。")
    else:
        print("✗ 存在必须修复的问题（FAIL），先处理这些再提交。")
    print("=" * 64)


if __name__ == "__main__":
    main()
