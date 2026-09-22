import { useEffect, useState } from "react";

import { refreshMediaUrlWithStagingFallback } from "../../lib/backend";
import type { AssetItem, AssetKind } from "./workspaceModel";

/**
 * 素材预览地址缺失时的补取。
 *
 * 上游素材记录并不总带地址：列表接口与「按身份读取」给出的字段可以不一致，导入中的素材也
 * 可能先出现在列表里而没有地址。卡片与详情弹窗若直接按「没有地址」渲染，就会一直停在
 * 「预览不可用」而一次请求都不发 —— 用户看到的是「这个素材坏了」，实际只是没去取。
 *
 * 同一素材在一个会话里只补一次：整页卡片各发一次请求会把素材库刷成一串空转请求。
 */
const missingPreviewUrlAttempts = new Map<string, Promise<string | null>>();

/** 测试与素材库整表刷新时清空补取记账，避免上一条列表的判断泄漏到下一条。 */
export function resetMissingPreviewUrlAttempts(): void {
  missingPreviewUrlAttempts.clear();
}

/**
 * 当前地址缺失时按素材身份补取一次，返回补到的地址（没补到则 null）。
 *
 * 补取走的是与所有预览渲染点相同的恢复入口：云端素材回读供应商记录、本地素材重签对象
 * 存储地址，上游回放导入时的死地址时继续按对象键重签暂存副本。
 */
export function useRecoveredPreviewUrl(
  asset: AssetItem,
  kind: AssetKind,
  currentUrl: string | null | undefined,
): { readonly url: string | null; readonly settled: boolean } {
  const [recovered, setRecovered] = useState<string | null>(null);
  const [attemptFinished, setAttemptFinished] = useState(false);
  const { id, source, providerConnectionId } = asset;
  const eligible =
    (currentUrl == null || currentUrl === "") &&
    recovered == null &&
    id !== "" &&
    // 只补当前渲染的那种用途：视频卡片不该为一个图片预览去发一次请求（反之亦然）。
    asset.kind === kind &&
    (kind === "image" || kind === "video") &&
    asset.cloudStatus !== "failed" &&
    asset.cloudStatus !== "deleted";
  useEffect(() => {
    if (!eligible) return;
    const key = `${id}:${kind}`;
    // 同一素材共享这一次补取：卡片卸载再挂上时不再发第二轮请求，也等得到同一次结果。
    let pending = missingPreviewUrlAttempts.get(key);
    if (pending == null) {
      pending = refreshMediaUrlWithStagingFallback({ id, source, providerConnectionId }, kind, null)
        .then((freshUrl) => (freshUrl == null || freshUrl === "" ? null : freshUrl))
        .catch(() => null);
      missingPreviewUrlAttempts.set(key, pending);
    }
    let cancelled = false;
    void pending.then((freshUrl) => {
      if (cancelled) return;
      if (freshUrl != null) setRecovered(freshUrl);
      setAttemptFinished(true);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, id, kind, source, providerConnectionId]);
  return { url: recovered, settled: !eligible || attemptFinished };
}
