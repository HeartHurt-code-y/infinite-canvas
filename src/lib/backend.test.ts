import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assetLibraryClient,
  BackendContractError,
  providerSettingsClient,
  refreshMediaUrlWithStagingFallback,
  tosStagingClient,
  type CloudAsset,
} from "./backend";

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function mockDesktopInvoke(invoke: InvokeFn): void {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = { invoke };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("assetLibraryClient.list", () => {
  it("forwards the typed browse query and consumes canonical asset records", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    const assets: CloudAsset[] = [
      {
        providerConnectionId: "provider-1",
        id: "asset-1",
        name: "封面图",
        kind: "image",
        status: "ready",
        rawStatus: "Active",
        previewUrl: "https://cdn.example.com/asset-1.png",
        assetUrl: "asset://asset-1",
        coverUrl: null,
        groupId: "7",
      },
    ];
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve(assets);
    });

    await expect(assetLibraryClient.list({ providerConnectionId: "provider-1" })).resolves.toEqual(
      assets,
    );
    expect(capturedCommand).toBe("list_assets");
    expect(capturedArgs).toEqual({
      command: {
        providerConnectionId: "provider-1",
        pageNumber: 1,
        pageSize: 100,
        name: null,
        groupId: null,
        kind: null,
      },
    });
  });

  it("leaves domain errors from the desktop interface intact", async () => {
    const error = new Error("browse assets returned HTTP 401");
    mockDesktopInvoke(() => Promise.reject(error));

    await expect(assetLibraryClient.list({ providerConnectionId: "provider-1" })).rejects.toBe(
      error,
    );
  });
});

describe("assetLibraryClient.countAssetsByKind", () => {
  it("请求后端按类型统计并解析三个计数", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve({ image: 12, video: 3, audio: 1 });
    });

    await expect(
      assetLibraryClient.countAssetsByKind?.({
        providerConnectionId: "provider-1",
        groupId: "21",
      }),
    ).resolves.toEqual({ image: 12, video: 3, audio: 1 });
    expect(capturedCommand).toBe("count_assets_by_kind");
    expect(capturedArgs).toEqual({
      command: { providerConnectionId: "provider-1", groupId: "21" },
    });
  });

  it("整库口径把分组归一为 null 而不是省略字段", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((_command, args) => {
      capturedArgs = args;
      return Promise.resolve({ image: 0, video: 0, audio: 0 });
    });

    await assetLibraryClient.countAssetsByKind?.({ providerConnectionId: "provider-1" });
    expect(capturedArgs).toEqual({
      command: { providerConnectionId: "provider-1", groupId: null },
    });
  });
});

describe("assetLibraryClient group management", () => {
  it("forwards an asset group update with name and description", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve("asset-group-1");
    });

    await expect(
      assetLibraryClient.updateAssetGroup({
        providerConnectionId: "provider-1",
        id: "asset-group-1",
        name: "客户 A 品牌物料",
        description: "2026 夏季主视觉",
      }),
    ).resolves.toBe("asset-group-1");
    expect(capturedCommand).toBe("update_asset_group");
    expect(capturedArgs).toEqual({
      command: {
        providerConnectionId: "provider-1",
        id: "asset-group-1",
        name: "客户 A 品牌物料",
        description: "2026 夏季主视觉",
      },
    });
  });

  it("forwards a permanent asset group deletion", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve("asset-group-9");
    });

    await expect(
      assetLibraryClient.deleteAssetGroup({
        providerConnectionId: "provider-1",
        id: "asset-group-9",
      }),
    ).resolves.toBe("asset-group-9");
    expect(capturedCommand).toBe("delete_asset_group");
    expect(capturedArgs).toEqual({
      command: { providerConnectionId: "provider-1", id: "asset-group-9" },
    });
  });
});

describe("assetLibraryClient real-person H5 operations", () => {
  it("creates an H5 authorization link with the provider-scoped artist payload", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve({
        h5Url: "https://h5.example.com/auth?ticket=once",
        tip: "请在 120 秒内完成认证",
      });
    });

    await expect(
      assetLibraryClient.createRealPersonAuthLink({
        providerConnectionId: "provider-1",
        artistName: "张三",
        artistDesc: "品牌代言人真人素材组",
      }),
    ).resolves.toEqual({
      h5Url: "https://h5.example.com/auth?ticket=once",
      tip: "请在 120 秒内完成认证",
    });
    expect(capturedCommand).toBe("create_real_person_auth_link");
    expect(capturedArgs).toEqual({
      command: {
        providerConnectionId: "provider-1",
        artistName: "张三",
        artistDesc: "品牌代言人真人素材组",
      },
    });
  });

  it("lists groups and preserves the platform ID separately from the upstream group ID", async () => {
    const groups = [
      {
        id: 128,
        remoteGroupId: "group-remote-1",
        artistName: "张三",
        artistDesc: null,
        authorizedAt: "2026-04-27T12:00:29+08:00",
        assetCount: 3,
      },
    ];
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      expect(command).toBe("list_real_person_groups");
      capturedArgs = args;
      return Promise.resolve(groups);
    });

    await expect(assetLibraryClient.listRealPersonGroups("provider-1")).resolves.toEqual(groups);
    expect(capturedArgs).toEqual({ command: { providerConnectionId: "provider-1" } });
  });

  it("forwards permanent asset and group deletion to their dedicated commands", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    mockDesktopInvoke((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(command === "delete_real_person_asset" ? "asset-1" : null);
    });

    await expect(
      assetLibraryClient.deleteRealPersonAsset({
        providerConnectionId: "provider-1",
        id: "asset-1",
      }),
    ).resolves.toBe("asset-1");
    await expect(
      assetLibraryClient.deleteRealPersonGroup({ providerConnectionId: "provider-1", id: 128 }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      [
        "delete_real_person_asset",
        { command: { providerConnectionId: "provider-1", id: "asset-1" } },
      ],
      ["delete_real_person_group", { command: { providerConnectionId: "provider-1", id: 128 } }],
    ]);
  });
});

describe("tosStagingClient.listLocalAssets", () => {
  it("forwards a selected library group ID through the existing staging upload", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve("job-real-1");
    });

    await expect(
      tosStagingClient.startUpload({
        localPath: "C:\\素材\\张三.png",
        purpose: "asset_import",
        mediaType: "image",
        import: {
          providerConnectionId: "provider-1",
          name: "张三-正脸",
          groupId: "128",
        },
      }),
    ).resolves.toBe("job-real-1");
    expect(capturedCommand).toBe("start_staging_upload");
    expect(capturedArgs).toEqual({
      command: {
        localPath: "C:\\素材\\张三.png",
        purpose: "asset_import",
        mediaType: "image",
        import: {
          providerConnectionId: "provider-1",
          name: "张三-正脸",
          groupId: "128",
        },
      },
    });
  });

  it("reads the independent local index without a remote provider query", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve({
        items: [
          {
            id: "upload-1",
            name: "reference.png",
            mediaType: "image",
            objectKey: "assets/reference.png",
            previewUrl: "https://tos.example.com/reference.png?sign=fresh",
            byteSize: 128,
            createdAt: 1,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 40,
        kindTotals: { image: 1, video: 0, audio: 0 },
      });
    });

    const page = await tosStagingClient.listLocalAssets({
      mediaType: "image",
      name: null,
      page: 1,
      pageSize: 40,
    });
    expect(capturedCommand).toBe("list_local_assets");
    expect(capturedArgs).toEqual({
      query: { mediaType: "image", name: null, page: 1, pageSize: 40 },
    });
    expect(page.items[0]?.id).toBe("upload-1");
    expect(page.total).toBe(1);
  });

  it("rejects malformed desktop payloads at the IPC boundary", async () => {
    mockDesktopInvoke(() =>
      Promise.resolve({
        items: [
          {
            id: "upload-1",
            name: "reference.png",
            mediaType: "document",
            objectKey: "assets/reference.png",
            previewUrl: "https://tos.example.com/reference.png?secret=must-not-leak",
            byteSize: 128,
            createdAt: 1,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 40,
        kindTotals: { image: 0, video: 0, audio: 0 },
      }),
    );

    const request = tosStagingClient.listLocalAssets();
    await expect(request).rejects.toBeInstanceOf(BackendContractError);
    await expect(request).rejects.toMatchObject({
      details: {
        command: "list_local_assets",
        issues: [expect.objectContaining({ path: "items.0.mediaType" })],
      },
    });
    await expect(request).rejects.not.toThrow(/must-not-leak/);
  });
});

describe("providerSettingsClient token groups", () => {
  it("lists token groups for a provider connection", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    const groups = [
      {
        id: "token-group-1",
        providerConnectionId: "provider-1",
        groupName: "as分组",
        credentialRef: "provider:provider-1:token:token-group-1",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve(groups);
    });

    await expect(providerSettingsClient.listProviderTokenGroups("provider-1")).resolves.toEqual(
      groups,
    );
    expect(capturedCommand).toBe("list_provider_token_groups");
    expect(capturedArgs).toEqual({ providerConnectionId: "provider-1" });
  });

  it("upserts a token group and forwards its secret to the command", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    const group = {
      id: "token-group-2",
      providerConnectionId: "provider-1",
      groupName: "as分组",
      credentialRef: "provider:provider-1:token:token-group-2",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve(group);
    });

    await expect(
      providerSettingsClient.upsertProviderTokenGroup({
        providerConnectionId: "provider-1",
        groupName: "as分组",
        enabled: true,
        secret: "as-token-secret",
      }),
    ).resolves.toEqual(group);
    expect(capturedCommand).toBe("upsert_provider_token_group");
    expect(capturedArgs).toEqual({
      command: {
        providerConnectionId: "provider-1",
        groupName: "as分组",
        enabled: true,
        secret: "as-token-secret",
      },
    });
  });

  it("deletes a token group by name", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve(null);
    });

    await expect(
      providerSettingsClient.deleteProviderTokenGroup("provider-1", "as分组"),
    ).resolves.toBeUndefined();
    expect(capturedCommand).toBe("delete_provider_token_group");
    expect(capturedArgs).toEqual({
      command: { providerConnectionId: "provider-1", groupName: "as分组" },
    });
  });

  it("forwards the pull token group when fetching provider models", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      expect(command).toBe("fetch_provider_models");
      capturedArgs = args;
      return Promise.resolve([
        {
          id: "company-sd",
          modelDefinitionId: "remote::provider-1::company-sd",
          displayName: "SD",
          ownedBy: null,
          hasConfiguredBinding: false,
          configuredOperations: [],
          suggestedOperations: ["text_to_image"],
          operationSchema: {},
          tokenGroup: "as分组",
        },
      ]);
    });

    await providerSettingsClient.fetchProviderModels("provider-1", "as分组");
    expect(capturedArgs).toEqual({ providerConnectionId: "provider-1", tokenGroup: "as分组" });
  });

  it("defaults the pull token group to null", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      expect(command).toBe("fetch_provider_models");
      capturedArgs = args;
      return Promise.resolve([]);
    });

    await providerSettingsClient.fetchProviderModels("provider-1");
    expect(capturedArgs).toEqual({ providerConnectionId: "provider-1", tokenGroup: null });
  });
});

/**
 * 素材预览地址的共享恢复入口：所有渲染预览图的地方都走它，缺一环就会留下
 * 「某个入口能恢复、另一个入口永久停在预览不可用」的缝。
 */
describe("refreshMediaUrlWithStagingFallback", () => {
  const deadUrl =
    "https://tos.example.com/staging/e90484f4b8801be7/2026/09/14/55be7f2f.png?X-Tos-Date=20260914T023421Z&X-Tos-Expires=3600&X-Tos-Signature=dead";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the freshly read provider address", async () => {
    const fresh = "https://tos.example.com/staging/a/b.png?signature=fresh";
    const read = vi.spyOn(assetLibraryClient, "refreshAssetMedia").mockResolvedValue(fresh);
    const resign = vi.spyOn(tosStagingClient, "refreshStagingObjectUrl");

    await expect(
      refreshMediaUrlWithStagingFallback(
        { id: "asset-1", source: "cloud", providerConnectionId: "provider-1" },
        "image",
        deadUrl,
      ),
    ).resolves.toBe(fresh);
    expect(read).toHaveBeenCalledWith({
      providerConnectionId: "provider-1",
      id: "asset-1",
      mediaType: "image",
    });
    // 续签已经换到新地址，不必再按对象键重签。
    expect(resign).not.toHaveBeenCalled();
  });

  it("re-signs the staging object when the provider replays the same dead address", async () => {
    // 实测魔芋 `/v1/assets/get` 会把导入时的暂存租约地址原样回放：续签「成功」但地址没变。
    const resigned = "https://tos.example.com/staging/a/b.png?X-Tos-Date=20260914T050000Z";
    vi.spyOn(assetLibraryClient, "refreshAssetMedia").mockResolvedValue(deadUrl);
    const resign = vi
      .spyOn(tosStagingClient, "refreshStagingObjectUrl")
      .mockResolvedValue(resigned);

    await expect(
      refreshMediaUrlWithStagingFallback(
        { id: "asset-1", source: "cloud", providerConnectionId: "provider-1" },
        "image",
        deadUrl,
      ),
    ).resolves.toBe(resigned);
    expect(resign).toHaveBeenCalledWith(deadUrl);
  });

  it("falls back to the provider result when the staging object cannot be re-signed", async () => {
    vi.spyOn(assetLibraryClient, "refreshAssetMedia").mockResolvedValue(deadUrl);
    vi.spyOn(tosStagingClient, "refreshStagingObjectUrl").mockRejectedValue(
      new Error("只支持续签当前暂存桶内的对象地址。"),
    );

    // 地址不属于当前暂存桶（例如上游自己的 CDN）：保持原续签结果，不阻断其他素材行。
    await expect(
      refreshMediaUrlWithStagingFallback(
        { id: "asset-1", source: "cloud", providerConnectionId: "provider-1" },
        "image",
        "https://api.example.com/asset.png?sign=expired",
      ),
    ).resolves.toBe(deadUrl);
  });

  it("keeps local assets on their staging job identity without a provider read", async () => {
    const fresh = "https://tos.example.com/staging/local.png?signature=fresh";
    const local = vi.spyOn(tosStagingClient, "refreshLocalAssetMedia").mockResolvedValue(fresh);
    const read = vi.spyOn(assetLibraryClient, "refreshAssetMedia");

    await expect(
      refreshMediaUrlWithStagingFallback({ id: "job-1", source: "local" }, "image", null),
    ).resolves.toBe(fresh);
    expect(local).toHaveBeenCalledWith({ stagingJobId: "job-1", mediaType: "image" });
    // 本地素材没有 providerConnectionId，不该去问供应商记录。
    expect(read).not.toHaveBeenCalled();
  });
});
