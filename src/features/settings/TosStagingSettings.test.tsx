import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TosStagingClient, TosStagingConfig } from "../../lib/backend";
import { TosStagingSettings } from "./TosStagingSettings";

const SAVED_CONFIG: TosStagingConfig = {
  region: "cn-beijing",
  endpoint: "tos-cn-beijing.volces.com",
  bucket: "my-staging-bucket",
  credentialRef: "tos-ak-sk",
  objectPrefix: "staging",
  enabled: true,
};

const CONNECTIVITY_OK = {
  ok: true,
  httpStatus: 200,
  elapsedMs: 120,
  reason: null,
  detail: null,
} as const;

function createClient(
  overrides: Partial<TosStagingClient> = {},
  config: TosStagingConfig | null = SAVED_CONFIG,
): TosStagingClient {
  return {
    getConfig: vi.fn(() => Promise.resolve(config)),
    configure: vi.fn(() => Promise.resolve()),
    testConnectivity: vi.fn(() => Promise.resolve(CONNECTIVITY_OK)),
    setCredential: vi.fn(() => Promise.resolve()),
    getCredential: vi.fn(() => Promise.resolve("")),
    startUpload: vi.fn(() => Promise.resolve("job-1")),
    getJob: vi.fn(() => {
      throw new Error("not used in these tests");
    }),
    listAssetImportOutputs: vi.fn(() => Promise.resolve([])),
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
    ...overrides,
  };
}

describe("TosStagingSettings", () => {
  it("loads the saved config, updates fields, and persists AK/SK as one credential before configuring", async () => {
    const client = createClient();
    render(<TosStagingSettings client={client} />);

    expect(await screen.findByText("已启用")).toBeInTheDocument();
    expect(screen.getByLabelText(/^桶名/)).toHaveValue("my-staging-bucket");
    expect(screen.queryByLabelText(/^地域/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Endpoint/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^对象前缀/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^桶名/), {
      target: { value: "my-other-bucket" },
    });
    fireEvent.change(screen.getByLabelText(/^AccessKey ID/), {
      target: { value: "AKTEST123" },
    });
    fireEvent.change(screen.getByLabelText(/^Secret Access Key/), {
      target: { value: "SKTEST456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.setCredential).toHaveBeenCalledTimes(1);
    expect(client.setCredential).toHaveBeenCalledWith({
      credentialRef: "tos-ak-sk",
      secret: JSON.stringify({ accessKey: "AKTEST123", secretKey: "SKTEST456" }),
    });
    expect(client.configure).toHaveBeenCalledWith({
      region: "cn-beijing",
      endpoint: "tos-cn-beijing.volces.com",
      bucket: "my-other-bucket",
      credentialRef: "tos-ak-sk",
      objectPrefix: "staging",
      enabled: true,
    });
    expect(await screen.findByText(/已保存并启用/)).toBeInTheDocument();
    // 保存后输入框保留已输入的值，便于用户核对（凭据以明文可见，按需求不遮罩）。
    expect(screen.getByLabelText(/^AccessKey ID/)).toHaveValue("AKTEST123");
    expect(screen.getByLabelText(/^Secret Access Key/)).toHaveValue("SKTEST456");
  });

  it("renders the AccessKey ID and Secret Access Key inputs as visible plaintext (not masked)", async () => {
    const client = createClient();
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    // 按需求，凭据输入框为明文 text 类型，保存后可直观核对，不做密码遮罩。
    expect(screen.getByLabelText(/^AccessKey ID/)).toHaveAttribute("type", "text");
    expect(screen.getByLabelText(/^Secret Access Key/)).toHaveAttribute("type", "text");
  });

  it("keeps existing credentials when both key fields are left empty", async () => {
    const client = createClient();
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.setCredential).not.toHaveBeenCalled();
    expect(client.configure).toHaveBeenCalledWith(
      expect.objectContaining({ credentialRef: "tos-ak-sk" }),
    );
  });

  it("saves an empty bucket as a disabled config instead of erroring", async () => {
    const client = createClient({}, null);
    render(<TosStagingSettings client={client} />);

    expect(await screen.findByText("未配置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.setCredential).not.toHaveBeenCalled();
    expect(client.configure).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "", enabled: false, credentialRef: null }),
    );
    expect(await screen.findByText(/已停用/)).toBeInTheDocument();
  });

  it("fills hidden fields with defaults for an unconfigured app when saving", async () => {
    const client = createClient({}, null);
    render(<TosStagingSettings client={client} />);

    await screen.findByText("未配置");
    fireEvent.change(screen.getByLabelText(/^桶名/), {
      target: { value: "my-new-bucket" },
    });
    fireEvent.change(screen.getByLabelText(/^AccessKey ID/), {
      target: { value: "AKTEST123" },
    });
    fireEvent.change(screen.getByLabelText(/^Secret Access Key/), {
      target: { value: "SKTEST456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.configure).toHaveBeenCalledWith({
      region: "cn-beijing",
      endpoint: "tos-cn-beijing.volces.com",
      bucket: "my-new-bucket",
      credentialRef: "tos-ak-sk",
      objectPrefix: "staging",
      enabled: true,
    });
    expect(await screen.findByText("已启用")).toBeInTheDocument();
  });

  it("preserves previously saved custom hidden fields when saving again", async () => {
    const client = createClient(
      {},
      {
        ...SAVED_CONFIG,
        region: "cn-shanghai",
        endpoint: "tos-cn-shanghai.volces.com",
        objectPrefix: "custom-prefix",
      },
    );
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.configure).toHaveBeenCalledWith({
      region: "cn-shanghai",
      endpoint: "tos-cn-shanghai.volces.com",
      bucket: "my-staging-bucket",
      credentialRef: "tos-ak-sk",
      objectPrefix: "custom-prefix",
      enabled: true,
    });
  });

  it("rejects saving a bucket without AK/SK when no credentials were saved before", async () => {
    const client = createClient({}, { ...SAVED_CONFIG, credentialRef: null, enabled: false });
    render(<TosStagingSettings client={client} />);

    await screen.findByText("未配置");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    expect(await screen.findByText(/需要同时填写 AccessKey 和 SecretKey/)).toBeInTheDocument();
    expect(client.setCredential).not.toHaveBeenCalled();
    expect(client.configure).not.toHaveBeenCalled();
  });

  it("rejects mismatched AK/SK pairs", async () => {
    const client = createClient();
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.change(screen.getByLabelText(/^AccessKey ID/), {
      target: { value: "AKONLY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    expect(await screen.findByText(/需要成对填写/)).toBeInTheDocument();
    expect(client.setCredential).not.toHaveBeenCalled();
    expect(client.configure).not.toHaveBeenCalled();
  });

  it("renders the complete backend error payload without replacing it", async () => {
    const rawError = {
      kind: "protocol",
      message: "TOS upload returned HTTP 403",
      details: {
        httpStatus: 403,
        rawResponse: '{"Code":"SignatureDoesNotMatch"}',
      },
    };
    const configureError = Object.assign(new Error(rawError.message), rawError);
    const client = createClient({
      configure: vi.fn(() => Promise.reject(configureError)),
    });
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    const errorBlock = await screen.findByRole("alert");
    expect(errorBlock.querySelector("pre")?.textContent).toContain("TOS upload");
    expect(errorBlock.querySelector("pre")?.textContent).toContain("SignatureDoesNotMatch");
  });

  it("runs a connectivity test after saving an enabled config and reports success", async () => {
    const client = createClient();
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    expect(await screen.findByText(/对象存储连通性测试通过/)).toBeInTheDocument();
    expect(client.testConnectivity).toHaveBeenCalledTimes(1);
  });

  it("reports a failed connectivity test while keeping the saved config", async () => {
    const client = createClient({
      testConnectivity: vi.fn(() =>
        Promise.resolve({
          ok: false,
          httpStatus: 403,
          elapsedMs: 64,
          reason: "auth-rejected",
          detail: "code=SignatureDoesNotMatch",
        }),
      ),
    });
    render(<TosStagingSettings client={client} />);

    await screen.findByText("已启用");
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    expect(await screen.findByText(/对象存储连通性测试失败（HTTP 403）/)).toBeInTheDocument();
    expect(await screen.findByText(/凭据被拒绝/)).toBeInTheDocument();
    // 保存本身成功，成功消息与失败提示同时可见。
    expect(await screen.findByText(/已保存并启用/)).toBeInTheDocument();
    expect(client.testConnectivity).toHaveBeenCalledTimes(1);
  });

  it("skips the connectivity test when the config is saved disabled", async () => {
    const client = createClient({}, null);
    render(<TosStagingSettings client={client} />);

    expect(await screen.findByText("未配置")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存直连配置" }));

    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(1));
    expect(client.testConnectivity).not.toHaveBeenCalled();
    expect(await screen.findByText(/已停用/)).toBeInTheDocument();
  });

  it("reveals the saved AK/SK in plaintext when reopening (persisted, not hidden)", async () => {
    const client = createClient({
      getCredential: vi.fn(() =>
        Promise.resolve(JSON.stringify({ accessKey: "AKDISPLAY", secretKey: "SKDISPLAY" })),
      ),
    });
    render(<TosStagingSettings client={client} />);

    await waitFor(() => expect(screen.getByLabelText(/^AccessKey ID/)).toHaveValue("AKDISPLAY"));
    expect(screen.getByLabelText(/^Secret Access Key/)).toHaveValue("SKDISPLAY");
    expect(client.getCredential).toHaveBeenCalledWith("tos-ak-sk");
  });

  it("does not hydrate credential fields from a malformed stored payload", async () => {
    const client = createClient({
      getCredential: vi.fn(() =>
        Promise.resolve(JSON.stringify({ accessKey: 123, secretKey: "SKDISPLAY" })),
      ),
    });
    render(<TosStagingSettings client={client} />);

    await waitFor(() => expect(client.getCredential).toHaveBeenCalledWith("tos-ak-sk"));
    expect(screen.getByLabelText(/^AccessKey ID/)).toHaveValue("");
    expect(screen.getByLabelText(/^Secret Access Key/)).toHaveValue("");
  });
});
