#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
万相3.0 提示词交付前自检脚本
用法: python validate_prompt.py <prompt_file.txt>

适用范围：本脚本面向「全能参考」四段式提示词。首尾帧模式（不写 @ 指代）与视频编辑模式（源视频称 视频1、无 @）有各自的指代/格式约定，相关提示词可能触发「未发现 @图片N」「疑似旧写法 视频1」等提示，属正常现象，按模式自行判断即可。

检查项（对应 SKILL.md §10 交付前自检）：
  1. 四段式结构（【主体】【风格】【时间线】【限制】）齐全且顺序正确
  2. @指代（@图片N/@视频N/@音频N）存在且带 @、用全称
  3. 镜头时间戳 镜头N[a-b秒] 从 0 连续覆盖、不重叠、单段 ≥2s
  4. 互斥组合（固定镜头/持续环绕、一镜到底/硬切转场 等）不同时出现
  5. 提示词正文中未写入 API 参数（resolution/ratio/duration/audio/seed...）
  6. 【限制】条数建议 3—8 条

退出码: 0=通过(仅警告或无问题), 1=存在硬伤, 2=用法错误
"""
import sys
import re


def main():
    if len(sys.argv) < 2:
        print("用法: python validate_prompt.py <prompt_file.txt>")
        sys.exit(2)

    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: 无法读取文件 {path}: {e}")
        sys.exit(2)

    errors = []
    warnings = []

    # 1. 四段式结构
    sections = ["【主体】", "【风格】", "【时间线】", "【限制】"]
    present = [(s, text.find(s)) for s in sections]
    for s, idx in present:
        if idx == -1:
            errors.append(f"缺少一级段落 {s}")
    idxs = [i for _, i in present if i != -1]
    if len(idxs) == 4 and not (idxs[0] < idxs[1] < idxs[2] < idxs[3]):
        errors.append("四段顺序必须为 主体→风格→时间线→限制")

    # 2. @ 指代
    at_refs = re.findall(r"@(图片|视频|音频)\d+", text)
    if not at_refs:
        warnings.append("未发现 @图片N/@视频N/@音频N 指代（纯文生可忽略）")
    # 旧写法检测
    if re.search(r"(?<!@)(?<![一-龥])(图\d+|视频\d+|音频\d+)", text):
        warnings.append("检测到可能遗漏 @ 的旧写法（如图1/视频1），建议统一为 @图片1/@视频1/@音频1")

    # 3. 镜头时间戳
    shots = re.findall(r"镜头\s*\d+\s*\[\s*(\d+)\s*-\s*(\d+)\s*秒\s*\]", text)
    if shots:
        ranges = sorted((int(a), int(b)) for a, b in shots)
        if ranges[0][0] != 0:
            errors.append(f"时间线未从 0 秒开始（首段起点={ranges[0][0]}）")
        for i in range(1, len(ranges)):
            prev_end = ranges[i - 1][1]
            cur_start, cur_end = ranges[i]
            if cur_start < prev_end:
                errors.append(f"时间段重叠：{ranges[i-1]} 与 {ranges[i]}")
            elif cur_start > prev_end:
                warnings.append(f"时间段留空：{prev_end}~{cur_start}秒")
        for a, b in ranges:
            if b - a < 2:
                warnings.append(f"存在 <2秒 的短段：{a}-{b}秒（官方要求单段≥2s）")
        total = ranges[-1][1]
        warnings.append(f"时间线覆盖 0~{total}秒（请确保各段之和 = duration 参数）")
    else:
        warnings.append("未检测到 镜头N[a-b秒] 时间戳（「生成单镜头」可忽略）")

    # 4. 互斥组合
    mutex = [
        ("固定镜头", "持续环绕"),
        ("固定镜头", "持续推进"),
        ("一镜到底", "硬切转场"),
        ("生成单镜头", "硬切转场"),
        ("自然纪录质感", "每秒强转场"),
        ("浅景深近景特写", "交代全景空间关系"),
        ("商品正面 logo 全程朝向镜头", "360 度环绕展示"),
    ]
    for a, b in mutex:
        if a in text and b in text:
            errors.append(f"互斥组合同时出现：『{a}』与『{b}』")

    # 5. API 参数不应写进提示词正文
    param_patterns = [
        (r"\b\d+P\b", "分辨率档位(如1080P)"),
        (r"\bratio\b", "ratio"),
        (r"adaptive", "adaptive"),
        (r"\bduration\b", "duration"),
        (r"\baudio\b", "audio"),
        (r"\bseed\b", "seed"),
        (r"watermark", "watermark"),
        (r"prompt_extend", "prompt_extend"),
        (r"16:9|9:16|4:3|3:4|1:1", "画幅比例"),
    ]
    for pat, name in param_patterns:
        if re.search(pat, text, re.IGNORECASE):
            warnings.append(f"提示词中出现疑似 API 参数词：{name}（参数应在生成页/API 设置，不写进正文）")

    # 6. 限制条数
    if "【限制】" in text:
        limit_block = text[text.find("【限制】"):]
        limit_lines = [
            ln.strip()
            for ln in limit_block.splitlines()
            if ln.strip() and not ln.strip().startswith("【限制】")
        ]
        # 去掉可能的分号/顿号合并行，粗略按中文分号与换行计数
        count = 0
        for ln in limit_lines:
            count += len([x for x in re.split(r"[；;]", ln) if x.strip()])
        if count and not (3 <= count <= 8):
            warnings.append(f"【限制】条数≈{count}（建议 3—8 条，过多会稀释注意力）")

    # 报告
    print("=" * 52)
    print("万相3.0 提示词自检报告")
    print("=" * 52)
    if errors:
        print(f"\n[FAIL] {len(errors)} 个硬伤：")
        for e in errors:
            print("  ✗", e)
    else:
        print("\n[PASS] 结构硬约束全部通过")
    if warnings:
        print(f"\n[WARN] {len(warnings)} 个提示：")
        for w in warnings:
            print("  !", w)
    if not errors and not warnings:
        print("\n完美，直接交付。")
    print()
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
