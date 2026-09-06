import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RealPersonAssetLibraryClient, RealPersonGroup } from "../../lib/backend";
import { RealPersonAssetDialog } from "./AssetDialogs";

const AUTHORIZED_GROUP: RealPersonGroup = {
  id: 128,
  remoteGroupId: "group-remote-1",
  artistName: "李四",
  artistDesc: "品牌代言人",
  authorizedAt: "2026-04-27T12:00:29+08:00",
  assetCount: 3,
};

function dialogClient(
  overrides: Partial<RealPersonAssetLibraryClient> = {},
): RealPersonAssetLibraryClient {
  return {
    createRealPersonAuthLink: vi.fn().mockResolvedValue({
      h5Url: "https://h5.example.com/auth?ticket=once",
      tip: "请在 120 秒内完成认证",
    }),
    listRealPersonGroups: vi.fn().mockResolvedValue([AUTHORIZED_GROUP]),
    deleteRealPersonAsset: vi.fn().mockResolvedValue("asset-1"),
    deleteRealPersonGroup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RealPersonAssetDialog", () => {
  it("creates, copies, and opens a visible H5 authorization link", async () => {
    const client = dialogClient();
    const copyLink = vi.fn().mockResolvedValue(undefined);
    const openLink = vi.fn().mockResolvedValue(undefined);

    render(
      <RealPersonAssetDialog
        providerConnectionId="provider-1"
        providerDisplayName="海外平台"
        onClose={vi.fn()}
        onUploadToGroup={vi.fn().mockResolvedValue(0)}
        client={client}
        copyLink={copyLink}
        openLink={openLink}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "明星真人素材" });
    expect(within(dialog).getByText("海外平台")).toBeInTheDocument();
    expect(await within(dialog).findByText("李四")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/明星 \/ 授权人名称/), {
      target: { value: "张三" },
    });
    fireEvent.change(within(dialog).getByLabelText("用途说明（可选）"), {
      target: { value: "品牌代言人真人素材组" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "生成认证链接" }));

    expect(await within(dialog).findByText("一次性链接已就绪")).toBeInTheDocument();
    expect(client.createRealPersonAuthLink).toHaveBeenCalledWith({
      providerConnectionId: "provider-1",
      artistName: "张三",
      artistDesc: "品牌代言人真人素材组",
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "复制链接" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "浏览器打开" }));
    await waitFor(() => {
      expect(copyLink).toHaveBeenCalledWith("https://h5.example.com/auth?ticket=once");
      expect(openLink).toHaveBeenCalledWith("https://h5.example.com/auth?ticket=once");
    });
  });

  it("keeps an authorized group visible while its authorization time is synchronizing", async () => {
    const client = dialogClient({
      listRealPersonGroups: vi.fn().mockResolvedValue([
        {
          ...AUTHORIZED_GROUP,
          authorizedAt: null,
        },
      ]),
    });

    render(
      <RealPersonAssetDialog
        providerConnectionId="provider-1"
        providerDisplayName="海外平台"
        onClose={vi.fn()}
        onUploadToGroup={vi.fn().mockResolvedValue(0)}
        client={client}
        copyLink={vi.fn().mockResolvedValue(undefined)}
        openLink={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("李四")).toBeInTheDocument();
    expect(screen.getByText("时间待同步")).toBeInTheDocument();
  });

  it("uploads selected files into the platform integer group ID", async () => {
    const onUploadToGroup = vi.fn().mockResolvedValue(2);
    render(
      <RealPersonAssetDialog
        providerConnectionId="provider-1"
        providerDisplayName="海外平台"
        onClose={vi.fn()}
        onUploadToGroup={onUploadToGroup}
        client={dialogClient()}
        copyLink={vi.fn().mockResolvedValue(undefined)}
        openLink={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const upload = await screen.findByRole("button", { name: "上传同一人的素材" });
    fireEvent.click(upload);

    await waitFor(() => expect(onUploadToGroup).toHaveBeenCalledWith(AUTHORIZED_GROUP));
    expect(
      await screen.findByText("已将 2 个文件加入“李四”真人素材上传队列。"),
    ).toBeInTheDocument();
  });
});
