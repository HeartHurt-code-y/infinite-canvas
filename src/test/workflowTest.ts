import { test as baseTest, describe, expect, vi } from "vitest";

import { fakeDependencies, planJson } from "./videoWorkflowFixtures";

/**
 * 工作流 runner 共用 fixture：每个用例拿到一份干净的 prompt / generation / frames / composer mock。
 * 只在测试显式解构 `workflowFakes` 时才创建。
 */
export const test = baseTest.extend("workflowFakes", () => fakeDependencies(planJson()));
export const it = test;
export { describe, expect, vi };
