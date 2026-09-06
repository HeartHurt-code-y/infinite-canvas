#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 references/04-complete-examples.md 抽取示例 A / B 生成测试样本。"""
from pathlib import Path

src = Path(__file__).resolve().parent.parent / "references" / "04-complete-examples.md"
out = Path(__file__).resolve().parent

import re

text = src.read_text(encoding="utf-8")

START = "subject_definitions:"
END = "Negative:"

blocks = []
pos = 0
while True:
    i = text.find(START, pos)
    if i < 0:
        break
    # 只取「行首」出现的字段名，避免命中正文里的说明文字
    if i > 0 and text[i - 1] not in "\n":
        pos = i + 1
        continue
    # V1.3：若该示例前方带「图片上传顺序」前置块，一并纳入样本
    # （前置块在六段之外，是 PIC-ORDER 校验的目标，必须一起测）
    pre = ""
    head = text[:i]
    m = list(re.finditer(r"^(?:图片上传顺序|Image upload order)[:：]?\s*$", head, re.M))
    if m:
        # 只纳入紧邻本示例、且中间没有其它示例字段名的那一块
        start = m[-1].start()
        between = head[start:i]
        if "subject_definitions:" not in between:
            pre = between.strip()
    j = text.find(END, i)
    if j < 0:
        break
    # 只取行首的 Negative:
    if text[j - 1] not in "\n":
        pos = j + 1
        continue
    k = text.find("\n", j)
    body = text[i:k].strip()
    blocks.append((pre + "\n\n" + body).strip() if pre else body)
    pos = k

for idx, b in enumerate(blocks, 1):
    name = {1: "sample_a.txt", 2: "sample_b.txt", 3: "sample_c.txt",
            4: "sample_d.txt"}.get(
        idx, f"sample_{idx}.txt"
    )
    (out / name).write_text(b + "\n", encoding="utf-8")
    print(f"[OK] {name}  {len(b)} chars")

if not blocks:
    raise SystemExit("未抽取到任何示例块")
