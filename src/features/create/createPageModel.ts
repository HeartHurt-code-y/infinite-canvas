/*
 * 生成页（完整即梦式外壳）的纯逻辑层。
 *
 * 这一层只回答「页面上有哪些东西、它们怎么排」，不碰 React：
 *   1. 侧栏导航项与分区；
 *   2. 资产库的分类与来源映射（即梦的页签 ↔ 本项目的素材库）；
 *   3. 记录流按天分组后的展示口径。
 *
 * 视觉与交互规格来自对即梦 AI 创作页的实测（DOM + 计算样式 + CSS 分包），
 * 数值全部落在 tokens.css 的 `--color-create-*` / `--size-create-*` 令牌组里。
 * 数据层仍然走本项目自有 API，不复用被逆向方的任何端点或签名。
 */
import type { AssetKind, AssetLibrarySource } from "../workspace/workspaceModel";

/* ── 侧栏导航 ───────────────────────────────────────────────────────── */

export interface GenerateNavItem {
  readonly id: "create" | "explore" | "asset" | "subject";
  readonly label: string;
  /** 指向本项目内部的哪个入口；null 表示该分区本项目还没有对应物。 */
  readonly href: string | null;
}

/**
 * 侧栏主导航。
 *
 * 即梦是「创作 / 探索 / 资产 / 主体」。本项目没有「探索」与「主体」两个子系统，
 * 与其放两个点了没反应的按钮，不如只留有落地的两个——但外观仍是即梦那一排。
 */
export const CREATE_NAV_ITEMS: readonly GenerateNavItem[] = [
  { id: "create", label: "创作", href: null },
  { id: "explore", label: "探索", href: null },
  { id: "asset", label: "资产", href: null },
  { id: "subject", label: "主体", href: null },
];

/* ── 资产库分类 ─────────────────────────────────────────────────────── */

export type CreateAssetCategoryId = "all" | AssetKind;

export interface CreateAssetCategory {
  readonly id: CreateAssetCategoryId;
  readonly label: string;
}

/**
 * 资产库分类页签。
 *
 * 即梦是「图片 / 视频 / 音频 / 文档 / 主体」。本项目的素材库只有三种媒体
 * （`AssetKind` = image | video | audio），没有文档与主体——所以这两个页签
 * 不出现，留着就是点了没反应。样式与即梦完全一致，少的是没有落地的分类。
 */
export const CREATE_ASSET_CATEGORIES: readonly CreateAssetCategory[] = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
];

/**
 * 资产来源。
 *
 * 即梦的「我的 / 官方」是云端与本地的分野；本项目也有同一条分野，只是叫法不同：
 *   - local  本机 Base64 素材库（用户自己导入的）
 *   - cloud  已接入供应商的云端素材库
 * 这个映射是本页与本项目素材库对接的唯一入口。
 */
export type CreateAssetSource = AssetLibrarySource;

export interface CreateAssetSourceOption {
  readonly id: CreateAssetSource;
  readonly label: string;
}

export const CREATE_ASSET_SOURCES: readonly CreateAssetSourceOption[] = [
  { id: "local", label: "我的" },
  { id: "cloud", label: "官方" },
];

export function assetSourceLabel(source: CreateAssetSource): string {
  return CREATE_ASSET_SOURCES.find((option) => option.id === source)?.label ?? "全部";
}

/* ── 素材 → 参考素材 ───────────────────────────────────────────────── */

/**
 * 素材卡 → 生成请求里的参考素材。
 *
 * 云端素材必须带 `providerConnectionId`：后端要靠「供应商连接 + 素材 ID」去
 * 取媒体正文，只给素材 ID 会认不出是哪家的。本机 Base64 素材则只需要素材 ID。
 */
export function referenceFromAsset(asset: {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly previewUrl?: string | null;
  readonly source?: AssetLibrarySource;
  readonly providerConnectionId?: string;
}): {
  readonly kind: "asset" | "local_base64_asset";
  readonly name: string;
  readonly mediaType: AssetKind;
  readonly assetId: string;
  readonly providerConnectionId?: string;
  readonly previewUrl?: string | null;
} {
  const isCloud = asset.source !== "local";
  return {
    kind: isCloud ? "asset" : "local_base64_asset",
    name: asset.name,
    mediaType: asset.kind,
    assetId: asset.id,
    ...(isCloud && asset.providerConnectionId
      ? { providerConnectionId: asset.providerConnectionId }
      : {}),
    previewUrl: asset.previewUrl ?? null,
  };
}

/* ── 记录流 ─────────────────────────────────────────────────────────── */

/**
 * 记录流的筛选维度。
 *
 * 即梦顶栏那枚「筛选」按钮弹出的是五个区块（日期 / 创作 / 分类 / 编辑 +
 * 清空全部），其中**只有媒体类型**这一维在本项目的记录模型里有对应物：
 * 全部 / 图片 / 视频。其余维度（对口型 / Agent 模式 / 动作模仿 / 音频 /
 * 收藏 / 超清 / 补帧 / 时间区间）在浮层里禁用并标注「后端暂未接入」。
 */
export type CreateRecordFilter = "all" | "image" | "video";

/**
 * 记录流的媒体网格列数。
 *
 * 即梦的图片记录是 4 列方阵（单格约 252×252，gap 2px），视频记录是 flex 换行
 * 的 16:9 宽幅（单格 50% 宽）。同一屏里两种网格不能混排，所以按记录的媒体
 * 类型分。
 */
export function recordMediaLayout(mediaType: string): "square" | "wide" {
  return mediaType === "video" ? "wide" : "square";
}
