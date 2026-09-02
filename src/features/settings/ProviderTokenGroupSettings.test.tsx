import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection, ProviderSettingsClient } from "../../lib/backend";
import { ProviderTokenGroupSettings } from "./ProviderTokenGroupSettings";

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

const CONNECTIVITY_OK = {
  ok: true,
  httpStatus: 200,
  elapsedMs: 42,
  reason: null,
  detail: null,
} as const;

const AS_GROUP = {
  id: "token-group-1",
  providerConnectionId: PROVIDER.id,
  groupName: "as分组",
  credentialRef: "provider:provider-company:token:token-group-1",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function createClient(overrides: Partial<ProviderSettingsClient> = {}): ProviderSettingsClient {
  return {
    listProviderConnections: vi.fn(() => Promise.resolve([])),
    upsertProviderConnection: vi.fn(),
    setCredential: vi.fn(() => Promise.resolve()),
    getCredential: vi.fn(() => Promise.resolve("")),
    fetchProviderModels: vi.fn(() => Promise.resolve([])),
    listSavedProviderModels: vi.fn(() => Promise.resolve([])),
    testConnection: vi.fn(() => Promise.resolve(CONNECTIVITY_OK)),
    replaceProviderModelBindings: vi.fn(() => Promise.resolve([])),
    listProviderTokenGroups: vi.fn(() => Promise.resolve([])),
    upsertProviderTokenGroup: vi.fn(
      (command: { readonly providerConnectionId: string; readonly groupName: string }) =>
        Promise.resolve({
          id: "token-group-new",
          providerConnectionId: command.providerConnectionId,
          groupName: command.groupName,
          credentialRef: `provider:${command.providerConnectionId}:token:token-group-new`,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        }),
    ),
    deleteProviderTokenGroup: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProviderTokenGroupSettings", () => {
  it("loads and renders token groups for the active provider", async () => {
    const client = createClient({
      listProviderTokenGroups: vi.fn(() => Promise.resolve([AS_GROUP])),
      getCredential: vi.fn(() => Promise.resolve("as-secret")),
    });
    render(
      <ProviderTokenGroupSettings provider={PROVIDER} client={client} credentialClient={client} />,
    );

    await screen.findByDisplayValue("as分组");
    expect(client.listProviderTokenGroups).toHaveBeenCalledWith(PROVIDER.id);
    expect(screen.getByDisplayValue("as-secret")).toBeInTheDocument();
  });

  it("adds a new group with name and secret", async () => {
    const client = createClient();
    const onTokenGroupsChanged = vi.fn();
    render(
      <ProviderTokenGroupSettings
        provider={PROVIDER}
        client={client}
        credentialClient={client}
        onTokenGroupsChanged={onTokenGroupsChanged}
      />,
    );

    const nameInput = await screen.findByLabelText("新增分组名称");
    fireEvent.change(nameInput, { target: { value: "as分组" } });
    fireEvent.change(screen.getByLabelText(/^令牌值/), { target: { value: "as-token" } });
    fireEvent.click(screen.getByRole("button", { name: "添加分组" }));

    await waitFor(() =>
      expect(client.upsertProviderTokenGroup).toHaveBeenCalledWith({
        providerConnectionId: PROVIDER.id,
        groupName: "as分组",
        enabled: true,
        secret: "as-token",
      }),
    );
    expect(await screen.findByText(/已添加/)).toBeInTheDocument();
    expect(onTokenGroupsChanged).toHaveBeenCalled();
  });

  it("rejects duplicate group names before calling the backend", async () => {
    const client = createClient({
      listProviderTokenGroups: vi.fn(() => Promise.resolve([AS_GROUP])),
    });
    render(
      <ProviderTokenGroupSettings provider={PROVIDER} client={client} credentialClient={client} />,
    );

    await screen.findByDisplayValue("as分组");
    fireEvent.change(await screen.findByLabelText("新增分组名称"), {
      target: { value: "as分组" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加分组" }));

    expect(await screen.findByText(/已存在/)).toBeInTheDocument();
    expect(client.upsertProviderTokenGroup).not.toHaveBeenCalled();
  });

  it("saves the secret of an existing group back to the credential store", async () => {
    const client = createClient({
      listProviderTokenGroups: vi.fn(() => Promise.resolve([AS_GROUP])),
      getCredential: vi.fn(() => Promise.resolve("old-secret")),
    });
    render(
      <ProviderTokenGroupSettings provider={PROVIDER} client={client} credentialClient={client} />,
    );

    const secretInput = await screen.findByDisplayValue("old-secret");
    fireEvent.change(secretInput, { target: { value: "new-secret" } });
    const row = secretInput.closest(".token-group-settings__row");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(client.upsertProviderTokenGroup).toHaveBeenCalledWith({
        providerConnectionId: PROVIDER.id,
        groupName: "as分组",
        enabled: true,
        secret: "new-secret",
      }),
    );
  });

  it("tests connectivity with the group token", async () => {
    const client = createClient({
      listProviderTokenGroups: vi.fn(() => Promise.resolve([AS_GROUP])),
    });
    render(
      <ProviderTokenGroupSettings provider={PROVIDER} client={client} credentialClient={client} />,
    );

    await screen.findByDisplayValue("as分组");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));

    await waitFor(() => expect(client.testConnection).toHaveBeenCalledWith(PROVIDER.id, "as分组"));
    expect(await screen.findByText(/连通性正常/)).toBeInTheDocument();
  });

  it("deletes a group and reports the model fallback", async () => {
    let groups: (typeof AS_GROUP)[] = [AS_GROUP];
    const client = createClient({
      listProviderTokenGroups: vi.fn(() => Promise.resolve(groups)),
      deleteProviderTokenGroup: vi.fn(() => {
        groups = [];
        return Promise.resolve();
      }),
    });
    render(
      <ProviderTokenGroupSettings provider={PROVIDER} client={client} credentialClient={client} />,
    );

    await screen.findByDisplayValue("as分组");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(client.deleteProviderTokenGroup).toHaveBeenCalledWith(PROVIDER.id, "as分组"),
    );
    expect(await screen.findByText(/回到默认令牌/)).toBeInTheDocument();
  });
});
