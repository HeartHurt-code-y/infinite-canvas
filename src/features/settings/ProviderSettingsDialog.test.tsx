import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetLibraryClient } from "../../lib/backend";
import type {
  ProviderConnection,
  ProviderSettingsClient,
  ProviderTokenGroup,
  RemoteModelOption,
  TosStagingClient,
} from "../../lib/backend";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";

const SAVED_PROVIDER: ProviderConnection = {
  id: "provider-company",
  displayName: "公司接口",
  adapterId: "moyu_v1",
  baseUrl: "https://api.company.com/v1",
  apiKeyRef: "provider:provider-company:api-key",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const TOS_STUB: TosStagingClient = {
  getConfig: vi.fn(() => Promise.resolve(null)),
  configure: vi.fn(() => Promise.resolve()),
  testConnectivity: vi.fn(() => Promise.resolve(CONNECTIVITY_OK)),
  setCredential: vi.fn(() => Promise.resolve()),
  getCredential: vi.fn(() => Promise.resolve("")),
  startUpload: vi.fn(() => Promise.resolve("job-1")),
  getJob: vi.fn(() => Promise.reject(new Error("unused"))),
  listLocalAssets: vi.fn(() =>
    Promise.resolve({
      items: [],
      total: 0,
      page: 1,
      pageSize: 40,
      kindTotals: { image: 0, video: 0, audio: 0 },
    }),
  ),
  pullBucketAssets: vi.fn(() =>
    Promise.resolve({
      totalObjects: 0,
      imported: 0,
      skippedExisting: 0,
      ignoredUnsupported: 0,
      prefix: "",
    }),
  ),
};

const CONNECTIVITY_OK = {
  ok: true,
  httpStatus: 200,
  elapsedMs: 42,
  reason: null,
  detail: null,
} as const;

const IMAGE_OPERATION_SCHEMA = {
  text_to_image: {
    resultType: "image",
    parameters: { size: { type: "string", default: "1024x1024" } },
  },
  image_to_image: { resultType: "image" },
} as const;

const VIDEO_OPERATION_SCHEMA = {
  video_generation: {
    resultType: "video",
    parameters: { duration: { type: "integer", default: 8 } },
  },
} as const;

const TEXT_OPERATION_SCHEMA = {
  text_generation: {
    resultType: "text",
    requestProfileId: "openai_chat_v1",
    parameters: {},
  },
} as const;

const REMOTE_MODELS: RemoteModelOption[] = [
  {
    id: "company-image-1",
    modelDefinitionId: "remote::provider-company::company-image-1",
    displayName: "公司图片模型",
    ownedBy: "company",
    hasConfiguredBinding: false,
    configuredOperations: [],
    suggestedOperations: ["text_to_image"],
    operationSchema: IMAGE_OPERATION_SCHEMA,
    tokenGroup: null,
  },
  {
    id: "company-video-1",
    modelDefinitionId: "remote::provider-company::company-video-1",
    displayName: "公司视频模型",
    ownedBy: null,
    hasConfiguredBinding: true,
    configuredOperations: ["video_generation"],
    suggestedOperations: ["text_to_image", "image_to_image"],
    operationSchema: VIDEO_OPERATION_SCHEMA,
    tokenGroup: null,
  },
];

const AS_GROUP: ProviderTokenGroup = {
  id: "token-group-1",
  providerConnectionId: SAVED_PROVIDER.id,
  groupName: "as分组",
  credentialRef: "provider:provider-company:token:token-group-1",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function createClient(overrides: Partial<ProviderSettingsClient> = {}): ProviderSettingsClient {
  return {
    listProviderConnections: vi.fn(() => Promise.resolve([])),
    upsertProviderConnection: vi.fn(() => Promise.resolve(SAVED_PROVIDER)),
    setCredential: vi.fn(() => Promise.resolve()),
    fetchProviderModels: vi.fn(() => Promise.resolve(REMOTE_MODELS)),
    listSavedProviderModels: vi.fn(() => Promise.resolve([])),
    testConnection: vi.fn(() => Promise.resolve(CONNECTIVITY_OK)),
    replaceProviderModelBindings: vi.fn(() => Promise.resolve([])),
    getCredential: vi.fn(() => Promise.resolve("")),
    listProviderTokenGroups: vi.fn(() => Promise.resolve([])),
    upsertProviderTokenGroup: vi.fn(() =>
      Promise.resolve({
        id: "token-group-1",
        providerConnectionId: SAVED_PROVIDER.id,
        groupName: "as分组",
        credentialRef: "provider:provider-company:token:token-group-1",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    deleteProviderTokenGroup: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/** 单个已保存的图片模型，用于让保存按钮渲染出来。 */
const SAVED_IMAGE_MODEL: RemoteModelOption[] = [
  {
    id: "company-image-1",
    modelDefinitionId: "remote::provider-company::company-image-1",
    displayName: "公司图片模型",
    ownedBy: null,
    hasConfiguredBinding: true,
    configuredOperations: ["text_to_image"],
    suggestedOperations: [],
    operationSchema: IMAGE_OPERATION_SCHEMA,
    tokenGroup: null,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProviderSettingsDialog", () => {
  it("素材库跟随全局设置中当前选中的供应商", async () => {
    const otherProvider: ProviderConnection = {
      ...SAVED_PROVIDER,
      id: "provider-other",
      displayName: "海外平台",
      baseUrl: "https://new-provider.example/v1",
      apiKeyRef: "provider:provider-other:api-key",
    };
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER, otherProvider])),
    });
    const listSpy = vi.spyOn(assetLibraryClient, "list").mockResolvedValue([]);
    const onAssetProviderChanged = vi.fn();

    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        activeAssetProviderId={SAVED_PROVIDER.id}
        onAssetProviderChanged={onAssetProviderChanged}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("供应商连接")).toHaveValue(SAVED_PROVIDER.id));
    fireEvent.change(screen.getByLabelText("供应商连接"), {
      target: { value: otherProvider.id },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存并拉取素材" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("素材库令牌值"), {
      target: { value: "<REDACTED>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并拉取素材" }));

    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ providerConnectionId: otherProvider.id }),
    );
    expect(onAssetProviderChanged).toHaveBeenCalledWith(otherProvider.id);
  });

  it("requires a key for a new connection and saves without pulling models", async () => {
    const client = createClient();
    const onCatalogChanged = vi.fn(() => Promise.resolve());
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={onCatalogChanged}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com/v1" },
    });
    const saveButton = screen.getByRole("button", { name: "保存连接" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    expect(await screen.findByRole("alert")).toHaveTextContent("新供应商连接需要输入 API Key");
    expect(client.upsertProviderConnection).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "secret-key" } });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(client.upsertProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://api.company.com/v1", adapterId: "moyu_v1" }),
      ),
    );
    expect(client.setCredential).toHaveBeenCalledWith({
      credentialRef: SAVED_PROVIDER.apiKeyRef,
      secret: "secret-key",
    });
    expect(client.fetchProviderModels).not.toHaveBeenCalled();
    expect(onCatalogChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText(/已保存 公司接口 的连接信息/)).toBeInTheDocument();
  });

  it("saves an existing connection while keeping its stored key", async () => {
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    const saveButton = screen.getByRole("button", { name: "保存连接" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com/updated/v1" },
    });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(client.upsertProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://api.company.com/updated/v1" }),
      ),
    );
    expect(client.setCredential).not.toHaveBeenCalled();
    expect(client.fetchProviderModels).not.toHaveBeenCalled();
  });

  it("restores saved models from the local database when the dialog opens", async () => {
    const savedModels: RemoteModelOption[] = [
      {
        id: "company-image-1",
        modelDefinitionId: "remote::provider-company::company-image-1",
        displayName: "公司图片模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: ["text_to_image", "image_to_image"],
        suggestedOperations: [],
        operationSchema: IMAGE_OPERATION_SCHEMA,
        tokenGroup: null,
      },
      {
        id: "company-disabled-1",
        modelDefinitionId: "remote::provider-company::company-disabled-1",
        displayName: "公司停用模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: [],
        suggestedOperations: [],
        operationSchema: IMAGE_OPERATION_SCHEMA,
        tokenGroup: null,
      },
      {
        id: "company-video-1",
        modelDefinitionId: "remote::provider-company::company-video-1",
        displayName: "公司视频模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: ["video_generation"],
        suggestedOperations: [],
        operationSchema: VIDEO_OPERATION_SCHEMA,
        tokenGroup: null,
      },
    ];
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(savedModels)),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    const imageModel = (await screen.findByText("公司图片模型")).closest("article");
    expect(imageModel).not.toBeNull();
    expect(
      within(imageModel as HTMLElement).getByRole("radio", { name: "图片模型" }),
    ).toBeChecked();
    expect(
      within(imageModel as HTMLElement).getByRole("checkbox", { name: "文生图" }),
    ).toBeChecked();
    expect(
      within(imageModel as HTMLElement).getByRole("checkbox", { name: "图片参考生成" }),
    ).toBeChecked();

    const disabledModel = screen.getByText("公司停用模型").closest("article");
    expect(disabledModel).not.toBeNull();
    expect(
      within(disabledModel as HTMLElement).getByRole("radio", { name: "不启用" }),
    ).toBeChecked();

    const videoModel = screen.getByText("公司视频模型").closest("article");
    expect(videoModel).not.toBeNull();
    expect(
      within(videoModel as HTMLElement).getByRole("radio", { name: "视频模型" }),
    ).toBeChecked();

    expect(client.listSavedProviderModels).toHaveBeenCalledWith(SAVED_PROVIDER.id);
    expect(client.fetchProviderModels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));
    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(
        SAVED_PROVIDER.id,
        expect.arrayContaining([
          expect.objectContaining({
            remoteModelId: "company-image-1",
            enabled: true,
            enabledOperations: ["text_to_image", "image_to_image"],
          }),
          expect.objectContaining({
            remoteModelId: "company-disabled-1",
            enabled: false,
            enabledOperations: [],
          }),
          expect.objectContaining({
            remoteModelId: "company-video-1",
            enabled: true,
            enabledOperations: ["video_generation"],
          }),
        ]),
      ),
    );
  });

  it("classifies a text model and persists text_generation operations", async () => {
    const savedModels: RemoteModelOption[] = [
      {
        id: "company-chat-1",
        modelDefinitionId: "remote::provider-company::company-chat-1",
        displayName: "公司文本模型",
        ownedBy: null,
        hasConfiguredBinding: false,
        configuredOperations: [],
        suggestedOperations: ["text_generation"],
        operationSchema: TEXT_OPERATION_SCHEMA,
        tokenGroup: null,
      },
    ];
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(savedModels)),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    const textModel = (await screen.findByText("公司文本模型")).closest("article");
    expect(textModel).not.toBeNull();
    // 建议操作为 text_generation 的模型自动选中「文本模型」分类。
    expect(within(textModel as HTMLElement).getByRole("radio", { name: "文本模型" })).toBeChecked();
    expect(screen.getByText("文本模型 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));
    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(
        SAVED_PROVIDER.id,
        expect.arrayContaining([
          expect.objectContaining({
            remoteModelId: "company-chat-1",
            enabled: true,
            enabledOperations: ["text_generation"],
          }),
        ]),
      ),
    );
  });

  it("filters pulled models by text, image, and video type", async () => {
    const textModel: RemoteModelOption = {
      id: "company-chat-1",
      modelDefinitionId: "remote::provider-company::company-chat-1",
      displayName: "公司文本模型",
      ownedBy: null,
      hasConfiguredBinding: false,
      configuredOperations: [],
      suggestedOperations: ["text_generation"],
      operationSchema: TEXT_OPERATION_SCHEMA,
      tokenGroup: null,
    };
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      fetchProviderModels: vi.fn(() => Promise.resolve([...REMOTE_MODELS, textModel])),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    await screen.findByText("公司文本模型");
    const allFilter = screen.getByRole("button", { name: "全部模型，3 个" });
    expect(allFilter).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "文本模型，1 个" }));
    expect(screen.getByText("公司文本模型")).toBeInTheDocument();
    expect(screen.queryByText("公司图片模型")).not.toBeInTheDocument();
    expect(screen.queryByText("公司视频模型")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "图片模型，1 个" }));
    expect(screen.getByText("公司图片模型")).toBeInTheDocument();
    expect(screen.queryByText("公司文本模型")).not.toBeInTheDocument();
    expect(screen.queryByText("公司视频模型")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "视频模型，1 个" }));
    expect(screen.getByText("公司视频模型")).toBeInTheDocument();
    expect(screen.queryByText("公司文本模型")).not.toBeInTheDocument();
    expect(screen.queryByText("公司图片模型")).not.toBeInTheDocument();

    fireEvent.click(allFilter);
    expect(screen.getByText("公司文本模型")).toBeInTheDocument();
    expect(screen.getByText("公司图片模型")).toBeInTheDocument();
    expect(screen.getByText("公司视频模型")).toBeInTheDocument();
  });

  it("runs a connectivity test after saving models and reports the success", async () => {
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(SAVED_IMAGE_MODEL)),
      testConnection: vi.fn(() =>
        Promise.resolve({
          ok: true,
          httpStatus: 200,
          elapsedMs: 320,
          reason: null,
          detail: null,
        }),
      ),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("供应商连接")).toHaveValue(SAVED_PROVIDER.id));
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    expect(await screen.findByText(/供应商 公司接口 连通性测试通过/)).toBeInTheDocument();
    expect(client.testConnection).toHaveBeenCalledWith(SAVED_PROVIDER.id);
  });

  it("reports a failed connectivity test without discarding the saved models", async () => {
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(SAVED_IMAGE_MODEL)),
      testConnection: vi.fn(() =>
        Promise.resolve({
          ok: false,
          httpStatus: 401,
          elapsedMs: 87,
          reason: "auth-rejected",
          detail: "invalid api key",
        }),
      ),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("供应商连接")).toHaveValue(SAVED_PROVIDER.id));
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    expect(await screen.findByText(/连通性测试失败（HTTP 401）/)).toBeInTheDocument();
    // 保存本身成功，成功消息与失败提示同时可见。
    expect(await screen.findByText(/已保存 \d+ 个图片模型/)).toBeInTheDocument();
    expect(client.testConnection).toHaveBeenCalledWith(SAVED_PROVIDER.id);
  });

  it("restores saved models again when switching between saved providers", async () => {
    const otherProvider: ProviderConnection = {
      ...SAVED_PROVIDER,
      id: "provider-other",
      displayName: "备用接口",
      apiKeyRef: "provider:provider-other:api-key",
    };
    const savedModels: RemoteModelOption[] = [
      {
        id: "other-video-1",
        modelDefinitionId: "remote::provider-other::other-video-1",
        displayName: "备用视频模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: ["video_generation"],
        suggestedOperations: [],
        operationSchema: VIDEO_OPERATION_SCHEMA,
        tokenGroup: null,
      },
    ];
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER, otherProvider])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(savedModels)),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await screen.findByText("备用视频模型");
    expect(client.listSavedProviderModels).toHaveBeenCalledWith(SAVED_PROVIDER.id);

    fireEvent.change(screen.getByLabelText("供应商连接"), {
      target: { value: "provider-other" },
    });

    await waitFor(() =>
      expect(client.listSavedProviderModels).toHaveBeenCalledWith("provider-other"),
    );
    expect(await screen.findByText("备用视频模型")).toBeInTheDocument();
    expect(screen.queryByText("公司图片模型")).not.toBeInTheDocument();
    expect(client.fetchProviderModels).not.toHaveBeenCalled();
  });

  it("persists before pulling, auto-selects suggestions, and saves operation schema", async () => {
    const callOrder: string[] = [];
    const client = createClient({
      upsertProviderConnection: vi.fn(() => {
        callOrder.push("save-connection");
        return Promise.resolve(SAVED_PROVIDER);
      }),
      setCredential: vi.fn(() => {
        callOrder.push("save-key");
        return Promise.resolve();
      }),
      fetchProviderModels: vi.fn(() => {
        callOrder.push("fetch-models");
        return Promise.resolve(REMOTE_MODELS);
      }),
    });
    const onCatalogChanged = vi.fn(() => Promise.resolve());
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={onCatalogChanged}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "secret-key" } });
    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    const imageModelName = await screen.findByText("公司图片模型");
    expect(callOrder).toEqual(["save-connection", "save-key", "fetch-models"]);
    expect(client.fetchProviderModels).toHaveBeenCalledWith(SAVED_PROVIDER.id, null);

    const imageModel = imageModelName.closest("article");
    expect(imageModel).not.toBeNull();
    expect(
      within(imageModel as HTMLElement).getByRole("radio", { name: "图片模型" }),
    ).toBeChecked();
    expect(
      within(imageModel as HTMLElement).getByRole("checkbox", { name: "文生图" }),
    ).toBeChecked();
    expect(
      within(imageModel as HTMLElement).getByRole("checkbox", { name: "图片参考生成" }),
    ).toBeChecked();

    const videoModel = screen.getByText("公司视频模型").closest("article");
    expect(videoModel).not.toBeNull();
    expect(
      within(videoModel as HTMLElement).getByRole("radio", { name: "视频模型" }),
    ).toBeChecked();
    expect(within(videoModel as HTMLElement).queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(
        SAVED_PROVIDER.id,
        expect.arrayContaining([
          expect.objectContaining({
            remoteModelId: "company-image-1",
            enabled: true,
            enabledOperations: ["text_to_image", "image_to_image"],
            operationSchema: IMAGE_OPERATION_SCHEMA,
          }),
          expect.objectContaining({
            remoteModelId: "company-video-1",
            enabled: true,
            enabledOperations: ["video_generation"],
            operationSchema: VIDEO_OPERATION_SCHEMA,
          }),
        ]),
      ),
    );
    expect(onCatalogChanged).toHaveBeenCalledOnce();
    expect(screen.getByText(/1 个图片模型、1 个视频模型/)).toBeInTheDocument();
  });

  it("按令牌分组拉取模型、为模型指定调用令牌，并在保存时携带 tokenGroup", async () => {
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listProviderTokenGroups: vi.fn(() => Promise.resolve([AS_GROUP])),
      fetchProviderModels: vi.fn(() => Promise.resolve(REMOTE_MODELS)),
    });
    const onCatalogChanged = vi.fn(() => Promise.resolve());
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={onCatalogChanged}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    // 已保存的供应商加载后，「拉取令牌」下拉应列出令牌分组。
    await waitFor(() => expect(screen.getByLabelText("供应商连接")).toHaveValue(SAVED_PROVIDER.id));
    const pullTokenSelect = screen.getByLabelText(/拉取令牌/);
    await waitFor(() =>
      expect(within(pullTokenSelect).getByRole("option", { name: "as分组" })).toBeInTheDocument(),
    );
    fireEvent.change(pullTokenSelect, { target: { value: "as分组" } });

    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    // 拉取请求应携带所选令牌分组。
    await waitFor(() =>
      expect(client.fetchProviderModels).toHaveBeenCalledWith(SAVED_PROVIDER.id, "as分组"),
    );

    // 模型卡片上的「调用令牌」下拉列出全部分组，可为该模型指定 as 分组。
    const imageModelName = await screen.findByText("公司图片模型");
    const imageModel = imageModelName.closest("article");
    expect(imageModel).not.toBeNull();
    const tokenSelect = within(imageModel as HTMLElement).getByLabelText(/调用令牌/);
    expect(within(tokenSelect).getByRole("option", { name: "as分组" })).toBeInTheDocument();
    fireEvent.change(tokenSelect, { target: { value: "as分组" } });

    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    // 保存时该模型的绑定应携带 tokenGroup: "as分组"。
    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(
        SAVED_PROVIDER.id,
        expect.arrayContaining([
          expect.objectContaining({
            remoteModelId: "company-image-1",
            enabled: true,
            tokenGroup: "as分组",
          }),
          expect.objectContaining({
            remoteModelId: "company-video-1",
            enabled: true,
            tokenGroup: null,
          }),
        ]),
      ),
    );
  });

  it("keeps an explicitly disabled model unselected after pulling again", async () => {
    const disabledModel: RemoteModelOption = {
      ...REMOTE_MODELS[0]!,
      hasConfiguredBinding: true,
      configuredOperations: [],
      suggestedOperations: ["text_to_image", "image_to_image"],
    };
    const client = createClient({
      fetchProviderModels: vi.fn(() => Promise.resolve([disabledModel])),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "secret-key" } });
    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    const model = (await screen.findByText("公司图片模型")).closest("article");
    expect(model).not.toBeNull();
    expect(within(model as HTMLElement).getByRole("radio", { name: "不启用" })).toBeChecked();
    expect(within(model as HTMLElement).queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));
    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(SAVED_PROVIDER.id, [
        expect.objectContaining({
          remoteModelId: "company-image-1",
          enabled: false,
          enabledOperations: [],
        }),
      ]),
    );
  });

  it("persists disabling a newly discovered suggested model", async () => {
    const client = createClient({
      fetchProviderModels: vi.fn(() => Promise.resolve([REMOTE_MODELS[0]!])),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "secret-key" } });
    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    const model = (await screen.findByText("公司图片模型")).closest("article");
    expect(model).not.toBeNull();
    fireEvent.click(within(model as HTMLElement).getByRole("radio", { name: "不启用" }));
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(SAVED_PROVIDER.id, [
        expect.objectContaining({ enabled: false, enabledOperations: [] }),
      ]),
    );
  });

  it("renders the complete backend error payload without replacing it", async () => {
    const rawError = {
      kind: "protocol",
      message: "provider returned HTTP 502 while listing models",
      details: {
        httpStatus: 502,
        headers: { "x-request-id": "req-models-1" },
        rawResponse: '{"error":{"code":"UPSTREAM_FAILED"}}',
      },
    };
    const providerError = Object.assign(new Error(rawError.message), rawError);
    const client = createClient({
      fetchProviderModels: vi.fn(() => Promise.reject(providerError)),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Base URL/), {
      target: { value: "https://api.company.com" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "secret-key" } });
    const fetchButton = screen.getByRole("button", { name: "拉取模型" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    fireEvent.click(fetchButton);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('"httpStatus": 502');
    expect(alert).toHaveTextContent('"x-request-id": "req-models-1"');
    expect(alert).toHaveTextContent("UPSTREAM_FAILED");
  });

  it("re-scopes legacy bare model ids when saving restored models", async () => {
    // 历史版本允许把裸远程模型 ID 直接存为模型定义 ID；恢复时仍可能拿到裸 ID。
    // 保存必须按规范作用域格式发送，避免后端 scoping 校验失败。
    const legacyModels: RemoteModelOption[] = [
      {
        id: "company-image-1",
        modelDefinitionId: "company-image-1",
        displayName: "公司图片模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: ["text_to_image"],
        suggestedOperations: [],
        operationSchema: IMAGE_OPERATION_SCHEMA,
        tokenGroup: null,
      },
      {
        id: "company-video-1",
        modelDefinitionId: "company-video-1",
        displayName: "公司视频模型",
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: ["video_generation"],
        suggestedOperations: [],
        operationSchema: VIDEO_OPERATION_SCHEMA,
        tokenGroup: null,
      },
    ];
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      listSavedProviderModels: vi.fn(() => Promise.resolve(legacyModels)),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    const imageModel = (await screen.findByText("公司图片模型")).closest("article");
    expect(imageModel).not.toBeNull();
    expect(
      within(imageModel as HTMLElement).getByRole("checkbox", { name: "图片参考生成" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存图片、视频与文本模型" }));

    await waitFor(() =>
      expect(client.replaceProviderModelBindings).toHaveBeenCalledWith(SAVED_PROVIDER.id, [
        expect.objectContaining({
          remoteModelId: "company-image-1",
          modelDefinitionId: "remote::provider-company::company-image-1",
          enabled: true,
          enabledOperations: ["text_to_image"],
        }),
        expect.objectContaining({
          remoteModelId: "company-video-1",
          modelDefinitionId: "remote::provider-company::company-video-1",
          enabled: true,
          enabledOperations: ["video_generation"],
        }),
      ]),
    );
  });

  it("reveals the saved API key in plaintext when reopening an existing connection", async () => {
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER])),
      getCredential: vi.fn(() => Promise.resolve("REVEALED-KEY")),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(/^API Key/)).toHaveValue("REVEALED-KEY"));
    expect(client.getCredential).toHaveBeenCalledWith(SAVED_PROVIDER.apiKeyRef);
  });

  it("loads the selected provider's saved key when switching connections", async () => {
    const otherProvider: ProviderConnection = {
      ...SAVED_PROVIDER,
      id: "provider-other",
      displayName: "备用接口",
      apiKeyRef: "provider:provider-other:api-key",
    };
    const client = createClient({
      listProviderConnections: vi.fn(() => Promise.resolve([SAVED_PROVIDER, otherProvider])),
      getCredential: vi.fn((ref: string) =>
        Promise.resolve(ref === SAVED_PROVIDER.apiKeyRef ? "COMPANY-KEY" : "OTHER-KEY"),
      ),
    });
    render(
      <ProviderSettingsDialog
        open
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        client={client}
        tosClient={TOS_STUB}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(/^API Key/)).toHaveValue("COMPANY-KEY"));
    fireEvent.change(screen.getByLabelText("供应商连接"), { target: { value: "provider-other" } });
    await waitFor(() => expect(screen.getByLabelText(/^API Key/)).toHaveValue("OTHER-KEY"));
    expect(client.getCredential).toHaveBeenCalledWith(otherProvider.apiKeyRef);
  });
});
