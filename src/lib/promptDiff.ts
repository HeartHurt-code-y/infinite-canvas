import { diffArrays } from "diff";

/**
 * 提示词对比 diff：原提示词与优化后提示词的差异高亮。
 *
 * 中文提示词以单字为 token，连续的 ASCII 字母/数字合并为一个 token，
 * 由 diff 包计算 token 级变更，再投影为原文与优化文两侧的高亮段。
 * 原提示词侧高亮 removed（被改掉的部分），优化侧高亮 added（新写入的部分）。
 */

export type DiffRunType = "same" | "added" | "removed";

export interface DiffRun {
  readonly type: DiffRunType;
  readonly text: string;
}

export interface PromptDiffResult {
  /** 原提示词的渲染段：same + removed。 */
  readonly originalRuns: readonly DiffRun[];
  /** 优化后提示词的渲染段：same + added。 */
  readonly optimizedRuns: readonly DiffRun[];
}

const CJK_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/;
const DIFF_TIMEOUT_MS = 250;

/** 分词：CJK 单字成词；连续 ASCII 字母数字合一词；其余字符（标点/空白）单独成词。 */
export function tokenizePrompt(text: string): string[] {
  const tokens: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      tokens.push(buffer);
      buffer = "";
    }
  };
  for (const char of text) {
    if (CJK_PATTERN.test(char)) {
      flush();
      tokens.push(char);
    } else if (/[A-Za-z0-9]/.test(char)) {
      buffer += char;
    } else {
      flush();
      tokens.push(char);
    }
  }
  flush();
  return tokens;
}

/**
 * token 级 diff。计算超时时退化为整段删除/新增，保证极端长文本不会持续阻塞画布渲染。
 */
export function diffPromptRuns(original: string, optimized: string): PromptDiffResult {
  const originalTokens = tokenizePrompt(original);
  const optimizedTokens = tokenizePrompt(optimized);
  const changes = diffArrays(originalTokens, optimizedTokens, { timeout: DIFF_TIMEOUT_MS });
  if (changes == null) {
    return {
      originalRuns: original ? [{ type: "removed", text: original }] : [],
      optimizedRuns: optimized ? [{ type: "added", text: optimized }] : [],
    };
  }

  const originalRuns: DiffRun[] = changes.flatMap((change) =>
    change.added
      ? []
      : [
          {
            type: change.removed ? "removed" : "same",
            text: change.value.join(""),
          },
        ],
  );
  const optimizedRuns: DiffRun[] = changes.flatMap((change) =>
    change.removed
      ? []
      : [
          {
            type: change.added ? "added" : "same",
            text: change.value.join(""),
          },
        ],
  );

  return {
    originalRuns,
    optimizedRuns,
  };
}
