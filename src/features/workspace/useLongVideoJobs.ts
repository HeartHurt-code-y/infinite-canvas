import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as v from "valibot";
import { isDesktopRuntime } from "../../lib/backend";
import { subscribeBackendEvent } from "../../lib/ipc";
import { longVideoClient, LONG_VIDEO_CHANGED_EVENT } from "../../lib/longVideo";

const longVideoChangedSchema = v.object({ jobId: v.string(), canvasId: v.string() });

/*
 * 后端事件只订阅一次，而且**每张画布只失效一次**。
 *
 * 这个 hook 会被每个视频节点各调一次（节点卡片 + 展开的节点编辑区是同一节点的两份实例）。
 * 如果每个实例都自己去失效，一次后端事件就会触发 N 次失效、N 次重渲染——
 * 而事件在生成期间每 1.2 秒就发一次。所以这里按画布去重：
 * 后端事件 → 找到那张画布的失效函数 → 只跑一次。
 *
 * 引用计数是必需的：同一张画布上可能同时挂着多个实例，
 * 卸载其中一个不能把整张画布的注册一起带走（否则存活的那个就再也收不到事件了）。
 */
interface CanvasRegistration {
  invalidate: () => void;
  refs: number;
}
const canvasRegistrations = new Map<string, CanvasRegistration>();
let changedUnsubscribe: (() => void) | null = null;

function subscribeChanged(canvasId: string, invalidate: () => void): () => void {
  const existing = canvasRegistrations.get(canvasId);
  if (existing) {
    existing.refs += 1;
    existing.invalidate = invalidate;
  } else {
    canvasRegistrations.set(canvasId, { invalidate, refs: 1 });
  }
  changedUnsubscribe ??= subscribeBackendEvent(
    LONG_VIDEO_CHANGED_EVENT,
    longVideoChangedSchema,
    (payload) => {
      canvasRegistrations.get(payload.canvasId)?.invalidate();
    },
  );
  return () => {
    const registration = canvasRegistrations.get(canvasId);
    if (!registration) return;
    registration.refs -= 1;
    if (registration.refs > 0) return;
    canvasRegistrations.delete(canvasId);
    if (canvasRegistrations.size === 0 && changedUnsubscribe) {
      changedUnsubscribe();
      changedUnsubscribe = null;
    }
  };
}

export function useLongVideoJobs(canvasId: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["long-video-jobs", canvasId],
    queryFn: () => longVideoClient.list(canvasId),
    enabled: Boolean(canvasId) && isDesktopRuntime(),
    // 没有长视频任务时不轮询：后端已经会在状态变化时推事件，
    // 固定 3 秒一次 IPC + 数据库读取在空画布上是纯浪费。
    refetchInterval: (observer) => ((observer.state.data?.length ?? 0) > 0 ? 3000 : false),
    staleTime: 1500,
  });
  useEffect(() => {
    if (!canvasId) return;
    // 后端每次状态变化都会推一次事件：状态与进度不再等固定间隔才刷新。
    return subscribeChanged(canvasId, () => {
      void client.invalidateQueries({ queryKey: ["long-video-jobs", canvasId] });
    });
  }, [canvasId, client]);
  return query;
}
