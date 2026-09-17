import { describe, expect, it } from "vitest";
import {
  BAILIAN_ADAPTER_ID,
  MOYU_ADAPTER_ID,
  assembleBailianBaseUrl,
  isBailianAdapter,
  isValidBailianWorkspaceId,
  parseBailianWorkspaceId,
} from "./providerAdapters";

describe("providerAdapters", () => {
  it("only treats aliyun_bailian_v1 as the Bailian adapter", () => {
    expect(isBailianAdapter(BAILIAN_ADAPTER_ID)).toBe(true);
    expect(isBailianAdapter(MOYU_ADAPTER_ID)).toBe(false);
  });

  it("assembles and parses the North China 2 Beijing MaaS URL", () => {
    expect(assembleBailianBaseUrl("llm-workspace-1")).toBe(
      "https://llm-workspace-1.cn-beijing.maas.aliyuncs.com",
    );
    expect(
      parseBailianWorkspaceId("https://llm-workspace-1.cn-beijing.maas.aliyuncs.com/"),
    ).toBe("llm-workspace-1");
    expect(parseBailianWorkspaceId("https://dashscope.aliyuncs.com/api/v1")).toBe("");
    expect(assembleBailianBaseUrl("  ")).toBe("");
  });

  it("rejects empty or dotted workspace ids", () => {
    expect(isValidBailianWorkspaceId("")).toBe(false);
    expect(isValidBailianWorkspaceId("bad.id")).toBe(false);
    expect(isValidBailianWorkspaceId("llm-ok_1")).toBe(true);
  });
});
