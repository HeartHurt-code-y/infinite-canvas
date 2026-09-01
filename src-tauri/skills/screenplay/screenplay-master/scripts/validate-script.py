# -*- coding: utf-8 -*-
"""
Screenplay Quality Validation Script for screenplay-master skill.
Performs 10 automated quality checks on short drama screenplays.

Supports both Markdown and Fountain format scripts.
Outputs results as JSON to stdout, summary table to stderr.
"""

import argparse
import json
import re
import sys
import os
import traceback
from collections import defaultdict, OrderedDict
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Any

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np


def _find_chinese_font():
    """Try to find a usable Chinese font on the system."""
    candidates = ['SimHei', 'Microsoft YaHei', 'SimSun', 'KaiTi',
                  'FangSong', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei',
                  'WenQuanYi Zen Hei', 'AR PL UMing CN', 'STHeiti', 'PingFang SC']
    available = {f.name for f in fm.fontManager.ttflist}
    for name in candidates:
        if name in available:
            return name
    for f in fm.fontManager.ttflist:
        if any(kw in f.name.lower() for kw in ['cjk', 'hei', 'song', 'ming', 'kai', 'fang', 'chinese']):
            return f.name
    return None


_CHINESE_FONT = _find_chinese_font()
if _CHINESE_FONT:
    plt.rcParams['font.sans-serif'] = [_CHINESE_FONT, 'DejaVu Sans']
else:
    plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False


HOOK_CONFIG: Dict[str, Dict[str, int]] = {
    "极速": {"interval": 10},
    "弧光": {"interval": 15},
    "长剧": {"interval": 15},
}

PAYMENT_CARDS: Dict[str, Dict[str, int]] = {
    "card1": {"min": 8,  "max": 16},
    "card2": {"min": 25, "max": 30},
    "card3": {"min": 45, "max": 55},
}

EMOTION_KEYWORDS: Dict[str, List[str]] = {
    "愤怒": [
        "愤怒", "怒火", "暴怒", "气愤", "气炸", "吼", "咆哮", "摔", "砸",
        "咬牙切齿", "怒不可遏", "火冒三丈", "勃然大怒", "怒目", "攥紧拳头",
        "额头青筋", "眼中喷火", "杀气", "厉声", "喝斥", "怒吼", "暴跳如雷"
    ],
    "悲伤": [
        "悲伤", "哭泣", "泪水", "眼泪", "哽咽", "心碎", "绝望", "哀伤",
        "痛哭", "泣不成声", "泪流满面", "黯然", "低落", "抽泣", "崩溃",
        "呜咽", "心如刀绞", "痛不欲生", "泪如雨下", "失声", "压抑的哭声",
        "红了眼眶", "强忍泪水", "无声落泪", "把头埋进"
    ],
    "喜悦": [
        "喜悦", "开心", "欢笑", "幸福", "甜蜜", "欣喜", "激动", "灿烂",
        "嘴角上扬", "眉开眼笑", "笑出声", "眼中闪光", "心花怒放", "开怀",
        "雀跃", "如释重负", "松了一口气", "嘴角噙笑", "眼含笑", "春风满面"
    ],
    "恐惧": [
        "恐惧", "害怕", "惊恐", "颤抖", "脸色苍白", "瑟瑟发抖", "后退",
        "瞳孔收缩", "毛骨悚然", "冷汗", "浑身僵硬", "难以置信", "倒吸",
        "背脊发凉", "不寒而栗", "头皮发麻", "腿软", "退缩", "躲避"
    ],
    "紧张": [
        "紧张", "屏住呼吸", "握紧", "心跳加速", "手心冒汗", "悬着", "紧绷",
        "注视", "盯着", "等着", "全神贯注", "咬紧牙关", "捏了一把汗",
        "不敢出声", "血液凝固", "僵住了", "对视", "对峙", "一触即发"
    ],
    "惊讶": [
        "惊讶", "震惊", "愣住", "瞪大眼睛", "目瞪口呆", "难以置信", "失声",
        "呆住", "怔住", "瞳孔放大", "不可思议", "出乎意料", "大惊失色",
        "愣在原地", "张大了嘴", "说不出话", "愕然", "呆立当场"
    ],
    "爽感": [
        "打脸", "反击", "反转", "揭露", "揭穿", "碾压", "甩出", "亮出",
        "众人震惊", "全场哗然", "鸦雀无声", "跪", "求饶", "纷纷低头",
        "霸气", "气场", "碾压", "秒杀", "震慑", "臣服", "目瞪口呆",
        "全场死寂", "再也不敢", "没想到", "才是真正的", "参见龙王"
    ],
}

HOOK_KEYWORDS: List[str] = [
    "悬念", "反转", "钩子", "未完待续", "下一集", "究竟", "为什么",
    "怎么会", "难道", "原来", "竟然", "这才是", "真正的", "没想到",
    "突然", "猛地", "下一秒", "却没注意", "却没发现", "并不知道",
    "身后", "暗中", "背后", "暗中观察", "缓缓地", "悄然",
]

SATISFACTION_KEYWORDS: List[str] = [
    "打脸", "反转", "反击", "揭露", "揭穿", "碾压", "亮出身份",
    "众人震惊", "全场哗然", "绝地反击", "翻盘", "逆袭", "狠狠",
    "一巴掌", "跪", "求饶", "跪地求饶", "啪啪打脸", "傻眼",
    "鸦雀无声", "再也不敢", "霸气", "气场全开", "甩出证据",
    "顶级", "碾压一切", "秒杀", "龙王", "大佬", "真身", "臣服",
]

FOUNTAIN_SCENE_HEADING_RE = re.compile(
    r'^((?:INT|EXT|I/E|INT\.\/EXT|EXT\.\/INT)\.?)[.]?\s+', re.IGNORECASE
)



# =============================================================================
# Data structures
# =============================================================================

@dataclass
class Dialogue:
    character: str
    text: str
    emotion: str = ""
    action: str = ""
    line_number: int = 0
    scene_index: int = 0


@dataclass
class Scene:
    index: int
    title: str = ""
    location: str = ""
    time_of_day: str = ""
    dialogues: List[Dialogue] = field(default_factory=list)
    actions: List[str] = field(default_factory=list)
    description: str = ""
    line_start: int = 0
    line_end: int = 0


@dataclass
class CharacterCard:
    name: str = ""
    gender: str = ""
    tag: str = ""
    speech_pattern: str = ""
    facade: str = ""
    true_self: str = ""
    trigger_point: str = ""
    signature_line: str = ""
    raw: Dict[str, Any] = field(default_factory=dict)



# =============================================================================
# Script Parser
# =============================================================================

class ScriptParser:

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.raw_text = ""
        self.lines: List[str] = []
        self.scenes: List[Scene] = []
        self.dialogues: List[Dialogue] = []
        self.actions: List[str] = []
        self.format_type: str = "unknown"
        self._load()
        self._parse()

    def _load(self):
        if not os.path.exists(self.filepath):
            raise FileNotFoundError(f"Script file not found: {self.filepath}")
        with open(self.filepath, 'r', encoding='utf-8') as f:
            self.raw_text = f.read()
        self.lines = self.raw_text.split('\n')

    def _detect_format(self) -> str:
        fountain_score = 0
        markdown_score = 0
        for line in self.lines[:50]:
            stripped = line.strip()
            if FOUNTAIN_SCENE_HEADING_RE.match(stripped):
                fountain_score += 3
            if re.match(r'^[A-Z\u4e00-\u9fff]{2,30}$', stripped) and line.isupper():
                fountain_score += 1
            if re.match(r'^>', stripped):
                fountain_score += 1
            if re.match(r'^##\s+场景\d+', stripped):
                markdown_score += 3
            if re.match(r'^△\s+\*\*', stripped):
                markdown_score += 3
            if re.match(r'^\[.+\]', stripped):
                markdown_score += 1
        if fountain_score > markdown_score:
            return "fountain"
        elif markdown_score > fountain_score:
            return "markdown"
        return "markdown"

    def _parse(self):
        self.format_type = self._detect_format()
        if self.format_type == "markdown":
            self._parse_markdown()
        else:
            self._parse_fountain()

    def _parse_markdown(self):
        current_scene: Optional[Scene] = None
        scene_idx = 0
        in_dialogue_block = False

        for i, line in enumerate(self.lines):
            stripped = line.strip()

            scene_match = re.match(r'^##\s+场景(\d+)[：:]\s*(.*)', stripped)
            if scene_match:
                if current_scene and current_scene.dialogues:
                    current_scene.line_end = i
                    self.scenes.append(current_scene)
                s_num = int(scene_match.group(1))
                s_title = scene_match.group(2).strip()
                current_scene = Scene(index=s_num, title=s_title, line_start=i)
                loc_match = re.match(
                    r'^([^/\-]+(?:/[^/\-]+)?)\s*[-]\s*(\S+)$', s_title)
                if loc_match:
                    current_scene.location = loc_match.group(1).strip()
                    current_scene.time_of_day = loc_match.group(2).strip()
                scene_idx = s_num
                in_dialogue_block = False
                continue

            if re.match(r'^##\s+本集悬念结尾', stripped):
                if current_scene and current_scene.dialogues:
                    current_scene.line_end = i
                    self.scenes.append(current_scene)
                current_scene = None
                continue

            if re.match(r'^#+\s', stripped) and not re.match(r'^##\s+场景\d+', stripped):
                in_dialogue_block = False
                continue

            if current_scene is None:
                continue

            bracket_desc = re.match(r'^【(.+)】\s*$', stripped)
            if bracket_desc:
                current_scene.actions.append(bracket_desc.group(1))
                self.actions.append(bracket_desc.group(1))
                continue

            cam_match = re.match(r'^\[(.+?)\][：:]?\s*(.*)', stripped)
            if cam_match:
                desc = cam_match.group(2).strip()
                if desc:
                    current_scene.actions.append(desc)
                    self.actions.append(desc)
                continue

            dialogue_match = re.match(
                r'^△\s+\*\*(.+?)\*\*\s*(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)',
                stripped)
            if dialogue_match:
                char_name = dialogue_match.group(1).strip()
                emotion_action = dialogue_match.group(2) or ""
                text = dialogue_match.group(3).strip()
                emotion = ""
                action = ""
                if emotion_action:
                    parts = re.split(r'[/／]', emotion_action)
                    if len(parts) >= 2:
                        emotion = parts[0].strip()
                        action = parts[1].strip()
                    else:
                        emotion = emotion_action.strip()
                dialogue = Dialogue(
                    character=char_name, text=text, emotion=emotion,
                    action=action, line_number=i + 1,
                    scene_index=current_scene.index)
                current_scene.dialogues.append(dialogue)
                self.dialogues.append(dialogue)
                continue

            if in_dialogue_block and stripped and not stripped.startswith('#'):
                if current_scene.dialogues:
                    current_scene.dialogues[-1].text += stripped
                continue

            if re.match(r'^\*\*', stripped) or re.match(
                    r'^[^【\[#△]+[：:].*', stripped):
                in_dialogue_block = True
            else:
                if stripped and not stripped.startswith('#') \
                        and not stripped.startswith('>'):
                    current_scene.actions.append(stripped)
                    self.actions.append(stripped)

        if current_scene and current_scene.dialogues:
            current_scene.line_end = len(self.lines)
            self.scenes.append(current_scene)


    def _parse_fountain(self):
        current_scene: Optional[Scene] = None
        scene_idx = 0
        pending_character: Optional[str] = None

        for i, line in enumerate(self.lines):
            stripped = line.strip()

            if FOUNTAIN_SCENE_HEADING_RE.match(stripped):
                if current_scene and current_scene.dialogues:
                    current_scene.line_end = i
                    self.scenes.append(current_scene)
                scene_idx += 1
                current_scene = Scene(index=scene_idx, line_start=i)
                heading = FOUNTAIN_SCENE_HEADING_RE.sub('', stripped)
                parts = re.split(r'\s*[-–—]\s*', heading, maxsplit=1)
                if len(parts) >= 2:
                    current_scene.location = parts[0].strip()
                    current_scene.time_of_day = parts[1].strip()
                else:
                    current_scene.location = heading.strip()
                current_scene.title = stripped
                pending_character = None
                continue

            if current_scene is None:
                continue

            if stripped and not stripped.startswith('#') \
                    and not stripped.startswith('>') \
                    and not stripped.startswith('[') \
                    and not stripped.startswith('('):
                prev_empty = (i == 0) or (i > 0 and not self.lines[i - 1].strip())
                if prev_empty and i + 1 < len(self.lines):
                    next_line = self.lines[i + 1].strip()
                    if next_line and not next_line.startswith('#') \
                            and not next_line.startswith('>'):
                        pending_character = stripped
                        continue

            if pending_character and stripped \
                    and not stripped.startswith('#') \
                    and not stripped.startswith('>'):
                dialogue = Dialogue(
                    character=pending_character, text=stripped,
                    line_number=i + 1, scene_index=current_scene.index)
                current_scene.dialogues.append(dialogue)
                self.dialogues.append(dialogue)
                pending_character = None
                continue

            if stripped.startswith('>'):
                continue

            if stripped and not stripped.startswith('#') \
                    and not pending_character:
                current_scene.actions.append(stripped)
                self.actions.append(stripped)
                pending_character = None

        if current_scene and current_scene.dialogues:
            current_scene.line_end = len(self.lines)
            self.scenes.append(current_scene)

    def get_all_text(self) -> str:
        return '\n'.join(d.text for d in self.dialogues)

    def get_scene_count(self) -> int:
        return len(self.scenes)


def load_character_card(filepath: str) -> Optional[CharacterCard]:
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            if '_example' in data and isinstance(data['_example'], dict):
                data = data['_example']
            data = {k: v for k, v in data.items() if not k.startswith('_')}
        return CharacterCard(
            name=data.get('name', ''),
            gender=data.get('gender', ''),
            tag=data.get('tag', ''),
            speech_pattern=data.get('speech_pattern', ''),
            facade=data.get('facade', ''),
            true_self=data.get('true_self', ''),
            trigger_point=data.get('trigger_point', ''),
            signature_line=data.get('signature_line', ''),
            raw=data)
    except Exception as e:
        print(f"Warning: Failed to load character card: {e}", file=sys.stderr)
        return None



# =============================================================================
# Check Functions (each wrapped in try/except)
# =============================================================================

def safe_check(func):
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            return {
                "check": func.__name__.replace("check_", ""),
                "status": "ERROR",
                "message": str(e),
                "traceback": traceback.format_exc(),
                "details": {}
            }
    return wrapper


@safe_check
def check_dialogue_length(parser: ScriptParser, **kwargs) -> Dict[str, Any]:
    violations = []
    total = len(parser.dialogues)
    for d in parser.dialogues:
        chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', d.text))
        if chinese_chars > 15:
            violations.append({
                "line": d.line_number,
                "character": d.character,
                "text": d.text[:50] + ("..." if len(d.text) > 50 else ""),
                "chinese_chars": chinese_chars,
                "excess": chinese_chars - 15,
            })
    passed = len(violations) == 0
    return {
        "check": "dialogue_length",
        "status": "PASS" if passed else "FAIL",
        "message": f"All {total} dialogue lines within 15-char limit" if passed
                   else f"{len(violations)}/{total} lines exceed 15-char limit",
        "details": {
            "total_dialogues": total,
            "violations": violations,
            "violation_count": len(violations),
        }
    }


@safe_check
def check_hook_density(parser: ScriptParser, mode: str = "极速",
                       episode: int = 1, duration: int = 90, **kwargs) -> Dict[str, Any]:
    config = HOOK_CONFIG.get(mode, HOOK_CONFIG["极速"])
    interval = config["interval"]
    expected_hooks = max(1, duration // interval)
    text = parser.raw_text
    found_hooks = []
    for kw in HOOK_KEYWORDS:
        for m in re.finditer(re.escape(kw), text):
            pos = m.start()
            scene_num = 0
            for scene in parser.scenes:
                scene_text = '\n'.join(
                    parser.lines[scene.line_start:scene.line_end + 1]
                    if scene.line_end else parser.lines[scene.line_start:])
                if kw in scene_text:
                    scene_num = scene.index
                    break
            found_hooks.append({
                "keyword": kw,
                "position": pos,
                "scene": scene_num if scene_num else "unknown",
            })
    hook_count = len(found_hooks)
    threshold = int(expected_hooks * 0.7)
    passed = hook_count >= threshold
    return {
        "check": "hook_density",
        "status": "PASS" if passed else "FAIL",
        "message": f"Found {hook_count} hooks, expected >= {expected_hooks} (mode: {mode}, interval: {interval}s)"
                   if passed else
                   f"Insufficient hooks: {hook_count} found, need >= {threshold} (mode: {mode}, interval: {interval}s)",
        "details": {
            "mode": mode,
            "interval_seconds": interval,
            "duration_seconds": duration,
            "expected_hooks": expected_hooks,
            "found_hooks": hook_count,
            "threshold": threshold,
            "hooks": found_hooks[:20],
        }
    }


@safe_check
def check_scene_count(parser: ScriptParser, **kwargs) -> Dict[str, Any]:
    scene_count = parser.get_scene_count()
    passed = scene_count <= 3
    return {
        "check": "scene_count",
        "status": "PASS" if passed else "FAIL",
        "message": f"Scene count: {scene_count} (max: 3)" if passed
                   else f"Scene count {scene_count} exceeds max of 3",
        "details": {
            "count": scene_count,
            "max_allowed": 3,
            "scenes": [
                {"index": s.index, "title": s.title, "location": s.location}
                for s in parser.scenes
            ]
        }
    }



@safe_check
def check_emotion_curve(parser: ScriptParser, output_chart: Optional[str] = None,
                        **kwargs) -> Dict[str, Any]:
    emotions = OrderedDict([
        ("愤怒", []),
        ("悲伤", []),
        ("喜悦", []),
        ("恐惧", []),
        ("紧张", []),
        ("惊讶", []),
        ("爽感", []),
    ])
    scene_labels = []
    for scene in parser.scenes:
        scene_text = '\n'.join(
            [d.text for d in scene.dialogues] + scene.actions)
        scene_labels.append(f"S{scene.index}")
        for em_name, keywords in EMOTION_KEYWORDS.items():
            score = 0
            for kw in keywords:
                score += len(re.findall(re.escape(kw), scene_text))
            emotions[em_name].append(score)

    scene_count = max(1, len(parser.scenes))
    x = np.arange(scene_count)
    emotion_data = {k: np.array(v) if v else np.zeros(scene_count)
                    for k, v in emotions.items()}

    colors = {
        "愤怒": "#E74C3C",
        "悲伤": "#3498DB",
        "喜悦": "#2ECC71",
        "恐惧": "#9B59B6",
        "紧张": "#F39C12",
        "惊讶": "#1ABC9C",
        "爽感": "#E91E63",
    }

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8), sharex=True)

    for em_name, values in emotion_data.items():
        if np.any(values > 0):
            ax1.plot(x, values, marker='o', linewidth=2, markersize=6,
                     label=em_name, color=colors.get(em_name, '#333333'))

    ax1.set_ylabel('Emotion Intensity', fontsize=12)
    ax1.set_title('Screenplay Emotion Curve - Scene Analysis',
                  fontsize=14, fontweight='bold')
    ax1.legend(loc='upper left', fontsize=9, ncol=4)
    ax1.grid(True, alpha=0.3)
    ax1.set_xticks(x)
    ax1.set_xticklabels(scene_labels if scene_labels else ['S1'])

    area_data = np.zeros((len(emotion_data), scene_count))
    em_names = list(emotion_data.keys())
    for j, em_name in enumerate(em_names):
        area_data[j] = emotion_data[em_name]

    cumsum = np.zeros(scene_count)
    for j, em_name in enumerate(em_names):
        values = area_data[j]
        if np.any(values > 0):
            ax2.fill_between(x, cumsum, cumsum + values, alpha=0.7,
                             label=em_name, color=colors.get(em_name, '#333333'))
            cumsum += values

    ax2.set_xlabel('Scene', fontsize=12)
    ax2.set_ylabel('Cumulative Emotion', fontsize=12)
    ax2.set_title('Composite Emotion Profile (Stacked Area)',
                  fontsize=14, fontweight='bold')
    ax2.legend(loc='upper left', fontsize=9, ncol=4)
    ax2.grid(True, alpha=0.3)
    ax2.set_xticks(x)
    ax2.set_xticklabels(scene_labels if scene_labels else ['S1'])

    plt.tight_layout()

    chart_path = output_chart
    if chart_path:
        os.makedirs(os.path.dirname(chart_path) or '.', exist_ok=True)
        fig.savefig(chart_path, dpi=150, bbox_inches='tight')
    else:
        default_path = os.path.join(
            os.path.dirname(parser.filepath) or '.', 'emotion_curve.png')
        fig.savefig(default_path, dpi=150, bbox_inches='tight')
        chart_path = default_path

    plt.close(fig)

    peaks = {}
    for em_name, values in emotion_data.items():
        if len(values) > 0:
            peak_idx = int(np.argmax(values))
            peak_val = float(np.max(values))
            if peak_val > 0:
                peaks[em_name] = {"scene": peak_idx + 1, "intensity": peak_val}

    total_emotion = float(np.sum([np.sum(v) for v in emotion_data.values()]))
    has_emotion = total_emotion > 0

    return {
        "check": "emotion_curve",
        "status": "PASS" if has_emotion else "WARN",
        "message": f"Emotion curve generated with {total_emotion:.0f} total intensity units"
                   if has_emotion else "No emotion keywords detected in script",
        "details": {
            "chart_path": chart_path,
            "scene_count": scene_count,
            "total_emotion_intensity": total_emotion,
            "emotion_peaks": peaks,
            "scene_labels": scene_labels,
            "emotion_scores": {k: v.tolist() for k, v in emotion_data.items()},
        }
    }



@safe_check
def check_payment_cards(parser: ScriptParser, episode: int = 1, **kwargs) -> Dict[str, Any]:
    results = {}
    all_pass = True
    for card_name, card_range in PAYMENT_CARDS.items():
        cmin = card_range["min"]
        cmax = card_range["max"]
        in_range = cmin <= episode <= cmax
        if episode < cmin:
            distance = cmin - episode
            direction = "before"
        elif episode > cmax:
            distance = episode - cmax
            direction = "after"
        else:
            distance = 0
            direction = "within"
        is_pass = in_range or (episode <= cmax + 5 and episode >= cmin - 3)
        results[card_name] = {
            "expected_range": f"{cmin}-{cmax}",
            "current_episode": episode,
            "in_range": in_range,
            "distance": distance,
            "direction": direction,
            "status": "PASS" if is_pass else "WARN",
        }
        if not is_pass:
            all_pass = False
    passed = all(results[c]["status"] == "PASS" for c in results)
    return {
        "check": "payment_cards",
        "status": "PASS" if passed else "WARN",
        "message": f"Episode {episode} payment card check" if passed
                   else f"Episode {episode} is outside one or more payment card ranges",
        "details": results,
    }


@safe_check
def check_ooc(parser: ScriptParser, character_file: Optional[str] = None,
              **kwargs) -> Dict[str, Any]:
    if not character_file or not os.path.exists(character_file):
        return {
            "check": "ooc",
            "status": "SKIP",
            "message": "No character card provided or file not found; OOC check skipped",
            "details": {"character_file": character_file},
        }
    card = load_character_card(character_file)
    if not card or not card.name:
        return {
            "check": "ooc",
            "status": "SKIP",
            "message": "Failed to load character card",
            "details": {"character_file": character_file},
        }
    char_dialogues = [d for d in parser.dialogues
                      if d.character.strip() == card.name.strip()]
    if not char_dialogues:
        return {
            "check": "ooc",
            "status": "WARN",
            "message": f"No dialogues found for character '{card.name}'",
            "details": {"character": card.name, "dialogue_count": 0},
        }
    ooc_flags = []
    if card.speech_pattern:
        speech_kws = _extract_speech_keywords(card.speech_pattern)
        for d in char_dialogues:
            matches = sum(1 for kw in speech_kws if kw in d.text)
            if matches == 0 and len(speech_kws) > 0:
                ooc_flags.append({
                    "line": d.line_number,
                    "text": d.text[:50],
                    "reason": "speech_pattern_mismatch",
                    "expected_patterns": speech_kws[:5],
                })
    ooc_count = len(ooc_flags)
    threshold_val = max(1, int(len(char_dialogues) * 0.15))
    passed = ooc_count <= threshold_val
    return {
        "check": "ooc",
        "status": "PASS" if passed else "FAIL",
        "message": f"OOC check: {ooc_count} flags in {len(char_dialogues)} dialogues for '{card.name}'"
                   if passed
                   else f"OOC: {ooc_count}/{len(char_dialogues)} dialogues flagged for '{card.name}'",
        "details": {
            "character": card.name,
            "dialogue_count": len(char_dialogues),
            "ooc_flags": ooc_flags[:20],
            "ooc_count": ooc_count,
            "threshold": threshold_val,
            "speech_pattern": card.speech_pattern,
            "tag": card.tag,
        }
    }


def _extract_speech_keywords(pattern: str) -> List[str]:
    kws = []
    quoted = re.findall(r'[\u201c\u201d\u300c\u300e\u2018\u2019]([^\u201c\u201d\u300c\u300e\u2018\u2019]+)[\u201c\u201d\u300d\u300f\u2018\u2019]', pattern)
    kws.extend(quoted)
    items = re.split(r'[、，,；;。.]', pattern)
    for item in items:
        item = item.strip()
        if len(item) >= 2 and len(item) <= 15 and not item.startswith('常'):
            kws.append(item)
    if '卑微' in pattern:
        kws.extend(['好的', '对不起', '嗯', '我错了', '是我的错', '请', '求'])
    if '冰冷' in pattern or '简短' in pattern:
        kws.extend(['不必', '够了', '滚', '知道', '明白'])
    if '粗犷' in pattern:
        kws.extend(['老子', '他妈的', '操', '干'])
    return list(set(kws))



@safe_check
def check_word_count(parser: ScriptParser, duration: int = 90, **kwargs) -> Dict[str, Any]:
    all_text = parser.get_all_text()
    action_text = '\n'.join(parser.actions)
    dialogue_chars = len(re.findall(r'[\u4e00-\u9fff]', all_text))
    action_chars = len(re.findall(r'[\u4e00-\u9fff]', action_text))
    effect_text = '\n'.join(re.findall(r'【特效：(.*?)】', parser.raw_text, re.DOTALL))
    effect_chars = len(re.findall(r'[\u4e00-\u9fff]', effect_text))
    total_chars = dialogue_chars + action_chars
    min_words = duration * 10
    max_words = duration * 12
    min_acceptable = int(min_words * 0.7)
    max_acceptable = int(max_words * 1.3)
    passed = min_acceptable <= total_chars <= max_acceptable
    if total_chars < min_acceptable:
        status_msg = f"Word count {total_chars} BELOW minimum {min_acceptable} (duration: {duration}s)"
    elif total_chars > max_acceptable:
        status_msg = f"Word count {total_chars} ABOVE maximum {max_acceptable} (duration: {duration}s)"
    else:
        status_msg = f"Word count {total_chars} within range [{min_acceptable}, {max_acceptable}]"
    return {
        "check": "word_count",
        "status": "PASS" if passed else "FAIL",
        "message": status_msg,
        "details": {
            "total_chinese_chars": total_chars,
            "dialogue_chars": dialogue_chars,
            "action_chars": action_chars,
            "effect_chars_excluded": effect_chars,
            "duration_seconds": duration,
            "standard_range": f"{min_words}-{max_words}",
            "acceptable_range": f"{min_acceptable}-{max_acceptable}",
            "min_expected": min_words,
            "max_expected": max_words,
        }
    }


@safe_check
def check_suspense_chain(parser: ScriptParser, **kwargs) -> Dict[str, Any]:
    results = []
    suspense_kws = [
        "悬念", "反转", "未完待续", "下一集", "究竟", "为什么",
        "怎么会", "难道", "原来", "竟然", "这才是", "真正的",
        "没想到", "突然", "猛地", "下一秒",
    ]
    for scene in parser.scenes:
        last_dialogues = scene.dialogues[-3:] if len(scene.dialogues) >= 3 else scene.dialogues
        last_text = ' '.join(d.text for d in last_dialogues) if last_dialogues else ''
        found_suspense = []
        for kw in suspense_kws:
            if kw in last_text:
                found_suspense.append(kw)
            for action in scene.actions[-3:]:
                if kw in action:
                    found_suspense.append(kw)
        has_suspense = len(found_suspense) > 0
        has_suspense_section = bool(re.search(
            r'本集悬念结尾|悬念结尾|下集预告',
            '\n'.join(parser.lines[scene.line_start:scene.line_end + 1]
                     if scene.line_end else parser.lines[scene.line_start:])))
        results.append({
            "scene": scene.index,
            "title": scene.title,
            "has_suspense_keywords": has_suspense,
            "suspense_keywords_found": found_suspense,
            "has_suspense_section": has_suspense_section,
            "suspense_quality": "GOOD" if (has_suspense or has_suspense_section) else "MISSING",
        })
    chain_breaks = []
    for i in range(len(results) - 1):
        if results[i]["suspense_quality"] == "MISSING":
            chain_breaks.append({
                "from_scene": results[i]["scene"],
                "to_scene": results[i + 1]["scene"],
                "issue": f"Scene {results[i]['scene']} has no suspense hook",
            })
    all_have_hooks = all(r["suspense_quality"] != "MISSING" for r in results)
    passed = all_have_hooks or len(chain_breaks) <= 1
    return {
        "check": "suspense_chain",
        "status": "PASS" if passed else "FAIL",
        "message": f"Suspense chain: {sum(1 for r in results if r['suspense_quality'] == 'GOOD')}/{len(results)} scenes have hooks"
                   if passed
                   else f"Suspense chain broken: {len(chain_breaks)} breaks found",
        "details": {
            "scene_results": results,
            "chain_breaks": chain_breaks,
            "total_scenes": len(results),
            "scenes_with_hooks": sum(1 for r in results if r["suspense_quality"] == "GOOD"),
        }
    }



@safe_check
def check_satisfaction_density(parser: ScriptParser, **kwargs) -> Dict[str, Any]:
    satisfaction_events = []
    for kw in SATISFACTION_KEYWORDS:
        for m in re.finditer(re.escape(kw), parser.raw_text):
            pos = m.start()
            line_num = parser.raw_text[:pos].count('\n') + 1
            scene_num = 0
            for scene in parser.scenes:
                if scene.line_start <= line_num <= (scene.line_end or len(parser.lines)):
                    scene_num = scene.index
                    break
            satisfaction_events.append({
                "keyword": kw,
                "scene": scene_num if scene_num else "unknown",
                "line": line_num,
            })
    event_count = len(satisfaction_events)
    scene_count = max(1, parser.get_scene_count())
    density = event_count / scene_count
    passed = density >= 0.8
    return {
        "check": "satisfaction_density",
        "status": "PASS" if passed else "WARN",
        "message": f"Satisfaction density: {density:.1f} events/scene ({event_count} events in {scene_count} scenes)"
                   if passed
                   else f"Low satisfaction density: {density:.1f} events/scene (expected >= 0.8)",
        "details": {
            "total_events": event_count,
            "scene_count": scene_count,
            "density": round(density, 2),
            "events_by_keyword": _count_by_key(satisfaction_events, "keyword"),
            "events_by_scene": _count_by_key(satisfaction_events, "scene"),
            "events": satisfaction_events[:30],
        }
    }


def _count_by_key(items: List[Dict], key: str) -> Dict[str, int]:
    counts: Dict[str, int] = defaultdict(int)
    for item in items:
        k = str(item.get(key, "unknown"))
        counts[k] += 1
    return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True))


@safe_check
def check_fountain_format(parser: ScriptParser, **kwargs) -> Dict[str, Any]:
    if parser.format_type != "fountain":
        return {
            "check": "fountain_format",
            "status": "SKIP",
            "message": f"Script is in {parser.format_type} format, not Fountain; format check skipped",
            "details": {"detected_format": parser.format_type},
        }
    issues = []
    for i, line in enumerate(parser.lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if FOUNTAIN_SCENE_HEADING_RE.match(stripped):
            rest = FOUNTAIN_SCENE_HEADING_RE.sub('', stripped)
            if len(rest.strip()) < 3:
                issues.append({
                    "line": i + 1,
                    "type": "scene_heading_too_short",
                    "text": stripped,
                })
    for scene in parser.scenes:
        if not scene.dialogues and scene.index > 0:
            issues.append({
                "scene": scene.index,
                "type": "scene_without_dialogue",
                "text": scene.title,
            })
    issue_count = len(issues)
    passed = issue_count <= 2
    return {
        "check": "fountain_format",
        "status": "PASS" if passed else "FAIL",
        "message": f"Fountain format: {issue_count} issues found" if passed
                   else f"Fountain format: {issue_count} issues found (threshold: 2)",
        "details": {
            "format_type": parser.format_type,
            "issue_count": issue_count,
            "issues": issues[:20],
        }
    }



# =============================================================================
# Main entry point
# =============================================================================

def _print_summary_table(results: List[Dict[str, Any]], quiet: bool) -> None:
    if quiet:
        return
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    CYAN = '\033[96m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

    def color_status(s: str) -> str:
        if s == "PASS": return f"{GREEN}PASS{RESET}"
        if s == "FAIL": return f"{RED}FAIL{RESET}"
        if s == "WARN": return f"{YELLOW}WARN{RESET}"
        if s == "SKIP": return f"{CYAN}SKIP{RESET}"
        if s == "ERROR": return f"{RED}ERROR{RESET}"
        return s

    print(f"\n{BOLD}{'=' * 80}{RESET}", file=sys.stderr)
    print(f"{BOLD}  SCREENPLAY QUALITY VALIDATION REPORT{RESET}", file=sys.stderr)
    print(f"{BOLD}{'=' * 80}{RESET}", file=sys.stderr)
    print(f"  {'Check':<30} {'Status':<10} {'Summary'}", file=sys.stderr)
    print(f"  {'-' * 78}", file=sys.stderr)

    for r in results:
        check_name = r.get('check', 'unknown')
        status = r.get('status', 'UNKNOWN')
        message = r.get('message', '')
        if len(message) > 45:
            message = message[:42] + '...'
        print(f"  {check_name:<30} {color_status(status):<18} {message}", file=sys.stderr)

    total = len(results)
    passes = sum(1 for r in results if r['status'] == 'PASS')
    fails = sum(1 for r in results if r['status'] == 'FAIL')
    warns = sum(1 for r in results if r['status'] == 'WARN')
    skips = sum(1 for r in results if r['status'] == 'SKIP')
    errors = sum(1 for r in results if r['status'] == 'ERROR')

    print(f"  {'-' * 78}", file=sys.stderr)
    print(f"  Total: {total} | {GREEN}Pass: {passes}{RESET} | {RED}Fail: {fails}{RESET} | "
          f"{YELLOW}Warn: {warns}{RESET} | {CYAN}Skip: {skips}{RESET} | {RED}Error: {errors}{RESET}",
          file=sys.stderr)
    print(f"{BOLD}{'=' * 80}{RESET}\n", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Screenplay Quality Validation Script - screenplay-master skill",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python validate-script.py --file script.md --mode 极速 --duration 90
  python validate-script.py --file script.fountain --character char.json --mode 弧光
  python validate-script.py --file script.md --output-chart emotion.png --quiet
        """
    )
    parser.add_argument('--file', '-f', required=True, type=str,
                        help='Path to screenplay file (Markdown or Fountain format)')
    parser.add_argument('--character', '-c', type=str, default=None,
                        help='Path to character card JSON file for OOC check')
    parser.add_argument('--mode', '-m', type=str, default='极速',
                        choices=['极速', '弧光', '长剧'], help='Drama mode (default: 极速)')
    parser.add_argument('--episode', '-e', type=int, default=1,
                        help='Episode number (default: 1)')
    parser.add_argument('--duration', '-d', type=int, default=90,
                        help='Episode duration in seconds (default: 90)')
    parser.add_argument('--output-chart', '-o', type=str, default=None,
                        help='Output path for emotion curve chart (PNG)')
    parser.add_argument('--quiet', '-q', action='store_true', default=False,
                        help='Suppress summary table output to stderr')
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(2)

    try:
        script_parser = ScriptParser(args.file)
    except Exception as e:
        print(f"Error: Failed to parse script: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)

    results = []
    results.append(check_dialogue_length(script_parser))
    results.append(check_hook_density(script_parser, mode=args.mode,
                                       duration=args.duration))
    results.append(check_scene_count(script_parser))
    results.append(check_emotion_curve(script_parser,
                                        output_chart=args.output_chart))
    results.append(check_payment_cards(script_parser, episode=args.episode))
    results.append(check_ooc(script_parser, character_file=args.character))
    results.append(check_word_count(script_parser, duration=args.duration))
    results.append(check_suspense_chain(script_parser))
    results.append(check_satisfaction_density(script_parser))
    results.append(check_fountain_format(script_parser))

    from datetime import datetime
    metadata = {
        "script_file": os.path.abspath(args.file),
        "format": script_parser.format_type,
        "mode": args.mode,
        "episode": args.episode,
        "duration_seconds": args.duration,
        "character_file": os.path.abspath(args.character) if args.character else None,
        "scene_count": script_parser.get_scene_count(),
        "dialogue_count": len(script_parser.dialogues),
        "timestamp": datetime.now().isoformat(),
    }

    _print_summary_table(results, args.quiet)

    has_failure = any(r['status'] == 'FAIL' for r in results)
    has_error = any(r['status'] == 'ERROR' for r in results)

    output = {
        "metadata": metadata,
        "results": results,
        "summary": {
            "total": len(results),
            "pass": sum(1 for r in results if r['status'] == 'PASS'),
            "fail": sum(1 for r in results if r['status'] == 'FAIL'),
            "warn": sum(1 for r in results if r['status'] == 'WARN'),
            "skip": sum(1 for r in results if r['status'] == 'SKIP'),
            "error": sum(1 for r in results if r['status'] == 'ERROR'),
            "overall": "PASS" if not (has_failure or has_error) else "FAIL",
        }
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))

    if has_failure or has_error:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
