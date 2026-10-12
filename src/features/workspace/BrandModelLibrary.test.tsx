import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveBrandModelVersion,
  archiveBrandModel,
  listBrandModels,
  saveBrandModelVersion,
  selectBrandModelVersion,
  validateBrandModelVersion,
  type BrandModelProfile,
  type BrandModelSelection,
} from "../../lib/brandModels";
import { BrandModelLibrary } from "./BrandModelLibrary";

vi.mock("../../lib/brandModels", async (original) => ({
  ...(await original<object>()),
  listBrandModels: vi.fn(),
  saveBrandModelVersion: vi.fn(),
  approveBrandModelVersion: vi.fn(),
  archiveBrandModel: vi.fn(),
  selectBrandModelVersion: vi.fn(),
  validateBrandModelVersion: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const reference = {
  id: "front",
  label: "正面",
  role: "front" as const,
  path: "C:/library/front.png",
  contentHash: "a".repeat(64),
  width: 100,
  height: 120,
};
const approved = {
  id: "approved-v1",
  version: 1,
  createdAt: 1,
  status: "approved" as const,
  description: "成年女性，冷静表情",
  invariants: "棕色眼睛，深色短发",
  references: [reference],
  signature: "b".repeat(64),
};
const draft = {
  ...approved,
  id: "draft-v2",
  version: 2,
  status: "draft" as const,
  signature: "c".repeat(64),
};
const profile: BrandModelProfile = {
  id: "profile",
  brandName: "杉间",
  name: "白露",
  archived: false,
  currentVersionId: approved.id,
  createdAt: 1,
  updatedAt: 2,
  versions: [approved, draft],
};
const selection: BrandModelSelection = {
  profileId: profile.id,
  versionId: approved.id,
  signature: approved.signature,
  name: profile.name,
  description: approved.description,
  invariants: approved.invariants,
  references: approved.references,
};

async function expandLibrary() {
  const details = screen.getByLabelText<HTMLDetailsElement>("品牌数字模特库");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(screen.getByRole("button", { name: "新建模特" })).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listBrandModels).mockResolvedValue([profile]);
  vi.mocked(saveBrandModelVersion).mockResolvedValue(profile);
  vi.mocked(approveBrandModelVersion).mockResolvedValue({
    ...profile,
    versions: [approved, { ...draft, status: "approved" }],
  });
  vi.mocked(validateBrandModelVersion).mockResolvedValue(approved);
  vi.mocked(selectBrandModelVersion).mockReturnValue(selection);
  vi.mocked(archiveBrandModel).mockResolvedValue({ ...profile, archived: true });
});

describe("brand model library", () => {
  it("loads on demand and saves AI reference provenance into a new durable draft", async () => {
    render(
      <BrandModelLibrary
        disabled={false}
        brandName="杉间"
        onSelect={vi.fn()}
        candidates={[
          {
            path: "C:/outputs/model.png",
            label: "已保存模特图",
            taskId: "stable-task",
            resultIndex: 3,
            sourceNodeId: "image-node",
          },
        ]}
      />,
    );
    expect(listBrandModels).not.toHaveBeenCalled();
    await expandLibrary();
    fireEvent.change(screen.getByRole("textbox", { name: "数字模特名称" }), {
      target: { value: "白露" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "数字模特人物描述" }), {
      target: { value: "成年女性，冷静表情" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "数字模特固定特征" }), {
      target: { value: "棕色眼睛，深色短发" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "选择已保存的模特成图" }), {
      target: { value: "C:/outputs/model.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入参考照片" }));
    fireEvent.change(screen.getByRole("combobox", { name: "人物参考用途 1" }), {
      target: { value: "three_quarter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模特草稿" }));
    await waitFor(() =>
      expect(saveBrandModelVersion).toHaveBeenCalledWith({
        brandName: "杉间",
        name: "白露",
        description: "成年女性，冷静表情",
        invariants: "棕色眼睛，深色短发",
        references: [
          {
            sourcePath: "C:/outputs/model.png",
            label: "已保存模特图",
            role: "three_quarter",
            taskId: "stable-task",
            resultIndex: 3,
            sourceNodeId: "image-node",
          },
        ],
      }),
    );
    expect(screen.getByRole("textbox", { name: "数字模特名称" })).toBeRequired();
  });

  it("validates the approved exact version before selection, and never selects unsaved edits", async () => {
    const onSelect = vi.fn();
    render(<BrandModelLibrary disabled={false} selected={selection} onSelect={onSelect} />);
    await expandLibrary();
    fireEvent.change(screen.getByRole("combobox", { name: "模特档案" }), {
      target: { value: profile.id },
    });
    expect(screen.getByRole("button", { name: "使用当前版本" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "模特版本" }), {
      target: { value: approved.id },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "数字模特固定特征" }), {
      target: { value: "改为金发" },
    });
    expect(screen.getByRole("button", { name: "使用当前版本" })).toBeDisabled();
    expect(screen.getByText(/这些编辑尚未保存/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "数字模特固定特征" }), {
      target: { value: approved.invariants },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用当前版本" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(selection));
    expect(validateBrandModelVersion).toHaveBeenCalledWith({
      profileId: profile.id,
      versionId: approved.id,
      expectedSignature: approved.signature,
    });
    expect(selectBrandModelVersion).toHaveBeenCalledWith(profile, approved);
    fireEvent.click(screen.getByRole("button", { name: "移除当前任务的模特" }));
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it("approves a saved draft, keeps the chosen version and archives without rewriting the selected snapshot", async () => {
    const onSelect = vi.fn();
    render(<BrandModelLibrary disabled={false} selected={selection} onSelect={onSelect} />);
    await expandLibrary();
    fireEvent.change(screen.getByRole("combobox", { name: "模特档案" }), {
      target: { value: profile.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "批准当前版本" }));
    await waitFor(() =>
      expect(approveBrandModelVersion).toHaveBeenCalledWith({
        profileId: profile.id,
        versionId: draft.id,
        expectedSignature: draft.signature,
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "使用当前版本" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "模特版本" })).toHaveValue(draft.id);
    fireEvent.click(screen.getByRole("button", { name: "归档模特" }));
    await waitFor(() =>
      expect(archiveBrandModel).toHaveBeenCalledWith({ profileId: profile.id, archived: true }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复模特" })).toBeVisible());
    expect(screen.getByRole("button", { name: "使用当前版本" })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders native failures as a human summary with an associated repair hint", async () => {
    const nativeError = {
      kind: "validation",
      message: "模特照片已变化",
      details: { file: "C:/library/front.png" },
    };
    vi.mocked(validateBrandModelVersion).mockRejectedValue(nativeError);
    render(<BrandModelLibrary disabled={false} onSelect={vi.fn()} />);
    await expandLibrary();
    fireEvent.change(screen.getByRole("combobox", { name: "模特档案" }), {
      target: { value: profile.id },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "模特版本" }), {
      target: { value: approved.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用当前版本" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("模特照片已变化");
    expect(alert).not.toHaveTextContent('"kind"');
    expect(alert).toHaveTextContent("换一张清晰图片");
    expect(screen.getByRole("button", { name: "使用当前版本" })).toHaveAttribute(
      "aria-describedby",
      alert.id,
    );
    expect(screen.getByText("展开完整报错")).toBeVisible();
  });
});
