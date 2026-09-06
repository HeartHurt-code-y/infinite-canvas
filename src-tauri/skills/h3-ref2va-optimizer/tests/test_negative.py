#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""负样本回归：确保该报错的都报错。"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable
SCRIPT = HERE.parent / "scripts" / "validate_ref2va.py"

CASES = [
    # (名称, 内容, 期望码, 时长)
    ("缺段落", "summary:\n测试\n", ["SEC-MISSING"], None),
    ("顺序错", "summary:\na\n\nsubject_definitions:\nb\n\nretention_analysis:\nc\n"
              "detailed_description:\nd\noverall_soundscape:\ne\nnon_diegetic_music:\nf\n",
     ["SEC-ORDER"], None),
    ("用了中文保留标记", "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
                     "retention_analysis:\n<Subject 1>：完全保留 外观。\n\n"
                     "detailed_description:\n→唐糖走路。\n\n"
                     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["LANG-MARKER"], None),
    ("Negative 写中文", "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
                     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
                     "detailed_description:\n→唐糖走路。\n\n"
                     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n\n"
                     "Negative: 不要其他人, 不要夸张表情\n",
     ["NEG-CN"], None),
    ("内心独白", "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
              "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
              "detailed_description:\n→唐糖心跳加速，满脑子都是他。\n\n"
              "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["ABS-BAN"], None),
    ("Negative 超 10 词",
     "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\noverall_soundscape:\n风声。\n\n"
     "non_diegetic_music:\nN/A\n\n"
     "Negative: a, b, c, d, e, f, g, h, i, j, k\n",
     ["NEG-LONG"], None),
    ("时长不匹配", "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
               "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
               "detailed_description:\n[一镜到底] 0–5s，走路。\n→唐糖走路。\n\n"
               "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["TL-MISMATCH"], 10),
    ("节拍模式无时长标注",
     "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n场景是夜晚街头。\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     [], None),

    # ---- V1.2 新增：多镜头时长预算 / 任务类型 / 环境图豁免 / <d> 豁免 ----
    ("末镜台词塞不下",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] A 15-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n"
     "[Shot 1] She walks. <d>[Chinese] 好。</d>\n"
     "[Shot 2] At 00:10.000, she says a very long line. "
     "<d>[Chinese] 如果屏幕前的家人们支持我们，愿意成全我们这一对，"
     "请在评论区留下一句暖心祝福。</d>\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["SHOT-OVER"], None),
    ("任务前缀非法",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[super generation] A scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["TASK-BAD"], None),
    ("任务前缀合法不报错",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation + audio reference] A scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["TASK-OK"], None),
    ("环境参考图豁免背景污染",
     "subject_definitions:\n<Subject 1> is the coffee-shop environment in "
     "<Picture 1>, featuring an exposed brick wall.\n\n"
     "summary:\n[reference generation] A 6-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 环境。\n\n"
     "detailed_description:\n→镜头扫过咖啡馆。\n\n"
     "overall_soundscape:\n环境音。\n\nnon_diegetic_music:\nN/A\n",
     ["BG-ENV"], None),
    ("官方英文版 <d> 对白不报中英混写",
     "subject_definitions:\n<Subject 1> is a woman in <Picture 1>.\n\n"
     "summary:\n[reference generation] A 6-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\nThe camera holds still and she speaks gently, "
     "<d>[Chinese] 如果屏幕前的家人们支持我们，愿意成全我们这一对。</d> "
     "Then she smiles.\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     [], None),

    # ---- V1.3 新增：模糊词 / 转场空话 / 上传顺序 / 多段尾帧 ----
    ("模糊词未替换",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] 一个震撼的夜晚街头场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→镜头缓慢推近，画面很有氛围感。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["VAGUE"], None),
    ("cinematic 用在非首句",
     "subject_definitions:\n<Subject 1> is a woman in <Picture 1>.\n\n"
     "summary:\n[reference generation] A 6-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\nThe camera holds on her face while she "
     "walks slowly down the empty street at night, her coat catching "
     "the orange glow of the streetlamps one after another as she goes. "
     "The whole framing here is cinematic and the light falls gently "
     "across her shoulders as she turns toward the far end of the road.\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["VAGUE-CINE"], None),
    ("cinematic 作首句风格标签不报错",
     "subject_definitions:\n<Subject 1> is a woman in <Picture 1>.\n\n"
     "summary:\n[reference generation] A 6-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\nLive-action, cinematic, a medium shot "
     "frames her walking down the street. She turns her head.\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     [], None),
    ("转场只写空话",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走到门口。\n→丝滑转场到室内。\n→唐糖坐在沙发上。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["TRANS-EMPTY"], None),
    ("转场写了匹配元素不报错",
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖的手伸向门把。\n"
     "→转场：接上同一个门把被压下的动作，切到室内。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     [], None),
    ("有参考图未声明上传顺序",
     "subject_definitions:\n<Subject 1>：唐糖。完全参照 <Picture 1> 外观。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["PIC-ORDER"], None),
    ("上传顺序漏了一张图",
     "图片上传顺序：\n@图片1：唐糖主参考\n\n"
     "subject_definitions:\n<Subject 1>：唐糖。完全参照 <Picture 1> 外观。\n"
     "<Subject 2>：林浩。完全参照 <Picture 2> 外观。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→两人走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["PIC-ORDER-MISS"], None),
    ("英文声明上传顺序被识别",
     "Image upload order:\n@Image 1: Primary reference for <Subject 1>.\n\n"
     "subject_definitions:\n<Subject 1> is a woman in <Picture 1>.\n\n"
     "summary:\n[reference generation] A 6-second scene.\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\nShe walks.\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["PIC-ORDER"], None),
    # 回归：V1.3 修掉的崩溃。六段出现两次但没标【第N段】时，
    # 旧版 zip 截断使 bad 为空、bad[0] 直接 IndexError 崩掉。
    ("多段未标段号不崩溃",
     "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\na\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖停下。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n\n"
     "subject_definitions:\n<Subject 1>：唐糖。\n\nsummary:\nb\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→林浩转身。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["SEC-MULTI"], None),
    ("多段缺尾帧状态",
     "【第1段｜8秒｜唐糖停下】\n"
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖停下。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n\n"
     "【第2段｜7秒｜林浩转身】\n"
     "subject_definitions:\n<Subject 1>：唐糖。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→林浩转身。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["TAIL-FRAME"], None),
    # ---- V1.5 无图模式门禁 ----
    ("无图未声明无图模式",
     "subject_definitions:\n<Subject 1>：唐糖，24 岁中国女性。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["IMG-DECL"], None),
    ("声明无图但未标注文字定义",
     "无图模式：本条没有参考图。\n\n"
     "subject_definitions:\n<Subject 1>：唐糖，24 岁中国女性。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：weak_reference 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["IMG-TXT-DEF"], None),
    ("无图声明与参考图冲突",
     "无图模式：本条没有参考图。\n\n"
     "subject_definitions:\n<Subject 1>：唐糖，完全参照 <Picture 1> 外观。\n\n"
     "summary:\n[reference generation] 一个场景。\n\n"
     "retention_analysis:\n<Subject 1>：fully_preserved 外观。\n\n"
     "detailed_description:\n→唐糖走路。\n\n"
     "overall_soundscape:\n风声。\n\nnon_diegetic_music:\nN/A\n",
     ["IMG-CONFLICT"], None),
]

fails = 0
for name, content, expect, dur in CASES:
    p = HERE / "_neg.txt"
    p.write_text(content, encoding="utf-8")
    cmd = [PY, str(SCRIPT), str(p)]
    if dur is not None:
        cmd += ["--duration", str(dur)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    out = r.stdout
    hit = [c for c in expect if c in out]
    ok = len(hit) == len(expect)
    if not ok:
        fails += 1
        print(f"[{'FAIL'}] 调试输出 ↓\nSTDOUT:\n{out}\nSTDERR:\n{r.stderr}\n{'-'*40}")
    print(f"[{'PASS' if ok else 'FAIL'}] {name:<22} 期望 {expect or '无'} -> 命中 {hit}")

p = HERE / "_neg.txt"
p.unlink(missing_ok=True)
print()
print("负样本回归:", "全部通过" if fails == 0 else f"{fails} 个未通过")
sys.exit(1 if fails else 0)
