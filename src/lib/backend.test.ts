import { afterEach, describe, expect, it } from "vitest";

import {
  assetLibraryClient,
  BackendContractError,
  providerSettingsClient,
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
        groupId: 7,
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
  it("forwards a real-person platform group ID through the existing staging upload", async () => {
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
          groupId: 128,
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
          groupId: 128,
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
