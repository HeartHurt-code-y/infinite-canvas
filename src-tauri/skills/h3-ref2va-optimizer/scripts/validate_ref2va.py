#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
H3 Ref2VA 提示词校验器 · V1.2

用法:
    python validate_ref2va.py prompt.txt
    python validate_ref2va.py prompt.txt --duration 10

V1.2 修正（2026-09-05，场次58 实测暴露）：
    1. SPK-ID：说话人 ID 支持全角括号（S1），V1.1 只认半角 (S1) → 误报
    2. ABS-BAN：对白原文 <d>…</d> 内的「觉得」「内心」等词不再判为内心独白
    3. BEAT-FMT：节拍行若已用官方 <d>[中文] 语法，不再提示改回「角色名说"…"」
    4. BG-ENV：人物 Subject 优先判定，避免「实际场景替换为 X」里的「场景」把它误判成环境类

语言策略（V1.1 起）：
    字段名 / 参考标签 / 保留标记 / Negative  -> 英文（会校验）
    叙述性文本 / 对白                        -> 中文（正常，不告警）

检查项:
    [E] 错误 - 必须修
    [W] 警告 - 建议修
    [I] 提示 - 仅供参考
"""

import re
import sys
import argparse
from pathlib import Path

SECTIONS = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
]

RETENTION_MARKERS = [
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
]

ABSTRACT_WORDS = [
    "心跳加速", "满脑子", "内心", "感到", "觉得", "心如刀绞",
    "思绪万千", "五味杂陈", "百感交集", "若有所思",
    "heart racing", "mind racing", "feels sad", "thinks about",
    "inner monologue", "lost in thought",
]

EMOTION_LABELS = [
    "伤心", "悲伤", "难过", "害羞", "愤怒", "紧张", "焦虑", "开心",
    "兴奋", "恐惧", "害怕", "感动", "心动", "失落", "绝望",
]

# 中文对白写法：角色名（1–10 字）+ 说 + 引号。
# V1.3 起不锚定行首——对白七要素允许停顿 / 呼吸 / 视线描述前置。
DLG_CN = r"[\u4e00-\u9fff]{1,10}说\s*[「“\"']"


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, code, msg):
        self.items.append((level, code, msg))

    def error(self, code, msg):
        self.add("E", code, msg)

    def warn(self, code, msg):
        self.add("W", code, msg)

    def info(self, code, msg):
        self.add("I", code, msg)

    @property
    def counts(self):
        c = {"E": 0, "W": 0, "I": 0}
        for lv, _, _ in self.items:
            c[lv] += 1
        return c


def parse_sections(text):
    """返回 {字段名: 内容} 以及字段出现顺序"""
    lines = text.splitlines()
    found = {}
    order = []
    cur = None
    buf = []
    for ln in lines:
        m = re.match(r"^\s*\**\s*([a-z_]+)\s*\**\s*[::]\s*(.*)$", ln)
        if m and m.group(1) in SECTIONS:
            if cur:
                found[cur] = "\n".join(buf).strip()
            cur = m.group(1)
            order.append(cur)
            buf = [m.group(2)]
        elif cur:
            buf.append(ln)
    if cur:
        found[cur] = "\n".join(buf).strip()
    return found, order


def check(text, duration=None, seg_index=1):
    r = Report()
    secs, order = parse_sections(text)

    # ---- 1. 六段齐全 + 顺序 ----
    # V1.3：order 可能长于 6（多段输出时六段会重复出现）。
    # 只比对前 6 个，且必须判空再取 [0]——否则多段输入会 IndexError 崩溃。
    missing = [s for s in SECTIONS if s not in secs]
    for s in missing:
        r.error("SEC-MISSING", f"缺少节段 `{s}`")
    if not missing:
        head_order = order[:len(SECTIONS)]
        bad = [s for a, s in zip(SECTIONS, head_order) if a != s]
        if bad:
            r.error("SEC-ORDER", f"节段顺序错误，第一个错位出现在 `{bad[0]}`")
        if len(order) > len(SECTIONS):
            # 节段数超过 6 = 疑似多段输出，但没用【第N段】隔开
            r.warn(
                "SEC-MULTI",
                f"检测到 {len(order)} 个节段（六段式的 "
                f"{len(order) / len(SECTIONS):.0f} 倍）。若是多段输出，"
                f"请用【第1段｜时长｜事件名】隔开，"
                f"否则内容类校验只对最后一段生效",
            )

    # ---- 2. 节段非空 ----
    for s in SECTIONS:
        if s in secs and not secs[s].strip():
            r.error("SEC-EMPTY", f"节段 `{s}` 内容为空")
    if secs.get("non_diegetic_music", "").strip().upper() in ("", "N/A"):
        r.info("MUSIC-NA", "non_diegetic_music 为 N/A（符合规范）")

    # ---- 3. 字符数 ----
    n = len(text)
    if n > 7000:
        r.error("LEN-OVER", f"提示词 {n} 字符，超过 7000 上限（超出 {n - 7000}）")
    elif n > 6300:
        r.warn("LEN-NEAR", f"提示词 {n} 字符，接近 7000 上限")
    else:
        r.info("LEN-OK", f"提示词 {n} 字符")

    # ---- 4. 标签定义 vs 引用 ----
    defs_block = secs.get("subject_definitions", "")
    defs = {
        "Subject": set(re.findall(r"<Subject\s*(\d+)>", defs_block)),
        "Picture": set(re.findall(r"<Picture\s*(\d+)>", defs_block)),
        "Video": set(re.findall(r"<Video\s*(\d+)>", defs_block)),
        "Audio": set(re.findall(r"<Audio\s*(\d+)>", defs_block)),
    }
    body = "\n".join(
        secs.get(s, "") for s in SECTIONS if s != "subject_definitions"
    )
    used = {
        "Subject": set(re.findall(r"<Subject\s*(\d+)>", body)),
        "Picture": set(re.findall(r"<Picture\s*(\d+)>", body)),
        "Video": set(re.findall(r"<Video\s*(\d+)>", body)),
        "Audio": set(re.findall(r"<Audio\s*(\d+)>", body)),
    }
    # 角色图在 <Subject> 内被引用属于正确写法，不计入"未引用"
    cited_in_subject = set()
    for m in re.finditer(
        r"<Subject\s*\d+>[^<]*?((?:<Picture\s*\d+>[^<]*?)+)", defs_block, re.S
    ):
        cited_in_subject.update(re.findall(r"<Picture\s*(\d+)>", m.group(1)))

    for kind in defs:
        undef = used[kind] - defs[kind]
        for i in sorted(undef, key=int):
            r.error("LBL-UNDEF", f"<{kind} {i}> 在正文被引用，但未在 subject_definitions 定义")
        unused = defs[kind] - used[kind]
        for i in sorted(unused, key=int):
            if kind == "Picture" and i in cited_in_subject:
                r.info(
                    "LBL-INLINE",
                    f"<Picture {i}> 在 <Subject> 定义内被引用（角色图正确写法）",
                )
                continue
            r.warn("LBL-UNUSED", f"<{kind} {i}> 已定义但正文未引用")

    # ---- 5. 角色图不得独立建 Picture 条目 ----
    for m in re.finditer(
        r"^\s*[-*]?\s*\**\s*<Picture\s*(\d+)>\s*\**\s*[::]", defs_block, re.M
    ):
        r.warn(
            "PIC-STANDALONE",
            f"<Picture {m.group(1)}> 在 subject_definitions 中独立成条 —— "
            f"若仅用于定义角色外观，应改写进对应的 <Subject N>",
        )

    # ---- 6. 素材数量上限 ----
    np_, nv, na = len(defs["Picture"]), len(defs["Video"]), len(defs["Audio"])
    if np_ > 9:
        r.error("ASSET-PIC", f"参考图 {np_} 张，超过 9 张上限")
    if nv > 3:
        r.error("ASSET-VID", f"参考视频 {nv} 段，超过 3 段上限")
    if na > 3:
        r.error("ASSET-AUD", f"参考音频 {na} 段，超过 3 段上限")
    if np_ + nv + na > 12:
        r.error("ASSET-TOTAL", f"参考素材共 {np_ + nv + na} 个，超过总数 12 上限")
    if np_ > 3:
        r.warn("ASSET-PIC-MANY", f"参考图 {np_} 张，超过建议值 3 张，失败率可能上升")

    # ---- 7. retention_analysis 标记 ----
    ra = secs.get("retention_analysis", "")
    if ra:
        if not any(mk in ra for mk in RETENTION_MARKERS):
            r.error(
                "RET-NOMARK",
                "retention_analysis 未出现任何保留标记（fully_preserved / "
                "partially_preserved / attribute_transfer / weak_reference）",
            )
        defined_subjects = sorted(defs["Subject"], key=int)
        for i in defined_subjects:
            if not re.search(rf"<Subject\s*{i}\s*>", ra):
                r.warn("RET-MISS", f"<Subject {i}> 未在 retention_analysis 中声明保留方式")
        # 画面构成误放检测
        for kw in ["画面中只有", "背景虚化", "占画面", "Composition:", "only three"]:
            if kw in ra:
                r.warn(
                    "RET-COMPOSITION",
                    f"retention_analysis 疑似出现画面构成描述「{kw}」，应移至 detailed_description",
                )

    # ---- 8. 描述模式检测：节拍模式 / 时间码模式 ----
    dd = secs.get("detailed_description", "")
    beats = re.findall(r"^\s*→\s*(.+)$", dd, re.M)

    # 首行形如「[一镜到底] 0–10s，场景是……」是总时长标注，不算时间码分段
    dd_lines = dd.splitlines()
    header = dd_lines[0] if dd_lines else ""
    body = "\n".join(dd_lines[1:])
    stamps = re.findall(r"(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s", body)
    header_stamp = re.findall(
        r"(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s", header
    )

    mode = None
    if beats and not stamps:
        mode = "节拍"
    elif stamps and not beats:
        mode = "时间码"
    elif beats and stamps:
        mode = "混合"

    if beats:
        n = len(beats)
        r.info("MODE-BEAT", f"节拍模式：{n} 个事件")
        # 台词量预算
        lines = [b for b in beats if re.search(r"说\s*[「“\"']", b)]
        if duration:
            budget = int(duration // 2)
            if len(lines) > budget:
                r.warn(
                    "BEAT-DENSE",
                    f"{len(lines)} 句台词 / {duration}s —— 超出预算（约 {budget} 句），"
                    f"H3 可能加快语速或吞字",
                )
        elif len(lines) > 8:
            r.warn("BEAT-DENSE", f"{len(lines)} 句台词，未指定时长，超过 8 句需注意节奏")
        # 台词格式
        # V1.3：对白七要素允许停顿 / 呼吸 / 视线等描述前置，
        # 所以不能要求台词顶格，只要行内出现「角色名说"…"」即合规。
        for b in beats:
            # V1.2：多人对白 / 说话人 ID / 精确音画对齐场景按官方 <d>[中文] 写，
            # 此时不该再提示改回「角色名说"…"」（与 06 模板 §三个仍然要用官方标记的场景 冲突）
            if "<d>" in b:
                continue
            if re.search(r"[「“\"']", b) and not re.search(DLG_CN, b):
                r.warn(
                    "BEAT-FMT",
                    f"台词建议写「角色名说\"……\"」，当前：{b[:28]}",
                )
                break
        # 台词是否配视线/动作
        if lines and not re.search(r"看(着|向)|转头|低头|抬头|笑", dd):
            r.warn("BEAT-EYE", "台词未配视线或动作，人物容易站桩念稿")
        # 节拍模式：总时长以首行 [一镜到底] 0–Ns 为准
        if duration and header_stamp:
            ht = float(header_stamp[0][1])
            if abs(ht - duration) > 0.6:
                r.error(
                    "TL-MISMATCH",
                    f"首行标注 {ht}s，与目标时长 {duration}s 相差 {abs(ht - duration):.1f}s",
                )
            else:
                r.info("TL-OK", f"首行总长 {ht}s，与目标 {duration}s 匹配")
        if header_stamp:
            ht = float(header_stamp[0][1])
            if ht < 4 or ht > 15:
                r.error("TL-RANGE", f"首行总长 {ht}s 超出 4–15 秒区间")
        elif duration is None:
            r.info("TL-BEAT", "节拍模式未标注总时长，建议首行写 `[一镜到底] 0–Ns`")

    if stamps:
        if len(stamps) < 4:
            r.warn("TL-FEW", f"时间码仅 {len(stamps)} 段，建议 8 秒片段不少于 5 段")
        ends = [float(b) for _, b in stamps]
        total = max(ends)
        if duration:
            if abs(total - duration) > 0.6:
                r.error(
                    "TL-MISMATCH",
                    f"时间码收尾于 {total}s，与目标时长 {duration}s 相差 "
                    f"{abs(total - duration):.1f}s",
                )
            else:
                r.info("TL-OK", f"时间码总长 {total}s，与目标 {duration}s 匹配")
        else:
            r.info("TL-TOTAL", f"时间码总长 {total}s（未指定 --duration，跳过匹配校验）")
        if total < 4 or total > 15:
            r.error("TL-RANGE", f"总时长 {total}s 超出 4–15 秒区间")

    # 官方多镜头写法 [Shot N] At 00:0X.000 自带切点，不需要本 skill 的时间码/节拍
    is_multishot = bool(re.search(r"\[Shot\s*\d+\]", dd))
    if not beats and not stamps and not is_multishot:
        r.warn(
            "TL-NONE",
            "未检测到时间码（`0–1s`）或节拍（`→`）。"
            "对白密集用节拍模式，表演密集用时间码模式",
        )
    elif mode:
        r.info("MODE", f"当前描述模式：{mode}模式")

    # ---- 9. 内心独白 / 情绪标签 ----
    # V1.2：对白原文是台词本体，允许出现「觉得」「内心」等词（如「大家觉得…吗？」），
    # 不能判为内心独白。先把 <d>…</d> 剔除再扫。
    text_nod = re.sub(r"<d>.*?</d>", " ", text, flags=re.S)
    for w in ABSTRACT_WORDS:
        if w in text_nod:
            r.error("ABS-BAN", f"检测到内心独白/抽象描述「{w}」，必须删除或改写为可观察动作")
    hit = [w for w in EMOTION_LABELS if w in dd]
    if hit:
        r.warn("EMO-LABEL", f"detailed_description 疑似使用情绪标签 {hit}，建议替换为具体动作")

    # ---- 10. 运镜五要素 ----
    # 复杂运镜才要求凑齐五要素；简单跟随/固定机位不要求
    COMPLEX_CAM = [
        "Orbital", "Arc", "Push in", "Pull out", "Dolly in", "Dolly out",
        "Pan", "Tilt", "Rack focus", "Zoom",
        "弧形", "环绕", "推近", "拉远", "平移", "俯仰",
        "焦点切换", "焦点推移", "变焦",
    ]
    SIMPLE_CAM = [
        "Static", "Fixed", "Steadicam", "Gimbal", "Tracking",
        "跟随", "跟拍", "固定机位", "稳定器",
    ]
    # 官方 §4.3：运镜 = 运动类型 + 幅度 + 速度（三维度）
    # 注意：本 skill V1.1 及之前写的「五要素（轨迹/方向/角度/速度/轴心点）」是自创的，
    # 与官方冲突，已于 V1.2 废止，改为官方三维度。
    # 用正则而非字面量：原文常是 pushes in / panning / tracking 等屈折形式
    MOTION_RE = [
        (r"\bzoom(?:s|ing|ed)?\s+(?:in|out)\b", "Zoom In/Out"),
        (r"\bpush(?:es|ing|ed)?\s+in\b|\bdolly(?:ies|ing)?\s+in\b", "Push In"),
        (r"\bpull(?:s|ing|ed)?\s+out\b|\bdolly(?:ies|ing)?\s+out\b", "Pull Out"),
        (r"\bpan(?:s|ning|ned)?\s+(?:left|right)\b", "Pan"),
        (r"\btruck(?:s|ing|ed)?\s+(?:left|right)\b", "Truck"),
        (r"\btilt(?:s|ing|ed)?\s+(?:up|down)\b", "Tilt"),
        (r"\bpedestal(?:s|ing)?\s+(?:up|down)\b", "Pedestal"),
        (r"\barc\s+shot\b|\bmoves?\s+in\s+an?\s+arc\b|\borbit(?:s|ing|al)?\b", "Arc Shot"),
        (r"\btracking\s+shot\b|\bfollow(?:s|ing)?\s+(?:the|a|her|him|them)\b", "Tracking Shot"),
        (r"\bstatic\s+shot\b|\bholds?\s+(?:nearly\s+)?still\b|\bfixed\s+(?:camera|shot)\b",
         "Static Shot"),
        (r"\bshake[sd]?\s+(?:slightly|strongly)\b|\bcamera\s+shake\b", "Shake"),
        (r"\bpov\b|point\s+of\s+view", "POV"),
        (r"\broll(?:s|ing)?\s+(?:clockwise|counterclockwise)\b", "Roll"),
        (r"\bdrift(?:s|ing)?\s+(?:closer|in|back)\b", "Push In"),
        (r"\bhandheld\b|\bsteadicam\b|\bgimbal\b", "Handheld/Stabilized"),
        (r"推近|拉远|平移|俯仰|环绕|跟拍|升降|变焦|摇镜", "中文运镜词"),
    ]
    AMPLITUDE = [
        "with small amplitude", "with large amplitude", "with medium amplitude",
        "small amplitude", "large amplitude", "medium amplitude",
        "小幅度", "大幅度", "中等幅度",
    ]
    SPEED = [
        "at slow speed", "at fast speed", "at normal speed",
        "slow speed", "fast speed",
        "slowly", "rapidly", "quickly", "gently", "gradually", "briskly",
        "缓慢", "快速", "平滑", "急速", "徐徐",
        "barely perceptible", "very slowly",
    ]
    low_dd = dd.lower()
    motion_hit = [name for pat, name in MOTION_RE if re.search(pat, low_dd)]
    motion_hit = list(dict.fromkeys(motion_hit))
    # 多镜头提示词里常常「某一镜静止、另一镜推拉」，不能因为出现一次
    # "holds nearly still" 就把整段判成静态。只有「除静止外没有任何运镜」才算静态。
    moving = [m for m in motion_hit if m != "Static Shot"]
    is_static = not moving
    amp_hit = [k for k in AMPLITUDE if k.lower() in low_dd]
    spd_hit = [k for k in SPEED if k.lower() in low_dd]

    if motion_hit and not is_static:
        if not amp_hit and not spd_hit:
            r.warn(
                "CAM-VAGUE",
                f"运镜只写了类型（{motion_hit[0]}），缺幅度与速度。"
                f"官方 §4.3 要求「运动类型 + 幅度 + 速度」，"
                f"幅度用 with small/large amplitude，速度用 at slow/fast speed",
            )
        else:
            missing = []
            if not amp_hit:
                missing.append("幅度")
            if not spd_hit:
                missing.append("速度")
            if missing:
                r.info(
                    "CAM-PARTIAL",
                    f"运镜类型「{motion_hit[0]}」已写明，{'/'.join(missing)}未提"
                    f"（官方：普通幅度/常规速度可省略，需强调时补上）",
                )
            else:
                r.info(
                    "CAM-OK",
                    f"运镜三要素齐全：类型 {motion_hit[0]} + "
                    f"幅度 {amp_hit[0]} + 速度 {spd_hit[0]}",
                )
    elif is_static:
        r.info("CAM-STATIC", "静态镜头，无需幅度/速度")
    else:
        r.info("CAM-NONE", "未检测到运镜描述（固定机位场景可忽略）")

    # ---- 11. 去背景污染 ----
    # 官方 §2.1：Scenes / backgrounds / environments 本身就是 <Subject N> 的合法内容，
    # 环境参考图的「背景」就是要保留的主体，不能要求「不得展示其背景」——跳过这类。
    ENV_KW = (
        "environment", "scene", "background", "setting", "location",
        "interior", "cabin", "room", "street", "cafe", "café", "coffee",
        "hall", "office", "square", "alley", "forest", "mountain", "beach",
        "场景", "环境", "背景", "车厢", "室内", "街道", "房间", "车内",
    )
    pics = sorted(defs["Picture"], key=int)
    if pics:
        # 换行会打断句子，先把换行折叠为空格再做匹配
        flat = re.sub(r"\s*\n\s*", " ", defs_block)
        # 先把 defs_block 按 <Subject N> 切成段，判断每张图挂在哪个 Subject 下
        # V1.2：人物 Subject 里常写「实际场景替换为 X」这种去污染句式，
        # 会被 ENV_KW 的「场景」命中而误判成环境类 → 人物优先判定
        PERSON_KW = (
            "男性", "女性", "男人", "女人", "男子", "女子", "男孩", "女孩",
            "少年", "少女", "人物", "角色", "完全参照",
            " man", "woman", "male", "female", "person", "boy", "girl",
        )
        subj_chunks = re.split(r"(<Subject\s*\d+>)", defs_block)
        env_pics = set()
        for k in range(1, len(subj_chunks) - 1, 2):
            body = subj_chunks[k + 1]
            low = body.lower()
            if any(w in body or w in low for w in PERSON_KW):
                continue
            if any(w in low for w in ENV_KW):
                env_pics.update(re.findall(r"<Picture\s*(\d+)>", body))
        covered = set(
            re.findall(
                r"<Picture\s*(\d+)>[^.]{0,80}?"
                r"(?:不得展示|不得出现|不得保留|不得带|"
                r"must not show|does not show|no longer|without its|"
                r"not show its)",
                flat,
                re.I,
            )
        )
        for i in pics:
            if i in env_pics:
                r.info(
                    "BG-ENV",
                    f"<Picture {i}> 挂在环境类 Subject 下（官方 §2.1 允许），"
                    f"其背景即主体内容，跳过背景污染检查",
                )
            elif i not in covered:
                r.warn(
                    "BG-POLLUTION",
                    f"<Picture {i}> 未声明背景处理方式；若参考图带棚拍纯色背景，"
                    f"需写明「<Picture {i}> 不得展示 X 背景，替换为实际场景」",
                )

    # ---- 12. Negative ----
    neg = re.search(r"Negative\s*[::]\s*(.*?)(?:\n\s*\n|$)", text, re.S | re.I)
    if neg:
        words = [w.strip() for w in neg.group(1).split(",") if w.strip()]
        real = [w for w in words if w and w.lower() != "n/a"]
        if len(real) > 10:
            r.error("NEG-LONG", f"Negative 共 {len(real)} 个词，超过 10 个上限，需精简")
        else:
            r.info("NEG-OK", f"Negative 共 {len(real)} 个词")
        # Negative 必须是英文
        cn_neg = [w for w in real if re.search(r"[\u4e00-\u9fff]", w)]
        if cn_neg:
            r.error("NEG-CN", f"Negative 必须用英文，检测到中文：{cn_neg}")
    else:
        r.info("NEG-NONE", "未检测到 Negative 段（官方无此字段，本 skill 建议添加）")

    # ---- 13. 对白格式（V1.1：中文版用「角色名说"…"」即可） ----
    dialogue_hint = re.findall(r"[「“\"][^「”\"\n]{3,}[」”\"]", dd)
    d_tags = re.findall(r"<d>", dd)
    if dialogue_hint:
        if d_tags:
            r.info("DLG-OFFICIAL", f"使用官方 <d> 包裹 {len(d_tags)} 处对话（英文版/精确对齐场景）")
        else:
            ok_fmt = sum(
                1 for b in re.findall(r"^\s*→\s*(.+)$", dd, re.M)
                if re.search(DLG_CN, b)
            )
            if ok_fmt:
                r.info("DLG-CN", f'中文对白格式正确：{ok_fmt} 处「角色名说"…"」')
            else:
                r.warn(
                    "DLG-FMT",
                    f"检测到 {len(dialogue_hint)} 处对话文本，建议统一为 "
                    f"「→角色名说\"……\"」（中文版）或 <d>[中文] \"……\"</d>（官方版）",
                )

    # ---- 14. 语言策略：英文元素必须为英文，叙述中文为正常 ----
    # V1.1 起：叙述性文本用中文是规范写法，不再告警。
    # 反过来要检查「该用英文的地方没用英文」。

    # 14a. 字段名必须是英文（parse_sections 已保证，这里给出正向确认）
    if not missing:
        r.info("LANG-FIELD", "六个字段名均为英文 ✓")

    # 14b. 保留标记必须是英文
    ra = secs.get("retention_analysis", "")
    # 注意：中文提示词里用的是全角冒号「：」，正则要两种都收
    cn_marker = re.findall(
        r"<Subject\s*\d+>\s*[:：]?\s*([\u4e00-\u9fff]{2,6})[\s，。]", ra
    )
    cn_marker = [m for m in cn_marker if m in ("完全保留", "部分保留", "属性转移", "弱参考")]
    if cn_marker:
        r.error("LANG-MARKER", f"保留标记必须用英文，检测到中文：{cn_marker}")

    # 14c. 标签名必须是英文
    for wrong in re.findall(r"<\s*(主体|图片|视频|音频|Subject|Picture|Video|Audio)\s*[^0-9]*(\d+)\s*>", text):
        if wrong[0] in ("主体", "图片", "视频", "音频"):
            r.error("LANG-LABEL", f"标签必须用英文，检测到「<{wrong[0]} {wrong[1]}>」")

    # 14d. 中英混写检测：英文叙述里突然出现大段中文叙述（易让模型混淆结构）
    # 官方 §5：对话/歌词保留原语言放在 <d> 内，属于合法中文，必须先剔除再判断
    dd_nod = re.sub(r"<d>.*?</d>", " ", dd, flags=re.S)
    dd_nod = re.sub(r"\[(?:Chinese|English|Mandarin)\]", " ", dd_nod, flags=re.I)
    if re.search(r"\b(the target video|a medium shot|the camera)\b", dd_nod, re.I) and \
       len(re.findall(r"[\u4e00-\u9fff]{6,}", dd_nod)) > 3:
        r.warn(
            "LANG-MIX",
            "detailed_description 中英混写。建议整段统一："
            "要么全中文（默认），要么全英文（需要官方标记时）",
        )

    # ---- 15. 任务类型前缀（官方 §3，6 选 1 或 + 组合）----
    TASK_TYPES = {
        "keyframe completion", "reference generation", "video editing",
        "video continuation", "audio reuse", "audio reference",
    }
    sm = secs.get("summary", "")
    # 官方允许用 ` + ` 组合多个任务类型，例如
    # [video continuation + keyframe completion]
    prefixes = [
        p.strip()
        for raw in re.findall(r"\[\s*([a-z][a-z +\-]+?)\s*\]", sm)
        for p in raw.split("+")
        if p.strip()
    ]
    if prefixes:
        bad = [p for p in prefixes if p.lower() not in TASK_TYPES]
        if bad:
            r.error(
                "TASK-BAD",
                f"summary 任务类型前缀非法：{bad}。"
                f"合法值：{sorted(TASK_TYPES)}",
            )
        else:
            r.info("TASK-OK", f"任务类型前缀：{prefixes}")

    # ---- 16. 多镜头 [Shot N] 时长预算 ----
    _check_shot_budget(r, dd, sm, duration)

    # ---- 17. 说话人 ID（官方 §4.4 / §127）----
    # 凡是有 <d> 对白，说话人就应有稳定 ID (S1)/(S2)，跨镜头保持一致
    d_blocks = re.findall(r"<d>.*?</d>", dd, re.S)
    if d_blocks:
        # V1.2：中文提示词里普遍用全角括号（S1），V1.1 只认半角 → 误报
        ids = re.findall(r"[\(（]\s*(S\d+(?:\s*,\s*S\d+)*)\s*[\)）]", dd)
        if not ids:
            r.warn(
                "SPK-ID",
                f"检测到 {len(d_blocks)} 处 <d> 对白，但没有说话人 ID。"
                f"官方 §4.4 要求：说话的角色用稳定 ID 如 (S1)/(S2)，"
                f"放在 <d> 之外，跨镜头保持一致；不发声的角色不给 ID",
            )
        else:
            flat_ids = sorted({i.strip() for grp in ids for i in grp.split(",")})
            r.info("SPK-OK", f"说话人 ID：{flat_ids}（共 {len(d_blocks)} 处对白）")

    # ---- 18. BGM 抽象情绪词（官方 §162）----
    # 官方：只写乐器/速度/节奏/力度变化，禁用抽象情绪词、不解释音乐的情感功能
    bgm = secs.get("non_diegetic_music", "")
    if bgm and bgm.strip().upper() != "N/A":
        MOOD = [
            "warm", "hopeful", "sad", "touching", "moving", "emotional",
            "romantic", "tense", "triumphant", "heartwarming", "uplifting",
            "melancholic", "joyful", "sorrowful", "nostalgic",
            "温暖", "希望", "感人", "动人心弦", "催泪", "伤感",
        ]
        hit = [w for w in MOOD if re.search(rf"\b{re.escape(w)}\b", bgm, re.I)]
        if hit:
            r.warn(
                "BGM-MOOD",
                f"non_diegetic_music 出现抽象情绪词：{hit}。"
                f"官方 §162 要求只写乐器/速度/节奏/力度变化，"
                f"不解释音乐的情感功能",
            )
        else:
            r.info("BGM-OK", "non_diegetic_music 未使用抽象情绪词")

    # ---- 19. 模糊词（V1.3 合并自 minimax-h3-prompt-standardizer）----
    # 抽象形容词对模型是无效指令，须换成构图/运动/色彩/光线/节奏/质感
    VAGUE = [
        "震撼", "高级感", "唯美", "氛围感", "有张力", "很带感",
        "大片感", "大片既视感", "绝美", "超燃",
    ]
    dd_all = dd + "\n" + secs.get("summary", "")
    hit = [w for w in VAGUE if w in dd_all]
    if hit:
        r.warn(
            "VAGUE",
            f"出现模糊词：{hit}。须替换为可生成维度"
            f"（构图 / 运动 / 色彩 / 光线 / 节奏 / 质感）",
        )

    # cinematic：官方 base-en §4.2 允许作首句整体风格标签，其余位置视为偷懒
    for m in re.finditer(r"cinematic|电影感", dd, re.I):
        if m.start() > 120:
            r.warn(
                "VAGUE-CINE",
                f"`{m.group(0)}` 出现在 detailed_description 第 "
                f"{m.start()} 字符处（非首句）。"
                f"官方仅允许作 Shot 1 开头的整体风格标签；"
                f"此处须改写为具体光位 / 构图 / 画幅 / 运镜",
            )
            break

    # ---- 20. 转场空话（V1.3）----
    if re.search(r"转场|过渡|切换", dd):
        if re.search(r"丝滑|自然过渡|流畅(?:地)?(?:过|切|转)|无缝衔接", dd):
            if not re.search(
                r"匹配|承接|接上|同一|延续|画右|画左|同方向|继续|保持", dd
            ):
                r.warn(
                    "TRANS-EMPTY",
                    "转场只写了观感形容词（丝滑 / 自然 / 流畅），未指明可见匹配元素。"
                    "须写明两段的共有钩子：视线 / 动作 / 形状 / 色彩 / 运动方向 / 声音",
                )

    # ---- 21. 参考图上传顺序（V1.3）----
    # 前置块写在提示词之外，所以要在全文 text 里找，不能在 dd 里找
    pics_used = sorted(defs.get("Picture", set()), key=int)
    has_order_block = bool(
        re.search(r"图片上传顺序|image\s+upload\s+order", text, re.I)
    )
    if pics_used and not has_order_block:
        r.warn(
            "PIC-ORDER",
            f"使用了 {len(pics_used)} 张参考图（<Picture "
            f"{'/'.join(pics_used)}>），但提示词前未声明「图片上传顺序」。"
            f"H3 只按上传先后认图，不声明极易对不上号",
        )
    elif pics_used:
        # 中英文两种写法都要认：@图片N / @Image N / @图片 N
        declared = re.findall(r"@\s*(?:图片|image)\s*(\d+)", text, re.I)
        undeclared = [p for p in pics_used if p not in declared]
        if undeclared:
            r.warn(
                "PIC-ORDER-MISS",
                f"<Picture {'/'.join(undeclared)}> 在正文被引用，"
                f"但上传顺序块里没有对应的 @图片N 声明",
            )
        else:
            r.info("PIC-ORDER", f"图片上传顺序已声明：{declared}")

    # ---- 21b. 无图模式门禁 / 读图校准提醒（V1.5）----
    # Ref2VA 是全参考模式：没有参考图 = 让模型自己发明主角，必须显式声明。
    # 强声明 = 正式的无图模式声明块；弱标注 = 单个 Subject 里的「无参考图，由文字描述定义」。
    # V1.5.1：场景 Subject 写「无参考图」是模板标准写法，不能当成整条提示词声明了无图模式，
    # 否则「有图 + 场景无图」的常规提示词会被误判成 IMG-CONFLICT。
    # 强声明只在**提示词前置块**（subject_definitions 之前）里找：
    # Subject 内部写「无参考图 / No reference image; defined by text only」是「这个 Subject 没图」，
    # 不等于整条提示词声明了无图模式（英文示例 sample_c 就踩过这个坑）。
    head_block = re.split(r"subject_definitions", text, maxsplit=1)[0]
    strong_decl = bool(
        re.search(r"无图模式|没有任何参考图|no\s+reference", head_block, re.I)
    )
    weak_decl = bool(re.search(r"无参考图|由文字(?:描述)?定义|文字描述", text))
    if not (pics_used or defs.get("Video") or defs.get("Audio")):
        # 三种参考素材全都没有 = 无图模式
        if strong_decl or weak_decl:
            chunks = re.split(r"(<Subject\s*\d+>)", defs_block)
            miss = []
            for k in range(1, len(chunks) - 1, 2):
                label, seg_body = chunks[k], chunks[k + 1]
                if not re.search(
                    r"无参考图|由文字(?:描述)?定义|文字描述|text[- ]only", seg_body
                ):
                    m2 = re.search(r"\d+", label)
                    if m2:
                        miss.append(m2.group(0))
            if miss:
                r.warn(
                    "IMG-TXT-DEF",
                    f"已声明无图模式，但 <Subject {'/'.join(miss)}> 未标注"
                    f"「无参考图，由文字描述定义」——模型会以为漏了图",
                )
            elif strong_decl:
                r.info("IMG-MODE", "无图模式已声明，全部 Subject 均标注由文字定义")
            else:
                r.info(
                    "IMG-MODE",
                    "全部 Subject 已标注由文字定义；建议在提示词前补一段正式的"
                    "「无图模式（已确认）」声明块，并附上线前补图清单",
                )
        elif seg_index > 1:
            # 多段输出：后续段复用第 1 段的 subject_definitions，不重复引用属正常
            r.info(
                "IMG-INHERIT",
                "续段未重复引用参考素材（沿用第 1 段定义，属正常写法）",
            )
        else:
            r.warn(
                "IMG-DECL",
                "全文没有 <Picture N>，也没有声明「无图模式」。Ref2VA 是全参考模式："
                "要么先向用户索要参考图，要么经用户确认后走无图模式并显式声明",
            )
    elif strong_decl:
        r.error(
            "IMG-CONFLICT",
            "同时出现「无图模式」声明与参考素材引用，自相矛盾，须二选一",
        )
    elif pics_used:
        r.info(
            "IMG-CALIB",
            f"检测到 {len(pics_used)} 张参考图：确认已走完读图校准三步法"
            f"（读图 → 列校准表 → 按图重写 Subject）",
        )

    # ---- 22. 多段尾帧状态（V1.3）----
    segs = re.findall(r"【第\s*\d+\s*段", text)
    if len(segs) >= 2:
        tails = re.findall(r"【本段尾帧】", text)
        if len(tails) < len(segs):
            r.warn(
                "TAIL-FRAME",
                f"多段输出共 {len(segs)} 段，但只有 {len(tails)} 段写了【本段尾帧】。"
                f"每段结尾须写明尾帧状态 + 下段切点，否则跨段接不上",
            )
        else:
            r.info("TAIL-FRAME", f"{len(segs)} 段均已写明尾帧状态")

    return r


def _check_shot_budget(r, dd, sm, duration):
    """官方多镜头写法 [Shot N] At 00:0X.000 的时长预算校验。

    单镜头时间码模式（0–1s）由第 8 项负责，这里只管官方的切镜写法。
    核心：中文台词按字数估算口播时长，看是否塞得进该镜头的可用秒数。
    """
    shots = re.split(r"\[Shot\s*(\d+)\]", dd)
    if len(shots) < 3:
        return  # 无 [Shot N] 写法，交给时间码/节拍逻辑
    # shots: ['', '1', body1, '2', body2, ...]
    order, bodies = [], []
    for k in range(1, len(shots) - 1, 2):
        order.append(int(shots[k]))
        bodies.append(shots[k + 1])

    # 各镜起点：显式 At 00:0X.000，缺则按上一镜结束（首镜为 0）
    starts = {}
    for idx, body in zip(order, bodies):
        m = re.search(r"At\s*(\d{2}):(\d{2})\.(\d{3})", body)
        if m:
            starts[idx] = int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3)) / 1000
    if 0.0 not in starts.values():
        starts[order[0]] = 0.0

    # 目标总时长：优先 --duration，其次从 summary 里找 "15-second" / "15 秒"
    total = duration
    if total is None:
        m = re.search(r"(\d+(?:\.\d+)?)[-\s]*(?:second|sec|s)\b", sm, re.I) or \
            re.search(r"(\d+(?:\.\d+)?)\s*秒", sm)
        if m:
            total = float(m.group(1))

    # 逐镜边界
    bounds = {}
    for i, idx in enumerate(order):
        nxt = order[i + 1] if i + 1 < len(order) else None
        end = starts.get(nxt) if nxt is not None else total
        bounds[idx] = (starts.get(idx, 0.0), end)

    # 台词字数预算：中文口语约 4.5 字/秒（含停顿）； brisk 约 5.2，情绪慢速约 3.8
    RATE = 4.5
    for idx, body in zip(order, bodies):
        s, e = bounds[idx]
        if e is None:
            r.warn("SHOT-NOEND", f"[Shot {idx}] 起点 {s:.3f}s，但无法确定结束时间"
                                 f"（未指定 --duration 且 summary 无时长）")
            continue
        span = e - s
        lines = re.findall(r"<d>(?:\[[^\]]*\])?\s*(.*?)</d>", body, re.S)
        if not lines:
            continue
        chars = sum(len(re.findall(r"[\u4e00-\u9fff]", ln)) for ln in lines)
        if chars == 0:
            continue
        need = chars / RATE
        # 台词之外还要留动作/反应时间，按 1.2s 起算
        slack = span - need
        if slack < 0:
            r.error(
                "SHOT-OVER",
                f"[Shot {idx}] 仅 {span:.1f}s（{s:.0f}–{e:.0f}s），"
                f"但 {chars} 字台词需 {need:.1f}s，超出 {abs(slack):.1f}s。"
                f"要么砍台词到 {int(span * RATE)} 字以内，要么把该镜延长到 "
                f"{need + 1.2:.1f}s（相应压缩其它镜头或加长总时长）",
            )
        elif slack < 1.2:
            r.warn(
                "SHOT-TIGHT",
                f"[Shot {idx}] {span:.1f}s 内塞 {chars} 字台词（需 {need:.1f}s），"
                f"只剩 {slack:.1f}s 做动作/反应，偏紧。建议留 ≥1.2s",
            )
        else:
            r.info(
                "SHOT-OK",
                f"[Shot {idx}] {span:.1f}s / {chars} 字台词 ≈ {need:.1f}s，"
                f"余 {slack:.1f}s",
            )

    # 总时长交代
    real_end = starts.get(order[-1], 0.0)
    if total is not None:
        r.info("SHOT-TOTAL", f"{len(order)} 个镜头，末镜起于 {real_end:.0f}s，"
                             f"声明总时长 {total:g}s")


def check_multi(text, duration=None):
    """多段输出校验（V1.3）。

    按【第N段｜…】切分，每段独立跑一遍 check()（所有内容类校验逐段生效），
    再补全局检查（尾帧状态 / 跨段锚点）。报告条目加段号前缀。
    """
    r = Report()
    parts = re.split(r"(【第\s*\d+\s*段[^\n]*)", text)
    segs = [(parts[i].strip(), parts[i + 1])
            for i in range(1, len(parts) - 1, 2)]
    if len(segs) < 2:
        return check(text, duration)

    r.info("MULTI-SEG", f"多段输出：共 {len(segs)} 段，逐段校验")
    for idx, (title, body) in enumerate(segs, 1):
        sub = check(body, duration, seg_index=idx)
        label = f"第{idx}段 "
        for lv, code, msg in sub.items:
            r.add(lv, code, label + msg)

    # ---- 全局检查：尾帧状态 ----
    tails = re.findall(r"【本段尾帧】", text)
    if len(tails) < len(segs):
        r.warn(
            "TAIL-FRAME",
            f"多段输出共 {len(segs)} 段，但只有 {len(tails)} 段写了【本段尾帧】。"
            f"每段结尾须写明尾帧状态 + 下段切点，否则跨段接不上",
        )
    else:
        r.info("TAIL-FRAME", f"{len(segs)} 段均已写明尾帧状态")

    # ---- 全局检查：跨段锚点 ----
    if "【整体设定】" not in text:
        r.warn(
            "ANCHOR-MISS",
            "多段输出建议先写【整体设定】，定死角色 / 场景 / 声音 / 时间四个锚点，"
            "否则各段容易各写各的",
        )
    return r


def main():
    ap = argparse.ArgumentParser(description="H3 Ref2VA 提示词校验器")
    ap.add_argument("file", help="提示词文件路径")
    ap.add_argument("--duration", type=float, default=None, help="目标时长（秒）")
    args = ap.parse_args()

    p = Path(args.file)
    if not p.exists():
        print(f"[E] FILE-NOTFOUND 文件不存在: {p}")
        return 2
    text = p.read_text(encoding="utf-8")

    # V1.3：多段输出走 check_multi，逐段校验
    if len(re.findall(r"【第\s*\d+\s*段", text)) >= 2:
        r = check_multi(text, args.duration)
    else:
        r = check(text, args.duration)
    c = r.counts

    print("=" * 62)
    print(f"  H3 Ref2VA 提示词校验报告 · {p.name}")
    print("=" * 62)
    if not r.items:
        print("  无问题")
    for lv, code, msg in r.items:
        print(f"  [{lv}] {code:<18} {msg}")
    print("-" * 62)
    print(f"  错误 {c['E']} · 警告 {c['W']} · 提示 {c['I']}")
    print("=" * 62)

    return 1 if c["E"] else 0


if __name__ == "__main__":
    sys.exit(main())
