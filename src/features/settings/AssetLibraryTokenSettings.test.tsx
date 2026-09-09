import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ASSET_LIBRARY_CREDENTIAL_REF,
  assetLibraryCredentialRef,
  type AssetLibraryClient,
  type CloudAsset,
  type ProviderConnection,
} from "../../lib/backend";
import { AssetLibraryTokenSettings } from "./AssetLibraryTokenSettings";

const PROVIDER: ProviderConnection = {
  id: "provider-company",
  displayName: "公司接口",
  adapterId: "moyu_v1",
  baseUrl: "https://api.company.com/v1",
  apiKeyRef: "provider:provider-company:api-key",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const ASSETS: CloudAsset[] = [
  {
    providerConnectionId: "provider-company",
    id: "asset-1",
    name: "参考图",
    kind: "image",
    status: "ready",
    rawStatus: "Active",
    previewUrl: "https://cdn.example.com/asset-1.png",
    assetUrl: "asset://asset-1",
    coverUrl: null,
    groupId: "12",
  },
];

function mockLibraryClient(assets: CloudAsset[] = []): AssetLibraryClient {
  return {
    list: vi.fn(() => Promise.resolve(assets)),
    deleteAsset: vi.fn(() => Promise.resolve("")),
    listAssetGroups: vi.fn(() => Promise.resolve([])),
    createAssetGroup: vi.fn(() =>
      Promise.resolve({
        id: "1",
        name: "mock",
        groupName: "mock",
        isDefault: false,
        assetCount: 0,
      }),
    ),
    renameAsset: vi.fn(() => Promise.resolve("")),
    refreshAssetCover: vi.fn(() => Promise.resolve("")),
    refreshAssetMedia: vi.fn(() => Promise.resolve("")),
    updateAssetGroup: vi.fn(() => Promise.resolve("1")),
    deleteAssetGroup: vi.fn(() => Promise.resolve("1")),
  };
}

describe("AssetLibraryTokenSettings", () => {
  it("供应商选项只显示名称，不附加待配置文案", () => {
    const pendingProvider: ProviderConnection = {
      ...PROVIDER,
      id: "provider-pending",
      displayName: "待启用接口",
      enabled: false,
    };

    render(
      <AssetLibraryTokenSettings
        provider={PROVIDER}
        providers={[PROVIDER, pendingProvider]}
        credentialClient={{
          getCredential: vi.fn(() => Promise.resolve("")),
          setCredential: vi.fn(() => Promise.resolve()),
        }}
        libraryClient={mockLibraryClient()}
        onAssetsLoaded={vi.fn()}
      />,
    );

    const pendingOption = screen.getByRole("option", { name: "待启用接口" });
    expect(pendingOption).toHaveTextContent("待启用接口");
    expect(screen.queryByText(/待配置/)).not.toBeInTheDocument();
  });

  it("切换供应商下拉框后读取并保存对应供应商的令牌", async () => {
    const otherProvider: ProviderConnection = {
      ...PROVIDER,
      id: "provider-overseas",
      displayName: "海外平台",
      apiKeyRef: "provider:provider-overseas:api-key",
    };
    const credentialClient = {
      getCredential: vi.fn((credentialRef: string) =>
        Promise.resolve(
          credentialRef === assetLibraryCredentialRef(otherProvider.id)
            ? "overseas-library-token"
            : "company-library-token",
        ),
      ),
      setCredential: vi.fn(() => Promise.resolve()),
    };
    const libraryClient = mockLibraryClient();

    const view = render(
      <AssetLibraryTokenSettings
        provider={PROVIDER}
        providers={[PROVIDER, otherProvider]}
        onProviderChanged={vi.fn()}
        credentialClient={credentialClient}
        libraryClient={libraryClient}
        onAssetsLoaded={vi.fn()}
      />,
    );

    const providerSelect = screen.getByLabelText("素材库供应商连接");
    const input = screen.getByRole("textbox", { name: "素材库令牌值" });
    await waitFor(() => expect(input).toHaveValue("company-library-token"));

    fireEvent.change(providerSelect, { target: { value: otherProvider.id } });
    // 组件通过受控 provider prop 切换，这里重新渲染来模拟父组件的选择结果。
    view.rerender(
      <AssetLibraryTokenSettings
        provider={otherProvider}
        providers={[PROVIDER, otherProvider]}
        credentialClient={credentialClient}
        libraryClient={libraryClient}
        onAssetsLoaded={vi.fn()}
      />,
    );
    const switchedInput = screen.getByRole("textbox", { name: "素材库令牌值" });
    await waitFor(() => expect(switchedInput).toHaveValue("overseas-library-token"));

    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));
    await waitFor(() =>
      expect(credentialClient.setCredential).toHaveBeenCalledWith({
        credentialRef: assetLibraryCredentialRef(otherProvider.id),
        secret: "overseas-library-token",
      }),
    );
    expect(libraryClient.list).toHaveBeenCalledWith({ providerConnectionId: otherProvider.id });
  });

  it("restores, saves, validates, and returns the token-scoped asset library", async () => {
    const credentialClient = {
      getCredential: vi.fn(() => Promise.resolve("saved-library-token")),
      setCredential: vi.fn(() => Promise.resolve()),
    };
    const libraryClient = mockLibraryClient(ASSETS);
    const onAssetsLoaded = vi.fn();
    const onPullStarted = vi.fn();

    render(
      <AssetLibraryTokenSettings
        provider={PROVIDER}
        credentialClient={credentialClient}
        libraryClient={libraryClient}
        onAssetsLoaded={onAssetsLoaded}
        onPullStarted={onPullStarted}
      />,
    );

    const input = screen.getByRole("textbox", { name: "素材库令牌值" });
    await waitFor(() => expect(input).toHaveValue("saved-library-token"));
    expect(credentialClient.getCredential).toHaveBeenCalledWith(
      assetLibraryCredentialRef(PROVIDER.id),
    );

    fireEvent.change(input, { target: { value: "  target-library-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));

    await waitFor(() =>
      expect(credentialClient.setCredential).toHaveBeenCalledWith({
        credentialRef: assetLibraryCredentialRef(PROVIDER.id),
        secret: "target-library-token",
      }),
    );
    expect(onPullStarted).toHaveBeenCalledWith(PROVIDER.id);
    expect(libraryClient.list).toHaveBeenCalledWith({ providerConnectionId: PROVIDER.id });
    expect(onAssetsLoaded).toHaveBeenCalledWith(PROVIDER.id, ASSETS);
    expect(await screen.findByText("令牌已保存，并拉取到 1 个素材。")).toBeInTheDocument();
  });

  it("供应商专用令牌不存在时读取旧版全局令牌", async () => {
    const credentialClient = {
      getCredential: vi.fn((credentialRef: string) =>
        credentialRef === ASSET_LIBRARY_CREDENTIAL_REF
          ? Promise.resolve("legacy-library-token")
          : Promise.reject(new Error("not found")),
      ),
      setCredential: vi.fn(() => Promise.resolve()),
    };

    render(
      <AssetLibraryTokenSettings
        provider={PROVIDER}
        credentialClient={credentialClient}
        libraryClient={mockLibraryClient()}
        onAssetsLoaded={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("素材库令牌值")).toHaveValue("legacy-library-token"),
    );
    expect(credentialClient.getCredential.mock.calls.map(([ref]) => ref)).toEqual([
      assetLibraryCredentialRef(PROVIDER.id),
      ASSET_LIBRARY_CREDENTIAL_REF,
    ]);
  });

  it("requires a saved provider connection before pulling assets", async () => {
    render(
      <AssetLibraryTokenSettings
        provider={null}
        credentialClient={{
          getCredential: vi.fn(() => Promise.resolve("token")),
          setCredential: vi.fn(() => Promise.resolve()),
        }}
        libraryClient={mockLibraryClient()}
        onAssetsLoaded={vi.fn()}
      />,
    );

    expect(await screen.findByText("请先保存供应商连接，再配置素材库令牌。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并拉取素材" })).toBeDisabled();
  });

  it("火山引擎连接使用 AK/SK 双输入框并组合为 JSON 保存", async () => {
    const arkProvider: ProviderConnection = {
      ...PROVIDER,
      id: "provider-ark",
      displayName: "火山引擎",
      adapterId: "volcengine_ark_v1",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "provider:provider-ark:api-key",
    };
    const credentialClient = {
      getCredential: vi.fn(() => Promise.resolve("")),
      setCredential: vi.fn(() => Promise.resolve()),
    };
    const libraryClient = mockLibraryClient();
    const onAssetsLoaded = vi.fn();

    render(
      <AssetLibraryTokenSettings
        provider={arkProvider}
        credentialClient={credentialClient}
        libraryClient={libraryClient}
        onAssetsLoaded={onAssetsLoaded}
      />,
    );

    const akInput = screen.getByRole("textbox", { name: "Access Key（AK）" });
    const skInput = screen.getByLabelText("Secret Key（SK）");
    await waitFor(() => expect(akInput).toHaveValue(""));
    await waitFor(() => expect(skInput).toHaveValue(""));
    expect(akInput).toHaveAttribute("placeholder", "输入火山引擎 Access Key，例如 AKLT…");
    // 非火山引擎的单字段令牌输入框不应出现。
    expect(screen.queryByRole("textbox", { name: "素材库令牌值" })).not.toBeInTheDocument();

    // AK 为空时拒绝保存。
    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));
    await expect(screen.findByText(/请输入火山引擎 Access Key/)).resolves.toBeInTheDocument();
    expect(credentialClient.setCredential).not.toHaveBeenCalled();

    // 仅填 AK、SK 为空时拒绝保存。
    fireEvent.change(akInput, { target: { value: "AK-test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));
    await expect(screen.findByText(/请输入火山引擎 Secret Key/)).resolves.toBeInTheDocument();
    expect(credentialClient.setCredential).not.toHaveBeenCalled();

    // 填入 AK/SK 后通过校验并组合为 JSON 保存。
    fireEvent.change(skInput, { target: { value: "SK-test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));
    await waitFor(() =>
      expect(credentialClient.setCredential).toHaveBeenCalledWith({
        credentialRef: assetLibraryCredentialRef(arkProvider.id),
        secret: '{"accessKey":"AK-test","secretKey":"SK-test"}',
      }),
    );
    expect(libraryClient.list).toHaveBeenCalledWith({ providerConnectionId: arkProvider.id });
  });

  it("火山引擎连接回显已保存的 AK/SK JSON 到两个输入框", async () => {
    const arkProvider: ProviderConnection = {
      ...PROVIDER,
      id: "provider-ark-echo",
      displayName: "火山引擎",
      adapterId: "volcengine_ark_v1",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "provider:provider-ark-echo:api-key",
    };
    const credentialClient = {
      getCredential: vi.fn(() =>
        Promise.resolve('{"accessKey":"AK-saved","secretKey":"SK-saved"}'),
      ),
      setCredential: vi.fn(() => Promise.resolve()),
    };

    render(
      <AssetLibraryTokenSettings
        provider={arkProvider}
        credentialClient={credentialClient}
        libraryClient={mockLibraryClient()}
        onAssetsLoaded={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Access Key（AK）" })).toHaveValue("AK-saved"),
    );
    expect(screen.getByLabelText("Secret Key（SK）")).toHaveValue("SK-saved");
  });
});
