import { useEffect, useState } from "react";

import { isDesktopRuntime, mediaClient, toMediaSrc, type MediaThumbnail } from "../../lib/backend";

interface PosterResult {
  readonly sourcePath: string;
  readonly thumbnail: MediaThumbnail | null;
}

// 仅合并进行中的请求；完成后删除，让原生磁盘缓存按文件大小/修改时间检查变化。
const pendingPosters = new Map<string, Promise<MediaThumbnail | null>>();

function requestPoster(sourcePath: string): Promise<MediaThumbnail | null> {
  const pending = pendingPosters.get(sourcePath);
  if (pending != null) return pending;
  const request = mediaClient
    .createThumbnail(sourcePath, 512)
    .finally(() => pendingPosters.delete(sourcePath));
  pendingPosters.set(sourcePath, request);
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
  const [result, setResult] = useState<PosterResult | null>(null);

  useEffect(() => {
    if (!enabled || sourcePath == null) return;
    let current = true;
    void requestPoster(sourcePath)
      .then((thumbnail) => {
        if (current) setResult({ sourcePath, thumbnail });
      })
      .catch(() => {
        if (current) setResult({ sourcePath, thumbnail: null });
      });
    return () => {
      current = false;
    };
  }, [enabled, sourcePath]);

  // 封面身份绑定原文件：换源后的迟到请求不能把旧画面写到新产物上。
  const thumbnail =
    sourcePath != null && result?.sourcePath === sourcePath ? result.thumbnail : null;
  return {
    src: thumbnail == null ? null : toMediaSrc(thumbnail.path),
    width: thumbnail?.width ?? null,
    height: thumbnail?.height ?? null,
    unavailable: enabled && result?.sourcePath === sourcePath && thumbnail == null,
  };
}
