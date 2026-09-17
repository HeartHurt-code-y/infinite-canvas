import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "./backend";
import { assetLibraryProviders, providerSupportsAssetLibrary } from "./assetLibrarySupport";

function provider(
  baseUrl: string,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "provider-under-test",
    displayName: "待判定连接",
    adapterId: "moyu_v1",
    baseUrl,
    apiKeyRef: "provider:provider-under-test:api-key",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("素材库供应商支持判定", () => {
  it("盘趣网关的直连 IP 与域名都不参与素材库", () => {
    // 该网关没有 /v1/assets/*，无论用户填 IP 还是文档里的域名都同样排除。
    expect(providerSupportsAssetLibrary(provider("https://115.191.2.88/"))).toBe(false);
    expect(providerSupportsAssetLibrary(provider("https://115.191.2.88:3000/"))).toBe(false);
    expect(providerSupportsAssetLibrary(provider("https://aiapis.panqu.com/"))).toBe(false);
    expect(providerSupportsAssetLibrary(provider("https://panqu.com/v1"))).toBe(false);
  });

  it("判定按上游主机而不是连接身份，命名与地址写法都不影响结论", () => {
    expect(
      providerSupportsAssetLibrary(
        provider("HTTP://115.191.2.88/", { displayName: "随便改的名字" }),
      ),
    ).toBe(false);
    // 只是名字里带 panqu 的连接仍有素材库：素材库能力属于上游地址。
    expect(providerSupportsAssetLibrary(provider("https://api.example.com/v1"))).toBe(true);
    expect(
      providerSupportsAssetLibrary(provider("https://api.example.com/v1", { id: "panqu-like" })),
    ).toBe(true);
  });

  it("其他网关与火山引擎方舟继续作为素材库来源", () => {
    expect(providerSupportsAssetLibrary(provider("https://www.moyu.info/"))).toBe(true);
    expect(providerSupportsAssetLibrary(provider("https://www.konjac.ai/v1"))).toBe(true);
    expect(
      providerSupportsAssetLibrary(
        provider("https://ark.cn-beijing.volces.com/api/v3", { adapterId: "volcengine_ark_v1" }),
      ),
    ).toBe(true);
  });

  it("阿里云百炼没有云端素材库", () => {
    expect(
      providerSupportsAssetLibrary(
        provider("https://llm-ws.cn-beijing.maas.aliyuncs.com", {
          adapterId: "aliyun_bailian_v1",
        }),
      ),
    ).toBe(false);
  });

  it("地址缺失或写法不规范时保持原有行为，不误排除连接", () => {
    expect(providerSupportsAssetLibrary(provider(""))).toBe(true);
    expect(providerSupportsAssetLibrary(provider("   "))).toBe(true);
    expect(providerSupportsAssetLibrary(provider("https://api.company.com/v1"))).toBe(true);
  });

  it("过滤保持传入顺序，只去掉没有素材库的连接", () => {
    const moyu = provider("https://www.moyu.info/", { id: "provider-moyu" });
    const panqu = provider("https://115.191.2.88/", { id: "provider-panqu-api" });
    const ark = provider("https://ark.cn-beijing.volces.com/api/v3", {
      id: "provider-ark",
      adapterId: "volcengine_ark_v1",
    });

    expect(assetLibraryProviders([moyu, panqu, ark]).map((entry) => entry.id)).toEqual([
      "provider-moyu",
      "provider-ark",
    ]);
    expect(assetLibraryProviders([panqu])).toEqual([]);
  });
});
