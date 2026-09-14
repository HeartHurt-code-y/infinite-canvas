/** Only the style-library mode uses this cleaner. Never erase arbitrary notes, URLs or code. */
const metadataLabel =
  /^(?:所选模板方向|所选模板|模板选择|模板信息|模板名称|适用理由|选择理由|匹配理由|案例索引|案例编号|案例\s*ID|参考案例|案例来源|template name|selected template|selection rationale|case index|case id)(?:\s*[：:]|$)/i;
const templateNote =
  /^(?:说明|模板)[：:]\s*(?:所选模板|选择了|选用|采用的模板|.*模板[。；;]|.*案例\s*ID)/i;
const visualLabel =
  /^(?:主体与任务|主体|构图与布局|构图|视觉风格与材质|风格与材质|视觉风格|文字与标签要求|文字与标签|画面文字与标签|画面文字|文字|画幅与输出格式|画幅与输出形式|画幅与格式|画幅|约束与负面细节|约束与排除细节|约束|负面提示词|负面提示)(?:\s*[：:]|$)/;
const promptHeading =
  /^(?:最终提示词|图片提示词|生成提示词|完整提示词|final prompt|image prompt)[：:]?$/i;

function plainLabel(line: string): string {
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+)/, "")
    .replace(/^\*\*([^*]+)\*\*/, "$1");
}

function fenceAt(line: string): { marker: string; info: string } | null {
  const match = /^\s*(`{3,}|~{3,})([^`~]*)$/.exec(line);
  return match ? { marker: match[1]!, info: match[2]!.trim().toLowerCase() } : null;
}

/** A complete outer text envelope is safe to unwrap; inner and multiple code blocks stay intact. */
function unwrapEnvelope(text: string): string {
  let current = text.trim();
  for (;;) {
    const lines = current.split("\n");
    const opening = fenceAt(lines[0] ?? "");
    if (
      !opening ||
      !["", "text", "plaintext", "markdown", "md", "prompt"].includes(opening.info) ||
      lines.length < 3 ||
      lines.at(-1)?.trim() !== opening.marker ||
      lines.slice(1, -1).some((line) => line.trim() === opening.marker)
    )
      return current;
    current = lines.slice(1, -1).join("\n").trim();
  }
}

export function cleanGptImage2Prompt(text: string): string {
  const lines = unwrapEnvelope(text.replace(/\r\n/g, "\n")).split("\n");
  const result: string[] = [];
  let fence: string | null = null;
  let metadataContinuation = false;
  let removedMetadata = false;
  for (const line of lines) {
    const marker = fenceAt(line);
    if (fence) {
      result.push(line);
      if (line.trim() === fence) fence = null;
      continue;
    }
    if (marker) {
      fence = marker.marker;
      metadataContinuation = false;
      result.push(line);
      continue;
    }
    const label = plainLabel(line);
    if (metadataLabel.test(label) || templateNote.test(label)) {
      metadataContinuation = true;
      removedMetadata = true;
      continue;
    }
    // Only an indented continuation belongs to the previous metadata field. A normal
    // paragraph may be a new prompt, a user constraint or a necessary clarification.
    if (metadataContinuation && /^\s{2,}\S/.test(line) && !visualLabel.test(label)) continue;
    metadataContinuation = false;
    if (!promptHeading.test(label)) result.push(line);
  }
  if (removedMetadata && !fence) {
    while (result.length && /^(?:\s*|\s*(?:-{3,}|\*{3,}|_{3,})\s*)$/.test(result.at(-1)!)) {
      result.pop();
    }
  }
  const unwrapped = unwrapEnvelope(result.join("\n"));
  fence = null;
  return unwrapped
    .split("\n")
    .map((line) => {
      if (fence) {
        if (line.trim() === fence) fence = null;
        return line;
      }
      const marker = fenceAt(line);
      if (marker) {
        fence = marker.marker;
        return line;
      }
      const label = plainLabel(line);
      // Flatten known delivery labels, without changing literal title typography,
      // Markdown code samples, @ references, negative instructions or image URLs.
      return visualLabel.test(label) ? label : line;
    })
    .join("\n")
    .trim();
}
