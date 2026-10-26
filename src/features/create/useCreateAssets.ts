/*
 * 生成页资产库的数据层。
 *
 * 这里接的是**本项目自己的素材库**，不是被逆向方的资产服务：
 *   - local  → localBase64AssetClient（用户导入本机 Base64 素材库的素材）
 *   - cloud  → assetLibraryClient（已接入供应商的云端素材库）
 *
 * 为什么不复用画布工作台那套状态：那边素材状态与分页、分组、供应商记忆、
 * 请求竞态取消、未就绪素材结算、预览自愈全都长在 WorkspaceApp 里（12000+ 行）。
 * 把它们搬到生成页要拖走半个工作台；宁可在这里重写一份轻量读取，
 * 也不要把那套引用迷宫引进来——那是本仓库最容易引入竞态回归的地方。
 *
 * 卡片缩略图走 mediaByteCache 的同一条链（预览续签与字节缓存）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assetLibraryClient,
  isDesktopRuntime,
  localBase64AssetClient,
  providerSettingsClient,
  type AssetGroupRecord,
} from "../../lib/backend";
import {
  assetLibraryProviders,
  resolveActiveAssetLibraryProvider,
} from "../../lib/assetLibrarySupport";
import { cloudAssetToItem, localAssetToItem, type AssetItem } from "../workspace/workspaceModel";
import type { CreateAssetCategoryId, CreateAssetSource } from "./createPageModel";

/** 单页条数：即梦的资产抽屉一次铺满一屏，取 60 张够滚。 */
const PAGE_SIZE = 60;

export interface CreateAssetGroup {
  readonly id: string;
  readonly name: string;
  readonly count: number | null;
}

export interface CreateAssets {
  readonly assets: readonly AssetItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly total: number;
  readonly source: CreateAssetSource;
  readonly setSource: (source: CreateAssetSource) => void;
  readonly category: CreateAssetCategoryId;
  readonly setCategory: (category: CreateAssetCategoryId) => void;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly groups: readonly CreateAssetGroup[];
  readonly groupId: string | null;
  readonly setGroupId: (groupId: string | null) => void;
  /** 手动重读（供应商配置变更、上传完成之后调用）。 */
  readonly reload: () => void;
  /** 当前来源下有没有可用的素材库（云端要供应商支持）。 */
  readonly cloudAvailable: boolean;
}

/** 分类 → 后端过滤参数；「全部」传 null（不过滤）。 */
function categoryToMediaType(category: CreateAssetCategoryId): "image" | "video" | "audio" | null {
  return category === "all" ? null : category;
}

/** 云端分组记录 → 抽屉里的分组项。 */
function toGroupOption(group: AssetGroupRecord): CreateAssetGroup {
  return { id: group.id, name: group.name, count: group.assetCount ?? null };
}

/** 一次素材读取的结果。key 是这次读取对应的查询键。 */
interface AssetReadResult {
  readonly key: string;
  readonly assets: readonly AssetItem[];
  readonly total: number;
  readonly error: unknown;
}

const EMPTY_READ: AssetReadResult = { key: "", assets: [], total: 0, error: null };

export function useCreateAssets(): CreateAssets {
  const [read, setRead] = useState<AssetReadResult>(EMPTY_READ);
  const [source, setSource] = useState<CreateAssetSource>("local");
  const [category, setCategory] = useState<CreateAssetCategoryId>("all");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<readonly CreateAssetGroup[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /** 请求序号：只有最后一次请求的结果才允许写进 state。 */
  const requestRef = useRef(0);
  /** 云端供应商连接 ID：素材按供应商隔离，选错连接会显示成空库。 */
  const providerIdRef = useRef<string | null>(null);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * 切换来源。
   *
   * 同时清掉分组选择：云端分组 ID 与本机分组 ID 不是一个命名空间，
   * 留着会让列表按一个不存在的分组去查，表现为「切过去素材全没了」。
   */
  const changeSource = useCallback((next: CreateAssetSource) => {
    setSource(next);
    setGroupId(null);
  }, []);

  /*
   * 云端来源要先解决「用哪个供应商」：列出连接、过滤掉不支持素材库的、
   * 再按「已记住的优先」挑一个。这个判定放在 effect 里而不是组件里，
   * 是因为它要等一次 IPC；组件在等它的时候显示加载态即可。
   */
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void providerSettingsClient
      .listProviderConnections()
      .then((connections) => {
        if (cancelled) return;
        const usable = assetLibraryProviders(connections);
        const active = resolveActiveAssetLibraryProvider(usable, null);
        providerIdRef.current = active?.id ?? null;
        setCloudAvailable(active !== null);
      })
      .catch(() => {
        if (cancelled) return;
        providerIdRef.current = null;
        setCloudAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  /* 分组：随来源切换而换。所有写 state 都在 await 之后，避免同步 setState。 */
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const loadGroups = async (): Promise<void> => {
      if (source === "local") {
        const list = await localBase64AssetClient.listGroups();
        if (cancelled) return;
        setGroups(
          list.map((group) => ({ id: group.id, name: group.name, count: group.assetCount })),
        );
        return;
      }
      const providerConnectionId = providerIdRef.current;
      if (!providerConnectionId) {
        setGroups([]);
        return;
      }
      const list = await assetLibraryClient.listAssetGroups(providerConnectionId);
      if (cancelled) return;
      setGroups(list.map(toGroupOption));
    };
    void loadGroups().catch(() => {
      if (!cancelled) setGroups([]);
    });
    return () => {
      cancelled = true;
    };
  }, [source, reloadToken]);

  /* 素材列表。 */
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const requestId = ++requestRef.current;
    const mediaType = categoryToMediaType(category);
    const name = query.trim();
    const key = `${source}|${category}|${name}|${groupId ?? ""}|${reloadToken}`;

    const load = async (): Promise<AssetReadResult> => {
      if (source === "local") {
        const page = await localBase64AssetClient.listAssets({
          mediaType,
          name: name || null,
          groupId,
          page: 1,
          pageSize: PAGE_SIZE,
        });
        return { key, assets: page.items.map(localAssetToItem), total: page.total, error: null };
      }
      const providerConnectionId = providerIdRef.current;
      if (!providerConnectionId) {
        return { key, assets: [], total: 0, error: null };
      }
      const list = await assetLibraryClient.list({
        providerConnectionId,
        pageNumber: 1,
        pageSize: PAGE_SIZE,
        name: name || null,
        groupId,
        kind: mediaType,
      });
      return { key, assets: list.map(cloudAssetToItem), total: list.length, error: null };
    };

    void load().then(
      (result) => {
        if (requestId !== requestRef.current) return;
        setRead(result);
      },
      (reason: unknown) => {
        if (requestId !== requestRef.current) return;
        setRead({ key, assets: [], total: 0, error: reason });
      },
    );
  }, [source, category, query, groupId, reloadToken]);

  /*
   * 「正在读」由「当前查询键 ≠ 上一次读到的键」推导，而不是在 effect 里
   * 同步 setLoading(true)：同步 setState 会多触发一轮渲染。
   */
  const readKey = useMemo(
    () => `${source}|${category}|${query.trim()}|${groupId ?? ""}|${reloadToken}`,
    [category, groupId, query, reloadToken, source],
  );
  const isStale = read.key !== readKey;
  const assets = isStale ? [] : read.assets;
  const total = isStale ? 0 : read.total;
  const error = isStale ? null : read.error;

  return {
    assets,
    loading: isStale,
    error,
    total,
    source,
    setSource: changeSource,
    category,
    setCategory,
    query,
    setQuery,
    groups,
    groupId,
    setGroupId,
    reload,
    cloudAvailable,
  };
}
