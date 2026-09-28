import { describe, expect, it } from "vitest";
import {
  type CinematicDialogueGuard,
  validateCinematicDialogueReady,
} from "./cinematicDialogueValidator";

const genericGuard: CinematicDialogueGuard = {
  lockedLines: "甲：别走。\n乙:我会回来。",
  targetDurationSeconds: 10,
  targetFormat: "generic",
};

const genericPrompt = "甲在站台说：别走。乙听完，回答：我会回来。";

function genericTiming() {
  return {
    beats: [
      {
        startMs: 0,
        endMs: 4_000,
        utterances: [{ speaker: "甲", text: "别走。", startMs: 500, endMs: 2_000 }],
      },
      {
        startMs: 4_000,
        endMs: 10_000,
        utterances: [{ speaker: "乙", text: "我会回来。", startMs: 5_000, endMs: 7_500 }],
      },
    ],
  };
}

const h3Prompt = [
  "subject_definitions: 甲和乙站在同一侧月台。",
  "summary: 十秒站台告别。",
  "retention_analysis: 甲与乙衣着连续。",
  "detailed_description: 稳定机位，听到一句后再反应。",
  "→甲用 <Audio 1> 的音色 (S1) says: <d>[中文]别走。</d>",
  "→乙 (S2) says: <d>[中文]我会回来。</d>",
  "overall_soundscape: 风声与远处列车声。",
  "non_diegetic_music: N/A",
].join("\n");

describe("validateCinematicDialogueReady", () => {
  it("checks locked dialogue, exact order, and continuous timing before reporting success", () => {
    const result = validateCinematicDialogueReady({
      videoPrompt: genericPrompt,
      guard: genericGuard,
      timing: genericTiming(),
    });

    expect(result.report).toContain("从 0 连续到 10 秒");
    expect(result.report).toContain("2 句锁定台词");
    expect(result.report).toContain("40.0%");
    expect(result.report).toContain("不代表语速或成片已验收");
  });

  it("requires a configured integer target duration and a complete timing plan", () => {
    for (const targetDurationSeconds of [null, 0, -1, 10.5, Number.NaN]) {
      expect(() =>
        validateCinematicDialogueReady({
          videoPrompt: genericPrompt,
          guard: { ...genericGuard, targetDurationSeconds },
          timing: genericTiming(),
        }),
      ).toThrow("设置正整数目标时长");
    }
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: null,
      }),
    ).toThrow("对白时间轴必须是对象");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: { beats: [] },
      }),
    ).toThrow("非空 beats 列表");
  });

  it("reports when the user has not locked original dialogue", () => {
    const result = validateCinematicDialogueReady({
      videoPrompt: "站台上的两人沉默地告别。",
      guard: { ...genericGuard, lockedLines: " \n" },
      timing: { beats: [{ startMs: 0, endMs: 10_000, utterances: [] }] },
    });
    expect(result.report).toContain("原台词未锁定，逐字保留未核验");
    expect(result.report).toContain("0.0%");
  });

  it("rejects malformed locked lines and preserves punctuation and spaces inside dialogue", () => {
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: { ...genericGuard, lockedLines: "甲 别走。" },
        timing: genericTiming(),
      }),
    ).toThrow("第 1 行缺少");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: { ...genericGuard, lockedLines: "甲：别走！\n乙：我会回来。" },
        timing: genericTiming(),
      }),
    ).toThrow("时间轴第 1 句与锁定原台词");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: "甲说：别走。",
        guard: { ...genericGuard, lockedLines: "甲： 别走。" },
        timing: {
          beats: [
            {
              startMs: 0,
              endMs: 10_000,
              utterances: [{ speaker: "甲", text: " 别走。", startMs: 0, endMs: 2_000 }],
            },
          ],
        },
      }),
    ).toThrow("未按原顺序逐字出现");
  });

  it("rejects omitted, reordered, or duplicated locked dialogue in the video prompt", () => {
    const reordered = "乙说：我会回来。甲说：别走。";
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: reordered,
        guard: genericGuard,
        timing: genericTiming(),
      }),
    ).toThrow("未按原顺序");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: `${genericPrompt}甲又说了一次：别走。`,
        guard: genericGuard,
        timing: genericTiming(),
      }),
    ).toThrow("应出现 1 次，实际出现 2 次");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: "甲说：别走。乙没有回答。",
        guard: genericGuard,
        timing: genericTiming(),
      }),
    ).toThrow("第 2 句");
  });

  it("also checks locked dialogue in an optional alternate prompt", () => {
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        alternatePrompt: "乙说：我会回来。甲说：别走。",
        guard: genericGuard,
        timing: genericTiming(),
      }),
    ).toThrow("未按原顺序逐字出现在备选提示词中");
  });

  it("rejects timing gaps, overlap between beats, excess duration, and invalid numbers", () => {
    const changed = genericTiming();
    changed.beats[1]!.startMs = 4_001;
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: changed,
      }),
    ).toThrow("第 2 段从 4001 毫秒开始");

    const overlong = genericTiming();
    overlong.beats[1]!.endMs = 10_001;
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: overlong,
      }),
    ).toThrow("超过目标时长");

    const short = genericTiming();
    short.beats[1]!.endMs = 9_999;
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: short,
      }),
    ).toThrow("必须等于目标时长");

    const fractional = genericTiming();
    fractional.beats[0]!.utterances[0]!.startMs = 500.5;
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: fractional,
      }),
    ).toThrow("非负整数毫秒");
  });

  it("rejects speech outside a beat, missing lines, and speaker changes", () => {
    const outside = genericTiming();
    outside.beats[0]!.utterances[0]!.endMs = 4_001;
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: outside,
      }),
    ).toThrow("当前段内的正时长");

    const missing = genericTiming();
    missing.beats[1]!.utterances = [];
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: missing,
      }),
    ).toThrow("不得遗漏或增加");

    const changedSpeaker = genericTiming();
    changedSpeaker.beats[1]!.utterances[0]!.speaker = "甲";
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: changedSpeaker,
      }),
    ).toThrow("说话人及台词必须按原顺序逐字保留");
  });

  it("rejects overlapping speech by one speaker but allows another speaker to interrupt", () => {
    const overlapping = {
      beats: [
        {
          startMs: 0,
          endMs: 10_000,
          utterances: [
            { speaker: "甲", text: "别走。", startMs: 0, endMs: 6_000 },
            { speaker: "甲", text: "我会回来。", startMs: 5_000, endMs: 9_000 },
          ],
        },
      ],
    };
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: overlapping,
      }),
    ).toThrow("前一句发声区间重叠");

    overlapping.beats[0]!.utterances[1]!.speaker = "乙";
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: genericPrompt,
        guard: genericGuard,
        timing: overlapping,
      }),
    ).not.toThrow();
  });

  it("accepts H3 sections and dialogue rows with stable IDs and optional language labels", () => {
    const result = validateCinematicDialogueReady({
      videoPrompt: h3Prompt,
      guard: { ...genericGuard, targetFormat: "h3" },
      timing: genericTiming(),
    });
    expect(result.report).toContain("H3 六段标题");
  });

  it("does not count H3 headings found only inside a fenced example", () => {
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: `\`\`\`text\n${h3Prompt}\n\`\`\``,
        guard: { ...genericGuard, targetFormat: "h3" },
        timing: genericTiming(),
      }),
    ).toThrow("subject_definitions 应有且仅有一个标题");
  });

  it("rejects missing, duplicate, or reordered H3 sections", () => {
    const h3Guard = { ...genericGuard, targetFormat: "h3" as const };
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace("summary: 十秒站台告别。\n", ""),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("summary 应有且仅有一个标题");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: `${h3Prompt}\nsummary: 重复标题`,
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("summary 应有且仅有一个标题");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace(
          "summary: 十秒站台告别。\nretention_analysis: 甲与乙衣着连续。",
          "retention_analysis: 甲与乙衣着连续。\nsummary: 十秒站台告别。",
        ),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("第 2 个分区应为 summary");
  });

  it("rejects malformed H3 dialogue rows and speech outside detailed_description", () => {
    const h3Guard = { ...genericGuard, targetFormat: "h3" as const };
    for (const malformed of [
      h3Prompt.replace("→甲用 <Audio 1> 的音色 (S1)", "甲用 <Audio 1> 的音色 (S1)"),
      h3Prompt.replace("→甲用 <Audio 1> 的音色 (S1)", "→甲用 <Audio 1> 的音色"),
      h3Prompt.replace("<d>[中文]别走。</d>", "<d>[中文]别走。</d> 甲收手"),
    ]) {
      expect(() =>
        validateCinematicDialogueReady({
          videoPrompt: malformed,
          guard: h3Guard,
          timing: genericTiming(),
        }),
      ).toThrow(/H3 正文第 \d+ 行/);
    }
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace(
          "summary: 十秒站台告别。",
          "summary: →甲 (S1) says: <d>额外台词。</d>",
        ),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("台词必须位于 detailed_description");
  });

  it("rejects H3 speaker-ID drift and H3 lines absent from the timing plan", () => {
    const h3Guard = { ...genericGuard, targetFormat: "h3" as const };
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace("乙 (S2)", "乙 (S1)"),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("角色映射不一致");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace("→甲用 <Audio 1> 的音色 (S1)", "→乙用 <Audio 1> 的音色 (S1)"),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("可见角色名须与时间轴");
    expect(() =>
      validateCinematicDialogueReady({
        videoPrompt: h3Prompt.replace(
          "→乙 (S2) says: <d>[中文]我会回来。</d>",
          "→乙 (S2) says: <d>[中文]我会回来。</d>\n→甲 (S1) says: <d>再见。</d>",
        ),
        guard: h3Guard,
        timing: genericTiming(),
      }),
    ).toThrow("H3 正文有 3 行台词，时间轴有 2 句");
  });

  it("warns about dense scheduled speech instead of rejecting it", () => {
    const result = validateCinematicDialogueReady({
      videoPrompt: "甲说：别走。乙说：我会回来。",
      guard: genericGuard,
      timing: {
        beats: [
          {
            startMs: 0,
            endMs: 10_000,
            utterances: [
              { speaker: "甲", text: "别走。", startMs: 0, endMs: 4_500 },
              { speaker: "乙", text: "我会回来。", startMs: 4_500, endMs: 9_000 },
            ],
          },
        ],
      },
    });
    expect(result.report).toContain("90.0%");
    expect(result.report).toContain("超过 85%");
  });
});
