import { afterEach, describe, expect, it } from "vitest";

import {
  assetLibraryClient,
  BackendContractError,
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

describe("tosStagingClient.listLocalAssets", () => {
  it("reads the independent local index without a remote provider query", async () => {
    let capturedCommand = "";
    let capturedArgs: Record<string, unknown> | undefined;
    mockDesktopInvoke((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return Promise.resolve([
        {
          id: "upload-1",
          name: "reference.png",
          mediaType: "image",
          objectKey: "assets/reference.png",
          previewUrl: "https://tos.example.com/reference.png?sign=fresh",
          byteSize: 128,
          createdAt: 1,
        },
      ]);
    });

    const assets = await tosStagingClient.listLocalAssets();
    expect(capturedCommand).toBe("list_local_assets");
    expect(capturedArgs).toEqual({});
    expect(assets[0]?.id).toBe("upload-1");
  });

  it("rejects malformed desktop payloads at the IPC boundary", async () => {
    mockDesktopInvoke(() =>
      Promise.resolve([
        {
          id: "upload-1",
          name: "reference.png",
          mediaType: "document",
          objectKey: "assets/reference.png",
          previewUrl: "https://tos.example.com/reference.png?secret=must-not-leak",
          byteSize: 128,
          createdAt: 1,
        },
      ]),
    );

    const request = tosStagingClient.listLocalAssets();
    await expect(request).rejects.toBeInstanceOf(BackendContractError);
    await expect(request).rejects.toMatchObject({
      details: {
        command: "list_local_assets",
        issues: [expect.objectContaining({ path: "0.mediaType" })],
      },
    });
    await expect(request).rejects.not.toThrow(/must-not-leak/);
  });
});
