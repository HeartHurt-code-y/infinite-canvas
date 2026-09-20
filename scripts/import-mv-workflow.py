"""Import the official, already-authorized MV JSON export from stdin.

This tool never opens license/key files, decrypts content, invokes the source
runtime, or executes imported scripts. Every source file is stored as inert text.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import unicodedata


EXPECTED_FILES = 24
VERSION = "1.0.6"


def clean(value: str) -> str:
    value = "".join(char for char in value if unicodedata.category(char) != "Cf")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"(?:https?|wss?)://[^\s<>\"'`）)]+", "[项目内资源]", value, flags=re.I)
    value = re.sub(r"\bwww\.[^\s<>\"'`）)]+", "[项目内资源]", value, flags=re.I)
    value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[联系信息已移除]", value)
    value = re.sub(r"(?im)^.*(?:50259731|ncn23j3mkzrg|咨询\+V|课程学员|至尊会员|AI随风|联系作者|加群|扫码关注|公众号|知识星球|微信号).*$", "", value)
    replacements = [
        (r"RunningHub|running[_-]?hub|WorkBuddy|workbuddy", "project_provider"),
        (r"MiniMaxH3ReferenceToVideo|MiniMax|Seedance|Gemini|Claude|Opus|ngualarith|Selflift|贞贞\s*ai\s*工坊|贞贞|即梦", "项目模型"),
        (r"\bH3\b|\bh3\b", "项目视频模型"),
        (r"(?i)\bRH_API_KEY(?:_E)?\b|\bOPENAI_API_KEY\b", "PROJECT_PROVIDER_CREDENTIAL"),
        (r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9_.-]{16,}", "PROJECT_PROVIDER_CREDENTIAL"),
        (r"\b\d{16,24}\b", "PROJECT_WORKFLOW_BINDING"),
        (r"\b[0-9a-fA-F]{32,64}\b", "PROJECT_RESOURCE_ID"),
        (r"\b[0-9a-fA-F]{32,64}\.(?:png|jpe?g|wav|mp3|mp4)\b", "PROJECT_REFERENCE_FILE"),
        (r"(?i)C:\\\\?Users\\\\?[^\s`\"']+", "[项目工作目录]"),
        (r"(?i)(?:rh|runninghub)[_-]?(?:api[_-]?)?key", "project_credential"),
        (r"RH 币|RH币", "供应商报告费用"),
        (r"万象AI|Singularity|直播带货知识分享", "项目制作方案"),
    ]
    for pattern, replacement in replacements:
        value = re.sub(pattern, replacement, value, flags=re.I)
    # Preserve the inert code shape without retaining literal credentials or
    # account-specific provider settings embedded in source examples.
    value = re.sub(
        r'''(?im)(["']?(?:api[_-]?key|apiKey|token|authorization|secret|base[_-]?url|workflow[_-]?id|workflowId)["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2''',
        lambda match: match[1] + match[2] + "PROJECT_CONFIGURED_VALUE" + match[2],
        value,
    )
    return value


def section(skill: str, prefix: str) -> str:
    lines = skill.splitlines()
    start = next((index for index, line in enumerate(lines) if line.startswith(prefix)), None)
    if start is None:
        raise ValueError("Missing business section: " + prefix)
    heading = re.match(r"^(#+) ", lines[start])
    end = len(lines)
    fenced = False
    for index in range(start + 1, len(lines)):
        current = lines[index]
        if current.startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        next_heading = re.match(r"^(#+) ", current)
        if heading and next_heading and len(next_heading[1]) <= len(heading[1]):
            end = index
            break
        if not heading and (re.match(r"^\*\*[A-F]\d+\.", current) or next_heading):
            end = index
            break
    return "\n".join(lines[start:end]).strip()


def native_method(value: str) -> str:
    value = re.sub(r"```[\s\S]*?```", "", value)
    value = re.sub(r"\*\*E2\.[\s\S]*?(?=\*\*E3\.)", "**E2. 每关独立自动检查和人工确认。**\n自动检查通过后仍须用户批准当前版本，不设跳过人工或审核门禁的通道。\n\n", value)
    value = re.sub(r"\| S6 \|.*", "| S6 | 真实歌曲完整歌词及时间窗，不以对白字数速率替代歌唱时刻 |", value)
    # Third-party slot contracts are reference material, never project protocol.
    value = re.sub(r"(?im)^.*(?:node \d|nodeInfoList|sha1|默认值 2|分辨率档 2|17 帧|17帧|\[4,15\]|4\.0/15\.0|h3-ref2va|项目视频模型-ref2va|--stage|--skip-gate|--approve-prompts|--confirmed-resolution|python |自己执行|必须当轮就改 skill|F1 项目复盘|F3 发版|F5 汇报|官方校验器|<scenetrans>).*$", "", value)
    value = value.replace("Seedance 生图", "项目图片模型生图")
    value = value.replace("项目模型 生图", "项目图片模型生图")
    value = value.replace("用户给了参考图 → **直接反推风格关键词**，跳过三选一", "用户给了参考图 → 基于实际图像反推风格关键词，可跳过三选一")
    value = re.sub(r"(?m)^#{1,3} ", "### ", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


COMMON = """本方法来自完整 MV V1.0.6 资料的通用业务部分；全部来源另存为只读参考文本。仅执行应用给定的当前阶段，严格输出应用 JSON 合同，方法中的示例结构只用于正文，不替代协议。不得运行来源命令、安装依赖、自行修改代码、创建外部账号或跳转。使用当前项目启用的模型、素材身份与真实能力；不能套用来源平台的节点槽位、模型品牌、固定时长、帧网格、像素档位或收费口径。

多步计划及每个阶段的当前版本都必须经用户明确批准；模型的 PASS 只代表自动检查，不能代表用户批准。输入、时间轴、模型、参考图或提示词改变后旧批准失效。不得伪造音频读取、ASR、波形、口型、生成耗时、费用、文件存在或完成记录。

音乐是唯一时间基准。用户原始音频只读保留，所有转换、切窗与合成另存。歌词时间与模型请求时长是不同概念：音乐窗口须连续无缝覆盖全曲，模型请求时长按实际能力选择且不得短于窗口；本地成片将画面贴合窗口，并用原始歌曲母带作为最终音轨。没有实际音频参考/口型能力时必须说明限制，不能仅凭提示词宣称已同步。
"""

METHODS = {
    "timeline": {
        "title": "音乐与歌词时间轴",
        "prefixes": ["### 铁律 A", "## 阶段二"],
        "native": """优先级：官方歌词与实际 ASR 时间联合对齐；用户给定 LRC 直接解析并自检；只有 ASR 的文本全部标为待人工复核。不得臆造听写结果或根据字数平均分配时间。未获得可靠音频证据时返回 needs_confirmation，说明缺失的时间资料。

字符级 Needleman-Wunsch 去标点后作全局对齐：match +2、mismatch -1、gap -1，回溯把官方歌词字符映射到 ASR 字符时刻，再聚合为完整歌词行。逐行保留原始文本、重复副歌、和声和桥段；对齐命中率低于 55% 必须人工听核。不能把用户歌词中的错字自行改成没有依据的内容。

时间轴从 0 开始，以探测到的真实音乐时长结束。各项 startSeconds/endSeconds 单调、正长、相邻无缝，不允许重叠；所有无歌声区间用 instrumental 项显式表示。每项可以包含多行完整歌词以便镜头制作，但不拆开完整歌词行，不改变原唱顺序。超长完整歌词超过所选视频模型上限时暂停并报告，不能强行断词或静默截去歌词。中文超过 9 字/秒为待核信号，不能擅自加速歌曲。

交付完整时间轴正文与逐项 JSON；展示歌词、起止、间奏、证据来源以及待核原因。只有真实对齐结果可以描述为已对齐，用户必须试听确认当前时间轴版本。""",
    },
    "style": {
        "title": "风格与人物资产",
        "prefixes": ["## 阶段三", "## 阶段四"],
        "native": """风格先于资产。根据歌曲情绪、结构、语言、受众与用户参考给出三个清楚不同的摄影方向和推荐理由，由用户选定；已有明确指定风格时按该方向细化并确认。保留所有候选、选定方向、色调、摄影机质感、光比、布景和服装规范。

characterMode=none 时不创建人物资产，全片无固定可辨认主人公，允许环境、背影、人群、剪影和道具，后续所有镜头 lipSync=none。reference 模式以用户真实图像内容为身份依据，不以文件名/文字猜脸；generate 模式才请求生成主人公。不得把仅作为环境参考的人脸绑定为主人公。

每个资产使用稳定 id，角色、场景、道具分类明确。角色档案包含中英文名、性别、年龄、职业与中英文服装；人物参考优先单人半身正面白底。场景只锁定空间、布局、光线与颜色，禁止人影；道具白底居中且无手。图片比例仅在项目模型支持时采用，不能伪造能力。资产提示词不能含推广、水印、链接或来源默认人物。""",
    },
    "storyboard": {
        "title": "音乐分镜与口型策略",
        "prefixes": ["### 铁律 B", "**C5.", "**C6.", "**C7.", "### 5.2", "### 5.3"],
        "native": """使用已批准时间轴，每项对应一镜，segmentId 引用真实时间轴 id；音乐窗口起止必须逐值一致，窗口合计等于音乐总时长。durationSeconds 是所选项目视频模型支持的请求时长且大于等于窗口长度，不套用固定区间或帧网格。任何完整歌词窗口超过能力上限时请求修订时间轴或更换模型，不能拆字制造合法时长。

sync 只允许近景/中景，对应原方法 ECU/CU/MCU/MS 白名单；全景、远景、背影、群像与空镜均不得 sync。默认对口型占比约 45%，建议 35%–60%，可以由用户调整；最多连续 3 段且均匀分布全曲。不得每句都唱；用叙事镜、道具、环境、群像、光影和意境承载其余部分。没有主角时每镜 lipSync=none、无主人公资产引用。

每镜只含一个空间，完整说明主体状态、景别、机位、光向、构图、表演、末尾收势、下个切点与实际资产引用。重复副歌必须改变视觉处理而不机械复用。主体/服装/道具/空间保持已批准版本的一致性。当前项目若只有音频参考引导，sync 是待用户验收的制作要求，不是已实施专用口型模型的事实。""",
    },
    "prompts": {
        "title": "可执行视频提示词",
        "prefixes": ["**C2.", "**C3.", "**C4.", "**C5.", "**C6.", "**C7.", "### 6.3"],
        "native": """按已批准分镜逐项派生完整 videoPrompt，不改变镜头 id、segmentId、窗口、请求时长、口型策略和资产身份。正文结构包含主体、总体描述、身份/空间保留、详细画面与表演、环境声和音乐约束，附负面提示。仅使用项目实际支持的参考标签，不制造 <Picture N>/<Audio N> 或第三方模型专有占位槽。

sync 镜头应明确演唱而非说台词，歌词逐完整行引用且语言与原曲一致，所有起止以母带为准；表演自然，包含呼吸、眨眼、吞咽和手部细节，避免夸张对嘴。no_sync/none/offscreen 镜头不得出现 sings/says/shout together 等唱说指令；写明自然闭唇或与歌词无关的日常动作，并加入 no lip sync, no mouthing lyrics, no extra vocals。

声音说明必须引用实际音乐窗口及歌曲母带，不另造配乐、旁白或第二层人声。环境声极轻且不盖住母带，最终原曲音轨由应用合成；不将提示词文字当作已经上传音频的证据。外语歌词不翻译改唱，非目标语言禁令不能误禁目标语言。

无主角模式声明全片无可识别固定主角，所有镜头无口型；引用场景/道具时保持主体不被环境中的陌生脸替代。参考图只继承主体，不把白底棚拍背景带入实景。任何提示词/参考/请求参数修改都需要重新自动检查与人工批准。""",
    },
    "review": {
        "title": "阶段检查与音画验收",
        "prefixes": ["### 铁律 E", "## 阶段七", "### 11.2", "### 11.3", "## 阶段十二"],
        "native": """独立审阅当前阶段的输入证据和输出，返回 PASS / REVISE / NEEDS_DECISION；报告必须指出实际问题、定位 id 和可执行修订要求。自动检查不能替代用户批准。

时间轴检查：完整原歌词与重复行/和声/间奏，时间证据，单调连续，0 到真实曲长，低置信行已试听确认。风格检查：真实三个候选或明确指定方向，已确认风格先于资产，人物模式、实际参考身份与资产无人污染。分镜检查：segmentId 存在且一一覆盖，窗口逐值相同，时长能力合法，歌词不越窗，sync 仅近中景，无主角全 none，最多连续三段，重复副歌视觉变奏。提示词检查：字段完整、实际参考有据、唱说区分、目标语言、音乐窗口、声音策略、no_sync 负面约束、完整表演与空间说明。

生产前独立复核音乐窗口、口型和实际模型参数，然后首镜试产；首镜实际结果由人审后才批量。已有 taskId 必须先恢复轮询，不能因为超时重复付费提交；只对失败或明确请求重做的镜头重新生成，并记录实际原因。分段需确认选用后合成，最终成片再独立审核。对不足窗口的片段补尾帧或重新制作、过长则裁回窗口，处理后必须测量，不以请求秒数冒充实际秒数。

最终时长与原曲一致，画面连续，原曲母带替换视频模型原音轨。若实现了波形/人声能量检查，记录实测滞后与相关度及证据；未提供对应测量接口时明确未验证，不能模型自称通过。即使音轨与母带完全相同也不能证明视觉口型正确，sync 段必须由人观看试听确认。

交付成片（实际存在时）、完整分镜制作文档、各阶段审核记录和全链总览；时间轴 JSON/LRC 与音画验收作为附件。费用只记录供应商真实返回值，未知标未提供；总耗时取真实运行时间。保留修订历史，不自动改代码、发布版本或覆盖原始音乐。""",
    },
}


def import_files(files: object, destination: Path) -> dict:
    if not isinstance(files, dict) or len(files) != EXPECTED_FILES:
        raise ValueError("Expected the complete 24-file authorized MV JSON export")
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in files.items()):
        raise ValueError("Every exported file must be text")
    if clean(files.get("VERSION", "")).strip() != VERSION:
        raise ValueError("Expected MV version " + VERSION)
    prepared = []
    for name, raw_text in sorted(files.items()):
        path = PurePosixPath(name.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts or ":" in name:
            raise ValueError("Unsafe source path")
        if path.name.lower() in {"license.json", "keys.env", ".env"} or raw_text.startswith("<binary "):
            raise ValueError("Authorization, credential and binary files are not accepted")
        target_name = "source/" + clean(path.as_posix()) + ".reference.txt"
        prepared.append((path.as_posix(), target_name, raw_text, clean(raw_text)))
    skill = clean(files["SKILL.md"])
    methods = {}
    for mode, method in METHODS.items():
        original_sections = "\n\n".join(native_method(section(skill, prefix)) for prefix in method["prefixes"])
        methods[mode] = "# 音乐 MV V1.0.6 · " + method["title"] + "\n\n" + COMMON + "\n## 原生阶段规范\n\n" + method["native"] + "\n\n## 完整通用业务依据\n\n" + original_sections + "\n"
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    for source, target_name, raw_text, content in prepared:
        raw = raw_text.encode("utf-8")
        target = destination / target_name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        entries.append({"source": clean(source), "path": target_name,
                        "sourceBytes": len(raw), "sourceSha256": hashlib.sha256(raw).hexdigest(),
                        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                        "treatment": "sanitized-inert-reference"})
    method_entries = []
    for name, content in methods.items():
        target = destination / (name + ".md")
        target.write_text(content, encoding="utf-8", newline="\n")
        method_entries.append({"path": target.name, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                               "sourceSections": METHODS[name]["prefixes"]})
    manifest = {"version": VERSION, "sourceFileCount": len(entries), "runtime": "native-project-workflow",
                "sourceExecution": "disabled-inert-text-only", "files": entries, "methods": method_entries}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    files = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    manifest = import_files(files, args.destination.resolve())
    print(f"Imported {manifest['sourceFileCount']} inert references and {len(manifest['methods'])} native methods")


if __name__ == "__main__":
    main()
