import { describe, expect, it } from "vitest";
import { parseCinematicDialogueResponse as parseWithGuardImpl } from "./cinematicDialogueResponse";

const ready = {
  status: "ready",
  videoPrompt: "两人在站台对话，镜头保持稳定。",
  target: "15 秒 · 16:9 · 当前视频模型",
  turnPlan: "起手：甲；接话：乙；抢话：乙在‘离开’时进入；退让：甲收手。",
  budget: "15 秒，台词 45 字，占用率约 67%。",
  timing: { beats: [{ startMs: 0, endMs: 15000, utterances: [] }] },
  reviewChecklist: "- [ ] 声音确实重叠\n- [ ] 口型与台词一致",
};
const guard = { lockedLines: "", targetDurationSeconds: 15, targetFormat: "generic" } as const;
const parseCinematicDialogueResponse = (raw: string) => parseWithGuardImpl(raw, guard);

describe("parseCinematicDialogueResponse", () => {
  it("returns a clarification as conversation text without a downstream prompt", () => {
    expect(
      parseCinematicDialogueResponse(
        JSON.stringify({
          status: "needs_input",
          message: "  台词可以改编吗？  ",
          videoPrompt: "误传",
        }),
      ),
    ).toEqual({
      status: "needs_input",
      displayText: "台词可以改编吗？",
      downstreamPrompt: null,
    });
  });

  it("renders the required deliverables and sends only videoPrompt downstream", () => {
    const result = parseCinematicDialogueResponse(
      `\`\`\`json\n${JSON.stringify({
        ...ready,
        adaptationNotes: "原句‘我会走’调整为‘我……会走’，保留事实。",
        alternatePrompt: "备选模型的对白格式。",
      })}\n\`\`\``,
    );

    expect(result.status).toBe("ready");
    expect(result.downstreamPrompt).toBe(ready.videoPrompt);
    expect(result.displayText).toContain("## 视频提示词");
    expect(result.displayText).toContain(ready.videoPrompt);
    expect(result.displayText).toContain("## 视频目标\n\n" + ready.target);
    expect(result.displayText).toContain(ready.turnPlan);
    expect(result.displayText).toContain(ready.budget);
    expect(result.displayText).toContain("## 项目校验");
    expect(result.displayText).toContain(ready.reviewChecklist);
    expect(result.displayText).toContain("## 台词改编");
    expect(result.displayText).toContain("## 备选提示词");
    expect(result.downstreamPrompt).not.toContain("备选模型");
  });

  it("uses a fence longer than any backtick run inside prompts", () => {
    const videoPrompt = '镜头 A\n```json\n{"shot":1}\n```\n镜头 B';
    const alternatePrompt = "备用\n````\n结束";
    const result = parseCinematicDialogueResponse(
      JSON.stringify({ ...ready, videoPrompt, alternatePrompt }),
    );

    expect(result.displayText).toContain(`\`\`\`\`text\n${videoPrompt}\n\`\`\`\``);
    expect(result.displayText).toContain(`\`\`\`\`\`text\n${alternatePrompt}\n\`\`\`\`\``);
    expect(result.downstreamPrompt).toBe(videoPrompt);
  });

  it("rejects empty or malformed responses instead of accepting partial output", () => {
    expect(() => parseCinematicDialogueResponse(" ")).toThrow("没有返回内容");
    expect(() => parseCinematicDialogueResponse('{"status":"ready","videoPrompt":')).toThrow(
      "JSON 无效或不完整",
    );
    expect(() =>
      parseCinematicDialogueResponse(`这里是结果：\n\`\`\`json\n${JSON.stringify(ready)}\n\`\`\``),
    ).toThrow("JSON 无效或不完整");
    expect(() => parseCinematicDialogueResponse(`\`\`\`json\n${JSON.stringify(ready)}`)).toThrow(
      "JSON 无效或不完整",
    );
    expect(() => parseCinematicDialogueResponse("[]")).toThrow("顶层必须是 JSON 对象");
  });

  it("requires nonempty fields for each status", () => {
    expect(() =>
      parseCinematicDialogueResponse(JSON.stringify({ status: "needs_input", message: "  " })),
    ).toThrow("message 必须是非空文本");
    for (const key of ["videoPrompt", "target", "turnPlan", "budget", "reviewChecklist"]) {
      expect(() =>
        parseCinematicDialogueResponse(JSON.stringify({ ...ready, [key]: "  " })),
      ).toThrow(`${key} 必须是非空文本`);
    }
    expect(() => parseCinematicDialogueResponse('{"status":"other"}')).toThrow(
      "status 必须是 needs_input 或 ready",
    );
  });

  it("omits empty optional sections and rejects optional values with the wrong type", () => {
    const result = parseCinematicDialogueResponse(
      JSON.stringify({ ...ready, adaptationNotes: " ", alternatePrompt: null }),
    );
    expect(result.displayText).not.toContain("## 台词改编");
    expect(result.displayText).not.toContain("## 备选提示词");
    expect(() =>
      parseCinematicDialogueResponse(JSON.stringify({ ...ready, alternatePrompt: ["错误类型"] })),
    ).toThrow("alternatePrompt 必须是文本");
  });
});
