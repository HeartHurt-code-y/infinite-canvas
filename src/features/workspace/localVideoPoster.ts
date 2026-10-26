import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { isDesktopRuntime, mediaClient, toMediaSrc, type MediaThumbnail } from "../../lib/backend";

interface PosterResult {
  readonly sourcePath: string;
  /** 请求发出时的内容指纹：同路径被改写后，迟到的旧封面不能盖到新内容上。 */
  readonly fingerprint: string;
  readonly thumbnail: MediaThumbnail | null;
}

/**
 * 读本地媒体文件的内容指纹：字节大小 + 最后修改时间。
 *
 * 为什么需要它：后端 `create_media_thumbnail` 的磁盘缓存键是
 * 「源路径 | 源大小 | 源修改时间 | 目标边长」，源文件被改写时后端会算出新的缓存文件。
 * 但前端如果只按**路径**缓存结果，同一路径就永远命中同一份前端缓存 → 后端根本没有机会
 * 重算 → 界面一直显示旧缩略图，而且整个会话都不会自愈。
 *
 * 用「大小 + 修改时间」而不是内容哈希：读一遍几十 MB 的产物算 sha256 太贵，
 * 而这两个字段与后端缓存键用的是同一组数据，语义一致（改写必然改变其中至少一项）。
 */
async function readFileFingerprint(path: string): Promise<string> {
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(path);
    return `${info.size}-${info.mtime?.getTime() ?? 0}`;
  } catch {
    // 读不到元数据（文件已被删除、无权限、非桌面运行时）：退化成固定占位值。
    // 这里不能抛错 —— 抛错会让指纹查询进入 error 态，缩略图请求永远发不出去，
    // 界面就会一直停在「正在加载预览」，而不是给出「预览不可用」这个真实结论。
    return "unknown";
  }
}

/**
 * 读取本地媒体文件的内容指纹；没算出来时返回 null（调用方据此判定「还没就绪」）。
 *
 * 刷新时机全是**事件**，不是定时器：
 *   · 查询挂载时；
 *   · 节点重新进入视口时（enabled 由 false 变 true）；
 *   · 窗口重新获得焦点时（下面单独说明）。
 * `staleTime: 0` 让它随时可刷新；因为不设 `refetchInterval`，它不会变成轮询。
 *
 * 窗口聚焦这一条是**故意**覆盖应用级默认（`lib/queryClient.ts` 里
 * `refetchOnWindowFocus: false`：WebView 内聚焦语义不可靠，且刷新会带来多余请求）。
 * 这里覆盖它是因为代价不同：本查询只做一次 `fs.stat`（一次系统调用），
 * 而它换来的是「用户在应用外改写了文件、切回来就能看到新缩略图」这条恢复路径。
 * 指纹没变就不会触发任何缩略图请求，所以「多余请求」仍然只有 stat 这一条。
 */
export function useMediaFileFingerprint(
  sourcePath: string | null,
  enabled: boolean,
): string | null {
  const { data } = useQuery({
    queryKey: ["media-file-fingerprint", sourcePath],
    queryFn: () => readFileFingerprint(sourcePath as string),
    enabled: enabled && sourcePath != null && isDesktopRuntime(),
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: "always",
  });
  return data ?? null;
}

// 仅合并进行中的请求；完成后删除，让原生磁盘缓存按文件大小/修改时间检查变化。
// 键里必须带内容指纹：同一路径被改写后不能复用上一次的在途请求（那返回的是旧画面的封面）。
const pendingPosters = new Map<string, Promise<MediaThumbnail | null>>();

function requestPoster(sourcePath: string, fingerprint: string): Promise<MediaThumbnail | null> {
  const key = `${sourcePath}#${fingerprint}`;
  const pending = pendingPosters.get(key);
  if (pending != null) return pending;
  const request = mediaClient
    .createThumbnail(sourcePath, 512)
    .finally(() => pendingPosters.delete(key));
  pendingPosters.set(key, request);
  return request;
}

/** 本地视频封面由原生 FFmpeg 解码并缓存；卡片无需为静止封面持有视频解码器。 */
export function useLocalVideoPoster(
  sourcePath: string | null,
  visible = true,
): {
  readonly src: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly unavailable: boolean;
} {
  const enabled = isDesktopRuntime() && sourcePath != null && visible;
  /*
   * 内容指纹进依赖数组：同路径被改写 → 指纹变 → 依赖变化 → 重新取封面。
   * 之前依赖只有 [enabled, sourcePath]，同路径改写根本不会重发请求 ——
   * 注释里写的「让原生磁盘缓存按文件大小/修改时间检查变化」因此是空话：
   * 请求不重发，后端那份按大小/修改时间建的缓存键根本没机会被重新计算。
   */
  const fingerprint = useMediaFileFingerprint(sourcePath, enabled);
  const [result, setResult] = useState<PosterResult | null>(null);

  useEffect(() => {
    if (!enabled || sourcePath == null || fingerprint == null) return;
    let current = true;
    void requestPoster(sourcePath, fingerprint)
      .then((thumbnail) => {
        if (current) setResult({ sourcePath, fingerprint, thumbnail });
      })
      .catch(() => {
        if (current) setResult({ sourcePath, fingerprint, thumbnail: null });
      });
    return () => {
      current = false;
    };
  }, [enabled, sourcePath, fingerprint]);

  // 封面身份绑定原文件**与它的内容**：换源或改写后的迟到请求不能把旧画面写到新产物上。
  const matched =
    result != null && result.sourcePath === sourcePath && result.fingerprint === fingerprint
      ? result
      : null;
  const thumbnail = matched?.thumbnail ?? null;
  return {
    src: thumbnail == null ? null : toMediaSrc(thumbnail.path),
    width: thumbnail?.width ?? null,
    height: thumbnail?.height ?? null,
    // 「还没拿到结果」与「确实拿不到封面」要分开：指纹没算出来、请求还在路上时是加载态，
    // 只有请求已经落定且没有封面时才算不可用。
    unavailable: enabled && matched != null && thumbnail == null,
  };
}
