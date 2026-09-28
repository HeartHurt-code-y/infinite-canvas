export type CinematicDialogueGuard = {
  readonly lockedLines: string;
  readonly targetDurationSeconds: number | null;
  readonly targetFormat: "generic" | "h3";
};

type LockedLine = {
  readonly speaker: string;
  readonly text: string;
  readonly sourceLine: number;
};

type TimedUtterance = {
  readonly speaker: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
};

const H3_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

const H3_HEADING =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)(?:\*\*)?\s*[:：](?:\*\*)?/;
const H3_FENCE = /^\s*(`{3,}|~{3,})/;
const H3_SPEAKER_ID = /\((S[1-9]\d*)\)/g;
const H3_LANGUAGE_LABEL = /^\[(?:中文|英文|Chinese|English)\]/;

function object(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location}必须是非负整数毫秒。`);
  }
  return value;
}

function parseLockedLines(raw: string): LockedLine[] {
  if (typeof raw !== "string") {
    throw new Error("锁定原台词必须是文本。");
  }
  return raw.split(/\r?\n/).flatMap((line, index): LockedLine[] => {
    if (!line.trim()) return [];
    const separator = /[：:]/.exec(line);
    if (!separator) {
      throw new Error(`锁定原台词第 ${index + 1} 行缺少“角色：台词”分隔符。`);
    }
    const speaker = line.slice(0, separator.index).trim();
    const text = line.slice(separator.index + 1);
    if (!speaker || !text.trim()) {
      throw new Error(`锁定原台词第 ${index + 1} 行必须同时填写角色和台词。`);
    }
    return [{ speaker, text, sourceLine: index + 1 }];
  });
}

function occurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function validateLockedPrompt(
  prompt: string,
  lines: readonly LockedLine[],
  label = "视频提示词",
): void {
  let position = 0;
  for (const [index, line] of lines.entries()) {
    const found = prompt.indexOf(line.text, position);
    if (found < 0) {
      throw new Error(
        `锁定台词第 ${index + 1} 句（原文第 ${line.sourceLine} 行）未按原顺序逐字出现在${label}中：${line.text}`,
      );
    }
    position = found + line.text.length;
  }

  const expectedCounts = new Map<string, number>();
  for (const line of lines) {
    expectedCounts.set(line.text, (expectedCounts.get(line.text) ?? 0) + 1);
  }
  for (const [text, expected] of expectedCounts) {
    const actual = occurrenceCount(prompt, text);
    if (actual !== expected) {
      throw new Error(
        `锁定台词“${text}”在${label}中应出现 ${expected} 次，实际出现 ${actual} 次。`,
      );
    }
  }
}

function validateTiming(
  timing: unknown,
  targetDurationMs: number,
  lockedLines: readonly LockedLine[],
): { beats: number; utterances: TimedUtterance[]; occupiedMs: number } {
  const plan = object(timing, "对白时间轴");
  if (!Array.isArray(plan["beats"]) || plan["beats"].length === 0) {
    throw new Error("对白时间轴缺少非空 beats 列表，请重新生成逐段计划。");
  }

  const utterances: TimedUtterance[] = [];
  let previousBeatEnd = 0;
  let previousUtteranceStart = -1;
  const previousEndBySpeaker = new Map<string, number>();
  for (const [beatIndex, rawBeat] of plan["beats"].entries()) {
    const location = `时间轴第 ${beatIndex + 1} 段`;
    const beat = object(rawBeat, location);
    const startMs = nonNegativeInteger(beat["startMs"], `${location}起点 startMs`);
    const endMs = nonNegativeInteger(beat["endMs"], `${location}终点 endMs`);
    if (startMs !== previousBeatEnd) {
      throw new Error(
        `${location}从 ${startMs} 毫秒开始，应与上一段终点 ${previousBeatEnd} 毫秒连续。`,
      );
    }
    if (endMs <= startMs) {
      throw new Error(`${location}终点必须晚于起点。`);
    }
    if (endMs > targetDurationMs) {
      throw new Error(`${location}终点 ${endMs} 毫秒超过目标时长 ${targetDurationMs} 毫秒。`);
    }
    if (!Array.isArray(beat["utterances"])) {
      throw new Error(`${location}缺少 utterances 列表；没有台词时请返回空列表。`);
    }
    for (const [utteranceIndex, rawUtterance] of beat["utterances"].entries()) {
      const utteranceLocation = `${location}第 ${utteranceIndex + 1} 句`;
      const utterance = object(rawUtterance, utteranceLocation);
      const speaker = utterance["speaker"];
      const text = utterance["text"];
      if (typeof speaker !== "string" || !speaker.trim()) {
        throw new Error(`${utteranceLocation}缺少说话人 speaker。`);
      }
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`${utteranceLocation}缺少原样台词 text。`);
      }
      const utteranceStart = nonNegativeInteger(
        utterance["startMs"],
        `${utteranceLocation}起点 startMs`,
      );
      const utteranceEnd = nonNegativeInteger(utterance["endMs"], `${utteranceLocation}终点 endMs`);
      if (utteranceEnd <= utteranceStart || utteranceStart < startMs || utteranceEnd > endMs) {
        throw new Error(`${utteranceLocation}发声区间必须为当前段内的正时长。`);
      }
      if (utteranceStart < previousUtteranceStart) {
        throw new Error(`${utteranceLocation}的起点早于前一句，发言顺序与时间轴不一致。`);
      }
      const speakerName = speaker.trim();
      const previousSpeakerEnd = previousEndBySpeaker.get(speakerName);
      if (previousSpeakerEnd !== undefined && utteranceStart < previousSpeakerEnd) {
        throw new Error(`${utteranceLocation}与说话人“${speakerName}”的前一句发声区间重叠。`);
      }
      previousUtteranceStart = utteranceStart;
      previousEndBySpeaker.set(speakerName, utteranceEnd);
      utterances.push({
        speaker: speakerName,
        text,
        startMs: utteranceStart,
        endMs: utteranceEnd,
      });
    }
    previousBeatEnd = endMs;
  }
  if (previousBeatEnd !== targetDurationMs) {
    throw new Error(
      `时间轴末段终点为 ${previousBeatEnd} 毫秒，必须等于目标时长 ${targetDurationMs} 毫秒。`,
    );
  }

  if (lockedLines.length > 0) {
    if (utterances.length !== lockedLines.length) {
      throw new Error(
        `时间轴共有 ${utterances.length} 句台词，锁定原台词有 ${lockedLines.length} 句；不得遗漏或增加。`,
      );
    }
    for (const [index, utterance] of utterances.entries()) {
      const locked = lockedLines[index]!;
      if (utterance.speaker !== locked.speaker || utterance.text !== locked.text) {
        throw new Error(
          `时间轴第 ${index + 1} 句与锁定原台词第 ${locked.sourceLine} 行不一致：说话人及台词必须按原顺序逐字保留。`,
        );
      }
    }
  }

  // Concurrent speakers cover the shared interval only once. This checks the
  // schedule's arithmetic, not whether a model can speak at the planned rate.
  const intervals = utterances
    .map(({ startMs, endMs }) => ({ startMs, endMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let occupiedMs = 0;
  let coveredUntil = 0;
  for (const interval of intervals) {
    occupiedMs += Math.max(0, interval.endMs - Math.max(interval.startMs, coveredUntil));
    coveredUntil = Math.max(coveredUntil, interval.endMs);
  }
  return { beats: plan["beats"].length, utterances, occupiedMs };
}

function h3SpokenText(value: string, expected: string): boolean {
  if (value === expected) return true;
  return value.replace(H3_LANGUAGE_LABEL, "") === expected;
}

function validateH3(prompt: string, utterances: readonly TimedUtterance[]): void {
  const lines = prompt.split(/\r?\n/);
  const activeLines: { line: string; number: number }[] = [];
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const marker = H3_FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) activeLines.push({ line, number: index + 1 });
  }

  const headings = activeLines.flatMap(({ line, number }, index) => {
    const match = H3_HEADING.exec(line);
    return match ? [{ name: match[1]!, number, activeIndex: index }] : [];
  });
  for (const section of H3_SECTIONS) {
    const occurrences = headings.filter((heading) => heading.name === section);
    if (occurrences.length !== 1) {
      throw new Error(`H3 正文分区 ${section} 应有且仅有一个标题，实际 ${occurrences.length} 个。`);
    }
  }
  for (const [index, expected] of H3_SECTIONS.entries()) {
    if (headings[index]?.name !== expected) {
      throw new Error(
        `H3 第 ${index + 1} 个分区应为 ${expected}，实际为 ${headings[index]?.name ?? "缺失"}。`,
      );
    }
  }

  const detailStart = headings[3]!.activeIndex;
  const detailEnd = headings[4]!.activeIndex;
  const spokenRows: { text: string; id: string; prefix: string; number: number }[] = [];
  for (const [index, { line, number }] of activeLines.entries()) {
    if (!line.includes("<d") && !line.includes("</d")) continue;
    const location = `H3 正文第 ${number} 行`;
    if (index <= detailStart || index >= detailEnd) {
      throw new Error(`${location}的台词必须位于 detailed_description 分区。`);
    }
    const start = line.indexOf("<d>");
    const end = line.indexOf("</d>");
    if (
      start < 0 ||
      end <= start ||
      line.indexOf("<d>", start + 3) >= 0 ||
      line.indexOf("</d>", end + 4) >= 0 ||
      line.slice(end + 4).trim()
    ) {
      throw new Error(`${location}必须只有一组 <d>…</d>，且 </d> 收在行尾。`);
    }
    const prefix = line.slice(0, start);
    const speakerIds = [...prefix.matchAll(H3_SPEAKER_ID)];
    if (!prefix.trimStart().startsWith("→") || speakerIds.length !== 1) {
      throw new Error(`${location}须以 → 开始，并在 <d> 外标注唯一说话人编号 (S#)。`);
    }
    spokenRows.push({
      text: line.slice(start + 3, end),
      id: speakerIds[0]![1]!,
      prefix: prefix.trimStart().slice(1).trimStart(),
      number,
    });
  }
  if (spokenRows.length !== utterances.length) {
    throw new Error(
      `H3 正文有 ${spokenRows.length} 行台词，时间轴有 ${utterances.length} 句，必须一一对应。`,
    );
  }
  const idsBySpeaker = new Map<string, string>();
  const speakersById = new Map<string, string>();
  const speakerNames = [...new Set(utterances.map((utterance) => utterance.speaker))].sort(
    (left, right) => right.length - left.length,
  );
  for (const [index, row] of spokenRows.entries()) {
    const utterance = utterances[index]!;
    if (!h3SpokenText(row.text, utterance.text)) {
      throw new Error(`H3 正文第 ${row.number} 行台词与时间轴第 ${index + 1} 句不一致。`);
    }
    const visiblePrefix = row.prefix.startsWith("【") ? row.prefix.slice(1) : row.prefix;
    const visibleSpeaker = speakerNames.find((name) => visiblePrefix.startsWith(name));
    if (visibleSpeaker !== utterance.speaker) {
      throw new Error(
        `H3 正文第 ${row.number} 行可见角色名须与时间轴第 ${index + 1} 句说话人“${utterance.speaker}”一致。`,
      );
    }
    const previousId = idsBySpeaker.get(utterance.speaker);
    const previousSpeaker = speakersById.get(row.id);
    if (
      (previousId && previousId !== row.id) ||
      (previousSpeaker && previousSpeaker !== utterance.speaker)
    ) {
      throw new Error(`H3 正文第 ${row.number} 行说话人编号 ${row.id} 与前文角色映射不一致。`);
    }
    idsBySpeaker.set(utterance.speaker, row.id);
    speakersById.set(row.id, utterance.speaker);
  }
}

/** Validate only facts independently available from locked user text and a typed schedule. */
export function validateCinematicDialogueReady(input: {
  videoPrompt: string;
  alternatePrompt?: string | null;
  guard: CinematicDialogueGuard;
  timing: unknown;
}): { readonly report: string } {
  const { videoPrompt, alternatePrompt, guard, timing } = input;
  if (typeof videoPrompt !== "string" || !videoPrompt.trim()) {
    throw new Error("视频提示词不能为空。");
  }
  if (guard.targetFormat !== "generic" && guard.targetFormat !== "h3") {
    throw new Error("对白目标格式必须是 generic 或 h3。");
  }
  const duration = guard.targetDurationSeconds;
  if (
    duration === null ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(duration * 1000)
  ) {
    throw new Error("请先在对白节点设置正整数目标时长，才能核验时间轴并下发视频提示词。");
  }
  const lockedLines = parseLockedLines(guard.lockedLines);
  const result = validateTiming(timing, duration * 1000, lockedLines);
  if (lockedLines.length > 0) {
    validateLockedPrompt(videoPrompt, lockedLines);
    if (alternatePrompt) validateLockedPrompt(alternatePrompt, lockedLines, "备选提示词");
  }
  if (guard.targetFormat === "h3") validateH3(videoPrompt, result.utterances);

  const occupancy = result.occupiedMs / (duration * 1000);
  const report = [
    `已核验 ${result.beats} 段时间轴：从 0 连续到 ${duration} 秒，${result.utterances.length} 句发言均在所属段内。`,
    lockedLines.length > 0
      ? `已核验 ${lockedLines.length} 句锁定台词：提示词字面按原顺序出现，时间轴的说话人和台词逐字一致。`
      : "原台词未锁定，逐字保留未核验。",
    alternatePrompt && lockedLines.length > 0 ? "备选提示词也已核验锁定台词。" : null,
    guard.targetFormat === "h3"
      ? "已核验 H3 六段标题、台词行格式及说话人编号一致性。"
      : "目标为通用视频提示词；未标记的额外发言和正文说话人归属无法结构化核验。",
    `规划发声区间覆盖目标时长的 ${(occupancy * 100).toFixed(1)}%；仅核对区间算术，不代表语速或成片已验收。${occupancy > 0.85 ? " 台词占用超过 85%，请检查停顿与反应余量。" : ""}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return { report };
}
