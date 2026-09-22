import { describe, expect, it } from "vitest";
import {
  assetGroupBounds,
  assetGroupsFromNodes,
  compareLibraryPickOrder,
  layoutAssetPlacements,
  nextLibraryPickOrder,
  regroupAssetNodes,
} from "./assetGroups";
import type { AssetNodeData } from "./workspaceModel";

function asset(overrides: Partial<AssetNodeData> & Pick<AssetNodeData, "key">): AssetNodeData {
  return {
    assetId: overrides.key,
    providerConnectionId: "provider",
    source: "local",
    kind: "image",
    name: overrides.key,
    previewUrl: null,
    videoUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

describe("素材组与点选顺序", () => {
  it("生成输入按素材库点选序号，而不是画布上的左右位置", () => {
    const laterOnTheLeft = asset({ key: "left", x: 0, libraryPickOrder: 3 });
    const earlierOnTheRight = asset({ key: "right", x: 800, libraryPickOrder: 1 });
    const unnumbered = asset({ key: "old", x: 10, y: -20 });
    const ordered = [laterOnTheLeft, unnumbered, earlierOnTheRight].sort(compareLibraryPickOrder);
    expect(ordered.map((node) => node.key)).toEqual(["right", "left", "old"]);
  });

  it("下一次点选序号接在已有序号之后", () => {
    expect(nextLibraryPickOrder([asset({ key: "a", libraryPickOrder: 4 })])).toBe(5);
    expect(nextLibraryPickOrder([asset({ key: "a" })])).toBe(1);
  });

  it("框选成组后按点选顺序读取成员，并解散只剩一个的旧组", () => {
    const nodes = [
      asset({ key: "a", libraryPickOrder: 2, assetGroupId: "old" }),
      asset({ key: "b", libraryPickOrder: 1, assetGroupId: "old" }),
      asset({ key: "c", libraryPickOrder: 3, assetGroupId: "old" }),
    ];
    const next = regroupAssetNodes(nodes, ["a", "c"], "new");
    expect(next).not.toBeNull();
    expect(next?.find((node) => node.key === "b")?.assetGroupId).toBeUndefined();
    const groups = assetGroupsFromNodes(next ?? []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((node) => node.key)).toEqual(["a", "c"]);
  });

  it("再次框选同一整组不会改写节点", () => {
    const nodes = [
      asset({ key: "a", libraryPickOrder: 1, assetGroupId: "same" }),
      asset({ key: "b", libraryPickOrder: 2, assetGroupId: "same" }),
    ];
    expect(regroupAssetNodes(nodes, ["b", "a"], "other")).toBeNull();
  });

  it("成组外框包住成员，并在右侧留出端口", () => {
    const bounds = assetGroupBounds([
      asset({ key: "a", x: 100, y: 80 }),
      asset({ key: "b", x: 200, y: 80 }),
    ]);
    expect(bounds.x).toBeLessThan(100);
    expect(bounds.y).toBeLessThan(80);
    expect(bounds.x + bounds.width).toBeGreaterThan(200);
  });

  it("一次放入时落点顺序与点选顺序一致，且互不重叠", () => {
    const placed = layoutAssetPlacements(3, { x: 0, y: 0 }, { width: 100, height: 80 }, []);
    expect(placed).toHaveLength(3);
    expect(placed[0]!.x).toBeLessThan(placed[1]!.x);
    expect(placed[2]!.y).toBeGreaterThan(placed[0]!.y);
    for (let index = 0; index < placed.length; index += 1) {
      for (let other = index + 1; other < placed.length; other += 1) {
        const separated =
          placed[index]!.x + 100 <= placed[other]!.x ||
          placed[other]!.x + 100 <= placed[index]!.x ||
          placed[index]!.y + 80 <= placed[other]!.y ||
          placed[other]!.y + 80 <= placed[index]!.y;
        expect(separated).toBe(true);
      }
    }
  });
});
